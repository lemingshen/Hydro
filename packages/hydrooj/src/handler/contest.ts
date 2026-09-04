import { Readable } from 'stream';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { stringify as toCSV } from 'csv-stringify/sync';
import { readFile } from 'fs-extra';
import { escapeRegExp, pick } from 'lodash';
import moment from 'moment-timezone';
import { ObjectId } from 'mongodb';
import {
    Counter, diffArray, getAlphabeticId, randomstring, sortFiles, Time, yaml,
} from '@hydrooj/utils/lib/utils';
import { Context, Service } from '../context';
import {
    BadRequestError, ContestAlreadyStartedError, ContestNotAttendedError, ContestNotEndedError, ContestNotFoundError,
    ContestNotLiveError, ContestScoreboardHiddenError, FileLimitExceededError, FileUploadError,
    InvalidTokenError, MethodNotAllowedError, NotAssignedError, NotFoundError, PermissionError, ValidationError,
} from '../error';
import { ContestStatusDoc, FileInfo, ScoreboardConfig, Tdoc } from '../interface';
import { gradeObjectiveAnswer } from '../lib/objective_grade';
import { readRawProblemConfig } from '../lib/problem_config';
import { objectiveSubKindOf } from '../lib/objective_markdown';
import { PERM, PRIV, STATUS } from '../model/builtin';
import * as contest from '../model/contest';
import * as discussion from '../model/discussion';
import * as document from '../model/document';
import { getSubjective } from '../model/selflearning';
import message from '../model/message';
import * as oplog from '../model/oplog';
import problem from '../model/problem';
import record from '../model/record';
import ScheduleModel from '../model/schedule';
import * as setting from '../model/setting';
import storage from '../model/storage';
import user from '../model/user';

import {
    Handler, param, post, Type, Types,
} from '../service/server';

/**
 * 🌐 The allowed submission languages of a test / homework, as saved.
 *
 * Shared by the test and homework editors (and mirrored by the
 * self-learning session editor): unknown or disabled judge language ids
 * are dropped rather than refused — the picker only offers valid ones, and
 * a stale form may still name a language since retired — and the result
 * is deduplicated. Empty = no restriction.
 *
 * Then the one check that matters: a problem with its own language list
 * that shares NOTHING with this one would be unsubmittable inside the
 * test (the two are intersected on the problem page), so the save is
 * refused naming the problem and its languages, rather than letting a
 * student discover an empty language menu.
 */
export function resolveAllowedLangs(raw: string[], pdict: Record<number, any>, pids: number[]): string[] {
    const langs = [...new Set((raw || []).map((l) => String(l).trim())
        .filter((l) => l && setting.langs[l] && !setting.langs[l].disabled))].slice(0, 64);
    if (!langs.length) return [];
    const dead = pids
        .map((pid) => pdict[pid])
        .filter((pdoc) => pdoc && pdoc.config && typeof pdoc.config === 'object'
            && Array.isArray(pdoc.config.langs) && pdoc.config.langs.length
            && !pdoc.config.langs.some((l: string) => langs.includes(l)))
        .map((pdoc) => `${pdoc.pid || pdoc.docId} (${pdoc.config.langs.map((l: string) => setting.langs[l]?.display || l).join(', ')})`);
    if (dead.length) {
        throw new ValidationError('langs', null,
            'These problems accept none of the selected languages, so nobody could submit them here: '
            + `${dead.join('; ')}. Widen the language list or remove the problem.`);
    }
    return langs;
}

/* ------------------------------------------------------------------ */
/*  PTA: objective tasks are scored only after the container ends      */
/* ------------------------------------------------------------------ */
/**
 * Whatever the rule, an objective answer given inside a running Test or
 * Homework reveals nothing until the container ends:
 *   - the record and the contest journal are masked by applyProjection
 *     (status Waiting, no score), on every page and socket;
 *   - the problem-set status (problem list, problem page, statistics,
 *     homepage) is NOT written at judge time (handler/judge.ts postJudge
 *     defers it) but by this sync, which the end-of-container schedule task
 *     runs (`syncObjective`), with a lazy fallback on the first visit after
 *     the end. Idempotent through the `objectiveSynced` flag on the tdoc.
 */
export function hasObjectiveTask(pids: number[], pdict: Record<number, { pid?: string | number }>): boolean {
    return pids.some((pid) => /^o/i.test(String(pdict[pid]?.pid || '')));
}

export async function syncObjectiveStatus(domainId: string, tdoc: Tdoc) {
    if ((tdoc as any).objectiveSynced || !contest.isDone(tdoc)) return;
    await contest.edit(domainId, tdoc.docId, { objectiveSynced: true } as any);
    const pdict = await problem.getList(domainId, tdoc.pids, true, false, ['docId', 'pid'] as any, true);
    const objective = tdoc.pids.filter((pid) => /^o/i.test(String(pdict[pid]?.pid || '')));
    if (!objective.length) return;
    const rdocs = await record.getMulti(domainId, { contest: tdoc.docId, lang: '_', pid: { $in: objective } }).sort({ _id: 1 }).toArray();
    for (const rdoc of rdocs) {
        if (![STATUS.STATUS_ACCEPTED, STATUS.STATUS_WRONG_ANSWER].includes(rdoc.status)) continue;
        const updated = await problem.updateStatus(domainId, rdoc.pid, rdoc.uid, rdoc._id, rdoc.status, rdoc.score);
        if (!updated || rdoc.status !== STATUS.STATUS_ACCEPTED) continue;
        await problem.inc(domainId, rdoc.pid, 'nAccept', 1);
        await record.collStat.updateOne({ _id: rdoc._id }, {
            $set: {
                domainId, pid: rdoc.pid, uid: rdoc.uid, time: rdoc.time, memory: rdoc.memory, length: rdoc.code?.length || 0, lang: rdoc.lang,
            },
        }, { upsert: true });
    }
}

const PENDING_STATUSES = [STATUS.STATUS_WAITING, STATUS.STATUS_JUDGING, STATUS.STATUS_COMPILING, STATUS.STATUS_FETCHED];

/**
 * END-OF-CONTAINER EVALUATION. When a Test / Homework ends — on schedule,
 * or because a teacher moved its end into the past — every student's results
 * are rebuilt from the submission records themselves, so the scoreboard is
 * complete even if a journal entry was lost at judge time (a write that
 * raced another submission, a judge callback that never arrived):
 *   1. objective answers that were never judged are queued again;
 *   2. each attendee's journal is rebuilt from all of their records in the
 *      container (records are authoritative; entries the records don't
 *      cover are kept) and the rule's stats are recomputed;
 *   3. the objective problem-set statuses are synced (syncObjectiveStatus).
 * Idempotent: re-running only refreshes.
 */
export async function evaluateContainerResults(domainId: string, tdoc: Tdoc) {
    if (!contest.isDone(tdoc)) return;
    const pids = tdoc.pids || [];
    const rdocs = await record.getMulti(domainId, { contest: tdoc.docId, pid: { $in: pids } }, {
        projection: { _id: 1, uid: 1, pid: 1, status: 1, score: 1, lang: 1, subtasks: 1 },
    }).sort({ _id: 1 }).toArray();
    /*
     * Objective answers are graded here, in process, against each task's
     * answer key (lib/objective_grade): whatever state the judge left them in
     * — never judged, still pending, or judged — every answer gets its score
     * now, and the record is updated so the students' pages agree with the
     * scoreboard. Programming records keep the judge's verdicts.
     */
    const objectivePids = pids.filter((pid) => rdocs.some((r) => r.pid === pid && r.lang === '_'));
    if (objectivePids.length) {
        const pdict = await problem.getList(domainId, objectivePids, true, false, ['docId', 'pid', 'data', 'domainId'] as any, true);
        const keys: Record<number, any> = {};
        for (const pid of objectivePids) if (pdict[pid]) keys[pid] = await readRawProblemConfig(pdict[pid]);
        for (const r of rdocs) {
            if (r.lang !== '_' || !keys[r.pid]?.answers) continue;
            const full = await record.get(domainId, r._id);
            if (!full) continue;
            const grade = gradeObjectiveAnswer(keys[r.pid], full.code || '');
            r.status = grade.status;
            r.score = grade.score;
            r.subtasks = grade.subtasks as any;
            await record.update(domainId, r._id, {
                status: grade.status, score: grade.score, subtasks: grade.subtasks as any, judgeAt: new Date(), judger: 0,
            });
        }
    }
    const byUid: Record<number, typeof rdocs> = {};
    for (const r of rdocs) (byUid[r.uid] ||= []).push(r);
    const tsdocs = await document.getMultiStatus(domainId, document.TYPE_CONTEST, { docId: tdoc.docId }).toArray();
    const uids = new Set<number>([...tsdocs.map((t) => t.uid), ...Object.keys(byUid).map(Number)]);
    for (const uid of uids) {
        const tsdoc = tsdocs.find((t) => t.uid === uid);
        const fromRecords = (byUid[uid] || [])
            .filter((r) => r.lang === '_' || !PENDING_STATUSES.includes(r.status))
            .map((r) => ({
                rid: r._id, pid: r.pid, status: r.status, score: r.score || 0, subtasks: r.subtasks, lang: r.lang,
            }));
        const covered = new Set(fromRecords.map((j) => j.rid.toHexString()));
        const kept = (tsdoc?.journal || []).filter((j) => !covered.has(j.rid.toHexString()));
        const journal = [...kept, ...fromRecords].sort((a, b) => a.rid.getTimestamp().getTime() - b.rid.getTimestamp().getTime());
        if (!journal.length && !tsdoc) continue;
        const stats = contest.RULES[tdoc.rule].stat(tdoc, journal);
        await document.setStatus(domainId, document.TYPE_CONTEST, tdoc.docId, uid, { journal, ...stats } as any);
    }
    await syncObjectiveStatus(domainId, tdoc);
}

/* ------------------------------------------------------------------ */
/*  PTA test editor: the paper as four sections                        */
/* ------------------------------------------------------------------ */
const PAPER_SECTIONS = ['tf', 'choice', 'blank'] as const;
/** Sections whose tasks carry their own points (typed per task in the editor). */
const SCORED_SECTIONS = ['prog', 'subj'] as const;
export interface PaperSections {
    tf: { total: number, pids: number[] };
    choice: { total: number, pids: number[] };
    blank: { total: number, pids: number[] };
    prog: { pids: number[], scores: Record<number, number> };
    /**
     * PTA fork: SUBJECTIVE (project-level, S-pid) tasks — the homework
     * editor's fifth section. Students hand in a report and files on the
     * task page (handler/self_learning.ts SubjectiveTaskHandler); nothing
     * is judged, so their points are graded by the teacher outside the
     * scoreboard. Tests do not offer the section (parsePaper still accepts
     * it, so the shape is shared).
     */
    subj: { pids: number[], scores: Record<number, number> };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * The stored sections of a test, or — for a test saved before this editor
 * existed — its problems classified by kind and question type, with the
 * stored per-problem weights (default 100 each) as the points.
 */
export async function paperOf(domainId: string, tdoc?: Tdoc): Promise<PaperSections> {
    const empty: PaperSections = {
        tf: { total: 0, pids: [] }, choice: { total: 0, pids: [] }, blank: { total: 0, pids: [] }, prog: { pids: [], scores: {} }, subj: { pids: [], scores: {} },
    };
    if (!tdoc) return empty;
    const stored = (tdoc as any).sections;
    if (stored && typeof stored === 'object') {
        for (const k of PAPER_SECTIONS) {
            empty[k].total = +stored[k]?.total || 0;
            empty[k].pids = (stored[k]?.pids || []).map((x) => +x).filter((x) => x);
        }
        for (const k of SCORED_SECTIONS) {
            empty[k].pids = (stored[k]?.pids || []).map((x) => +x).filter((x) => x);
            empty[k].scores = stored[k]?.scores || {};
        }
        return empty;
    }
    const pdict = await problem.getList(domainId, tdoc.pids, true, false, ['docId', 'pid', 'content'] as any, true);
    for (const pid of tdoc.pids) {
        const pdoc = pdict[pid];
        const weight = tdoc.score?.[pid] ?? 100;
        if (pdoc && /^o/i.test(String(pdoc.pid || ''))) {
            const sub = objectiveSubKindOf(pdoc.content) || 'choice';
            empty[sub].pids.push(pid);
            empty[sub].total = round2(empty[sub].total + weight);
        } else if (pdoc && /^s/i.test(String(pdoc.pid || ''))) {
            empty.subj.pids.push(pid);
            empty.subj.scores[pid] = weight;
        } else {
            empty.prog.pids.push(pid);
            empty.prog.scores[pid] = weight;
        }
    }
    return empty;
}

/**
 * Validate the editor's paper JSON and turn it into the problem order, the
 * per-problem weights and the sections to store. Objective sections split
 * their total evenly over their tasks (10 points over 5 true/false tasks =
 * 2 each); programming tasks carry the points the teacher typed.
 */
export async function parsePaper(domainId: string, raw: string, viewer: any) {
    let j: any;
    try {
        j = JSON.parse(raw);
    } catch {
        throw new ValidationError('paper');
    }
    if (!j || typeof j !== 'object') throw new ValidationError('paper');
    const ids = (v: any) => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((x) => +x).filter((x) => Number.isInteger(x) && x > 0))];
    const points = (v: any) => {
        const n = Math.round((+v || 0) * 100) / 100;
        if (!(n >= 0) || n > 1000) throw new ValidationError('paper');
        return n;
    };
    const sections: PaperSections = {
        tf: { total: points(j.tf?.total), pids: ids(j.tf?.pids) },
        choice: { total: points(j.choice?.total), pids: ids(j.choice?.pids) },
        blank: { total: points(j.blank?.total), pids: ids(j.blank?.pids) },
        prog: { pids: ids(j.prog?.pids), scores: {} },
        subj: { pids: ids(j.subj?.pids), scores: {} },
    };
    for (const k of SCORED_SECTIONS) for (const pid of sections[k].pids) sections[k].scores[pid] = points(j[k]?.scores?.[pid]);
    const all = [...sections.tf.pids, ...sections.choice.pids, ...sections.blank.pids, ...sections.prog.pids, ...sections.subj.pids];
    const pids = [...new Set(all)];
    const pdict = await problem.getList(domainId, pids, viewer.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || viewer._id, false, ['docId', 'pid'] as any, true);
    for (const pid of pids) if (!pdict[pid]) throw new ValidationError('paper', `problem ${pid}`);
    // Kind guard: objective sections hold O-tasks, the programming section
    // P-tasks, the subjective section S-tasks.
    for (const k of PAPER_SECTIONS) for (const pid of sections[k].pids) if (!/^o/i.test(String(pdict[pid].pid || ''))) throw new ValidationError('paper', `${pid} is not an objective task`);
    for (const pid of sections.prog.pids) if (/^[os]/i.test(String(pdict[pid].pid || ''))) throw new ValidationError('paper', `${pid} is not a programming task`);
    for (const pid of sections.subj.pids) if (!/^s/i.test(String(pdict[pid].pid || ''))) throw new ValidationError('paper', `${pid} is not a subjective task`);
    const score: Record<number, number> = {};
    for (const k of PAPER_SECTIONS) {
        const n = sections[k].pids.length;
        for (const pid of sections[k].pids) score[pid] = n ? round2(sections[k].total / n) : 0;
    }
    for (const k of SCORED_SECTIONS) for (const pid of sections[k].pids) score[pid] = sections[k].scores[pid];
    return { pids, score, sections };
}

/**
 * PTA: the student's detailed results, shown on the test page once the
 * container has ended (contest_detail.html "Your results"): the objective
 * sections and the programming tasks with, per task, the points it is
 * worth and the points earned (weight × judged score / 100), plus totals.
 */
export async function myResultsOf(domainId: string, tdoc: Tdoc, detail: Record<number, any>, uid?: number) {
    const sections = await paperOf(domainId, tdoc);
    const pdict = await problem.getList(domainId, tdoc.pids, true, false, ['docId', 'pid', 'title', 'content'] as any, true);
    const sectionOf: Record<number, string> = {};
    for (const key of PAPER_SECTIONS) for (const pid of sections[key].pids) sectionOf[pid] = key;
    for (const pid of tdoc.pids) {
        const pdoc = pdict[pid];
        if (pdoc && /^o/i.test(String(pdoc.pid || '')) && !sectionOf[pid]) sectionOf[pid] = objectiveSubKindOf(pdoc.content) || 'choice';
    }
    const weightOf = (pid: number) => (typeof tdoc.score?.[pid] === 'number' ? tdoc.score[pid] : 100);
    const rowOf = (pid: number, index: number) => {
        const d = detail?.[pid];
        // PTA fork: a teacher-adjusted task counts as judged even without a
        // submission (a hand-graded task); the adjustment travels with the row.
        const adjusted = d?.override ? { computed: d.override.computed, reason: d.override.reason, at: d.override.at } : null;
        const judged = !!adjusted || (!!d?.rid && d.status !== STATUS.STATUS_WAITING);
        const score = judged ? (d.score || 0) : 0;
        const full = (weightOf(pid) * score) / 100;
        // Homework: the rule stores the penalised, weighted points per task
        // (penaltyScore) — that is what the scoreboard totals, so it is what
        // the student sees; a reduced value is flagged as late.
        const earned = judged && typeof d.penaltyScore === 'number' ? d.penaltyScore : full;
        return {
            docId: pid,
            pid: pdict[pid]?.pid,
            title: pdict[pid]?.title || String(pid),
            index,
            points: round2(weightOf(pid)),
            earned: round2(earned),
            late: judged && earned < full - 1e-9,
            score: judged ? score : null,
            status: d?.status ?? null,
            submitted: !!d?.rid || !!adjusted,
            rid: d?.rid,
            adjusted,
        };
    };
    const meta: Record<string, { name: string, icon: string }> = {
        tf: { name: 'True / False', icon: '✓✗' }, choice: { name: 'Single / Multiple Choice', icon: '◉' }, blank: { name: 'Fill in the Blank', icon: '✎' },
    };
    let n = 0;
    const objective = PAPER_SECTIONS.map((key) => {
        const pids = tdoc.pids.filter((pid) => sectionOf[pid] === key);
        const tasks = pids.map((pid) => rowOf(pid, ++n));
        return {
            key, name: meta[key].name, icon: meta[key].icon, tasks,
            total: round2(tasks.reduce((a, t) => a + t.points, 0)), earned: round2(tasks.reduce((a, t) => a + t.earned, 0)),
        };
    }).filter((g) => g.tasks.length);
    const isSubjective = (pid: number) => /^s/i.test(String(pdict[pid]?.pid || ''));
    const progPids = tdoc.pids.filter((pid) => !sectionOf[pid] && !isSubjective(pid));
    const programming = progPids.map((pid, i) => rowOf(pid, i + 1));
    const groups = [...objective, ...(programming.length ? [{
        key: 'prog', name: 'Programming', icon: '⌨', tasks: programming,
        total: round2(programming.reduce((a, t) => a + t.points, 0)), earned: round2(programming.reduce((a, t) => a + t.earned, 0)),
    }] : [])];
    /*
     * PTA fork: SUBJECTIVE tasks are handed in as a report + files (no
     * judge, no record), so they are listed apart from the auto-graded
     * groups — their points are graded by the teacher by hand and never
     * enter `earned` / `total` below. With a uid, each row says whether
     * the student has handed anything in.
     */
    const subjPids = tdoc.pids.filter(isSubjective);
    const handedIn: Record<number, { files: number, hasReport: boolean, updateAt?: Date } | null> = {};
    if (uid && subjPids.length) {
        await Promise.all(subjPids.map(async (pid) => {
            const doc = await getSubjective(domainId, pid, uid).catch(() => null);
            handedIn[pid] = doc ? { files: (doc.files || []).length, hasReport: !!(doc.report || '').trim(), updateAt: doc.updateAt } : null;
        }));
    }
    const subjective = subjPids.map((pid, i) => {
        // PTA fork: the teacher grades a subjective task through a score
        // adjustment on it (homework_score_override) — that is its grade.
        const d = detail?.[pid];
        const graded = d?.override ? { score: d.score || 0, earned: round2(typeof d.penaltyScore === 'number' ? d.penaltyScore : (weightOf(pid) * (d.score || 0)) / 100), reason: d.override.reason, at: d.override.at } : null;
        return {
            docId: pid,
            pid: pdict[pid]?.pid,
            title: pdict[pid]?.title || String(pid),
            index: i + 1,
            points: round2(weightOf(pid)),
            submitted: uid ? !!(handedIn[pid] && (handedIn[pid].files || handedIn[pid].hasReport)) : null,
            files: handedIn[pid]?.files || 0,
            hasReport: !!handedIn[pid]?.hasReport,
            updateAt: handedIn[pid]?.updateAt || null,
            graded,
        };
    });
    return {
        groups,
        total: round2(groups.reduce((a, g) => a + g.total, 0)),
        earned: round2(groups.reduce((a, g) => a + g.earned, 0)),
        subjective: {
            tasks: subjective,
            total: round2(subjective.reduce((a, t) => a + t.points, 0)),
            earned: subjective.some((t) => t.graded) ? round2(subjective.reduce((a, t) => a + (t.graded ? t.graded.earned : 0), 0)) : null,
            graded: subjective.filter((t) => t.graded).length,
        },
    };
}

export class ContestListHandler extends Handler {
    @param('rule', Types.Range(contest.RULES), true)
    @param('group', Types.Name, true)
    @param('page', Types.PositiveInt, true)
    @param('q', Types.String, true)
    async get(domainId: string, rule = '', group = '', page = 1, q = '') {
        if (rule && contest.RULES[rule].hidden) throw new BadRequestError();
        const groups = (await user.listGroup(domainId, this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST) ? undefined : this.user._id))
            .map((i) => i.name);
        if (group && !groups.includes(group)) throw new NotAssignedError(group);
        const rules = Object.keys(contest.RULES).filter((i) => !contest.RULES[i].hidden);
        const escaped = escapeRegExp(q.toLowerCase());
        const $regex = new RegExp(q.length >= 2 ? escaped : `\\A${escaped}`, 'gim');
        const filter = {
            ...(this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST) && !group)
                ? {}
                : {
                    $or: [
                        { maintainer: this.user._id },
                        { owner: this.user._id },
                        { assign: { $in: groups } },
                        { assign: { $size: 0 } },
                    ],
                },
            ...rule ? { rule } : { rule: { $in: rules } },
            ...group ? { assign: { $in: [group] } } : {},
            ...q ? { title: { $regex } } : {},
        };
        await this.ctx.parallel('contest/list', filter, this);
        const cursor = contest.getMulti(domainId, filter).sort({ endAt: -1, beginAt: -1, _id: -1 });
        let qs = rule ? `rule=${rule}` : '';
        if (group) qs += qs ? `&group=${group}` : `group=${group}`;
        if (q) qs += `${qs ? '&' : ''}q=${encodeURIComponent(q)}`;
        const [tdocs, tpcount] = await this.paginate(cursor, page, 'contest');
        const tids = [];
        for (const tdoc of tdocs) tids.push(tdoc.docId);
        const tsdict = await contest.getListStatus(domainId, this.user._id, tids);
        const groupsFilter = groups.filter((i) => !Number.isSafeInteger(+i));
        this.response.template = 'contest_main.html';
        this.response.body = {
            page, tpcount, qs, rule, tdocs, tsdict, groups: groupsFilter, group, q,
        };
    }
}

export class ContestDetailBaseHandler extends Handler {
    tdoc?: Tdoc;
    tsdoc?: ContestStatusDoc;

    @param('tid', Types.ObjectId, true)
    async __prepare(domainId: string, tid: ObjectId) {
        if (!tid) return; // ProblemDetailHandler also extends from ContestDetailBaseHandler
        [this.tdoc, this.tsdoc] = await Promise.all([
            contest.get(domainId, tid),
            contest.getStatus(domainId, tid, this.user._id),
        ]);
        if (this.tdoc.assign?.length && !this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)) {
            const groups = await user.listGroup(domainId, this.user._id);
            if (!new Set(this.tdoc.assign).intersection(new Set(groups.map((i) => i.name))).size) {
                throw new NotAssignedError('contest', tid);
            }
        }
        if (this.tdoc.duration && this.tsdoc?.startAt) {
            this.tsdoc.endAt = moment.min([
                moment(this.tsdoc.startAt).add(this.tdoc.duration, 'hours'),
                moment(this.tdoc.endAt),
                ...(this.tsdoc.endAt ? [moment(this.tsdoc.endAt)] : []),
            ]).toDate();
        }
    }

    tsdocAsPublic() {
        if (!this.tsdoc) return null;
        return pick(this.tsdoc, ['attend', 'subscribe', 'startAt', ...(this.tdoc.duration || this.tsdoc.endAt ? ['endAt'] : [])]);
    }

    @param('tid', Types.ObjectId, true)
    async after(domainId: string, tid: ObjectId) {
        // PTA: the client-side deadline hand-off never moves managers.
        if (this.tdoc) this.UiContext.canManageContest = this.user.own(this.tdoc) || this.user.hasPerm(PERM.PERM_EDIT_CONTEST);
        if (!tid || this.tdoc.rule === 'homework') return;
        if (this.request.json || !this.response.template) return;
        const pdoc = 'pdoc' in this ? (this as any).pdoc : {};
        this.response.body.overrideNav = [
            {
                name: 'contest_main',
                args: {},
                displayName: 'Back to contest list',
                checker: () => true,
            },
            {
                name: 'contest_detail',
                displayName: this.tdoc.title,
                args: { tid, prefix: 'contest_detail' },
                checker: () => true,
            },
            (this.user.own(this.tdoc) || this.user.hasPerm(PERM.PERM_EDIT_CONTEST))
                ? {
                    name: 'contest_problemlist',
                    args: { tid, prefix: 'contest_problemlist' },
                    checker: () => this.tsdoc?.attend || contest.isDone(this.tdoc),
                }
                // PTA: students open the one-page paper (the test UI) instead of the list.
                : {
                    name: 'contest_paper',
                    displayName: 'Problem List',
                    args: { tid, prefix: 'contest_paper' },
                    checker: () => this.tsdoc?.attend || contest.isDone(this.tdoc),
                },
            {
                name: 'contest_print',
                args: { tid, prefix: 'contest_print' },
                checker: () => this.tdoc.allowPrint && (this.tsdoc?.attend || this.user.own(this.tdoc) || this.user.hasPerm(PERM.PERM_EDIT_CONTEST)),
            },
            {
                name: 'contest_scoreboard',
                args: { tid, prefix: 'contest_scoreboard' },
                checker: () => contest.canShowScoreboard.call(this, this.tdoc, true),
            },
            {
                name: 'problem_detail',
                displayName: `${getAlphabeticId(this.tdoc.pids.indexOf(pdoc.docId))}. ${pdoc.title}`,
                args: { query: { tid }, pid: pdoc.docId, prefix: 'contest_detail_problem' },
                checker: () => 'pdoc' in this,
            },
        ];
    }
}

export class ContestDetailHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        if (contest.RULES[this.tdoc.rule].hidden) throw new ContestNotFoundError(domainId, tid);
    }

    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        this.response.template = 'contest_detail.html';
        const udict = await user.getList(domainId, [this.tdoc.owner]);
        this.response.body = {
            tdoc: this.tdoc,
            tsdoc: this.tsdocAsPublic(),
            udict,
            files: (this.tsdoc?.attend && !contest.isNotStarted(this.tdoc)) ? sortFiles(this.tdoc.privateFiles || []) : [],
            urlForFile: (filename: string) => this.url('contest_file_download', { tid, filename, type: 'private' }),
        };
        if (this.request.json) return;
        this.response.body.tdoc.content = this.response.body.tdoc.content
            .replace(/\(file:\/\//g, `(./${this.tdoc.docId}/file/public/`)
            .replace(/="file:\/\//g, `="./${this.tdoc.docId}/file/public/`);
        /*
         * PTA: once the test has ended — this page is where students land
         * at the deadline — make sure the end-of-test evaluation has run
         * (fallback for the schedule task), then show the attendee's
         * detailed scores (contest_detail.html "Your results").
         */
        if (contest.isDone(this.tdoc, this.tsdoc)) {
            if (!(this.tdoc as any).objectiveSynced) {
                await evaluateContainerResults(domainId, this.tdoc).catch(() => { /* retried on the next visit */ });
                this.tsdoc = await contest.getStatus(domainId, tid, this.user._id) || this.tsdoc;
            }
            if (this.tsdoc?.attend) this.response.body.myResults = await myResultsOf(domainId, this.tdoc, this.tsdoc.detail || {});
        }
    }

    @param('tid', Types.ObjectId)
    @param('code', Types.String, true)
    async postAttend(domainId: string, tid: ObjectId, code = '') {
        this.checkPerm(PERM.PERM_ATTEND_CONTEST);
        if (contest.isDone(this.tdoc)) throw new ContestNotLiveError(domainId, tid);
        if (this.tdoc._code && code !== this.tdoc._code) throw new InvalidTokenError('Contest Invitation', code);
        await contest.attend(domainId, tid, this.user._id, { subscribe: 1 });
        this.back();
    }

    @param('tid', Types.ObjectId)
    @param('subscribe', Types.Boolean)
    async postSubscribe(domainId: string, tid: ObjectId, subscribe = false) {
        if (!this.tsdoc?.attend) throw new ContestNotAttendedError(domainId, tid);
        await contest.setStatus(domainId, tid, this.user._id, { subscribe: subscribe ? 1 : 0 });
        this.back();
    }

    @param('tid', Types.ObjectId)
    async postEarlyEnd(domainId: string, tid: ObjectId) {
        if (this.tdoc.rule === 'homework') throw new ContestNotFoundError(domainId, tid);
        if (!this.tsdoc?.attend) throw new ContestNotAttendedError(domainId, tid);
        if (!contest.isOngoing(this.tdoc, this.tsdoc)) throw new ContestNotLiveError(domainId, tid);
        const now = new Date();
        await contest.setStatus(domainId, tid, this.user._id, { endAt: now, ...(!this.tsdoc.startAt ? { startAt: now } : {}) });
        this.back();
    }
}

export class ContestPrintHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    async prepare({ domainId }, tid: ObjectId) {
        if (!this.tdoc?.allowPrint) throw new NotFoundError();
        if (!this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_EDIT_CONTEST) && !this.tsdoc?.attend) {
            throw new ContestNotAttendedError(domainId, tid);
        }
    }

    async get() {
        this.response.body = { tdoc: this.tdoc };
        this.response.template = 'contest_print.html';
    }

    async post() {
        if (this.args.operation) return;
        if (this.args.file_contents && this.args.original_name) {
            try {
                await (this.postPrint as any)({
                    ...this.args,
                    title: this.args.original_name,
                    content: Buffer.from(this.args.file_contents, 'base64').toString('utf-8'),
                });
                this.response.body = { success: true, output: '' };
            } catch (e) {
                this.response.body = { success: false, output: e.message };
            } finally {
                delete this.response.redirect;
            }
        } else throw new MethodNotAllowedError('POST');
    }

    @param('tid', Types.ObjectId)
    @param('title', Types.Title, true)
    @param('content', Types.Content, true)
    async postPrint(domainId: string, tid: ObjectId, title = '', content = '') {
        if (!this.tsdoc?.attend) throw new ContestNotAttendedError(domainId, tid);
        if (!contest.isOngoing(this.tdoc, this.tsdoc)) throw new ContestNotLiveError(domainId, tid);
        await this.limitRate('add_print', 3600, 60);
        if (this.request.files?.file) {
            const file = this.request.files.file;
            if (file.size > 1024 * 1024) throw new ValidationError('file');
            content = await readFile(file.filepath, 'utf-8');
            title ||= file.originalFilename || 'file';
        }
        if (!content) throw new ValidationError('content');
        await contest.addPrintTask(domainId, tid, this.user._id, title, content);
        this.back();
    }

    @param('tid', Types.ObjectId)
    async postGetPrintTask(domainId: string, tid: ObjectId) {
        const isContestAdmin = this.user.own(this.tdoc) || this.user.hasPerm(PERM.PERM_EDIT_CONTEST);
        const tasks = await contest.getMultiPrintTask(domainId, tid, isContestAdmin ? {} : { owner: this.user._id })
            .project({ _id: 1, title: 1, owner: 1, status: 1 }).sort({ _id: 1 }).toArray();
        const uids = Array.from(new Set(tasks.map((i) => i.owner)));
        const udict = await user.getListForRender(domainId, uids, this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO));
        this.response.body = { tasks, udict };
    }

    @param('tid', Types.ObjectId)
    async postAllocatePrintTask(domainId: string, tid: ObjectId) {
        if (!this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_EDIT_CONTEST)) {
            throw new PermissionError(PERM.PERM_EDIT_CONTEST);
        }
        const task = await contest.allocatePrintTask(domainId, tid);
        const udoc = task ? await user.getById(domainId, task.owner) : null;
        this.response.body = { task, udoc };
    }

    @param('tid', Types.ObjectId)
    @param('taskId', Types.ObjectId)
    @param('status', Types.Range(['printed', 'pending']))
    async postUpdatePrintTask(domainId: string, tid: ObjectId, taskId: ObjectId, status: 'printed' | 'pending') {
        if (!this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_EDIT_CONTEST)) {
            throw new PermissionError(PERM.PERM_EDIT_CONTEST);
        }
        await contest.updatePrintTask(domainId, tid, taskId, {
            status: status === 'printed' ? contest.PrintTaskStatus.printed : contest.PrintTaskStatus.pending,
        });
        this.response.body = { success: true };
    }
}

export class ContestProblemListHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        if (contest.RULES[this.tdoc.rule].hidden) throw new ContestNotFoundError(domainId, tid);
    }

    /** Students never see the tabular problem list of a Test: the one-page paper is the test UI. */
    private paperForStudents(domainId: string, tid: ObjectId): boolean {
        if (this.request.json) return false;
        if (this.user.own(this.tdoc) || this.user.hasPerm(PERM.PERM_EDIT_CONTEST)) return false;
        if (this.tdoc.rule === 'homework') return false;
        this.response.redirect = this.url('contest_paper', { tid });
        return true;
    }

    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        if (contest.isNotStarted(this.tdoc)) throw new ContestNotLiveError(domainId, tid);
        if (!this.tsdoc?.attend && !contest.isDone(this.tdoc)) throw new ContestNotAttendedError(domainId, tid);
        // PTA: for students the whole test is ONE page — the paper (objective
        // questions inline, programming tasks in its rail). The tabular list
        // stays for managers. JSON callers keep the data. The start stamp is
        // written before leaving so nothing depends on the redirect target.
        if (this.tsdoc?.attend && !this.tsdoc.startAt && contest.isOngoing(this.tdoc)) {
            await contest.setStatus(domainId, tid, this.user._id, { startAt: new Date() });
            this.tsdoc.startAt = new Date();
        }
        if (this.paperForStudents(domainId, tid)) return;
        // Fallback for the end-of-test schedule task (see evaluateContainerResults).
        if (contest.isDone(this.tdoc) && !(this.tdoc as any).objectiveSynced) {
            await evaluateContainerResults(domainId, this.tdoc).catch(() => { /* retried on the next visit */ });
        }
        const [pdict, udict, tcdocs] = await Promise.all([
            problem.getList(domainId, this.tdoc.pids, true, true, problem.PROJECTION_CONTEST_LIST),
            user.getList(domainId, [this.tdoc.owner, this.user._id]),
            contest.getMultiClarification(domainId, tid, this.user._id),
        ]);
        this.response.body = {
            pdict, psdict: {}, udict, rdict: {}, tdoc: this.tdoc, tcdocs,
        };
        this.response.template = 'contest_problemlist.html';
        this.response.body.showScore = Object.values(this.tdoc.score || {}).some((i) => i && i !== 100);
        if (!this.tsdoc) return;
        if (this.tsdoc.attend && !this.tsdoc.startAt && contest.isOngoing(this.tdoc)) {
            await contest.setStatus(domainId, tid, this.user._id, { startAt: new Date() });
            this.tsdoc.startAt = new Date();
        }
        this.response.body.tsdoc = this.tsdocAsPublic();
        this.response.body.psdict = this.tsdoc.detail || {};
        const psdocs: any[] = Object.values(this.response.body.psdict);
        const canViewRecord = contest.canShowSelfRecord.call(this, this.tdoc);
        this.response.body.canViewRecord = canViewRecord;
        const rids = psdocs.map((i) => i.rid);
        if (contest.isDone(this.tdoc) && canViewRecord) {
            const correction = await problem.getListStatus(domainId, this.user._id, this.tdoc.pids);
            for (const pid in correction) {
                if (this.tsdoc.detail?.[pid]?.rid === correction[pid].rid) delete correction[pid];
            }
            rids.push(...Object.values(correction).map((i) => i.rid));
            this.response.body.correction = correction;
        }
        [this.response.body.rdict, this.response.body.rdocs] = canViewRecord
            ? await Promise.all([
                record.getList(domainId, rids),
                record.getMulti(domainId, { contest: tid, uid: this.user._id })
                    .sort({ _id: -1 }).toArray(),
            ])
            : [Object.fromEntries(psdocs.map((i) => [i.rid, { _id: i.rid }])), []];
        if (!this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_EDIT_CONTEST)) {
            this.response.body.rdocs = this.response.body.rdocs.map((rdoc) => contest.applyProjection(this.tdoc, rdoc, this.user));
            for (const key in this.response.body.rdict) {
                this.response.body.rdict[key] = contest.applyProjection(this.tdoc, this.response.body.rdict[key], this.user);
            }
            for (const key in this.response.body.psdict) {
                this.response.body.psdict[key] = contest.applyProjection(this.tdoc, this.response.body.psdict[key], this.user);
            }
        }
    }

    @param('tid', Types.ObjectId)
    @param('content', Types.Content)
    @param('subject', Types.Int)
    async postClarification(domainId: string, tid: ObjectId, content: string, subject: number) {
        if (!this.tsdoc?.attend) throw new ContestNotAttendedError(domainId, tid);
        if (!contest.isOngoing(this.tdoc)) throw new ContestNotLiveError(domainId, tid);
        await this.limitRate('add_discussion', 3600, 60);
        await contest.addClarification(domainId, tid, this.user._id, content, this.request.ip, subject);
        if (!this.user.own(this.tdoc)) {
            await message.send(1, (this.tdoc.maintainer || []).concat(this.tdoc.owner), JSON.stringify({
                message: 'Contest {0} has a new clarification about {1}, please go to contest clarifications page to reply.',
                params: [this.tdoc.title, subject > 0 ? `#${this.tdoc.pids.indexOf(subject) + 1}` : 'the contest'],
                url: this.url('contest_clarification', { tid }),
            }), message.FLAG_I18N | message.FLAG_UNREAD);
        }
        this.back();
    }
}

export class ContestEditHandler extends Handler {
    tdoc: Tdoc;

    @param('tid', Types.ObjectId, true)
    async prepare(domainId: string, tid: ObjectId) {
        if (tid) {
            this.tdoc = await contest.get(domainId, tid);
            if (!this.tdoc) throw new ContestNotFoundError(domainId, tid);
            if (contest.RULES[this.tdoc.rule].hidden) throw new ContestNotFoundError(domainId, tid);
            if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            else this.checkPerm(PERM.PERM_EDIT_CONTEST_SELF);
        } else this.checkPerm(PERM.PERM_CREATE_CONTEST);
    }

    @param('tid', Types.ObjectId, true)
    async get(domainId: string, tid: ObjectId) {
        this.response.template = 'contest_edit.html';
        const rules = {};
        for (const i in contest.RULES) {
            if (!contest.RULES[i].hidden) {
                rules[i] = contest.RULES[i].TEXT;
            }
        }
        let ts = Date.now();
        ts = ts - (ts % (15 * Time.minute)) + 15 * Time.minute;
        const beginAt = moment(this.tdoc?.beginAt || new Date(ts)).tz(this.user.timeZone);
        this.response.body = {
            rules,
            tdoc: this.tdoc,
            duration: tid ? -beginAt.diff(this.tdoc.endAt, 'hour', true) : 2,
            pids: tid ? this.tdoc.pids.join(',') : '',
            beginAt,
            page_name: tid ? 'contest_edit' : 'contest_create',
            files: tid ? this.tdoc.files : [],
            urlForFile: (filename: string) => this.url('contest_file_download', { tid, filename, type: 'public' }),
        };
        // PTA test editor: the paper as four sections. The stored layout is
        // used when the test was saved by this editor; older tests are
        // classified from their problems so they open in the same form.
        this.UiContext.paper = await paperOf(domainId, this.tdoc);
    }

    @param('tid', Types.ObjectId, true)
    @param('beginAtDate', Types.Date)
    @param('beginAtTime', Types.Time)
    @param('duration', Types.Float)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('rule', Types.String, true)
    @param('pids', Types.Content)
    @param('rated', Types.Boolean)
    @param('code', Types.String, true)
    @param('autoHide', Types.Boolean)
    @param('assign', Types.CommaSeperatedArray, true)
    @param('lock', Types.UnsignedInt, true)
    @param('contestDuration', Types.Float, true)
    @param('maintainer', Types.NumericArray, true)
    @param('allowViewCode', Types.Boolean)
    @param('allowPrint', Types.Boolean)
    @param('keepScoreboardHidden', Types.Boolean)
    @param('langs', Types.CommaSeperatedArray, true)
    @param('paper', Types.Content, true)
    async postUpdate(
        domainId: string, tid: ObjectId, beginAtDate: string, beginAtTime: string, duration: number,
        title: string, content: string, rule: string, _pids: string, rated = false,
        _code = '', autoHide = false, assign: string[] = [], lock: number = null,
        contestDuration: number = null, maintainer: number[] = [], allowViewCode = false, allowPrint = false,
        keepScoreboardHidden = false, langs: string[] = [], paper = '',
    ) {
        // PTA: one rule for every test (model/contest TEST_RULE). A test that
        // was created under a legacy rule keeps it until it is re-saved.
        rule = contest.TEST_RULE;
        if (autoHide) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
        // PTA test editor: the four-section paper (objective sections with a
        // total each, programming tasks with their own points) decides the
        // problem order and the per-problem weights (tdoc.score, the native
        // OI/IOI weighting). The plain `pids` field remains for API callers.
        const parsedPaper = paper ? await parsePaper(domainId, paper, this.user) : null;
        const pids = parsedPaper ? parsedPaper.pids : _pids.replace(/，/g, ',').split(',').map((i) => +i).filter((i) => i);
        const beginAtMoment = moment.tz(`${beginAtDate} ${beginAtTime}`, this.user.timeZone);
        if (!beginAtMoment.isValid()) throw new ValidationError('beginAtDate', 'beginAtTime');
        const endAt = beginAtMoment.clone().add(duration, 'hours').toDate();
        if (beginAtMoment.isSameOrAfter(endAt)) throw new ValidationError('duration');
        const beginAt = beginAtMoment.toDate();
        const lockAt = lock ? moment(endAt).add(-lock, 'minutes').toDate() : null;
        if (lockAt && contestDuration) throw new ValidationError('lockAt', 'duration');
        const pdict = await problem.getList(domainId, pids, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id, true);
        // 🌐 Sanitized, and refused if it would make a listed problem unsubmittable.
        langs = resolveAllowedLangs(langs, pdict, pids);
        if (tid) {
            await contest.edit(domainId, tid, {
                title, content, rule, beginAt, endAt, pids, rated, duration: contestDuration,
            });
            if (this.tdoc.beginAt !== beginAt || this.tdoc.endAt !== endAt
                || diffArray(this.tdoc.pids, pids) || this.tdoc.rule !== rule
                || lockAt !== this.tdoc.lockAt) {
                await contest.recalcStatus(domainId, this.tdoc.docId);
            }
        } else {
            tid = await contest.add(domainId, title, content, this.user._id, rule, beginAt, endAt, pids, rated, { duration: contestDuration });
        }
        const task = {
            type: 'schedule', subType: 'contest', domainId, tid,
        };
        await ScheduleModel.deleteMany(task);
        const operation = [];
        if (Date.now() <= endAt.getTime() && autoHide) {
            await Promise.all(pids.map((pid) => problem.edit(domainId, pid, { hidden: true })));
            operation.push('unhide');
        }
        // Objective answers are scored on the problem set only when the test ends.
        if (Date.now() <= endAt.getTime() && hasObjectiveTask(pids, pdict)) operation.push('syncObjective');
        if (tid && this.tdoc && (this.tdoc as any).objectiveSynced && Date.now() <= endAt.getTime()) {
            await contest.edit(domainId, tid, { objectiveSynced: false } as any);
        }
        // Ended early (the end moved into the past): evaluate every student now,
        // so the scoreboard is complete the moment the teacher opens it.
        if (tid && Date.now() > endAt.getTime()) {
            const fresh = await contest.get(domainId, tid);
            if (fresh) await evaluateContainerResults(domainId, { ...fresh, objectiveSynced: false } as any);
        }
        if (operation.length) {
            await ScheduleModel.add({
                ...task,
                operation,
                executeAfter: endAt,
            });
        }
        await contest.edit(domainId, tid, {
            assign, _code, autoHide, lockAt, maintainer, allowViewCode, allowPrint, keepScoreboardHidden, langs,
            ...(parsedPaper ? { score: parsedPaper.score, sections: parsedPaper.sections } : {}),
        } as any);
        this.response.body = { tid };
        this.response.redirect = this.url('contest_detail', { tid });
    }

    @param('tid', Types.ObjectId)
    async postDelete(domainId: string, tid: ObjectId) {
        if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
        const [ddocs] = await Promise.all([
            discussion.getMulti(domainId, { parentType: document.TYPE_CONTEST, parentId: tid }).project({ _id: 1 }).toArray(),
            contest.del(domainId, tid),
        ]);
        const tasks: any[] = ddocs.map((i) => discussion.del(domainId, i._id));
        await Promise.all(tasks.concat([
            record.updateMulti(domainId, { domainId, contest: tid }, undefined, undefined, { contest: '' }),
            ScheduleModel.deleteMany({
                type: 'schedule', subType: 'contest', domainId, tid,
            }),
            storage.del(
                (this.tdoc.files?.map((i) => `contest/${domainId}/${tid}/public/${i.name}`) || [])
                    .concat(this.tdoc.privateFiles?.map((i) => `contest/${domainId}/${tid}/private/${i.name}`) || []),
                this.user._id,
            ),
        ]));
        this.response.redirect = this.url('contest_main');
    }
}

export class ContestManagementBaseHandler extends ContestDetailBaseHandler {
    async prepare() {
        if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
    }
}

export class ContestCodeHandler extends Handler {
    @param('tid', Types.ObjectId)
    @param('all', Types.Boolean)
    async get(domainId: string, tid: ObjectId, all: boolean) {
        await this.limitRate('contest_code', 60, 10);
        const [tdoc, tsdocs] = await contest.getAndListStatus(domainId, tid);
        if (!this.user.own(tdoc)) {
            if (!this.user.hasPriv(PRIV.PRIV_READ_RECORD_CODE)) {
                this.checkPerm(PERM.PERM_READ_RECORD_CODE);
            }
            if (!contest.isDone(tdoc)) throw new ContestNotEndedError(domainId, tid);
        }
        if (!contest.canShowRecord.call(this, tdoc as any, true)) {
            throw new PermissionError(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
        }
        const rnames = {};
        for (const tsdoc of tsdocs) {
            if (all) {
                for (const j of tsdoc.journal || []) {
                    let name = `U${tsdoc.uid}_P${j.pid}_R${j.rid}`;
                    if (typeof j.score === 'number') name += `_S${j.status || 0}@${j.score}`;
                    rnames[j.rid] = name;
                }
            } else {
                for (const pid in tsdoc.detail || {}) {
                    let name = `U${tsdoc.uid}_P${pid}_R${tsdoc.detail[pid].rid}`;
                    if (typeof tsdoc.detail[pid].score === 'number') name += `_S${tsdoc.detail[pid].status || 0}@${tsdoc.detail[pid].score}`;
                    rnames[tsdoc.detail[pid].rid] = name;
                }
            }
        }
        const zip = new ZipWriter(new BlobWriter('application/zip'), { bufferedWrite: true });
        const rdocs = await record.getMulti(domainId, {
            _id: { $in: Array.from(Object.keys(rnames)).map((id) => new ObjectId(id)) },
        }).toArray();
        await Promise.all(rdocs.map(async (rdoc) => {
            if (rdoc.files?.code) {
                const [id, filename] = rdoc.files?.code?.split('#') || [];
                if (!id) return;
                await zip.add(
                    `${rnames[rdoc._id.toHexString()]}.${filename || 'txt'}`,
                    Readable.toWeb(await storage.get(`submission/${id}`)),
                );
            } else if (rdoc.code) {
                await zip.add(`${rnames[rdoc._id.toHexString()]}.${rdoc.lang}`, new TextReader(rdoc.code));
            }
        }));
        this.binary(await zip.close(), `${tdoc.title}.zip`);
    }
}

export class ContestManagementHandler extends ContestManagementBaseHandler {
    @param('tid', Types.ObjectId)
    @param('d', Types.Range(['public', 'private']), true)
    @param('sidebar', Types.Boolean)
    async get(domainId: string, tid: ObjectId, d?: string, sidebar?: boolean) {
        this.response.body = {
            tdoc: this.tdoc,
            tsdoc: this.tsdoc,
            owner_udoc: await user.getById(domainId, this.tdoc.owner),
            pdict: await problem.getList(domainId, this.tdoc.pids, true, true, [...problem.PROJECTION_CONTEST_LIST, 'tag']),
            files: sortFiles(this.tdoc.files || []),
            privateFiles: sortFiles(this.tdoc.privateFiles || []),
            urlForFile: (filename: string, type: string) => this.url('contest_file_download', { tid, filename, type }),
        };
        this.response.pjax = [
            ...((!d || d === 'public') ? [['partials/files.html', { filetype: 'public', sidebar }] as const] : []),
            ...((!d || d === 'private') ? [['partials/files.html', {
                files: this.response.body.privateFiles,
                filetype: 'private',
                sidebar,
            }] as const] : []),
        ];
        this.response.template = 'contest_manage.html';
    }

    @param('tid', Types.ObjectId)
    @post('filename', Types.Filename, true)
    @post('type', Types.Range(['private', 'public']), true)
    async postUploadFile(domainId: string, tid: ObjectId, filename: string, type: 'private' | 'public' = 'private') {
        const allFiles = [...(this.tdoc.files || []), ...(this.tdoc.privateFiles || [])];
        if (allFiles.length >= this.ctx.setting.get('limit.contest_files')) {
            throw new FileLimitExceededError('count');
        }
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        if (Math.sum(allFiles.map((i) => i.size)) + file.size >= this.ctx.setting.get('limit.contest_files_size')) {
            throw new FileLimitExceededError('size');
        }
        filename ||= file.originalFilename || randomstring(16);
        const target = `contest/${domainId}/${tid}/${type}/${filename}`;
        await storage.put(target, file.filepath, this.user._id);
        const meta = await storage.getMeta(target);
        const payload = { _id: filename, name: filename, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!meta) throw new FileUploadError();
        const updateList = (files: FileInfo[], newFile: FileInfo) => (files || []).filter((i) => i._id !== newFile._id).concat(newFile);
        await contest.edit(domainId, tid, {
            files: type === 'private' ? this.tdoc.files : updateList(this.tdoc.files, payload),
            privateFiles: type === 'private' ? updateList(this.tdoc.privateFiles, payload) : this.tdoc.privateFiles,
        });
        this.back();
    }

    @param('tid', Types.ObjectId)
    @post('files', Types.ArrayOf(Types.Filename))
    @post('type', Types.Range(['public', 'private']), true)
    async postDeleteFiles(domainId: string, tid: ObjectId, files: string[], type = 'private') {
        await Promise.all([
            storage.del(files.map((t) => `contest/${domainId}/${tid}/${type}/${t}`), this.user._id),
            contest.edit(domainId, tid, type === 'private'
                ? { privateFiles: this.tdoc.privateFiles?.filter((i) => !files.includes(i.name)) }
                : { files: this.tdoc.files?.filter((i) => !files.includes(i.name)) },
            ),
        ]);
        this.back();
    }

    @param('pid', Types.PositiveInt)
    @param('score', Types.PositiveInt)
    async postSetScore(domainId: string, pid: number, score: number) {
        if (!this.tdoc.pids.includes(pid)) throw new ValidationError('pid');
        this.tdoc.score ||= {};
        this.tdoc.score[pid] = score;
        await contest.edit(domainId, this.tdoc.docId, { score: this.tdoc.score });
        await contest.recalcStatus(domainId, this.tdoc.docId);
        this.back();
    }
}

class ContestClarificationHandler extends ContestManagementBaseHandler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const tcdocs = await contest.getMultiClarification(domainId, tid);
        this.response.body = {
            tdoc: this.tdoc,
            tsdoc: this.tsdoc,
            owner_udoc: await user.getById(domainId, this.tdoc.owner),
            pdict: await problem.getList(domainId, this.tdoc.pids, true, true, [...problem.PROJECTION_CONTEST_LIST, 'tag']),
            tcdocs,
            udict: await user.getListForRender(
                domainId, tcdocs.map((i) => i.owner),
                this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO),
            ),
        };
        this.response.pjax = 'partials/contest_clarification.html';
        this.response.template = 'contest_clarification.html';
    }

    @param('tid', Types.ObjectId)
    @param('content', Types.Content)
    @param('did', Types.ObjectId, true)
    @param('subject', Types.Int, true)
    async postClarification(domainId: string, tid: ObjectId, content: string, did: ObjectId, subject = 0) {
        if (did) {
            const tcdoc = await contest.getClarification(domainId, did);
            await Promise.all([
                contest.addClarificationReply(domainId, did, 0, content, this.request.ip),
                message.send(1, tcdoc.owner, JSON.stringify({
                    message: 'Contest {0} jury replied to your clarification, please go to contest page to view.',
                    params: [this.tdoc.title],
                    url: this.url('contest_problemlist', { tid }),
                }), message.FLAG_I18N | message.FLAG_ALERT),
            ]);
        } else {
            const tsdocs = await contest.getMultiStatus(domainId, { docId: tid, subscribe: 1 }).toArray();
            const uids = Array.from<number>(new Set(tsdocs.map((tsdoc) => tsdoc.uid)));
            const flag = contest.isOngoing(this.tdoc) ? message.FLAG_ALERT : message.FLAG_UNREAD;
            await Promise.all([
                contest.addClarification(domainId, tid, 0, content, this.request.ip, subject),
                message.send(1, uids, JSON.stringify({
                    message: 'Broadcast message from contest {0}:\n{1}',
                    params: [this.tdoc.title, content],
                    url: this.url('contest_problemlist', { tid }),
                }), flag | message.FLAG_I18N),
            ]);
        }
        this.back();
    }
}

export class ContestFileDownloadHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean)
    @param('type', Types.Range(['public', 'private']), true)
    async get(domainId: string, tid: ObjectId, filename: string, noDisposition = false, type = 'private') {
        if (contest.RULES[this.tdoc.rule].hidden && !contest.RULES[this.tdoc.rule].features?.includes('download')) {
            throw new ContestNotFoundError(domainId, tid);
        }
        if (type === 'private' && !this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_EDIT_CONTEST)) {
            if (!this.tsdoc?.attend) throw new ContestNotAttendedError(domainId, tid);
            if (!contest.isOngoing(this.tdoc) && !contest.isDone(this.tdoc)) throw new ContestNotLiveError(domainId, tid);
            if (!this.tsdoc.startAt) await contest.setStatus(domainId, tid, this.user._id, { startAt: new Date() });
        }
        this.response.addHeader('Cache-Control', 'public');
        const target = `contest/${domainId}/${tid}/${type}/${filename}`;
        const file = await storage.getMeta(target);
        await oplog.log(this, 'download.file.contest', {
            target,
            size: file?.size || 0,
        });
        this.response.redirect = await storage.signDownloadLink(
            target, noDisposition ? undefined : filename, false, 'user',
        );
    }
}

export class ContestUserHandler extends ContestManagementBaseHandler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const tsdocs = await contest.getMultiStatus(domainId, { docId: tid }).project({
            uid: 1, attend: 1, startAt: 1, unrank: 1, endAt: 1,
        }).toArray();
        for (const tsdoc of tsdocs) {
            if (this.tdoc.duration && tsdoc.startAt) {
                tsdoc.endAt = moment.min([
                    moment(tsdoc.startAt).add(this.tdoc.duration, 'hours'),
                    moment(this.tdoc.endAt),
                    ...(tsdoc.endAt ? [moment(tsdoc.endAt)] : []),
                ]).toDate();
            }
        }
        const udict = await user.getListForRender(
            domainId, [this.tdoc.owner, ...tsdocs.map((i) => i.uid)],
            this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO),
        );
        this.response.body = { tdoc: this.tdoc, tsdocs, udict };
        this.response.pjax = 'partials/contest_user.html';
        this.response.template = 'contest_user.html';
    }

    @param('tid', Types.ObjectId)
    @param('uids', Types.NumericArray)
    @param('unrank', Types.Boolean)
    async postAddUser(domainId: string, tid: ObjectId, uids: number[], unrank = false) {
        await Promise.all(uids.map((uid) => contest.attend(domainId, tid, uid, { unrank })));
        this.back();
    }

    @param('tid', Types.ObjectId)
    @param('uid', Types.PositiveInt)
    async postRank(domainId: string, tid: ObjectId, uid: number) {
        const tsdoc = await contest.getStatus(domainId, tid, uid);
        if (!tsdoc) throw new ContestNotAttendedError(uid);
        await contest.setStatus(domainId, tid, uid, { unrank: !tsdoc.unrank });
        this.back();
    }

    @param('tid', Types.ObjectId)
    @param('uid', Types.PositiveInt)
    async postResume(domainId: string, tid: ObjectId, uid: number) {
        const tsdoc = await contest.getStatus(domainId, tid, uid);
        if (!tsdoc?.attend) throw new ContestNotAttendedError(uid);
        if (this.tdoc.endAt <= new Date()) throw new ContestNotLiveError(domainId, tid);
        if (this.tdoc.duration && tsdoc.startAt) {
            const durationEnd = moment(tsdoc.startAt).add(this.tdoc.duration, 'hours').toDate();
            if (durationEnd <= new Date()) throw new ContestNotLiveError(domainId, tid);
        }
        await contest.setStatus(domainId, tid, uid, null, { endAt: '' });
        this.back();
    }

    @param('tid', Types.ObjectId)
    @param('uid', Types.Int)
    async postRemoveUser(domainId: string, tid: ObjectId, uid: number) {
        if (!contest.isNotStarted(this.tdoc)) throw new ContestAlreadyStartedError();
        const tsdoc = await contest.getStatus(domainId, tid, uid);
        if (!tsdoc?.attend) throw new ContestNotAttendedError(uid);
        await contest.cancelAttend(domainId, tid, uid);
        this.back();
    }
}

export class ContestBalloonHandler extends ContestManagementBaseHandler {
    @param('tid', Types.ObjectId)
    @param('todo', Types.Boolean)
    async get(domainId: string, tid: ObjectId, todo = false) {
        const bdocs = await contest.getMultiBalloon(domainId, tid, {
            ...todo ? { sent: { $exists: false } } : {},
            ...(!this.tdoc.lockAt || this.user.hasPerm(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD))
                ? {} : { _id: { $lt: Time.getObjectID(this.tdoc.lockAt) } },
        }).sort({ _id: -1 }).toArray();
        const uids = bdocs.map((i) => i.uid).concat(bdocs.filter((i) => i.sent).map((i) => i.sent));
        this.response.body = {
            tdoc: this.tdoc,
            tsdoc: this.tsdoc,
            owner_udoc: await user.getById(domainId, this.tdoc.owner),
            pdict: await problem.getList(domainId, this.tdoc.pids, true, true, problem.PROJECTION_CONTEST_LIST),
            bdocs,
            udict: await user.getListForRender(domainId, uids, this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO)),
        };
        this.response.pjax = 'partials/contest_balloon.html';
        this.response.template = 'contest_balloon.html';
    }

    @param('tid', Types.ObjectId)
    @param('color', Types.Content)
    async postSetColor(domainId: string, tid: ObjectId, color: string) {
        const config = yaml.load(color);
        if (typeof config !== 'object') throw new ValidationError('color');
        const balloon = {};
        for (const pid of this.tdoc.pids) {
            if (!config[pid]) throw new ValidationError('color');
            balloon[pid] = config[pid.toString()];
        }
        await contest.edit(domainId, tid, { balloon });
        this.back();
    }

    @param('tid', Types.ObjectId)
    @param('balloon', Types.ObjectId)
    async postDone(domainId: string, tid: ObjectId, bid: ObjectId) {
        const balloon = await contest.getBalloon(domainId, tid, bid);
        if (!balloon) throw new ValidationError('balloon');
        if (balloon.sent) throw new ValidationError('Balloon already sent');
        await contest.updateBalloon(domainId, tid, bid, { sent: this.user._id, sentAt: new Date() });
        this.back();
    }
}

interface BuiltinInput {
    tdoc: Tdoc;
    groups: any[];
}
type AnyFunction = (...args: any) => any;
type ParseArgs<T extends { [key: string]: keyof BuiltinInput | AnyFunction | Type<any> }> = {
    [key in keyof T]: T[key] extends keyof BuiltinInput ? BuiltinInput[T[key]] : T[key] extends AnyFunction ? ReturnType<T[key]> : any
};
export interface ScoreboardView<T extends { [key: string]: keyof BuiltinInput | AnyFunction | Type<any> }> {
    id: string;
    name: string;
    supportedRules: string[];
    cacheTime?: number; // in seconds
    args: T;
    display: (this: ContestScoreboardHandler, args: ParseArgs<T>) => Promise<void>;
    checker?: (this: ContestScoreboardHandler) => boolean;
}

export class ContestScoreboardHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    @param('view', Types.String, true)
    async get(domainId: string, tid: ObjectId, viewId = 'default') {
        if (contest.RULES[this.tdoc.rule].hidden && !contest.RULES[this.tdoc.rule].features?.includes('scoreboard')) {
            throw new ContestNotFoundError(domainId, tid);
        }
        if (!this.user.own(this.tdoc)) {
            if (!contest.canShowScoreboard.call(this, this.tdoc, true)) throw new ContestScoreboardHiddenError(tid);
            if (contest.isNotStarted(this.tdoc)) throw new ContestNotLiveError(domainId, tid);
        }
        // A finished container is evaluated before its board is rendered.
        if (contest.isDone(this.tdoc) && !(this.tdoc as any).objectiveSynced) {
            await evaluateContainerResults(domainId, this.tdoc).catch(() => { /* retried on the next visit */ });
        }
        const view = this.ctx.scoreboard.getView(viewId);
        if (!view) throw new NotFoundError(`View ${viewId} not found`);
        const args = {};
        const fetcher = {
            tdoc: () => this.tdoc,
            groups: async () => {
                const allGroups = (this.user.hasPerm(PERM.PERM_EDIT_CONTEST_SELF) && this.user.own(this.tdoc))
                    || this.user.hasPerm(PERM.PERM_EDIT_CONTEST);
                return await user.listGroup(domainId, allGroups ? undefined : this.user._id);
            },
        };
        for (const key in view.args) {
            if (typeof view.args[key] === 'function') {
                try {
                    args[key] = view.args[key](this.args[key]);
                } catch (e) {
                    throw new ValidationError(key);
                }
            } else if (view.args[key] instanceof Array) {
                if (this.args[key] === undefined && view.args[key].find((i) => i === true)) continue;
                if (view.args[key][1] && !view.args[key][1](this.args[key])) throw new ValidationError(key);
                args[key] = view.args[key][0](this.args[key]);
            } else if (fetcher[view.args[key]]) {
                args[key] = await fetcher[view.args[key]](); // eslint-disable-line no-await-in-loop
            }
        }
        await view.display.call(this, args);
        /*
         * PTA fork: teacher score adjustments on the homework scoreboard —
         * the page script (homework_score_override.page.js) turns the score
         * cells into "adjust" affordances for the owner / homework editors.
         */
        if (this.tdoc.rule === 'homework' && (this.user.own(this.tdoc) || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK))) {
            const pdict = await problem.getList(domainId, this.tdoc.pids, true, false, ['docId', 'pid', 'title'] as any, true);
            this.UiContext.scoreOverride = {
                url: this.url('homework_score_override', { tid }),
                pids: this.tdoc.pids,
                labels: Object.fromEntries(this.tdoc.pids.map((pid) => [pid, `${(pdict[pid] as any)?.pid || pid} ${(pdict[pid] as any)?.title || ''}`.trim()])),
                weights: this.tdoc.score || {},
            };
        }
    }

    @param('tid', Types.ObjectId)
    async postUnlock(domainId: string, tid: ObjectId) {
        if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
        if (!contest.isDone(this.tdoc)) throw new ContestNotEndedError(domainId, tid);
        await contest.unlockScoreboard(domainId, tid);
        this.back();
    }
}

class ScoreboardService extends Service {
    views: Record<string, ScoreboardView<any>> = {};
    constructor(ctx: Context) {
        super(ctx, 'scoreboard');
    }

    addView<T extends { [key: string]: keyof BuiltinInput | AnyFunction | Type<any> }>(
        id: string, name: string, args: T,
        { display, supportedRules, cacheTime, checker }: {
            display: (this: ContestScoreboardHandler, args: ParseArgs<T>) => Promise<void>;
            supportedRules: string[];
            cacheTime?: number;
            checker?: (this: ContestScoreboardHandler) => boolean;
        },
    ) {
        if (this.views[id]) throw new Error(`View ${id} already exists`);
        this.ctx.effect(() => {
            this.views[id] = {
                id, name, args, display, supportedRules, cacheTime, checker,
            };
            return () => {
                delete this.views[id];
            };
        });
    }

    getAvailableViews(rule: string, handler: ContestScoreboardHandler) {
        return Object.fromEntries(Object.values(this.views).filter((i) => (
            (i.supportedRules.includes(rule) || i.supportedRules.includes('*'))
            && (!i.checker || i.checker.call(handler))
        )).map((i) => [i.id, i.name]));
    }

    getView(id: string) {
        return this.views[id];
    }
}

declare module 'cordis' {
    interface Context {
        scoreboard: ScoreboardService;
    }
}

export async function apply(ctx: Context) {
    ctx.Route('contest_create', '/contest/create', ContestEditHandler);
    ctx.Route('contest_main', '/contest', ContestListHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_detail', '/contest/:tid', ContestDetailHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_problemlist', '/contest/:tid/problems', ContestProblemListHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_edit', '/contest/:tid/edit', ContestEditHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_print', '/contest/:tid/print', ContestPrintHandler, PERM.PERM_VIEW_CONTEST);
    // Support for DOMJudge printfile
    ctx.Route('contest_print_alt', '/contest/:tid/api/printing/team', ContestPrintHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_manage', '/contest/:tid/management', ContestManagementHandler);
    ctx.Route('contest_clarification', '/contest/:tid/clarification', ContestClarificationHandler);
    ctx.Route('contest_code', '/contest/:tid/code', ContestCodeHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_file_download', '/contest/:tid/file/:type/:filename', ContestFileDownloadHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_user', '/contest/:tid/user', ContestUserHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_balloon', '/contest/:tid/balloon', ContestBalloonHandler, PERM.PERM_VIEW_CONTEST);
    ctx.worker.addHandler('contest', async (doc) => {
        const tdoc = await contest.get(doc.domainId, doc.tid);
        if (!tdoc) return;
        const tasks = [];
        for (const op of doc.operation) {
            if (op === 'unhide') {
                for (const pid of tdoc.pids) {
                    tasks.push(problem.edit(doc.domainId, pid, { hidden: false }));
                }
            }
            if (op === 'syncObjective') tasks.push(evaluateContainerResults(doc.domainId, tdoc));
        }
        await Promise.all(tasks);
    });
    ctx.plugin(ScoreboardService);
    await ctx.inject(['scoreboard'], ({ Route, scoreboard }) => {
        Route('contest_scoreboard', '/contest/:tid/scoreboard', ContestScoreboardHandler, PERM.PERM_VIEW_CONTEST_SCOREBOARD);
        Route('contest_scoreboard_view', '/contest/:tid/scoreboard/:view', ContestScoreboardHandler, PERM.PERM_VIEW_CONTEST_SCOREBOARD);
        scoreboard.addView('default', 'Default', { tdoc: 'tdoc', groups: 'groups', realtime: Types.Boolean }, {
            async display({ realtime, tdoc, groups }) {
                if (realtime && !this.user.own(tdoc)) {
                    this.checkPerm(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
                }
                const config: ScoreboardConfig = { isExport: false, showDisplayName: this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO) };
                if (!realtime && this.tdoc.lockAt && !this.tdoc.unlocked) {
                    config.lockAt = this.tdoc.lockAt;
                }
                const [, rows, udict, pdict] = await contest.getScoreboard.call(this, tdoc.domainId, tdoc._id, config);
                // eslint-disable-next-line ts/naming-convention
                const page_name = tdoc.rule === 'homework'
                    ? 'homework_scoreboard'
                    : 'contest_scoreboard';
                const availableViews = scoreboard.getAvailableViews(tdoc.rule, this);
                this.response.body = {
                    tdoc: this.tdoc, tsdoc: this.tsdocAsPublic(), rows, udict, pdict, page_name, groups, availableViews,
                };
                this.response.pjax = 'partials/scoreboard.html';
                this.response.template = 'contest_scoreboard.html';
            },
            supportedRules: ['*'],
        });
        scoreboard.addView('ghost', 'Ghost', { tdoc: 'tdoc' }, {
            async display({ tdoc }) {
                if (contest.isLocked(tdoc) && !this.user.own(tdoc)) {
                    this.checkPerm(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
                }
                const [pdict, teams] = await Promise.all([
                    problem.getList(tdoc.domainId, tdoc.pids, true, false, problem.PROJECTION_LIST, true),
                    contest.getMultiStatus(tdoc.domainId, { docId: tdoc._id }).toArray(),
                ]);
                const udict = await user.getList(tdoc.domainId, teams.map((i) => i.uid));
                const teamIds: Record<number, number> = {};
                for (let i = 1; i <= teams.length; i++) teamIds[teams[i - 1].uid] = i;
                const time = (t: ObjectId) => Math.floor((t.getTimestamp().getTime() - tdoc.beginAt.getTime()) / Time.second);
                const pid = (i: number) => getAlphabeticId(i);
                const escape = (i: string) => i.replace(/[",]/g, '');
                const unknownSchool = this.translate('Unknown School');
                const statusMap = {
                    [STATUS.STATUS_ACCEPTED]: 'OK',
                    [STATUS.STATUS_WRONG_ANSWER]: 'WA',
                    [STATUS.STATUS_COMPILE_ERROR]: 'CE',
                    [STATUS.STATUS_TIME_LIMIT_EXCEEDED]: 'TL',
                    [STATUS.STATUS_RUNTIME_ERROR]: 'RT',
                };
                const submissions = teams.flatMap((i, idx) => {
                    if (!i.journal) return [];
                    const journal = i.journal.filter((s) => tdoc.pids.includes(s.pid));
                    const c = Counter();
                    return journal.map((s) => {
                        const id = pid(tdoc.pids.indexOf(s.pid));
                        c[id]++;
                        return `@s ${idx + 1},${id},${c[id]},${time(s.rid)},${statusMap[s.status] || 'RJ'}`;
                    });
                });
                const res = [
                    `@contest "${escape(tdoc.title)}"`,
                    `@contlen ${Math.floor((tdoc.endAt.getTime() - tdoc.beginAt.getTime()) / Time.minute)}`,
                    `@problems ${tdoc.pids.length}`,
                    `@teams ${tdoc.attend}`,
                    `@submissions ${submissions.length}`,
                ].concat(
                    tdoc.pids.map((i, idx) => `@p ${pid(idx)},${escape(pdict[i]?.title || 'Unknown Problem')},20,0`),
                    teams.map((i, idx) => {
                        const showName = this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO) && udict[i.uid].displayName
                            ? udict[i.uid].displayName : udict[i.uid].uname;
                        const teamName = `${i.rank ? '*' : ''}${escape(udict[i.uid].school || unknownSchool)}-${escape(showName)}`;
                        return `@t ${idx + 1},0,1,"${teamName}"`;
                    }),
                    submissions,
                );
                this.binary(res.join('\n'), `${this.tdoc.title}.ghost`);
            },
            supportedRules: ['*'],
        });
        scoreboard.addView('html', 'HTML', { tdoc: 'tdoc' }, {
            async display({ tdoc }) {
                await this.limitRate('scoreboard_download', 60, 3);
                const [, rows] = await contest.getScoreboard.call(this, tdoc.domainId, tdoc._id, {
                    isExport: true, lockAt: this.tdoc.lockAt, showDisplayName: this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO),
                });
                this.binary(await this.renderHTML('contest_scoreboard_download_html.html', { rows, tdoc }), `${this.tdoc.title}.html`);
            },
            supportedRules: ['*'],
        });
        scoreboard.addView('csv', 'CSV', { tdoc: 'tdoc' }, {
            async display({ tdoc }) {
                await this.limitRate('scoreboard_download', 60, 3);
                const [, rows] = await contest.getScoreboard.call(this, tdoc.domainId, tdoc._id, {
                    isExport: true, lockAt: this.tdoc.lockAt, showDisplayName: this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO),
                });
                this.binary(toCSV(rows.map((r) => r.map((c) => c.value.toString())), { bom: true }), `${this.tdoc.title}.csv`);
            },
            supportedRules: ['*'],
        });
    });
}

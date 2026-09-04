/* eslint-disable max-len */
/* eslint-disable no-await-in-loop */
/**
 * PTA fork — CODE SIMILARITY for homework.
 *
 * The homework editor's "Check Code Similarity" tick box
 * (tdoc.checkSimilarity, handler/homework.ts) asks for this: once the
 * homework ENDS (endAt = deadline + extension), every student's counted
 * submission to each PROGRAMMING task is compared with everyone else's,
 * and the teacher gets a report of suspiciously similar pairs.
 *
 * Engine. Dolos (lib/dolos.ts) — the open-source MOSS alternative from
 * Ghent University, invoked as a script (`dolos run -f csv`). It runs on
 * the web server, so student code never leaves the site. One Dolos run per
 * (task, language): submissions in different languages are compared
 * separately; a language Dolos cannot parse falls back to its character
 * comparison.
 *
 * Which submission counts. The homework rule scores the LAST submission a
 * student made on each task (contest.ts `homework.stat`: the latest journal
 * entry per pid), so that is the one compared — exactly the code that
 * earned the grade. Attending students only; the homework's owner and
 * maintainers are left out. Records without source text (answer / file
 * uploads) are skipped.
 *
 * When. The homework editor calls scheduleSimilarityCheck() on every save:
 * a `similarity` schedule task fires at endAt (the worker below picks it
 * up), or — for a homework that has already ended — the check runs right
 * away, once. Teachers can also (re)run it any time from the report page.
 *
 * Where. One report per homework (model/similarity.ts); the report page
 * `/homework/:tid/similarity` is for the homework's staff only (owner,
 * root, PERM_EDIT_HOMEWORK). Students never see it — the sidebar merely
 * tells them the check is on.
 */
import { ObjectId } from 'mongodb';
import { STATUS, STATUS_TEXTS } from '@hydrooj/common';
import { Context } from '../context';
import { BadRequestError, NotFoundError, PermissionError } from '../error';
import type { Tdoc } from '../interface';
import {
    DolosError, DolosInputFile, dolosLanguageFor, dolosVersion, runDolos,
} from '../lib/dolos';
import { Logger } from '../logger';
import { PERM, PRIV } from '../model/builtin';
import * as contest from '../model/contest';
import message from '../model/message';
import problem from '../model/problem';
import record from '../model/record';
import ScheduleModel from '../model/schedule';
import * as SettingModel from '../model/setting';
import SimilarityModel, {
    SimilarityFile, SimilarityGroup, SimilarityPair, SimilarityReportDoc, SimilarityTask,
} from '../model/similarity';
import system from '../model/system';
import user from '../model/user';
import { param, Types } from '../service/server';
import { ContestDetailBaseHandler } from './contest';

const logger = new Logger('handler/similarity');

/* ------------------------------------------------------------------ */
/*  System settings (Control Panel -> Settings -> Code Similarity)     */
/* ------------------------------------------------------------------ */
const { Setting, SystemSetting } = SettingModel;

/** HMR-safe registration (same pattern as lib/ai_tutor.ts): sweep our keys, then register. */
function registerSystemSettingsIdempotent(...defs: any[]) {
    const keys = new Set(defs.map((d) => d.key));
    for (let i = SettingModel.SYSTEM_SETTINGS.length - 1; i >= 0; i--) {
        if (keys.has(SettingModel.SYSTEM_SETTINGS[i].key)) SettingModel.SYSTEM_SETTINGS.splice(i, 1);
    }
    for (const k of keys) delete SettingModel.SYSTEM_SETTINGS_BY_KEY[k];
    SystemSetting(...defs);
}

registerSystemSettingsIdempotent(
    Setting('setting_similarity', 'similarity.enabled', true, 'boolean', 'similarity.enabled', 'Run the code-similarity check for homework whose "Check Code Similarity" box is ticked'),
    Setting('setting_similarity', 'similarity.dolos_path', '', 'text', 'similarity.dolos_path', 'The Dolos command. Leave blank to auto-detect: @dodona/dolos installed next to Hydro, a global "npm install -g @dodona/dolos", or "dolos" on the PATH of the Hydro process. Otherwise give the executable ("dolos"), the path to Dolos\' dist/cli.js, or a full command such as "node /opt/dolos/dist/cli.js".'),
    Setting('setting_similarity', 'similarity.threshold', 0.75, 'float', 'similarity.threshold', 'Flag a pair of submissions when their similarity (0-1, the share of matching code fingerprints) reaches this value'),
    Setting('setting_similarity', 'similarity.min_store', 0.3, 'float', 'similarity.min_store', 'Keep pairs at or above this similarity in the report (0-1); lower values give the teacher more context but larger reports'),
    Setting('setting_similarity', 'similarity.max_pairs', 2000, 'number', 'similarity.max_pairs', 'Most pairs kept per task and language, highest similarity first'),
    Setting('setting_similarity', 'similarity.timeout', 900, 'number', 'similarity.timeout', 'Seconds one Dolos run (one task, one language) may take before it is stopped'),
    Setting('setting_similarity', 'similarity.extra_args', '', 'text', 'similarity.extra_args', 'Extra "dolos run" arguments, e.g. "-M 0.8 -k 20" (see dolos run --help)'),
);

interface SimilarityConfig {
    enabled: boolean;
    command: string;
    threshold: number;
    minStore: number;
    maxPairs: number;
    timeoutMs: number;
    extraArgs: string[];
}

export function similarityConfig(): SimilarityConfig {
    const num = (key: string, dflt: number, min: number, max: number) => {
        const v = +system.get(key);
        return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
    };
    const threshold = num('similarity.threshold', 0.75, 0.05, 1);
    return {
        enabled: system.get('similarity.enabled') !== false,
        command: String(system.get('similarity.dolos_path') ?? '').trim(),
        threshold,
        minStore: Math.min(threshold, num('similarity.min_store', 0.3, 0, 1)),
        maxPairs: Math.round(num('similarity.max_pairs', 2000, 50, 20000)),
        timeoutMs: num('similarity.timeout', 900, 30, 7200) * 1000,
        extraArgs: String(system.get('similarity.extra_args') || '').trim().split(/\s+/).filter(Boolean),
    };
}

/* ------------------------------------------------------------------ */
/*  Scope: which tasks and which submissions                           */
/* ------------------------------------------------------------------ */
/**
 * Site convention (handler/problem.ts problemKindOf): the display pid's
 * first letter is authoritative — O objective, S subjective, anything else
 * (P, or a legacy prefix-less pid) programming — and the judge config is
 * the fallback: only judged programs (`default` / `remote_judge`) carry
 * source code worth comparing.
 */
function isProgrammingTask(pdoc: any): boolean {
    if (/^[os]/i.test(String(pdoc?.pid || ''))) return false;
    const cfg = pdoc?.config;
    let type = '';
    if (cfg && typeof cfg === 'object') type = String(cfg.type || '');
    else if (typeof cfg === 'string') type = (/^\s*type\s*:\s*['"]?([\w-]+)/m.exec(cfg) || [])[1] || ''; // list projections carry the raw YAML
    if (type && !['default', 'remote_judge'].includes(type)) return false;
    return true;
}

interface CountedSubmission {
    uid: number;
    rid: ObjectId;
    lang: string;
    code: string;
    status: number;
    score: number;
    at: Date;
}

interface TaskScope {
    pid: number;
    pidLabel: string;
    title: string;
    submissions: CountedSubmission[];
    /** Counted records that carry no source text. */
    noCode: number;
}

async function collectScope(domainId: string, tdoc: Tdoc): Promise<{ tasks: TaskScope[], students: number }> {
    const pdict = await problem.getList(domainId, tdoc.pids, true, false, problem.PROJECTION_CONTEST_LIST, true);
    const pids = tdoc.pids.filter((pid) => pdict[pid] && isProgrammingTask(pdict[pid]));
    const staff = new Set<number>([tdoc.owner, ...(tdoc.maintainer || [])]);
    const tsdocs = await contest.getMultiStatus(domainId, { docId: tdoc.docId, attend: 1 })
        .project({ uid: 1, detail: 1 }).toArray();
    const students = new Set<number>();
    const rids: ObjectId[] = [];
    const wanted = new Map<string, { uid: number, pid: number }>();
    for (const tsdoc of tsdocs as any[]) {
        if (staff.has(tsdoc.uid)) continue;
        for (const pid of pids) {
            const d = tsdoc.detail?.[pid];
            if (!d?.rid) continue;
            students.add(tsdoc.uid);
            const rid = d.rid instanceof ObjectId ? d.rid : new ObjectId(String(d.rid));
            rids.push(rid);
            wanted.set(rid.toHexString(), { uid: tsdoc.uid, pid });
        }
    }
    const byPid = new Map<number, CountedSubmission[]>();
    const noCode = new Map<number, number>();
    for (const pid of pids) {
        byPid.set(pid, []);
        noCode.set(pid, 0);
    }
    if (rids.length) {
        const rdocs = await record.getMulti(domainId, { _id: { $in: rids } })
            .project({
                uid: 1, pid: 1, lang: 1, code: 1, status: 1, score: 1,
            }).toArray();
        for (const rdoc of rdocs as any[]) {
            const w = wanted.get(rdoc._id.toHexString());
            if (!w || rdoc.pid !== w.pid || rdoc.uid !== w.uid) continue;
            const code = typeof rdoc.code === 'string' ? rdoc.code : '';
            if (!code.trim()) {
                noCode.set(w.pid, (noCode.get(w.pid) || 0) + 1);
                continue;
            }
            byPid.get(w.pid)!.push({
                uid: rdoc.uid,
                rid: rdoc._id,
                lang: String(rdoc.lang || ''),
                code,
                status: rdoc.status,
                score: rdoc.score || 0,
                at: rdoc._id.getTimestamp(),
            });
        }
    }
    return {
        students: students.size,
        tasks: pids.map((pid) => ({
            pid,
            pidLabel: String(pdict[pid].pid || pid),
            title: pdict[pid].title || String(pid),
            submissions: byPid.get(pid) || [],
            noCode: noCode.get(pid) || 0,
        })),
    };
}

/* ------------------------------------------------------------------ */
/*  The check                                                          */
/* ------------------------------------------------------------------ */
/** A 'running' report older than this is treated as crashed and may be restarted. */
function staleMs(cfg: SimilarityConfig): number {
    return Math.max(30 * 60 * 1000, cfg.timeoutMs * 4);
}

function emptyReport(domainId: string, tdoc: Tdoc, cfg: SimilarityConfig, trigger: 'deadline' | 'manual', by?: number): SimilarityReportDoc {
    return {
        _id: `${domainId}/${tdoc.docId}`,
        domainId,
        tid: tdoc.docId,
        status: 'running',
        trigger,
        ...(by ? { by } : {}),
        startedAt: new Date(),
        engine: 'dolos',
        threshold: cfg.threshold,
        minStore: cfg.minStore,
        maxPairs: cfg.maxPairs,
        students: 0,
        tasks: [],
        summary: {
            submissions: 0, compared: 0, groups: 0, flagged: 0, maxSimilarity: 0,
        },
        snapshot: { title: tdoc.title, pids: [...tdoc.pids], endAt: tdoc.endAt },
    };
}

/** Group one task's submissions by the Dolos language that analyzes them. */
function groupByLanguage(subs: CountedSubmission[]): Map<string, { dolosLang: string, ext: string, charFallback: boolean, langs: Set<string>, subs: CountedSubmission[] }> {
    const groups = new Map<string, { dolosLang: string, ext: string, charFallback: boolean, langs: Set<string>, subs: CountedSubmission[] }>();
    for (const s of subs) {
        const base = s.lang.split('.')[0] || 'unknown';
        const dl = dolosLanguageFor(s.lang, SettingModel.langs[s.lang]?.highlight);
        // Character comparison must not mix languages: `pas` and `hs` stay apart.
        const key = dl.charFallback ? `char:${base}` : dl.id;
        if (!groups.has(key)) {
            groups.set(key, {
                dolosLang: dl.id, ext: dl.ext, charFallback: dl.charFallback, langs: new Set(), subs: [],
            });
        }
        const g = groups.get(key)!;
        g.langs.add(base);
        g.subs.push(s);
    }
    return groups;
}

function langDisplay(base: string): string {
    const entry = SettingModel.langs[base] || Object.values(SettingModel.langs).find((l) => l.key.split('.')[0] === base);
    return entry?.display || base;
}

/** Tell the homework's owner (and maintainers) that the deadline report is ready. */
async function notifyStaff(domainId: string, tdoc: Tdoc, doc: SimilarityReportDoc) {
    const prefix = domainId === 'system' ? '' : `/d/${domainId}`;
    await message.send(1, [tdoc.owner, ...(tdoc.maintainer || [])], JSON.stringify({
        message: 'The code similarity report of homework {0} is ready: {1} flagged pair(s) among {2} submission(s).',
        params: [tdoc.title, doc.summary.flagged, doc.summary.submissions],
        url: `${prefix}/homework/${tdoc.docId}/similarity`,
    }), message.FLAG_I18N | message.FLAG_UNREAD);
}

/**
 * Run the check for one homework and store the report. Resolves to the
 * outcome; never throws (failures are written into the report).
 */
export async function runSimilarityCheck(domainId: string, tid: ObjectId, trigger: 'deadline' | 'manual', by?: number): Promise<'done' | 'failed' | 'busy' | 'skipped'> {
    const cfg = similarityConfig();
    let tdoc: Tdoc;
    try {
        tdoc = await contest.get(domainId, tid);
    } catch (e) {
        return 'skipped';
    }
    if (!tdoc || tdoc.rule !== 'homework') return 'skipped';
    if (trigger === 'deadline' && (!tdoc.checkSimilarity || !cfg.enabled)) {
        logger.info('[similarity] %s/%s: check not requested any more (box %s, system %s) — skipped', domainId, tid, tdoc.checkSimilarity ? 'ticked' : 'unticked', cfg.enabled ? 'enabled' : 'disabled');
        return 'skipped';
    }
    const seed = emptyReport(domainId, tdoc, cfg, trigger, by);
    if (!await SimilarityModel.claim(domainId, tid, seed, staleMs(cfg))) {
        logger.info('[similarity] %s/%s: a check is already running', domainId, tid);
        return 'busy';
    }
    const startedAt = seed.startedAt;
    const setProgress = (done: number, total: number, label: string) => SimilarityModel
        .patch(domainId, tid, { progress: { done, total, label } })
        .catch(() => { /* progress is cosmetic */ });
    try {
        logger.info('[similarity] %s/%s: check started (%s%s)', domainId, tid, trigger, by ? ` by uid ${by}` : '');
        const engineVersion = await dolosVersion(cfg.command);
        const scope = await collectScope(domainId, tdoc);
        const tasks: SimilarityTask[] = [];
        const plan: { task: TaskScope, key: string }[] = [];
        const grouped = new Map<number, ReturnType<typeof groupByLanguage>>();
        for (const task of scope.tasks) {
            const groups = groupByLanguage(task.submissions);
            grouped.set(task.pid, groups);
            for (const [key, g] of groups) if (g.subs.length >= 2) plan.push({ task, key });
        }
        let done = 0;
        let compared = 0;
        let submissions = 0;
        let flaggedTotal = 0;
        let maxSimilarity = 0;
        let groupsRun = 0;
        for (const task of scope.tasks) {
            const groups = grouped.get(task.pid)!;
            const out: SimilarityTask = {
                pid: task.pid,
                pidLabel: task.pidLabel,
                title: task.title,
                submissions: task.submissions.length,
                skipped: task.noCode,
                groups: [],
            };
            submissions += task.submissions.length;
            for (const [, g] of groups) {
                if (g.subs.length < 2) {
                    out.skipped += g.subs.length; // alone in its language: nothing to compare with
                    continue;
                }
                const langs = [...g.langs].sort();
                const group: SimilarityGroup = {
                    dolosLang: g.dolosLang,
                    langs,
                    langNames: langs.map(langDisplay),
                    charFallback: g.charFallback,
                    files: [],
                    pairs: [],
                    totalPairs: 0,
                    flagged: 0,
                    startedAt: new Date(),
                };
                await setProgress(done, plan.length, `${task.pidLabel} · ${group.langNames.join(', ')}`);
                const bySub = new Map<number, CountedSubmission>();
                const inputs: DolosInputFile[] = g.subs.map((s) => {
                    bySub.set(s.uid, s);
                    return {
                        name: `${s.uid}${g.ext}`, content: s.code, label: String(s.uid), createdAt: s.at,
                    };
                });
                try {
                    const res = await runDolos(inputs, {
                        command: cfg.command,
                        language: g.dolosLang,
                        extraArgs: cfg.extraArgs,
                        timeoutMs: cfg.timeoutMs,
                        name: `${tdoc.docId}-${task.pidLabel}-${g.dolosLang}`,
                    });
                    const uidOf = (name: string) => Number.parseInt(name, 10);
                    const maxOf = new Map<number, number>();
                    const pairs: SimilarityPair[] = [];
                    for (const p of res.pairs) {
                        const l = bySub.get(uidOf(p.leftName));
                        const r = bySub.get(uidOf(p.rightName));
                        if (!l || !r || l.uid === r.uid) continue;
                        maxOf.set(l.uid, Math.max(maxOf.get(l.uid) || 0, p.similarity));
                        maxOf.set(r.uid, Math.max(maxOf.get(r.uid) || 0, p.similarity));
                        group.totalPairs += 1;
                        if (p.similarity >= cfg.threshold) group.flagged += 1;
                        if (p.similarity > maxSimilarity) maxSimilarity = p.similarity;
                        if (p.similarity >= cfg.minStore && p.similarity > 0) {
                            pairs.push({
                                left: l.uid,
                                right: r.uid,
                                leftRid: l.rid,
                                rightRid: r.rid,
                                similarity: Math.round(p.similarity * 10000) / 10000,
                                overlap: p.totalOverlap,
                                longest: p.longestFragment,
                                leftCovered: p.leftCovered,
                                rightCovered: p.rightCovered,
                            });
                        }
                    }
                    pairs.sort((a, b) => (b.similarity - a.similarity) || (b.overlap - a.overlap) || (a.left - b.left));
                    group.pairs = pairs.slice(0, cfg.maxPairs);
                    const kgramsOf = new Map<number, number>();
                    for (const f of res.files) kgramsOf.set(uidOf(f.name), f.kgrams);
                    group.files = g.subs.map((s): SimilarityFile => ({
                        uid: s.uid,
                        rid: s.rid,
                        lang: s.lang,
                        kgrams: kgramsOf.get(s.uid) || 0,
                        status: s.status,
                        score: s.score,
                        maxSimilarity: Math.round((maxOf.get(s.uid) || 0) * 10000) / 10000,
                    })).sort((a, b) => (b.maxSimilarity - a.maxSimilarity) || (a.uid - b.uid));
                    group.log = res.log;
                    compared += g.subs.length;
                    flaggedTotal += group.flagged;
                    groupsRun += 1;
                } catch (e) {
                    // Dolos not installed / not found: every group would fail the
                    // same way, so the whole run fails with that message.
                    if (e instanceof DolosError && e.kind === 'missing') throw e;
                    group.error = e.message;
                    group.files = g.subs.map((s): SimilarityFile => ({
                        uid: s.uid, rid: s.rid, lang: s.lang, kgrams: 0, status: s.status, score: s.score, maxSimilarity: 0,
                    }));
                    logger.warn('[similarity] %s/%s task %s (%s): %s', domainId, tid, task.pidLabel, g.dolosLang, e.message);
                }
                group.finishedAt = new Date();
                out.groups.push(group);
                done += 1;
            }
            tasks.push(out);
        }
        const doc: SimilarityReportDoc = {
            ...seed,
            status: 'done',
            startedAt,
            finishedAt: new Date(),
            engineVersion: engineVersion || undefined,
            students: scope.students,
            tasks,
            summary: {
                submissions, compared, groups: groupsRun, flagged: flaggedTotal, maxSimilarity: Math.round(maxSimilarity * 10000) / 10000,
            },
        };
        delete doc.progress;
        delete doc.error;
        await SimilarityModel.set(doc);
        logger.info('[similarity] %s/%s: done — %d student(s), %d submission(s) in %d group(s), %d flagged pair(s) ≥ %d%%', domainId, tid, doc.students, submissions, groupsRun, flaggedTotal, Math.round(cfg.threshold * 100));
        if (trigger === 'deadline') await notifyStaff(domainId, tdoc, doc).catch(() => { /* optional */ });
        return 'done';
    } catch (e) {
        logger.error('[similarity] %s/%s: check failed: %s', domainId, tid, e.message);
        await SimilarityModel.patch(domainId, tid, {
            status: 'failed', error: String(e.message || e), finishedAt: new Date(), progress: undefined,
        }).catch(() => { /* nothing better to do */ });
        return 'failed';
    }
}

/** Start a check in the background; resolves once it is claimed (or refused). */
export async function startSimilarityCheck(domainId: string, tid: ObjectId, trigger: 'deadline' | 'manual', by?: number): Promise<'started' | 'busy' | 'disabled'> {
    const cfg = similarityConfig();
    if (!cfg.enabled) return 'disabled';
    const existing = await SimilarityModel.getStatus(domainId, tid);
    if (existing?.status === 'running' && existing.startedAt > new Date(Date.now() - staleMs(cfg))) return 'busy';
    runSimilarityCheck(domainId, tid, trigger, by).catch((e) => logger.error('[similarity] %s/%s: %s', domainId, tid, e.message));
    return 'started';
}

const SCHEDULE_SUBTYPE = 'similarity';

/**
 * Called by the homework editor on every save: keep exactly one deadline
 * task while the box is ticked and the homework has not ended; run right
 * away (once) when it already has. Unticking the box withdraws the task
 * but keeps any report already produced.
 */
export async function scheduleSimilarityCheck(domainId: string, tid: ObjectId, checkSimilarity: boolean, endAt: Date): Promise<void> {
    const task = {
        type: 'schedule', subType: SCHEDULE_SUBTYPE, domainId, tid,
    };
    await ScheduleModel.deleteMany(task);
    if (!checkSimilarity) return;
    if (Date.now() <= endAt.getTime()) {
        await ScheduleModel.add({ ...task, executeAfter: endAt });
        return;
    }
    const existing = await SimilarityModel.getStatus(domainId, tid);
    if (existing && existing.status !== 'failed') return; // already checked; the teacher can re-run from the report page
    await startSimilarityCheck(domainId, tid, 'deadline');
}

/* ------------------------------------------------------------------ */
/*  The teacher's report                                               */
/* ------------------------------------------------------------------ */
function nameOf(udoc: any, uid: number) {
    return {
        uid,
        uname: udoc?.uname || String(uid),
        name: `${udoc?.firstName || ''} ${udoc?.lastName || ''}`.trim() || udoc?.displayName || '',
    };
}

async function reportForClient(domainId: string, tdoc: Tdoc, report: SimilarityReportDoc | null, cfg: SimilarityConfig, canOpenRecords: boolean) {
    const uids = new Set<number>();
    if (report?.by) uids.add(report.by);
    for (const t of report?.tasks || []) for (const g of t.groups) for (const f of g.files) uids.add(f.uid);
    const udict: any = uids.size ? await user.getList(domainId, [...uids]) : {};
    const person = (uid: number) => nameOf(udict[uid], uid);
    const stale = !!report && report.status === 'done' && (
        report.snapshot.pids.join(',') !== tdoc.pids.join(',')
        || new Date(report.snapshot.endAt).getTime() !== new Date(tdoc.endAt).getTime()
    );
    return {
        tid: tdoc.docId.toHexString(),
        title: tdoc.title,
        checkSimilarity: !!tdoc.checkSimilarity,
        ended: Date.now() > tdoc.endAt.getTime(),
        endAt: tdoc.endAt,
        systemEnabled: cfg.enabled,
        engine: { name: 'Dolos', version: report?.engineVersion || null, command: cfg.command || '(auto-detected)' },
        // In this fork record pages open for the submitter and root only; the
        // report shows the code itself, and links out only when they would work.
        canOpenRecords,
        threshold: report?.threshold ?? cfg.threshold,
        minStore: report?.minStore ?? cfg.minStore,
        status: report?.status || null,
        trigger: report?.trigger || null,
        by: report?.by ? person(report.by) : null,
        startedAt: report?.startedAt || null,
        finishedAt: report?.finishedAt || null,
        error: report?.error || null,
        progress: report?.progress || null,
        students: report?.students || 0,
        summary: report?.summary || null,
        stale,
        tasks: (report?.tasks || []).map((t) => ({
            pid: t.pid,
            pidLabel: t.pidLabel,
            title: t.title,
            submissions: t.submissions,
            skipped: t.skipped,
            groups: t.groups.map((g) => ({
                dolosLang: g.dolosLang,
                langNames: g.langNames,
                charFallback: g.charFallback,
                totalPairs: g.totalPairs,
                flagged: g.flagged,
                error: g.error || null,
                log: g.log || '',
                files: g.files.map((f) => ({
                    ...person(f.uid),
                    rid: f.rid.toHexString(),
                    lang: f.lang,
                    kgrams: f.kgrams,
                    status: f.status,
                    statusText: STATUS_TEXTS[f.status] || String(f.status),
                    accepted: f.status === STATUS.STATUS_ACCEPTED,
                    score: f.score,
                    maxSimilarity: f.maxSimilarity,
                })),
                pairs: g.pairs.map((p) => ({
                    left: { ...person(p.left), rid: p.leftRid.toHexString(), covered: p.leftCovered },
                    right: { ...person(p.right), rid: p.rightRid.toHexString(), covered: p.rightCovered },
                    similarity: p.similarity,
                    overlap: p.overlap,
                    longest: p.longest,
                })),
            })),
        })),
    };
}

class HomeworkSimilarityHandler extends ContestDetailBaseHandler {
    canManage() {
        return this.user.own(this.tdoc) || this.user.role === 'root' || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
    }

    async prepare({ domainId }) {
        if (!this.tdoc || this.tdoc.rule !== 'homework') throw new NotFoundError(domainId, this.args.tid);
        if (!this.canManage()) throw new PermissionError(PERM.PERM_EDIT_HOMEWORK);
    }

    @param('tid', Types.ObjectId)
    @param('left', Types.ObjectId, true)
    @param('right', Types.ObjectId, true)
    async get(domainId: string, tid: ObjectId, left?: ObjectId, right?: ObjectId) {
        if (left || right) {
            if (!left || !right) throw new BadRequestError('Both records of the pair are required.');
            this.response.body = { left: await this.recordView(domainId, tid, left), right: await this.recordView(domainId, tid, right) };
            return;
        }
        const cfg = similarityConfig();
        const report = await SimilarityModel.get(domainId, tid);
        const view = await reportForClient(domainId, this.tdoc, report, cfg, this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM));
        this.response.template = 'homework_similarity.html';
        this.response.body = {
            tdoc: this.tdoc,
            tsdoc: this.tsdocAsPublic(),
            report: view,
            page_name: 'homework_similarity',
        };
        // The page script only needs the run state (the report is server-rendered).
        this.UiContext.similarity = { status: view.status, tid: view.tid };
    }

    /** One side of the side-by-side view: the record must belong to this homework. */
    async recordView(domainId: string, tid: ObjectId, rid: ObjectId) {
        const rdoc = await record.get(domainId, rid);
        if (!rdoc || !rdoc.contest || String(rdoc.contest) !== tid.toHexString()) throw new NotFoundError(domainId, rid);
        const udoc = await user.getById(domainId, rdoc.uid);
        return {
            ...nameOf(udoc, rdoc.uid),
            rid: rid.toHexString(),
            pid: rdoc.pid,
            lang: rdoc.lang,
            langName: SettingModel.langs[rdoc.lang]?.display || rdoc.lang,
            code: typeof rdoc.code === 'string' ? rdoc.code : '',
            status: rdoc.status,
            statusText: STATUS_TEXTS[rdoc.status] || String(rdoc.status),
            accepted: rdoc.status === STATUS.STATUS_ACCEPTED,
            score: rdoc.score || 0,
            submitAt: rid.getTimestamp().getTime(),
            recordUrl: this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM) ? this.url('record_detail', { rid }) : null,
        };
    }

    @param('tid', Types.ObjectId)
    async postRun(domainId: string, tid: ObjectId) {
        await this.limitRate('similarity_run', 60, 6, '{{user}}');
        const outcome = await startSimilarityCheck(domainId, tid, 'manual', this.user._id);
        this.response.body = { outcome };
    }

    @param('tid', Types.ObjectId)
    async postStatus(domainId: string, tid: ObjectId) {
        const st = await SimilarityModel.getStatus(domainId, tid);
        this.response.body = {
            status: st?.status || null,
            startedAt: st?.startedAt || null,
            finishedAt: st?.finishedAt || null,
            error: st?.error || null,
            progress: st?.progress || null,
        };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('homework_similarity', '/homework/:tid/similarity', HomeworkSimilarityHandler, PERM.PERM_VIEW_HOMEWORK);
    // The deadline task the homework editor schedules (scheduleSimilarityCheck).
    ctx.worker.addHandler(SCHEDULE_SUBTYPE, async (doc) => {
        await runSimilarityCheck(doc.domainId, doc.tid, 'deadline');
    });
    // A deleted homework takes its report and pending task with it.
    ctx.on('contest/del', async (domainId, tid) => {
        await Promise.all([
            SimilarityModel.del(domainId, tid),
            ScheduleModel.deleteMany({
                type: 'schedule', subType: SCHEDULE_SUBTYPE, domainId, tid,
            }),
        ]);
    });
    ctx.on('domain/delete', (domainId) => SimilarityModel.delByDomain(domainId));
    /*
     * The homework page's "Code Similarity" card (homework_detail.html,
     * staff only): the tick box state, the programming tasks a run covers,
     * and the last report's outcome — so a teacher can start a check with
     * one click from the homework itself (the page script posts `run` to
     * the report route and moves to the report, which shows the progress).
     */
    ctx.on('handler/after/HomeworkDetail#get' as any, async (h: any) => {
        try {
            if (!h?.response?.template || !h.tdoc) return;
            const tdoc: Tdoc = h.tdoc;
            const staff = h.user.own(tdoc) || h.user.role === 'root' || h.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
            if (!staff) return;
            const domainId = h.args.domainId;
            const cfg = similarityConfig();
            // The detail handler loads the problem list for managers; a
            // staff member it skipped (no owner / hidden-scoreboard
            // permission) gets the same list fetched here.
            const pdict = h.response.body.pdict
                || await problem.getList(domainId, tdoc.pids, true, false, problem.PROJECTION_CONTEST_LIST, true);
            const programming = tdoc.pids.filter((pid) => pdict?.[pid] && isProgrammingTask(pdict[pid])).map((pid) => String(pdict[pid].pid || pid));
            const st = await SimilarityModel.getStatus(domainId, tdoc.docId);
            const url = h.url('homework_similarity', { tid: tdoc.docId });
            h.response.body.similarity = {
                url,
                systemEnabled: cfg.enabled,
                checkSimilarity: !!tdoc.checkSimilarity,
                ended: Date.now() > tdoc.endAt.getTime(),
                endAt: tdoc.endAt,
                programming,
                status: st?.status || null,
                trigger: st?.trigger || null,
                startedAt: st?.startedAt || null,
                finishedAt: st?.finishedAt || null,
                error: st?.error || null,
                progress: st?.progress || null,
                summary: st?.summary || null,
                threshold: st?.threshold ?? cfg.threshold,
                students: st?.students || 0,
            };
            h.UiContext.hwSimilarity = { status: st?.status || null, url };
        } catch (e) {
            logger.warn('[similarity] homework page card failed: %s', e.message);
        }
    });
    await SimilarityModel.apply();
    logger.info('[similarity] homework code-similarity check ready (engine: Dolos, command: %s)', similarityConfig().command || '(bundled @dodona/dolos)');
}

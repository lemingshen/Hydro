import * as yaml from 'js-yaml';
import { escapeRegExp, pick } from 'lodash';
import moment from 'moment-timezone';
import { ObjectId } from 'mongodb';
import { sortFiles, Time } from '@hydrooj/utils/lib/utils';
import {
    ContestNotFoundError, FileLimitExceededError, FileUploadError, HomeworkNotLiveError, NotAssignedError, PermissionError, ValidationError,
} from '../error';
import { PenaltyRules, Tdoc } from '../interface';
import { PERM } from '../model/builtin';
import * as contest from '../model/contest';
import type { ScoreOverride } from '../model/contest';
import * as discussion from '../model/discussion';
import problem from '../model/problem';
import record from '../model/record';
import ScheduleModel from '../model/schedule';
import storage from '../model/storage';
import system from '../model/system';
import user from '../model/user';
import {
    Handler, param, post, Types,
} from '../service/server';
import {
    ContestCodeHandler, ContestFileDownloadHandler, ContestScoreboardHandler, evaluateContainerResults, hasObjectiveTask, myResultsOf, paperOf, parsePaper, resolveAllowedLangs,
} from './contest';
import { applyObjectiveFeedback } from '../lib/objective_feedback';
import { scheduleSimilarityCheck } from './similarity';

export const validatePenaltyRules = (input: string) => {
    try {
        const res = yaml.load(input);
        return typeof res === 'object' && res !== null && Object.keys(res).every((key) => typeof res[key] === 'number');
    } catch (e) {
        return false;
    }
};
export const convertPenaltyRules = (input: string) => yaml.load(input);

class HomeworkMainHandler extends Handler {
    @param('group', Types.Name, true)
    @param('page', Types.PositiveInt, true)
    @param('q', Types.String, true)
    async get(domainId: string, group = '', page = 1, q = '') {
        const groups = (await user.listGroup(domainId, this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK) ? undefined : this.user._id))
            .map((i) => i.name);
        if (group && !groups.includes(group)) throw new NotAssignedError(group);
        const escaped = escapeRegExp(q.toLowerCase());
        const cursor = contest.getMulti(domainId, {
            rule: 'homework',
            ...this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK) && !group
                ? {}
                : {
                    $or: [
                        { maintainer: this.user._id },
                        { owner: this.user._id },
                        { assign: { $in: groups } },
                        { assign: { $size: 0 } },
                    ],
                },
            ...group ? { assign: { $in: [group] } } : {},
            ...q ? { title: { $regex: new RegExp(q.length >= 2 ? escaped : `\\A${escaped}`, 'gim') } } : {},
        }).sort({
            penaltySince: -1, endAt: -1, beginAt: -1, _id: -1,
        });
        const [tdocs, tpcount] = await this.paginate(cursor, page, 'contest');
        const calendar = [];
        for (const tdoc of tdocs) {
            const cal = { ...tdoc, url: this.url('homework_detail', { tid: tdoc.docId }) };
            if (contest.isExtended(tdoc) || contest.isDone(tdoc)) {
                cal.endAt = tdoc.endAt;
                cal.penaltySince = tdoc.penaltySince;
            } else cal.endAt = tdoc.penaltySince;
            calendar.push(cal);
        }
        let qs = group ? `group=${group}` : '';
        if (q) qs += `${qs ? '&' : ''}q=${encodeURIComponent(q)}`;
        const groupsFilter = groups.filter((i) => !Number.isSafeInteger(+i));
        this.response.body = {
            tdocs, calendar, tpcount, page, qs, groups: groupsFilter, group, q,
        };
        this.response.template = 'homework_main.html';
    }
}

class HomeworkDetailHandler extends Handler {
    tdoc: Tdoc;

    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        this.tdoc = await contest.get(domainId, tid);
        if (this.tdoc.rule !== 'homework') throw new ContestNotFoundError(domainId, tid);
        if (this.tdoc.assign?.length && !this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)) {
            if (!new Set(this.tdoc.assign).intersection(new Set(this.user.group)).size) {
                throw new NotAssignedError('homework', this.tdoc.docId);
            }
        }
    }

    @param('tid', Types.ObjectId)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, tid: ObjectId, page = 1) {
        const tsdoc = await contest.getStatus(domainId, tid, this.user._id);
        if (this.tdoc.rule !== 'homework') throw new ContestNotFoundError(domainId, tid);
        // discussion
        const [ddocs, dpcount, dcount] = await this.paginate(
            discussion.getMulti(domainId, { parentType: this.tdoc.docType, parentId: this.tdoc.docId }),
            page,
            'discussion',
        );
        const uids = ddocs.map((ddoc) => ddoc.owner);
        uids.push(this.tdoc.owner);
        const udict = await user.getList(domainId, uids);
        this.response.template = 'homework_detail.html';
        this.response.body = {
            tdoc: this.tdoc, tsdoc, udict, ddocs, page, dpcount, dcount,
        };
        // PTA: the client-side deadline hand-off never moves managers.
        this.UiContext.canManageContest = this.user.own(this.tdoc) || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
        this.response.body.tdoc.content = this.response.body.tdoc.content
            .replace(/\(file:\/\//g, `(./${this.tdoc.docId}/file/public/`)
            .replace(/="file:\/\//g, `="./${this.tdoc.docId}/file/public/`);
        if (
            (contest.isNotStarted(this.tdoc) || (!tsdoc?.attend && !contest.isDone(this.tdoc)))
            && !this.user.own(this.tdoc)
            && !this.user.hasPerm(PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD)
        ) return;
        const pdict = await problem.getList(domainId, this.tdoc.pids, true, true, problem.PROJECTION_CONTEST_LIST);
        const psdict = {};
        let rdict = {};
        if (tsdoc) {
            if (tsdoc.attend && !tsdoc.startAt && contest.isOngoing(this.tdoc)) {
                await contest.setStatus(domainId, tid, this.user._id, { startAt: new Date() });
                tsdoc.startAt = new Date();
            }
            const valid = (tsdoc.journal || []).filter((p) => this.tdoc.pids.includes(p.pid));
            for (const pdetail of valid) {
                psdict[pdetail.pid] = pdetail;
                rdict[pdetail.rid.toHexString()] = { _id: pdetail.rid };
            }
            if (contest.canShowSelfRecord.call(this, this.tdoc) && valid.length) {
                rdict = await record.getList(domainId, valid.map((pdetail) => pdetail.rid));
            }
        }
        Object.assign(this.response.body, { pdict, psdict, rdict });
        // PTA: after the hard deadline the attendee's detailed scores
        // (homework_detail.html "Your results"), evaluating first if the
        // end-of-container task has not run yet.
        if (tsdoc?.attend && contest.isDone(this.tdoc, tsdoc)) {
            let mine = tsdoc;
            if (!(this.tdoc as any).objectiveSynced) {
                await evaluateContainerResults(domainId, this.tdoc).catch(() => { /* retried on the next visit */ });
                mine = await contest.getStatus(domainId, tid, this.user._id) || tsdoc;
            }
            this.response.body.myResults = await myResultsOf(domainId, this.tdoc, mine.detail || {}, this.user._id);
        }
    }

    async postAttend({ domainId }) {
        this.checkPerm(PERM.PERM_ATTEND_HOMEWORK);
        if (contest.isDone(this.tdoc)) throw new HomeworkNotLiveError(this.tdoc.docId);
        await contest.attend(domainId, this.tdoc.docId, this.user._id);
        this.back();
    }
}

class HomeworkEditHandler extends Handler {
    @param('tid', Types.ObjectId, true)
    async get(domainId: string, tid: ObjectId) {
        const tdoc = tid ? await contest.get(domainId, tid) : null;
        if (!tid) this.checkPerm(PERM.PERM_CREATE_HOMEWORK);
        else if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        else this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
        const extensionDays = tid
            ? Math.round(
                (tdoc.endAt.getTime() - tdoc.penaltySince.getTime()) / (Time.day / 100),
            ) / 100
            : 1;
        const beginAt = tid
            ? moment(tdoc.beginAt).tz(this.user.timeZone)
            : moment().add(1, 'day').tz(this.user.timeZone).hour(0).minute(0).millisecond(0);
        const penaltySince = tid
            ? moment(tdoc.penaltySince).tz(this.user.timeZone)
            : beginAt.clone().add(7, 'days').tz(this.user.timeZone).hour(23).minute(59).millisecond(0);
        this.response.template = 'homework_edit.html';
        this.response.body = {
            tdoc,
            dateBeginText: beginAt.format('YYYY-M-D'),
            timeBeginText: beginAt.format('H:mm'),
            datePenaltyText: penaltySince.format('YYYY-M-D'),
            timePenaltyText: penaltySince.format('H:mm'),
            extensionDays,
            penaltyRules: tid ? yaml.dump(tdoc.penaltyRules) : null,
            pids: tid ? tdoc.pids.join(',') : '',
            page_name: tid ? 'homework_edit' : 'homework_create',
        };
        // PTA homework editor: the same four-section paper as the test editor.
        this.UiContext.paper = await paperOf(domainId, tdoc);
    }

    @param('tid', Types.ObjectId, true)
    @param('beginAtDate', Types.Date)
    @param('beginAtTime', Types.Time)
    @param('penaltySinceDate', Types.Date)
    @param('penaltySinceTime', Types.Time)
    @param('extensionDays', Types.Float)
    @param('penaltyRules', Types.Content, validatePenaltyRules, convertPenaltyRules)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('pids', Types.Content)
    @param('rated', Types.Boolean)
    @param('maintainer', Types.NumericArray, true)
    @param('assign', Types.CommaSeperatedArray, true)
    @param('langs', Types.CommaSeperatedArray, true)
    @param('paper', Types.Content, true)
    @param('checkSimilarity', Types.Boolean)
    async postUpdate(
        domainId: string, tid: ObjectId, beginAtDate: string, beginAtTime: string,
        penaltySinceDate: string, penaltySinceTime: string, extensionDays: number,
        penaltyRules: PenaltyRules, title: string, content: string, _pids: string, rated = false,
        maintainer: number[] = [], assign: string[] = [], langs: string[] = [], paper = '',
        checkSimilarity = false,
    ) {
        // PTA homework editor: objective sections with a total each, programming
        // tasks with their own points → problem order + tdoc.score weights.
        const parsedPaper = paper ? await parsePaper(domainId, paper, this.user) : null;
        const pids = parsedPaper ? parsedPaper.pids : _pids.replace(/，/g, ',').split(',').map((i) => +i).filter((i) => i);
        const tdoc = tid ? await contest.get(domainId, tid) : null;
        if (!tid) this.checkPerm(PERM.PERM_CREATE_HOMEWORK);
        else if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        else this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
        const beginAt = moment.tz(`${beginAtDate} ${beginAtTime}`, this.user.timeZone);
        if (!beginAt.isValid()) throw new ValidationError('beginAtDate', 'beginAtTime');
        const penaltySince = moment.tz(`${penaltySinceDate} ${penaltySinceTime}`, this.user.timeZone);
        if (!penaltySince.isValid()) throw new ValidationError('endAtDate', 'endAtTime');
        const endAt = penaltySince.clone().add(extensionDays, 'days');
        if (beginAt.isSameOrAfter(penaltySince)) throw new ValidationError('endAtDate', 'endAtTime');
        if (penaltySince.isAfter(endAt)) throw new ValidationError('extensionDays');
        const pdict = await problem.getList(domainId, pids, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id, true);
        // 🌐 Sanitized, and refused if it would make a listed problem unsubmittable.
        langs = resolveAllowedLangs(langs, pdict, pids);
        if (!tid) {
            // `langs` (and `maintainer`) used to be dropped on CREATE and only
            // stored on a later edit — the picker on the creation page had no
            // effect until the homework was saved a second time.
            // `checkSimilarity` is the homework editor's "Check Code Similarity"
            // tick box — stored on the homework so the editor round-trips it
            // and the similarity check can key off it.
            tid = await contest.add(domainId, title, content, this.user._id,
                'homework', beginAt.toDate(), endAt.toDate(), pids, rated,
                {
                    penaltySince: penaltySince.toDate(), penaltyRules, assign, maintainer, langs, checkSimilarity,
                });
        } else {
            await contest.edit(domainId, tid, {
                title,
                content,
                beginAt: beginAt.toDate(),
                endAt: endAt.toDate(),
                pids,
                penaltySince: penaltySince.toDate(),
                penaltyRules,
                rated,
                maintainer,
                assign,
                langs,
                checkSimilarity,
            });
            if (tdoc.beginAt !== beginAt.toDate()
                || tdoc.endAt !== endAt.toDate()
                || tdoc.penaltySince !== penaltySince.toDate()
                || tdoc.pids.sort().join(' ') !== pids.sort().join(' ')) {
                await contest.recalcStatus(domainId, tdoc.docId);
            }
        }
        if (parsedPaper) await contest.edit(domainId, tid, { score: parsedPaper.score, sections: parsedPaper.sections } as any);
        // Objective answers are scored on the problem set only when the
        // homework's hard deadline passes (contest.syncObjectiveStatus).
        const syncTask = { type: 'schedule', subType: 'contest', domainId, tid };
        await ScheduleModel.deleteMany(syncTask);
        if (Date.now() <= endAt.toDate().getTime() && hasObjectiveTask(pids, pdict)) {
            await ScheduleModel.add({ ...syncTask, operation: ['syncObjective'], executeAfter: endAt.toDate() });
            await contest.edit(domainId, tid, { objectiveSynced: false } as any);
        } else if (Date.now() > endAt.toDate().getTime()) {
            // Closed early: evaluate every student now.
            const fresh = await contest.get(domainId, tid);
            if (fresh) await evaluateContainerResults(domainId, { ...fresh, objectiveSynced: false } as any);
        }
        // Code similarity (PTA fork, handler/similarity.ts): while the box is
        // ticked and the homework is still open, a deadline task compares the
        // programming submissions once it ends; a homework that has already
        // ended is checked right away, once. Unticking withdraws the task.
        await scheduleSimilarityCheck(domainId, tid, checkSimilarity, endAt.toDate());
        this.response.body = { tid };
        this.response.redirect = this.url('homework_detail', { tid });
    }

    @param('tid', Types.ObjectId)
    async postDelete(domainId: string, tid: ObjectId) {
        const tdoc = await contest.get(domainId, tid);
        if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        await Promise.all([
            record.updateMulti(domainId, { domainId, contest: tid }, undefined, undefined, { contest: '' }),
            contest.del(domainId, tid),
            storage.del(tdoc.files?.map((i) => `contest/${domainId}/${tid}/public/${i.name}`) || [], this.user._id),
        ]);
        this.response.redirect = this.url('homework_main');
    }
}

export class HomeworkFilesHandler extends Handler {
    tdoc: Tdoc;

    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        this.tdoc = await contest.get(domainId, tid);
        if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        else this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
    }

    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        this.response.body = {
            tdoc: this.tdoc,
            tsdoc: await contest.getStatus(domainId, this.tdoc.docId, this.user._id),
            udoc: await user.getById(domainId, this.tdoc.owner),
            files: sortFiles(this.tdoc.files || []),
            urlForFile: (filename: string) => this.url('homework_file_download', { tid, filename, type: 'public' }),
        };
        this.response.pjax = 'partials/files.html';
        this.response.template = 'homework_files.html';
    }

    @param('tid', Types.ObjectId)
    @post('filename', Types.Filename, true)
    async postUploadFile(domainId: string, tid: ObjectId, filename: string) {
        if ((this.tdoc.files?.length || 0) >= system.get('limit.contest_files')) {
            throw new FileLimitExceededError('count');
        }
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const size = Math.sum((this.tdoc.files || []).map((i) => i.size)) + file.size;
        if (size >= system.get('limit.contest_files_size')) {
            throw new FileLimitExceededError('size');
        }
        await storage.put(`contest/${domainId}/${tid}/public/${filename}`, file.filepath, this.user._id);
        const meta = await storage.getMeta(`contest/${domainId}/${tid}/public/${filename}`);
        const payload = { _id: filename, name: filename, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!meta) throw new FileUploadError();
        await contest.edit(domainId, tid, { files: [...(this.tdoc.files || []), payload] });
        this.back();
    }

    @param('tid', Types.ObjectId)
    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, tid: ObjectId, files: string[]) {
        await Promise.all([
            storage.del(files.map((t) => `contest/${domainId}/${tid}/public/${t}`), this.user._id),
            contest.edit(domainId, tid, { files: this.tdoc.files.filter((i) => !files.includes(i.name)) }),
        ]);
        this.back();
    }
}

/**
 * PTA fork: TEACHER SCORE ADJUSTMENT for a homework — when a student
 * argues a score, the owner (or a homework editor) can set a task's score
 * (raw 0..100, weighted and late-penalized exactly like a judged one) or
 * the final total, with a mandatory reason. Adjustments live on the
 * student's status document (`override`, model/contest.ts ScoreOverride)
 * next to the computed values, so every recalculation re-applies them and
 * "computed → adjusted" stays visible on the scoreboard, in the student's
 * results and in the evidence pop-ups. Grading a subjective task by hand
 * is the same operation on an S-task.
 */
class HomeworkScoreOverrideHandler extends Handler {
    tdoc: Tdoc;

    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        this.tdoc = await contest.get(domainId, tid);
        if (this.tdoc.rule !== 'homework') throw new ValidationError('tid');
        if (!this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)) throw new PermissionError(PERM.PERM_EDIT_HOMEWORK);
    }

    /** The student's current adjustments (for the dialog). */
    @param('tid', Types.ObjectId)
    @param('uid', Types.Int)
    async get(domainId: string, tid: ObjectId, uid: number) {
        const tsdoc: any = await contest.getStatus(domainId, tid, uid);
        this.response.body = {
            override: tsdoc?.override || null,
            detail: tsdoc?.detail || {},
            score: tsdoc?.score ?? null,
            penaltyScore: tsdoc?.penaltyScore ?? null,
            computedPenaltyScore: tsdoc?.computedPenaltyScore ?? null,
        };
    }

    @param('tid', Types.ObjectId)
    @param('uid', Types.Int)
    @param('pid', Types.Int, true)
    @param('score', Types.Float)
    @param('reason', Types.Content)
    async postSet(domainId: string, tid: ObjectId, uid: number, pid: number | undefined, score: number, reason: string) {
        if (pid !== undefined && !this.tdoc.pids.includes(pid)) throw new ValidationError('pid');
        if (!Number.isFinite(score) || score < 0) throw new ValidationError('score');
        if (pid !== undefined && score > 100) throw new ValidationError('score');
        const why = String(reason || '').trim().slice(0, 500);
        if (!why) throw new ValidationError('reason');
        const tsdoc: any = (await contest.getStatus(domainId, tid, uid)) || {};
        const override: ScoreOverride = { ...(tsdoc.override || {}) };
        override.tasks = { ...(override.tasks || {}) };
        override.log = [...(override.log || [])].slice(-50);
        const at = new Date();
        if (pid !== undefined) {
            const computed = tsdoc.detail?.[pid]?.override ? tsdoc.detail[pid].override.computed : (tsdoc.detail?.[pid]?.score ?? null);
            override.tasks[String(pid)] = {
                score, computed, reason: why, by: this.user._id, at,
            };
            override.log.push({
                kind: 'task', pid, from: tsdoc.detail?.[pid]?.score ?? null, to: score, reason: why, by: this.user._id, at,
            });
        } else {
            const computed = tsdoc.totalOverride ? tsdoc.totalOverride.computed : (tsdoc.penaltyScore ?? null);
            override.total = {
                score, computed, reason: why, by: this.user._id, at,
            };
            override.log.push({
                kind: 'total', from: tsdoc.penaltyScore ?? null, to: score, reason: why, by: this.user._id, at,
            });
        }
        await contest.setStatus(domainId, tid, uid, { override });
        const fresh: any = await contest.recalcUserStatus(domainId, tid, uid);
        this.response.body = {
            ok: true, override, score: fresh.score, penaltyScore: fresh.penaltyScore, detail: fresh.detail,
        };
    }

    @param('tid', Types.ObjectId)
    @param('uid', Types.Int)
    @param('pid', Types.Int, true)
    async postClear(domainId: string, tid: ObjectId, uid: number, pid?: number) {
        const tsdoc: any = await contest.getStatus(domainId, tid, uid);
        const override: ScoreOverride = { ...(tsdoc?.override || {}) };
        override.tasks = { ...(override.tasks || {}) };
        override.log = [...(override.log || [])].slice(-50);
        const at = new Date();
        if (pid !== undefined) {
            if (override.tasks[String(pid)]) {
                override.log.push({
                    kind: 'task', pid, from: override.tasks[String(pid)].score, to: null, reason: 'adjustment removed', by: this.user._id, at,
                });
            }
            delete override.tasks[String(pid)];
        } else if (override.total) {
            override.log.push({
                kind: 'total', from: override.total.score, to: null, reason: 'adjustment removed', by: this.user._id, at,
            });
            delete override.total;
        }
        await contest.setStatus(domainId, tid, uid, { override });
        const fresh: any = await contest.recalcUserStatus(domainId, tid, uid);
        this.response.body = {
            ok: true, override, score: fresh.score, penaltyScore: fresh.penaltyScore, detail: fresh.detail,
        };
    }
}

export async function apply(ctx) {
    ctx.Route('homework_main', '/homework', HomeworkMainHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_create', '/homework/create', HomeworkEditHandler);
    ctx.Route('homework_detail', '/homework/:tid', HomeworkDetailHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_code', '/homework/:tid/code', ContestCodeHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_edit', '/homework/:tid/edit', HomeworkEditHandler);
    ctx.Route('homework_files', '/homework/:tid/file', HomeworkFilesHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_file_download', '/homework/:tid/file/:type/:filename', ContestFileDownloadHandler, PERM.PERM_VIEW_HOMEWORK);
    await ctx.inject(['scoreboard'], ({ Route }) => {
        Route('homework_scoreboard', '/homework/:tid/scoreboard', ContestScoreboardHandler, PERM.PERM_VIEW_HOMEWORK_SCOREBOARD);
        Route('homework_scoreboard_view', '/homework/:tid/scoreboard/:view', ContestScoreboardHandler, PERM.PERM_VIEW_HOMEWORK_SCOREBOARD);
        // PTA fork: the teacher's score adjustments (owner / homework editors; checked in the handler).
        Route('homework_score_override', '/homework/:tid/score-override', HomeworkScoreOverrideHandler, PERM.PERM_VIEW_HOMEWORK);
    });
    // PTA fork: the student's AI review of objective answers after the deadline (route + page card).
    applyObjectiveFeedback(ctx);
}

import { load as yamlLoad } from 'js-yaml';
import { ObjectId } from 'mongodb';
import { STATUS, STATUS_SHORT_TEXTS, STATUS_TEXTS } from '@hydrooj/common';
import { Context } from '../context';
import { Logger } from '../logger';
import { ContestNotLiveError, ContestNotAttendedError,
    BadRequestError, ForbiddenError, NotFoundError, PermissionError,
    ProblemConfigError, ProblemNotAllowLanguageError, ValidationError,
} from '../error';
import type { ProblemDoc, RecordDoc } from '../interface';
import * as aiTutor from '../lib/ai_tutor';
import { AiStudioDetailHandler, AiStudioHandler, registerAiStudioTemplates } from './ai_author';
import { ContestDetailBaseHandler } from './contest';
import { PERM, PRIV } from '../model/builtin';
import * as contest from '../model/contest';
import domain from '../model/domain';
import problem from '../model/problem';
import record from '../model/record';
import storage from '../model/storage';
import SelfLearningModel, { getClassReport, getSubjective, getSuggestionReportsIn, getTutorThreadsIn, listSubjective, removeSubjectiveFile, setClassReport, setSubjectiveReport, upsertSubjectiveFile, getSuggestionReport, setSuggestionReport, SelfLearningDoc, TutorMessage, TutorThreadDoc } from '../model/selflearning';
import * as setting from '../model/setting';
import system from '../model/system';
import user from '../model/user';
import { Handler, param, Types } from '../service/server';

const JUDGING = [STATUS.STATUS_WAITING, STATUS.STATUS_JUDGING, STATUS.STATUS_COMPILING, STATUS.STATUS_FETCHED];

async function loadSession(domainId: string, ssid: ObjectId): Promise<SelfLearningDoc> {
    const sdoc = await SelfLearningModel.get(domainId, ssid);
    if (!sdoc) throw new NotFoundError(domainId, ssid);
    return sdoc;
}

class SelfLearningMainHandler extends Handler {
    async get({ domainId }) {
        const sdocs = await SelfLearningModel.getMulti(domainId).limit(100).toArray();
        const udict = await user.getList(domainId, sdocs.map((i) => i.owner));
        this.response.template = 'self_learning.html';
        this.response.body = {
            sdocs,
            udict,
            canCreate: this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK) || this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM),
        };
    }
}

class SelfLearningEditHandler extends Handler {
    sdoc?: SelfLearningDoc;

    @param('ssid', Types.ObjectId, true)
    async prepare({ domainId }, ssid?: ObjectId) {
        if (ssid) {
            this.sdoc = await loadSession(domainId, ssid);
            if (this.sdoc.owner !== this.user._id) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        } else this.checkPerm(PERM.PERM_CREATE_HOMEWORK);
    }

    async get() {
        this.response.template = 'self_learning_edit.html';
        this.response.body = {
            sdoc: this.sdoc,
            pids: this.sdoc ? this.sdoc.pids.join(',') : '',
            page_name: this.sdoc ? 'self_learning_edit' : 'self_learning_create',
        };
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('pids', Types.Content)
    async postUpdate({ domainId }, title: string, content: string, _pids: string) {
        const pids = _pids.replace(/，/g, ',').split(',').map((i) => +i).filter((i) => i);
        if (!pids.length) throw new ValidationError('pids');
        await problem.getList(domainId, pids, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id, true);
        if (this.sdoc) {
            await SelfLearningModel.edit(domainId, this.sdoc.docId, { title, content, pids });
            this.response.redirect = this.url('self_learning_detail', { ssid: this.sdoc.docId });
        } else {
            const ssid = await SelfLearningModel.add(domainId, this.user._id, title, content, pids);
            this.response.redirect = this.url('self_learning_detail', { ssid });
        }
    }

    async postDelete({ domainId }) {
        if (!this.sdoc) throw new NotFoundError();
        await SelfLearningModel.del(domainId, this.sdoc.docId);
        this.response.redirect = this.url('self_learning');
    }
}

class SelfLearningDetailHandler extends Handler {
    @param('ssid', Types.ObjectId)
    async get({ domainId }, ssid: ObjectId) {
        const sdoc = await loadSession(domainId, ssid);
        const pdict = await problem.getList(
            domainId, sdoc.pids, true, false, problem.PROJECTION_CONTEST_LIST, true,
        );
        const psdict = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await problem.getListStatus(domainId, this.user._id, sdoc.pids)
            : {};
        const udict = await user.getList(domainId, [sdoc.owner]);
        // Tutor Spark strip: the student's own momentum, rendered server-side
        // so the page needs no extra scripting. Staff accounts see nothing.
        const isStudentView = !this.user.own(sdoc)
            && !this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK)
            && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
        let spark: any = null;
        if (isStudentView && this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            const sp = await SelfLearningModel.getSpark(domainId, this.user._id).catch(() => null);
            if (sp) {
                const owned = new Set(sp.badges || []);
                spark = {
                    streak: sp.streak || 0,
                    challengesCleared: sp.challengesCleared || 0,
                    badges: SelfLearningModel.badgeCatalog().filter((b) => owned.has(b.id)),
                };
            }
        }
        const solvedCount = sdoc.pids.filter((pid) => psdict[pid]?.status === STATUS.STATUS_ACCEPTED).length;
        this.response.template = 'self_learning_detail.html';
        this.response.body = {
            sdoc,
            pdict,
            psdict,
            udict,
            spark,
            solvedCount,
            canEdit: sdoc.owner === this.user._id
                || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
                || this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM),
        };
    }
}

class SelfLearningProblemBaseHandler extends Handler {
    sdoc: SelfLearningDoc;
    pdoc: ProblemDoc;

    @param('ssid', Types.ObjectId)
    @param('pid', Types.PositiveInt)
    async _prepare({ domainId }, ssid: ObjectId, pid: number) {
        this.sdoc = await loadSession(domainId, ssid);
        if (!this.sdoc.pids.includes(pid)) throw new NotFoundError(domainId, pid);
        this.pdoc = await problem.get(domainId, pid);
        if (!this.pdoc) throw new NotFoundError(domainId, pid);
    }

    /**
     * Students are domain members without teaching capability here: not the
     * session owner, and without the homework-management permissions of this
     * domain. Note that Hydro forces accounts holding PRIV_MANAGE_ALL_DOMAIN
     * into the root role of every domain, so those always count as staff.
     */
    get isStudent() {
        if (this.sdoc && this.user.own(this.sdoc)) return false;
        return !this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK)
            && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
    }

    /** 'programming' | 'objective' (quiz) | 'submit_answer'. */
    get problemKind() {
        return aiTutor.problemKindOf(this.pdoc.config);
    }

    /**
     * The given user's judged submissions on this problem, oldest first,
     * excluding Scratchpad pretest runs (they carry the RECORD_PRETEST
     * contest marker and are not real attempts).
     */
    async submissionTrajectory(domainId: string, uid: number, limit = 10) {
        const history = await record.getMulti(domainId, {
            pid: this.pdoc.docId, uid, contest: { $ne: record.RECORD_PRETEST },
        }).sort({ _id: -1 }).limit(limit)
            .project({ code: 1, lang: 1, status: 1, score: 1 })
            .toArray();
        return history.reverse().map((r: any) => ({
            rid: r._id.toHexString(),
            lang: r.lang || '',
            status: r.status,
            statusText: STATUS_TEXTS[r.status] || `${r.status}`,
            accepted: r.status === STATUS.STATUS_ACCEPTED,
            score: r.score || 0,
            at: r._id.getTimestamp().getTime(),
            code: typeof r.code === 'string' ? r.code.slice(0, 8000) : '',
        }));
    }
}

class SelfLearningSolveHandler extends SelfLearningProblemBaseHandler {
    async get({ domainId }) {
        const langRange = (this.pdoc.config && typeof this.pdoc.config === 'object' && this.pdoc.config.langs)
            ? Object.fromEntries(this.pdoc.config.langs.map((i) => [i, setting.langs[i]?.display || i]))
            : setting.SETTINGS_BY_KEY.codeLang.range;
        this.UiContext.slSsid = this.sdoc.docId.toHexString();
        this.UiContext.slPid = this.pdoc.docId;
        this.UiContext.slTutor = aiTutor.tutorConfigured() && this.isStudent;
        this.UiContext.slType = this.problemKind;
        // The full session problem list feeds the PTA-style rail inside the IDE.
        try {
            const listPdict = await problem.getList(
                domainId, this.sdoc.pids, true, false, problem.PROJECTION_CONTEST_LIST, true,
            );
            const listPsdict = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
                ? await problem.getListStatus(domainId, this.user._id, this.sdoc.pids)
                : {};
            this.UiContext.slProblems = this.sdoc.pids.map((pid) => ({
                pid,
                title: listPdict[pid]?.title || String(pid),
                kind: aiTutor.problemKindOf(listPdict[pid]?.config),
                status: listPsdict[pid]?.status || 0,
            }));
        } catch (e) { /* the rail is optional */ }
        this.response.template = 'self_learning_solve.html';
        this.response.body = {
            sdoc: this.sdoc,
            pdoc: this.pdoc,
            langRange,
            problemKind: this.problemKind,
            tutorConfigured: aiTutor.tutorConfigured(),
            isStudent: this.isStudent,
            providerInfo: aiTutor.tutorProviderInfo(),
        };
    }

    @param('lang', Types.Name)
    @param('code', Types.String)
    @param('pretest', Types.Boolean)
    async post({ domainId }, lang: string, code: string, pretest = false) {
        const config = this.pdoc.config;
        if (typeof config === 'string' || config === null) throw new ProblemConfigError();
        if (['submit_answer', 'objective'].includes(config.type)) {
            lang = '_';
            pretest = false;
        } else if ((config.langs && !config.langs.includes(lang)) || !setting.langs[lang] || setting.langs[lang].disabled) {
            throw new ProblemNotAllowLanguageError();
        }
        let input: string[] = [];
        if (pretest) {
            // Mirror the core submit handler: pretest runs the code against
            // custom input from the Scratchpad, without touching statistics.
            if (setting.langs[lang]?.pretest) lang = setting.langs[lang].pretest as string;
            if (!['default', 'remote_judge'].includes(config.type)) throw new BadRequestError('Pretest is not supported for this problem.');
            const raw = (this.args as any).input;
            input = (Array.isArray(raw) ? raw : [raw]).map((i: any) => String(i ?? ''));
            if (!input.length) throw new ValidationError('input');
        }
        await this.limitRate('add_record', 60, system.get('limit.submission_user'), '{{user}}');
        await this.limitRate('add_record', 60, pretest ? system.get('limit.pretest') : system.get('limit.submission'));
        code = code.replace(/\r\n/g, '\n');
        const lengthLimit = system.get('limit.codelength') || 128 * 1024;
        if (!code.trim()) throw new ValidationError('code');
        if (code.length > lengthLimit) throw new ValidationError('code');
        const rid = await record.add(
            domainId, this.pdoc.docId, this.user._id, lang, code, true,
            pretest ? { input, type: 'pretest' } : { type: 'judge' },
        );
        if (!pretest) {
            await Promise.all([
                problem.inc(domainId, this.pdoc.docId, 'nSubmit', 1),
                domain.incUserInDomain(domainId, this.user._id, 'nSubmit'),
            ]);
        }
        this.response.body = { rid: rid.toHexString() };
    }
}

class SelfLearningRecordHandler extends SelfLearningProblemBaseHandler {
    @param('rid', Types.ObjectId, true)
    @param('full', Types.Boolean)
    async get({ domainId }, rid?: ObjectId, full = false) {
        if (!rid) {
            // History mode: the solve page's "Submitted code" panel asks for the
            // requesting user's own trajectory on this problem, no rid needed.
            this.response.body = { attempts: await this.submissionTrajectory(domainId, this.user._id) };
            return;
        }
        const rdoc = await record.get(domainId, rid);
        if (!rdoc || rdoc.pid !== this.pdoc.docId) throw new NotFoundError(domainId, rid);
        if (rdoc.uid !== this.user._id && !this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) throw new PermissionError();
        const judged = !JUDGING.includes(rdoc.status);
        this.response.body = {
            rid: rid.toHexString(),
            status: rdoc.status,
            statusText: STATUS_TEXTS[rdoc.status] || `${rdoc.status}`,
            shortText: STATUS_SHORT_TEXTS[rdoc.status] || '',
            accepted: rdoc.status === STATUS.STATUS_ACCEPTED,
            judged,
            score: rdoc.score || 0,
            time: rdoc.time || 0,
            memory: rdoc.memory || 0,
            lang: rdoc.lang || '',
            code: typeof rdoc.code === 'string' ? rdoc.code.slice(0, 8000) : '',
            submitAt: rdoc._id.getTimestamp().getTime(),
            judgeAt: rdoc.judgeAt ? new Date(rdoc.judgeAt).getTime() : null,
            compilerTexts: (rdoc.compilerTexts || []).join('\n').slice(0, 4000),
            judgeTexts: (rdoc.judgeTexts || [])
                .map((t: any) => (typeof t === 'string' ? t : t?.message || ''))
                .filter((t: string) => t).join('\n').slice(0, 2000),
            cases: (rdoc.testCases || []).slice(0, 60).map((c: any) => ({
                id: c.id,
                subtaskId: c.subtaskId,
                status: c.status,
                statusText: STATUS_TEXTS[c.status] || STATUS_SHORT_TEXTS[c.status] || `${c.status}`,
                message: (typeof c.message === 'string' ? c.message : (c.message?.message || '')).slice(0, 200),
                score: c.score,
                time: c.time,
                memory: c.memory,
            })),
        };
        if (full) {
            const uiLang = this.user.viewLang || this.session.viewLang || system.get('server.language') || 'en';
            this.response.body.problem = {
                pid: this.pdoc.pid || this.pdoc.docId,
                title: this.pdoc.title || '',
                kind: this.problemKind,
                statementRaw: aiTutor.resolveStatement(this.pdoc, uiLang).slice(0, 40000),
            };
            // The submission trajectory of the record's owner on this problem
            // (oldest first), so the tutor window can show every attempt's code.
            this.response.body.attempts = await this.submissionTrajectory(domainId, rdoc.uid);
        }
    }
}

class SelfLearningTutorHandler extends SelfLearningProblemBaseHandler {
    checkTutorAllowed() {
        if (!aiTutor.tutorEnabled()) throw new ForbiddenError('The AI tutor is disabled.');
        if (!aiTutor.tutorConfigured()) throw new ForbiddenError('The AI tutor is not configured. Please ask the administrator to set an API key.');
        if (!this.isStudent) throw new ForbiddenError('The AI tutor is only available to student accounts.');
    }

    /** Best-effort spark update — motivation must never break tutoring. */
    async sparkTouch(domainId: string, inc: any = {}) {
        try {
            return await SelfLearningModel.touchSpark(domainId, this.user._id, inc);
        } catch (e) {
            logger.warn('[pta-ui] spark update failed: %s', e.message);
            return null;
        }
    }

    static sparkView(s: any) {
        if (!s) return null;
        return {
            streak: s.streak || 0,
            accepted: s.accepted || 0,
            cleanSolves: s.cleanSolves || 0,
            comebacks: s.comebacks || 0,
            cardAnswers: s.cardAnswers || 0,
            challengesCleared: s.challengesCleared || 0,
            badges: s.badges || [],
        };
    }

    static publicBadges(badges: any[]) {
        return (badges || []).map((b) => ({ id: b.id, icon: b.icon, title: b.title, desc: b.desc }));
    }

    /** The Boss Challenge offer/state payload for the client. */
    challengePayload(thread: TutorThreadDoc | null) {
        if (!['programming', 'objective'].includes(this.problemKind)) return null;
        const c = thread?.challenge;
        if (c?.state === 'cleared') return { state: 'cleared' };
        if (c?.state === 'declined') return { state: 'declined' };
        if (c?.state === 'active') {
            return {
                state: 'active', available: true, title: c.title || 'Boss Challenge', hook: c.hook || '', question: c.question || '',
            };
        }
        return { state: 'offered', available: true };
    }

    /**
     * First-accept bookkeeping shared by every path a fresh Accepted verdict
     * can arrive through (postAnnotate for programming, postAccepted for
     * quizzes, postStart for the record-page flows). attemptCountAtAc counts
     * the accepted attempt itself; the thread flag makes it fire exactly once
     * per student per problem.
     */
    async sparkOnAccepted(domainId: string, thread: TutorThreadDoc | null, attemptCountAtAc: number) {
        if (!thread || thread.firstAcceptedAt) return this.sparkTouch(domainId);
        try {
            await SelfLearningModel.setThreadFields(thread._id, { firstAcceptedAt: new Date() });
        } catch (e) {
            logger.warn('[pta-ui] firstAcceptedAt stamp failed: %s', e.message);
        }
        return this.sparkTouch(domainId, {
            accepted: 1,
            cleanSolves: attemptCountAtAc <= 1 ? 1 : 0,
            comebacks: attemptCountAtAc >= 4 ? 1 : 0,
        });
    }

    async tutorCtx(rdoc: RecordDoc | null, attemptCount: number, everAccepted: boolean): Promise<aiTutor.TutorTurnContext> {
        const uiLang = this.user.viewLang || this.session.viewLang || system.get('server.language') || 'en';
        const problemKind = this.problemKind;
        let objective: aiTutor.ObjectiveAnalysis | null = null;
        if (problemKind === 'objective') {
            // The answer key lives only in the raw testdata config.yaml. We load it
            // server-side for the tutor's private aiming; it is never sent to the client.
            let rawConfig = '';
            try {
                const raw = await problem.get(this.args.domainId, this.pdoc.docId, ['docId', 'config'] as any, true);
                if (typeof raw?.config === 'string') rawConfig = raw.config;
            } catch (e) { /* the tutor still works without the key */ }
            objective = aiTutor.analyzeObjective(this.pdoc, rawConfig, rdoc, uiLang);
        }
        let attempts: aiTutor.TutorAttempt[] | undefined;
        if (problemKind !== 'objective' && rdoc) {
            // Requirement: every tutor turn sees the WHOLE submission history so
            // its questions stay consistent across resubmissions. Older attempts
            // are truncated harder; the latest rdoc is excluded (it appears in
            // full as the focal submission).
            try {
                const latest = rdoc._id.toHexString();
                attempts = (await this.submissionTrajectory(this.args.domainId, this.user._id, 9))
                    .filter((a) => a.rid !== latest)
                    .slice(-8)
                    .map((a) => ({
                        statusText: a.statusText,
                        score: a.score,
                        lang: a.lang,
                        accepted: a.accepted,
                        code: (a.code || '').slice(0, 2000),
                    }));
                if (!attempts.length) attempts = undefined;
            } catch (e) { /* history is best-effort context */ }
        }
        return {
            pdoc: this.pdoc,
            rdoc,
            attemptCount,
            everAccepted,
            uiLang,
            problemKind,
            objective,
            attempts,
        };
    }

    async everAccepted(domainId: string) {
        const psdoc = await problem.getStatus(domainId, this.pdoc.docId, this.user._id);
        return psdoc?.status === STATUS.STATUS_ACCEPTED;
    }

    /** Serialize a stored message for the client, keeping card metadata. */
    static mapMsg(m: TutorMessage) {
        return {
            role: m.role, kind: m.kind, content: m.content, line: m.line, endLine: m.endLine, resolved: m.resolved,
        };
    }

    /**
     * Every judged submission gets exactly one divider in the thread. With the
     * pop-up cards as the sole channel for programming problems, this is now
     * shared bookkeeping: postAnnotate calls it on failures, postAccepted on
     * successes. Returns the divider text when one was just created so the
     * client can mirror it live.
     */
    async ensureAttemptMarker(domainId: string, rdoc: RecordDoc): Promise<{ thread: TutorThreadDoc, marker: string | null, accepted: boolean }> {
        const accepted = rdoc.status === STATUS.STATUS_ACCEPTED;
        let thread = await SelfLearningModel.ensureThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        if (thread.rid && thread.rid.toHexString() === rdoc._id.toHexString()) return { thread, marker: null, accepted };
        const attemptCount = (thread.attemptCount || 0) + 1;
        const content = `Attempt #${attemptCount} — verdict: ${STATUS_TEXTS[rdoc.status] || rdoc.status} (score ${rdoc.score || 0}).`;
        await SelfLearningModel.pushMessages(thread._id, [
            { role: 'user', kind: accepted ? 'accepted' : 'attempt', content },
        ], { rid: rdoc._id, attemptCount });
        thread = await SelfLearningModel.getThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        return { thread, marker: content, accepted };
    }

    async get() {
        this.checkTutorAllowed();
        const thread = await SelfLearningModel.getThread(this.args.domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        const spark = await SelfLearningModel.getSpark(this.args.domainId, this.user._id).catch(() => null);
        this.response.body = {
            messages: (thread?.messages || []).map(SelfLearningTutorHandler.mapMsg),
            attemptCount: thread?.attemptCount || 0,
            spark: SelfLearningTutorHandler.sparkView(spark),
            badgeCatalog: SelfLearningModel.badgeCatalog(),
            challenge: this.challengePayload(thread),
        };
    }

    async loadOwnRecord(domainId: string, rid: ObjectId) {
        const rdoc = await record.get(domainId, rid);
        if (!rdoc || rdoc.pid !== this.pdoc.docId || rdoc.uid !== this.user._id) throw new NotFoundError(domainId, rid);
        if (!aiTutor.isJudged(rdoc)) throw new BadRequestError('This submission has not been judged yet.');
        return rdoc;
    }

    @param('rid', Types.ObjectId)
    async postStart({ domainId }, rid: ObjectId) {
        this.checkTutorAllowed();
        await this.limitRate('ai_tutor', 60, 10, '{{user}}');
        const rdoc = await this.loadOwnRecord(domainId, rid);
        const accepted = rdoc.status === STATUS.STATUS_ACCEPTED;
        let thread = await SelfLearningModel.ensureThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        const sameRid = !!(thread.rid && thread.rid.toHexString() === rid.toHexString() && thread.messages.length);
        const lastMsg = thread.messages[thread.messages.length - 1];
        // Reopening the chat on the same submission: just return existing history.
        if (sameRid && lastMsg?.role === 'assistant') {
            const sparkNow = await SelfLearningModel.getSpark(domainId, this.user._id).catch(() => null);
            this.response.body = {
                messages: thread.messages.map(SelfLearningTutorHandler.mapMsg),
                spark: SelfLearningTutorHandler.sparkView(sparkNow),
                badgeCatalog: SelfLearningModel.badgeCatalog(),
                challenge: this.challengePayload(thread),
            };
            return;
        }
        // First tutoring turn if the tutor has never spoken in this thread yet.
        const isFirst = !thread.messages.some((m) => m.role === 'assistant');
        let attemptCount = thread.attemptCount || 0;
        if (!sameRid) {
            // A brand-new submission: record it as an attempt divider.
            attemptCount += 1;
            const marker: Omit<TutorMessage, 'at'> = {
                role: 'user',
                kind: accepted ? 'accepted' : 'attempt',
                content: `Attempt #${attemptCount} — verdict: ${STATUS_TEXTS[rdoc.status] || rdoc.status} (score ${rdoc.score || 0}).`,
            };
            await SelfLearningModel.pushMessages(thread._id, [marker], { rid, attemptCount });
            thread = await SelfLearningModel.getThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        }
        // If sameRid but the last message is not from the assistant, a previous
        // provider call failed after the marker was stored — retry the reply only.
        const ctx = await this.tutorCtx(rdoc, attemptCount || 1, await this.everAccepted(domainId));
        const directive = accepted
            ? (isFirst ? aiTutor.ACCEPTED_OPENING_DIRECTIVE : aiTutor.ACCEPTED_DIRECTIVE)
            : (isFirst ? aiTutor.OPENING_DIRECTIVE : aiTutor.RESUBMIT_DIRECTIVE);
        const reply = await aiTutor.runTutorTurn(ctx, thread.messages, directive);
        await SelfLearningModel.pushMessages(thread._id, [{ role: 'assistant', kind: 'chat', content: reply }]);
        const messages = [...thread.messages, { role: 'assistant', kind: 'chat', content: reply }];
        const touched = accepted && !sameRid
            ? await this.sparkOnAccepted(domainId, thread, attemptCount || 1)
            : await this.sparkTouch(domainId);
        this.response.body = {
            messages: messages.map((m: any) => SelfLearningTutorHandler.mapMsg(m)),
            spark: SelfLearningTutorHandler.sparkView(touched?.spark),
            newBadges: SelfLearningTutorHandler.publicBadges(touched?.newBadges || []),
            badgeCatalog: SelfLearningModel.badgeCatalog(),
            challenge: this.challengePayload(await SelfLearningModel.getThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id)),
        };
    }

    @param('rid', Types.ObjectId)
    @param('asked', Types.String, true)
    async postAnnotate({ domainId }, rid: ObjectId, asked = '') {
        this.checkTutorAllowed();
        if (this.problemKind !== 'programming') {
            this.response.body = { annotation: null };
            return;
        }
        await this.limitRate('ai_tutor', 60, 10, '{{user}}');
        let askedList: string[] = [];
        try {
            const parsed = JSON.parse(asked || '[]');
            if (Array.isArray(parsed)) askedList = parsed.map((q) => String(q)).slice(0, 12);
        } catch (e) { /* ignore malformed asked lists */ }
        const rdoc = await this.loadOwnRecord(domainId, rid);
        // The pop-up cards are the interaction channel for programming
        // problems, so this endpoint owns the attempt bookkeeping and
        // persists every card question into the thread — the red launcher
        // replays that history read-only.
        const { thread, marker, accepted } = await this.ensureAttemptMarker(domainId, rdoc);
        const ctx = await this.tutorCtx(rdoc, thread?.attemptCount || 1, await this.everAccepted(domainId));
        // Guided-session chaining: the client sends the CURRENT editor code so
        // the next question targets what the student sees (fixed flaws are
        // skipped, anchors match the live line numbers).
        if (typeof this.args.code === 'string' && this.args.code.trim()) {
            ctx.liveCode = String(this.args.code).slice(0, 8000);
        }
        const annotation = await aiTutor.runAnnotationTurn(ctx, askedList);
        if (annotation && thread) {
            await SelfLearningModel.pushMessages(thread._id, [{
                role: 'assistant', kind: 'anno', content: annotation.question, line: annotation.line, endLine: annotation.endLine,
            }]);
        }
        // Spark: a FRESH accepted divider means this attempt just won —
        // counted once per problem; every call keeps the daily streak alive.
        const touched = accepted && marker
            ? await this.sparkOnAccepted(domainId, thread, thread?.attemptCount || 1)
            : await this.sparkTouch(domainId);
        this.response.body = {
            annotation,
            marker,
            markerAccepted: accepted,
            spark: SelfLearningTutorHandler.sparkView(touched?.spark),
            newBadges: SelfLearningTutorHandler.publicBadges(touched?.newBadges || []),
            challenge: accepted ? this.challengePayload(thread) : null,
        };
    }

    @param('rid', Types.ObjectId)
    @param('line', Types.UnsignedInt)
    @param('question', Types.String)
    @param('text', Types.String)
    @param('endLine', Types.UnsignedInt, true)
    @param('history', Types.String, true)
    async postAnnotateReply({ domainId }, rid: ObjectId, line: number, question: string, text: string, endLine = 0, history = '') {
        this.checkTutorAllowed();
        if (this.problemKind !== 'programming') throw new BadRequestError('Line annotations are only available for programming problems.');
        await this.limitRate('ai_tutor', 60, 10, '{{user}}');
        let turns: { role: string, content: string }[] = [];
        try {
            const parsed = JSON.parse(history || '[]');
            if (Array.isArray(parsed)) {
                turns = parsed
                    .filter((t) => t && typeof t === 'object')
                    .map((t) => ({ role: String(t.role || ''), content: String(t.content || '').slice(0, 800) }))
                    .slice(-12);
            }
        } catch (e) { /* ignore malformed history */ }
        const rdoc = await this.loadOwnRecord(domainId, rid);
        const { thread } = await this.ensureAttemptMarker(domainId, rdoc);
        const maxMessages = +system.get('ai_tutor.max_messages') || 80;
        if (thread.messages.length >= maxMessages) {
            throw new BadRequestError('This tutoring conversation reached its length limit. Please reset it to continue.');
        }
        const ctx = await this.tutorCtx(rdoc, thread?.attemptCount || 1, await this.everAccepted(domainId));
        if (typeof this.args.code === 'string' && this.args.code.trim()) {
            ctx.liveCode = String(this.args.code).slice(0, 8000);
        }
        const result = await aiTutor.runAnnotationDialogue(ctx, {
            line,
            endLine,
            question: question.slice(0, 300),
            history: turns,
            answer: text.slice(0, 1000),
        });
        // Persist the card exchange: this dialogue IS the tutoring history now.
        await SelfLearningModel.pushMessages(thread._id, [
            {
                role: 'user', kind: 'anno', content: text.slice(0, 1000), line, endLine,
            },
            {
                role: 'assistant', kind: 'anno', content: result.reply, line, endLine, resolved: result.resolved,
            },
        ]);
        const touched = await this.sparkTouch(domainId, { cardAnswers: 1 });
        this.response.body = {
            ...result,
            spark: SelfLearningTutorHandler.sparkView(touched?.spark),
            newBadges: SelfLearningTutorHandler.publicBadges(touched?.newBadges || []),
        };
    }

    @param('text', Types.String)
    async postMessage({ domainId }, text: string) {
        this.checkTutorAllowed();
        this.sparkTouch(domainId); // fire-and-forget: chatting counts as a practice day
        await this.limitRate('ai_tutor', 60, 10, '{{user}}');
        text = text.trim();
        if (!text) throw new ValidationError('text');
        if (text.length > 2000) throw new ValidationError('text');
        const thread = await SelfLearningModel.getThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        if (!thread || !thread.rid) throw new BadRequestError('Please submit your solution first — the tutor starts from a judged attempt.');
        const maxMessages = +system.get('ai_tutor.max_messages') || 80;
        if (thread.messages.length >= maxMessages) {
            throw new BadRequestError('This tutoring conversation reached its length limit. Please reset it to continue.');
        }
        const rdoc = await record.get(domainId, thread.rid);
        const ctx = await this.tutorCtx(rdoc, thread.attemptCount || 1, await this.everAccepted(domainId));
        const history = [...thread.messages, { role: 'user' as const, kind: 'chat' as const, content: text, at: new Date() }];
        const reply = await aiTutor.runTutorTurn(ctx, history, '');
        await SelfLearningModel.pushMessages(thread._id, [
            { role: 'user', kind: 'chat', content: text },
            { role: 'assistant', kind: 'chat', content: reply },
        ]);
        this.response.body = { reply };
    }

    @param('rid', Types.ObjectId)
    async postAccepted({ domainId }, rid: ObjectId) {
        this.checkTutorAllowed();
        await this.limitRate('ai_tutor', 60, 10, '{{user}}');
        const rdoc = await this.loadOwnRecord(domainId, rid);
        if (rdoc.status !== STATUS.STATUS_ACCEPTED) throw new BadRequestError('This submission was not accepted.');
        if (this.problemKind === 'programming') {
            // The card channel asks nothing on success (the student should not
            // lose patience after winning); just record the accepted divider so
            // the read-only history shows the milestone. Spark counting also
            // lives in postAnnotate — the firstAcceptedAt stamp keeps the two
            // paths from ever double-counting.
            const { thread, marker } = await this.ensureAttemptMarker(domainId, rdoc);
            const touched = marker
                ? await this.sparkOnAccepted(domainId, thread, thread?.attemptCount || 1)
                : await this.sparkTouch(domainId);
            this.response.body = {
                reply: null,
                marker,
                markerAccepted: true,
                spark: SelfLearningTutorHandler.sparkView(touched?.spark),
                newBadges: SelfLearningTutorHandler.publicBadges(touched?.newBadges || []),
                challenge: this.challengePayload(thread),
            };
            return;
        }
        // Quizzes: ensure the thread + accepted divider exist even when this
        // is a clean first-try accept (no failed attempts, so no prior chat).
        const { thread, marker: attemptMarker } = await this.ensureAttemptMarker(domainId, rdoc);
        const touched = attemptMarker
            ? await this.sparkOnAccepted(domainId, thread, thread?.attemptCount || 1)
            : await this.sparkTouch(domainId);
        const sparkFields = {
            spark: SelfLearningTutorHandler.sparkView(touched?.spark),
            newBadges: SelfLearningTutorHandler.publicBadges(touched?.newBadges || []),
            challenge: this.challengePayload(thread),
        };
        const hasDialogue = (thread?.messages || []).some((m) => m.role === 'assistant');
        if (!thread || !hasDialogue) {
            // Nothing to congratulate in-chat yet — the client celebrates via
            // spark and offers the Boss Challenge directly.
            this.response.body = { reply: null, marker: attemptMarker, markerAccepted: true, ...sparkFields };
            return;
        }
        const marker: Omit<TutorMessage, 'at'> = { role: 'user', kind: 'accepted', content: 'My new submission was ACCEPTED!' };
        const ctx = await this.tutorCtx(rdoc, thread.attemptCount || 1, true);
        const reply = await aiTutor.runTutorTurn(ctx, [...thread.messages, { ...marker, at: new Date() }], aiTutor.ACCEPTED_DIRECTIVE);
        await SelfLearningModel.pushMessages(thread._id, [marker, { role: 'assistant', kind: 'chat', content: reply }], { rid });
        this.response.body = { reply, ...sparkFields };
    }

    /**
     * Boss Challenge: start (or resume) the optional post-acceptance stretch
     * goal. Generation runs once per problem; the stored question survives
     * page reloads so the student can come back to it.
     */
    @param('rid', Types.ObjectId, true)
    async postChallenge({ domainId }, rid?: ObjectId) {
        this.checkTutorAllowed();
        if (!['programming', 'objective'].includes(this.problemKind)) throw new BadRequestError('The Boss Challenge is only available for programming and quiz problems.');
        await this.limitRate('ai_tutor', 60, 10, '{{user}}');
        const thread = await SelfLearningModel.ensureThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        if (thread.challenge?.state === 'cleared') throw new BadRequestError('You already cleared the Boss Challenge for this problem.');
        if (thread.challenge?.state === 'active' && thread.challenge.question) {
            this.response.body = {
                title: thread.challenge.title || 'Boss Challenge',
                hook: thread.challenge.hook || '',
                question: thread.challenge.question,
                resumed: true,
            };
            return;
        }
        if (!thread.firstAcceptedAt && !(await this.everAccepted(domainId))) {
            throw new BadRequestError('Get the problem Accepted first — then the Boss Challenge unlocks.');
        }
        // The challenge grows out of the student's own accepted solution.
        let rdoc: RecordDoc | null = null;
        if (rid) rdoc = await this.loadOwnRecord(domainId, rid);
        if (!rdoc || rdoc.status !== STATUS.STATUS_ACCEPTED) {
            const [latest] = await record.getMulti(domainId, {
                uid: this.user._id, pid: this.pdoc.docId, status: STATUS.STATUS_ACCEPTED,
            }).sort({ _id: -1 }).limit(1).toArray();
            rdoc = latest || rdoc;
        }
        const ctx = await this.tutorCtx(rdoc, thread.attemptCount || 1, true);
        const gen = await aiTutor.runChallengeGeneration(ctx);
        await SelfLearningModel.pushMessages(thread._id, [{
            role: 'assistant', kind: 'anno', content: `🔥 ${gen.title} — ${gen.challenge}`,
        }], {
            challenge: {
                state: 'active', title: gen.title, hook: gen.hook, question: gen.challenge, rid: rdoc?._id,
            },
        });
        await this.sparkTouch(domainId);
        this.response.body = { title: gen.title, hook: gen.hook, question: gen.challenge };
    }

    @param('text', Types.String)
    @param('history', Types.String, true)
    async postChallengeReply({ domainId }, text: string, history = '') {
        this.checkTutorAllowed();
        await this.limitRate('ai_tutor', 60, 10, '{{user}}');
        const thread = await SelfLearningModel.getThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        if (!thread || thread.challenge?.state !== 'active' || !thread.challenge.question) {
            throw new BadRequestError('No active Boss Challenge. Start one first.');
        }
        const maxMessages = +system.get('ai_tutor.max_messages') || 80;
        if (thread.messages.length >= maxMessages) {
            throw new BadRequestError('This tutoring conversation reached its length limit. Please reset it to continue.');
        }
        let turns: { role: string, content: string }[] = [];
        try {
            const parsed = JSON.parse(history || '[]');
            if (Array.isArray(parsed)) {
                turns = parsed
                    .filter((t) => t && typeof t === 'object')
                    .map((t) => ({ role: String(t.role || ''), content: String(t.content || '').slice(0, 800) }))
                    .slice(-12);
            }
        } catch (e) { /* ignore malformed history */ }
        let rdoc: RecordDoc | null = null;
        if (thread.challenge.rid) rdoc = await record.get(domainId, thread.challenge.rid).catch(() => null);
        if (rdoc && (rdoc.uid !== this.user._id || rdoc.pid !== this.pdoc.docId)) rdoc = null;
        const ctx = await this.tutorCtx(rdoc, thread.attemptCount || 1, true);
        if (typeof this.args.code === 'string' && this.args.code.trim()) {
            ctx.liveCode = String(this.args.code).slice(0, 8000);
        }
        const result = await aiTutor.runChallengeTurn(ctx, {
            challenge: thread.challenge.question,
            history: turns,
            answer: text.slice(0, 1500),
        });
        await SelfLearningModel.pushMessages(thread._id, [
            { role: 'user', kind: 'anno', content: text.slice(0, 1500) },
            {
                role: 'assistant', kind: 'anno', content: result.reply, resolved: result.cleared,
            },
        ], result.cleared ? { 'challenge.state': 'cleared', 'challenge.clearedAt': new Date() } : {});
        const touched = await this.sparkTouch(domainId, { cardAnswers: 1, challengesCleared: result.cleared ? 1 : 0 });
        this.response.body = {
            reply: result.reply,
            cleared: result.cleared,
            spark: SelfLearningTutorHandler.sparkView(touched?.spark),
            newBadges: SelfLearningTutorHandler.publicBadges(touched?.newBadges || []),
        };
    }

    async postChallengeDecline({ domainId }) {
        this.checkTutorAllowed();
        const thread = await SelfLearningModel.ensureThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        if (thread.challenge?.state === 'cleared') {
            this.response.body = { ok: 1, state: 'cleared' };
            return;
        }
        await SelfLearningModel.setThreadFields(thread._id, { challenge: { ...(thread.challenge || {}), state: 'declined' } });
        this.response.body = { ok: 1, state: 'declined' };
    }

    async postReset({ domainId }) {
        this.checkTutorAllowed();
        await SelfLearningModel.resetThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        this.response.body = { ok: 1 };
    }
}

const logger = new Logger('self-learning');

/* ------------------------------------------------------------------------ */
/* Site-wide PTA UI backend — migrated here from problem_trajectory.ts.     */
/* Some dev-mode watchers hot-reload MODIFIED handler files but never       */
/* discover files CREATED after boot, so anything defined only in a brand-  */
/* new file was unreachable on such deployments. This file is proven live.  */
/* ------------------------------------------------------------------------ */

/** Kind + title for each listed problem (config arrives as a raw YAML string). */
async function activityKinds(domainId: string, pids: number[], uid?: number) {
    const pdict = await problem.getList(domainId, pids, true, false, ['docId', 'pid', 'title', 'config'], true);
    // Rail verdict states: the requester's OWN problem-status docs. The judge
    // updates these for contest/homework submissions too (handler/judge.ts
    // calls problem.updateStatus before contest.updateStatus), so accepted /
    // tried decorations are correct inside activities as well.
    const psdict: Record<number, { status?: number, score?: number }> = {};
    if (uid && uid > 1) {
        try {
            const rows = await problem.getMultiStatus(domainId, { uid, docId: { $in: pids } })
                .project({ docId: 1, status: 1, score: 1 }).toArray();
            for (const r of rows) psdict[r.docId] = r as any;
        } catch (e) { /* status decoration is optional */ }
    }
    return pids.map((pid) => {
        const p: any = pdict[pid] || {};
        let conf: any = p.config;
        if (typeof conf === 'string') {
            try {
                conf = yamlLoad(conf) || {};
            } catch (e) {
                conf = {};
            }
        }
        // Site convention: the display pid's first letter is authoritative —
        // P=programming, O=objective, S=subjective — with the config as the
        // fallback for legacy problems.
        const disp = String(p.pid || '');
        let kind: string = aiTutor.problemKindOf(conf);
        if (/^s/i.test(disp)) kind = 'subjective';
        else if (/^o/i.test(disp)) kind = 'objective';
        else if (/^p/i.test(disp)) kind = 'programming';
        const st = psdict[pid] || {};
        return { pid, kind, title: p.title || String(pid), status: st.status || 0, score: st.score };
    });
}

/**
 * Site-wide submission trajectory for the PTA-style problem UI: the
 * requester's OWN judged, non-pretest submissions (no rid), or one
 * submission's full verdict payload for the result modal (rid given).
 */
class ProblemTrajectoryHandler extends Handler {
    @param('pid', Types.PositiveInt)
    @param('rid', Types.ObjectId, true)
    async get({ domainId }, pid: number, rid?: ObjectId) {
        if (rid) {
            const rdoc = await record.get(domainId, rid);
            if (!rdoc || rdoc.uid !== this.user._id || rdoc.pid !== pid) throw new NotFoundError(rid);
            const judged = !JUDGING.includes(rdoc.status);
            this.response.body = {
                rid: rid.toHexString(),
                status: rdoc.status,
                statusText: STATUS_TEXTS[rdoc.status] || `${rdoc.status}`,
                shortText: STATUS_SHORT_TEXTS[rdoc.status] || '',
                accepted: rdoc.status === STATUS.STATUS_ACCEPTED,
                judged,
                score: rdoc.score || 0,
                time: rdoc.time || 0,
                memory: rdoc.memory || 0,
                lang: rdoc.lang || '',
                code: typeof rdoc.code === 'string' ? rdoc.code.slice(0, 8000) : '',
                submitAt: rdoc._id.getTimestamp().getTime(),
                judgeAt: rdoc.judgeAt ? new Date(rdoc.judgeAt).getTime() : null,
                compilerTexts: (rdoc.compilerTexts || []).join('\n').slice(0, 4000),
                judgeTexts: (rdoc.judgeTexts || [])
                    .map((t: any) => (typeof t === 'string' ? t : t?.message || ''))
                    .filter((t: string) => t).join('\n').slice(0, 2000),
                cases: (rdoc.testCases || []).slice(0, 60).map((c: any) => ({
                    id: c.id,
                    subtaskId: c.subtaskId,
                    status: c.status,
                    statusText: STATUS_TEXTS[c.status] || STATUS_SHORT_TEXTS[c.status] || `${c.status}`,
                    message: (typeof c.message === 'string' ? c.message : (c.message?.message || '')).slice(0, 200),
                    score: c.score,
                    time: c.time,
                    memory: c.memory,
                })),
            };
            return;
        }
        const history = await record.getMulti(domainId, {
            pid, uid: this.user._id, contest: { $ne: record.RECORD_PRETEST },
        }).sort({ _id: -1 }).limit(10)
            .project({ code: 1, lang: 1, status: 1, score: 1 })
            .toArray();
        this.response.body = {
            attempts: history.reverse().map((r: any) => ({
                rid: r._id.toHexString(),
                lang: r.lang || '',
                status: r.status,
                statusText: STATUS_TEXTS[r.status] || `${r.status}`,
                accepted: r.status === STATUS.STATUS_ACCEPTED,
                score: r.score || 0,
                at: r._id.getTimestamp().getTime(),
                code: typeof r.code === 'string' ? r.code.slice(0, 8000) : '',
            })),
        };
    }
}

/** Kinds+titles of a contest/homework's problems (they share TYPE_CONTEST). */
class ActivityProblemKindsHandler extends Handler {
    @param('tid', Types.ObjectId)
    async get({ domainId }, tid: ObjectId) {
        const tdoc = await contest.get(domainId, tid);
        if (!tdoc) throw new NotFoundError(tid);
        this.response.body = { pids: await activityKinds(domainId, tdoc.pids || [], this.user?._id) };
    }
}

const FALSY_AVAILABILITY = ['', '0', 'false', 'no', 'n', 'unavailable', 'inactive', 'off'];

/**
 * Post-acceptance "AI Suggestions": one comprehensive Markdown code review
 * over the problem statement plus the requester's FULL submission trajectory
 * (timestamps included, so debugging behavior can be analyzed). Requires at
 * least one accepted attempt — the button only appears on accepted modals.
 */
class AiSuggestionsHandler extends Handler {
    @param('pid', Types.PositiveInt)
    async get({ domainId }, pid: number) {
        // Saved-report lookup: lets the modal show the last generated report
        // instantly (and token-free) instead of regenerating every time.
        const doc = await getSuggestionReport(domainId, pid, this.user._id);
        this.response.body = doc
            ? { report: doc.report, updateAt: doc.updateAt, attempts: doc.attempts }
            : { report: null };
    }

    @param('pid', Types.PositiveInt)
    async post({ domainId }, pid: number) {
        if (!aiTutor.tutorConfigured()) throw new ForbiddenError('The AI tutor is not configured. Please ask the administrator to set an API key.');
        await this.limitRate('ai_suggestions', 60, 3, '{{user}}');
        const history = await record.getMulti(domainId, {
            pid, uid: this.user._id, contest: { $ne: record.RECORD_PRETEST },
        }).sort({ _id: -1 }).limit(12)
            .project({ code: 1, lang: 1, status: 1, score: 1 })
            .toArray();
        const attempts: aiTutor.SuggestionAttempt[] = history.reverse().map((r: any) => ({
            at: r._id.getTimestamp().getTime(),
            lang: r.lang || '',
            statusText: STATUS_TEXTS[r.status] || `${r.status}`,
            score: r.score || 0,
            accepted: r.status === STATUS.STATUS_ACCEPTED,
            code: typeof r.code === 'string' ? r.code.slice(0, 8000) : '',
        }));
        if (!attempts.some((a) => a.accepted)) {
            throw new BadRequestError('AI Suggestions are available after an accepted submission.');
        }
        const pdoc = await problem.get(domainId, pid);
        if (!pdoc) throw new NotFoundError(pid);
        const uiLang = this.user.viewLang || this.session.viewLang || system.get('server.language') || 'en';
        const report = await aiTutor.runSuggestionsReport({ pdoc, attempts, uiLang });
        const updateAt = await setSuggestionReport(domainId, pid, this.user._id, report, attempts.length);
        this.response.body = { report, updateAt };
        logger.info('[pta-ui] AI Suggestions generated and saved for uid=%d pid=%d over %d attempt(s)', this.user._id, pid, attempts.length);
    }
}

/**
 * Root-only bulk user import (the homepage "Add Users" modal).
 * GET  -> every domain with its assignable roles, for the pickers.
 * POST -> { users: [{lastName, firstName, uname, availability}],
 *           assignments: [{domainId, role}] }
 *         Creates missing accounts (password `Username_LastName_FirstName`),
 *         then joins every listed user into every listed domain with the
 *         chosen role. Existing accounts are never modified — they are only
 *         added to the domains.
 */
class BulkAddUsersHandler extends Handler {
    async get() {
        const ddocs = await domain.getMulti().limit(200).toArray();
        this.response.body = {
            domains: ddocs.map((d: any) => ({
                _id: d._id,
                name: d.name || d._id,
                roles: Array.from(new Set(['default', 'root', ...Object.keys(d.roles || {})]))
                    .filter((r) => r !== 'guest'),
            })),
        };
    }

    async post() {
        const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
        let users: any[] = [];
        let assignments: any[] = [];
        try {
            users = parse(this.args.users) || [];
            assignments = parse(this.args.assignments) || [];
        } catch (e) {
            throw new BadRequestError('Malformed payload.');
        }
        if (!Array.isArray(users) || !users.length || users.length > 500) {
            throw new BadRequestError('Provide between 1 and 500 users.');
        }
        if (!Array.isArray(assignments) || !assignments.length || assignments.length > 20) {
            throw new BadRequestError('Provide between 1 and 20 domain assignments.');
        }
        // Validate every assignment up front: unknown domains abort the run.
        for (const a of assignments) {
            const ddoc = await domain.get(String(a.domainId));
            if (!ddoc) throw new NotFoundError(String(a.domainId));
            a.domainId = String(a.domainId);
            a.role = String(a.role || 'default') || 'default';
        }
        const created: string[] = [];
        const existed: string[] = [];
        const skipped: string[] = [];
        const errors: { uname: string, error: string }[] = [];
        for (const row of users) {
            const uname = String(row?.uname ?? '').trim();
            const lastName = String(row?.lastName ?? '').trim();
            const firstName = String(row?.firstName ?? '').trim();
            const availability = String(row?.availability ?? '').trim().toLowerCase();
            if (!uname) {
                errors.push({ uname: '(empty)', error: 'Missing Username' });
                continue;
            }
            if (FALSY_AVAILABILITY.includes(availability)) {
                skipped.push(uname);
                continue;
            }
            let uid: number;
            let isNew = false;
            try {
                const udoc = await user.getByUname('system', uname);
                if (udoc) {
                    uid = udoc._id;
                } else {
                    const password = `${uname}_${lastName}_${firstName}`;
                    const mailLocal = uname.toLowerCase().replace(/[^a-z0-9._-]/g, '') || `u${Date.now()}`;
                    uid = await user.create(`${mailLocal}@bulk-import.invalid`, uname, password);
                    isNew = true;
                }
                for (const a of assignments) {
                    await domain.setUserRole(a.domainId, uid, a.role, true); // autojoin: membership + role
                }
                /*
                 * The roster's real name becomes the domain displayName —
                 * "First Last", e.g. "Leming Shen" — so the ID (22040929R)
                 * stays the login/uname while people see a human name in the
                 * nav and user cards. Written to every assigned domain PLUS
                 * 'system' (the homepage renders under 'system', and a name
                 * set only in course domains would vanish there). The roster
                 * is authoritative: re-importing updates existing users too.
                 */
                const realName = [firstName, lastName].filter(Boolean).join(' ').slice(0, 255);
                if (realName) {
                    /*
                     * The roster is AUTHORITATIVE for names, and (with the
                     * settings fields now FLAG_DISABLED) this importer is
                     * their only writer. Overwrite BOTH fields with exactly
                     * what the row says — including setting the absent half
                     * to '', so a corrected re-import clears a stale value
                     * instead of merging with it. Rows with no name at all
                     * skip this block and leave the account untouched.
                     */
                    await user.setById(uid, {
                        firstName: firstName.slice(0, 120),
                        lastName: lastName.slice(0, 120),
                    });
                    // Compatibility copy: components/user.html and rankings
                    // already render the per-domain displayName, so keep it in
                    // step wherever the student was assigned.
                    const nameDomains = new Set(['system', ...assignments.map((a) => a.domainId)]);
                    for (const dom of nameDomains) {
                        await domain.setUserInDomain(dom, uid, { displayName: realName });
                    }
                }
                (isNew ? created : existed).push(uname);
            } catch (e) {
                errors.push({ uname, error: e.message || `${e}` });
            }
        }
        logger.info(
            '[pta-ui] bulk user import by %s: %d created, %d existed, %d skipped, %d errors -> domains %s',
            this.user.uname, created.length, existed.length, skipped.length, errors.length,
            assignments.map((a) => `${a.domainId}:${a.role}`).join(', '),
        );
        this.response.body = {
            created, existed, skipped, errors,
        };
    }
}


/* ---------------------- teacher-facing AI class report ---------------------- */

const CLASS_MAX_PARTICIPANTS = 400; // hard safety ceiling
const CLASS_SINGLE_CALL_MAX = 60; // above this, the map-reduce path runs
const CLASS_BATCH_SIZE = 40;
const CLASS_MAX_PIDS = 8;
const CLASS_MAX_RECORDS = 20000;
const NONFINAL_STATUS = [0, 20, 21, 22]; // waiting / judging / compiling / fetched

/**
 * Deterministic collector: everything the LLM may cite is computed HERE.
 * `full` additionally assembles roster lines, code samples, and the harvest
 * from stored per-student AI reports (all anonymized as S-tokens).
 */
async function buildClassStats(domainId: string, tdoc: any, full: boolean, kind = 'contest') {
    const pidsAll: number[] = (tdoc.pids || []).filter((x: any) => typeof x === 'number');
    const pids = pidsAll.slice(0, CLASS_MAX_PIDS);
    // Code NEVER rides the bulk query (200+ students x attempts would be
    // hundreds of MB) — samples are re-fetched by rid afterwards.
    const proj: any = {
        uid: 1, pid: 1, status: 1, score: 1,
    };
    // Self-learning submissions carry NO contest tag, so that kind analyzes
    // every non-pretest judged submission on the session's problems.
    const recordQuery = kind === 'self-learning'
        ? { pid: { $in: pids }, contest: { $ne: record.RECORD_PRETEST } }
        : { contest: tdoc.docId, pid: { $in: pids } };
    const rdocs = await record.getMulti(domainId, recordQuery)
        .sort({ _id: 1 }).limit(CLASS_MAX_RECORDS).project(proj).toArray();
    const trails = new Map<string, { at: number, status: number, score: number, code?: string }[]>();
    const uidSet = new Set<number>();
    for (const r of rdocs as any[]) {
        if (NONFINAL_STATUS.includes(r.status)) continue;
        uidSet.add(r.uid);
        const key = `${r.uid}/${r.pid}`;
        if (!trails.has(key)) trails.set(key, []);
        trails.get(key)!.push({
            at: r._id.getTimestamp().getTime(), status: r.status, score: r.score || 0, rid: r._id,
        });
    }
    const participantsAll = [...uidSet].sort((a, b) => a - b);
    const sampled = participantsAll.length > CLASS_MAX_PARTICIPANTS
        || pidsAll.length > pids.length || (rdocs as any[]).length >= CLASS_MAX_RECORDS;
    const participants = participantsAll.slice(0, CLASS_MAX_PARTICIPANTS);
    const sOf = new Map<number, string>();
    participants.forEach((uid, i) => sOf.set(uid, `S${i + 1}`));
    const pdocs = await problem.getMulti(domainId, { docId: { $in: pids } })
        .project({ docId: 1, pid: 1, title: 1 }).toArray();
    const pLabel = new Map<number, string>();
    const pTitle = new Map<number, string>();
    for (const pd of pdocs as any[]) {
        pLabel.set(pd.docId, `P${pd.pid ?? pd.docId}`);
        pTitle.set(pd.docId, pd.title || '');
    }
    for (const pid of pids) if (!pLabel.has(pid)) pLabel.set(pid, `P${pid}`);
    const perPid: any[] = [];
    for (const pid of pids) {
        let attempted = 0;
        let solved = 0;
        let thrashers = 0;
        const verdicts: Record<string, number> = {};
        const firstFail: Record<string, number> = {};
        const attemptCounts: number[] = [];
        for (const uid of participants) {
            const t = trails.get(`${uid}/${pid}`);
            if (!t || !t.length) continue;
            attempted++;
            attemptCounts.push(t.length);
            if (t.some((x) => x.status === STATUS.STATUS_ACCEPTED)) solved++;
            const ff = t.find((x) => x.status !== STATUS.STATUS_ACCEPTED);
            if (ff) {
                const k = STATUS_TEXTS[ff.status] || `${ff.status}`;
                firstFail[k] = (firstFail[k] || 0) + 1;
            }
            for (const x of t) {
                if (x.status === STATUS.STATUS_ACCEPTED) continue;
                const k = STATUS_TEXTS[x.status] || `${x.status}`;
                verdicts[k] = (verdicts[k] || 0) + 1;
            }
            if (t.length >= 3) {
                let fast = 0;
                for (let i = 1; i < t.length; i++) if (t[i].at - t[i - 1].at < 90000) fast++;
                if (fast / (t.length - 1) >= 0.5) thrashers++;
            }
        }
        attemptCounts.sort((a, b) => a - b);
        perPid.push({
            pid,
            label: pLabel.get(pid),
            title: pTitle.get(pid),
            attempted,
            solved,
            medianAttempts: attemptCounts.length ? attemptCounts[Math.floor((attemptCounts.length - 1) / 2)] : 0,
            maxAttempts: attemptCounts[attemptCounts.length - 1] || 0,
            thrashers,
            verdicts,
            firstFail,
        });
    }
    // Self-learning bonus data: tutor-thread engagement per problem —
    // questions asked, student replies, and silently-skipped questions
    // (question shown, never answered: the fast-fix path or disengagement).
    const tutorByPid = new Map<number, { questions: number, replies: number, skipped: number, threads: number }>();
    if (kind === 'self-learning') {
        try {
            const threads = await getTutorThreadsIn(domainId, tdoc.docId, pids, participants);
            for (const th of threads as any[]) {
                if (!tutorByPid.has(th.pid)) {
                    tutorByPid.set(th.pid, {
                        questions: 0, replies: 0, skipped: 0, threads: 0,
                    });
                }
                const agg = tutorByPid.get(th.pid)!;
                agg.threads++;
                let pendingAnswered = true;
                for (const m of th.messages || []) {
                    if (m.kind !== 'anno') continue;
                    if (m.role === 'assistant' && typeof m.resolved !== 'boolean') {
                        if (!pendingAnswered) agg.skipped++;
                        agg.questions++;
                        pendingAnswered = false;
                    } else if (m.role === 'user') {
                        agg.replies++;
                        pendingAnswered = true;
                    }
                }
                if (!pendingAnswered) agg.skipped++;
            }
        } catch (e) {
            logger.warn('[pta-ui] tutor engagement stats failed: %s', e.message);
        }
    }
    const light = {
        activity: tdoc.title,
        kind,
        participants: participantsAll.length,
        records: (rdocs as any[]).length,
        sampled,
        problems: perPid.map((p) => ({
            label: p.label,
            title: p.title,
            attempted: p.attempted,
            solved: p.solved,
            medianAttempts: p.medianAttempts,
            maxAttempts: p.maxAttempts,
            thrashers: p.thrashers,
            verdicts: p.verdicts,
            firstFail: p.firstFail,
            ...(kind === 'self-learning' ? {
                tutorQuestions: tutorByPid.get(p.pid)?.questions || 0,
                tutorReplies: tutorByPid.get(p.pid)?.replies || 0,
                tutorSkipped: tutorByPid.get(p.pid)?.skipped || 0,
            } : {}),
        })),
    };
    if (!full) return { light } as any;
    const roster: string[] = [];
    for (const uid of participants) {
        const parts: string[] = [];
        for (const pid of pids) {
            const t = trails.get(`${uid}/${pid}`);
            if (!t || !t.length) continue;
            const ac = t.some((x) => x.status === STATUS.STATUS_ACCEPTED);
            const last = t[t.length - 1];
            parts.push(`${pLabel.get(pid)}:${t.length}${ac ? '(AC)' : `(${STATUS_SHORT_TEXTS[last.status] || last.status})`}`);
        }
        roster.push(`${sOf.get(uid)}: ${parts.join(' ') || '(no submissions)'}`.slice(0, 120));
    }
    // Pick sample rids first, then fetch just those codes (<= ~32 small reads).
    const picks: { rid: any, label: string, sTok: string, tag: string, cap: number }[] = [];
    for (const p of perPid) {
        const modal = (Object.entries(p.firstFail) as [string, number][]).sort((a, b) => b[1] - a[1])[0]?.[0];
        let taken = 0;
        if (modal) {
            for (const uid of participants) {
                if (taken >= 3) break;
                const t = trails.get(`${uid}/${p.pid}`);
                const hit = t?.find((x) => (STATUS_TEXTS[x.status] || `${x.status}`) === modal);
                if (hit) {
                    picks.push({
                        rid: hit.rid, label: p.label!, sTok: sOf.get(uid)!, tag: `failing sample (${sOf.get(uid)}, ${modal})`, cap: 900,
                    });
                    taken++;
                }
            }
        }
        for (const uid of participants) {
            const t = trails.get(`${uid}/${p.pid}`);
            const ac = t?.find((x) => x.status === STATUS.STATUS_ACCEPTED);
            if (ac) {
                picks.push({
                    rid: ac.rid, label: p.label!, sTok: sOf.get(uid)!, tag: `accepted sample (${sOf.get(uid)})`, cap: 1200,
                });
                break;
            }
        }
    }
    const samples: string[] = [];
    if (picks.length) {
        const codeDocs = await record.getMulti(domainId, { _id: { $in: picks.map((x) => x.rid) } })
            .project({ code: 1 }).toArray();
        const codeById = new Map((codeDocs as any[]).map((d) => [String(d._id), d.code]));
        for (const pk of picks) {
            const code = codeById.get(String(pk.rid));
            if (typeof code === 'string' && code.trim()) {
                samples.push(`--- ${pk.label} ${pk.tag} ---\n${String(code).slice(0, pk.cap)}`);
            }
        }
    }
    const harvested: string[] = [];
    try {
        const sdocs = await getSuggestionReportsIn(domainId, pids, participants);
        for (const d of sdocs as any[]) {
            const idx = String(d.report || '').toLowerCase().indexOf('critical concept');
            if (idx < 0) continue;
            const snip = String(d.report).slice(idx, idx + 340).replace(/[*_#`>]/g, ' ').replace(/\s+/g, ' ').trim();
            harvested.push(`${sOf.get(d.uid) || '(other)'} on ${pLabel.get(d.pid) || `P${d.pid}`}: ${snip}`);
            if (harvested.length >= 40) break;
        }
    } catch (e) { /* the harvest is best-effort */ }
    return {
        light, participants, sOf, perPid, roster, samples, harvested,
    } as any;
}

/** MAP-stage context: shared per-problem stats + ONE batch's student lines. */
function classBatchContext(stats: any, batchTokens: Set<string>): string {
    const L = stats.light;
    const lines: string[] = [
        `ACTIVITY TITLE: ${L.activity}`,
        `TYPE: ${L.kind}`,
        `Full-class participants: ${L.participants}. THIS BATCH: ${batchTokens.size} students.`,
        '',
        '--- Per-problem statistics (full class; read-only reference) ---',
    ];
    for (const p of stats.perPid) {
        lines.push(`${p.label} "${p.title}": attempted ${p.attempted}, solved ${p.solved}, median attempts ${p.medianAttempts}`);
    }
    lines.push('', `--- This batch's roster (${[...batchTokens][0]}..${[...batchTokens][batchTokens.size - 1]}) ---`);
    lines.push(...stats.roster.filter((r: string) => batchTokens.has(r.split(':')[0])));
    const bh = stats.harvested.filter((h: string) => batchTokens.has(h.split(' ')[0]));
    if (bh.length) lines.push('', "--- This batch's harvested critical-concept notes ---", ...bh);
    lines.push('', '--- End of batch. Emit the JSON now. ---');
    return lines.join('\n');
}

/** Tolerant parse of one map-stage JSON output. */
function parseMapOutput(raw: string, validLabels: Set<string>, batchTokens: Set<string>) {
    const cleaned = String(raw || '').replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{');
    if (start < 0) throw new Error('no JSON object');
    const parsed = JSON.parse(cleaned.slice(start, cleaned.lastIndexOf('}') + 1));
    const concepts = (Array.isArray(parsed?.concepts) ? parsed.concepts : [])
        .filter((c: any) => c && typeof c.name === 'string')
        .map((c: any) => ({
            name: String(c.name).slice(0, 60).trim(),
            problems: Object.fromEntries(Object.entries(c.problems || {})
                .filter(([k, v]) => validLabels.has(String(k)) && Number.isFinite(+(v as any)) && +(v as any) > 0)
                .map(([k, v]) => [String(k), Math.min(Math.round(+(v as any)), batchTokens.size)])),
            students: (Array.isArray(c.students) ? c.students : []).map(String).filter((t: string) => batchTokens.has(t)).slice(0, 40),
        }))
        .filter((c: any) => Object.keys(c.problems).length);
    const flags = parsed?.flags || {};
    return {
        concepts,
        intervention: (Array.isArray(flags.intervention) ? flags.intervention : [])
            .filter((f: any) => f && batchTokens.has(String(f.s)))
            .map((f: any) => ({ s: String(f.s), reason: String(f.reason || '').slice(0, 90) })).slice(0, 8),
        stretch: (Array.isArray(flags.stretch) ? flags.stretch : []).map(String).filter((t: string) => batchTokens.has(t)).slice(0, 8),
        notes: (Array.isArray(parsed?.notes) ? parsed.notes : []).map((x: any) => String(x).slice(0, 140)).slice(0, 3),
    };
}

/**
 * Extract and strip the mandatory json:concepts trailer: the prose report
 * stays clean while the structured knowledge points feed the charts.
 */
function extractConceptBlock(md: string, validLabels?: Set<string>): { report: string, concepts: any[] } {
    const m = md.match(/```json:concepts\s*\n([\s\S]*?)```/);
    if (!m) return { report: md.trim(), concepts: [] };
    const report = (md.slice(0, m.index) + md.slice((m.index as number) + m[0].length)).trim();
    let concepts: any[] = [];
    try {
        const parsed = JSON.parse(m[1]);
        if (Array.isArray(parsed?.concepts)) {
            concepts = parsed.concepts
                .filter((c: any) => c && typeof c.name === 'string')
                .slice(0, 10)
                .map((c: any) => ({
                    name: String(c.name).slice(0, 60),
                    problems: Object.fromEntries(
                        Object.entries(c.problems || {})
                            .filter(([k, v]) => Number.isFinite(+(v as any)) && +(v as any) > 0
                                && (!validLabels || validLabels.has(String(k))))
                            .map(([k, v]) => [String(k).slice(0, 16), Math.round(+(v as any))]),
                    ),
                    students: Array.isArray(c.students) ? c.students.map(String).slice(0, 100) : [],
                }))
                .filter((c: any) => !validLabels || Object.keys(c.problems).length);
        }
    } catch (e) {
        logger.warn('[pta-ui] class report concepts block unparsable: %s', e.message);
    }
    return { report, concepts };
}

function classContextBlock(stats: any, agg: any = null): string {
    const L = stats.light;
    const lines: string[] = [
        `ACTIVITY TITLE: ${L.activity}`,
        `TYPE: ${L.kind}`,
        `Participants (students with at least one judged submission): ${L.participants}${L.sampled ? ' — NOTE: the data was capped/sampled; state this in the Executive Summary.' : ''}`,
        `Total judged submissions considered: ${L.records}`,
        '',
        '--- Problems and deterministic statistics (server-computed; the ONLY numbers you may cite) ---',
    ];
    const lightByLabel = new Map((L.problems || []).map((p: any) => [p.label, p]));
    for (const p of stats.perPid) {
        const lp: any = lightByLabel.get(p.label) || {};
        const tutorBit = lp.tutorQuestions != null
            ? `, tutor questions ${lp.tutorQuestions}, student replies ${lp.tutorReplies}, silently-skipped ${lp.tutorSkipped}` : '';
        lines.push(`${p.label} "${p.title}": attempted ${p.attempted}, solved ${p.solved}, median attempts ${p.medianAttempts}, max attempts ${p.maxAttempts}, grader-thrash students ${p.thrashers}${tutorBit}`);
        lines.push(`  failing verdicts (all attempts): ${Object.entries(p.verdicts).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);
        lines.push(`  first-failure verdicts: ${Object.entries(p.firstFail).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);
    }
    if (agg) {
        lines.push('', `--- Batch analysis (per-student lines were processed in ${agg.batchCount} disjoint batches covering ALL ${L.participants} participants; concept counts below are exact sums) ---`);
        for (const c of agg.concepts) {
            const per = Object.entries(c.problems).map(([k, v]) => `${k}:${v}`).join(' ');
            lines.push(`concept "${c.name}" — total ${c.total} student(s) (${per || 'no per-problem split'}) — e.g. ${c.students.slice(0, 10).join(', ') || '-'}`);
        }
        if (agg.intervention.length) lines.push('', 'Flagged for intervention:', ...agg.intervention.map((f: any) => `- ${f.s}: ${f.reason}`));
        if (agg.stretch.length) lines.push('', `Ready for stretch material: ${agg.stretch.join(', ')}`);
        if (agg.notes.length) lines.push('', 'Batch observations:', ...agg.notes.map((x: string) => `- ${x}`));
        const flagged = new Set([...agg.intervention.map((f: any) => f.s), ...agg.stretch]);
        const flaggedLines = stats.roster.filter((r: string) => flagged.has(r.split(':')[0])).slice(0, 40);
        if (flaggedLines.length) lines.push('', '--- Roster lines of flagged students only ---', ...flaggedLines);
    } else {
        lines.push('', '--- Anonymized roster (per-problem attempt counts and final state) ---', ...stats.roster);
    }
    if (stats.harvested.length && !agg) lines.push('', '--- Harvested "critical concept" notes from per-student AI reports ---', ...stats.harvested);
    if (stats.samples.length) lines.push('', '--- Representative code excerpts (the ONLY code you may quote) ---', ...stats.samples);
    lines.push('', '--- End of context. Write the report now. ---');
    return lines.join('\n');
}

/**
 * Teacher-only class report over one contest/homework: GET serves the cached
 * report plus cheap live stats (dry=1 returns the full assembled context for
 * auditing, no LLM call); POST collects, generates, name-substitutes, and
 * stores both the anonymous and the named variants.
 */
class AiClassReportHandler extends Handler {
    async classTdoc(domainId: string, tid: ObjectId) {
        let tdoc: any = null;
        let kind = 'contest';
        try {
            tdoc = await contest.get(domainId, tid);
            kind = tdoc?.rule === 'homework' ? 'homework' : 'contest';
        } catch (e) { /* not a contest/homework — try self-learning */ }
        if (!tdoc) {
            tdoc = await SelfLearningModel.get(domainId, tid);
            kind = 'self-learning';
        }
        if (!tdoc) throw new NotFoundError(tid);
        const isTeacher = this.user.role === 'root'
            || this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)
            || tdoc.owner === this.user._id;
        if (!isTeacher) throw new ForbiddenError('Only the activity owner or a domain root can access the class report.');
        return { tdoc, kind };
    }

    @param('tid', Types.ObjectId)
    @param('dry', Types.Boolean, true)
    async get({ domainId }, tid: ObjectId, dry = false) {
        const { tdoc, kind } = await this.classTdoc(domainId, tid);
        if (dry) {
            const stats = await buildClassStats(domainId, tdoc, true, kind);
            const big = stats.participants.length > CLASS_SINGLE_CALL_MAX;
            const firstBatch = big
                ? new Set<string>(stats.participants.slice(0, CLASS_BATCH_SIZE).map((uid: number) => stats.sOf.get(uid)))
                : null;
            this.response.body = {
                mode: big ? 'map-reduce' : 'single-call',
                batchCount: big ? Math.ceil(stats.participants.length / CLASS_BATCH_SIZE) : 1,
                light: stats.light,
                roster: stats.roster,
                samplesCount: stats.samples.length,
                harvestedCount: stats.harvested.length,
                sampleBatchContext: firstBatch ? classBatchContext(stats, firstBatch) : undefined,
                context: classContextBlock(stats, null),
            };
            return;
        }
        const [doc, stats] = await Promise.all([
            getClassReport(domainId, String(tid)),
            buildClassStats(domainId, tdoc, false, kind),
        ]);
        this.response.body = {
            report: doc?.reportNamed || null,
            generatedAt: doc?.generatedAt || null,
            participants: doc?.participants ?? null,
            concepts: doc?.concepts || [],
            stats: stats.light,
        };
    }

    @param('tid', Types.ObjectId)
    async post({ domainId }, tid: ObjectId) {
        const { tdoc, kind } = await this.classTdoc(domainId, tid);
        if (!aiTutor.tutorConfigured()) throw new ForbiddenError('The AI tutor is not configured. Please ask the administrator to set an API key.');
        await this.limitRate('ai_class_report', 600, 2, '{{user}}');
        const stats = await buildClassStats(domainId, tdoc, true, kind);
        if (!stats.light.participants) throw new BadRequestError('No judged submissions yet — nothing to analyze.');
        const validLabels = new Set<string>(stats.perPid.map((p: any) => String(p.label)));
        let agg: any = null;
        if (stats.participants.length > CLASS_SINGLE_CALL_MAX) {
            // MAP stage: disjoint 40-student batches -> structured JSON, with a
            // small concurrency pool. Deterministic stats never need batching.
            const tokens: string[] = stats.participants.map((uid: number) => stats.sOf.get(uid));
            const batches: Set<string>[] = [];
            for (let i = 0; i < tokens.length; i += CLASS_BATCH_SIZE) batches.push(new Set(tokens.slice(i, i + CLASS_BATCH_SIZE)));
            const results: any[] = new Array(batches.length).fill(null);
            let cursor = 0;
            const worker = async () => {
                for (;;) {
                    const idx = cursor++;
                    if (idx >= batches.length) return;
                    try {
                        const rawMap = await aiTutor.runClassMapBatch(classBatchContext(stats, batches[idx]));
                        results[idx] = parseMapOutput(rawMap, validLabels, batches[idx]);
                    } catch (e) {
                        logger.warn('[pta-ui] class report map batch %d/%d failed: %s', idx + 1, batches.length, e.message);
                    }
                }
            };
            await Promise.all([worker(), worker(), worker()]);
            const byName = new Map<string, any>();
            const intervention: any[] = [];
            const stretch: string[] = [];
            const notes: string[] = [];
            let okBatches = 0;
            for (const r of results) {
                if (!r) continue;
                okBatches++;
                for (const c of r.concepts) {
                    const key = c.name.toLowerCase();
                    if (!byName.has(key)) {
                        byName.set(key, {
                            name: c.name, problems: {}, students: [], total: 0,
                        });
                    }
                    const m = byName.get(key);
                    for (const [k, v] of Object.entries(c.problems)) {
                        m.problems[k] = (m.problems[k] || 0) + (v as number);
                        m.total += v as number;
                    }
                    m.students.push(...c.students);
                }
                intervention.push(...r.intervention);
                stretch.push(...r.stretch);
                notes.push(...r.notes);
            }
            if (okBatches) {
                agg = {
                    batchCount: batches.length,
                    concepts: [...byName.values()].sort((a, b) => b.total - a.total).slice(0, 25),
                    intervention: intervention.slice(0, 25),
                    stretch: [...new Set(stretch)].slice(0, 25),
                    notes: notes.slice(0, 8),
                };
                if (okBatches < batches.length) {
                    agg.notes.push(`${batches.length - okBatches} batch(es) failed to analyze; their students are covered by the statistics only.`);
                }
                logger.info('[pta-ui] class report map stage: %d/%d batches ok, %d merged concept(s)', okBatches, batches.length, agg.concepts.length);
            } else {
                logger.warn('[pta-ui] class report: all map batches failed; reducing on statistics only');
            }
        }
        const raw = await aiTutor.runClassReport(classContextBlock(stats, agg));
        const { report: reportAnon, concepts: conceptsAnon } = extractConceptBlock(raw, validLabels);
        // Teacher-only artifact: substitute S-tokens with real usernames. The
        // provider only ever saw the anonymous tokens.
        let udict: any = {};
        try {
            udict = await user.getList(domainId, [...stats.sOf.keys()]);
        } catch (e) { /* fall back to uid placeholders */ }
        const sidMap = [...stats.sOf.entries()].map(([uid, sTok]) => ({
            s: sTok, uid, uname: udict[uid]?.uname || `user#${uid}`,
        }));
        const byTok = new Map(sidMap.map((e) => [e.s, e.uname]));
        const substitute = (text: string) => text.replace(/\bS(\d+)\b/g, (m) => byTok.get(m) || m);
        const reportNamed = substitute(reportAnon);
        const concepts = conceptsAnon.map((c: any) => ({
            ...c, students: (c.students || []).map((tok: string) => byTok.get(tok) || tok),
        }));
        const generatedAt = await setClassReport({
            domainId,
            tid: String(tid),
            reportAnon,
            reportNamed,
            sidMap,
            concepts,
            statsSnapshot: stats.light,
            participants: stats.light.participants,
            generatedBy: this.user._id,
        });
        this.response.body = {
            report: reportNamed, updateAt: generatedAt, stats: stats.light, concepts,
        };
        logger.info('[pta-ui] AI class report generated for %s/%s by uid=%d (%d participants)', domainId, tid, this.user._id, stats.light.participants);
    }
}


/* ---------------- subjective (project-level, teacher-graded) tasks ---------------- */

const SUBJECTIVE_MAX_FILE = 25 * 1024 * 1024; // 25 MB per file
const SUBJECTIVE_MAX_FILES = 10;
const SUBJECTIVE_MAX_REPORT = 65536;

function isSubjectivePdoc(pdoc: any) {
    return /^s/i.test(String(pdoc?.pid || ''));
}

function subjectiveTeacher(h: any, pdoc: any) {
    return h.user.role === 'root' || h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM) || pdoc.owner === h.user._id;
}

const cleanFileName = (name: string) => String(name || '').replace(/.*[\\/]/, '').replace(/[^\w.() \-\u4e00-\u9fff]+/g, '_').slice(0, 120) || 'file';

/**
 * Subjective project tasks (pid starts with S): students upload files and
 * write a markdown report; teachers (problem owner or domain root) list all
 * submissions and read/download them. Nothing here touches the judge.
 */
class SubjectiveTaskHandler extends Handler {
    pdoc: any;

    /** Canonical numeric problem id: URLs may carry the display pid (e.g. "S1000"). */
    get npid(): number {
        return this.pdoc.docId;
    }

    @param('pid', Types.ProblemId)
    async prepare({ domainId }, pid: number | string) {
        this.pdoc = await problem.get(domainId, pid);
        if (!this.pdoc) throw new NotFoundError(pid);
        if (!isSubjectivePdoc(this.pdoc)) throw new BadRequestError('This problem is not a subjective task.');
    }

    @param('uid', Types.PositiveInt, true)
    @param('list', Types.Boolean, true)
    async get({ domainId }, uid?: number, list = false) {
        const pid = this.npid;
        const teacher = subjectiveTeacher(this, this.pdoc);
        if (list) {
            if (!teacher) throw new ForbiddenError('Only the problem owner or a domain root can list submissions.');
            const docs = await listSubjective(domainId, pid);
            let udict: any = {};
            try {
                udict = await user.getList(domainId, docs.map((d) => d.uid));
            } catch (e) { /* uname fallback below */ }
            this.response.body = {
                submissions: docs.map((d) => ({
                    uid: d.uid,
                    uname: udict[d.uid]?.uname || `user#${d.uid}`,
                    files: (d.files || []).length,
                    hasReport: !!(d.report || '').trim(),
                    updateAt: d.updateAt,
                })),
            };
            return;
        }
        const targetUid = (uid && uid !== this.user._id) ? uid : this.user._id;
        if (targetUid !== this.user._id && !teacher) throw new ForbiddenError('Not your submission.');
        const doc = await getSubjective(domainId, pid, targetUid);
        this.response.body = {
            report: doc?.report || '',
            files: (doc?.files || []).map((f) => ({ name: f.name, size: f.size, uploadAt: f.uploadAt })),
            updateAt: doc?.updateAt || null,
            teacher,
        };
    }

    /**
     * Hydro dispatches POSTs that carry an `operation` field to
     * post{Operation} and throws InvalidOperationError (whose inherited
     * message reads "MethodNotAllowedError") when that method is missing —
     * a generic post() is never consulted for such requests. So each
     * client operation gets its own method here.
     */
    async postReport({ domainId }) {
        const report = String(this.args.report || '').slice(0, SUBJECTIVE_MAX_REPORT);
        const updateAt = await setSubjectiveReport(domainId, this.npid, this.user._id, report);
        this.response.body = { updateAt };
    }

    async postUpload({ domainId }) {
        const pid = this.npid;
        const file = this.request.files?.file;
        if (!file || !file.size) throw new BadRequestError('No file received.');
        if (file.size > SUBJECTIVE_MAX_FILE) throw new BadRequestError('The file exceeds the 25 MB limit.');
        const doc = await getSubjective(domainId, pid, this.user._id);
        const name = cleanFileName(file.originalFilename || file.newFilename || 'file');
        const existing = (doc?.files || []).filter((f) => f.name !== name);
        if (existing.length >= SUBJECTIVE_MAX_FILES) throw new BadRequestError(`At most ${SUBJECTIVE_MAX_FILES} files.`);
        const target = `subjective/${domainId}/${pid}/${this.user._id}/${name}`;
        await storage.put(target, file.filepath, this.user._id);
        await upsertSubjectiveFile(domainId, pid, this.user._id, {
            name, size: file.size, target, uploadAt: new Date(),
        });
        const fresh = await getSubjective(domainId, pid, this.user._id);
        this.response.body = { files: (fresh?.files || []).map((f) => ({ name: f.name, size: f.size, uploadAt: f.uploadAt })) };
        logger.info('[pta-ui] subjective upload: uid=%d pid=%d "%s" (%d bytes)', this.user._id, pid, name, file.size);
    }

    async postDelete({ domainId }) {
        const pid = this.npid;
        const name = cleanFileName(this.args.name);
        const doc = await getSubjective(domainId, pid, this.user._id);
        const entry = (doc?.files || []).find((f) => f.name === name);
        if (entry) {
            try {
                await storage.del([entry.target]);
            } catch (e) { /* the entry removal below is authoritative */ }
            await removeSubjectiveFile(domainId, pid, this.user._id, name);
        }
        const fresh = await getSubjective(domainId, pid, this.user._id);
        this.response.body = { files: (fresh?.files || []).map((f) => ({ name: f.name, size: f.size, uploadAt: f.uploadAt })) };
    }
}

/** Download one submitted file (own, or any as teacher) via a signed link. */
class SubjectiveFileHandler extends Handler {
    @param('pid', Types.ProblemId)
    @param('name', Types.String)
    @param('uid', Types.PositiveInt, true)
    async get({ domainId }, pid: number | string, name: string, uid?: number) {
        const pdoc = await problem.get(domainId, pid);
        if (!pdoc) throw new NotFoundError(pid);
        if (!isSubjectivePdoc(pdoc)) throw new BadRequestError('This problem is not a subjective task.');
        const targetUid = (uid && uid !== this.user._id) ? uid : this.user._id;
        if (targetUid !== this.user._id && !subjectiveTeacher(this, pdoc)) throw new ForbiddenError('Not your submission.');
        const doc = await getSubjective(domainId, pdoc.docId, targetUid);
        const entry = (doc?.files || []).find((f) => f.name === cleanFileName(name));
        if (!entry) throw new NotFoundError(name);
        this.response.redirect = await storage.signDownloadLink(entry.target, entry.name, false);
    }
}


/* ------------------------------------------------------------------ */
/*  Combined objective paper for a test / homework                     */
/* ------------------------------------------------------------------ */
/**
 * One page holding EVERY objective task of a contest ("Test") or homework,
 * in problem order — the one-question-per-task model makes each section a
 * single question, so the page reads like a paper. The sidebar lists the
 * tasks and anchors into the page; answering and submitting stays strictly
 * per-problem underneath (one record per task, exactly as if each problem
 * page had been used), so scoreboards, records and rejudging all behave
 * identically to individual submission.
 *
 * Extends ContestDetailBaseHandler: tdoc/tsdoc loading and the group-assign
 * check are inherited, and the same class serves homework because both
 * live in TYPE_CONTEST.
 */
class ObjectivePaperHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const tdoc = this.tdoc!;
        const canManage = this.user.own(tdoc) || this.user.hasPerm(PERM.PERM_EDIT_CONTEST) || this.user.role === 'root';
        if (!canManage) {
            if (contest.isNotStarted(tdoc)) throw new ContestNotLiveError(domainId, tid);
            if (!this.tsdoc?.attend) throw new ContestNotAttendedError(domainId, tid);
        }
        const isHomework = tdoc.rule === 'homework';
        // Verdicts for objective tasks are withheld until the container
        // ends (contest.applyProjection masks the records); tell the paper
        // so it neither polls for results nor pre-colors chips from the
        // student's global problem status — either would leak.
        const resultsWithheld = !canManage && !contest.isDone(tdoc, this.tsdoc);
        await respondObjectivePaper(this, domainId, {
            resultsWithheld,
            heading: tdoc.title,
            backUrl: this.url(isHomework ? 'homework_detail' : 'contest_detail', { tid }),
            pageName: isHomework ? 'homework_paper' : 'contest_paper',
            storeKey: tid.toHexString(),
            docIds: tdoc.pids || [],
            // ?tid keeps each record inside the contest, exactly as the
            // single-problem page would.
            submitUrlFor: (docId) => this.url('problem_submit', { pid: docId, query: { tid: tid.toHexString() } }),
            chipHrefFor: (pdoc) => this.url('problem_detail', { pid: pdoc.docId, query: { tid: tid.toHexString() } }),
        });
    }
}

/** And from a self-learning session's problem list. */
class SelfLearningPaperHandler extends Handler {
    @param('ssid', Types.ObjectId)
    async get({ domainId }, ssid: ObjectId) {
        const sdoc = await loadSession(domainId, ssid);
        await respondObjectivePaper(this, domainId, {
            heading: sdoc.title,
            backUrl: this.url('self_learning_detail', { ssid }),
            pageName: 'self_learning_paper',
            storeKey: ssid.toHexString(),
            docIds: sdoc.pids || [],
            submitUrlFor: (docId) => this.url('problem_submit', { pid: docId }),
            chipHrefFor: (pdoc) => this.url('self_learning_solve', { ssid, pid: pdoc.docId }),
        });
    }
}

/**
 * Shared renderer: the four containers differ only in where the problem
 * list comes from, how records should be tagged, and where Back leads.
 * Everything else — objective filtering by the O pid prefix, section
 * assembly, UiContext for the page script — is identical by construction.
 */
async function respondObjectivePaper(h: Handler, domainId: string, opts: {
    heading: string, backUrl: string, pageName: string, storeKey: string,
    docIds: number[], submitUrlFor: (docId: number) => string,
    chipHrefFor: (pdoc: any) => string,
    resultsWithheld?: boolean,
}) {
    const pdocs = (await Promise.all((opts.docIds || []).map((docId) => problem.get(domainId, docId))))
        .filter((x) => x);
    const objective = pdocs.filter((pdoc) => /^o/i.test(String(pdoc.pid || '')));
    const tasks = objective.map((pdoc, k) => ({
        docId: pdoc.docId,
        pid: pdoc.pid,
        index: k + 1,
        title: pdoc.title,
        submitUrl: opts.submitUrlFor(pdoc.docId),
        content: pdoc.content,
    }));
    h.response.template = 'objective_paper.html';
    h.response.body = {
        heading: opts.heading,
        backUrl: opts.backUrl,
        tasks,
        othersCount: pdocs.length - objective.length,
        page_name: opts.pageName,
    };
    h.UiContext.paperTasks = tasks.map(({ content, ...t }) => t);
    h.UiContext.paperKey = opts.storeKey;
    h.UiContext.paperWithheld = !!opts.resultsWithheld;
    /*
     * The fixed-left problems rail (auto_scratchpad's sl-rail) replaces the
     * paper's own sidebar: every task of the container, all kinds, with the
     * student's solve status. Objective chips anchor into the paper; other
     * kinds carry the container context out to their own pages, so nobody
     * has to hop back to the detail page to move around.
     */
    const psdict = await problem.getListStatus(domainId, (h as any).user._id, pdocs.map((p) => p.docId));
    h.UiContext.paperRail = {
        items: pdocs.map((pdoc) => {
            const pidStr = String(pdoc.pid || '');
            const kind = /^o/i.test(pidStr) ? 'objective' : (/^s/i.test(pidStr) ? 'subjective' : 'programming');
            return {
                pid: pdoc.pid || pdoc.docId,
                kind,
                // While results are withheld, objective chips stay neutral:
                // the global problem status would reveal exactly what the
                // record mask is hiding.
                status: (opts.resultsWithheld && kind === 'objective') ? 0 : (psdict[pdoc.docId]?.status || 0),
                title: pdoc.title,
                href: kind === 'objective' ? `#q-${pdoc.docId}` : opts.chipHrefFor(pdoc),
            };
        }),
    };
}

export async function apply(ctx: Context) {
    ctx.Route('self_learning', '/self-learning', SelfLearningMainHandler);
    ctx.Route('self_learning_create', '/self-learning/create', SelfLearningEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('self_learning_detail', '/self-learning/:ssid', SelfLearningDetailHandler);
    ctx.Route('self_learning_edit', '/self-learning/:ssid/edit', SelfLearningEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('self_learning_solve', '/self-learning/:ssid/p/:pid', SelfLearningSolveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('self_learning_record', '/self-learning/:ssid/p/:pid/record', SelfLearningRecordHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('self_learning_tutor', '/self-learning/:ssid/p/:pid/tutor', SelfLearningTutorHandler, PRIV.PRIV_USER_PROFILE);

    // ---- Site-wide PTA UI backend (migrated from problem_trajectory.ts) ----
    ctx.Route('problem_trajectory', '/p/:pid/trajectory', ProblemTrajectoryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('activity_problem_kinds', '/activity/:tid/problem-kinds', ActivityProblemKindsHandler, PRIV.PRIV_USER_PROFILE);
    // Root-only bulk user import behind the homepage "Add Users" button.
    ctx.Route('bulk_add_users', '/bulk-add-users', BulkAddUsersHandler, PRIV.PRIV_EDIT_SYSTEM);
    // Post-acceptance AI report behind the result modal's "AI Suggestions" button.
    ctx.Route('ai_suggestions', '/p/:pid/ai-suggestions', AiSuggestionsHandler, PRIV.PRIV_USER_PROFILE);
    // Teacher-only class report behind the contest/homework page button.
    ctx.Route('ai_class_report', '/activity/:tid/ai-class-report', AiClassReportHandler, PRIV.PRIV_USER_PROFILE);
    // Subjective (project-level) tasks: submissions + file downloads.
    ctx.Route('subjective_task', '/p/:pid/subjective', SubjectiveTaskHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('subjective_task_file', '/p/:pid/subjective/file', SubjectiveFileHandler, PRIV.PRIV_USER_PROFILE);
    // AI Studio (teacher problem authoring). Registered HERE, not in
    // ai_author.ts: new handler files are only discovered at boot and the
    // HMR watcher cannot see them, so their routes would 404 until a cold
    // restart. self_learning.ts is always loaded and hot-reloads.
    ctx.Route('contest_paper', '/contest/:tid/paper', ObjectivePaperHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('homework_paper', '/homework/:tid/paper', ObjectivePaperHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('self_learning_paper', '/self-learning/:ssid/paper', SelfLearningPaperHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ai_studio', '/ai-studio', AiStudioHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ai_studio_detail', '/ai-studio/:id', AiStudioDetailHandler, PRIV.PRIV_USER_PROFILE);
    registerAiStudioTemplates(ctx); // template registry survives hot-reload; no cold restart needed
    const setKinds = async (h: any, source: string) => {
        if (!h?.UiContext || h.UiContext.tdocKinds || h.UiContext.trainingRail || h.UiContext.psetRail) return;
        let tdoc = h.tdoc || h.response?.body?.tdoc;
        if (!tdoc && h.args?.tid) tdoc = await contest.get(h.args.domainId, h.args.tid).catch(() => null);
        if (tdoc && Array.isArray(tdoc.pids) && tdoc.pids.length > 1) {
            try {
                h.UiContext.tdocKinds = await activityKinds(h.args.domainId, tdoc.pids, h.user?._id);
                logger.info('[pta-ui] rail kinds injected via %s: %d problem(s) for tid=%s', source, tdoc.pids.length, tdoc.docId);
            } catch (e) {
                logger.warn('[pta-ui] rail kinds failed via %s: %s', source, e.message);
            }
            return;
        }
        // (Training removed for this deployment: the ?trid rail decorator
        // that lived here went with it.)
        // Problem set: plain problem pages (no contest tid) get the same left
        // sidebar — a window of the problem list around the current problem,
        // in docId order, honoring hidden-problem visibility.
        if (h.args?.tid) return;
        try {
            const cur = h.pdoc?.docId ?? h.response?.body?.pdoc?.docId;
            if (typeof cur !== 'number') return;
            const canViewHidden = h.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN);
            const vis: any = canViewHidden ? {} : { hidden: false };
            const [before, after] = await Promise.all([
                problem.getMulti(h.args.domainId, { ...vis, docId: { $lt: cur } })
                    .sort({ docId: -1 }).limit(12).project({ docId: 1 }).toArray(),
                problem.getMulti(h.args.domainId, { ...vis, docId: { $gte: cur } })
                    .sort({ docId: 1 }).limit(13).project({ docId: 1 }).toArray(),
            ]);
            const pids = [...before.reverse(), ...after].map((p: any) => p.docId);
            if (pids.length < 2) return;
            h.UiContext.psetRail = { kinds: await activityKinds(h.args.domainId, pids, h.user?._id) };
            logger.info('[pta-ui] rail kinds injected via %s (problem set): %d problem(s) around #%d', source, pids.length, cur);
        } catch (e) {
            logger.warn('[pta-ui] problem-set rail kinds failed via %s: %s', source, e.message);
        }
    };
    // ProblemDetailHandler serves problem_detail, contest_detail_problem AND
    // homework_detail_problem (page_name is just switched on tdoc.rule), so
    // one class-named hook covers all three surfaces.
    ctx.on('handler/after/ProblemDetail#get' as any, (h: any) => setKinds(h, 'ProblemDetail#get'));
    // Safety net: the generic handler/after fires for every request; the
    // template guard makes it a no-op elsewhere, and the tdocKinds check
    // dedupes when both hooks run.
    ctx.on('handler/after' as any, (h: any) => {
        if (!String(h?.response?.template || '').startsWith('problem_detail')) return null;
        return setKinds(h, 'generic-after');
    });
    // Core's ProblemSubmitHandler deliberately omits the rid for contest and
    // homework submissions when the activity hides self-records
    // (canShowSelfRecord is false): body is { tid } and the redirect points
    // at the activity page, not /record/:rid. This site's requirement is a
    // result modal on EVERY surface, so restore the rid for JSON callers —
    // the record was just created by this very request, so the newest
    // non-pretest record of this user on this problem is it.
    ctx.on('handler/after/ProblemSubmit#post' as any, async (h: any) => {
        try {
            if (!h?.response?.body || h.response.body.rid) return;
            const latest = await record.getMulti(h.args.domainId, {
                pid: h.pdoc.docId, uid: h.user._id, contest: { $ne: record.RECORD_PRETEST },
            }).sort({ _id: -1 }).limit(1).project({ _id: 1 }).toArray();
            if (!latest[0]) return;
            h.response.body.rid = latest[0]._id.toHexString();
            logger.info('[pta-ui] rid restored on submit response (self-record-hidden activity): %s', h.response.body.rid);
        } catch (e) {
            logger.warn('[pta-ui] rid restore failed: %s', e.message);
        }
    });
    // Nav domain dropdown: the stock list renders handler.user.domains, a
    // denormalized udoc field that misses memberships granted via
    // setUserRole (e.g. our bulk user import) and goes stale. On every HTML
    // page render, replace it with the user's TRUE membership — current
    // domain first, then by display name — so hovering the domain menu
    // (dropdowns open on hover by default) lists every domain the user is
    // in, each linking to that domain's homepage ("visit").
    ctx.on('handler/after' as any, async (h: any) => {
        try {
            if (!h?.response?.template) return; // JSON/API responses render no nav
            // Problem authors keep the ORIGINAL problem page: the client skips
            // the scratchpad auto-enter for domain roots and super-admins.
            if (h.UiContext) {
                h.UiContext.isDomainRoot = h.user?.role === 'root' || !!h.user?.hasPriv?.(PRIV.PRIV_EDIT_SYSTEM);
            }
            if (!h.user?.hasPriv?.(PRIV.PRIV_USER_PROFILE)) return;
            const dudict = await domain.getDictUserByDomainId(h.user._id);
            const dids = Object.keys(dudict);
            if (!dids.length) return;
            const ddocs = await domain.getMulti({ _id: { $in: dids } }).toArray();
            const cur = h.args?.domainId;
            const label = (d: any) => String(d.name || d._id).toLowerCase();
            ddocs.sort((a: any, b: any) => {
                if (a._id === cur) return -1;
                if (b._id === cur) return 1;
                return label(a) < label(b) ? -1 : 1;
            });
            h.user.domains = ddocs.slice(0, 30);
        } catch (e) { /* the nav falls back to the stock list */ }
    });
    logger.info('[pta-ui] trajectory + activity-kinds routes, ProblemDetail rail hooks, and nav-domains hook registered (via self_learning.ts)');

    // Self-healing guard for /manage/config: if the stored config source
    // (system collection, _id 'config') is not valid YAML, the built-in
    // config editor crashes in the browser before it can render, and the
    // save path throws too, so the corruption cannot be fixed from the UI.
    // When root opens the page, repair the document and serve a clean value.
    ctx.on('handler/after/SystemConfig#get' as any, async (h: any) => {
        const value = h?.response?.body?.value;
        try {
            if (typeof value === 'string') yamlLoad(value);
            return;
        } catch (e) { /* fall through to repair */ }
        logger.warn('Corrupted system config source detected; resetting to an empty document.');
        try {
            await h.ctx.setting.saveConfig({});
        } catch (e) {
            try {
                await h.ctx.db.collection('system').updateOne({ _id: 'config' }, { $set: { value: '{}' } }, { upsert: true });
                await h.ctx.setting.loadConfig();
            } catch (err) {
                logger.error('Failed to repair the system config source: %s', err.message);
            }
        }
        h.response.body.value = '{}\n';
    });
    // ---- Privacy self-heal: personal submission history & ranking ----
    // The 'default' role of PRE-EXISTING domains was minted when PERM_DEFAULT
    // still contained PERM_VIEW_RECORD, so students there can browse the whole
    // class's submissions. New domains no longer grant it (see
    // @hydrooj/common/permission.ts); this one-time boot sweep strips the bit
    // from the two builtin role names in every existing domain too. Custom
    // roles (teacher / TA / ...) are deliberately untouched — granting "View
    // other's records" to a role is the supported way to give course staff
    // full record and ranking visibility.
    if (!(global as any).__ptaRecordPrivacySweepDone) {
        (global as any).__ptaRecordPrivacySweepDone = true;
        setTimeout(async () => {
            try {
                const ddocs = await domain.getMulti().project({ _id: 1, roles: 1 }).toArray();
                let fixed = 0;
                for (const ddoc of ddocs) {
                    const patch: Record<string, bigint> = {};
                    for (const role of ['default', 'guest']) {
                        const cur = (ddoc as any).roles?.[role];
                        if (cur === undefined) continue;
                        const perm = BigInt(cur);
                        if (perm & PERM.PERM_VIEW_RECORD) patch[role] = perm & ~PERM.PERM_VIEW_RECORD;
                    }
                    if (Object.keys(patch).length) {
                        // eslint-disable-next-line no-await-in-loop
                        await domain.setRoles((ddoc as any)._id, patch);
                        fixed += 1;
                    }
                }
                if (fixed) logger.info('[pta-ui] record privacy: removed "View other\'s records" from builtin roles in %d domain(s)', fixed);
            } catch (e) {
                logger.warn('[pta-ui] record privacy sweep failed: %s', e.message);
            }
        }, 3000);
    }
    await SelfLearningModel.apply();
}

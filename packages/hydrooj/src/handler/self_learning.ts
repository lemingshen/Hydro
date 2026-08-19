import { load as yamlLoad } from 'js-yaml';
import { ObjectId } from 'mongodb';
import { STATUS, STATUS_SHORT_TEXTS, STATUS_TEXTS } from '@hydrooj/common';
import { Context } from '../context';
import { Logger } from '../logger';
import {
    BadRequestError, ForbiddenError, NotFoundError, PermissionError,
    ProblemConfigError, ProblemNotAllowLanguageError, ValidationError,
} from '../error';
import type { ProblemDoc, RecordDoc } from '../interface';
import * as aiTutor from '../lib/ai_tutor';
import { PERM, PRIV } from '../model/builtin';
import * as contest from '../model/contest';
import domain from '../model/domain';
import problem from '../model/problem';
import record from '../model/record';
import SelfLearningModel, { SelfLearningDoc, TutorMessage, TutorThreadDoc } from '../model/selflearning';
import * as setting from '../model/setting';
import system from '../model/system';
import * as training from '../model/training';
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
        this.response.template = 'self_learning_detail.html';
        this.response.body = {
            sdoc,
            pdict,
            psdict,
            udict,
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
        this.response.body = {
            messages: (thread?.messages || []).map(SelfLearningTutorHandler.mapMsg),
            attemptCount: thread?.attemptCount || 0,
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
            this.response.body = { messages: thread.messages.map(SelfLearningTutorHandler.mapMsg) };
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
        this.response.body = { messages: messages.map((m: any) => SelfLearningTutorHandler.mapMsg(m)) };
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
        this.response.body = { annotation, marker, markerAccepted: accepted };
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
        this.response.body = result;
    }

    @param('text', Types.String)
    async postMessage({ domainId }, text: string) {
        this.checkTutorAllowed();
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
            // the read-only history shows the milestone.
            const { marker } = await this.ensureAttemptMarker(domainId, rdoc);
            this.response.body = { reply: null, marker, markerAccepted: true };
            return;
        }
        const thread = await SelfLearningModel.getThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        if (!thread || !thread.messages.length) {
            this.response.body = { reply: null };
            return;
        }
        const marker: Omit<TutorMessage, 'at'> = { role: 'user', kind: 'accepted', content: 'My new submission was ACCEPTED!' };
        const ctx = await this.tutorCtx(rdoc, thread.attemptCount || 1, true);
        const reply = await aiTutor.runTutorTurn(ctx, [...thread.messages, { ...marker, at: new Date() }], aiTutor.ACCEPTED_DIRECTIVE);
        await SelfLearningModel.pushMessages(thread._id, [marker, { role: 'assistant', kind: 'chat', content: reply }], { rid });
        this.response.body = { reply };
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
async function activityKinds(domainId: string, pids: number[]) {
    const pdict = await problem.getList(domainId, pids, true, false, ['docId', 'title', 'config'], true);
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
        return { pid, kind: aiTutor.problemKindOf(conf), title: p.title || String(pid) };
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
        this.response.body = { pids: await activityKinds(domainId, tdoc.pids || []) };
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
        this.response.body = { report };
        logger.info('[pta-ui] AI Suggestions generated for uid=%d pid=%d over %d attempt(s)', this.user._id, pid, attempts.length);
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
    const setKinds = async (h: any, source: string) => {
        if (!h?.UiContext || h.UiContext.tdocKinds || h.UiContext.trainingRail || h.UiContext.psetRail) return;
        let tdoc = h.tdoc || h.response?.body?.tdoc;
        if (!tdoc && h.args?.tid) tdoc = await contest.get(h.args.domainId, h.args.tid).catch(() => null);
        if (tdoc && Array.isArray(tdoc.pids) && tdoc.pids.length > 1) {
            try {
                h.UiContext.tdocKinds = await activityKinds(h.args.domainId, tdoc.pids);
                logger.info('[pta-ui] rail kinds injected via %s: %d problem(s) for tid=%s', source, tdoc.pids.length, tdoc.docId);
            } catch (e) {
                logger.warn('[pta-ui] rail kinds failed via %s: %s', source, e.message);
            }
            return;
        }
        // Training context: its problems link to the plain problem page, so
        // the frontend carries the training id along as ?trid=... — resolve
        // the training's DAG into a flat, ordered problem list here.
        const trid = h.args?.trid;
        if (trid && /^[0-9a-f]{24}$/i.test(String(trid))) {
            try {
                const ttdoc = await training.get(h.args.domainId, new ObjectId(String(trid)));
                const pids: number[] = ttdoc ? training.getPids(ttdoc.dag || []) : [];
                if (pids.length >= 2) {
                    h.UiContext.trainingRail = {
                        trid: String(trid),
                        title: ttdoc.title || '',
                        kinds: await activityKinds(h.args.domainId, pids),
                    };
                    logger.info('[pta-ui] rail kinds injected via %s (training): %d problem(s) for trid=%s', source, pids.length, trid);
                    return;
                }
            } catch (e) {
                logger.warn('[pta-ui] training rail kinds failed via %s: %s', source, e.message);
            }
        }
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
            h.UiContext.psetRail = { kinds: await activityKinds(h.args.domainId, pids) };
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
    await SelfLearningModel.apply();
}

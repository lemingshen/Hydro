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
import domain from '../model/domain';
import problem from '../model/problem';
import record from '../model/record';
import SelfLearningModel, { SelfLearningDoc, TutorMessage } from '../model/selflearning';
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
}

class SelfLearningSolveHandler extends SelfLearningProblemBaseHandler {
    async get() {
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
    @param('rid', Types.ObjectId)
    @param('full', Types.Boolean)
    async get({ domainId }, rid: ObjectId, full = false) {
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
            compilerTexts: (rdoc.compilerTexts || []).join('\n').slice(0, 4000),
            judgeTexts: (rdoc.judgeTexts || [])
                .map((t: any) => (typeof t === 'string' ? t : t?.message || ''))
                .filter((t: string) => t).join('\n').slice(0, 2000),
            cases: (rdoc.testCases || []).slice(0, 60).map((c: any) => ({
                id: c.id,
                subtaskId: c.subtaskId,
                status: c.status,
                statusText: STATUS_SHORT_TEXTS[c.status] || STATUS_TEXTS[c.status] || `${c.status}`,
                message: (typeof c.message === 'string' ? c.message : (c.message?.message || '')).slice(0, 200),
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
            const history = await record.getMulti(domainId, { pid: this.pdoc.docId, uid: rdoc.uid })
                .sort({ _id: -1 }).limit(10)
                .project({ code: 1, lang: 1, status: 1, score: 1 })
                .toArray();
            this.response.body.attempts = history.reverse().map((r: any) => ({
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
        return {
            pdoc: this.pdoc,
            rdoc,
            attemptCount,
            everAccepted,
            uiLang,
            problemKind,
            objective,
        };
    }

    async everAccepted(domainId: string) {
        const psdoc = await problem.getStatus(domainId, this.pdoc.docId, this.user._id);
        return psdoc?.status === STATUS.STATUS_ACCEPTED;
    }

    async get() {
        this.checkTutorAllowed();
        const thread = await SelfLearningModel.getThread(this.args.domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        this.response.body = {
            messages: (thread?.messages || []).map((m) => ({ role: m.role, kind: m.kind, content: m.content })),
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
            this.response.body = { messages: thread.messages.map((m) => ({ role: m.role, kind: m.kind, content: m.content })) };
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
        this.response.body = { messages: messages.map((m: any) => ({ role: m.role, kind: m.kind, content: m.content })) };
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
            if (Array.isArray(parsed)) askedList = parsed.map((q) => String(q)).slice(0, 8);
        } catch (e) { /* ignore malformed asked lists */ }
        const rdoc = await this.loadOwnRecord(domainId, rid);
        const thread = await SelfLearningModel.getThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        const ctx = await this.tutorCtx(rdoc, thread?.attemptCount || 1, await this.everAccepted(domainId));
        this.response.body = { annotation: await aiTutor.runAnnotationTurn(ctx, askedList) };
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
        const thread = await SelfLearningModel.getThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        const ctx = await this.tutorCtx(rdoc, thread?.attemptCount || 1, await this.everAccepted(domainId));
        this.response.body = await aiTutor.runAnnotationDialogue(ctx, {
            line,
            endLine,
            question: question.slice(0, 300),
            history: turns,
            answer: text.slice(0, 1000),
        });
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

export async function apply(ctx: Context) {
    ctx.Route('self_learning', '/self-learning', SelfLearningMainHandler);
    ctx.Route('self_learning_create', '/self-learning/create', SelfLearningEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('self_learning_detail', '/self-learning/:ssid', SelfLearningDetailHandler);
    ctx.Route('self_learning_edit', '/self-learning/:ssid/edit', SelfLearningEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('self_learning_solve', '/self-learning/:ssid/p/:pid', SelfLearningSolveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('self_learning_record', '/self-learning/:ssid/p/:pid/record', SelfLearningRecordHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('self_learning_tutor', '/self-learning/:ssid/p/:pid/tutor', SelfLearningTutorHandler, PRIV.PRIV_USER_PROFILE);

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

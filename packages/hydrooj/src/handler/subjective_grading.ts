/* eslint-disable max-len */
/**
 * PTA fork — AI-GRADED REPORT TASKS: the teacher's review page and the
 * student's grade endpoints.
 *
 *  GET  /homework/:tid/subjective/:pid          the review page (HTML), or —
 *       for the page's own XHR — its JSON: every student of the homework
 *       with their PDF and the state of their AI grade, the rubric, the
 *       running job. `?uid=N` returns one student's full grade (criteria,
 *       comments, summary) and submission.
 *  POST /homework/:tid/subjective/:pid          operation =
 *       grade (force?)      start grading every ungraded / changed PDF
 *       regrade (uid)       grade one student again from scratch
 *       status              the job + counts (the page polls this)
 *       release (uid?)      show the grade(s) to the student(s) — they enter
 *                           the scoreboard at that moment
 *       unrelease (uid?)    withdraw
 *       adjust (uid, points, note)   the teacher's points per criterion + note
 *       clearAdjust (uid)   back to the AI's points
 *       evaluate            EVALUATE THE HOMEWORK (manual-evaluation
 *                           homeworks: the deadline does not evaluate a
 *                           homework that contains a subjective task —
 *                           this does: objective grading, statuses,
 *                           results published to students, and the AI
 *                           report grading started)
 *  GET  /p/:pid/subjective/grade?uid=           a student's released grade
 *       (own), any grade for the task's teacher
 *  GET  /p/:pid/subjective/annotated?uid=&inline=1   the annotated PDF (own
 *       once released; any for the teacher)
 *  GET  /subjective/rubrics                     the domain's rubrics, for the
 *       builder's "Copy from another task" (teachers)
 *
 * Grading itself lives in lib/subjective_grader.ts; the scores reach the
 * homework scoreboard through model/contest.ts seedSubjectiveScores.
 * Routes are registered through registerSubjectiveGradingRoutes(), called
 * from apply() here AND from handler/self_learning.ts, so a dev watcher
 * that never discovered this file still serves them (global flag = once).
 */
import fs from 'fs';
import path from 'path';
import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { BadRequestError, ForbiddenError, NotFoundError, PermissionError, ValidationError } from '../error';
import { pdfjsAvailable } from '../lib/pdf_text';
import {
    autoGradeEnabled, autoReleaseEnabled, gradingEnabled, pdfFileOf, setGradesReleased, startGradingJob, studentGradeView, subjectiveConfigOfPdoc, teacherGradeView,
} from '../lib/subjective_grader';
import { rubricHash } from '../lib/subjective_rubric';
import { Logger } from '../logger';
import { PERM, PRIV } from '../model/builtin';
import * as contest from '../model/contest';
import problem from '../model/problem';
import { getSubjective, listSubjective } from '../model/selflearning';
import storage from '../model/storage';
import * as GradeModel from '../model/subjective_grade';
import user from '../model/user';
import { Handler, param, Types } from '../service/server';
import { ensureManualEvalFlag, evaluateContainerResults } from './contest';

const logger = new Logger('subjective-grading');

const isSubjectivePdoc = (pdoc: any) => /^s/i.test(String(pdoc?.pid || ''));

/** The task's teacher: the problem owner, a domain root, or anyone who may edit homework. */
function taskTeacher(h: any, pdoc: any): boolean {
    return h.user.role === 'root' || h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM) || pdoc.owner === h.user._id || h.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
}

const round1 = (x: number) => Math.round(x * 10) / 10;

class HomeworkSubjectiveReviewHandler extends Handler {
    tdoc: any;
    pdoc: any;

    @param('tid', Types.ObjectId)
    @param('pid', Types.ProblemId)
    async prepare({ domainId }, tid: ObjectId, pid: number | string) {
        this.tdoc = await contest.get(domainId, tid);
        if (!this.tdoc || this.tdoc.rule !== 'homework') throw new NotFoundError(tid);
        if (!this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)) throw new PermissionError(PERM.PERM_EDIT_HOMEWORK);
        this.pdoc = await problem.get(domainId, pid);
        if (!this.pdoc || !this.tdoc.pids.includes(this.pdoc.docId)) throw new NotFoundError(pid);
        if (!isSubjectivePdoc(this.pdoc)) throw new BadRequestError('This task is not a subjective task.');
        await ensureManualEvalFlag(domainId, this.tdoc);
        // One URL, two representations (HTML for the browser, JSON for the
        // page's XHR): keep a cache from replaying the JSON on Back/Forward.
        this.response.addHeader('Vary', 'Accept');
        this.response.addHeader('Cache-Control', 'no-store, must-revalidate');
    }

    get tidStr(): string {
        return this.tdoc.docId.toHexString();
    }

    /** Job state with staleness folded in (a run without a heartbeat is dead). */
    async jobView() {
        const job = await GradeModel.getJob(this.args.domainId, this.tidStr, this.pdoc.docId);
        if (!job) return null;
        if (GradeModel.jobStale(job)) return { ...job, status: 'failed', error: 'The grading job stopped reporting progress (the server may have restarted). Start it again.' };
        return job;
    }

    /** Every student of the homework (attendees ∪ submitters) with their PDF and grade. */
    async rows(domainId: string) {
        const pid = this.pdoc.docId;
        const [subs, grades, tsdocs] = await Promise.all([
            listSubjective(domainId, pid),
            GradeModel.gradeMapOf(domainId, pid),
            contest.getMultiStatus(domainId, { docId: this.tdoc.docId }).project({ uid: 1, attend: 1 }).toArray() as Promise<any[]>,
        ]);
        const subOf = new Map(subs.map((s) => [s.uid, s]));
        const uids = [...new Set([...tsdocs.filter((t) => t.attend).map((t) => t.uid), ...subs.map((s) => s.uid)])]
            .filter((uid) => uid !== this.tdoc.owner && !(this.tdoc.maintainer || []).includes(uid));
        const udict: any = uids.length ? await user.getList(domainId, uids) : {};
        const rh = rubricHash((await subjectiveConfigOfPdoc(this.pdoc)).rubric);
        const rows = uids.map((uid) => {
            const sub = subOf.get(uid);
            const file = pdfFileOf(sub);
            const g = grades.get(uid) || null;
            const view = teacherGradeView(g);
            const u = udict[uid] || {};
            return {
                uid,
                uname: u.uname || `user#${uid}`,
                name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.displayName || '',
                attended: tsdocs.some((t) => t.uid === uid && t.attend),
                file: file ? { name: file.name, size: file.size, uploadAt: file.uploadAt } : null,
                hasReport: !!(sub?.report || '').trim(),
                grade: view ? {
                    status: view.status,
                    stage: view.stage,
                    stageAt: view.stageAt,
                    total: view.total,
                    aiTotal: view.aiTotal,
                    maxTotal: view.maxTotal,
                    score100: view.score100,
                    confidence: view.confidence,
                    flags: view.flags,
                    released: view.released,
                    adjusted: !!view.teacher,
                    error: view.error || view.skipReason || null,
                    gradedAt: view.gradedAt,
                    annotated: !!view.annotated,
                    // The grade no longer matches the PDF (re-uploaded or removed) or the rubric on file.
                    stale: view.status === 'done' && (!file || (g.fileAt && new Date(file.uploadAt).getTime() !== new Date(g.fileAt).getTime()) || (rh && g.rubricHash !== rh)),
                } : null,
            };
        });
        rows.sort((a, b) => (a.uname < b.uname ? -1 : a.uname > b.uname ? 1 : 0));
        const counts = {
            students: rows.length,
            submissions: rows.filter((r) => r.file).length,
            graded: rows.filter((r) => r.grade?.status === 'done').length,
            failed: rows.filter((r) => r.grade?.status === 'failed').length,
            skipped: rows.filter((r) => r.grade?.status === 'skipped').length,
            running: rows.filter((r) => r.grade?.status === 'running' || r.grade?.status === 'queued').length,
            released: rows.filter((r) => r.grade?.released).length,
            stale: rows.filter((r) => r.grade?.stale).length,
            pending: rows.filter((r) => r.file && (!r.grade || r.grade.status === 'failed' || r.grade.stale)).length,
        };
        const done = rows.filter((r) => r.grade?.status === 'done' && typeof r.grade.total === 'number');
        const mean = done.length ? round1(done.reduce((a, r) => a + (r.grade!.total || 0), 0) / done.length) : null;
        return { rows, counts, mean };
    }

    /** Where every form post returns to (the review page, with the student kept open). */
    backUrl(uid?: number) {
        return this.url('homework_subjective_review', { tid: this.tdoc.docId, pid: this.pdoc.docId, ...(uid ? { query: { uid } } : {}) });
    }

    @param('uid', Types.PositiveInt, true)
    async get({ domainId }, uid?: number) {
        const config = await subjectiveConfigOfPdoc(this.pdoc);
        const { rows, counts, mean } = await this.rows(domainId);
        // One student opened (?uid=): their full grade, comments and submission.
        let detail: any = null;
        if (uid) {
            const [doc, sub] = await Promise.all([GradeModel.getGrade(domainId, this.pdoc.docId, uid), getSubjective(domainId, this.pdoc.docId, uid)]);
            const udict: any = await user.getList(domainId, [uid]);
            const u = udict[uid] || {};
            detail = {
                uid,
                uname: u.uname || `user#${uid}`,
                name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.displayName || '',
                grade: teacherGradeView(doc),
                submission: sub ? {
                    report: sub.report || '',
                    files: (sub.files || []).map((f) => ({ name: f.name, size: f.size, uploadAt: f.uploadAt })),
                    updateAt: sub.updateAt,
                } : null,
            };
        }
        // Server-rendered page (homework_report_review.html); the same
        // body is the JSON the page script polls and older clients read.
        this.response.template = 'homework_report_review.html';
        this.response.body = {
            tdoc: {
                _id: this.tidStr, title: this.tdoc.title, beginAt: this.tdoc.beginAt, endAt: this.tdoc.endAt, ended: contest.isDone(this.tdoc), points: this.tdoc.score?.[this.pdoc.docId] ?? 100,
            },
            pdoc: { docId: this.pdoc.docId, pid: this.pdoc.pid || String(this.pdoc.docId), title: this.pdoc.title },
            config: { ...config, rubricHash: rubricHash(config.rubric) },
            enabled: gradingEnabled(),
            pdfjs: pdfjsAvailable(),
            autoRelease: autoReleaseEnabled(),
            // Manual evaluation: the teacher publishes the homework's results (see postEvaluate).
            evaluation: {
                manual: !!this.tdoc.manualEval, evaluatedAt: this.tdoc.evaluatedAt || null, ended: contest.isDone(this.tdoc),
            },
            job: await this.jobView(),
            rows,
            counts,
            mean,
            detail,
            links: {
                homework: this.url('homework_detail', { tid: this.tdoc.docId }),
                scoreboard: this.url('homework_scoreboard', { tid: this.tdoc.docId }),
                task: this.url('homework_detail_problem', { tid: this.tdoc.docId, pid: this.pdoc.docId }),
                edit: this.url('problem_edit', { pid: this.pdoc.pid || this.pdoc.docId }),
                grade: this.url('subjective_grade', { pid: this.pdoc.docId }),
                annotated: this.url('subjective_annotated', { pid: this.pdoc.docId }),
                file: this.url('subjective_task_file', { pid: this.pdoc.docId }),
            },
        };
    }

    /**
     * The teacher's "Evaluate & review grades": evaluates the homework the
     * way the deadline would for any other homework (objective answers
     * graded, every status rebuilt, results published to the students,
     * problem-set statuses synced) and starts the AI grading of the report
     * tasks. Only for an ended homework; harmless when repeated.
     */
    async postEvaluate({ domainId }) {
        const fresh = await contest.get(domainId, this.tdoc.docId);
        if (!contest.isDone(fresh)) throw new BadRequestError('The homework has not ended yet — it can be evaluated once the deadline (and the late window) has passed.');
        await evaluateContainerResults(domainId, { ...fresh, objectiveSynced: false } as any, { manual: true, by: this.user._id });
        const after = await contest.get(domainId, this.tdoc.docId);
        this.response.body = { evaluated: true, evaluatedAt: after?.evaluatedAt || null };
        this.response.redirect = this.backUrl();
    }

    async requireGradable() {
        if (!gradingEnabled()) throw new ForbiddenError('The AI grader is not enabled (or no AI provider is configured).');
        const config = await subjectiveConfigOfPdoc(this.pdoc);
        if (config.type !== 'report') throw new BadRequestError('Only report tasks (one PDF per student) are graded automatically for now.');
        if (!config.rubric) throw new BadRequestError('This task has no rubric yet — add one on the task\'s edit page first.');
        return config;
    }

    @param('force', Types.Boolean, true)
    async postGrade({ domainId }, force = false) {
        await this.requireGradable();
        const job = await this.jobView();
        if (job && job.status === 'running') {
            this.response.body = { started: false, job };
            this.response.redirect = this.backUrl();
            return;
        }
        startGradingJob(domainId, this.tidStr, this.pdoc.docId, { by: this.user._id, force });
        this.response.body = { started: true, job: await this.jobView() };
        this.response.redirect = this.backUrl();
    }

    @param('uid', Types.PositiveInt)
    async postRegrade({ domainId }, uid: number) {
        await this.requireGradable();
        const job = await this.jobView();
        if (job && job.status === 'running') throw new BadRequestError('A grading run is in progress — wait for it to finish.');
        startGradingJob(domainId, this.tidStr, this.pdoc.docId, { by: this.user._id, force: true, uids: [uid] });
        this.response.body = { started: true, job: await this.jobView() };
        this.response.redirect = this.backUrl(uid);
    }

    /** The live state the page polls while a run is in progress: the job, the counts and every row's grade state. */
    async postStatus({ domainId }) {
        const { rows, counts, mean } = await this.rows(domainId);
        this.response.body = {
            job: await this.jobView(),
            counts,
            mean,
            rows: rows.map((r) => ({ uid: r.uid, file: !!r.file, grade: r.grade })),
            at: new Date(),
        };
    }

    @param('uid', Types.PositiveInt, true)
    async postRelease({ domainId }, uid?: number) {
        const uids = await setGradesReleased(domainId, this.tidStr, this.pdoc.docId, true, this.user._id, uid);
        this.response.body = { released: uids.length, uids };
        this.response.redirect = this.backUrl(uid);
    }

    @param('uid', Types.PositiveInt, true)
    async postUnrelease({ domainId }, uid?: number) {
        const uids = await setGradesReleased(domainId, this.tidStr, this.pdoc.docId, false, this.user._id, uid);
        this.response.body = { withdrawn: uids.length, uids };
        this.response.redirect = this.backUrl(uid);
    }

    @param('uid', Types.PositiveInt)
    @param('points', Types.Content, true)
    @param('note', Types.Content, true)
    async postAdjust({ domainId }, uid: number, pointsRaw = '', note = '') {
        const doc = await GradeModel.getGrade(domainId, this.pdoc.docId, uid);
        if (!doc || doc.status !== 'done') throw new BadRequestError('There is no finished grade to adjust for this student.');
        // XHR clients post `points` as JSON; the page's form posts one pt_<criterion id> field per row.
        let parsed: any = {};
        if (String(pointsRaw || '').trim()) {
            try {
                parsed = JSON.parse(pointsRaw);
            } catch {
                throw new ValidationError('points');
            }
        } else {
            for (const c of doc.criteria || []) if (this.args[`pt_${c.id}`] !== undefined) parsed[c.id] = this.args[`pt_${c.id}`];
        }
        const points: Record<string, number> = {};
        for (const c of doc.criteria || []) {
            const v = parsed?.[c.id];
            if (v === undefined || v === null || v === '') continue;
            const n = Math.round(+v * 100) / 100;
            if (!Number.isFinite(n) || n < 0 || n > c.maxPoints) throw new ValidationError('points', null, `"${c.title}" takes 0 to ${c.maxPoints} points.`);
            if (n !== c.points) points[c.id] = n;
        }
        const cleanNote = String(note || '').trim().slice(0, 2000);
        const fresh = await GradeModel.patchGrade(domainId, this.pdoc.docId, uid, {
            teacher: {
                points, note: cleanNote, by: this.user._id, at: new Date(),
            },
        });
        if (fresh?.released) await setGradesReleased(domainId, this.tidStr, this.pdoc.docId, true, this.user._id, uid); // re-derives the status
        this.response.body = { grade: teacherGradeView(fresh) };
        this.response.redirect = this.backUrl(uid);
    }

    @param('uid', Types.PositiveInt)
    async postClearAdjust({ domainId }, uid: number) {
        const fresh = await GradeModel.patchGrade(domainId, this.pdoc.docId, uid, {}, ['teacher']);
        if (fresh?.released) await setGradesReleased(domainId, this.tidStr, this.pdoc.docId, true, this.user._id, uid);
        this.response.body = { grade: teacherGradeView(fresh) };
        this.response.redirect = this.backUrl(uid);
    }
}

/** A student's own released grade (or, for the teacher, anyone's). */
class SubjectiveGradeHandler extends Handler {
    @param('pid', Types.ProblemId)
    @param('uid', Types.PositiveInt, true)
    async get({ domainId }, pid: number | string, uid?: number) {
        const pdoc = await problem.get(domainId, pid);
        if (!pdoc || !isSubjectivePdoc(pdoc)) throw new NotFoundError(pid);
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) throw new ForbiddenError('Please sign in.');
        this.response.addHeader('Cache-Control', 'no-store');
        const teacher = taskTeacher(this, pdoc);
        const targetUid = (uid && uid !== this.user._id) ? uid : this.user._id;
        if (targetUid !== this.user._id && !teacher) throw new ForbiddenError('Not your grade.');
        const doc = await GradeModel.getGrade(domainId, pdoc.docId, targetUid);
        this.response.body = {
            grade: teacher && targetUid !== this.user._id ? teacherGradeView(doc) : studentGradeView(doc),
            config: await subjectiveConfigOfPdoc(pdoc),
        };
    }
}

/** The annotated copy of a graded PDF: the student's own once released, any for the teacher. */
class SubjectiveAnnotatedHandler extends Handler {
    @param('pid', Types.ProblemId)
    @param('uid', Types.PositiveInt, true)
    @param('inline', Types.Boolean, true)
    async get({ domainId }, pid: number | string, uid?: number, inline = false) {
        const pdoc = await problem.get(domainId, pid);
        if (!pdoc || !isSubjectivePdoc(pdoc)) throw new NotFoundError(pid);
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) throw new ForbiddenError('Please sign in.');
        const teacher = taskTeacher(this, pdoc);
        const targetUid = (uid && uid !== this.user._id) ? uid : this.user._id;
        if (targetUid !== this.user._id && !teacher) throw new ForbiddenError('Not your submission.');
        const doc = await GradeModel.getGrade(domainId, pdoc.docId, targetUid);
        if (!doc?.annotated) throw new NotFoundError('annotated.pdf');
        if (!teacher && !doc.released) throw new ForbiddenError('This grade has not been released yet.');
        // No filename = no attachment disposition, so the PDF opens inline (the viewer frame).
        this.response.redirect = await storage.signDownloadLink(doc.annotated.target, inline ? undefined : doc.annotated.name, false);
    }
}

/**
 * Rubric reuse: every subjective task of the domain that has a rubric (as
 * far as this teacher may see), for the builder's "Copy from another task"
 * menu on the create/edit page.
 */
class SubjectiveRubricListHandler extends Handler {
    async get({ domainId }) {
        this.checkPerm(PERM.PERM_CREATE_PROBLEM);
        this.response.addHeader('Cache-Control', 'no-store');
        const pdocs = await problem.getMulti(domainId, { pid: /^s/i } as any, ['docId', 'pid', 'title', 'data', 'domainId', 'owner', 'hidden'] as any)
            .sort({ docId: -1 }).limit(200).toArray() as any[];
        const canSeeHidden = this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN);
        const rubrics: any[] = [];
        for (const pdoc of pdocs) {
            if (pdoc.hidden && pdoc.owner !== this.user._id && !canSeeHidden) continue;
            // eslint-disable-next-line no-await-in-loop
            const cfg = await subjectiveConfigOfPdoc(pdoc);
            if (!cfg.rubric) continue;
            rubrics.push({
                docId: pdoc.docId, pid: pdoc.pid || String(pdoc.docId), title: pdoc.title, type: cfg.type, rubric: cfg.rubric,
            });
        }
        this.response.body = { rubrics };
    }
}

/**
 * The page's template lives in ui-default/templates. The in-memory registry
 * is filled by scanning that folder at boot; this fallback covers a process
 * whose scan predates the file (dev watcher): it reads the on-disk template
 * through the package, and only if that fails registers a notice shell.
 */
function reviewTemplateSource(): string {
    try {
        const base = path.dirname(require.resolve('@hydrooj/ui-default/package.json'));
        const file = path.join(base, 'templates', 'homework_report_review.html');
        if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8');
    } catch (e) { /* fall through */ }
    return `{% extends "layout/basic.html" %}
{% block content %}
<div class="row"><div class="medium-12 columns"><div class="section"><div class="section__body">
{{ _('The review page template (templates/homework_report_review.html) is not installed on this server — copy the ui-default files and restart.') }}
</div></div></div></div>
{% endblock %}
`;
}

export function registerSubjectiveGradingRoutes(ctx: Context) {
    if ((global as any).__ptaSubjectiveGradingRoutes) return;
    (global as any).__ptaSubjectiveGradingRoutes = true;
    (ctx as any).inject(['template'], (c: any) => {
        c.template.registry['homework_report_review.html'] ||= reviewTemplateSource();
    });
    ctx.Route('homework_subjective_review', '/homework/:tid/subjective/:pid', HomeworkSubjectiveReviewHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('subjective_grade', '/p/:pid/subjective/grade', SubjectiveGradeHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('subjective_annotated', '/p/:pid/subjective/annotated', SubjectiveAnnotatedHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('subjective_rubrics', '/subjective/rubrics', SubjectiveRubricListHandler, PERM.PERM_CREATE_PROBLEM);
    /*
     * The homework page's "Subjective tasks" card (homework_detail.html,
     * staff only): every subjective task of the homework with ALL students'
     * hand-ins (who, which files, when, cover note) — and for report tasks
     * the state of the AI grades and the link to the review page. The same
     * data fills the "handed in" cells of the manager's problem table.
     */
    ctx.on('handler/after/HomeworkDetail#get' as any, async (h: any) => {
        try {
            if (!h?.response?.template || !h.tdoc) return;
            const tdoc = h.tdoc;
            const staff = h.user.own(tdoc) || h.user.role === 'root' || h.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
            if (!staff) return;
            const domainId = h.args.domainId;
            /*
             * The page's own pdict is PROJECTION_CONTEST_LIST, which carries
             * no `data` — and the submission type + rubric live in
             * config.yaml, which readRawProblemConfig finds through `data`.
             * So the subjective tasks are loaded again with it.
             */
            const pdict = await problem.getList(domainId, tdoc.pids, true, false, ['docId', 'pid', 'title', 'data', 'domainId'] as any, true);
            const staffUids = new Set<number>([tdoc.owner, ...(tdoc.maintainer || [])]);
            const tasks: any[] = [];
            const byPid: Record<number, any> = {};
            let allUids: number[] = [];
            for (const pid of tdoc.pids as number[]) {
                const pdoc = pdict?.[pid];
                if (!pdoc || !isSubjectivePdoc(pdoc)) continue;
                // eslint-disable-next-line no-await-in-loop
                const cfg = await subjectiveConfigOfPdoc(pdoc);
                const isReport = cfg.type === 'report';
                // eslint-disable-next-line no-await-in-loop
                const [subs, grades] = await Promise.all([listSubjective(domainId, pid), isReport ? GradeModel.gradeMapOf(domainId, pid) : Promise.resolve(new Map())]);
                const students = subs.filter((sub) => !staffUids.has(sub.uid));
                allUids = allUids.concat(students.map((sub) => sub.uid));
                const submissions = students
                    .sort((a, b) => new Date(b.updateAt).getTime() - new Date(a.updateAt).getTime())
                    .map((sub) => {
                        const g: any = grades.get(sub.uid) || null;
                        const pdf = pdfFileOf(sub);
                        return {
                            uid: sub.uid,
                            files: (sub.files || []).map((f) => ({ name: f.name, size: f.size, uploadAt: f.uploadAt })),
                            pdf: pdf ? pdf.name : null,
                            hasReport: !!(sub.report || '').trim(),
                            updateAt: sub.updateAt,
                            grade: g ? {
                                status: g.status, score100: g.status === 'done' ? GradeModel.effectiveScore100(g) : null, released: !!g.released, error: g.error || g.skipReason || null,
                            } : null,
                        };
                    });
                const latest = submissions.reduce((a: Date | null, sub) => (!a || new Date(sub.updateAt) > a ? new Date(sub.updateAt) : a), null);
                const task = {
                    docId: pid,
                    pid: pdoc.pid || String(pid),
                    title: pdoc.title,
                    type: cfg.type,
                    rubric: !!cfg.rubric,
                    url: isReport ? h.url('homework_subjective_review', { tid: tdoc.docId, pid }) : null,
                    fileUrl: h.url('subjective_task_file', { pid }),
                    taskUrl: h.url('problem_detail', { pid, query: { tid: tdoc.docId } }),
                    handedIn: submissions.length,
                    pdfs: submissions.filter((sub) => sub.pdf).length,
                    latestAt: latest,
                    graded: submissions.filter((sub) => sub.grade?.status === 'done').length,
                    released: submissions.filter((sub) => sub.grade?.released).length,
                    failed: submissions.filter((sub) => sub.grade?.status === 'failed').length,
                    submissions,
                };
                tasks.push(task);
                byPid[pid] = task;
            }
            if (!tasks.length) return;
            const udict: any = allUids.length ? await user.getList(domainId, [...new Set(allUids)]) : {};
            for (const task of tasks) {
                for (const sub of task.submissions) {
                    const u = udict[sub.uid] || {};
                    sub.uname = u.uname || `user#${sub.uid}`;
                    sub.name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.displayName || '';
                }
            }
            h.response.body.subjectiveOverview = {
                enabled: gradingEnabled(),
                auto: autoGradeEnabled(),
                ended: contest.isDone(tdoc),
                tasks,
                byPid,
                hasReportTasks: tasks.some((t) => t.type === 'report'),
                // Manual evaluation (a subjective task is listed): the deadline
                // does not evaluate this homework — the teacher's "Evaluate &
                // review grades" does. The form posts `evaluate` to any of the
                // subjective tasks' review routes; the first one is used.
                evaluation: {
                    manual: !!tdoc.manualEval,
                    evaluatedAt: tdoc.evaluatedAt || null,
                    url: h.url('homework_subjective_review', { tid: tdoc.docId, pid: tasks[0].docId }),
                },
            };
        } catch (e) {
            logger.warn('[subjective-grader] homework page card failed: %s', e.message);
        }
    });
    ctx.effect(() => () => { (global as any).__ptaSubjectiveGradingRoutes = false; });
}

export async function apply(ctx: Context) {
    registerSubjectiveGradingRoutes(ctx);
}

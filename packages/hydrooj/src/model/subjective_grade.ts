/* eslint-disable max-len */
/**
 * PTA fork — AI GRADES of subjective REPORT submissions.
 *
 * One document per (domain, task, student): what the grader
 * (lib/subjective_grader.ts) concluded about the student's PDF — points per
 * rubric criterion with a rationale, page-anchored comments (the evidence
 * behind the points, each verified against the PDF's own text), an overall
 * summary, and the annotated copy of the PDF where those comments are
 * highlighted. The teacher can adjust the points (`teacher`), and decides
 * when students see it (`released`).
 *
 * A released grade IS the task's score on the homework scoreboard: model/
 * contest.ts seedSubjectiveScores() folds it into the student's status as
 * the COMPUTED score of that task — the teacher's manual adjustment
 * (tsdoc.override, homework_score_override) still applies on top, exactly
 * as for every other task.
 *
 * One JOB document per (domain, homework, task) tracks a grading run (the
 * teacher's page polls it; a run without a heartbeat for JOB_STALE_MS is
 * reported as dead).
 */
import db from '../service/db';

export type SubjectiveGradeStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';
/** Where a running grade is: the review page animates these (pages/homework_subjective_review.page.js). */
export type SubjectiveGradeStage = 'queued' | 'extract' | 'grading' | 'verify' | 'annotate' | 'done' | 'failed' | 'skipped';

export interface GradeCriterionResult {
    id: string;
    title: string;
    maxPoints: number;
    /** The grader's points (the teacher's adjustment lives in `teacher.points`). */
    points: number;
    /** Label of the rubric level the grader picked, when the criterion has levels. */
    level?: string;
    rationale: string;
}

export interface GradeComment {
    /** 1-based number, the marker drawn in the annotated PDF. */
    n: number;
    page: number;
    /** Verbatim text of the report this comment is about (as the model cited it). */
    quote: string;
    kind: 'strength' | 'issue' | 'note';
    criterionId?: string;
    note: string;
    /** The quote was found in the page's text (partial = only its head matched). */
    verified: boolean;
    partial?: boolean;
    /** Highlight boxes on the page, PDF user space (absent when not verified). */
    rects?: { x: number, y: number, w: number, h: number }[];
}

export interface SubjectiveGradeDoc {
    /** `${domainId}/${pid}/${uid}` */
    _id: string;
    domainId: string;
    pid: number;
    uid: number;
    status: SubjectiveGradeStatus;
    /** Step of the pipeline a running grade is at, and when it got there. */
    stage?: SubjectiveGradeStage;
    stageAt?: Date;
    /** The homework the grading run belonged to (informational: grades are per task). */
    tid?: string;
    /** Who started the run (0 = the automatic end-of-homework run). */
    by?: number;
    fileName?: string;
    fileHash?: string;
    /** When the graded PDF was uploaded — the homework's late rule applies to it. */
    fileAt?: Date;
    rubricHash?: string;
    total?: number;
    maxTotal?: number;
    /** total / maxTotal × 100 — the scoreboard's scale. */
    score100?: number;
    criteria?: GradeCriterionResult[];
    comments?: GradeComment[];
    summary?: { overall: string, strengths: string[], improvements: string[] };
    /** 0..1: how confident the grader is that the text gave it enough to judge. */
    confidence?: number;
    flags?: string[];
    extraction?: { pages: number, readPages: number, chars: number, scanned: boolean, truncated: boolean };
    annotated?: { target: string, name: string, generatedAt: Date };
    model?: string;
    /** How the model read the report: extracted text only, or the PDF itself alongside the text. */
    mode?: 'text' | 'vision';
    usage?: { input?: number, output?: number, cached?: number };
    gradedAt?: Date;
    error?: string;
    skipReason?: string;
    /** The teacher's adjustments: points per criterion id (others keep the grader's) and a note to the student. */
    teacher?: { points: Record<string, number>, note: string, by: number, at: Date };
    released: boolean;
    releasedAt?: Date;
    releasedBy?: number;
    updateAt: Date;
}

export interface SubjectiveGradeJob {
    /** `${domainId}/${tid}/${pid}` */
    _id: string;
    domainId: string;
    tid: string;
    pid: number;
    status: 'running' | 'done' | 'failed';
    stage: string;
    done: number;
    total: number;
    graded: number;
    failed: number;
    skipped: number;
    force: boolean;
    startedAt: Date;
    updatedAt: Date;
    finishedAt?: Date;
    by: number;
    error?: string;
}

export const JOB_STALE_MS = 6 * 60 * 1000;

const coll = db.collection('subjective.aigrade' as any);
const collJob = db.collection('subjective.aigrade.job' as any);

export const gradeId = (domainId: string, pid: number, uid: number) => `${domainId}/${pid}/${uid}`;
export const jobId = (domainId: string, tid: string, pid: number) => `${domainId}/${tid}/${pid}`;

export async function getGrade(domainId: string, pid: number, uid: number): Promise<SubjectiveGradeDoc | null> {
    return await coll.findOne({ _id: gradeId(domainId, pid, uid) as any }) as any;
}

export async function listGrades(domainId: string, pid: number): Promise<SubjectiveGradeDoc[]> {
    return await coll.find({ domainId, pid }).limit(2000).toArray() as any;
}

/** Released grades of several tasks, optionally for one set of students — the scoreboard's read. */
export async function listReleasedGrades(domainId: string, pids: number[], uids?: number[]): Promise<SubjectiveGradeDoc[]> {
    if (!pids.length || (uids && !uids.length)) return [];
    const q: any = { domainId, pid: { $in: pids }, released: true, status: 'done' };
    if (uids) q.uid = { $in: uids };
    return await coll.find(q).project({
        pid: 1, uid: 1, score100: 1, total: 1, maxTotal: 1, fileAt: 1, gradedAt: 1, teacher: 1, criteria: 1,
    }).limit(20000).toArray() as any;
}

export async function setGrade(doc: Omit<SubjectiveGradeDoc, '_id' | 'updateAt'> & Partial<Pick<SubjectiveGradeDoc, 'updateAt'>>): Promise<void> {
    const _id = gradeId(doc.domainId, doc.pid, doc.uid);
    await coll.updateOne({ _id: _id as any }, { $set: { ...doc, updateAt: new Date() } }, { upsert: true });
}

export async function patchGrade(domainId: string, pid: number, uid: number, $set: Partial<SubjectiveGradeDoc>, $unset: string[] = []): Promise<SubjectiveGradeDoc | null> {
    const update: any = { $set: { ...$set, updateAt: new Date() } };
    if ($unset.length) update.$unset = Object.fromEntries($unset.map((k) => [k, '']));
    return await coll.findOneAndUpdate({ _id: gradeId(domainId, pid, uid) as any }, update, { returnDocument: 'after' }) as any;
}

export async function deleteGrade(domainId: string, pid: number, uid: number): Promise<void> {
    await coll.deleteOne({ _id: gradeId(domainId, pid, uid) as any });
}

/** Release (or withdraw) every finished grade of a task, or one student's. Returns the uids touched. */
export async function setReleased(domainId: string, pid: number, released: boolean, by: number, uid?: number): Promise<number[]> {
    const q: any = { domainId, pid, status: 'done' };
    if (uid !== undefined) q.uid = uid;
    const docs = await coll.find(q).project({ uid: 1 }).toArray();
    if (!docs.length) return [];
    await coll.updateMany(q, {
        $set: released
            ? { released: true, releasedAt: new Date(), releasedBy: by, updateAt: new Date() }
            : { released: false, updateAt: new Date() },
    });
    return docs.map((d: any) => d.uid);
}

/* ---- effective points: the teacher's adjustment wins per criterion ---- */

export function effectivePoints(doc: SubjectiveGradeDoc): { total: number, perCriterion: Record<string, number> } {
    const per: Record<string, number> = {};
    let total = 0;
    for (const c of doc.criteria || []) {
        const t = doc.teacher?.points?.[c.id];
        const v = typeof t === 'number' && Number.isFinite(t) ? Math.max(0, Math.min(c.maxPoints, t)) : c.points;
        per[c.id] = v;
        total += v;
    }
    return { total: Math.round(total * 100) / 100, perCriterion: per };
}

export function effectiveScore100(doc: SubjectiveGradeDoc): number {
    const max = doc.maxTotal || 0;
    if (!(max > 0)) return doc.score100 || 0;
    return Math.max(0, Math.min(100, Math.round((effectivePoints(doc).total / max) * 10000) / 100));
}

/* ---- jobs ---- */

export async function getJob(domainId: string, tid: string, pid: number): Promise<SubjectiveGradeJob | null> {
    return await collJob.findOne({ _id: jobId(domainId, tid, pid) as any }) as any;
}

export function jobStale(job: SubjectiveGradeJob | null | undefined, staleMs = JOB_STALE_MS): boolean {
    return !!job && job.status === 'running' && Date.now() - new Date(job.updatedAt || job.startedAt).getTime() > staleMs;
}

/** Atomically claim the job: returns false while another live run holds it. */
export async function claimJob(domainId: string, tid: string, pid: number, by: number, force: boolean): Promise<boolean> {
    const now = new Date();
    const _id = jobId(domainId, tid, pid) as any;
    const fresh: SubjectiveGradeJob = {
        _id, domainId, tid, pid, status: 'running', stage: 'collect', done: 0, total: 0, graded: 0, failed: 0, skipped: 0, force, startedAt: now, updatedAt: now, by,
    };
    const { _id: _omit, ...fields } = fresh;
    void _omit;
    const res = await collJob.updateOne(
        { _id, $or: [{ status: { $ne: 'running' } }, { updatedAt: { $lt: new Date(now.getTime() - JOB_STALE_MS) } }] },
        { $set: fields },
    );
    if (res.matchedCount) return true;
    try {
        await collJob.insertOne(fresh as any);
        return true;
    } catch (e) {
        return false; // exists and is running
    }
}

export async function patchJob(domainId: string, tid: string, pid: number, $set: Partial<SubjectiveGradeJob>): Promise<void> {
    await collJob.updateOne({ _id: jobId(domainId, tid, pid) as any }, { $set: { ...$set, updatedAt: new Date() } });
}

/** Grades of a task keyed by uid — the review page's table. */
export async function gradeMapOf(domainId: string, pid: number): Promise<Map<number, SubjectiveGradeDoc>> {
    const docs = await listGrades(domainId, pid);
    return new Map(docs.map((d) => [d.uid, d]));
}

declare module '../interface' {
    interface Collections {
        'subjective.aigrade': SubjectiveGradeDoc;
        'subjective.aigrade.job': SubjectiveGradeJob;
    }
}

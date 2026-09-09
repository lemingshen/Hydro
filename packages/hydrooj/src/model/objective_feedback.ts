import db from '../service/db';

/**
 * PTA fork — the AI EXPLANATION of ONE objective task a student got wrong:
 * one document per (homework, student, task) holding the generated
 * Markdown, a snapshot of what it was generated from, and the state of
 * the background job that produces it (the page polls it; a refresh or a
 * closed tab does not interrupt the generation).
 */
export interface ObjectiveFeedbackDoc {
    _id: string; // `${domainId}/${tid}/${uid}/${pid}`
    domainId: string;
    tid: string;
    uid: number;
    pid: number;
    report?: string;
    generatedAt?: Date;
    /** What the review covered: question counts by outcome. */
    snapshot?: { questions: number, wrong: number, unanswered: number, correct: number, ungraded?: number };
    job?: {
        status: 'running' | 'done' | 'failed';
        /** ai-speedup WP5: 'waiting' while the scheduler has no capacity (with the queue position / ETA). */
        stage?: 'waiting' | 'running';
        waiting?: { ahead: number, eta: number };
        /** ai-speedup WP2: the live stream the student's page attaches to (this process only; absent for pre-warmed reports). */
        streamId?: string;
        startedAt: Date;
        updatedAt: Date;
        finishedAt?: Date;
        error?: string;
    };
}

declare module '../service/db' {
    interface Collections {
        'ai.objective_feedback': ObjectiveFeedbackDoc;
    }
}

const coll = db.collection('ai.objective_feedback');
const idOf = (domainId: string, tid: string, uid: number, pid: number) => `${domainId}/${tid}/${uid}/${pid}`;

export async function getObjectiveFeedback(domainId: string, tid: string, uid: number, pid: number): Promise<ObjectiveFeedbackDoc | null> {
    return await coll.findOne({ _id: idOf(domainId, tid, uid, pid) as any });
}

/** Every explanation this student already has in this homework (one query for the page). */
export async function listObjectiveFeedback(domainId: string, tid: string, uid: number): Promise<ObjectiveFeedbackDoc[]> {
    return await coll.find({ domainId, tid, uid }).project({ pid: 1, generatedAt: 1, job: 1 }).limit(200).toArray() as any;
}

export async function setObjectiveFeedbackJob(domainId: string, tid: string, uid: number, pid: number, job: Omit<ObjectiveFeedbackDoc['job'], 'updatedAt'>): Promise<void> {
    await coll.updateOne(
        { _id: idOf(domainId, tid, uid, pid) as any },
        { $set: { domainId, tid, uid, pid, job: { ...job, updatedAt: new Date() } } },
        { upsert: true },
    );
}

export async function setObjectiveFeedbackReport(domainId: string, tid: string, uid: number, pid: number, report: string, snapshot: ObjectiveFeedbackDoc['snapshot']): Promise<Date> {
    const generatedAt = new Date();
    await coll.updateOne(
        { _id: idOf(domainId, tid, uid, pid) as any },
        { $set: { domainId, tid, uid, pid, report, snapshot, generatedAt } },
        { upsert: true },
    );
    return generatedAt;
}

/** A running job whose last heartbeat is older than `silenceMs` counts as dead. */
export function objectiveFeedbackJobStale(job: ObjectiveFeedbackDoc['job'] | null | undefined, silenceMs: number): boolean {
    if (!job || job.status !== 'running') return false;
    const last = job.updatedAt || job.startedAt;
    return !last || Date.now() - new Date(last).getTime() > silenceMs;
}

/**
 * Remove the documents written by the retired homework-wide handler
 * (handler/objective_feedback.ts, now an empty stub). It called this model
 * with one argument too few, so `pid` received the job object or the
 * report text and the documents landed under `.../[object Object]` and
 * `.../<report text>` keys — unreachable by the per-question code, which
 * always stores a numeric `pid`, and dead weight in listObjectiveFeedback.
 * Idempotent; runs once per boot from applyObjectiveFeedback().
 */
export async function purgeMalformedObjectiveFeedback(): Promise<number> {
    const res = await coll.deleteMany({ pid: { $not: { $type: 'number' } } } as any);
    return res.deletedCount || 0;
}

export default {
    getObjectiveFeedback,
    listObjectiveFeedback,
    setObjectiveFeedbackJob,
    setObjectiveFeedbackReport,
    objectiveFeedbackJobStale,
    purgeMalformedObjectiveFeedback,
};

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

export default {
    getObjectiveFeedback, listObjectiveFeedback, setObjectiveFeedbackJob, setObjectiveFeedbackReport, objectiveFeedbackJobStale,
};

/**
 * ⚡ QUICK REVIEW — storage.
 *
 * Three things live here:
 *
 *  1. The `quick` block on the activity's class-report document
 *     (`ai.class_report`, `_id = domainId/tid`, shared with the Full
 *     Report in model/selflearning.ts). It holds the exact statistics
 *     (`digest`), the one-call AI diagnosis (`diagnosis`, may be null), a
 *     compact per-student outcome map used for the students' own feedback
 *     card (`perStudent`, keyed by uid — never sent to anyone but that
 *     student and staff), the job state, and the teacher's release switch.
 *     Regeneration $sets the fields one by one, so `released` and the Full
 *     Report's fields survive.
 *
 *  2. `ai.question_points` — knowledge points PER QUESTION of an objective
 *     task. Tags are per task, but a quiz is often one task with many
 *     questions; the review needs question granularity. Rows are written
 *     by the teacher ("fix knowledge point" on the panel) or inferred once
 *     by the model from the catalog, and are read at digest time.
 *
 *  3. `ai.quiz_evidence` — one row per (student, question) of a finished
 *     test, consumed by lib/knowledge_map.ts as `quiz_ok` / `quiz_fail`
 *     evidence so the Knowledge Map and "Practise next" reflect the quiz.
 *     Replaced wholesale for a test on every regeneration (idempotent).
 */
import db from '../service/db';
import * as contest from './contest';
import system from './system';

export interface QuickJob {
    status: 'running' | 'done' | 'failed';
    stage: 'collect' | 'points' | 'digest' | 'map' | 'diagnose' | 'evidence' | 'prewarm' | 'done';
    startedAt: Date;
    updatedAt: Date;
    by: number | 'system';
    /** batches done / planned, for the `map` stage */
    progress?: { done: number, total: number };
    error?: string;
}

export interface QuickReviewBlock {
    generatedAt: Date;
    by: number | 'system';
    /** Exact statistics: lib/quick_review.ts QuickDigest. */
    digest: any;
    /** The AI diagnosis (lib/quick_review.ts QuickDiagnosis) or null when skipped / failed. */
    diagnosis: any | null;
    /** Why `diagnosis` is null, for the panel ("not configured", "homework", an error). */
    diagnosisNote?: string;
    /** The model's reply as received (anonymous by construction), for the teacher's "raw reply" view. */
    diagnosisRaw?: string;
    /** uid → { score, missed: [{ pid, key, given }], failed: [label] } */
    perStudent: Record<string, { score: number | null, missed: { pid: number, key: string, given: string }[], failed: string[] }>;
    /** Student feedback visible (policy `on_teacher` toggles it; `on_end` sets it at generation). */
    released: boolean;
    prewarm?: { queued: number, done: number };
    job?: QuickJob;
}

export interface QuestionPointsDoc {
    _id: string; // `${domainId}/${pid}/${key}`
    domainId: string;
    pid: number;
    key: string;
    points: string[];
    source: 'teacher' | 'inferred';
    updatedAt: Date;
    by?: number;
}

export interface QuizEvidenceDoc {
    _id: string; // `${domainId}/${tid}/${uid}/${pid}/${key}`
    domainId: string;
    tid: string;
    uid: number;
    pid: number;
    key: string;
    label: string;
    points: string[];
    correct: boolean;
    at: Date;
}

declare module '../service/db' {
    interface Collections {
        'ai.question_points': QuestionPointsDoc;
        'ai.quiz_evidence': QuizEvidenceDoc;
    }
}

const collReport = db.collection('ai.class_report' as any);
const collQuestionPoints = db.collection('ai.question_points');
const collQuizEvidence = db.collection('ai.quiz_evidence');

const idOf = (domainId: string, tid: string) => `${domainId}/${tid}`;

export async function getQuick(domainId: string, tid: string): Promise<QuickReviewBlock | null> {
    const doc: any = await collReport.findOne({ _id: idOf(domainId, tid) } as any, { projection: { quick: 1 } });
    return doc?.quick || null;
}

/** The block without the per-student map (what the teacher panel needs). */
export async function getQuickForTeacher(domainId: string, tid: string): Promise<Omit<QuickReviewBlock, 'perStudent'> | null> {
    // Inclusions only (mixing an inclusion with a nested exclusion is a path
    // collision on MongoDB 4.4+): everything but the per-student map.
    const fields = ['generatedAt', 'by', 'digest', 'diagnosis', 'diagnosisNote', 'diagnosisRaw', 'released', 'prewarm', 'job'];
    const projection = Object.fromEntries(fields.map((f) => [`quick.${f}`, 1]));
    const doc: any = await collReport.findOne({ _id: idOf(domainId, tid) } as any, { projection });
    return doc?.quick || null;
}

/** Only this student's row plus the class-level parts the card renders from. */
export async function getQuickForStudent(domainId: string, tid: string, uid: number) {
    const doc: any = await collReport.findOne({ _id: idOf(domainId, tid) } as any, {
        projection: {
            'quick.generatedAt': 1, 'quick.digest': 1, 'quick.diagnosis': 1, 'quick.released': 1, [`quick.perStudent.${uid}`]: 1,
        } as any,
    });
    const q = doc?.quick;
    if (!q?.digest) return null;
    return {
        generatedAt: q.generatedAt, digest: q.digest, diagnosis: q.diagnosis || null, released: !!q.released, mine: q.perStudent?.[String(uid)] || null,
    };
}

export async function setQuick(domainId: string, tid: string, quick: Omit<QuickReviewBlock, 'job' | 'released'> & { released?: boolean }): Promise<void> {
    const $set: any = {
        domainId, tid,
        'quick.generatedAt': quick.generatedAt,
        'quick.by': quick.by,
        'quick.digest': quick.digest,
        'quick.diagnosis': quick.diagnosis ?? null,
        'quick.diagnosisNote': quick.diagnosisNote || '',
        'quick.diagnosisRaw': quick.diagnosisRaw || '',
        'quick.perStudent': quick.perStudent || {},
        'quick.prewarm': quick.prewarm || null,
    };
    if (typeof quick.released === 'boolean') $set['quick.released'] = quick.released;
    await collReport.updateOne({ _id: idOf(domainId, tid) } as any, { $set }, { upsert: true });
}

export async function setQuickJob(domainId: string, tid: string, job: QuickJob | null): Promise<void> {
    await collReport.updateOne(
        { _id: idOf(domainId, tid) } as any,
        { $set: { domainId, tid, 'quick.job': job ? { ...job, updatedAt: new Date() } : null } },
        { upsert: true },
    );
}

export async function setQuickReleased(domainId: string, tid: string, released: boolean): Promise<void> {
    await collReport.updateOne({ _id: idOf(domainId, tid) } as any, { $set: { domainId, tid, 'quick.released': released } }, { upsert: true });
}

export async function setQuickPrewarm(domainId: string, tid: string, prewarm: { queued: number, done: number }): Promise<void> {
    await collReport.updateOne({ _id: idOf(domainId, tid) } as any, { $set: { 'quick.prewarm': prewarm } });
}

/** A running job with no heartbeat for `silenceMs` is dead (server restart). */
export function quickJobStale(job: QuickJob | null | undefined, silenceMs: number): boolean {
    if (!job || job.status !== 'running') return false;
    const last = job.updatedAt || job.startedAt;
    return !last || Date.now() - new Date(last).getTime() > silenceMs;
}

/**
 * Whether the students' feedback for a test (the weak-points card and the
 * Explain button) is visible right now: the policy
 * ai_tutor.quick_review_student_feedback, the CONTAINER end (never a
 * student's personal window) and, under `on_teacher`, the release switch.
 */
export function studentFeedbackVisible(tdoc: any, quick: { released?: boolean } | null | undefined): boolean {
    const policy = String(system.get('ai_tutor.quick_review_student_feedback') || 'on_end');
    if (policy === 'off') return false;
    if (!tdoc || !contest.isDone(tdoc)) return false;
    if (policy === 'on_teacher') return !!quick?.released;
    return true;
}

/* ------------------------- per-question knowledge points ------------------------- */

export const questionPointKey = (pid: number, key: string) => `${pid}:${key}`;

export async function getQuestionPoints(domainId: string, pids: number[]): Promise<Map<string, QuestionPointsDoc>> {
    if (!pids.length) return new Map();
    const docs = await collQuestionPoints.find({ domainId, pid: { $in: pids } }).toArray();
    return new Map(docs.map((d) => [questionPointKey(d.pid, d.key), d]));
}

export async function setQuestionPoints(
    domainId: string, pid: number, key: string, points: string[], source: QuestionPointsDoc['source'], by?: number,
): Promise<void> {
    const clean = [...new Set(points.map((p) => String(p || '').trim()).filter((p) => p))].slice(0, 6);
    const _id = `${domainId}/${pid}/${key}`;
    if (!clean.length) {
        await collQuestionPoints.deleteOne({ _id });
        return;
    }
    await collQuestionPoints.updateOne(
        { _id },
        { $set: { domainId, pid, key, points: clean, source, updatedAt: new Date(), ...(by ? { by } : {}) } },
        { upsert: true },
    );
}

/* ------------------------------ quiz evidence ------------------------------ */

export async function replaceQuizEvidence(domainId: string, tid: string, rows: Omit<QuizEvidenceDoc, '_id' | 'domainId' | 'tid'>[]): Promise<void> {
    await collQuizEvidence.deleteMany({ domainId, tid });
    if (!rows.length) return;
    const docs = rows.map((r) => ({ ...r, _id: `${domainId}/${tid}/${r.uid}/${r.pid}/${r.key}`, domainId, tid }));
    for (let i = 0; i < docs.length; i += 1000) {
        await collQuizEvidence.insertMany(docs.slice(i, i + 1000), { ordered: false }).catch(() => { /* duplicates on a retried run */ });
    }
}

export async function quizEvidenceOf(domainId: string, uid: number, limit = 2000): Promise<QuizEvidenceDoc[]> {
    return await collQuizEvidence.find({ domainId, uid }).sort({ at: -1 }).limit(limit).toArray();
}

export default {
    getQuick, getQuickForTeacher, getQuickForStudent, setQuick, setQuickJob, setQuickReleased, setQuickPrewarm, quickJobStale, studentFeedbackVisible,
    getQuestionPoints, setQuestionPoints, questionPointKey, replaceQuizEvidence, quizEvidenceOf,
};

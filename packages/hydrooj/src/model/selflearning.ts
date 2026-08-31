import { ObjectId } from 'mongodb';
import type { PenaltyRules } from '../interface';
import db from '../service/db';
import * as document from './document';

export const TYPE_SELF_LEARNING = 75 as const;

export interface SelfLearningDoc {
    _id: ObjectId;
    domainId: string;
    docType: 75;
    docId: ObjectId;
    owner: number;
    title: string;
    content: string;
    pids: number[];
    /*
     * Homework-style schedule (all optional: legacy sessions without these
     * fields are treated as always-open). `endAt` is the nominal deadline —
     * homework's penaltySince — and the hard stop is endAt + extensionDays.
     * `penaltyRules` is homework's tiered shape verbatim — { hours:
     * coefficient }, the largest elapsed hour-key wins — and `penalty` is
     * the legacy single-percent form from the first iteration of this
     * feature, kept so sessions saved with it keep their exact behavior
     * (it maps to { 0: (100 - penalty) / 100 }).
     */
    beginAt?: Date;
    endAt?: Date;
    extensionDays?: number;
    /**
     * PTA fork: the session's RESULTS — every student's summed score,
     * computed automatically once the deadline (endAt + extension) has
     * passed (`final`), or on demand by the teacher before that
     * (provisional). See handler/self_learning.ts computeSessionResults.
     */
    results?: SessionResults;
    /** Legacy: flat percent deducted while late. Superseded by penaltyRules. */
    penalty?: number;
    penaltyRules?: PenaltyRules;
    createdAt: Date;
    updateAt: Date;
}

declare module './document' {
    interface DocType {
        [TYPE_SELF_LEARNING]: SelfLearningDoc;
    }
}

export interface TutorMessage {
    role: 'user' | 'assistant';
    /**
     * chat: legacy panel turn (still used by objective quizzes, which have no
     * code to anchor cards to); attempt/accepted: dividers injected when a new
     * submission arrives; anno: a turn of the line-anchored pop-up card
     * dialogue — the only interaction channel for programming problems.
     */
    kind: 'chat' | 'attempt' | 'accepted' | 'anno';
    content: string;
    /** For kind 'anno': the anchored line range in the submission this card belongs to. */
    line?: number;
    endLine?: number;
    /** For kind 'anno' assistant replies: the tutor accepted the student's reasoning. */
    resolved?: boolean;
    at: Date;
}

export interface TutorThreadDoc {
    _id: ObjectId;
    domainId: string;
    ssid: ObjectId;
    pid: number;
    uid: number;
    /** The latest record this thread is tutoring on */
    rid?: ObjectId;
    attemptCount: number;
    messages: TutorMessage[];
    /** Set once, when this student first gets this problem Accepted. */
    firstAcceptedAt?: Date;
    createdAt: Date;
    updateAt: Date;
}

declare module '../service/db' {
    interface Collections {
        'selflearning.tutor': TutorThreadDoc;
    }
}

export const collTutor = db.collection('selflearning.tutor');

/* ------------------- per-student task progression --------------------- */
/*
 * PTA fork: a session presents ONE task at a time, in order. A student's
 * record of which tasks are finished ("done": accepted and the tutor's
 * post-acceptance question answered) or set aside ("skipped": after
 * engaging the tutor and still being stuck). The gate is derived from
 * these sets and the session's pid order — the first pid in neither set
 * is the current task; everything up to it is open, everything after it
 * is locked. Done and skipped tasks stay open for retries.
 */
/**
 * A BONUS TASK generated for this student once every session task has been
 * attempted: an AI Studio draft (id) targeting the student's weak points,
 * materialized as a hidden problem (docId) reachable only through the
 * session. `status` mirrors the draft's pipeline: drafting → building →
 * ready | failed.
 */
export interface SelfLearningBonusEntry {
    id: ObjectId;
    docId?: number;
    pid?: string;
    title?: string;
    status: 'drafting' | 'building' | 'ready' | 'failed';
    message?: string;
    weakPoints: string[];
    createdAt: Date;
    readyAt?: Date;
}

export interface SelfLearningProgressDoc {
    _id: ObjectId;
    domainId: string;
    ssid: ObjectId;
    uid: number;
    done: number[];
    skipped: number[];
    bonuses?: SelfLearningBonusEntry[];
    updateAt: Date;
}

declare module '../service/db' {
    interface Collections {
        'selflearning.progress': SelfLearningProgressDoc;
    }
}

export const collProgress = db.collection('selflearning.progress');

export interface SessionResultRow {
    uid: number;
    uname: string;
    /** Roster real name when known ("firstName lastName"), else ''. */
    name: string;
    /** Per task: the best EFFECTIVE score (late tier applied), its raw score, whether it was late, and the attempt count. */
    scores: Record<string, { score: number, effective: number, late: boolean, attempts: number }>;
    total: number;
    attempts: number;
    done: number;
    skipped: number;
    /** Bonus task: 'none' | 'building' | 'ready' | 'failed' | 'accepted' */
    bonus: string;
}

export interface SessionResults {
    computedAt: Date;
    /** True once computed after the deadline; provisional otherwise. */
    final: boolean;
    maxTotal: number;
    rows: SessionResultRow[];
}

export interface SessionGate {
    /** The task the student should work on now; null when every task is finished or skipped. */
    current: number | null;
    /** The pid after `current` in session order (null at the end). */
    next: number | null;
    /** 1-based position of `current` (total when finished). */
    index: number;
    total: number;
    done: number[];
    skipped: number[];
    /** Pids the student may open: everything up to and including `current`. */
    unlocked: number[];
}

export function computeGate(pids: number[], progress: { done?: number[], skipped?: number[] } | null): SessionGate {
    const done = (progress?.done || []).filter((p) => pids.includes(p));
    const skipped = (progress?.skipped || []).filter((p) => pids.includes(p) && !done.includes(p));
    const finished = new Set([...done, ...skipped]);
    const cur = pids.findIndex((p) => !finished.has(p));
    const current = cur >= 0 ? pids[cur] : null;
    const unlocked = cur >= 0 ? pids.slice(0, cur + 1) : [...pids];
    return {
        current,
        next: cur >= 0 && cur + 1 < pids.length ? pids[cur + 1] : null,
        index: cur >= 0 ? cur + 1 : pids.length,
        total: pids.length,
        done,
        skipped,
        unlocked,
    };
}

export class SelfLearningModel {
    static add(
        domainId: string, owner: number, title: string, content: string, pids: number[],
        extra: Partial<SelfLearningDoc> = {},
    ): Promise<ObjectId> {
        return document.add(
            domainId, content, owner, TYPE_SELF_LEARNING, null, null, null,
            { title, pids, ...extra, createdAt: new Date(), updateAt: new Date() },
        );
    }

    static get(domainId: string, ssid: ObjectId): Promise<SelfLearningDoc> {
        return document.get(domainId, TYPE_SELF_LEARNING, ssid);
    }

    static edit(domainId: string, ssid: ObjectId, $set: Partial<SelfLearningDoc>): Promise<SelfLearningDoc> {
        return document.set(domainId, TYPE_SELF_LEARNING, ssid, { ...$set, updateAt: new Date() });
    }

    static async del(domainId: string, ssid: ObjectId) {
        await Promise.all([
            document.deleteOne(domainId, TYPE_SELF_LEARNING, ssid),
            collTutor.deleteMany({ domainId, ssid }),
        ]);
    }

    static getMulti(domainId: string, query: any = {}) {
        return document.getMulti(domainId, TYPE_SELF_LEARNING, query).sort({ _id: -1 });
    }

    /* ------------------------- AI tutor chat threads ------------------------- */

    static getThread(domainId: string, ssid: ObjectId, pid: number, uid: number) {
        return collTutor.findOne({ domainId, ssid, pid, uid });
    }

    static async ensureThread(domainId: string, ssid: ObjectId, pid: number, uid: number): Promise<TutorThreadDoc> {
        const now = new Date();
        const res = await collTutor.findOneAndUpdate(
            { domainId, ssid, pid, uid },
            { $setOnInsert: { attemptCount: 0, messages: [], createdAt: now, updateAt: now } },
            { upsert: true, returnDocument: 'after' },
        );
        return res as any;
    }

    static async pushMessages(tid: ObjectId, messages: Omit<TutorMessage, 'at'>[], $set: any = {}) {
        const at = new Date();
        await collTutor.updateOne(
            { _id: tid },
            {
                $push: { messages: { $each: messages.map((m) => ({ ...m, at })) } },
                $set: { updateAt: at, ...$set },
            },
        );
    }

    static setThreadFields(tid: ObjectId, $set: any) {
        return collTutor.updateOne({ _id: tid }, { $set: { ...$set, updateAt: new Date() } });
    }

    static async resetThread(domainId: string, ssid: ObjectId, pid: number, uid: number) {
        await collTutor.updateOne(
            { domainId, ssid, pid, uid },
            { $set: { messages: [], attemptCount: 0, updateAt: new Date() }, $unset: { rid: '' } },
        );
    }

    /* ------------------- task progression (see collProgress) ------------------- */

    static async getProgress(domainId: string, ssid: ObjectId, uid: number): Promise<SelfLearningProgressDoc | null> {
        return await collProgress.findOne({ domainId, ssid, uid });
    }

    /** Accepted + the tutor's reflection answered (or no tutor): the task is finished. */
    static async markDone(domainId: string, ssid: ObjectId, uid: number, pid: number) {
        await collProgress.updateOne(
            { domainId, ssid, uid },
            { $addToSet: { done: pid }, $pull: { skipped: pid }, $set: { updateAt: new Date() }, $setOnInsert: { _id: new ObjectId() } },
            { upsert: true },
        );
    }

    /** Set aside after engaging the tutor; never overrides a finished task. */
    static async markSkipped(domainId: string, ssid: ObjectId, uid: number, pid: number) {
        const cur = await collProgress.findOne({ domainId, ssid, uid });
        if (cur?.done?.includes(pid)) return;
        await collProgress.updateOne(
            { domainId, ssid, uid },
            { $addToSet: { skipped: pid }, $set: { updateAt: new Date() }, $setOnInsert: { _id: new ObjectId(), done: [] } },
            { upsert: true },
        );
    }

    static async addBonus(domainId: string, ssid: ObjectId, uid: number, entry: SelfLearningBonusEntry) {
        await collProgress.updateOne(
            { domainId, ssid, uid },
            { $push: { bonuses: entry }, $set: { updateAt: new Date() }, $setOnInsert: { _id: new ObjectId(), done: [], skipped: [] } },
            { upsert: true },
        );
    }

    static async updateBonus(domainId: string, ssid: ObjectId, uid: number, id: ObjectId, patch: Partial<SelfLearningBonusEntry>) {
        const $set: any = { updateAt: new Date() };
        for (const [k, v] of Object.entries(patch)) $set[`bonuses.$.${k}`] = v;
        await collProgress.updateOne({ domainId, ssid, uid, 'bonuses.id': id }, { $set });
    }

    static async apply() {
        await db.ensureIndexes(
            collTutor,
            { name: 'thread', key: { domainId: 1, ssid: 1, pid: 1, uid: 1 }, unique: true },
        );
        await db.ensureIndexes(
            collProgress,
            { name: 'progress', key: { domainId: 1, ssid: 1, uid: 1 }, unique: true },
        );
    }
}

/* ------------------ persisted AI Suggestions reports ------------------ */

export interface AiSuggestionDoc {
    _id: string; // `${domainId}/${pid}/${uid}` — one latest report per user per problem
    domainId: string;
    pid: number;
    uid: number;
    report: string;
    attempts: number;
    updateAt: Date;
}

const collSuggestion = db.collection('ai.suggestion' as any);

export async function getSuggestionReport(domainId: string, pid: number, uid: number): Promise<AiSuggestionDoc | null> {
    return await collSuggestion.findOne({ _id: `${domainId}/${pid}/${uid}` as any }) as any;
}

export async function setSuggestionReport(domainId: string, pid: number, uid: number, report: string, attempts: number): Promise<Date> {
    const updateAt = new Date();
    await collSuggestion.updateOne(
        { _id: `${domainId}/${pid}/${uid}` as any },
        {
            $set: {
                domainId, pid, uid, report, attempts, updateAt,
            },
        },
        { upsert: true },
    );
    return updateAt;
}

export async function getSuggestionReportsIn(domainId: string, pids: number[], uids: number[]): Promise<AiSuggestionDoc[]> {
    if (!pids.length || !uids.length) return [];
    return await collSuggestion.find({ domainId, pid: { $in: pids }, uid: { $in: uids } })
        .limit(200).toArray() as any;
}

export async function getTutorThreadsIn(domainId: string, ssid: ObjectId, pids: number[], uids: number[]) {
    if (!pids.length || !uids.length) return [];
    return await collTutor.find({
        domainId, ssid, pid: { $in: pids }, uid: { $in: uids },
    }).project({ pid: 1, uid: 1, messages: 1, attemptCount: 1 }).limit(500).toArray();
}

/* ------------------- persisted AI class reports (teachers) ------------------- */

export interface AiClassReportDoc {
    _id: string; // `${domainId}/${tid}` — one latest report per activity
    domainId: string;
    tid: string;
    reportAnon: string;
    reportNamed: string;
    sidMap: { s: string, uid: number, uname: string }[];
    /** AI-classified knowledge points: name -> per-problem affected-student counts. */
    concepts: { name: string, problems: Record<string, number>, students: string[] }[];
    statsSnapshot: any;
    participants: number;
    generatedBy: number;
    generatedAt: Date;
}

const collClassReport = db.collection('ai.class_report' as any);

export async function getClassReport(domainId: string, tid: string): Promise<AiClassReportDoc | null> {
    return await collClassReport.findOne({ _id: `${domainId}/${tid}` as any }) as any;
}

export async function setClassReport(doc: Omit<AiClassReportDoc, '_id' | 'generatedAt'>): Promise<Date> {
    const generatedAt = new Date();
    await collClassReport.updateOne(
        { _id: `${doc.domainId}/${doc.tid}` as any },
        { $set: { ...doc, generatedAt } },
        { upsert: true },
    );
    return generatedAt;
}

/* ---------------- subjective (project-level, teacher-graded) tasks ---------------- */

export interface SubjectiveFile {
    name: string;
    size: number;
    target: string; // storage key
    uploadAt: Date;
}

export interface SubjectiveSubmissionDoc {
    _id: string; // `${domainId}/${pid}/${uid}` — the latest submission wins
    domainId: string;
    pid: number;
    uid: number;
    report: string; // markdown
    files: SubjectiveFile[];
    updateAt: Date;
}

const collSubjective = db.collection('subjective.submission' as any);

const subjectiveId = (domainId: string, pid: number, uid: number) => `${domainId}/${pid}/${uid}`;

export async function getSubjective(domainId: string, pid: number, uid: number): Promise<SubjectiveSubmissionDoc | null> {
    return await collSubjective.findOne({ _id: subjectiveId(domainId, pid, uid) as any }) as any;
}

export async function setSubjectiveReport(domainId: string, pid: number, uid: number, report: string): Promise<Date> {
    const updateAt = new Date();
    await collSubjective.updateOne(
        { _id: subjectiveId(domainId, pid, uid) as any },
        { $set: { domainId, pid, uid, report, updateAt }, $setOnInsert: { files: [] } },
        { upsert: true },
    );
    return updateAt;
}

export async function upsertSubjectiveFile(domainId: string, pid: number, uid: number, file: SubjectiveFile): Promise<void> {
    const _id = subjectiveId(domainId, pid, uid) as any;
    await collSubjective.updateOne(
        { _id },
        { $setOnInsert: { domainId, pid, uid, report: '' }, $set: { updateAt: new Date() } },
        { upsert: true },
    );
    await collSubjective.updateOne({ _id }, { $pull: { files: { name: file.name } } as any });
    await collSubjective.updateOne({ _id }, { $push: { files: file } as any });
}

export async function removeSubjectiveFile(domainId: string, pid: number, uid: number, name: string): Promise<void> {
    await collSubjective.updateOne(
        { _id: subjectiveId(domainId, pid, uid) as any },
        { $pull: { files: { name } } as any, $set: { updateAt: new Date() } },
    );
}

export async function listSubjective(domainId: string, pid: number): Promise<SubjectiveSubmissionDoc[]> {
    return await collSubjective.find({ domainId, pid }).sort({ updateAt: -1 }).limit(500).toArray() as any;
}

export default SelfLearningModel;

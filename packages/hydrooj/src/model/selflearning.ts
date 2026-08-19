import { ObjectId } from 'mongodb';
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
    createdAt: Date;
    updateAt: Date;
}

declare module '../service/db' {
    interface Collections {
        'selflearning.tutor': TutorThreadDoc;
    }
}

export const collTutor = db.collection('selflearning.tutor');

export class SelfLearningModel {
    static add(domainId: string, owner: number, title: string, content: string, pids: number[]): Promise<ObjectId> {
        return document.add(
            domainId, content, owner, TYPE_SELF_LEARNING, null, null, null,
            { title, pids, createdAt: new Date(), updateAt: new Date() },
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

    static async resetThread(domainId: string, ssid: ObjectId, pid: number, uid: number) {
        await collTutor.updateOne(
            { domainId, ssid, pid, uid },
            { $set: { messages: [], attemptCount: 0, updateAt: new Date() }, $unset: { rid: '' } },
        );
    }

    static async apply() {
        await db.ensureIndexes(
            collTutor,
            { name: 'thread', key: { domainId: 1, ssid: 1, pid: 1, uid: 1 }, unique: true },
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

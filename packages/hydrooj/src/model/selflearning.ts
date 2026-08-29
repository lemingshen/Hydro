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
    /** Set once, when this student first gets this problem Accepted (spark counters key off it). */
    firstAcceptedAt?: Date;
    /** Boss Challenge state for this student on this problem. */
    challenge?: {
        state: 'active' | 'cleared' | 'declined';
        title?: string;
        question?: string;
        hook?: string;
        rid?: ObjectId;
        clearedAt?: Date;
    };
    createdAt: Date;
    updateAt: Date;
}

declare module '../service/db' {
    interface Collections {
        'selflearning.tutor': TutorThreadDoc;
    }
}

export const collTutor = db.collection('selflearning.tutor');

/* --------------------- Tutor Spark: momentum & badges ---------------------- */
/*
 * Lightweight motivation layer for the AI tutor: a per-student momentum doc
 * (daily streak + achievement counters) and a fixed badge catalog. Counters
 * are only ever bumped from the tutor handlers, so everything derives from
 * activity the tutor actually witnessed. Deliberately per-student and
 * non-competitive: the class-report anonymization ethos extends here — spark
 * celebrates the student's OWN momentum, never ranks them against others.
 */

export interface SparkDoc {
    domainId: string;
    uid: number;
    /** Consecutive calendar days (server-local) with tutor-visible activity. */
    streak: number;
    lastDay: string;
    /** Problems brought to Accepted (first accept per problem thread). */
    accepted: number;
    /** Accepted on attempt #1. */
    cleanSolves: number;
    /** Accepted after three or more failed attempts. */
    comebacks: number;
    /** Answers typed into tutor question cards (incl. Boss Challenge turns). */
    cardAnswers: number;
    challengesCleared: number;
    badges: string[];
    updateAt: Date;
}

declare module '../service/db' {
    interface Collections {
        'selflearning.spark': SparkDoc;
    }
}

export const collSpark = db.collection('selflearning.spark');

export interface SparkBadge {
    id: string;
    icon: string;
    title: string;
    desc: string;
    test: (s: SparkDoc) => boolean;
}

export const SPARK_BADGES: SparkBadge[] = [
    { id: 'first-light', icon: '🌱', title: 'First Light', desc: 'Get your first problem Accepted.', test: (s) => s.accepted >= 1 },
    { id: 'hat-trick', icon: '🎩', title: 'Hat Trick', desc: 'Bring three problems to Accepted.', test: (s) => s.accepted >= 3 },
    { id: 'rising-star', icon: '🌟', title: 'Rising Star', desc: 'Bring ten problems to Accepted.', test: (s) => s.accepted >= 10 },
    { id: 'problem-crusher', icon: '🚀', title: 'Problem Crusher', desc: 'Bring twenty-five problems to Accepted.', test: (s) => s.accepted >= 25 },
    { id: 'clean-strike', icon: '🎯', title: 'Clean Strike', desc: 'Solve a problem on your very first attempt.', test: (s) => s.cleanSolves >= 1 },
    { id: 'comeback-kid', icon: '💪', title: 'Comeback Kid', desc: 'Get Accepted after three or more failed attempts. Persistence wins.', test: (s) => s.comebacks >= 1 },
    { id: 'bug-whisperer', icon: '🐛', title: 'Bug Whisperer', desc: 'Answer ten tutor questions at your code.', test: (s) => s.cardAnswers >= 10 },
    { id: 'deep-thinker', icon: '🧠', title: 'Deep Thinker', desc: 'Answer thirty tutor questions. Thinking out loud works.', test: (s) => s.cardAnswers >= 30 },
    { id: 'on-fire', icon: '🔥', title: 'On Fire', desc: 'Practice three days in a row.', test: (s) => s.streak >= 3 },
    { id: 'unstoppable', icon: '🌋', title: 'Unstoppable', desc: 'Practice seven days in a row.', test: (s) => s.streak >= 7 },
    { id: 'challenger', icon: '⚔️', title: 'Challenger', desc: 'Clear your first Boss Challenge.', test: (s) => s.challengesCleared >= 1 },
    { id: 'boss-slayer', icon: '👑', title: 'Boss Slayer', desc: 'Clear five Boss Challenges.', test: (s) => s.challengesCleared >= 5 },
];

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

    /* ------------------------------ Tutor Spark ------------------------------ */

    static sparkDay(d = new Date()): string {
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    static async getSpark(domainId: string, uid: number): Promise<SparkDoc> {
        const s = await collSpark.findOne({ domainId, uid });
        return s || {
            domainId, uid, streak: 0, lastDay: '', accepted: 0, cleanSolves: 0, comebacks: 0, cardAnswers: 0, challengesCleared: 0, badges: [], updateAt: new Date(),
        };
    }

    /**
     * Register tutor-visible activity: advance the daily streak, apply the
     * counter increments, and award any badge whose condition just became
     * true. Returns the fresh doc plus the badges earned by THIS call so the
     * client can celebrate exactly once.
     */
    static async touchSpark(domainId: string, uid: number, inc: Partial<Record<'accepted' | 'cleanSolves' | 'comebacks' | 'cardAnswers' | 'challengesCleared', number>> = {}) {
        const now = new Date();
        const today = SelfLearningModel.sparkDay(now);
        const s = await SelfLearningModel.getSpark(domainId, uid);
        if (s.lastDay !== today) {
            const yesterday = SelfLearningModel.sparkDay(new Date(now.getTime() - 86400000));
            s.streak = s.lastDay === yesterday ? (s.streak || 0) + 1 : 1;
            s.lastDay = today;
        }
        for (const [k, v] of Object.entries(inc)) if (v) (s as any)[k] = ((s as any)[k] || 0) + v;
        const owned = new Set(s.badges || []);
        const newBadges = SPARK_BADGES.filter((b) => !owned.has(b.id) && b.test(s));
        if (newBadges.length) s.badges = [...(s.badges || []), ...newBadges.map((b) => b.id)];
        s.updateAt = now;
        const { domainId: d, uid: u, ...rest } = s as any;
        delete rest._id;
        await collSpark.updateOne({ domainId, uid }, { $set: rest }, { upsert: true });
        return { spark: s, newBadges };
    }

    /** The public badge catalog (no test functions) for client rendering. */
    static badgeCatalog() {
        return SPARK_BADGES.map(({ id, icon, title, desc }) => ({ id, icon, title, desc }));
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

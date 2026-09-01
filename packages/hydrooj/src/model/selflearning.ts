import { ObjectId } from 'mongodb';
import type { PenaltyRules } from '../interface';
import db from '../service/db';
import * as document from './document';

export const TYPE_SELF_LEARNING = 75 as const;

export interface SelfLearningDoc {
    /**
     * 📊 Manual-evaluation background job (handler postRecompute): the
     * evaluation OUTLIVES the HTTP request, so refreshing the page or
     * re-logging in never cancels it — a reloaded page re-attaches to this
     * state, and the status poll (postEvalStatus) reads it. A 'running'
     * job older than the handler's EVAL_JOB_STALE_MS is treated as crashed
     * and may be restarted.
     */
    evalJob?: {
        state: 'running' | 'done' | 'failed',
        startedAt: Date,
        finishedAt?: Date,
        error?: string,
        /**
         * Live progress of the retroactive grading (who is being judged
         * right now), written by the manual job and shown on the teacher's
         * progress card; the final 'done' write keeps the summary counts.
         */
        progress?: {
            uid?: number, uname?: string, pid?: number | string, done?: number, total?: number, graded?: number, failed?: number,
        },
    };
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
    /**
     * 🎓 CODE-OWNERSHIP grade of a student's POST-ACCEPTANCE 'anno' answer,
     * LLM-judged 0..4 (see handler/self_learning.ts ownershipOf). Shown to
     * the student as immediate per-answer feedback (reply body + mapMsg
     * replay) and to teachers via the score board's hover breakdown; the
     * SESSION total remains embargoed until release.
     */
    level?: number;
    /**
     * 🧩 REASONING-QUALITY grade of a student's PRE-ACCEPTANCE 'anno'
     * answer, LLM-judged 0..4 (thinking vs guessing) — the failure-phase
     * counterpart of `level`. Live-graded (dialogue call) and backfilled
     * for legacy histories.
     */
    rlevel?: number;
    at: Date;
}

/** One post-acceptance ownership question and the grades of its answers. */
export interface OwnershipQuestion {
    /** The question text (doubles as the dedup key against the asked list). */
    question: string;
    line?: number;
    at: Date;
    /**
     * LLM level (0..4) of every student response to this question, in order.
     * Empty = asked but never answered — the evaluation counts that as one
     * level-0 response (evasion).
     */
    levels: number[];
    /**
     * Normalized keys of the answers already graded for this question —
     * replaying an identical answer must not push its level again (mean
     * inflation); the handler also caps levels per question.
     */
    answerKeys?: string[];
}

/**
 * 🎓 The per-task CODE-OWNERSHIP walkthrough state, created the moment the
 * task's FIRST accepted submission reaches the tutor. The question budget
 * is fixed then and never re-rolled: 5..6 questions when that acceptance
 * was the very first attempt, 2..3 otherwise (handler ownershipBudget).
 */
export interface OwnershipState {
    /**
     * 1-based attempt number of the FIRST acceptance, where an attempt is
     * any judged, non-pretest submission on the task from any surface
     * (handler classifyFirstAcceptance). 1 = accepted on the very first
     * try — the 5..6-question budget.
     */
    acceptedAttempt: number;
    minQ: number;
    maxQ: number;
    /** True once the walkthrough closed (budget reached, or the model ran out past minQ). */
    done?: boolean;
    questions: OwnershipQuestion[];
}

/**
 * 🔧 One judged GUIDANCE→FIX transition: the student answered tutor
 * questions on a FAILED attempt and then resubmitted; the LLM compared the
 * two codes against the targeted flaw. trial = 1-based position among the
 * task's qualifying transitions (drives the 1 → 0.8 → 0.6 → 0.5 penalty).
 * A dangling engagement with no next submission is never stored — per the
 * rubric, it does not count.
 */
export interface FixConvTransition {
    fromRid: ObjectId;
    toRid: ObjectId;
    trial: number;
    /** LLM level 0..4 (0 region untouched … 4 minimal targeted fix). */
    level: number;
    /** How many tutor questions were answered in the window. */
    asked: number;
    at: Date;
}

/** 🔧 Per-task Guidance-to-Fix-Conversion state (graded at evaluation time). */
export interface FixConvState {
    transitions: FixConvTransition[];
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
    /** 🎓 Post-acceptance ownership walkthrough (absent until the first acceptance). */
    ownership?: OwnershipState;
    /** 🔧 Guidance→fix transitions judged so far (absent until the first evaluation grades one). */
    fixconv?: FixConvState;
    /**
     * 🧠 Knowledge points SURFACED as this student's misconception in the
     * PRE-ACCEPTANCE tutoring of this task (LLM-extracted once by the
     * evaluation; the dialogue is frozen after acceptance, so so is this).
     * Empty names = extracted, nothing surfaced.
     */
    surfacedKp?: { names: string[], extractedAt: Date };
    /**
     * 🧩 Reasoning-quality levels of this task's failure-phase answers,
     * with normalized answer keys for replay dedupe (anti-inflation).
     */
    reasoning?: { levels: number[], answerKeys?: string[] };
    /**
     * 💡 SELF-DIAGNOSTIC INITIATIVE of this task's FIRST engagement:
     * did the student show up with a theory, or wait to be led? One
     * LLM-graded level 0..4, judged once the first-engagement window
     * closed (first acceptance, parking, or session end).
     */
    initiative?: { level: number, at: Date };
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

/**
 * 🧠 One CONCEPT-TRANSFER assessment: concept C first surfaced (in
 * failure tutoring) AND resolved at fromPid, then judged 0..4 at the FIRST
 * chronological re-encounter toPid (a task tagged with C). One per
 * concept; graded by the evaluation backfill.
 */
export interface TransferAssessment {
    /** Canonical knowledge-point name (the concept C). */
    concept: string;
    fromPid: number;
    toPid: number;
    /** 0 relapse-unrecognized … 4 correct, unprompted, with awareness. */
    level: number;
    at: Date;
}

export interface SelfLearningProgressDoc {
    _id: ObjectId;
    domainId: string;
    ssid: ObjectId;
    uid: number;
    done: number[];
    skipped: number[];
    bonuses?: SelfLearningBonusEntry[];
    /** 🧠 Cross-problem concept-transfer assessments (evaluation-graded). */
    transfer?: { assessments: TransferAssessment[] };
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
    /**
     * 🏆 The ACHIEVEMENT rubric component: the programming tasks' summed
     * effective score mapped onto SESSION_ACHIEVEMENT_MAX (20). Rows stored
     * by builds before this component existed lack the field — the table
     * and the CSV render those as empty until the session is re-evaluated.
     */
    achievement?: number;
    /**
     * 🎓 The CODE-OWNERSHIP rubric component: mean LLM-graded level (0..4)
     * of the student's post-acceptance explanations, mapped onto
     * SESSION_OWNERSHIP_MAX (10). null = NOT MEASURED (no walkthrough
     * answers recorded anywhere — e.g. every acceptance predates the
     * rubric); renders as "—" and adds 0 to the total. A stored 0 means
     * measured and graded 0. Absent entirely on rows from older builds.
     */
    ownership?: number | null;
    /**
     * 🔧 The GUIDANCE-TO-FIX-CONVERSION rubric component: penalty-weighted
     * mean level (0..4) of judged guidance→fix transitions on failed
     * attempts, mapped onto SESSION_FIXCONV_MAX (15). null = nothing to
     * judge yet (renders as —); absent on rows from older builds.
     */
    fixConv?: number | null;
    /**
     * 📈 The INDEPENDENCE-TRAJECTORY rubric component: does the student
     * need less tutor help across the session? Class-percentile based,
     * max(level, improvement), mapped onto SESSION_TRAJECTORY_MAX (10).
     * null = not engaged anywhere; absent on rows from older builds.
     */
    trajectory?: number | null;
    /** 📈 The breakdown behind trajectory, for the teacher's hover pop-up. */
    trajectoryInfo?: {
        level: number,
        improvement: number,
        slope: number | null,
        points: { pid: number, pos: number, idx: number, pct: number }[],
    };
    /**
     * 🧠 The CONCEPT-TRANSFER rubric component: does a lesson learned on
     * one task carry to the next task exercising the same knowledge point?
     * mean(level 0..4) × 3.75 onto SESSION_TRANSFER_MAX (15); null =
     * nothing testable yet; absent on rows from older builds.
     */
    transfer?: number | null;
    /**
     * 🧩 The REASONING-QUALITY rubric component: thinking-not-guessing in
     * failure-phase answers, mean(level 0..4) × 6.25 onto
     * SESSION_REASONING_MAX (25); null = no failure answers graded yet;
     * absent on rows from older builds.
     */
    reasoning?: number | null;
    /**
     * 💡 The SELF-DIAGNOSTIC-INITIATIVE rubric component: showing up
     * with a theory vs waiting to be led, one level per task's first
     * engagement, mean × 1.25 onto SESSION_INITIATIVE_MAX (5); null =
     * nothing judged yet; absent on rows from older builds.
     */
    initiative?: number | null;
    /**
     * ⭐ One rubric composite per programming task (first-attempt tasks:
     * 🏆 40 + 🎓 60; others: the seven components with session-level
     * Trajectory/Transfer injected; unattempted: 0). The row total is the
     * mean of these scores. Absent on rows from older builds.
     */
    taskScores?: {
        pid: number,
        attempted: boolean,
        firstAttempt: boolean,
        score: number,
        parts: { key: string, max: number, value: number, pending?: boolean }[],
    }[];
    /**
     * 🧠 Why the transfer value is what it is: 'assessed' (real),
     * 'pending' (testable, not yet graded — charged 0), 'untestable'
     * (no re-encounter possible — the slot is removed and standard tasks
     * renormalize ×100/85). Absent on rows from older builds.
     */
    transferState?: 'assessed' | 'pending' | 'untestable';
    /** ⭐ Count of first-attempt tasks (each scored 40 + 60); display applicability. */
    faTasks?: number;
    /** Count of attempted non-first-attempt tasks; 0 ⇒ the five mistake components read n/a. */
    stdTasks?: number;
    /** The session total, out of SESSION_TOTAL_MAX (100): the sum of the rubric components. */
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
    /** The session grade scale (SESSION_TOTAL_MAX, 100). */
    maxTotal: number;
    /** The Achievement component's scale (SESSION_ACHIEVEMENT_MAX, 20); absent on results stored by older builds. */
    achievementMax?: number;
    /** The Ownership component's scale (SESSION_OWNERSHIP_MAX, 10); absent on results stored by older builds. */
    ownershipMax?: number;
    /** The Fix-Conversion component's scale (SESSION_FIXCONV_MAX, 15); absent on results stored by older builds. */
    fixConvMax?: number;
    /** The Trajectory component's scale (SESSION_TRAJECTORY_MAX, 10); absent on results stored by older builds. */
    trajectoryMax?: number;
    /** The Concept-Transfer component's scale (SESSION_TRANSFER_MAX, 15); absent on results stored by older builds. */
    transferMax?: number;
    /** The Reasoning-Quality component's scale (SESSION_REASONING_MAX, 25); absent on results stored by older builds. */
    reasoningMax?: number;
    /** The Self-Diagnostic-Initiative component's scale (SESSION_INITIATIVE_MAX, 5); absent on results stored by older builds. */
    initiativeMax?: number;
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

    /* ------------------ 🎓 code-ownership walkthrough state ------------------ */

    /** Fix the walkthrough budget at the task's first acceptance (idempotent per thread). */
    static initOwnership(tid: ObjectId, ownership: OwnershipState) {
        return collTutor.updateOne(
            { _id: tid, ownership: { $exists: false } },
            { $set: { ownership, updateAt: new Date() } },
        );
    }

    static pushOwnershipQuestion(tid: ObjectId, q: OwnershipQuestion) {
        return collTutor.updateOne(
            { _id: tid },
            { $push: { 'ownership.questions': q }, $set: { updateAt: new Date() } },
        );
    }

    /**
     * Append one graded answer level (0..4) to the matching asked question.
     * Matching by STORED question text is deliberate: an answer to a
     * question the tutor never asked can never land in the rubric. The
     * answerKey records which (normalized) answers were graded, so the
     * handler can refuse to re-grade a replayed identical answer.
     */
    static pushOwnershipLevel(tid: ObjectId, question: string, level: number, answerKey: string) {
        return collTutor.updateOne(
            { _id: tid, 'ownership.questions.question': question },
            { $push: { 'ownership.questions.$.levels': level, 'ownership.questions.$.answerKeys': answerKey }, $set: { updateAt: new Date() } },
        );
    }

    /** 🎓 Retro-grade bookkeeping: stamp the LLM level onto one stored message. */
    static setMessageLevel(tid: ObjectId, index: number, level: number) {
        return collTutor.updateOne({ _id: tid }, { $set: { [`messages.${index}.level`]: level, updateAt: new Date() } });
    }

    /** 🔧 Record one judged guidance→fix transition (evaluation backfill). */
    static pushFixConvTransition(tid: ObjectId, t: FixConvTransition) {
        return collTutor.updateOne(
            { _id: tid },
            { $push: { 'fixconv.transitions': t }, $set: { updateAt: new Date() } },
        );
    }

    /** 🔧 Reconcile a stored transition's derived trial number with the current chain rule. */
    static setFixConvTrial(tid: ObjectId, toRid: ObjectId, trial: number) {
        return collTutor.updateOne(
            { _id: tid, 'fixconv.transitions.toRid': toRid },
            { $set: { 'fixconv.transitions.$.trial': trial, updateAt: new Date() } },
        );
    }

    /** 🧠 Record the concepts surfaced in a thread's pre-acceptance tutoring. */
    static setSurfacedKp(tid: ObjectId, names: string[]) {
        return collTutor.updateOne(
            { _id: tid },
            { $set: { surfacedKp: { names, extractedAt: new Date() }, updateAt: new Date() } },
        );
    }

    /** 🧠 Append one concept-transfer assessment to the student's session progress. */
    static pushTransferAssessment(domainId: string, ssid: ObjectId, uid: number, a: TransferAssessment) {
        return collProgress.updateOne(
            { domainId, ssid, uid },
            {
                $push: { 'transfer.assessments': a },
                $setOnInsert: { done: [], skipped: [] },
                $set: { updateAt: new Date() },
            },
            { upsert: true },
        );
    }

    /** 🧩 Append one failure-phase reasoning level (dedup key alongside). */
    static pushReasoningLevel(tid: ObjectId, level: number, answerKey: string) {
        return collTutor.updateOne(
            { _id: tid },
            { $push: { 'reasoning.levels': level, 'reasoning.answerKeys': answerKey }, $set: { updateAt: new Date() } },
        );
    }

    /** 🧩 Retro-grade bookkeeping: stamp the reasoning level onto one stored message. */
    static setMessageRlevel(tid: ObjectId, index: number, level: number) {
        return collTutor.updateOne({ _id: tid }, { $set: { [`messages.${index}.rlevel`]: level, updateAt: new Date() } });
    }

    /** 💡 Record the one-per-task initiative level (first engagement). */
    static setInitiative(tid: ObjectId, level: number) {
        return collTutor.updateOne(
            { _id: tid },
            { $set: { initiative: { level, at: new Date() }, updateAt: new Date() } },
        );
    }

    /** ⭐ Raise a thread's stored walkthrough budget to the current policy; optionally reopen a walkthrough closed under the smaller budget. */
    static updateOwnershipBudget(tid: ObjectId, min: number, max: number, reopen: boolean) {
        const $set: any = { 'ownership.minQ': min, 'ownership.maxQ': max, updateAt: new Date() };
        if (reopen) $set['ownership.done'] = false;
        return collTutor.updateOne({ _id: tid }, { $set });
    }

    static setOwnershipDone(tid: ObjectId) {
        return collTutor.updateOne({ _id: tid }, { $set: { 'ownership.done': true, updateAt: new Date() } });
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

/**
 * 🎓 Lean ownership-only fetch for the evaluation (whole session) and the
 * student's own score card (uid given): every thread's walkthrough state
 * without the message bodies.
 */
/** Every tutor thread of a session, messages included — the evaluation's retroactive grading reads these. */
export async function getSessionThreads(domainId: string, ssid: ObjectId): Promise<TutorThreadDoc[]> {
    return await collTutor.find({ domainId, ssid }).toArray() as any;
}

/** Rubric states per (uid, pid): the ownership walkthrough AND the fix-conversion transitions. */
export async function getOwnershipIn(domainId: string, ssid: ObjectId, uid?: number): Promise<{ uid: number, pid: number, ownership?: OwnershipState, fixconv?: FixConvState, surfacedKp?: { names: string[] }, reasoning?: { levels: number[], answerKeys?: string[] }, initiative?: { level: number } }[]> {
    const filter: any = { domainId, ssid, ownership: { $exists: true } };
    if (typeof uid === 'number') filter.uid = uid;
    return await collTutor.find(filter).project({ uid: 1, pid: 1, ownership: 1, fixconv: 1, surfacedKp: 1, reasoning: 1, initiative: 1 }).limit(5000).toArray() as any;
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

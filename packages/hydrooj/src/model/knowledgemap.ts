/**
 * PTA fork — the PERSONAL KNOWLEDGE MAP store (model side).
 *
 * One document per (domain, student): every knowledge point of the domain
 * catalog with the student's MASTERY STATE on it, the evidence that state
 * was derived from, and the ranked "what to practise next" list.
 *
 * ⚠ DERIVED, NEVER AUTHORITATIVE. Nothing here is a source of truth: every
 * field is recomputed from records, tutor threads, session progress and the
 * catalog by lib/knowledge_map.ts. A bug in the derivation is fixed by
 * bumping MASTERY_VERSION and recomputing — never by hand-editing a stored
 * map. That is also why the map is a CACHE with a version stamp rather than
 * an incrementally-updated aggregate: an aggregate that drifts cannot be
 * repaired, and this one spans four collections.
 *
 * The second collection here (`knowledge.attribution`) is the LLM cache.
 * Attribution is the expensive half of the map — for work done OUTSIDE a
 * self-learning session there is no tutor dialogue to mine, so a model has
 * to read the failing code and say WHICH of the task's knowledge points the
 * failure was actually about. That answer depends only on (task, code), so
 * it is cached on a hash of exactly those and never recomputed, including
 * across map rebuilds and MASTERY_VERSION bumps.
 */
import { ObjectId } from 'mongodb';
import db from '../service/db';

/**
 * Bump whenever the evidence set, the weights or the state thresholds
 * change: a stored map with another version is ignored on sight and
 * rebuilt, exactly like SESSION_RUBRIC_VERSION in handler/self_learning.ts.
 */
export const MASTERY_VERSION = 1;

/**
 * The five states a knowledge point can be in for one student.
 *
 * Deliberately NOT a single 0-100 score. A scalar looks precise, is not
 * (most points carry two or three pieces of evidence), and cannot be
 * explained to the student it is shown to. A state plus a separate
 * CONFIDENCE says the honest thing: "we think this is shaky, and here is
 * how sure we are".
 *
 *   untouched  no task carrying this point has been attempted
 *   exposed    attempted, but nothing yet says mastered or not
 *   shaky      surfaced as a misconception, or repeatedly failed
 *   resolving  was shaky and has since been solved, but not re-tested
 *   mastered   independent evidence: transfer, or clean first-try solves
 */
export type MasteryState = 'untouched' | 'exposed' | 'shaky' | 'resolving' | 'mastered';

/** Where one piece of evidence came from. Kept on the doc so the UI can explain itself. */
export type EvidenceKind =
    | 'first_try'        // accepted at the first attempt on a task carrying the point
    | 'solved'           // accepted, but not first try
    | 'unsolved'         // attempted repeatedly, never accepted
    | 'surfaced'         // 🧠 tutor named this point as the student's own misconception
    | 'transfer_ok'      // 🧠 re-encounter of the concept went well (level >= 3)
    | 'transfer_fail'    // 🧠 re-encounter relapsed (level <= 1)
    | 'ownership'        // 🎓 post-acceptance walkthrough level on a carrying task
    | 'reasoning'        // 🧩 failure-phase reasoning level on a carrying task
    | 'attributed'       // 🤖 LLM attributed a failure outside self-learning to this point
    | 'quiz_ok' // ⚡ a question of a finished test carrying the point, answered correctly
    | 'quiz_fail'; // ⚡ ... answered wrongly or left blank

export interface MasteryEvidence {
    kind: EvidenceKind;
    /** +1 supports mastery, -1 argues against it. */
    polarity: 1 | -1;
    /** Post-decay contribution to the point's totals. */
    weight: number;
    /** The task this came from, when it came from one. */
    pid?: number;
    /** Display label of that task (pid string, e.g. "P1042"). */
    label?: string;
    at?: Date;
    /** One short human-readable line; shown in the "why" popover. */
    note?: string;
}

export interface MasteryPoint {
    /** Canonical catalog name — the tag written on tasks. */
    name: string;
    /** Ancestor names, root first: ["Control flow", "Loops"]. Display only. */
    path: string[];
    depth: number;
    state: MasteryState;
    /**
     * positive / (positive + negative), or null when there is no evidence
     * at all. NOT a percentage of anything the student did — it is the
     * balance of evidence, which is why it always ships with `confidence`.
     */
    mastery: number | null;
    /** 0..1 — how much evidence backs the state. Low confidence = weak claim. */
    confidence: number;
    positive: number;
    negative: number;
    /** Most recent evidence timestamp; drives the staleness hint. */
    lastAt?: Date;
    /** Task counts for THIS point and everything under it (tree rollup). */
    tasks: { total: number, attempted: number, solved: number, firstTry: number };
    /** Trimmed to the most informative few — the doc must stay small. */
    evidence: MasteryEvidence[];
    /** True when this point's numbers include descendants' evidence. */
    rolled?: boolean;
}

/** One entry of the ranked "practise this next" list. */
export interface MasteryNext {
    name: string;
    path: string[];
    /** Why it is being recommended, already phrased for a student. */
    reason: string;
    priority: number;
    state: MasteryState;
    confidence: number;
    /** Unsolved tasks in the domain that carry this point — the actionable part. */
    tasks: { docId: number, pid: string, title: string, difficulty?: number }[];
}

export interface KnowledgeMasteryDoc {
    _id: ObjectId;
    domainId: string;
    uid: number;
    version: number;
    /**
     * When the derivation STARTED, not when it finished. Evidence written
     * after this instant is not guaranteed to be in the map, so this is the
     * honest watermark to compare `dirtyAt` against.
     */
    computedAt: Date;
    /**
     * Last moment something happened that this map does not reflect — set
     * by the record/judge listener the instant a submission is judged.
     *
     * A TIMESTAMP rather than a boolean on purpose. With a boolean, a
     * submission landing WHILE a rebuild is in flight would be cleared by
     * that rebuild's write even though the rebuild never saw it, and the
     * map would go stale with nothing left to say so. Comparing
     * `dirtyAt > computedAt` cannot lose an update: the rebuild only ever
     * moves `computedAt` to the time it began.
     */
    dirtyAt?: Date;
    /** Milliseconds the derivation took — surfaced in the teacher view. */
    tookMs?: number;
    points: MasteryPoint[];
    next: MasteryNext[];
    /**
     * Built without LLM attribution while attribution work was outstanding
     * — a cheap background rebuild after a submission. The viewer treats a
     * partial map as due for a full rebuild even when `computedAt` is
     * recent, which is what keeps the background path from silently
     * starving the attribution path.
     */
    partial?: boolean;
    stats: {
        catalog: number;
        untouched: number;
        exposed: number;
        shaky: number;
        resolving: number;
        mastered: number;
        /** How many points had any evidence at all — the map's coverage. */
        covered: number;
        /** Of the covered ones, how many rest on tutor-grade evidence. */
        strong: number;
        /** LLM attribution calls made during this build (0 when fully cached). */
        llmCalls: number;
        /** Attribution candidates a `noLlm` build left unresolved. */
        llmPending?: number;
    };
}

/* ------------------------------------------------------------------ */
/*  🤖 The student assistant's memory                                  */
/* ------------------------------------------------------------------ */
/**
 * One conversation per student per domain — persisted so a thread started
 * on the problem set continues on a task page. Trimmed to the newest
 * THREAD_KEEP messages on every write.
 */
export interface AssistantMessage {
    role: 'user' | 'assistant';
    content: string;
    at: Date;
    /** Where the student was when they said it (pagename / pid / tid). */
    page?: { name?: string, pid?: number, tid?: string };
    /** Tool names the assistant used to answer — shown as small chips. */
    tools?: string[];
}

export interface AssistantThreadDoc {
    _id: ObjectId;
    domainId: string;
    uid: number;
    messages: AssistantMessage[];
    /** Per-day turn counter for the cost cap: { 'YYYY-MM-DD': n }. */
    turns: Record<string, number>;
    /**
     * A rolling 2-3 sentence recap of the conversation BEFORE the messages
     * the prompt still sees, refreshed every few turns (lib/assistant.ts
     * distill). This is what lets the assistant say "last week we worked
     * on X" after the messages themselves have scrolled out of the window.
     */
    summary?: string;
    /** How many messages the thread had when `summary` was written. */
    summarizedAt?: number;
    updateAt: Date;
}

/**
 * What the assistant knows about a student beyond the derived data. Three
 * layers with provenance, each shown to (and correctable by) the student:
 *  declared — set by the student, never inferred
 *  goals    — stated targets with an optional date
 *  learned  — the assistant's own conclusions from conversation, dated
 */
export interface AssistantProfileDoc {
    _id: ObjectId;
    domainId: string;
    uid: number;
    declared: {
        style?: 'examples' | 'theory';
        length?: 'short' | 'thorough';
        tone?: 'encouraging' | 'direct';
    };
    goals: { text: string, by?: Date, at: Date }[];
    learned: { fact: string, source: 'chat' | 'probe', at: Date }[];
    updateAt: Date;
}

export const THREAD_KEEP = 40;

declare module '../service/db' {
    interface Collections {
        'knowledge.mastery': KnowledgeMasteryDoc;
        'knowledge.attribution': KnowledgeAttributionDoc;
        'assistant.thread': AssistantThreadDoc;
        'assistant.profile': AssistantProfileDoc;
    }
}

export const collThread = db.collection('assistant.thread');
export const collProfile = db.collection('assistant.profile');

export async function getThread(domainId: string, uid: number): Promise<AssistantThreadDoc | null> {
    return await collThread.findOne({ domainId, uid });
}

/** Append messages, trim to THREAD_KEEP, bump today's turn counter. Returns the new thread. */
export async function appendThread(domainId: string, uid: number, msgs: AssistantMessage[], countTurn: boolean): Promise<AssistantThreadDoc> {
    const day = new Date().toISOString().slice(0, 10);
    const res = await collThread.findOneAndUpdate(
        { domainId, uid },
        {
            $push: { messages: { $each: msgs, $slice: -THREAD_KEEP } },
            $set: { updateAt: new Date() },
            // No `turns: {}` here: MongoDB refuses to set `turns` and $inc
            // `turns.<day>` in the same update ("would create a conflict at
            // 'turns'"), and $inc creates the sub-document itself on insert.
            $setOnInsert: { _id: new ObjectId() },
            ...(countTurn ? { $inc: { [`turns.${day}`]: 1 } } : {}),
        },
        { upsert: true, returnDocument: 'after' },
    );
    return res as any;
}

export async function resetThread(domainId: string, uid: number): Promise<void> {
    await collThread.updateOne({ domainId, uid }, { $set: { messages: [], summary: '', summarizedAt: 0, updateAt: new Date() } });
}

export async function setThreadSummary(domainId: string, uid: number, summary: string, summarizedAt: number): Promise<void> {
    await collThread.updateOne({ domainId, uid }, { $set: { summary: summary.slice(0, 1200), summarizedAt } });
}

export async function getProfile(domainId: string, uid: number): Promise<AssistantProfileDoc> {
    return (await collProfile.findOne({ domainId, uid })) || {
        _id: new ObjectId(), domainId, uid, declared: {}, goals: [], learned: [], updateAt: new Date(),
    };
}

export async function saveProfile(domainId: string, uid: number, patch: Partial<Pick<AssistantProfileDoc, 'declared' | 'goals' | 'learned'>>): Promise<void> {
    await collProfile.updateOne(
        { domainId, uid },
        { $set: { ...patch, updateAt: new Date() }, $setOnInsert: { _id: new ObjectId() } },
        { upsert: true },
    );
}

export const collMastery = db.collection('knowledge.mastery');

/**
 * 🤖 One cached LLM attribution: for this student's failing submission on
 * this task, which of the task's knowledge points was the failure about.
 *
 * `_id` is deterministic (`domainId/uid/pid/hash`) so a rebuild re-derives
 * the same key and hits the cache instead of paying for the call again.
 * `hash` covers the code AND the point list — relabel the task and the
 * attribution is correctly recomputed.
 */
export interface KnowledgeAttributionDoc {
    _id: string;
    domainId: string;
    uid: number;
    pid: number;
    hash: string;
    /** Canonical point names the model blamed. Empty = no specific gap found. */
    names: string[];
    at: Date;
}

export const collAttribution = db.collection('knowledge.attribution');

export async function getMap(domainId: string, uid: number): Promise<KnowledgeMasteryDoc | null> {
    return await collMastery.findOne({ domainId, uid });
}

/** Fresh enough to serve without recomputing? */
export function mapFresh(doc: KnowledgeMasteryDoc | null, maxAgeMs: number): boolean {
    if (!doc || doc.version !== MASTERY_VERSION) return false;
    return Date.now() - new Date(doc.computedAt).getTime() < maxAgeMs;
}

/**
 * Must this map be rebuilt before it is shown? The single question every
 * reader should ask, so no caller can forget one of the three reasons.
 *
 * The `dirtyAt` clause is the one that matters after a submission: a
 * student who just solved a recommended task opens the map seconds later,
 * long inside the freshness window, and without this would be served the
 * old map with the task they just solved still in "Practise next".
 */
export function mapStale(doc: KnowledgeMasteryDoc | null, maxAgeMs: number): boolean {
    if (!mapFresh(doc, maxAgeMs)) return true;
    if (doc!.partial) return true;
    const dirtyAt = doc!.dirtyAt ? new Date(doc!.dirtyAt).getTime() : 0;
    return dirtyAt > new Date(doc!.computedAt).getTime();
}

/**
 * Record that this student's map no longer reflects reality. Cheap enough
 * for the judge hot path: one indexed single-field update, and no upsert —
 * a student with no map yet has nothing to invalidate.
 */
export async function markDirty(domainId: string, uid: number): Promise<void> {
    await collMastery.updateOne({ domainId, uid }, { $set: { dirtyAt: new Date() } });
}

export async function saveMap(doc: Omit<KnowledgeMasteryDoc, '_id'>): Promise<void> {
    await collMastery.updateOne(
        { domainId: doc.domainId, uid: doc.uid },
        { $set: doc },
        { upsert: true },
    );
}

/** The class view reads many students' maps at once. */
export async function getMapsIn(domainId: string, uids: number[]): Promise<Map<number, KnowledgeMasteryDoc>> {
    const out = new Map<number, KnowledgeMasteryDoc>();
    if (!uids.length) return out;
    const docs = await collMastery.find({ domainId, uid: { $in: uids }, version: MASTERY_VERSION }).toArray();
    for (const d of docs) out.set(d.uid, d);
    return out;
}

export async function getAttributionsIn(domainId: string, uid: number, ids: string[]): Promise<Map<string, KnowledgeAttributionDoc>> {
    const out = new Map<string, KnowledgeAttributionDoc>();
    if (!ids.length) return out;
    const docs = await collAttribution.find({ _id: { $in: ids } } as any).toArray();
    for (const d of docs) out.set(d._id, d);
    return out;
}

export async function saveAttribution(doc: KnowledgeAttributionDoc): Promise<void> {
    await collAttribution.updateOne({ _id: doc._id } as any, { $set: doc }, { upsert: true });
}

/**
 * ⚠ THE DEFAULT EXPORT MUST BE A CLASS.
 *
 * entry/common.ts `builtinModel` walks src/model/*.ts and only initialises a
 * module when it exports an `apply`, or when its DEFAULT EXPORT IS A CLASS
 * (`isClass(unwrapExports(module))`). This file used to default-export a
 * plain object, so it matched neither test: it was never initialised, its
 * `apply` never ran, and both collections lived without a single index —
 * every getMap() was a full collection scan, growing with every student in
 * every domain. Exporting the class is what registers it, exactly as
 * KnowledgeModel and SelfLearningModel do.
 */
class KnowledgeMapModel {
    static MASTERY_VERSION = MASTERY_VERSION;
    static collMastery = collMastery;
    static collAttribution = collAttribution;
    static getMap = getMap;
    static mapFresh = mapFresh;
    static saveMap = saveMap;
    static getMapsIn = getMapsIn;
    static mapStale = mapStale;
    static markDirty = markDirty;
    static getAttributionsIn = getAttributionsIn;
    static saveAttribution = saveAttribution;

    static async apply() {
        await db.ensureIndexes(
            collMastery,
            // The only lookup there is, and the key saveMap upserts on —
            // unique so a race cannot leave a student with two maps.
            { name: 'domain_uid', key: { domainId: 1, uid: 1 }, unique: true },
        );
        await db.ensureIndexes(
            collAttribution,
            // `_id` covers the hot path; this one is for housekeeping
            // (purging a domain's or a student's cached attributions).
            { name: 'domain_uid_pid', key: { domainId: 1, uid: 1, pid: 1 } },
        );
        await db.ensureIndexes(collThread, { name: 'domain_uid', key: { domainId: 1, uid: 1 }, unique: true });
        await db.ensureIndexes(collProfile, { name: 'domain_uid', key: { domainId: 1, uid: 1 }, unique: true });
    }
}

export default KnowledgeMapModel;

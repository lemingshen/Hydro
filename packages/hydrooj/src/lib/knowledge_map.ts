/**
 * PTA fork — the PERSONAL KNOWLEDGE MAP derivation engine.
 *
 * Turns everything a student has done in a domain into a per-knowledge-point
 * MASTERY STATE and a ranked "practise this next" list. Reads only; the
 * result is cached by model/knowledgemap.ts and is always rebuildable.
 *
 * ── WHY NOT "% OF TASKS SOLVED PER TAG" ──────────────────────────────────
 * Two reasons, both of which this fork's own architecture already accepts:
 *
 *  1. Solving is not understanding. The session rubric separates 🏆
 *     Achievement from 🎓 Ownership precisely because a student can be
 *     walked to an accepted solution by the tutor. A pass-rate map scores
 *     that as mastery.
 *  2. A failure on a task tagged {binary search, off-by-one, sorting} does
 *     not say WHICH of the three broke. Attribution is the whole problem.
 *
 * So outcomes are used only as a weak prior, and the strong signals are the
 * ones that are already attributed to a single concept:
 *
 *  🧠 surfacedKp        the tutor named this point as the student's own
 *                       misconception (TutorThreadDoc, self-learning only)
 *  🧠 TransferAssessment did the lesson survive a later re-encounter of the
 *                       SAME concept (SelfLearningProgressDoc) — the single
 *                       most on-point signal, since it is keyed by concept
 *                       rather than by task
 *  🎓 ownership levels  post-acceptance "do you own your own code"
 *  🧩 reasoning levels  thinking quality while failing
 *
 * ── THE COVERAGE PROBLEM ─────────────────────────────────────────────────
 * Every one of those exists ONLY inside self-learning sessions. Work done
 * in contests, homework and the problem set has no tutor dialogue to mine,
 * so it arrives unattributed. That gap is closed by 🤖 LLM ATTRIBUTION: for
 * a repeatedly-failed multi-concept task with no tutor evidence, a model
 * reads the failing code and names which of the task's points the failure
 * was about. Bounded per build and cached forever on (task, code), because
 * the answer cannot change unless one of those does.
 *
 * Evidence from the two worlds is NOT pooled blindly — tutor-grade evidence
 * carries more weight than an inferred one, and `stats.strong` reports how
 * much of the map rests on the good kind so the UI can be honest about it.
 */
import { createHash } from 'crypto';
import { ObjectId } from 'mongodb';
import { STATUS, STATUS_TEXTS } from '@hydrooj/common';
import { Logger } from '../logger';
import type { ProblemDoc } from '../interface';
import KnowledgeModel, { KnowledgePointDoc } from '../model/knowledge';
import {
    collAttribution, KnowledgeAttributionDoc, KnowledgeMasteryDoc, MASTERY_VERSION,
    MasteryEvidence, MasteryNext, MasteryPoint, MasteryState, saveMap,
} from '../model/knowledgemap';
import problem from '../model/problem';
import RecordModel from '../model/record';
import { quizEvidenceOf } from '../model/quick_review';
import { collProgress, collTutor } from '../model/selflearning';
import * as aiTutor from './ai_tutor';

const logger = new Logger('knowledge-map');

const JUDGING = [STATUS.STATUS_WAITING, STATUS.STATUS_JUDGING, STATUS.STATUS_COMPILING, STATUS.STATUS_FETCHED];

/** A course has hundreds of tasks, not millions; keep every scan bounded. */
const TASK_SCAN_LIMIT = 3000;

/**
 * Evidence weights. Exported so they can be inspected (and argued with)
 * rather than buried — the whole map is a linear combination of these.
 *
 * The ordering is the claim: a judged concept RE-ENCOUNTER (transfer) beats
 * a named misconception, which beats a raw outcome, which beats an inferred
 * attribution. Nothing here is sacred; bump MASTERY_VERSION after tuning.
 */
export const WEIGHTS = {
    transfer_ok: 4,
    transfer_fail: 4,
    surfaced: 3,
    first_try: 3,
    attributed: 2.5,
    unsolved: 2,
    ownership: 2,
    solved: 1.5,
    reasoning: 1.5,
    // ⚡ one quiz question is direct but small evidence: below a solved task,
    // and a miss counts a little more than a hit (a blank or wrong answer on
    // a question the point is *about* is informative; a right answer may be
    // a guess on a 4-option question).
    quiz_ok: 1,
    quiz_fail: 1.25,
} as const;

/** Kinds that come from graded tutor dialogue rather than inference. */
const STRONG_KINDS = new Set(['surfaced', 'transfer_ok', 'transfer_fail', 'ownership', 'reasoning']);

/**
 * Old evidence still counts, but less. Half-life 120 days with a 0.35
 * floor: a concept a student mastered last term should not read as
 * "mastered, high confidence" forever, and should not vanish either.
 */
const DECAY_HALF_LIFE_DAYS = 120;
const DECAY_FLOOR = 0.35;

function decay(at?: Date): number {
    if (!at) return 1;
    const days = (Date.now() - new Date(at).getTime()) / 86400000;
    if (days <= 0) return 1;
    return Math.max(DECAY_FLOOR, 0.5 ** (days / DECAY_HALF_LIFE_DAYS));
}

/** Evidence propagated from a descendant to an ancestor counts for less than its own. */
const ROLLUP_DISCOUNT = 0.6;

/** Confidence saturates: ~6 weighted points of evidence is "we are fairly sure". */
function confidenceOf(total: number): number {
    return Math.round((1 - Math.exp(-total / 6)) * 100) / 100;
}

/** At most this many LLM attribution calls per map build — the cost ceiling. */
const MAX_ATTRIBUTION_CALLS = 12;
/** Only bother attributing a failure the student actually pushed on. */
const ATTRIBUTION_MIN_ATTEMPTS = 2;

/* ------------------------------------------------------------------ */
/*  Raw evidence gathering                                             */
/* ------------------------------------------------------------------ */

interface TaskOutcome {
    pid: number;
    attempts: number;
    accepted: boolean;
    firstTry: boolean;
    lastAt: Date;
    lastFailId?: ObjectId;
    lastFailStatus?: number;
}

/**
 * Every judged, non-pretest submission this student made in the domain,
 * folded to one row per task. This is the ONLY evidence source that spans
 * all activity — contests, homework, the problem set and self-learning all
 * write plain records.
 */
async function outcomesOf(domainId: string, uid: number): Promise<Map<number, TaskOutcome>> {
    const rows = await RecordModel.coll.aggregate([
        {
            $match: {
                domainId,
                uid,
                status: { $nin: JUDGING },
                contest: { $nin: [RecordModel.RECORD_PRETEST, RecordModel.RECORD_GENERATE] },
            },
        },
        { $sort: { _id: 1 } },
        {
            $group: {
                _id: '$pid',
                attempts: { $sum: 1 },
                firstStatus: { $first: '$status' },
                accepted: { $max: { $cond: [{ $eq: ['$status', STATUS.STATUS_ACCEPTED] }, 1, 0] } },
                lastId: { $last: '$_id' },
                // $max ignores the nulls produced for accepted rows, so this
                // is the newest FAILING submission — what attribution reads.
                lastFailId: { $max: { $cond: [{ $ne: ['$status', STATUS.STATUS_ACCEPTED] }, '$_id', null] } },
                lastFailStatus: { $last: { $cond: [{ $ne: ['$status', STATUS.STATUS_ACCEPTED] }, '$status', null] } },
            },
        },
    ]).toArray();
    const out = new Map<number, TaskOutcome>();
    for (const r of rows as any[]) {
        if (typeof r._id !== 'number') continue;
        out.set(r._id, {
            pid: r._id,
            attempts: r.attempts || 0,
            accepted: !!r.accepted,
            firstTry: !!r.accepted && r.firstStatus === STATUS.STATUS_ACCEPTED,
            lastAt: r.lastId ? new ObjectId(r.lastId).getTimestamp() : new Date(),
            lastFailId: r.lastFailId || undefined,
            lastFailStatus: r.lastFailStatus ?? undefined,
        });
    }
    return out;
}

interface TutorEvidence {
    /** pid -> canonical point names the tutor blamed. */
    surfaced: Map<number, string[]>;
    /** pid -> mean post-acceptance ownership level 0..4. */
    ownership: Map<number, number>;
    /** pid -> mean failure-phase reasoning level 0..4. */
    reasoning: Map<number, number>;
    /** pid -> when this thread was last touched. */
    at: Map<number, Date>;
    /** Concept-keyed transfer judgments, straight from the progress docs. */
    transfer: { concept: string, level: number, at: Date }[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

async function tutorEvidenceOf(domainId: string, uid: number): Promise<TutorEvidence> {
    const [threads, progresses] = await Promise.all([
        collTutor.find({ domainId, uid }).toArray(),
        collProgress.find({ domainId, uid }).toArray(),
    ]);
    const ev: TutorEvidence = {
        surfaced: new Map(), ownership: new Map(), reasoning: new Map(), at: new Map(), transfer: [],
    };
    for (const th of threads) {
        if (th.surfacedKp?.names?.length) ev.surfaced.set(th.pid, th.surfacedKp.names);
        // 🚫 Integrity-flagged sub-rubrics are excluded rather than counted
        // as failure: the map describes what a student knows, and a grader
        // -manipulation flag is a conduct finding, not a knowledge one.
        const own = th.ownership?.questions?.flatMap((q: any) => q.levels || []) || [];
        if (own.length && !th.integrity?.own) {
            const m = mean(own);
            if (m !== null) ev.ownership.set(th.pid, m);
        }
        const rea = th.reasoning?.levels || [];
        if (rea.length && !th.integrity?.rea) {
            const m = mean(rea);
            if (m !== null) ev.reasoning.set(th.pid, m);
        }
        ev.at.set(th.pid, th.updateAt || th.createdAt || new Date());
    }
    for (const p of progresses) {
        for (const a of p.transfer?.assessments || []) {
            if (a.flagged) continue;
            if (typeof a.level !== 'number' || !a.concept) continue;
            ev.transfer.push({ concept: a.concept, level: a.level, at: a.at || p.updateAt || new Date() });
        }
    }
    return ev;
}

/* ------------------------------------------------------------------ */
/*  🤖 LLM attribution of unexplained failures                          */
/* ------------------------------------------------------------------ */

const ATTRIBUTION_PROMPT = `You attribute a student's FAILED attempts on a programming task to specific KNOWLEDGE POINTS.

You receive the task statement, a NUMBERED list of the knowledge points the task is labeled with, the judge verdict, and the student's most recent FAILING submission.

Decide which of the listed knowledge points the failure was ACTUALLY about — the concept the student's code shows they have not yet mastered — NOT every concept the task happens to involve. Most failures are about one point, sometimes two; rarely more.

Rules:
- Judge the CODE, never the student's language, comments, naming or style.
- A failure that shows no conceptual gap (a typo, an off-by-one in output formatting, an otherwise correct approach that is merely too slow for reasons unrelated to the listed points) attributes to NOTHING — return an empty array. Attributing everything is worse than attributing nothing: this feeds a map the student is shown.
- Never invent a point that is not in the numbered list.

Reply with ONLY a JSON array of the chosen numbers and nothing else. Examples: [2] or [1,4] or [].`;

function attributionKey(domainId: string, uid: number, pid: number, hash: string) {
    return `${domainId}/${uid}/${pid}/${hash}`;
}

function hashOf(parts: string[]): string {
    return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

function parseNumberArray(raw: string, max: number): number[] {
    const m = /\[[^\]]*\]/.exec(String(raw || ''));
    if (!m) return [];
    try {
        const arr = JSON.parse(m[0]);
        if (!Array.isArray(arr)) return [];
        return [...new Set(arr
            .map((x: any) => parseInt(String(x), 10))
            .filter((n: number) => Number.isInteger(n) && n >= 1 && n <= max))];
    } catch {
        return [];
    }
}

/**
 * Attribute the failures that no tutor dialogue explains. Returns the point
 * names blamed per pid, merging cache hits with fresh calls.
 *
 * Deliberately conservative about spending: only repeatedly-failed tasks
 * carrying MORE THAN ONE point are worth a call (a single-point task is
 * already attributed by construction), the call count is capped per build,
 * and every answer is cached on (task, code, labels) forever.
 */
async function attributeFailures(
    domainId: string, uid: number,
    candidates: { pdoc: ProblemDoc, outcome: TaskOutcome, points: string[] }[],
): Promise<{ byPid: Map<number, string[]>, calls: number }> {
    const byPid = new Map<number, string[]>();
    if (!candidates.length) return { byPid, calls: 0 };

    // Fetch the failing submissions first: the hash covers the code, so
    // nothing can be looked up in the cache without it.
    const rids = candidates.map((c) => c.outcome.lastFailId).filter((x): x is ObjectId => !!x);
    const recs = rids.length
        ? await RecordModel.coll.find({ _id: { $in: rids } }, { projection: { _id: 1, code: 1, status: 1 } }).toArray()
        : [];
    const codeOf = new Map<string, { code: string, status: number }>();
    for (const r of recs as any[]) codeOf.set(String(r._id), { code: String(r.code || ''), status: r.status });

    const planned = candidates.map((c) => {
        const rec = c.outcome.lastFailId ? codeOf.get(String(c.outcome.lastFailId)) : null;
        const code = (rec?.code || '').slice(0, 6000);
        const hash = hashOf([code, c.points.join('|')]);
        return { ...c, code, status: rec?.status, key: attributionKey(domainId, uid, c.pdoc.docId, hash), hash };
    }).filter((c) => c.code.trim());

    const cached = planned.length
        ? await collAttribution.find({ _id: { $in: planned.map((p) => p.key) } } as any).toArray()
        : [];
    const cacheMap = new Map<string, KnowledgeAttributionDoc>();
    for (const d of cached) cacheMap.set(d._id, d);

    let calls = 0;
    for (const p of planned) {
        const hit = cacheMap.get(p.key);
        if (hit) {
            if (hit.names.length) byPid.set(p.pdoc.docId, hit.names);
            continue;
        }
        if (calls >= MAX_ATTRIBUTION_CALLS) break;
        if (!aiTutor.tutorConfigured()) break;
        calls += 1;
        try {
            const numbered = p.points.map((n, i) => `${i + 1}. ${n}`).join('\n');
            const user = [
                `=== TASK: ${p.pdoc.title || ''} ===`,
                aiTutor.extractStatement(p.pdoc),
                '',
                '=== KNOWLEDGE POINTS OF THIS TASK ===',
                numbered,
                '',
                `=== VERDICT: ${STATUS_TEXTS[p.status as number] || 'Failed'} after ${p.outcome.attempts} attempt(s) ===`,
                '',
                '=== STUDENT\'S LATEST FAILING SUBMISSION ===',
                p.code,
            ].join('\n');
            // ai-speedup WP5: bulk, lowest priority, under the `attrib` cap —
            // it only ever uses idle capacity, and waits when there is none.
            const reply = await aiTutor.aiScheduler.runWhenCapacity({
                feature: 'attrib', lane: 'background', priority: 3, label: 'knowledge-map attribution',
            }, () => aiTutor.callProvider(ATTRIBUTION_PROMPT, [{ role: 'user', content: user }], { temperature: 0 }));
            const names = parseNumberArray(reply, p.points.length).map((n) => p.points[n - 1]).filter((x) => x);
            await collAttribution.updateOne(
                { _id: p.key } as any,
                { $set: { _id: p.key, domainId, uid, pid: p.pdoc.docId, hash: p.hash, names, at: new Date() } },
                { upsert: true },
            );
            if (names.length) byPid.set(p.pdoc.docId, names);
        } catch (e: any) {
            // Attribution is an ENHANCEMENT: a provider outage must degrade
            // the map's resolution, never fail the page that asked for it.
            logger.warn('attribution failed for uid=%d pid=%d: %s', uid, p.pdoc.docId, e.message);
        }
    }
    return { byPid, calls };
}

/* ------------------------------------------------------------------ */
/*  Assembly                                                           */
/* ------------------------------------------------------------------ */

interface Bucket {
    positive: number;
    negative: number;
    evidence: MasteryEvidence[];
    lastAt?: Date;
    tasks: { total: number, attempted: number, solved: number, firstTry: number };
    /** Any tutor-grade (non-inferred) evidence landed here. */
    strong: boolean;
}

const newBucket = (): Bucket => ({
    positive: 0, negative: 0, evidence: [], tasks: { total: 0, attempted: 0, solved: 0, firstTry: 0 }, strong: false,
});

function addEvidence(b: Bucket, e: MasteryEvidence) {
    if (e.polarity > 0) b.positive += e.weight;
    else b.negative += e.weight;
    b.evidence.push(e);
    if (STRONG_KINDS.has(e.kind)) b.strong = true;
    if (e.at && (!b.lastAt || e.at > b.lastAt)) b.lastAt = e.at;
}

function stateOf(b: Bucket, mastery: number | null, confidence: number): MasteryState {
    const total = b.positive + b.negative;
    if (total <= 0) return b.tasks.attempted ? 'exposed' : 'untouched';
    if (mastery === null) return 'exposed';
    if (mastery >= 0.75 && confidence >= 0.45) return 'mastered';
    if (mastery >= 0.5) return b.negative > 0 ? 'resolving' : 'exposed';
    return 'shaky';
}

/** The most informative evidence lines, newest and heaviest first. */
function trimEvidence(list: MasteryEvidence[], keep = 6): MasteryEvidence[] {
    return [...list]
        .sort((a, b) => (STRONG_KINDS.has(b.kind) ? 1 : 0) - (STRONG_KINDS.has(a.kind) ? 1 : 0)
            || b.weight - a.weight
            || (b.at?.getTime() || 0) - (a.at?.getTime() || 0))
        .slice(0, keep);
}

/** A student-facing sentence explaining why a point is being recommended. */
function reasonOf(p: MasteryPoint): string {
    const kinds = new Set(p.evidence.map((e) => e.kind));
    if (kinds.has('transfer_fail')) return 'This came back on a later task and tripped you up again.';
    if (kinds.has('surfaced')) return 'The tutor traced one of your errors to this idea.';
    if (kinds.has('attributed')) return 'Your unsolved attempts here point at this idea.';
    if (kinds.has('quiz_fail')) return 'A quiz question about this went wrong.';
    if (kinds.has('reasoning')) return 'Your explanations while debugging this were still uncertain.';
    if (kinds.has('ownership')) return 'You solved it, but explaining your own solution was shaky.';
    if (p.state === 'resolving') return 'You got past this once — worth confirming it stuck.';
    if (kinds.has('unsolved')) return 'You have attempted tasks needing this without solving one yet.';
    return 'Little evidence either way yet — a good place to build some.';
}

export interface ComputeOptions {
    /** Skip LLM attribution entirely (class rebuilds, or a cost-constrained run). */
    noLlm?: boolean;
}

/**
 * Build one student's map. Pure derivation: callers persist the result.
 */
export async function computeMastery(
    domainId: string, uid: number, opts: ComputeOptions = {},
): Promise<Omit<KnowledgeMasteryDoc, '_id'>> {
    const startedAt = Date.now();

    const [catalog, pdocs, outcomes, tutor, quiz] = await Promise.all([
        KnowledgeModel.getMulti(domainId).limit(TASK_SCAN_LIMIT).toArray() as Promise<KnowledgePointDoc[]>,
        problem.getMulti(domainId, { tag: { $exists: true, $ne: [] } }, ['docId', 'pid', 'title', 'tag', 'difficulty', 'hidden'] as any)
            .limit(TASK_SCAN_LIMIT).toArray() as Promise<ProblemDoc[]>,
        outcomesOf(domainId, uid),
        tutorEvidenceOf(domainId, uid),
        // ⚡ per-question outcomes of finished tests (lib/quick_review.ts)
        quizEvidenceOf(domainId, uid).catch(() => []),
    ]);

    // Catalog index. Tags are matched case-insensitively through names AND
    // aliases, exactly as KnowledgeModel.resolve would, but in one pass —
    // a per-tag round trip would be hundreds of queries.
    const byLower = new Map<string, KnowledgePointDoc>();
    for (const d of catalog) {
        byLower.set(d.nameLower, d);
        for (const a of d.aliasesLower || []) if (!byLower.has(a)) byLower.set(a, d);
    }
    const canonical = (tag: string): KnowledgePointDoc | null => byLower.get(String(tag || '').trim().toLowerCase()) || null;

    const buckets = new Map<string, Bucket>();
    const bucketOf = (name: string): Bucket => {
        if (!buckets.has(name)) buckets.set(name, newBucket());
        return buckets.get(name)!;
    };

    // Which catalog points each task carries (canonicalized, deduped).
    const pointsOfTask = new Map<number, string[]>();
    for (const pdoc of pdocs) {
        const names = [...new Set((pdoc.tag || []).map((t) => canonical(t)?.name).filter((x): x is string => !!x))];
        if (names.length) pointsOfTask.set(pdoc.docId, names);
    }
    const pdocOf = new Map<number, ProblemDoc>(pdocs.map((p) => [p.docId, p]));
    const labelOf = (pid: number) => String(pdocOf.get(pid)?.pid || pid);

    /* ---- 1. outcomes (all activity — the weak prior) ---- */
    for (const [pid, names] of pointsOfTask) {
        const o = outcomes.get(pid);
        for (const name of names) {
            const b = bucketOf(name);
            b.tasks.total += 1;
            if (!o) continue;
            b.tasks.attempted += 1;
            if (o.accepted) b.tasks.solved += 1;
            if (o.firstTry) b.tasks.firstTry += 1;
            const d = decay(o.lastAt);
            if (o.firstTry) {
                addEvidence(b, {
                    kind: 'first_try', polarity: 1, weight: WEIGHTS.first_try * d, pid, label: labelOf(pid), at: o.lastAt,
                    note: 'Solved on the first attempt.',
                });
            } else if (o.accepted) {
                addEvidence(b, {
                    kind: 'solved', polarity: 1, weight: WEIGHTS.solved * d, pid, label: labelOf(pid), at: o.lastAt,
                    note: `Solved after ${o.attempts} attempts.`,
                });
            } else if (o.attempts >= ATTRIBUTION_MIN_ATTEMPTS) {
                addEvidence(b, {
                    kind: 'unsolved', polarity: -1, weight: WEIGHTS.unsolved * d, pid, label: labelOf(pid), at: o.lastAt,
                    note: `${o.attempts} attempts, not solved yet.`,
                });
            }
        }
    }

    /* ---- 1b. ⚡ quiz questions of finished tests (question-level, direct) ---- */
    for (const q of quiz) {
        const d = decay(q.at);
        for (const raw of q.points || []) {
            const name = canonical(raw)?.name;
            if (!name) continue;
            addEvidence(bucketOf(name), {
                kind: q.correct ? 'quiz_ok' : 'quiz_fail', polarity: q.correct ? 1 : -1, weight: (q.correct ? WEIGHTS.quiz_ok : WEIGHTS.quiz_fail) * d,
                pid: q.pid, label: q.label, at: q.at, note: q.correct ? `Answered correctly in a test (${q.label}).` : `Missed in a test (${q.label}).`,
            });
        }
    }

    /* ---- 2. 🧠 tutor-named misconceptions (attributed by construction) ---- */
    for (const [pid, names] of tutor.surfaced) {
        const at = tutor.at.get(pid);
        for (const raw of names) {
            const doc = canonical(raw);
            if (!doc) continue;
            addEvidence(bucketOf(doc.name), {
                kind: 'surfaced', polarity: -1, weight: WEIGHTS.surfaced * decay(at), pid, label: labelOf(pid), at,
                note: 'The tutor traced your errors here to this point.',
            });
        }
    }

    /* ---- 3. 🧠 concept transfer — the strongest per-concept signal ---- */
    for (const t of tutor.transfer) {
        const doc = canonical(t.concept);
        if (!doc) continue;
        if (t.level >= 3) {
            addEvidence(bucketOf(doc.name), {
                kind: 'transfer_ok', polarity: 1, weight: WEIGHTS.transfer_ok * decay(t.at), at: t.at,
                note: 'You met this again later and handled it.',
            });
        } else if (t.level <= 1) {
            addEvidence(bucketOf(doc.name), {
                kind: 'transfer_fail', polarity: -1, weight: WEIGHTS.transfer_fail * decay(t.at), at: t.at,
                note: 'You met this again later and it tripped you up.',
            });
        }
    }

    /* ---- 4. 🎓 ownership / 🧩 reasoning levels, spread over the task's points ---- */
    const spread = (src: Map<number, number>, kind: 'ownership' | 'reasoning', hi: number, lo: number) => {
        for (const [pid, level] of src) {
            const names = pointsOfTask.get(pid);
            if (!names?.length) continue;
            const at = tutor.at.get(pid);
            // A task's level is evidence about EVERY point it carries, but
            // weakly — it is not attributed to one of them. Splitting across
            // the task's points keeps a 6-tag task from shouting.
            const share = 1 / Math.min(names.length, 3);
            for (const name of names) {
                if (level >= hi) {
                    addEvidence(bucketOf(name), {
                        kind, polarity: 1, weight: WEIGHTS[kind] * share * decay(at), pid, label: labelOf(pid), at,
                        note: kind === 'ownership' ? 'You explained your own solution well.' : 'Your debugging reasoning was sound.',
                    });
                } else if (level <= lo) {
                    addEvidence(bucketOf(name), {
                        kind, polarity: -1, weight: WEIGHTS[kind] * share * decay(at), pid, label: labelOf(pid), at,
                        note: kind === 'ownership' ? 'Explaining your own solution was shaky.' : 'Your debugging reasoning was uncertain.',
                    });
                }
            }
        }
    };
    spread(tutor.ownership, 'ownership', 3, 1);
    spread(tutor.reasoning, 'reasoning', 3, 1);

    /* ---- 5. 🤖 LLM attribution for failures no tutor explains ---- */
    let llmCalls = 0;
    /*
     * How much attribution a `noLlm` run left undone. This is what makes the
     * BACKGROUND rebuild after a submission safe to skip the model with:
     * the resulting map is marked `partial`, and the next time the student
     * actually opens it the handler rebuilds with attribution on. Without
     * this counter a cheap background build would stamp a fresh
     * `computedAt`, the freshness check would be satisfied, and the LLM path
     * would silently never run again.
     */
    let llmPending = 0;
    const candidates: { pdoc: ProblemDoc, outcome: TaskOutcome, points: string[] }[] = [];
    for (const [pid, names] of pointsOfTask) {
        const o = outcomes.get(pid);
        if (!o || o.accepted || o.attempts < ATTRIBUTION_MIN_ATTEMPTS) continue;
        if (names.length < 2) continue; // single-point tasks need no attribution
        if (tutor.surfaced.has(pid)) continue; // already attributed, for free
        const pdoc = pdocOf.get(pid);
        if (pdoc) candidates.push({ pdoc, outcome: o, points: names });
    }
    if (opts.noLlm) {
        llmPending = candidates.length;
    } else {
        // Most recent struggles first — they are what "practise next" is about.
        candidates.sort((a, b) => b.outcome.lastAt.getTime() - a.outcome.lastAt.getTime());
        const res = await attributeFailures(domainId, uid, candidates.slice(0, MAX_ATTRIBUTION_CALLS * 2));
        llmCalls = res.calls;
        for (const [pid, names] of res.byPid) {
            const o = outcomes.get(pid);
            for (const name of names) {
                addEvidence(bucketOf(name), {
                    kind: 'attributed', polarity: -1, weight: WEIGHTS.attributed * decay(o?.lastAt), pid, label: labelOf(pid), at: o?.lastAt,
                    note: 'Your unsolved attempts here look like this point.',
                });
            }
        }
    }

    /* ---- 6. tree rollup: a parent inherits its descendants, discounted ---- */
    const byId = new Map<string, KnowledgePointDoc>(catalog.map((d) => [String(d._id), d]));
    const rolled = new Map<string, Bucket>();
    for (const d of catalog) {
        const own = buckets.get(d.name);
        const b = rolled.get(d.name) || newBucket();
        if (own) {
            b.positive += own.positive;
            b.negative += own.negative;
            b.evidence.push(...own.evidence);
            b.strong = b.strong || own.strong;
            b.tasks.total += own.tasks.total;
            b.tasks.attempted += own.tasks.attempted;
            b.tasks.solved += own.tasks.solved;
            b.tasks.firstTry += own.tasks.firstTry;
            if (own.lastAt && (!b.lastAt || own.lastAt > b.lastAt)) b.lastAt = own.lastAt;
        }
        rolled.set(d.name, b);
        if (!own) continue;
        for (const anc of d.ancestors || []) {
            const parent = byId.get(String(anc));
            if (!parent) continue;
            const pb = rolled.get(parent.name) || newBucket();
            pb.positive += own.positive * ROLLUP_DISCOUNT;
            pb.negative += own.negative * ROLLUP_DISCOUNT;
            pb.tasks.total += own.tasks.total;
            pb.tasks.attempted += own.tasks.attempted;
            pb.tasks.solved += own.tasks.solved;
            pb.tasks.firstTry += own.tasks.firstTry;
            pb.strong = pb.strong || own.strong;
            if (own.lastAt && (!pb.lastAt || own.lastAt > pb.lastAt)) pb.lastAt = own.lastAt;
            rolled.set(parent.name, pb);
        }
    }

    /* ---- 7. states ---- */
    const points: MasteryPoint[] = catalog.map((d) => {
        const b = rolled.get(d.name) || newBucket();
        const total = b.positive + b.negative;
        const mastery = total > 0 ? Math.round((b.positive / total) * 100) / 100 : null;
        const confidence = confidenceOf(total);
        return {
            name: d.name,
            path: d.path || [],
            depth: d.depth || 0,
            state: stateOf(b, mastery, confidence),
            mastery,
            confidence,
            positive: Math.round(b.positive * 100) / 100,
            negative: Math.round(b.negative * 100) / 100,
            lastAt: b.lastAt,
            tasks: b.tasks,
            evidence: trimEvidence(b.evidence),
            rolled: !buckets.has(d.name) && total > 0,
        };
    });
    const pointByName = new Map(points.map((p) => [p.name, p]));

    /* ---- 8. what to practise next ---- */
    /*
     * Two gates matter more than the ranking itself:
     *
     *  • PREREQUISITE READINESS — never recommend a leaf while one of its
     *    ancestors is shaky. Sending a student to "Off-by-one in loop
     *    bounds" while "Loops" itself is unstable is the classic way an
     *    adaptive map wastes someone's afternoon. Recommend the ancestor.
     *  • ACTIONABILITY — a recommendation with no unsolved task carrying it
     *    is not advice, it is a complaint. Those are dropped.
     */
    const unsolvedByPoint = new Map<string, { docId: number, pid: string, title: string, difficulty?: number }[]>();
    for (const [pid, names] of pointsOfTask) {
        const pdoc = pdocOf.get(pid);
        if (!pdoc || pdoc.hidden) continue;
        if (outcomes.get(pid)?.accepted) continue;
        for (const name of names) {
            const list = unsolvedByPoint.get(name) || [];
            if (list.length < 4) {
                list.push({
                    docId: pdoc.docId, pid: String(pdoc.pid || pdoc.docId), title: pdoc.title || '', difficulty: (pdoc as any).difficulty,
                });
            }
            unsolvedByPoint.set(name, list);
        }
    }
    const shakyAncestor = (d: KnowledgePointDoc): boolean => (d.ancestors || []).some((a) => {
        const parent = byId.get(String(a));
        return !!parent && pointByName.get(parent.name)?.state === 'shaky';
    });

    const next: MasteryNext[] = [];
    for (const d of catalog) {
        const p = pointByName.get(d.name);
        if (!p) continue;
        if (!['shaky', 'resolving', 'exposed'].includes(p.state)) continue;
        if (p.state === 'exposed' && !p.tasks.attempted) continue; // untouched-in-practice
        if (shakyAncestor(d)) continue;
        const tasks = unsolvedByPoint.get(d.name) || [];
        if (!tasks.length) continue;
        const deficit = p.mastery === null ? 0.6 : 1 - p.mastery;
        // Weak evidence should not silence a recommendation, only soften it.
        const priority = deficit * (0.4 + 0.6 * p.confidence)
            * (p.state === 'shaky' ? 1.25 : p.state === 'resolving' ? 1 : 0.7);
        next.push({
            name: p.name,
            path: p.path,
            reason: reasonOf(p),
            priority: Math.round(priority * 1000) / 1000,
            state: p.state,
            confidence: p.confidence,
            tasks,
        });
    }
    next.sort((a, b) => b.priority - a.priority);

    const stats = {
        catalog: points.length,
        untouched: points.filter((p) => p.state === 'untouched').length,
        exposed: points.filter((p) => p.state === 'exposed').length,
        shaky: points.filter((p) => p.state === 'shaky').length,
        resolving: points.filter((p) => p.state === 'resolving').length,
        mastered: points.filter((p) => p.state === 'mastered').length,
        covered: points.filter((p) => p.state !== 'untouched').length,
        strong: catalog.filter((d) => rolled.get(d.name)?.strong).length,
        llmCalls,
        llmPending,
    };

    return {
        domainId,
        uid,
        version: MASTERY_VERSION,
        // The START of the derivation, not the end. Evidence written while
        // this ran is not guaranteed to be included, so stamping the end
        // time would claim to cover submissions the map never read — and
        // `dirtyAt > computedAt` would then miss them. See model/knowledgemap.
        computedAt: new Date(startedAt),
        tookMs: Date.now() - startedAt,
        points,
        next: next.slice(0, 10),
        stats,
        // Built without attribution while work was outstanding — the viewer
        // rebuilds it properly (see handler/knowledge.ts).
        partial: llmPending > 0,
    };
}

export default { computeMastery, WEIGHTS };

/* ------------------------------------------------------------------ */
/*  ⏱ BACKGROUND REBUILD AFTER A SUBMISSION                            */
/* ------------------------------------------------------------------ */
/**
 * Rebuild one student's map shortly after they submit, without making them
 * wait and without rebuilding once per keystroke of a debugging session.
 *
 * A student working on a hard task submits repeatedly — five failures in
 * three minutes is ordinary. Rebuilding on each one would run the whole
 * derivation five times to produce almost the same map, so submissions are
 * COALESCED: each one restarts a short timer, and only the quiet moment at
 * the end of the burst actually triggers a build.
 *
 * The background build deliberately runs with `noLlm`. Every failed
 * submission is new code, so it is a new attribution hash and a guaranteed
 * cache miss — attributing on each one would spend a model call per failure
 * to re-answer a question whose answer barely moved. The states that DO
 * depend on the new verdict (solved / first-try / still unsolved) come from
 * the record aggregation and update immediately; attribution is left to the
 * moment the student actually opens the map, which is user-initiated and
 * rate-limited. `partial` on the saved doc is what tells the viewer to do
 * that work.
 */
const DEBOUNCE_MS = 20 * 1000;

const pendingBuilds = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<string>();

const buildKey = (domainId: string, uid: number) => `${domainId}/${uid}`;

async function runScheduledBuild(domainId: string, uid: number) {
    const key = buildKey(domainId, uid);
    // Never two builds for the same student at once: the second would read
    // the same evidence and race the first's write for no benefit.
    if (inFlight.has(key)) {
        scheduleMastery(domainId, uid);
        return;
    }
    inFlight.add(key);
    try {
        const fresh = await computeMastery(domainId, uid, { noLlm: true });
        await saveMap(fresh);
        logger.debug('[knowledge-map] rebuilt for %s in %dms', key, fresh.tookMs);
    } catch (e: any) {
        // A failed rebuild must never surface to the student: their
        // submission already succeeded, and the map self-heals on the next
        // submission or the next time they open it.
        logger.warn('[knowledge-map] background rebuild failed for %s: %s', key, e.message);
    } finally {
        inFlight.delete(key);
    }
}

/** Queue a debounced rebuild. Safe to call as often as you like. */
export function scheduleMastery(domainId: string, uid: number) {
    if (!domainId || !uid || uid <= 1) return;
    const key = buildKey(domainId, uid);
    const existing = pendingBuilds.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        pendingBuilds.delete(key);
        runScheduledBuild(domainId, uid);
    }, DEBOUNCE_MS);
    // Do not hold the process open for a map rebuild during shutdown.
    if (typeof timer.unref === 'function') timer.unref();
    pendingBuilds.set(key, timer);
}

/** Drop every queued rebuild — called on dispose so reloads leave nothing behind. */
export function cancelScheduledMastery() {
    for (const t of pendingBuilds.values()) clearTimeout(t);
    pendingBuilds.clear();
}

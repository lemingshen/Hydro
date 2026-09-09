import { ObjectId } from 'mongodb';
import type { PenaltyRules } from '../interface';
import db from '../service/db';
import * as document from './document';
import type { ScoreOverride, ScoreOverrideEntry } from './contest';

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
        /** ♻️ True for the teacher-button run that re-judges everything from scratch. */
        force?: boolean;
        /**
         * Live progress of the retroactive grading (who is being judged
         * right now), written by the manual job and shown on the teacher's
         * progress card; the final 'done' write keeps the summary counts.
         */
        progress?: {
            uid?: number, uname?: string, pid?: number | string, done?: number, total?: number, graded?: number, failed?: number,
            /** Which grader is running: 'own' (🎓 walkthrough) or 'fix' (🔧 guidance-to-fix). */
            phase?: string,
            /** 🎓 split of the final combined counts (the done write). */
            own?: { graded: number, total: number },
            /** 🔧 split of the final combined counts (the done write). */
            fix?: { graded: number, total: number },
            /** 🧩 split of the final combined counts (the done write). */
            rea?: { graded: number, total: number },
            /** 💡 split of the final combined counts (the done write). */
            ini?: { graded: number, total: number },
            /** 📈 split of the final combined counts (the done write). */
            trj?: { graded: number, total: number };
            /** 🧠 split of the final combined counts (the done write). */
            trf?: { graded: number, total: number };
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
     * PTA fork: the session's RESULTS — every student's session score
     * (🅰 Block A per-task rubrics + 🅱 Block B cross-task rubrics, out
     * of 100), computed automatically once the deadline (endAt +
     * extension) has passed (`final`), or on demand by the teacher before
     * that (provisional). See handler/self_learning.ts computeSessionResults.
     */
    results?: SessionResults;
    /**
     * 🎁 Does this session offer a BONUS TASK? Set by the teacher's tickbox
     * on the create / edit form.
     *
     * Tri-state on purpose:
     *   true      — the teacher ticked the box; students may request one.
     *   false     — the teacher UNticked it; no new bonus task is offered.
     *   undefined — a session saved before this field existed. Bonus tasks
     *               were unconditionally available then, so absent reads as
     *               ENABLED; anything else would silently withdraw a feature
     *               from every session already running.
     *
     * The gate covers REQUESTING a task (bonusAllowed in
     * handler/self_learning.ts). A bonus task a student already owns stays
     * reachable whatever the teacher later ticks — revoking it mid-session
     * would strand their work and orphan their submissions.
     */
    bonusEnabled?: boolean;
    /**
     * 🌐 Submission languages allowed in this session — judge language
     * ids, the teacher's pick on the create / edit form. Empty or absent
     * = no session-level restriction (each task's own config decides).
     * Applied to EVERY programming task the session opens — its listed
     * tasks and each student's bonus task alike — by intersecting with the
     * task's own `config.langs` on every session surface (solve page,
     * scratchpad language menu, submit), exactly as a contest's `langs`
     * is folded into the problem's chain upstream.
     */
    langs?: string[];
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
    /**
     * ai-speedup WP4: the rolling five-line summary of the thread (goal ·
     * tried · blocker · hints given · next step), refreshed in the
     * background every few student turns; the next tutor call sends it
     * plus the last turns instead of the whole history.
     */
    summary?: { text: string, upToIndex: number, updatedAt: Date };
    /** ai-speedup WP4: the code the tutor last saw in full — later turns send a diff against it. */
    lastSentCode?: { hash: string, text: string, at: Date };
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
     * 🚫 Grader-manipulation flags on THIS task's evidence: which of the
     * four task sub-rubrics (own/fix/rea/ini) were zeroed because the
     * detector fired on student-authored content, with audit excerpts.
     * A flagged sub-rubric scores 0 for this task regardless of any
     * other, clean evidence on it.
     */
    integrity?: {
        own?: boolean; fix?: boolean; rea?: boolean; ini?: boolean;
        hits?: { sub: string, excerpt: string, at: Date }[];
    };
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
 * materialized as a problem (docId) the student reaches through the
 * session (and, once verified, through the domain's problem set).
 *
 * The whole build is a BACKGROUND JOB the student's page merely watches:
 *   diagnosing → the AI reads every attempt and tutor exchange and names
 *                the weak points (no draft exists yet — the entry itself
 *                is the job's only record, and `id` is the draft _id the
 *                job will create);
 *   drafting   → the draft exists, the statement is being written;
 *   building   → the problem exists; solution, tests and verification run;
 *   ready | failed.
 * The entry is written BEFORE the first AI call, so a page refresh at any
 * moment finds it and resumes watching; nothing about the build depends
 * on the request that started it.
 */
export interface SelfLearningBonusEntry {
    /** The AI Studio draft _id — pre-generated, so it names the task from the first instant. */
    id: ObjectId;
    docId?: number;
    pid?: string;
    title?: string;
    status: 'diagnosing' | 'drafting' | 'building' | 'ready' | 'failed';
    message?: string;
    weakPoints: string[];
    createdAt: Date;
    /** When the current (re)run of the diagnosis started — the staleness clock while `diagnosing`. */
    startedAt?: Date;
    readyAt?: Date;
}

/**
 * 🧠 One CONCEPT-TRANSFER assessment: concept C first surfaced (in
 * failure tutoring) AND resolved at fromPid, then judged 0..4 at the FIRST
 * chronological re-encounter toPid (a task tagged with C). One per
 * concept; graded by the evaluation backfill.
 */
export interface TransferAssessment {
    /** 🚫 True when the detector fired on this re-encounter's student content — 🧠 zeroes. */
    flagged?: boolean;
    /** Canonical knowledge-point name (the concept C). */
    concept: string;
    fromPid: number;
    toPid: number;
    /** 0 relapse-unrecognized … 4 correct, unprompted, with awareness. */
    level: number;
    at: Date;
}

export interface SelfLearningProgressDoc {
    /**
     * 📈 The student's ONE whole-session Independence-Trajectory judgment
     * (Block B): level 0..4, when it was judged, and the history BASIS it
     * was judged on (taskCount:recordCount:answeredExchanges) — the
     * backfill re-runs the LLM only when the basis changed.
     */
    trajectory?: { level: number, at: Date, basis?: string, flagged?: boolean };
    /**
     * ✎ PTA fork: the TEACHER'S SCORE ADJUSTMENTS for this student in this
     * session (per task 0..100 and/or the final total 0..100, each with a
     * reason), kept apart from every computed value so an evaluation can
     * never wipe them — the evaluation re-applies them to its fresh row
     * (handler applySessionOverride) and the student's own card shows them.
     */
    override?: ScoreOverride;
    _id: ObjectId;
    domainId: string;
    ssid: ObjectId;
    uid: number;
    done: number[];
    skipped: number[];
    bonuses?: SelfLearningBonusEntry[];
    /** 🧠 Cross-problem concept-transfer assessments (evaluation-graded). */
    /**
     * 🧠 Concept Transfer (Block B): the judged re-encounter assessments
     * plus the backfill's PLAN — how many re-encounter candidates the
     * planner found and whether the student is UNTESTABLE (surfacing
     * settled, zero candidates → the spec's full-credit edge case).
     */
    transfer?: {
        assessments?: TransferAssessment[];
        plan?: { candidates: number, untestable: boolean, at: Date };
    };
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
     * ⭐ Per-task score (Block A material): pid → 0..taskMax (100), one
     * decimal, from handler taskRubricOf — the SUM of the task's earned
     * sub-rubric points (🏆 judged×30% + 🎓 mean level×5; the 🔧/🧩/💡
     * placeholders earn nothing yet, so a task currently tops out at
     * 50). Unattempted tasks appear as 0. Absent on rows stored under
     * another rubric version — such results re-derive on sight
     * (SESSION_RUBRIC_VERSION).
     */
    taskScores?: Record<string, number>;
    /**
     * 🎓 Per-task Code-Ownership evidence behind taskScores: pid →
     * { level: mean walkthrough level 0..4 (2 decimals; asked-unanswered
     * counts 0) or null when no walkthrough exists; pts: the task's EXACT
     * 🎓 points (round1 of the unrounded mean × 5) — the number the Σ was
     * built from, which the 🎓 cell displays; asked: questions asked;
     * graded: answers with a stored level }. Absent on other-version rows
     * (pts additionally absent on rows stored before the pts field).
     */
    own?: Record<string, { level: number | null, pts?: number, asked: number, graded: number, flagged?: boolean }>;
    /**
     * 🔧 Per-task Guidance-to-Fix evidence behind taskScores: pid →
     * { level: penalty-weighted mean level 0..4 (2 decimals) or null when
     * no judged transitions; pts: the task's EXACT 🔧 points (round1 of
     * the unrounded weighted mean × 3.75) — the number the Σ was built
     * from, which the 🔧 cell displays; judged: transitions graded }.
     * Absent on other-version rows.
     */
    fix?: Record<string, { level: number | null, pts?: number, judged: number, flagged?: boolean }>;
    /**
     * 🧩 Per-task Reasoning-Quality evidence behind taskScores: pid →
     * { level: mean failure-phase level 0..4 (2 decimals) or null when
     * nothing graded; pts: the task's EXACT 🧩 points (round1 of the
     * unrounded mean × 7.5) — the number the Σ was built from, which the
     * 🧩 cell displays; judged: answers graded }. Absent on
     * other-version rows.
     */
    rea?: Record<string, { level: number | null, pts?: number, judged: number, flagged?: boolean }>;
    /**
     * 💡 Per-task Self-Diagnostic-Initiative evidence behind taskScores:
     * pid → { level: the ONE first-engagement level 0..4 or null when not
     * judged yet (no closed failure engagement with answers); pts: the
     * task's EXACT 💡 points (level × 1.25) }. Absent on other-version
     * rows.
     */
    ini?: Record<string, { level: number | null, pts?: number, flagged?: boolean }>;
    /**
     * ⭐ FIRST-ATTEMPT EXCEPTION markers: pid → true when the task was
     * accepted with a single submission — such a task is scored 🏆 judged
     * × 40% (/40) + 🎓 mean level × 15 (/60), and 🔧/🧩/💡 do not apply
     * (the fix/rea/ini entries carry level null there). Sparse; absent
     * on other-version rows.
     */
    fa?: Record<string, boolean>;
    /**
     * 🅱📈 The student's Independence-Trajectory sub-score: { level: the
     * one whole-session level 0..4 or null when not judged yet; pts:
     * level × 2.5 (0 when unjudged) }. blockB = trj.pts (+ 🧠 once it
     * lands). Absent on other-version rows.
     */
    trj?: { level: number | null, pts: number, flagged?: boolean };
    /**
     * 🅱🧠 The student's Concept-Transfer sub-score: state 'assessed'
     * (level = mean re-encounter level, pts = mean × 3.75, judged =
     * re-encounters graded), 'untestable' (the edge case — pts = the full
     * 15) or 'pending' (testable, judging awaited — pts 0). blockB =
     * trj.pts + trf.pts. Absent on other-version rows.
     */
    trf?: { state: 'assessed' | 'pending' | 'untestable', level: number | null, pts: number, judged: number, flagged?: boolean };
    /**
     * ⭐⭐ ALL-FIRST-ATTEMPT COLLAPSE: true when EVERY task was accepted
     * on the first attempt — the whole session rescores as 🏆 40 + 🎓 60
     * and total = sessAch + sessOwn (up to rounding of the exact task
     * mean); 🅰/🅱/📈/🧠 do not apply. Absent on normal rows.
     */
    allFa?: boolean;
    /** ⭐⭐ The collapsed session's 🏆 part: mean(judged) × 40% (0..40). */
    sessAch?: number;
    /** ⭐⭐ The collapsed session's 🎓 part: mean(walkthrough level) × 15 (0..60). */
    sessOwn?: number;
    /** ⏱ The tiered late factor applied to this student’s total (present only when < 1). */
    lateFactor?: number;
    /** ⏱ Hours past the deadline of their last counted submission (1 decimal). */
    lateHours?: number;
    /** 🅰 Block A (0..blockAMax, 75): (Σ task scores) / (n × 100) × 75. Absent on other-version rows. */
    blockA?: number;
    /** 🅱 Block B (0..blockBMax, 25): cross-task rubrics — not implemented yet, stored as 0. Absent on other-version rows. */
    blockB?: number;
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
    /** The session total, out of SESSION_TOTAL_MAX (100): 🅰 Block A + 🅱 Block B. */
    total: number;
    /**
     * ✎ Teacher adjustments applied to this row (a copy of the progress
     * doc's override at evaluation time) and the values they replaced —
     * the table marks adjusted cells and the evidence pop-up shows
     * "computed X → adjusted Y: reason". Absent when nothing is adjusted.
     */
    override?: { tasks?: Record<string, ScoreOverrideEntry>, total?: ScoreOverrideEntry };
    computed?: { taskScores: Record<string, number>, blockA?: number, total: number };
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
    /**
     * ⭐ Scoring-shape version (handler SESSION_RUBRIC_VERSION). Results
     * stored under a DIFFERENT version — including the retired
     * sum-of-judged-scores table, which lacks the field entirely — are
     * re-derived on first staff sight through runSessionEvaluation.
     */
    rubric?: number;
    /** The session grade scale (SESSION_TOTAL_MAX, 100). */
    maxTotal: number;
    /** 🅰 Block A's scale (BLOCK_A_MAX, 75); absent on other-version results. */
    blockAMax?: number;
    /** 🅰's earnable ceiling while the placeholder sub-rubrics are pending (BLOCK_A_EARNABLE, 37.5). Absent on other-version results. */
    blockAEarnable?: number;
    /** 🅱 Block B's scale (BLOCK_B_MAX, 25); absent on other-version results. */
    blockBMax?: number;
    /** Each task's point scale (TASK_RUBRIC_MAX, 100 = 🏆30+🎓20+🔧15+🧩30+💡5); absent on other-version results. */
    taskMax?: number;
    /** 🏆 Achievement's points of a task's 100 (ACHIEVEMENT_SHARE, 30); absent on other-version results. */
    achievementShare?: number;
    /** 🎓 Code Ownership's points of a task's 100 (OWNERSHIP_SHARE, 20); absent on other-version results. */
    ownershipShare?: number;
    /** 🔧 Guidance-to-Fix Conversion's points of a task's 100 (FIXCONV_SHARE, 15) — PLACEHOLDER; absent on other-version results. */
    fixconvShare?: number;
    /** 🧩 Reasoning Quality's points of a task's 100 (REASONING_SHARE, 30) — PLACEHOLDER; absent on other-version results. */
    reasoningShare?: number;
    /** 💡 Self-Diagnostic Initiative's points of a task's 100 (INITIATIVE_SHARE, 5); absent on other-version results. */
    initiativeShare?: number;
    /** ⭐ 🏆's points on a FIRST-ATTEMPT task (FIRST_ATTEMPT_ACH_MAX, 40); absent on other-version results. */
    faAchShare?: number;
    /** ⭐ 🎓's points on a FIRST-ATTEMPT task (FIRST_ATTEMPT_OWN_MAX, 60); absent on other-version results. */
    faOwnShare?: number;
    /** 🅱📈 Independence Trajectory's points of Block B's 25 (TRAJECTORY_SHARE, 10); absent on other-version results. */
    trajectoryShare?: number;
    /** 🅱🧠 Concept Transfer's points of Block B's 25 (TRANSFER_SHARE, 15) — PLACEHOLDER; absent on other-version results. */
    transferShare?: number;
    /** 🅱's earnable ceiling while 🧠 is pending (BLOCK_B_EARNABLE, 10); absent on other-version results. */
    blockBEarnable?: number;
    /** RETIRED (old 7-component rubric) component scales; absent on results stored by current builds. */
    ownershipMax?: number;
    fixConvMax?: number;
    trajectoryMax?: number;
    transferMax?: number;
    reasoningMax?: number;
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

    /** ai-speedup WP4: store the refreshed rolling summary (skipped when an even newer one landed meanwhile). */
    static setThreadSummary(tid: ObjectId, summary: { text: string, upToIndex: number }) {
        return collTutor.updateOne(
            { _id: tid, $or: [{ summary: { $exists: false } }, { 'summary.upToIndex': { $lte: summary.upToIndex } }] },
            { $set: { summary: { ...summary, updatedAt: new Date() } } },
        );
    }

    /** ai-speedup WP4: remember the code the tutor has seen in full. */
    static setLastSentCode(tid: ObjectId, code: string, hash: string) {
        return collTutor.updateOne({ _id: tid }, { $set: { lastSentCode: { hash, text: code, at: new Date() } } });
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

    /**
     * ♻️ FORCE RE-EVALUATION support: clear every stored LLM judgment of
     * the session so the (idempotent, cache-driven) evaluation phases
     * re-grade everything from scratch. What is cleared: 🎓 per-question
     * levels + answer keys and per-message levels, 🔧 transitions, 🧩
     * reasoning grades + per-message rlevels, 💡 initiative, 🧠 surfaced
     * knowledge points + the whole transfer state, 📈 the trajectory, and
     * the 🚫 integrity flags (the deterministic detector re-derives them
     * from the same content). What SURVIVES: every dialogue message, the
     * walkthrough questions with their budget/acceptance bookkeeping, and
     * all records — the evidence, as opposed to the judgments of it.
     */
    static async resetEvaluationState(domainId: string, ssid: ObjectId): Promise<{ threads: number, progresses: number }> {
        const [q, t, m, p] = await Promise.all([
            collTutor.updateMany(
                { domainId, ssid, 'ownership.questions': { $exists: true } },
                { $set: { 'ownership.questions.$[].levels': [], 'ownership.questions.$[].answerKeys': [] } },
            ),
            collTutor.updateMany(
                { domainId, ssid },
                { $unset: { fixconv: '', reasoning: '', initiative: '', surfacedKp: '', integrity: '' } },
            ),
            collTutor.updateMany(
                { domainId, ssid, messages: { $exists: true, $ne: [] } },
                { $unset: { 'messages.$[].level': '', 'messages.$[].rlevel': '' } },
            ),
            collProgress.updateMany(
                { domainId, ssid },
                { $unset: { trajectory: '', transfer: '' } },
            ),
        ]);
        return {
            threads: Math.max(q.modifiedCount || 0, t.modifiedCount || 0, m.modifiedCount || 0),
            progresses: p.modifiedCount || 0,
        };
    }

    /** 🚫 Flag one task sub-rubric as manipulation-zeroed, with the audit excerpt. */
    static flagIntegrity(tid: ObjectId, sub: 'own' | 'fix' | 'rea' | 'ini', excerpt: string) {
        return collTutor.updateOne(
            { _id: tid },
            {
                $set: { [`integrity.${sub}`]: true },
                $push: { 'integrity.hits': { sub, excerpt: String(excerpt || '').slice(0, 120), at: new Date() } },
            },
        );
    }

    /** 📈 Store the student's whole-session Independence-Trajectory judgment (Block B). */
    static setTrajectory(domainId: string, ssid: ObjectId, uid: number, t: { level: number, at: Date, basis?: string }) {
        return collProgress.updateOne(
            { domainId, ssid, uid },
            { $set: { trajectory: t, updateAt: new Date() }, $setOnInsert: { done: [], skipped: [] } },
            { upsert: true },
        );
    }

    /** 🧠 Store the student's transfer PLAN (candidate count + the untestable verdict). */
    static setTransferPlan(domainId: string, ssid: ObjectId, uid: number, plan: { candidates: number, untestable: boolean, at: Date }) {
        return collProgress.updateOne(
            { domainId, ssid, uid },
            { $set: { 'transfer.plan': plan, updateAt: new Date() }, $setOnInsert: { done: [], skipped: [] } },
            { upsert: true },
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

    /** ✎ Store (or clear, with null) the teacher's score adjustments for one student. */
    static async setOverride(domainId: string, ssid: ObjectId, uid: number, override: ScoreOverride | null): Promise<void> {
        await collProgress.updateOne(
            { domainId, ssid, uid },
            override
                ? { $set: { override, updateAt: new Date() }, $setOnInsert: { done: [], skipped: [] } }
                : { $unset: { override: '' }, $set: { updateAt: new Date() }, $setOnInsert: { done: [], skipped: [] } },
            { upsert: true },
        );
    }

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

export interface AiSuggestionJob {
    status: 'queued' | 'running' | 'done' | 'failed';
    stage?: string;
    startedAt: Date;
    updatedAt: Date;
    finishedAt?: Date;
    /** The live stream a reopened modal can re-attach to (in-memory; gone after a restart). */
    streamId?: string;
    error?: string;
}

export interface AiSuggestionDoc {
    _id: string; // `${domainId}/${pid}/${uid}` — one latest report per user per problem
    domainId: string;
    pid: number;
    uid: number;
    report: string;
    attempts: number;
    updateAt: Date;
    /** ai-speedup WP2: the generation job (the report streams into the modal). */
    job?: AiSuggestionJob;
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

/** ai-speedup WP2: the job block of a suggestion report (created even before a report exists). */
export async function setSuggestionJob(domainId: string, pid: number, uid: number, job: Partial<AiSuggestionJob>): Promise<void> {
    const $set: any = { domainId, pid, uid };
    for (const [k, v] of Object.entries(job)) $set[`job.${k}`] = v;
    $set['job.updatedAt'] = new Date();
    await collSuggestion.updateOne({ _id: `${domainId}/${pid}/${uid}` as any }, { $set, $setOnInsert: { report: '', attempts: 0 } }, { upsert: true });
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
/**
 * The rubric's tutoring EVIDENCE for a session: every thread carrying an
 * 🎓 ownership walkthrough, a 🔧 fix-conversion state, a 🧩 reasoning
 * state OR a 💡 initiative grade (a student who failed and answered but
 * never resubmitted has reasoning only; one who resubmitted but never
 * passed has fixconv; one whose every answer failed live grading may
 * carry initiative alone — none must be missed).
 */
export async function getOwnershipIn(domainId: string, ssid: ObjectId, uid?: number): Promise<{
    uid: number;
    pid: number;
    ownership?: OwnershipState;
    fixconv?: FixConvState;
    surfacedKp?: { names: string[] };
    reasoning?: { levels: number[], answerKeys?: string[] };
    initiative?: { level: number };
    integrity?: { own?: boolean, fix?: boolean, rea?: boolean, ini?: boolean };
}[]> {
    const filter: any = {
        domainId,
        ssid,
        $or: [
            { ownership: { $exists: true } }, { fixconv: { $exists: true } },
            { reasoning: { $exists: true } }, { initiative: { $exists: true } },
            { integrity: { $exists: true } },
        ],
    };
    if (typeof uid === 'number') filter.uid = uid;
    return await collTutor.find(filter).project({
        uid: 1, pid: 1, ownership: 1, fixconv: 1, surfacedKp: 1, reasoning: 1, initiative: 1, integrity: 1,
    }).limit(5000).toArray() as any;
}

/* ------------------- persisted AI class reports (teachers) ------------------- */

export interface RemedialPrompt {
    concept: string;
    kind: 'programming' | 'function';
    difficulty: 'intro' | 'medium' | 'challenge';
    title: string;
    brief: string;
    /** Task labels of the activity (P7, F2…) the new task must NOT resemble. */
    avoid: string[];
    students: string[];
    uids: number[];
}

export interface AiClassReportDoc {
    _id: string; // `${domainId}/${tid}` — one latest report per activity
    domainId: string;
    tid: string;
    reportAnon: string;
    reportNamed: string;
    sidMap: { s: string, uid: number, uname: string }[];
    /** AI-classified knowledge points: name -> per-problem affected-student counts. */
    concepts: { name: string, problems: Record<string, number>, students: string[] }[];
    /**
     * PTA fork — REMEDIAL PROMPTS: one AI-written Studio brief per concept,
     * emitted by the same reduce call as `concepts` (json:remedial trailer).
     * Shown as editable cards on the report; the teacher ticks the ones to
     * turn into tasks and the Studio drafts them (handler/self_learning.ts
     * AiClassReportHandler.postRemedialCreate). `students` are display
     * names after substitution; `uids` keep the real ids so the report can
     * rank existing tasks by how many affected students have not solved them.
     */
    remedial?: RemedialPrompt[];
    /**
     * The Studio drafts already created from `remedial` (appended by
     * postRemedialCreate). Reopening the report shows THESE — with live
     * status pulled from the Studio — instead of the create cards for the
     * concepts they cover; only concepts without a draft still get a card.
     * Survives report regeneration (setClassReport $sets other fields).
     */
    remedialDrafts?: { concept: string, draftId: ObjectId, title: string, kind: string, createdAt: Date }[];
    statsSnapshot: any;
    participants: number;
    generatedBy: number;
    generatedAt: Date;
    /**
     * 📡 The self-learning session report is generated by a BACKGROUND JOB
     * the page polls (it can take minutes: every student's submissions and
     * tutor dialogues go through the model in batches, then one reduce).
     * The job's progress lives here so a page refresh — or a second tab —
     * finds it. `done`/`total` count the map batches.
     */
    job?: {
        status: 'running' | 'done' | 'failed';
        stage: 'collect' | 'map' | 'reduce' | 'finalize' | 'done';
        done: number;
        total: number;
        startedAt: Date;
        /**
         * 💓 Heartbeat: written by every progress update. A running job is
         * considered dead only when THIS is old — a 200-student run takes
         * far longer than any fixed limit measured from startedAt.
         */
        updatedAt?: Date;
        finishedAt?: Date;
        error?: string;
        by?: number;
        /** Coverage: students whose transcript the model read this run, from the cache, and (at the end) not at all. */
        students?: number;
        analyzed?: number;
        cached?: number;
        unanalyzed?: number;
        /** ai-speedup WP5: the scheduler had no capacity for the current call (queue position / ETA); null once granted. */
        waiting?: { ahead: number, eta: number } | null;
    };
}

const collClassReport = db.collection('ai.class_report' as any);

export async function getClassReport(domainId: string, tid: string): Promise<AiClassReportDoc | null> {
    return await collClassReport.findOne({ _id: `${domainId}/${tid}` as any }) as any;
}

/** Record drafts created from a report's remedial cards (kept across regenerations). */
export async function addClassReportDrafts(domainId: string, tid: string, entries: NonNullable<AiClassReportDoc['remedialDrafts']>): Promise<void> {
    if (!entries.length) return;
    await collClassReport.updateOne(
        { _id: `${domainId}/${tid}` as any },
        { $push: { remedialDrafts: { $each: entries } } } as any,
    );
}

export async function setClassReport(doc: Omit<AiClassReportDoc, '_id' | 'generatedAt' | 'job'>): Promise<Date> {
    const generatedAt = new Date();
    await collClassReport.updateOne(
        { _id: `${doc.domainId}/${doc.tid}` as any },
        { $set: { ...doc, generatedAt } },
        { upsert: true },
    );
    return generatedAt;
}

/** 📡 Record where the report job stands (upserts the document if none exists yet). */
export async function setClassReportJob(domainId: string, tid: string, job: AiClassReportDoc['job']): Promise<void> {
    await collClassReport.updateOne(
        { _id: `${domainId}/${tid}` as any },
        { $set: { domainId, tid, job: { ...job, updatedAt: new Date() } } },
        { upsert: true },
    );
}

/** 💓 A running job whose heartbeat (last progress write) is older than `silenceMs` is treated as dead. */
export function classReportJobStale(job: AiClassReportDoc['job'] | null | undefined, silenceMs: number): boolean {
    if (!job || job.status !== 'running') return false;
    const last = job.updatedAt || job.startedAt;
    return !last || Date.now() - new Date(last).getTime() > silenceMs;
}

/*
 * 🗂 PER-STUDENT MAP CACHE. The map stage's findings for one student,
 * keyed by a hash of everything the model read about them (their
 * transcript). Regenerating the report for a 200-student class then only
 * sends the students whose data changed since the last run; the rest are
 * merged from here — analyzed once, never dropped.
 */
export interface ClassReportMapCacheDoc {
    _id: string; // `${domainId}/${tid}/${uid}`
    domainId: string;
    tid: string;
    uid: number;
    hash: string;
    findings: any;
    at: Date;
}

const collClassReportMap = db.collection('ai.class_report.map' as any);

export async function getClassReportMapCache(domainId: string, tid: string, uids: number[]): Promise<Map<number, ClassReportMapCacheDoc>> {
    if (!uids.length) return new Map();
    const docs = await collClassReportMap.find({ domainId, tid, uid: { $in: uids } }).limit(uids.length + 1).toArray() as any as ClassReportMapCacheDoc[];
    return new Map(docs.map((d) => [d.uid, d]));
}

export async function setClassReportMapCache(domainId: string, tid: string, uid: number, hash: string, findings: any): Promise<void> {
    await collClassReportMap.updateOne(
        { _id: `${domainId}/${tid}/${uid}` as any },
        { $set: { domainId, tid, uid, hash, findings, at: new Date() } },
        { upsert: true },
    );
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

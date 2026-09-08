import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { createHash } from 'crypto';
import { escapeRegExp } from 'lodash';
import moment from 'moment-timezone';
import { ObjectId } from 'mongodb';
import { STATUS, STATUS_SHORT_TEXTS, STATUS_TEXTS } from '@hydrooj/common';
import { Context } from '../context';
import { Logger } from '../logger';
import { ContestNotLiveError, ContestNotAttendedError,
    BadRequestError, ForbiddenError, NotFoundError, PermissionError,
    ProblemConfigError, ProblemNotAllowLanguageError, ValidationError,
} from '../error';
import type { PenaltyRules, ProblemDoc, RecordDoc } from '../interface';
import * as aiTutor from '../lib/ai_tutor';
import { activityPids, repairLegacyHiddenFlags } from '../lib/activity_pids';
import { paperFeedbackFor } from '../lib/objective_feedback';
import {
    QUICK_JOB_STALE_MS, resultsHashOf, startQuickReview,
} from '../lib/quick_review';
import {
    getQuick, getQuickForTeacher, quickJobStale, setQuestionPoints, setQuickReleased, studentFeedbackVisible,
} from '../model/quick_review';
import { seesEveryProblem } from './problem';
import {
    ACTIVITY_JOB_STALE_MS, activityReportContext, buildActivityCorpus, extractRemedialBlock, renderActivityStudent, runActivityReportJob,
} from '../lib/activity_report';
import { objectiveSubKindOf } from '../lib/objective_markdown';
import { objectiveTitleOf } from '../lib/objective_title';
import { ContestDetailBaseHandler, paperOf } from './contest';
import { convertPenaltyRules, validatePenaltyRules } from './homework';
import { PROBLEM_KIND_FILTERS } from './problem';
// Bonus tasks reuse the AI Studio's draft + verification pipeline. (Cross-file
// function import: under dev-mode hot reload an edit to ai_author.ts keeps
// these references on the previous module instance until a restart.)
import {
    bonusState, createBonusDraft, createRemedialDrafts, draftSummariesIn, ensureBonusPublished, hasBonusDraft, materializeBonus, publishReadyBonusTasks, retryBonus,
} from './ai_author';
import KnowledgeModel from '../model/knowledge';
import * as document from '../model/document';
import { PERM, PRIV } from '../model/builtin';
import * as contest from '../model/contest';
import type { ScoreOverride } from '../model/contest';
import domain from '../model/domain';
import problem from '../model/problem';
import record, { harnessFor } from '../model/record';
import storage from '../model/storage';
import SelfLearningModel, { computeGate, SessionGate, SelfLearningBonusEntry, SessionResultRow, SessionResults, TYPE_SELF_LEARNING, classReportJobStale, collProgress, collTutor, getClassReport, getClassReportMapCache, getSubjective, listSubjective, removeSubjectiveFile, setClassReport, setClassReportJob, setClassReportMapCache, setSubjectiveReport, upsertSubjectiveFile, getSuggestionReport, setSuggestionReport, SelfLearningDoc, TutorMessage, TutorThreadDoc, OwnershipState, FixConvState, FixConvTransition, TransferAssessment, getOwnershipIn, getSessionThreads, RemedialPrompt, addClassReportDrafts } from '../model/selflearning';
import * as setting from '../model/setting';
import system from '../model/system';
import user from '../model/user';
import db from '../service/db';
import { Handler, param, Types } from '../service/server';

const logger = new Logger('self-learning');
const JUDGING = [STATUS.STATUS_WAITING, STATUS.STATUS_JUDGING, STATUS.STATUS_COMPILING, STATUS.STATUS_FETCHED];

async function loadSession(domainId: string, ssid: ObjectId): Promise<SelfLearningDoc> {
    const sdoc = await SelfLearningModel.get(domainId, ssid);
    if (!sdoc) throw new NotFoundError(domainId, ssid);
    return sdoc;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export type SessionTaskKind = 'programming' | 'function' | 'objective' | 'subjective';

/**
 * Kinds answered WITH CODE. A function task (pid F…) is a programming task
 * whose answer is one function — it enters the scratchpad, is judged by
 * compiling (model/record.ts splices the harness in), gets the tutor, and
 * is graded by the programming rubric. Every "is this programming?" gate in
 * this file asks this instead, so the two kinds never drift apart.
 */
export const CODE_SESSION_KINDS = new Set<SessionTaskKind>(['programming', 'function']);
export const isCodeSessionKind = (k: SessionTaskKind | string) => CODE_SESSION_KINDS.has(k as SessionTaskKind);

/**
 * Site convention (handler/problem.ts problemKindOf): the display pid's
 * first letter is authoritative — P programming, O objective, S subjective —
 * and the judge config is only the fallback for legacy problems without a
 * prefix. Accepts both config shapes: the raw config.yaml STRING that list
 * projections carry, and the parsed object that problem.get / getList
 * return.
 *
 * Self-learning sessions are programming-only: the editor validates every
 * pid against this, and the tutor / scratchpad surfaces key off it too.
 */
export function sessionKindOf(pdoc: any): SessionTaskKind {
    const pid = String(pdoc?.pid || '');
    if (/^s/i.test(pid)) return 'subjective';
    if (/^o/i.test(pid)) return 'objective';
    if (/^f/i.test(pid)) return 'function';
    if (/^p/i.test(pid)) return 'programming';
    const conf = pdoc?.config;
    if (typeof conf === 'string') return /^\s*type:\s*['"]?objective/im.test(conf) ? 'objective' : 'programming';
    return aiTutor.problemKindOf(conf) === 'objective' ? 'objective' : 'programming';
}

export type SessionPhase = 'open' | 'notStarted' | 'running' | 'extension' | 'ended';

/**
 * Homework-parity schedule resolution for a session. Field mapping:
 * beginAt ↔ homework beginAt, endAt ↔ homework penaltySince (the nominal
 * deadline), endAt + extensionDays ↔ homework endAt (the hard stop). Legacy
 * sessions without dates resolve to 'open' — always available, no penalty —
 * so nothing changes for documents created before this feature.
 */
export function sessionSchedule(sdoc: SelfLearningDoc, now = new Date()) {
    if (!sdoc?.beginAt || !sdoc?.endAt) {
        return {
            phase: 'open' as SessionPhase, penalty: 0, maxPenalty: 0, beginAt: null, endAt: null, hardEndAt: null,
        };
    }
    const extMs = Math.max(0, Math.round((sdoc.extensionDays || 0) * DAY_MS));
    const hardEndAt = new Date(sdoc.endAt.getTime() + extMs);
    let phase: SessionPhase;
    if (now < sdoc.beginAt) phase = 'notStarted';
    else if (now <= sdoc.endAt) phase = 'running';
    else if (extMs > 0 && now <= hardEndAt) phase = 'extension';
    else phase = 'ended';
    // Percent view of the tier that applies RIGHT NOW (0 before the
    // deadline and inside the grace tier), plus the deepest tier for
    // "up to −N%" previews before the window opens.
    const penalty = Math.round((1 - penaltyCoefficientAt(sdoc, now)) * 100);
    const factors = (sdoc.penaltyRules && Object.keys(sdoc.penaltyRules).length)
        ? Object.values(sdoc.penaltyRules).map((v) => Math.min(1, Math.max(0, +v || 0)))
        : (typeof sdoc.penalty === 'number' ? [Math.min(1, Math.max(0, (100 - sdoc.penalty) / 100))] : []);
    const maxPenalty = factors.length ? Math.round((1 - Math.min(...factors)) * 100) : 0;
    return {
        phase, penalty, maxPenalty, beginAt: sdoc.beginAt, endAt: sdoc.endAt, hardEndAt,
    };
}

/**
 * Homework's exact tier selection (model/contest.ts penaltyScore): keys are
 * HOURS past the deadline; sorted ascending, the largest key whose hour-mark
 * has elapsed supplies the coefficient — so lateness inside the first key's
 * hour rides free at 1.0, exactly as homework grades it. Legacy sessions
 * saved with the earlier single `penalty` percent map to
 * { 0: (100 - penalty) / 100 }: the same flat factor from the first late
 * second that they had before this feature existed.
 */
/**
 * ⏹ THE SESSION CUTOFF — the instant after which nothing a student does can
 * influence their score. It is the hard end (deadline + extension); a
 * session without dates never closes, so everything counts.
 *
 * After it the session stays OPEN for practice: the student may keep
 * submitting and keep talking to the tutor. Those records and messages are
 * simply invisible to every scoring path — scoreRecords already drops late
 * records, the tutor stores no grades any more (practice mode), and the
 * loaders below cut records and messages at this instant so the retroactive
 * graders (🔧 fix-conversion, 💡 initiative, 🧩 reasoning, 📈 trajectory,
 * 🧠 transfer) can never see post-session activity either.
 */
export function sessionCutoff(sdoc: SelfLearningDoc): number {
    const hard = sessionSchedule(sdoc).hardEndAt;
    return hard ? hard.getTime() : Number.POSITIVE_INFINITY;
}

/** Session threads with every post-cutoff message removed (grading input). */
async function gradedSessionThreads(domainId: string, sdoc: SelfLearningDoc): Promise<TutorThreadDoc[]> {
    const cap = sessionCutoff(sdoc);
    const threads = await gradedSessionThreads(domainId, sdoc);
    if (!Number.isFinite(cap)) return threads;
    return threads.map((t) => ({
        ...t,
        messages: (t.messages || []).filter((m) => !m.at || new Date(m.at).getTime() <= cap),
    })) as TutorThreadDoc[];
}

/** True while a record belongs to the session (i.e. was made before the cutoff). */
function recordCounts(rid: ObjectId, cap: number): boolean {
    return !Number.isFinite(cap) || rid.getTimestamp().getTime() <= cap;
}

export function penaltyCoefficientAt(sdoc: SelfLearningDoc, at: Date): number {
    if (!sdoc?.endAt) return 1;
    const exceedSeconds = Math.floor((at.getTime() - sdoc.endAt.getTime()) / 1000);
    if (exceedSeconds < 0) return 1;
    const rules: PenaltyRules | null = (sdoc.penaltyRules && Object.keys(sdoc.penaltyRules).length)
        ? sdoc.penaltyRules
        : (typeof sdoc.penalty === 'number'
            ? { 0: Math.min(1, Math.max(0, (100 - sdoc.penalty) / 100)) }
            : null);
    if (!rules) return 1;
    let coefficient = 1;
    const keys = Object.keys(rules).map(Number.parseFloat).sort((a, b) => a - b);
    for (const i of keys) {
        if (i * 3600 <= exceedSeconds) coefficient = rules[i];
        else break;
    }
    return Math.min(1, Math.max(0, coefficient));
}

/* ------------------------------------------------------------------ */
/*  THE evaluation rubric — single source of truth                     */
/* ------------------------------------------------------------------ */
export interface TaskBest {
    /** Raw score of the counting record. */
    score: number;
    /** What the session counts: raw × the late-tier coefficient at submission time. */
    effective: number;
    /** True when a late tier actually reduced this record's score. */
    late: boolean;
    /** Judged, non-pretest attempts on the task (inside the counting window). */
    attempts: number;
}

/**
 * THE session scoring rubric — the one place where "what does a student's
 * work count for" is decided:
 *   - a record submitted after the hard end (endAt + extension) never
 *     counts (submissions from other surfaces, e.g. the plain problem
 *     page, land on the same pid and would otherwise sneak in);
 *   - effective = the raw score (⏱ the teacher's tiered late rule is a
 *     SESSION-TOTAL multiplier now — latePenaltyOf — keyed to the
 *     student's LAST counted submission, so no record is individually
 *     reduced);
 *   - a task's counting record is the one with the highest score, and on
 *     equal scores the on-time record beats a late one;
 *   - EACH programming task is worth TASK_RUBRIC_MAX (100) points,
 *     split across FIVE sub-rubrics (🏆30 🎓20 🔧15 🧩30 💡5, summing to
 *     100); a task's score = the SUM of its earned sub-rubric points
 *     (taskRubricOf; the 🔧/🧩/💡 placeholders earn nothing yet, so a
 *     task currently tops out at 50);
 *   - 🅰 Block A (BLOCK_A_MAX, 75) = (Σ task scores) / (taskCount × 100)
 *     × 75 — five tasks summing 500/500 → 75, 250 → 37.5 — with an
 *     unattempted task counting 0 but staying in the denominator (the
 *     placeholder points not being earnable caps 🅰 at BLOCK_A_EARNABLE,
 *     37.5, for now);
 *   - 🅱 Block B (BLOCK_B_MAX, 25) — per STUDENT across the session:
 *     📈 Independence Trajectory (10, one LLM level × 2.5) + 🧠 Concept
 *     Transfer (15, mean re-encounter level × 3.75; untestable → full
 *     15) — blockBOf;
 *   - the session total (SESSION_TOTAL_MAX, 100) = Block A + Block B.
 *
 * EVERY consumer flows through here: the teacher's "Evaluate all students
 * now" button, the automatic post-deadline sweep and the on-view
 * finalization (all three via runSessionEvaluation, THE single evaluation
 * routine, which delegates to computeSessionResults), and the student's
 * own score card and per-task chips (SelfLearningDetailHandler). Change
 * the rubric HERE and press the button on any session to see the effect
 * immediately — the automatic evaluation will produce the same numbers.
 */
export function scoreRecords(sdoc: SelfLearningDoc, rows: { pid: number, score: number, at: Date, accepted?: boolean }[]): Map<number, TaskBest> {
    const hardEnd = sessionSchedule(sdoc).hardEndAt || null;
    const best = new Map<number, TaskBest>();
    for (const r of rows) {
        if (hardEnd && r.at > hardEnd) continue;
        const score = r.score || 0;
        // ⏱ The teacher's tiered late rule applies to the student's session
        // TOTAL (latePenaltyOf), not per record — a record keeps its raw
        // score; `late` merely marks submissions past the deadline.
        const effective = score;
        const late = !!(sdoc.endAt && r.at > sdoc.endAt);
        const cur = best.get(r.pid);
        if (!cur) best.set(r.pid, { score, effective, late, attempts: 1 });
        else {
            cur.attempts += 1;
            if (effective > cur.effective || (effective === cur.effective && cur.late && !late)) {
                cur.score = score;
                cur.effective = effective;
                cur.late = late;
            }
        }
    }
    return best;
}

/**
 * ⏱ THE SESSION-LEVEL LATE PENALTY — the teacher's tiered rule
 * (penaltyRules, "hours: coefficient") multiplies the STUDENT'S TOTAL.
 * The student's lateness is their LAST counted submission (records after
 * the hard end never count at all), and the factor is homework's exact
 * tier selection (penaltyCoefficientAt): lateness inside the first
 * tier's hour rides free. Returns null when nothing applies — no
 * deadline, no counted rows, on time, or a factor of 1.
 */
export function latePenaltyOf(
    sdoc: SelfLearningDoc,
    rows: { at: Date }[],
): { factor: number, hours: number } | null {
    if (!sdoc?.endAt || !rows?.length) return null;
    const hardEnd = sessionSchedule(sdoc).hardEndAt || null;
    let lastAt: Date | null = null;
    for (const r of rows) {
        if (hardEnd && r.at > hardEnd) continue;
        if (!lastAt || r.at > lastAt) lastAt = r.at;
    }
    if (!lastAt || lastAt <= sdoc.endAt) return null;
    const factor = penaltyCoefficientAt(sdoc, lastAt);
    if (factor >= 1) return null;
    const hours = Math.round(((lastAt.getTime() - sdoc.endAt.getTime()) / 3600000) * 10) / 10;
    return { factor, hours };
}

/** A 'running' manual evaluation older than this is treated as crashed. */
export const EVAL_JOB_STALE_MS = 10 * 60 * 1000;

/** The session grade scale: a session is evaluated out of 100. */
export const SESSION_TOTAL_MAX = 100;

/* ------------------------------------------------------------------ */
/*  ⭐ THE SESSION RUBRIC — Blocks A & B                               */
/* ------------------------------------------------------------------ */
/*
 * Total (100) = 🅰 Block A (75, per-task rubrics) + 🅱 Block B (25,
 * cross-task rubrics; not implemented yet, counts 0).
 *
 * 🅰 Block A — evaluated PER TASK: every programming task is worth
 * TASK_RUBRIC_MAX (100) points, split across FIVE sub-rubrics whose
 * point values sum to exactly 100:
 *   🏆 Achievement (30) — judged effective score × 30% (best test-case
 *      score, late tier applied — exactly what scoreRecords produces;
 *      the table shows it as "judged→points", e.g. 100→30);
 *   🎓 Code Ownership (20) — can the student explain their OWN accepted
 *      code? After an acceptance the AI tutor runs a walkthrough (5..6
 *      questions when accepted on the very first attempt, 2..3 otherwise
 *      — ownershipBudget); the LLM grades every answer on the L0..L4
 *      authorship scale (0 evasion · 1 restates the code · 2 correct
 *      mechanical account · 3 + why it's necessary · 4 + a
 *      generalization; 2→3 is the discriminating boundary), an asked-
 *      but-never-answered question counting level 0; the task earns
 *      taskMeanOf(levels) × 5 points. No walkthrough yet → 0;
 *   🔧 Guidance-to-Fix Conversion (15) — do students understand their
 *      fault and make correct changes? Judged on every failed-attempt →
 *      answered-guidance → resubmission transition (engaging and then
 *      never resubmitting is NEVER counted — extractFixConvCandidates
 *      only pairs an attempt with the next one); each transition is
 *      LLM-graded L0..L4 (0 targeted domain unchanged · 1 thrashing ·
 *      2 right area, incomplete · 3 flaw correctly addressed · 4 minimal
 *      targeted fix, no collateral rewriting), with the trial penalty
 *      1 → 0.8 → 0.6 → 0.5-after (fixConvPenalty, sequential per task);
 *      the task earns mean(level × penalty) × 3.75 points
 *      (taskFixConvMeanOf / 4 × 15). No judged transitions yet → 0;
 *   🧩 Reasoning Quality (30) — does the tutor's question get a
 *      substantial answer: thinking, not guessing? Judged per exchange,
 *      across all cycles, on FAILURE-PHASE answers only (while the
 *      program is not accepted — everything before the first
 *      acceptance); each answer is LLM-graded L0..L4 (0 no substantive
 *      answer, off-topic, or restates the question · 1 a guess with no
 *      reasoning, "maybe the loop?" · 2 relevant reasoning but vague or
 *      partly wrong · 3 correct, specific reasoning about their own
 *      code · 4 correct reasoning PLUS predicts a consequence or
 *      generalizes) — live in the dialogue, retroactively by
 *      backfillReasoningGrades; the task earns mean(level) × 7.5 points
 *      (reasoningTaskMeanOf / 4 × 30). Nothing graded yet → 0;
 *   💡 Self-Diagnostic Initiative (5) — does the student show up with a
 *      THEORY, or wait to be led? ONE grade per task, judged over the
 *      FIRST-ENGAGEMENT failure dialogue only, once that window has
 *      CLOSED (first acceptance, parking, or session end). Two signals
 *      combine: a hypothesis VOLUNTEERED before the tutor localized the
 *      flaw (a wrong one still counts) and the quality of the
 *      comprehension-stage answers (restate the task, state the
 *      constraints, explain the approach). LLM-graded L0..L4 (0 no
 *      hypothesis, comprehension weak or absent · 1 no hypothesis,
 *      comprehension adequate · 2 a vague hypothesis, "something with
 *      the loop", OR strong comprehension alone · 3 a specific,
 *      plausible hypothesis pointing at the right area · 4 a specific
 *      hypothesis identifying the ACTUAL flaw); the task earns
 *      mean(level) × 1.25 points (level / 4 × 5 — one level per task).
 *      No failure engagement → 0.
 * A task's score = the SUM of its five sub-rubric points — every
 * sub-rubric is implemented, so a task can now reach its full 100.
 *
 * ⭐ FIRST-ATTEMPT EXCEPTION: a task accepted with a SINGLE submission
 * (the chronologically first judged, non-pretest record is Accepted —
 * firstAttemptAcceptedPids, the same truth the walkthrough budget
 * uses) has no failure phase, so 🔧/🧩/💡 do not apply; its 100 points
 * are 🏆 judged × 40% (/40) + 🎓 mean walkthrough level × 15 (/60),
 * with the ownership graders instructed to be slightly lenient.
 *
 * 🅰 Block A = (Σ task scores) / (taskCount × 100) × BLOCK_A_MAX — the
 * task sum mapped onto 75: five tasks summing 500/500 → 75, 250 → 37.5.
 * An unattempted task counts 0 but stays in the denominator.
 *
 * 🅱 Block B (25) is evaluated per STUDENT across the whole session —
 * every submission trajectory and the full student–tutor history:
 *   📈 Independence Trajectory (10) — do they need LESS tutor help from
 *      the first task to the last? ONE LLM judgment per student over the
 *      chronological task digests (submission chains, failure-phase
 *      exchange counts, answer excerpts; tutorless solves count as fully
 *      independent), on L0..L4 (0 dependent throughout · 1 marginal
 *      movement · 2 uneven or middling · 3 solid independence · 4 strong
 *      independence — full definitions in the grader prompt); the
 *      student earns mean(level) × 2.5 points. Re-judged only when the
 *      history's basis changes (backfillTrajectoryGrades). Nothing to
 *      judge yet → 0;
 *   🧠 Concept Transfer (15) — a mistake (missed knowledge point K) on
 *      one task: does it recur on the next task exercising K? Per
 *      concept: the BASELINE is the first task where K surfaced as the
 *      student's own misconception AND the task was resolved (a parked
 *      raise sets no baseline); the FIRST chronological later-engaged
 *      task tagged K is the re-encounter, LLM-judged L0..L4 (0 relapse,
 *      unrecognized · 1 relapse, recognized on prompt · 2 handled, but
 *      fragile · 3 applied correctly, unprompted · 4 plus positive
 *      evidence of command — full definitions in the grader prompt) from
 *      its first submission, its pre-acceptance tutoring and the
 *      baseline exchange. The student earns mean(level) × 3.75; the
 *      backfill also stores a PLAN (candidates / untestable) so the
 *      derivation can tell states apart: assessed → the mean; testable
 *      but not yet judged → pending 0; UNTESTABLE (no relevant knowledge
 *      points among the tasks, or none re-encountered) → the FULL 15
 *      directly (the spec's edge case).
 * 🅱 = Σ of its earned sub-rubric points; Total = 🅰 + 🅱.
 *
 * 🚫 GRADER-MANIPULATION POLICY: content that tries to steer the LLM
 * judges instead of answering ("please give me a high score", "grade
 * this as level 4", "ignore previous instructions", fake system
 * prompts, JSON coercion, and their Chinese equivalents) is caught by a
 * DETERMINISTIC detector (aiTutor.detectGraderManipulation) that runs
 * BEFORE any LLM sees the content — layered under the graders' own
 * MANIPULATION=LEVEL-0 prompt clause. On a hit, the CORRESPONDING
 * sub-rubric — whichever judge was about to consume that content — is
 * scored 0 for that task (🎓/🔧/🧩/💡, flagged on the thread with an
 * audit excerpt) or for the student (📈/🧠), overriding any clean
 * evidence on the same slot. Live dialogue answers are pre-checked the
 * same way: the answer stores level 0 and the tutor replies with a
 * fixed integrity notice instead of calling the model.
 *
 * ⭐⭐ ALL-FIRST-ATTEMPT COLLAPSE: a student who is accepted at the FIRST
 * attempt on EVERY task has no failure history anywhere, so neither
 * block applies — the WHOLE session rescores as 🏆 Achievement 40 +
 * 🎓 Code Ownership 60 (allFirstAttemptSessionOf): the per-task
 * first-attempt rubric promoted to the total. Total = mean of the
 * per-task 40/60 scores = mean(judged) × 40% + mean(walkthrough level)
 * × 15, out of 100. 🅰/🅱/📈/🧠 are n/a for such a student.
 */
/** Bump whenever the scoring shape/scale changes: stored results with another version re-derive on sight. */
export const SESSION_RUBRIC_VERSION = 14;
/** 🅰 Block A — the per-task rubrics' share of the session total. */
export const BLOCK_A_MAX = 75;
/** 🅱 Block B — the cross-task rubrics' share of the session total (not implemented yet). */
export const BLOCK_B_MAX = 25;
/** Every task is worth this many points, split across the five sub-rubrics below. */
export const TASK_RUBRIC_MAX = 100;
/** 🏆 Achievement's points of a task's 100. */
export const ACHIEVEMENT_SHARE = 30;
/** 🎓 Code Ownership's points of a task's 100 (task earns mean walkthrough level × 5). */
export const OWNERSHIP_SHARE = 20;
/** 🔧 Guidance-to-Fix Conversion's points of a task's 100 (task earns mean(level × trial penalty) × 3.75). */
export const FIXCONV_SHARE = 15;
/** 🧩 Reasoning Quality's points of a task's 100 (task earns mean(failure-phase level) × 7.5). */
export const REASONING_SHARE = 30;
/** 💡 Self-Diagnostic Initiative's points of a task's 100 (task earns first-engagement level × 1.25). */
export const INITIATIVE_SHARE = 5;
/** The LLM grades each post-acceptance answer on 0..OWNERSHIP_LEVEL_MAX. */
export const OWNERSHIP_LEVEL_MAX = 4;
/** The LLM grades each guidance→fix transition on 0..FIXCONV_LEVEL_MAX. */
export const FIXCONV_LEVEL_MAX = 4;
/** The LLM grades each failure-phase answer on 0..REASONING_LEVEL_MAX. */
export const REASONING_LEVEL_MAX = 4;
/** The LLM grades each task's first engagement on 0..INITIATIVE_LEVEL_MAX. */
export const INITIATIVE_LEVEL_MAX = 4;
/* ---- 🅱 Block B (25) — cross-task sub-rubrics, per STUDENT ---- */
/** 📈 Independence Trajectory's points of Block B's 25 (student earns level × 2.5). */
export const TRAJECTORY_SHARE = 10;
/** 🧠 Concept Transfer's points of Block B's 25 (student earns mean(re-encounter level) × 3.75; untestable → the full 15). */
export const TRANSFER_SHARE = 15;
/** The LLM grades the whole-session trajectory on 0..TRAJECTORY_LEVEL_MAX. */
export const TRAJECTORY_LEVEL_MAX = 4;
/** The LLM grades each concept re-encounter on 0..TRANSFER_LEVEL_MAX. */
export const TRANSFER_LEVEL_MAX = 4;
/** 🅱's earnable ceiling — with 📈 and 🧠 both live it equals BLOCK_B_MAX (10 + 15 = 25). */
export const BLOCK_B_EARNABLE = TRAJECTORY_SHARE + TRANSFER_SHARE;
/**
 * ⭐ FIRST-ATTEMPT EXCEPTION — a task ACCEPTED with a single submission
 * has no failure phase, so 🔧/🧩/💡 cannot apply. Its 100 points
 * renormalize to 🏆 Achievement 40 + 🎓 Code Ownership 60 (the
 * walkthrough asks 5–6 questions and its LLM grading is slightly
 * lenient — see the graders in lib/ai_tutor).
 */
export const FIRST_ATTEMPT_ACH_MAX = 40;
export const FIRST_ATTEMPT_OWN_MAX = 60;
/**
 * 🔧 The trial penalty across a task's guided resubmissions, sequential:
 * the 1st guidance→fix trial counts in full, the 2nd ×0.8, the 3rd ×0.6,
 * and every trial after that ×0.5.
 */
export function fixConvPenalty(trial: number): number {
    if (trial <= 1) return 1;
    if (trial === 2) return 0.8;
    if (trial === 3) return 0.6;
    return 0.5;
}
/** Σ of the IMPLEMENTED sub-rubric points per task — ALL FIVE now: 30 + 20 + 15 + 30 + 5 = 100. */
export const IMPLEMENTED_TASK_SHARES = ACHIEVEMENT_SHARE + OWNERSHIP_SHARE + FIXCONV_SHARE + REASONING_SHARE + INITIATIVE_SHARE;
/** 🅰's earnable ceiling — with every sub-rubric implemented it equals BLOCK_A_MAX (100/100 × 75 = 75). */
export const BLOCK_A_EARNABLE = Math.round((IMPLEMENTED_TASK_SHARES * BLOCK_A_MAX * 10) / TASK_RUBRIC_MAX) / 10;

const round1 = (x: number) => Math.round(x * 10) / 10;

export interface TaskRubricPart {
    /** Stable machine key of the sub-rubric ('achievement' | 'ownership' | 'fixconv' | 'reasoning' | 'initiative'). */
    key: string;
    /** The sub-rubric's point value of the task's 100 (30/20/15/30/5). */
    share: number;
    /** The POINTS this task earned on the sub-rubric (0..share, one decimal); null = pending placeholder. */
    points: number | null;
    /** True while the sub-rubric is not implemented yet (points null, earns nothing). */
    pending?: boolean;
}
/** 🎓 The Code-Ownership evidence of ONE task, as taskRubricOf consumes it. */
export interface TaskOwnershipInput {
    /** taskMeanOf of the walkthrough (0..4, asked-unanswered = 0); null = no walkthrough questions yet. */
    level: number | null;
}
export interface TaskRubricBreakdown {
    pid: number;
    /** False = no judged record inside the counting window (score 0). */
    attempted: boolean;
    /** ⭐ True = accepted on the very first attempt: the task is 🏆40 + 🎓60 and 🔧/🧩/💡 do not apply. */
    firstAttempt: boolean;
    /** The task's score, 0..TASK_RUBRIC_MAX: the SUM of its earned sub-rubric points (pending → 0 earned). */
    score: number;
    /** 🏆 The points earned on Achievement (0..30 = judged × 30%). */
    achPts: number;
    /** The judged evidence behind 🏆: best effective score 0..100. */
    judged: number;
    late: boolean;
    /** 🎓 The points earned on Code Ownership (0..20 = mean level × 5; 0 when unmeasured). */
    ownPts: number;
    /** 🎓 The mean walkthrough level behind it (0..4, 2 decimals); null = no walkthrough yet. */
    ownLevel: number | null;
    /** 🔧 The points earned on Guidance-to-Fix Conversion (0..15 = penalty-weighted mean level × 3.75; 0 when unmeasured). */
    fixPts: number;
    /** 🔧 The penalty-weighted mean level behind it (0..4, 2 decimals); null = no judged transitions yet. */
    fixLevel: number | null;
    /** 🧩 The points earned on Reasoning Quality (0..30 = mean failure-phase level × 7.5; 0 when unmeasured). */
    reaPts: number;
    /** 🧩 The mean failure-phase level behind it (0..4, 2 decimals); null = nothing graded yet. */
    reaLevel: number | null;
    /** 💡 The points earned on Self-Diagnostic Initiative (0..5 = first-engagement level × 1.25; 0 when unjudged). */
    iniPts: number;
    /** 💡 The first-engagement level behind it (0..4); null = not judged yet (no closed engagement with answers). */
    iniLevel: number | null;
    parts: TaskRubricPart[];
}

/** 🔧 The Guidance-to-Fix evidence of ONE task, as taskRubricOf consumes it. */
export interface TaskFixConvInput {
    /** taskFixConvMeanOf of the state (0..4, penalty-weighted); null = no judged transitions yet. */
    level: number | null;
}

/** 🧩 The Reasoning-Quality evidence of ONE task, as taskRubricOf consumes it. */
export interface TaskReasoningInput {
    /** reasoningTaskMeanOf of the state (0..4); null = no graded failure-phase answers yet. */
    level: number | null;
}

/** 💡 The Self-Diagnostic-Initiative evidence of ONE task, as taskRubricOf consumes it. */
export interface TaskInitiativeInput {
    /** The one first-engagement level (0..4); null = not judged yet. */
    level: number | null;
}

/**
 * ⭐ ONE task's rubric — the five sub-rubric points and their sum. The
 * single place a task's points are decided: the evaluation, the
 * teacher's table, the CSV and the student's own card all call this, so
 * they can never disagree. Implementing a placeholder later = replace
 * its null points with the real computation here; everything downstream
 * follows automatically.
 */
export function taskRubricOf(
    pid: number,
    best: TaskBest | null | undefined,
    own?: TaskOwnershipInput | null,
    fix?: TaskFixConvInput | null,
    rea?: TaskReasoningInput | null,
    ini?: TaskInitiativeInput | null,
    firstAttempt = false,
): TaskRubricBreakdown {
    // ⭐ First-attempt acceptance: the task's shares renormalize to
    // 🏆 40 + 🎓 60 (no failure phase existed, so 🔧/🧩/💡 cannot apply).
    const fa = !!firstAttempt && !!best;
    const achShare = fa ? FIRST_ATTEMPT_ACH_MAX : ACHIEVEMENT_SHARE;
    const ownShare = fa ? FIRST_ATTEMPT_OWN_MAX : OWNERSHIP_SHARE;
    // 🏆 Achievement (30, or 40 first-attempt): judged effective score × share%.
    const judged = best ? Math.min(100, Math.max(0, best.effective || 0)) : 0;
    const achPts = round1((judged / 100) * achShare);
    // 🎓 Code Ownership (20, or 60 first-attempt): mean walkthrough level
    // × share/4. No walkthrough (not accepted, or the tutor never asked) → 0.
    const ownLevel = typeof own?.level === 'number'
        ? Math.min(OWNERSHIP_LEVEL_MAX, Math.max(0, own.level)) : null;
    const ownPts = ownLevel === null ? 0 : round1((ownLevel / OWNERSHIP_LEVEL_MAX) * ownShare);
    // 🔧 Guidance-to-Fix Conversion (15): penalty-weighted mean level ×
    // 3.75 (level/4 × 15). No judged transitions (never failed, never
    // engaged, or engaged-then-skipped) → 0.
    const fixLevel = typeof fix?.level === 'number'
        ? Math.min(FIXCONV_LEVEL_MAX, Math.max(0, fix.level)) : null;
    const fixPts = fixLevel === null ? 0 : round1((fixLevel / FIXCONV_LEVEL_MAX) * FIXCONV_SHARE);
    // 🧩 Reasoning Quality (30): mean failure-phase level × 7.5
    // (level/4 × 30). Nothing graded (never failed, or never answered
    // while failing) → 0.
    const reaLevel = typeof rea?.level === 'number'
        ? Math.min(REASONING_LEVEL_MAX, Math.max(0, rea.level)) : null;
    const reaPts = reaLevel === null ? 0 : round1((reaLevel / REASONING_LEVEL_MAX) * REASONING_SHARE);
    // 💡 Self-Diagnostic Initiative (5): the one first-engagement level ×
    // 1.25 (level/4 × 5). Not judged (no closed failure engagement with
    // answers) → 0.
    const iniLevel = typeof ini?.level === 'number'
        ? Math.min(INITIATIVE_LEVEL_MAX, Math.max(0, ini.level)) : null;
    const iniPts = iniLevel === null ? 0 : round1((iniLevel / INITIATIVE_LEVEL_MAX) * INITIATIVE_SHARE);
    const parts: TaskRubricPart[] = fa
        ? [
            { key: 'achievement', share: achShare, points: achPts },
            { key: 'ownership', share: ownShare, points: ownPts },
        ]
        : [
            { key: 'achievement', share: achShare, points: achPts },
            { key: 'ownership', share: ownShare, points: ownPts },
            { key: 'fixconv', share: FIXCONV_SHARE, points: fixPts },
            { key: 'reasoning', share: REASONING_SHARE, points: reaPts },
            { key: 'initiative', share: INITIATIVE_SHARE, points: iniPts },
        ];
    const score = round1(parts.reduce((a, pp) => a + (pp.points || 0), 0));
    return {
        pid,
        attempted: !!best,
        firstAttempt: fa,
        score,
        achPts,
        judged,
        late: !!best?.late,
        ownPts,
        ownLevel: ownLevel === null ? null : Math.round(ownLevel * 100) / 100,
        fixPts: fa ? 0 : fixPts,
        fixLevel: fa ? null : (fixLevel === null ? null : Math.round(fixLevel * 100) / 100),
        reaPts: fa ? 0 : reaPts,
        reaLevel: fa ? null : (reaLevel === null ? null : Math.round(reaLevel * 100) / 100),
        iniPts: fa ? 0 : iniPts,
        iniLevel: fa ? null : iniLevel,
        parts,
    };
}

/**
 * ✎ TEACHER SCORE ADJUSTMENTS — apply a student's overrides (model
 * SelfLearningProgressDoc.override) to a computed results row: an
 * adjusted task score replaces the rubric's Σ for that task and Block A
 * (or the ⭐⭐ collapsed total) is re-derived from the task scores with
 * the same arithmetic as the evaluation, the late factor re-applied; an
 * adjusted total then replaces the final total outright. The values
 * replaced are kept in `row.computed`, so the table can mark the cells
 * and the evidence pop-up can show "computed → adjusted: reason".
 * Passing no overrides (or empty ones) restores the computed values.
 */
export function applySessionOverride(rowIn: SessionResultRow, override?: ScoreOverride | null): SessionResultRow {
    const row: any = { ...rowIn };
    const base = row.computed || {
        taskScores: { ...(row.taskScores || {}) }, blockA: row.blockA, total: row.total,
    };
    const tasks = Object.entries(override?.tasks || {}).filter(([pid, o]) => o && typeof o.score === 'number' && pid in base.taskScores);
    const hasTotal = !!(override?.total && typeof override.total.score === 'number');
    if (!tasks.length && !hasTotal) {
        if (row.computed) {
            row.taskScores = { ...base.taskScores };
            row.blockA = base.blockA;
            row.total = base.total;
            delete row.computed;
            delete row.override;
        }
        return row;
    }
    row.computed = base;
    const taskScores: Record<string, number> = { ...base.taskScores };
    const applied: NonNullable<SessionResultRow['override']> = {};
    for (const [pid, o] of tasks) {
        taskScores[pid] = round1(Math.min(TASK_RUBRIC_MAX, Math.max(0, o.score)));
        applied.tasks = { ...(applied.tasks || {}), [pid]: { ...o, computed: base.taskScores[pid] ?? null } };
    }
    const n = Object.keys(taskScores).length;
    const sum = Object.values(taskScores).reduce((a, b) => a + (b || 0), 0);
    let totalBase: number;
    let blockA = base.blockA;
    if (row.allFa) {
        totalBase = n ? round1((sum * SESSION_TOTAL_MAX) / (n * TASK_RUBRIC_MAX)) : 0;
    } else {
        blockA = n ? round1((sum * BLOCK_A_MAX) / (n * TASK_RUBRIC_MAX)) : 0;
        totalBase = round1(blockA + (row.blockB || 0));
    }
    let total = row.lateFactor ? round1(totalBase * row.lateFactor) : totalBase;
    if (hasTotal) {
        applied.total = { ...override!.total!, computed: total };
        total = round1(Math.min(SESSION_TOTAL_MAX, Math.max(0, override!.total!.score)));
    }
    row.taskScores = taskScores;
    row.blockA = blockA;
    row.total = total;
    row.override = applied;
    return row;
}

/**
 * 🅰 Block A = (Σ task scores) / (n × TASK_RUBRIC_MAX) × BLOCK_A_MAX,
 * one decimal — the task sum mapped onto 75, exactly the spec: five
 * tasks summing 500/500 → 75, 250 → 37.5.
 */
export function blockAOf(tasks: TaskRubricBreakdown[]): number {
    if (!tasks.length) return 0;
    const sum = tasks.reduce((a, t) => a + (t.score || 0), 0);
    // Multiply before dividing: 475/500 × 75 must round from the exact
    // 71.25 (→ 71.3), not from 0.95's float representation (→ 71.2).
    return round1((sum * BLOCK_A_MAX) / (tasks.length * TASK_RUBRIC_MAX));
}

/** 📈 The Independence-Trajectory evidence of ONE student, as blockBOf consumes it. */
export interface TrajectoryInput {
    /** The one whole-session level (0..4); null = not judged yet. */
    level: number | null;
}

/**
 * ⭐⭐ THE ALL-FIRST-ATTEMPT COLLAPSE — when EVERY programming task was
 * accepted on the very first attempt, the whole session rescores as
 * 🏆 40 + 🎓 60: Total = mean of the per-task first-attempt scores
 * (each already 🏆 judged × 40% + 🎓 level × 15), with the two parts
 * reported for transparency. Returns null unless every task's breakdown
 * is a first-attempt one (any normal or unattempted task → the standard
 * Block A + Block B rubric applies instead).
 */
export function allFirstAttemptSessionOf(
    tasks: TaskRubricBreakdown[],
): { total: number, ach: number, own: number } | null {
    if (!tasks.length || !tasks.every((t) => t.firstAttempt && t.attempted)) return null;
    const n = tasks.length;
    const sum = tasks.reduce((a, t) => a + (t.score || 0), 0);
    return {
        // Multiply before dividing (the 71.25-style exactness rule).
        total: round1((sum * SESSION_TOTAL_MAX) / (n * TASK_RUBRIC_MAX)),
        ach: round1(tasks.reduce((a, t) => a + (t.achPts || 0), 0) / n),
        own: round1(tasks.reduce((a, t) => a + (t.ownPts || 0), 0) / n),
    };
}

/** 🧠 The Concept-Transfer sub-score of ONE student, as blockBOf consumes it. */
export interface TransferSubScore {
    /** assessed = ≥1 re-encounter judged; pending = testable, judging awaited; untestable = the edge case (full credit). */
    state: 'assessed' | 'pending' | 'untestable';
    /** Mean re-encounter level (0..4, 2 decimals); null unless assessed. */
    level: number | null;
    /** The points: assessed → round1(mean × 3.75); untestable → TRANSFER_SHARE; pending → 0. */
    pts: number;
    /** Re-encounters judged so far. */
    judged: number;
    /** 🚫 True when a manipulation flag zeroed the sub-rubric. */
    flagged?: boolean;
}

/**
 * 🧠 Derive the transfer sub-score from what the backfill stored on the
 * progress doc: the judged assessments and the PLAN (candidate count +
 * the untestable verdict). Assessed → mean(level) × 3.75 over judged
 * re-encounters; no assessments but a clean plan with ZERO candidates →
 * UNTESTABLE, the spec's edge case: the full 15 directly; anything else
 * (candidates awaiting judgment, or no clean plan yet) → pending 0.
 */
export function transferSubScoreOf(
    assessments?: { level: number, flagged?: boolean }[] | null,
    plan?: { candidates: number, untestable: boolean } | null,
): TransferSubScore {
    // 🚫 A single flagged re-encounter zeroes the whole 🧠 sub-rubric.
    if ((assessments || []).some((a) => a.flagged)) {
        return {
            state: 'assessed', level: 0, pts: 0, judged: (assessments || []).length, flagged: true,
        };
    }
    const levels = (assessments || []).map((a) => Math.min(TRANSFER_LEVEL_MAX, Math.max(0, +a.level || 0)));
    if (levels.length) {
        const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
        return {
            state: 'assessed',
            level: Math.round(mean * 100) / 100,
            pts: round1((mean / TRANSFER_LEVEL_MAX) * TRANSFER_SHARE),
            judged: levels.length,
        };
    }
    if (plan?.untestable) return { state: 'untestable', level: null, pts: TRANSFER_SHARE, judged: 0 };
    return { state: 'pending', level: null, pts: 0, judged: 0 };
}

/**
 * 🅱 Block B = the SUM of the student's earned cross-task sub-rubric
 * points: 📈 Independence Trajectory = level × 2.5 (level/4 × 10; not
 * judged yet → 0) + 🧠 Concept Transfer (transferSubScoreOf: assessed →
 * mean × 3.75, untestable → the full 15, pending → 0). Both live, so it
 * tops at BLOCK_B_MAX (25).
 */
export function blockBOf(trj?: TrajectoryInput | null, trf?: TransferSubScore | null): number {
    const trjLevel = typeof trj?.level === 'number'
        ? Math.min(TRAJECTORY_LEVEL_MAX, Math.max(0, trj.level)) : null;
    const trjPts = trjLevel === null ? 0 : round1((trjLevel / TRAJECTORY_LEVEL_MAX) * TRAJECTORY_SHARE);
    return round1(trjPts + (trf?.pts || 0));
}

/** 📈 The one trajectory sub-score on its own (level × 2.5; 0 when unjudged) — what the 📈 column shows. */
export function trajectoryPtsOf(level: number | null): number {
    if (typeof level !== 'number') return 0;
    const l = Math.min(TRAJECTORY_LEVEL_MAX, Math.max(0, level));
    return round1((l / TRAJECTORY_LEVEL_MAX) * TRAJECTORY_SHARE);
}

/** 🏆 RETIRED (old 7-component rubric) — kept only for the dormant machinery below. */
export const SESSION_ACHIEVEMENT_MAX = 20;

/**
 * The session's PROGRAMMING tasks by the site's P/O/S convention — the
 * set the Achievement component maps. One classification rule for both the
 * evaluation and the student card: pass the same pdict shape
 * (PROJECTION_CONTEST_LIST covers what sessionKindOf reads). Deleted
 * problems are absent from pdict and therefore drop out of the scale.
 */
export function programmingPidsOf(sdoc: SelfLearningDoc, pdict: Record<number, any>): number[] {
    return (sdoc.pids || []).filter((pid) => pdict[pid] && isCodeSessionKind(sessionKindOf(pdict[pid])));
}

/**
 * 🏆 ACHIEVEMENT — the direct programming score: the programming tasks'
 * best effective scores (0..100 each), summed and mapped linearly onto
 * SESSION_ACHIEVEMENT_MAX, kept to one decimal. Example: 5 programming
 * tasks, all accepted → 500 / 500 × 20 = 20; three of five accepted → 12.
 * Sessions with no programming task score 0 on this component.
 */
export function achievementOf(sdoc: SelfLearningDoc, best: Map<number, TaskBest>, programmingPids: number[]): number {
    const max = programmingPids.length * 100;
    if (!max) return 0;
    const raw = programmingPids.reduce((acc, pid) => acc + (best.get(pid)?.effective || 0), 0);
    return Math.round((raw / max) * SESSION_ACHIEVEMENT_MAX * 10) / 10;
}

/**
 * The rubric's NAMED COMPONENTS of one student's evaluation. Future rubric
 * parts get a field here, a *Of() function above, and one line each in
 * componentsOf and sessionTaskMeanTotal — every consumer (results table, CSV,
 * student card) then picks them up from the same place.
 */
export interface SessionComponents {
    /** 🏆 Direct programming score mapped onto SESSION_ACHIEVEMENT_MAX. */
    achievement: number;
    /**
     * 🎓 Post-acceptance explanation quality mapped onto
     * SESSION_OWNERSHIP_MAX; null = not measured (no walkthrough answers
     * recorded anywhere), which renders as "—" and adds 0 to the total.
     */
    ownership: number | null;
    /**
     * 🔧 Guided fixes on failed attempts mapped onto SESSION_FIXCONV_MAX;
     * null = nothing to judge yet ("—", adds 0 to the total).
     */
    fixConv: number | null;
    /**
     * 📈 Independence trajectory mapped onto SESSION_TRAJECTORY_MAX.
     * Class-relative, so it is COMPUTED by the evaluation and PASSED in
     * here (the student card reads its stored value); null = not engaged
     * with any task / not evaluated yet ("—", adds 0 to the total).
     */
    trajectory: number | null;
    /**
     * 🧠 Concept transfer mapped onto SESSION_TRANSFER_MAX; null =
     * nothing testable yet ("—", adds 0 to the total).
     */
    transfer: number | null;
    /**
     * 🧩 Reasoning quality in failure-phase answers mapped onto
     * SESSION_REASONING_MAX; null = nothing graded yet ("—", adds 0).
     */
    reasoning: number | null;
    /**
     * 💡 Self-diagnostic initiative mapped onto SESSION_INITIATIVE_MAX;
     * null = nothing judged yet ("—", adds 0).
     */
    initiative: number | null;
}

/** 🎓 RETIRED (old 7-component rubric): explanation levels mapped onto 0..10. */
export const SESSION_OWNERSHIP_MAX = 10;
/** Hard cap of graded answers per walkthrough question (anti-spam). */
export const MAX_LEVELS_PER_QUESTION = 8;

/**
 * Dedup key of a student answer: replaying a byte-identical (modulo case
 * and whitespace) answer to the same question must not push its level a
 * second time — otherwise repeating one good answer inflates the mean.
 */
export function normalizeAnswerKey(text: string): string {
    return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * SERVER-AUTHORITATIVE grading transcript: rebuild the dialogue of ONE
 * walkthrough question from the STORED thread messages — everything the
 * student and the tutor exchanged on it is persisted there (the question
 * as an assistant 'anno' message, then alternating answers and replies).
 * The LLM judge is fed THIS, not the browser-supplied history, so a
 * crafted client cannot whisper "the tutor loved it" into its own grading
 * context. Returns null when the question is not found in the thread
 * (legacy reflection questions), in which case the caller may fall back
 * to the client turns.
 */
export function dialogueHistoryFor(
    thread: { messages?: TutorMessage[] } | null,
    questionKey: string,
): { role: string, content: string }[] | null {
    const messages = thread?.messages || [];
    let start = -1;
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role === 'assistant' && m.kind === 'anno' && String(m.content || '').slice(0, 300) === questionKey) start = i;
    }
    if (start < 0) return null;
    const turns: { role: string, content: string }[] = [];
    for (let i = start + 1; i < messages.length; i++) {
        const m = messages[i];
        if (m.kind !== 'anno') continue;
        turns.push({ role: m.role === 'user' ? 'student' : 'tutor', content: String(m.content || '').slice(0, 800) });
    }
    return turns.slice(-12);
}

/**
 * ⏯ The thread's OPEN question, if any — the one the student may still
 * answer. Per the stored-message contract: an assistant 'anno' message
 * WITHOUT a resolved flag is a QUESTION; WITH one it is a reply, and a
 * reply carrying resolved=true closes the question. Only the LAST
 * question can be open (a newer question supersedes the older ones).
 * Used to REHYDRATE the launcher panel after a page reload, so closing
 * the pop-up card — or the tab — never strands an unanswered question:
 * the round tutor button reopens the panel and answering continues
 * through the very same endpoint. accepted mirrors which grading the
 * reply will get (🎓 walkthrough after the first acceptance, 🧩 before).
 */
export function openTutorQuestionOf(thread: TutorThreadDoc | null): {
    question: string;
    line?: number;
    endLine?: number;
    accepted: boolean;
    history: { role: string, content: string }[];
    /** Every question asked so far (chronological, capped) — reseeds the client's repeat-avoidance memory after a reload. */
    asked: string[];
    /** 🎓 The walkthrough's Qn/m counter, when the open question belongs to it. */
    ownership: { asked: number, max: number } | null;
} | null {
    const messages = thread?.messages || [];
    let q: TutorMessage | null = null;
    let resolved = false;
    const asked: string[] = [];
    for (const m of messages) {
        if (m.kind !== 'anno' || m.role !== 'assistant') continue;
        if ((m as any).resolved === undefined) {
            q = m; // a fresh question opens (and supersedes any earlier one)
            resolved = false;
            asked.push(String(m.content || '').slice(0, 500));
        } else if (q && (m as any).resolved === true) {
            resolved = true; // a resolving reply closes the current question
        }
    }
    if (!q || resolved) return null;
    const accepted = !!(thread?.firstAcceptedAt && q.at && new Date(q.at as any) >= new Date(thread.firstAcceptedAt as any));
    const history = dialogueHistoryFor(thread, String(q.content || '').slice(0, 300)) || [];
    const own = thread?.ownership;
    return {
        question: String(q.content || '').slice(0, 800),
        line: (q as any).line,
        endLine: (q as any).endLine,
        accepted,
        history,
        asked: asked.slice(-12),
        ownership: accepted && own ? { asked: (own.questions || []).length, max: own.maxQ } : null,
    };
}

export interface WalkthroughAnswer { index: number, text: string, level?: number, at?: Date }
export interface WalkthroughPair { key: string, line?: number, at?: Date, qIndex: number, answers: WalkthroughAnswer[] }

/**
 * 🎓 The POST-ACCEPTANCE walkthrough structure of a stored thread,
 * derived purely from its messages: everything after the FIRST 'accepted'
 * divider, paired as question \u2192 answers. An assistant 'anno' message
 * WITHOUT a resolved flag is a question; WITH one it is a reply to an
 * answer \u2014 both the current build and the legacy single-reflection
 * build stored them that way, so this works on histories recorded before
 * the ownership rubric existed. Pre-acceptance dialogue and free chat are
 * never included (the rubric measures post-acceptance responses only);
 * returns null when the thread has no accepted attempt at all.
 */
export function extractWalkthroughPairs(messages: TutorMessage[]): { acceptedAttempt: number, pairs: WalkthroughPair[] } | null {
    const list = messages || [];
    const accIdx = list.findIndex((m) => m.kind === 'accepted');
    if (accIdx < 0) return null;
    const parsed = /#(\d+)/.exec(String(list[accIdx].content || ''));
    let acceptedAttempt = parsed ? parseInt(parsed[1], 10) : 0;
    if (!acceptedAttempt) {
        acceptedAttempt = list.slice(0, accIdx + 1).filter((m) => m.kind === 'attempt' || m.kind === 'accepted').length || 1;
    }
    const pairs: WalkthroughPair[] = [];
    let cur: WalkthroughPair | null = null;
    for (let i = accIdx + 1; i < list.length; i++) {
        const m = list[i];
        if (m.kind !== 'anno') continue;
        if (m.role === 'assistant' && m.resolved === undefined) {
            cur = { key: String(m.content || '').slice(0, 300), line: m.line, at: m.at, qIndex: i, answers: [] };
            pairs.push(cur);
        } else if (m.role === 'user' && cur) {
            cur.answers.push({ index: i, text: String(m.content || '').slice(0, 1000), level: m.level, at: m.at });
        }
    }
    return { acceptedAttempt, pairs };
}

export interface FixConvCandidate {
    /** Index of the FAILED attempt whose guidance is being judged. */
    fromIdx: number;
    /** Index of the resubmission that should carry the fix. */
    toIdx: number;
    /** 1-based position among the task's qualifying transitions. */
    trial: number;
    /** Indices of the answered-question messages inside the window. */
    msgIdx: number[];
}

/**
 * 🔧 The qualifying GUIDANCE→FIX transitions of one task, purely from the
 * attempt timeline + the thread messages:
 *   - the FROM attempt must NOT be accepted (guidance on failures only —
 *     post-acceptance dialogue is Ownership territory);
 *   - the student must have ANSWERED at least one tutor question (a user
 *     'anno' message) strictly between the two submissions;
 *   - a final engagement with NO next submission never qualifies — per the
 *     rubric, "engaged and then skipped" does not count.
 * Trial numbers are positions in this full deterministic sequence, so
 * re-running the extraction always assigns the same trial to the same
 * pair (idempotent grading).
 */
export function extractFixConvCandidates(
    attempts: { at: Date, accepted: boolean, score?: number }[],
    messages: TutorMessage[],
): FixConvCandidate[] {
    const out: FixConvCandidate[] = [];
    /*
     * ⭐ Trials are SEQUENTIAL per task, exactly as the rubric states:
     * the task's 1st qualifying transition is trial 1 (penalty ×1), the
     * 2nd trial 2 (×0.8), the 3rd ×0.6, and every one after ×0.5 —
     * decided purely from the record timeline, so trial numbers stay
     * deterministic and never depend on an LLM output. (Stored trials
     * from an older numbering rule are reconciled by the backfill's
     * setFixConvTrial pass on the next evaluation.)
     */
    let trial = 0;
    for (let k = 0; k + 1 < attempts.length; k++) {
        if (attempts[k].accepted) continue; // guidance on failures only
        const t0 = attempts[k].at.getTime();
        const t1 = attempts[k + 1].at.getTime();
        const msgIdx: number[] = [];
        for (let i = 0; i < (messages || []).length; i++) {
            const m = messages[i];
            if (m.kind !== 'anno' || m.role !== 'user' || !m.at) continue;
            const t = new Date(m.at).getTime();
            if (t > t0 && t < t1) msgIdx.push(i);
        }
        if (msgIdx.length) {
            trial += 1;
            out.push({
                fromIdx: k, toIdx: k + 1, trial, msgIdx,
            });
        }
    }
    return out;
}

/**
 * 📈 ONE student's chronological task digests — exactly what the
 * trajectory judge reads: per touched task (ordered by first
 * submission), the submission chain, how many failure-phase exchanges
 * were answered before the first acceptance (0 = solved without tutor
 * help), and short excerpts of the first/last failure answers. Pure
 * record+thread arithmetic; exported for the test harness.
 */
export function trajectoryTaskDigestsOf(
    rows: { pid: number, at: Date, accepted: boolean, score: number }[],
    msgsByPid: Map<number, TutorMessage[]>,
    labelOf: (pid: number) => string,
): { label: string, chain: string, answered: number, first?: string, last?: string }[] {
    const byPid = new Map<number, { at: number, accepted: boolean, score: number }[]>();
    for (const r of rows || []) {
        if (!byPid.has(r.pid)) byPid.set(r.pid, []);
        byPid.get(r.pid)!.push({ at: new Date(r.at).getTime(), accepted: !!r.accepted, score: r.score || 0 });
    }
    const pids = [...byPid.keys()];
    for (const list of byPid.values()) list.sort((a, b) => a.at - b.at);
    pids.sort((a, b) => byPid.get(a)![0].at - byPid.get(b)![0].at);
    return pids.map((pid) => {
        const list = byPid.get(pid)!;
        const shown = list.slice(0, 12);
        const chain = shown.map((r) => `${r.accepted ? 'AC' : 'WA'}(${r.score})`).join(' → ')
            + (list.length > shown.length ? ` → … (${list.length - shown.length} more)` : '');
        let firstAc = Infinity;
        for (const r of list) {
            if (r.accepted) {
                firstAc = r.at;
                break;
            }
        }
        const answers: string[] = [];
        for (const m of msgsByPid.get(pid) || []) {
            if (m.kind !== 'anno' || m.role !== 'user' || !m.at) continue;
            if (new Date(m.at).getTime() >= firstAc) continue;
            answers.push(String(m.content || '').slice(0, 160));
        }
        const out: { label: string, chain: string, answered: number, first?: string, last?: string } = {
            label: labelOf(pid), chain, answered: answers.length,
        };
        if (answers.length) out.first = answers[0];
        if (answers.length > 1) out.last = answers[answers.length - 1];
        return out;
    });
}

/**
 * 📈 The re-judge trigger: a stable key of the history's size — when it
 * matches the stored one, the LLM is not called again.
 */
export function trajectoryBasisOf(digests: { chain: string, answered: number }[], totalRows: number): string {
    const answered = digests.reduce((a, d) => a + d.answered, 0);
    return `${digests.length}:${totalRows}:${answered}`;
}

/**
 * 🎓 RETROACTIVE GRADING \u2014 the evaluation judges every RECORDED
 * post-acceptance answer that has no level yet: histories from before this
 * rubric existed (the old single-reflection flow) are graded the first
 * time the teacher evaluates, and any answer whose live grading failed is
 * retried. Runs ONLY inside background evaluations (the manual job and
 * the post-deadline sweep) \u2014 never on a page view, because every
 * ungraded answer is one LLM call. Idempotent: a graded answer carries
 * its level on the message and its key in answerKeys, so once everything
 * is graded a re-evaluation costs zero LLM calls. A question answered but
 * never successfully graded creates NO rubric entry (the task stays
 * unmeasured and is retried later) \u2014 only a question asked and truly
 * never answered records the deliberate level-0.
 */
export interface OwnershipBackfillProgress {
    uid: number;
    uname: string;
    pid: number | string;
    /** Work-item counter: which ungraded answer is being judged, of how many. */
    done: number;
    total: number;
    graded: number;
    failed: number;
}

export async function backfillOwnershipGrades(
    domainId: string,
    sdoc: SelfLearningDoc,
    onProgress?: (p: OwnershipBackfillProgress) => Promise<void> | void,
): Promise<{ graded: number, failed: number, total: number }> {
    const out = { graded: 0, failed: 0, total: 0 };
    if (!aiTutor.tutorEnabled() || !aiTutor.tutorConfigured()) return out;
    const pids = sdoc.pids || [];
    if (!pids.length) return out;
    const pdict = await problem.getList(domainId, pids, true, false, problem.PROJECTION_CONTEST_LIST, true);
    const progPids = new Set(programmingPidsOf(sdoc, pdict));
    const threads = await gradedSessionThreads(domainId, sdoc);
    /*
     * PHASE 1 — build the work list without any LLM call: init missing
     * walkthrough states, record asked-never-answered questions (the
     * deliberate level-0), and collect every recorded answer that still
     * needs a grade. Knowing the total upfront lets the progress card show
     * "answer 3 of 7 · <student>".
     */
    interface WorkItem { thread: TutorThreadDoc, ownership: OwnershipState, pair: WalkthroughPair, ans: WalkthroughAnswer }
    const work: WorkItem[] = [];
    for (const thread of threads) {
        if (!progPids.has(thread.pid) || thread.uid === sdoc.owner) continue;
        const walk = extractWalkthroughPairs(thread.messages || []);
        if (!walk || !walk.pairs.length) continue;
        let ownership = thread.ownership;
        if (!ownership) {
            // Same record-history truth as the live init; the divider-derived
            // attempt number is only the fallback when records are gone.
            const cls = await acceptedOnFirstAttempt(domainId, thread.uid, thread.pid)
                || { firstAttempt: walk.acceptedAttempt <= 1, attemptNo: walk.acceptedAttempt };
            const budget = ownershipBudget(cls.firstAttempt);
            ownership = {
                acceptedAttempt: cls.attemptNo, minQ: budget.min, maxQ: budget.max, questions: [],
            };
            await SelfLearningModel.initOwnership(thread._id, ownership);
        }
        for (const pair of walk.pairs) {
            // The asked question must exist in the state — answered or not —
            // so an ignored question counts its deliberate level-0 and a
            // graded answer has a slot to land in.
            let q = (ownership.questions || []).find((x) => x.question === pair.key);
            if (!q) {
                q = {
                    question: pair.key, line: pair.line, at: pair.at || new Date(), levels: [], answerKeys: [],
                };
                await SelfLearningModel.pushOwnershipQuestion(thread._id, q);
                ownership.questions.push(q);
            }
            for (const ans of pair.answers) {
                if (typeof ans.level === 'number') {
                    /*
                     * Graded live already — but REPAIR the state if that
                     * grade never landed in it (e.g. the question-store
                     * write was lost before the answer arrived, so
                     * pushOwnershipLevel matched nothing): adopt the
                     * message's level under the same dedup + cap rules,
                     * with no LLM call.
                     */
                    const key = normalizeAnswerKey(ans.text);
                    if (!q.answerKeys?.includes(key) && (q.levels?.length || 0) < MAX_LEVELS_PER_QUESTION) {
                        await SelfLearningModel.pushOwnershipLevel(thread._id, pair.key, ans.level, key);
                        q.levels.push(ans.level);
                        q.answerKeys ||= [];
                        q.answerKeys.push(key);
                    }
                    continue;
                }
                work.push({ thread, ownership, pair, ans });
            }
        }
    }
    out.total = work.length;
    if (!work.length) return out;
    const unames = await user.getList(domainId, [...new Set(work.map((w) => w.thread.uid))]);
    /*
     * PHASE 2 — grade sequentially, reporting WHO is being judged before
     * each LLM call so the teacher's card can display it live.
     */
    const codeOf = new Map<string, string>();
    let done = 0;
    for (const w of work) {
        done += 1;
        const uname = (unames as any)[w.thread.uid]?.uname || String(w.thread.uid);
        const pidLabel = (pdict[w.thread.pid] as any)?.pid || w.thread.pid;
        try {
            await onProgress?.({
                uid: w.thread.uid, uname, pid: pidLabel, done, total: out.total, graded: out.graded, failed: out.failed,
            });
        } catch (e) { /* progress is best-effort */ }
        const key = normalizeAnswerKey(w.ans.text);
        let q = (w.ownership.questions || []).find((x) => x.question === w.pair.key);
        if (q?.answerKeys?.includes(key)) continue;
        if ((q?.levels?.length || 0) >= MAX_LEVELS_PER_QUESTION) continue;
        const codeKey = `${w.thread.uid}:${w.thread.pid}`;
        if (!codeOf.has(codeKey)) {
            const acc = await record.getMulti(domainId, { uid: w.thread.uid, pid: w.thread.pid, status: STATUS.STATUS_ACCEPTED })
                .sort({ _id: -1 }).limit(1).project({ code: 1 }).toArray();
            codeOf.set(codeKey, String((acc[0] as any)?.code || ''));
        }
        const transcript = (w.thread.messages || []).slice(w.pair.qIndex + 1, w.ans.index)
            .filter((mm) => mm.kind === 'anno')
            .map((mm) => ({ role: mm.role === 'user' ? 'student' : 'tutor', content: String(mm.content || '').slice(0, 800) }));
        const level = await aiTutor.runOwnershipGrading({
            firstAttempt: w.ownership.acceptedAttempt === 1 || (w.ownership.minQ ?? 0) >= 5,
            title: (pdict[w.thread.pid] as any)?.title || String(w.thread.pid),
            code: codeOf.get(codeKey)!,
            question: w.pair.key,
            transcript,
            answer: w.ans.text,
        });
        if (level === null) {
            out.failed += 1;
            continue;
        }
        // 🚫 Manipulation → 🎓 flagged for this task; the level-0 record
        // still lands so the walkthrough's bookkeeping stays coherent.
        // eslint-disable-next-line no-await-in-loop
        if (level === aiTutor.GRADER_FLAGGED) await SelfLearningModel.flagIntegrity(w.thread._id, 'own', '');
        const storeLevel = level === aiTutor.GRADER_FLAGGED ? 0 : level;
        if (!q) {
            q = {
                question: w.pair.key, line: w.pair.line, at: w.pair.at || new Date(), levels: [], answerKeys: [],
            };
            await SelfLearningModel.pushOwnershipQuestion(w.thread._id, q);
            w.ownership.questions.push(q);
        }
        await SelfLearningModel.pushOwnershipLevel(w.thread._id, w.pair.key, storeLevel, key);
        await SelfLearningModel.setMessageLevel(w.thread._id, w.ans.index, storeLevel);
        q.levels.push(storeLevel);
        if (!q.answerKeys) q.answerKeys = [];
        q.answerKeys.push(key);
        out.graded += 1;
    }
    return out;
}

/**
 * 🔧 GUIDANCE→FIX-CONVERSION grading, evaluation-time only: for every
 * qualifying transition (extractFixConvCandidates) not yet judged, feed the
 * tutoring exchange plus the BEFORE/AFTER code to the LLM and store the
 * level. Idempotent (dedup by the resubmission's rid; trial numbers come
 * from the full deterministic candidate sequence) and capped per task.
 */
export async function backfillFixConversionGrades(
    domainId: string,
    sdoc: SelfLearningDoc,
    onProgress?: (p: OwnershipBackfillProgress) => Promise<void> | void,
): Promise<{ graded: number, failed: number, total: number }> {
    const out = { graded: 0, failed: 0, total: 0 };
    if (!aiTutor.tutorEnabled() || !aiTutor.tutorConfigured()) return out;
    const pids = sdoc.pids || [];
    if (!pids.length) return out;
    const pdict = await problem.getList(domainId, pids, true, false, problem.PROJECTION_CONTEST_LIST, true);
    const progPids = new Set(programmingPidsOf(sdoc, pdict));
    const threads = await gradedSessionThreads(domainId, sdoc);
    interface Item {
        thread: TutorThreadDoc;
        cand: FixConvCandidate;
        attempts: { rid: any, at: Date, accepted: boolean, verdict: string }[];
    }
    const work: Item[] = [];
    for (const thread of threads) {
        if (!progPids.has(thread.pid) || thread.uid === sdoc.owner) continue;
        const recs = await record.getMulti(domainId, {
            uid: thread.uid, pid: thread.pid, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
        }).sort({ _id: 1 }).limit(60).project({ status: 1, score: 1 }).toArray();
        // ⏹ Only the session's own attempts decide the walkthrough budget.
        const capOwn = sessionCutoff(sdoc);
        const inSession = (recs as any[]).filter((r) => recordCounts(r._id, capOwn));
        if (inSession.length < 2) continue;
        const attempts = inSession.map((r: any) => ({
            rid: r._id,
            at: r._id.getTimestamp(),
            accepted: r.status === STATUS.STATUS_ACCEPTED,
            score: r.score || 0,
            verdict: `${STATUS_TEXTS[r.status] || r.status} (score ${r.score || 0})`,
        }));
        const cands = extractFixConvCandidates(attempts, thread.messages || []);
        const judgedTrial = new Map((thread.fixconv?.transitions || []).map((t) => [String(t.toRid), t.trial]));
        const judged = new Set(judgedTrial.keys());
        let count = thread.fixconv?.transitions?.length || 0;
        for (const cand of cands) {
            const toKey = String(attempts[cand.toIdx].rid);
            if (judged.has(toKey)) {
                // Trial numbers are DERIVED metadata: if the chain rule
                // renumbered an already-graded transition, reconcile the
                // stored trial so the penalty always follows the current
                // rule (idempotent; the level itself is never re-graded).
                if (judgedTrial.get(toKey) !== cand.trial) {
                    await SelfLearningModel.setFixConvTrial(thread._id, attempts[cand.toIdx].rid, cand.trial);
                }
                continue;
            }
            if (count >= MAX_FIXCONV_PER_TASK) break;
            count += 1;
            work.push({ thread, cand, attempts });
        }
    }
    out.total = work.length;
    if (!work.length) return out;
    const unames = await user.getList(domainId, [...new Set(work.map((w) => w.thread.uid))]);
    const codeCache = new Map<string, string>();
    const codeOf = async (rid: any) => {
        const key = String(rid);
        if (!codeCache.has(key)) {
            const r = await record.get(domainId, rid);
            codeCache.set(key, String((r as any)?.code || '').slice(0, 8000));
        }
        return codeCache.get(key)!;
    };
    let done = 0;
    for (const w of work) {
        done += 1;
        try {
            await onProgress?.({
                uid: w.thread.uid,
                uname: (unames as any)[w.thread.uid]?.uname || String(w.thread.uid),
                pid: (pdict[w.thread.pid] as any)?.pid || w.thread.pid,
                done,
                total: out.total,
                graded: out.graded,
                failed: out.failed,
            });
        } catch (e) { /* progress is best-effort */ }
        const from = w.attempts[w.cand.fromIdx];
        const to = w.attempts[w.cand.toIdx];
        // The whole tutoring exchange inside the window (questions, answers,
        // replies) is the guidance context — recorded history only.
        const t0 = from.at.getTime();
        const t1 = to.at.getTime();
        const guidance = (w.thread.messages || [])
            .filter((m) => m.kind === 'anno' && m.at && new Date(m.at).getTime() > t0 && new Date(m.at).getTime() < t1)
            .map((m) => ({ role: m.role === 'user' ? 'student' : 'tutor', content: String(m.content || '').slice(0, 600) }));
        const level = await aiTutor.runFixConversionGrading({
            title: (pdict[w.thread.pid] as any)?.title || String(w.thread.pid),
            guidance,
            beforeCode: await codeOf(from.rid),
            afterCode: await codeOf(to.rid),
            beforeVerdict: from.verdict,
            afterVerdict: to.verdict,
        });
        if (level === null) {
            out.failed += 1;
            continue;
        }
        // 🚫 Manipulation → 🔧 flagged for this task.
        // eslint-disable-next-line no-await-in-loop
        if (level === aiTutor.GRADER_FLAGGED) await SelfLearningModel.flagIntegrity(w.thread._id, 'fix', '');
        await SelfLearningModel.pushFixConvTransition(w.thread._id, {
            fromRid: from.rid,
            toRid: to.rid,
            trial: w.cand.trial,
            level: level === aiTutor.GRADER_FLAGGED ? 0 : level,
            asked: w.cand.msgIdx.length,
            at: to.at,
        });
        out.graded += 1;
    }
    return out;
}

/**
 * 🧠 CONCEPT-TRANSFER grading, evaluation-time only, in three steps:
 * (1) SURFACE — for each accepted task with failure-phase tutoring, the
 * LLM marks which of the task's knowledge points the dialogue surfaced as
 * the student's own misconception (cached on the thread; the pre-acceptance
 * dialogue is frozen after acceptance, so one extraction suffices);
 * (2) PLAN — extractTransferCandidates picks, per concept, the baseline
 * (first surfaced-AND-resolved task) and the FIRST later engaged task
 * tagged with it (a parked raise sets no baseline);
 * (3) JUDGE — the LLM grades the re-encounter 0..4 from its first
 * submission, its pre-acceptance tutoring (empty = unprompted) and the
 * baseline exchange. One assessment per concept, capped per student,
 * idempotent (concept-keyed on the progress doc), failures retried.
 */
export async function backfillConceptTransferGrades(
    domainId: string,
    sdoc: SelfLearningDoc,
    onProgress?: (p: OwnershipBackfillProgress) => Promise<void> | void,
): Promise<{ graded: number, failed: number, total: number }> {
    const out = { graded: 0, failed: 0, total: 0 };
    if (!aiTutor.tutorEnabled() || !aiTutor.tutorConfigured()) return out;
    const pids = sdoc.pids || [];
    if (!pids.length) return out;
    const pdict = await problem.getList(domainId, pids, true, false, problem.PROJECTION_CONTEST_LIST, true);
    const progPids = programmingPidsOf(sdoc, pdict);
    if (!progPids.length) return out;
    // Knowledge points ride pdoc.tag (the catalog is authoritative for
    // spelling, tags for membership); the contest projection lacks them.
    const tagDocs = await problem.getMulti(domainId, { docId: { $in: progPids } }).project({ docId: 1, tag: 1 }).toArray();
    const tagsByPid = new Map<number, string[]>();
    for (const d of tagDocs as any[]) tagsByPid.set(d.docId, (d.tag || []).map((t: any) => String(t)));
    const sessionUntagged = ![...tagsByPid.values()].some((t) => t.length);
    const threads = await gradedSessionThreads(domainId, sdoc);
    const threadOf = new Map<string, TutorThreadDoc>();
    for (const t of threads) threadOf.set(`${t.uid}:${t.pid}`, t);
    const recs = await record.getMulti(domainId, {
        pid: { $in: progPids }, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
    }).project({ uid: 1, pid: 1, status: 1, score: 1 }).limit(200000).toArray();
    const cap = sessionCutoff(sdoc);
    const rowsOf = new Map<number, { pid: number, at: Date, accepted: boolean, rid: any, score: number }[]>();
    for (const r of recs as any[]) {
        // ⏹ Practice made after the session closed never reaches a grader.
        if (!recordCounts(r._id, cap)) continue;
        if (!rowsOf.has(r.uid)) rowsOf.set(r.uid, []);
        rowsOf.get(r.uid)!.push({
            pid: r.pid, at: r._id.getTimestamp(), accepted: r.status === STATUS.STATUS_ACCEPTED, rid: r._id, score: r.score || 0,
        });
    }
    /** Pre-acceptance dialogue: anno messages before the task's first acceptance (all, if never accepted). */
    const preAcDialogue = (uid: number, pid: number) => {
        const th = threadOf.get(`${uid}:${pid}`);
        if (!th) return [] as { role: string, content: string }[];
        const rows = rowsOf.get(uid) || [];
        let firstAc = Infinity;
        for (const r of rows) if (r.pid === pid && r.accepted) firstAc = Math.min(firstAc, r.at.getTime());
        return (th.messages || [])
            .filter((m) => m.kind === 'anno' && m.at && new Date(m.at).getTime() < firstAc)
            .map((m) => ({ role: m.role === 'user' ? 'student' : 'tutor', content: String(m.content || '').slice(0, 600) }));
    };
    const allUids = [...rowsOf.keys()].filter((u) => u !== sdoc.owner);
    if (sessionUntagged) {
        // The spec's edge case, session-wide: with no knowledge points
        // among the tasks, every student is UNTESTABLE (full credit).
        for (const uid of allUids) {
            // eslint-disable-next-line no-await-in-loop
            await SelfLearningModel.setTransferPlan(domainId, sdoc.docId, uid, { candidates: 0, untestable: true, at: new Date() });
        }
        return out;
    }
    const surfWork: { uid: number, pid: number, thread: TutorThreadDoc }[] = [];
    for (const uid of allUids) {
        const rows = rowsOf.get(uid)!;
        const resolved = new Set(rows.filter((r) => r.accepted).map((r) => r.pid));
        for (const pid of resolved) {
            if (!(tagsByPid.get(pid) || []).length) continue;
            const th = threadOf.get(`${uid}:${pid}`);
            if (!th || th.surfacedKp) continue;
            if (!preAcDialogue(uid, pid).some((m) => m.role === 'student')) continue; // no failure tutoring engaged
            surfWork.push({ uid, pid, thread: th });
        }
    }
    const surfDirty = new Set<number>();
    out.total = surfWork.length; // judge items are known only after surfacing
    const unames = allUids.length ? await user.getList(domainId, allUids) : {};
    const label = (uid: number) => (unames as any)[uid]?.uname || String(uid);
    let done = 0;
    for (const w of surfWork) {
        done += 1;
        try {
            await onProgress?.({
                uid: w.uid, uname: label(w.uid), pid: (pdict[w.pid] as any)?.pid || w.pid, done, total: out.total, graded: out.graded, failed: out.failed,
            });
        } catch (e) { /* best-effort */ }
        const idx = await aiTutor.runConceptSurfacing({
            title: (pdict[w.pid] as any)?.title || String(w.pid),
            tags: tagsByPid.get(w.pid)!,
            dialogue: preAcDialogue(w.uid, w.pid),
        });
        if (idx === null) {
            out.failed += 1;
            surfDirty.add(w.uid); // this student's plan can't settle yet
            continue; // surfacedKp stays absent -> retried next evaluation
        }
        const names = idx.map((n) => tagsByPid.get(w.pid)![n - 1]).filter(Boolean);
        await SelfLearningModel.setSurfacedKp(w.thread._id, names);
        w.thread.surfacedKp = { names, extractedAt: new Date() };
    }
    const judgeWork: { uid: number, cand: TransferCandidate }[] = [];
    for (const uid of allUids) {
        const rows = rowsOf.get(uid) || [];
        const resolved = new Set(rows.filter((r) => r.accepted).map((r) => r.pid));
        const wins = assistanceWindows(rows, progPids);
        const engagements = [...wins.entries()].map(([pid, win]) => ({ pid, start: win.start }));
        const surfacedByPid = new Map<number, string[]>();
        for (const pid of new Set(rows.map((r) => r.pid))) {
            const th = threadOf.get(`${uid}:${pid}`);
            if (th?.surfacedKp?.names?.length) surfacedByPid.set(pid, th.surfacedKp.names);
        }
        const cands = surfacedByPid.size
            ? extractTransferCandidates(engagements, tagsByPid, surfacedByPid, resolved) : [];
        // 🧠 The student's PLAN: how many re-encounters exist, and — only
        // when this student's surfacing is fully settled — whether they
        // are UNTESTABLE (zero candidates → the edge case's full credit).
        // eslint-disable-next-line no-await-in-loop
        await SelfLearningModel.setTransferPlan(domainId, sdoc.docId, uid, {
            candidates: cands.length,
            untestable: !surfDirty.has(uid) && cands.length === 0,
            at: new Date(),
        });
        if (!cands.length) continue;
        // eslint-disable-next-line no-await-in-loop
        const prog = await SelfLearningModel.getProgress(domainId, sdoc.docId, uid);
        const doneConcepts = new Set((prog?.transfer?.assessments || []).map((a) => a.concept));
        let count = prog?.transfer?.assessments?.length || 0;
        for (const cand of cands) {
            if (doneConcepts.has(cand.concept)) continue;
            if (count >= MAX_TRANSFER_PER_STUDENT) break;
            count += 1;
            judgeWork.push({ uid, cand });
        }
    }
    out.total += judgeWork.length;
    const kpDocs = judgeWork.length
        ? await KnowledgeModel.coll.find({ domainId, nameLower: { $in: [...new Set(judgeWork.map((w) => w.cand.concept.toLowerCase()))] } }).project({ name: 1, nameLower: 1, description: 1 }).toArray()
        : [];
    const descOf = new Map((kpDocs as any[]).map((d) => [d.nameLower, d.description || '']));
    for (const w of judgeWork) {
        done += 1;
        try {
            await onProgress?.({
                uid: w.uid, uname: label(w.uid), pid: (pdict[w.cand.toPid] as any)?.pid || w.cand.toPid, done, total: out.total, graded: out.graded, failed: out.failed,
            });
        } catch (e) { /* best-effort */ }
        const rows = (rowsOf.get(w.uid) || []).filter((r) => r.pid === w.cand.toPid).sort((a, b) => a.at.getTime() - b.at.getTime());
        if (!rows.length) continue;
        const first = rows[0];
        const firstRec = await record.get(domainId, first.rid);
        const outcome = rows.slice(0, 8).map((r) => `${r.accepted ? 'AC' : 'WA'}(${r.score})`).join(' → ');
        const level = await aiTutor.runConceptTransferGrading({
            concept: w.cand.concept,
            conceptDescription: descOf.get(w.cand.concept.toLowerCase()) || '',
            fromTitle: (pdict[w.cand.fromPid] as any)?.title || String(w.cand.fromPid),
            baselineDialogue: preAcDialogue(w.uid, w.cand.fromPid),
            toTitle: (pdict[w.cand.toPid] as any)?.title || String(w.cand.toPid),
            firstCode: String((firstRec as any)?.code || '').slice(0, 8000),
            firstVerdict: `${first.accepted ? 'Accepted' : 'Not accepted'} (score ${first.score})`,
            reDialogue: preAcDialogue(w.uid, w.cand.toPid),
            outcome,
        });
        if (level === null) {
            out.failed += 1;
            continue;
        }
        // 🚫 Manipulation → this concept's assessment is a flagged 0 (🧠 zeroes).
        await SelfLearningModel.pushTransferAssessment(domainId, sdoc.docId, w.uid, {
            concept: w.cand.concept,
            fromPid: w.cand.fromPid,
            toPid: w.cand.toPid,
            level: level === aiTutor.GRADER_FLAGGED ? 0 : level,
            at: new Date(),
            ...(level === aiTutor.GRADER_FLAGGED ? { flagged: true } : {}),
        });
        out.graded += 1;
    }
    return out;
}

/**
 * 🧩 REASONING-QUALITY backfill: grade every recorded PRE-ACCEPTANCE
 * answer that has no reasoning level yet — histories from before live
 * grading, plus answers whose live grading failed. Idempotent (rlevel on
 * the message + normalized-answer dedupe on the thread), capped per task,
 * failures retried; runs only inside background evaluations.
 */
export async function backfillReasoningGrades(
    domainId: string,
    sdoc: SelfLearningDoc,
    onProgress?: (p: OwnershipBackfillProgress) => Promise<void> | void,
): Promise<{ graded: number, failed: number, total: number }> {
    const out = { graded: 0, failed: 0, total: 0 };
    if (!aiTutor.tutorEnabled() || !aiTutor.tutorConfigured()) return out;
    const pids = sdoc.pids || [];
    if (!pids.length) return out;
    const pdict = await problem.getList(domainId, pids, true, false, problem.PROJECTION_CONTEST_LIST, true);
    const progPids = new Set(programmingPidsOf(sdoc, pdict));
    const threads = await gradedSessionThreads(domainId, sdoc);
    const recs = await record.getMulti(domainId, {
        pid: { $in: [...progPids] }, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
    }).project({ uid: 1, pid: 1, status: 1 }).limit(200000).toArray();
    const cap = sessionCutoff(sdoc);
    const recRowsOf = new Map<string, { at: number, accepted: boolean, rid: any }[]>();
    for (const r of recs as any[]) {
        if (!recordCounts(r._id, cap)) continue; // ⏹ post-session practice
        const key = `${r.uid}:${r.pid}`;
        if (!recRowsOf.has(key)) recRowsOf.set(key, []);
        recRowsOf.get(key)!.push({ at: r._id.getTimestamp().getTime(), accepted: r.status === STATUS.STATUS_ACCEPTED, rid: r._id });
    }
    interface Item { thread: TutorThreadDoc, idx: number, qIdx: number }
    const work: Item[] = [];
    for (const thread of threads) {
        if (!progPids.has(thread.pid) || thread.uid === sdoc.owner) continue;
        const rows = (recRowsOf.get(`${thread.uid}:${thread.pid}`) || []).sort((a, b) => a.at - b.at);
        let firstAc = Infinity;
        for (const r of rows) if (r.accepted) { firstAc = r.at; break; }
        const msgs = thread.messages || [];
        let count = thread.reasoning?.levels?.length || 0;
        let lastQ = -1;
        for (let k = 0; k < msgs.length; k++) {
            const m = msgs[k];
            if (m.kind !== 'anno' || !m.at) continue;
            const t = new Date(m.at).getTime();
            if (t >= firstAc) break; // failure phase only
            if (m.role === 'assistant' && m.resolved === undefined) lastQ = k;
            else if (m.role === 'user' && typeof (m as any).rlevel !== 'number' && lastQ >= 0) {
                if (count >= MAX_REASONING_PER_TASK) break;
                count += 1;
                work.push({ thread, idx: k, qIdx: lastQ });
            }
        }
    }
    out.total = work.length;
    if (!work.length) return out;
    const unames = await user.getList(domainId, [...new Set(work.map((w) => w.thread.uid))]);
    const codeCache = new Map<string, string>();
    let done = 0;
    for (const w of work) {
        done += 1;
        try {
            await onProgress?.({
                uid: w.thread.uid,
                uname: (unames as any)[w.thread.uid]?.uname || String(w.thread.uid),
                pid: (pdict[w.thread.pid] as any)?.pid || w.thread.pid,
                done,
                total: out.total,
                graded: out.graded,
                failed: out.failed,
            });
        } catch (e) { /* best-effort */ }
        const msgs = w.thread.messages || [];
        const ans = msgs[w.idx];
        const key = normalizeAnswerKey(String(ans.content || ''));
        const state = w.thread.reasoning || (w.thread.reasoning = { levels: [], answerKeys: [] });
        if (state.answerKeys?.includes(key)) continue; // replay of a graded answer
        // The code the answer reasons about: the latest submission before it.
        const rows = (recRowsOf.get(`${w.thread.uid}:${w.thread.pid}`) || []).filter((r) => r.at <= new Date(ans.at!).getTime()).sort((a, b) => b.at - a.at);
        const ckey = rows.length ? String(rows[0].rid) : '';
        if (ckey && !codeCache.has(ckey)) {
            const r = await record.get(domainId, rows[0].rid);
            codeCache.set(ckey, String((r as any)?.code || '').slice(0, 8000));
        }
        const transcript = msgs.slice(w.qIdx + 1, w.idx)
            .filter((mm) => mm.kind === 'anno')
            .map((mm) => ({ role: mm.role === 'user' ? 'student' : 'tutor', content: String(mm.content || '').slice(0, 600) }));
        const level = await aiTutor.runReasoningGrading({
            title: (pdict[w.thread.pid] as any)?.title || String(w.thread.pid),
            code: ckey ? codeCache.get(ckey)! : '',
            question: String(msgs[w.qIdx].content || '').slice(0, 300),
            transcript,
            answer: String(ans.content || ''),
        });
        if (level === null) {
            out.failed += 1;
            continue;
        }
        // 🚫 Manipulation → 🧩 flagged for this task.
        // eslint-disable-next-line no-await-in-loop
        if (level === aiTutor.GRADER_FLAGGED) await SelfLearningModel.flagIntegrity(w.thread._id, 'rea', '');
        const rlv = level === aiTutor.GRADER_FLAGGED ? 0 : level;
        await SelfLearningModel.setMessageRlevel(w.thread._id, w.idx, rlv);
        await SelfLearningModel.pushReasoningLevel(w.thread._id, rlv, key);
        state.levels.push(rlv);
        if (!state.answerKeys) state.answerKeys = [];
        state.answerKeys.push(key);
        out.graded += 1;
    }
    return out;
}

/**
 * 💡 SELF-DIAGNOSTIC-INITIATIVE grading: one level per task, judged
 * over the FIRST-ENGAGEMENT failure dialogue — did the student volunteer
 * a hypothesis before the tutor localized the flaw, and how well did they
 * answer the comprehension stages? Graded once, only after the window
 * CLOSED (first acceptance, parking, or session end), so later answers of
 * the same engagement can never be missed. Idempotent; failures retried.
 */
export async function backfillInitiativeGrades(
    domainId: string,
    sdoc: SelfLearningDoc,
    onProgress?: (p: OwnershipBackfillProgress) => Promise<void> | void,
): Promise<{ graded: number, failed: number, total: number }> {
    const out = { graded: 0, failed: 0, total: 0 };
    if (!aiTutor.tutorEnabled() || !aiTutor.tutorConfigured()) return out;
    const pids = sdoc.pids || [];
    if (!pids.length) return out;
    const pdict = await problem.getList(domainId, pids, true, false, problem.PROJECTION_CONTEST_LIST, true);
    const progPids = programmingPidsOf(sdoc, pdict);
    const progSet = new Set(progPids);
    if (!progPids.length) return out;
    const threads = await gradedSessionThreads(domainId, sdoc);
    const recs = await record.getMulti(domainId, {
        pid: { $in: progPids }, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
    }).project({ uid: 1, pid: 1, status: 1, score: 1 }).limit(200000).toArray();
    const cap = sessionCutoff(sdoc);
    const rowsOf = new Map<number, { pid: number, at: Date, accepted: boolean, rid: any, score: number }[]>();
    for (const r of recs as any[]) {
        // ⏹ Practice made after the session closed never reaches a grader.
        if (!recordCounts(r._id, cap)) continue;
        if (!rowsOf.has(r.uid)) rowsOf.set(r.uid, []);
        rowsOf.get(r.uid)!.push({
            pid: r.pid, at: r._id.getTimestamp(), accepted: r.status === STATUS.STATUS_ACCEPTED, rid: r._id, score: r.score || 0,
        });
    }
    const ended = sessionSchedule(sdoc).phase === 'ended';
    interface Item { thread: TutorThreadDoc, win: AssistanceWindow }
    const work: Item[] = [];
    for (const thread of threads) {
        if (!progSet.has(thread.pid) || thread.uid === sdoc.owner) continue;
        if ((thread as any).initiative) continue; // graded once, forever
        const win = assistanceWindows(rowsOf.get(thread.uid) || [], progPids).get(thread.pid);
        if (!win) continue; // never engaged the task
        // Grade only CLOSED windows: first AC, parking, or session end.
        if (win.end === null && !ended) continue;
        const hasAnswer = (thread.messages || []).some((m) => {
            if (m.kind !== 'anno' || m.role !== 'user' || !m.at) return false;
            const t = new Date(m.at).getTime();
            return t >= win.start && (win.end === null || t < win.end);
        });
        if (!hasAnswer) continue; // no failure answers -> not judged (like Reasoning)
        work.push({ thread, win });
    }
    out.total = work.length;
    if (!work.length) return out;
    const unames = await user.getList(domainId, [...new Set(work.map((w) => w.thread.uid))]);
    let done = 0;
    for (const w of work) {
        done += 1;
        try {
            await onProgress?.({
                uid: w.thread.uid,
                uname: (unames as any)[w.thread.uid]?.uname || String(w.thread.uid),
                pid: (pdict[w.thread.pid] as any)?.pid || w.thread.pid,
                done,
                total: out.total,
                graded: out.graded,
                failed: out.failed,
            });
        } catch (e) { /* best-effort */ }
        const dialogue = (w.thread.messages || [])
            .filter((m) => {
                if (m.kind !== 'anno' || !m.at) return false;
                const t = new Date(m.at).getTime();
                return t >= w.win.start && (w.win.end === null || t < w.win.end);
            })
            .map((m) => ({ role: m.role === 'user' ? 'student' : 'tutor', content: String(m.content || '').slice(0, 600) }));
        const rows = (rowsOf.get(w.thread.uid) || []).filter((r) => r.pid === w.thread.pid).sort((a, b) => a.at.getTime() - b.at.getTime());
        if (!rows.length) continue;
        const firstRec = await record.get(domainId, rows[0].rid);
        const level = await aiTutor.runInitiativeGrading({
            title: (pdict[w.thread.pid] as any)?.title || String(w.thread.pid),
            code: String((firstRec as any)?.code || '').slice(0, 8000),
            verdict: `${rows[0].accepted ? 'Accepted' : 'Not accepted'} (score ${rows[0].score})`,
            dialogue,
        });
        if (level === null) {
            out.failed += 1;
            continue;
        }
        // 🚫 Manipulation → 💡 flagged for this task.
        // eslint-disable-next-line no-await-in-loop
        if (level === aiTutor.GRADER_FLAGGED) await SelfLearningModel.flagIntegrity(w.thread._id, 'ini', '');
        await SelfLearningModel.setInitiative(w.thread._id, level === aiTutor.GRADER_FLAGGED ? 0 : level);
        out.graded += 1;
    }
    return out;
}


/**
 * 📈 INDEPENDENCE-TRAJECTORY grading: ONE whole-session judgment per
 * student, over their chronological task digests. Cached by a BASIS key
 * (task count : record count : answered-exchange count): the LLM is
 * called only for students whose history changed since the stored
 * judgment, so a settled session costs zero calls. Owner and course
 * staff are skipped. Failures leave the old judgment (or none) in place
 * and are retried next evaluation.
 */
export async function backfillTrajectoryGrades(
    domainId: string,
    sdoc: SelfLearningDoc,
    onProgress?: (p: OwnershipBackfillProgress) => Promise<void> | void,
): Promise<{ graded: number, failed: number, total: number }> {
    const out = { graded: 0, failed: 0, total: 0 };
    if (!aiTutor.tutorEnabled() || !aiTutor.tutorConfigured()) return out;
    const pids = sdoc.pids || [];
    if (!pids.length) return out;
    const pdict = await problem.getList(domainId, pids, true, false, problem.PROJECTION_CONTEST_LIST, true);
    const progPids = programmingPidsOf(sdoc, pdict);
    if (!progPids.length) return out;
    const recs = await record.getMulti(domainId, {
        pid: { $in: progPids }, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
    }).project({ uid: 1, pid: 1, status: 1, score: 1 }).limit(200000).toArray();
    const cap = sessionCutoff(sdoc);
    const rowsOf = new Map<number, { pid: number, at: Date, accepted: boolean, score: number }[]>();
    for (const r of recs as any[]) {
        if (!recordCounts(r._id, cap)) continue; // ⏹ post-session practice
        if (!rowsOf.has(r.uid)) rowsOf.set(r.uid, []);
        rowsOf.get(r.uid)!.push({
            pid: r.pid, at: r._id.getTimestamp(), accepted: r.status === STATUS.STATUS_ACCEPTED, score: r.score || 0,
        });
    }
    const threads = await gradedSessionThreads(domainId, sdoc);
    const msgsByUidPid = new Map<number, Map<number, TutorMessage[]>>();
    for (const t of threads) {
        if (!msgsByUidPid.has(t.uid)) msgsByUidPid.set(t.uid, new Map());
        msgsByUidPid.get(t.uid)!.set(t.pid, t.messages || []);
    }
    const progressDocs = await collProgress.find({ domainId, ssid: sdoc.docId }).project({ uid: 1, trajectory: 1 }).toArray();
    const trajOf = new Map((progressDocs as any[]).map((p) => [p.uid, p.trajectory]));
    const uids = [...rowsOf.keys()].filter((uid) => uid !== sdoc.owner);
    const udict: any = uids.length ? await user.getList(domainId, uids) : {};
    const labelOf = (pid: number) => String((pdict[pid] as any)?.pid || (pdict[pid] as any)?.title || pid);
    interface Item { uid: number, digests: ReturnType<typeof trajectoryTaskDigestsOf>, basis: string }
    const work: Item[] = [];
    for (const uid of uids) {
        const udoc: any = udict[uid];
        try {
            const staff = udoc && typeof udoc.hasPerm === 'function'
                && (udoc.hasPerm(PERM.PERM_EDIT_HOMEWORK) || udoc.hasPerm(PERM.PERM_CREATE_HOMEWORK));
            if (staff) continue;
        } catch (e) { /* keep */ }
        const rows = rowsOf.get(uid) || [];
        // ⭐⭐ Every task accepted first-try → the session collapses to
        // 🏆 40 + 🎓 60 and 📈 is n/a: skip the (unused) LLM judgment.
        // eslint-disable-next-line ts/no-use-before-define
        const faPids = firstAttemptAcceptedPids(rows);
        if (progPids.length && progPids.every((pid) => faPids.has(pid))) continue;
        const digests = trajectoryTaskDigestsOf(rows, msgsByUidPid.get(uid) || new Map(), labelOf);
        if (!digests.length) continue;
        const basis = trajectoryBasisOf(digests, rows.length);
        if (trajOf.get(uid)?.basis === basis) continue; // unchanged history — cached judgment stands
        work.push({ uid, digests, basis });
    }
    out.total = work.length;
    if (!work.length) return out;
    let done = 0;
    for (const w of work) {
        done += 1;
        try {
            await onProgress?.({
                uid: w.uid,
                uname: (udict as any)[w.uid]?.uname || String(w.uid),
                pid: `${w.digests.length}`,
                done,
                total: out.total,
                graded: out.graded,
                failed: out.failed,
            });
        } catch (e) { /* best-effort */ }
        // eslint-disable-next-line no-await-in-loop
        const level = await aiTutor.runTrajectoryGrading({ tasks: w.digests });
        if (level === null) {
            out.failed += 1;
            continue;
        }
        // 🚫 Manipulation anywhere in the digests → 📈 = 0, flagged.
        // eslint-disable-next-line no-await-in-loop
        await SelfLearningModel.setTrajectory(domainId, sdoc.docId, w.uid, {
            level: level === aiTutor.GRADER_FLAGGED ? 0 : level,
            at: new Date(),
            basis: w.basis,
            ...(level === aiTutor.GRADER_FLAGGED ? { flagged: true } : {}),
        });
        out.graded += 1;
    }
    return out;
}

/**
 * ⭐ Budgets are FROZEN onto the thread when its walkthrough is created,
 * so a POLICY CHANGE must be inherited by threads that already exist —
 * in either direction:
 *   - a deepened budget raises the stored one and REOPENS a walkthrough
 *     that was closed under the smaller budget, so its student can still
 *     be asked the newly-owed questions;
 *   - a shallower budget (e.g. the first-attempt track settling on the
 *     rubric's 5..6) lowers the stored one and CLOSES a walkthrough that
 *     already reached the new maximum, so no student is asked beyond the
 *     current policy. Questions already asked and answers already graded
 *     are never removed — every recorded level keeps counting in the
 *     🎓 mean.
 */
async function reconcileOwnershipBudget(thread: TutorThreadDoc): Promise<void> {
    const own = thread.ownership as any;
    if (!own) return;
    const budget = ownershipBudget((own.acceptedAttempt || 1) === 1);
    if ((own.maxQ || 0) === budget.max && (own.minQ || 0) === budget.min) return; // already current
    const asked = own.questions?.length || 0;
    const reopen = !!own.done && asked < budget.min;
    const close = !own.done && asked >= budget.max;
    await SelfLearningModel.updateOwnershipBudget(thread._id, budget.min, budget.max, reopen);
    own.minQ = budget.min;
    own.maxQ = budget.max;
    if (reopen) own.done = false;
    if (close) {
        await SelfLearningModel.setOwnershipDone(thread._id);
        own.done = true;
    }
}

/**
 * 🎓 The ownership question budget, fixed once per task at its FIRST
 * acceptance: 5..6 questions when that acceptance was the very first
 * attempt, 2..3 otherwise (the rubric's spec). The tutor must keep asking
 * below min, may stop between min and max, and the server refuses past
 * max.
 */
export function ownershipBudget(firstAttempt: boolean): { min: number, max: number } {
    // ⭐ A first-attempt acceptance skipped the whole failure-phase
    // dialogue, so its walkthrough digs deeper: 5..6 questions instead of
    // the guided track's 2..3.
    return firstAttempt ? { min: 5, max: 6 } : { min: 2, max: 3 };
}

/**
 * 🎓 From a task's judged submissions in chronological order (true =
 * accepted), find the FIRST acceptance: its 1-based attempt number, and
 * whether it was the very first attempt. "Attempt" means any judged,
 * non-pretest submission on the task — whichever page it came from — so
 * failing five times on the plain problem page and then passing on the
 * session page is NOT a first-attempt acceptance. Null = never accepted.
 */
export function classifyFirstAcceptance(accepted: boolean[]): { firstAttempt: boolean, attemptNo: number } | null {
    for (let i = 0; i < accepted.length; i++) {
        if (accepted[i]) return { firstAttempt: i === 0, attemptNo: i + 1 };
    }
    return null;
}

/** The record-history truth behind the walkthrough budget (see classifyFirstAcceptance). */
export async function acceptedOnFirstAttempt(
    domainId: string,
    uid: number,
    pid: number,
): Promise<{ firstAttempt: boolean, attemptNo: number } | null> {
    const rows = await record.getMulti(domainId, {
        uid, pid, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
    }).sort({ _id: 1 }).limit(200).project({ status: 1 }).toArray();
    return classifyFirstAcceptance((rows as any[]).map((r) => r.status === STATUS.STATUS_ACCEPTED));
}

/**
 * 🎓 OWNERSHIP — can the student explain their own accepted code? Only
 * POST-ACCEPTANCE responses are measured (the walkthrough exists solely on
 * accepted submissions; debugging answers never create entries). Each
 * answer is LLM-graded 0..4:
 *   0 no answer / "I don't know" / evasion; 1 restates the code in words;
 *   2 correct mechanical account (what and how); 3 correct plus why it is
 *   necessary (what breaks without it); 4 correct plus a generalization
 *   (tradeoff, alternative, complexity). The 2→3 boundary discriminates
 *   authorship.
 * Per task: the mean level over every graded response, with an asked-but-
 * never-answered question counting as one level-0 response.
 * ⭐ THE CURRENT RUBRIC consumes exactly that per-task mean: taskRubricOf
 * turns taskMeanOf(state) into the task's 🎓 points (level × 5, out of
 * 20), with no-walkthrough tasks charged 0. What follows below —
 * ownershipOf and the session-mean mapping — is the RETIRED 7-component
 * aggregation, kept dormant.
 * (Retired semantics:) The component
 * is the mean of those task means over the programming tasks that have at
 * least one ownership question, mapped onto SESSION_OWNERSHIP_MAX
 * (÷ 4 × 10), one decimal. Tasks never accepted ask no ownership
 * questions and stay out of the mean. A student with no ownership
 * questions ANYWHERE is NOT MEASURED: the component returns null — the
 * table, CSV and card render it as "—" (contributing 0 to the total) —
 * which is different from a real 0, i.e. measured and graded 0. This is
 * what legacy acceptances from before this rubric look like until the
 * student re-submits an accepted solution and answers the walkthrough.
 */
/**
 * One task's mean level (0..4) over every graded response, an
 * asked-but-never-answered question counting as one level-0 response;
 * null when the task has no ownership questions. THE per-task rule —
 * ownershipOf aggregates these, and the teacher's hover breakdown
 * (postOwnershipDetail) shows the same numbers.
 */
export function taskMeanOf(state: { questions: { levels: number[] }[] } | undefined | null): number | null {
    if (!state || !state.questions?.length) return null;
    const levels: number[] = [];
    for (const q of state.questions) {
        if (q.levels?.length) {
            for (const l of q.levels) levels.push(Math.min(OWNERSHIP_LEVEL_MAX, Math.max(0, +l || 0)));
        } else levels.push(0); // asked, never answered → evasion
    }
    return levels.reduce((a, b) => a + b, 0) / levels.length;
}

export function ownershipOf(
    entriesByPid: Map<number, { questions: { levels: number[] }[] }>,
    programmingPids: number[],
    max: number = SESSION_OWNERSHIP_MAX,
): number | null {
    const taskMeans: number[] = [];
    for (const pid of programmingPids) {
        const mean = taskMeanOf(entriesByPid.get(pid));
        if (mean !== null) taskMeans.push(mean);
    }
    if (!taskMeans.length) return null;
    const mean = taskMeans.reduce((a, b) => a + b, 0) / taskMeans.length;
    return Math.round((mean / OWNERSHIP_LEVEL_MAX) * max * 10) / 10;
}

/** 🔧 RETIRED (old 7-component rubric): guided fixes mapped onto 0..15. */
export const SESSION_FIXCONV_MAX = 15;
/** Cap of judged transitions per task (bounds LLM cost and gaming). */
export const MAX_FIXCONV_PER_TASK = 12;

/**
 * One task's PENALTY-WEIGHTED mean fix-conversion level (0..4): each judged
 * transition contributes level × fixConvPenalty(trial); null when the task
 * has no judged transitions. The teacher's hover breakdown shows the same
 * per-task numbers fixConvOf aggregates.
 */
/**
 * ⭐ THE CURRENT RUBRIC consumes exactly this per-task weighted mean:
 * taskRubricOf turns taskFixConvMeanOf(state) into the task's 🔧 points
 * (level × 3.75, out of 15), with no-transition tasks charged 0.
 */
export function taskFixConvMeanOf(state: { transitions: { level: number, trial: number }[] } | undefined | null): number | null {
    if (!state || !state.transitions?.length) return null;
    const vals = state.transitions.map((t) => Math.min(FIXCONV_LEVEL_MAX, Math.max(0, +t.level || 0)) * fixConvPenalty(t.trial || 1));
    return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * 🔧 GUIDANCE TO FIX CONVERSION — do students understand their fault and
 * make correct changes? Judged ONLY on failed attempts where the student
 * answered the tutor's questions AND then resubmitted (a final engagement
 * with no next submission is never counted). Each transition is LLM-graded
 * 0..4 (0 targeted region unchanged; 1 thrashing; 2 right area, incomplete;
 * 3 flaw correctly addressed; 4 minimal targeted fix), penalty-weighted by
 * trial (1 → 0.8 → 0.6 → 0.5 after), per-task mean, mean across measured
 * tasks, × 3.75 (= 15 / 4) onto SESSION_FIXCONV_MAX, one decimal. null =
 * nothing to judge anywhere (renders as —, adds 0 to the total).
 */
/**
 * 🔧 Per task: was the student's FIRST judged, non-pretest attempt
 * accepted? (Rows may arrive unordered; the earliest timestamp per pid
 * decides.) Such a task needed no guidance at all — the fix-conversion
 * rule below credits it as an implicit level-4 transition.
 */
export function firstAttemptAcceptedPids(rows: { pid: number, at: Date, accepted?: boolean }[]): Set<number> {
    const earliest = new Map<number, { at: number, accepted: boolean }>();
    for (const r of rows || []) {
        const t = new Date(r.at).getTime();
        const cur = earliest.get(r.pid);
        if (!cur || t < cur.at) earliest.set(r.pid, { at: t, accepted: !!r.accepted });
    }
    const out = new Set<number>();
    for (const [pid, e] of earliest) if (e.accepted) out.add(pid);
    return out;
}

export function fixConvOf(
    entriesByPid: Map<number, { transitions: { level: number, trial: number }[] }>,
    programmingPids: number[],
): number | null {
    /*
     * Under PER-TASK scoring a first-attempt task has NO fix slot (it is
     * scored 🏆 40 + 🎓 60), so the aggregate no longer injects a
     * phantom level 4 for such tasks: it mirrors exactly what feeds the
     * standard tasks' fix slots — the mean over guided transitions only,
     * null (or n/a) when no task needed guided fixing.
     */
    const taskMeans: number[] = [];
    for (const pid of programmingPids) {
        const mean = taskFixConvMeanOf(entriesByPid.get(pid));
        if (mean !== null) taskMeans.push(mean);
    }
    if (!taskMeans.length) return null;
    const mean = taskMeans.reduce((a, b) => a + b, 0) / taskMeans.length;
    return Math.round((mean / FIXCONV_LEVEL_MAX) * SESSION_FIXCONV_MAX * 10) / 10;
}

/** 📈 The Independence-Trajectory component's scale: 0..10. */
export const SESSION_TRAJECTORY_MAX = 10;
/**
 * Policy constant, not a fact: the slope treated as "strong improvement"
 * (a 90th→10th-percentile journey over 10 problems ≈ −9 percentile
 * points per problem). Calibrate against real class data if the first
 * runs cluster at 100 (too generous) or never exceed 60 (too harsh).
 */
export const TRAJECTORY_SLOPE_CEILING = 9;

export interface AssistanceWindow {
    /** First-engagement window [start, end) in epoch ms; end null = never closed. */
    start: number;
    end: number | null;
    /** 1-based chronological position among the student's engaged tasks. */
    position: number;
}

/**
 * 📈 Per programming task the student engaged with (≥ 1 judged record):
 * the FIRST-ENGAGEMENT window — from their first judged submission until
 * the FIRST acceptance on the task or until they PARK it (first activity
 * on any other task after starting this one), whichever comes first.
 * Position is the order they first touched tasks in, not task id.
 */
export function assistanceWindows(
    rows: { pid: number, at: Date, accepted?: boolean }[],
    programmingPids: number[],
): Map<number, AssistanceWindow> {
    const prog = new Set(programmingPids);
    const startOf = new Map<number, number>();
    const firstAcOf = new Map<number, number>();
    for (const r of rows || []) {
        if (!prog.has(r.pid)) continue;
        const t = new Date(r.at).getTime();
        if (!startOf.has(r.pid) || t < startOf.get(r.pid)!) startOf.set(r.pid, t);
        if (r.accepted && (!firstAcOf.has(r.pid) || t < firstAcOf.get(r.pid)!)) firstAcOf.set(r.pid, t);
    }
    const ordered = [...startOf.entries()].sort((a, b) => a[1] - b[1]);
    const out = new Map<number, AssistanceWindow>();
    for (let i = 0; i < ordered.length; i++) {
        const [pid, start] = ordered[i];
        let park: number | null = null;
        for (const [opid, ostart] of ordered) {
            if (opid !== pid && ostart > start && (park === null || ostart < park)) park = ostart;
        }
        const ac = firstAcOf.get(pid);
        let end: number | null;
        if (ac !== undefined && park !== null) end = Math.min(ac, park);
        else if (ac !== undefined) end = ac;
        else end = park;
        out.set(pid, { start, end, position: i + 1 });
    }
    return out;
}

/**
 * 📈 Assistance index = tutor exchanges the student ANSWERED inside the
 * first-engagement window (before the correct fix or before parking).
 * Zero is meaningful: solving with no help is maximal independence.
 * Answers at or after the first acceptance are Ownership territory and
 * never counted here (the window ends at that acceptance).
 */
export function assistanceIndexOf(
    win: AssistanceWindow,
    messages: { role: string, kind: string, at?: Date }[],
): number {
    let n = 0;
    for (const m of messages || []) {
        if (m.kind !== 'anno' || m.role !== 'user' || !m.at) continue;
        const t = new Date(m.at).getTime();
        if (t >= win.start && (win.end === null || t < win.end)) n += 1;
    }
    return n;
}

/**
 * 📈 Class percentile of an assistance index (classIndices INCLUDES the
 * student's own value): low percentile = little help — a student needing
 * less than 80% of classmates sits near the 20th.
 *
 * REDESIGNED ANCHOR: needing NO help at all is an ABSOLUTE state, not a
 * relative one — you cannot need less than none — so an index of 0
 * always maps to the 0th percentile, regardless of how many classmates
 * were equally independent. Under pure midrank, ties among zero-help
 * students dragged all of them to the 50th, capping a student who was
 * accepted everywhere on the first attempt near 5/10; with the anchor,
 * such a student's level is 100 and the component is a guaranteed full
 * score. Non-zero indices keep the midrank rank against the WHOLE class
 * (zero-help classmates included), so needing 3 exchanges while everyone
 * else needed none still ranks as heavy help. A lone helped student sits
 * at 50 (neutral).
 */
export function assistancePercentile(classIndices: number[], mine: number): number {
    if (mine === 0) return 0; // absolute independence — the floor, always
    const n = classIndices.length;
    if (!n) return 50;
    let less = 0;
    let equal = 0;
    for (const v of classIndices) {
        if (v < mine) less += 1;
        else if (v === mine) equal += 1;
    }
    return (100 * (less + 0.5 * equal)) / n;
}

/** Standard least-squares slope; null when undefined (< 2 points or zero variance). */
export function lsSlope(points: { x: number, y: number }[]): number | null {
    const n = points.length;
    if (n < 2) return null;
    const xm = points.reduce((a, q) => a + q.x, 0) / n;
    const ym = points.reduce((a, q) => a + q.y, 0) / n;
    let num = 0;
    let den = 0;
    for (const q of points) {
        num += (q.x - xm) * (q.y - ym);
        den += (q.x - xm) ** 2;
    }
    if (!den) return null;
    return num / den;
}

export interface TrajectoryInfo {
    /** 100 − mean percentile: strong throughout scores high here. */
    level: number;
    /** 50 + 50 × clamp(−slope / ceiling, 0, 1): improving scores high here. */
    improvement: number;
    slope: number | null;
    /** max(level, improvement), 0..100. */
    score: number;
}

/**
 * 📈 INDEPENDENCE TRAJECTORY — does the student need less tutor help
 * across the session? Input: the class percentiles of their assistance
 * indices, in chronological engagement order. A strong student who needs
 * little help throughout scores via level; a weaker student who improves
 * scores via the fitted downward trend; the component takes the better.
 */
export function trajectoryOf(percentilesInOrder: number[]): TrajectoryInfo | null {
    if (!percentilesInOrder.length) return null;
    const level = 100 - percentilesInOrder.reduce((a, b) => a + b, 0) / percentilesInOrder.length;
    const slope = lsSlope(percentilesInOrder.map((y, i) => ({ x: i + 1, y })));
    const normalized = slope === null ? 0 : Math.min(1, Math.max(0, -slope / TRAJECTORY_SLOPE_CEILING));
    const improvement = 50 + 50 * normalized;
    const score = Math.max(level, improvement);
    return {
        level: Math.round(level * 10) / 10,
        improvement: Math.round(improvement * 10) / 10,
        slope: slope === null ? null : Math.round(slope * 100) / 100,
        score,
    };
}

/** The 0..100 trajectory mapped onto the 10-point component, one decimal. */
export function trajectoryComponentOf(info: TrajectoryInfo | null): number | null {
    if (!info) return null;
    return Math.round((info.score / 100) * SESSION_TRAJECTORY_MAX * 10) / 10;
}

/** 🧠 RETIRED (old 7-component rubric): the Concept-Transfer scale, 0..15. */
export const SESSION_TRANSFER_MAX = 15;
/** Cap of transfer assessments per student per session (bounds LLM cost). */
export const MAX_TRANSFER_PER_STUDENT = 20;

/**
 * 🧠 CONCEPT TRANSFER — a mistake (missed knowledge point) made and
 * resolved on one task: does it recur on the next task exercising the same
 * concept? Score = mean(level 0..4) × 3.75 onto SESSION_TRANSFER_MAX,
 * one decimal; null = no concept had a judged re-encounter yet.
 */
export function conceptTransferOf(assessments: { level: number }[] | undefined | null): number | null {
    const list = assessments || [];
    if (!list.length) return null;
    const mean = list.reduce((a, x) => a + Math.min(TRANSFER_LEVEL_MAX, Math.max(0, +x.level || 0)), 0) / list.length;
    return Math.round((mean / TRANSFER_LEVEL_MAX) * SESSION_TRANSFER_MAX * 10) / 10;
}

export interface TransferCandidate { concept: string, fromPid: number, toPid: number }

/**
 * 🧠 Plan the transfer tests, purely from per-task facts:
 *   - the BASELINE of concept C is the first engaged task (chronological by
 *     engagement start) where C SURFACED in the failure tutoring AND the
 *     task was RESOLVED (accepted) — a parked task where C was raised but
 *     never resolved sets NO baseline (a later surfaced-and-resolved task
 *     can);
 *   - the judged re-encounter is the FIRST task engaged after the baseline
 *     whose knowledge points include C; later re-encounters are not judged;
 *   - a concept whose baseline has no later C-tagged engagement is
 *     untested and stays out of the mean.
 * Deterministic order (baseline start, then name) so the per-student cap
 * is stable across evaluations.
 */
/**
 * 🧠 The per-concept BASELINES: the first engaged task (chronological)
 * where the concept surfaced AND the task was resolved. A raised-but-
 * parked task sets no baseline. One per concept.
 */
export function extractTransferBaselines(
    engagements: { pid: number, start: number }[],
    surfacedByPid: Map<number, string[]>,
    resolvedPids: Set<number>,
): { concept: string, fromPid: number, start: number }[] {
    const ordered = [...engagements].sort((a, b) => a.start - b.start);
    const seen = new Set<string>();
    const out: { concept: string, fromPid: number, start: number }[] = [];
    for (const e of ordered) {
        if (!resolvedPids.has(e.pid)) continue; // raised-but-parked: no baseline
        for (const concept of [...(surfacedByPid.get(e.pid) || [])].sort()) {
            if (seen.has(concept)) continue;
            seen.add(concept);
            out.push({ concept, fromPid: e.pid, start: e.start });
        }
    }
    return out;
}

export function extractTransferCandidates(
    engagements: { pid: number, start: number }[],
    tagsByPid: Map<number, string[]>,
    surfacedByPid: Map<number, string[]>,
    resolvedPids: Set<number>,
): TransferCandidate[] {
    const startOf = new Map(engagements.map((e) => [e.pid, e.start]));
    const out: TransferCandidate[] = [];
    for (const b of extractTransferBaselines(engagements, surfacedByPid, resolvedPids)) {
        let toPid: number | null = null;
        let toStart = Infinity;
        for (const [pid, tags] of tagsByPid) {
            if (pid === b.fromPid) continue;
            const s = startOf.get(pid);
            if (s === undefined || s <= b.start) continue; // must be engaged AFTER the baseline
            if (!tags.includes(b.concept)) continue;
            if (s < toStart) {
                toStart = s;
                toPid = pid;
            }
        }
        if (toPid !== null) out.push({ concept: b.concept, fromPid: b.fromPid, toPid });
    }
    return out;
}

/** 🧩 The Reasoning-Quality component's scale: 0..25. */
export const SESSION_REASONING_MAX = 25;
/** Cap of graded failure answers per task (anti-spam, bounds LLM cost). */
export const MAX_REASONING_PER_TASK = 24;

/**
 * 🧩 REASONING QUALITY — do the tutor's questions get substantial
 * answers during FAILED attempts: thinking, not guessing? Judged per
 * exchange across all cycles and all tasks; the score is the FLAT mean of
 * every graded level × 6.25 (= 25 / 4) onto SESSION_REASONING_MAX, one
 * decimal. null = no failure-phase answers graded anywhere.
 */
export function reasoningOf(states: { levels: number[] }[] | undefined | null): number | null {
    const levels: number[] = [];
    for (const s of states || []) {
        for (const l of s?.levels || []) levels.push(Math.min(REASONING_LEVEL_MAX, Math.max(0, +l || 0)));
    }
    if (!levels.length) return null;
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
    return Math.round((mean / REASONING_LEVEL_MAX) * SESSION_REASONING_MAX * 10) / 10;
}

/** 💡 RETIRED (old 7-component rubric): the Self-Diagnostic-Initiative scale, 0..5. */
export const SESSION_INITIATIVE_MAX = 5;

/**
 * 💡 SELF-DIAGNOSTIC INITIATIVE — does the student show up with a
 * theory about their own bug, or wait to be led? One level per task
 * (first engagement only); score = mean(level 0..4) × 1.25 (= 5 / 4)
 * onto SESSION_INITIATIVE_MAX, one decimal; null = nothing judged yet.
 */
export function initiativeOf(levels: number[] | undefined | null): number | null {
    const list = (levels || []).map((l) => Math.min(INITIATIVE_LEVEL_MAX, Math.max(0, +l || 0)));
    if (!list.length) return null;
    const mean = list.reduce((a, b) => a + b, 0) / list.length;
    return Math.round((mean / INITIATIVE_LEVEL_MAX) * SESSION_INITIATIVE_MAX * 10) / 10;
}

/** Every rubric component of one student, from their per-task bests and ownership states. */
export function componentsOf(
    sdoc: SelfLearningDoc,
    best: Map<number, TaskBest>,
    programmingPids: number[],
    ownershipByPid: Map<number, { questions: { levels: number[] }[] }>,
    fixConvByPid: Map<number, { transitions: { level: number, trial: number }[] }>,
    trajectory: number | null = null,
    transferAssessments?: { level: number }[] | null,
    reasoningStates?: { levels: number[] }[] | null,
    initiativeLevels?: number[] | null,
): SessionComponents {
    return {
        achievement: achievementOf(sdoc, best, programmingPids),
        ownership: ownershipOf(ownershipByPid, programmingPids),
        fixConv: fixConvOf(fixConvByPid, programmingPids),
        trajectory,
        transfer: conceptTransferOf(transferAssessments),
        reasoning: reasoningOf(reasoningStates),
        initiative: initiativeOf(initiativeLevels),
    };
}

/**
 * ⭐ PER-TASK SCORING — the session total is the AVERAGE of one score per
 * programming task, each out of TASK_SCORE_MAX (100):
 *   - a task passed on the very FIRST attempt is "execute + explain":
 *     🏆 40 × effective/100 + 🎓 60 × walkthrough-mean/4;
 *   - any other attempted task follows the seven components, with the two
 *     session-level quantities (📈 Trajectory 0..10 and 🧠 Transfer
 *     0..15) injected at their session values;
 *   - an unattempted task scores 0 and still counts in the mean.
 * "Not applicable through excellence" earns the alternate split; "not
 * measured through avoidance" stays a pending 0. The session components
 * (achievementOf, ownershipOf, ...) remain as the board's transparency
 * aggregates; the TOTAL comes from the per-task composites alone.
 */
export const TASK_SCORE_MAX = 100;

/**
 * ⭐ THE CURRENT RUBRIC consumes exactly this per-task mean: taskRubricOf
 * turns reasoningTaskMeanOf(state) into the task's 🧩 points (level ×
 * 7.5, out of 30), with nothing-graded tasks charged 0. Per-task
 * reasoning mean (0..4) from the thread's failure-answer levels; null
 * when nothing graded.
 */
export function reasoningTaskMeanOf(state: { levels: number[] } | undefined | null): number | null {
    const levels = (state?.levels || []).map((l) => Math.min(REASONING_LEVEL_MAX, Math.max(0, +l || 0)));
    if (!levels.length) return null;
    return levels.reduce((a, b) => a + b, 0) / levels.length;
}

/**
 * 🧠 RETIRED note (old 7-component rubric): the three-cause analysis
 * below described a RENORMALIZATION for the untestable case. THE CURRENT
 * RUBRIC replaces it with the spec's edge case — an untestable student
 * (no relevant knowledge points among the tasks, or none re-encountered)
 * receives the FULL TRANSFER_SHARE (15) directly (transferSubScoreOf);
 * assessed → mean × 3.75; pending → 0. The states themselves survive:
 * Transfer's null has THREE causes, and only one deserves a 0:
 *   'assessed'   — ≥ 1 re-encounter judged: the value is real;
 *   'pending'    — testable but not yet graded (surfacing incomplete, or
 *                  planned candidates await judging): pending-0, resolves
 *                  on the next evaluation;
 *   'untestable' — surfacing is complete and the planner yields ZERO
 *                  re-encounters (disjoint knowledge points, the mistake
 *                  came last, nothing surfaced, or an untagged session):
 *                  the student can do nothing to be tested, so the 🧠
 *                  slot is REMOVED and their standard tasks renormalize
 *                  onto 100. Neutral under baseline-voiding maneuvers:
 *                  the slot leaves both what can be earned and what one
 *                  is graded out of.
 */
export function transferStateOf(input: {
    assessments: number,
    anyTags: boolean,
    surfacingIncomplete: boolean,
    candidates: number,
}): 'assessed' | 'pending' | 'untestable' {
    if (input.assessments > 0) return 'assessed';
    if (!input.anyTags) return 'untestable';
    if (input.surfacingIncomplete) return 'pending';
    return input.candidates > 0 ? 'pending' : 'untestable';
}

export interface TaskScorePart { key: string, max: number, value: number, pending?: boolean }
export interface TaskScoreBreakdown {
    pid: number;
    attempted: boolean;
    firstAttempt: boolean;
    /** 0..TASK_SCORE_MAX, one decimal (already renormalized when basis < 100). */
    score: number;
    /** The unscaled sum of the parts, one decimal. */
    raw: number;
    /** The denominator the parts sum toward: 100, or 85 when the 🧠 slot is removed (untestable). */
    basis: number;
    parts: TaskScorePart[];
}

export function taskScoreOf(input: {
    pid: number,
    best?: { effective: number } | null,
    firstAttempt: boolean,
    ownershipMean: number | null,
    fixConvMean: number | null,
    reasoningMean: number | null,
    initiativeLevel: number | null,
    sessionTrajectory: number | null,
    sessionTransfer: number | null,
    /** 🧠 True when transfer is UNTESTABLE for this student: the slot is skipped and the task renormalizes onto 100. */
    transferUntestable?: boolean,
}): TaskScoreBreakdown {
    const r1 = (x: number) => Math.round(x * 10) / 10;
    if (!input.best) {
        return {
            pid: input.pid, attempted: false, firstAttempt: false, score: 0, raw: 0, basis: TASK_SCORE_MAX, parts: [],
        };
    }
    const eff = Math.min(100, Math.max(0, input.best.effective || 0));
    const parts: TaskScorePart[] = [];
    let sum = 0;
    /** A 0..4 level quantity mapped onto its slot; null = pending 0. */
    const level = (key: string, x: number | null, max: number) => {
        if (x === null) {
            parts.push({
                key, max, value: 0, pending: true,
            });
            return;
        }
        const v = (Math.min(4, Math.max(0, x)) / 4) * max;
        parts.push({ key, max, value: r1(v) });
        sum += v;
    };
    /** A ready 0..max session value injected as-is; null = pending 0. */
    const injected = (key: string, x: number | null, max: number) => {
        if (x === null) {
            parts.push({
                key, max, value: 0, pending: true,
            });
            return;
        }
        const v = Math.min(max, Math.max(0, x));
        parts.push({ key, max, value: r1(v) });
        sum += v;
    };
    const ach = (max: number) => {
        const v = (eff / 100) * max;
        parts.push({ key: 'achievement', max, value: r1(v) });
        sum += v;
    };
    if (input.firstAttempt) {
        ach(FIRST_ATTEMPT_ACH_MAX);
        level('ownership', input.ownershipMean, FIRST_ATTEMPT_OWN_MAX);
    } else {
        ach(SESSION_ACHIEVEMENT_MAX);
        level('ownership', input.ownershipMean, SESSION_OWNERSHIP_MAX);
        level('fixConv', input.fixConvMean, SESSION_FIXCONV_MAX);
        injected('trajectory', input.sessionTrajectory, SESSION_TRAJECTORY_MAX);
        if (!input.transferUntestable) injected('transfer', input.sessionTransfer, SESSION_TRANSFER_MAX);
        level('reasoning', input.reasoningMean, SESSION_REASONING_MAX);
        level('initiative', input.initiativeLevel, SESSION_INITIATIVE_MAX);
    }
    const basis = (!input.firstAttempt && input.transferUntestable)
        ? TASK_SCORE_MAX - SESSION_TRANSFER_MAX
        : TASK_SCORE_MAX;
    return {
        pid: input.pid,
        attempted: true,
        firstAttempt: input.firstAttempt,
        raw: r1(sum),
        basis,
        score: r1((sum / basis) * TASK_SCORE_MAX),
        parts,
    };
}

/** ⭐ The session total: mean of the per-task scores over ALL programming tasks, one decimal. */
export function sessionTaskMeanTotal(breakdowns: TaskScoreBreakdown[]): number {
    if (!breakdowns.length) return 0;
    const sum = breakdowns.reduce((a, b) => a + (b.score || 0), 0);
    return Math.round((sum / breakdowns.length) * 10) / 10;
}

/**
 * Score embargo: a student's session TOTAL is shown only once the session's
 * deadline (endAt) has passed — the late window qualifies, since the
 * deadline itself is then behind us — or once the teacher has pressed
 * "Evaluate all students now" at least once (which stores sdoc.results; the
 * automatic post-deadline evaluation writes the same object, but by then
 * the phase releases on its own). Per-task score chips are deliberately NOT
 * embargoed: every verdict modal already shows its score the moment a
 * submission is judged — only the summed total is news. Sessions without
 * dates (phase 'open') therefore release exclusively through the teacher's
 * evaluation, matching the results panel's own wording for them.
 */
export function totalScoreReleased(sdoc: SelfLearningDoc, schedule = sessionSchedule(sdoc)): boolean {
    if (schedule.phase === 'extension' || schedule.phase === 'ended') return true;
    return !!sdoc.results?.computedAt;
}

/**
 * Client-safe copy of a session doc for NON-STAFF payloads. The stored
 * results table (every student's name and total) must never reach a
 * student: no template renders it, but every handler body here serializes
 * VERBATIM for `Accept: application/json` callers, so the doc itself has
 * to travel without it.
 */
function scrubResults<T extends SelfLearningDoc>(sdoc: T): T {
    if (!sdoc || (!sdoc.results && !sdoc.evalJob)) return sdoc;
    const copy: any = { ...sdoc };
    delete copy.results;
    delete copy.evalJob; // teachers' evaluation bookkeeping — not for students
    return copy as T;
}

class SelfLearningMainHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('q', Types.String, true)
    @param('phase', Types.Name, true)
    async get({ domainId }, page = 1, q = '', phase = '') {
        // Homework-parity toolbar: title search, a phase filter standing in
        // for homework's group filter (sessions have no groups), and a
        // calendar view fed exactly like homework's.
        if (!['open', 'notStarted', 'running', 'extension', 'ended'].includes(phase)) phase = '';
        const escaped = escapeRegExp(q.toLowerCase());
        const query = q ? { title: { $regex: new RegExp(q.length >= 2 ? escaped : `^${escaped}`, 'im') } } : {};
        /*
         * A course runs dozens of sessions, not thousands — fetch the
         * q-matched set once, compute each schedule once, then filter and
         * paginate in memory so the phase filter (a COMPUTED property)
         * cannot punch holes in server-side pages.
         */
        const all = await SelfLearningModel.getMulti(domainId, query).limit(500).toArray();
        const now = new Date();
        const scheds = new Map(all.map((s) => [s.docId.toHexString(), sessionSchedule(s, now)]));
        const filtered = phase ? all.filter((s) => scheds.get(s.docId.toHexString())!.phase === phase) : all;
        const PER_PAGE = 20;
        const spcount = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
        page = Math.min(page, spcount);
        const sdocs = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
        const udict = await user.getList(domainId, sdocs.map((i) => i.owner));
        const sPhase: Record<string, SessionPhase> = {};
        const sPenalty: Record<string, number> = {};
        for (const s of sdocs) {
            const sc = scheds.get(s.docId.toHexString())!;
            sPhase[s.docId.toHexString()] = sc.phase;
            sPenalty[s.docId.toHexString()] = sc.penalty;
        }
        /*
         * Calendar events, homework's exact convention: the solid bar runs
         * begin → nominal deadline; once the session is extended or done the
         * bar runs to the hard stop with the extension masked from the
         * deadline ("Time Extension" hatch). Always-open sessions have no
         * dates to sit on — they stay list-only.
         */
        const calendar: any[] = [];
        for (const s of filtered) {
            if (!s.beginAt || !s.endAt) continue;
            const sc = scheds.get(s.docId.toHexString())!;
            const cal: any = {
                _id: s.docId, title: s.title, beginAt: s.beginAt, url: this.url('self_learning_detail', { ssid: s.docId }),
            };
            if (sc.hardEndAt && sc.hardEndAt > s.endAt && ['extension', 'ended'].includes(sc.phase)) {
                cal.endAt = sc.hardEndAt;
                cal.penaltySince = s.endAt;
            } else cal.endAt = s.endAt;
            calendar.push(cal);
        }
        let qs = q ? `q=${encodeURIComponent(q)}` : '';
        if (phase) qs += `${qs ? '&' : ''}phase=${phase}`;
        // The list template never renders sdoc.results, but JSON callers get
        // the docs verbatim — same staff rule as the detail page, per doc.
        const listStaff = this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK) || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
        this.response.template = 'self_learning.html';
        this.response.body = {
            sdocs: sdocs.map((s) => ((listStaff || this.user.own(s)) ? s : scrubResults(s))),
            udict,
            sPhase,
            sPenalty,
            calendar,
            page,
            spcount,
            qs,
            q,
            phase,
            canCreate: this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK),
        };
    }
}

/* ------------------------------------------------------------------ */
/*  AI task advisor for session creation                               */
/* ------------------------------------------------------------------ */
/*
 * The teacher describes what the session should train ("for-loops with
 * sentinel input"); the advisor proposes 3-8 of the domain's programming
 * tasks that (a) exercise the knowledge points the goal maps to and
 * (b) INTERLOCK — every suggested task shares a knowledge point with
 * another one — so a misconception observed in one task can be observed
 * again in the next. Reasons are per task; the overlap table names the
 * shared points. The teacher then adds tasks freely; nothing is chosen
 * for them. Follow-up messages refine the set (stateless: the client
 * keeps the short conversation and sends it back).
 */
const ADVISOR_SYSTEM = `You are a course assistant helping a programming teacher assemble a SELF-LEARNING SESSION: a small set of programming tasks students solve on their own with an AI tutor, chosen so that a mistake (a missed knowledge point) revealed in one task can be observed again in another. You know the course's task catalog and its knowledge-point vocabulary. You only ever recommend tasks from the candidate list you are given, by their exact pid. You write in English only, whatever language the teacher uses.`;

const ADVISOR_PROMPT = `From the CANDIDATE TASKS below (the domain's programming tasks with their knowledge-point labels), suggest 3 to 8 tasks for the teacher's goal.
Selection rules:
1. RELEVANCE — every task must exercise the knowledge points the goal is about. Interpret the goal with the CATALOG, which is a TREE (topic › subtopic › point): a goal phrased at topic level ("for-loop", "loops") covers every point beneath that topic, and candidate labels are shown with their topic ("Loops › For loop reading n values").
2. MUTUAL RELEVANCE — the set must interlock: each suggested task shares at least one goal-relevant knowledge point — the same point, or two points under the same goal-relevant topic — with at least one other suggested task, and the goal's core points should each be carried by two or more suggested tasks, so a mistake in one task can recur in another. Name shared points by their exact label (the part after the last "›").
3. PROGRESSION — the tasks form a LEARNING PATH that students work through in order, from simple to hard. Order primarily by knowledge-point load: step 1 needs only the goal's most basic point(s) in their plainest form; every later step keeps what came before and adds at most one or two new points, or a harder application of the same points (bigger constraints, a pitfall, a combination). Difficulty (1-10) and acceptance rates are hints, not the rule. Prefer varied scenarios over near-duplicates. Say what each step adds and what it builds on.
4. Use pids from the candidate list ONLY, exactly as written. If fewer than 3 candidates fit, return what fits and say in "notes" what is missing (e.g. a knowledge point no task carries yet — the teacher can create one in the AI Studio).
Reply with ONLY JSON:
{"points": [string], "path": string, "tasks": [{"step": number, "pid": string, "level": "basic"|"intermediate"|"advanced", "buildsOn": string, "newPoints": [string], "reason": string, "points": [string]}], "overlap": [{"point": string, "pids": [string]}], "notes": string}
- "points": the catalog knowledge points the goal maps to (exact catalog names, most central first).
- "path": two or three sentences describing the progression as a whole — where it starts, how the demand grows, where it ends.
- "tasks": in learning order; "step" is 1, 2, 3 ... in that order.
- "tasks[].level": the student's expected effort at this step relative to the others.
- "tasks[].buildsOn": the pid of the earlier suggested task this step builds on ("" for step 1).
- "tasks[].newPoints": the goal-relevant knowledge points first required at this step (exact names from its label list; empty when the step deepens earlier points instead).
- "tasks[].reason": one or two sentences — why this task, why at this position, and which other suggested task it connects to through which knowledge point.
- "tasks[].points": the labels of that task that matter for this goal (exact names from its label list).
- "overlap": each goal-relevant knowledge point carried by two or more suggested tasks, with those pids.
- "notes": one short paragraph for the teacher — coverage, gaps, and how the set lets repeated mistakes be observed.
Write "path", "reason" and "notes" in English only, whatever language the teacher writes in.`;

/** Wrapping-fence tolerant JSON extraction (the model is asked for bare JSON). */
function parseJsonLoose(text: string): any {
    const raw = String(text || '').trim();
    const fenced = /^```(?:json|jsonc)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(raw);
    const body = fenced ? fenced[1].trim() : raw;
    try {
        return JSON.parse(body);
    } catch (e) {
        const a = body.indexOf('{');
        const b = body.lastIndexOf('}');
        if (a >= 0 && b > a) return JSON.parse(body.slice(a, b + 1));
        throw e;
    }
}

interface AdvisorCandidate {
    docId: number;
    pid: string;
    title: string;
    difficulty: number;
    nSubmit: number;
    nAccept: number;
    hidden: boolean;
    tags: string[];
    /** 🌳 The ancestor paths of the task's labels ("Control flow › Loops"), for goal matching. */
    paths?: string[];
}

/** Crude lexical relevance of a task to the goal — only used to bound the candidate list. */
function goalScore(goalWords: string[], c: AdvisorCandidate): number {
    // 🌳 A goal said at topic level ("loops") should reach a task whose
    // label lives under that topic even when the label's own words differ.
    const hay = `${c.title} ${c.tags.join(' ')} ${(c.paths || []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const w of goalWords) if (w.length >= 3 && hay.includes(w)) score += 1;
    return score * 10 + Math.min(c.tags.length, 8); // richer labeling breaks ties
}

class SelfLearningEditHandler extends Handler {
    sdoc?: SelfLearningDoc;

    @param('ssid', Types.ObjectId, true)
    async prepare({ domainId }, ssid?: ObjectId) {
        if (ssid) {
            this.sdoc = await loadSession(domainId, ssid);
            if (this.sdoc.owner !== this.user._id) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        } else this.checkPerm(PERM.PERM_CREATE_HOMEWORK);
    }

    async get() {
        // Prefill exactly like HomeworkEditHandler: existing values in the
        // teacher's timezone, or tomorrow-00:00 → +14 days 23:59 defaults.
        const beginAt = this.sdoc?.beginAt
            ? moment(this.sdoc.beginAt).tz(this.user.timeZone)
            : moment().add(1, 'day').tz(this.user.timeZone).hour(0).minute(0).second(0).millisecond(0);
        const endAt = this.sdoc?.endAt
            ? moment(this.sdoc.endAt).tz(this.user.timeZone)
            : beginAt.clone().add(14, 'days').hour(23).minute(59);
        /*
         * Sessions are programming-only. A session saved before that rule
         * may still list quiz / subjective tasks; the picker is locked to
         * programming, so it cannot ADD any, but the teacher must remove the
         * old ones before postUpdate accepts the form — list them so the
         * rejection never comes as a surprise.
         */
        let legacyTasks: { pid: string, title: string, kind: SessionTaskKind }[] = [];
        // The editor picks programming and function tasks in two sections
        // that merge into the ordered `pids`; on edit the stored list is
        // split back by kind so each section prefills with its own tasks.
        const progPids: number[] = [];
        const fnPids: number[] = [];
        if (this.sdoc?.pids?.length) {
            try {
                const pdict = await problem.getList(
                    this.args.domainId, this.sdoc.pids, true, false, problem.PROJECTION_CONTEST_LIST, true,
                );
                legacyTasks = this.sdoc.pids
                    .map((pid) => pdict[pid])
                    .filter((pdoc) => pdoc && pdoc.docId && !isCodeSessionKind(sessionKindOf(pdoc)))
                    .map((pdoc) => ({ pid: String(pdoc.pid || pdoc.docId), title: pdoc.title, kind: sessionKindOf(pdoc) }));
                for (const pid of this.sdoc.pids) {
                    const k = pdict[pid] ? sessionKindOf(pdict[pid]) : 'programming';
                    (k === 'function' ? fnPids : progPids).push(pid);
                }
            } catch (e) { /* the warning is best-effort; postUpdate still enforces the rule */ }
        }
        this.response.template = 'self_learning_edit.html';
        this.response.body = {
            sdoc: this.sdoc,
            pids: this.sdoc ? this.sdoc.pids.join(',') : '',
            progPids: progPids.join(','),
            fnPids: fnPids.join(','),
            legacyTasks,
            advisorAvailable: aiTutor.tutorEnabled() && aiTutor.tutorConfigured(),
            dateBeginText: beginAt.format('YYYY-M-D'),
            timeBeginText: beginAt.format('H:mm'),
            dateEndText: endAt.format('YYYY-M-D'),
            timeEndText: endAt.format('H:mm'),
            extensionDays: this.sdoc?.extensionDays ?? 1,
            // 🎁 undefined (new session, or one saved before the tickbox
            // existed) prefills as ticked — see SelfLearningDoc.bonusEnabled.
            bonusEnabled: this.sdoc?.bonusEnabled ?? true,
            // 🌐 The picker reads a comma-joined id list (same convention as
            // contest_edit's `langs`).
            langs: (this.sdoc?.langs || []).join(','),
            penaltyRules: this.sdoc?.penaltyRules ? yamlDump(this.sdoc.penaltyRules) : null,
            page_name: this.sdoc ? 'self_learning_edit' : 'self_learning_create',
        };
    }

    /**
     * AI task advisor: `message` is the teacher's goal (first turn) or a
     * refinement; `history` is the prior conversation as JSON
     * [{role:'user'|'assistant', content}] (assistant turns are the compact
     * summaries this handler returned), so the model can revise its own
     * suggestion. Stateless — nothing is stored.
     */
    @param('message', Types.String)
    @param('history', Types.String, true)
    async postSuggest({ domainId }, message: string, history = '') {
        if (!aiTutor.tutorEnabled() || !aiTutor.tutorConfigured()) throw new ForbiddenError('The AI assistant is not configured. Please ask the administrator to set an API key.');
        const goal = String(message || '').trim().slice(0, 2000);
        if (!goal) throw new BadRequestError('Describe what the session should train first.');
        await this.limitRate('ai_tutor', 60, 10, '{{user}}');

        // Candidates: the domain's programming tasks this teacher may see.
        const visible = KnowledgeModel.visibilityFilter(this.user, PERM.PERM_VIEW_PROBLEM_HIDDEN);
        // Both code kinds: a progression may mix programming and function tasks.
        const rows = await problem.getMulti(domainId, { $and: [PROBLEM_KIND_FILTERS.code, visible] },
            ['docId', 'pid', 'title', 'tag', 'difficulty', 'nSubmit', 'nAccept', 'hidden'] as any)
            .limit(2000).toArray();
        const all: AdvisorCandidate[] = rows.map((p: any) => ({
            docId: p.docId,
            pid: String(p.pid || p.docId),
            title: p.title || '',
            difficulty: p.difficulty || 0,
            nSubmit: p.nSubmit || 0,
            nAccept: p.nAccept || 0,
            hidden: !!p.hidden,
            tags: (p.tag || []).map((t: any) => String(t)).filter((t: string) => t),
        }));
        if (!all.length) throw new BadRequestError('This domain has no programming tasks yet — create some in the AI Studio first.');
        // Labeled tasks carry the knowledge points the advisor reasons
        // about; unlabeled ones join only when labeled ones are scarce.
        const labeled = all.filter((c) => c.tags.length);
        const pool = labeled.length >= 30 ? labeled : all;
        // 🌳 Ancestor paths per label, once per distinct tag, for the goal match.
        const ancestorsOf = new Map<string, string>();
        for (const c of pool) {
            for (const t of c.tags) {
                const k = t.toLowerCase();
                if (ancestorsOf.has(k)) continue;
                const doc = await KnowledgeModel.getByName(domainId, t);
                ancestorsOf.set(k, doc && doc.path?.length ? doc.path.join(' ') : '');
            }
            c.paths = c.tags.map((t) => ancestorsOf.get(t.toLowerCase()) || '').filter((x) => x);
        }
        const goalWords = [...new Set(goal.toLowerCase().split(/[^\p{L}\p{N}+#-]+/u).filter((w) => w))];
        const candidates = [...pool].sort((a, b) => goalScore(goalWords, b) - goalScore(goalWords, a)).slice(0, 120);
        const byPid = new Map<string, AdvisorCandidate>();
        for (const c of candidates) byPid.set(c.pid.toLowerCase(), c);

        /*
         * 🌳 The catalog as a TREE, and each candidate's labels with their
         * topic ("Loops › For loop reading n values"): two tasks whose leaf
         * points differ but share a topic still interlock, and a goal
         * phrased at topic level ("loops") reaches every point beneath it.
         */
        const catalogBlock = await KnowledgeModel.promptCatalog(domainId, { title: 'CATALOG: the domain\'s knowledge points', budget: 7000 });
        const pathOf = new Map<string, string>();
        for (const c of candidates) {
            for (const t of c.tags) {
                if (pathOf.has(t.toLowerCase())) continue;
                const doc = await KnowledgeModel.getByName(domainId, t);
                pathOf.set(t.toLowerCase(), doc ? KnowledgeModel.describe(doc) : t);
            }
        }
        const candidateBlock = `=== CANDIDATE TASKS (${candidates.length}) — pid | title | difficulty 1-10 | accepted/submissions | knowledge points (topic › point) ===\n${candidates.map((c) => `${c.pid} | ${c.title} | ${c.difficulty || '?'} | ${c.nAccept}/${c.nSubmit} | ${c.tags.length ? c.tags.map((t) => pathOf.get(t.toLowerCase()) || t).join('; ') : '(unlabeled)'}`).join('\n')}\n=== END CANDIDATES ===`;

        // Conversation: the big context rides in the first user turn; the
        // client's prior turns follow verbatim; the new message closes.
        let turns: { role: 'user' | 'assistant', content: string }[] = [];
        try {
            const parsed = JSON.parse(history || '[]');
            if (Array.isArray(parsed)) {
                turns = parsed
                    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
                    .slice(-10)
                    .map((t) => ({ role: t.role, content: String(t.content).slice(0, 4000) }));
            }
        } catch (e) { turns = []; }
        const first = turns.length && turns[0].role === 'user' ? turns[0].content : goal;
        const rest = turns.length && turns[0].role === 'user' ? turns.slice(1) : turns;
        const messages: aiTutor.ChatMessage[] = [
            { role: 'user', content: `${ADVISOR_PROMPT}\n\n${catalogBlock}\n\n${candidateBlock}\n\nTEACHER'S GOAL: ${first}` },
            ...rest,
            ...(turns.length ? [{ role: 'user' as const, content: `TEACHER'S FOLLOW-UP: ${goal}\nRevise the suggestion accordingly and reply with the full JSON again.` }] : []),
        ];
        const raw = await aiTutor.callProvider(ADVISOR_SYSTEM, messages, { temperature: 0.3 });
        let j: any;
        try {
            j = parseJsonLoose(raw);
        } catch (e) {
            const retry = await aiTutor.callProvider(ADVISOR_SYSTEM, [
                ...messages,
                { role: 'assistant', content: raw.slice(0, 6000) },
                { role: 'user', content: 'Your previous reply was not valid JSON. Reply again with ONLY the JSON value, no prose, no markdown fences.' },
            ], { temperature: 0 });
            j = parseJsonLoose(retry);
        }

        // Validate against the candidates; unknown pids are dropped, never
        // invented. The learning order is the model's "step" (its array
        // order as fallback), re-numbered 1..n after validation.
        const LEVELS = ['basic', 'intermediate', 'advanced'];
        const seen = new Set<string>();
        const rawTasks = (Array.isArray(j?.tasks) ? j.tasks : []).map((t: any, i: number) => ({ t, i }));
        rawTasks.sort((a, b) => (Number(a.t?.step) || a.i + 1) - (Number(b.t?.step) || b.i + 1) || a.i - b.i);
        const tasks = rawTasks.map(({ t }) => {
            const c = byPid.get(String(t?.pid || '').trim().toLowerCase());
            if (!c || seen.has(c.pid)) return null;
            seen.add(c.pid);
            const tagLower = new Map(c.tags.map((x) => [x.toLowerCase(), x] as const));
            const pick = (list: any) => (Array.isArray(list) ? list : [])
                .map((x: any) => tagLower.get(String(x || '').toLowerCase())).filter((x: any) => x);
            const level = String(t.level || '').toLowerCase();
            return {
                docId: c.docId,
                pid: c.pid,
                title: c.title,
                difficulty: c.difficulty,
                nSubmit: c.nSubmit,
                nAccept: c.nAccept,
                hidden: c.hidden,
                points: c.tags,
                goalPoints: pick(t.points),
                newPoints: pick(t.newPoints),
                level: LEVELS.includes(level) ? level : '',
                buildsOn: String(t.buildsOn || '').trim(),
                reason: String(t.reason || '').slice(0, 600),
            };
        }).filter((x: any) => x).slice(0, 8);
        const suggestedPids = new Set(tasks.map((t: any) => t.pid.toLowerCase()));
        tasks.forEach((t: any, i: number) => {
            t.step = i + 1;
            // buildsOn must name an EARLIER suggested task; otherwise it is the previous step.
            const ref = tasks.find((o: any, k: number) => k < i && o.pid.toLowerCase() === t.buildsOn.toLowerCase());
            t.buildsOn = i === 0 ? '' : (ref ? ref.pid : tasks[i - 1].pid);
            // A level for every step, monotone along the path when the model left gaps.
            if (!t.level) t.level = i === 0 ? 'basic' : i === tasks.length - 1 && tasks.length > 2 ? 'advanced' : (tasks[i - 1].level || 'intermediate');
        });
        const path = String(j?.path || '').slice(0, 900);
        const overlap = (Array.isArray(j?.overlap) ? j.overlap : [])
            .map((o: any) => ({
                point: String(o?.point || '').slice(0, 60),
                pids: (Array.isArray(o?.pids) ? o.pids : []).map((p: any) => String(p)).filter((p: string) => suggestedPids.has(p.toLowerCase())),
            }))
            .filter((o: any) => o.point && o.pids.length >= 2)
            .slice(0, 20);
        const points = (Array.isArray(j?.points) ? j.points : []).map((x: any) => String(x || '').slice(0, 60)).filter((x: string) => x).slice(0, 12);
        const notes = String(j?.notes || '').slice(0, 1500);
        this.response.body = {
            points,
            path,
            tasks,
            overlap,
            notes,
            candidates: candidates.length,
            labeled: labeled.length,
            // What the client stores as the assistant turn for follow-ups.
            summary: JSON.stringify({
                points,
                path,
                tasks: tasks.map((t: any) => ({ step: t.step, pid: t.pid, level: t.level, buildsOn: t.buildsOn, newPoints: t.newPoints, points: t.goalPoints })),
                overlap,
                notes,
            }),
        };
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('pids', Types.Content)
    @param('beginAtDate', Types.Date)
    @param('beginAtTime', Types.Time)
    @param('endAtDate', Types.Date)
    @param('endAtTime', Types.Time)
    @param('extensionDays', Types.Float)
    @param('penaltyRules', Types.Content, validatePenaltyRules, convertPenaltyRules)
    @param('bonusEnabled', Types.Boolean)
    @param('langs', Types.CommaSeperatedArray, true)
    async postUpdate(
        { domainId }, title: string, content: string, _pids: string,
        beginAtDate: string, beginAtTime: string, endAtDate: string, endAtTime: string,
        extensionDays: number, penaltyRules: PenaltyRules, bonusEnabled = false, rawLangs: string[] = [],
    ) {
        const pids = _pids.replace(/，/g, ',').split(',').map((i) => +i).filter((i) => i);
        if (!pids.length) throw new ValidationError('pids');
        // Same parsing + ordering rules as HomeworkEditHandler.postUpdate:
        // teacher-timezone wall-clock in, UTC Dates stored.
        const beginAt = moment.tz(`${beginAtDate} ${beginAtTime}`, this.user.timeZone);
        if (!beginAt.isValid()) throw new ValidationError('beginAtDate', 'beginAtTime');
        const endAt = moment.tz(`${endAtDate} ${endAtTime}`, this.user.timeZone);
        if (!endAt.isValid()) throw new ValidationError('endAtDate', 'endAtTime');
        if (beginAt.isSameOrAfter(endAt)) throw new ValidationError('endAtDate', 'endAtTime');
        if (!(extensionDays >= 0)) throw new ValidationError('extensionDays');
        /*
         * 🎁 An UNCHECKED checkbox sends no field at all, so `false` here
         * means both "the teacher unticked it" and "an old client posted a
         * form without the field". Writing it explicitly on every save is
         * what keeps SelfLearningDoc.bonusEnabled's tri-state meaningful:
         * `undefined` then only ever means a session saved before the
         * tickbox existed, which reads as enabled.
         */
        /*
         * 🌐 Allowed submission languages. Unknown or disabled ids are
         * dropped rather than refused (the picker only offers valid ones;
         * a stale form may name a language since retired). Empty = no
         * restriction — stored as [] so a cleared picker really clears.
         */
        const langs = [...new Set(rawLangs.map((l) => l.trim()).filter((l) => l && setting.langs[l] && !setting.langs[l].disabled))].slice(0, 64);
        const schedule = {
            beginAt: beginAt.toDate(), endAt: endAt.toDate(), extensionDays, penaltyRules, bonusEnabled, langs,
        };
        const pdict = await problem.getList(
            domainId, pids, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id, true,
            problem.PROJECTION_CONTEST_LIST, true,
        );
        // Programming tasks only. The picker already hides quiz / subjective
        // tasks, but the rule is enforced HERE: a crafted form, an old
        // client, or a legacy session that still lists such tasks must all
        // be refused with the offending pids named.
        const rejected = pids
            .map((pid) => pdict[pid])
            .filter((pdoc) => pdoc && !isCodeSessionKind(sessionKindOf(pdoc)))
            .map((pdoc) => `${pdoc.pid || pdoc.docId} (${sessionKindOf(pdoc)})`);
        if (rejected.length) {
            throw new ValidationError('pids', null, `Only programming and function tasks can be added to a self-learning session. Remove: ${rejected.join(', ')}`);
        }
        /*
         * A task with its own language list that shares NOTHING with the
         * session's would be unsubmittable inside the session (the two are
         * intersected on every session surface). Refuse now, naming the
         * task and its languages, rather than let a student discover an
         * empty language menu.
         */
        if (langs.length) {
            const dead = pids
                .map((pid) => pdict[pid])
                .filter((pdoc) => pdoc && typeof pdoc.config === 'object' && Array.isArray((pdoc.config as any).langs) && (pdoc.config as any).langs.length
                    && !(pdoc.config as any).langs.some((l: string) => langs.includes(l)))
                .map((pdoc) => `${pdoc.pid || pdoc.docId} (${(pdoc.config as any).langs.map((l: string) => setting.langs[l]?.display || l).join(', ')})`);
            if (dead.length) {
                throw new ValidationError('langs', null, `These tasks accept none of the selected languages, so nobody could submit them in this session: ${dead.join('; ')}. Widen the language list or remove the task.`);
            }
        }
        if (this.sdoc) {
            const patch: any = { title, content, pids, ...schedule };
            /*
             * 📊 Deadline moved: results finality follows the schedule AS
             * IT IS NOW. If the new hard end (endAt + extension) is back in
             * the future while the stored results are marked final, demote
             * them to provisional — the automatic post-deadline sweep skips
             * 'results.final: true' sessions, so without this the NEW
             * deadline passing would never trigger the evaluation again.
             * (Dotted key: flip the flag in place, keep the stored table.)
             */
            const newHardEnd = new Date(schedule.endAt.getTime() + Math.max(0, Math.round((schedule.extensionDays || 0) * DAY_MS)));
            if (this.sdoc.results?.final && newHardEnd > new Date()) {
                patch['results.final'] = false;
            }
            await SelfLearningModel.edit(domainId, this.sdoc.docId, patch);
            this.response.redirect = this.url('self_learning_detail', { ssid: this.sdoc.docId });
        } else {
            const ssid = await SelfLearningModel.add(domainId, this.user._id, title, content, pids, schedule);
            this.response.redirect = this.url('self_learning_detail', { ssid });
        }
    }

    async postDelete({ domainId }) {
        if (!this.sdoc) throw new NotFoundError();
        await SelfLearningModel.del(domainId, this.sdoc.docId);
        this.response.redirect = this.url('self_learning');
    }
}

/* ------------------------------------------------------------------ */
/*  Session results: every student's summed score (auto after deadline) */
/* ------------------------------------------------------------------ */
/*
 * THE evaluation funnel — every way of "evaluating the students" runs the
 * SAME function, runSessionEvaluation (below), which claims the shared
 * evalJob, calls computeSessionResults exactly once, stores the results,
 * and records the job outcome the teacher page polls:
 *   1. the teacher's "Evaluate all students now" button (postRecompute);
 *   2. the automatic post-deadline sweep (finalizeDueSessions, on a timer);
 *   3. the on-view finalization when a teacher opens an ended session
 *      (including the stale-schema re-derivation).
 * computeSessionResults itself is called from NOWHERE else, so the three
 * triggers cannot diverge in scoring, finality, storage, or presentation.
 * The scoring is delegated to scoreRecords / sessionTaskMeanTotal (the
 * shared rubric near the top of this file), which the student's own score
 * card also uses — so changing the rubric there and pressing the button is
 * a faithful preview of what the automatic evaluation will store. Bonus
 * tasks are reported beside the total, never summed into it.
 */
export async function computeSessionResults(domainId: string, sdoc: SelfLearningDoc, final: boolean): Promise<SessionResults> {
    const pids = sdoc.pids || [];
    // Classify the tasks ONCE for this evaluation: the 20-point total maps
    // the PROGRAMMING component (programmingPidsOf — the same rule the
    // student's own card applies to its pdict).
    const pdict = await problem.getList(domainId, pids, true, false, problem.PROJECTION_CONTEST_LIST, true);
    const progPids = programmingPidsOf(sdoc, pdict);
    // 🎓 Ownership walkthrough states for the whole session, loaded once and
    // grouped per student — the same getOwnershipIn the student card uses.
    const ownershipDocs = await getOwnershipIn(domainId, sdoc.docId);
    const rows = await record.getMulti(domainId, {
        pid: { $in: pids }, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
    }).project({
        uid: 1, pid: 1, score: 1, status: 1,
    }).limit(200000).toArray();
    // ⏹ The evaluation sees the session's own records only; practice made
    // after the hard end is invisible to every component of the score.
    const cap = sessionCutoff(sdoc);
    // Group the raw records per student; scoreRecords — THE shared rubric,
    // also behind the student's own card — turns each group into per-task
    // bests, so this table can never disagree with what a student sees.
    const rowsOf = new Map<number, { pid: number, score: number, at: Date, accepted: boolean }[]>();
    for (const r of rows as any[]) {
        if (!recordCounts(r._id, cap)) continue;
        if (!rowsOf.has(r.uid)) rowsOf.set(r.uid, []);
        rowsOf.get(r.uid)!.push({
            pid: r.pid, score: r.score || 0, at: r._id.getTimestamp(), accepted: r.status === STATUS.STATUS_ACCEPTED,
        });
    }
    const progress = await collProgress.find({ domainId, ssid: sdoc.docId }).toArray();
    const progressOf = new Map(progress.map((p) => [p.uid, p]));
    const uids = [...new Set([...rowsOf.keys(), ...progressOf.keys()])].filter((uid) => uid !== sdoc.owner);
    const udict = uids.length ? await user.getList(domainId, uids) : {};
    // Course staff who tried the tasks are not students of the session —
    // hoisted BEFORE the trajectory pipeline so the class percentiles are
    // computed over exactly the students the board will show.
    const studentUids: number[] = [];
    for (const uid of uids) {
        const udoc: any = udict[uid];
        try {
            if (udoc && typeof udoc.hasPerm === 'function' && (udoc.hasPerm(PERM.PERM_EDIT_HOMEWORK) || udoc.hasPerm(PERM.PERM_CREATE_HOMEWORK))) continue;
        } catch (e) { /* keep the row */ }
        studentUids.push(uid);
    }
    /*
     * 📈 INDEPENDENCE TRAJECTORY — class-relative by definition, so it
     * lives here rather than in per-student componentsOf: (1) every
     * student's assistance index per engaged task (answered exchanges at
     * FIRST engagement, before the correct fix or before parking); (2) a
     * class percentile per task; (3) max(level, improvement) per student.
     * Pure record+thread arithmetic — no LLM.
     */
    /*
     * ⭐ THE RUBRIC (Blocks A & B): every task is worth 100 = 🏆30 +
     * 🎓20 + 🔧15 + 🧩30 + 💡5; its score is the SUM of the earned
     * sub-rubric points (🏆 = judged × 30%, 🎓 = mean walkthrough level
     * × 5; the 🔧/🧩/💡 placeholders earn nothing yet). 🅰 Block A =
     * (Σ task scores) / (N × 100) × 75; 🅱 Block B (cross-task, 25) is
     * not implemented yet and counts 0; the total (0..100) is 🅰 + 🅱.
     */
    // 🎓/🔧 The stored tutoring evidence, uid → pid → per-task inputs.
    interface Evidence {
        own?: { level: number | null, asked: number, graded: number, flagged?: boolean };
        fix?: { level: number | null, judged: number, flagged?: boolean };
        rea?: { level: number | null, judged: number, flagged?: boolean };
        ini?: { level: number | null, flagged?: boolean };
    }
    const evByUidPid = new Map<number, Map<number, Evidence>>();
    const evOf = (uid: number, pid: number): Evidence => {
        let m = evByUidPid.get(uid);
        if (!m) {
            m = new Map();
            evByUidPid.set(uid, m);
        }
        let e = m.get(pid);
        if (!e) {
            e = {};
            m.set(pid, e);
        }
        return e;
    };
    for (const t of await getOwnershipIn(domainId, sdoc.docId)) {
        const e = evOf(t.uid, t.pid);
        if (t.ownership) {
            e.own = {
                level: taskMeanOf(t.ownership),
                asked: t.ownership.questions?.length || 0,
                graded: (t.ownership.questions || []).reduce((a, q) => a + (q.levels?.length || 0), 0),
            };
        }
        if (t.fixconv?.transitions?.length) {
            e.fix = { level: taskFixConvMeanOf(t.fixconv), judged: t.fixconv.transitions.length };
        }
        if (t.reasoning?.levels?.length) {
            e.rea = { level: reasoningTaskMeanOf(t.reasoning), judged: t.reasoning.levels.length };
        }
        if (typeof t.initiative?.level === 'number') {
            e.ini = { level: t.initiative.level };
        }
        // 🚫 Manipulation flags override any clean evidence on the same
        // slot: the corresponding sub-rubric scores 0 for this task.
        const ig = t.integrity;
        if (ig?.own) e.own = { level: 0, asked: e.own?.asked || 0, graded: e.own?.graded || 0, flagged: true };
        if (ig?.fix) e.fix = { level: 0, judged: e.fix?.judged || 0, flagged: true };
        if (ig?.rea) e.rea = { level: 0, judged: e.rea?.judged || 0, flagged: true };
        if (ig?.ini) e.ini = { level: 0, flagged: true };
    }
    const result: SessionResultRow[] = [];
    for (const uid of studentUids) {
        const udoc: any = udict[uid];
        const m = scoreRecords(sdoc, rowsOf.get(uid) || []);
        // ⭐ First-attempt truth from the same chronological record history
        // the walkthrough budget classifies on.
        const faSet = firstAttemptAcceptedPids(rowsOf.get(uid) || []);
        const scores: SessionResultRow['scores'] = {};
        let attempts = 0;
        for (const pid of pids) {
            const v = m.get(pid);
            if (v) {
                scores[String(pid)] = v;
                attempts += v.attempts;
            }
        }
        // One rubric breakdown per programming task (unattempted → 0, still
        // in Block A's denominator) — through THE shared taskRubricOf,
        // fed the 🎓 walkthrough evidence.
        const evOfUid = evByUidPid.get(uid);
        const breakdowns = progPids.map((pid) => {
            const e = evOfUid?.get(pid);
            return taskRubricOf(
                pid, m.get(pid) || null, e?.own || null, e?.fix || null, e?.rea || null, e?.ini || null, faSet.has(pid),
            );
        });
        const taskScores: Record<string, number> = {};
        const own: NonNullable<SessionResultRow['own']> = {};
        const fix: NonNullable<SessionResultRow['fix']> = {};
        const rea: NonNullable<SessionResultRow['rea']> = {};
        const ini: NonNullable<SessionResultRow['ini']> = {};
        const fa: NonNullable<SessionResultRow['fa']> = {};
        for (const b of breakdowns) {
            taskScores[String(b.pid)] = b.score;
            const e = evOfUid?.get(b.pid);
            // pts = the EXACT numbers Σ was built from (round1 of the
            // unrounded means × the share/4) — the 🎓/🔧 cells show these,
            // so the Σ column always equals the visible parts sum even in
            // thirds cases where re-deriving from the 2-decimal level
            // would drift 0.1.
            own[String(b.pid)] = {
                level: b.ownLevel, pts: b.ownPts, asked: e?.own?.asked || 0, graded: e?.own?.graded || 0,
                ...(e?.own?.flagged ? { flagged: true } : {}),
            };
            fix[String(b.pid)] = {
                level: b.fixLevel, pts: b.fixPts, judged: e?.fix?.judged || 0,
                ...(e?.fix?.flagged ? { flagged: true } : {}),
            };
            rea[String(b.pid)] = {
                level: b.reaLevel, pts: b.reaPts, judged: e?.rea?.judged || 0,
                ...(e?.rea?.flagged ? { flagged: true } : {}),
            };
            ini[String(b.pid)] = { level: b.iniLevel, pts: b.iniPts, ...(e?.ini?.flagged ? { flagged: true } : {}) };
            if (b.firstAttempt) fa[String(b.pid)] = true;
        }
        // ⭐⭐ Every task accepted first-try → the whole session rescores
        // as 🏆 40 + 🎓 60; the blocks (and 📈/🧠) do not apply.
        const allFa = allFirstAttemptSessionOf(breakdowns);
        const blockA = blockAOf(breakdowns);
        // 📈 The student's whole-session trajectory judgment, stored on
        // their progress doc by backfillTrajectoryGrades.
        const trjLevelRaw = progressOf.get(uid)?.trajectory?.level;
        const trjLevel = typeof trjLevelRaw === 'number'
            ? Math.min(TRAJECTORY_LEVEL_MAX, Math.max(0, trjLevelRaw)) : null;
        const trjPts = trajectoryPtsOf(trjLevel);
        // 🧠 Assessments + the backfill's plan → assessed / pending /
        // untestable (the edge case's full 15), zero extra queries.
        const trf = transferSubScoreOf(
            progressOf.get(uid)?.transfer?.assessments,
            progressOf.get(uid)?.transfer?.plan,
        );
        const blockB = blockBOf({ level: trjLevel }, trf);
        // ⏱ The tiered late rule lands HERE — on the total (the collapsed
        // ⭐⭐ total included), keyed to the last counted submission.
        const lp = latePenaltyOf(sdoc, rowsOf.get(uid) || []);
        const totalBase = allFa ? allFa.total : round1(blockA + blockB);
        const total = lp ? round1(totalBase * lp.factor) : totalBase;
        const pg = progressOf.get(uid);
        const bonus = (pg?.bonuses || [])[0];
        let bonusState = 'none';
        if (bonus) {
            bonusState = bonus.status;
            if (bonus.status === 'ready' && bonus.docId) {
                const acc = await record.getMulti(domainId, { uid, pid: bonus.docId, status: STATUS.STATUS_ACCEPTED }).project({ _id: 1 }).limit(1).toArray();
                if (acc.length) bonusState = 'accepted';
            }
        }
        result.push(applySessionOverride({
            uid,
            uname: udoc?.uname || String(uid),
            name: `${udoc?.firstName || ''} ${udoc?.lastName || ''}`.trim(),
            scores,
            taskScores,
            own,
            fix,
            rea,
            ini,
            fa,
            trj: {
                level: trjLevel,
                pts: trjPts,
                ...(progressOf.get(uid)?.trajectory?.flagged ? { flagged: true } : {}),
            },
            trf,
            blockA,
            blockB,
            ...(allFa ? { allFa: true, sessAch: allFa.ach, sessOwn: allFa.own } : {}),
            ...(lp ? { lateFactor: lp.factor, lateHours: lp.hours } : {}),
            total,
            attempts,
            done: (pg?.done || []).filter((x) => pids.includes(x)).length,
            skipped: (pg?.skipped || []).filter((x) => pids.includes(x)).length,
            bonus: bonusState,
        }, pg?.override));
    }
    result.sort((a, b) => b.total - a.total || a.uname.localeCompare(b.uname));
    const results: SessionResults = {
        computedAt: new Date(),
        final,
        rubric: SESSION_RUBRIC_VERSION,
        maxTotal: SESSION_TOTAL_MAX,
        blockAMax: BLOCK_A_MAX,
        blockBMax: BLOCK_B_MAX,
        taskMax: TASK_RUBRIC_MAX,
        achievementShare: ACHIEVEMENT_SHARE,
        ownershipShare: OWNERSHIP_SHARE,
        fixconvShare: FIXCONV_SHARE,
        reasoningShare: REASONING_SHARE,
        initiativeShare: INITIATIVE_SHARE,
        faAchShare: FIRST_ATTEMPT_ACH_MAX,
        faOwnShare: FIRST_ATTEMPT_OWN_MAX,
        blockAEarnable: BLOCK_A_EARNABLE,
        trajectoryShare: TRAJECTORY_SHARE,
        transferShare: TRANSFER_SHARE,
        blockBEarnable: BLOCK_B_EARNABLE,
        rows: result,
    };
    await SelfLearningModel.edit(domainId, sdoc.docId, { results });
    return results;
}

/**
 * ⚛️ Atomically claim the session's evaluation job (evalJob = running).
 * Exactly ONE caller wins at any moment — the teacher's button, the
 * post-deadline sweep and the on-view finalization all pass through this
 * claim, so two evaluations of the same session can never run
 * concurrently, whichever combination of triggers fires. A 'running' job
 * older than EVAL_JOB_STALE_MS (crashed worker) may be taken over.
 */
async function claimEvalJob(domainId: string, ssid: ObjectId, startedAt: Date, force = false): Promise<boolean> {
    const staleBefore = new Date(startedAt.getTime() - EVAL_JOB_STALE_MS);
    const res = await document.coll.findOneAndUpdate(
        {
            domainId,
            docType: TYPE_SELF_LEARNING,
            docId: ssid,
            $or: [
                { evalJob: { $exists: false } },
                { 'evalJob.state': { $ne: 'running' } },
                { 'evalJob.startedAt': { $lt: staleBefore } },
            ],
        } as any,
        // force rides the job doc so the status poll (and a re-attached
        // page) can label the run as a from-scratch re-evaluation.
        { $set: { evalJob: { state: 'running', startedAt, ...(force ? { force: true } : {}) }, updateAt: new Date() } } as any,
    );
    return !!res;
}

/**
 * ⭐ The evaluation BODY — the code every trigger executes once the job
 * is claimed, and the ONLY caller of computeSessionResults. It evaluates
 * and stores every student's score, marks the results FINAL exactly when
 * the session's deadline (endAt + extension) has passed at run time
 * (sessionSchedule phase 'ended' — the identical rule for the button, the
 * sweep and the on-view path), and records the job outcome that the
 * teacher page's progress card polls (postEvalStatus). On failure the
 * evalJob is marked failed (the card reports it) and the error rethrown
 * for the caller's logging.
 */
async function runClaimedEvaluation(domainId: string, ssid: ObjectId, startedAt: Date, forceReset = false): Promise<SessionResults> {
    try {
        const sdoc = await SelfLearningModel.get(domainId, ssid);
        if (!sdoc) throw new Error('session no longer exists');
        /*
         * ♻️ FORCE: the teacher's button re-evaluates EVERYTHING from
         * scratch. All six graders are cache-driven idempotent, so one
         * central reset of the stored judgments (levels, transitions,
         * reasoning, initiative, surfacing, transfer, trajectory and the
         * 🚫 flags — the walkthrough QUESTIONS and every dialogue message
         * survive untouched) makes the normal phases below naturally
         * re-judge every item. The 🚫 detector is deterministic, so
         * cleared flags re-derive from the same content. A crash mid-run
         * leaves a partially regraded state that the next (normal)
         * evaluation simply completes.
         */
        if (forceReset) {
            const rc = await SelfLearningModel.resetEvaluationState(domainId, ssid);
            logger.info('[self-learning] ♻️ force re-evaluation %s/%s: reset %d thread(s), %d progress doc(s)',
                domainId, ssid, rc.threads, rc.progresses);
        }
        /*
         * 🎓 GRADE FIRST, aggregate second: every recorded-but-ungraded
         * walkthrough answer is judged here (backfillOwnershipGrades —
         * idempotent, resumable, skipped entirely when the AI tutor is
         * disabled), with live progress written to evalJob.progress so the
         * teacher's card can show "🎓 Now grading 3/7 · name · P5" — for
         * EVERY trigger, button and automatic alike, because this function
         * is the single evaluation body they all share. Answers graded
         * live at answer time are already stored and are skipped; the 🔧
         * guidance-to-fix, 🧩 reasoning, 💡 initiative, 📈 trajectory and
         * 🧠 concept-transfer graders run right after on the same footing
         * — six phases, all idempotent.
         */
        let own = { graded: 0, failed: 0, total: 0 };
        let fix = { graded: 0, failed: 0, total: 0 };
        let rea = { graded: 0, failed: 0, total: 0 };
        let ini = { graded: 0, failed: 0, total: 0 };
        let trj = { graded: 0, failed: 0, total: 0 };
        let trf = { graded: 0, failed: 0, total: 0 };
        let lastWrite = 0;
        let lastUid = 0;
        const writeProgress = (phase: 'own' | 'fix' | 'rea' | 'ini' | 'trj' | 'trf') => async (p: OwnershipBackfillProgress) => {
            const t = Date.now();
            const force = p.uid !== lastUid || p.done === 1 || p.done === p.total;
            if (!force && t - lastWrite < 400) return;
            lastWrite = t;
            lastUid = p.uid;
            await SelfLearningModel.edit(domainId, ssid, { 'evalJob.progress': { ...p, phase } } as any).catch(() => { /* best-effort */ });
        };
        try {
            own = await backfillOwnershipGrades(domainId, sdoc, writeProgress('own'));
            if (own.graded || own.failed) {
                logger.info('[self-learning] 🎓 ownership backfill %s/%s: %d graded, %d failed of %d',
                    domainId, ssid, own.graded, own.failed, own.total);
            }
        } catch (e) {
            logger.warn('[self-learning] 🎓 ownership backfill %s/%s failed: %s', domainId, ssid, e.message);
        }
        // 🔧 Guidance-to-Fix: judge every not-yet-graded qualifying
        // transition (idempotent; trial numbers reconciled to the
        // current sequential rule as a side effect).
        try {
            fix = await backfillFixConversionGrades(domainId, sdoc, writeProgress('fix'));
            if (fix.graded || fix.failed) {
                logger.info('[self-learning] 🔧 fix-conversion backfill %s/%s: %d graded, %d failed of %d',
                    domainId, ssid, fix.graded, fix.failed, fix.total);
            }
        } catch (e) {
            logger.warn('[self-learning] 🔧 fix-conversion backfill %s/%s failed: %s', domainId, ssid, e.message);
        }
        // 🧩 Reasoning Quality: grade every recorded failure-phase answer
        // that has no level yet (idempotent via rlevel + answer dedup).
        try {
            rea = await backfillReasoningGrades(domainId, sdoc, writeProgress('rea'));
            if (rea.graded || rea.failed) {
                logger.info('[self-learning] 🧩 reasoning backfill %s/%s: %d graded, %d failed of %d',
                    domainId, ssid, rea.graded, rea.failed, rea.total);
            }
        } catch (e) {
            logger.warn('[self-learning] 🧩 reasoning backfill %s/%s failed: %s', domainId, ssid, e.message);
        }
        // 💡 Self-Diagnostic Initiative: one grade per task, judged over
        // the CLOSED first-engagement dialogue (idempotent — a graded
        // thread is skipped forever).
        try {
            ini = await backfillInitiativeGrades(domainId, sdoc, writeProgress('ini'));
            if (ini.graded || ini.failed) {
                logger.info('[self-learning] 💡 initiative backfill %s/%s: %d graded, %d failed of %d',
                    domainId, ssid, ini.graded, ini.failed, ini.total);
            }
        } catch (e) {
            logger.warn('[self-learning] 💡 initiative backfill %s/%s failed: %s', domainId, ssid, e.message);
        }
        // 📈 Independence Trajectory: one whole-session judgment per
        // student, re-run only when their history's basis changed.
        try {
            trj = await backfillTrajectoryGrades(domainId, sdoc, writeProgress('trj'));
            if (trj.graded || trj.failed) {
                logger.info('[self-learning] 📈 trajectory backfill %s/%s: %d graded, %d failed of %d',
                    domainId, ssid, trj.graded, trj.failed, trj.total);
            }
        } catch (e) {
            logger.warn('[self-learning] 📈 trajectory backfill %s/%s failed: %s', domainId, ssid, e.message);
        }
        // 🧠 Concept Transfer: surface → plan (stored per student) →
        // judge each first re-encounter; concept-keyed, idempotent.
        try {
            trf = await backfillConceptTransferGrades(domainId, sdoc, writeProgress('trf'));
            if (trf.graded || trf.failed) {
                logger.info('[self-learning] 🧠 transfer backfill %s/%s: %d graded, %d failed of %d',
                    domainId, ssid, trf.graded, trf.failed, trf.total);
            }
        } catch (e) {
            logger.warn('[self-learning] 🧠 transfer backfill %s/%s failed: %s', domainId, ssid, e.message);
        }
        const final = sessionSchedule(sdoc).phase === 'ended';
        const results = await computeSessionResults(domainId, sdoc, final);
        // The done write keeps the summary counts so the finished card
        // (which stays on screen) can report them — combined, plus the
        // per-grader split for the card's detail line.
        await SelfLearningModel.edit(domainId, ssid, {
            evalJob: {
                state: 'done',
                startedAt,
                finishedAt: new Date(),
                progress: {
                    done: own.total + fix.total + rea.total + ini.total + trj.total + trf.total,
                    total: own.total + fix.total + rea.total + ini.total + trj.total + trf.total,
                    graded: own.graded + fix.graded + rea.graded + ini.graded + trj.graded + trf.graded,
                    failed: own.failed + fix.failed + rea.failed + ini.failed + trj.failed + trf.failed,
                    own: { graded: own.graded, total: own.total },
                    fix: { graded: fix.graded, total: fix.total },
                    rea: { graded: rea.graded, total: rea.total },
                    ini: { graded: ini.graded, total: ini.total },
                    trj: { graded: trj.graded, total: trj.total },
                    trf: { graded: trf.graded, total: trf.total },
                },
            },
        });
        return results;
    } catch (e) {
        await SelfLearningModel.edit(domainId, ssid, {
            evalJob: {
                state: 'failed', startedAt, finishedAt: new Date(), error: String(e.message || e).slice(0, 200),
            },
        }).catch(() => { /* best-effort */ });
        throw e;
    }
}

export interface SessionEvaluationOutcome {
    /** True when THIS call performed the evaluation (it claimed the job and ran). */
    ran: boolean;
    /** True when another evaluation already held the job — nothing was started. */
    alreadyRunning: boolean;
    /** The freshly stored results when ran; otherwise whatever is currently stored. */
    results: SessionResults | null;
}

/**
 * ⭐ THE single evaluation entry point: claim the job, run the shared
 * evaluation body, report the outcome. The post-deadline sweep and the
 * on-view finalization await this directly; the teacher's button claims
 * and then detaches the same body (postRecompute) so the HTTP response
 * returns immediately — either way the code that evaluates and presents
 * the scores is one and the same.
 */
export async function runSessionEvaluation(domainId: string, ssid: ObjectId, force = false): Promise<SessionEvaluationOutcome> {
    const startedAt = new Date();
    const claimed = await claimEvalJob(domainId, ssid, startedAt, force);
    if (!claimed) {
        const current = await SelfLearningModel.get(domainId, ssid);
        if (!current) throw new NotFoundError(domainId, ssid);
        return { ran: false, alreadyRunning: true, results: current.results || null };
    }
    const results = await runClaimedEvaluation(domainId, ssid, startedAt, force);
    return { ran: true, alreadyRunning: false, results };
}

/**
 * Sessions whose hard end has passed and whose results are not final yet:
 * evaluate them through THE shared runSessionEvaluation — the exact
 * function behind the teacher's "Evaluate all students now" button — so
 * the deadline passing and the button produce identical results. Runs on
 * a timer in apply() (first worker only) and when a teacher opens a
 * closed session, so results exist whichever comes first.
 */
export async function finalizeDueSessions(): Promise<number> {
    const now = new Date();
    const due = await document.coll.find({
        docType: TYPE_SELF_LEARNING, endAt: { $exists: true, $ne: null }, 'results.final': { $ne: true },
    } as any).project({ domainId: 1, docId: 1, endAt: 1, extensionDays: 1 }).limit(500).toArray();
    let n = 0;
    for (const d of due as any[]) {
        const hardEnd = new Date(new Date(d.endAt).getTime() + (d.extensionDays || 0) * DAY_MS);
        if (hardEnd > now) continue;
        try {
            // eslint-disable-next-line no-await-in-loop
            const outcome = await runSessionEvaluation(d.domainId, d.docId);
            if (outcome.ran) n++;
            // alreadyRunning: a concurrent evaluation (e.g. the teacher's
            // button) holds the job; running now, it stores 'ended'-phase
            // FINAL results itself. If it computed just before the
            // deadline (provisional), results.final stays false and the
            // next sweep tick finalizes.
        } catch (e) {
            logger.warn('[self-learning] results for %s/%s failed: %s', d.domainId, d.docId, e.message);
        }
    }
    return n;
}

class SelfLearningDetailHandler extends Handler {
    /**
     * Teacher: (re)compute the results now — final if the session is closed,
     * provisional otherwise. This runs THE shared evaluation — the atomic
     * claim plus runClaimedEvaluation, the identical code path behind the
     * automatic post-deadline sweep and the on-view finalization — so
     * pressing the button IS the automatic evaluation, just on demand.
     */
    @param('ssid', Types.ObjectId)
    @param('force', Types.Boolean, true)
    async postRecompute({ domainId }, ssid: ObjectId, forceArg = false) {
        const sdoc = await loadSession(domainId, ssid);
        if (!this.user.own(sdoc) && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)) throw new PermissionError();
        /*
         * The claim happens BEFORE responding so the very first status poll
         * (and any reloaded page) already sees the running job. The
         * evaluation itself runs DETACHED from this request — refreshing
         * the page, closing the tab or re-logging in never cancels it.
         * Progress lives on sdoc.evalJob (postEvalStatus); a stale
         * 'running' job (server crash mid-compute) unblocks itself after
         * EVAL_JOB_STALE_MS. If the automatic sweep (or another staff
         * member) already holds the job, alreadyRunning is reported and
         * the page's poll simply re-attaches to that run — the button and
         * the automatic evaluation share one job, one body, one card.
         */
        const startedAt = new Date();
        const claimed = await claimEvalJob(domainId, ssid, startedAt, !!forceArg);
        if (claimed) {
            (async () => {
                try {
                    await runClaimedEvaluation(domainId, ssid, startedAt, !!forceArg);
                } catch (e) {
                    // runClaimedEvaluation already recorded the failed job.
                    logger.warn('[self-learning] manual evaluation for %s/%s failed: %s', domainId, ssid, e.message);
                }
            })();
        }
        // XHR callers poll postEvalStatus; the no-JS form fallback just
        // returns to the page (the job keeps running in the background).
        this.response.body = { started: claimed, alreadyRunning: !claimed };
        this.response.redirect = this.url('self_learning_detail', { ssid });
    }

    /**
     * Teacher: one student's per-task, per-answer ownership breakdown —
     * feeds the pop-up shown when hovering the Ownership cell on the score
     * board. Uses the SAME per-task rule as the evaluation (taskMeanOf /
     * ownershipOf), so the pop-up can never disagree with the column.
     */
    @param('ssid', Types.ObjectId)
    @param('uid', Types.Int)
    async postOwnershipDetail({ domainId }, ssid: ObjectId, uid: number) {
        const sdoc = await loadSession(domainId, ssid);
        if (!this.user.own(sdoc) && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)) throw new PermissionError();
        const pdict = await problem.getList(domainId, sdoc.pids || [], true, false, problem.PROJECTION_CONTEST_LIST, true);
        const progPids = programmingPidsOf(sdoc, pdict);
        const byPid = new Map<number, { questions: { question: string, levels: number[] }[] }>();
        const fixByPid = new Map<number, { transitions: { level: number, trial: number, toRid?: any }[] }>();
        const reasonByPid = new Map<number, { levels: number[] }>();
        const initByPid = new Map<number, number>();
        // 🐛 Hoisted above its first use in the loop below (was a TDZ
        // crash the moment any thread carried surfacedKp).
        const surfacedByPid = new Map<number, string[]>();
        for (const t of await getOwnershipIn(domainId, sdoc.docId, uid)) {
            if (t.ownership) byPid.set(t.pid, t.ownership as any);
            if (t.fixconv) fixByPid.set(t.pid, t.fixconv as any);
            if ((t as any).surfacedKp?.names?.length) surfacedByPid.set(t.pid, (t as any).surfacedKp.names);
            if ((t as any).reasoning?.levels?.length) reasonByPid.set(t.pid, (t as any).reasoning);
            if (typeof (t as any).initiative?.level === 'number') initByPid.set(t.pid, (t as any).initiative.level);
        }
        // First-attempt acceptances count as level 4 (same rule as fixConvOf).
        const recRows = await record.getMulti(domainId, {
            uid, pid: { $in: [...progPids] }, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
        }).project({ pid: 1, status: 1, score: 1 }).limit(5000).toArray();
        const recMapped = (recRows as any[]).map((r) => ({
            pid: r.pid, at: r._id.getTimestamp(), accepted: r.status === STATUS.STATUS_ACCEPTED, score: r.score || 0,
        }));
        const firstAc = firstAttemptAcceptedPids(recMapped);
        const epBest = scoreRecords(sdoc, recMapped);
        // ⭐ Hoisted: the per-task rubric composites below need the stored
        // trajectory and this student's transfer assessments.
        const row: any = (sdoc.results?.rows || []).find((r) => r.uid === uid) || null;
        const progDoc = await SelfLearningModel.getProgress(domainId, sdoc.docId, uid);
        const epTransfer = conceptTransferOf(progDoc?.transfer?.assessments || null);
        const epTrajectory = row && typeof row.trajectory === 'number' ? row.trajectory : null;
        const epTState = (row as any)?.transferState
            || ((progDoc?.transfer?.assessments?.length) ? 'assessed' : 'pending');
        /*
         * 🧠 Transfer DIAGNOSTICS: rebuild the planning state so a "—"
         * explains itself — surfaced concepts per task, baselines whose
         * grading is still pending, and baselines with no re-encounter.
         */
        const tagDocs = await problem.getMulti(domainId, { docId: { $in: progPids } }).project({ docId: 1, tag: 1 }).toArray();
        const tagsByPid = new Map<number, string[]>((tagDocs as any[]).map((d) => [d.docId, (d.tag || []).map((t: any) => String(t))]));
        const tasks = [];
        for (const pid of progPids) {
            const state = byPid.get(pid) || null;
            const mean = taskMeanOf(state);
            const fc = fixByPid.get(pid);
            const isFirstAc = firstAc.has(pid);
            const fcMean = taskFixConvMeanOf(fc);
            // ⭐ Every programming task appears, each with its rubric
            // composite (unattempted -> 0, still in the session mean).
            const rubric = taskScoreOf({
                pid,
                best: epBest.get(pid) || null,
                firstAttempt: isFirstAc,
                ownershipMean: mean,
                fixConvMean: fc ? taskFixConvMeanOf(fc) : null,
                reasoningMean: reasoningTaskMeanOf(reasonByPid.get(pid)),
                initiativeLevel: initByPid.has(pid) ? initByPid.get(pid)! : null,
                sessionTrajectory: epTrajectory,
                sessionTransfer: epTState === 'assessed' ? epTransfer : null,
                transferUntestable: epTState === 'untestable',
            });
            tasks.push({
                rubric,
                pid: (pdict[pid] as any)?.pid || String(pid),
                title: (pdict[pid] as any)?.title || '',
                mean: mean === null ? null : Math.round(mean * 100) / 100,
                questions: ((state && state.questions) || []).map((q) => ({
                    question: String(q.question || '').slice(0, 160),
                    levels: (q.levels || []).map((l) => Math.min(OWNERSHIP_LEVEL_MAX, Math.max(0, +l || 0))),
                })),
                initiative: initByPid.has(pid) ? { level: Math.min(INITIATIVE_LEVEL_MAX, Math.max(0, initByPid.get(pid)!)) } : null,
                reasoning: reasonByPid.has(pid) ? {
                    levels: (reasonByPid.get(pid)!.levels || []).map((l) => Math.min(REASONING_LEVEL_MAX, Math.max(0, +l || 0))),
                } : null,
                fix: fc ? {
                    mean: fcMean === null ? null : Math.round(fcMean * 100) / 100,
                    transitions: (fc?.transitions || []).map((t) => ({
                        trial: t.trial, level: Math.min(FIXCONV_LEVEL_MAX, Math.max(0, +t.level || 0)), penalty: fixConvPenalty(t.trial || 1),
                    })),
                } : null,
            });
        }
        const wins = assistanceWindows(recMapped, progPids);
        const engagements = [...wins.entries()].map(([pid, win]) => ({ pid, start: win.start }));
        const resolvedSet = new Set(recMapped.filter((r) => r.accepted).map((r) => r.pid));
        const baselines = extractTransferBaselines(engagements, surfacedByPid, resolvedSet);
        const cands = extractTransferCandidates(engagements, tagsByPid, surfacedByPid, resolvedSet);
        const candConcepts = new Set(cands.map((c) => c.concept));
        const assessedConcepts = new Set((progDoc?.transfer?.assessments || []).map((a) => a.concept));
        const pidLabel = (pid: number) => (pdict[pid] as any)?.pid || String(pid);
        this.response.body = {
            tasks,
            total: sessionTaskMeanTotal(tasks.map((t: any) => t.rubric)),
            totalMax: TASK_SCORE_MAX,
            faTasks: tasks.filter((t: any) => t.rubric.firstAttempt).length,
            stdTasks: tasks.filter((t: any) => t.rubric.attempted && !t.rubric.firstAttempt).length,
            ownership: ownershipOf(byPid, progPids),
            ownershipMax: SESSION_OWNERSHIP_MAX,
            fixConv: fixConvOf(fixByPid, progPids),
            fixConvMax: SESSION_FIXCONV_MAX,
            trajectory: row && typeof row.trajectory === 'number' ? row.trajectory : null,
            trajectoryMax: SESSION_TRAJECTORY_MAX,
            reasoning: reasoningOf([...reasonByPid.values()]),
            reasoningMax: SESSION_REASONING_MAX,
            initiative: initiativeOf([...initByPid.values()]),
            initiativeMax: SESSION_INITIATIVE_MAX,
            transfer: epTransfer,
            transferState: epTState,
            transferMax: SESSION_TRANSFER_MAX,
            transferInfo: (progDoc?.transfer?.assessments || []).map((a) => ({
                concept: a.concept,
                fromPid: pidLabel(a.fromPid),
                toPid: pidLabel(a.toPid),
                level: Math.min(TRANSFER_LEVEL_MAX, Math.max(0, +a.level || 0)),
            })),
            // 🧠 Why a "—": planned but not yet graded / no re-encounter.
            transferPending: cands.filter((c) => !assessedConcepts.has(c.concept)).map((c) => ({
                concept: c.concept, fromPid: pidLabel(c.fromPid), toPid: pidLabel(c.toPid),
            })),
            transferUntested: baselines.filter((b) => !candConcepts.has(b.concept)).map((b) => ({
                concept: b.concept, fromPid: pidLabel(b.fromPid),
            })),
            transferSurfaced: [...surfacedByPid.entries()].map(([pid, names]) => ({ pid: pidLabel(pid), names })),
            trajectoryInfo: row?.trajectoryInfo ? {
                level: row.trajectoryInfo.level,
                improvement: row.trajectoryInfo.improvement,
                slope: row.trajectoryInfo.slope,
                points: (row.trajectoryInfo.points || []).map((q: any) => ({
                    pid: (pdict[q.pid] as any)?.pid || String(q.pid), pos: q.pos, idx: q.idx, pct: q.pct,
                })),
            } : null,
            levelMax: OWNERSHIP_LEVEL_MAX,
        };
    }

    /**
     * 🔎 SCORE EVIDENCE — the proof behind every cell of the teacher's
     * score board (self_learning_detail.page.js hover pop-up). Where
     * postOwnershipDetail re-derives live composites, THIS endpoint
     * reports the STORED results row (the very numbers the table shows)
     * and attaches the raw evidence each number was computed from:
     *   🏆 every judged attempt on the task (verdict, score, time, late /
     *      excluded), the counted one marked;
     *   🎓 each walkthrough question with the student's own answers and
     *      their L0–L4 grades (an asked-but-unanswered question = L0);
     *   🔧 each judged guidance→fix transition: the failed submission, the
     *      guidance answered in between, the resubmission, level, trial
     *      penalty;
     *   🧩 each failure-phase exchange (tutor question, student answer,
     *      grade);
     *   💡 the first engagement's exchanges and its one grade;
     *   📈 the trajectory judgment (level, basis, class-percentile points);
     *   🧠 the transfer assessments, the planner's verdict, the surfaced
     *      knowledge points;
     *   🚫 the manipulation flags with their audit excerpts.
     * Texts come straight from the tutor threads (selflearning.tutor) —
     * the same record the student saw — so a dispute can be settled on
     * what was actually said. Staff only (owner or homework editors).
     */
    @param('ssid', Types.ObjectId)
    @param('uid', Types.Int)
    async postScoreEvidence({ domainId }, ssid: ObjectId, uid: number) {
        const sdoc = await loadSession(domainId, ssid);
        if (!this.user.own(sdoc) && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)) throw new PermissionError();
        const pids = sdoc.pids || [];
        const pdict = await problem.getList(domainId, pids, true, false, problem.PROJECTION_CONTEST_LIST, true);
        const label = (pid: number) => String((pdict[pid] as any)?.pid || pid);
        const results: any = sdoc.results || null;
        const row: any = (results?.rows || []).find((r: any) => r.uid === uid) || null;
        const schedule = sessionSchedule(sdoc);
        const udoc: any = await user.getById(domainId, uid).catch(() => null);
        const cut = (t: any, n: number) => {
            const str = String(t ?? '');
            return str.length > n ? `${str.slice(0, n)}…` : str;
        };
        // ---- 🏆 every judged attempt of this student on the session's tasks ----
        const rdocs = await record.getMulti(domainId, {
            uid, pid: { $in: pids }, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
        }).project({
            pid: 1, status: 1, score: 1, lang: 1,
        }).sort({ _id: 1 }).limit(5000).toArray();
        const hardEnd = schedule.hardEndAt ? new Date(schedule.hardEndAt) : null;
        const attemptsByPid = new Map<number, any[]>();
        const byRid = new Map<string, any>();
        for (const r of rdocs as any[]) {
            const at = r._id.getTimestamp();
            const excluded = !!(hardEnd && at > hardEnd);
            const late = !!(sdoc.endAt && at > sdoc.endAt);
            if (!attemptsByPid.has(r.pid)) attemptsByPid.set(r.pid, []);
            const list = attemptsByPid.get(r.pid)!;
            const entry = {
                rid: r._id.toHexString(),
                no: list.length + 1,
                at: at.getTime(),
                status: r.status,
                statusText: STATUS_TEXTS[r.status] || String(r.status),
                accepted: r.status === STATUS.STATUS_ACCEPTED,
                score: r.score || 0,
                lang: r.lang || '',
                late,
                excluded,
                counted: false,
            };
            list.push(entry);
            byRid.set(entry.rid, { ...entry, pid: r.pid });
        }
        // The counting record, by scoreRecords' exact rule: highest score;
        // on a tie the on-time one; records past the hard end never count.
        for (const [, list] of attemptsByPid) {
            let best: any = null;
            for (const a of list) {
                if (a.excluded) continue;
                if (!best || a.score > best.score || (a.score === best.score && best.late && !a.late)) best = a;
            }
            if (best) best.counted = true;
        }
        // ---- the tutor threads: walkthrough / reasoning / fix / initiative evidence ----
        const threads = await collTutor.find({ domainId, ssid: sdoc.docId, uid }).toArray() as any[];
        const tasks: Record<string, any> = {};
        for (const pid of pids) {
            tasks[String(pid)] = {
                pid, pidLabel: label(pid), title: (pdict[pid] as any)?.title || '', kind: pdict[pid] ? sessionKindOf(pdict[pid]) : 'programming',
                attempts: (attemptsByPid.get(pid) || []).slice(-40),
                walkthrough: null, reasoning: null, fix: null, initiative: null, integrity: null, surfacedKp: [],
            };
        }
        for (const th of threads) {
            const t = tasks[String(th.pid)];
            if (!t) continue;
            // Pair every student answer with the tutor question it replied to,
            // and stamp the attempt it belongs to and the phase (before or
            // after the first acceptance).
            const msgs: any[] = th.messages || [];
            let lastQ: any = null;
            let attemptNo = 0;
            let accepted = false;
            const answers: any[] = [];
            for (let i = 0; i < msgs.length; i++) {
                const m = msgs[i];
                if (m.kind === 'attempt' || m.kind === 'accepted') {
                    attemptNo += 1;
                    if (m.kind === 'accepted') accepted = true;
                    lastQ = null;
                    continue;
                }
                if (m.role === 'assistant') {
                    lastQ = { text: cut(m.content, 600), line: m.line, endLine: m.endLine, at: m.at ? new Date(m.at).getTime() : null };
                    continue;
                }
                if (m.role === 'user' && (m.kind === 'anno' || m.kind === 'chat')) {
                    answers.push({
                        idx: i,
                        text: cut(m.content, 1500),
                        at: m.at ? new Date(m.at).getTime() : null,
                        attemptNo,
                        post: accepted,
                        level: typeof m.level === 'number' ? m.level : null,
                        rlevel: typeof m.rlevel === 'number' ? m.rlevel : null,
                        resolved: !!m.resolved,
                        question: lastQ,
                    });
                }
            }
            const own: OwnershipState | undefined = th.ownership;
            if (own) {
                const used = new Set<number>();
                const questions = (own.questions || []).map((q, k) => {
                    const key = String(q.question || '');
                    // Answers to THIS question: the stored key is the question's
                    // first 300 chars (postAnnotate); match the tutor turn by it.
                    let mine = answers.filter((a) => a.post && a.question && String(a.question.text).slice(0, 300) === key.slice(0, 300) && !used.has(a.idx));
                    if (!mine.length) {
                        // Older threads: positional fallback over the post-acceptance answers.
                        const pool = answers.filter((a) => a.post && !used.has(a.idx));
                        mine = pool.slice(0, Math.max(1, q.levels?.length || 1));
                    }
                    for (const a of mine) used.add(a.idx);
                    return {
                        no: k + 1,
                        question: cut(key, 600),
                        line: q.line,
                        at: q.at ? new Date(q.at).getTime() : null,
                        levels: (q.levels || []).map((l) => Math.min(OWNERSHIP_LEVEL_MAX, Math.max(0, +l || 0))),
                        answers: mine.map((a) => ({ text: a.text, at: a.at, level: a.level })),
                    };
                });
                const mean = taskMeanOf(own);
                t.walkthrough = {
                    acceptedAttempt: own.acceptedAttempt, minQ: own.minQ, maxQ: own.maxQ, done: !!own.done,
                    mean: mean === null ? null : Math.round(mean * 100) / 100,
                    questions,
                };
            }
            // 🧩 failure-phase exchanges (graded rlevel when the live grader ran).
            const failing = answers.filter((a) => !a.post);
            if (failing.length || th.reasoning?.levels?.length) {
                const mean = reasoningTaskMeanOf(th.reasoning);
                t.reasoning = {
                    levels: (th.reasoning?.levels || []).map((l: number) => Math.min(REASONING_LEVEL_MAX, Math.max(0, +l || 0))),
                    mean: mean === null ? null : Math.round(mean * 100) / 100,
                    exchanges: failing.slice(0, 40).map((a) => ({
                        attemptNo: a.attemptNo, question: a.question?.text || '', line: a.question?.line, answer: a.text, at: a.at, rlevel: a.rlevel,
                    })),
                };
            }
            // 🔧 judged transitions with the two submissions and the guidance answered between them.
            const fc: FixConvState | undefined = th.fixconv;
            if (fc?.transitions?.length) {
                const mean = taskFixConvMeanOf(fc);
                t.fix = {
                    mean: mean === null ? null : Math.round(mean * 100) / 100,
                    transitions: fc.transitions.map((x) => {
                        const from = byRid.get(String(x.fromRid)) || null;
                        const to = byRid.get(String(x.toRid)) || null;
                        const between = (from && to)
                            ? answers.filter((a) => a.at && a.at > from.at && a.at <= to.at).slice(0, 12)
                            : [];
                        return {
                            trial: x.trial,
                            level: Math.min(FIXCONV_LEVEL_MAX, Math.max(0, +x.level || 0)),
                            penalty: fixConvPenalty(x.trial || 1),
                            asked: x.asked,
                            at: x.at ? new Date(x.at).getTime() : null,
                            from: from ? { no: from.no, at: from.at, statusText: from.statusText, score: from.score, accepted: from.accepted } : null,
                            to: to ? { no: to.no, at: to.at, statusText: to.statusText, score: to.score, accepted: to.accepted } : null,
                            exchanges: between.map((a) => ({ question: a.question?.text || '', answer: cut(a.text, 500), rlevel: a.rlevel })),
                        };
                    }),
                };
            }
            // 💡 the first engagement: the exchanges of the earliest attempt that has any.
            if (typeof th.initiative?.level === 'number') {
                const firstNo = Math.min(...failing.map((a) => a.attemptNo), Number.POSITIVE_INFINITY);
                const first = Number.isFinite(firstNo) ? failing.filter((a) => a.attemptNo === firstNo).slice(0, 6) : [];
                t.initiative = {
                    level: Math.min(INITIATIVE_LEVEL_MAX, Math.max(0, +th.initiative.level || 0)),
                    at: th.initiative.at ? new Date(th.initiative.at).getTime() : null,
                    attemptNo: Number.isFinite(firstNo) ? firstNo : null,
                    exchanges: first.map((a) => ({ question: a.question?.text || '', answer: cut(a.text, 500), at: a.at })),
                };
            }
            if (th.integrity && (th.integrity.own || th.integrity.fix || th.integrity.rea || th.integrity.ini)) {
                t.integrity = {
                    own: !!th.integrity.own, fix: !!th.integrity.fix, rea: !!th.integrity.rea, ini: !!th.integrity.ini,
                    hits: (th.integrity.hits || []).slice(-8).map((h: any) => ({ sub: h.sub, excerpt: cut(h.excerpt, 300), at: h.at ? new Date(h.at).getTime() : null })),
                };
            }
            if (th.surfacedKp?.names?.length) t.surfacedKp = th.surfacedKp.names.slice(0, 12);
        }
        // ---- 📈 / 🧠 the session-wide (Block B) judgments ----
        const progDoc = await SelfLearningModel.getProgress(domainId, sdoc.docId, uid);
        this.response.body = {
            uid,
            uname: udoc?.uname || String(uid),
            name: `${udoc?.firstName || ''} ${udoc?.lastName || ''}`.trim(),
            evaluated: !!row,
            computedAt: results?.computedAt || null,
            final: !!results?.final,
            row,
            shares: {
                taskMax: results?.taskMax ?? TASK_RUBRIC_MAX,
                ach: results?.achievementShare ?? ACHIEVEMENT_SHARE,
                own: results?.ownershipShare ?? OWNERSHIP_SHARE,
                fix: results?.fixconvShare ?? FIXCONV_SHARE,
                rea: results?.reasoningShare ?? REASONING_SHARE,
                ini: results?.initiativeShare ?? INITIATIVE_SHARE,
                faAch: results?.faAchShare ?? FIRST_ATTEMPT_ACH_MAX,
                faOwn: results?.faOwnShare ?? FIRST_ATTEMPT_OWN_MAX,
                trj: results?.trajectoryShare ?? TRAJECTORY_SHARE,
                trf: results?.transferShare ?? TRANSFER_SHARE,
                blockA: results?.blockAMax ?? BLOCK_A_MAX,
                blockB: results?.blockBMax ?? BLOCK_B_MAX,
                total: results?.maxTotal ?? SESSION_TOTAL_MAX,
                levelMax: OWNERSHIP_LEVEL_MAX,
            },
            schedule: {
                endAt: sdoc.endAt ? new Date(sdoc.endAt).getTime() : null,
                hardEndAt: schedule.hardEndAt ? new Date(schedule.hardEndAt).getTime() : null,
                penaltyRules: sdoc.penaltyRules || (typeof sdoc.penalty === 'number' ? { 0: (100 - sdoc.penalty) / 100 } : null),
            },
            programmingPids: programmingPidsOf(sdoc, pdict),
            tasks,
            trajectory: progDoc?.trajectory ? {
                level: Math.min(TRAJECTORY_LEVEL_MAX, Math.max(0, +progDoc.trajectory.level || 0)),
                at: progDoc.trajectory.at ? new Date(progDoc.trajectory.at).getTime() : null,
                basis: progDoc.trajectory.basis || '',
                flagged: !!progDoc.trajectory.flagged,
                info: row?.trajectoryInfo ? {
                    level: row.trajectoryInfo.level,
                    improvement: row.trajectoryInfo.improvement,
                    slope: row.trajectoryInfo.slope,
                    points: (row.trajectoryInfo.points || []).map((q: any) => ({ pid: label(q.pid), pos: q.pos, idx: q.idx, pct: q.pct })),
                } : null,
            } : null,
            transfer: {
                assessments: (progDoc?.transfer?.assessments || []).map((a) => ({
                    concept: a.concept, fromPid: label(a.fromPid), toPid: label(a.toPid), level: Math.min(TRANSFER_LEVEL_MAX, Math.max(0, +a.level || 0)), at: a.at ? new Date(a.at).getTime() : null, flagged: !!a.flagged,
                })),
                plan: progDoc?.transfer?.plan ? { candidates: progDoc.transfer.plan.candidates, untestable: !!progDoc.transfer.plan.untestable, at: progDoc.transfer.plan.at ? new Date(progDoc.transfer.plan.at).getTime() : null } : null,
                surfaced: threads.filter((th) => th.surfacedKp?.names?.length).map((th) => ({ pid: label(th.pid), names: th.surfacedKp.names.slice(0, 12) })),
            },
        };
    }

    /**
     * ✎ Teacher: adjust a student's score — one task's Σ (0..100) or the
     * session total (0..100) — with a mandatory reason, when the student
     * argues. Stored on the progress doc (survives re-evaluation) and
     * applied at once to the stored results row, so the board, the CSV
     * and the student's card all change together.
     */
    @param('ssid', Types.ObjectId)
    @param('uid', Types.Int)
    @param('pid', Types.Int, true)
    @param('score', Types.Float)
    @param('reason', Types.Content)
    async postOverrideScore({ domainId }, ssid: ObjectId, uid: number, pid: number | undefined, score: number, reason: string) {
        const sdoc = await loadSession(domainId, ssid);
        if (!this.user.own(sdoc) && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)) throw new PermissionError();
        if (!Number.isFinite(score) || score < 0 || score > 100) throw new ValidationError('score');
        if (pid !== undefined && !(sdoc.pids || []).includes(pid)) throw new ValidationError('pid');
        const why = String(reason || '').trim().slice(0, 500);
        if (!why) throw new ValidationError('reason');
        const prog = await SelfLearningModel.getProgress(domainId, ssid, uid);
        const override: ScoreOverride = { ...(prog?.override || {}) };
        override.tasks = { ...(override.tasks || {}) };
        override.log = [...(override.log || [])].slice(-50);
        const row: any = (sdoc.results?.rows || []).find((r) => r.uid === uid) || null;
        const at = new Date();
        if (pid !== undefined) {
            const computed = row?.computed?.taskScores?.[String(pid)] ?? row?.taskScores?.[String(pid)] ?? null;
            override.tasks[String(pid)] = {
                score, computed, reason: why, by: this.user._id, at,
            };
            override.log.push({
                kind: 'task', pid, from: row?.taskScores?.[String(pid)] ?? null, to: score, reason: why, by: this.user._id, at,
            });
        } else {
            override.total = {
                score, computed: row?.computed?.total ?? row?.total ?? null, reason: why, by: this.user._id, at,
            };
            override.log.push({
                kind: 'total', from: row?.total ?? null, to: score, reason: why, by: this.user._id, at,
            });
        }
        await SelfLearningModel.setOverride(domainId, ssid, uid, override);
        const fresh = await this.patchResultsRow(domainId, sdoc, uid, override);
        this.response.body = { ok: true, override, row: fresh };
    }

    /** ✎ Teacher: remove one adjustment (a task's, or the total's); the computed value returns. */
    @param('ssid', Types.ObjectId)
    @param('uid', Types.Int)
    @param('pid', Types.Int, true)
    async postClearOverride({ domainId }, ssid: ObjectId, uid: number, pid?: number) {
        const sdoc = await loadSession(domainId, ssid);
        if (!this.user.own(sdoc) && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)) throw new PermissionError();
        const prog = await SelfLearningModel.getProgress(domainId, ssid, uid);
        const override: ScoreOverride = { ...(prog?.override || {}) };
        override.tasks = { ...(override.tasks || {}) };
        override.log = [...(override.log || [])].slice(-50);
        const at = new Date();
        if (pid !== undefined) {
            if (override.tasks[String(pid)]) {
                override.log.push({
                    kind: 'task', pid, from: override.tasks[String(pid)].score, to: null, reason: 'adjustment removed', by: this.user._id, at,
                });
            }
            delete override.tasks[String(pid)];
        } else if (override.total) {
            override.log.push({
                kind: 'total', from: override.total.score, to: null, reason: 'adjustment removed', by: this.user._id, at,
            });
            delete override.total;
        }
        await SelfLearningModel.setOverride(domainId, ssid, uid, override);
        const fresh = await this.patchResultsRow(domainId, sdoc, uid, override);
        this.response.body = { ok: true, override, row: fresh };
    }

    /** Re-apply a student's overrides to their stored results row (no re-evaluation needed). */
    async patchResultsRow(domainId: string, sdoc: SelfLearningDoc, uid: number, override: ScoreOverride) {
        const results = sdoc.results;
        if (!results?.rows) return null;
        const idx = results.rows.findIndex((r) => r.uid === uid);
        if (idx < 0) return null;
        const fresh = applySessionOverride(results.rows[idx], override);
        const rows = [...results.rows];
        rows[idx] = fresh;
        rows.sort((a, b) => b.total - a.total || a.uname.localeCompare(b.uname));
        await SelfLearningModel.edit(domainId, sdoc.docId, { results: { ...results, rows } });
        return fresh;
    }

    /** Teacher: the manual evaluation's background-job state (for the progress card + reattach after reload). */
    @param('ssid', Types.ObjectId)
    async postEvalStatus({ domainId }, ssid: ObjectId) {
        const sdoc = await loadSession(domainId, ssid);
        if (!this.user.own(sdoc) && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)) throw new PermissionError();
        const job: any = sdoc.evalJob || null;
        const stale = !!(job && job.state === 'running'
            && Date.now() - new Date(job.startedAt).getTime() >= EVAL_JOB_STALE_MS);
        this.response.body = {
            job: job ? { ...job, stale } : null,
            computedAt: sdoc.results?.computedAt || null,
        };
    }

    @param('ssid', Types.ObjectId)
    @param('export', Types.String, true)
    async get({ domainId }, ssid: ObjectId, exportAs = '') {
        const sdoc = await loadSession(domainId, ssid);
        const pdict = await problem.getList(
            domainId, sdoc.pids, true, false, problem.PROJECTION_CONTEST_LIST, true,
        );
        const psdict = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await problem.getListStatus(domainId, this.user._id, sdoc.pids)
            : {};
        const udict = await user.getList(domainId, [sdoc.owner]);
        // Staff accounts (owner, homework editors) see the teacher view.
        const isStudentView = !this.user.own(sdoc)
            && !this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK)
            && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
        const solvedCount = sdoc.pids.filter((pid) => psdict[pid]?.status === STATUS.STATUS_ACCEPTED).length;
        const schedule = sessionSchedule(sdoc);
        // (Stale-schema results re-derivation moved into the teacher
        // results section below, where it runs through THE shared
        // runSessionEvaluation together with the on-view finalization.)
        // One task at a time: the student's gate (finished / skipped /
        // current / locked per task) for the task list. Staff see no gate.
        let gateOf: Record<number, string> | null = null;
        let gateInfo: any = null;
        if (isStudentView && this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            const g = computeGate(sdoc.pids, await SelfLearningModel.getProgress(domainId, sdoc.docId, this.user._id));
            gateOf = {};
            for (const pid of sdoc.pids) {
                gateOf[pid] = g.done.includes(pid) ? 'done'
                    : g.skipped.includes(pid) ? 'skipped'
                        : g.current === pid ? 'current'
                            : g.unlocked.includes(pid) ? 'open' : 'locked';
            }
            gateInfo = { current: g.current, index: g.index, total: g.total, finished: g.current === null, done: g.done.length, skipped: g.skipped.length };
        }
        // Bonus tasks earned in this session (students only).
        let bonuses: any[] = [];
        let bonusEligibleNow = false;
        if (isStudentView && this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            bonuses = await refreshBonuses(domainId, sdoc, this.user._id);
            bonusEligibleNow = await bonusEligible(domainId, sdoc, this.user._id);
        }
        /*
         * 🎁 The teacher's counterpart: every student's bonus task, live.
         * Never fatal — the board is an extra panel below the task list, so
         * a failure here (a deleted draft, an unreachable provider) must
         * still leave the session page renderable.
         */
        let bonusRows: any[] = [];
        let bonusStats: any = null;
        if (!isStudentView) {
            try {
                bonusRows = await staffBonusRows(domainId, sdoc);
                bonusStats = {
                    total: bonusRows.length,
                    ready: bonusRows.filter((b) => b.status === 'ready').length,
                    building: bonusRows.filter(isBonusBusy).length,
                    failed: bonusRows.filter((b) => b.status === 'failed').length,
                    accepted: bonusRows.filter((b) => b.accepted).length,
                    inProblemSet: bonusRows.filter((b) => b.inProblemSet).length,
                };
            } catch (e) {
                logger.warn('[self-learning] bonus board for %s/%s failed: %s', domainId, sdoc.docId, e.message);
            }
        }

        // Before the begin time students see the schedule, not the problems.
        const hideProblems = isStudentView && schedule.phase === 'notStarted';
        /*
         * Per-problem effective score for the student, through THE shared
         * rubric (scoreRecords) — the same function the teacher's Evaluate
         * button and the automatic post-deadline evaluation run — so this
         * card can never disagree with the stored results table. Records
         * keep their TRUE score (exactly like homework, where the penalty
         * lives in contest scoring, not on the record) — the session
         * interprets them. Note: records after the hard end no longer count
         * here either; the earlier inline copy of this math missed that
         * cutoff and could drift from the evaluation.
         */
        let myScores: Record<number, TaskBest> | null = null;
        let myBest: Map<number, TaskBest> | null = null;
        let myFirstAc: Set<number> = new Set();
        let myLateRows: { at: Date }[] = [];
        if (isStudentView && !hideProblems && this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            try {
                const rdocs = await record.getMulti(domainId, {
                    uid: this.user._id, pid: { $in: sdoc.pids }, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
                }).project({ pid: 1, score: 1, status: 1 }).toArray();
                const myRows = (rdocs as any[]).map((r) => ({
                    pid: r.pid, score: r.score || 0, at: r._id.getTimestamp(), accepted: r.status === STATUS.STATUS_ACCEPTED,
                }));
                myBest = scoreRecords(sdoc, myRows);
                myFirstAc = firstAttemptAcceptedPids(myRows);
                myLateRows = myRows;
                myScores = {};
                for (const [pid, v] of myBest) myScores[pid] = v;
            } catch (e) { /* score chips are optional */ }
        }
        /*
         * The student's own score: the live total (same rule as the
         * teacher's evaluation, so both always agree) and, when the teacher
         * has evaluated the session, that recorded total and time.
         *
         * EMBARGO (see totalScoreReleased): before the deadline has passed
         * and before the teacher's first evaluation, the client receives a
         * locked descriptor — the max, the attempt count and the reveal
         * date, never the number itself — so neither the card nor a JSON
         * caller can learn the total early.
         */
        let myScore: any = null;
        if (myScores && myBest) {
            // Same classification rule as computeSessionResults, applied to
            // the pdict this page already loaded.
            const progPids = programmingPidsOf(sdoc, pdict);
            if (totalScoreReleased(sdoc, schedule)) {
                /*
                 * ⭐ THE shared rubric (taskRubricOf → blockAOf + blockBOf),
                 * the very functions the evaluation stores — so this card
                 * can never disagree with the teacher's table. Per task:
                 * score /100 = Σ earned sub-rubric points (🏆 judged×30% +
                 * 🎓 mean level×5, from the STORED walkthrough levels —
                 * live-graded as the student answers, backfilled by every
                 * evaluation; 🔧/🧩/💡 pending); 🅰 = task-sum × 75/(N×100);
                 * 🅱 = 0 (coming).
                 */
                const myOwn = new Map<number, { level: number | null, asked: number }>();
                const myFix = new Map<number, { level: number | null, judged: number }>();
                const myRea = new Map<number, { level: number | null, judged: number }>();
                const myIni = new Map<number, { level: number | null }>();
                for (const t of await getOwnershipIn(domainId, sdoc.docId, this.user._id)) {
                    if (t.ownership) myOwn.set(t.pid, { level: taskMeanOf(t.ownership), asked: t.ownership.questions?.length || 0 });
                    if (t.fixconv?.transitions?.length) {
                        myFix.set(t.pid, { level: taskFixConvMeanOf(t.fixconv), judged: t.fixconv.transitions.length });
                    }
                    if (t.reasoning?.levels?.length) {
                        myRea.set(t.pid, { level: reasoningTaskMeanOf(t.reasoning), judged: t.reasoning.levels.length });
                    }
                    if (typeof t.initiative?.level === 'number') myIni.set(t.pid, { level: t.initiative.level });
                    // 🚫 Flags override clean evidence — the slot is 0.
                    const ig = (t as any).integrity;
                    if (ig?.own) myOwn.set(t.pid, { level: 0, asked: myOwn.get(t.pid)?.asked || 0, flagged: true } as any);
                    if (ig?.fix) myFix.set(t.pid, { level: 0, judged: myFix.get(t.pid)?.judged || 0, flagged: true } as any);
                    if (ig?.rea) myRea.set(t.pid, { level: 0, judged: myRea.get(t.pid)?.judged || 0, flagged: true } as any);
                    if (ig?.ini) myIni.set(t.pid, { level: 0, flagged: true } as any);
                }
                const breakdowns = progPids.map((pid) => taskRubricOf(
                    pid, myBest!.get(pid) || null, myOwn.get(pid) || null, myFix.get(pid) || null,
                    myRea.get(pid) || null, myIni.get(pid) || null, myFirstAc.has(pid),
                ));
                const blockA = blockAOf(breakdowns);
                const myProg = await SelfLearningModel.getProgress(domainId, sdoc.docId, this.user._id);
                const myTrjRaw = myProg?.trajectory?.level;
                const myTrjLevel = typeof myTrjRaw === 'number'
                    ? Math.min(TRAJECTORY_LEVEL_MAX, Math.max(0, myTrjRaw)) : null;
                const myTrf = transferSubScoreOf(myProg?.transfer?.assessments, myProg?.transfer?.plan);
                const blockB = blockBOf({ level: myTrjLevel }, myTrf);
                // ⭐⭐ All tasks accepted first-try → the collapsed 40+60 total.
                const myAllFa = allFirstAttemptSessionOf(breakdowns);
                const myLp = latePenaltyOf(sdoc, myLateRows);
                const myTotalBase = myAllFa ? myAllFa.total : Math.round((blockA + blockB) * 10) / 10;
                const total = myLp ? Math.round(myTotalBase * myLp.factor * 10) / 10 : myTotalBase;
                const perTask = breakdowns.map((b) => ({
                    pid: (pdict[b.pid] as any)?.pid || String(b.pid),
                    score: b.score,
                    achPts: b.achPts,
                    judged: b.judged,
                    ownPts: b.ownPts,
                    ownLevel: b.ownLevel,
                    ownAsked: myOwn.get(b.pid)?.asked || 0,
                    fixPts: b.fixPts,
                    fixLevel: b.fixLevel,
                    fixJudged: myFix.get(b.pid)?.judged || 0,
                    reaPts: b.reaPts,
                    reaLevel: b.reaLevel,
                    reaJudged: myRea.get(b.pid)?.judged || 0,
                    iniPts: b.iniPts,
                    iniLevel: b.iniLevel,
                    ownFlagged: !!(myOwn.get(b.pid) as any)?.flagged,
                    fixFlagged: !!(myFix.get(b.pid) as any)?.flagged,
                    reaFlagged: !!(myRea.get(b.pid) as any)?.flagged,
                    iniFlagged: !!(myIni.get(b.pid) as any)?.flagged,
                    firstAttempt: b.firstAttempt,
                    attempted: b.attempted,
                    late: b.late,
                }));
                const evaluated = sdoc.results?.rows?.find((r) => r.uid === this.user._id) || null;
                myScore = {
                    released: true,
                    total,
                    max: SESSION_TOTAL_MAX,
                    blockA,
                    blockAMax: BLOCK_A_MAX,
                    blockAEarnable: BLOCK_A_EARNABLE,
                    blockB,
                    blockBMax: BLOCK_B_MAX,
                    taskMax: TASK_RUBRIC_MAX,
                    achievementShare: ACHIEVEMENT_SHARE,
                    ownershipShare: OWNERSHIP_SHARE,
                    fixconvShare: FIXCONV_SHARE,
                    reasoningShare: REASONING_SHARE,
                    initiativeShare: INITIATIVE_SHARE,
                    faAchShare: FIRST_ATTEMPT_ACH_MAX,
                    faOwnShare: FIRST_ATTEMPT_OWN_MAX,
                    trajectoryShare: TRAJECTORY_SHARE,
                    transferShare: TRANSFER_SHARE,
                    blockBEarnable: BLOCK_B_EARNABLE,
                    trjLevel: myTrjLevel,
                    trjPts: trajectoryPtsOf(myTrjLevel),
                    trjFlagged: !!myProg?.trajectory?.flagged,
                    trfState: myTrf.state,
                    trfLevel: myTrf.level,
                    trfPts: myTrf.pts,
                    trfJudged: myTrf.judged,
                    trfFlagged: !!myTrf.flagged,
                    allFa: !!myAllFa,
                    sessAch: myAllFa ? myAllFa.ach : null,
                    sessOwn: myAllFa ? myAllFa.own : null,
                    lateFactor: myLp ? myLp.factor : null,
                    lateHours: myLp ? myLp.hours : null,
                    perTask,
                    attempted: perTask.filter((t) => t.attempted).length,
                    evaluatedTotal: evaluated ? evaluated.total : null,
                    // The template renders "Evaluated by your teacher {when}":
                    // the evaluation time is the stored table's computedAt.
                    evaluatedAt: evaluated ? (sdoc.results?.computedAt || null) : null,
                };
                /*
                 * ✎ The teacher's adjustments, applied with the very
                 * function the evaluation uses, so the card and the table
                 * agree: task scores, Block A, the total — each adjusted
                 * value carries the computed one and the reason.
                 */
                if (myProg?.override && (Object.keys(myProg.override.tasks || {}).length || myProg.override.total)) {
                    const shaped = applySessionOverride({
                        taskScores: Object.fromEntries(breakdowns.map((b) => [String(b.pid), b.score])),
                        blockA, blockB, total, allFa: !!myAllFa, lateFactor: myLp ? myLp.factor : undefined,
                    } as any, myProg.override);
                    myScore.total = shaped.total;
                    myScore.blockA = shaped.blockA;
                    myScore.adjusted = {
                        total: shaped.override?.total ? { computed: shaped.override.total.computed, reason: shaped.override.total.reason, at: shaped.override.total.at } : null,
                        tasks: Object.keys(shaped.override?.tasks || {}).length,
                    };
                    for (const t of perTask) {
                        const pid = breakdowns.find((b) => ((pdict[b.pid] as any)?.pid || String(b.pid)) === t.pid)?.pid;
                        const o = pid !== undefined ? shaped.override?.tasks?.[String(pid)] : null;
                        if (o) {
                            (t as any).adjusted = { computed: o.computed, reason: o.reason, at: o.at };
                            t.score = shaped.taskScores![String(pid)];
                        }
                    }
                }
            } else {
                myScore = {
                    released: false,
                    max: SESSION_TOTAL_MAX,
                    attempted: sdoc.pids.filter((pid) => myScores![pid]).length,
                    releaseAt: schedule.endAt || null,
                };
            }
        }
        /*
         * Teacher view: the results table. Once the deadline (with extension)
         * has passed, results are FINAL — computed here on first sight if the
         * timer has not got to this session yet; before that, whatever
         * provisional table the teacher last asked for.
         */
        let results: SessionResults | null = null;
        let resultsState = 'none';
        if (!isStudentView) {
            // 'ended' is the terminal SessionPhase (an earlier build tested
            // the nonexistent 'closed', so this branch never fired and only
            // the background timer ever finalized results).
            const closed = schedule.phase === 'ended';
            results = sdoc.results || null;
            /*
             * Two on-view cases start an evaluation right here, BOTH
             * through THE shared claim + runClaimedEvaluation — the
             * identical body behind the Evaluate button and the
             * post-deadline sweep, so all paths always agree:
             *   - ↩️ stale-rubric results (stored under another
             *     SESSION_RUBRIC_VERSION) re-derive on sight;
             *   - an ended session whose results are not final yet
             *     finalizes on first sight if the sweep has not got to it.
             * The evaluation now includes 🎓 LLM grading, so it runs
             * DETACHED (exactly like the button): this page serves the
             * stored table (or 'pending'), and its status poll re-attaches
             * to the running job's progress card, swapping the fresh table
             * in on completion. If another evaluation already holds the
             * job, the poll re-attaches to that one — same presentation
             * either way.
             */
            const staleSchema = !!results && results.rubric !== SESSION_RUBRIC_VERSION;
            if (staleSchema || (closed && !results?.final)) {
                const startedAt = new Date();
                const claimed = await claimEvalJob(domainId, sdoc.docId, startedAt).catch(() => false);
                if (claimed) {
                    if (staleSchema) logger.info('[self-learning] re-deriving stale-rubric results for %s/%s on view', domainId, sdoc.docId);
                    (async () => {
                        try {
                            await runClaimedEvaluation(domainId, sdoc.docId, startedAt);
                        } catch (e) {
                            // runClaimedEvaluation already recorded the failed job.
                            logger.warn('[self-learning] on-view evaluation failed for %s/%s: %s', domainId, sdoc.docId, e.message);
                        }
                    })();
                    sdoc.evalJob = { state: 'running', startedAt } as any; // JSON callers see the claim this response made
                }
            }
            resultsState = results ? (results.final ? 'final' : 'provisional') : (schedule.phase === 'open' ? 'open' : 'pending');
            if (exportAs === 'csv' && results) {
                const csvEsc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
                const label = (pid: number) => pdict[pid]?.pid || String(pid);
                // Mirrors the on-screen table: per task a 7-column group —
                // score, then the five sub-rubrics (🏆 as judged + points,
                // 🎓 as level + points, 🔧/🧩/💡 pending → empty) — then
                // 🅰/🅱/total.
                // firstAttempt=1 rows are the ⭐ exception: achievement is
                // /40 and ownership /60 there, and fixconv/reasoning/
                // initiative are n/a (empty).
                const perTaskHead = (pid: number) => [
                    `${label(pid)} (/${results.taskMax ?? TASK_RUBRIC_MAX})`,
                    `${label(pid)} firstAttempt`,
                    `${label(pid)} judged (/100)`,
                    `${label(pid)} achievement `
                    + `(/${results.achievementShare ?? ACHIEVEMENT_SHARE}, FA /${results.faAchShare ?? FIRST_ATTEMPT_ACH_MAX})`,
                    `${label(pid)} ownership level (/4)`,
                    `${label(pid)} ownership (/${results.ownershipShare ?? OWNERSHIP_SHARE}, FA /${results.faOwnShare ?? FIRST_ATTEMPT_OWN_MAX})`,
                    `${label(pid)} fixconv (/${results.fixconvShare ?? FIXCONV_SHARE})`,
                    `${label(pid)} reasoning (/${results.reasoningShare ?? REASONING_SHARE})`,
                    `${label(pid)} initiative (/${results.initiativeShare ?? INITIATIVE_SHARE})`,
                ];
                const head = [
                    'uid', 'username', 'name',
                    ...sdoc.pids.flatMap((pid) => perTaskHead(pid)),
                    'late hours',
                    'late factor',
                    'allFirstAttempt',
                    `session achievement (/${results.faAchShare ?? FIRST_ATTEMPT_ACH_MAX})`,
                    `session ownership (/${results.faOwnShare ?? FIRST_ATTEMPT_OWN_MAX})`,
                    `blockA (/${results.blockAMax ?? BLOCK_A_MAX})`,
                    'trajectory level (/4)',
                    `trajectory (/${results.trajectoryShare ?? TRAJECTORY_SHARE})`,
                    `transfer (/${results.transferShare ?? TRANSFER_SHARE})`,
                    'transfer state',
                    `blockB (/${results.blockBMax ?? BLOCK_B_MAX})`,
                    'total', 'max', 'attempts', 'finished', 'skipped', 'bonus',
                ];
                const lines = [head.map(csvEsc).join(',')];
                const r1c = (x: number) => Math.round(x * 10) / 10;
                for (const r of results.rows) {
                    const perTaskCells = (pid: number) => {
                        const sc = r.scores[String(pid)];
                        const ow = r.own?.[String(pid)];
                        const achShare = results.achievementShare ?? ACHIEVEMENT_SHARE;
                        const ownShare = results.ownershipShare ?? OWNERSHIP_SHARE;
                        const fx = r.fix?.[String(pid)];
                        const rx = r.rea?.[String(pid)];
                        const ix = r.ini?.[String(pid)];
                        const isFa = !!r.fa?.[String(pid)];
                        const aSh = isFa ? (results.faAchShare ?? FIRST_ATTEMPT_ACH_MAX) : achShare;
                        const oSh = isFa ? (results.faOwnShare ?? FIRST_ATTEMPT_OWN_MAX) : ownShare;
                        return [
                            r.taskScores?.[String(pid)] ?? '',
                            isFa ? 1 : '',
                            sc?.effective ?? 0,
                            sc ? r1c((sc.effective * aSh) / 100) : 0,
                            ow?.level ?? '',
                            typeof ow?.pts === 'number' ? ow.pts
                                : (typeof ow?.level === 'number' ? r1c((ow.level * oSh) / 4) : 0),
                            typeof fx?.pts === 'number' ? fx.pts
                                : (typeof fx?.level === 'number' ? r1c((fx.level * (results.fixconvShare ?? FIXCONV_SHARE)) / 4) : ''),
                            typeof rx?.pts === 'number' ? rx.pts
                                : (typeof rx?.level === 'number' ? r1c((rx.level * (results.reasoningShare ?? REASONING_SHARE)) / 4) : ''),
                            typeof ix?.pts === 'number' ? ix.pts
                                : (typeof ix?.level === 'number' ? r1c((ix.level * (results.initiativeShare ?? INITIATIVE_SHARE)) / 4) : ''),
                        ];
                    };
                    lines.push([
                        r.uid, r.uname, r.name,
                        ...sdoc.pids.flatMap((pid) => perTaskCells(pid)),
                        r.lateHours ?? '',
                        r.lateFactor ?? '',
                        r.allFa ? 1 : '',
                        r.allFa ? (r.sessAch ?? '') : '',
                        r.allFa ? (r.sessOwn ?? '') : '',
                        r.allFa ? '' : (r.blockA ?? ''),
                        r.allFa ? '' : (r.trj?.level ?? ''),
                        r.allFa ? '' : (typeof r.trj?.pts === 'number' ? r.trj.pts : ''),
                        r.allFa ? '' : (typeof r.trf?.pts === 'number' ? r.trf.pts : ''),
                        r.allFa ? '' : (r.trf?.state ?? ''),
                        r.allFa ? '' : (r.blockB ?? ''),
                        r.total, results.maxTotal, r.attempts, r.done, r.skipped, r.bonus,
                    ].map(csvEsc).join(','));
                }
                this.response.type = 'text/csv';
                this.response.disposition = `attachment; filename="session-${sdoc.docId.toHexString()}-results.csv"`;
                this.response.body = `\ufeff${lines.join('\r\n')}\r\n`;
                return;
            }
        }
        this.response.template = 'self_learning_detail.html';
        this.response.body = {
            // myScore above is computed from the ORIGINAL doc; what travels
            // to a student must not carry the class-wide results table.
            sdoc: isStudentView ? scrubResults(sdoc) : sdoc,
            pdict,
            psdict,
            udict,
            solvedCount,
            schedule,
            staffView: !isStudentView,
            results,
            resultsState,
            hideProblems,
            myScores,
            myScore,
            gateOf,
            gateInfo,
            bonuses,
            bonusEligibleNow,
            bonusRows,
            bonusStats,
            // 🎁 The teacher's tickbox, for both views: the student's page
            // stops advertising a bonus task the session does not offer, and
            // the teacher's board says so plainly.
            bonusAllowed: bonusAllowed(sdoc),
            canEdit: sdoc.owner === this.user._id
                || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
                || this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM),
        };
    }
}

class SelfLearningProblemBaseHandler extends Handler {
    sdoc: SelfLearningDoc;
    pdoc: ProblemDoc;
    /** Students only: the task progression (one task at a time). */
    gate?: SessionGate;
    /** Set when `pid` is one of THIS student's bonus tasks (hidden, session-only, no tutor). */
    bonus?: SelfLearningBonusEntry;

    @param('ssid', Types.ObjectId)
    @param('pid', Types.PositiveInt)
    async _prepare({ domainId }, ssid: ObjectId, pid: number) {
        this.sdoc = await loadSession(domainId, ssid);
        const progress = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await SelfLearningModel.getProgress(domainId, this.sdoc.docId, this.user._id) : null;
        this.bonus = (progress?.bonuses || []).find((b) => b.docId === pid);
        if (!this.sdoc.pids.includes(pid) && !this.bonus) throw new NotFoundError(domainId, pid);
        this.pdoc = await problem.get(domainId, pid);
        if (!this.pdoc) throw new NotFoundError(domainId, pid);
        /*
         * 🌐 The session's language restriction, folded into the task's own
         * config exactly as a contest's `langs` is upstream: the solve page
         * (langRange), the scratchpad menu (UiContext.pdoc.config.langs)
         * and the submit check all read `config.langs`, so intersecting it
         * here — for listed tasks and bonus tasks alike — restricts every
         * one of them at once. A task without its own list simply takes
         * the session's; disabled languages are dropped either way.
         */
        const sessionLangs = (this.sdoc.langs || []).filter((l) => setting.langs[l] && !setting.langs[l].disabled);
        const cfg: any = this.pdoc.config;
        if (sessionLangs.length && cfg && typeof cfg === 'object' && !['objective', 'submit_answer'].includes(cfg.type)) {
            cfg.langs = Array.isArray(cfg.langs) && cfg.langs.length
                ? cfg.langs.filter((l: string) => sessionLangs.includes(l))
                : sessionLangs;
        }
        /*
         * FUNCTION TASKS: a harness exists per language FAMILY, so offer only
         * the variants that can actually be judged — the same family filter
         * ProblemDetailHandler applies. Without it the session's solve page
         * listed every judge language and a Python submission to a C-only
         * task would have compiled the bare fragment.
         */
        if (cfg && typeof cfg === 'object' && cfg.template && /^f/i.test(String(this.pdoc.pid || ''))) {
            const base: string[] = Array.isArray(cfg.langs) && cfg.langs.length
                ? cfg.langs
                : Object.keys(setting.langs).filter((l) => !setting.langs[l].disabled);
            cfg.langs = base.filter((l: string) => !!harnessFor(cfg.template, l));
        }
        // Homework-style schedule: before beginAt the session is closed to
        // students on every surface this base serves (solve, record, tutor).
        // After the end everything stays OPEN for review and tutoring; only
        // NEW submissions are refused (SelfLearningSolveHandler.post).
        if (this.isStudent && sessionSchedule(this.sdoc).phase === 'notStarted') {
            throw new ForbiddenError('This session has not started yet.');
        }
        /*
         * One task at a time: a student may open the current task and any
         * task before it (finished or skipped — retries are always
         * welcome); later tasks are locked until the current one is
         * finished or skipped. Staff see everything.
         */
        if (this.isStudent) {
            this.gate = computeGate(this.sdoc.pids, progress);
            // A bonus task belongs to the student who earned it: always open.
            if (!this.bonus && !this.gate.unlocked.includes(pid)) {
                throw new ForbiddenError('This task unlocks after you finish or skip the previous one.');
            }
        }
    }

    /** Reload the gate after a progress change and shape it for the client. */
    async refreshGate(domainId: string, engaged?: boolean) {
        if (!this.isStudent) return null;
        this.gate = computeGate(this.sdoc.pids, await SelfLearningModel.getProgress(domainId, this.sdoc.docId, this.user._id));
        return await this.gateView(engaged);
    }

    /**
     * The gate as the page sees it. `engaged` = the student has made at
     * least one real, judged attempt on this task (Scratchpad pretests do
     * not count); that is what makes Skip available — a task can be set
     * aside only after trying it.
     */
    async gateView(engaged?: boolean) {
        if (!this.gate) return null;
        const pid = this.pdoc.docId;
        const g = this.gate;
        if (this.bonus) {
            return {
                current: g.current, next: g.next, index: g.index, total: g.total, done: g.done, skipped: g.skipped, unlocked: g.unlocked,
                pid, isCurrent: false, isDone: false, isSkipped: false, engaged: false, canSkip: false, finished: g.current === null, isBonus: true,
            };
        }
        let eng = engaged;
        if (eng === undefined) {
            eng = (await record.getMulti(this.args.domainId, {
                pid, uid: this.user._id, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
            }).project({ _id: 1 }).limit(1).toArray()).length > 0;
        }
        return {
            current: g.current,
            next: g.next,
            index: g.index,
            total: g.total,
            done: g.done,
            skipped: g.skipped,
            unlocked: g.unlocked,
            pid,
            isCurrent: g.current === pid,
            isDone: g.done.includes(pid),
            isSkipped: g.skipped.includes(pid),
            engaged: !!eng,
            canSkip: g.current === pid && !!eng,
            finished: g.current === null,
        };
    }

    /**
     * The task counts as finished once the student is accepted AND has
     * answered the tutor's post-acceptance question — or is accepted with
     * no tutor to answer to. Idempotent.
     */
    async finishTask(domainId: string) {
        if (!this.isStudent) return null;
        // ⏹ Progress (done / skipped, and with it the gate and the results'
        // 🏁 ⏭ columns) is frozen at the session's hard end: practising a
        // task afterwards cannot mark it finished retroactively.
        if (sessionSchedule(this.sdoc).phase === 'ended') return await this.gateView();
        await SelfLearningModel.markDone(domainId, this.sdoc.docId, this.user._id, this.pdoc.docId);
        return await this.refreshGate(domainId, true);
    }

    /**
     * Students are domain members without teaching capability here: not the
     * session owner, and without the homework-management permissions of this
     * domain. Note that Hydro forces accounts holding PRIV_MANAGE_ALL_DOMAIN
     * into the root role of every domain, so those always count as staff.
     */
    get isStudent() {
        if (this.sdoc && this.user.own(this.sdoc)) return false;
        return !this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK)
            && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
    }

    /** 'programming' | 'objective' (quiz) | 'submit_answer' — from the parsed judge config. */
    get problemKind() {
        return aiTutor.problemKindOf(this.pdoc.config);
    }

    /** P / O / S classification of this task by the site convention. */
    get sessionKind() {
        return sessionKindOf(this.pdoc);
    }

    /**
     * The AI tutor exists for PROGRAMMING tasks only: a P-kind task whose
     * config is a real judged-program type. Objective quizzes, subjective
     * project tasks and answer-submission problems get no tutor on any
     * surface (solve page, paper, record page).
     */
    get tutorEligible() {
        if (this.bonus) return false; // bonus tasks: submit, see the verdict, retry — no tutor
        // sessionKind is the pid letter (F is a code kind); problemKind is
        // the judge config, which for a function task is still `default`.
        return isCodeSessionKind(this.sessionKind) && this.problemKind === 'programming';
    }

    /**
     * The given user's judged submissions on this problem, oldest first,
     * excluding Scratchpad pretest runs (they carry the RECORD_PRETEST
     * contest marker and are not real attempts).
     */
    async submissionTrajectory(domainId: string, uid: number, limit = 10) {
        const history = await record.getMulti(domainId, {
            pid: this.pdoc.docId, uid, contest: { $ne: record.RECORD_PRETEST },
        }).sort({ _id: -1 }).limit(limit)
            .project({ code: 1, lang: 1, status: 1, score: 1 })
            .toArray();
        return history.reverse().map((r: any) => ({
            rid: r._id.toHexString(),
            lang: r.lang || '',
            status: r.status,
            statusText: STATUS_TEXTS[r.status] || `${r.status}`,
            accepted: r.status === STATUS.STATUS_ACCEPTED,
            score: r.score || 0,
            at: r._id.getTimestamp().getTime(),
            code: typeof r.code === 'string' ? r.code.slice(0, 8000) : '',
        }));
    }
}

class SelfLearningSolveHandler extends SelfLearningProblemBaseHandler {
    async get({ domainId }) {
        /*
         * PTA UI: objective tasks are answered on the session's combined
         * paper — the same on-page answering surface Tests and Homework use
         * — so every HTML entry point (detail rows, rail chips, old
         * bookmarks) funnels there, anchored at this very question. XHR/json
         * callers and this handler's POST, /record and /tutor sub-routes are
         * untouched: the paper itself submits and tutors through them.
         */
        if (this.problemKind === 'objective' && !this.request.json) {
            this.response.redirect = `${this.url('self_learning_paper', { ssid: this.sdoc.docId })}#q-${this.pdoc.docId}`;
            return;
        }
        /*
         * Subjective (S) tasks have no judge and no tutor: they are answered
         * with a report + file upload on the problem page itself
         * (subjective_task.page.js). Nothing in a session should ever open
         * the IDE for one; legacy sessions that still list an S task are
         * forwarded there.
         */
        if (this.sessionKind === 'subjective' && !this.request.json) {
            this.response.redirect = this.url('problem_detail', { pid: this.pdoc.docId });
            return;
        }
        const langRange = (this.pdoc.config && typeof this.pdoc.config === 'object' && this.pdoc.config.langs)
            ? Object.fromEntries(this.pdoc.config.langs.map((i) => [i, setting.langs[i]?.display || i]))
            : setting.SETTINGS_BY_KEY.codeLang.range;
        this.UiContext.slSsid = this.sdoc.docId.toHexString();
        this.UiContext.slPid = this.pdoc.docId;
        // Students cannot select / copy the statement or the tutor's text.
        this.UiContext.noCopy = this.isStudent;
        // The tutor flows only run for programming tasks (see tutorEligible).
        this.UiContext.slTutor = aiTutor.tutorConfigured() && this.isStudent && this.tutorEligible;
        this.UiContext.slType = this.problemKind;
        // ⏯ RESUME: while the session has not ended, an unanswered tutor
        // question RIDES THE PAGE — reloads (or closing the pop-up card and
        // coming back tomorrow) keep it answerable from the round button.
        if (this.UiContext.slTutor && sessionSchedule(this.sdoc).phase !== 'ended') {
            const th = await SelfLearningModel.getThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
            const oq = openTutorQuestionOf(th);
            if (oq && th?.rid) this.UiContext.slOpenQuestion = { ...oq, rid: th.rid.toHexString() };
        }
        // Schedule cues for the fullscreen IDE (students only — the page
        // itself shows the notice; enforcement stays in post()).
        if (this.isStudent) {
            const sched = sessionSchedule(this.sdoc);
            if (sched.phase !== 'open') {
                this.UiContext.slSchedule = {
                    phase: sched.phase, penalty: sched.penalty, endAt: sched.endAt, hardEndAt: sched.hardEndAt,
                };
            }
        }
        // The full session problem list feeds the PTA-style rail inside the IDE.
        try {
            const listPdict = await problem.getList(
                domainId, this.sdoc.pids, true, false, problem.PROJECTION_CONTEST_LIST, true,
            );
            /*
             * 🎯 Rail verdict states of a SESSION: the records that COUNT for
             * it (scoreRecords — inside the window, the same rule the score
             * card and the evaluation use), never the global problem-status
             * doc, which would also show practice in the problem set, another
             * session that reused the task, or a submission made after the
             * session closed.
             */
            const listPsdict: Record<number, { status?: number }> = {};
            if (this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
                const rows = await record.getMulti(domainId, {
                    uid: this.user._id, pid: { $in: this.sdoc.pids }, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
                }).project({ pid: 1, score: 1, status: 1 }).limit(5000).toArray();
                const best = scoreRecords(this.sdoc, (rows as any[]).map((r) => ({ pid: r.pid, score: r.score || 0, at: r._id.getTimestamp() })));
                for (const pid of this.sdoc.pids) {
                    const b = best.get(pid);
                    if (b) listPsdict[pid] = { status: b.effective >= 100 ? STATUS.STATUS_ACCEPTED : STATUS.STATUS_WRONG_ANSWER };
                }
            }
            const g = this.gate;
            this.UiContext.slProblems = this.sdoc.pids.map((pid) => ({
                pid,
                title: listPdict[pid]?.title || String(pid),
                kind: listPdict[pid] ? sessionKindOf(listPdict[pid]) : 'programming',
                status: listPsdict[pid]?.status || 0,
                // Students: one task at a time (staff chips carry no gate).
                ...(g ? {
                    gate: g.done.includes(pid) ? 'done'
                        : g.skipped.includes(pid) ? 'skipped'
                            : g.current === pid ? 'current'
                                : g.unlocked.includes(pid) ? 'open' : 'locked',
                } : {}),
            }));
            this.UiContext.slGate = await this.gateView();
            // Bonus tasks (students): the student's own list (rail chips) and
            // whether a new one may be requested; on a bonus task, its state.
            if (this.isStudent) {
                const bonuses = await refreshBonuses(domainId, this.sdoc, this.user._id);
                this.UiContext.slBonuses = bonuses;
                this.UiContext.slBonus = {
                    // 🎁 The teacher's tickbox. The panel hides the button
                    // entirely when a session offers no bonus task, so the
                    // student is never shown a door that cannot open.
                    allowed: bonusAllowed(this.sdoc),
                    eligible: await bonusEligible(domainId, this.sdoc, this.user._id),
                    inProgress: bonuses.some(isBonusBusy),
                    available: aiTutor.tutorEnabled() && aiTutor.tutorConfigured(),
                    count: bonuses.length,
                };
                if (this.bonus) this.UiContext.slBonusTask = bonuses.find((b) => b.docId === this.pdoc.docId) || null;
            }
        } catch (e) { /* the rail is optional */ }
        this.response.template = 'self_learning_solve.html';
        this.response.body = {
            // Same rule as the detail page: the class-wide results table
            // riding on the doc never travels to a student.
            sdoc: this.isStudent ? scrubResults(this.sdoc) : this.sdoc,
            pdoc: this.pdoc,
            langRange,
            problemKind: this.problemKind,
            tutorConfigured: aiTutor.tutorConfigured(),
            tutorEligible: this.tutorEligible,
            isStudent: this.isStudent,
            providerInfo: aiTutor.tutorProviderInfo(),
        };
    }

    @param('lang', Types.Name)
    @param('code', Types.String)
    @param('pretest', Types.Boolean)
    async post({ domainId }, lang: string, code: string, pretest = false) {
        const schedNow = sessionSchedule(this.sdoc);
        /*
         * ⏹ PRACTICE AFTER THE END. A closed session stays usable: the
         * student may keep submitting (and keep talking to the tutor) on its
         * tasks. Nothing of it counts — scoreRecords drops records made past
         * the hard end, every retroactive grader cuts its input at
         * sessionCutoff, and the progress below is not touched either, so
         * the rail and the results keep the picture the deadline froze.
         */
        const practice = this.isStudent && schedNow.phase === 'ended';
        if (this.sessionKind === 'subjective') {
            throw new BadRequestError('Subjective tasks are not judged: submit the report and files from the task page instead.');
        }
        if (this.bonus && !pretest) {
            // The judge (testdata + limits) arrives with the background build.
            const st = await bonusState(domainId, this.bonus.id);
            if (st.status !== 'ready') throw new BadRequestError(st.status === 'failed'
                ? 'The bonus task could not be prepared. Ask for a retry from the task list.'
                : 'The judge for this bonus task is still being prepared — you can keep writing; submissions open in a moment.');
        }
        const config = this.pdoc.config;
        if (typeof config === 'string' || config === null) throw new ProblemConfigError();
        if (['submit_answer', 'objective'].includes(config.type)) {
            lang = '_';
            pretest = false;
        } else if ((config.langs && !config.langs.includes(lang)) || !setting.langs[lang] || setting.langs[lang].disabled) {
            throw new ProblemNotAllowLanguageError();
        }
        let input: string[] = [];
        if (pretest) {
            // Mirror the core submit handler: pretest runs the code against
            // custom input from the Scratchpad, without touching statistics.
            if (setting.langs[lang]?.pretest) lang = setting.langs[lang].pretest as string;
            if (!['default', 'remote_judge'].includes(config.type)) throw new BadRequestError('Pretest is not supported for this problem.');
            const raw = (this.args as any).input;
            input = (Array.isArray(raw) ? raw : [raw]).map((i: any) => String(i ?? ''));
            if (!input.length) throw new ValidationError('input');
        }
        await this.limitRate('add_record', 60, system.get('limit.submission_user'), '{{user}}');
        await this.limitRate('add_record', 60, pretest ? system.get('limit.pretest') : system.get('limit.submission'));
        code = code.replace(/\r\n/g, '\n');
        const lengthLimit = system.get('limit.codelength') || 128 * 1024;
        if (!code.trim()) throw new ValidationError('code');
        if (code.length > lengthLimit) throw new ValidationError('code');
        const rid = await record.add(
            domainId, this.pdoc.docId, this.user._id, lang, code, true,
            pretest ? { input, type: 'pretest' } : { type: 'judge' },
        );
        if (!pretest) {
            await Promise.all([
                problem.inc(domainId, this.pdoc.docId, 'nSubmit', 1),
                domain.incUserInDomain(domainId, this.user._id, 'nSubmit'),
            ]);
        }
        this.response.body = {
            rid: rid.toHexString(),
            // Lateness is decided HERE, per submission — not from whatever
            // phase the client happened to render at page load.
            late: this.isStudent && schedNow.phase === 'extension',
            // ⏹ Practice run: the client says so on the verdict card.
            practice,
            penalty: schedNow.penalty,
        };
    }
}

/* ------------------------------------------------------------------ */
/*  Bonus task: an AI-made challenge aimed at the student's weak points */
/* ------------------------------------------------------------------ */
/*
 * Once a student has attempted every task of the session, the rail offers
 * a Bonus Task. The AI reads the student's work — each task's knowledge
 * points, the submission trajectory, the tutor exchanges, what was skipped
 * — diagnoses the weak points, and writes a brief for ONE new, harder task
 * that exercises exactly those. The AI Studio pipeline then builds it in
 * two phases (see ai_author.ts materializeBonus): the statement first, so
 * the student can open it right away, then the solution, cross-check,
 * tests and sandbox verification in the background. No tutor on bonus
 * tasks: submit, see the verdict, retry.
 */
const BONUS_SYSTEM = `You are the assistant of a programming tutor. From one student's work in a self-learning session you identify the student's WEAK POINTS and design the brief for ONE new programming task that makes them practise exactly those. You never solve anything for the student; you only design practice. You write in English only, whatever language the student's code, comments or the session's tasks use.`;

const BONUS_PROMPT = `Below is a student's complete work in a session: each task with its knowledge points, the student's judged attempts (verdicts, scores, the latest code), and the exchanges with the Socratic tutor. Diagnose and design.
Reply with ONLY JSON:
{"weakPoints": [{"name": string, "evidence": string}], "strengths": [string], "difficulty": "medium"|"challenge", "brief": string}
Rules:
- "weakPoints": 2 to 5 knowledge points the student struggled with — repeated wrong verdicts on the same point, tutor questions answered incorrectly or only after several hints, tasks skipped, patterns visible in the code. Use the EXACT names from the knowledge-point list when they match; "evidence" is one short sentence pointing at the attempts or exchanges that show it.
- "strengths": 1 to 3 points the student clearly handles (so the task does not waste effort there).
- "difficulty": "challenge" when the student solved most tasks quickly, "medium" when they struggled a lot.
- "brief": 4 to 8 sentences describing ONE self-contained programming task (standard input / output, deterministic answer) whose correct solution REQUIRES every weak point, in a FRESH scenario — never a rephrasing of a session task — and harder than the session's tasks. Describe the scenario, the input and output, and which weak points it forces; do not write the full statement or any solution. Write everything in English only.`;

/**
 * 🎁 Does this session offer bonus tasks at all?
 *
 * See SelfLearningDoc.bonusEnabled for the tri-state: only an explicit
 * `false` — the teacher unticking the box — turns the feature off, so
 * sessions saved before the tickbox existed keep behaving exactly as they
 * did. This governs REQUESTING a task; a task a student already owns is
 * deliberately not revoked (see SelfLearningBonusHandler).
 */
export function bonusAllowed(sdoc: Pick<SelfLearningDoc, 'bonusEnabled'>): boolean {
    return sdoc?.bonusEnabled !== false;
}

/** Every session task has at least one judged, non-pretest attempt by the student. */
async function bonusEligible(domainId: string, sdoc: SelfLearningDoc, uid: number): Promise<boolean> {
    // The teacher's tickbox is the first gate: when the session offers no
    // bonus task, nothing else about the student's work matters.
    if (!bonusAllowed(sdoc)) return false;
    if (!sdoc.pids.length) return false;
    const rows = await record.getMulti(domainId, {
        pid: { $in: sdoc.pids }, uid, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
    }).project({ pid: 1 }).toArray();
    const tried = new Set(rows.map((r: any) => r.pid));
    return sdoc.pids.every((pid) => tried.has(pid));
}

/** The statuses in which a bonus task is still being built (the page polls). */
const BONUS_BUSY: ReadonlySet<string> = new Set(['diagnosing', 'drafting', 'building']);
export function isBonusBusy(b: Pick<SelfLearningBonusEntry, 'status'> | null | undefined): boolean {
    return !!b && BONUS_BUSY.has(b.status);
}
/**
 * A diagnosis is one or two LLM calls plus a handful of reads: minutes at
 * the very most. An entry still `diagnosing` after this long has lost its
 * job — the worker that ran it restarted — and, unlike the studio drafts
 * (whose boot sweep marks orphaned runs failed), it has no draft yet for
 * any sweep to find. The reader repairs it instead, so the student sees a
 * retry rather than an eternal spinner. Process-agnostic on purpose: with
 * several workers, a boot-time sweep would misfire on jobs still live
 * elsewhere.
 */
const BONUS_DIAGNOSIS_STALE_MS = 12 * 60 * 1000;

/**
 * Bring ONE stored bonus entry up to date with its draft, and — once the
 * task is verified — make sure it is in the domain's problem set.
 *
 * Shared by the student's own view (refreshBonuses) and the teacher's
 * session-wide board (staffBonusRows), so the two can never disagree about
 * a task's state, and either of them repairs a stranded publication.
 */
async function refreshBonusEntry(
    domainId: string, ssid: ObjectId, uid: number, b: SelfLearningBonusEntry,
): Promise<SelfLearningBonusEntry> {
    let entry = b;
    if (b.status === 'diagnosing') {
        // No draft exists yet — the job writes this entry directly, and
        // bonusState would read the missing draft as "no longer exists".
        const since = new Date(b.startedAt || b.createdAt).getTime();
        if (Number.isFinite(since) && Date.now() - since > BONUS_DIAGNOSIS_STALE_MS) {
            const patch = { status: 'failed' as const, message: 'The diagnosis was interrupted (the server restarted) — retry from the side panel.' };
            try {
                await SelfLearningModel.updateBonus(domainId, ssid, uid, b.id, patch);
                entry = { ...b, ...patch };
            } catch (e) { /* keep the stored state */ }
        }
        return entry;
    }
    if (b.status !== 'ready' && b.status !== 'failed') {
        try {
            const st = await bonusState(domainId, b.id);
            const patch: any = { status: st.status, message: st.message.slice(0, 300) };
            if (st.docId && !b.docId) { patch.docId = st.docId; patch.pid = st.pid; }
            if (st.title && !b.title) patch.title = st.title;
            if (st.status === 'ready' && !b.readyAt) patch.readyAt = new Date();
            await SelfLearningModel.updateBonus(domainId, ssid, uid, b.id, patch);
            entry = { ...b, ...patch };
        } catch (e) { /* keep the stored state */ }
    }
    // 📚 Idempotent and near-free once the task is already visible; see
    // ensureBonusPublished for why this runs on every read instead of
    // trusting the pipeline's single publish write.
    if (entry.status === 'ready') {
        try {
            await ensureBonusPublished(domainId, entry.id);
        } catch (e) { /* the listing must render even if the repair fails */ }
    }
    return entry;
}

/** The client shape of one bonus entry (student panel and teacher board). */
function bonusToClient(entry: SelfLearningBonusEntry) {
    return {
        id: entry.id.toHexString(),
        docId: entry.docId || null,
        pid: entry.pid || null,
        title: entry.title || '',
        status: entry.status,
        message: entry.message || '',
        weakPoints: entry.weakPoints || [],
        createdAt: entry.createdAt,
        startedAt: entry.startedAt || null,
        readyAt: entry.readyAt || null,
    };
}

/** Refresh the student's bonus entries from their drafts and return the client shape. */
async function refreshBonuses(domainId: string, sdoc: SelfLearningDoc, uid: number) {
    const progress = await SelfLearningModel.getProgress(domainId, sdoc.docId, uid);
    const out: any[] = [];
    for (const b of progress?.bonuses || []) {
        out.push(bonusToClient(await refreshBonusEntry(domainId, sdoc.docId, uid, b)));
    }
    return out;
}

/** Teacher board: how many rows one session's bonus listing may hold. */
const STAFF_BONUS_LIMIT = 500;

/**
 * 🎁 TEACHER VIEW — every student's bonus task in this session.
 *
 * A bonus task is generated per student from their own attempts and tutor
 * exchanges, so it is invisible to the teacher everywhere else: it is not
 * one of `sdoc.pids`, and the score board only carries a one-word status
 * per student, and only after an evaluation has been run. This assembles
 * the live picture instead — who has one, what it targets, whether it
 * built, whether it reached the problem set, and how the student did on
 * it — with no dependency on the evaluation having run.
 *
 * Batched by design: one progress query, one user lookup, one problem
 * lookup and one record scan for the whole session, plus a per-entry draft
 * read for the few tasks still building.
 */
async function staffBonusRows(domainId: string, sdoc: SelfLearningDoc) {
    const progresses = await collProgress
        .find({ domainId, ssid: sdoc.docId, 'bonuses.0': { $exists: true } })
        .limit(STAFF_BONUS_LIMIT).toArray();
    if (!progresses.length) return [];
    const entries: { uid: number, entry: SelfLearningBonusEntry }[] = [];
    for (const p of progresses) {
        for (const b of p.bonuses || []) {
            entries.push({ uid: p.uid, entry: await refreshBonusEntry(domainId, sdoc.docId, p.uid, b) });
        }
    }
    if (!entries.length) return [];
    const uids = [...new Set(entries.map((e) => e.uid))];
    const docIds = [...new Set(entries.map((e) => e.entry.docId).filter((x): x is number => !!x))];
    const [udict, pdict] = await Promise.all([
        user.getList(domainId, uids),
        // canViewHidden: true — a task still building is legitimately
        // hidden, and the teacher's board must still name it.
        docIds.length
            ? problem.getList(domainId, docIds, true, false, problem.PROJECTION_LIST, true)
            : Promise.resolve({} as any),
    ]);
    /*
     * The owning student's work on their own bonus task. Same filters the
     * session uses everywhere else (no pretests, nothing still judging),
     * and keyed by uid AND pid: now that finished bonus tasks live in the
     * problem set, other people's submissions on them must not leak into
     * a row.
     */
    const byKey = new Map<string, { attempts: number, best: number, accepted: boolean, lastAt: Date | null }>();
    if (docIds.length) {
        const rdocs = await record.getMulti(domainId, {
            pid: { $in: docIds },
            uid: { $in: uids },
            contest: { $ne: record.RECORD_PRETEST },
            status: { $nin: JUDGING },
        }).project({ pid: 1, uid: 1, score: 1, status: 1 }).limit(20000).toArray();
        for (const r of rdocs as any[]) {
            const key = `${r.uid}/${r.pid}`;
            const cur = byKey.get(key) || { attempts: 0, best: 0, accepted: false, lastAt: null };
            const at = r._id.getTimestamp();
            cur.attempts += 1;
            cur.best = Math.max(cur.best, r.score || 0);
            cur.accepted ||= r.status === STATUS.STATUS_ACCEPTED;
            if (!cur.lastAt || at > cur.lastAt) cur.lastAt = at;
            byKey.set(key, cur);
        }
    }
    const rows = entries.map(({ uid, entry }) => {
        const udoc: any = udict[uid];
        const pdoc: any = entry.docId ? pdict[entry.docId] : null;
        const stat = entry.docId ? byKey.get(`${uid}/${entry.docId}`) : null;
        return {
            ...bonusToClient(entry),
            uid,
            uname: udoc?.uname || String(uid),
            name: `${udoc?.firstName || ''} ${udoc?.lastName || ''}`.trim(),
            // The problem may have been deleted by hand; `null` then, and
            // the row renders as unavailable rather than linking nowhere.
            problemPid: pdoc ? (pdoc.pid || String(pdoc.docId)) : null,
            problemTitle: pdoc?.title || '',
            // 📚 The point of the reconciliation above, made visible: a
            // verified task should always read as in the problem set.
            inProblemSet: !!pdoc && !pdoc.hidden,
            difficulty: pdoc?.difficulty || 0,
            tag: pdoc?.tag || [],
            attempts: stat?.attempts || 0,
            best: stat?.best || 0,
            accepted: !!stat?.accepted,
            lastAt: stat?.lastAt || null,
        };
    });
    // Roster order: the teacher scans this against a class list, so sort by
    // the name they know, falling back to the login id.
    rows.sort((a, b) => (a.name || a.uname).localeCompare(b.name || b.uname) || a.uid - b.uid);
    return rows;
}

/**
 * 🎁 The bonus task's BACKGROUND JOB — detached from the request that
 * started it, so a page refresh (or the student simply leaving) at any
 * moment disturbs nothing: the entry was written under `id` before this
 * runs, every step updates it, and the page only ever watches.
 *
 *   1. read the student's whole body of work in the session;
 *   2. DIAGNOSE — one LLM call (one retry on malformed JSON) names the
 *      weak points and briefs the task; the weak points land on the entry
 *      at once, so the rail can show what the task will target;
 *   3. create the AI Studio draft UNDER THE PRE-GENERATED ID, then hand
 *      over to materializeBonus (statement → problem) which itself chains
 *      the verification pipeline (solution, tests, sandbox) — each phase
 *      as much a background job as this one.
 * Any failure lands on the entry as `failed` with its reason; postRetry
 * re-runs whichever phase failed.
 */
async function runBonusDiagnosis(domainId: string, sdoc: SelfLearningDoc, uid: number, id: ObjectId): Promise<void> {
    const ssid = sdoc.docId;
    const setEntry = (patch: Partial<SelfLearningBonusEntry>) => SelfLearningModel.updateBonus(domainId, ssid, uid, id, patch);
    try {
        // ---- the student's work, task by task ----
        const pdict = await problem.getList(domainId, sdoc.pids, true, false, problem.PROJECTION_CONTEST_LIST, true);
        const progress = await SelfLearningModel.getProgress(domainId, sdoc.docId, uid);
        const langCount = new Map<string, number>();
        const blocks: string[] = [];
        for (const pid of sdoc.pids) {
            const pdoc = pdict[pid];
            if (!pdoc) continue;
            const recs = await record.getMulti(domainId, { pid, uid, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING } })
                .sort({ _id: 1 }).limit(20).project({ status: 1, score: 1, lang: 1, code: 1 }).toArray();
            for (const r of recs as any[]) if (r.lang) langCount.set(r.lang, (langCount.get(r.lang) || 0) + 1);
            const trajectory = (recs as any[]).map((r, i) => `${i + 1}:${STATUS_SHORT_TEXTS[r.status] || STATUS_TEXTS[r.status] || r.status}${r.score ? `(${r.score})` : ''}`).join(' → ');
            const last = (recs as any[])[recs.length - 1];
            const thread = await SelfLearningModel.getThread(domainId, sdoc.docId, pid, uid);
            const exchanges = (thread?.messages || []).filter((m: any) => m.kind === 'anno').slice(-10)
                .map((m: any) => `${m.role === 'user' ? 'STUDENT' : 'TUTOR'}${m.line ? ` [line ${m.line}]` : ''}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
            const state = progress?.done?.includes(pid) ? 'finished' : progress?.skipped?.includes(pid) ? 'SKIPPED' : 'in progress';
            blocks.push([
                `=== TASK ${pdoc.pid || pid}: ${pdoc.title} [${state}] ===`,
                `Knowledge points: ${(await KnowledgeModel.describeTags(domainId, (pdoc.tag || []).map((t: any) => String(t)))).join('; ') || '(none)'}`,
                `Attempts: ${trajectory || '(none)'}`,
                last?.code ? `Latest code (${last.lang}):\n${String(last.code).slice(0, 1200)}` : '',
                exchanges ? `Tutor exchanges:\n${exchanges}` : 'Tutor exchanges: (none)',
            ].filter((x) => x).join('\n'));
        }
        const language = [...langCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || sdoc.pids.length && (pdict[sdoc.pids[0]]?.config as any)?.langs?.[0] || 'cc.cc17';
        // 🌳 The tree, so a weak point can be named at the right grain and
        // a NEW one placed under the topic it belongs to.
        const catalogBlock = await KnowledgeModel.promptCatalog(domainId, { title: 'KNOWLEDGE-POINT CATALOG of this course (use exact names)', budget: 6000, descriptions: false });
        const raw = await aiTutor.callProvider(BONUS_SYSTEM, [{
            role: 'user',
            content: [BONUS_PROMPT, catalogBlock, blocks.join('\n\n').slice(0, 24000)].filter((x) => x).join('\n\n'),
        }], { temperature: 0.4 });
        let j: any;
        try {
            j = parseJsonLoose(raw);
        } catch (e) {
            const retry = await aiTutor.callProvider(BONUS_SYSTEM, [
                { role: 'user', content: [BONUS_PROMPT, catalogBlock, blocks.join('\n\n').slice(0, 24000)].filter((x) => x).join('\n\n') },
                { role: 'assistant', content: raw.slice(0, 6000) },
                { role: 'user', content: 'Your previous reply was not valid JSON. Reply again with ONLY the JSON value.' },
            ], { temperature: 0 });
            j = parseJsonLoose(retry);
        }
        const weak: { name: string, description?: string }[] = [];
        for (const w of (Array.isArray(j?.weakPoints) ? j.weakPoints : []).slice(0, 5)) {
            const name = KnowledgeModel.normalizeName(w?.name);
            if (!name) continue;
            const canonical = await KnowledgeModel.resolve(domainId, name);
            const doc = canonical ? await KnowledgeModel.getByName(domainId, canonical) : null;
            weak.push(doc?.description ? { name: doc.name, description: doc.description } : { name: canonical || name });
        }
        const brief = String(j?.brief || '').trim();
        if (!brief) throw new Error('The AI could not design a bonus task from your work yet. Please retry.');
        const evidence = (Array.isArray(j?.weakPoints) ? j.weakPoints : []).map((w: any) => `- ${w?.name}: ${w?.evidence || ''}`).join('\n');
        const titles = sdoc.pids.map((pid) => pdict[pid]?.title).filter((x) => x).join('; ');
        await createBonusDraft(domainId, sdoc.owner, {
            topic: brief,
            notes: [
                'This is a BONUS TASK generated for ONE student who has attempted every task of a self-learning session. It exists to make them practise their weak points.',
                `Weak points (evidence from their work):\n${evidence}`,
                (Array.isArray(j?.strengths) && j.strengths.length) ? `Already solid (do not center the task on these): ${j.strengths.join('; ')}` : '',
                `Must be clearly harder than the session's tasks and use a fresh scenario. Never reuse or rephrase these: ${titles}.`,
                'Single program, standard input/output, deterministic output. Keep the statement self-contained; do not mention that it targets weak points.',
            ].filter((x) => x).join('\n\n'),
            language,
            difficulty: j?.difficulty === 'medium' ? 'medium' : 'challenge',
            knowledge: weak,
        }, { ssid: sdoc.docId, uid }, id);
        await setEntry({ status: 'drafting', message: 'Drafting the statement…', weakPoints: weak.map((w) => w.name) });
        // Phase 1: the statement, then the problem; phase 2 (solution,
        // tests, verification) follows on its own inside materializeBonus.
        const m = await materializeBonus(domainId, id);
        await setEntry({ docId: m.docId, pid: m.pid, title: m.title, status: 'building', message: 'Preparing the judge…' });
    } catch (e) {
        logger.warn('[self-learning] bonus job %s for user %d failed: %s', id.toHexString(), uid, e.message);
        await setEntry({ status: 'failed', message: String(e.message || e).slice(0, 300) }).catch(() => { /* nothing left to record on */ });
    }
}

class SelfLearningBonusHandler extends Handler {
    sdoc: SelfLearningDoc;

    @param('ssid', Types.ObjectId)
    async prepare({ domainId }, ssid: ObjectId) {
        this.sdoc = await loadSession(domainId, ssid);
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) throw new ForbiddenError('Please sign in.');
        // Same student test as the task surfaces: staff have the Studio.
        const staff = this.user.own(this.sdoc) || this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK) || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
        if (staff) throw new ForbiddenError('Bonus tasks are generated for students of the session.');
        if (sessionSchedule(this.sdoc).phase === 'notStarted') throw new ForbiddenError('This session has not started yet.');
    }

    async get({ domainId }) {
        const bonuses = await refreshBonuses(domainId, this.sdoc, this.user._id);
        this.response.body = {
            bonuses,
            // The teacher's tickbox, so the side panel can say "this session
            // offers none" instead of "finish every task first".
            allowed: bonusAllowed(this.sdoc),
            eligible: await bonusEligible(domainId, this.sdoc, this.user._id),
            inProgress: bonuses.some(isBonusBusy),
            available: aiTutor.tutorEnabled() && aiTutor.tutorConfigured(),
        };
    }

    /** Diagnose the student's weak points and start a new bonus task. */
    async postCreate({ domainId }) {
        // Explicit gate ahead of bonusEligible, which also checks it: this
        // is the one that produces a message naming the real reason, so a
        // crafted POST cannot look like "you have not finished the tasks".
        if (!bonusAllowed(this.sdoc)) throw new ForbiddenError('This session does not offer a bonus task.');
        if (!(aiTutor.tutorEnabled() && aiTutor.tutorConfigured())) throw new ForbiddenError('The AI assistant is not configured. Please ask the administrator to set an API key.');
        if (!await bonusEligible(domainId, this.sdoc, this.user._id)) throw new BadRequestError('Attempt every task of the session first — then a bonus task can be made for you.');
        // ONE bonus task per student per session: it is the session's
        // capstone, built from the whole body of work. A failed build can be
        // retried (postRetry); a second task is never created.
        const existing = await refreshBonuses(domainId, this.sdoc, this.user._id);
        if (existing.length) {
            const b = existing[0];
            throw new BadRequestError(b.status === 'failed'
                ? 'Your bonus task could not be prepared — retry it from the side panel instead of creating another.'
                : 'This session already has your bonus task; each session offers exactly one.');
        }
        await this.limitRate('ai_tutor', 60, 3, '{{user}}');
        const uid = this.user._id;
        /*
         * The entry is recorded FIRST, under the draft id the job will
         * create, and the response leaves at once: from here on the build
         * is runBonusDiagnosis's business, and this page — or any reload
         * of it — just polls the entry. It also closes the old race in
         * which a refresh during the (long, silent) diagnosis showed the
         * button again and a second click started a second diagnosis.
         */
        const id = new ObjectId();
        const now = new Date();
        const entry: SelfLearningBonusEntry = {
            id, status: 'diagnosing', message: 'Reading your attempts and tutor exchanges…', weakPoints: [], createdAt: now, startedAt: now,
        };
        await SelfLearningModel.addBonus(domainId, this.sdoc.docId, uid, entry);
        runBonusDiagnosis(domainId, this.sdoc, uid, id); // detached on purpose — never awaited
        this.response.body = { bonus: bonusToClient(entry) };
    }

    /** Retry a failed bonus build — whichever phase failed. */
    @param('id', Types.ObjectId)
    async postRetry({ domainId }, id: ObjectId) {
        const progress = await SelfLearningModel.getProgress(domainId, this.sdoc.docId, this.user._id);
        const b = (progress?.bonuses || []).find((x) => x.id.equals(id));
        if (!b) throw new NotFoundError(id);
        if (b.status !== 'failed') throw new BadRequestError('Only a failed bonus task can be retried.');
        await this.limitRate('ai_tutor', 60, 3, '{{user}}');
        const ssid = this.sdoc.docId;
        const uid = this.user._id;
        // A failure BEFORE the draft existed (the diagnosis itself, or an
        // interrupted one) is retried by running the diagnosis again —
        // there is nothing in the studio to resume yet.
        if (!await hasBonusDraft(domainId, id)) {
            const now = new Date();
            await SelfLearningModel.updateBonus(domainId, ssid, uid, id, {
                status: 'diagnosing', message: 'Reading your attempts and tutor exchanges…', startedAt: now,
            });
            runBonusDiagnosis(domainId, this.sdoc, uid, id); // detached, like postCreate
            this.response.body = { ok: 1 };
            return;
        }
        await SelfLearningModel.updateBonus(domainId, ssid, uid, id, { status: b.docId ? 'building' : 'drafting', message: 'Retrying…' });
        retryBonus(domainId, id).catch(async (e) => {
            await SelfLearningModel.updateBonus(domainId, ssid, uid, id, { status: 'failed', message: String(e.message || e).slice(0, 300) });
        });
        this.response.body = { ok: 1 };
    }
}

/*
 * Skip: after at least one judged attempt and still being stuck, the student
 * sets the CURRENT task aside and moves on; it stays open for a retry any
 * time. Its own sub-route (like /tutor and /record): the framework runs the
 * solve handler's plain post() — the code submission — before ANY operation
 * post, so a skip operation on the solve URL would hit the submission's
 * validators first.
 */
class SelfLearningSkipHandler extends SelfLearningProblemBaseHandler {
    async post({ domainId }) {
        if (!this.isStudent) throw new ForbiddenError('Only students move through a session one task at a time.');
        const view = await this.gateView();
        if (!view || !view.isCurrent) throw new BadRequestError('Only the current task can be skipped.');
        if (!view.engaged) throw new BadRequestError('Submit at least one attempt first — then you may skip this task.');
        await SelfLearningModel.markSkipped(domainId, this.sdoc.docId, this.user._id, this.pdoc.docId);
        const gate = await this.refreshGate(domainId, true);
        this.response.body = {
            gate,
            nextUrl: gate?.current
                ? this.url('self_learning_solve', { ssid: this.sdoc.docId, pid: gate.current })
                : this.url('self_learning_detail', { ssid: this.sdoc.docId }),
        };
    }
}

class SelfLearningRecordHandler extends SelfLearningProblemBaseHandler {
    @param('rid', Types.ObjectId, true)
    @param('full', Types.Boolean)
    async get({ domainId }, rid?: ObjectId, full = false) {
        if (!rid) {
            // History mode: the solve page's "Submitted code" panel asks for the
            // requesting user's own trajectory on this problem, no rid needed.
            this.response.body = { attempts: await this.submissionTrajectory(domainId, this.user._id) };
            return;
        }
        const rdoc = await record.get(domainId, rid);
        if (!rdoc || rdoc.pid !== this.pdoc.docId) throw new NotFoundError(domainId, rid);
        if (rdoc.uid !== this.user._id && !this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) throw new PermissionError();
        const judged = !JUDGING.includes(rdoc.status);
        // Progression: the first judged attempt makes Skip available; an
        // accepted verdict with no tutor to answer to finishes the task.
        let gate: any = null;
        if (judged && rdoc.uid === this.user._id && this.isStudent) {
            const noTutor = !(aiTutor.tutorEnabled() && aiTutor.tutorConfigured() && this.tutorEligible);
            gate = (rdoc.status === STATUS.STATUS_ACCEPTED && noTutor) ? await this.finishTask(domainId) : await this.refreshGate(domainId, true);
        }
        this.response.body = {
            gate,
            rid: rid.toHexString(),
            status: rdoc.status,
            statusText: STATUS_TEXTS[rdoc.status] || `${rdoc.status}`,
            shortText: STATUS_SHORT_TEXTS[rdoc.status] || '',
            accepted: rdoc.status === STATUS.STATUS_ACCEPTED,
            judged,
            score: rdoc.score || 0,
            time: rdoc.time || 0,
            memory: rdoc.memory || 0,
            lang: rdoc.lang || '',
            code: typeof rdoc.code === 'string' ? rdoc.code.slice(0, 8000) : '',
            submitAt: rdoc._id.getTimestamp().getTime(),
            judgeAt: rdoc.judgeAt ? new Date(rdoc.judgeAt).getTime() : null,
            compilerTexts: (rdoc.compilerTexts || []).join('\n').slice(0, 4000),
            judgeTexts: (rdoc.judgeTexts || [])
                .map((t: any) => (typeof t === 'string' ? t : t?.message || ''))
                .filter((t: string) => t).join('\n').slice(0, 2000),
            cases: (rdoc.testCases || []).slice(0, 60).map((c: any) => ({
                id: c.id,
                subtaskId: c.subtaskId,
                status: c.status,
                statusText: STATUS_TEXTS[c.status] || STATUS_SHORT_TEXTS[c.status] || `${c.status}`,
                message: (typeof c.message === 'string' ? c.message : (c.message?.message || '')).slice(0, 200),
                score: c.score,
                time: c.time,
                memory: c.memory,
            })),
        };
        if (full) {
            const uiLang = this.user.viewLang || this.session.viewLang || system.get('server.language') || 'en';
            this.response.body.problem = {
                pid: this.pdoc.pid || this.pdoc.docId,
                title: this.pdoc.title || '',
                kind: this.problemKind,
                statementRaw: aiTutor.resolveStatement(this.pdoc, uiLang).slice(0, 40000),
            };
            // The submission trajectory of the record's owner on this problem
            // (oldest first), so the tutor window can show every attempt's code.
            this.response.body.attempts = await this.submissionTrajectory(domainId, rdoc.uid);
        }
    }
}

class SelfLearningTutorHandler extends SelfLearningProblemBaseHandler {
    /** ⏹ After the session's hard end the tutor answers but grades nothing. */
    get practice(): boolean {
        return !!this.sdoc && sessionSchedule(this.sdoc).phase === 'ended';
    }

    checkTutorAllowed() {
        if (!aiTutor.tutorEnabled()) throw new ForbiddenError('The AI tutor is disabled.');
        if (!aiTutor.tutorConfigured()) throw new ForbiddenError('The AI tutor is not configured. Please ask the administrator to set an API key.');
        /*
         * ⏯ The tutor stays OPEN after the session ends — a student may keep
         * practising and keep talking to it — but from that moment it runs in
         * PRACTICE MODE: the dialogue is stored so the student can re-read
         * it, and nothing else is. No walkthrough question is added, no
         * answer is graded, no integrity flag is raised: the ownership,
         * reasoning, fix-conversion and initiative evidence the score is
         * built from is frozen exactly as the deadline left it (the graders
         * also cut their inputs at sessionCutoff, so a late message could
         * not reach them even if one were stored).
         */
        // Programming tasks only — every operation of this handler, history
        // included, is refused for objective / subjective / answer tasks.
        if (!this.tutorEligible) throw new ForbiddenError('The AI tutor is only available for programming tasks.');
        if (!this.isStudent) throw new ForbiddenError('The AI tutor is only available to student accounts.');
    }

    async tutorCtx(rdoc: RecordDoc | null, attemptCount: number, everAccepted: boolean): Promise<aiTutor.TutorTurnContext> {
        const uiLang = this.user.viewLang || this.session.viewLang || system.get('server.language') || 'en';
        const problemKind = this.problemKind;
        let attempts: aiTutor.TutorAttempt[] | undefined;
        if (rdoc) {
            // Requirement: every tutor turn sees the WHOLE submission history so
            // its questions stay consistent across resubmissions. Older attempts
            // are truncated harder; the latest rdoc is excluded (it appears in
            // full as the focal submission).
            try {
                const latest = rdoc._id.toHexString();
                attempts = (await this.submissionTrajectory(this.args.domainId, this.user._id, 9))
                    .filter((a) => a.rid !== latest)
                    .slice(-8)
                    .map((a) => ({
                        statusText: a.statusText,
                        score: a.score,
                        lang: a.lang,
                        accepted: a.accepted,
                        code: (a.code || '').slice(0, 2000),
                    }));
                if (!attempts.length) attempts = undefined;
            } catch (e) { /* history is best-effort context */ }
        }
        return {
            pdoc: this.pdoc,
            rdoc,
            attemptCount,
            everAccepted,
            uiLang,
            problemKind,
            attempts,
        };
    }

    async everAccepted(domainId: string) {
        const psdoc = await problem.getStatus(domainId, this.pdoc.docId, this.user._id);
        return psdoc?.status === STATUS.STATUS_ACCEPTED;
    }

    /** Serialize a stored message for the client, keeping card metadata. */
    static mapMsg(m: TutorMessage) {
        return {
            role: m.role, kind: m.kind, content: m.content, line: m.line, endLine: m.endLine, resolved: m.resolved, level: m.level, rlevel: m.rlevel,
        };
    }

    /**
     * Every judged submission gets exactly one divider in the thread. The
     * pop-up cards are the interaction channel, so this is shared
     * bookkeeping between postAnnotate and postAnnotateReply (and the
     * chat-style postAccepted). Returns the divider text when one was just
     * created so the client can mirror it live.
     */
    async ensureAttemptMarker(domainId: string, rdoc: RecordDoc): Promise<{ thread: TutorThreadDoc, marker: string | null, accepted: boolean }> {
        const accepted = rdoc.status === STATUS.STATUS_ACCEPTED;
        let thread = await SelfLearningModel.ensureThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        if (thread.rid && thread.rid.toHexString() === rdoc._id.toHexString()) return { thread, marker: null, accepted };
        const attemptCount = (thread.attemptCount || 0) + 1;
        const content = `Attempt #${attemptCount} — verdict: ${STATUS_TEXTS[rdoc.status] || rdoc.status} (score ${rdoc.score || 0}).`;
        await SelfLearningModel.pushMessages(thread._id, [
            { role: 'user', kind: accepted ? 'accepted' : 'attempt', content },
        ], { rid: rdoc._id, attemptCount });
        thread = await SelfLearningModel.getThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        return { thread, marker: content, accepted };
    }

    async get() {
        this.checkTutorAllowed();
        const thread = await SelfLearningModel.getThread(this.args.domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        this.response.body = {
            messages: (thread?.messages || []).map(SelfLearningTutorHandler.mapMsg),
            attemptCount: thread?.attemptCount || 0,
        };
    }

    async loadOwnRecord(domainId: string, rid: ObjectId) {
        const rdoc = await record.get(domainId, rid);
        if (!rdoc || rdoc.pid !== this.pdoc.docId || rdoc.uid !== this.user._id) throw new NotFoundError(domainId, rid);
        // Pretest runs are not submissions: they must neither create attempt
        // dividers (which would corrupt the walkthrough budget) nor start a
        // post-"acceptance" walkthrough of their own.
        if (rdoc.contest && String(rdoc.contest) === String(record.RECORD_PRETEST)) {
            throw new BadRequestError('Pretest runs cannot be tutored — submit your solution first.');
        }
        if (!aiTutor.isJudged(rdoc)) throw new BadRequestError('This submission has not been judged yet.');
        return rdoc;
    }

    @param('rid', Types.ObjectId)
    async postStart({ domainId }, rid: ObjectId) {
        this.checkTutorAllowed();
        await this.limitRate('ai_tutor', 60, 10, '{{user}}');
        const rdoc = await this.loadOwnRecord(domainId, rid);
        const accepted = rdoc.status === STATUS.STATUS_ACCEPTED;
        let thread = await SelfLearningModel.ensureThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        const sameRid = !!(thread.rid && thread.rid.toHexString() === rid.toHexString() && thread.messages.length);
        const lastMsg = thread.messages[thread.messages.length - 1];
        // Reopening the chat on the same submission: just return existing history.
        if (sameRid && lastMsg?.role === 'assistant') {
            this.response.body = {
                messages: thread.messages.map(SelfLearningTutorHandler.mapMsg),
                };
            return;
        }
        // First tutoring turn if the tutor has never spoken in this thread yet.
        const isFirst = !thread.messages.some((m) => m.role === 'assistant');
        let attemptCount = thread.attemptCount || 0;
        if (!sameRid) {
            // A brand-new submission: record it as an attempt divider.
            attemptCount += 1;
            const marker: Omit<TutorMessage, 'at'> = {
                role: 'user',
                kind: accepted ? 'accepted' : 'attempt',
                content: `Attempt #${attemptCount} — verdict: ${STATUS_TEXTS[rdoc.status] || rdoc.status} (score ${rdoc.score || 0}).`,
            };
            await SelfLearningModel.pushMessages(thread._id, [marker], { rid, attemptCount });
            thread = await SelfLearningModel.getThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        }
        // If sameRid but the last message is not from the assistant, a previous
        // provider call failed after the marker was stored — retry the reply only.
        const ctx = await this.tutorCtx(rdoc, attemptCount || 1, await this.everAccepted(domainId));
        const directive = accepted
            ? (isFirst ? aiTutor.ACCEPTED_OPENING_DIRECTIVE : aiTutor.ACCEPTED_DIRECTIVE)
            : (isFirst ? aiTutor.OPENING_DIRECTIVE : aiTutor.RESUBMIT_DIRECTIVE);
        const reply = await aiTutor.runTutorTurn(ctx, thread.messages, directive);
        await SelfLearningModel.pushMessages(thread._id, [{ role: 'assistant', kind: 'chat', content: reply }]);
        const messages = [...thread.messages, { role: 'assistant', kind: 'chat', content: reply }];
        this.response.body = {
            messages: messages.map((m: any) => SelfLearningTutorHandler.mapMsg(m)),
        };
    }

    @param('rid', Types.ObjectId)
    @param('asked', Types.String, true)
    async postAnnotate({ domainId }, rid: ObjectId, asked = '') {
        this.checkTutorAllowed();
        if (this.problemKind !== 'programming') {
            this.response.body = { annotation: null };
            return;
        }
        await this.limitRate('ai_tutor', 60, 10, '{{user}}');
        let askedList: string[] = [];
        try {
            const parsed = JSON.parse(asked || '[]');
            if (Array.isArray(parsed)) askedList = parsed.map((q) => String(q)).slice(0, 12);
        } catch (e) { /* ignore malformed asked lists */ }
        const rdoc = await this.loadOwnRecord(domainId, rid);
        // The pop-up cards are the interaction channel for programming
        // problems, so this endpoint owns the attempt bookkeeping and
        // persists every card question into the thread — the red launcher
        // replays that history read-only.
        const { thread, marker, accepted } = await this.ensureAttemptMarker(domainId, rdoc);
        const ctx = await this.tutorCtx(rdoc, thread?.attemptCount || 1, await this.everAccepted(domainId));
        // Guided-session chaining: the client sends the CURRENT editor code so
        // the next question targets what the student sees (fixed flaws are
        // skipped, anchors match the live line numbers).
        if (typeof this.args.code === 'string' && this.args.code.trim()) {
            ctx.liveCode = String(this.args.code).slice(0, 8000);
        }
        /*
         * 🎓 CODE-OWNERSHIP walkthrough — the 20-point per-task sub-rubric
         * (task earns mean(level) × 5): once a submission is ACCEPTED, the
         * tutor asks a short sequence of questions probing whether the
         * student can explain THEIR OWN code, and the LLM grades each
         * answer 0..4 (postAnnotateReply). The question budget is fixed at
         * the FIRST acceptance — 5..6 questions when that acceptance was
         * the very first attempt, 2..3 otherwise — and later
         * re-acceptances continue the same unfinished sequence rather than
         * re-rolling it.
         */
        let ownership: OwnershipState | undefined;
        if (accepted && thread) {
            if (!thread.ownership) {
                // The budget follows the RECORD history, not the thread's
                // witnessed counter: attempts made on the plain problem page
                // never reach this tutor, yet they are attempts — passing on
                // the first session-page submission after failing elsewhere
                // must NOT earn the 5..6 first-attempt budget.
                const cls = await acceptedOnFirstAttempt(domainId, this.user._id, this.pdoc.docId)
                    || { firstAttempt: (thread.attemptCount || 1) <= 1, attemptNo: thread.attemptCount || 1 };
                const budget = ownershipBudget(cls.firstAttempt);
                const fresh: OwnershipState = {
                    acceptedAttempt: cls.attemptNo, minQ: budget.min, maxQ: budget.max, questions: [],
                };
                if (!this.practice) await SelfLearningModel.initOwnership(thread._id, fresh);
                thread.ownership = fresh;
            }
            ownership = thread.ownership;
            // ⭐ Inherit any deepened budget before gating on the stored one.
            await reconcileOwnershipBudget(thread);
            // Reload-safe dedup: the client's asked list dies with the page,
            // but the stored walkthrough questions do not — merge them so
            // the model never repeats an aspect after a refresh.
            for (const q of ownership.questions) if (!askedList.includes(q.question)) askedList.push(q.question);
            askedList = askedList.slice(-12);
            if (ownership.done || ownership.questions.length >= ownership.maxQ) {
                // Budget spent (or the model already closed the walkthrough):
                // finish without another model call.
                if (!this.practice && !ownership.done) await SelfLearningModel.setOwnershipDone(thread._id);
                const doneGate = await this.finishTask(domainId);
                this.response.body = {
                    annotation: null, marker, markerAccepted: accepted, gate: doneGate,
                };
                return;
            }
            ctx.ownership = { asked: ownership.questions.length, min: ownership.minQ, max: ownership.maxQ };
        }
        const annotation = await aiTutor.runAnnotationTurn(ctx, askedList);
        if (annotation && thread) {
            await SelfLearningModel.pushMessages(thread._id, [{
                role: 'assistant', kind: 'anno', content: annotation.question, line: annotation.line, endLine: annotation.endLine,
            }]);
            if (accepted && ownership) {
                // The sliced text is the dedup/grade key postAnnotateReply
                // matches on, so store exactly what the reply will send —
                // and only ONCE: should the model ever repeat a question
                // verbatim despite the asked list, a second entry would sit
                // unanswered forever and drag the mean with a phantom L0.
                const qkey = String(annotation.question).slice(0, 300);
                if (!(ownership.questions || []).find((x) => x.question === qkey)) {
                    if (!this.practice) await SelfLearningModel.pushOwnershipQuestion(thread._id, {
                        question: qkey, line: annotation.line, at: new Date(), levels: [],
                    });
                }
            }
        }
        if (accepted && !annotation && thread && ownership && !ownership.done) {
            /*
             * Null PAST the minimum = the model genuinely closed the
             * walkthrough. Null BELOW it is a transient failure (provider
             * hiccup, malformed JSON): the task still finishes — progression
             * is never hostage to the LLM — but the walkthrough stays OPEN,
             * so a later accepted submission (or the gate's "Answer the
             * tutor" button) resumes the remaining questions instead of
             * freezing this task at an unfixable, unmeasured state.
             */
            if (!this.practice && ownership.questions.length >= ownership.minQ) await SelfLearningModel.setOwnershipDone(thread._id);
        }
        // Progression: accepted and nothing left for the tutor to ask → the
        // task is finished right away (the walkthrough's later questions
        // route back through this endpoint, which finishes once the budget
        // is spent or the model closes the sequence).
        const gate = (accepted && !annotation) ? await this.finishTask(domainId) : await this.gateView();
        this.response.body = {
            annotation,
            marker,
            markerAccepted: accepted,
            gate,
            // Walkthrough progress for the card's subtle indicator — counts
            // only, never grades (per-answer levels are embargoed).
            ...(accepted && ownership && annotation
                ? { ownership: { asked: ownership.questions.length + 1, min: ownership.minQ, max: ownership.maxQ } }
                : {}),
        };
    }

    @param('rid', Types.ObjectId)
    @param('line', Types.UnsignedInt)
    @param('question', Types.String)
    @param('text', Types.String)
    @param('endLine', Types.UnsignedInt, true)
    @param('history', Types.String, true)
    async postAnnotateReply({ domainId }, rid: ObjectId, line: number, question: string, text: string, endLine = 0, history = '') {
        this.checkTutorAllowed();
        if (this.problemKind !== 'programming') throw new BadRequestError('Line annotations are only available for programming problems.');
        await this.limitRate('ai_tutor', 60, 10, '{{user}}');
        let turns: { role: string, content: string }[] = [];
        try {
            const parsed = JSON.parse(history || '[]');
            if (Array.isArray(parsed)) {
                turns = parsed
                    .filter((t) => t && typeof t === 'object')
                    .map((t) => ({ role: String(t.role || ''), content: String(t.content || '').slice(0, 800) }))
                    .slice(-12);
            }
        } catch (e) { /* ignore malformed history */ }
        const rdoc = await this.loadOwnRecord(domainId, rid);
        const { thread } = await this.ensureAttemptMarker(domainId, rdoc);
        const maxMessages = +system.get('ai_tutor.max_messages') || 80;
        // The length limit never strands an ACCEPTED walkthrough: a student
        // who chatted a lot before passing must still be able to answer the
        // ownership questions (the walkthrough itself is bounded by maxQ),
        // otherwise unanswered questions would force level-0 grades.
        if (thread.messages.length >= maxMessages && rdoc.status !== STATUS.STATUS_ACCEPTED) {
            throw new BadRequestError('This tutoring conversation reached its length limit. Please reset it to continue.');
        }
        /*
         * AUDIT: the LLM judge is fed the SERVER-RECORDED transcript of
         * this question (dialogueHistoryFor), not the browser-supplied
         * history — every student–tutor exchange is persisted in the
         * thread, so the stored record IS the grading context. The client
         * turns remain only as a fallback for questions that predate the
         * walkthrough (legacy reflection cards, absent from the store).
         */
        const serverTurns = dialogueHistoryFor(thread, question.slice(0, 300));
        if (serverTurns) turns = serverTurns;
        // 🚫 Deterministic pre-check: an answer that tries to steer the
        // grader never reaches the LLM — it stores level 0 on the
        // corresponding sub-rubric and gets a fixed integrity notice.
        const manip = aiTutor.detectGraderManipulation([text]);
        if (manip.hit && thread) {
            const accepted = rdoc.status === STATUS.STATUS_ACCEPTED;
            const sub = accepted ? 'own' as const : 'rea' as const;
            const notice = 'This answer contains instructions aimed at the grader, so it is scored 0 for this exchange. '
                + 'Please answer the question itself. / 该回答包含试图操纵评分的指令，本次交流计 0 分。请针对问题本身作答。';
            const userIdx = (thread.messages || []).length;
            await SelfLearningModel.pushMessages(thread._id, [
                { role: 'user', kind: 'anno', content: text.slice(0, 2000), at: new Date(), line, endLine } as any,
                { role: 'assistant', kind: 'anno', content: notice, at: new Date(), line, endLine, resolved: false } as any,
            ]);
            if (accepted) {
                const qkey = question.slice(0, 300);
                let q0 = (thread.ownership?.questions || []).find((qq) => qq.question === qkey);
                if (!q0) {
                    q0 = { question: qkey, line, at: new Date(), levels: [], answerKeys: [] } as any;
                    if (!this.practice) await SelfLearningModel.pushOwnershipQuestion(thread._id, q0!);
                }
                if (!this.practice) await SelfLearningModel.pushOwnershipLevel(thread._id, qkey, 0, normalizeAnswerKey(text));
                if (!this.practice) await SelfLearningModel.setMessageLevel(thread._id, userIdx, 0);
            } else {
                if (!this.practice) await SelfLearningModel.pushReasoningLevel(thread._id, 0, normalizeAnswerKey(text));
                if (!this.practice) await SelfLearningModel.setMessageRlevel(thread._id, userIdx, 0);
            }
            if (!this.practice) await SelfLearningModel.flagIntegrity(thread._id, sub, manip.excerpt || '');
            this.response.body = { reply: notice, resolved: false, level: 0, flagged: true };
            return;
        }
        const ctx = await this.tutorCtx(rdoc, thread?.attemptCount || 1, await this.everAccepted(domainId));
        if (typeof this.args.code === 'string' && this.args.code.trim()) {
            ctx.liveCode = String(this.args.code).slice(0, 8000);
        }
        const result = await aiTutor.runAnnotationDialogue(ctx, {
            line,
            endLine,
            question: question.slice(0, 300),
            history: turns,
            answer: text.slice(0, 1000),
            // ⭐ First-attempt acceptance (frozen at walkthrough creation
            // from the record history) activates the ownership leniency.
            firstAttempt: thread?.ownership ? (thread.ownership.acceptedAttempt === 1 || (thread.ownership.minQ ?? 0) >= 5) : false,
        });
        /*
         * 🎓 CODE-OWNERSHIP grading: runAnnotationDialogue returns a level
         * (0..4) ONLY when the submission is Accepted — the rubric measures
         * post-acceptance explanations exclusively. The level is stored on
         * the walkthrough state and the user message, and — by request —
         * returned to the student as immediate per-answer feedback (the
         * response's `level` field; the SESSION total stays embargoed until
         * release as before).
         */
        const accepted = rdoc.status === STATUS.STATUS_ACCEPTED;
        const level = (accepted && typeof result.level === 'number') ? result.level : null;
        // Persist the card exchange: this dialogue IS the tutoring history now.
        await SelfLearningModel.pushMessages(thread._id, [
            {
                role: 'user', kind: 'anno', content: text.slice(0, 1000), line, endLine, ...(level === null ? {} : (rdoc.status === STATUS.STATUS_ACCEPTED ? { level } : { rlevel: level })),
            },
            {
                role: 'assistant', kind: 'anno', content: result.reply, line, endLine, resolved: result.resolved,
            },
        ]);
        // 🧩 Failure-phase answers now carry a REASONING level from the
        // same dialogue call: store it (dedup by normalized answer, capped
        // per task) — the flat mean across all exchanges is the rubric.
        if (level !== null && rdoc.status !== STATUS.STATUS_ACCEPTED) {
            const rkey = normalizeAnswerKey(text);
            const rstate = thread.reasoning || { levels: [], answerKeys: [] };
            const rdup = !!rstate.answerKeys?.includes(rkey);
            if (!rdup && (rstate.levels?.length || 0) < MAX_REASONING_PER_TASK) {
                if (!this.practice) await SelfLearningModel.pushReasoningLevel(thread._id, level, rkey);
            }
        }
        if (level !== null && rdoc.status === STATUS.STATUS_ACCEPTED && thread.ownership) {
            /*
             * Anti-inflation: a level lands in the rubric only when (a) the
             * question was genuinely asked (pushOwnershipLevel matches the
             * STORED question text), (b) this normalized answer was not
             * graded for it before, and (c) the question is under its
             * graded-answer cap. The message above keeps the level either
             * way, as the audit trail.
             */
            const key = normalizeAnswerKey(text);
            const q = (thread.ownership.questions || []).find((x) => x.question === question.slice(0, 300));
            const duplicate = !!q?.answerKeys?.includes(key);
            const capped = (q?.levels?.length || 0) >= MAX_LEVELS_PER_QUESTION;
            if (!duplicate && !capped) {
                if (!this.practice) await SelfLearningModel.pushOwnershipLevel(thread._id, question.slice(0, 300), level, key);
            }
        }
        // Progression: a resolved post-acceptance answer no longer finishes
        // the task by itself — the ownership walkthrough may have further
        // questions. The client chains back into postAnnotate, which
        // finishes the task once the budget is spent or the model closes
        // the sequence. (Failed-verdict cards keep sending the student back
        // to the editor, exactly as before.)
        const gate = await this.refreshGate(domainId);
        this.response.body = {
            reply: result.reply,
            resolved: result.resolved,
            // Per-answer feedback: the just-graded level. levelKind picks the
            // chip wording: post-acceptance ownership vs failure reasoning.
            level,
            levelKind: rdoc.status === STATUS.STATUS_ACCEPTED ? 'ownership' : 'reasoning',
            gate,
        };
    }

    @param('text', Types.String)
    async postMessage({ domainId }, text: string) {
        this.checkTutorAllowed();
        await this.limitRate('ai_tutor', 60, 10, '{{user}}');
        text = text.trim();
        if (!text) throw new ValidationError('text');
        if (text.length > 2000) throw new ValidationError('text');
        const thread = await SelfLearningModel.getThread(domainId, this.sdoc.docId, this.pdoc.docId, this.user._id);
        if (!thread || !thread.rid) throw new BadRequestError('Please submit your solution first — the tutor starts from a judged attempt.');
        const maxMessages = +system.get('ai_tutor.max_messages') || 80;
        if (thread.messages.length >= maxMessages) {
            throw new BadRequestError('This tutoring conversation reached its length limit. Please reset it to continue.');
        }
        const rdoc = await record.get(domainId, thread.rid);
        const ctx = await this.tutorCtx(rdoc, thread.attemptCount || 1, await this.everAccepted(domainId));
        const history = [...thread.messages, { role: 'user' as const, kind: 'chat' as const, content: text, at: new Date() }];
        const reply = await aiTutor.runTutorTurn(ctx, history, '');
        await SelfLearningModel.pushMessages(thread._id, [
            { role: 'user', kind: 'chat', content: text },
            { role: 'assistant', kind: 'chat', content: reply },
        ]);
        this.response.body = { reply };
    }

    @param('rid', Types.ObjectId)
    async postAccepted({ domainId }, rid: ObjectId) {
        this.checkTutorAllowed();
        await this.limitRate('ai_tutor', 60, 10, '{{user}}');
        const rdoc = await this.loadOwnRecord(domainId, rid);
        if (rdoc.status !== STATUS.STATUS_ACCEPTED) throw new BadRequestError('This submission was not accepted.');
        // The card channel asks nothing on success (the student should not
        // lose patience after winning); just record the accepted divider so
        // the read-only history shows the milestone.
        const { thread, marker } = await this.ensureAttemptMarker(domainId, rdoc);
        this.response.body = {
            reply: null,
            marker,
            markerAccepted: true,
        };
    }

}

/* ------------------------------------------------------------------------ */
/* Site-wide PTA UI backend — migrated here from problem_trajectory.ts.     */
/* Some dev-mode watchers hot-reload MODIFIED handler files but never       */
/* discover files CREATED after boot, so anything defined only in a brand-  */
/* new file was unreachable on such deployments. This file is proven live.  */
/* ------------------------------------------------------------------------ */

/** Kind + title for each listed problem (config arrives as a raw YAML string). */
/**
 * PTA test paper layout — shared by the paper page and the rail so that
 * numbers, sections and points agree everywhere: objective tasks in the
 * order true/false → choice → fill-in (the editor's stored sections, else
 * classified from content), numbered 1..n across the paper; every task's
 * points from tdoc.score (default 100).
 */
async function paperLayoutOf(domainId: string, tdoc: any, pdocs: Array<{ docId: number, pid?: any, content?: any }>) {
    const sections = await paperOf(domainId, tdoc);
    const sectionOf: Record<number, string> = {};
    for (const key of ['tf', 'choice', 'blank']) for (const pid of sections[key].pids) sectionOf[pid] = key;
    const objective = pdocs.filter((p) => /^o/i.test(String(p.pid || '')));
    for (const p of objective) if (!sectionOf[p.docId]) sectionOf[p.docId] = objectiveSubKindOf(p.content) || 'choice';
    const order: Record<string, number> = { tf: 0, choice: 1, blank: 2 };
    const original = pdocs.map((p) => p.docId);
    const ordered = [...objective].sort((a, b) => (order[sectionOf[a.docId]] - order[sectionOf[b.docId]]) || (original.indexOf(a.docId) - original.indexOf(b.docId)));
    const indexOf: Record<number, number> = {};
    ordered.forEach((p, k) => { indexOf[p.docId] = k + 1; });
    const pointsOf: Record<number, number> = {};
    for (const p of pdocs) {
        const w = tdoc?.score?.[p.docId];
        pointsOf[p.docId] = typeof w === 'number' ? w : 100;
    }
    return { sectionOf, indexOf, pointsOf, ordered };
}

async function activityKinds(domainId: string, pids: number[], uid?: number, tdoc?: any) {
    const pdict = await problem.getList(domainId, pids, true, false, ['docId', 'pid', 'title', 'config', 'content'], true);
    // Rail sections + running numbers + points of the test paper (see paperLayoutOf).
    const layout = tdoc ? await paperLayoutOf(domainId, tdoc, pids.map((pid) => pdict[pid]).filter((x) => x)) : null;
    /*
     * 🎯 Rail verdict states. INSIDE a contest / homework the chips must show
     * what the student did IN THAT ACTIVITY — their contest status document
     * (tsdoc.detail, exactly what the scoreboard counts) — never the global
     * problem-status doc, which also carries practice in the problem set, an
     * earlier activity that reused the task, and correction submissions made
     * after the deadline. Outside an activity (the problem-set rail) the
     * global status is the right source.
     * While an activity is still running the verdicts of OBJECTIVE tasks are
     * withheld, so those chips report "handed in" instead of a verdict.
     */
    const psdict: Record<number, { status?: number, score?: number, submitted?: boolean }> = {};
    if (uid && uid > 1) {
        try {
            if (tdoc) {
                const tsdoc: any = await contest.getStatus(domainId, tdoc.docId, uid);
                const detail = tsdoc?.detail || {};
                for (const pid of pids) {
                    const d = detail[pid];
                    if (!d?.rid) continue;
                    psdict[pid] = { status: d.status || 0, score: d.score, submitted: true };
                }
            } else {
                const rows = await problem.getMultiStatus(domainId, { uid, docId: { $in: pids } })
                    .project({ docId: 1, status: 1, score: 1 }).toArray();
                for (const r of rows) psdict[r.docId] = r as any;
            }
        } catch (e) { /* status decoration is optional */ }
    }
    const withheld = !!tdoc && !contest.isDone(tdoc);
    return pids.map((pid) => {
        const p: any = pdict[pid] || {};
        let conf: any = p.config;
        if (typeof conf === 'string') {
            try {
                conf = yamlLoad(conf) || {};
            } catch (e) {
                conf = {};
            }
        }
        // Site convention: the display pid's first letter is authoritative —
        // P=programming, O=objective, S=subjective — with the config as the
        // fallback for legacy problems.
        const disp = String(p.pid || '');
        let kind: string = aiTutor.problemKindOf(conf);
        if (/^s/i.test(disp)) kind = 'subjective';
        else if (/^o/i.test(disp)) kind = 'objective';
        else if (/^f/i.test(disp)) kind = 'function';
        else if (/^p/i.test(disp)) kind = 'programming';
        const st = psdict[pid] || {};
        // Objective verdicts stay hidden while the activity is live.
        const hide = withheld && kind === 'objective';
        return {
            pid,
            kind,
            title: p.title || String(pid),
            status: hide ? 0 : (st.status || 0),
            submitted: !!st.submitted,
            score: hide ? undefined : st.score,
            ...(layout ? {
                group: kind === 'objective' ? (layout.sectionOf[pid] || 'objective') : kind,
                index: kind === 'objective' ? layout.indexOf[pid] : undefined,
                points: layout.pointsOf[pid],
            } : {}),
        };
    });
}

/**
 * Site-wide submission trajectory for the PTA-style problem UI: the
 * requester's OWN judged, non-pretest submissions (no rid), or one
 * submission's full verdict payload for the result modal (rid given).
 */
class ProblemTrajectoryHandler extends Handler {
    @param('pid', Types.PositiveInt)
    @param('rid', Types.ObjectId, true)
    async get({ domainId }, pid: number, rid?: ObjectId) {
        if (rid) {
            const rdoc = await record.get(domainId, rid);
            if (!rdoc || rdoc.uid !== this.user._id || rdoc.pid !== pid) throw new NotFoundError(rid);
            const judged = !JUDGING.includes(rdoc.status);
            this.response.body = {
                rid: rid.toHexString(),
                status: rdoc.status,
                statusText: STATUS_TEXTS[rdoc.status] || `${rdoc.status}`,
                shortText: STATUS_SHORT_TEXTS[rdoc.status] || '',
                accepted: rdoc.status === STATUS.STATUS_ACCEPTED,
                judged,
                score: rdoc.score || 0,
                time: rdoc.time || 0,
                memory: rdoc.memory || 0,
                lang: rdoc.lang || '',
                code: typeof rdoc.code === 'string' ? rdoc.code.slice(0, 8000) : '',
                submitAt: rdoc._id.getTimestamp().getTime(),
                judgeAt: rdoc.judgeAt ? new Date(rdoc.judgeAt).getTime() : null,
                compilerTexts: (rdoc.compilerTexts || []).join('\n').slice(0, 4000),
                judgeTexts: (rdoc.judgeTexts || [])
                    .map((t: any) => (typeof t === 'string' ? t : t?.message || ''))
                    .filter((t: string) => t).join('\n').slice(0, 2000),
                cases: (rdoc.testCases || []).slice(0, 60).map((c: any) => ({
                    id: c.id,
                    subtaskId: c.subtaskId,
                    status: c.status,
                    statusText: STATUS_TEXTS[c.status] || STATUS_SHORT_TEXTS[c.status] || `${c.status}`,
                    message: (typeof c.message === 'string' ? c.message : (c.message?.message || '')).slice(0, 200),
                    score: c.score,
                    time: c.time,
                    memory: c.memory,
                })),
            };
            return;
        }
        const history = await record.getMulti(domainId, {
            pid, uid: this.user._id, contest: { $ne: record.RECORD_PRETEST },
        }).sort({ _id: -1 }).limit(10)
            .project({ code: 1, lang: 1, status: 1, score: 1 })
            .toArray();
        this.response.body = {
            attempts: history.reverse().map((r: any) => ({
                rid: r._id.toHexString(),
                lang: r.lang || '',
                status: r.status,
                statusText: STATUS_TEXTS[r.status] || `${r.status}`,
                accepted: r.status === STATUS.STATUS_ACCEPTED,
                score: r.score || 0,
                at: r._id.getTimestamp().getTime(),
                code: typeof r.code === 'string' ? r.code.slice(0, 8000) : '',
            })),
        };
    }
}

/** Kinds+titles of a contest/homework's problems (they share TYPE_CONTEST). */
class ActivityProblemKindsHandler extends Handler {
    @param('tid', Types.ObjectId)
    async get({ domainId }, tid: ObjectId) {
        const tdoc = await contest.get(domainId, tid);
        if (!tdoc) throw new NotFoundError(tid);
        this.response.body = { pids: await activityKinds(domainId, tdoc.pids || [], this.user?._id, tdoc) };
    }
}

const FALSY_AVAILABILITY = ['', '0', 'false', 'no', 'n', 'unavailable', 'inactive', 'off'];

/**
 * Post-acceptance "AI Suggestions": one comprehensive Markdown code review
 * over the problem statement plus the requester's FULL submission trajectory
 * (timestamps included, so debugging behavior can be analyzed). Requires at
 * least one accepted attempt — the button only appears on accepted modals.
 */
/**
 * A TEST that is still running, contains this problem and that the user is
 * taking: AI Suggestions are locked for them until the test ends for
 * everyone (the container end, never a personal window — the same rule as
 * every other reveal). Owners, maintainers and contest editors are exempt.
 * Returns the blocking test, or null. Decided from the records, so the
 * lock holds whichever page the request comes from.
 */
async function liveTestLockingAi(h: Handler, domainId: string, pid: number): Promise<{ title: string, endAt: Date } | null> {
    if (h.user.hasPerm(PERM.PERM_EDIT_CONTEST)) return null;
    const now = new Date();
    const live = await contest.getMulti(domainId, {
        rule: { $ne: 'homework' }, pids: pid, beginAt: { $lte: now }, endAt: { $gt: now },
    } as any).project({ docId: 1, owner: 1, maintainer: 1, title: 1, endAt: 1 }).toArray();
    for (const tdoc of live) {
        if (tdoc.owner === h.user._id || (tdoc.maintainer || []).includes(h.user._id)) continue;
        const tsdoc = await contest.getStatus(domainId, tdoc.docId, h.user._id);
        if (tsdoc?.attend) return { title: tdoc.title, endAt: tdoc.endAt };
    }
    return null;
}

class AiSuggestionsHandler extends Handler {
    @param('pid', Types.PositiveInt)
    async get({ domainId }, pid: number) {
        const lock = await liveTestLockingAi(this, domainId, pid);
        if (lock) {
            this.response.body = { report: null, locked: true, lockedUntil: lock.endAt, lockedBy: lock.title };
            return;
        }
        // Saved-report lookup: lets the modal show the last generated report
        // instantly (and token-free) instead of regenerating every time.
        const doc = await getSuggestionReport(domainId, pid, this.user._id);
        this.response.body = doc
            ? { report: doc.report, updateAt: doc.updateAt, attempts: doc.attempts }
            : { report: null };
    }

    @param('pid', Types.PositiveInt)
    async post({ domainId }, pid: number) {
        if (!aiTutor.tutorConfigured()) throw new ForbiddenError('The AI tutor is not configured. Please ask the administrator to set an API key.');
        const lock = await liveTestLockingAi(this, domainId, pid);
        if (lock) throw new ForbiddenError('AI Suggestions are available after the test ends.');
        await this.limitRate('ai_suggestions', 60, 3, '{{user}}');
        const history = await record.getMulti(domainId, {
            pid, uid: this.user._id, contest: { $ne: record.RECORD_PRETEST },
        }).sort({ _id: -1 }).limit(12)
            .project({ code: 1, lang: 1, status: 1, score: 1 })
            .toArray();
        const attempts: aiTutor.SuggestionAttempt[] = history.reverse().map((r: any) => ({
            at: r._id.getTimestamp().getTime(),
            lang: r.lang || '',
            statusText: STATUS_TEXTS[r.status] || `${r.status}`,
            score: r.score || 0,
            accepted: r.status === STATUS.STATUS_ACCEPTED,
            code: typeof r.code === 'string' ? r.code.slice(0, 8000) : '',
        }));
        if (!attempts.some((a) => a.accepted)) {
            throw new BadRequestError('AI Suggestions are available after an accepted submission.');
        }
        const pdoc = await problem.get(domainId, pid);
        if (!pdoc) throw new NotFoundError(pid);
        const uiLang = this.user.viewLang || this.session.viewLang || system.get('server.language') || 'en';
        const report = await aiTutor.runSuggestionsReport({ pdoc, attempts, uiLang });
        const updateAt = await setSuggestionReport(domainId, pid, this.user._id, report, attempts.length);
        this.response.body = { report, updateAt };
        logger.info('[pta-ui] AI Suggestions generated and saved for uid=%d pid=%d over %d attempt(s)', this.user._id, pid, attempts.length);
    }
}

/**
 * Root-only bulk user import (the homepage "Add Users" modal).
 * GET  -> every domain with its assignable roles, for the pickers.
 * POST -> { users: [{lastName, firstName, uname, availability}],
 *           assignments: [{domainId, role}] }
 *         Creates missing accounts (password `Username_LastName_FirstName`),
 *         then joins every listed user into every listed domain with the
 *         chosen role. Existing accounts are never modified — they are only
 *         added to the domains.
 */
class BulkAddUsersHandler extends Handler {
    async get() {
        const ddocs = await domain.getMulti().limit(200).toArray();
        this.response.body = {
            domains: ddocs.map((d: any) => ({
                _id: d._id,
                name: d.name || d._id,
                roles: Array.from(new Set(['default', 'root', ...Object.keys(d.roles || {})]))
                    .filter((r) => r !== 'guest'),
            })),
        };
    }

    async post() {
        const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
        let users: any[] = [];
        let assignments: any[] = [];
        try {
            users = parse(this.args.users) || [];
            assignments = parse(this.args.assignments) || [];
        } catch (e) {
            throw new BadRequestError('Malformed payload.');
        }
        if (!Array.isArray(users) || !users.length || users.length > 500) {
            throw new BadRequestError('Provide between 1 and 500 users.');
        }
        if (!Array.isArray(assignments) || !assignments.length || assignments.length > 20) {
            throw new BadRequestError('Provide between 1 and 20 domain assignments.');
        }
        // Validate every assignment up front: unknown domains abort the run.
        for (const a of assignments) {
            const ddoc = await domain.get(String(a.domainId));
            if (!ddoc) throw new NotFoundError(String(a.domainId));
            a.domainId = String(a.domainId);
            a.role = String(a.role || 'default') || 'default';
        }
        const created: string[] = [];
        const existed: string[] = [];
        const skipped: string[] = [];
        const errors: { uname: string, error: string }[] = [];
        for (const row of users) {
            const uname = String(row?.uname ?? '').trim();
            const lastName = String(row?.lastName ?? '').trim();
            const firstName = String(row?.firstName ?? '').trim();
            const availability = String(row?.availability ?? '').trim().toLowerCase();
            if (!uname) {
                errors.push({ uname: '(empty)', error: 'Missing Username' });
                continue;
            }
            if (FALSY_AVAILABILITY.includes(availability)) {
                skipped.push(uname);
                continue;
            }
            let uid: number;
            let isNew = false;
            try {
                const udoc = await user.getByUname('system', uname);
                if (udoc) {
                    uid = udoc._id;
                } else {
                    const password = `${uname}_${lastName}_${firstName}`;
                    const mailLocal = uname.toLowerCase().replace(/[^a-z0-9._-]/g, '') || `u${Date.now()}`;
                    uid = await user.create(`${mailLocal}@bulk-import.invalid`, uname, password);
                    isNew = true;
                }
                for (const a of assignments) {
                    await domain.setUserRole(a.domainId, uid, a.role, true); // autojoin: membership + role
                }
                /*
                 * The roster's real name becomes the domain displayName —
                 * "First Last", e.g. "Leming Shen" — so the ID (22040929R)
                 * stays the login/uname while people see a human name in the
                 * nav and user cards. Written to every assigned domain PLUS
                 * 'system' (the homepage renders under 'system', and a name
                 * set only in course domains would vanish there). The roster
                 * is authoritative: re-importing updates existing users too.
                 */
                const realName = [firstName, lastName].filter(Boolean).join(' ').slice(0, 255);
                if (realName) {
                    /*
                     * The roster is AUTHORITATIVE for names, and (with the
                     * settings fields now FLAG_DISABLED) this importer is
                     * their only writer. Overwrite BOTH fields with exactly
                     * what the row says — including setting the absent half
                     * to '', so a corrected re-import clears a stale value
                     * instead of merging with it. Rows with no name at all
                     * skip this block and leave the account untouched.
                     */
                    await user.setById(uid, {
                        firstName: firstName.slice(0, 120),
                        lastName: lastName.slice(0, 120),
                    });
                    // Compatibility copy: components/user.html and rankings
                    // already render the per-domain displayName, so keep it in
                    // step wherever the student was assigned.
                    const nameDomains = new Set(['system', ...assignments.map((a) => a.domainId)]);
                    for (const dom of nameDomains) {
                        await domain.setUserInDomain(dom, uid, { displayName: realName });
                    }
                }
                (isNew ? created : existed).push(uname);
            } catch (e) {
                errors.push({ uname, error: e.message || `${e}` });
            }
        }
        logger.info(
            '[pta-ui] bulk user import by %s: %d created, %d existed, %d skipped, %d errors -> domains %s',
            this.user.uname, created.length, existed.length, skipped.length, errors.length,
            assignments.map((a) => `${a.domainId}:${a.role}`).join(', '),
        );
        this.response.body = {
            created, existed, skipped, errors,
        };
    }
}

/* ---------------------- teacher-facing AI class report ---------------------- */

/*
 * PTA fork: the HOMEWORK / TEST report moved to lib/activity_report.ts
 * (a background map-reduce job over every task, submission and objective
 * answer). Only the limits the SESSION corpus below still uses remain here.
 */
const CLASS_MAX_RECORDS = 20000;
const NONFINAL_STATUS = [0, 20, 21, 22]; // waiting / judging / compiling / fetched

/**
 * Extract and strip the mandatory json:concepts trailer: the prose report
 * stays clean while the structured knowledge points feed the charts.
 */
function extractConceptBlock(md: string, validLabels?: Set<string>): { report: string, concepts: any[] } {
    const m = md.match(/```json:concepts[ \t]*\n([\s\S]*?)```/);
    if (!m) return { report: md.trim(), concepts: [] };
    const report = (md.slice(0, m.index) + md.slice((m.index as number) + m[0].length)).trim();
    let concepts: any[] = [];
    try {
        const parsed = JSON.parse(m[1]);
        if (Array.isArray(parsed?.concepts)) {
            concepts = parsed.concepts
                .filter((c: any) => c && typeof c.name === 'string')
                .slice(0, 10)
                .map((c: any) => ({
                    name: String(c.name).slice(0, 60),
                    problems: Object.fromEntries(
                        Object.entries(c.problems || {})
                            .filter(([k, v]) => Number.isFinite(+(v as any)) && +(v as any) > 0
                                && (!validLabels || validLabels.has(String(k))))
                            .map(([k, v]) => [String(k).slice(0, 16), Math.round(+(v as any))]),
                    ),
                    students: Array.isArray(c.students) ? c.students.map(String).slice(0, 100) : [],
                }))
                .filter((c: any) => !validLabels || Object.keys(c.problems).length);
        }
    } catch (e) {
        logger.warn('[pta-ui] class report concepts block unparsable: %s', e.message);
    }
    return { report, concepts };
}

/* ------------- self-learning SESSION report: the whole corpus, in batches ------------- */

/*
 * 📏 SCALE. A class may hold 200+ students, each with dozens of attempts
 * and long tutor dialogues; the model's context is finite. The map stage
 * therefore packs students into batches by SIZE, not by count (a budget
 * of characters per call, overridable by the ai_tutor.report_batch_chars
 * setting), renders a student's transcript at one of three compaction
 * LEVELS (full → tight → tightest) to fit, splits a student who does not
 * fit even then across two calls by task, bisects a failed batch until
 * the failing student is found and retried tighter — and only after all
 * of that marks a student unanalyzed, by name, in the report. A per-
 * student CACHE keyed by the transcript's hash makes a re-run send only
 * students whose data changed.
 */
const SESSION_REPORT_MAX_STUDENTS = 600;
const SESSION_BATCH_CHARS = () => Math.max(12000, +system.get('ai_tutor.report_batch_chars') || 48000);
const SESSION_REDUCE_CHARS = () => Math.max(30000, +system.get('ai_tutor.report_reduce_chars') || 110000);
const SESSION_MAP_CONCURRENCY = () => Math.min(8, Math.max(1, +system.get('ai_tutor.report_concurrency') || 3));
/** Wall-clock guard: above this many map calls the whole class is rendered one level tighter (every student still read). */
const SESSION_MAX_CALLS = () => Math.max(8, +system.get('ai_tutor.report_max_calls') || 40);
const SESSION_CODE_AC_CAP = 1200;
const SESSION_CODE_FAIL_CAP = 900;
const SESSION_MSG_CAP = 320; // characters per tutor message in the corpus
/** 💓 Session report jobs: dead after this long WITHOUT a progress heartbeat (see model classReportJobStale). */
const SESSION_JOB_STALE_MS = 15 * 60 * 1000;
/** Compaction levels: [dialogue messages per task, chars per message, code chars, collapse attempt runs]. */
const SESSION_LEVELS: { msgs: number, msgChars: number, code: number, collapse: boolean }[] = [
    { msgs: 24, msgChars: SESSION_MSG_CAP, code: SESSION_CODE_AC_CAP, collapse: false },
    { msgs: 14, msgChars: 200, code: 600, collapse: true },
    { msgs: 8, msgChars: 140, code: 300, collapse: true },
];

const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const a = [...xs].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 10) / 10;
};
const mean1 = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const IDK_RE = /^(?:i\s*(?:don'?t|do not)\s*know|不知道|我不知道|no idea|idk)\b/i;

/**
 * 📊 EVERYTHING the session report reasons from, collected deterministically:
 *   - the tasks with their knowledge points (tree paths);
 *   - every student's every judged submission on them, in order, with the
 *     code of the last failing and the accepted attempt (capped);
 *   - every tutor exchange, verbatim (capped per message), with its grades;
 *   - the rubric scores when the session has been evaluated;
 *   - and the STATISTICS the report may quote: per task, per knowledge
 *     point, tutor engagement, results.
 * `light` skips the code and the transcripts: enough for the page's live
 * strip and charts, cheap enough for every GET.
 */
async function buildSessionCorpus(domainId: string, sdoc: SelfLearningDoc, light: boolean) {
    const pids: number[] = (sdoc.pids || []).filter((x: any) => typeof x === 'number');
    const pdict = await problem.getList(domainId, pids, true, false, ['docId', 'pid', 'title', 'difficulty', 'tag', 'config'] as any, true);
    const tasks: any[] = [];
    for (const pid of pids) {
        const pd: any = pdict[pid];
        if (!pd) continue;
        const points = (pd.tag || []).map((t: any) => String(t)).filter((t: string) => t);
        tasks.push({ pid, label: String(pd.pid || `P${pid}`), title: pd.title, difficulty: pd.difficulty || 0, points, pointPaths: await KnowledgeModel.describeTags(domainId, points) });
    }
    const labelOf = new Map(tasks.map((t) => [t.pid, t.label]));

    // Every judged, non-pretest submission on the session's tasks.
    const recs = await record.getMulti(domainId, { pid: { $in: pids }, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: NONFINAL_STATUS } })
        .project({ uid: 1, pid: 1, status: 1, score: 1, lang: 1 }).sort({ _id: 1 }).limit(CLASS_MAX_RECORDS).toArray() as any[];
    const uids = [...new Set(recs.map((r) => r.uid as number))].slice(0, SESSION_REPORT_MAX_STUDENTS);
    const uidSet = new Set(uids);
    const [udict, threads, progresses] = await Promise.all([
        user.getList(domainId, uids),
        getSessionThreads(domainId, sdoc.docId),
        collProgress.find({ domainId, ssid: sdoc.docId }).limit(SESSION_REPORT_MAX_STUDENTS).toArray(),
    ]);
    const sOf = new Map<number, string>();
    uids.forEach((uid, i) => sOf.set(uid, `S${i + 1}`));
    const progOf = new Map(progresses.map((p) => [p.uid, p]));
    const rowOf = new Map((sdoc.results?.rows || []).map((r: any) => [r.uid, r]));

    // ---- per (student, task) ----
    interface Cell { attempts: any[], firstAt: Date | null, acAt: Date | null, lastFailRid: any, acRid: any, lastFailStatus: number }
    const cells = new Map<string, Cell>();
    const cellKey = (uid: number, pid: number) => `${uid}:${pid}`;
    for (const r of recs) {
        if (!uidSet.has(r.uid)) continue;
        const k = cellKey(r.uid, r.pid);
        if (!cells.has(k)) cells.set(k, { attempts: [], firstAt: null, acAt: null, lastFailRid: null, acRid: null, lastFailStatus: 0 });
        const c = cells.get(k)!;
        const at = r._id.getTimestamp();
        if (!c.firstAt) c.firstAt = at;
        c.attempts.push({ status: r.status, score: r.score || 0, at, rid: r._id });
        if (r.status === STATUS.STATUS_ACCEPTED) {
            if (!c.acAt) {
                c.acAt = at;
                c.acRid = r._id;
            }
        } else if (!c.acAt) {
            c.lastFailRid = r._id;
            c.lastFailStatus = r.status;
        }
    }
    const threadOf = new Map<string, TutorThreadDoc>();
    for (const th of threads) if (uidSet.has(th.uid)) threadOf.set(cellKey(th.uid, th.pid), th);

    // Code excerpts (the ONLY code the model may quote): the accepted
    // attempt and, for students who never got there, the last failing one.
    const codeOf = new Map<string, string>();
    if (!light) {
        const wanted: { rid: any, cap: number }[] = [];
        for (const c of cells.values()) {
            if (c.acRid) wanted.push({ rid: c.acRid, cap: SESSION_CODE_AC_CAP });
            else if (c.lastFailRid) wanted.push({ rid: c.lastFailRid, cap: SESSION_CODE_FAIL_CAP });
        }
        const rdocs = await record.getMulti(domainId, { _id: { $in: wanted.map((w) => w.rid) } }).project({ code: 1 }).limit(wanted.length + 1).toArray() as any[];
        const capOf = new Map(wanted.map((w) => [String(w.rid), w.cap]));
        for (const rd of rdocs) codeOf.set(String(rd._id), String(rd.code || '').slice(0, capOf.get(String(rd._id)) || 900));
    }

    // ---- statistics ----
    const perTask = tasks.map((t) => {
        const own = uids.map((uid) => cells.get(cellKey(uid, t.pid))).filter((c): c is Cell => !!c);
        const verdicts: Record<string, number> = {};
        const firstFail: Record<string, number> = {};
        const minutesToAc: number[] = [];
        for (const c of own) {
            for (const a of c.attempts) if (a.status !== STATUS.STATUS_ACCEPTED) verdicts[STATUS_SHORT_TEXTS[a.status] || STATUS_TEXTS[a.status] || String(a.status)] = (verdicts[STATUS_SHORT_TEXTS[a.status] || STATUS_TEXTS[a.status] || String(a.status)] || 0) + 1;
            const f = c.attempts[0];
            if (f && f.status !== STATUS.STATUS_ACCEPTED) firstFail[STATUS_SHORT_TEXTS[f.status] || STATUS_TEXTS[f.status] || String(f.status)] = (firstFail[STATUS_SHORT_TEXTS[f.status] || STATUS_TEXTS[f.status] || String(f.status)] || 0) + 1;
            if (c.acAt && c.firstAt) minutesToAc.push(Math.round((c.acAt.getTime() - c.firstAt.getTime()) / 60000));
        }
        const tutor = { threads: 0, questions: 0, replies: 0, idk: 0, unanswered: 0, resolved: 0, rlevels: [] as number[], olevels: [] as number[] };
        for (const uid of uids) {
            const th = threadOf.get(cellKey(uid, t.pid));
            if (!th) continue;
            tutor.threads += 1;
            const msgs = (th.messages || []).filter((m) => m.kind === 'anno');
            for (let i = 0; i < msgs.length; i++) {
                const m = msgs[i];
                if (m.role === 'assistant') {
                    tutor.questions += 1;
                    if (m.resolved) tutor.resolved += 1;
                    if (!msgs.slice(i + 1).some((x) => x.role === 'user')) tutor.unanswered += 1;
                } else {
                    tutor.replies += 1;
                    if (IDK_RE.test(String(m.content || '').trim())) tutor.idk += 1;
                    if (typeof m.rlevel === 'number') tutor.rlevels.push(m.rlevel);
                    if (typeof m.level === 'number') tutor.olevels.push(m.level);
                }
            }
        }
        const skipped = progresses.filter((p) => uidSet.has(p.uid) && (p.skipped || []).includes(t.pid)).length;
        return {
            label: t.label, title: t.title, pid: t.pid, points: t.points,
            attempted: own.length, solved: own.filter((c) => !!c.acAt).length,
            medianAttempts: median(own.map((c) => c.attempts.length)), maxAttempts: Math.max(0, ...own.map((c) => c.attempts.length)),
            medianMinutesToAc: median(minutesToAc), verdicts, firstFail, skipped,
            tutor: {
                threads: tutor.threads, questions: tutor.questions, replies: tutor.replies, idk: tutor.idk, unanswered: tutor.unanswered,
                resolvedRate: pct(tutor.resolved, tutor.questions), meanReasoning: mean1(tutor.rlevels), meanOwnership: mean1(tutor.olevels),
            },
        };
    });
    // Per knowledge point, across the tasks that carry it.
    const perPoint = new Map<string, any>();
    for (const t of tasks) {
        const pt = perTask.find((x) => x.pid === t.pid)!;
        t.points.forEach((name: string, i: number) => {
            const k = name.toLowerCase();
            if (!perPoint.has(k)) perPoint.set(k, { name, path: t.pointPaths[i] || name, tasks: [], attempted: 0, solved: 0, surfaced: new Set<string>(), idk: 0 });
            const e = perPoint.get(k);
            e.tasks.push(t.label);
            e.attempted += pt.attempted;
            e.solved += pt.solved;
            e.idk += pt.tutor.idk;
        });
    }
    for (const th of threads) {
        if (!uidSet.has(th.uid)) continue;
        for (const n of th.surfacedKp?.names || []) {
            const e = perPoint.get(String(n).toLowerCase());
            if (e) e.surfaced.add(sOf.get(th.uid)!);
        }
    }
    const perPointRows = [...perPoint.values()].map((e) => ({ ...e, surfaced: e.surfaced.size, surfacedStudents: [...e.surfaced].slice(0, 12), solvedRate: pct(e.solved, e.attempted) }))
        .sort((a, b) => b.surfaced - a.surfaced || a.solvedRate - b.solvedRate);
    const engagement = { students: uids.length, active: 0, partial: 0, silent: 0, questions: 0, replies: 0, idk: 0 };
    for (const uid of uids) {
        let q = 0;
        let r = 0;
        let idk = 0;
        for (const t of tasks) {
            const th = threadOf.get(cellKey(uid, t.pid));
            for (const m of (th?.messages || []).filter((x) => x.kind === 'anno')) {
                if (m.role === 'assistant') q += 1;
                else {
                    r += 1;
                    if (IDK_RE.test(String(m.content || '').trim())) idk += 1;
                }
            }
        }
        engagement.questions += q;
        engagement.replies += r;
        engagement.idk += idk;
        if (!q) continue;
        if (r >= Math.max(1, Math.ceil(q * 0.6))) engagement.active += 1;
        else if (r > 0) engagement.partial += 1;
        else engagement.silent += 1;
    }
    const rows = uids.map((uid) => rowOf.get(uid)).filter((r): r is any => !!r);
    const results = sdoc.results ? {
        evaluated: true, computedAt: sdoc.results.computedAt, final: !!sdoc.results.final, students: rows.length,
        meanTotal: mean1(rows.map((r) => r.total || 0)), medianTotal: median(rows.map((r) => r.total || 0)),
        meanAchievement: mean1(rows.map((r) => r.achievement).filter((x) => typeof x === 'number')),
        meanOwnership: mean1(rows.map((r) => r.ownership).filter((x) => typeof x === 'number')),
        meanFixconv: mean1(rows.map((r) => r.fixconv).filter((x) => typeof x === 'number')),
        meanReasoning: mean1(rows.map((r) => r.reasoning).filter((x) => typeof x === 'number')),
        meanInitiative: mean1(rows.map((r) => r.initiative).filter((x) => typeof x === 'number')),
    } : { evaluated: false };
    const light_ = {
        activity: sdoc.title, kind: 'self-learning', participants: uids.length,
        problems: perTask.map((p) => ({ label: p.label, title: p.title, attempted: p.attempted, solved: p.solved, tutorQuestions: p.tutor.questions, tutorReplies: p.tutor.replies, tutorSkipped: p.tutor.unanswered, idk: p.tutor.idk, skipped: p.skipped })),
        engagement, results, points: perPointRows.slice(0, 12).map((e) => ({ name: e.name, tasks: e.tasks, solvedRate: e.solvedRate, surfaced: e.surfaced })),
    };

    // ---- the per-student corpus (full mode) ----
    const students: any[] = [];
    if (!light) {
        for (const uid of uids) {
            const prog = progOf.get(uid);
            const row = rowOf.get(uid);
            const st: any = {
                uid, s: sOf.get(uid), uname: udict[uid]?.uname || `user#${uid}`,
                done: (prog?.done || []).map((p: number) => labelOf.get(p)).filter((x: any) => x),
                skipped: (prog?.skipped || []).map((p: number) => labelOf.get(p)).filter((x: any) => x),
                bonus: (prog?.bonuses || []).map((b: any) => ({ title: b.title || '', status: b.status, weakPoints: b.weakPoints || [] })),
                results: row ? { total: row.total, achievement: row.achievement, ownership: row.ownership, fixconv: row.fixconv, reasoning: row.reasoning, initiative: row.initiative } : null,
                tasks: [] as any[],
            };
            for (const t of tasks) {
                const c = cells.get(cellKey(uid, t.pid));
                const th = threadOf.get(cellKey(uid, t.pid));
                if (!c && !th) continue;
                const t0 = c?.firstAt ? c.firstAt.getTime() : 0;
                const attempts = (c?.attempts || []).map((a: any, i: number) => `#${i + 1} ${STATUS_SHORT_TEXTS[a.status] || STATUS_TEXTS[a.status] || a.status}${a.score ? `(${a.score})` : ''}@+${Math.round((a.at.getTime() - t0) / 60000)}m`);
                // The dialogue rides RAW (role, text, grades); it is rendered
                // per compaction level when the batch is packed.
                const dialogue = (th?.messages || []).filter((m) => m.kind === 'anno' || m.kind === 'attempt' || m.kind === 'accepted').map((m) => ({
                    kind: m.kind, role: m.role, line: m.line, resolved: !!m.resolved, level: m.level, rlevel: m.rlevel,
                    text: m.kind === 'anno' ? String(m.content || '').replace(/\s+/g, ' ') : '',
                }));
                st.tasks.push({
                    label: t.label, attempts, solved: !!c?.acAt, minutesToAc: c?.acAt && c.firstAt ? Math.round((c.acAt.getTime() - c.firstAt.getTime()) / 60000) : null,
                    code: c?.acRid ? { kind: 'accepted', text: codeOf.get(String(c.acRid)) || '' } : c?.lastFailRid ? { kind: `last failing (${STATUS_SHORT_TEXTS[c.lastFailStatus] || c.lastFailStatus})`, text: codeOf.get(String(c.lastFailRid)) || '' } : null,
                    surfaced: th?.surfacedKp?.names || [],
                    dialogue,
                });
            }
            students.push(st);
        }
    }
    return { sdoc, tasks, uids, sOf, udict, perTask, perPoint: perPointRows, engagement, results, light: light_, students };
}

/** The task list as the model reads it (shared by both stages). */
function sessionTaskBlock(corpus: any): string {
    return [`=== TASKS OF THE SESSION "${corpus.sdoc.title}" (in learning order) ===`,
        ...corpus.tasks.map((t: any) => `${t.label} "${t.title}" — difficulty ${t.difficulty || '?'}/10 — knowledge points: ${t.pointPaths.length ? t.pointPaths.join('; ') : '(unlabeled)'}`),
        '=== END TASKS ==='].join('\n');
}

/** "#1 WA(0)@+0m → #2 WA(0)@+3m → …": long runs of the same verdict collapse at the tighter levels. */
function renderAttempts(attempts: string[], collapse: boolean): string {
    if (!collapse || attempts.length <= 8) return attempts.join(' → ');
    const verdictOf = (a: string) => a.replace(/^#\d+\s*/, '').replace(/@\+\d+m$/, '');
    const out: string[] = [];
    let i = 0;
    while (i < attempts.length) {
        let j = i;
        while (j + 1 < attempts.length && verdictOf(attempts[j + 1]) === verdictOf(attempts[i])) j++;
        if (j - i >= 2) out.push(`${attempts[i]} … ${attempts[j]} (${j - i + 1}× ${verdictOf(attempts[i])})`);
        else for (let k = i; k <= j; k++) out.push(attempts[k]);
        i = j + 1;
    }
    return out.join(' → ');
}

/** One task of one student at a compaction level. */
function renderTask(t: any, lv: typeof SESSION_LEVELS[number]): string[] {
    const lines: string[] = [];
    lines.push(`${t.label}: ${t.attempts.length ? renderAttempts(t.attempts, lv.collapse) : '(no submissions)'}${t.solved ? ` — solved after ${t.minutesToAc} min` : ' — NOT solved'}${t.surfaced.length ? ` | surfaced misconceptions: ${t.surfaced.join('; ')}` : ''}`);
    if (t.code && t.code.text) {
        // Comments and blank lines carry little for the analysis at the tight levels.
        let code = t.code.text.slice(0, lv.code);
        if (lv.collapse) code = code.split('\n').filter((l: string) => l.trim() && !/^\s*(?:\/\/|#)/.test(l)).join('\n');
        lines.push(`  code (${t.code.kind}):`, ...code.split('\n').map((l: string) => `    ${l.replace(/^ {4,}/, '    ').replace(/^\t+/, '    ')}`));
    }
    const msgs = (t.dialogue || []).slice(-lv.msgs);
    if (msgs.length) {
        lines.push('  tutor dialogue:');
        for (const m of msgs) {
            if (m.kind === 'attempt') lines.push('    [new failed attempt]');
            else if (m.kind === 'accepted') lines.push('    [accepted — ownership walkthrough begins]');
            else {
                const grade = typeof m.level === 'number' ? ` (ownership L${m.level})` : typeof m.rlevel === 'number' ? ` (reasoning L${m.rlevel})` : '';
                // The student's words are the evidence: they keep the full cap; the tutor's question shrinks first.
                const cap = m.role === 'assistant' ? Math.round(lv.msgChars * 0.6) : lv.msgChars;
                lines.push(`    ${m.role === 'assistant' ? 'TUTOR' : 'STUDENT'}${m.line ? ` [line ${m.line}]` : ''}${m.role === 'assistant' && m.resolved ? ' [resolved]' : ''}: ${m.text.slice(0, cap)}${grade}`);
            }
        }
    }
    return lines;
}

/**
 * One student's transcript at a compaction level, optionally restricted
 * to some of their tasks (a student too big for one call is split by
 * task; every part carries the same S-token and says which part it is).
 */
function renderStudent(st: any, level: number, taskLabels?: string[], part?: { i: number, n: number }): string {
    const lv = SESSION_LEVELS[Math.min(level, SESSION_LEVELS.length - 1)];
    const lines: string[] = ['', `--- ${st.s}${part ? ` (part ${part.i}/${part.n}: tasks ${taskLabels!.join(', ')})` : ''} ---`,
        `finished: ${st.done.join(', ') || '-'} | skipped: ${st.skipped.join(', ') || '-'}${st.bonus.length ? ` | bonus task: ${st.bonus.map((b: any) => `${b.title || '(building)'} [${b.status}]`).join('; ')}` : ''}${st.results ? ` | rubric total ${st.results.total}/100` : ''}`];
    for (const t of st.tasks) {
        if (taskLabels && !taskLabels.includes(t.label)) continue;
        lines.push(...renderTask(t, lv));
    }
    return lines.join('\n');
}

/** A unit of map work: one student, or one part of a student. */
interface MapItem { st: any, level: number, tasks?: string[], part?: { i: number, n: number }, text: string }

/**
 * 📦 Pack students into batches by SIZE. Each student is rendered at the
 * fullest level that fits the budget; a student who does not fit even at
 * the tightest level is split by task into parts that do. Then items are
 * packed greedily, largest first, so every batch stays under the budget
 * and the number of calls stays small.
 */
function packSessionBatches(students: any[], budget: number, maxCalls = SESSION_MAX_CALLS()): { batches: MapItem[][], parts: number, startLevel: number } {
    const headroom = Math.floor(budget * 0.85); // the task list + framing take the rest
    // ⏱ A 200-student class at full detail can mean a hundred calls. When
    // the class would exceed the call ceiling, everyone starts one level
    // tighter (then two): every student is still read, in fewer calls.
    let startLevel = 0;
    for (; startLevel < SESSION_LEVELS.length - 1; startLevel++) {
        const total = students.reduce((n, st) => n + renderStudent(st, startLevel).length, 0);
        if (Math.ceil(total / headroom) <= maxCalls) break;
    }
    const items: MapItem[] = [];
    let parts = 0;
    for (const st of students) {
        let placed = false;
        for (let level = startLevel; level < SESSION_LEVELS.length; level++) {
            const text = renderStudent(st, level);
            if (text.length <= headroom) {
                items.push({ st, level, text });
                placed = true;
                break;
            }
        }
        if (placed) continue;
        // Split by task at the tightest level: consecutive tasks, each part under the budget.
        const level = SESSION_LEVELS.length - 1;
        const groups: string[][] = [];
        let cur: string[] = [];
        for (const t of st.tasks) {
            const trial = renderStudent(st, level, [...cur, t.label]);
            if (cur.length && trial.length > headroom) {
                groups.push(cur);
                cur = [t.label];
            } else cur.push(t.label);
        }
        if (cur.length) groups.push(cur);
        groups.forEach((g, i) => {
            const part = { i: i + 1, n: groups.length };
            let text = renderStudent(st, level, g, part);
            if (text.length > headroom) text = `${text.slice(0, headroom - 40)}\n    … (truncated to fit the analysis budget)`;
            items.push({ st, level, tasks: g, part, text });
        });
        parts += groups.length;
    }
    // First-fit-decreasing: biggest items first into the batch with room.
    items.sort((a, b) => b.text.length - a.text.length);
    const batches: { items: MapItem[], size: number }[] = [];
    for (const it of items) {
        const home = batches.find((b) => b.size + it.text.length <= headroom);
        if (home) {
            home.items.push(it);
            home.size += it.text.length;
        } else batches.push({ items: [it], size: it.text.length });
    }
    return { batches: batches.map((b) => b.items), parts, startLevel };
}

/** MAP context: the tasks + ONE batch of rendered student blocks. */
function sessionBatchContext(corpus: any, items: MapItem[]): string {
    return [sessionTaskBlock(corpus), '', `=== STUDENTS IN THIS BATCH (${items.length} block(s)) — complete records ===`,
        ...items.map((it) => it.text), '', '=== END BATCH. Reply with the JSON. ==='].join('\n');
}

function parseSessionMap(raw: string, tokens: Set<string>, labels: Set<string>, points: Map<string, string>) {
    let j: any;
    try {
        j = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    } catch (e) {
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('map reply is not JSON');
        j = JSON.parse(m[0]);
    }
    const tok = (x: any) => (tokens.has(String(x)) ? String(x) : null);
    const pointName = (x: any) => points.get(String(x || '').toLowerCase()) || String(x || '').slice(0, 60);
    const students = (Array.isArray(j?.students) ? j.students : []).map((s: any) => ({
        s: tok(s?.s), summary: String(s?.summary || '').slice(0, 400),
        struggles: (Array.isArray(s?.struggles) ? s.struggles : []).slice(0, 6).map((x: any) => ({ concept: pointName(x?.concept), evidence: String(x?.evidence || '').slice(0, 200) })),
        engagement: ['active', 'partial', 'evasive', 'none'].includes(s?.engagement) ? s.engagement : 'partial',
        attention: !!s?.attention, reason: String(s?.reason || '').slice(0, 200),
    })).filter((s: any) => s.s);
    const errors = (Array.isArray(j?.errors) ? j.errors : []).map((e: any) => ({
        category: String(e?.category || '').slice(0, 80), concept: pointName(e?.concept),
        tasks: (Array.isArray(e?.tasks) ? e.tasks : []).map(String).filter((l: string) => labels.has(l)),
        students: (Array.isArray(e?.students) ? e.students : []).map(tok).filter((x: any) => x),
        evidence: String(e?.evidence || '').slice(0, 240),
    })).filter((e: any) => e.category && e.students.length);
    const tutor = (Array.isArray(j?.tutor) ? j.tutor : []).map((t: any) => ({ s: tok(t?.s), task: labels.has(String(t?.task)) ? String(t.task) : '', observation: String(t?.observation || '').slice(0, 240) })).filter((t: any) => t.s);
    const notes = (Array.isArray(j?.notes) ? j.notes : []).map((x: any) => String(x).slice(0, 240)).slice(0, 3);
    return { students, errors, tutor, notes };
}

/** REDUCE context: statistics + merged findings. */
function sessionReportContext(corpus: any, findings: any): string {
    const L: string[] = [`=== SESSION: "${corpus.sdoc.title}" — ${corpus.uids.length} participating students, ${corpus.tasks.length} tasks ===`];
    L.push(sessionTaskBlock(corpus), '');
    L.push('=== PER-TASK STATISTICS (deterministic) ===');
    for (const p of corpus.perTask) {
        L.push(`${p.label} "${p.title}": attempted ${p.attempted}, solved ${p.solved}, median attempts ${p.medianAttempts}, max ${p.maxAttempts}, median minutes to first accept ${p.medianMinutesToAc}, skipped by ${p.skipped}`);
        L.push(`  failing verdicts (all attempts): ${Object.entries(p.verdicts).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}; first-attempt verdicts: ${Object.entries(p.firstFail).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);
        L.push(`  tutor: ${p.tutor.threads} dialogues, ${p.tutor.questions} questions, ${p.tutor.replies} replies, "I don't know" ${p.tutor.idk}, unanswered ${p.tutor.unanswered}, resolved ${p.tutor.resolvedRate}%${p.tutor.meanReasoning != null ? `, mean reasoning level ${p.tutor.meanReasoning}/4` : ''}${p.tutor.meanOwnership != null ? `, mean ownership level ${p.tutor.meanOwnership}/4` : ''}`);
    }
    L.push('', '=== PER-KNOWLEDGE-POINT STATISTICS ===');
    for (const e of corpus.perPoint) L.push(`${e.path}: tasks ${e.tasks.join(', ')}; solved rate ${e.solvedRate}% (${e.solved}/${e.attempted} task-attempts); students with surfaced misconception ${e.surfaced}${e.surfacedStudents.length ? ` (${e.surfacedStudents.join(', ')})` : ''}; "I don't know" replies ${e.idk}`);
    const en = corpus.engagement;
    L.push('', `=== TUTOR ENGAGEMENT (whole session) === students ${en.students}; engaged reasoners ${en.active}, partial ${en.partial}, silent ${en.silent}; questions ${en.questions}, replies ${en.replies}, "I don't know" ${en.idk} (${pct(en.idk, en.replies)}% of replies)`);
    const R = corpus.results;
    L.push('', R.evaluated
        ? `=== RUBRIC RESULTS (evaluated ${R.final ? 'final' : 'provisional'}) === students ${R.students}; mean total ${R.meanTotal}/100, median ${R.medianTotal}; means — achievement ${R.meanAchievement}/30, ownership ${R.meanOwnership}/20, guidance-to-fix ${R.meanFixconv}/15, reasoning ${R.meanReasoning}/30, initiative ${R.meanInitiative}/5`
        : '=== RUBRIC RESULTS === not evaluated yet');
    const cov = findings.coverage || { students: corpus.uids.length, analyzed: corpus.uids.length, cached: 0, unanalyzed: [] as string[] };
    L.push('', `=== FINDINGS OF THE PER-STUDENT ANALYSIS (${cov.analyzed} of ${cov.students} students read individually — every submission and tutor exchange${cov.cached ? `; ${cov.cached} unchanged since the last report, reused` : ''}) ===`);
    if (cov.unanalyzed.length) L.push(`NOTE: ${cov.unanalyzed.length} student(s) could NOT be analyzed individually and appear in the statistics only: ${cov.unanalyzed.join(', ')}. Say so in section 1.`);
    else L.push('Every participating student was analyzed individually.');
    L.push('--- classified errors (merged) ---');
    for (const e of findings.errors) L.push(`- [${e.concept}] ${e.category}: ${e.students.length} student(s) (${e.students.slice(0, 20).join(', ')}${e.students.length > 20 ? ', …' : ''}) on ${e.tasks.join(', ') || '?'} — ${e.evidence}`);
    /*
     * 📏 Two hundred per-student lines do not fit one call. The students
     * who need the teacher's eye keep their full line; everyone else is
     * listed by engagement group with a short summary — and if the
     * context is still over budget, the summaries go, then the tutor
     * observations, while the group lists (which name every student) stay.
     */
    const attention = findings.students.filter((x: any) => x.attention);
    const rest = findings.students.filter((x: any) => !x.attention);
    const groups: Record<string, string[]> = { active: [], partial: [], evasive: [], none: [] };
    for (const x of rest) (groups[x.engagement] || groups.partial).push(x.s);
    const line = (x: any, full: boolean) => `${x.s}: engagement=${x.engagement}${x.attention ? ` ATTENTION (${x.reason})` : ''} — ${full ? x.summary : x.summary.slice(0, 160)}${x.struggles.length ? ` | struggles: ${x.struggles.slice(0, full ? 6 : 3).map((y: any) => `${y.concept}${full ? ` (${y.evidence})` : ''}`).join('; ')}` : ''}`;
    const build = (tier: number) => {
        const out: string[] = ['--- students needing attention ---', ...attention.map((x: any) => line(x, tier === 0))];
        out.push('--- other students, by tutor engagement (every token listed) ---');
        for (const [g, toks] of Object.entries(groups)) if (toks.length) out.push(`${g}: ${toks.join(', ')}`);
        if (tier <= 1) out.push('--- their summaries ---', ...rest.map((x: any) => line(x, false)));
        if (tier <= 2 && findings.tutor.length) out.push('--- tutor dialogue observations ---', ...findings.tutor.slice(0, tier === 0 ? 60 : 30).map((t: any) => `- ${t.s} on ${t.task || '?'}: ${t.observation}`));
        if (findings.notes.length) out.push('--- batch notes ---', ...findings.notes.map((n: string) => `- ${n}`));
        return out;
    };
    const budget = SESSION_REDUCE_CHARS();
    const head = L.join('\n').length;
    let tier = 0;
    let body = build(tier);
    while (tier < 3 && head + body.join('\n').length > budget) {
        tier += 1;
        body = build(tier);
    }
    L.push(...body);
    L.push('', '=== End of context. Write the report now. ===');
    return L.join('\n');
}

/**
 * 📡 The session report JOB — detached from the request, progress on the
 * report document (the page polls it): collect → map (batches of students,
 * three at a time) → reduce → substitute names → store.
 */
async function runSessionReportJob(domainId: string, sdoc: SelfLearningDoc, by: number): Promise<void> {
    const tid = String(sdoc.docId);
    const startedAt = new Date();
    const progress = (patch: any) => setClassReportJob(domainId, tid, { status: 'running', stage: 'collect', done: 0, total: 0, startedAt, by, ...patch });
    try {
        await progress({ stage: 'collect' });
        const corpus = await buildSessionCorpus(domainId, sdoc, false);
        if (!corpus.uids.length) throw new Error('No judged submissions yet — nothing to analyze.');
        const tokens = new Set<string>([...corpus.sOf.values()]);
        const labels = new Set<string>(corpus.tasks.map((t: any) => t.label));
        const pointNames = new Map<string, string>();
        for (const t of corpus.tasks) for (const n of t.points) pointNames.set(String(n).toLowerCase(), String(n));

        // 🗂 The cache: students whose transcript hashes as before were
        // analyzed by an earlier run — their findings are reused verbatim.
        const hashOf = new Map<number, string>();
        for (const st of corpus.students) hashOf.set(st.uid, createHash('sha1').update(renderStudent(st, 0)).digest('hex'));
        const cache = await getClassReportMapCache(domainId, tid, corpus.uids);
        const perStudent = new Map<string, any>(); // S-token → merged findings for that student
        const analyzedNow = new Set<string>();
        const cachedNow = new Set<string>();
        const fresh: any[] = [];
        for (const st of corpus.students) {
            const c = cache.get(st.uid);
            if (c && c.hash === hashOf.get(st.uid) && c.findings) {
                perStudent.set(st.s, { ...c.findings, s: st.s });
                cachedNow.add(st.s);
            } else fresh.push(st);
        }

        const budget = SESSION_BATCH_CHARS();
        const { batches, parts, startLevel } = packSessionBatches(fresh, budget);
        logger.info('[pta-ui] session report: %d fresh student(s) → %d call(s) at compaction level %d (%d-char budget)%s', fresh.length, batches.length, startLevel, budget, parts ? `; ${parts} student part(s) split by task` : '');
        await progress({ stage: 'map', done: 0, total: batches.length, students: corpus.uids.length, analyzed: cachedNow.size, cached: cachedNow.size });

        // Findings per batch are folded into per-student records and the
        // shared error / dialogue lists as they arrive.
        const errByKey = new Map<string, any>();
        const tutorObs: any[] = [];
        const notes: string[] = [];
        const absorb = (r: any, items: MapItem[]) => {
            const inBatch = new Set(items.map((it) => it.st.s));
            for (const sx of r.students) {
                if (!inBatch.has(sx.s)) continue;
                const prev = perStudent.get(sx.s);
                if (!prev) perStudent.set(sx.s, sx);
                else {
                    // A student analyzed in parts: union the findings, keep the stronger flag.
                    prev.summary = prev.summary.length >= sx.summary.length ? prev.summary : sx.summary;
                    for (const g of sx.struggles) if (!prev.struggles.some((x: any) => x.concept === g.concept)) prev.struggles.push(g);
                    prev.attention = prev.attention || sx.attention;
                    if (sx.attention && !prev.reason) prev.reason = sx.reason;
                    const rank = ['none', 'evasive', 'partial', 'active'];
                    prev.engagement = rank[Math.max(rank.indexOf(prev.engagement), rank.indexOf(sx.engagement))] || prev.engagement;
                }
                analyzedNow.add(sx.s);
            }
            for (const e of r.errors) {
                const key = `${e.concept.toLowerCase()}|${e.category.toLowerCase()}`;
                if (!errByKey.has(key)) errByKey.set(key, { ...e, students: [], tasks: [] });
                const m = errByKey.get(key);
                for (const st of e.students) if (!m.students.includes(st)) m.students.push(st);
                for (const t of e.tasks) if (!m.tasks.includes(t)) m.tasks.push(t);
            }
            tutorObs.push(...r.tutor);
            notes.push(...r.notes);
        };

        /*
         * 🔁 A batch that fails is not dropped: it is bisected until the
         * offending item stands alone, and a lone item is retried one
         * compaction level tighter. Only an item that fails at the tightest
         * level is given up on — and then the report names the student.
         */
        let done = 0;
        const analyzeItems = async (items: MapItem[], depth = 0): Promise<void> => {
            // 🔁 Transient provider errors are retried with backoff (shared
            // cooldown on 429) before the batch is split; a malformed reply
            // gets one fresh call.
            const ctx = sessionBatchContext(corpus, items);
            for (let ask = 0; ask < 2; ask++) {
                try {
                    const raw = await aiTutor.callWithRetry(() => aiTutor.runSessionMapBatch(ctx), { label: `session map (${items.length} block(s))` });
                    absorb(parseSessionMap(raw, tokens, labels, pointNames), items);
                    return;
                } catch (e) {
                    logger.warn('[pta-ui] session report map call failed (%d block(s), depth %d, ask %d): %s', items.length, depth, ask + 1, e.message);
                    if (aiTutor.isTransientProviderError(e)) break;
                }
            }
            if (items.length > 1) {
                const mid = Math.ceil(items.length / 2);
                await analyzeItems(items.slice(0, mid), depth + 1);
                await analyzeItems(items.slice(mid), depth + 1);
                return;
            }
            const it = items[0];
            if (it.level < SESSION_LEVELS.length - 1) {
                const tighter: MapItem = { ...it, level: it.level + 1, text: renderStudent(it.st, it.level + 1, it.tasks, it.part) };
                await analyzeItems([tighter], depth + 1);
            }
        };
        let cursor = 0;
        const worker = async () => {
            for (;;) {
                const idx = cursor++;
                if (idx >= batches.length) return;
                await analyzeItems(batches[idx]);
                done += 1;
                await progress({ stage: 'map', done, total: batches.length, students: corpus.uids.length, analyzed: analyzedNow.size + cachedNow.size, cached: cachedNow.size });
            }
        };
        await Promise.all(Array.from({ length: SESSION_MAP_CONCURRENCY() }, () => worker()));

        // 🗂 Remember this run's per-student findings for the next one.
        for (const st of fresh) {
            const f = perStudent.get(st.s);
            if (f && analyzedNow.has(st.s)) await setClassReportMapCache(domainId, tid, st.uid, hashOf.get(st.uid)!, { ...f, s: undefined }).catch(() => {});
        }
        const unanalyzed = corpus.students.map((st: any) => st.s).filter((tok: string) => !perStudent.has(tok));
        const findings = {
            errors: [...errByKey.values()].sort((x, y) => y.students.length - x.students.length).slice(0, 40),
            students: [...perStudent.values()],
            tutor: tutorObs,
            notes: notes.slice(0, 8),
            coverage: { students: corpus.uids.length, analyzed: analyzedNow.size + cachedNow.size, cached: cachedNow.size, unanalyzed },
        };
        const failed = unanalyzed.length;
        await progress({ stage: 'reduce', done: batches.length, total: batches.length, students: corpus.uids.length, analyzed: findings.coverage.analyzed, cached: cachedNow.size, unanalyzed: failed });
        const sessionCtx = sessionReportContext(corpus, findings);
        const raw = await aiTutor.callWithRetry(() => aiTutor.runSessionReport(sessionCtx), { label: 'session reduce' });
        await progress({ stage: 'finalize', done: batches.length, total: batches.length, students: corpus.uids.length, analyzed: findings.coverage.analyzed, cached: cachedNow.size, unanalyzed: failed });
        const sidMap = [...corpus.sOf.entries()].map(([uid, sTok]) => ({ s: sTok, uid, uname: corpus.udict[uid]?.uname || `user#${uid}` }));
        // Remedial prompts first (so their block is stripped), then concepts.
        const { report: withoutRemedial, remedial: remedialAnon } = extractRemedialBlock(raw, labels, new Set(sidMap.map((e) => e.s)));
        const { report: reportAnon, concepts: conceptsAnon } = extractConceptBlock(withoutRemedial, labels);
        const byTok = new Map(sidMap.map((e) => [e.s, e.uname]));
        const uidByTok = new Map(sidMap.map((e) => [e.s, e.uid]));
        const substitute = (text: string) => text.replace(/\bS(\d+)\b/g, (m) => byTok.get(m) || m);
        const reportNamed = substitute(reportAnon);
        const concepts = conceptsAnon.map((c: any) => ({ ...c, students: (c.students || []).map((tok: string) => byTok.get(tok) || tok) }));
        const remedial = remedialAnon.map((r: any) => ({
            ...r,
            brief: substitute(r.brief),
            students: (r.students || []).map((tok: string) => byTok.get(tok) || tok),
            uids: (r.students || []).map((tok: string) => uidByTok.get(tok)).filter((u: any) => typeof u === 'number'),
        }));
        await setClassReport({
            domainId, tid, reportAnon, reportNamed, sidMap, concepts, remedial, statsSnapshot: corpus.light, participants: corpus.uids.length, generatedBy: by,
        });
        await setClassReportJob(domainId, tid, {
            status: 'done', stage: 'done', done: batches.length, total: batches.length, startedAt, finishedAt: new Date(), by,
            students: corpus.uids.length, analyzed: findings.coverage.analyzed, cached: cachedNow.size, unanalyzed: failed,
        });
        logger.info('[pta-ui] session report generated for %s/%s by uid=%d (%d students: %d analyzed now, %d from cache, %d unanalyzed; %d calls)', domainId, tid, by, corpus.uids.length, analyzedNow.size, cachedNow.size, failed, batches.length);
    } catch (e) {
        logger.warn('[pta-ui] session report job for %s/%s failed: %s', domainId, tid, e.message);
        await setClassReportJob(domainId, tid, { status: 'failed', stage: 'done', done: 0, total: 0, startedAt, finishedAt: new Date(), error: String(e.message || e).slice(0, 300), by }).catch(() => {});
    }
}

/**
 * Teacher-only class report over one contest/homework: GET serves the cached
 * report plus cheap live stats (dry=1 returns the full assembled context for
 * auditing, no LLM call); POST collects, generates, name-substitutes, and
 * stores both the anonymous and the named variants.
 */
/**
 * PTA fork — REMEDIAL CARDS. Enrich the report's stored prompts with what
 * only the live catalog and problem set can say:
 *
 *  • `catalog` — does the concept resolve to a knowledge point (by name or
 *    alias)? A draft targeting an unresolved name would create a near-
 *    duplicate point, so the card flags it instead of hiding it.
 *  • `existing` — tasks ALREADY in the problem set that carry the point and
 *    were not in this activity, ranked by how many of the affected students
 *    have not solved them. Reuse is cheaper and faster than creation, and
 *    the knowledge map targets a reused task at once; creating is the
 *    fallback when nothing fits.
 *  • `avoidTitles` — the activity tasks the new one must not resemble.
 */
async function enrichRemedial(domainId: string, remedial: RemedialPrompt[], activityPids: number[]): Promise<any[]> {
    if (!remedial?.length) return [];
    const own = new Set(activityPids.map(Number));
    const activityPdict = activityPids.length
        ? await problem.getList(domainId, activityPids, true, false, ['docId', 'pid', 'title'] as any, true)
        : {};
    const titleOfLabel = new Map<string, string>();
    for (const pd of Object.values(activityPdict) as any[]) if (pd) titleOfLabel.set(String(pd.pid || `P${pd.docId}`), pd.title || '');
    const out: any[] = [];
    for (const r of remedial) {
        // eslint-disable-next-line no-await-in-loop
        const canonical = await KnowledgeModel.resolve(domainId, r.concept);
        let existing: any[] = [];
        if (canonical) {
            // eslint-disable-next-line no-await-in-loop
            const candidates = await problem.getMulti(domainId, { tag: canonical, hidden: { $ne: true } }, ['docId', 'pid', 'title', 'difficulty'] as any)
                .limit(24).toArray() as any[];
            const pool = candidates.filter((c) => !own.has(c.docId));
            const uids = (r.uids || []).filter((u) => typeof u === 'number');
            const solvedBy = new Map<number, number>();
            if (pool.length && uids.length) {
                // eslint-disable-next-line no-await-in-loop
                const psdocs = await problem.getMultiStatus(domainId, { uid: { $in: uids }, docId: { $in: pool.map((c) => c.docId) }, status: STATUS.STATUS_ACCEPTED })
                    .project({ docId: 1 }).toArray();
                for (const ps of psdocs as any[]) solvedBy.set(ps.docId, (solvedBy.get(ps.docId) || 0) + 1);
            }
            existing = pool
                .map((c) => ({
                    docId: c.docId, pid: String(c.pid || c.docId), title: c.title || '', difficulty: c.difficulty || 0,
                    unsolvedBy: Math.max(0, uids.length - (solvedBy.get(c.docId) || 0)),
                }))
                .sort((a, b) => b.unsolvedBy - a.unsolvedBy || a.difficulty - b.difficulty)
                .slice(0, 3);
        }
        out.push({
            ...r,
            catalog: !!canonical,
            canonical: canonical || r.concept,
            avoidTitles: (r.avoid || []).map((l) => ({ label: l, title: titleOfLabel.get(l) || '' })),
            existing,
        });
    }
    return out;
}

/**
 * The drafts already created from this report, with their CURRENT Studio
 * state — so a reopened report shows "Verifying…" / "Published as F12"
 * rather than the create cards again. A draft the teacher discarded since
 * is reported as gone.
 */
async function createdRemedialDrafts(h: Handler, domainId: string, doc: any): Promise<any[]> {
    const entries: any[] = doc?.remedialDrafts || [];
    if (!entries.length) return [];
    const live = await draftSummariesIn(domainId, entries.map((e) => e.draftId));
    return entries.map((e) => {
        const d = live.get(String(e.draftId));
        return {
            concept: e.concept,
            draftId: String(e.draftId),
            title: d?.title || e.title,
            kind: d?.kind || e.kind,
            createdAt: e.createdAt,
            gone: !d,
            status: d ? (d.published ? (d.publishedHidden ? 'published_hidden' : 'published') : (d.status || 'idle')) : 'gone',
            stage: d?.stage || '',
            hasStatement: !!d?.title,
            pids: d?.pids || [],
            docId: d?.docId || null,
            url: h.url('ai_studio_detail', { id: e.draftId }),
            problemUrl: d?.docId ? h.url('problem_detail', { pid: d.docId }) : null,
        };
    });
}

class AiClassReportHandler extends Handler {
    async classTdoc(domainId: string, tid: ObjectId) {
        let tdoc: any = null;
        let kind = 'contest';
        try {
            tdoc = await contest.get(domainId, tid);
            kind = tdoc?.rule === 'homework' ? 'homework' : 'contest';
        } catch (e) { /* not a contest/homework — try self-learning */ }
        if (!tdoc) {
            tdoc = await SelfLearningModel.get(domainId, tid);
            kind = 'self-learning';
        }
        if (!tdoc) throw new NotFoundError(tid);
        const isTeacher = this.user.role === 'root'
            || this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)
            || tdoc.owner === this.user._id;
        if (!isTeacher) throw new ForbiddenError('Only the activity owner or a domain root can access the class report.');
        return { tdoc, kind };
    }

    @param('tid', Types.ObjectId)
    @param('dry', Types.Boolean, true)
    @param('job', Types.Boolean, true)
    @param('quick', Types.Boolean, true)
    @param('deck', Types.Boolean, true)
    async get({ domainId }, tid: ObjectId, dry = false, jobOnly = false, quick = false, deck = false) {
        if (deck) {
            await this.respondDeck(domainId, tid);
            return;
        }
        const { tdoc, kind } = await this.classTdoc(domainId, tid);
        if (quick) {
            await this.respondQuick(domainId, tdoc, kind, jobOnly);
            return;
        }
        const staleMs = kind === 'self-learning' ? SESSION_JOB_STALE_MS : ACTIVITY_JOB_STALE_MS;
        // 💓 Dead = no heartbeat for staleMs (every batch writes one), never
        // "started long ago": a 200-student run legitimately takes an hour.
        const jobOf = (doc: any) => {
            let job = doc?.job || null;
            if (classReportJobStale(job, staleMs)) {
                job = { ...job, status: 'failed', error: 'The report job stopped reporting progress (the server may have restarted). Generate it again.' };
            }
            return job;
        };
        // 📡 The poll while a job runs: the job state alone, no statistics
        // (the page re-fetches everything once the job ends).
        if (jobOnly) {
            const doc = await getClassReport(domainId, String(tid));
            this.response.body = { kind, job: jobOf(doc), generatedAt: doc?.generatedAt || null };
            return;
        }
        if (kind === 'self-learning') {
            // 📊 The session report: cached report + live statistics + the
            // state of a running job.
            const [doc, corpus] = await Promise.all([
                getClassReport(domainId, String(tid)),
                buildSessionCorpus(domainId, tdoc, true),
            ]);
            this.response.body = {
                kind,
                report: doc?.reportNamed || null,
                generatedAt: doc?.generatedAt || null,
                participants: doc?.participants ?? null,
                concepts: doc?.concepts || [],
                remedial: await enrichRemedial(domainId, doc?.remedial || [], tdoc.pids || []),
                remedialDrafts: await createdRemedialDrafts(this, domainId, doc),
                stats: corpus.light,
                job: jobOf(doc),
            };
            return;
        }
        /*
         * 📊 HOMEWORK / TEST: the same shape, from lib/activity_report —
         * every task with its knowledge points and answer key, every
         * student's every submission and answer, the scoreboard and the
         * timeline (dry=1 returns the assembled reduce context for auditing,
         * no LLM call).
         */
        if (dry) {
            const corpus = await buildActivityCorpus(domainId, tdoc, kind as any, false);
            this.response.body = {
                kind,
                light: corpus.light,
                tasks: corpus.tasks,
                students: corpus.students.length,
                sampleStudent: corpus.students.length ? renderActivityStudent(corpus.students[0], 0) : '',
                context: activityReportContext(corpus, {
                    errors: [], misconceptions: [], students: [], notes: [], coverage: { students: corpus.uids.length, analyzed: 0, cached: 0, unanalyzed: [] },
                }),
            };
            return;
        }
        const [doc, corpus] = await Promise.all([
            getClassReport(domainId, String(tid)),
            buildActivityCorpus(domainId, tdoc, kind as any, true),
        ]);
        this.response.body = {
            kind,
            report: doc?.reportNamed || null,
            generatedAt: doc?.generatedAt || null,
            participants: doc?.participants ?? null,
            concepts: doc?.concepts || [],
            remedial: await enrichRemedial(domainId, doc?.remedial || [], tdoc.pids || []),
            remedialDrafts: await createdRemedialDrafts(this, domainId, doc),
            stats: corpus.light,
            job: jobOf(doc),
        };
    }

    /*
     * ⚡ QUICK REVIEW (lib/quick_review.ts): the exact statistics of a
     * finished test + the one-call diagnosis, cached on the class-report
     * document. `stale` tells the page the cache no longer matches the
     * scoreboard (a re-grade, a score override); a stale or missing review
     * of an ENDED activity is regenerated in the background right away when
     * ai_tutor.quick_review_auto is on, so the teacher's click after the
     * end normally finds it ready.
     */
    async respondQuick(domainId: string, tdoc: any, kind: string, jobOnly: boolean) {
        if (kind === 'self-learning') throw new BadRequestError('Quick Review is for tests and homework.');
        const tid = String(tdoc.docId);
        const q = await getQuickForTeacher(domainId, tid);
        let job: any = q?.job || null;
        if (quickJobStale(job, QUICK_JOB_STALE_MS)) job = { ...job, status: 'failed', error: 'The review job stopped reporting progress (the server may have restarted). Generate it again.' };
        if (jobOnly) {
            this.response.body = { kind, job, generatedAt: q?.generatedAt || null };
            return;
        }
        const ended = contest.isDone(tdoc);
        const light = (await buildActivityCorpus(domainId, tdoc, kind as any, true)).light;
        const currentHash = resultsHashOf(light);
        const stale = !!q?.digest && q.digest.resultsHash !== currentHash;
        const running = job?.status === 'running';
        const failedRecently = job?.status === 'failed' && job.updatedAt && Date.now() - new Date(job.updatedAt).getTime() < 5 * 60 * 1000;
        if (!running && !failedRecently && ended && light.participants && (!q?.digest || stale) && system.get('ai_tutor.quick_review_auto') !== false) {
            startQuickReview(domainId, tdoc, kind as any, { by: this.user._id });
            job = { status: 'running', stage: 'collect', startedAt: new Date(), updatedAt: new Date(), by: this.user._id };
        }
        const policy = String(system.get('ai_tutor.quick_review_student_feedback') || 'on_end');
        this.response.body = {
            kind,
            title: tdoc.title,
            ended,
            stale,
            job: job && job.status !== 'done' ? job : null,
            quick: q?.digest ? {
                generatedAt: q.generatedAt, by: q.by, digest: q.digest, diagnosis: q.diagnosis || null, diagnosisNote: q.diagnosisNote || '', diagnosisRaw: q.diagnosisRaw || '', released: !!q.released, prewarm: q.prewarm || null,
            } : null,
            policy,
            studentFeedback: kind === 'contest' ? studentFeedbackVisible(tdoc, q) : false,
            stats: light,
            links: {
                paper: this.url(kind === 'homework' ? 'homework_paper' : 'contest_paper', { tid: tdoc.docId }),
                scoreboard: this.url(kind === 'homework' ? 'homework_scoreboard' : 'contest_scoreboard', { tid: tdoc.docId }),
            },
        };
    }

    /*
     * ⚡ The class-review DECK for the students who took the test: the same
     * slides the teacher projects (anonymous aggregates, the re-teach, the
     * quick checks), once the feedback policy shows them their results.
     * Staff get it regardless. Never the per-student map, never the panel.
     */
    async respondDeck(domainId: string, tid: ObjectId) {
        const tdoc = await contest.get(domainId, tid);
        if (!tdoc || tdoc.rule === 'homework') throw new NotFoundError(tid);
        const staff = this.user.own(tdoc) || this.user.hasPerm(PERM.PERM_EDIT_CONTEST) || (tdoc.maintainer || []).includes(this.user._id);
        const q = await getQuickForTeacher(domainId, String(tid));
        if (!staff) {
            const tsdoc = await contest.getStatus(domainId, tid, this.user._id);
            if (!tsdoc?.attend) throw new ForbiddenError('Only students who took this test can open its review.');
            if (!studentFeedbackVisible(tdoc, q)) throw new ForbiddenError('The class review opens after the test ends.');
        }
        this.response.body = {
            kind: 'contest',
            title: tdoc.title,
            quick: q?.digest ? { generatedAt: q.generatedAt, digest: q.digest, diagnosis: q.diagnosis || null } : null,
        };
    }

    /** Start (or re-attach to) the Quick Review job. */
    @param('tid', Types.ObjectId)
    async postQuick({ domainId }, tid: ObjectId) {
        const { tdoc, kind } = await this.classTdoc(domainId, tid);
        if (kind === 'self-learning') throw new BadRequestError('Quick Review is for tests and homework.');
        if (!contest.isDone(tdoc)) throw new ForbiddenError('The activity has not ended yet — the review is built from final results.');
        const q = await getQuick(domainId, String(tid));
        if (q?.job && q.job.status === 'running' && !quickJobStale(q.job, QUICK_JOB_STALE_MS)) {
            this.response.body = { kind, started: false, job: q.job };
            return;
        }
        await this.limitRate('ai_quick_review', 300, 6, '{{user}}');
        startQuickReview(domainId, tdoc, kind as any, { by: this.user._id });
        this.response.body = { kind, started: true };
    }

    /** `on_teacher` policy: show / hide the students' weak-points card and Explain. */
    @param('tid', Types.ObjectId)
    @param('released', Types.Boolean)
    async postRelease({ domainId }, tid: ObjectId, released: boolean) {
        const { tdoc } = await this.classTdoc(domainId, tid);
        await setQuickReleased(domainId, String(tid), released);
        this.response.body = { released, studentFeedback: studentFeedbackVisible(tdoc, { released }) };
    }

    /**
     * "Fix knowledge point": the teacher's names for one question win over
     * the inference; the review is rebuilt so the weak-point ranking, the
     * students' cards and the map evidence follow.
     */
    @param('tid', Types.ObjectId)
    @param('pid', Types.Int)
    @param('key', Types.String)
    @param('points', Types.Content)
    async postFixPoint({ domainId }, tid: ObjectId, pid: number, key: string, points: string) {
        const { tdoc, kind } = await this.classTdoc(domainId, tid);
        if (!(tdoc.pids || []).includes(pid)) throw new NotFoundError(pid);
        let names: string[] = [];
        try {
            const parsed = JSON.parse(points);
            names = Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
        } catch (e) {
            names = String(points).split(/[,;\n]/);
        }
        names = [...new Set(names.map((n) => n.trim()).filter((n) => n))].slice(0, 6);
        const resolved: string[] = [];
        for (const n of names) resolved.push((await KnowledgeModel.resolve(domainId, n).catch(() => null)) || n);
        await setQuestionPoints(domainId, pid, String(key).slice(0, 16), resolved, 'teacher', this.user._id);
        if (contest.isDone(tdoc)) startQuickReview(domainId, tdoc, kind as any, { by: this.user._id, prewarm: false });
        this.response.body = { points: resolved };
    }

    /**
     * 🧩 "Create N tasks" from the remedial cards. The teacher's EDITED
     * cards arrive (brief, kind, difficulty, title — whatever they changed
     * on screen), so what gets drafted is what they approved, not what the
     * model first wrote. Each becomes a Studio draft via the same creator
     * the Studio form uses; every statement starts at once, and the page
     * opens a tab per draft so the teacher decides each one — Continue
     * (solutions, tests, verification) or Discard — in the Studio itself.
     */
    @param('tid', Types.ObjectId)
    @param('items', Types.Content)
    async postRemedialCreate({ domainId }, tid: ObjectId, items: string) {
        const { tdoc, kind } = await this.classTdoc(domainId, tid);
        await this.limitRate('ai_class_report_remedial', 60, 4, '{{user}}');
        let picked: any[];
        try {
            picked = JSON.parse(items);
        } catch {
            throw new BadRequestError('Bad remedial payload.');
        }
        if (!Array.isArray(picked) || !picked.length) throw new BadRequestError('Nothing selected.');
        if (picked.length > 8) throw new BadRequestError('At most 8 tasks at a time.');
        const doc = await getClassReport(domainId, String(tid));
        const stored = doc?.remedial || [];
        const activityTitle = String(tdoc.title || '');
        const activityLang = (Array.isArray(tdoc.langs) ? tdoc.langs : []).find((l: string) => setting.langs[l] && !setting.langs[l].disabled) || '';
        const pidsList: number[] = tdoc.pids || [];
        const pdict = pidsList.length ? await problem.getList(domainId, pidsList, true, false, ['docId', 'pid', 'title'] as any, true) : {};
        const titleOfLabel = new Map<string, string>();
        for (const pd of Object.values(pdict) as any[]) if (pd) titleOfLabel.set(String(pd.pid || `P${pd.docId}`), pd.title || '');
        const briefs = picked.map((it: any, i: number) => {
            const base = stored.find((r) => r.concept === it.concept) || stored[i] || {} as any;
            const concept = String(it.concept || base.concept || '').slice(0, 60);
            const avoid: string[] = Array.isArray(it.avoid) ? it.avoid.map(String) : (base.avoid || []);
            const affected = base.students?.length || 0;
            const notes = [
                String(it.brief || base.brief || '').trim(),
                '',
                `Context: this task is remedial practice generated from the AI class report of ${kind === 'self-learning' ? 'self-learning session' : kind} "${activityTitle}", where ${affected} student(s) struggled with "${concept}".`,
                avoid.length ? `Do NOT resemble these tasks the students already saw: ${avoid.map((l) => `${l}${titleOfLabel.get(l) ? ` "${titleOfLabel.get(l)}"` : ''}`).join(', ')}. Same knowledge point, different scenario, different input shape.` : '',
            ].filter((x) => x !== undefined).join('\n');
            return {
                topic: String(it.title || base.title || concept).slice(0, 200),
                notes,
                // Only code kinds are remedial tasks; anything else is a programming task.
                kind: ['programming', 'function'].includes(String(it.kind || base.kind)) ? String(it.kind || base.kind) : 'programming',
                difficulty: String(it.difficulty || base.difficulty || 'intro'),
                language: activityLang,
                knowledge: concept,
                crosscheck: true,
                origin: `class report of "${activityTitle}"`,
            };
        });
        const created = await createRemedialDrafts(domainId, this.user._id, briefs);
        // Remember them on the report: reopening it shows these drafts (with
        // live status) instead of the create cards for their concepts.
        await addClassReportDrafts(domainId, String(tid), created.map((c, i) => ({
            concept: String(briefs[i]?.knowledge || ''), draftId: c.id, title: c.title, kind: c.kind, createdAt: new Date(),
        })));
        this.response.body = {
            created: created.map((c) => ({ ...c, url: this.url('ai_studio_detail', { id: c.id }) })),
            studioUrl: this.url('ai_studio'),
        };
    }

    @param('tid', Types.ObjectId)
    async post({ domainId }, tid: ObjectId) {
        /*
         * ⚠ The framework runs `post` BEFORE `post<Operation>` on EVERY
         * operation POST (framework/server.ts: the step list is
         * `method` then `post${operation}`). A bare POST from the page
         * means "start the report"; an operation POST (remedial_create)
         * must NOT — without this guard, creating remedial drafts silently
         * kicked off a full report regeneration each time.
         */
        if (this.request.body?.operation) return;
        const { tdoc, kind } = await this.classTdoc(domainId, tid);
        if (!aiTutor.tutorConfigured()) throw new ForbiddenError('The AI tutor is not configured. Please ask the administrator to set an API key.');
        /*
         * 📡 ALWAYS A BACKGROUND JOB, never the request: reading every
         * student's every submission (and, for sessions, every tutor
         * exchange) takes minutes, and the page may be refreshed or closed
         * meanwhile — the job carries on and the report is there when the
         * teacher returns. One job per activity at a time; a second click
         * while it runs just returns the progress the page is polling.
         */
        const staleMs = kind === 'self-learning' ? SESSION_JOB_STALE_MS : ACTIVITY_JOB_STALE_MS;
        const doc = await getClassReport(domainId, String(tid));
        const running = doc?.job && doc.job.status === 'running' && !classReportJobStale(doc.job, staleMs);
        if (running) {
            this.response.body = { kind, started: false, job: doc!.job };
            return;
        }
        await this.limitRate('ai_class_report', 600, 3, '{{user}}');
        const startedAt = new Date();
        const job = {
            status: 'running' as const, stage: 'collect' as const, done: 0, total: 0, startedAt, by: this.user._id,
        };
        await setClassReportJob(domainId, String(tid), job);
        if (kind === 'self-learning') runSessionReportJob(domainId, tdoc, this.user._id); // detached on purpose
        else runActivityReportJob(domainId, tdoc, kind as any, this.user._id); // detached on purpose
        this.response.body = { kind, started: true, job };
    }
}

/* ---------------- subjective (project-level, teacher-graded) tasks ---------------- */

const SUBJECTIVE_MAX_FILE = 25 * 1024 * 1024; // 25 MB per file
const SUBJECTIVE_MAX_FILES = 10;
const SUBJECTIVE_MAX_REPORT = 65536;

function isSubjectivePdoc(pdoc: any) {
    return /^s/i.test(String(pdoc?.pid || ''));
}

function subjectiveTeacher(h: any, pdoc: any) {
    return h.user.role === 'root' || h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM) || pdoc.owner === h.user._id;
}

const cleanFileName = (name: string) => String(name || '').replace(/.*[\\/]/, '').replace(/[^\w.() \-\u4e00-\u9fff]+/g, '_').slice(0, 120) || 'file';

/**
 * Subjective project tasks (pid starts with S): students upload files and
 * write a markdown report; teachers (problem owner or domain root) list all
 * submissions and read/download them. Nothing here touches the judge.
 */
class SubjectiveTaskHandler extends Handler {
    pdoc: any;

    /** Canonical numeric problem id: URLs may carry the display pid (e.g. "S1000"). */
    get npid(): number {
        return this.pdoc.docId;
    }

    @param('pid', Types.ProblemId)
    async prepare({ domainId }, pid: number | string) {
        this.pdoc = await problem.get(domainId, pid);
        if (!this.pdoc) throw new NotFoundError(pid);
        if (!isSubjectivePdoc(this.pdoc)) throw new BadRequestError('This problem is not a subjective task.');
    }

    @param('uid', Types.PositiveInt, true)
    @param('list', Types.Boolean, true)
    async get({ domainId }, uid?: number, list = false) {
        const pid = this.npid;
        const teacher = subjectiveTeacher(this, this.pdoc);
        if (list) {
            if (!teacher) throw new ForbiddenError('Only the problem owner or a domain root can list submissions.');
            const docs = await listSubjective(domainId, pid);
            let udict: any = {};
            try {
                udict = await user.getList(domainId, docs.map((d) => d.uid));
            } catch (e) { /* uname fallback below */ }
            this.response.body = {
                submissions: docs.map((d) => ({
                    uid: d.uid,
                    uname: udict[d.uid]?.uname || `user#${d.uid}`,
                    files: (d.files || []).length,
                    hasReport: !!(d.report || '').trim(),
                    updateAt: d.updateAt,
                })),
            };
            return;
        }
        const targetUid = (uid && uid !== this.user._id) ? uid : this.user._id;
        if (targetUid !== this.user._id && !teacher) throw new ForbiddenError('Not your submission.');
        const doc = await getSubjective(domainId, pid, targetUid);
        this.response.body = {
            report: doc?.report || '',
            files: (doc?.files || []).map((f) => ({ name: f.name, size: f.size, uploadAt: f.uploadAt })),
            updateAt: doc?.updateAt || null,
            teacher,
        };
    }

    /**
     * Hydro dispatches POSTs that carry an `operation` field to
     * post{Operation} and throws InvalidOperationError (whose inherited
     * message reads "MethodNotAllowedError") when that method is missing —
     * a generic post() is never consulted for such requests. So each
     * client operation gets its own method here.
     */
    async postReport({ domainId }) {
        const report = String(this.args.report || '').slice(0, SUBJECTIVE_MAX_REPORT);
        const updateAt = await setSubjectiveReport(domainId, this.npid, this.user._id, report);
        this.response.body = { updateAt };
    }

    async postUpload({ domainId }) {
        const pid = this.npid;
        const file = this.request.files?.file;
        if (!file || !file.size) throw new BadRequestError('No file received.');
        if (file.size > SUBJECTIVE_MAX_FILE) throw new BadRequestError('The file exceeds the 25 MB limit.');
        const doc = await getSubjective(domainId, pid, this.user._id);
        const name = cleanFileName(file.originalFilename || file.newFilename || 'file');
        const existing = (doc?.files || []).filter((f) => f.name !== name);
        if (existing.length >= SUBJECTIVE_MAX_FILES) throw new BadRequestError(`At most ${SUBJECTIVE_MAX_FILES} files.`);
        const target = `subjective/${domainId}/${pid}/${this.user._id}/${name}`;
        await storage.put(target, file.filepath, this.user._id);
        await upsertSubjectiveFile(domainId, pid, this.user._id, {
            name, size: file.size, target, uploadAt: new Date(),
        });
        const fresh = await getSubjective(domainId, pid, this.user._id);
        this.response.body = { files: (fresh?.files || []).map((f) => ({ name: f.name, size: f.size, uploadAt: f.uploadAt })) };
        logger.info('[pta-ui] subjective upload: uid=%d pid=%d "%s" (%d bytes)', this.user._id, pid, name, file.size);
    }

    async postDelete({ domainId }) {
        const pid = this.npid;
        const name = cleanFileName(this.args.name);
        const doc = await getSubjective(domainId, pid, this.user._id);
        const entry = (doc?.files || []).find((f) => f.name === name);
        if (entry) {
            try {
                await storage.del([entry.target]);
            } catch (e) { /* the entry removal below is authoritative */ }
            await removeSubjectiveFile(domainId, pid, this.user._id, name);
        }
        const fresh = await getSubjective(domainId, pid, this.user._id);
        this.response.body = { files: (fresh?.files || []).map((f) => ({ name: f.name, size: f.size, uploadAt: f.uploadAt })) };
    }
}

/** Download one submitted file (own, or any as teacher) via a signed link. */
class SubjectiveFileHandler extends Handler {
    @param('pid', Types.ProblemId)
    @param('name', Types.String)
    @param('uid', Types.PositiveInt, true)
    async get({ domainId }, pid: number | string, name: string, uid?: number) {
        const pdoc = await problem.get(domainId, pid);
        if (!pdoc) throw new NotFoundError(pid);
        if (!isSubjectivePdoc(pdoc)) throw new BadRequestError('This problem is not a subjective task.');
        const targetUid = (uid && uid !== this.user._id) ? uid : this.user._id;
        if (targetUid !== this.user._id && !subjectiveTeacher(this, pdoc)) throw new ForbiddenError('Not your submission.');
        const doc = await getSubjective(domainId, pdoc.docId, targetUid);
        const entry = (doc?.files || []).find((f) => f.name === cleanFileName(name));
        if (!entry) throw new NotFoundError(name);
        this.response.redirect = await storage.signDownloadLink(entry.target, entry.name, false);
    }
}

/* ------------------------------------------------------------------ */
/*  Combined objective paper for a test / homework                     */
/* ------------------------------------------------------------------ */
/**
 * One page holding EVERY objective task of a contest ("Test") or homework,
 * in problem order — the one-question-per-task model makes each section a
 * single question, so the page reads like a paper. The sidebar lists the
 * tasks and anchors into the page; answering and submitting stays strictly
 * per-problem underneath (one record per task, exactly as if each problem
 * page had been used), so scoreboards, records and rejudging all behave
 * identically to individual submission.
 *
 * Extends ContestDetailBaseHandler: tdoc/tsdoc loading and the group-assign
 * check are inherited, and the same class serves homework because both
 * live in TYPE_CONTEST.
 */
class ObjectivePaperHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const tdoc = this.tdoc!;
        const canManage = this.user.own(tdoc) || this.user.role === 'root'
            || this.user.hasPerm(tdoc.rule === 'homework' ? PERM.PERM_EDIT_HOMEWORK : PERM.PERM_EDIT_CONTEST);
        if (!canManage) {
            if (contest.isNotStarted(tdoc)) throw new ContestNotLiveError(domainId, tid);
            if (!this.tsdoc?.attend) throw new ContestNotAttendedError(domainId, tid);
        }
        /*
         * The paper is where a student STARTS the test (it replaced the
         * tabular problem list as the entry point), so it stamps the start
         * exactly as that page did: `startAt` opens the personal window of a
         * flexible-duration test and is what the task pages require before
         * they show a problem inside the container.
         */
        if (this.tsdoc?.attend && !this.tsdoc.startAt && contest.isOngoing(tdoc)) {
            await contest.setStatus(domainId, tid, this.user._id, { startAt: new Date() });
            this.tsdoc.startAt = new Date();
        }
        const isHomework = tdoc.rule === 'homework';
        // Verdicts for objective tasks are withheld until the container
        // ends (contest.applyProjection masks the records); tell the paper
        // so it neither polls for results nor pre-colors chips from the
        // student's global problem status — either would leak.
        // CONTAINER-level end (no tsdoc): a per-student time limit closes a
        // student's own window earlier, and revealing verdicts then would
        // show classmates who are still answering which options are right.
        // Answering still locks on the personal window (`locked` below).
        const resultsWithheld = !canManage && !contest.isDone(tdoc);
        // The countdown on the paper (pages/contest.page.ts) reads the same
        // fields the contest pages expose: the test's window and, for a
        // flexible-duration test, the student's own start / end.
        this.UiContext.tdoc = {
            docId: tdoc.docId, rule: tdoc.rule, beginAt: tdoc.beginAt, endAt: tdoc.endAt, duration: tdoc.duration || 0, penaltySince: tdoc.penaltySince,
        };
        this.UiContext.canManageContest = canManage;
        this.UiContext.tsdoc = this.tsdoc ? {
            attend: this.tsdoc.attend, startAt: this.tsdoc.startAt, ...((tdoc.duration || this.tsdoc.endAt) ? { endAt: this.tsdoc.endAt } : {}),
        } : null;
        /*
         * PTA fork: once a HOMEWORK has ended, every objective question the
         * student did not get right carries an "Explain" button on the paper
         * (lib/objective_feedback.ts) and its rail chip turns red.
         */
        // ⚡ ... and on a TEST once its Quick Review policy shows students
        // their feedback (model/quick_review.ts studentFeedbackVisible).
        const feedbackAllowed = isHomework
            || studentFeedbackVisible(tdoc, await getQuick(domainId, String(tid)).catch(() => null));
        const feedback = (feedbackAllowed && !resultsWithheld && !canManage && this.tsdoc?.attend)
            ? await paperFeedbackFor(this, domainId, tdoc, this.tsdoc?.detail || {}).catch(() => null)
            : null;
        await respondObjectivePaper(this, domainId, {
            resultsWithheld,
            locked: contest.isDone(tdoc, this.tsdoc),
            feedback,
            statusOf: (docId) => this.tsdoc?.detail?.[docId]?.status || 0,
            // Sections (true/false, choice, fill-in) with their points, from
            // the test editor's layout or classified from the tasks.
            tdoc,
            // Attending students answer while the container is live (for
            // homework that includes the late window); managers only look.
            canSubmit: !canManage && !!this.tsdoc?.attend && contest.isOngoing(tdoc, this.tsdoc),
            submittedOf: (docId) => !!(this.tsdoc?.detail?.[docId]?.rid || (this.tsdoc?.journal || []).some((j) => j.pid === docId)),
            heading: tdoc.title,
            backUrl: this.url(isHomework ? 'homework_detail' : 'contest_detail', { tid }),
            pageName: isHomework ? 'homework_paper' : 'contest_paper',
            storeKey: tid.toHexString(),
            docIds: tdoc.pids || [],
            // ?tid keeps each record inside the contest, exactly as the
            // single-problem page would.
            submitUrlFor: (docId) => this.url('problem_submit', { pid: docId, query: { tid: tid.toHexString() } }),
            chipHrefFor: (pdoc) => this.url('problem_detail', { pid: pdoc.docId, query: { tid: tid.toHexString() } }),
        });
    }
}

/** And from a self-learning session's problem list. */
class SelfLearningPaperHandler extends Handler {
    @param('ssid', Types.ObjectId)
    async get({ domainId }, ssid: ObjectId) {
        const sdoc = await loadSession(domainId, ssid);
        /*
         * Unlike the Test/Homework papers (an answer sheet whose judging
         * story lives with the assessment), the SELF-LEARNING paper is the
         * primary answering surface for objective tasks — the solve route
         * redirects here. So each section carries its own submit + record
         * endpoints (the solve handler's POST and /record sub-route), giving
         * per-question verdict polling. There is NO tutor on the paper: the
         * AI tutor is a programming-only feature. New sessions cannot list
         * objective tasks at all (see SelfLearningEditHandler); this page
         * keeps legacy sessions answerable.
         */
        const isStudentView = !this.user.own(sdoc)
            && !this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK)
            && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
        const schedule = sessionSchedule(sdoc);
        // Not started: students get the schedule on the detail page instead.
        if (isStudentView && schedule.phase === 'notStarted') {
            this.response.redirect = this.url('self_learning_detail', { ssid });
            return;
        }
        const closed = isStudentView && schedule.phase === 'ended';
        const solveUrl = (docId: number) => this.url('self_learning_solve', { ssid, pid: docId });
        // 🎯 The rail shows THIS session's counted records (scoreRecords),
        // not the student's global problem status.
        const sessionRows = await record.getMulti(domainId, {
            uid: this.user._id, pid: { $in: sdoc.pids || [] }, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
        }).project({ pid: 1, score: 1, status: 1 }).limit(5000).toArray();
        const sessionBest = scoreRecords(sdoc, (sessionRows as any[]).map((r) => ({ pid: r.pid, score: r.score || 0, at: r._id.getTimestamp() })));
        await respondObjectivePaper(this, domainId, {
            statusOf: (docId) => {
                const b = sessionBest.get(docId);
                if (!b) return 0;
                return b.effective >= 100 ? STATUS.STATUS_ACCEPTED : STATUS.STATUS_WRONG_ANSWER;
            },
            heading: sdoc.title,
            backUrl: this.url('self_learning_detail', { ssid }),
            pageName: 'self_learning_paper',
            storeKey: ssid.toHexString(),
            docIds: sdoc.pids || [],
            canSubmit: !closed,
            locked: closed,
            submitUrlFor: (docId) => solveUrl(docId),
            recordUrlFor: (docId) => `${solveUrl(docId)}/record`,
            chipHrefFor: (pdoc) => this.url('self_learning_solve', { ssid, pid: pdoc.docId }),
        });
        Object.assign(this.response.body, { schedule, scheduleClosed: closed });
        // The verdict chip appends the late note only while it applies.
        this.UiContext.paperPenalty = (isStudentView && schedule.phase === 'extension') ? schedule.penalty : 0;
    }
}

/**
 * Shared renderer: the four containers differ only in where the problem
 * list comes from, how records should be tagged, and where Back leads.
 * Everything else — objective filtering by the O pid prefix, section
 * assembly, UiContext for the page script — is identical by construction.
 */
async function respondObjectivePaper(h: Handler, domainId: string, opts: {
    /** PTA fork: the container has ended — the objective sheet is read-only. */
    locked?: boolean,
    /** PTA fork: per-task outcome + stored explanations, once a homework has ended. */
    feedback?: { url: string, byPid: Record<string, any>, outcomeOf: (docId: number) => string } | null,
    /** The counted record's status inside this container (the rail prefers it over the global one). */
    statusOf?: (docId: number) => number,
    heading: string, backUrl: string, pageName: string, storeKey: string,
    docIds: number[], submitUrlFor: (docId: number) => string,
    chipHrefFor: (pdoc: any) => string,
    resultsWithheld?: boolean,
    /** Test / Homework: group the paper into sections and show points. */
    tdoc?: any,
    /** Test / Homework: whether the viewer already handed in an answer for the task. */
    submittedOf?: (docId: number) => boolean,
    /** Self-learning: the paper answers in place (per-task submit + verdicts). */
    canSubmit?: boolean,
    recordUrlFor?: (docId: number) => string,
}) {
    const pdocs = (await Promise.all((opts.docIds || []).map((docId) => problem.get(domainId, docId))))
        .filter((x) => x);
    let objective = pdocs.filter((pdoc) => /^o/i.test(String(pdoc.pid || '')));
    /*
     * PTA test paper: three objective sections in a fixed order — true/false,
     * single/multiple choice, fill-in-the-blank — each with its total, and
     * every task with its own points (tdoc.score, the weights the test editor
     * writes). Numbering runs through the whole paper. Without a tdoc (the
     * self-learning paper) there are no sections and no points.
     */
    const SECTION_META: Record<string, { name: string, icon: string }> = {
        tf: { name: 'True / False', icon: '✓✗' },
        choice: { name: 'Single / Multiple Choice', icon: '◉' },
        blank: { name: 'Fill in the Blank', icon: '✎' },
    };
    let sectionOf: Record<number, string> = {};
    let pointsOf: Record<number, number> = {};
    if (opts.tdoc) {
        const layout = await paperLayoutOf(domainId, opts.tdoc, pdocs);
        sectionOf = layout.sectionOf;
        pointsOf = layout.pointsOf;
        objective = layout.ordered as any;
    }
    const tasks = objective.map((pdoc, k) => ({
        docId: pdoc.docId,
        pid: pdoc.pid,
        index: k + 1,
        section: sectionOf[pdoc.docId] || '',
        points: opts.tdoc ? pointsOf[pdoc.docId] : null,
        // Handed in already: the student's contest status keeps the record
        // id even while the verdict is withheld (Test / Homework papers).
        submitted: !!opts.submittedOf?.(pdoc.docId),
        title: pdoc.title,
        // Objective titles are derived from the question text
        // (lib/objective_title); the paper renders the content right below,
        // so such a title would only repeat the stem — the template shows
        // the number and pid alone in that case.
        titleFromContent: pdoc.title === objectiveTitleOf(pdoc.content || '', pdoc.title),
        submitUrl: opts.submitUrlFor(pdoc.docId),
        // ✅/✗ once the container has ended (null while results are withheld).
        outcome: opts.feedback ? opts.feedback.outcomeOf(pdoc.docId) : null,
        explained: !!opts.feedback?.byPid?.[String(pdoc.docId)]?.hasReport,
        explaining: !!opts.feedback?.byPid?.[String(pdoc.docId)]?.running,
        recordUrl: opts.recordUrlFor ? opts.recordUrlFor(pdoc.docId) : '',
        content: pdoc.content,
    }));
    const round2 = (x: number) => Math.round(x * 100) / 100;
    const groups = opts.tdoc
        ? ['tf', 'choice', 'blank'].map((key) => ({
            key,
            name: SECTION_META[key].name,
            icon: SECTION_META[key].icon,
            tasks: tasks.filter((t) => t.section === key),
            total: round2(tasks.filter((t) => t.section === key).reduce((a, t) => a + (t.points || 0), 0)),
        })).filter((g) => g.tasks.length)
        : [{ key: '', name: '', icon: '', tasks, total: 0 }];
    // Function tasks (pid F…) are listed as their own cell, like the rail's
    // own FUNCTION section: same scratchpad, different ask.
    const programmingPdocs = pdocs.filter((p) => !/^[osf]/i.test(String(p.pid || '')));
    const functionPdocs = pdocs.filter((p) => /^f/i.test(String(p.pid || '')));
    const subjectivePdocs = pdocs.filter((p) => /^s/i.test(String(p.pid || '')));
    const programmingPoints = opts.tdoc
        ? round2(programmingPdocs.reduce((a, p) => a + (pointsOf[p.docId] || 0), 0))
        : 0;
    const functionPoints = opts.tdoc
        ? round2(functionPdocs.reduce((a, p) => a + (pointsOf[p.docId] || 0), 0))
        : 0;
    // PTA fork: subjective tasks (the homework editor's fifth section) are
    // handed in on their own pages and graded by hand; the overview lists
    // their points separately so the total still reads as the whole paper.
    const subjectivePoints = opts.tdoc
        ? round2(subjectivePdocs.reduce((a, p) => a + (pointsOf[p.docId] || 0), 0))
        : 0;
    const objectivePoints = round2(groups.reduce((a, g) => a + g.total, 0));
    h.response.template = 'objective_paper.html';
    h.response.body = {
        heading: opts.heading,
        backUrl: opts.backUrl,
        tasks,
        groups,
        showScores: !!opts.tdoc,
        objectivePoints,
        programmingPoints,
        functionPoints,
        subjectivePoints,
        totalPoints: round2(objectivePoints + programmingPoints + functionPoints + subjectivePoints),
        canSubmit: !!opts.canSubmit,
        othersCount: pdocs.length - objective.length,
        programmingCount: programmingPdocs.length,
        functionCount: functionPdocs.length,
        subjectiveCount: subjectivePdocs.length,
        page_name: opts.pageName,
    };
    h.UiContext.paperTasks = tasks.map(({ content, ...t }) => t);
    h.UiContext.paperKey = opts.storeKey;
    h.UiContext.paperWithheld = !!opts.resultsWithheld;
    h.UiContext.paperCanSubmit = !!opts.canSubmit;
    /*
     * PTA fork: once the container has ended the objective sheet is FROZEN —
     * the page disables every control so a student cannot keep ticking boxes
     * (a submission would be refused by the server anyway). Programming tasks
     * stay open through the correction path, but nothing they do then may
     * repaint the rail: it keeps the status the deadline froze.
     */
    h.UiContext.paperLocked = !!opts.locked;
    h.UiContext.railFrozen = !!opts.locked;
    h.response.body.paperLocked = !!opts.locked;
    h.UiContext.noCopy = !(h.user.hasPerm(PERM.PERM_EDIT_PROBLEM) || h.user.hasPerm(PERM.PERM_CREATE_PROBLEM));
    /*
     * The fixed-left problems rail (auto_scratchpad's sl-rail) replaces the
     * paper's own sidebar: every task of the container, all kinds, with the
     * student's solve status. Objective chips anchor into the paper; other
     * kinds carry the container context out to their own pages, so nobody
     * has to hop back to the detail page to move around.
     */
    const psdict = await problem.getListStatus(domainId, (h as any).user._id, pdocs.map((p) => p.docId));
    const indexOf: Record<number, number> = {};
    for (const t of tasks) indexOf[t.docId] = t.index;
    if (opts.feedback) h.UiContext.paperFeedback = { url: opts.feedback.url, byPid: opts.feedback.byPid };
    h.UiContext.paperRail = {
        items: pdocs.map((pdoc) => {
            const pidStr = String(pdoc.pid || '');
            const kind = /^o/i.test(pidStr) ? 'objective' : (/^s/i.test(pidStr) ? 'subjective' : (/^f/i.test(pidStr) ? 'function' : 'programming'));
            return {
                pid: pdoc.pid || pdoc.docId,
                kind,
                // Rail sections (auto_scratchpad getRailGroups): the three
                // objective types, then programming; objective chips carry
                // the paper's running number.
                group: kind === 'objective' ? (sectionOf[pdoc.docId] || 'objective') : kind,
                index: kind === 'objective' ? indexOf[pdoc.docId] : undefined,
                // Handed in while the verdict is withheld (see tasks above).
                submitted: !!opts.submittedOf?.(pdoc.docId),
                // While results are withheld, objective chips stay neutral:
                // the global problem status would reveal exactly what the
                // record mask is hiding.
                /*
                 * 🎯 The chip's verdict comes from the ACTIVITY (statusOf:
                 * the contest status doc, or a session's counted records),
                 * never from the global problem-status doc — that would show
                 * practice done outside this activity. `statusOf` is supplied
                 * by every caller; psdict remains only for a legacy caller
                 * that does not.
                 */
                status: (opts.resultsWithheld && kind === 'objective') ? 0
                    : (opts.statusOf ? opts.statusOf(pdoc.docId) : (psdict[pdoc.docId]?.status || 0)),
                // 🔴 A wrong objective answer paints its rail chip red (and
                // a partial one amber) once the container has ended.
                outcome: (kind === 'objective' && opts.feedback) ? opts.feedback.outcomeOf(pdoc.docId) : null,
                title: pdoc.title,
                href: kind === 'objective' ? `#q-${pdoc.docId}` : opts.chipHrefFor(pdoc),
            };
        }),
    };
}

export async function apply(ctx: Context) {
    ctx.Route('self_learning', '/self-learning', SelfLearningMainHandler);
    ctx.Route('self_learning_create', '/self-learning/create', SelfLearningEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('self_learning_detail', '/self-learning/:ssid', SelfLearningDetailHandler);
    ctx.Route('self_learning_edit', '/self-learning/:ssid/edit', SelfLearningEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('self_learning_solve', '/self-learning/:ssid/p/:pid', SelfLearningSolveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('self_learning_record', '/self-learning/:ssid/p/:pid/record', SelfLearningRecordHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('self_learning_tutor', '/self-learning/:ssid/p/:pid/tutor', SelfLearningTutorHandler, PRIV.PRIV_USER_PROFILE);

    // ---- Site-wide PTA UI backend (migrated from problem_trajectory.ts) ----
    ctx.Route('problem_trajectory', '/p/:pid/trajectory', ProblemTrajectoryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('activity_problem_kinds', '/activity/:tid/problem-kinds', ActivityProblemKindsHandler, PRIV.PRIV_USER_PROFILE);
    // Root-only bulk user import behind the homepage "Add Users" button.
    ctx.Route('bulk_add_users', '/bulk-add-users', BulkAddUsersHandler, PRIV.PRIV_EDIT_SYSTEM);
    // Post-acceptance AI report behind the result modal's "AI Suggestions" button.
    ctx.Route('ai_suggestions', '/p/:pid/ai-suggestions', AiSuggestionsHandler, PRIV.PRIV_USER_PROFILE);
    // Teacher-only class report behind the contest/homework page button.
    ctx.Route('ai_class_report', '/activity/:tid/ai-class-report', AiClassReportHandler, PRIV.PRIV_USER_PROFILE);
    // Subjective (project-level) tasks: submissions + file downloads.
    ctx.Route('subjective_task', '/p/:pid/subjective', SubjectiveTaskHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('subjective_task_file', '/p/:pid/subjective/file', SubjectiveFileHandler, PRIV.PRIV_USER_PROFILE);
    // The AI Studio routes (/ai-studio, /ai-studio/:id) are registered by
    // ai_author.ts itself — see the HMR note in that file's apply().
    ctx.Route('contest_paper', '/contest/:tid/paper', ObjectivePaperHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('homework_paper', '/homework/:tid/paper', ObjectivePaperHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('self_learning_paper', '/self-learning/:ssid/paper', SelfLearningPaperHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('self_learning_bonus', '/self-learning/:ssid/bonus', SelfLearningBonusHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('self_learning_skip', '/self-learning/:ssid/p/:pid/skip', SelfLearningSkipHandler, PRIV.PRIV_USER_PROFILE);
    // Results finalize themselves: once a session's deadline (with extension)
    // has passed, every student's summed score is computed and stored. One
    // worker runs the sweep; the teacher's page also computes on first sight.
    if (!process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0') {
        const sweep = () => finalizeDueSessions().catch((e) => logger.warn('[self-learning] results sweep failed: %s', e.message));
        const first = setTimeout(sweep, 60 * 1000);
        const every = setInterval(sweep, 10 * 60 * 1000);
        // 👁 Task visibility + 📚 bonus publication run on the same worker
        // and cadence, offset so the two sweeps never start in the same tick.
        // The first pass also repairs everything left hidden by the earlier
        // end-gated behaviour, and publishes any bonus task whose pipeline
        // finished while nobody had the session page open.
        const visibility = async () => {
            const released = await repairLegacyHiddenFlags();
            if (released) logger.info('[visibility] %d stale hidden flag(s) cleared', released);
            const n = await publishReadyBonusTasks();
            if (n) logger.info('[visibility] %d bonus task(s) confirmed in the problem set', n);
        };
        const runVisibility = () => visibility().catch((e) => logger.warn('[visibility] sweep failed: %s', e.message));
        const firstVisibility = setTimeout(runVisibility, 90 * 1000);
        const everyVisibility = setInterval(runVisibility, 10 * 60 * 1000);
        // cordis 4 never emits a 'dispose' event on the context, so the old
        // ctx.on('dispose') cleanup was dead code and a hot-reloaded module
        // left the previous timers running (duplicate sweeps in dev mode).
        // The effect disposer runs when this plugin scope is torn down.
        ctx.effect(() => () => {
            clearTimeout(first); clearInterval(every);
            clearTimeout(firstVisibility); clearInterval(everyVisibility);
        });
    }
    const setKinds = async (h: any, source: string) => {
        if (!h?.UiContext || h.UiContext.tdocKinds || h.UiContext.trainingRail || h.UiContext.psetRail) return;
        let tdoc = h.tdoc || h.response?.body?.tdoc;
        if (!tdoc && h.args?.tid) tdoc = await contest.get(h.args.domainId, h.args.tid).catch(() => null);
        if (tdoc && Array.isArray(tdoc.pids) && tdoc.pids.length > 1) {
            try {
                h.UiContext.tdocKinds = await activityKinds(h.args.domainId, tdoc.pids, h.user?._id, tdoc);
                logger.info('[pta-ui] rail kinds injected via %s: %d problem(s) for tid=%s', source, tdoc.pids.length, tdoc.docId);
            } catch (e) {
                logger.warn('[pta-ui] rail kinds failed via %s: %s', source, e.message);
            }
            return;
        }
        // (Training removed for this deployment: the ?trid rail decorator
        // that lived here went with it.)
        // Problem set: plain problem pages (no contest tid) get the same left
        // sidebar — a window of the problem list around the current problem,
        // in docId order, honoring hidden-problem visibility.
        if (h.args?.tid) return;
        try {
            const cur = h.pdoc?.docId ?? h.response?.body?.pdoc?.docId;
            if (typeof cur !== 'number') return;
            const canViewHidden = h.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN);
            const vis: any = canViewHidden ? {} : { hidden: false };
            /*
             * PTA fork: the problem-set rail is the problem set — tasks that
             * belong to a homework / test / session are left out of it for
             * students, exactly as they are left out of the list.
             */
            const ownedByActivity = seesEveryProblem(h) ? [] : [...await activityPids(h.args.domainId)];
            if (ownedByActivity.length) vis.docId = { $nin: ownedByActivity };
            const around = (range: any) => ({ ...vis, docId: { ...(vis.docId || {}), ...range } });
            const [before, after] = await Promise.all([
                problem.getMulti(h.args.domainId, around({ $lt: cur }))
                    .sort({ docId: -1 }).limit(12).project({ docId: 1 }).toArray(),
                problem.getMulti(h.args.domainId, around({ $gte: cur }))
                    .sort({ docId: 1 }).limit(13).project({ docId: 1 }).toArray(),
            ]);
            const pids = [...before.reverse(), ...after].map((p: any) => p.docId);
            if (pids.length < 2) return;
            h.UiContext.psetRail = { kinds: await activityKinds(h.args.domainId, pids, h.user?._id) };
            logger.info('[pta-ui] rail kinds injected via %s (problem set): %d problem(s) around #%d', source, pids.length, cur);
        } catch (e) {
            logger.warn('[pta-ui] problem-set rail kinds failed via %s: %s', source, e.message);
        }
    };
    // ProblemDetailHandler serves problem_detail, contest_detail_problem AND
    // homework_detail_problem (page_name is just switched on tdoc.rule), so
    // one class-named hook covers all three surfaces.
    ctx.on('handler/after/ProblemDetail#get' as any, (h: any) => setKinds(h, 'ProblemDetail#get'));
    // Safety net: the generic handler/after fires for every request; the
    // template guard makes it a no-op elsewhere, and the tdocKinds check
    // dedupes when both hooks run.
    ctx.on('handler/after' as any, (h: any) => {
        if (!String(h?.response?.template || '').startsWith('problem_detail')) return null;
        return setKinds(h, 'generic-after');
    });
    // Core's ProblemSubmitHandler deliberately omits the rid for contest and
    // homework submissions when the activity hides self-records
    // (canShowSelfRecord is false): body is { tid } and the redirect points
    // at the activity page, not /record/:rid. This site's requirement is a
    // result modal on EVERY surface, so restore the rid for JSON callers —
    // the record was just created by this very request, so the newest
    // non-pretest record of this user on this problem is it.
    ctx.on('handler/after/ProblemSubmit#post' as any, async (h: any) => {
        try {
            if (!h?.response?.body || h.response.body.rid) return;
            const latest = await record.getMulti(h.args.domainId, {
                pid: h.pdoc.docId, uid: h.user._id, contest: { $ne: record.RECORD_PRETEST },
            }).sort({ _id: -1 }).limit(1).project({ _id: 1 }).toArray();
            if (!latest[0]) return;
            h.response.body.rid = latest[0]._id.toHexString();
            logger.info('[pta-ui] rid restored on submit response (self-record-hidden activity): %s', h.response.body.rid);
        } catch (e) {
            logger.warn('[pta-ui] rid restore failed: %s', e.message);
        }
    });
    // Nav domain dropdown: the stock list renders handler.user.domains, a
    // denormalized udoc field that misses memberships granted via
    // setUserRole (e.g. our bulk user import) and goes stale. On every HTML
    // page render, replace it with the user's TRUE membership — current
    // domain first, then by display name — so hovering the domain menu
    // (dropdowns open on hover by default) lists every domain the user is
    // in, each linking to that domain's homepage ("visit").
    ctx.on('handler/after' as any, async (h: any) => {
        try {
            if (!h?.response?.template) return; // JSON/API responses render no nav
            // Problem authors keep the ORIGINAL problem page: the client skips
            // the scratchpad auto-enter for domain roots and super-admins.
            if (h.UiContext) {
                h.UiContext.isDomainRoot = h.user?.role === 'root' || !!h.user?.hasPriv?.(PRIV.PRIV_EDIT_SYSTEM);
            }
            if (!h.user?.hasPriv?.(PRIV.PRIV_USER_PROFILE)) return;
            const dudict = await domain.getDictUserByDomainId(h.user._id);
            const dids = Object.keys(dudict);
            if (!dids.length) return;
            const ddocs = await domain.getMulti({ _id: { $in: dids } }).toArray();
            const cur = h.args?.domainId;
            const label = (d: any) => String(d.name || d._id).toLowerCase();
            ddocs.sort((a: any, b: any) => {
                if (a._id === cur) return -1;
                if (b._id === cur) return 1;
                return label(a) < label(b) ? -1 : 1;
            });
            h.user.domains = ddocs.slice(0, 30);
        } catch (e) { /* the nav falls back to the stock list */ }
    });
    logger.info('[pta-ui] trajectory + activity-kinds routes, ProblemDetail rail hooks, and nav-domains hook registered (via self_learning.ts)');

    // Self-healing guard for /manage/config: if the stored config source
    // (system collection, _id 'config') is not valid YAML, the built-in
    // config editor crashes in the browser before it can render, and the
    // save path throws too, so the corruption cannot be fixed from the UI.
    // When root opens the page, repair the document and serve a clean value.
    ctx.on('handler/after/SystemConfig#get' as any, async (h: any) => {
        const value = h?.response?.body?.value;
        try {
            if (typeof value === 'string') yamlLoad(value);
            return;
        } catch (e) { /* fall through to repair */ }
        logger.warn('Corrupted system config source detected; resetting to an empty document.');
        try {
            await h.ctx.setting.saveConfig({});
        } catch (e) {
            try {
                await h.ctx.db.collection('system').updateOne({ _id: 'config' }, { $set: { value: '{}' } }, { upsert: true });
                await h.ctx.setting.loadConfig();
            } catch (err) {
                logger.error('Failed to repair the system config source: %s', err.message);
            }
        }
        h.response.body.value = '{}\n';
    });
    // ---- Privacy self-heal: personal submission history & ranking ----
    // The 'default' role of PRE-EXISTING domains was minted when PERM_DEFAULT
    // still contained PERM_VIEW_RECORD, so students there can browse the whole
    // class's submissions. New domains no longer grant it (see
    // @hydrooj/common/permission.ts); this one-time boot sweep strips the bit
    // from the two builtin role names in every existing domain too. Custom
    // roles (teacher / TA / ...) are deliberately untouched — granting "View
    // other's records" to a role is the supported way to give course staff
    // full record and ranking visibility.
    if (!(global as any).__ptaRecordPrivacySweepDone) {
        (global as any).__ptaRecordPrivacySweepDone = true;
        setTimeout(async () => {
            try {
                const ddocs = await domain.getMulti().project({ _id: 1, roles: 1 }).toArray();
                let fixed = 0;
                for (const ddoc of ddocs) {
                    const patch: Record<string, bigint> = {};
                    for (const role of ['default', 'guest']) {
                        const cur = (ddoc as any).roles?.[role];
                        if (cur === undefined) continue;
                        const perm = BigInt(cur);
                        if (perm & PERM.PERM_VIEW_RECORD) patch[role] = perm & ~PERM.PERM_VIEW_RECORD;
                    }
                    if (Object.keys(patch).length) {
                        // eslint-disable-next-line no-await-in-loop
                        await domain.setRoles((ddoc as any)._id, patch);
                        fixed += 1;
                    }
                }
                if (fixed) logger.info('[pta-ui] record privacy: removed "View other\'s records" from builtin roles in %d domain(s)', fixed);
            } catch (e) {
                logger.warn('[pta-ui] record privacy sweep failed: %s', e.message);
            }
        }, 3000);
    }
    await SelfLearningModel.apply();
}

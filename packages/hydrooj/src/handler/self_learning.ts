import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
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
import { ContestDetailBaseHandler } from './contest';
import { convertPenaltyRules, validatePenaltyRules } from './homework';
import { PROBLEM_KIND_FILTERS } from './problem';
// Bonus tasks reuse the AI Studio's draft + verification pipeline. (Cross-file
// function import: under dev-mode hot reload an edit to ai_author.ts keeps
// these references on the previous module instance until a restart.)
import { bonusState, createBonusDraft, materializeBonus, retryBonus } from './ai_author';
import KnowledgeModel from '../model/knowledge';
import * as document from '../model/document';
import { PERM, PRIV } from '../model/builtin';
import * as contest from '../model/contest';
import domain from '../model/domain';
import problem from '../model/problem';
import record from '../model/record';
import storage from '../model/storage';
import SelfLearningModel, { computeGate, SessionGate, SelfLearningBonusEntry, SessionResultRow, SessionResults, TYPE_SELF_LEARNING, collProgress, getClassReport, getSubjective, getSuggestionReportsIn, getTutorThreadsIn, listSubjective, removeSubjectiveFile, setClassReport, setSubjectiveReport, upsertSubjectiveFile, getSuggestionReport, setSuggestionReport, SelfLearningDoc, TutorMessage, TutorThreadDoc, OwnershipState, FixConvState, FixConvTransition, TransferAssessment, getOwnershipIn, getSessionThreads } from '../model/selflearning';
import * as setting from '../model/setting';
import system from '../model/system';
import user from '../model/user';
import { Handler, param, Types } from '../service/server';

const JUDGING = [STATUS.STATUS_WAITING, STATUS.STATUS_JUDGING, STATUS.STATUS_COMPILING, STATUS.STATUS_FETCHED];

async function loadSession(domainId: string, ssid: ObjectId): Promise<SelfLearningDoc> {
    const sdoc = await SelfLearningModel.get(domainId, ssid);
    if (!sdoc) throw new NotFoundError(domainId, ssid);
    return sdoc;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export type SessionTaskKind = 'programming' | 'objective' | 'subjective';

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
 *   - effective = round(raw score × penaltyCoefficientAt(submission time));
 *   - a task's counting record is the one with the highest EFFECTIVE
 *     score, and on equal effective scores the on-time record beats a
 *     late one;
 *   - a session total (sessionTaskMeanTotal, out of 100) averages the PER-TASK rubric
 *     components (componentsOf) — today the 🏆 Achievement component
 *     alone: the programming tasks' summed score mapped onto 20 points.
 *
 * EVERY consumer flows through here: the teacher's "Evaluate all students
 * now" button, the automatic post-deadline sweep and the on-view
 * finalization (all three via computeSessionResults), and the student's
 * own score card and per-task chips (SelfLearningDetailHandler). Change
 * the rubric HERE and press the button on any session to see the effect
 * immediately — the automatic evaluation will produce the same numbers.
 */
export function scoreRecords(sdoc: SelfLearningDoc, rows: { pid: number, score: number, at: Date }[]): Map<number, TaskBest> {
    const hardEnd = sessionSchedule(sdoc).hardEndAt || null;
    const best = new Map<number, TaskBest>();
    for (const r of rows) {
        if (hardEnd && r.at > hardEnd) continue;
        const score = r.score || 0;
        const effective = Math.round(score * penaltyCoefficientAt(sdoc, r.at));
        const late = !!(sdoc.endAt && r.at > sdoc.endAt) && effective !== score;
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

/** A 'running' manual evaluation older than this is treated as crashed. */
export const EVAL_JOB_STALE_MS = 10 * 60 * 1000;

/** The session grade scale: a session is evaluated out of 100. */
export const SESSION_TOTAL_MAX = 100;
/** 🏆 The Achievement component's scale: the programming tasks map onto 0..20. */
export const SESSION_ACHIEVEMENT_MAX = 20;

/**
 * The session's PROGRAMMING tasks by the site's P/O/S convention — the
 * set the Achievement component maps. One classification rule for both the
 * evaluation and the student card: pass the same pdict shape
 * (PROJECTION_CONTEST_LIST covers what sessionKindOf reads). Deleted
 * problems are absent from pdict and therefore drop out of the scale.
 */
export function programmingPidsOf(sdoc: SelfLearningDoc, pdict: Record<number, any>): number[] {
    return (sdoc.pids || []).filter((pid) => pdict[pid] && sessionKindOf(pdict[pid]) === 'programming');
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

/** 🎓 The Ownership component's scale: explanation levels map onto 0..10. */
export const SESSION_OWNERSHIP_MAX = 10;
/** The LLM grades each post-acceptance answer on 0..OWNERSHIP_LEVEL_MAX. */
export const OWNERSHIP_LEVEL_MAX = 4;
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
     * The trial counter follows ERROR CHAINS, not raw position: repeated
     * guided resubmissions that fail to move the verdict are retries of the
     * SAME struggle (1 → 0.8 → 0.6 → 0.5), but once a resubmission
     * IMPROVES the score (or gets accepted) the chain closes — the next
     * guided transition targets a DIFFERENT error and starts fresh at
     * trial 1. Any improvement resets the chain, guided or not. This is
     * decided purely from record scores, so trial numbers stay
     * deterministic and never depend on an LLM output.
     */
    let chain = 0;
    for (let k = 0; k + 1 < attempts.length; k++) {
        if (attempts[k].accepted) {
            chain = 0;
            continue;
        }
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
            chain += 1;
            out.push({
                fromIdx: k, toIdx: k + 1, trial: chain, msgIdx,
            });
        }
        const improved = attempts[k + 1].accepted || ((attempts[k + 1].score || 0) > (attempts[k].score || 0));
        if (improved) chain = 0;
    }
    return out;
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
    const threads = await getSessionThreads(domainId, sdoc.docId);
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
            if (!pair.answers.length) {
                if (!(ownership.questions || []).find((x) => x.question === pair.key)) {
                    const q = {
                        question: pair.key, line: pair.line, at: pair.at || new Date(), levels: [], answerKeys: [],
                    };
                    await SelfLearningModel.pushOwnershipQuestion(thread._id, q);
                    ownership.questions.push(q);
                }
                continue;
            }
            for (const ans of pair.answers) {
                if (typeof ans.level === 'number') continue; // graded live already
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
        if (!q) {
            q = {
                question: w.pair.key, line: w.pair.line, at: w.pair.at || new Date(), levels: [], answerKeys: [],
            };
            await SelfLearningModel.pushOwnershipQuestion(w.thread._id, q);
            w.ownership.questions.push(q);
        }
        await SelfLearningModel.pushOwnershipLevel(w.thread._id, w.pair.key, level, key);
        await SelfLearningModel.setMessageLevel(w.thread._id, w.ans.index, level);
        q.levels.push(level);
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
    const threads = await getSessionThreads(domainId, sdoc.docId);
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
        if ((recs as any[]).length < 2) continue;
        const attempts = (recs as any[]).map((r) => ({
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
        await SelfLearningModel.pushFixConvTransition(w.thread._id, {
            fromRid: from.rid, toRid: to.rid, trial: w.cand.trial, level, asked: w.cand.msgIdx.length, at: to.at,
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
    if (![...tagsByPid.values()].some((t) => t.length)) return out; // untagged session: nothing testable
    const threads = await getSessionThreads(domainId, sdoc.docId);
    const threadOf = new Map<string, TutorThreadDoc>();
    for (const t of threads) threadOf.set(`${t.uid}:${t.pid}`, t);
    const recs = await record.getMulti(domainId, {
        pid: { $in: progPids }, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
    }).project({ uid: 1, pid: 1, status: 1, score: 1 }).limit(200000).toArray();
    const rowsOf = new Map<number, { pid: number, at: Date, accepted: boolean, rid: any, score: number }[]>();
    for (const r of recs as any[]) {
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
        if (!surfacedByPid.size) continue;
        const prog = await SelfLearningModel.getProgress(domainId, sdoc.docId, uid);
        const doneConcepts = new Set((prog?.transfer?.assessments || []).map((a) => a.concept));
        let count = prog?.transfer?.assessments?.length || 0;
        for (const cand of extractTransferCandidates(engagements, tagsByPid, surfacedByPid, resolved)) {
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
        await SelfLearningModel.pushTransferAssessment(domainId, sdoc.docId, w.uid, {
            concept: w.cand.concept, fromPid: w.cand.fromPid, toPid: w.cand.toPid, level, at: new Date(),
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
    const threads = await getSessionThreads(domainId, sdoc.docId);
    const recs = await record.getMulti(domainId, {
        pid: { $in: [...progPids] }, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
    }).project({ uid: 1, pid: 1, status: 1 }).limit(200000).toArray();
    const recRowsOf = new Map<string, { at: number, accepted: boolean, rid: any }[]>();
    for (const r of recs as any[]) {
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
        await SelfLearningModel.setMessageRlevel(w.thread._id, w.idx, level);
        await SelfLearningModel.pushReasoningLevel(w.thread._id, level, key);
        state.levels.push(level);
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
    const threads = await getSessionThreads(domainId, sdoc.docId);
    const recs = await record.getMulti(domainId, {
        pid: { $in: progPids }, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
    }).project({ uid: 1, pid: 1, status: 1, score: 1 }).limit(200000).toArray();
    const rowsOf = new Map<number, { pid: number, at: Date, accepted: boolean, rid: any, score: number }[]>();
    for (const r of recs as any[]) {
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
        await SelfLearningModel.setInitiative(w.thread._id, level);
        out.graded += 1;
    }
    return out;
}



/**
 * ⭐ Budgets are FROZEN onto the thread when its walkthrough is created,
 * so a policy deepening (5–6 → 8–10 for first-attempt acceptances, whose
 * Ownership carries 60 of that task’s 100 points) must be inherited by threads
 * that already exist: raise the stored budget in place, and REOPEN a
 * walkthrough that was closed under the smaller budget — otherwise the
 * students the track was built for could never be asked the deeper
 * questions, capping the 60-point ownership part at a 5–6-question sample
 * (or at the zeros of questions they never answered, which answering now
 * heals). Guided (non-first-attempt) budgets are unchanged.
 */
async function reconcileOwnershipBudget(thread: TutorThreadDoc): Promise<void> {
    const own = thread.ownership as any;
    if (!own) return;
    const budget = ownershipBudget((own.acceptedAttempt || 1) === 1);
    if ((own.maxQ || 0) >= budget.max) return; // already current (or deeper)
    const reopen = !!own.done && (own.questions?.length || 0) < budget.min;
    await SelfLearningModel.updateOwnershipBudget(thread._id, budget.min, budget.max, reopen);
    own.minQ = budget.min;
    own.maxQ = budget.max;
    if (reopen) own.done = false;
}

/**
 * 🎓 The ownership question budget, fixed once per task at its FIRST
 * acceptance: 5..6 questions when that acceptance was the very first
 * attempt, 2..3 otherwise. The tutor must keep asking below min, may stop
 * between min and max, and the server refuses past max.
 */
export function ownershipBudget(firstAttempt: boolean): { min: number, max: number } {
    // ⭐ First-attempt acceptances get a DEEPER walkthrough: on the
    // per-task rubric, Ownership carries 60 of a first-attempt task’s
    // 100 points, so the tutor asks more questions to earn it.
    return firstAttempt ? { min: 8, max: 10 } : { min: 2, max: 3 };
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
 * never-answered question counting as one level-0 response. The component
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

/** 🔧 The Fix-Conversion component's scale: guided fixes map onto 0..15. */
export const SESSION_FIXCONV_MAX = 15;
/** The LLM grades each guidance→fix transition on 0..FIXCONV_LEVEL_MAX. */
export const FIXCONV_LEVEL_MAX = 4;
/** Cap of judged transitions per task (bounds LLM cost and gaming). */
export const MAX_FIXCONV_PER_TASK = 12;

/**
 * 🔧 The trial penalty across multiple guided resubmissions of one task:
 * the 1st guidance→fix trial counts in full, the 2nd ×0.8, the 3rd ×0.6,
 * and every trial after that ×0.5.
 */
export function fixConvPenalty(trial: number): number {
    if (trial <= 1) return 1;
    if (trial === 2) return 0.8;
    if (trial === 3) return 0.6;
    return 0.5;
}

/**
 * One task's PENALTY-WEIGHTED mean fix-conversion level (0..4): each judged
 * transition contributes level × fixConvPenalty(trial); null when the task
 * has no judged transitions. The teacher's hover breakdown shows the same
 * per-task numbers fixConvOf aggregates.
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

/** 🧠 The Concept-Transfer component's scale: transfer maps onto 0..15. */
export const SESSION_TRANSFER_MAX = 15;
/** The LLM grades each concept re-encounter on 0..TRANSFER_LEVEL_MAX. */
export const TRANSFER_LEVEL_MAX = 4;
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
/** The LLM grades each failure-phase answer on 0..REASONING_LEVEL_MAX. */
export const REASONING_LEVEL_MAX = 4;
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

/** 💡 The Self-Diagnostic-Initiative component's scale: 0..5. */
export const SESSION_INITIATIVE_MAX = 5;
/** The LLM grades each task's first engagement on 0..INITIATIVE_LEVEL_MAX. */
export const INITIATIVE_LEVEL_MAX = 4;

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
export const FIRST_ATTEMPT_ACH_MAX = 40;
export const FIRST_ATTEMPT_OWN_MAX = 60;

/** Per-task reasoning mean (0..4) from the thread's failure-answer levels; null when nothing graded. */
export function reasoningTaskMeanOf(state: { levels: number[] } | undefined | null): number | null {
    const levels = (state?.levels || []).map((l) => Math.min(REASONING_LEVEL_MAX, Math.max(0, +l || 0)));
    if (!levels.length) return null;
    return levels.reduce((a, b) => a + b, 0) / levels.length;
}

/**
 * 🧠 Transfer's null has THREE causes, and only one deserves a 0:
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
1. RELEVANCE — every task must exercise the knowledge points the goal is about. Interpret the goal with the CATALOG: it may be phrased loosely ("for-loop" covers labels such as "For loop reading n values" or "Loop boundary off-by-one").
2. MUTUAL RELEVANCE — the set must interlock: each suggested task shares at least one goal-relevant knowledge point with at least one other suggested task, and the goal's core points should each be carried by two or more suggested tasks, so a mistake in one task can recur in another.
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
}

/** Crude lexical relevance of a task to the goal — only used to bound the candidate list. */
function goalScore(goalWords: string[], c: AdvisorCandidate): number {
    const hay = `${c.title} ${c.tags.join(' ')}`.toLowerCase();
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
        if (this.sdoc?.pids?.length) {
            try {
                const pdict = await problem.getList(
                    this.args.domainId, this.sdoc.pids, true, false, problem.PROJECTION_CONTEST_LIST, true,
                );
                legacyTasks = this.sdoc.pids
                    .map((pid) => pdict[pid])
                    .filter((pdoc) => pdoc && pdoc.docId && sessionKindOf(pdoc) !== 'programming')
                    .map((pdoc) => ({ pid: String(pdoc.pid || pdoc.docId), title: pdoc.title, kind: sessionKindOf(pdoc) }));
            } catch (e) { /* the warning is best-effort; postUpdate still enforces the rule */ }
        }
        this.response.template = 'self_learning_edit.html';
        this.response.body = {
            sdoc: this.sdoc,
            pids: this.sdoc ? this.sdoc.pids.join(',') : '',
            legacyTasks,
            advisorAvailable: aiTutor.tutorEnabled() && aiTutor.tutorConfigured(),
            dateBeginText: beginAt.format('YYYY-M-D'),
            timeBeginText: beginAt.format('H:mm'),
            dateEndText: endAt.format('YYYY-M-D'),
            timeEndText: endAt.format('H:mm'),
            extensionDays: this.sdoc?.extensionDays ?? 1,
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
        const rows = await problem.getMulti(domainId, { $and: [PROBLEM_KIND_FILTERS.programming, visible] },
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
        const goalWords = [...new Set(goal.toLowerCase().split(/[^\p{L}\p{N}+#-]+/u).filter((w) => w))];
        const candidates = [...pool].sort((a, b) => goalScore(goalWords, b) - goalScore(goalWords, a)).slice(0, 120);
        const byPid = new Map<string, AdvisorCandidate>();
        for (const c of candidates) byPid.set(c.pid.toLowerCase(), c);

        const catalog = await KnowledgeModel.list(domainId, '', 400);
        const catalogBlock = catalog.length
            ? `=== CATALOG: the domain's knowledge points (name — description) ===\n${catalog.map((k) => `- ${k.name}${k.description ? ` — ${k.description.slice(0, 100)}` : ''}`).join('\n').slice(0, 7000)}\n=== END CATALOG ===`
            : '=== CATALOG: (empty — rely on the task labels) ===';
        const candidateBlock = `=== CANDIDATE TASKS (${candidates.length}) — pid | title | difficulty 1-10 | accepted/submissions | knowledge points ===\n${candidates.map((c) => `${c.pid} | ${c.title} | ${c.difficulty || '?'} | ${c.nAccept}/${c.nSubmit} | ${c.tags.length ? c.tags.join('; ') : '(unlabeled)'}`).join('\n')}\n=== END CANDIDATES ===`;

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
    async postUpdate(
        { domainId }, title: string, content: string, _pids: string,
        beginAtDate: string, beginAtTime: string, endAtDate: string, endAtTime: string,
        extensionDays: number, penaltyRules: PenaltyRules,
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
        const schedule = {
            beginAt: beginAt.toDate(), endAt: endAt.toDate(), extensionDays, penaltyRules,
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
            .filter((pdoc) => pdoc && sessionKindOf(pdoc) !== 'programming')
            .map((pdoc) => `${pdoc.pid || pdoc.docId} (${sessionKindOf(pdoc)})`);
        if (rejected.length) {
            throw new ValidationError('pids', null, `Only programming tasks can be added to a self-learning session. Remove: ${rejected.join(', ')}`);
        }
        if (this.sdoc) {
            await SelfLearningModel.edit(domainId, this.sdoc.docId, {
                title, content, pids, ...schedule,
            });
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
 * THE evaluation entry point — every way of "evaluating the students" is
 * this one function:
 *   1. the teacher's "Evaluate all students now" button (postRecompute);
 *   2. the automatic post-deadline sweep (finalizeDueSessions, on a timer);
 *   3. the on-view finalization when a teacher opens an ended session.
 * The scoring itself is delegated to scoreRecords / sessionTaskMeanTotal (the
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
    // Group the raw records per student; scoreRecords — THE shared rubric,
    // also behind the student's own card — turns each group into per-task
    // bests, so this table can never disagree with what a student sees.
    const rowsOf = new Map<number, { pid: number, score: number, at: Date }[]>();
    for (const r of rows as any[]) {
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
     * ROLLBACK: the evaluation is the original one — per-task judged
     * scores (late tier applied) and their SUM. The rubric machinery
     * (components, per-task 40/60, LLM backfills) stays in the codebase,
     * dormant, but is neither run nor reported here.
     */
    const result: SessionResultRow[] = [];
    for (const uid of studentUids) {
        const udoc: any = udict[uid];
        const m = scoreRecords(sdoc, rowsOf.get(uid) || []);
        const scores: SessionResultRow['scores'] = {};
        let attempts = 0;
        for (const pid of pids) {
            const v = m.get(pid);
            if (v) {
                scores[String(pid)] = v;
                attempts += v.attempts;
            }
        }
        // The original total: the sum of per-task effective scores.
        const total = Math.round(progPids.reduce((acc, pid) => acc + (m.get(pid)?.effective || 0), 0) * 10) / 10;
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
        result.push({
            uid,
            uname: udoc?.uname || String(uid),
            name: `${udoc?.firstName || ''} ${udoc?.lastName || ''}`.trim(),
            scores,
            total,
            attempts,
            done: (pg?.done || []).filter((x) => pids.includes(x)).length,
            skipped: (pg?.skipped || []).filter((x) => pids.includes(x)).length,
            bonus: bonusState,
        });
    }
    result.sort((a, b) => b.total - a.total || a.uname.localeCompare(b.uname));
    const results: SessionResults = {
        computedAt: new Date(), final, maxTotal: progPids.length * 100, rows: result,
    };
    await SelfLearningModel.edit(domainId, sdoc.docId, { results });
    return results;
}

/**
 * Sessions whose hard end has passed and whose results are not final yet:
 * compute them. Runs on a timer in apply() (first worker only) and when a
 * teacher opens a closed session, so results exist whichever comes first.
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
            const sdoc = await SelfLearningModel.get(d.domainId, d.docId);
            if (!sdoc) continue;
            try {
            } catch (e) {
                logger.warn('[self-learning] rubric backfill %s/%s failed: %s', d.domainId, d.docId, e.message);
            }
            await computeSessionResults(d.domainId, sdoc, true);
            n++;
        } catch (e) {
            logger.warn('[self-learning] results for %s/%s failed: %s', d.domainId, d.docId, e.message);
        }
    }
    return n;
}

class SelfLearningDetailHandler extends Handler {
    /**
     * Teacher: (re)compute the results now — final if the session is closed,
     * provisional otherwise. This is the SAME computeSessionResults (and
     * therefore the same scoreRecords rubric) the automatic post-deadline
     * sweep runs: pressing the button is an exact preview of the automatic
     * evaluation.
     */
    @param('ssid', Types.ObjectId)
    async postRecompute({ domainId }, ssid: ObjectId) {
        const sdoc = await loadSession(domainId, ssid);
        if (!this.user.own(sdoc) && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)) throw new PermissionError();
        const now = new Date();
        const running = sdoc.evalJob?.state === 'running'
            && now.getTime() - new Date(sdoc.evalJob.startedAt).getTime() < EVAL_JOB_STALE_MS;
        if (!running) {
            // Mark the job BEFORE responding so the very first status poll
            // (and any reloaded page) already sees it.
            await SelfLearningModel.edit(domainId, ssid, { evalJob: { state: 'running', startedAt: now } });
            /*
             * BACKGROUND: the evaluation runs detached from this request —
             * refreshing the page, closing the tab or re-logging in never
             * cancels it. Progress lives on sdoc.evalJob (postEvalStatus);
             * a stale 'running' job (server crash mid-compute) unblocks
             * itself after EVAL_JOB_STALE_MS.
             * 'ended' is the terminal SessionPhase (an earlier build tested
             * the nonexistent 'closed', so manual evaluations were never
             * final).
             */
            (async () => {
                try {
                    const fresh = await SelfLearningModel.get(domainId, ssid);
                    if (!fresh) throw new Error('session no longer exists');
                    // Grade every recorded-but-ungraded post-acceptance
                    // answer FIRST (this is where the LLM time goes), then
                    // aggregate — so pressing the button judges the stored
                    // interaction histories, exactly as a teacher expects.
                    let bf = { graded: 0, failed: 0, total: 0 };
                    try {
                        // Live progress: write who is being judged (throttled,
                        // but never skipping a student change or the ends) so
                        // the teacher's card — on this page or a reloaded one
                        // — can display it.
                        let lastWrite = 0;
                        let lastUid = 0;
                        const writeProgress = async (p) => {
                            const t = Date.now();
                            const force = p.uid !== lastUid || p.done === 1 || p.done === p.total;
                            if (!force && t - lastWrite < 400) return;
                            lastWrite = t;
                            lastUid = p.uid;
                            await SelfLearningModel.edit(domainId, ssid, { 'evalJob.progress': p } as any).catch(() => { /* best-effort */ });
                        };
                        // ROLLBACK: no LLM grading — the evaluation reports
                        // raw per-task scores and their sum only. (The
                        // writeProgress plumbing stays for a future re-enable.)
                        void writeProgress;
                        if (bf.graded || bf.failed) logger.info('[self-learning] rubric backfill %s/%s: %d graded, %d failed', domainId, ssid, bf.graded, bf.failed);
                    } catch (e) {
                        logger.warn('[self-learning] ownership backfill %s/%s failed: %s', domainId, ssid, e.message);
                    }
                    await computeSessionResults(domainId, fresh, sessionSchedule(fresh).phase === 'ended');
                    // The done write keeps the summary counts so the finished
                    // card (which now stays on screen) can report them.
                    await SelfLearningModel.edit(domainId, ssid, {
                        evalJob: {
                            state: 'done',
                            startedAt: now,
                            finishedAt: new Date(),
                            progress: {
                                done: bf.total, total: bf.total, graded: bf.graded, failed: bf.failed,
                            },
                        },
                    });
                } catch (e) {
                    logger.warn('[self-learning] manual evaluation for %s/%s failed: %s', domainId, ssid, e.message);
                    await SelfLearningModel.edit(domainId, ssid, {
                        evalJob: {
                            state: 'failed', startedAt: now, finishedAt: new Date(), error: String(e.message || e).slice(0, 200),
                        },
                    }).catch(() => { /* best-effort */ });
                }
            })();
        }
        // XHR callers poll postEvalStatus; the no-JS form fallback just
        // returns to the page (the job keeps running in the background).
        this.response.body = { started: !running, alreadyRunning: running };
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
        const surfacedByPid = new Map<number, string[]>();
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
        /*
         * ↩️ ROLLBACK MIGRATION — results computed under the retired rubric
         * (maxTotal 100) would render nonsensically next to the sum legend.
         * Evaluation is LLM-free and instant now, so a STAFF view simply
         * re-derives stale-schema results on sight; the Evaluate button and
         * the post-deadline sweep run the exact same computeSessionResults,
         * so all three paths agree with what the table presents.
         */
        if (!isStudentView && sdoc.results && sdoc.results.maxTotal !== programmingPidsOf(sdoc, pdict).length * 100) {
            try {
                sdoc.results = await computeSessionResults(domainId, sdoc, sdoc.results.final === true);
                logger.info('[self-learning] re-derived stale-schema results for %s/%s', domainId, sdoc.docId);
            } catch (e) {
                logger.warn('[self-learning] stale-results refresh failed for %s/%s: %s', domainId, sdoc.docId, e.message);
            }
        }
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
                // 🎓 The student's own ownership walkthrough states — the same
                // fetch and the same rubric the evaluation runs.
                // ROLLBACK: raw per-task scores + their sum.
                const perTask = progPids.map((pid) => {
                    const bb = myBest!.get(pid) || null;
                    return {
                        pid: (pdict[pid] as any)?.pid || String(pid),
                        score: bb ? bb.effective : 0,
                        attempted: !!bb,
                        late: !!(bb as any)?.late,
                    };
                });
                const total = Math.round(perTask.reduce((acc, t) => acc + t.score, 0) * 10) / 10;
                const evaluated = sdoc.results?.rows?.find((r) => r.uid === this.user._id) || null;
                myScore = {
                    released: true,
                    total,
                    max: progPids.length * 100,
                    perTask,
                    attempted: perTask.filter((t) => t.attempted).length,
                    evaluatedTotal: evaluated ? evaluated.total : null,
                };
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
            if (closed && !results?.final) {
                try { results = await computeSessionResults(domainId, sdoc, true); } catch (e) { /* the table is optional */ }
            }
            resultsState = results ? (results.final ? 'final' : 'provisional') : (schedule.phase === 'open' ? 'open' : 'pending');
            if (exportAs === 'csv' && results) {
                const csvEsc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
                const head = ['uid', 'username', 'name', ...sdoc.pids.map((pid) => pdict[pid]?.pid || String(pid)), 'total', 'max', 'attempts', 'finished', 'skipped', 'bonus'];
                const lines = [head.map(csvEsc).join(',')];
                for (const r of results.rows) {
                    lines.push([
                        r.uid, r.uname, r.name, ...sdoc.pids.map((pid) => r.scores[String(pid)]?.effective ?? 0),
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
        return this.sessionKind === 'programming' && this.problemKind === 'programming';
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
            const listPsdict = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
                ? await problem.getListStatus(domainId, this.user._id, this.sdoc.pids)
                : {};
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
                    eligible: await bonusEligible(domainId, this.sdoc, this.user._id),
                    inProgress: bonuses.some((b) => b.status === 'drafting' || b.status === 'building'),
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
        if (this.isStudent && schedNow.phase === 'ended') {
            throw new ForbiddenError('This session has ended — submissions are closed.');
        }
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

/** Every session task has at least one judged, non-pretest attempt by the student. */
async function bonusEligible(domainId: string, sdoc: SelfLearningDoc, uid: number): Promise<boolean> {
    if (!sdoc.pids.length) return false;
    const rows = await record.getMulti(domainId, {
        pid: { $in: sdoc.pids }, uid, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING },
    }).project({ pid: 1 }).toArray();
    const tried = new Set(rows.map((r: any) => r.pid));
    return sdoc.pids.every((pid) => tried.has(pid));
}

/** Refresh the student's bonus entries from their drafts and return the client shape. */
async function refreshBonuses(domainId: string, sdoc: SelfLearningDoc, uid: number) {
    const progress = await SelfLearningModel.getProgress(domainId, sdoc.docId, uid);
    const out: any[] = [];
    for (const b of progress?.bonuses || []) {
        let entry = b;
        if (b.status !== 'ready' && b.status !== 'failed') {
            try {
                const st = await bonusState(domainId, b.id);
                const patch: any = { status: st.status, message: st.message.slice(0, 300) };
                if (st.docId && !b.docId) { patch.docId = st.docId; patch.pid = st.pid; }
                if (st.title && !b.title) patch.title = st.title;
                if (st.status === 'ready' && !b.readyAt) patch.readyAt = new Date();
                await SelfLearningModel.updateBonus(domainId, sdoc.docId, uid, b.id, patch);
                entry = { ...b, ...patch };
            } catch (e) { /* keep the stored state */ }
        }
        out.push({
            id: entry.id.toHexString(),
            docId: entry.docId || null,
            pid: entry.pid || null,
            title: entry.title || '',
            status: entry.status,
            message: entry.message || '',
            weakPoints: entry.weakPoints || [],
            createdAt: entry.createdAt,
        });
    }
    return out;
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
            eligible: await bonusEligible(domainId, this.sdoc, this.user._id),
            inProgress: bonuses.some((b) => b.status === 'drafting' || b.status === 'building'),
            available: aiTutor.tutorEnabled() && aiTutor.tutorConfigured(),
        };
    }

    /** Diagnose the student's weak points and start a new bonus task. */
    async postCreate({ domainId }) {
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

        // ---- the student's work, task by task ----
        const pdict = await problem.getList(domainId, this.sdoc.pids, true, false, problem.PROJECTION_CONTEST_LIST, true);
        const progress = await SelfLearningModel.getProgress(domainId, this.sdoc.docId, uid);
        const langCount = new Map<string, number>();
        const blocks: string[] = [];
        for (const pid of this.sdoc.pids) {
            const pdoc = pdict[pid];
            if (!pdoc) continue;
            const recs = await record.getMulti(domainId, { pid, uid, contest: { $ne: record.RECORD_PRETEST }, status: { $nin: JUDGING } })
                .sort({ _id: 1 }).limit(20).project({ status: 1, score: 1, lang: 1, code: 1 }).toArray();
            for (const r of recs as any[]) if (r.lang) langCount.set(r.lang, (langCount.get(r.lang) || 0) + 1);
            const trajectory = (recs as any[]).map((r, i) => `${i + 1}:${STATUS_SHORT_TEXTS[r.status] || STATUS_TEXTS[r.status] || r.status}${r.score ? `(${r.score})` : ''}`).join(' → ');
            const last = (recs as any[])[recs.length - 1];
            const thread = await SelfLearningModel.getThread(domainId, this.sdoc.docId, pid, uid);
            const exchanges = (thread?.messages || []).filter((m: any) => m.kind === 'anno').slice(-10)
                .map((m: any) => `${m.role === 'user' ? 'STUDENT' : 'TUTOR'}${m.line ? ` [line ${m.line}]` : ''}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
            const state = progress?.done?.includes(pid) ? 'finished' : progress?.skipped?.includes(pid) ? 'SKIPPED' : 'in progress';
            blocks.push([
                `=== TASK ${pdoc.pid || pid}: ${pdoc.title} [${state}] ===`,
                `Knowledge points: ${(pdoc.tag || []).join('; ') || '(none)'}`,
                `Attempts: ${trajectory || '(none)'}`,
                last?.code ? `Latest code (${last.lang}):\n${String(last.code).slice(0, 1200)}` : '',
                exchanges ? `Tutor exchanges:\n${exchanges}` : 'Tutor exchanges: (none)',
            ].filter((x) => x).join('\n'));
        }
        const language = [...langCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || this.sdoc.pids.length && (pdict[this.sdoc.pids[0]]?.config as any)?.langs?.[0] || 'cc.cc17';
        const catalog = await KnowledgeModel.list(domainId, '', 300);
        const catalogBlock = catalog.length ? `Knowledge-point list of this course (use exact names): ${catalog.map((k) => k.name).join('; ')}` : '';
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
        if (!brief) throw new BadRequestError('The AI could not design a bonus task from your work yet. Please try again.');
        const evidence = (Array.isArray(j?.weakPoints) ? j.weakPoints : []).map((w: any) => `- ${w?.name}: ${w?.evidence || ''}`).join('\n');
        const titles = this.sdoc.pids.map((pid) => pdict[pid]?.title).filter((x) => x).join('; ');
        const id = await createBonusDraft(domainId, this.sdoc.owner, {
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
        }, { ssid: this.sdoc.docId, uid });
        const entry: SelfLearningBonusEntry = {
            id, status: 'drafting', message: 'Drafting the statement…', weakPoints: weak.map((w) => w.name), createdAt: new Date(),
        };
        await SelfLearningModel.addBonus(domainId, this.sdoc.docId, uid, entry);
        // Phase 1 in the background: the statement, then the hidden problem;
        // phase 2 (solution, tests, verification) follows on its own.
        const ssid = this.sdoc.docId;
        materializeBonus(domainId, id).then(async (m) => {
            await SelfLearningModel.updateBonus(domainId, ssid, uid, id, { docId: m.docId, pid: m.pid, title: m.title, status: 'building', message: 'Preparing the judge…' });
        }).catch(async (e) => {
            await SelfLearningModel.updateBonus(domainId, ssid, uid, id, { status: 'failed', message: String(e.message || e).slice(0, 300) });
        });
        this.response.body = {
            bonus: {
                id: id.toHexString(), docId: null, pid: null, title: '', status: 'drafting', message: entry.message, weakPoints: entry.weakPoints, createdAt: entry.createdAt,
            },
        };
    }

    /** Retry a failed bonus build. */
    @param('id', Types.ObjectId)
    async postRetry({ domainId }, id: ObjectId) {
        const progress = await SelfLearningModel.getProgress(domainId, this.sdoc.docId, this.user._id);
        const b = (progress?.bonuses || []).find((x) => x.id.equals(id));
        if (!b) throw new NotFoundError(id);
        if (b.status !== 'failed') throw new BadRequestError('Only a failed bonus task can be retried.');
        await this.limitRate('ai_tutor', 60, 3, '{{user}}');
        await SelfLearningModel.updateBonus(domainId, this.sdoc.docId, this.user._id, id, { status: b.docId ? 'building' : 'drafting', message: 'Retrying…' });
        const ssid = this.sdoc.docId;
        const uid = this.user._id;
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
    checkTutorAllowed() {
        if (!aiTutor.tutorEnabled()) throw new ForbiddenError('The AI tutor is disabled.');
        if (!aiTutor.tutorConfigured()) throw new ForbiddenError('The AI tutor is not configured. Please ask the administrator to set an API key.');
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
         * 🎓 CODE-OWNERSHIP walkthrough — the 10-point rubric component:
         * once a submission is ACCEPTED, the tutor asks a short sequence of
         * questions probing whether the student can explain THEIR OWN code,
         * and the LLM grades each answer 0..4 (postAnnotateReply). The
         * question budget is fixed at the FIRST acceptance — 5..6 questions
         * when that acceptance was the very first attempt, 2..3 otherwise —
         * and later re-acceptances continue the same unfinished sequence
         * rather than re-rolling it.
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
                await SelfLearningModel.initOwnership(thread._id, fresh);
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
                if (!ownership.done) await SelfLearningModel.setOwnershipDone(thread._id);
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
                // matches on, so store exactly what the reply will send.
                await SelfLearningModel.pushOwnershipQuestion(thread._id, {
                    question: String(annotation.question).slice(0, 300), line: annotation.line, at: new Date(), levels: [],
                });
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
            if (ownership.questions.length >= ownership.minQ) await SelfLearningModel.setOwnershipDone(thread._id);
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
                await SelfLearningModel.pushReasoningLevel(thread._id, level, rkey);
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
                await SelfLearningModel.pushOwnershipLevel(thread._id, question.slice(0, 300), level, key);
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

const logger = new Logger('self-learning');

/* ------------------------------------------------------------------------ */
/* Site-wide PTA UI backend — migrated here from problem_trajectory.ts.     */
/* Some dev-mode watchers hot-reload MODIFIED handler files but never       */
/* discover files CREATED after boot, so anything defined only in a brand-  */
/* new file was unreachable on such deployments. This file is proven live.  */
/* ------------------------------------------------------------------------ */

/** Kind + title for each listed problem (config arrives as a raw YAML string). */
async function activityKinds(domainId: string, pids: number[], uid?: number) {
    const pdict = await problem.getList(domainId, pids, true, false, ['docId', 'pid', 'title', 'config'], true);
    // Rail verdict states: the requester's OWN problem-status docs. The judge
    // updates these for contest/homework submissions too (handler/judge.ts
    // calls problem.updateStatus before contest.updateStatus), so accepted /
    // tried decorations are correct inside activities as well.
    const psdict: Record<number, { status?: number, score?: number }> = {};
    if (uid && uid > 1) {
        try {
            const rows = await problem.getMultiStatus(domainId, { uid, docId: { $in: pids } })
                .project({ docId: 1, status: 1, score: 1 }).toArray();
            for (const r of rows) psdict[r.docId] = r as any;
        } catch (e) { /* status decoration is optional */ }
    }
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
        else if (/^p/i.test(disp)) kind = 'programming';
        const st = psdict[pid] || {};
        return { pid, kind, title: p.title || String(pid), status: st.status || 0, score: st.score };
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
        this.response.body = { pids: await activityKinds(domainId, tdoc.pids || [], this.user?._id) };
    }
}

const FALSY_AVAILABILITY = ['', '0', 'false', 'no', 'n', 'unavailable', 'inactive', 'off'];

/**
 * Post-acceptance "AI Suggestions": one comprehensive Markdown code review
 * over the problem statement plus the requester's FULL submission trajectory
 * (timestamps included, so debugging behavior can be analyzed). Requires at
 * least one accepted attempt — the button only appears on accepted modals.
 */
class AiSuggestionsHandler extends Handler {
    @param('pid', Types.PositiveInt)
    async get({ domainId }, pid: number) {
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

const CLASS_MAX_PARTICIPANTS = 400; // hard safety ceiling
const CLASS_SINGLE_CALL_MAX = 60; // above this, the map-reduce path runs
const CLASS_BATCH_SIZE = 40;
const CLASS_MAX_PIDS = 8;
const CLASS_MAX_RECORDS = 20000;
const NONFINAL_STATUS = [0, 20, 21, 22]; // waiting / judging / compiling / fetched

/**
 * Deterministic collector: everything the LLM may cite is computed HERE.
 * `full` additionally assembles roster lines, code samples, and the harvest
 * from stored per-student AI reports (all anonymized as S-tokens).
 */
async function buildClassStats(domainId: string, tdoc: any, full: boolean, kind = 'contest') {
    const pidsAll: number[] = (tdoc.pids || []).filter((x: any) => typeof x === 'number');
    const pids = pidsAll.slice(0, CLASS_MAX_PIDS);
    // Code NEVER rides the bulk query (200+ students x attempts would be
    // hundreds of MB) — samples are re-fetched by rid afterwards.
    const proj: any = {
        uid: 1, pid: 1, status: 1, score: 1,
    };
    // Self-learning submissions carry NO contest tag, so that kind analyzes
    // every non-pretest judged submission on the session's problems.
    const recordQuery = kind === 'self-learning'
        ? { pid: { $in: pids }, contest: { $ne: record.RECORD_PRETEST } }
        : { contest: tdoc.docId, pid: { $in: pids } };
    const rdocs = await record.getMulti(domainId, recordQuery)
        .sort({ _id: 1 }).limit(CLASS_MAX_RECORDS).project(proj).toArray();
    const trails = new Map<string, { at: number, status: number, score: number, code?: string }[]>();
    const uidSet = new Set<number>();
    for (const r of rdocs as any[]) {
        if (NONFINAL_STATUS.includes(r.status)) continue;
        uidSet.add(r.uid);
        const key = `${r.uid}/${r.pid}`;
        if (!trails.has(key)) trails.set(key, []);
        trails.get(key)!.push({
            at: r._id.getTimestamp().getTime(), status: r.status, score: r.score || 0, rid: r._id,
        });
    }
    const participantsAll = [...uidSet].sort((a, b) => a - b);
    const sampled = participantsAll.length > CLASS_MAX_PARTICIPANTS
        || pidsAll.length > pids.length || (rdocs as any[]).length >= CLASS_MAX_RECORDS;
    const participants = participantsAll.slice(0, CLASS_MAX_PARTICIPANTS);
    const sOf = new Map<number, string>();
    participants.forEach((uid, i) => sOf.set(uid, `S${i + 1}`));
    const pdocs = await problem.getMulti(domainId, { docId: { $in: pids } })
        .project({ docId: 1, pid: 1, title: 1 }).toArray();
    const pLabel = new Map<number, string>();
    const pTitle = new Map<number, string>();
    for (const pd of pdocs as any[]) {
        pLabel.set(pd.docId, `P${pd.pid ?? pd.docId}`);
        pTitle.set(pd.docId, pd.title || '');
    }
    for (const pid of pids) if (!pLabel.has(pid)) pLabel.set(pid, `P${pid}`);
    const perPid: any[] = [];
    for (const pid of pids) {
        let attempted = 0;
        let solved = 0;
        let thrashers = 0;
        const verdicts: Record<string, number> = {};
        const firstFail: Record<string, number> = {};
        const attemptCounts: number[] = [];
        for (const uid of participants) {
            const t = trails.get(`${uid}/${pid}`);
            if (!t || !t.length) continue;
            attempted++;
            attemptCounts.push(t.length);
            if (t.some((x) => x.status === STATUS.STATUS_ACCEPTED)) solved++;
            const ff = t.find((x) => x.status !== STATUS.STATUS_ACCEPTED);
            if (ff) {
                const k = STATUS_TEXTS[ff.status] || `${ff.status}`;
                firstFail[k] = (firstFail[k] || 0) + 1;
            }
            for (const x of t) {
                if (x.status === STATUS.STATUS_ACCEPTED) continue;
                const k = STATUS_TEXTS[x.status] || `${x.status}`;
                verdicts[k] = (verdicts[k] || 0) + 1;
            }
            if (t.length >= 3) {
                let fast = 0;
                for (let i = 1; i < t.length; i++) if (t[i].at - t[i - 1].at < 90000) fast++;
                if (fast / (t.length - 1) >= 0.5) thrashers++;
            }
        }
        attemptCounts.sort((a, b) => a - b);
        perPid.push({
            pid,
            label: pLabel.get(pid),
            title: pTitle.get(pid),
            attempted,
            solved,
            medianAttempts: attemptCounts.length ? attemptCounts[Math.floor((attemptCounts.length - 1) / 2)] : 0,
            maxAttempts: attemptCounts[attemptCounts.length - 1] || 0,
            thrashers,
            verdicts,
            firstFail,
        });
    }
    // Self-learning bonus data: tutor-thread engagement per problem —
    // questions asked, student replies, and silently-skipped questions
    // (question shown, never answered: the fast-fix path or disengagement).
    const tutorByPid = new Map<number, { questions: number, replies: number, skipped: number, threads: number }>();
    if (kind === 'self-learning') {
        try {
            const threads = await getTutorThreadsIn(domainId, tdoc.docId, pids, participants);
            for (const th of threads as any[]) {
                if (!tutorByPid.has(th.pid)) {
                    tutorByPid.set(th.pid, {
                        questions: 0, replies: 0, skipped: 0, threads: 0,
                    });
                }
                const agg = tutorByPid.get(th.pid)!;
                agg.threads++;
                let pendingAnswered = true;
                for (const m of th.messages || []) {
                    if (m.kind !== 'anno') continue;
                    if (m.role === 'assistant' && typeof m.resolved !== 'boolean') {
                        if (!pendingAnswered) agg.skipped++;
                        agg.questions++;
                        pendingAnswered = false;
                    } else if (m.role === 'user') {
                        agg.replies++;
                        pendingAnswered = true;
                    }
                }
                if (!pendingAnswered) agg.skipped++;
            }
        } catch (e) {
            logger.warn('[pta-ui] tutor engagement stats failed: %s', e.message);
        }
    }
    const light = {
        activity: tdoc.title,
        kind,
        participants: participantsAll.length,
        records: (rdocs as any[]).length,
        sampled,
        problems: perPid.map((p) => ({
            label: p.label,
            title: p.title,
            attempted: p.attempted,
            solved: p.solved,
            medianAttempts: p.medianAttempts,
            maxAttempts: p.maxAttempts,
            thrashers: p.thrashers,
            verdicts: p.verdicts,
            firstFail: p.firstFail,
            ...(kind === 'self-learning' ? {
                tutorQuestions: tutorByPid.get(p.pid)?.questions || 0,
                tutorReplies: tutorByPid.get(p.pid)?.replies || 0,
                tutorSkipped: tutorByPid.get(p.pid)?.skipped || 0,
            } : {}),
        })),
    };
    if (!full) return { light } as any;
    const roster: string[] = [];
    for (const uid of participants) {
        const parts: string[] = [];
        for (const pid of pids) {
            const t = trails.get(`${uid}/${pid}`);
            if (!t || !t.length) continue;
            const ac = t.some((x) => x.status === STATUS.STATUS_ACCEPTED);
            const last = t[t.length - 1];
            parts.push(`${pLabel.get(pid)}:${t.length}${ac ? '(AC)' : `(${STATUS_SHORT_TEXTS[last.status] || last.status})`}`);
        }
        roster.push(`${sOf.get(uid)}: ${parts.join(' ') || '(no submissions)'}`.slice(0, 120));
    }
    // Pick sample rids first, then fetch just those codes (<= ~32 small reads).
    const picks: { rid: any, label: string, sTok: string, tag: string, cap: number }[] = [];
    for (const p of perPid) {
        const modal = (Object.entries(p.firstFail) as [string, number][]).sort((a, b) => b[1] - a[1])[0]?.[0];
        let taken = 0;
        if (modal) {
            for (const uid of participants) {
                if (taken >= 3) break;
                const t = trails.get(`${uid}/${p.pid}`);
                const hit = t?.find((x) => (STATUS_TEXTS[x.status] || `${x.status}`) === modal);
                if (hit) {
                    picks.push({
                        rid: hit.rid, label: p.label!, sTok: sOf.get(uid)!, tag: `failing sample (${sOf.get(uid)}, ${modal})`, cap: 900,
                    });
                    taken++;
                }
            }
        }
        for (const uid of participants) {
            const t = trails.get(`${uid}/${p.pid}`);
            const ac = t?.find((x) => x.status === STATUS.STATUS_ACCEPTED);
            if (ac) {
                picks.push({
                    rid: ac.rid, label: p.label!, sTok: sOf.get(uid)!, tag: `accepted sample (${sOf.get(uid)})`, cap: 1200,
                });
                break;
            }
        }
    }
    const samples: string[] = [];
    if (picks.length) {
        const codeDocs = await record.getMulti(domainId, { _id: { $in: picks.map((x) => x.rid) } })
            .project({ code: 1 }).toArray();
        const codeById = new Map((codeDocs as any[]).map((d) => [String(d._id), d.code]));
        for (const pk of picks) {
            const code = codeById.get(String(pk.rid));
            if (typeof code === 'string' && code.trim()) {
                samples.push(`--- ${pk.label} ${pk.tag} ---\n${String(code).slice(0, pk.cap)}`);
            }
        }
    }
    const harvested: string[] = [];
    try {
        const sdocs = await getSuggestionReportsIn(domainId, pids, participants);
        for (const d of sdocs as any[]) {
            const idx = String(d.report || '').toLowerCase().indexOf('critical concept');
            if (idx < 0) continue;
            const snip = String(d.report).slice(idx, idx + 340).replace(/[*_#`>]/g, ' ').replace(/\s+/g, ' ').trim();
            harvested.push(`${sOf.get(d.uid) || '(other)'} on ${pLabel.get(d.pid) || `P${d.pid}`}: ${snip}`);
            if (harvested.length >= 40) break;
        }
    } catch (e) { /* the harvest is best-effort */ }
    return {
        light, participants, sOf, perPid, roster, samples, harvested,
    } as any;
}

/** MAP-stage context: shared per-problem stats + ONE batch's student lines. */
function classBatchContext(stats: any, batchTokens: Set<string>): string {
    const L = stats.light;
    const lines: string[] = [
        `ACTIVITY TITLE: ${L.activity}`,
        `TYPE: ${L.kind}`,
        `Full-class participants: ${L.participants}. THIS BATCH: ${batchTokens.size} students.`,
        '',
        '--- Per-problem statistics (full class; read-only reference) ---',
    ];
    for (const p of stats.perPid) {
        lines.push(`${p.label} "${p.title}": attempted ${p.attempted}, solved ${p.solved}, median attempts ${p.medianAttempts}`);
    }
    lines.push('', `--- This batch's roster (${[...batchTokens][0]}..${[...batchTokens][batchTokens.size - 1]}) ---`);
    lines.push(...stats.roster.filter((r: string) => batchTokens.has(r.split(':')[0])));
    const bh = stats.harvested.filter((h: string) => batchTokens.has(h.split(' ')[0]));
    if (bh.length) lines.push('', "--- This batch's harvested critical-concept notes ---", ...bh);
    lines.push('', '--- End of batch. Emit the JSON now. ---');
    return lines.join('\n');
}

/** Tolerant parse of one map-stage JSON output. */
function parseMapOutput(raw: string, validLabels: Set<string>, batchTokens: Set<string>) {
    const cleaned = String(raw || '').replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{');
    if (start < 0) throw new Error('no JSON object');
    const parsed = JSON.parse(cleaned.slice(start, cleaned.lastIndexOf('}') + 1));
    const concepts = (Array.isArray(parsed?.concepts) ? parsed.concepts : [])
        .filter((c: any) => c && typeof c.name === 'string')
        .map((c: any) => ({
            name: String(c.name).slice(0, 60).trim(),
            problems: Object.fromEntries(Object.entries(c.problems || {})
                .filter(([k, v]) => validLabels.has(String(k)) && Number.isFinite(+(v as any)) && +(v as any) > 0)
                .map(([k, v]) => [String(k), Math.min(Math.round(+(v as any)), batchTokens.size)])),
            students: (Array.isArray(c.students) ? c.students : []).map(String).filter((t: string) => batchTokens.has(t)).slice(0, 40),
        }))
        .filter((c: any) => Object.keys(c.problems).length);
    const flags = parsed?.flags || {};
    return {
        concepts,
        intervention: (Array.isArray(flags.intervention) ? flags.intervention : [])
            .filter((f: any) => f && batchTokens.has(String(f.s)))
            .map((f: any) => ({ s: String(f.s), reason: String(f.reason || '').slice(0, 90) })).slice(0, 8),
        stretch: (Array.isArray(flags.stretch) ? flags.stretch : []).map(String).filter((t: string) => batchTokens.has(t)).slice(0, 8),
        notes: (Array.isArray(parsed?.notes) ? parsed.notes : []).map((x: any) => String(x).slice(0, 140)).slice(0, 3),
    };
}

/**
 * Extract and strip the mandatory json:concepts trailer: the prose report
 * stays clean while the structured knowledge points feed the charts.
 */
function extractConceptBlock(md: string, validLabels?: Set<string>): { report: string, concepts: any[] } {
    const m = md.match(/```json:concepts\s*\n([\s\S]*?)```/);
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

function classContextBlock(stats: any, agg: any = null): string {
    const L = stats.light;
    const lines: string[] = [
        `ACTIVITY TITLE: ${L.activity}`,
        `TYPE: ${L.kind}`,
        `Participants (students with at least one judged submission): ${L.participants}${L.sampled ? ' — NOTE: the data was capped/sampled; state this in the Executive Summary.' : ''}`,
        `Total judged submissions considered: ${L.records}`,
        '',
        '--- Problems and deterministic statistics (server-computed; the ONLY numbers you may cite) ---',
    ];
    const lightByLabel = new Map((L.problems || []).map((p: any) => [p.label, p]));
    for (const p of stats.perPid) {
        const lp: any = lightByLabel.get(p.label) || {};
        const tutorBit = lp.tutorQuestions != null
            ? `, tutor questions ${lp.tutorQuestions}, student replies ${lp.tutorReplies}, silently-skipped ${lp.tutorSkipped}` : '';
        lines.push(`${p.label} "${p.title}": attempted ${p.attempted}, solved ${p.solved}, median attempts ${p.medianAttempts}, max attempts ${p.maxAttempts}, grader-thrash students ${p.thrashers}${tutorBit}`);
        lines.push(`  failing verdicts (all attempts): ${Object.entries(p.verdicts).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);
        lines.push(`  first-failure verdicts: ${Object.entries(p.firstFail).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);
    }
    if (agg) {
        lines.push('', `--- Batch analysis (per-student lines were processed in ${agg.batchCount} disjoint batches covering ALL ${L.participants} participants; concept counts below are exact sums) ---`);
        for (const c of agg.concepts) {
            const per = Object.entries(c.problems).map(([k, v]) => `${k}:${v}`).join(' ');
            lines.push(`concept "${c.name}" — total ${c.total} student(s) (${per || 'no per-problem split'}) — e.g. ${c.students.slice(0, 10).join(', ') || '-'}`);
        }
        if (agg.intervention.length) lines.push('', 'Flagged for intervention:', ...agg.intervention.map((f: any) => `- ${f.s}: ${f.reason}`));
        if (agg.stretch.length) lines.push('', `Ready for stretch material: ${agg.stretch.join(', ')}`);
        if (agg.notes.length) lines.push('', 'Batch observations:', ...agg.notes.map((x: string) => `- ${x}`));
        const flagged = new Set([...agg.intervention.map((f: any) => f.s), ...agg.stretch]);
        const flaggedLines = stats.roster.filter((r: string) => flagged.has(r.split(':')[0])).slice(0, 40);
        if (flaggedLines.length) lines.push('', '--- Roster lines of flagged students only ---', ...flaggedLines);
    } else {
        lines.push('', '--- Anonymized roster (per-problem attempt counts and final state) ---', ...stats.roster);
    }
    if (stats.harvested.length && !agg) lines.push('', '--- Harvested "critical concept" notes from per-student AI reports ---', ...stats.harvested);
    if (stats.samples.length) lines.push('', '--- Representative code excerpts (the ONLY code you may quote) ---', ...stats.samples);
    lines.push('', '--- End of context. Write the report now. ---');
    return lines.join('\n');
}

/**
 * Teacher-only class report over one contest/homework: GET serves the cached
 * report plus cheap live stats (dry=1 returns the full assembled context for
 * auditing, no LLM call); POST collects, generates, name-substitutes, and
 * stores both the anonymous and the named variants.
 */
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
    async get({ domainId }, tid: ObjectId, dry = false) {
        const { tdoc, kind } = await this.classTdoc(domainId, tid);
        if (dry) {
            const stats = await buildClassStats(domainId, tdoc, true, kind);
            const big = stats.participants.length > CLASS_SINGLE_CALL_MAX;
            const firstBatch = big
                ? new Set<string>(stats.participants.slice(0, CLASS_BATCH_SIZE).map((uid: number) => stats.sOf.get(uid)))
                : null;
            this.response.body = {
                mode: big ? 'map-reduce' : 'single-call',
                batchCount: big ? Math.ceil(stats.participants.length / CLASS_BATCH_SIZE) : 1,
                light: stats.light,
                roster: stats.roster,
                samplesCount: stats.samples.length,
                harvestedCount: stats.harvested.length,
                sampleBatchContext: firstBatch ? classBatchContext(stats, firstBatch) : undefined,
                context: classContextBlock(stats, null),
            };
            return;
        }
        const [doc, stats] = await Promise.all([
            getClassReport(domainId, String(tid)),
            buildClassStats(domainId, tdoc, false, kind),
        ]);
        this.response.body = {
            report: doc?.reportNamed || null,
            generatedAt: doc?.generatedAt || null,
            participants: doc?.participants ?? null,
            concepts: doc?.concepts || [],
            stats: stats.light,
        };
    }

    @param('tid', Types.ObjectId)
    async post({ domainId }, tid: ObjectId) {
        const { tdoc, kind } = await this.classTdoc(domainId, tid);
        if (!aiTutor.tutorConfigured()) throw new ForbiddenError('The AI tutor is not configured. Please ask the administrator to set an API key.');
        await this.limitRate('ai_class_report', 600, 2, '{{user}}');
        const stats = await buildClassStats(domainId, tdoc, true, kind);
        if (!stats.light.participants) throw new BadRequestError('No judged submissions yet — nothing to analyze.');
        const validLabels = new Set<string>(stats.perPid.map((p: any) => String(p.label)));
        let agg: any = null;
        if (stats.participants.length > CLASS_SINGLE_CALL_MAX) {
            // MAP stage: disjoint 40-student batches -> structured JSON, with a
            // small concurrency pool. Deterministic stats never need batching.
            const tokens: string[] = stats.participants.map((uid: number) => stats.sOf.get(uid));
            const batches: Set<string>[] = [];
            for (let i = 0; i < tokens.length; i += CLASS_BATCH_SIZE) batches.push(new Set(tokens.slice(i, i + CLASS_BATCH_SIZE)));
            const results: any[] = new Array(batches.length).fill(null);
            let cursor = 0;
            const worker = async () => {
                for (;;) {
                    const idx = cursor++;
                    if (idx >= batches.length) return;
                    try {
                        const rawMap = await aiTutor.runClassMapBatch(classBatchContext(stats, batches[idx]));
                        results[idx] = parseMapOutput(rawMap, validLabels, batches[idx]);
                    } catch (e) {
                        logger.warn('[pta-ui] class report map batch %d/%d failed: %s', idx + 1, batches.length, e.message);
                    }
                }
            };
            await Promise.all([worker(), worker(), worker()]);
            const byName = new Map<string, any>();
            const intervention: any[] = [];
            const stretch: string[] = [];
            const notes: string[] = [];
            let okBatches = 0;
            for (const r of results) {
                if (!r) continue;
                okBatches++;
                for (const c of r.concepts) {
                    const key = c.name.toLowerCase();
                    if (!byName.has(key)) {
                        byName.set(key, {
                            name: c.name, problems: {}, students: [], total: 0,
                        });
                    }
                    const m = byName.get(key);
                    for (const [k, v] of Object.entries(c.problems)) {
                        m.problems[k] = (m.problems[k] || 0) + (v as number);
                        m.total += v as number;
                    }
                    m.students.push(...c.students);
                }
                intervention.push(...r.intervention);
                stretch.push(...r.stretch);
                notes.push(...r.notes);
            }
            if (okBatches) {
                agg = {
                    batchCount: batches.length,
                    concepts: [...byName.values()].sort((a, b) => b.total - a.total).slice(0, 25),
                    intervention: intervention.slice(0, 25),
                    stretch: [...new Set(stretch)].slice(0, 25),
                    notes: notes.slice(0, 8),
                };
                if (okBatches < batches.length) {
                    agg.notes.push(`${batches.length - okBatches} batch(es) failed to analyze; their students are covered by the statistics only.`);
                }
                logger.info('[pta-ui] class report map stage: %d/%d batches ok, %d merged concept(s)', okBatches, batches.length, agg.concepts.length);
            } else {
                logger.warn('[pta-ui] class report: all map batches failed; reducing on statistics only');
            }
        }
        const raw = await aiTutor.runClassReport(classContextBlock(stats, agg));
        const { report: reportAnon, concepts: conceptsAnon } = extractConceptBlock(raw, validLabels);
        // Teacher-only artifact: substitute S-tokens with real usernames. The
        // provider only ever saw the anonymous tokens.
        let udict: any = {};
        try {
            udict = await user.getList(domainId, [...stats.sOf.keys()]);
        } catch (e) { /* fall back to uid placeholders */ }
        const sidMap = [...stats.sOf.entries()].map(([uid, sTok]) => ({
            s: sTok, uid, uname: udict[uid]?.uname || `user#${uid}`,
        }));
        const byTok = new Map(sidMap.map((e) => [e.s, e.uname]));
        const substitute = (text: string) => text.replace(/\bS(\d+)\b/g, (m) => byTok.get(m) || m);
        const reportNamed = substitute(reportAnon);
        const concepts = conceptsAnon.map((c: any) => ({
            ...c, students: (c.students || []).map((tok: string) => byTok.get(tok) || tok),
        }));
        const generatedAt = await setClassReport({
            domainId,
            tid: String(tid),
            reportAnon,
            reportNamed,
            sidMap,
            concepts,
            statsSnapshot: stats.light,
            participants: stats.light.participants,
            generatedBy: this.user._id,
        });
        this.response.body = {
            report: reportNamed, updateAt: generatedAt, stats: stats.light, concepts,
        };
        logger.info('[pta-ui] AI class report generated for %s/%s by uid=%d (%d participants)', domainId, tid, this.user._id, stats.light.participants);
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
        const canManage = this.user.own(tdoc) || this.user.hasPerm(PERM.PERM_EDIT_CONTEST) || this.user.role === 'root';
        if (!canManage) {
            if (contest.isNotStarted(tdoc)) throw new ContestNotLiveError(domainId, tid);
            if (!this.tsdoc?.attend) throw new ContestNotAttendedError(domainId, tid);
        }
        const isHomework = tdoc.rule === 'homework';
        // Verdicts for objective tasks are withheld until the container
        // ends (contest.applyProjection masks the records); tell the paper
        // so it neither polls for results nor pre-colors chips from the
        // student's global problem status — either would leak.
        const resultsWithheld = !canManage && !contest.isDone(tdoc, this.tsdoc);
        await respondObjectivePaper(this, domainId, {
            resultsWithheld,
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
        await respondObjectivePaper(this, domainId, {
            heading: sdoc.title,
            backUrl: this.url('self_learning_detail', { ssid }),
            pageName: 'self_learning_paper',
            storeKey: ssid.toHexString(),
            docIds: sdoc.pids || [],
            canSubmit: !closed,
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
    heading: string, backUrl: string, pageName: string, storeKey: string,
    docIds: number[], submitUrlFor: (docId: number) => string,
    chipHrefFor: (pdoc: any) => string,
    resultsWithheld?: boolean,
    /** Self-learning: the paper answers in place (per-task submit + verdicts). */
    canSubmit?: boolean,
    recordUrlFor?: (docId: number) => string,
}) {
    const pdocs = (await Promise.all((opts.docIds || []).map((docId) => problem.get(domainId, docId))))
        .filter((x) => x);
    const objective = pdocs.filter((pdoc) => /^o/i.test(String(pdoc.pid || '')));
    const tasks = objective.map((pdoc, k) => ({
        docId: pdoc.docId,
        pid: pdoc.pid,
        index: k + 1,
        title: pdoc.title,
        submitUrl: opts.submitUrlFor(pdoc.docId),
        recordUrl: opts.recordUrlFor ? opts.recordUrlFor(pdoc.docId) : '',
        content: pdoc.content,
    }));
    h.response.template = 'objective_paper.html';
    h.response.body = {
        heading: opts.heading,
        backUrl: opts.backUrl,
        tasks,
        canSubmit: !!opts.canSubmit,
        othersCount: pdocs.length - objective.length,
        page_name: opts.pageName,
    };
    h.UiContext.paperTasks = tasks.map(({ content, ...t }) => t);
    h.UiContext.paperKey = opts.storeKey;
    h.UiContext.paperWithheld = !!opts.resultsWithheld;
    h.UiContext.paperCanSubmit = !!opts.canSubmit;
    h.UiContext.noCopy = !(h.user.hasPerm(PERM.PERM_EDIT_PROBLEM) || h.user.hasPerm(PERM.PERM_CREATE_PROBLEM));
    /*
     * The fixed-left problems rail (auto_scratchpad's sl-rail) replaces the
     * paper's own sidebar: every task of the container, all kinds, with the
     * student's solve status. Objective chips anchor into the paper; other
     * kinds carry the container context out to their own pages, so nobody
     * has to hop back to the detail page to move around.
     */
    const psdict = await problem.getListStatus(domainId, (h as any).user._id, pdocs.map((p) => p.docId));
    h.UiContext.paperRail = {
        items: pdocs.map((pdoc) => {
            const pidStr = String(pdoc.pid || '');
            const kind = /^o/i.test(pidStr) ? 'objective' : (/^s/i.test(pidStr) ? 'subjective' : 'programming');
            return {
                pid: pdoc.pid || pdoc.docId,
                kind,
                // While results are withheld, objective chips stay neutral:
                // the global problem status would reveal exactly what the
                // record mask is hiding.
                status: (opts.resultsWithheld && kind === 'objective') ? 0 : (psdict[pdoc.docId]?.status || 0),
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
        ctx.on('dispose', () => { clearTimeout(first); clearInterval(every); });
    }
    const setKinds = async (h: any, source: string) => {
        if (!h?.UiContext || h.UiContext.tdocKinds || h.UiContext.trainingRail || h.UiContext.psetRail) return;
        let tdoc = h.tdoc || h.response?.body?.tdoc;
        if (!tdoc && h.args?.tid) tdoc = await contest.get(h.args.domainId, h.args.tid).catch(() => null);
        if (tdoc && Array.isArray(tdoc.pids) && tdoc.pids.length > 1) {
            try {
                h.UiContext.tdocKinds = await activityKinds(h.args.domainId, tdoc.pids, h.user?._id);
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
            const [before, after] = await Promise.all([
                problem.getMulti(h.args.domainId, { ...vis, docId: { $lt: cur } })
                    .sort({ docId: -1 }).limit(12).project({ docId: 1 }).toArray(),
                problem.getMulti(h.args.domainId, { ...vis, docId: { $gte: cur } })
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

/**
 * ⚡ QUICK REVIEW — the class-level review of a finished test (in-class
 * quiz) that the teacher opens seconds after the end, and the instant
 * per-student feedback that comes with it.
 *
 * TWO SPEEDS. The Full Report (activity_report.ts) reads every student's
 * every submission through the model and takes minutes. The Quick Review
 * is built from the SAME corpus but the other way round:
 *
 *   1. everything with a number is computed here, exactly, in milliseconds
 *      (per-question accuracy, distractor analysis, fill-in error strings,
 *      multi-select miss/add rates, programming error clusters, knowledge-
 *      point mastery, a priority order of what to re-teach first);
 *   2. ONE model call (ai_tutor.runQuickDiagnosis) then EXPLAINS the top
 *      items — the misconception, a 60-second re-teach script, a check
 *      question — from an anonymous, aggregated digest. It can be missing
 *      (provider down, homework) and the panel still works.
 *
 * WHO SEES WHAT. Teachers (owner / root) get the digest + diagnosis and a
 * presentation mode that never shows a name. Each student gets their own
 * row of `perStudent` — missed questions, the knowledge points they expose,
 * the class misconception when their answer was the dominant wrong one —
 * once the test has ended for EVERYONE and the release policy allows.
 *
 * WHEN. Chained after the end-of-test evaluation (handler/contest.ts
 * schedule task) when ai_tutor.quick_review_auto is on, or on the
 * teacher's click. Cached on the class-report document; `resultsHash`
 * (from the light statistics) tells a GET whether the cache still matches
 * the scoreboard, so a score override or a re-grade is picked up.
 */
import { createHash } from 'crypto';
import { STATUS_SHORT_TEXTS, STATUS_TEXTS } from '@hydrooj/common';
import { Logger } from '../logger';
import { buildActivityCorpus } from './activity_report';
import * as aiTutor from './ai_tutor';
import { scheduleMastery } from './knowledge_map';
import { markDirty } from '../model/knowledgemap';
import { mapLimit } from './ai_scheduler';
import { runObjectiveFeedbackJob } from './objective_feedback';
import KnowledgeModel from '../model/knowledge';
import problem from '../model/problem';
import {
    getQuestionPoints, getQuick, questionPointKey, quickJobStale, replaceQuizEvidence, setQuestionPoints, setQuick, setQuickJob, setQuickPrewarm,
    studentFeedbackVisible,
} from '../model/quick_review';
import system from '../model/system';

const logger = new Logger('quick-review');

export { studentFeedbackVisible };

export const QUICK_JOB_STALE_MS = 10 * 60 * 1000;
/** Questions at or above this accuracy are "fine" and never become items. */
export const FINE_ACCURACY = 80;
const SNIPPET_LINES = 40;
const MAX_ITEMS = 10;
const MASTERY_STAGGER_MS = 1500;
const SYSTEM_REBUILD_MIN_MS = 2 * 60 * 1000;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface QuickOption {
    letter: string;
    text: string;
    count: number;
    /** share of the students who ANSWERED, 0..100 */
    share: number;
    correct: boolean;
}

export interface QuickQuestion {
    id: string; // `${pid}:${key}` — the item id the diagnosis refers to
    pid: number;
    label: string; // task label, e.g. "O12"
    key: string; // question number within the task
    kind: 'select' | 'multiselect' | 'input';
    prompt: string;
    options: QuickOption[];
    answer: string[];
    participants: number;
    answered: number;
    correct: number;
    /** correct / answered, 0..100 */
    accuracy: number;
    /** (participants - answered) / participants, 0..100 */
    blankRate: number;
    /** the wrong answer most students gave; share = of the wrong answers, 0..100 */
    dominantWrong: { answer: string, count: number, share: number } | null;
    /** two options each chosen by ≥ 35 % of the class */
    polarised: boolean;
    /** top wrong answers (fill-ins normalised), for the table */
    wrong: { answer: string, count: number }[];
    /** fill-ins: wrong answers within one edit of the key (typos), 0..100 of the wrong ones */
    nearMissRate: number | null;
    /** multi-select: correct options most often left out (rate = of the answered, 0..100) */
    missed: { letter: string, rate: number }[];
    /** multi-select: wrong options most often added */
    added: { letter: string, rate: number }[];
    /** multi-select: answers that were a proper subset of the key (half credit) */
    partialRate: number | null;
    points: string[];
    /** where the points came from: teacher | inferred | task */
    pointSource: 'teacher' | 'inferred' | 'task';
    priority: number;
}

export interface QuickTask {
    id: string; // `${pid}`
    pid: number;
    label: string;
    title: string;
    kind: 'programming';
    attempted: number;
    solved: number;
    participants: number;
    solvedRate: number;
    meanScore: number | null;
    /** verdict → count over all failing attempts */
    verdicts: Record<string, number>;
    /** verdict of the FIRST attempt → count */
    firstFail: Record<string, number>;
    /** students still unsolved, grouped by the verdict of their last failing attempt */
    clusters: { verdict: string, students: number, share: number }[];
    /**
     * finer failure signatures (verdict × first failing case × compiler
     * diagnostic): every unsolved student falls into exactly one; these are
     * what the map pass samples from
     */
    signatures: { key: string, verdict: string, failCase: string | null, compileSig: string | null, students: number, share: number }[];
    /** anonymised excerpts of last failing attempts, ≤ 2 per cluster (prompt only, not shown in presentation) */
    snippets: { verdict: string, lang: string, code: string }[];
    /**
     * conceptual error patterns from the map pass, extrapolated from the
     * labelled samples over their clusters (estimated students), weakest first
     */
    errorLabels?: QuickErrorLabel[];
    /** how much of the unsolved population the map pass sampled */
    mapCoverage?: { unsolved: number, withCode: number, sampled: number, calls: number };
    points: string[];
    priority: number;
}

export interface QuickErrorLabel {
    label: string;
    /** students estimated to share this error (cluster-weighted extrapolation of the samples) */
    estimated: number;
    /** samples that carried this label */
    sampled: number;
    /** share of the unsolved students, 0..100 */
    share: number;
    /** the decisive line/fact quoted by the labeller */
    note: string;
    /** one anonymised excerpt (prompt only; cleared before storage) */
    example: { lang: string, code: string } | null;
}

export interface QuickPoint {
    name: string;
    path: string;
    /** points earned / points available over the questions and tasks carrying it, 0..100 */
    mastery: number;
    questions: { id: string, label: string, key: string, accuracy: number }[];
    tasks: { id: string, label: string, solvedRate: number }[];
    /** share of students below 60 % on this point, 0..100 */
    studentsBelow: number;
    students: number;
}

export interface QuickItem {
    id: string;
    type: 'question' | 'task';
    label: string;
    priority: number;
}

export interface QuickDigest {
    resultsHash: string;
    kind: 'contest' | 'homework';
    participants: number;
    answered: number;
    scores: { mean: number | null, median: number | null, full: number };
    questions: QuickQuestion[];
    tasks: QuickTask[];
    points: QuickPoint[];
    items: QuickItem[];
    fine: { id: string, label: string, accuracy: number }[];
    /** whether snippets were included (prompt only) */
    hasSnippets: boolean;
}

export interface QuickReteach {
    /** 2-4 short bullets spoken to the class */
    points: string[];
    /** ONE minimal example, rendered as a code block on its own slide */
    code: { lang: string, text: string } | null;
    /** one memorable sentence */
    takeaway: string;
    /** legacy prose (reviews generated before the slide-ready format); empty otherwise */
    text: string;
}

export interface QuickDiagnosisItem {
    /** ≤ 8 words naming the error, used as the slide title */
    headline: string;
    misconception: string;
    reteach: QuickReteach;
    check: { prompt: string, options?: string[], answer: string, why?: string } | null;
    points: string[];
}

export interface QuickDiagnosis {
    summary: string[];
    items: Record<string, QuickDiagnosisItem>;
    model: string;
    generatedAt: Date;
}

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
};
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Full-width punctuation/digits → ASCII, collapse spaces, lower-case. */
export function normalizeAnswer(s: string): string {
    return String(s ?? '')
        .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/\u3000/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * Optimal-string-alignment (Damerau-Levenshtein) distance, so a swapped
 * pair of letters ("Wrold") is ONE typo; early exit above `max`.
 */
export function editDistance(a: string, b: string, max = 2): number {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const rows: number[][] = [];
    rows[0] = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        rows[i] = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let v = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2][j - 2] + 1);
            rows[i][j] = v;
            rowMin = Math.min(rowMin, v);
        }
        if (rowMin > max) return max + 1;
    }
    return rows[a.length][b.length];
}

const setOf = (xs: string[]) => new Set(xs.map((x) => normalizeAnswer(x)));
const sameSet = (a: string[], b: string[]) => {
    const A = setOf(a);
    const B = setOf(b);
    if (A.size !== B.size) return false;
    for (const x of A) if (!B.has(x)) return false;
    return true;
};

/** Correctness the way the digest counts it (fill-ins accept any listed alternative). */
export function isCorrectAnswer(kind: QuickQuestion['kind'], given: string[], answer: string[]): boolean {
    if (!answer.length || !given.length) return false;
    if (kind === 'input') {
        const g = normalizeAnswer(given.join(' '));
        return answer.some((a) => normalizeAnswer(a) === g);
    }
    return sameSet(given, answer);
}

/** Stable hash of the light statistics: changes when answers, verdicts or (override-adjusted) scores change. */
export function resultsHashOf(light: any): string {
    const h = createHash('sha1');
    h.update(String(light?.participants ?? 0));
    h.update(JSON.stringify(light?.scores ? { mean: light.scores.mean, median: light.scores.median, hist: light.scores.histogram } : null));
    for (const p of light?.problems || []) {
        h.update(`|${p.label}:${p.attempted}/${p.solved}/${p.meanScore}`);
        for (const q of p.questions || []) h.update(`|${q.key}:${q.answered}/${q.accuracy}`);
    }
    return h.digest('hex').slice(0, 16);
}

/** "RE" → "Runtime Error": the corpus abbreviates verdicts; the slides spell them out. */
const VERDICT_FULL: Record<string, string> = Object.fromEntries(
    Object.entries(STATUS_SHORT_TEXTS as Record<string, string>).map(([code, short]) => [short, (STATUS_TEXTS as Record<string, string>)[code] || short]),
);
export const fullVerdict = (v: string): string => VERDICT_FULL[v] || v;

const verdictOfAttempt = (s: string): string => {
    // "#3 WA(40)@+12m LATE" → "Wrong Answer"
    const m = /^#\d+\s+([^(@]+)/.exec(String(s || ''));
    return m ? fullVerdict(m[1].trim()) : 'Unknown';
};
const withFullVerdicts = (counts: Record<string, number> | undefined): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(counts || {})) out[fullVerdict(k)] = (out[fullVerdict(k)] || 0) + v;
    return out;
};

/* ------------------------------------------------------------------ */
/*  Failure clusters                                                   */
/* ------------------------------------------------------------------ */

export interface FailureMember {
    uid: number;
    verdict: string;
    failCase: string | null;
    compileSig: string | null;
    lang: string;
    code: string | null;
}

export const signatureKey = (m: { verdict: string, failCase: string | null, compileSig: string | null }) => `${m.verdict}|${m.failCase || ''}|${m.compileSig || ''}`;

/**
 * Every unsolved student of every programming task, with the failure
 * signature and (when loaded) the last failing code — pid → signature → members.
 * Deterministic and complete: this is where "every student is analysed"
 * happens, before any model call.
 */
export function failureMembersOf(corpus: any): Map<number, Map<string, FailureMember[]>> {
    const out = new Map<number, Map<string, FailureMember[]>>();
    const taskByLabel = new Map<string, any>(corpus.tasks.map((t: any) => [t.label, t]));
    for (const st of corpus.students || []) {
        for (const te of st.tasks || []) {
            const t = taskByLabel.get(te.label);
            if (!t || t.kind !== 'programming' || te.solved) continue;
            const m: FailureMember = {
                uid: st.uid,
                verdict: te.attempts?.length ? verdictOfAttempt(te.attempts[te.attempts.length - 1]) : 'No attempt',
                failCase: te.code?.failCase || null,
                compileSig: te.code?.compileSig || null,
                lang: te.lang || '',
                code: te.code && te.code.kind !== 'accepted' && te.code.text ? te.code.text : null,
            };
            if (!out.has(t.pid)) out.set(t.pid, new Map());
            const bySig = out.get(t.pid)!;
            const k = signatureKey(m);
            if (!bySig.has(k)) bySig.set(k, []);
            bySig.get(k)!.push(m);
        }
    }
    return out;
}

/* ------------------------------------------------------------------ */
/*  The digest                                                         */
/* ------------------------------------------------------------------ */

export interface DigestOptions {
    topK?: number;
    /** per-question knowledge points; returns null when unknown (task tags are used) */
    pointsOf?: (pid: number, key: string) => { points: string[], source: 'teacher' | 'inferred' } | null;
    includeSnippets?: boolean;
}

export function buildQuickDigest(corpus: any, opts: DigestOptions = {}): QuickDigest {
    const topK = Math.max(3, Math.min(MAX_ITEMS, opts.topK || 5));
    const participants: number = corpus.uids.length;
    const perTaskOf = new Map<number, any>(corpus.perTask.map((t: any) => [t.pid, t]));
    const taskByLabel = new Map<string, any>(corpus.tasks.map((t: any) => [t.label, t]));
    const fullScore: number = corpus.light?.scores?.full || 100;

    // per-student given answers, from the full corpus (students[].tasks[].answers)
    const givenOf = new Map<string, Map<number, string[]>>(); // `${pid}:${key}` → uid → given
    const solvedOf = new Map<number, Map<number, { solved: boolean, lastVerdict: string | null, lang: string, code: string | null }>>();
    for (const st of corpus.students || []) {
        for (const te of st.tasks || []) {
            const t = taskByLabel.get(te.label);
            if (!t) continue;
            if (t.kind === 'objective') {
                for (const a of te.answers || []) {
                    const k = `${t.pid}:${a.key}`;
                    if (!givenOf.has(k)) givenOf.set(k, new Map());
                    if (a.given?.length) givenOf.get(k)!.set(st.uid, a.given);
                }
            } else if (t.kind === 'programming') {
                if (!solvedOf.has(t.pid)) solvedOf.set(t.pid, new Map());
                const last = te.attempts?.length ? verdictOfAttempt(te.attempts[te.attempts.length - 1]) : null;
                solvedOf.get(t.pid)!.set(st.uid, {
                    solved: !!te.solved, lastVerdict: te.solved ? null : last, lang: te.lang || '', code: te.code && te.code.kind !== 'accepted' ? te.code.text : null,
                });
            }
        }
    }

    /* ---- objective questions ---- */
    const questions: QuickQuestion[] = [];
    for (const t of corpus.tasks) {
        if (t.kind !== 'objective') continue;
        const pt = perTaskOf.get(t.pid);
        const nQ = t.questions.length || 1;
        const weightShare = (t.weight || 100) / nQ / fullScore;
        for (const q of t.questions) {
            const given = givenOf.get(`${t.pid}:${q.key}`) || new Map<number, string[]>();
            const answered = given.size;
            let correct = 0;
            const dist = new Map<string, number>();
            const optionCount = new Map<string, number>();
            const missedCount = new Map<string, number>();
            const addedCount = new Map<string, number>();
            let partial = 0;
            let nearMiss = 0;
            let wrongCount = 0;
            const keySet = setOf(q.answer);
            for (const g of given.values()) {
                const ok = isCorrectAnswer(q.kind, g, q.answer);
                if (ok) correct += 1;
                else wrongCount += 1;
                if (q.kind === 'input') {
                    const shown = normalizeAnswer(g.join(' '));
                    if (!ok) {
                        dist.set(shown, (dist.get(shown) || 0) + 1);
                        if (q.answer.some((a) => editDistance(normalizeAnswer(a), shown, 1) <= 1)) nearMiss += 1;
                    }
                } else {
                    const letters = g.map((x) => normalizeAnswer(x).toUpperCase());
                    for (const l of letters) optionCount.set(l, (optionCount.get(l) || 0) + 1);
                    const shown = [...letters].sort().join(',');
                    if (!ok) dist.set(shown, (dist.get(shown) || 0) + 1);
                    if (q.kind === 'multiselect') {
                        const gs = new Set(letters.map((l) => l.toLowerCase()));
                        for (const k of keySet) if (!gs.has(k)) missedCount.set(k.toUpperCase(), (missedCount.get(k.toUpperCase()) || 0) + 1);
                        for (const l of gs) if (!keySet.has(l)) addedCount.set(l.toUpperCase(), (addedCount.get(l.toUpperCase()) || 0) + 1);
                        if (!ok && gs.size && [...gs].every((l) => keySet.has(l))) partial += 1;
                    }
                }
            }
            const wrongSorted = [...dist.entries()].sort((a, b) => b[1] - a[1]);
            const dominant = wrongSorted[0] ? { answer: wrongSorted[0][0], count: wrongSorted[0][1], share: pct(wrongSorted[0][1], wrongCount) } : null;
            const options: QuickOption[] = (q.options || []).map((o: any) => ({
                letter: o.letter, text: cut(String(o.text || ''), 160), count: optionCount.get(String(o.letter).toUpperCase()) || 0,
                share: pct(optionCount.get(String(o.letter).toUpperCase()) || 0, answered), correct: keySet.has(normalizeAnswer(o.letter)),
            }));
            const polarised = options.filter((o) => o.share >= 35).length >= 2;
            const accuracy = pct(correct, answered);
            const affected = participants - correct;
            const concentration = dominant ? dominant.share / 100 : 0.5;
            const priority = answered && accuracy < FINE_ACCURACY
                ? (1 - accuracy / 100) * weightShare * Math.log2(2 + affected) * (0.5 + 0.5 * concentration) * 1000
                : 0;
            const pts = opts.pointsOf?.(t.pid, q.key) || null;
            questions.push({
                id: `${t.pid}:${q.key}`,
                pid: t.pid,
                label: t.label,
                key: q.key,
                kind: q.kind,
                prompt: cut(String(q.prompt || ''), 400),
                options,
                answer: q.answer,
                participants,
                answered,
                correct,
                accuracy,
                blankRate: pct(participants - answered, participants),
                dominantWrong: dominant,
                polarised,
                wrong: wrongSorted.slice(0, 4).map(([answer, count]) => ({ answer, count })),
                nearMissRate: q.kind === 'input' && wrongCount ? pct(nearMiss, wrongCount) : null,
                missed: [...missedCount.entries()].map(([letter, c]) => ({ letter, rate: pct(c, answered) })).sort((a, b) => b.rate - a.rate).slice(0, 3),
                added: [...addedCount.entries()].map(([letter, c]) => ({ letter, rate: pct(c, answered) })).sort((a, b) => b.rate - a.rate).slice(0, 3),
                partialRate: q.kind === 'multiselect' && answered ? pct(partial, answered) : null,
                points: pts?.points?.length ? pts.points : (t.points || []),
                pointSource: pts?.points?.length ? pts.source : 'task',
                priority: Math.round(priority * 100) / 100,
            });
            void pt;
        }
    }

    /* ---- programming tasks ---- */
    const tasks: QuickTask[] = [];
    const failureMembers = failureMembersOf(corpus);
    for (const t of corpus.tasks) {
        if (t.kind !== 'programming') continue;
        const pt = perTaskOf.get(t.pid);
        if (!pt) continue;
        const rows = solvedOf.get(t.pid) || new Map();
        const clusterCount = new Map<string, number>();
        let unsolved = 0;
        for (const r of rows.values()) {
            if (r.solved) continue;
            unsolved += 1;
            const v = r.lastVerdict || 'No attempt';
            clusterCount.set(v, (clusterCount.get(v) || 0) + 1);
        }
        const clusters = [...clusterCount.entries()].map(([verdict, students]) => ({ verdict, students, share: pct(students, participants) }))
            .sort((a, b) => b.students - a.students).slice(0, 5);
        const bySig = failureMembers.get(t.pid) || new Map<string, FailureMember[]>();
        const signatures = [...bySig.entries()].map(([key, members]) => ({
            key, verdict: members[0].verdict, failCase: members[0].failCase, compileSig: members[0].compileSig, students: members.length, share: pct(members.length, participants),
        })).sort((a, b) => b.students - a.students).slice(0, 12);
        const snippets: QuickTask['snippets'] = [];
        if (opts.includeSnippets !== false) {
            for (const c of clusters.slice(0, 3)) {
                let n = 0;
                for (const r of rows.values()) {
                    if (r.solved || r.lastVerdict !== c.verdict || !r.code) continue;
                    snippets.push({ verdict: c.verdict, lang: r.lang, code: r.code.split('\n').slice(0, SNIPPET_LINES).join('\n') });
                    if (++n >= 2) break;
                }
            }
        }
        const weightShare = (t.weight || 100) / fullScore;
        const solvedRate = pct(pt.solved, participants);
        const affected = participants - pt.solved;
        const top = clusters[0];
        const concentration = top && affected ? top.students / affected : 0.5;
        const priority = solvedRate < FINE_ACCURACY && participants
            ? (1 - solvedRate / 100) * weightShare * Math.log2(2 + affected) * (0.5 + 0.5 * concentration) * 1000
            : 0;
        tasks.push({
            id: String(t.pid),
            pid: t.pid,
            label: t.label,
            title: t.title,
            kind: 'programming',
            attempted: pt.attempted,
            solved: pt.solved,
            participants,
            solvedRate,
            meanScore: pt.meanScore ?? null,
            verdicts: withFullVerdicts(pt.verdicts),
            firstFail: withFullVerdicts(pt.firstFail),
            clusters,
            signatures,
            snippets,
            points: t.points || [],
            priority: Math.round(priority * 100) / 100,
        });
        void unsolved;
    }

    /* ---- knowledge points ---- */
    const pathOf = new Map<string, string>();
    for (const t of corpus.tasks) (t.points || []).forEach((n: string, i: number) => pathOf.set(n.toLowerCase(), t.pointPaths?.[i] || n));
    interface Acc { name: string, earned: number, avail: number, questions: QuickPoint['questions'], tasks: QuickPoint['tasks'], perStudent: Map<number, { e: number, a: number }> }
    const acc = new Map<string, Acc>();
    const accOf = (name: string): Acc => {
        const k = name.toLowerCase();
        if (!acc.has(k)) acc.set(k, { name, earned: 0, avail: 0, questions: [], tasks: [], perStudent: new Map() });
        return acc.get(k)!;
    };
    for (const q of questions) {
        const given = givenOf.get(`${q.pid}:${q.key}`) || new Map<number, string[]>();
        for (const name of q.points) {
            const a = accOf(name);
            a.avail += participants;
            a.earned += q.correct;
            a.questions.push({ id: q.id, label: q.label, key: q.key, accuracy: q.accuracy });
            for (const uid of corpus.uids as number[]) {
                const g = given.get(uid);
                const ok = !!g && isCorrectAnswer(q.kind, g, q.answer);
                const s = a.perStudent.get(uid) || { e: 0, a: 0 };
                s.a += 1;
                if (ok) s.e += 1;
                a.perStudent.set(uid, s);
            }
        }
    }
    for (const t of tasks) {
        const rows = solvedOf.get(t.pid) || new Map();
        for (const name of t.points) {
            const a = accOf(name);
            a.avail += participants;
            a.earned += t.solved;
            a.tasks.push({ id: t.id, label: t.label, solvedRate: t.solvedRate });
            for (const uid of corpus.uids as number[]) {
                const s = a.perStudent.get(uid) || { e: 0, a: 0 };
                s.a += 1;
                if (rows.get(uid)?.solved) s.e += 1;
                a.perStudent.set(uid, s);
            }
        }
    }
    const points: QuickPoint[] = [...acc.values()].map((a) => {
        const students = a.perStudent.size;
        const below = [...a.perStudent.values()].filter((s) => s.a && s.e / s.a < 0.6).length;
        return {
            name: a.name,
            path: pathOf.get(a.name.toLowerCase()) || a.name,
            mastery: pct(a.earned, a.avail),
            questions: a.questions,
            tasks: a.tasks,
            studentsBelow: pct(below, students),
            students,
        };
    }).sort((x, y) => x.mastery - y.mastery || y.studentsBelow - x.studentsBelow);

    /* ---- what to review first ---- */
    const candidates: QuickItem[] = [
        ...questions.filter((q) => q.priority > 0).map((q) => ({ id: q.id, type: 'question' as const, label: `${q.label} Q${q.key}`, priority: q.priority })),
        ...tasks.filter((t) => t.priority > 0).map((t) => ({ id: t.id, type: 'task' as const, label: t.label, priority: t.priority })),
    ].sort((a, b) => b.priority - a.priority);
    const items = candidates.slice(0, topK);
    const fine = [
        ...questions.filter((q) => q.answered && q.accuracy >= FINE_ACCURACY).map((q) => ({ id: q.id, label: `${q.label} Q${q.key}`, accuracy: q.accuracy })),
        ...tasks.filter((t) => t.solvedRate >= FINE_ACCURACY).map((t) => ({ id: t.id, label: t.label, accuracy: t.solvedRate })),
    ];
    const scoresAll = (corpus.students || []).map((s: any) => s.score).filter((x: any) => typeof x === 'number') as number[];
    return {
        resultsHash: resultsHashOf(corpus.light),
        kind: corpus.kind,
        participants,
        answered: (corpus.students || []).filter((s: any) => (s.tasks || []).some((t: any) => (t.attempts?.length || 0) > 0 || (t.answers || []).some((a: any) => a.given?.length))).length,
        scores: { mean: mean(scoresAll), median: median(scoresAll), full: fullScore },
        questions,
        tasks,
        points,
        items,
        fine,
        hasSnippets: tasks.some((t) => t.snippets.length > 0),
    };
}

/** The per-student rows stored beside the digest (only ever returned to that student or staff). */
export function perStudentOf(corpus: any, digest: QuickDigest): QuickReviewPerStudent {
    const out: QuickReviewPerStudent = {};
    const qOf = new Map(digest.questions.map((q) => [q.id, q]));
    const taskByLabel = new Map<string, any>(corpus.tasks.map((t: any) => [t.label, t]));
    for (const st of corpus.students || []) {
        const missed: { pid: number, key: string, given: string }[] = [];
        const failed: string[] = [];
        for (const te of st.tasks || []) {
            const t = taskByLabel.get(te.label);
            if (!t) continue;
            if (t.kind === 'objective') {
                for (const a of te.answers || []) {
                    const q = qOf.get(`${t.pid}:${a.key}`);
                    if (!q) continue;
                    const ok = a.given?.length ? isCorrectAnswer(q.kind, a.given, q.answer) : false;
                    if (!ok) missed.push({ pid: t.pid, key: a.key, given: (a.given || []).join(',') });
                }
                // questions the student never answered at all (no sheet) count as missed too
                if (!(te.answers || []).length) for (const q of t.questions || []) missed.push({ pid: t.pid, key: q.key, given: '' });
            } else if (t.kind === 'programming' && !te.solved) failed.push(t.label);
        }
        out[String(st.uid)] = { score: typeof st.score === 'number' ? st.score : null, missed, failed };
    }
    return out;
}
export type QuickReviewPerStudent = Record<string, { score: number | null, missed: { pid: number, key: string, given: string }[], failed: string[] }>;

/* ------------------------------------------------------------------ */
/*  Map pass: label samples of every failure cluster                   */
/* ------------------------------------------------------------------ */

export interface MapOptions {
    /** excerpts per call */
    batch: number;
    /** calls allowed for the whole test */
    maxCalls: number;
    /** code lines per excerpt */
    lines: number;
    onProgress?: (done: number, total: number) => void;
    /** injectable for tests */
    label?: typeof aiTutor.runFailureLabeling;
    /** ai-speedup WP5: waiting for scheduler capacity (null once granted). */
    onWait?: (w: { ahead: number, eta: number } | null) => void;
}

interface Sample { pid: number, key: string, member: FailureMember }

/** Head + tail of the code, comments-only and blank lines dropped, ≤ `lines` lines. */
export function excerptOf(code: string, lines: number): string {
    const all = String(code || '').replace(/\r/g, '').split('\n').filter((l) => l.trim() && !/^\s*(?:\/\/|#\s|\*|\/\*)/.test(l));
    if (all.length <= lines) return all.join('\n');
    const tail = Math.min(15, Math.floor(lines / 4));
    return [...all.slice(0, lines - tail - 1), '// ... (lines omitted) ...', ...all.slice(-tail)].join('\n');
}

/** k members spread over the code-length range (short, medium, long solutions all get a voice). */
const spread = <T>(xs: T[], k: number): T[] => {
    if (k >= xs.length) return xs;
    if (k <= 0) return [];
    const out: T[] = [];
    for (let i = 0; i < k; i++) out.push(xs[Math.floor(((i + 0.5) * xs.length) / k)]);
    return out;
};

/**
 * Which excerpts to label: a global budget of `maxCalls × batch` excerpts,
 * split over the programming tasks in review order (tasks that are items
 * first), and within a task over its failure clusters in proportion to
 * their size — every cluster with code gets at least one sample, none
 * gets more than six. Tests see the same allocation the job uses.
 */
export function planFailureSamples(digest: QuickDigest, members: Map<number, Map<string, FailureMember[]>>, opts: { batch: number, maxCalls: number }): Sample[][] {
    const total = Math.max(0, opts.maxCalls) * Math.max(1, opts.batch);
    if (!total) return [];
    const itemPids = digest.items.filter((it) => it.type === 'task').map((it) => +it.id);
    const order = [...itemPids, ...digest.tasks.map((t) => t.pid).filter((pid) => !itemPids.includes(pid))]
        .filter((pid) => members.has(pid) && [...members.get(pid)!.values()].some((ms) => ms.some((m) => m.code)));
    if (!order.length) return [];
    const withCode = (pid: number) => [...members.get(pid)!.values()].reduce((n, ms) => n + ms.filter((m) => m.code).length, 0);
    const pool = order.map((pid) => ({ pid, n: withCode(pid) }));
    const sum = pool.reduce((a, b) => a + b.n, 0);
    // proportional, at least one batch for the first item task, never more than the code available
    let remaining = total;
    const budget = new Map<number, number>();
    for (const { pid, n } of pool) budget.set(pid, Math.min(n, Math.max(1, Math.round((n / sum) * total))));
    if (itemPids.length && pool[0] && budget.get(pool[0].pid)! < Math.min(opts.batch, pool[0].n)) budget.set(pool[0].pid, Math.min(opts.batch, pool[0].n));
    for (const { pid } of pool) {
        const b = Math.min(budget.get(pid)!, remaining);
        budget.set(pid, b);
        remaining -= b;
    }
    const batches: Sample[][] = [];
    for (const { pid } of pool) {
        const taskBudget = budget.get(pid)!;
        if (!taskBudget) continue;
        const clusters = [...members.get(pid)!.entries()].map(([key, ms]) => ({ key, ms: ms.filter((m) => m.code).sort((a, b) => a.code!.length - b.code!.length) }))
            .filter((c) => c.ms.length).sort((a, b) => b.ms.length - a.ms.length);
        const clusterTotal = clusters.reduce((a, c) => a + c.ms.length, 0);
        const alloc = clusters.map((c) => Math.min(6, c.ms.length, Math.max(1, Math.round((c.ms.length / clusterTotal) * taskBudget))));
        // trim to the task budget from the largest allocations down
        let over = alloc.reduce((a, b) => a + b, 0) - taskBudget;
        for (let i = 0; over > 0 && i < 1000; i++) {
            const j = alloc.indexOf(Math.max(...alloc));
            if (alloc[j] <= 1) break;
            alloc[j] -= 1;
            over -= 1;
        }
        const samples: Sample[] = [];
        clusters.forEach((c, i) => spread(c.ms, alloc[i]).forEach((member) => samples.push({ pid, key: c.key, member })));
        for (let i = 0; i < samples.length; i += opts.batch) batches.push(samples.slice(i, i + opts.batch));
    }
    return batches.slice(0, opts.maxCalls);
}

/**
 * Label the sampled excerpts (bounded calls, three at a time), then
 * extrapolate every label over the cluster its samples came from: a
 * cluster of 40 students with 3 samples labelled "off-by-one" and 1
 * "wrong condition" contributes ≈30 and ≈10. The result per task is an
 * estimated histogram over the WHOLE unsolved population.
 */
export async function labelFailureClusters(digest: QuickDigest, corpus: any, opts: MapOptions): Promise<void> {
    const members = failureMembersOf(corpus);
    const batches = planFailureSamples(digest, members, opts);
    const labelFn = opts.label || aiTutor.runFailureLabeling;
    const taskOf = new Map<number, any>(corpus.tasks.map((t: any) => [t.pid, t]));
    const results = new Map<number, Map<string, { member: FailureMember, label: string, note: string }[]>>(); // pid → key → labelled samples
    let done = 0;
    const calls = new Map<number, number>();
    /*
     * ai-speedup WP5: no worker pool here any more — every batch is
     * submitted to the scheduler, which runs at most `qr_label` (3) of them
     * at a time within the background lane. A refusal for lack of capacity
     * is reported through onWait and the batch resubmits itself.
     */
    let waiting = 0;
    const labelOne = async (batch: typeof batches[number]) => {
        const pid = batch[0].pid;
        const t = taskOf.get(pid);
        calls.set(pid, (calls.get(pid) || 0) + 1);
        try {
            const labels = await aiTutor.aiScheduler.runWhenCapacity({
                feature: 'qr_label', lane: 'background', priority: 2, label: `quick-review label ${t?.label || pid}`,
            }, () => labelFn({
                taskLabel: t?.label || String(pid),
                taskTitle: t?.title || '',
                statement: String(t?.statement || '').replace(/\s+/g, ' ').slice(0, 700),
                excerpts: batch.map((smp, i) => ({
                    n: i + 1, verdict: smp.member.verdict, failCase: smp.member.failCase, compileSig: smp.member.compileSig, lang: smp.member.lang, code: excerptOf(smp.member.code!, opts.lines),
                })),
            }), {
                onWait: (e) => {
                    waiting += 1;
                    opts.onWait?.({ ahead: e.position, eta: e.eta });
                },
            });
            if (waiting) {
                waiting = 0;
                opts.onWait?.(null);
            }
            batch.forEach((smp, i) => {
                const l = labels[i + 1];
                if (!l) return;
                if (!results.has(pid)) results.set(pid, new Map());
                const byKey = results.get(pid)!;
                if (!byKey.has(smp.key)) byKey.set(smp.key, []);
                byKey.get(smp.key)!.push({ member: smp.member, label: l.label, note: l.note });
            });
        } catch (e) {
            logger.warn('[quick-review] labelling batch failed for %s: %s', t?.label || pid, e.message);
        }
        done += 1;
        opts.onProgress?.(done, batches.length);
    };
    await Promise.all(batches.map((b) => labelOne(b)));

    for (const task of digest.tasks) {
        const bySig = members.get(task.pid);
        const labelled = results.get(task.pid);
        const unsolved = bySig ? [...bySig.values()].reduce((n, ms) => n + ms.length, 0) : 0;
        const withCode = bySig ? [...bySig.values()].reduce((n, ms) => n + ms.filter((m) => m.code).length, 0) : 0;
        let sampled = 0;
        const est = new Map<string, { estimated: number, sampled: number, note: string, example: QuickErrorLabel['example'] }>();
        if (labelled && bySig) {
            for (const [key, rows] of labelled) {
                const clusterSize = bySig.get(key)?.length || rows.length;
                sampled += rows.length;
                const counts = new Map<string, number>();
                for (const r of rows) counts.set(r.label, (counts.get(r.label) || 0) + 1);
                for (const [label, c] of counts) {
                    const e = est.get(label) || { estimated: 0, sampled: 0, note: '', example: null };
                    e.estimated += (c / rows.length) * clusterSize;
                    e.sampled += c;
                    const first = rows.find((r) => r.label === label)!;
                    if (!e.note && first.note) e.note = first.note;
                    if (!e.example && first.member.code) e.example = { lang: first.member.lang, code: excerptOf(first.member.code, 25) };
                    est.set(label, e);
                }
            }
        }
        task.mapCoverage = { unsolved, withCode, sampled, calls: calls.get(task.pid) || 0 };
        task.errorLabels = [...est.entries()].map(([label, e]) => ({
            label, estimated: Math.max(1, Math.round(e.estimated)), sampled: e.sampled, share: pct(Math.round(e.estimated), unsolved), note: e.note, example: e.example,
        })).sort((a, b) => b.estimated - a.estimated).slice(0, 8);
    }
}

/* ------------------------------------------------------------------ */
/*  The prompt digest and the diagnosis                                */
/* ------------------------------------------------------------------ */

const LANG_NAMES: [RegExp, string][] = [[/^(cc|cpp|c\+\+)/i, 'C++'], [/^c(\.|$)/i, 'C'], [/^py/i, 'Python'], [/^java(?!s)/i, 'Java'], [/^js|^node/i, 'JavaScript'], [/^rs|^rust/i, 'Rust'], [/^go/i, 'Go']];
const langNameOf = (code: string): string | null => {
    for (const [re, name] of LANG_NAMES) if (re.test(code)) return name;
    return null;
};

/** ~ tokens of a prompt (code-heavy text runs about 3 characters per token). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);

export interface RenderOptions {
    /** 0 = everything; higher levels condense (see renderDigestWithinBudget) */
    level?: number;
}

export function renderDigestForPrompt(digest: QuickDigest, opts: RenderOptions = {}): string {
    const level = opts.level || 0;
    const codeLines = level === 0 ? 40 : level === 1 ? 25 : 0;
    const promptChars = level >= 4 ? 200 : 400;
    const items = level >= 5 ? digest.items.slice(0, Math.max(3, Math.ceil(digest.items.length / 2))) : digest.items;
    const trimCode = (code: string) => code.split('\n').slice(0, codeLines).join('\n');
    const out: string[] = [];
    out.push(`Quiz: ${digest.participants} students, mean ${digest.scores.mean ?? '-'} / ${digest.scores.full}, median ${digest.scores.median ?? '-'}.`);
    const langs = [...new Set(digest.tasks.flatMap((t) => t.snippets.map((sn) => langNameOf(sn.lang || ''))).filter((x): x is string => !!x))];
    if (langs.length) out.push(`Language of the students' code: ${langs.join(', ')} — write code examples in it.`);
    out.push('');
    out.push('=== ITEMS TO REVIEW (priority order) ===');
    const qOf = new Map(digest.questions.map((q) => [q.id, q]));
    const tOf = new Map(digest.tasks.map((t) => [t.id, t]));
    for (const it of items) {
        if (it.type === 'question') {
            const q = qOf.get(it.id)!;
            out.push(`--- item "${q.id}" · ${q.label} Q${q.key} · ${q.kind === 'input' ? 'fill-in' : q.kind === 'multiselect' ? 'multiple choice (several correct)' : 'single choice'} ---`);
            out.push(`Question: ${cut(q.prompt, promptChars)}`);
            if (q.options.length) {
                for (const o of q.options) out.push(`  ${o.letter}. ${o.text} — chosen by ${o.share}%${o.correct ? ' [CORRECT]' : ''}`);
            }
            out.push(`Answer key: ${q.answer.join(', ')}`);
            out.push(`Accuracy: ${q.accuracy}% of ${q.answered} answered (${q.blankRate}% left it blank).`);
            if (q.dominantWrong) out.push(`Dominant wrong answer: "${q.dominantWrong.answer}" — ${q.dominantWrong.share}% of the wrong answers.`);
            if (q.kind === 'input' && q.wrong.length) out.push(`Most frequent wrong strings: ${q.wrong.map((w) => `"${w.answer}" ×${w.count}`).join(', ')}${q.nearMissRate ? ` (${q.nearMissRate}% of wrong answers are within one typo of the key)` : ''}`);
            if (q.kind === 'multiselect') {
                if (q.missed.length) out.push(`Correct options most often left out: ${q.missed.map((m) => `${m.letter} (${m.rate}%)`).join(', ')}`);
                if (q.added.length) out.push(`Wrong options most often added: ${q.added.map((m) => `${m.letter} (${m.rate}%)`).join(', ')}`);
            }
            out.push(`Knowledge points allowed for this item: ${q.points.join(' | ') || '(none)'}`);
        } else {
            const t = tOf.get(it.id)!;
            out.push(`--- item "${t.id}" · ${t.label} · programming task "${t.title}" ---`);
            out.push(`Solved by ${t.solvedRate}% (${t.solved}/${t.participants}); mean best score ${t.meanScore ?? '-'}.`);
            out.push(`Unsolved students by last verdict: ${t.clusters.map((c) => `${c.verdict} ${c.students}`).join(', ') || '(none)'}`);
            if (level < 4) out.push(`First-attempt verdicts: ${Object.entries(t.firstFail).map(([k, v]) => `${k} ${v}`).join(', ') || '(none)'}`);
            if (t.signatures.length > 1 && level < 4) out.push(`Failure signatures (verdict · first failing case · compiler diagnostic): ${t.signatures.slice(0, 6).map((sg) => `${sg.verdict}${sg.failCase ? ` case ${sg.failCase}` : ''}${sg.compileSig ? ` "${sg.compileSig}"` : ''}: ${sg.students}`).join('; ')}`);
            if (t.errorLabels?.length) {
                // the map pass: every unsolved student's code was clustered; samples of each cluster were labelled and extrapolated
                const cov = t.mapCoverage;
                out.push(`Error patterns across ALL ${cov?.unsolved ?? '?'} unsolved students (estimated from ${cov?.sampled ?? '?'} labelled excerpts covering every failure cluster):`);
                for (const l of t.errorLabels) out.push(`  - ${l.label}: ≈${l.estimated} students (${l.share}%)${l.note ? ` — ${l.note}` : ''}`);
                if (codeLines) {
                    const shown = level === 0 ? 3 : 1;
                    for (const l of t.errorLabels.slice(0, shown)) if (l.example) out.push(`Example of "${l.label}" (${l.example.lang}):\n\`\`\`\n${trimCode(l.example.code)}\n\`\`\``);
                }
            } else if (codeLines) {
                const per = level === 0 ? 4 : 2;
                for (const s of t.snippets.slice(0, per)) out.push(`Anonymised excerpt (${s.verdict}, ${s.lang}):\n\`\`\`\n${trimCode(s.code)}\n\`\`\``);
            }
            out.push(`Knowledge points allowed for this item: ${t.points.join(' | ') || '(none)'}`);
        }
        out.push('');
    }
    if (digest.points.length && level < 4) {
        out.push('=== KNOWLEDGE POINTS (weakest first) ===');
        for (const p of digest.points.slice(0, 8)) out.push(`${p.name}: mastery ${p.mastery}%, ${p.studentsBelow}% of students below 60% — from ${[...p.questions.map((q) => `${q.label} Q${q.key}`), ...p.tasks.map((t) => t.label)].join(', ')}`);
    }
    if (digest.fine.length && level < 4) out.push(`Fine (≥ ${FINE_ACCURACY}%): ${digest.fine.map((f) => `${f.label} ${f.accuracy}%`).join(', ')}`);
    return out.join('\n');
}

const FENCE_RE = /```([a-zA-Z0-9+#-]*)\n([\s\S]*?)```/;

/** First non-empty value among alias keys of a loosely shaped model object. */
const pick = (obj: any, keys: string[]): any => {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) {
        const v = obj[k];
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
};
const asText = (v: any): string => {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) return v.map(asText).filter((x) => x).join('\n');
    if (typeof v === 'object') return asText(pick(v, ['text', 'content', 'value', 'description', 'sentence']));
    return String(v).trim();
};
/** Bullets from an array of strings/objects, or from a string with line breaks / "- " markers. */
const asBullets = (v: any): string[] => {
    let list: string[] = [];
    if (Array.isArray(v)) list = v.map(asText);
    else if (typeof v === 'string') list = v.split(/\n+/).map((x) => x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''));
    else if (v && typeof v === 'object') list = asBullets(pick(v, ['bullets', 'points', 'items', 'lines', 'steps']));
    return list.map((x) => cut(String(x || '').trim(), 220)).filter((x) => x).slice(0, 4);
};
/** A code example from { lang, text } / { language, code } / a fenced or raw string. */
const asCode = (v: any): QuickReteach['code'] => {
    if (!v) return null;
    let lang = '';
    let text = '';
    if (typeof v === 'string') {
        const m = FENCE_RE.exec(v);
        lang = m ? m[1] : '';
        text = m ? m[2] : v;
    } else if (typeof v === 'object') {
        lang = asText(pick(v, ['lang', 'language'])) || '';
        const t = pick(v, ['text', 'code', 'source', 'snippet', 'content']);
        if (typeof t === 'string' && FENCE_RE.test(t)) {
            const m = FENCE_RE.exec(t)!;
            lang = lang || m[1];
            text = m[2];
        } else text = asText(t);
    }
    text = String(text || '').replace(/\r/g, '').replace(/^\n+|\n+$/g, '');
    if (!text.trim()) return null;
    return { lang: cut(lang.trim(), 20), text: text.split('\n').slice(0, 16).join('\n').slice(0, 1500) };
};

/**
 * The re-teach block, from the slide-ready object (with tolerant key names
 * and shapes — models rename and flatten things) or from legacy prose (a
 * fenced block inside the prose becomes the code example so it still
 * renders as a block on the slides).
 */
export function normalizeReteach(raw: any): QuickReteach {
    if (Array.isArray(raw)) return { points: asBullets(raw), code: null, takeaway: '', text: '' };
    if (raw && typeof raw === 'object') {
        const points = asBullets(pick(raw, ['bullets', 'points', 'steps', 'lines', 'key_points', 'keyPoints', 'explanation', 'explain']));
        const code = asCode(pick(raw, ['code', 'example', 'snippet', 'code_example', 'codeExample']));
        const takeaway = cut(asText(pick(raw, ['takeaway', 'take_away', 'remember', 'summary', 'key', 'one_liner', 'lesson'])), 220);
        // a prose body next to (or instead of) the bullets
        const body = points.length ? '' : cut(asText(pick(raw, ['text', 'script', 'content', 'body'])), 2000);
        const bodyCode = !code && body ? asCode(body) : null;
        return { points, code: code || bodyCode, takeaway, text: body.replace(FENCE_RE, '').replace(/\n{3,}/g, '\n\n').trim() };
    }
    const text = String(raw || '').trim();
    const code = asCode(text);
    const bullets = /^\s*(?:[-*•]|\d+[.)])\s/m.test(text.replace(FENCE_RE, '')) ? asBullets(text.replace(FENCE_RE, '')) : [];
    return {
        points: bullets, code: text.includes('```') ? code : null, takeaway: '', text: bullets.length ? '' : cut(text.replace(FENCE_RE, '').replace(/\n{3,}/g, '\n\n').trim(), 2000),
    };
}

const asCheck = (raw: any): QuickDiagnosisItem['check'] => {
    const c = Array.isArray(raw) ? raw[0] : raw;
    if (!c || typeof c !== 'object') return null;
    const prompt = asText(pick(c, ['prompt', 'question', 'text']));
    if (!prompt) return null;
    const optionsRaw = pick(c, ['options', 'choices']);
    const options = Array.isArray(optionsRaw) ? optionsRaw.map(asText).filter((o) => o).slice(0, 6).map((o) => cut(o, 200)) : [];
    return {
        prompt: cut(prompt, 700),
        ...(options.length ? { options } : {}),
        answer: cut(asText(pick(c, ['answer', 'key', 'correct'])), 200),
        ...(asText(pick(c, ['why', 'explanation', 'rationale'])) ? { why: cut(asText(pick(c, ['why', 'explanation', 'rationale'])), 300) } : {}),
    };
};

/** Validate and trim the model's JSON; unknown items and knowledge points are dropped. */
/**
 * Condense the digest until it fits `budgetTokens`: (1) shorter code,
 * (2) one example per pattern instead of per cluster, (3) no code at
 * all — labels and notes only, (4) shorter questions and no side
 * sections, (5) fewer items. The exact statistics always survive; what
 * shrinks is the illustrative material.
 */
export function renderDigestWithinBudget(digest: QuickDigest, budgetTokens: number): { text: string, level: number } {
    for (let level = 0; level <= 5; level++) {
        const text = renderDigestForPrompt(digest, { level });
        if (estimateTokens(text) <= budgetTokens || level === 5) return { text, level };
    }
    return { text: renderDigestForPrompt(digest, { level: 5 }), level: 5 };
}

/**
 * Strip ONLY an outer ```json … ``` wrapper around the reply. A global
 * replace would also eat the fences of code examples INSIDE the JSON
 * strings (a "```cpp" becomes the word "cpp"), which is what blanked the
 * re-teach and check slides.
 */
export function unwrapJsonFence(raw: string): string {
    let t = String(raw || '').trim();
    const open = /^```[a-zA-Z0-9_-]*\s*/.exec(t);
    if (open) t = t.slice(open[0].length);
    if (/```\s*$/.test(t)) t = t.replace(/```\s*$/, '');
    return t.trim();
}

export function parseDiagnosis(raw: string, digest: QuickDigest, model: string): QuickDiagnosis {
    const cleaned = unwrapJsonFence(raw);
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('The model did not return a JSON object.');
    const parsed: any = JSON.parse(cleaned.slice(start, end + 1));
    const allowedPoints = new Map<string, Map<string, string>>();
    for (const q of digest.questions) allowedPoints.set(q.id, new Map(q.points.map((p) => [p.toLowerCase(), p])));
    for (const t of digest.tasks) allowedPoints.set(t.id, new Map(t.points.map((p) => [p.toLowerCase(), p])));
    const items: Record<string, QuickDiagnosisItem> = {};
    const src = parsed.items && typeof parsed.items === 'object' ? parsed.items : {};
    // items may be keyed by id or label, or come as an array with an "id" field
    const byKey: Record<string, any> = {};
    if (Array.isArray(src)) {
        for (const x of src) {
            if (x && typeof x === 'object') byKey[String(pick(x, ['id', 'item', 'item_id', 'label']) ?? '')] = x;
        }
    } else Object.assign(byKey, src);
    for (const it of digest.items) {
        const raw2 = byKey[it.id] || byKey[it.label] || byKey[it.id.replace(':', ' Q')] || null;
        if (!raw2 || typeof raw2 !== 'object') continue;
        const allowed = allowedPoints.get(it.id) || new Map();
        const reteach = normalizeReteach(pick(raw2, ['reteach', 'reteaching', 're_teach', 'lesson', 'fix', 'explanation', 'explain']));
        const item: QuickDiagnosisItem = {
            headline: cut(asText(pick(raw2, ['headline', 'title', 'name'])), 120),
            misconception: cut(asText(pick(raw2, ['misconception', 'why', 'cause', 'diagnosis', 'error', 'problem'])), 600),
            reteach,
            check: asCheck(pick(raw2, ['check', 'checks', 'question', 'quiz'])),
            points: [...new Set((Array.isArray(raw2.points) ? raw2.points : []).map((p: any) => allowed.get(String(p || '').trim().toLowerCase())).filter((p: any) => p))] as string[],
        };
        if (!item.misconception || (!item.reteach.points.length && !item.reteach.text)) {
            logger.warn('[quick-review] item %s: incomplete diagnosis (keys: %s; reteach: %s)', it.id, Object.keys(raw2).join(','), JSON.stringify(raw2.reteach ?? null).slice(0, 200));
        }
        items[it.id] = item;
    }
    if (!Object.keys(items).length) throw new Error('The model returned no usable items.');
    const summary = (Array.isArray(parsed.summary) ? parsed.summary : typeof parsed.summary === 'string' ? [parsed.summary] : [])
        .map((s: any) => cut(String(s || '').trim(), 300)).filter((s: string) => s).slice(0, 3);
    return { summary, items, model, generatedAt: new Date() };
}

/* ------------------------------------------------------------------ */
/*  Student feedback                                                   */
/* ------------------------------------------------------------------ */

export interface StudentWeakPoint {
    name: string;
    path: string;
    missed: number;
    total: number;
    mastered: boolean;
    questions: { pid: number, label: string, key: string, prompt: string, given: string, answer: string[], misconception: string | null, classAccuracy: number }[];
    tasks: string[];
    practise: { pid: number, label: string, title: string, url?: string }[];
}

/**
 * What ONE student sees: their missed questions grouped by knowledge point,
 * the class misconception when their answer was the dominant wrong one,
 * and up to three practice tasks per weak point (tasks carrying the point,
 * outside the test, not yet solved by the student).
 */
export async function studentWeakPoints(
    domainId: string, tdoc: any, uid: number, quick: { digest: QuickDigest, diagnosis: QuickDiagnosis | null, mine: QuickReviewPerStudent[string] | null },
): Promise<{ points: StudentWeakPoint[], missedCount: number, questionCount: number, failedTasks: string[] } | null> {
    if (!quick?.digest) return null;
    const mine = quick.mine;
    const digest = quick.digest;
    const qOf = new Map(digest.questions.map((q) => [q.id, q]));
    if (!mine) return { points: [], missedCount: 0, questionCount: digest.questions.length, failedTasks: [] };
    const byPoint = new Map<string, StudentWeakPoint>();
    const pathOf = new Map(digest.points.map((p) => [p.name.toLowerCase(), p.path]));
    const ensure = (name: string) => {
        const k = name.toLowerCase();
        if (!byPoint.has(k)) {
            byPoint.set(k, {
                name, path: pathOf.get(k) || name, missed: 0, total: 0, mastered: true, questions: [], tasks: [], practise: [],
            });
        }
        return byPoint.get(k)!;
    };
    // totals: every question / task of the test carrying the point
    for (const q of digest.questions) for (const name of q.points) ensure(name).total += 1;
    for (const t of digest.tasks) for (const name of t.points) ensure(name).total += 1;
    const missedIds = new Set(mine.missed.map((m) => `${m.pid}:${m.key}`));
    for (const m of mine.missed) {
        const q = qOf.get(`${m.pid}:${m.key}`);
        if (!q) continue;
        const dominant = q.dominantWrong && m.given && normalizeAnswer(m.given.split(',').sort().join(',')) === normalizeAnswer(q.dominantWrong.answer);
        const diag = quick.diagnosis?.items?.[q.id] || null;
        for (const name of q.points) {
            const p = ensure(name);
            p.missed += 1;
            p.questions.push({
                pid: q.pid, label: q.label, key: q.key, prompt: q.prompt, given: m.given, answer: q.answer, misconception: dominant && diag ? diag.misconception : null, classAccuracy: q.accuracy,
            });
        }
    }
    for (const label of mine.failed) {
        const t = digest.tasks.find((x) => x.label === label);
        if (!t) continue;
        for (const name of t.points) {
            const p = ensure(name);
            p.missed += 1;
            p.tasks.push(t.label);
        }
    }
    const points = [...byPoint.values()].filter((p) => p.missed > 0).map((p) => ({ ...p, mastered: p.total > 0 && p.missed / p.total < 0.4 }))
        .sort((a, b) => (b.missed / Math.max(1, b.total)) - (a.missed / Math.max(1, a.total)) || b.missed - a.missed);
    // practice tasks: carrying the point, visible, outside the test, unsolved by the student
    const testPids = new Set<number>((tdoc.pids || []).filter((x: any) => typeof x === 'number'));
    for (const p of points.slice(0, 6)) {
        const names = [p.name];
        const doc = await KnowledgeModel.getByName(domainId, p.name).catch(() => null);
        if (doc?.aliases?.length) names.push(...doc.aliases);
        const cand: any[] = await problem.getMulti(domainId, { tag: { $in: names }, hidden: { $ne: true } } as any, ['docId', 'pid', 'title', 'difficulty'] as any)
            .sort({ difficulty: 1, docId: 1 }).limit(12).toArray().catch(() => []);
        const pids = cand.map((c) => c.docId).filter((d) => !testPids.has(d));
        const status = pids.length ? await problem.getListStatus(domainId, uid, pids).catch(() => ({})) : {};
        p.practise = cand.filter((c) => !testPids.has(c.docId) && (status as any)[c.docId]?.status !== 1).slice(0, 3)
            .map((c) => ({ pid: c.docId, label: String(c.pid || c.docId), title: c.title }));
    }
    return { points, missedCount: missedIds.size, questionCount: digest.questions.length, failedTasks: mine.failed };
}

/* ------------------------------------------------------------------ */
/*  Generation                                                         */
/* ------------------------------------------------------------------ */

export interface GenerateOptions {
    by: number | 'system';
    /** homework: table only, never the diagnosis */
    diagnose?: boolean;
    prewarm?: boolean;
}

/**
 * Explain reports are per (student, task): queue one for every student who
 * missed a question of a top item's task, bounded by
 * ai_tutor.quick_review_prewarm_max, three at a time, lowest priority.
 */
async function prewarmExplain(domainId: string, tdoc: any, digest: QuickDigest, perStudent: QuickReviewPerStudent): Promise<void> {
    const tid = String(tdoc.docId);
    const max = Math.max(0, +system.get('ai_tutor.quick_review_prewarm_max') || 150);
    if (!max) return;
    const topPids = new Set<number>();
    for (const it of digest.items) if (it.type === 'question') topPids.add(+it.id.split(':')[0]);
    const pairs: { uid: number, pid: number }[] = [];
    for (const [uidStr, row] of Object.entries(perStudent)) {
        const pids = new Set(row.missed.map((m) => m.pid));
        for (const pid of pids) if (topPids.has(pid)) pairs.push({ uid: +uidStr, pid });
    }
    const queue = pairs.slice(0, max);
    if (!queue.length) return;
    let done = 0;
    await setQuickPrewarm(domainId, tid, { queued: queue.length, done });
    // ai-speedup WP5: bulk work — priority 3, so it only ever uses idle
    // capacity (aging keeps it moving); the scheduler's `explain` cap bounds
    // the provider calls, the small local limit only bounds the DB reads
    // each job does before its call.
    await mapLimit(queue, 6, async (job) => {
        await runObjectiveFeedbackJob(domainId, tdoc, job.uid, job.pid, { priority: 3 }).catch(() => { /* the job wrote its own failure */ });
        done += 1;
        if (done % 5 === 0 || done === queue.length) await setQuickPrewarm(domainId, tid, { queued: queue.length, done }).catch(() => { /* cosmetic */ });
    });
}

/**
 * Build (or rebuild) the Quick Review of one activity. Detached from the
 * request that triggered it: progress goes to `quick.job`, the result to
 * the class-report document. One job per activity at a time.
 */
export async function generateQuickReview(domainId: string, tdoc: any, kind: 'contest' | 'homework', opts: GenerateOptions): Promise<void> {
    const tid = String(tdoc.docId);
    const startedAt = new Date();
    const existing = await getQuick(domainId, tid);
    if (existing?.job && existing.job.status === 'running' && !quickJobStale(existing.job, QUICK_JOB_STALE_MS)) return;
    // Two end-of-test paths (the schedule task and a page fallback) can
    // evaluate the same end within seconds: the system does not rebuild a
    // review it generated moments ago. A teacher's click always rebuilds;
    // a changed scoreboard is caught by the GET's stale check anyway.
    if (opts.by === 'system' && existing?.generatedAt && Date.now() - new Date(existing.generatedAt).getTime() < SYSTEM_REBUILD_MIN_MS) return;
    let lastProgress: { done: number, total: number } | undefined;
    let currentStage: any = 'collect';
    const progress = (stage: any, prog?: { done: number, total: number }, waiting: { ahead: number, eta: number } | null = null) => {
        currentStage = stage;
        if (prog) lastProgress = prog;
        return setQuickJob(domainId, tid, {
            status: 'running', stage, startedAt, updatedAt: new Date(), by: opts.by, ...(lastProgress ? { progress: lastProgress } : {}), waiting,
        });
    };
    /** The scheduler had no capacity for the current call: the theatre shows "waiting for capacity · N ahead · ~T s". */
    const onWait = (w: { ahead: number, eta: number } | null) => { progress(currentStage, undefined, w).catch(() => { /* cosmetic */ }); };
    try {
        await progress('collect');
        const corpus = await buildActivityCorpus(domainId, tdoc, kind, false);
        if (!corpus.uids.length) throw new Error('Nobody has taken part yet — nothing to review.');

        /* ---- knowledge points per question ---- */
        await progress('points');
        const objectivePids = corpus.tasks.filter((t: any) => t.kind === 'objective').map((t: any) => t.pid);
        const stored = await getQuestionPoints(domainId, objectivePids);
        const tutorOk = aiTutor.tutorConfigured() && aiTutor.tutorEnabled();
        if (tutorOk && system.get('ai_tutor.quick_review_infer_points') !== false) {
            const catalog = await KnowledgeModel.getMulti(domainId).limit(400).toArray().catch(() => []);
            const names = catalog.map((c: any) => c.name).filter((n: string) => n);
            for (const t of corpus.tasks) {
                if (t.kind !== 'objective' || t.questions.length < 2 || !names.length) continue;
                const missing = t.questions.filter((q: any) => !stored.has(questionPointKey(t.pid, q.key)));
                if (!missing.length) continue;
                try {
                    const inferred = await aiTutor.aiScheduler.runWhenCapacity({
                        feature: 'qr_points', lane: 'background', priority: 2, label: `quick-review points ${t.label}`,
                    }, () => aiTutor.inferQuestionPoints({
                        taskLabel: t.label,
                        taskTags: t.points,
                        catalogNames: names,
                        questions: missing.map((q: any) => ({ key: q.key, prompt: q.prompt, options: (q.options || []).map((o: any) => `${o.letter}. ${o.text}`), answer: q.answer })),
                    }), { onWait: (e) => onWait({ ahead: e.position, eta: e.eta }) });
                    onWait(null);
                    for (const q of missing) {
                        const pts = inferred[q.key] || [];
                        if (!pts.length) continue;
                        await setQuestionPoints(domainId, t.pid, q.key, pts, 'inferred');
                        stored.set(questionPointKey(t.pid, q.key), { _id: '', domainId, pid: t.pid, key: q.key, points: pts, source: 'inferred', updatedAt: new Date() });
                    }
                } catch (e) {
                    logger.warn('[quick-review] point inference skipped for %s: %s', t.label, e.message);
                }
            }
        }

        /* ---- the digest ---- */
        await progress('digest');
        const topK = Math.max(3, Math.min(MAX_ITEMS, +system.get('ai_tutor.quick_review_top') || 5));
        const digest = buildQuickDigest(corpus, {
            topK,
            pointsOf: (pid, key) => {
                const d = stored.get(questionPointKey(pid, key));
                return d ? { points: d.points, source: d.source } : null;
            },
        });
        const perStudent = perStudentOf(corpus, digest);

        /* ---- the diagnosis ---- */
        let diagnosis: QuickDiagnosis | null = null;
        let diagnosisNote = '';
        let diagnosisRaw = '';
        const wantDiagnosis = opts.diagnose !== false && kind === 'contest';
        if (!wantDiagnosis) diagnosisNote = kind === 'homework' ? 'homework' : 'skipped';
        else if (!tutorOk) diagnosisNote = 'The AI tutor is not configured; showing the statistics only.';
        else if (!digest.items.length) diagnosisNote = 'Nothing to re-teach: every question is above the fine threshold.';
        else {
            /*
             * MAP: every unsolved submission is already clustered by failure
             * signature; the model labels a few samples of EACH cluster in
             * small batches (bounded by settings) and the labels are
             * extrapolated over the clusters. A 200-student class costs a
             * handful of ~4K-token calls, never one giant prompt.
             */
            const rawMax = system.get('ai_tutor.quick_review_map_max_calls');
            const maxCalls = Math.max(0, Math.min(40, rawMax === undefined || rawMax === null || rawMax === '' ? 10 : +rawMax || 0));
            if (maxCalls && digest.tasks.some((t) => t.signatures.length)) {
                await progress('map', { done: 0, total: 0 });
                await labelFailureClusters(digest, corpus, {
                    batch: Math.max(4, Math.min(12, +system.get('ai_tutor.quick_review_map_batch') || 8)),
                    maxCalls,
                    lines: Math.max(20, Math.min(120, +system.get('ai_tutor.quick_review_map_lines') || 60)),
                    onProgress: (done, total) => { progress('map', { done, total }).catch(() => { /* cosmetic */ }); },
                    onWait,
                }).catch((e) => logger.warn('[quick-review] map pass failed: %s', e.message));
            }
            /* REDUCE: one call on the condensed digest, within the token budget. */
            await progress('diagnose');
            const budget = Math.max(3000, +system.get('ai_tutor.quick_review_prompt_budget') || 12000);
            const rendered = renderDigestWithinBudget(digest, budget);
            if (rendered.level > 0) logger.info('[quick-review] %s: digest condensed to level %d (~%d tokens, budget %d)', tid, rendered.level, estimateTokens(rendered.text), budget);
            try {
                const raw = await aiTutor.aiScheduler.runWhenCapacity({
                    feature: 'qr_diagnose', lane: 'background', priority: 1, label: 'quick-review diagnosis', retry: { attempts: 2 },
                }, () => aiTutor.runQuickDiagnosis(rendered.text), { onWait: (e) => onWait({ ahead: e.position, eta: e.eta }) });
                onWait(null);
                diagnosisRaw = String(raw || '').slice(0, 40000);
                diagnosis = parseDiagnosis(raw, digest, aiTutor.sysStr('ai_tutor.quick_review_model').trim() || aiTutor.sysStr('ai_tutor.model'));
            } catch (e) {
                diagnosisNote = `The AI diagnosis failed (${String(e.message || e).slice(0, 160)}); showing the statistics only.`;
                logger.warn('[quick-review] diagnosis failed for %s: %s', tid, e.message);
            }
        }
        // code excerpts are for the prompts only — never stored or shown
        for (const t of digest.tasks) {
            t.snippets = [];
            for (const l of t.errorLabels || []) l.example = null;
        }

        const policy = aiTutor.sysStr('ai_tutor.quick_review_student_feedback', 'on_end') || 'on_end';
        await setQuick(domainId, tid, {
            generatedAt: new Date(),
            by: opts.by,
            digest,
            diagnosis,
            diagnosisNote,
            diagnosisRaw,
            perStudent,
            ...(policy === 'on_end' ? { released: true } : existing?.released === undefined ? { released: false } : {}),
        });

        /* ---- evidence for the knowledge map ---- */
        if (kind === 'contest') {
            await progress('evidence');
            const rows: any[] = [];
            const at = tdoc.endAt ? new Date(tdoc.endAt) : new Date();
            const qOf = new Map(digest.questions.map((q) => [q.id, q]));
            for (const [uidStr, row] of Object.entries(perStudent)) {
                const uid = +uidStr;
                const missedIds = new Set(row.missed.map((m) => `${m.pid}:${m.key}`));
                for (const q of digest.questions) {
                    if (!q.points.length) continue;
                    rows.push({ uid, pid: q.pid, key: q.key, label: `${q.label} Q${q.key}`, points: q.points, correct: !missedIds.has(q.id), at });
                }
            }
            void qOf;
            await replaceQuizEvidence(domainId, tid, rows).catch((e) => logger.warn('[quick-review] evidence write failed: %s', e.message));
            // Marking the maps dirty makes a student who opens theirs right
            // now get a fresh build; the background rebuilds are STAGGERED
            // (one every 1.5 s) rather than fired for the whole class at
            // once — each build runs aggregations over the student's records.
            const uids = Object.keys(perStudent).map((x) => +x);
            for (const uid of uids) await markDirty(domainId, uid).catch(() => { /* no map yet — nothing to invalidate */ });
            uids.forEach((uid, i) => {
                const t = setTimeout(() => scheduleMastery(domainId, uid), i * MASTERY_STAGGER_MS);
                if (typeof t.unref === 'function') t.unref();
            });
        }

        await setQuickJob(domainId, tid, { status: 'done', stage: 'done', startedAt, updatedAt: new Date(), by: opts.by });

        /* ---- pre-warm the students' Explain reports for the most-missed questions ---- */
        if (kind === 'contest' && opts.prewarm !== false && tutorOk && system.get('ai_tutor.quick_review_prewarm') !== false) {
            prewarmExplain(domainId, tdoc, digest, perStudent).catch((e) => logger.warn('[quick-review] prewarm failed: %s', e.message));
        }
    } catch (e) {
        logger.error('[quick-review] %s: %s', tid, e.stack || e.message);
        await setQuickJob(domainId, tid, {
            status: 'failed', stage: 'done', startedAt, updatedAt: new Date(), by: opts.by, error: String(e.message || e).slice(0, 300),
        });
    }
}

/** Fire-and-forget entry used by the schedule task and the handler. */
export function startQuickReview(domainId: string, tdoc: any, kind: 'contest' | 'homework', opts: GenerateOptions): void {
    generateQuickReview(domainId, tdoc, kind, opts).catch((e) => logger.error('[quick-review] %s', e.message));
}

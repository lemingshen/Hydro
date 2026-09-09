/* eslint-disable max-len */
/**
 * PTA fork — PROMPT SHAPE FOR PROVIDER CACHING (ai-speedup WP3) and the
 * concise variable part (WP4).
 *
 * A prompt is split in two:
 *   PREFIX   — blocks that are byte-identical for everyone working on the
 *              same task (rules + persona, the problem statement, the
 *              task's knowledge points, an answer key): the provider caches
 *              this part, so the second student on the same problem pays a
 *              fraction of the input cost and gets a faster first token.
 *   VARIABLE — the student's own material: the thread summary, the last
 *              turns, their code (or a diff of it), the question.
 *
 * The rules that make the prefix cacheable are mechanical and live here so
 * every feature obeys them without thinking: fixed section order, whitespace
 * normalised, no timestamps, no names or ids, lists sorted, and the persona
 * text taken from settings ONCE per settings version (memoised) so an edit
 * mid-lecture does not silently split the cache.
 *
 * Nothing here touches the database: statements arrive resolved, settings
 * arrive as values. lib/ai_tutor.ts is the only place that maps these
 * shapes onto the provider request (system blocks with `cache_control`,
 * `prompt_cache_key`).
 */
import { createHash } from 'crypto';
import { createTwoFilesPatch } from 'diff';

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface PromptBlock {
    text: string;
    /** Part of the cacheable prefix (identical across users of the same task). */
    stable: boolean;
    /** Put a provider cache breakpoint after this block (Anthropic). */
    cache?: boolean;
}

export interface BuiltPrompt {
    feature: string;
    /** Sent as the system prompt: stable blocks first, then (optionally) a per-thread summary block. */
    prefix: PromptBlock[];
    /** The conversation. */
    variable: ChatMessage[];
    /** `<domainId>:<feature>:<task>:<prefix hash>` — the provider's routing key for prefix caching. */
    cacheKey: string;
}

/* ------------------------------------------------------------------ */
/*  Normalisation                                                      */
/* ------------------------------------------------------------------ */

/** Whitespace discipline for prefix text: no \r, no trailing spaces, at most one blank line in a row. */
export function normalizePrefixText(text: string): string {
    return String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Sort + dedupe a list of labels (tags, knowledge points) so the order never depends on who saved last. */
export function stableList(items: (string | null | undefined)[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of items || []) {
        const v = String(raw ?? '').trim();
        const k = v.toLowerCase();
        if (!v || seen.has(k)) continue;
        seen.add(k);
        out.push(v);
    }
    return out.sort((a, b) => a.localeCompare(b, 'en'));
}

/** Rough token estimate (≈ 3.6 characters per token for mixed English / code / CJK). */
export function estimateTokens(text: string): number {
    return Math.ceil(String(text || '').length / 3.6);
}

export function prefixHash(prefix: PromptBlock[]): string {
    const h = createHash('sha1');
    for (const b of prefix) if (b.stable) h.update(b.text).update('\u0000');
    return h.digest('hex').slice(0, 10);
}

/** The whole prefix as one string (what OpenAI-style providers receive as the system message). */
export function prefixText(prefix: PromptBlock[]): string {
    return prefix.map((b) => b.text).join('\n\n');
}

/* ------------------------------------------------------------------ */
/*  Settings snapshot memo                                             */
/* ------------------------------------------------------------------ */

const memoStore = new Map<string, { version: string, value: any }>();

/**
 * Compute `fn()` once per `version` (e.g. the settings version or a hash of
 * the inputs) and reuse it — the persona / rules text must not be rebuilt
 * from live settings on every call, or a mid-lecture edit splits the cache
 * across two prefixes for every student.
 */
export function memoByVersion<T>(key: string, version: string, fn: () => T): T {
    const hit = memoStore.get(key);
    if (hit && hit.version === version) return hit.value;
    const value = fn();
    memoStore.set(key, { version, value });
    return value;
}

export function clearPromptMemo() {
    memoStore.clear();
}

/* ------------------------------------------------------------------ */
/*  Prefix builders                                                    */
/* ------------------------------------------------------------------ */

export interface TaskContext {
    domainId: string;
    /** The task's docId (or any stable id of the cached object). */
    pid: number | string;
    /** Display id + title, without any per-user decoration. */
    title: string;
    label?: string;
    statement: string;
    limits?: { time?: string | number, memory?: string | number };
    knowledgePoints?: string[];
    /** Extra stable material (answer key, harness note, reference excerpt). */
    extra?: string[];
}

/**
 * The stable task block shared by every feature that reads a task: title,
 * limits, statement, knowledge points, extras — in that order, always.
 */
export function taskBlock(task: TaskContext): string {
    const lines = [
        `Problem: ${task.label ? `${task.label} ` : ''}${task.title}`.trim(),
    ];
    if (task.limits && (task.limits.time || task.limits.memory)) {
        lines.push(`Limits: time ${task.limits.time || '?'}ms, memory ${task.limits.memory || '?'}MB`);
    }
    lines.push('--- Problem statement (may be truncated) ---', task.statement || '(statement unavailable — rely on the student to describe it)', '--- End of statement ---');
    const points = stableList(task.knowledgePoints || []);
    if (points.length) lines.push(`Knowledge points of this task: ${points.join('; ')}`);
    for (const x of task.extra || []) if (x && x.trim()) lines.push(normalizePrefixText(x));
    return normalizePrefixText(lines.join('\n'));
}

export interface BuildPromptInput {
    feature: string;
    /** Rules + persona text (already a settings snapshot). */
    rules: string;
    task?: TaskContext;
    /** Additional stable blocks after the task (e.g. a directive catalogue). */
    stableBlocks?: string[];
    /** Per-thread rolling summary (its own breakpoint; not shared across users). */
    summary?: string;
    variable: ChatMessage[];
}

/**
 * Assemble a prompt: [rules][task][stable...] as the cached prefix (breakpoint
 * after the last stable block), an optional summary block (second
 * breakpoint), then the variable messages.
 */
export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
    const prefix: PromptBlock[] = [];
    const rules = normalizePrefixText(input.rules);
    if (rules) prefix.push({ text: rules, stable: true });
    if (input.task) prefix.push({ text: taskBlock(input.task), stable: true });
    for (const b of input.stableBlocks || []) {
        const t = normalizePrefixText(b);
        if (t) prefix.push({ text: t, stable: true });
    }
    if (prefix.length) prefix[prefix.length - 1].cache = true;
    const summary = normalizePrefixText(input.summary || '');
    if (summary) prefix.push({ text: `=== EARLIER IN THIS TUTORING THREAD (summary) ===\n${summary}`, stable: false, cache: true });
    const hash = prefixHash(prefix);
    const scope = input.task ? `${input.task.domainId}:${input.feature}:${input.task.pid}` : `-:${input.feature}:-`;
    return {
        feature: input.feature,
        prefix,
        variable: input.variable.filter((m) => m && typeof m.content === 'string'),
        cacheKey: `${scope}:${hash}`,
    };
}

/* ------------------------------------------------------------------ */
/*  WP4 — thread summaries                                             */
/* ------------------------------------------------------------------ */

export const SUMMARY_MAX_WORDS = 120;

export const THREAD_SUMMARY_PROMPT = `You maintain the running memory of a Socratic programming tutor's conversation with ONE student about ONE task. From the previous summary (if any) and the new turns, write the UPDATED summary in EXACTLY five lines, each starting with its label:
goal: <what the student is trying to do on this task, one clause>
tried: <what they have tried / submitted so far, one clause>
blocker: <the flaw or misunderstanding currently in the way, one clause>
hints given: <what the tutor has already pointed at, one clause — never the fix itself>
next step: <what the tutor should aim for next, one clause>
Rules: at most ${SUMMARY_MAX_WORDS} words in total; English only; no names, no dates, no code longer than an identifier; keep facts from the previous summary that are still true, drop what is resolved. Reply with the five lines only.`;

export function wordCount(text: string): number {
    return String(text || '').trim().split(/\s+/).filter((w) => w).length;
}

/**
 * Enforce the word budget of a SUMMARY (never of a model reply): keep whole
 * lines while they fit, then cut the last kept line at a sentence boundary.
 */
export function limitSummary(text: string, maxWords = SUMMARY_MAX_WORDS): string {
    const clean = normalizePrefixText(text);
    if (wordCount(clean) <= maxWords) return clean;
    const lines = clean.split('\n');
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
        const n = wordCount(line);
        if (used + n <= maxWords) {
            kept.push(line);
            used += n;
            continue;
        }
        const room = maxWords - used;
        if (room > 3) {
            const words = line.trim().split(/\s+/).slice(0, room).join(' ');
            const cut = Math.max(words.lastIndexOf('. '), words.lastIndexOf('; '), words.lastIndexOf(', '));
            kept.push(cut > words.length / 2 ? `${words.slice(0, cut + 1).trim()}` : `${words}…`);
        }
        break;
    }
    return kept.join('\n');
}

/** Whether a thread should get a (new) summary now: every `every` student turns once the thread is long enough. */
export function summaryDue(studentTurns: number, messageCount: number, every = 4, minMessages = 6): boolean {
    if (messageCount < minMessages) return false;
    return studentTurns > 0 && studentTurns % Math.max(1, every) === 0;
}

/* ------------------------------------------------------------------ */
/*  WP4 — code deltas                                                  */
/* ------------------------------------------------------------------ */

export const DIFF_MIN_LINES = 60;
export const DIFF_MAX_CHANGED = 40;

export interface CodeDelta {
    mode: 'full' | 'diff';
    text: string;
    /** Changed lines (added + removed) when mode is 'diff'. */
    changed?: number;
}

export function codeHash(code: string): string {
    return createHash('sha1').update(String(code || '').replace(/\r\n?/g, '\n')).digest('hex').slice(0, 16);
}

/**
 * Decide how to send the student's code: the full file when there is
 * nothing to diff against, when the file is short (< 60 lines), or when
 * the change is large (> 40 changed lines); otherwise a unified diff (3
 * context lines) with a one-line note.
 */
export function codeDelta(prev: string | null | undefined, cur: string): CodeDelta {
    const now = String(cur ?? '').replace(/\r\n?/g, '\n');
    const before = prev == null ? null : String(prev).replace(/\r\n?/g, '\n');
    const lineCount = now.split('\n').length;
    if (before === null || before === now || lineCount < DIFF_MIN_LINES) return { mode: 'full', text: now };
    const patch = createTwoFilesPatch('previous', 'current', before, now, '', '', { context: 3 });
    // The header is "====…", "--- previous", "+++ current"; hunks follow.
    const lines = patch.split('\n');
    const start = lines.findIndex((l) => l.startsWith('@@'));
    if (start < 0) return { mode: 'full', text: now };
    const hunkLines = lines.slice(start);
    const changed = hunkLines.filter((l) => /^[+-]/.test(l)).length;
    if (changed > DIFF_MAX_CHANGED) return { mode: 'full', text: now };
    const diffText = ['--- previous', '+++ current', ...hunkLines].join('\n').trim();
    return {
        mode: 'diff',
        changed,
        text: `(changes since your last message — unified diff against the code you already know; unchanged parts omitted)\n${diffText}`,
    };
}

/* eslint-disable max-len */
/**
 * PTA fork — AI STREAMING (ai-speedup WP2).
 *
 * Three things live here, all free of database and settings dependencies:
 *
 *  1. THE STREAM REGISTRY (`aiStreams`): an in-memory table of AI jobs that
 *     a browser watches — each with the text produced so far, its state
 *     (queued / running / done / error), the queue position, a status
 *     stage, the final result and the error. Handlers create a stream, hand
 *     its id to the client, and run the work in the background; the client
 *     subscribes over the `/ai/stream` websocket (or polls
 *     `/ai/stream/:id?from=N`) and sees deltas as they arrive. Streams are
 *     owned by a uid and expire ten minutes after finishing. An interactive
 *     stream nobody is watching any more (no subscriber, no poll for a
 *     grace period) is ABORTED, which frees its scheduler slot.
 *
 *  2. PROVIDER SSE PARSING: a line-buffered `SseParser` and the decoders
 *     for the two dialects the site speaks — Anthropic events and the
 *     OpenAI-compatible `data:` chunks (OpenAI, DeepSeek, Ollama) — mapped
 *     to one neutral signal shape (text delta / thinking tick / tool call /
 *     usage / done / error). Tolerant to unknown events; fixtures in
 *     test/ai_stream.spec.ts.
 *
 *  3. `JsonFieldStreamer`: when the model is asked for a JSON object such as
 *     {"reply": "...", "resolved": false}, this extracts the value of ONE
 *     string field progressively from the raw stream, so the tutor's reply
 *     can be shown word by word even though the transport is JSON.
 */
import { AiCallMeta, aiScheduler, AiSlot } from './ai_scheduler';

/* ------------------------------------------------------------------ */
/*  1. Stream registry                                                 */
/* ------------------------------------------------------------------ */

export type AiStreamState = 'queued' | 'running' | 'done' | 'error';

export type AiStreamEvent =
    | { type: 'queue', position: number, eta: number }
    | { type: 'delta', text: string }
    | { type: 'status', stage: string }
    | { type: 'reset' }
    | { type: 'done', result: any }
    | { type: 'error', message: string, retryAfter?: number };

export interface AiStreamMeta {
    feature: string;
    lane: 'interactive' | 'background';
    /** Abort when abandoned by the browser (default: lane === 'interactive'). */
    abortWhenAbandoned?: boolean;
}

export interface AiStreamEntry {
    id: string;
    uid: number;
    meta: AiStreamMeta;
    state: AiStreamState;
    text: string;
    queue: { position: number, eta: number } | null;
    stage: string | null;
    result: any;
    error: { message: string, retryAfter?: number } | null;
    createdAt: number;
    finishedAt: number | null;
    /** Last time a browser was seen watching (subscribe, poll, or the request that created it). */
    lastSeen: number;
    subscribers: Set<(ev: AiStreamEvent) => void>;
    controller: AbortController;
}

export interface AiStreamRead {
    id: string;
    state: AiStreamState;
    /** Text from `from` on (the client appends it). */
    text: string;
    /** Total length so far — the client's next `from`. */
    length: number;
    queue: { position: number, eta: number } | null;
    stage: string | null;
    done: boolean;
    result: any;
    error: { message: string, retryAfter?: number } | null;
}

/** What a job body drives: the writer side of one stream. */
export interface AiStreamHandle {
    id: string;
    signal: AbortSignal;
    /** True while a browser is (still) watching. */
    readonly watched: boolean;
    delta(text: string): void;
    stage(stage: string): void;
    queue(s: { position: number, eta: number }): void;
    reset(): void;
}

export const STREAM_TTL_MS = 10 * 60 * 1000;
/** An interactive stream nobody watched for this long is abandoned. */
export const ABANDON_GRACE_MS = 45 * 1000;
const SWEEP_MS = 15 * 1000;

let counter = 0;
function newId(): string {
    counter = (counter + 1) % 1e6;
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}${counter.toString(36)}`;
}

export class AiStreamRegistry {
    private entries = new Map<string, AiStreamEntry>();
    private timer: any = null;

    constructor(private now: () => number = () => Date.now()) { }

    create(uid: number, meta: AiStreamMeta): AiStreamEntry {
        const now = this.now();
        const entry: AiStreamEntry = {
            id: newId(),
            uid,
            meta,
            state: 'queued',
            text: '',
            queue: null,
            stage: null,
            result: undefined,
            error: null,
            createdAt: now,
            finishedAt: null,
            lastSeen: now,
            subscribers: new Set(),
            controller: new AbortController(),
        };
        this.entries.set(entry.id, entry);
        this.ensureTimer();
        return entry;
    }

    get(id: string): AiStreamEntry | undefined {
        return this.entries.get(id);
    }

    /** The writer side for a job body. */
    handle(id: string): AiStreamHandle {
        const self = this;
        const entry = this.entries.get(id);
        if (!entry) throw new Error(`Unknown stream ${id}`);
        return {
            id,
            signal: entry.controller.signal,
            get watched() { return entry.subscribers.size > 0 || self.now() - entry.lastSeen < ABANDON_GRACE_MS; },
            delta: (text) => this.append(id, text),
            stage: (stage) => this.setStage(id, stage),
            queue: (s) => this.setQueue(id, s),
            reset: () => this.reset(id),
        };
    }

    private emit(entry: AiStreamEntry, ev: AiStreamEvent) {
        for (const fn of entry.subscribers) {
            try {
                fn(ev);
            } catch (e) { /* a broken subscriber never breaks the stream */ }
        }
    }

    append(id: string, text: string) {
        const e = this.entries.get(id);
        if (!e || e.state === 'done' || e.state === 'error' || !text) return;
        if (e.state === 'queued') e.state = 'running';
        e.queue = null;
        e.text += text;
        this.emit(e, { type: 'delta', text });
    }

    setQueue(id: string, s: { position: number, eta: number }) {
        const e = this.entries.get(id);
        if (!e || e.state !== 'queued') return;
        e.queue = { position: s.position, eta: s.eta };
        this.emit(e, { type: 'queue', position: s.position, eta: s.eta });
    }

    setStage(id: string, stage: string) {
        const e = this.entries.get(id);
        if (!e || e.state === 'done' || e.state === 'error') return;
        if (e.state === 'queued') e.state = 'running';
        e.queue = null;
        e.stage = stage;
        this.emit(e, { type: 'status', stage });
    }

    /** Running now (slot granted): clears the queue line. */
    started(id: string) {
        const e = this.entries.get(id);
        if (!e || e.state !== 'queued') return;
        e.state = 'running';
        e.queue = null;
        this.emit(e, { type: 'status', stage: e.stage || 'running' });
    }

    reset(id: string) {
        const e = this.entries.get(id);
        if (!e || e.state === 'done' || e.state === 'error') return;
        e.text = '';
        this.emit(e, { type: 'reset' });
    }

    finish(id: string, result: any) {
        const e = this.entries.get(id);
        if (!e || e.state === 'done' || e.state === 'error') return;
        e.state = 'done';
        e.result = result;
        e.queue = null;
        e.finishedAt = this.now();
        this.emit(e, { type: 'done', result });
        e.subscribers.clear();
    }

    fail(id: string, error: any) {
        const e = this.entries.get(id);
        if (!e || e.state === 'done' || e.state === 'error') return;
        e.state = 'error';
        e.queue = null;
        e.finishedAt = this.now();
        const message = String(error?.message || error || 'The AI request failed.').slice(0, 500);
        const retryAfter = Number.isFinite(+error?.retryAfter) ? +error.retryAfter : undefined;
        e.error = retryAfter ? { message, retryAfter } : { message };
        this.emit(e, { type: 'error', message, ...(retryAfter ? { retryAfter } : {}) });
        e.subscribers.clear();
    }

    /** A browser is watching: subscribe for live events (the caller replays the buffer first via read()). */
    subscribe(id: string, fn: (ev: AiStreamEvent) => void): () => void {
        const e = this.entries.get(id);
        if (!e) return () => { };
        e.lastSeen = this.now();
        e.subscribers.add(fn);
        return () => {
            e.subscribers.delete(fn);
            e.lastSeen = this.now();
        };
    }

    /** Polling fallback / replay: the buffer from `from`, plus the state. Counts as "watched". */
    read(id: string, from = 0): AiStreamRead | null {
        const e = this.entries.get(id);
        if (!e) return null;
        e.lastSeen = this.now();
        const start = Math.max(0, Math.min(from, e.text.length));
        return {
            id,
            state: e.state,
            text: e.text.slice(start),
            length: e.text.length,
            queue: e.queue,
            stage: e.stage,
            done: e.state === 'done' || e.state === 'error',
            result: e.state === 'done' ? e.result : undefined,
            error: e.error,
        };
    }

    /** Only the owner (or root, decided by the caller) may watch a stream. */
    ownedBy(id: string, uid: number): boolean {
        const e = this.entries.get(id);
        return !!e && e.uid === uid;
    }

    /** Housekeeping: expire finished streams, abort abandoned interactive ones. Returns what it did (for tests). */
    sweep(): { expired: number, aborted: number } {
        const now = this.now();
        let expired = 0;
        let aborted = 0;
        for (const [id, e] of [...this.entries]) {
            const finished = e.state === 'done' || e.state === 'error';
            if (finished && e.finishedAt !== null && now - e.finishedAt > STREAM_TTL_MS) {
                this.entries.delete(id);
                expired += 1;
                continue;
            }
            const abortable = e.meta.abortWhenAbandoned ?? (e.meta.lane === 'interactive');
            if (!finished && abortable && !e.subscribers.size && now - e.lastSeen > ABANDON_GRACE_MS && !e.controller.signal.aborted) {
                e.controller.abort();
                aborted += 1;
            }
            // Never leak: a stream stuck for an hour is dropped whatever its state.
            if (!finished && now - e.createdAt > 6 * STREAM_TTL_MS) {
                if (!e.controller.signal.aborted) e.controller.abort();
                this.fail(id, new Error('The AI request expired.'));
            }
        }
        if (!this.entries.size && this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        return { expired, aborted };
    }

    count(): number {
        return this.entries.size;
    }

    /** Tests / hot reload. */
    clear() {
        for (const e of this.entries.values()) if (!e.controller.signal.aborted) e.controller.abort();
        this.entries.clear();
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private ensureTimer() {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.sweep();
            if (this.entries.size) this.ensureTimer();
        }, SWEEP_MS);
        this.timer.unref?.();
    }
}

export const aiStreams = new AiStreamRegistry();

/* ------------------------------------------------------------------ */
/*  Stream jobs: a handler's one-liner                                 */
/* ------------------------------------------------------------------ */

export interface StreamJobOptions<T> {
    uid: number;
    meta: Omit<AiCallMeta, 'signal' | 'onQueue' | 'stream'>;
    /** The work; write deltas / stages through the handle, return the final result. */
    run: (stream: AiStreamHandle, slot: AiSlot) => Promise<T>;
    /** Only abort when the browser stops watching (default for interactive lanes). */
    abortWhenAbandoned?: boolean;
}

/**
 * Create a stream and run the work under the scheduler in the background.
 * Returns the stream id at once; an admission refusal (AiBusyError) is
 * thrown synchronously, before any stream exists, so the handler answers
 * 503 with a retry-after and the client counts down.
 */
export function startStreamJob<T>(opts: StreamJobOptions<T>): { id: string, promise: Promise<T> } {
    const entry = aiStreams.create(opts.uid, {
        feature: opts.meta.feature, lane: opts.meta.lane, abortWhenAbandoned: opts.abortWhenAbandoned,
    });
    const handle = aiStreams.handle(entry.id);
    let promise: Promise<T>;
    try {
        promise = aiScheduler.submit<T>({
            ...opts.meta,
            stream: true,
            signal: entry.controller.signal,
            onQueue: (s) => aiStreams.setQueue(entry.id, s),
        }, async (slot) => {
            aiStreams.started(entry.id);
            return await opts.run(handle, slot);
        });
    } catch (e) {
        aiStreams.fail(entry.id, e);
        throw e;
    }
    promise.then((result) => aiStreams.finish(entry.id, result), (e) => aiStreams.fail(entry.id, e));
    // The stream is what reports the outcome; an unobserved rejection here is by design.
    promise.catch(() => { });
    return { id: entry.id, promise };
}

/* ------------------------------------------------------------------ */
/*  2. Provider SSE parsing                                            */
/* ------------------------------------------------------------------ */

export interface SseEvent {
    event: string;
    data: string;
}

/** Line-buffered Server-Sent-Events parser (frames may split anywhere across reads). */
export class SseParser {
    private buffer = '';
    private event = '';
    private data: string[] = [];

    feed(chunk: string): SseEvent[] {
        this.buffer += chunk;
        const out: SseEvent[] = [];
        let idx: number;
        // eslint-disable-next-line no-cond-assign
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            let line = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            const ev = this.line(line);
            if (ev) out.push(ev);
        }
        return out;
    }

    /** Flush a trailing frame without a final blank line. */
    end(): SseEvent[] {
        const out: SseEvent[] = [];
        if (this.buffer) {
            const ev = this.line(this.buffer.replace(/\r$/, ''));
            this.buffer = '';
            if (ev) out.push(ev);
        }
        const last = this.dispatch();
        if (last) out.push(last);
        return out;
    }

    private line(line: string): SseEvent | null {
        if (line === '') return this.dispatch();
        if (line.startsWith(':')) return null;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') this.event = value;
        else if (field === 'data') this.data.push(value);
        return null;
    }

    private dispatch(): SseEvent | null {
        if (!this.data.length && !this.event) return null;
        const ev = { event: this.event || 'message', data: this.data.join('\n') };
        this.event = '';
        this.data = [];
        return ev;
    }
}

/** One neutral signal from either dialect. */
export type StreamSignal =
    | { kind: 'text', text: string }
    | { kind: 'thinking' }
    | { kind: 'tool_start', index: number, id: string, name: string }
    | { kind: 'tool_args', index: number, partial: string }
    | { kind: 'usage', usage: any }
    | { kind: 'stop', reason: string }
    | { kind: 'done' }
    | { kind: 'error', message: string };

function parseJson(data: string): any | null {
    try {
        return JSON.parse(data);
    } catch (e) {
        return null;
    }
}

/** Anthropic Messages API stream events → signals. Unknown events are ignored. */
export function decodeAnthropicEvent(ev: SseEvent): StreamSignal[] {
    if (ev.event === 'ping') return [];
    const j = parseJson(ev.data);
    if (!j) return [];
    const type = j.type || ev.event;
    switch (type) {
        case 'message_start':
            return j.message?.usage ? [{ kind: 'usage', usage: j.message.usage }] : [];
        case 'content_block_start':
            if (j.content_block?.type === 'tool_use') return [{ kind: 'tool_start', index: j.index ?? 0, id: String(j.content_block.id || ''), name: String(j.content_block.name || '') }];
            if (j.content_block?.type === 'text' && j.content_block.text) return [{ kind: 'text', text: String(j.content_block.text) }];
            return [];
        case 'content_block_delta': {
            const d = j.delta || {};
            if (d.type === 'text_delta' && typeof d.text === 'string') return d.text ? [{ kind: 'text', text: d.text }] : [];
            if (d.type === 'thinking_delta' || d.type === 'signature_delta') return [{ kind: 'thinking' }];
            if (d.type === 'input_json_delta') return [{ kind: 'tool_args', index: j.index ?? 0, partial: String(d.partial_json || '') }];
            return [];
        }
        case 'message_delta': {
            const out: StreamSignal[] = [];
            if (j.usage) out.push({ kind: 'usage', usage: j.usage });
            if (j.delta?.stop_reason) out.push({ kind: 'stop', reason: String(j.delta.stop_reason) });
            return out;
        }
        case 'message_stop':
            return [{ kind: 'done' }];
        case 'error':
            return [{ kind: 'error', message: String(j.error?.message || j.message || 'provider error') }];
        default:
            return [];
    }
}

/** OpenAI-compatible chat-completion chunks (OpenAI, DeepSeek, Ollama) → signals. */
export function decodeOpenAIEvent(ev: SseEvent): StreamSignal[] {
    const data = ev.data.trim();
    if (!data) return [];
    if (data === '[DONE]') return [{ kind: 'done' }];
    const j = parseJson(data);
    if (!j) return [];
    if (j.error) return [{ kind: 'error', message: String(j.error?.message || j.error) }];
    const out: StreamSignal[] = [];
    const choice = Array.isArray(j.choices) ? j.choices[0] : null;
    const delta = choice?.delta || {};
    if (typeof delta.content === 'string' && delta.content) out.push({ kind: 'text', text: delta.content });
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) out.push({ kind: 'thinking' });
    if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
            const index = Number.isFinite(+tc.index) ? +tc.index : 0;
            if (tc.id || tc.function?.name) out.push({ kind: 'tool_start', index, id: String(tc.id || ''), name: String(tc.function?.name || '') });
            if (typeof tc.function?.arguments === 'string' && tc.function.arguments) out.push({ kind: 'tool_args', index, partial: tc.function.arguments });
        }
    }
    if (choice?.finish_reason) out.push({ kind: 'stop', reason: String(choice.finish_reason) });
    if (j.usage) out.push({ kind: 'usage', usage: j.usage });
    return out;
}

/* ------------------------------------------------------------------ */
/*  3. Progressive extraction of one JSON string field                 */
/* ------------------------------------------------------------------ */

/**
 * Feed the raw model output as it streams; the value of `"<field>": "..."`
 * is emitted through `onDelta` as soon as its characters are available,
 * escapes decoded (\n, \", \\, \uXXXX — a partial escape waits for the
 * rest). Works whether the object is bare or wrapped in a ```json fence,
 * and wherever the field sits in the object. Only the FIRST occurrence of
 * the field is streamed.
 */
export class JsonFieldStreamer {
    private raw = '';
    private scanFrom = 0;
    private phase: 'seek' | 'value' | 'done' = 'seek';
    private pending = ''; // unterminated escape sequence carried over
    value = '';

    constructor(private field: string, private onDelta: (text: string) => void) { }

    feed(chunk: string) {
        if (!chunk || this.phase === 'done') return;
        this.raw += chunk;
        if (this.phase === 'seek') {
            const re = new RegExp(`"${this.field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*"`, 'g');
            re.lastIndex = 0;
            const m = re.exec(this.raw);
            if (!m) {
                // Keep the tail so a key split across chunks is still found.
                this.scanFrom = Math.max(0, this.raw.length - this.field.length - 8);
                return;
            }
            this.phase = 'value';
            this.scanFrom = m.index + m[0].length;
        }
        this.drain();
    }

    private drain() {
        let text = this.pending + this.raw.slice(this.scanFrom);
        this.pending = '';
        let out = '';
        let i = 0;
        while (i < text.length) {
            const ch = text[i];
            if (ch === '"') {
                this.phase = 'done';
                break;
            }
            if (ch === '\\') {
                const next = text[i + 1];
                if (next === undefined) {
                    this.pending = text.slice(i);
                    i = text.length;
                    break;
                }
                if (next === 'u') {
                    const hex = text.slice(i + 2, i + 6);
                    if (hex.length < 4) {
                        this.pending = text.slice(i);
                        i = text.length;
                        break;
                    }
                    const code = Number.parseInt(hex, 16);
                    out += Number.isFinite(code) ? String.fromCharCode(code) : '';
                    i += 6;
                    continue;
                }
                const map: Record<string, string> = {
                    n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/',
                };
                out += map[next] ?? next;
                i += 2;
                continue;
            }
            out += ch;
            i += 1;
        }
        this.scanFrom = this.raw.length;
        text = '';
        if (out) {
            this.value += out;
            this.onDelta(out);
        }
    }
}

/**
 * Stream the text between a start marker and an end marker of a plain-text
 * reply — e.g. the `REPLY: …` line of the AI Studio's statement chat, which
 * ends at the line break or at the `TITLE:` / body markers. Characters that
 * could be the beginning of an end marker are held back until they are
 * known not to be; `end()` flushes what is left when the reply is complete.
 */
export class TextSpanStreamer {
    private raw = '';
    private from = 0;
    private phase: 'seek' | 'value' | 'done' = 'seek';
    value = '';

    constructor(private start: RegExp, private end: RegExp, private onDelta: (text: string) => void, private holdBack = 8) { }

    feed(chunk: string) {
        if (!chunk || this.phase === 'done') return;
        this.raw += chunk;
        if (this.phase === 'seek') {
            const m = this.start.exec(this.raw);
            if (!m) return;
            this.phase = 'value';
            this.from = m.index + m[0].length;
        }
        this.drain(false);
    }

    /** The reply is complete: emit the held-back tail (before any end marker). */
    finish() {
        if (this.phase === 'value') this.drain(true);
        this.phase = 'done';
    }

    private drain(final: boolean) {
        const tail = this.raw.slice(this.from);
        const e = this.end.exec(tail);
        let emit: string;
        if (e) {
            emit = tail.slice(0, e.index);
            this.phase = 'done';
        } else {
            emit = final ? tail : tail.slice(0, Math.max(0, tail.length - this.holdBack));
        }
        if (!emit) return;
        this.value += emit;
        this.from += emit.length;
        this.onDelta(emit);
    }
}

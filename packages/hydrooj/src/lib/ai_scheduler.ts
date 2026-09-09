/* eslint-disable max-len */
/**
 * PTA fork — THE AI SCHEDULER (ai-speedup WP1).
 *
 * Every call to the AI provider in this process goes through one of these:
 * `aiScheduler.run(meta, fn)` grants `fn` a SLOT and runs it, or queues it,
 * or refuses it with an `AiBusyError` the caller can turn into a countdown.
 * With hundreds of students in one lecture this is what keeps the provider
 * from seeing a 429 storm (never more than `slots` calls in flight), keeps
 * the tutor responsive while class reports grind in the background (two
 * LANES, an interactive reserve), and keeps one eager student from starving
 * the rest (per-user round-robin, one call in flight per user).
 *
 * Shape (see the plan): slots ── lanes (interactive / background) ── classes
 * 0..3 ── per-class a round-robin ring of per-user FIFOs. Dispatch walks
 * interactive first, then background; class 0 first; within a class the
 * next user in rotation whose head entry passes the per-user and
 * per-feature caps. Aging promotes entries that waited too long. Admission
 * control refuses when the queue is full or the ETA exceeds the maximum
 * wait. Transient provider errors RELEASE the slot, back off (honouring a
 * process-wide 429 cool-down) and re-enqueue at the same class. A single
 * `key` de-duplicates identical work (single-flight).
 *
 * The module has NO dependency on the database or the settings service:
 * time, timers, configuration and the transient-error test are injected,
 * so `test/ai_scheduler.spec.ts` drives it with a fake clock. The wiring to
 * the site's settings lives in lib/ai_tutor.ts (`installSchedulerConfig`).
 */
import { AsyncLocalStorage } from 'async_hooks';
import { UserFacingError } from '@hydrooj/framework/error';
import { AiMetrics, aiMetrics, AiOutcome, AiUsage, formatCallLine } from './ai_metrics';

export type AiLane = 'interactive' | 'background';
export type AiPriority = 0 | 1 | 2 | 3;

export interface AiCallMeta {
    /** 'tutor' | 'annotate' | 'assistant' | 'suggest' | 'explain' | 'qr_label' | 'qr_diagnose' | 'report_map' | 'report_reduce' | 'grade' | 'attrib' | 'summary' | 'author' | ... */
    feature: string;
    lane: AiLane;
    /** Default: interactive 0, background 2; bulk work passes 3. */
    priority?: AiPriority;
    /** Fairness key (0 / absent = system: no per-user cap). */
    uid?: number;
    /** Single-flight key: a second run() with the same key awaits the first. */
    key?: string;
    /** The slot is held until the stream ends (informational; the slot is held until fn settles either way). */
    stream?: boolean;
    /** Caller gone → dequeue (queued) or abort the provider call (running). */
    signal?: AbortSignal;
    /** Queue position / ETA updates while waiting (also fired once at enqueue). */
    onQueue?: (s: { position: number, eta: number }) => void;
    /** Retry policy for transient provider errors; false = never retry. */
    retry?: boolean | { attempts?: number, baseMs?: number };
    /** For the log line only. */
    label?: string;
}

export interface AiSlot {
    id: number;
    feature: string;
    lane: AiLane;
    /** Aborts when the caller's signal aborts, or the scheduler withdraws the slot. */
    signal: AbortSignal;
    /** True once the call produced visible output — such a call is never retried. */
    readonly emitted: boolean;
    /** Call when the first streamed token arrives (marks emitted + records TTFT). */
    markEmitted(): void;
    /** Attach the provider's usage report to this call's metrics. */
    setUsage(u: AiUsage | null): void;
    startedAt: number;
}

export type SlotFn<T> = (slot: AiSlot) => Promise<T>;

export interface SchedulerConfig {
    enabled: boolean;
    /** The base (and minimum) number of calls in flight. */
    slots: number;
    /**
     * ADAPTIVE CONCURRENCY: grow the limit above `slots` (up to `slotsMax`)
     * while the provider shows no pressure — additive increase after a run
     * of successful saturated completions, multiplicative decrease on a
     * 429, a step down on timeouts, and a hold while the first-token time
     * drifts above its baseline. Off (or slotsMax ≤ slots) = fixed limit.
     */
    adaptive: boolean;
    slotsMax: number;
    interactiveReserve: number;
    backgroundMax: number;
    userInflight: number;
    queueMax: number;
    maxWaitMs: number;
    ageMs: number;
    featureCaps: Record<string, number>;
    retryAttempts: number;
    retryBaseMs: number;
}

export const DEFAULT_FEATURE_CAPS = 'explain:3,qr_label:3,report_map:3,attrib:2,summary:2,grade:2,report_reduce:1,qr_points:1,author:2';

/** "explain:3,qr_label:3" → { explain: 3, qr_label: 3 } (bad pairs skipped). */
export function parseFeatureCaps(text: string | undefined | null): Record<string, number> {
    const out: Record<string, number> = {};
    for (const part of String(text || '').split(/[,\n;]/)) {
        const [k, v] = part.split(':').map((s) => s.trim());
        if (!k || !/^[\w-]+$/.test(k)) continue;
        const n = Math.floor(+v);
        if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return out;
}

export const DEFAULT_CONFIG: SchedulerConfig = {
    enabled: true,
    slots: 12,
    adaptive: true,
    slotsMax: 24,
    interactiveReserve: 6,
    backgroundMax: 4,
    userInflight: 1,
    queueMax: 200,
    maxWaitMs: 90000,
    ageMs: 30000,
    featureCaps: parseFeatureCaps(DEFAULT_FEATURE_CAPS),
    retryAttempts: 4,
    retryBaseMs: 4000,
};

/** Service-time seeds per feature (ms) until the EWMA has real samples. */
export const TAU_SEED: Record<string, number> = {
    tutor: 12000,
    annotate: 9000,
    assistant: 15000,
    suggest: 45000,
    explain: 30000,
    qr_label: 20000,
    qr_diagnose: 40000,
    qr_points: 15000,
    report_map: 60000,
    report_reduce: 90000,
    grade: 8000,
    attrib: 15000,
    summary: 6000,
    author: 30000,
    bonus: 30000,
    other: 15000,
};

/**
 * Refusal by admission control. A UserFacingError (HTTP 503) so a handler
 * that lets it escape produces a proper JSON error; the client reads
 * `params` = [ahead, etaSeconds, retryAfterSeconds] and counts down.
 */
export class AiBusyError extends UserFacingError {
    retryAfter: number;
    position: number;
    eta: number;

    constructor(position: number, eta: number, retryAfter: number) {
        super(position, Math.ceil(eta / 1000), retryAfter);
        this.name = 'AiBusyError';
        this.code = 503;
        this.position = position;
        this.eta = eta;
        this.retryAfter = retryAfter;
        this.msg = () => 'The AI is busy right now ({0} ahead, about {1} s to wait). Retrying automatically in {2} s.';
    }
}

/** Thrown (rejected) when a queued or running call was abandoned by its caller. */
export class AiAbortedError extends Error {
    name = 'AbortError';

    constructor(message = 'The AI call was cancelled.') {
        super(message);
    }
}

export interface SchedulerDeps {
    now?: () => number;
    setTimeout?: (fn: () => void, ms: number) => any;
    clearTimeout?: (t: any) => void;
    config?: () => Partial<SchedulerConfig>;
    isTransient?: (e: any) => boolean;
    isRateLimit?: (e: any) => boolean;
    metrics?: AiMetrics;
    log?: (line: string) => void;
    random?: () => number;
}

export interface SchedulerStatus {
    enabled: boolean;
    /** Configured base. */
    slots: number;
    /** The limit in force right now (adaptive), and its ceiling. */
    effectiveSlots: number;
    slotsMax: number;
    adaptive: boolean;
    interactiveReserve: number;
    backgroundMax: number;
    running: { total: number, interactive: number, background: number };
    queued: { interactive: number[], background: number[], total: number, users: number };
    cooldownMs: number;
    features: Record<string, { inflight: number, cap: number | null, queued: number, tau: number }>;
    singleFlight: number;
}

interface Entry<T = any> {
    id: number;
    meta: AiCallMeta;
    fn: SlotFn<T>;
    lane: AiLane;
    cls: number;
    uid: number;
    feature: string;
    /** When this (re-)enqueue happened. */
    enqueuedAt: number;
    /** Aging clock (reset on each promotion). */
    ageBase: number;
    /** When the call was first submitted (queue wait is measured from here). */
    firstEnqueuedAt: number;
    attempts: number;
    retryOf?: number;
    state: 'queued' | 'running' | 'settled';
    resolve: (v: T) => void;
    reject: (e: any) => void;
    slot?: SlotImpl;
    detachSignal?: () => void;
    lastNotify?: { position: number, eta: number };
}

class SlotImpl implements AiSlot {
    controller = new AbortController();
    emitted = false;
    ttftAt: number | null = null;
    usage: AiUsage | null = null;
    startedAt: number;

    constructor(public id: number, public feature: string, public lane: AiLane, private clock: () => number) {
        this.startedAt = clock();
    }

    get signal() { return this.controller.signal; }

    markEmitted() {
        if (!this.emitted) this.ttftAt = this.clock();
        this.emitted = true;
    }

    setUsage(u: AiUsage | null) {
        this.usage = u;
    }
}

const CLASSES = [0, 1, 2, 3];
const LANES: AiLane[] = ['interactive', 'background'];

const slotStorage = new AsyncLocalStorage<AiSlot>();

/** The slot the current async context runs in (undefined outside the scheduler). */
export function currentSlot(): AiSlot | undefined {
    return slotStorage.getStore();
}

const defaultIsTransient = (e: any) => {
    const msg = String(e?.message || e || '');
    if (/HTTP (?:408|409|425|429|5\d\d)\b/.test(msg)) return true;
    return /timed out|Cannot reach the AI provider|ECONNRESET|EAI_AGAIN|socket hang up|fetch failed|overloaded/i.test(msg);
};
const defaultIsRateLimit = (e: any) => /HTTP 429\b|rate.?limit/i.test(String(e?.message || e || ''));
const isAbortError = (e: any) => e?.name === 'AbortError' || e instanceof AiAbortedError;

export class AiScheduler {
    private nextId = 1;
    private queues: Record<AiLane, Map<number, Entry[]>[]> = {
        interactive: CLASSES.map(() => new Map()),
        background: CLASSES.map(() => new Map()),
    };

    private running = new Set<Entry>();
    private userInflight = new Map<number, number>();
    private featureInflight = new Map<string, number>();
    private singleFlight = new Map<string, Promise<any>>();
    private cooldownUntil = 0;
    /* adaptive concurrency (AIMD) */
    private effSlots = 0;
    private okStreak = 0;
    private lastPressureAt = 0;
    private ttftBase = 0;
    private ttftRecent = 0;
    private timer: any = null;
    private readonly now: () => number;
    private readonly setTimer: (fn: () => void, ms: number) => any;
    private readonly clearTimer: (t: any) => void;
    private readonly configFn: () => Partial<SchedulerConfig>;
    private readonly isTransient: (e: any) => boolean;
    private readonly isRateLimit: (e: any) => boolean;
    private readonly random: () => number;
    readonly metrics: AiMetrics;
    log: (line: string) => void;

    constructor(deps: SchedulerDeps = {}) {
        this.now = deps.now || (() => Date.now());
        this.setTimer = deps.setTimeout || ((fn, ms) => {
            const t = setTimeout(fn, ms);
            (t as any).unref?.();
            return t;
        });
        this.clearTimer = deps.clearTimeout || ((t) => clearTimeout(t));
        this.configFn = deps.config || (() => ({}));
        this.isTransient = deps.isTransient || defaultIsTransient;
        this.isRateLimit = deps.isRateLimit || defaultIsRateLimit;
        this.metrics = deps.metrics || aiMetrics;
        this.log = deps.log || (() => { });
        this.random = deps.random || Math.random;
    }

    /** Replace the configuration source (used by ai_tutor to bind the site settings). */
    configure(fn: () => Partial<SchedulerConfig>) {
        (this as any).configFn = fn;
    }

    get config(): SchedulerConfig {
        const c = this.configFn() || {};
        const num = (v: any, d: number, min = 0) => (Number.isFinite(+v) && +v >= min ? +v : d);
        return {
            enabled: c.enabled === undefined ? DEFAULT_CONFIG.enabled : !!c.enabled,
            slots: Math.max(1, Math.floor(num(c.slots, DEFAULT_CONFIG.slots, 1))),
            adaptive: c.adaptive === undefined ? DEFAULT_CONFIG.adaptive : !!c.adaptive,
            slotsMax: Math.max(1, Math.floor(num(c.slotsMax, DEFAULT_CONFIG.slotsMax, 1))),
            interactiveReserve: Math.floor(num(c.interactiveReserve, DEFAULT_CONFIG.interactiveReserve)),
            backgroundMax: Math.max(1, Math.floor(num(c.backgroundMax, DEFAULT_CONFIG.backgroundMax, 1))),
            userInflight: Math.max(1, Math.floor(num(c.userInflight, DEFAULT_CONFIG.userInflight, 1))),
            queueMax: Math.max(1, Math.floor(num(c.queueMax, DEFAULT_CONFIG.queueMax, 1))),
            maxWaitMs: Math.max(1000, num(c.maxWaitMs, DEFAULT_CONFIG.maxWaitMs, 1000)),
            ageMs: Math.max(1000, num(c.ageMs, DEFAULT_CONFIG.ageMs, 1000)),
            featureCaps: c.featureCaps || DEFAULT_CONFIG.featureCaps,
            retryAttempts: Math.max(1, Math.floor(num(c.retryAttempts, DEFAULT_CONFIG.retryAttempts, 1))),
            retryBaseMs: Math.max(100, num(c.retryBaseMs, DEFAULT_CONFIG.retryBaseMs, 100)),
        };
    }

    /* ------------------------------ public API ------------------------------ */

    /**
     * Run `fn` in a slot. Resolves with fn's result, rejects with fn's error
     * (after the retry policy), an AiAbortedError, or — synchronously at
     * admission — an AiBusyError. Inside a slot already (nested call), fn runs
     * at once in the current slot: a slot never waits for another slot.
     */
    run<T>(meta: AiCallMeta, fn: SlotFn<T>): Promise<T> {
        try {
            return this.submit(meta, fn);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    /**
     * Same as run(), except that an admission refusal is THROWN synchronously
     * (an AiBusyError) instead of rejecting the promise — for handlers that
     * must answer 503 before any stream is created.
     */
    submit<T>(meta: AiCallMeta, fn: SlotFn<T>): Promise<T> {
        const inner = currentSlot();
        if (inner) return fn(inner);
        return this.enqueue(meta, fn);
    }

    /** Like run(), but explicitly outside any slot the caller holds (for detached follow-up work). */
    runOutside<T>(meta: AiCallMeta, fn: SlotFn<T>): Promise<T> {
        return slotStorage.exit(() => this.run(meta, fn));
    }

    /**
     * Background job runners: an admission refusal is not an error but a
     * wait — sleep `retryAfter` and resubmit, reporting each wait.
     */
    async runWhenCapacity<T>(meta: AiCallMeta, fn: SlotFn<T>, opts: { onWait?: (e: AiBusyError) => void, maxWaits?: number } = {}): Promise<T> {
        const maxWaits = opts.maxWaits ?? 120;
        for (let i = 0; ; i++) {
            try {
                return await this.run(meta, fn);
            } catch (e) {
                if (!(e instanceof AiBusyError) || i >= maxWaits) throw e;
                opts.onWait?.(e);
                await new Promise<void>((resolve) => { this.setTimer(resolve, Math.max(1000, e.retryAfter * 1000)); });
            }
        }
    }

    /** The number of calls allowed in flight right now. */
    limit(cfg = this.config): number {
        if (!cfg.adaptive || cfg.slotsMax <= cfg.slots) return cfg.slots;
        if (!this.effSlots) this.effSlots = cfg.slots;
        return Math.min(cfg.slotsMax, Math.max(cfg.slots, Math.round(this.effSlots)));
    }

    /**
     * Adaptive concurrency, fed by every finished call:
     *  • 429            → halve (never below the configured base) — the provider said so;
     *  • timeout        → step down by two — the provider is slow to answer;
     *  • ok, saturated  → after four in a row with no pressure for a minute
     *                     and a healthy first-token time, one slot more (up to slotsMax).
     * The first-token time is the early-warning signal for providers that
     * queue instead of refusing: growth pauses when it drifts to 2.5× its
     * baseline and the limit steps down beyond 4×.
     */
    private adapt(cfg: SchedulerConfig, outcome: AiOutcome, saturated: boolean, ttft: number | null) {
        if (!cfg.adaptive || cfg.slotsMax <= cfg.slots) return;
        if (!this.effSlots) this.effSlots = cfg.slots;
        const now = this.now();
        if (outcome === 'rate_limited') {
            this.effSlots = Math.max(cfg.slots, Math.ceil(this.effSlots / 2));
            this.okStreak = 0;
            this.lastPressureAt = now;
            return;
        }
        if (outcome === 'timeout') {
            this.effSlots = Math.max(cfg.slots, this.effSlots - 2);
            this.okStreak = 0;
            this.lastPressureAt = now;
            return;
        }
        if (outcome !== 'ok') return;
        if (ttft !== null && ttft > 0) {
            this.ttftBase = this.ttftBase ? Math.min(this.ttftBase * 1.002, ttft) : ttft; // a slowly forgetting minimum
            this.ttftRecent = this.ttftRecent ? this.ttftRecent + 0.3 * (ttft - this.ttftRecent) : ttft;
            if (this.ttftBase >= 200 && this.ttftRecent > 4 * this.ttftBase) {
                this.effSlots = Math.max(cfg.slots, this.effSlots - 1);
                this.okStreak = 0;
                this.lastPressureAt = now;
                return;
            }
            if (this.ttftBase >= 200 && this.ttftRecent > 2.5 * this.ttftBase) {
                this.okStreak = 0;
                return; // hold
            }
        }
        if (!saturated || now - this.lastPressureAt < 60000) return;
        this.okStreak += 1;
        if (this.okStreak >= 4) {
            this.okStreak = 0;
            this.effSlots = Math.min(cfg.slotsMax, this.effSlots + 1);
        }
    }

    /** Called when the provider answered 429: every lane waits it out (for as long as the provider asked, at least 250 ms). */
    noteRateLimit(ms: number) {
        this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + Math.min(60000, Math.max(250, ms)));
        this.ensureTimer();
    }

    status(): SchedulerStatus {
        const cfg = this.config;
        const queued = (lane: AiLane) => this.queues[lane].map((m) => [...m.values()].reduce((n, f) => n + f.length, 0));
        const qi = queued('interactive');
        const qb = queued('background');
        const users = new Set<number>();
        const perFeatureQueued = new Map<string, number>();
        for (const lane of LANES) {
            for (const m of this.queues[lane]) {
                for (const [uid, fifo] of m) {
                    if (fifo.length && uid) users.add(uid);
                    for (const e of fifo) perFeatureQueued.set(e.feature, (perFeatureQueued.get(e.feature) || 0) + 1);
                }
            }
        }
        let interactive = 0;
        for (const e of this.running) if (e.lane === 'interactive') interactive += 1;
        const features: SchedulerStatus['features'] = {};
        const names = new Set<string>([
            ...this.featureInflight.keys(), ...perFeatureQueued.keys(), ...Object.keys(cfg.featureCaps), ...this.metrics.snapshot().features.map((f) => f.feature),
        ]);
        for (const f of names) {
            features[f] = {
                inflight: this.featureInflight.get(f) || 0,
                cap: cfg.featureCaps[f] ?? null,
                queued: perFeatureQueued.get(f) || 0,
                tau: this.metrics.tauOf(f, TAU_SEED[f] ?? TAU_SEED.other),
            };
        }
        return {
            enabled: cfg.enabled,
            slots: cfg.slots,
            effectiveSlots: this.limit(cfg),
            slotsMax: Math.max(cfg.slots, cfg.slotsMax),
            adaptive: cfg.adaptive && cfg.slotsMax > cfg.slots,
            interactiveReserve: cfg.interactiveReserve,
            backgroundMax: cfg.backgroundMax,
            running: { total: this.running.size, interactive, background: this.running.size - interactive },
            queued: { interactive: qi, background: qb, total: qi.reduce((a, b) => a + b, 0) + qb.reduce((a, b) => a + b, 0), users: users.size },
            cooldownMs: Math.max(0, this.cooldownUntil - this.now()),
            features,
            singleFlight: this.singleFlight.size,
        };
    }

    /** Queue depth of a lane counting only entries of class ≤ `cls` (what admission looks at). */
    queueLength(lane: AiLane, cls = 3): number {
        let n = 0;
        for (let c = 0; c <= cls; c++) for (const fifo of this.queues[lane][c].values()) n += fifo.length;
        return n;
    }

    /** Tests / hot reload: drop every queued entry (rejected as aborted) and timers. Running calls finish on their own. */
    reset() {
        for (const lane of LANES) {
            for (const m of this.queues[lane]) {
                for (const fifo of m.values()) for (const e of fifo) this.settle(e, new AiAbortedError('Scheduler reset'));
                m.clear();
            }
        }
        this.singleFlight.clear();
        this.cooldownUntil = 0;
        this.effSlots = 0;
        this.okStreak = 0;
        this.lastPressureAt = 0;
        this.ttftBase = 0;
        this.ttftRecent = 0;
        if (this.timer) this.clearTimer(this.timer);
        this.timer = null;
    }

    /* ------------------------------ enqueue ------------------------------ */

    private enqueue<T>(meta: AiCallMeta, fn: SlotFn<T>): Promise<T> {
        const cfg = this.config;
        if (!cfg.enabled) return this.passthrough(meta, fn, cfg);
        if (meta.signal?.aborted) throw new AiAbortedError();
        if (meta.key && this.singleFlight.has(meta.key)) return this.singleFlight.get(meta.key)!;
        const lane: AiLane = meta.lane === 'background' ? 'background' : 'interactive';
        const cls = this.classOf(meta, lane);
        const uid = meta.uid && meta.uid > 0 ? meta.uid : 0;
        const feature = meta.feature || 'other';
        // Admission looks at the queue THIS entry would join: entries of its
        // lane with the same or a better class (bulk class-3 work never
        // blocks a student's class-2 request), plus — for the background
        // lane — every interactive entry, since those all go first.
        const ahead = this.aheadOf(lane, cls).count;
        if (this.queueLength(lane, cls) >= cfg.queueMax) throw this.refuse(feature, lane, ahead, this.estimateEta(lane, cls, feature));
        const eta = this.estimateEta(lane, cls, feature);
        if (eta > cfg.maxWaitMs && !this.hasFreeSlot(lane, feature, uid)) throw this.refuse(feature, lane, ahead, eta);
        const now = this.now();
        let resolve!: (v: T) => void;
        let reject!: (e: any) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        const entry: Entry<T> = {
            id: this.nextId++,
            meta,
            fn,
            lane,
            cls,
            uid,
            feature,
            enqueuedAt: now,
            ageBase: now,
            firstEnqueuedAt: now,
            attempts: 0,
            state: 'queued',
            resolve,
            reject,
        };
        this.push(entry);
        if (meta.signal) {
            const onAbort = () => {
                if (entry.state === 'queued') {
                    this.remove(entry);
                    this.settle(entry, new AiAbortedError());
                } else if (entry.state === 'running') entry.slot?.controller.abort();
            };
            meta.signal.addEventListener('abort', onAbort, { once: true });
            entry.detachSignal = () => meta.signal!.removeEventListener('abort', onAbort);
        }
        this.notify(entry);
        if (meta.key) {
            const key = meta.key;
            this.singleFlight.set(key, promise);
            promise.finally(() => { if (this.singleFlight.get(key) === promise) this.singleFlight.delete(key); }).catch(() => { });
        }
        this.pump();
        return promise;
    }

    private classOf(meta: AiCallMeta, lane: AiLane): number {
        if (meta.priority !== undefined && Number.isFinite(+meta.priority)) return Math.min(3, Math.max(0, Math.floor(+meta.priority)));
        return lane === 'interactive' ? 0 : 2;
    }

    private refuse(feature: string, lane: AiLane, position: number, eta: number): AiBusyError {
        this.metrics.refused(feature, lane);
        const retryAfter = Math.max(1, Math.ceil(eta / 2000));
        this.log(`ai.refuse feature=${feature} lane=${lane} ahead=${position} eta=${Math.round(eta)}ms retryAfter=${retryAfter}s`);
        return new AiBusyError(position, eta, retryAfter);
    }

    private push(entry: Entry) {
        const m = this.queues[entry.lane][entry.cls];
        const fifo = m.get(entry.uid);
        if (fifo) fifo.push(entry);
        else m.set(entry.uid, [entry]);
        this.ensureTimer();
    }

    private remove(entry: Entry): boolean {
        const m = this.queues[entry.lane][entry.cls];
        const fifo = m.get(entry.uid);
        if (!fifo) return false;
        const i = fifo.indexOf(entry);
        if (i < 0) return false;
        fifo.splice(i, 1);
        if (!fifo.length) m.delete(entry.uid);
        return true;
    }

    /** Pass-through mode (sched_enabled = false): today's behaviour — direct call with plain retries. */
    private async passthrough<T>(meta: AiCallMeta, fn: SlotFn<T>, cfg: SchedulerConfig): Promise<T> {
        const policy = this.retryPolicy(meta, cfg);
        let lastErr: any;
        for (let i = 0; i < policy.attempts; i++) {
            const wait = this.cooldownUntil - this.now();
            if (wait > 0) await new Promise<void>((r) => { this.setTimer(r, wait); });
            const slot = new SlotImpl(this.nextId++, meta.feature || 'other', meta.lane, this.now);
            const onAbort = () => slot.controller.abort();
            meta.signal?.addEventListener('abort', onAbort, { once: true });
            try {
                return await slotStorage.run(slot, () => fn(slot));
            } catch (e) {
                lastErr = e;
                if (isAbortError(e) || !this.isTransient(e) || slot.emitted || i === policy.attempts - 1) throw e;
                const asked = Number.isFinite(+(e as any)?.retryAfterMs) && +(e as any).retryAfterMs > 0 ? +(e as any).retryAfterMs : 0;
                const backoff = asked ? Math.round(Math.max(250, asked) * (1 + this.random() * 0.25)) : this.backoff(policy.baseMs, i);
                if (this.isRateLimit(e)) this.noteRateLimit(asked || backoff);
                this.metrics.retried();
                await new Promise<void>((r) => { this.setTimer(r, backoff); });
            } finally {
                meta.signal?.removeEventListener('abort', onAbort);
            }
        }
        throw lastErr;
    }

    private retryPolicy(meta: AiCallMeta, cfg: SchedulerConfig): { attempts: number, baseMs: number } {
        if (meta.retry === false) return { attempts: 1, baseMs: cfg.retryBaseMs };
        const r = typeof meta.retry === 'object' && meta.retry ? meta.retry : {};
        return { attempts: Math.max(1, r.attempts ?? cfg.retryAttempts), baseMs: Math.max(100, r.baseMs ?? cfg.retryBaseMs) };
    }

    private backoff(baseMs: number, attempt: number): number {
        return Math.round(baseMs * 2 ** attempt * (0.75 + this.random() * 0.5));
    }

    /* ------------------------------ ETA ------------------------------ */

    private tauOf(feature: string): number {
        return this.metrics.tauOf(feature, TAU_SEED[feature] ?? TAU_SEED.other);
    }

    private backgroundLimit(cfg: SchedulerConfig): number {
        return Math.max(1, Math.min(cfg.backgroundMax, this.limit(cfg) - cfg.interactiveReserve));
    }

    private inflightOf(lane: AiLane): number {
        let n = 0;
        for (const e of this.running) if (e.lane === lane) n += 1;
        return n;
    }

    private slotsFor(lane: AiLane, cfg = this.config): number {
        if (lane === 'interactive') return Math.max(1, this.limit(cfg) - this.inflightOf('background'));
        return this.backgroundLimit(cfg);
    }

    /** Would an entry of this lane/feature/uid run right now? */
    private hasFreeSlot(lane: AiLane, feature: string, uid: number): boolean {
        const cfg = this.config;
        if (this.now() < this.cooldownUntil) return false;
        if (this.running.size >= this.limit(cfg)) return false;
        if (lane === 'background' && this.inflightOf('background') >= this.backgroundLimit(cfg)) return false;
        const cap = cfg.featureCaps[feature];
        if (cap && (this.featureInflight.get(feature) || 0) >= cap) return false;
        if (uid && lane === 'interactive' && (this.userInflight.get(uid) || 0) >= cfg.userInflight) return false;
        return true;
    }

    /** Entries dispatched before a hypothetical new entry of (lane, cls). */
    private aheadOf(lane: AiLane, cls: number, entry?: Entry): { count: number, tauSum: number } {
        let count = 0;
        let tauSum = 0;
        const consider = (e: Entry) => {
            count += 1;
            tauSum += this.tauOf(e.feature);
        };
        if (lane === 'background') {
            for (const m of this.queues.interactive) for (const fifo of m.values()) for (const e of fifo) consider(e);
        }
        for (let c = 0; c <= cls; c++) {
            for (const fifo of this.queues[lane][c].values()) {
                for (const e of fifo) {
                    if (e === entry) continue;
                    if (c < cls || !entry || e.enqueuedAt <= entry.enqueuedAt) consider(e);
                }
            }
        }
        return { count, tauSum };
    }

    private estimateEta(lane: AiLane, cls: number, feature: string, aheadCount?: number, entry?: Entry): number {
        const cfg = this.config;
        const ahead = this.aheadOf(lane, cls, entry);
        const count = aheadCount ?? ahead.count;
        const tauAvg = ahead.count ? ahead.tauSum / ahead.count : this.tauOf(feature);
        const slots = this.slotsFor(lane, cfg);
        let eta = (count * tauAvg) / slots;
        // No free slot right now: add the shortest remaining service time.
        if (!this.hasFreeSlot(lane, feature, 0) && this.running.size) {
            let minRemaining = Infinity;
            const now = this.now();
            for (const e of this.running) {
                const remaining = Math.max(0, this.tauOf(e.feature) - (now - (e.slot?.startedAt ?? now)));
                if (remaining < minRemaining) minRemaining = remaining;
            }
            if (Number.isFinite(minRemaining)) eta += minRemaining;
        }
        const cooldown = this.cooldownUntil - this.now();
        if (cooldown > 0) eta += cooldown;
        return Math.round(eta);
    }

    private notify(entry: Entry) {
        if (!entry.meta.onQueue || entry.state !== 'queued') return;
        const { count } = this.aheadOf(entry.lane, entry.cls, entry);
        const eta = this.estimateEta(entry.lane, entry.cls, entry.feature, count, entry);
        const s = { position: count, eta };
        if (entry.lastNotify && entry.lastNotify.position === s.position && Math.abs(entry.lastNotify.eta - eta) < 1000) return;
        entry.lastNotify = s;
        try {
            entry.meta.onQueue(s);
        } catch (e) { /* a broken callback never breaks the queue */ }
    }

    /* ------------------------------ dispatch ------------------------------ */

    private pump() {
        const cfg = this.config;
        if (!cfg.enabled) return;
        if (this.now() < this.cooldownUntil) {
            this.ensureTimer();
            return;
        }
        for (;;) {
            if (this.running.size >= this.limit(cfg)) break;
            const entry = this.pick(cfg);
            if (!entry) break;
            this.start(entry, cfg);
        }
    }

    /** The user served last per (lane, class): the rotation resumes AFTER them, even if their FIFO emptied meanwhile. */
    private lastServed = new Map<string, number>();

    private pick(cfg: SchedulerConfig): Entry | null {
        for (const lane of LANES) {
            if (lane === 'background' && this.inflightOf('background') >= this.backgroundLimit(cfg)) continue;
            for (let c = 0; c < CLASSES.length; c++) {
                const ring = this.queues[lane][c];
                if (!ring.size) continue;
                // Round-robin over users: start right after the user served last.
                const uids = [...ring.keys()];
                const key = `${lane}:${c}`;
                const last = this.lastServed.get(key);
                const at = last === undefined ? -1 : uids.indexOf(last);
                const order = at < 0 ? uids : [...uids.slice(at + 1), ...uids.slice(0, at + 1)];
                for (const uid of order) {
                    const fifo = ring.get(uid)!;
                    if (!fifo.length) {
                        ring.delete(uid);
                        continue;
                    }
                    // The per-user cap is about a student's INTERACTIVE calls: their
                    // background work (a thread summary, a pre-warm) never makes them wait.
                    if (uid && lane === 'interactive' && (this.userInflight.get(uid) || 0) >= cfg.userInflight) continue;
                    // A head blocked by its feature cap does not block the entries behind it.
                    const idx = fifo.findIndex((e) => {
                        const cap = cfg.featureCaps[e.feature];
                        return !cap || (this.featureInflight.get(e.feature) || 0) < cap;
                    });
                    if (idx < 0) continue;
                    const [entry] = fifo.splice(idx, 1);
                    if (!fifo.length) ring.delete(uid);
                    this.lastServed.set(key, uid);
                    return entry;
                }
            }
        }
        return null;
    }

    private start(entry: Entry, cfg: SchedulerConfig) {
        const slot = new SlotImpl(entry.id, entry.feature, entry.lane, this.now);
        entry.slot = slot;
        entry.state = 'running';
        entry.attempts += 1;
        this.running.add(entry);
        if (entry.uid && entry.lane === 'interactive') this.userInflight.set(entry.uid, (this.userInflight.get(entry.uid) || 0) + 1);
        this.featureInflight.set(entry.feature, (this.featureInflight.get(entry.feature) || 0) + 1);
        if (entry.meta.signal?.aborted) slot.controller.abort();
        let result: Promise<any>;
        try {
            result = Promise.resolve(slotStorage.run(slot, () => entry.fn(slot)));
        } catch (e) {
            result = Promise.reject(e);
        }
        result.then((v) => this.finish(entry, cfg, null, v), (e) => this.finish(entry, cfg, e ?? new Error('AI call failed')));
    }

    private release(entry: Entry) {
        if (!this.running.delete(entry)) return;
        if (entry.uid && entry.lane === 'interactive') {
            const n = (this.userInflight.get(entry.uid) || 1) - 1;
            if (n > 0) this.userInflight.set(entry.uid, n); else this.userInflight.delete(entry.uid);
        }
        const f = (this.featureInflight.get(entry.feature) || 1) - 1;
        if (f > 0) this.featureInflight.set(entry.feature, f); else this.featureInflight.delete(entry.feature);
    }

    private finish(entry: Entry, cfg: SchedulerConfig, err: any, value?: any) {
        const saturated = this.running.size >= this.limit(cfg);
        this.release(entry);
        const slot = entry.slot!;
        const now = this.now();
        const wait = Math.max(0, slot.startedAt - entry.firstEnqueuedAt);
        const service = Math.max(0, now - slot.startedAt);
        const ttft = slot.ttftAt === null ? null : Math.max(0, slot.ttftAt - slot.startedAt);
        const aborted = !!err && (isAbortError(err) || (slot.signal.aborted && this.isTransient(err)) || (entry.meta.signal?.aborted && this.isTransient(err)));
        let outcome: AiOutcome = 'ok';
        if (err) {
            if (aborted) outcome = 'aborted';
            else if (this.isRateLimit(err)) outcome = 'rate_limited';
            else if (/timed out/i.test(String(err?.message || ''))) outcome = 'timeout';
            else outcome = 'error';
        }
        const policy = this.retryPolicy(entry.meta, cfg);
        // A provider- or network-reported timeout is retried once at most:
        // each attempt re-sends (and, on a metered provider, re-bills) the
        // whole prompt. (The platform itself never times a call out.)
        const maxAttempts = outcome === 'timeout' ? Math.min(policy.attempts, 2) : policy.attempts;
        if (err && !aborted && this.isTransient(err) && !slot.emitted && entry.attempts < maxAttempts) {
            // Retry INSIDE the scheduler: the slot is released, the backoff
            // (and the shared 429 cool-down) is waited outside of it, then the
            // entry re-enters its own class with a link to the failed attempt.
            // A provider that says how long to wait (Retry-After) is obeyed to
            // the letter — a fixed 4 s base would stall every student longer
            // than the provider asked for.
            const asked = Number.isFinite(+err?.retryAfterMs) && +err.retryAfterMs > 0 ? +err.retryAfterMs : 0;
            const backoff = asked ? Math.round(Math.max(250, asked) * (1 + this.random() * 0.25)) : this.backoff(policy.baseMs, entry.attempts - 1);
            if (outcome === 'rate_limited') this.noteRateLimit(asked || backoff);
            this.adapt(cfg, outcome, saturated, null);
            this.metrics.retried();
            this.log(`ai.retry feature=${entry.feature} lane=${entry.lane} attempt=${entry.attempts}/${policy.attempts} in=${backoff}ms: ${String(err?.message || err).slice(0, 160)}`);
            const failedId = entry.id;
            entry.state = 'queued';
            entry.slot = undefined;
            this.setTimer(() => {
                if (entry.state !== 'queued') return;
                if (entry.meta.signal?.aborted) {
                    this.settle(entry, new AiAbortedError());
                    return;
                }
                entry.id = this.nextId++;
                entry.retryOf = failedId;
                entry.enqueuedAt = this.now();
                entry.ageBase = entry.enqueuedAt;
                this.push(entry);
                this.pump();
            }, backoff);
            this.pump();
            return;
        }
        this.metrics.record({
            feature: entry.feature, lane: entry.lane, wait, ttft, service, usage: slot.usage, outcome,
        });
        this.adapt(cfg, outcome, saturated, ttft);
        this.log(formatCallLine({
            feature: entry.feature, lane: entry.lane, uid: entry.uid, wait, ttft, service, usage: slot.usage, outcome, retries: entry.attempts - 1,
        }));
        if (err) this.settle(entry, aborted && !isAbortError(err) ? new AiAbortedError() : err);
        else this.settle(entry, null, value);
        this.pump();
    }

    private settle(entry: Entry, err: any, value?: any) {
        if (entry.state === 'settled') return;
        entry.state = 'settled';
        entry.detachSignal?.();
        if (err) entry.reject(err); else entry.resolve(value);
    }

    /* ------------------------------ timer ------------------------------ */

    private ensureTimer() {
        if (this.timer) return;
        this.timer = this.setTimer(() => {
            this.timer = null;
            this.tick();
        }, 1000);
    }

    private tick() {
        const cfg = this.config;
        const now = this.now();
        // Aging: a long wait buys the next-better class, keeping its user FIFO position.
        for (const lane of LANES) {
            for (let c = CLASSES.length - 1; c >= 1; c--) {
                for (const [uid, fifo] of [...this.queues[lane][c]]) {
                    const promote = fifo.filter((e) => e.ageBase + cfg.ageMs <= now);
                    if (!promote.length) continue;
                    const stay = fifo.filter((e) => !promote.includes(e));
                    if (stay.length) this.queues[lane][c].set(uid, stay); else this.queues[lane][c].delete(uid);
                    const target = this.queues[lane][c - 1];
                    const dest = target.get(uid) || [];
                    for (const e of promote) {
                        e.cls = c - 1;
                        e.ageBase = now;
                        dest.push(e);
                    }
                    target.set(uid, dest);
                }
            }
        }
        this.pump();
        let pending = 0;
        for (const lane of LANES) {
            for (const m of this.queues[lane]) {
                for (const fifo of m.values()) {
                    for (const e of fifo) {
                        pending += 1;
                        this.notify(e);
                    }
                }
            }
        }
        if (pending || this.now() < this.cooldownUntil) this.ensureTimer();
    }
}

/** The process-wide scheduler; lib/ai_tutor.ts binds its configuration to the site settings. */
export const aiScheduler = new AiScheduler();

/** `mapLimit` for job runners that want to keep their own queue short (the scheduler still enforces the caps). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out: R[] = Array.from({ length: items.length });
    let cursor = 0;
    const worker = async () => {
        for (;;) {
            const i = cursor++;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, () => worker()));
    return out;
}

/**
 * PTA fork — AI OBSERVABILITY (ai-speedup WP6).
 *
 * Everything the scheduler, the transport and the status card need to
 * answer "how is the AI doing right now": per-feature ring buffers of the
 * last calls (queue wait, service time, time-to-first-token, tokens, cache
 * hits, outcome), rolling per-hour counters (refusals, 429s, timeouts,
 * aborts, retries), and the one structured log line per call.
 *
 * In-memory only, per process: nothing is persisted, a restart starts the
 * rings empty. That is deliberate — this is a live dashboard, not an audit
 * log — and it keeps the module free of any database dependency so the
 * scheduler and its tests can import it standalone.
 */

export interface AiUsage {
    /** Uncached input tokens billed at the full rate. */
    input: number;
    /** Output tokens. */
    output: number;
    /** Input tokens served from the provider's prompt cache. */
    cacheRead: number;
    /** Input tokens written into the provider's prompt cache (Anthropic only). */
    cacheWrite: number;
}

export type AiOutcome = 'ok' | 'error' | 'timeout' | 'rate_limited' | 'aborted' | 'refused';

export interface AiCallRecord {
    at: number;
    feature: string;
    lane: string;
    /** Milliseconds spent queued before the slot was granted. */
    wait: number;
    /** Milliseconds from slot grant to the first streamed token (null = not streamed / none). */
    ttft: number | null;
    /** Milliseconds from slot grant to completion. */
    service: number;
    usage: AiUsage | null;
    outcome: AiOutcome;
}

export interface FeatureStats {
    feature: string;
    calls: number;
    errors: number;
    waitP50: number;
    waitP95: number;
    serviceP50: number;
    serviceP95: number;
    ttftP50: number | null;
    /** cacheRead / (input + cacheRead + cacheWrite), over calls that reported usage. */
    cacheHitRate: number | null;
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
    /** EWMA of the service time (ms), the scheduler's τ. */
    tau: number;
}

export interface HourCounters {
    hour: number;
    calls: number;
    ok: number;
    errors: number;
    refusals: number;
    rateLimits: number;
    timeouts: number;
    aborts: number;
    retries: number;
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
}

export interface MetricsSnapshot {
    features: FeatureStats[];
    hours: HourCounters[];
    /** Totals over the retained hours. */
    total: Omit<HourCounters, 'hour'>;
}

export const RING_SIZE = 500;
const HOURS_KEPT = 24;
const EWMA_ALPHA = 0.2;

function percentile(sorted: number[], p: number): number {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}

export const EMPTY_USAGE: AiUsage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
};

/**
 * Normalise a provider `usage` object into the four counters above. Each
 * provider reports its cache differently:
 *   Anthropic: input_tokens (uncached) + cache_read_input_tokens + cache_creation_input_tokens
 *   OpenAI:    prompt_tokens (TOTAL, cached included) + prompt_tokens_details.cached_tokens
 *   DeepSeek:  prompt_cache_hit_tokens + prompt_cache_miss_tokens (+ prompt_tokens total)
 * Unknown shapes degrade to "input = whatever total is given, no cache".
 */
export function normalizeUsage(raw: any): AiUsage | null {
    if (!raw || typeof raw !== 'object') return null;
    const n = (v: any) => (Number.isFinite(+v) ? Math.max(0, Math.round(+v)) : 0);
    const output = n(raw.output_tokens ?? raw.completion_tokens);
    if (raw.input_tokens !== undefined || raw.output_tokens !== undefined || raw.cache_read_input_tokens !== undefined || raw.cache_creation_input_tokens !== undefined) {
        return {
            input: n(raw.input_tokens), output, cacheRead: n(raw.cache_read_input_tokens), cacheWrite: n(raw.cache_creation_input_tokens),
        };
    }
    if (raw.prompt_cache_hit_tokens !== undefined || raw.prompt_cache_miss_tokens !== undefined) {
        const hit = n(raw.prompt_cache_hit_tokens);
        const miss = raw.prompt_cache_miss_tokens !== undefined ? n(raw.prompt_cache_miss_tokens) : Math.max(0, n(raw.prompt_tokens) - hit);
        return {
            input: miss, output, cacheRead: hit, cacheWrite: 0,
        };
    }
    if (raw.prompt_tokens !== undefined) {
        const cached = n(raw.prompt_tokens_details?.cached_tokens);
        return {
            input: Math.max(0, n(raw.prompt_tokens) - cached), output, cacheRead: cached, cacheWrite: 0,
        };
    }
    return null;
}

/** Sum two usages (independent calls). */
export function addUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
    if (!a) return b;
    if (!b) return a;
    return {
        input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    };
}

/**
 * Merge the usage events of ONE streamed call. Providers report cumulative
 * figures (Anthropic: `message_start` carries the input side with an
 * output of 1, `message_delta` the final cumulative output), so the
 * per-field maximum is the call's usage — never a sum.
 */
export function mergeStreamUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
    if (!a) return b;
    if (!b) return a;
    return {
        input: Math.max(a.input, b.input), output: Math.max(a.output, b.output), cacheRead: Math.max(a.cacheRead, b.cacheRead), cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    };
}

export class AiMetrics {
    private rings = new Map<string, AiCallRecord[]>();
    private tau = new Map<string, number>();
    private hours = new Map<number, HourCounters>();

    constructor(private now: () => number = () => Date.now(), private seed: Record<string, number> = {}) {}

    private bucket(): HourCounters {
        const hour = Math.floor(this.now() / 3600000);
        let b = this.hours.get(hour);
        if (!b) {
            b = {
                hour, calls: 0, ok: 0, errors: 0, refusals: 0, rateLimits: 0, timeouts: 0, aborts: 0, retries: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0,
            };
            this.hours.set(hour, b);
            for (const k of [...this.hours.keys()].sort((x, y) => x - y).slice(0, -HOURS_KEPT)) this.hours.delete(k);
        }
        return b;
    }

    /** One finished call (any outcome). */
    record(rec: Omit<AiCallRecord, 'at'>) {
        const at = this.now();
        const ring = this.rings.get(rec.feature) || [];
        ring.push({ ...rec, at });
        if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
        this.rings.set(rec.feature, ring);
        const b = this.bucket();
        b.calls += 1;
        if (rec.outcome === 'ok') {
            b.ok += 1;
            const prev = this.tau.get(rec.feature) ?? this.seed[rec.feature];
            this.tau.set(rec.feature, prev === undefined ? rec.service : prev + EWMA_ALPHA * (rec.service - prev));
        } else b.errors += 1;
        if (rec.outcome === 'rate_limited') b.rateLimits += 1;
        if (rec.outcome === 'timeout') b.timeouts += 1;
        if (rec.outcome === 'aborted') b.aborts += 1;
        if (rec.usage) {
            b.tokensIn += rec.usage.input;
            b.tokensOut += rec.usage.output;
            b.cacheRead += rec.usage.cacheRead;
            b.cacheWrite += rec.usage.cacheWrite;
        }
    }

    /** An admission refusal (the call never ran). */
    refused(feature: string, lane: string) {
        this.bucket().refusals += 1;
        this.record({
            feature, lane, wait: 0, ttft: null, service: 0, usage: null, outcome: 'refused',
        });
    }

    retried() {
        this.bucket().retries += 1;
    }

    /** The scheduler's service-time estimate for a feature (ms). */
    tauOf(feature: string, fallback: number): number {
        return this.tau.get(feature) ?? this.seed[feature] ?? fallback;
    }

    statsOf(feature: string): FeatureStats {
        const ring = (this.rings.get(feature) || []).filter((r) => r.outcome !== 'refused');
        const ok = ring.filter((r) => r.outcome === 'ok');
        const waits = ring.map((r) => r.wait).sort((a, b) => a - b);
        const services = ok.map((r) => r.service).sort((a, b) => a - b);
        const ttfts = ok.filter((r) => r.ttft !== null).map((r) => r.ttft as number).sort((a, b) => a - b);
        let tokensIn = 0;
        let tokensOut = 0;
        let cacheRead = 0;
        let cacheWrite = 0;
        for (const r of ring) {
            if (!r.usage) continue;
            tokensIn += r.usage.input;
            tokensOut += r.usage.output;
            cacheRead += r.usage.cacheRead;
            cacheWrite += r.usage.cacheWrite;
        }
        const cacheable = tokensIn + cacheRead + cacheWrite;
        return {
            feature,
            calls: ring.length,
            errors: ring.length - ok.length,
            waitP50: percentile(waits, 50),
            waitP95: percentile(waits, 95),
            serviceP50: percentile(services, 50),
            serviceP95: percentile(services, 95),
            ttftP50: ttfts.length ? percentile(ttfts, 50) : null,
            cacheHitRate: cacheable ? cacheRead / cacheable : null,
            tokensIn,
            tokensOut,
            cacheRead,
            cacheWrite,
            tau: this.tauOf(feature, 0),
        };
    }

    snapshot(): MetricsSnapshot {
        const features = [...new Set([...this.rings.keys(), ...this.tau.keys()])].sort().map((f) => this.statsOf(f));
        const hours = [...this.hours.values()].sort((a, b) => a.hour - b.hour);
        const total: Omit<HourCounters, 'hour'> = {
            calls: 0, ok: 0, errors: 0, refusals: 0, rateLimits: 0, timeouts: 0, aborts: 0, retries: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0,
        };
        for (const h of hours) {
            for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += h[k];
        }
        return { features, hours, total };
    }

    /** For tests and hot reloads. */
    reset() {
        this.rings.clear();
        this.tau.clear();
        this.hours.clear();
    }
}

/** A stable, non-reversible token for a uid in log lines (never the uid itself). */
export function uidHash(uid: number | undefined): string {
    if (!uid) return 'sys';
    // FNV-1a over the decimal string: short, deterministic, not invertible in practice.
    let h = 0x811C9DC5;
    for (const ch of String(uid)) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/** The one structured log line per call. */
export function formatCallLine(rec: Omit<AiCallRecord, 'at'> & { uid?: number, retries?: number }): string {
    const u = rec.usage;
    const cache = u ? (u.input + u.cacheRead + u.cacheWrite ? `${Math.round((u.cacheRead / (u.input + u.cacheRead + u.cacheWrite)) * 100)}%` : 'n/a') : 'n/a';
    return `ai.call feature=${rec.feature} lane=${rec.lane} uid=${uidHash(rec.uid)} wait=${rec.wait}ms ttft=${rec.ttft === null ? '-' : `${rec.ttft}ms`} `
        + `service=${rec.service}ms in=${u ? u.input : '-'} out=${u ? u.output : '-'} cache=${cache}${rec.retries ? ` retries=${rec.retries}` : ''} outcome=${rec.outcome}`;
}

/** The process-wide instance. */
export const aiMetrics = new AiMetrics();

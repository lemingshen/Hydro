/* eslint-disable max-len */
/**
 * PTA fork — API KEY POOL.
 *
 * Several API keys of one provider — separately limited accounts or
 * projects, or keys brought by each customer institution — are used at
 * the same time so that the platform's throughput is the SUM of what the
 * keys allow, and one key's rate limit is that key's problem alone.
 *
 * Each key has its own concurrency limit (adaptive, like the scheduler's),
 * its own request-per-minute window, its own cool-down and its own health:
 *   ok        usable
 *   cooling   the provider answered 429 for it — back after Retry-After
 *   paused    repeated failures — back after a quarantine
 *   disabled  invalid key (401/403) or no balance (402) — until reprobed / reconfigured
 *
 * Selection is CACHE-AWARE: provider prompt caches are usually scoped per
 * account, so requests that share a cached prefix (the scheduler's
 * `cacheKey` — the same task) prefer the same key by rendezvous hashing,
 * and only spill to the next-best key when that one is saturated. Load
 * still spreads across keys, but each cached prefix lives on as few keys
 * as possible.
 *
 * The pool reports its CAPACITY (sum of free room across usable keys) to
 * the scheduler, which never dispatches more than the keys can carry and
 * wakes up the moment a key comes back from a cool-down. A pool with a
 * single key behaves exactly like today's single key.
 *
 * No secrets ever leave this module in the clear: the status API and the
 * logs see a short hash and the label only.
 */
import { createHash } from 'crypto';

export type KeyHealth = 'ok' | 'cooling' | 'paused' | 'disabled';

export interface KeySpec {
    secret: string;
    label?: string;
    /** Per-key concurrency ceiling (the adaptive limit grows up to this). */
    maxInflight?: number;
    /** Starting concurrency (default: maxInflight). */
    startInflight?: number;
    /** Optional requests-per-minute budget for this key. */
    rpm?: number;
    /** Restrict the key to one tenant (domain). */
    domain?: string;
    /** Relative preference when several keys tie. */
    weight?: number;
}

export interface KeyEntry extends Required<Pick<KeySpec, 'secret' | 'label' | 'maxInflight' | 'weight'>> {
    id: string;
    rpm: number;
    domain: string;
    health: KeyHealth;
    reason: string;
    inflight: number;
    /** Adaptive concurrency limit within [1, maxInflight]. */
    limit: number;
    okStreak: number;
    cooldownUntil: number;
    consecutiveErrors: number;
    /** Request timestamps of the last minute (for the rpm window). */
    window: number[];
    stats: { calls: number, ok: number, errors: number, rateLimits: number, disabledAt: number };
    lastUsedAt: number;
}

export interface KeyLease {
    key: KeyEntry;
    /** Report the outcome; releases the key's in-flight slot. Idempotent. */
    done: (outcome: 'ok' | 'error' | 'rate_limited' | 'auth' | 'quota' | 'aborted', retryAfterMs?: number) => void;
}

export interface KeyPoolStatus {
    keys: {
        id: string; label: string; health: KeyHealth; reason: string; inflight: number; limit: number; maxInflight: number; rpm: number; rpmUsed: number; domain: string;
        cooldownMs: number; calls: number; ok: number; errors: number; rateLimits: number;
    }[];
    usable: number;
    capacity: number;
    available: number;
    nextFreeAt: number;
}

const QUARANTINE_MS = 5 * 60 * 1000;
const REPROBE_QUOTA_MS = 60 * 60 * 1000;
const MAX_CONSECUTIVE_ERRORS = 5;

/**
 * Parse the multi-line setting. One key per line; options after `|`:
 *   sk-abc... | label=deepseek-01 | max=8 | rpm=600 | domain=cs101 | weight=2
 * Blank lines and `#` comments are ignored. Bare lines are keys with defaults.
 */
export function parseKeySpecs(text: string, defaults: { maxInflight?: number, rpm?: number } = {}): KeySpec[] {
    const out: KeySpec[] = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line === '-' || line.toLowerCase() === 'none') return []; // explicit "no pool"

        const [secretPart, ...opts] = line.split('|').map((s) => s.trim());
        if (!secretPart) continue;
        const spec: KeySpec = { secret: secretPart, maxInflight: defaults.maxInflight, rpm: defaults.rpm };
        for (const o of opts) {
            const [k, v] = o.split('=').map((s) => s.trim());
            if (!k) continue;
            if (k === 'label') spec.label = v;
            else if (k === 'max' || k === 'maxInflight') spec.maxInflight = Math.max(1, Math.floor(+v) || 1);
            else if (k === 'start') spec.startInflight = Math.max(1, Math.floor(+v) || 1);
            else if (k === 'rpm') spec.rpm = Math.max(0, Math.floor(+v) || 0);
            else if (k === 'domain') spec.domain = v;
            else if (k === 'weight') spec.weight = Math.max(0.1, +v || 1);
        }
        out.push(spec);
    }
    return out;
}

export function keyId(secret: string): string {
    return createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

/** Rendezvous score of (key, affinity): deterministic, uniform, cheap. */
function affinityScore(id: string, affinity: string): number {
    const h = createHash('sha1').update(`${id}:${affinity}`).digest();
    return h.readUInt32BE(0) / 0xFFFFFFFF;
}

export interface KeyPoolDeps {
    now?: () => number;
    /** Called when capacity appears (a cool-down ended, a key was released): the scheduler pumps. */
    onCapacity?: () => void;
    setTimeout?: (fn: () => void, ms: number) => any;
    clearTimeout?: (t: any) => void;
    log?: (line: string) => void;
}

export class KeyPool {
    private keys: KeyEntry[] = [];
    private timer: any = null;
    private waiters: (() => void)[] = [];
    private readonly now: () => number;
    private readonly setTimer: (fn: () => void, ms: number) => any;
    private readonly clearTimer: (t: any) => void;
    private readonly log: (line: string) => void;
    onCapacity: () => void;

    constructor(deps: KeyPoolDeps = {}) {
        this.now = deps.now || (() => Date.now());
        this.setTimer = deps.setTimeout || ((fn, ms) => {
            const t = setTimeout(fn, ms);
            (t as any).unref?.();
            return t;
        });
        this.clearTimer = deps.clearTimeout || ((t) => clearTimeout(t));
        this.log = deps.log || (() => { });
        this.onCapacity = deps.onCapacity || (() => { });
    }

    /** Replace the configuration; keys that stay keep their state (health, limit, stats). */
    configure(specs: KeySpec[]) {
        const prev = new Map(this.keys.map((k) => [k.id, k]));
        const next: KeyEntry[] = [];
        const seen = new Set<string>();
        for (const s of specs) {
            const secret = String(s.secret || '').trim();
            if (!secret) continue;
            const id = keyId(secret);
            if (seen.has(id)) continue;
            seen.add(id);
            const maxInflight = Math.max(1, Math.floor(s.maxInflight || 8));
            const old = prev.get(id);
            if (old) {
                old.label = s.label || old.label;
                old.maxInflight = maxInflight;
                old.limit = Math.min(old.limit, maxInflight);
                old.rpm = s.rpm || 0;
                old.domain = s.domain || '';
                old.weight = s.weight || 1;
                next.push(old);
                continue;
            }
            next.push({
                id,
                secret,
                label: s.label || `key-${id}`,
                maxInflight,
                weight: s.weight || 1,
                rpm: s.rpm || 0,
                domain: s.domain || '',
                health: 'ok',
                reason: '',
                inflight: 0,
                limit: Math.min(maxInflight, Math.max(1, Math.floor(s.startInflight || maxInflight))),
                okStreak: 0,
                cooldownUntil: 0,
                consecutiveErrors: 0,
                window: [],
                stats: {
                    calls: 0, ok: 0, errors: 0, rateLimits: 0, disabledAt: 0,
                },
                lastUsedAt: 0,
            });
        }
        this.keys = next;
    }

    get size(): number {
        return this.keys.length;
    }

    /** Resolves at the next capacity change (a release, a cool-down ending) or when `signal` aborts. */
    waitForCapacity(signal?: AbortSignal): Promise<void> {
        return new Promise<void>((resolve) => {
            if (signal?.aborted) {
                resolve();
                return;
            }
            const done = () => {
                signal?.removeEventListener('abort', done);
                this.waiters = this.waiters.filter((w) => w !== done);
                resolve();
            };
            this.waiters.push(done);
            signal?.addEventListener('abort', done, { once: true });
            const cap = this.capacity();
            if (!cap.available && cap.nextFreeAt) this.ensureTimer(cap.nextFreeAt);
        });
    }

    private notify() {
        const w = this.waiters.splice(0);
        for (const fn of w) fn();
        this.onCapacity();
    }

    /* ------------------------------ health ------------------------------ */

    private refresh(k: KeyEntry) {
        const now = this.now();
        if (k.health === 'cooling' && now >= k.cooldownUntil) {
            k.health = 'ok';
            k.reason = '';
        } else if (k.health === 'paused' && now >= k.cooldownUntil) {
            k.health = 'ok';
            k.reason = '';
            k.consecutiveErrors = 0;
        } else if (k.health === 'disabled' && k.reason === 'quota' && now - k.stats.disabledAt >= REPROBE_QUOTA_MS) {
            // Balances get topped up: try again once an hour.
            k.health = 'ok';
            k.reason = '';
        }
        k.window = k.window.filter((t) => now - t < 60000);
    }

    private usable(k: KeyEntry, domain?: string): boolean {
        this.refresh(k);
        if (k.health !== 'ok') return false;
        if (k.domain && k.domain !== domain) return false;
        return true;
    }

    private hasRoom(k: KeyEntry): boolean {
        if (k.inflight >= k.limit) return false;
        if (k.rpm && k.window.length >= k.rpm) return false;
        return true;
    }

    /* ------------------------------ selection ------------------------------ */

    /**
     * Pick a key for a request. `affinity` (the scheduler's cacheKey) keeps a
     * cached prefix on as few keys as possible; `domain` restricts to a
     * tenant's own keys when it has some. Returns null when every usable
     * key is full — the scheduler then waits for capacity.
     */
    acquire(opts: { affinity?: string, domain?: string } = {}): KeyLease | null {
        const domain = opts.domain || '';
        let pool = this.keys.filter((k) => this.usable(k, domain) && k.domain === domain);
        if (!pool.length) pool = this.keys.filter((k) => this.usable(k, domain) && !k.domain); // shared keys
        if (!pool.length) return null;
        const withRoom = pool.filter((k) => this.hasRoom(k));
        if (!withRoom.length) return null;
        let chosen: KeyEntry;
        if (opts.affinity && withRoom.length > 1) {
            // Rendezvous hashing over the keys with room, weighted; the
            // affinity key wins while it has room, the runner-up when not.
            chosen = withRoom.reduce((best, k) => {
                const score = affinityScore(k.id, opts.affinity!) ** (1 / k.weight);
                return score > best.score ? { k, score } : best;
            }, { k: withRoom[0], score: -1 }).k;
        } else {
            // Least loaded (in-flight share of the limit), ties by weight.
            chosen = withRoom.reduce((best, k) => {
                const load = k.inflight / k.limit;
                const bestLoad = best.inflight / best.limit;
                if (load < bestLoad - 1e-9 || (Math.abs(load - bestLoad) < 1e-9 && k.weight > best.weight)) return k;
                return best;
            }, withRoom[0]);
        }
        const k = chosen;
        k.inflight += 1;
        k.stats.calls += 1;
        k.window.push(this.now());
        k.lastUsedAt = this.now();
        let released = false;
        return {
            key: k,
            done: (outcome, retryAfterMs) => {
                if (released) return;
                released = true;
                k.inflight = Math.max(0, k.inflight - 1);
                this.report(k, outcome, retryAfterMs);
                this.notify();
            },
        };
    }

    private report(k: KeyEntry, outcome: 'ok' | 'error' | 'rate_limited' | 'auth' | 'quota' | 'aborted', retryAfterMs?: number) {
        const now = this.now();
        switch (outcome) {
            case 'ok':
                k.stats.ok += 1;
                k.consecutiveErrors = 0;
                // Additive increase while the key keeps up: four successes that
                // completed with the key saturated buy one more slot. (An
                // unsaturated success neither counts nor resets — only errors do.)
                if (k.inflight + 1 >= k.limit) {
                    k.okStreak += 1;
                    if (k.okStreak >= 4 && k.limit < k.maxInflight) {
                        k.limit += 1;
                        k.okStreak = 0;
                    }
                }
                break;
            case 'rate_limited':
                k.stats.rateLimits += 1;
                k.stats.errors += 1;
                k.okStreak = 0;
                // Multiplicative decrease for THIS key, and a cool-down of what the provider asked (≥ 250 ms, ≤ 60 s).
                k.limit = Math.max(1, Math.ceil(k.limit / 2));
                k.health = 'cooling';
                k.reason = 'rate limited';
                k.cooldownUntil = now + Math.min(60000, Math.max(250, retryAfterMs || 2000));
                this.log(`ai.key ${k.label} rate-limited: limit→${k.limit}, cooling ${Math.round((k.cooldownUntil - now) / 1000)}s`);
                this.ensureTimer(k.cooldownUntil);
                break;
            case 'auth':
                k.stats.errors += 1;
                k.health = 'disabled';
                k.reason = 'invalid key';
                k.stats.disabledAt = now;
                this.log(`ai.key ${k.label} disabled: the provider rejected the key (401/403)`);
                break;
            case 'quota':
                k.stats.errors += 1;
                k.health = 'disabled';
                k.reason = 'quota';
                k.stats.disabledAt = now;
                this.log(`ai.key ${k.label} disabled: no balance / quota exhausted (402); reprobe in 1 h`);
                this.ensureTimer(now + REPROBE_QUOTA_MS);
                break;
            case 'error':
                k.stats.errors += 1;
                k.consecutiveErrors += 1;
                k.okStreak = 0;
                if (k.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    k.health = 'paused';
                    k.reason = `${k.consecutiveErrors} consecutive errors`;
                    k.cooldownUntil = now + QUARANTINE_MS;
                    this.log(`ai.key ${k.label} paused for 5 min after ${k.consecutiveErrors} consecutive errors`);
                    this.ensureTimer(k.cooldownUntil);
                }
                break;
            case 'aborted':
            default:
                break;
        }
    }

    /* ------------------------------ capacity ------------------------------ */

    /** Room for new requests right now across usable keys (all tenants), and when more appears. */
    capacity(domain?: string): { limit: number, available: number, nextFreeAt: number } {
        let limit = 0;
        let available = 0;
        let nextFreeAt = 0;
        for (const k of this.keys) {
            this.refresh(k);
            if (domain !== undefined && k.domain && k.domain !== domain) continue;
            if (k.health === 'ok') {
                limit += k.limit;
                if (this.hasRoom(k)) available += k.limit - k.inflight;
                else if (k.rpm && k.window.length >= k.rpm && k.window.length) nextFreeAt = nextFreeAt ? Math.min(nextFreeAt, k.window[0] + 60000) : k.window[0] + 60000;
            } else if ((k.health === 'cooling' || k.health === 'paused') && k.cooldownUntil) {
                nextFreeAt = nextFreeAt ? Math.min(nextFreeAt, k.cooldownUntil) : k.cooldownUntil;
            }
        }
        return { limit, available, nextFreeAt };
    }

    private ensureTimer(at: number) {
        const ms = Math.max(50, at - this.now());
        if (this.timer) this.clearTimer(this.timer);
        this.timer = this.setTimer(() => {
            this.timer = null;
            for (const k of this.keys) this.refresh(k);
            this.notify();
            const cap = this.capacity();
            if (!cap.available && cap.nextFreeAt) this.ensureTimer(cap.nextFreeAt);
        }, ms);
    }

    status(): KeyPoolStatus {
        const now = this.now();
        const cap = this.capacity();
        return {
            keys: this.keys.map((k) => {
                this.refresh(k);
                return {
                    id: k.id,
                    label: k.label,
                    health: k.health,
                    reason: k.reason,
                    inflight: k.inflight,
                    limit: k.limit,
                    maxInflight: k.maxInflight,
                    rpm: k.rpm,
                    rpmUsed: k.window.length,
                    domain: k.domain,
                    cooldownMs: k.health === 'cooling' || k.health === 'paused' ? Math.max(0, k.cooldownUntil - now) : 0,
                    calls: k.stats.calls,
                    ok: k.stats.ok,
                    errors: k.stats.errors,
                    rateLimits: k.stats.rateLimits,
                };
            }),
            usable: this.keys.filter((k) => k.health === 'ok').length,
            capacity: cap.limit,
            available: cap.available,
            nextFreeAt: cap.nextFreeAt,
        };
    }

    /** Tests / hot reload. */
    reset() {
        this.keys = [];
        if (this.timer) this.clearTimer(this.timer);
        this.timer = null;
        this.notify();
    }
}

export const keyPool = new KeyPool();

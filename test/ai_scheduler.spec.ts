/* eslint-disable no-await-in-loop */
/**
 * ai-speedup WP1 — scheduler tests with a fake clock (no database).
 * Run: node -r @hydrooj/register test/ai_scheduler.spec.ts
 */
import { expect } from 'chai';
import { describe, it } from 'node:test';
import { AiMetrics } from '../packages/hydrooj/src/lib/ai_metrics';
import {
    AiAbortedError, AiBusyError, AiCallMeta, AiScheduler, mapLimit, parseFeatureCaps, SchedulerConfig,
} from '../packages/hydrooj/src/lib/ai_scheduler';

const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => { setImmediate(r); });
};

/** A controllable clock + timer queue. */
class FakeClock {
    now = 1_000_000;
    private timers: { at: number, fn: () => void, id: number }[] = [];
    private seq = 0;

    setTimeout = (fn: () => void, ms: number) => {
        const id = ++this.seq;
        this.timers.push({ at: this.now + Math.max(0, ms), fn, id });
        return id;
    };

    clearTimeout = (id: any) => {
        this.timers = this.timers.filter((t) => t.id !== id);
    };

    /** Advance time, firing due timers in order; lets promises settle between steps. */
    async advance(ms: number) {
        const target = this.now + ms;
        for (;;) {
            this.timers.sort((a, b) => a.at - b.at);
            const next = this.timers[0];
            if (!next || next.at > target) break;
            this.timers.shift();
            this.now = next.at;
            next.fn();
            await flush();
        }
        this.now = target;
        await flush();
    }
}

/** A call whose completion the test controls. */
function deferred<T = string>() {
    let resolve!: (v: T) => void;
    let reject!: (e: any) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function make(config: Partial<SchedulerConfig> = {}) {
    const clock = new FakeClock();
    const metrics = new AiMetrics(() => clock.now);
    const logs: string[] = [];
    const sched = new AiScheduler({
        now: () => clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        config: () => ({ ageMs: 30000, adaptive: false, ...config }),
        metrics,
        log: (l) => logs.push(l),
        random: () => 0.5,
    });
    return {
        clock, sched, metrics, logs,
    };
}

/** Submit a call that resolves only when the test says so; records the start order. */
function submit(sched: AiScheduler, started: string[], name: string, meta: AiCallMeta) {
    const d = deferred();
    const p = sched.run(meta, async () => {
        started.push(name);
        return d.promise;
    });
    p.catch(() => { });
    return { done: d, promise: p };
}

describe('ai scheduler', () => {
    it('parses feature caps', () => {
        expect(parseFeatureCaps('explain:3, qr_label:3,bad,x:0,y:abc')).to.deep.equal({ explain: 3, qr_label: 3 });
    });

    it('dispatches by class and never exceeds the slot total', async () => {
        const { sched } = make({ slots: 2, interactiveReserve: 0, backgroundMax: 2 });
        const started: string[] = [];
        const a = submit(sched, started, 'a', { feature: 'tutor', lane: 'interactive', uid: 1 });
        const b = submit(sched, started, 'b', { feature: 'tutor', lane: 'interactive', uid: 2 });
        const c = submit(sched, started, 'c', { feature: 'tutor', lane: 'interactive', priority: 2, uid: 3 });
        const d = submit(sched, started, 'd', { feature: 'tutor', lane: 'interactive', priority: 0, uid: 4 });
        await flush();
        expect(started).to.deep.equal(['a', 'b']);
        expect(sched.status().running.total).to.equal(2);
        a.done.resolve('ok');
        await flush();
        // d (class 0) is served before c (class 2) although c was queued first.
        expect(started).to.deep.equal(['a', 'b', 'd']);
        b.done.resolve('ok');
        d.done.resolve('ok');
        await flush();
        expect(started).to.deep.equal(['a', 'b', 'd', 'c']);
        c.done.resolve('ok');
        expect(await a.promise).to.equal('ok');
    });

    it('round-robins between users (A×5, B×1 → B is served second)', async () => {
        const { sched } = make({ slots: 1, interactiveReserve: 0, userInflight: 1 });
        const started: string[] = [];
        const calls = [];
        for (let i = 0; i < 5; i++) calls.push(submit(sched, started, `A${i}`, { feature: 'tutor', lane: 'interactive', uid: 7 }));
        calls.push(submit(sched, started, 'B0', { feature: 'tutor', lane: 'interactive', uid: 8 }));
        await flush();
        expect(started).to.deep.equal(['A0']);
        calls[0].done.resolve('');
        await flush();
        expect(started).to.deep.equal(['A0', 'B0']);
        calls[5].done.resolve('');
        await flush();
        expect(started[2]).to.equal('A1');
        for (const c of calls) c.done.resolve('');
    });

    it('caps calls in flight per user', async () => {
        const { sched } = make({ slots: 4, interactiveReserve: 0, userInflight: 1 });
        const started: string[] = [];
        const a = submit(sched, started, 'a', { feature: 'tutor', lane: 'interactive', uid: 1 });
        const b = submit(sched, started, 'b', { feature: 'tutor', lane: 'interactive', uid: 1 });
        await flush();
        expect(started).to.deep.equal(['a']);
        a.done.resolve('');
        await flush();
        expect(started).to.deep.equal(['a', 'b']);
        b.done.resolve('');
    });

    it('never lets background take the interactive reserve', async () => {
        const { sched } = make({ slots: 4, interactiveReserve: 3, backgroundMax: 4 });
        const started: string[] = [];
        const bg = [1, 2, 3].map((i) => submit(sched, started, `bg${i}`, { feature: 'report_map', lane: 'background' }));
        await flush();
        expect(started).to.deep.equal(['bg1']); // 4 slots − 3 reserved = 1 background slot
        const it1 = submit(sched, started, 'it1', { feature: 'tutor', lane: 'interactive', uid: 1 });
        await flush();
        expect(started).to.deep.equal(['bg1', 'it1']);
        for (const c of [...bg, it1]) c.done.resolve('');
    });

    it('enforces per-feature caps', async () => {
        const { sched } = make({ slots: 6, interactiveReserve: 0, backgroundMax: 6, featureCaps: { explain: 2 } });
        const started: string[] = [];
        const calls = [1, 2, 3].map((i) => submit(sched, started, `e${i}`, { feature: 'explain', lane: 'background' }));
        const other = submit(sched, started, 'grade', { feature: 'grade', lane: 'background' });
        await flush();
        expect(started).to.deep.equal(['e1', 'e2', 'grade']);
        calls[0].done.resolve('');
        await flush();
        expect(started).to.deep.equal(['e1', 'e2', 'grade', 'e3']);
        for (const c of [...calls, other]) c.done.resolve('');
    });

    it('aging promotes a queued call to the next-better class', async () => {
        const { sched, clock } = make({ slots: 1, interactiveReserve: 0, ageMs: 30000 });
        const started: string[] = [];
        const hog = submit(sched, started, 'hog', { feature: 'tutor', lane: 'interactive', uid: 1 });
        const bulk = submit(sched, started, 'bulk', { feature: 'attrib', lane: 'interactive', priority: 3, uid: 2 });
        await flush();
        expect(sched.status().queued.interactive).to.deep.equal([0, 0, 0, 1]);
        await clock.advance(31000);
        expect(sched.status().queued.interactive).to.deep.equal([0, 0, 1, 0]);
        await clock.advance(31000);
        expect(sched.status().queued.interactive).to.deep.equal([0, 1, 0, 0]);
        hog.done.resolve('');
        bulk.done.resolve('');
        await flush();
        expect(started).to.deep.equal(['hog', 'bulk']);
    });

    it('single-flight shares one execution and one error', async () => {
        const { sched } = make({ slots: 4, interactiveReserve: 0 });
        let runs = 0;
        const d = deferred();
        const fn = async () => {
            runs += 1;
            return d.promise;
        };
        const p1 = sched.run({ feature: 'suggest', lane: 'interactive', key: 'k1' }, fn);
        const p2 = sched.run({ feature: 'suggest', lane: 'interactive', key: 'k1' }, fn);
        await flush();
        expect(runs).to.equal(1);
        expect(sched.status().singleFlight).to.equal(1);
        d.reject(new Error('boom'));
        let e1: any;
        let e2: any;
        await p1.catch((e) => { e1 = e; });
        await p2.catch((e) => { e2 = e; });
        expect(e1).to.equal(e2);
        expect(e1.message).to.equal('boom');
        await flush();
        expect(sched.status().singleFlight).to.equal(0);
    });

    it('refuses at the queue maximum with a retry-after', async () => {
        const { sched, metrics } = make({ slots: 1, interactiveReserve: 0, queueMax: 2 });
        const started: string[] = [];
        const a = submit(sched, started, 'a', { feature: 'tutor', lane: 'interactive', uid: 1 });
        submit(sched, started, 'b', { feature: 'tutor', lane: 'interactive', uid: 2 });
        submit(sched, started, 'c', { feature: 'tutor', lane: 'interactive', uid: 3 });
        let err: any;
        await sched.run({ feature: 'tutor', lane: 'interactive', uid: 4 }, async () => 'x').catch((e) => { err = e; });
        expect(err).to.be.instanceOf(AiBusyError);
        expect(err.code).to.equal(503);
        expect(err.position).to.equal(2);
        expect(err.retryAfter).to.be.at.least(1);
        expect(err.params[0]).to.equal(2);
        expect(metrics.snapshot().total.refusals).to.equal(1);
        // submit() throws synchronously (for handlers that answer 503 before creating a stream)
        expect(() => sched.submit({ feature: 'tutor', lane: 'interactive', uid: 5 }, async () => 'x')).to.throw(AiBusyError);
        a.done.resolve('');
    });

    it('refuses when the estimated wait exceeds the maximum', async () => {
        const { sched } = make({ slots: 1, interactiveReserve: 0, queueMax: 100, maxWaitMs: 20000 });
        const started: string[] = [];
        const a = submit(sched, started, 'a', { feature: 'tutor', lane: 'interactive', uid: 1 });
        // tutor τ seeds at 12 s per call; three queued ahead ≈ 36 s > 20 s
        submit(sched, started, 'b', { feature: 'tutor', lane: 'interactive', uid: 2 });
        submit(sched, started, 'c', { feature: 'tutor', lane: 'interactive', uid: 3 });
        submit(sched, started, 'd', { feature: 'tutor', lane: 'interactive', uid: 4 });
        let err: any;
        await sched.run({ feature: 'tutor', lane: 'interactive', uid: 5 }, async () => 'x').catch((e) => { err = e; });
        expect(err).to.be.instanceOf(AiBusyError);
        expect(err.eta).to.be.greaterThan(20000);
        a.done.resolve('');
    });

    it('bulk (class 3) work does not count against a class-2 admission', async () => {
        const { sched } = make({ slots: 1, interactiveReserve: 0, backgroundMax: 1, queueMax: 3, maxWaitMs: 999999 });
        const started: string[] = [];
        const hog = submit(sched, started, 'hog', { feature: 'explain', lane: 'background' });
        for (let i = 0; i < 3; i++) submit(sched, started, `bulk${i}`, { feature: 'attrib', lane: 'background', priority: 3 });
        await flush();
        // queueMax 3 is reached for class 3, but a class-2 student request still gets in
        const p = sched.run({ feature: 'explain', lane: 'background', priority: 2 }, async () => 'ok');
        p.catch(() => { });
        expect(sched.queueLength('background', 2)).to.equal(1);
        expect(sched.queueLength('background', 3)).to.equal(4);
        hog.done.resolve('');
        await flush();
        expect(await p).to.equal('ok');
    });

    it('dequeues on abort while queued and aborts the slot while running', async () => {
        const { sched } = make({ slots: 1, interactiveReserve: 0 });
        const started: string[] = [];
        let runningSignal: AbortSignal | null = null;
        const ac1 = new AbortController();
        const p1 = sched.run({ feature: 'tutor', lane: 'interactive', uid: 1, signal: ac1.signal }, (slot) => {
            runningSignal = slot.signal;
            started.push('a');
            return new Promise<string>((_, reject) => {
                slot.signal.addEventListener('abort', () => reject(new AiAbortedError()));
            });
        });
        const ac2 = new AbortController();
        const p2 = sched.run({ feature: 'tutor', lane: 'interactive', uid: 2, signal: ac2.signal }, async () => {
            started.push('b');
            return 'b';
        });
        p1.catch(() => { });
        p2.catch(() => { });
        await flush();
        expect(started).to.deep.equal(['a']);
        expect(sched.status().queued.total).to.equal(1);
        ac2.abort();
        await flush();
        expect(sched.status().queued.total).to.equal(0);
        let e2: any;
        await p2.catch((e) => { e2 = e; });
        expect(e2.name).to.equal('AbortError');
        ac1.abort();
        let e1: any;
        await p1.catch((e) => { e1 = e; });
        expect(runningSignal!.aborted).to.equal(true);
        expect(e1.name).to.equal('AbortError');
        expect(sched.status().running.total).to.equal(0);
        expect(started).to.deep.equal(['a']);
    });

    it('retries a transient error by re-enqueuing without exceeding the slots', async () => {
        const { sched, clock, metrics } = make({
            slots: 1, interactiveReserve: 0, retryAttempts: 3, retryBaseMs: 1000,
        });
        let attempts = 0;
        const p = sched.run({ feature: 'tutor', lane: 'interactive', uid: 1 }, async () => {
            attempts += 1;
            if (attempts < 3) throw new Error('AI provider returned HTTP 429 from x.');
            return 'ok';
        });
        p.catch(() => { });
        await flush();
        expect(attempts).to.equal(1);
        expect(sched.status().running.total).to.equal(0); // the slot was released for the backoff
        expect(sched.status().cooldownMs).to.be.greaterThan(0);
        await clock.advance(1500);
        expect(attempts).to.equal(2);
        await clock.advance(3000);
        expect(attempts).to.equal(3);
        expect(await p).to.equal('ok');
        expect(metrics.snapshot().total.retries).to.equal(2);
    });

    it('does not retry a call that already emitted text, nor non-transient errors', async () => {
        const { sched } = make({ slots: 1, interactiveReserve: 0, retryAttempts: 3 });
        let attempts = 0;
        const p = sched.run({ feature: 'tutor', lane: 'interactive', uid: 1 }, async (slot) => {
            attempts += 1;
            slot.markEmitted();
            throw new Error('AI provider returned HTTP 500 from x.');
        });
        let err: any;
        await p.catch((e) => { err = e; });
        expect(attempts).to.equal(1);
        expect(err.message).to.match(/500/);
        attempts = 0;
        await sched.run({ feature: 'tutor', lane: 'interactive', uid: 1 }, async () => {
            attempts += 1;
            throw new Error('malformed reply');
        }).catch(() => { });
        expect(attempts).to.equal(1);
    });

    it('waits out a provider rate limit before dispatching anything', async () => {
        const { sched, clock } = make({ slots: 2, interactiveReserve: 0 });
        sched.noteRateLimit(5000);
        const started: string[] = [];
        const a = submit(sched, started, 'a', { feature: 'tutor', lane: 'interactive', uid: 1 });
        await flush();
        expect(started).to.deep.equal([]);
        await clock.advance(6000);
        expect(started).to.deep.equal(['a']);
        a.done.resolve('');
    });

    it('reports queue position and ETA while waiting', async () => {
        const { sched } = make({ slots: 1, interactiveReserve: 0 });
        const started: string[] = [];
        const a = submit(sched, started, 'a', { feature: 'tutor', lane: 'interactive', uid: 1 });
        const seen: { position: number, eta: number }[] = [];
        const p = sched.run({
            feature: 'tutor', lane: 'interactive', uid: 2, onQueue: (s) => seen.push(s),
        }, async () => 'b');
        await flush();
        expect(seen[0].position).to.equal(0);
        expect(seen[0].eta).to.be.greaterThan(0);
        a.done.resolve('');
        expect(await p).to.equal('b');
    });

    it('records metrics and status counters', async () => {
        const { sched, metrics, clock } = make({ slots: 2, interactiveReserve: 0 });
        await sched.run({ feature: 'tutor', lane: 'interactive', uid: 1 }, async (slot) => {
            slot.markEmitted();
            slot.setUsage({
                input: 100, output: 20, cacheRead: 900, cacheWrite: 0,
            });
            clock.now += 800;
            return 'ok';
        });
        const stats = metrics.statsOf('tutor');
        expect(stats.calls).to.equal(1);
        expect(stats.cacheHitRate).to.equal(0.9);
        expect(stats.serviceP50).to.equal(800);
        expect(stats.ttftP50).to.equal(0);
        const st = sched.status();
        expect(st.slots).to.equal(2);
        expect(st.running.total).to.equal(0);
        expect(st.features.tutor.tau).to.be.greaterThan(0);
    });

    it('pass-through mode runs directly when the scheduler is disabled', async () => {
        const { sched } = make({ enabled: false, slots: 1 });
        const started: string[] = [];
        const a = submit(sched, started, 'a', { feature: 'tutor', lane: 'interactive', uid: 1 });
        const b = submit(sched, started, 'b', { feature: 'tutor', lane: 'interactive', uid: 2 });
        await flush();
        expect(started).to.deep.equal(['a', 'b']); // no slot limit in pass-through
        expect(sched.status().running.total).to.equal(0);
        a.done.resolve('');
        b.done.resolve('');
    });

    it('runWhenCapacity resubmits after a refusal', async () => {
        const { sched, clock } = make({ slots: 1, interactiveReserve: 0, queueMax: 1 });
        const started: string[] = [];
        const a = submit(sched, started, 'a', { feature: 'explain', lane: 'background' });
        submit(sched, started, 'b', { feature: 'explain', lane: 'background' });
        const waits: AiBusyError[] = [];
        const p = sched.runWhenCapacity({ feature: 'explain', lane: 'background' }, async () => 'c', { onWait: (e) => waits.push(e) });
        p.catch(() => { });
        await flush();
        expect(waits.length).to.equal(1);
        a.done.resolve('');
        await clock.advance((waits[0].retryAfter + 1) * 1000);
        await clock.advance(1000);
        expect(sched.status().queued.total + sched.status().running.total).to.be.at.least(1);
    });

    it('a student\'s background work never blocks their interactive call (per-user cap is per lane)', async () => {
        const { sched } = make({ slots: 4, interactiveReserve: 0, backgroundMax: 2, userInflight: 1 });
        const started: string[] = [];
        const summary = submit(sched, started, 'summary', { feature: 'summary', lane: 'background', uid: 5 });
        const reply = submit(sched, started, 'reply', { feature: 'tutor', lane: 'interactive', uid: 5 });
        await flush();
        expect(started).to.deep.equal(['summary', 'reply']);
        summary.done.resolve('');
        reply.done.resolve('');
    });

    it('adaptive: grows the limit while the provider keeps up, halves on a 429, never leaves [slots, slotsMax]', async () => {
        const { sched, clock } = make({
            slots: 2, slotsMax: 6, adaptive: true, interactiveReserve: 0, backgroundMax: 6, maxWaitMs: 9999999,
        });
        expect(sched.status().effectiveSlots).to.equal(2);
        // Saturate: keep the queue full and complete calls one by one (no pressure for a minute).
        clock.now += 61000;
        const pending: ReturnType<typeof submit>[] = [];
        const started: string[] = [];
        for (let i = 0; i < 12; i++) pending.push(submit(sched, started, `c${i}`, { feature: 'tutor', lane: 'interactive', uid: 100 + i }));
        await flush();
        expect(started.length).to.equal(2);
        // Four saturated successes → one more slot; the limit climbs while every call succeeds.
        for (let i = 0; i < 8; i++) {
            pending[i].done.resolve('ok');
            await flush();
        }
        expect(sched.status().effectiveSlots).to.equal(4);
        expect(started.length).to.be.greaterThan(2 + 8); // the extra slots were used
        // A rate limit halves the limit (not below the base) and starts the cool-down.
        const flaky = pending[8];
        flaky.done.reject(new Error('AI provider returned HTTP 429 from x.'));
        await flush();
        expect(sched.status().effectiveSlots).to.equal(2);
        expect(sched.status().cooldownMs).to.be.greaterThan(0);
        for (const c of pending) c.done.resolve('ok');
        await clock.advance(120000);
        expect(sched.status().effectiveSlots).to.be.at.least(2);
        expect(sched.status().effectiveSlots).to.be.at.most(6);
    });

    it('adaptive: a timeout steps the limit down and slotsMax caps growth', async () => {
        const { sched, clock } = make({
            slots: 2, slotsMax: 3, adaptive: true, interactiveReserve: 0, backgroundMax: 6, maxWaitMs: 9999999, retryAttempts: 1,
        });
        clock.now += 61000;
        const started: string[] = [];
        const calls: ReturnType<typeof submit>[] = [];
        for (let i = 0; i < 12; i++) calls.push(submit(sched, started, `c${i}`, { feature: 'tutor', lane: 'interactive', uid: 200 + i }));
        await flush();
        for (let i = 0; i < 8; i++) {
            calls[i].done.resolve('ok');
            await flush();
        }
        expect(sched.status().effectiveSlots).to.equal(3); // capped by slotsMax
        calls[8].done.reject(new Error('The AI provider timed out. Please try again.'));
        await flush();
        expect(sched.status().effectiveSlots).to.equal(2); // never below the base
        for (const c of calls) c.done.resolve('ok');
    });

    it('mapLimit bounds concurrency', async () => {
        let inflight = 0;
        let peak = 0;
        const out = await mapLimit([1, 2, 3, 4, 5], 2, async (x) => {
            inflight += 1;
            peak = Math.max(peak, inflight);
            await new Promise<void>((r) => { setImmediate(r); });
            inflight -= 1;
            return x * 2;
        });
        expect(out).to.deep.equal([2, 4, 6, 8, 10]);
        expect(peak).to.equal(2);
    });
});

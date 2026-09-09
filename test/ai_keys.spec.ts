/**
 * API key pool tests (no database, fake clock).
 * Run: node -r @hydrooj/register test/ai_keys.spec.ts
 */
import { expect } from 'chai';
import { describe, it } from 'node:test';
import { keyId, KeyPool, parseKeySpecs } from '../packages/hydrooj/src/lib/ai_keys';

function make() {
    let now = 1_000_000;
    let timers: { at: number, fn: () => void, id: number }[] = [];
    let seq = 0;
    let wakes = 0;
    const pool = new KeyPool({
        now: () => now,
        setTimeout: (fn, ms) => {
            const id = ++seq;
            timers.push({ at: now + ms, fn, id });
            return id;
        },
        clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
        onCapacity: () => { wakes += 1; },
    });
    const advance = (ms: number) => {
        const target = now + ms;
        for (;;) {
            timers.sort((a, b) => a.at - b.at);
            const next = timers[0];
            if (!next || next.at > target) break;
            timers.shift();
            now = next.at;
            next.fn();
        }
        now = target;
    };
    return { pool, advance, wakes: () => wakes, now: () => now };
}

describe('api key pool', () => {
    it('parses the multi-line setting with options, comments and an explicit clear', () => {
        const specs = parseKeySpecs('# pool\nsk-a | label=one | max=4 | rpm=120 | domain=cs101 | weight=2\nsk-b\n\n', { maxInflight: 8 });
        expect(specs).to.deep.equal([
            {
                secret: 'sk-a', maxInflight: 4, rpm: 120, label: 'one', domain: 'cs101', weight: 2,
            },
            { secret: 'sk-b', maxInflight: 8, rpm: undefined },
        ]);
        expect(parseKeySpecs('-')).to.deep.equal([]);
        expect(keyId('sk-a')).to.match(/^[0-9a-f]{8}$/);
    });

    it('spreads load across keys and never exceeds a key\'s limit', () => {
        const { pool } = make();
        pool.configure([{ secret: 'A', maxInflight: 2 }, { secret: 'B', maxInflight: 2 }]);
        const leases = [];
        for (let i = 0; i < 4; i++) leases.push(pool.acquire()!);
        expect(leases.every((l) => !!l)).to.equal(true);
        expect(leases.filter((l) => l.key.secret === 'A').length).to.equal(2);
        expect(leases.filter((l) => l.key.secret === 'B').length).to.equal(2);
        expect(pool.acquire()).to.equal(null); // both full
        expect(pool.capacity()).to.deep.include({ limit: 4, available: 0 });
        leases[0].done('ok');
        expect(pool.capacity().available).to.equal(1);
        expect(pool.acquire()!.key.secret).to.equal('A');
    });

    it('keeps a cached prefix on one key (affinity) and spills only when that key is full', () => {
        const { pool } = make();
        pool.configure(['A', 'B', 'C', 'D'].map((secret) => ({ secret, maxInflight: 2 })));
        const first = pool.acquire({ affinity: 'cs101:tutor:42:abc' })!;
        const second = pool.acquire({ affinity: 'cs101:tutor:42:abc' })!;
        expect(second.key.id).to.equal(first.key.id); // same task → same key while it has room
        const third = pool.acquire({ affinity: 'cs101:tutor:42:abc' })!;
        expect(third.key.id).to.not.equal(first.key.id); // full → the runner-up
        first.done('ok');
        second.done('ok');
        third.done('ok');
        // A different task usually lands elsewhere; whichever it is, it is deterministic.
        const other1 = pool.acquire({ affinity: 'cs101:tutor:7:def' })!;
        const other2 = pool.acquire({ affinity: 'cs101:tutor:7:def' })!;
        expect(other2.key.id).to.equal(other1.key.id);
    });

    it('a 429 cools down and halves THAT key only; capacity returns after Retry-After', () => {
        const { pool, advance, wakes } = make();
        pool.configure([{ secret: 'A', maxInflight: 8 }, { secret: 'B', maxInflight: 8 }]);
        const a = pool.acquire()!;
        a.done('rate_limited', 2000);
        const st = pool.status();
        const ka = st.keys.find((k) => k.label.endsWith(keyId('A')))!;
        expect(ka.health).to.equal('cooling');
        expect(ka.limit).to.equal(4);
        expect(pool.capacity().limit).to.equal(8); // B alone
        expect(pool.capacity().nextFreeAt).to.be.greaterThan(0);
        for (let i = 0; i < 8; i++) expect(pool.acquire()!.key.secret).to.equal('B');
        expect(pool.acquire()).to.equal(null);
        const before = wakes();
        advance(2100);
        expect(pool.status().keys.find((k) => k.label.endsWith(keyId('A')))!.health).to.equal('ok');
        expect(wakes()).to.be.greaterThan(before); // the scheduler was woken
        expect(pool.acquire()!.key.secret).to.equal('A');
    });

    it('disables an invalid key for good and a quota-exhausted key until the hourly reprobe', () => {
        const { pool, advance } = make();
        pool.configure([{ secret: 'A' }, { secret: 'B' }, { secret: 'C' }]);
        pool.acquire()!.done('auth');
        const bad = pool.status().keys.find((k) => k.health === 'disabled')!;
        expect(bad.reason).to.equal('invalid key');
        const q = pool.acquire()!;
        q.done('quota');
        expect(pool.status().usable).to.equal(1);
        advance(60 * 60 * 1000 + 1);
        expect(pool.status().usable).to.equal(2); // the quota key is retried, the invalid one stays out
    });

    it('quarantines a key after five consecutive errors and restores it later', () => {
        const { pool, advance } = make();
        pool.configure([{ secret: 'A' }, { secret: 'B' }]);
        for (let i = 0; i < 5; i++) {
            const l = pool.acquire({ affinity: 'x' })!;
            l.done('error');
        }
        expect(pool.status().keys.some((k) => k.health === 'paused')).to.equal(true);
        advance(5 * 60 * 1000 + 1);
        expect(pool.status().usable).to.equal(2);
    });

    it('honours a per-key rpm budget and tenant-scoped keys', () => {
        const { pool, advance } = make();
        pool.configure([{ secret: 'S', maxInflight: 8, rpm: 2 }, { secret: 'T', maxInflight: 8, domain: 'cs101' }]);
        // Shared key S: two requests per minute, then nothing until the window slides.
        pool.acquire()!.done('ok');
        pool.acquire()!.done('ok');
        expect(pool.acquire()).to.equal(null);
        advance(61000);
        expect(pool.acquire()).to.not.equal(null);
        // Tenant cs101 uses its own key; others never touch it.
        const t = pool.acquire({ domain: 'cs101' })!;
        expect(t.key.secret).to.equal('T');
        expect(pool.status().keys.find((k) => k.domain === 'cs101')!.inflight).to.equal(1);
    });

    it('grows a key\'s limit while it keeps up (AIMD) and keeps state across reconfiguration', () => {
        const { pool } = make();
        pool.configure([{ secret: 'A', maxInflight: 6, startInflight: 2 }]);
        for (let i = 0; i < 8; i++) {
            const l1 = pool.acquire()!;
            const l2 = pool.acquire()!;
            l1.done('ok');
            l2.done('ok');
        }
        const before = pool.status().keys[0].limit;
        expect(before).to.be.greaterThan(2);
        pool.configure([{ secret: 'A', maxInflight: 6, label: 'renamed' }, { secret: 'B' }]);
        expect(pool.status().keys[0].label).to.equal('renamed');
        expect(pool.status().keys[0].limit).to.equal(before); // learned limit survives
        expect(pool.size).to.equal(2);
    });
});

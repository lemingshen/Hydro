/**
 * ai-speedup — TRANSPORT tests: the real lib/ai_tutor.ts callProvider /
 * callProviderWithTools against the fake provider (test/ai_load), for both
 * dialects, streamed and not. No database: a minimal global.Hydro is set
 * up and the settings service is replaced by an in-memory map.
 * Run: node -r @hydrooj/register test/ai_transport.spec.ts
 */
import { expect } from 'chai';
import {
    after, before, describe, it,
} from 'node:test';
import { startFakeProvider } from './ai_load/fake_provider';

(global as any).Hydro = {
    version: {}, model: {}, handler: {}, lib: {}, service: {}, script: {}, module: {}, ui: { manifest: {}, nav: [], template: {} }, locales: {}, error: {},
};
(global as any).addons = {};

const settings: Record<string, any> = {
    'ai_tutor.enabled': true,
    'ai_tutor.provider': 'claude',
    'ai_tutor.api_key': 'test-key',
    'ai_tutor.model': 'fake-model',
    'ai_tutor.timeout': 10,
    'ai_tutor.sched_slots': 4,
    'ai_tutor.sched_interactive_reserve': 2,
    'ai_tutor.sched_background_max': 2,
};
// The settings service is a cordis Service behind a proxy; a static `get`
// on the class shadows the instance method for the whole test.
const system = require('../packages/hydrooj/src/model/system').default;
system.get = (key: string) => settings[key];
system.set = async (key: string, value: any) => { settings[key] = value; };

const aiTutor = require('../packages/hydrooj/src/lib/ai_tutor');
const { aiScheduler } = aiTutor;

const LONG_RULES = `You are a Socratic tutor. ${'Rule '.repeat(400)}`;

describe('ai transport', () => {
    let provider: Awaited<ReturnType<typeof startFakeProvider>>;
    before(async () => {
        provider = await startFakeProvider({ latencyMs: 200, ttftMs: 20 });
        settings['ai_tutor.base_url'] = provider.url;
    });
    after(async () => {
        aiScheduler.reset();
        await provider.close();
    });

    const dialectTest = (preset: string) => it(`streams a reply through the ${preset} dialect and reports cache usage`, async () => {
        settings['ai_tutor.provider'] = preset;
        provider.reset();
        const deltas: string[] = [];
        let usage: any = null;
        const prompt = aiTutor.callProvider;
        const blocks = [{ text: LONG_RULES, stable: true, cache: true }];
        const text1 = await prompt(blocks, [{ role: 'user', content: 'hello' }], {
            onDelta: (t: string) => deltas.push(t),
            onUsage: (u: any) => { usage = u; },
            cacheKey: 'd:tutor:1:abc',
            meta: { feature: 'tutor', lane: 'interactive', uid: 1 },
        });
        expect(deltas.length).to.be.greaterThan(3);
        expect(deltas.join('')).to.equal(text1);
        expect(usage).to.not.equal(null);
        expect(usage.cacheRead).to.equal(0);
        // second student on the same prefix → the provider reports cache reads
        const text2 = await prompt(blocks, [{ role: 'user', content: 'hi there' }], {
            onUsage: (u: any) => { usage = u; },
            cacheKey: 'd:tutor:1:abc',
            meta: { feature: 'tutor', lane: 'interactive', uid: 2 },
        });
        expect(text2).to.equal(text1);
        expect(usage.cacheRead).to.be.greaterThan(0);
        expect(provider.stats.cacheHits).to.equal(1);
        expect(provider.stats.streamed).to.equal(1);
        const stats = aiTutor.aiMetrics.statsOf('tutor');
        expect(stats.calls).to.be.at.least(2);
        expect(stats.ttftP50).to.be.at.least(0);
    });
    for (const preset of ['claude', 'openai', 'deepseek']) dialectTest(preset);

    it('walks the Anthropic max_tokens ladder once, then remembers the accepted ceiling', async () => {
        settings['ai_tutor.provider'] = 'claude';
        settings['ai_tutor.model'] = 'ladder-model';
        provider.reset();
        const text = await aiTutor.callProvider('sys', [{ role: 'user', content: 'x' }], { meta: { feature: 'tutor', lane: 'interactive' } });
        expect(text.length).to.be.greaterThan(10);
        expect(provider.stats.requests).to.equal(2); // 64000 rejected, 32000 accepted
        await aiTutor.callProvider('sys', [{ role: 'user', content: 'y' }], { meta: { feature: 'tutor', lane: 'interactive' } });
        expect(provider.stats.requests).to.equal(3); // the accepted ceiling is reused: one request
        settings['ai_tutor.model'] = 'fake-model';
    });

    it('drops stream_options once a provider rejects it', async () => {
        const p2 = await startFakeProvider({ latencyMs: 50, ttftMs: 5, rejectStreamOptions: true });
        try {
            settings['ai_tutor.provider'] = 'openai';
            settings['ai_tutor.base_url'] = p2.url;
            const deltas: string[] = [];
            await aiTutor.callProvider('sys', [{ role: 'user', content: 'x' }], { onDelta: (t: string) => deltas.push(t), meta: { feature: 'tutor', lane: 'interactive' } });
            expect(deltas.join('').length).to.be.greaterThan(0);
            expect(p2.stats.requests).to.equal(2);
            await aiTutor.callProvider('sys', [{ role: 'user', content: 'y' }], { onDelta: () => { }, meta: { feature: 'tutor', lane: 'interactive' } });
            expect(p2.stats.requests).to.equal(3); // remembered: no second rejection
        } finally {
            settings['ai_tutor.base_url'] = provider.url;
            await p2.close();
        }
    });

    it('never times a call out itself: a silent provider ends the call only by closing the connection', async () => {
        const silent = await startFakeProvider({ latencyMs: 2500, silent: true });
        try {
            settings['ai_tutor.provider'] = 'claude';
            settings['ai_tutor.base_url'] = silent.url;
            settings['ai_tutor.timeout'] = 1; // ignored: no timer of ours
            const t0 = Date.now();
            let err: any;
            await aiTutor.callProvider('sys', [{ role: 'user', content: 'x' }], { onDelta: () => { }, meta: { feature: 'tutor', lane: 'interactive', retry: false } }).catch((e: any) => { err = e; });
            expect(Date.now() - t0).to.be.at.least(2400); // waited for the provider, not for a timer
            expect(err.message).to.match(/empty response|closed the connection/);
        } finally {
            settings['ai_tutor.timeout'] = 10;
            settings['ai_tutor.base_url'] = provider.url;
            await silent.close();
        }
    });

    const heldOpenTest = (preset: string) => it(`finishes at the protocol's end even when the ${preset} connection stays open`, async () => {
        const held = await startFakeProvider({ latencyMs: 100, ttftMs: 10, holdOpenMs: 8000 });
        try {
            settings['ai_tutor.provider'] = preset;
            settings['ai_tutor.base_url'] = held.url;
            settings['ai_tutor.timeout'] = 2; // shorter than the hold: a connection-based reader would time out
            const t0 = Date.now();
            const text = await aiTutor.callProvider('sys', [{ role: 'user', content: 'x' }], { onDelta: () => { }, meta: { feature: 'tutor', lane: 'interactive', retry: false } });
            expect(text.length).to.be.greaterThan(10);
            expect(Date.now() - t0).to.be.lessThan(1500);
        } finally {
            settings['ai_tutor.timeout'] = 10;
            settings['ai_tutor.base_url'] = provider.url;
            await held.close();
        }
    });
    for (const preset of ['claude', 'openai']) heldOpenTest(preset);

    it('treats silence after the stop reason as completion (a gateway that never sends [DONE])', async () => {
        const gw = await startFakeProvider({ latencyMs: 100, ttftMs: 10, omitDoneMarker: true, holdOpenMs: 8000 });
        try {
            // 'deepseek', not 'openai': an earlier test taught this process that the
            // openai preset rejects stream_options, so no usage chunk would come.
            settings['ai_tutor.provider'] = 'deepseek';
            settings['ai_tutor.base_url'] = gw.url;
            settings['ai_tutor.timeout'] = 4;
            const t0 = Date.now();
            let usage: any = null;
            const text = await aiTutor.callProvider('sys', [{ role: 'user', content: 'x' }], { onDelta: () => { }, onUsage: (u: any) => { usage = u; }, meta: { feature: 'tutor', lane: 'interactive', retry: false } });
            expect(text.length).to.be.greaterThan(10);
            expect(usage).to.not.equal(null); // the usage chunk after the stop reason was still read
            expect(Date.now() - t0).to.be.lessThan(3000); // ~1.5 s of grace, not the 4 s idle guard or the hold
        } finally {
            settings['ai_tutor.timeout'] = 10;
            settings['ai_tutor.base_url'] = provider.url;
            await gw.close();
        }
    });

    it('a long reply is never cut off; a stream the provider drops keeps what was generated', async () => {
        const slow = await startFakeProvider({ latencyMs: 2500, ttftMs: 20 });
        const dropped = await startFakeProvider({ latencyMs: 500, ttftMs: 20, stallAfterWords: 3, stallMs: 1500 });
        try {
            settings['ai_tutor.provider'] = 'openai';
            settings['ai_tutor.timeout'] = 1; // ignored: no timer of ours
            settings['ai_tutor.base_url'] = slow.url;
            const deltas: string[] = [];
            const text = await aiTutor.callProvider('sys', [{ role: 'user', content: 'x' }], { onDelta: (t: string) => deltas.push(t), meta: { feature: 'tutor', lane: 'interactive', retry: false } });
            expect(deltas.join('')).to.equal(text); // 2.5 s of tokens: fine
            settings['ai_tutor.base_url'] = dropped.url;
            const t0 = Date.now();
            const partial = await aiTutor.callProvider('sys', [{ role: 'user', content: 'x' }], { onDelta: () => { }, meta: { feature: 'tutor', lane: 'interactive', retry: false } });
            expect(partial.split(/\s+/).length).to.equal(3); // the three words the provider sent (and billed) are kept
            expect(Date.now() - t0).to.be.at.least(1400); // the provider closed the connection; we waited for it
        } finally {
            settings['ai_tutor.timeout'] = 10;
            settings['ai_tutor.base_url'] = provider.url;
            await slow.close();
            await dropped.close();
        }
    });

    it('aborts a streamed call when the caller goes away and frees the slot', async () => {
        settings['ai_tutor.provider'] = 'openai';
        const slow = await startFakeProvider({ latencyMs: 2000, ttftMs: 10 });
        try {
            settings['ai_tutor.base_url'] = slow.url;
            const ac = new AbortController();
            let err: any;
            const p = aiTutor.callProvider('sys', [{ role: 'user', content: 'x' }], {
                onDelta: () => setTimeout(() => ac.abort(), 30), signal: ac.signal, meta: { feature: 'tutor', lane: 'interactive', uid: 9 },
            });
            await p.catch((e: any) => { err = e; });
            expect(err.name).to.equal('AbortError');
            await new Promise<void>((r) => { setTimeout(r, 50); });
            expect(aiScheduler.status().running.total).to.equal(0);
        } finally {
            settings['ai_tutor.base_url'] = provider.url;
            await slow.close();
        }
    });

    it('retries a 429 through the scheduler with a cool-down', async () => {
        const flaky = await startFakeProvider({ latencyMs: 30, rate429: 1 });
        try {
            settings['ai_tutor.provider'] = 'claude';
            settings['ai_tutor.base_url'] = flaky.url;
            const start = Date.now();
            let err: any;
            // rate429 = 1: every attempt fails; 2 attempts with a 100 ms base
            await aiTutor.scheduled({ feature: 'grade', lane: 'background', retry: { attempts: 2, baseMs: 100 } }, () => aiTutor.callProvider('sys', [{ role: 'user', content: 'x' }])).catch((e: any) => { err = e; });
            expect(err.message).to.match(/429/);
            expect(flaky.stats.requests).to.equal(2);
            expect(Date.now() - start).to.be.at.least(75);
            expect(aiTutor.aiMetrics.snapshot().total.retries).to.be.at.least(1);
        } finally {
            settings['ai_tutor.base_url'] = provider.url;
            await flaky.close();
            aiScheduler.reset();
        }
    });

    it('uses a pool of keys concurrently: per-key limits respected, a dead key sidelined, a 429 confined to its key', async () => {
        // Five keys, each allowing 3 concurrent requests at the provider; one of them is invalid.
        const keys = ['sk-1', 'sk-2', 'sk-3', 'sk-4', 'sk-5'];
        const strict = await startFakeProvider({ latencyMs: 400, ttftMs: 10, perKeyLimit: 3, invalidKeys: ['sk-5'] });
        const prevSlots = settings['ai_tutor.sched_slots'];
        const prevMax = settings['ai_tutor.sched_slots_max'];
        try {
            settings['ai_tutor.provider'] = 'openai';
            settings['ai_tutor.base_url'] = strict.url;
            // The keys go in the ONE API-key box, one per line (max=4 asks for one more than the provider allows: the pool must learn).
            settings['ai_tutor.api_key'] = keys.map((k) => `${k} | max=4`).join('\n');
            settings['ai_tutor.sched_slots'] = 24;
            settings['ai_tutor.sched_slots_max'] = 24;
            settings['ai_tutor.sched_interactive_reserve'] = 0;
            aiScheduler.reset();
            aiTutor.keyPool.reset();
            const t0 = Date.now();
            const results = await Promise.all(Array.from({ length: 24 }, (_, i) => aiScheduler.run(
                { feature: 'tutor', lane: 'interactive', uid: 500 + i },
                () => aiTutor.callProvider('sys', [{ role: 'user', content: `q${i}` }], { cacheKey: `d:tutor:${i % 4}:x` }),
            )));
            const elapsed = Date.now() - t0;
            expect(results.every((r) => r.length > 10)).to.equal(true);
            const st = aiTutor.keyPool.status();
            const dead = st.keys.find((k) => k.id === aiTutor.keyPool.status().keys.find((x) => x.health === 'disabled')?.id);
            expect(dead && dead.reason).to.equal('invalid key');
            expect(st.usable).to.equal(4);
            // Real concurrency across keys: 24 calls of 400 ms through 4 keys × 3 finished in a few rounds, not 24 × 400 ms.
            expect(strict.stats.peakInflight).to.be.at.least(6);
            expect(elapsed).to.be.lessThan(24 * 400);
            // Every valid key was used, and none beyond what the provider allows for long (429s were absorbed per key).
            const used = Object.keys(strict.stats.byKey).filter((k) => k !== 'sk-5');
            expect(used.length).to.equal(4);
            expect(aiScheduler.status().cooldownMs).to.equal(0); // no process-wide pause for one key's 429
            expect(aiScheduler.status().pool!.keys).to.equal(5);
        } finally {
            settings['ai_tutor.api_key'] = 'test-key';
            settings['ai_tutor.sched_slots'] = prevSlots;
            settings['ai_tutor.sched_slots_max'] = prevMax;
            settings['ai_tutor.sched_interactive_reserve'] = 2;
            settings['ai_tutor.base_url'] = provider.url;
            aiTutor.keyPool.reset();
            aiScheduler.reset();
            await strict.close();
        }
    });

    it('remembers the keys per provider: switching the provider brings its own keys back', async () => {
        const saved = { ...settings };
        try {
            // Root saves DeepSeek keys, then switches to OpenAI with new keys, then back to DeepSeek with the box left blank.
            settings['ai_tutor.provider'] = 'deepseek';
            settings['ai_tutor.api_key'] = 'ds-1\nds-2';
            await aiTutor.rememberProviderKeys({ ai_tutor: { provider: 'deepseek', api_key: 'ds-1\nds-2', model: 'x' } });
            expect(aiTutor.effectiveKeyText()).to.equal('ds-1\nds-2');
            settings['ai_tutor.provider'] = 'openai';
            settings['ai_tutor.api_key'] = 'oa-1';
            await aiTutor.rememberProviderKeys({ ai_tutor: { provider: 'openai', api_key: 'oa-1' } });
            expect(aiTutor.effectiveKeyText()).to.equal('oa-1');
            // Back to DeepSeek, box left blank (the form posts '' and the secret keeps the stored value 'oa-1').
            settings['ai_tutor.provider'] = 'deepseek';
            await aiTutor.rememberProviderKeys({ ai_tutor: { provider: 'deepseek', api_key: '' } });
            expect(aiTutor.effectiveKeyText()).to.equal('ds-1\nds-2'); // DeepSeek's own keys, not OpenAI's
            aiTutor.keyPool.reset();
            expect(aiTutor.ensureKeyPool().size).to.equal(2);
            // A provider never given keys has none (and is reported as not configured).
            settings['ai_tutor.provider'] = 'claude';
            expect(aiTutor.effectiveKeyText().trim()).to.equal('');
            expect(aiTutor.tutorConfigured()).to.equal(false);
            // The page shows DeepSeek's keys, root changes the dropdown to Claude on the SAME form and saves:
            // the box (still DeepSeek's text, api_key_provider=deepseek) must not be stored as Claude's keys.
            await aiTutor.rememberProviderKeys({ ai_tutor: { provider: 'claude', api_key: 'ds-1\nds-2', api_key_provider: 'deepseek' } });
            expect(aiTutor.providerKeyMap().claude).to.equal(undefined);
            expect(aiTutor.providerKeyMap().deepseek).to.equal('ds-1\nds-2');
            // An emptied box on a page that showed the keys clears that provider's keys.
            settings['ai_tutor.provider'] = 'openai';
            settings['ai_tutor.api_key'] = '';
            await aiTutor.rememberProviderKeys({ ai_tutor: { provider: 'openai', api_key: '', api_key_provider: 'openai' } });
            expect(aiTutor.providerKeyMap().openai).to.equal(undefined);
            expect(aiTutor.effectiveKeyText().trim()).to.equal('');
        } finally {
            for (const k of Object.keys(settings)) delete settings[k];
            Object.assign(settings, saved);
            aiTutor.keyPool.reset();
        }
    });

    it('holds one slot across a tool loop and streams only text rounds', async () => {
        settings['ai_tutor.provider'] = 'openai';
        provider.reset();
        const deltas: string[] = [];
        const out = await aiTutor.scheduled({ feature: 'assistant', lane: 'interactive', uid: 3 }, async () => {
            const r1 = await aiTutor.callProviderWithTools('sys', [{ role: 'user', content: 'plan my week' }], [{ name: 'my_activities', description: 'x', parameters: { type: 'object', properties: {} } }], {
                onDelta: (t: string) => deltas.push(t),
            });
            expect(aiScheduler.status().running.total).to.equal(1);
            return r1;
        });
        expect(out.toolCalls).to.deep.equal([]);
        expect(deltas.join('')).to.equal(out.text);
        expect(provider.stats.requests).to.equal(1);
    });
});

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
system.set = async () => { };

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

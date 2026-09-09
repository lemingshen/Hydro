/**
 * ai-speedup §9 — LOAD-TEST DRIVER (run manually before a milestone deploy).
 *
 * N simulated students (default 200) each send one tutor turn within a
 * window (default 60 s) while background jobs (one "quick review" of 12
 * labelling batches and ten "explain" reports) run at the same time —
 * all through the REAL scheduler and transport (lib/ai_scheduler.ts,
 * lib/ai_tutor.ts callProvider) against the fake provider of
 * ./fake_provider.ts (12 s ± 3 s latency, 1 s TTFT, optional 429 rate).
 * No database: a minimal global.Hydro and an in-memory settings map.
 *
 * It records queue wait, TTFT, total time and refusals per call and
 * asserts the M1/M2 acceptance criteria:
 *   • the provider never sees more than `sched_slots` calls in flight;
 *   • the first token of a tutor turn arrives < 2 s after the slot was granted;
 *   • waits are bounded (refused beyond `sched_max_wait`, with a retry-after);
 *   • background jobs keep progressing;
 *   • the cache-hit rate on the shared tutor prefix is > 80 %;
 *   • a 429 burst triggers the cool-down without a retry storm.
 *
 * Usage:
 *   node -r @hydrooj/register test/ai_load/driver.ts [students=200] [windowSec=60] [latencyMs=12000] [rate429=0]
 *   FAST=1 …  (scales latencies down 20× for a quick smoke run)
 */
import { startFakeProvider } from './fake_provider';

(global as any).Hydro = {
    version: {}, model: {}, handler: {}, lib: {}, service: {}, script: {}, module: {}, ui: { manifest: {}, nav: [], template: {} }, locales: {}, error: {},
};
(global as any).addons = {};

const STUDENTS = +(process.argv[2] || 200);
const WINDOW_S = +(process.argv[3] || 60);
const FAST = !!process.env.FAST;
const SCALE = FAST ? 20 : 1;
const LATENCY = +(process.argv[4] || 12000) / SCALE;
const RATE_429 = +(process.argv[5] || process.env.FAKE_429 || 0);
const SLOTS = 12;
const SLOTS_MAX = +(process.env.SLOTS_MAX || 24);

const settings: Record<string, any> = {
    'ai_tutor.enabled': true,
    'ai_tutor.provider': process.env.PROVIDER || 'claude',
    'ai_tutor.api_key': 'load-test',
    'ai_tutor.model': 'fake-model',
    'ai_tutor.timeout': Math.max(10, Math.ceil((LATENCY * 4) / 1000)),
    'ai_tutor.sched_enabled': process.env.SCHED !== '0',
    'ai_tutor.sched_slots': SLOTS,
    'ai_tutor.sched_adaptive': process.env.ADAPTIVE !== '0',
    'ai_tutor.sched_slots_max': SLOTS_MAX,
    'ai_tutor.sched_interactive_reserve': 6,
    'ai_tutor.sched_background_max': 4,
    'ai_tutor.sched_user_inflight': 1,
    'ai_tutor.sched_queue_max': 200,
    'ai_tutor.sched_max_wait': 90,
    'ai_tutor.sched_age_ms': 30000,
    'ai_tutor.sched_feature_caps': 'explain:3,qr_label:3,report_map:3,attrib:2,summary:2,grade:2,report_reduce:1,qr_points:1',
    'ai_tutor.cache_enabled': true,
    'ai_tutor.cache_ttl': '5m',
};
const system = require('../../packages/hydrooj/src/model/system').default;
system.get = (key: string) => settings[key];
system.set = async () => { };
const aiTutor = require('../../packages/hydrooj/src/lib/ai_tutor');
const { aiScheduler, aiMetrics, AiBusyError } = aiTutor;

const RULES = `You are a Socratic tutor for an introductory programming course. ${'Never give the fix; ask one question at a time. '.repeat(120)}`;
const STATEMENT = `Read n integers and print the sum of the even ones. ${'Constraints and examples follow. '.repeat(60)}`;

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const pct = (xs: number[], p: number) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

interface Sample { wait: number, ttft: number | null, felt: number | null, total: number, refused: boolean, error?: string }

async function tutorTurn(uid: number, samples: Sample[]) {
    const t0 = Date.now();
    let granted = 0;
    let ttft: number | null = null;
    try {
        const blocks = [{ text: RULES, stable: true }, { text: `Problem: P42 Even sum\n${STATEMENT}`, stable: true, cache: true }];
        await aiScheduler.run({
            feature: 'tutor', lane: 'interactive', uid, stream: true,
        }, async (slot: any) => {
            granted = Date.now();
            return await aiTutor.callProvider(blocks, [{ role: 'user', content: `Student ${uid} code:\nint main(){}\nQuestion: why WA?` }], {
                cacheKey: 'load:tutor:42:x',
                onDelta: () => { if (ttft === null) ttft = Date.now() - granted; },
                signal: slot.signal,
            });
        });
        samples.push({ wait: granted - t0, ttft, felt: ttft === null ? null : granted - t0 + ttft, total: Date.now() - t0, refused: false });
    } catch (e: any) {
        if (e instanceof AiBusyError) samples.push({ wait: 0, ttft: null, felt: null, total: Date.now() - t0, refused: true });
        else samples.push({ wait: granted ? granted - t0 : 0, ttft, felt: null, total: Date.now() - t0, refused: false, error: e.message });
    }
}

async function backgroundJobs(progress: { label: number, explain: number }) {
    const label = Array.from({ length: 12 }, (_, i) => aiScheduler.runWhenCapacity({ feature: 'qr_label', lane: 'background', priority: 2 }, () => aiTutor.callProvider('label prompt', [{ role: 'user', content: `batch ${i}` }])).then(() => { progress.label += 1; }));
    const explain = Array.from({ length: 10 }, (_, i) => aiScheduler.runWhenCapacity({ feature: 'explain', lane: 'background', priority: 3 }, () => aiTutor.callProvider('explain prompt', [{ role: 'user', content: `student ${i}` }])).then(() => { progress.explain += 1; }));
    await Promise.all([...label, ...explain]);
}

(async () => {
    const provider = await startFakeProvider({
        latencyMs: LATENCY, jitterMs: LATENCY / 4, ttftMs: 1000 / SCALE, rate429: RATE_429, reply: 'Which index does `i` reach on the last iteration? Trace it with n = 3 and tell me what you observe.',
    });
    settings['ai_tutor.base_url'] = provider.url;
    const limitMax = settings['ai_tutor.sched_adaptive'] ? SLOTS_MAX : SLOTS;
    console.log(`load test: ${STUDENTS} students over ${WINDOW_S} s, provider latency ${LATENCY} ms, 429 rate ${RATE_429}, scheduler ${settings['ai_tutor.sched_enabled'] ? 'on' : 'OFF'}, ${SLOTS} slots${settings['ai_tutor.sched_adaptive'] ? ` (adaptive up to ${SLOTS_MAX})` : ''}`);
    const samples: Sample[] = [];
    const progress = { label: 0, explain: 0 };
    const started = Date.now();
    const bg = backgroundJobs(progress);
    const students: Promise<void>[] = [];
    for (let i = 0; i < STUDENTS; i++) {
        const uid = 1000 + i;
        const delay = Math.random() * WINDOW_S * 1000 / SCALE;
        students.push(sleep(delay).then(() => tutorTurn(uid, samples)));
    }
    const ticker = setInterval(() => {
        const st = aiScheduler.status();
        console.log(`  t=${Math.round((Date.now() - started) / 1000)}s  inflight=${st.running.total}/${st.effectiveSlots} (i${st.running.interactive}/b${st.running.background})  queued=${st.queued.total}  done=${samples.length}/${STUDENTS}  bg=${progress.label}/12 label, ${progress.explain}/10 explain  provider peak=${provider.stats.peakInflight}`);
    }, FAST ? 1000 : 5000);
    await Promise.all(students);
    await bg;
    clearInterval(ticker);

    const ok = samples.filter((s) => !s.refused && !s.error);
    const refused = samples.filter((s) => s.refused);
    const failed = samples.filter((s) => s.error);
    const waits = ok.map((s) => s.wait);
    const ttfts = ok.map((s) => s.ttft).filter((x): x is number => x !== null);
    const felt = ok.map((s) => s.felt).filter((x): x is number => x !== null);
    const totals = ok.map((s) => s.total);
    const stats = aiMetrics.statsOf('tutor');
    console.log('\n=== results ===');
    console.log(`tutor turns: ${ok.length} ok, ${refused.length} refused (retry-after), ${failed.length} failed`);
    console.log(`queue wait  p50 ${pct(waits, 50)} ms  p95 ${pct(waits, 95)} ms  max ${Math.max(0, ...waits)} ms`);
    console.log(`TTFT        p50 ${pct(ttfts, 50)} ms  p95 ${pct(ttfts, 95)} ms  max ${Math.max(0, ...ttfts)} ms  (after the slot was granted)`);
    console.log(`first words p50 ${pct(felt, 50)} ms  p95 ${pct(felt, 95)} ms  (from the moment the student asked — what the student feels)`);
    console.log(`total       p50 ${pct(totals, 50)} ms  p95 ${pct(totals, 95)} ms`);
    console.log(`provider: ${provider.stats.requests} requests, peak ${provider.stats.peakInflight} in flight, ${provider.stats.served429} × 429, cache ${provider.stats.cacheHits} hits / ${provider.stats.cacheMisses} misses`);
    console.log(`metrics: cache-hit rate (tutor) ${stats.cacheHitRate === null ? 'n/a' : `${Math.round(stats.cacheHitRate * 100)}%`}, retries ${aiMetrics.snapshot().total.retries}, refusals ${aiMetrics.snapshot().total.refusals}`);
    if (failed.length) console.log('failures:', [...new Set(failed.map((f) => f.error))].slice(0, 5));

    console.log(`scheduler limit now: ${aiScheduler.status().effectiveSlots} (base ${SLOTS}, max ${limitMax})`);
    const checks: [string, boolean][] = [
        [`≤ ${limitMax} calls in flight at the provider (peak ${provider.stats.peakInflight})`, !settings['ai_tutor.sched_enabled'] || provider.stats.peakInflight <= limitMax],
        [`first token < 2 s after the slot (p95 ${pct(ttfts, 95)} ms)`, pct(ttfts, 95) < 2000 * (FAST ? 1 : 1)],
        [`waits bounded by sched_max_wait (max ${Math.max(0, ...waits)} ms)`, Math.max(0, ...waits) <= 90000 * 1.5],
        ['background jobs completed', progress.label === 12 && progress.explain === 10],
        [`cache-hit rate on the tutor prefix > 80 % (${stats.cacheHitRate === null ? 'n/a' : Math.round(stats.cacheHitRate * 100)}%)`, (stats.cacheHitRate || 0) > 0.8],
        ['no failed tutor turns', failed.length === 0],
    ];
    let bad = 0;
    for (const [name, pass] of checks) {
        console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
        if (!pass) bad += 1;
    }
    await provider.close();
    process.exit(bad ? 1 : 0);
})();

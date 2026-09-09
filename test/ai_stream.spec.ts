/**
 * ai-speedup WP2 / WP3 / WP4 — streaming, prompt-shape and summary tests (no database).
 * Run: node -r @hydrooj/register test/ai_stream.spec.ts
 */
import { expect } from 'chai';
import { describe, it } from 'node:test';
import { formatCallLine, mergeStreamUsage, normalizeUsage } from '../packages/hydrooj/src/lib/ai_metrics';
import {
    buildPrompt, codeDelta, estimateTokens, limitSummary, normalizePrefixText, prefixText, stableList, summaryDue, wordCount,
} from '../packages/hydrooj/src/lib/ai_prompt';
import {
    AiStreamRegistry, decodeAnthropicEvent, decodeOpenAIEvent, JsonFieldStreamer, SseParser, StreamSignal, TextSpanStreamer,
} from '../packages/hydrooj/src/lib/ai_stream';
import { TypewriterPacer } from '../packages/ui-default/components/aistream/pacer';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const ANTHROPIC_SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":25,"cache_read_input_tokens":1200,"cache_creation_input_tokens":0,"output_tokens":1}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: ping',
    'data: {"type": "ping"}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", world"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
].join('\n');

const OPENAI_SSE = [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
    '',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"thinking about it"},"finish_reason":null}]}',
    '',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
    '',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
    '',
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":1300,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":1024}}}',
    '',
    'data: [DONE]',
    '',
].join('\n');

function decodeAll(sse: string, decode: (ev: { event: string, data: string }) => StreamSignal[], chunk = 7): StreamSignal[] {
    const parser = new SseParser();
    const out: StreamSignal[] = [];
    // Split the frames at arbitrary byte positions (a real socket does).
    for (let i = 0; i < sse.length; i += chunk) for (const ev of parser.feed(sse.slice(i, i + chunk))) out.push(...decode(ev));
    for (const ev of parser.end()) out.push(...decode(ev));
    return out;
}
const textOf = (signals: StreamSignal[]) => signals.filter((s) => s.kind === 'text').map((s: any) => s.text).join('');

describe('sse parsing', () => {
    it('reassembles frames split across reads and handles CRLF', () => {
        const parser = new SseParser();
        const events = [...parser.feed('event: a\r\ndata: 1\r\n\r\nda'), ...parser.feed('ta: 2\n\n'), ...parser.end()];
        expect(events).to.deep.equal([{ event: 'a', data: '1' }, { event: 'message', data: '2' }]);
    });

    it('joins multi-line data and ignores comments', () => {
        const parser = new SseParser();
        const events = parser.feed(': keep-alive\ndata: x\ndata: y\n\n');
        expect(events).to.deep.equal([{ event: 'message', data: 'x\ny' }]);
    });

    it('decodes the Anthropic dialect (text, usage, stop, done)', () => {
        for (const chunk of [1, 7, 64, 4096]) {
            const signals = decodeAll(ANTHROPIC_SSE, decodeAnthropicEvent, chunk);
            expect(textOf(signals)).to.equal('Hello, world');
            // Anthropic reports cumulative figures across message_start / message_delta.
            const usage = signals.filter((s) => s.kind === 'usage').map((s: any) => normalizeUsage(s.usage)).reduce(mergeStreamUsage, null);
            expect(usage).to.deep.equal({
                input: 25, output: 12, cacheRead: 1200, cacheWrite: 0,
            });
            expect(signals.some((s) => s.kind === 'stop' && s.reason === 'end_turn')).to.equal(true);
            expect(signals[signals.length - 1].kind).to.equal('done');
        }
    });

    it('decodes the OpenAI dialect (reasoning ticks, text, usage, [DONE])', () => {
        for (const chunk of [3, 11, 512]) {
            const signals = decodeAll(OPENAI_SSE, decodeOpenAIEvent, chunk);
            expect(textOf(signals)).to.equal('Hello');
            expect(signals.filter((s) => s.kind === 'thinking').length).to.equal(1);
            const usage = signals.filter((s) => s.kind === 'usage').map((s: any) => normalizeUsage(s.usage))[0];
            expect(usage).to.deep.equal({
                input: 276, output: 7, cacheRead: 1024, cacheWrite: 0,
            });
            expect(signals[signals.length - 1].kind).to.equal('done');
        }
    });

    it('decodes tool calls in both dialects', () => {
        const oa = decodeOpenAIEvent({ event: 'message', data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"my_map","arguments":"{\\"a\\":"}}]}}]}' });
        expect(oa[0]).to.deep.equal({ kind: 'tool_start', index: 0, id: 'call_1', name: 'my_map' });
        expect(oa[1]).to.deep.equal({ kind: 'tool_args', index: 0, partial: '{"a":' });
        const an1 = decodeAnthropicEvent({ event: 'content_block_start', data: '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"task","input":{}}}' });
        expect(an1[0]).to.deep.equal({ kind: 'tool_start', index: 1, id: 'tu_1', name: 'task' });
        const an2 = decodeAnthropicEvent({ event: 'content_block_delta', data: '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"pid\\": 7}"}}' });
        expect(an2[0]).to.deep.equal({ kind: 'tool_args', index: 1, partial: '{"pid": 7}' });
    });

    it('surfaces error events and ignores unknown ones', () => {
        expect(decodeAnthropicEvent({ event: 'error', data: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }))
            .to.deep.equal([{ kind: 'error', message: 'Overloaded' }]);
        expect(decodeOpenAIEvent({ event: 'message', data: '{"error":{"message":"rate limited"}}' })).to.deep.equal([{ kind: 'error', message: 'rate limited' }]);
        expect(decodeAnthropicEvent({ event: 'weird', data: '{"type":"weird"}' })).to.deep.equal([]);
        expect(decodeOpenAIEvent({ event: 'message', data: 'not json' })).to.deep.equal([]);
    });
});

describe('json field streamer', () => {
    it('streams the reply field as it arrives, decoding escapes', () => {
        const out: string[] = [];
        const st = new JsonFieldStreamer('reply', (t) => out.push(t));
        const full = '```json\n{"resolved": false, "reply": "Look at line 3:\\nwhat does `i` equal?\\u00e9 \\"quoted\\"", "level": 2}\n```';
        for (let i = 0; i < full.length; i += 5) st.feed(full.slice(i, i + 5));
        expect(out.join('')).to.equal('Look at line 3:\nwhat does `i` equal?é "quoted"');
        expect(st.value).to.equal(out.join(''));
    });

    it('waits for a split escape and key', () => {
        const out: string[] = [];
        const st = new JsonFieldStreamer('reply', (t) => out.push(t));
        st.feed('{"re');
        st.feed('ply": "a\\');
        expect(out.join('')).to.equal('a');
        st.feed('nb"}');
        expect(out.join('')).to.equal('a\nb');
    });
});

describe('text span streamer', () => {
    it('streams the REPLY line of a plain-text reply and stops at the body markers', () => {
        const out: string[] = [];
        const st = new TextSpanStreamer(/^[ \t]*REPLY:[ \t]*/im, /\r?\n|TITLE:|<<<BODY/, (t) => out.push(t));
        const full = 'REPLY: I tightened the constraints as you asked.\nTITLE: Even sum\n<<<BODY\nbody text\nBODY>>>';
        for (let i = 0; i < full.length; i += 4) st.feed(full.slice(i, i + 4));
        st.finish();
        expect(out.join('')).to.equal('I tightened the constraints as you asked.');
        const short = new TextSpanStreamer(/^[ \t]*REPLY:[ \t]*/im, /\r?\n|TITLE:|<<<BODY/, (t) => out.push(t));
        out.length = 0;
        short.feed('REPLY: Just a question, no change');
        expect(out.join('').length).to.be.lessThan('Just a question, no change'.length); // the tail is held back…
        short.finish();
        expect(out.join('')).to.equal('Just a question, no change'); // …until the reply is known to be complete
    });
});

describe('typewriter pacer (browser reveal)', () => {
    /** A fake clock: timers fire in order when advanced. */
    const clock = () => {
        let now = 0;
        let timers: { at: number, fn: () => void }[] = [];
        return {
            now: () => now,
            setTimeout: (fn: () => void, ms: number) => {
                const t = { at: now + ms, fn };
                timers.push(t);
                return t;
            },
            clearTimeout: (t: any) => { timers = timers.filter((x) => x !== t); },
            advance: (ms: number) => {
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
            },
        };
    };

    it('reveals a burst word by word and drains after finish', () => {
        const c = clock();
        const pieces: string[] = [];
        const pacer = new TypewriterPacer((piece) => pieces.push(piece), { tickMs: 50, minChars: 3, ratio: 0.12, maxCatchupMs: 1000 }, c.setTimeout, c.clearTimeout, c.now);
        const text = 'Good reasoning: the loop reads each number and overwrites m, so memory stays constant. What happens at the last iteration?';
        pacer.push(text); // one burst, as a buffering proxy would deliver it
        c.advance(50);
        expect(pieces.length).to.equal(1);
        expect(pieces[0].length).to.be.lessThan(text.length / 3); // not the whole burst at once
        expect(pieces[0].endsWith(' ') || pieces[0].length === text.length).to.equal(true); // a word boundary
        c.advance(300);
        expect(pieces.length).to.be.greaterThan(3);
        let finished = false;
        pacer.finish(() => { finished = true; });
        c.advance(1100);
        expect(pieces.join('')).to.equal(text);
        expect(finished).to.equal(true);
        expect(pacer.pending).to.equal(0);
    });

    it('keeps up with a steady stream and preserves order', () => {
        const c = clock();
        const pieces: string[] = [];
        const pacer = new TypewriterPacer((piece) => pieces.push(piece), { tickMs: 50 }, c.setTimeout, c.clearTimeout, c.now);
        const words = 'one two three four five six seven eight nine ten'.split(' ').map((w) => `${w} `);
        for (const w of words) {
            pacer.push(w);
            c.advance(60);
        }
        pacer.finish(() => { });
        c.advance(1500);
        expect(pieces.join('')).to.equal(words.join(''));
        expect(pieces.length).to.be.at.least(words.length - 1);
    });

    it('finish with nothing pending calls back at once; reset discards the backlog', () => {
        const c = clock();
        const pieces: string[] = [];
        const pacer = new TypewriterPacer((piece) => pieces.push(piece), { tickMs: 50 }, c.setTimeout, c.clearTimeout, c.now);
        let called = 0;
        pacer.finish(() => { called += 1; });
        expect(called).to.equal(1);
        const p2 = new TypewriterPacer((piece) => pieces.push(piece), { tickMs: 50 }, c.setTimeout, c.clearTimeout, c.now);
        p2.push('half a sentence that was not the answer');
        p2.reset();
        c.advance(500);
        expect(pieces).to.deep.equal([]);
        expect(p2.revealed).to.equal('');
    });
});

describe('stream registry', () => {
    it('replays the buffer from an offset and finishes once', () => {
        let now = 1000;
        const reg = new AiStreamRegistry(() => now);
        const e = reg.create(42, { feature: 'tutor', lane: 'interactive' });
        const seen: any[] = [];
        const unsub = reg.subscribe(e.id, (ev) => seen.push(ev));
        reg.setQueue(e.id, { position: 2, eta: 5000 });
        reg.append(e.id, 'Hel');
        reg.append(e.id, 'lo');
        expect(reg.read(e.id, 0)!.text).to.equal('Hello');
        expect(reg.read(e.id, 3)!.text).to.equal('lo');
        expect(reg.read(e.id, 3)!.length).to.equal(5);
        reg.finish(e.id, { reply: 'Hello' });
        reg.finish(e.id, { reply: 'twice' });
        expect(seen.map((x) => x.type)).to.deep.equal(['queue', 'delta', 'delta', 'done']);
        expect(reg.read(e.id, 0)!.result).to.deep.equal({ reply: 'Hello' });
        expect(reg.ownedBy(e.id, 42)).to.equal(true);
        expect(reg.ownedBy(e.id, 43)).to.equal(false);
        unsub();
        now += 11 * 60 * 1000;
        expect(reg.sweep().expired).to.equal(1);
        expect(reg.get(e.id)).to.equal(undefined);
    });

    it('aborts an abandoned interactive stream after the grace period', () => {
        let now = 1000;
        const reg = new AiStreamRegistry(() => now);
        const e = reg.create(1, { feature: 'tutor', lane: 'interactive' });
        const bg = reg.create(1, { feature: 'explain', lane: 'background' });
        now += 60 * 1000;
        const r = reg.sweep();
        expect(r.aborted).to.equal(1);
        expect(e.controller.signal.aborted).to.equal(true);
        expect(bg.controller.signal.aborted).to.equal(false);
        // failing after an abort is a no-op only once finished; here it records the error
        reg.fail(e.id, new Error('cancelled'));
        expect(reg.read(e.id, 0)!.state).to.equal('error');
        reg.clear();
    });
});

describe('prompt shape (caching)', () => {
    const task = (extra = {}) => ({
        domainId: 'cs101', pid: 42, title: 'Sum of digits', label: 'P42', statement: 'Given n, print the sum of its digits.\r\n\r\n\r\n  ', limits: { time: 1000, memory: 256 }, knowledgePoints: ['loops', 'Integer division', 'loops'], ...extra,
    });

    it('produces byte-identical prefixes for two students on the same task', () => {
        const a = buildPrompt({ feature: 'tutor', rules: 'RULES ', task: task(), variable: [{ role: 'user', content: 'student A code' }] });
        const b = buildPrompt({ feature: 'tutor', rules: 'RULES', task: task({ knowledgePoints: ['Integer division', 'loops'] }), variable: [{ role: 'user', content: 'student B code' }] });
        expect(prefixText(a.prefix)).to.equal(prefixText(b.prefix));
        expect(a.cacheKey).to.equal(b.cacheKey);
        expect(a.cacheKey).to.match(/^cs101:tutor:42:[0-9a-f]{10}$/);
        expect(a.variable).to.not.deep.equal(b.variable);
    });

    it('places the breakpoint on the last stable block and a second one on the summary', () => {
        const p = buildPrompt({ feature: 'tutor', rules: 'RULES', task: task(), summary: 'goal: x', variable: [] });
        expect(p.prefix.map((b) => [b.stable, !!b.cache])).to.deep.equal([[true, false], [true, true], [false, true]]);
        const q = buildPrompt({ feature: 'tutor', rules: 'RULES', task: task(), variable: [] });
        expect(q.prefix.map((b) => !!b.cache)).to.deep.equal([false, true]);
        // the summary never changes the shared cache key
        expect(p.cacheKey).to.equal(q.cacheKey);
    });

    it('normalises whitespace and sorts lists', () => {
        expect(normalizePrefixText('a \r\nb  \n\n\n\nc')).to.equal('a\nb\n\nc');
        expect(stableList(['b', 'a', 'B', ' a ', ''])).to.deep.equal(['a', 'b']);
    });

    it('estimates a typical tutor prefix above the 1024-token cache minimum', () => {
        const rules = 'R'.repeat(2600);
        const p = buildPrompt({ feature: 'tutor', rules, task: task({ statement: 'S'.repeat(1500) }), variable: [] });
        expect(estimateTokens(prefixText(p.prefix))).to.be.at.least(1024);
    });

    it('normalises provider usage shapes', () => {
        expect(normalizeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 })).to.deep.equal({
            input: 10, output: 5, cacheRead: 100, cacheWrite: 7,
        });
        expect(normalizeUsage({ prompt_tokens: 120, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 100 } })).to.deep.equal({
            input: 20, output: 3, cacheRead: 100, cacheWrite: 0,
        });
        expect(normalizeUsage({ prompt_tokens: 120, completion_tokens: 3, prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 30 })).to.deep.equal({
            input: 30, output: 3, cacheRead: 90, cacheWrite: 0,
        });
        expect(normalizeUsage(null)).to.equal(null);
        expect(formatCallLine({
            feature: 'tutor', lane: 'interactive', uid: 5, wait: 10, ttft: 900, service: 4000, usage: { input: 20, output: 3, cacheRead: 80, cacheWrite: 0 }, outcome: 'ok',
        })).to.match(/^ai\.call feature=tutor lane=interactive uid=[0-9a-f]{8} wait=10ms ttft=900ms service=4000ms in=20 out=3 cache=80% outcome=ok$/);
    });
});

describe('thread summaries and code diffs', () => {
    it('is due every 4th student turn once the thread has six messages', () => {
        expect(summaryDue(4, 5)).to.equal(false);
        expect(summaryDue(4, 8)).to.equal(true);
        expect(summaryDue(5, 10)).to.equal(false);
        expect(summaryDue(8, 16)).to.equal(true);
        expect(summaryDue(3, 6, 3)).to.equal(true);
    });

    it('enforces the 120-word budget at a sentence boundary', () => {
        const line = (label: string, n: number) => `${label}: ${Array.from({ length: n }, (_, i) => `w${i}`).join(' ')}.`;
        const text = [line('goal', 20), line('tried', 20), line('blocker', 20), line('hints given', 20), line('next step', 60)].join('\n');
        const cut = limitSummary(text, 120);
        expect(wordCount(cut)).to.be.at.most(120);
        expect(cut.split('\n').length).to.be.at.least(4);
        expect(limitSummary('short summary')).to.equal('short summary');
    });

    it('decides between full file and diff', () => {
        const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
        expect(codeDelta(null, lines(80)).mode).to.equal('full'); // nothing to diff against
        expect(codeDelta(lines(40), `${lines(40)}\nx`).mode).to.equal('full'); // short file
        expect(codeDelta(lines(80), lines(80)).mode).to.equal('full'); // unchanged
        const small = codeDelta(lines(80), lines(80).replace('line 10', 'line ten').replace('line 50', 'line fifty'));
        expect(small.mode).to.equal('diff');
        expect(small.changed).to.equal(4);
        expect(small.text).to.match(/^\(changes since your last message/);
        expect(small.text).to.match(/@@ -8,7 \+8,7 @@/);
        expect(small.text).to.match(/-line 10\n\+line ten/);
        let big = lines(80);
        for (let i = 0; i < 25; i++) big = big.replace(`line ${i}`, `LINE ${i}`);
        expect(codeDelta(lines(80), big).mode).to.equal('full'); // > 40 changed lines
    });
});

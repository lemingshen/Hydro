/**
 * ai-speedup §9 — FAKE AI PROVIDER for load tests and transport tests.
 *
 * An HTTP server that speaks both dialects the site uses:
 *   POST /v1/messages          (Anthropic Messages API: JSON or SSE stream)
 *   POST /v1/chat/completions  (OpenAI-compatible: JSON or SSE stream, [DONE])
 * with configurable latency (± jitter), time-to-first-token, an injectable
 * 429 rate, and usage fields that report CACHE HITS for repeated prefixes
 * (the system prompt of a request is hashed; a prefix seen before within
 * the TTL counts as cached — exactly what a real provider does).
 *
 * It also keeps the numbers a load test asserts on: peak concurrent
 * requests (must never exceed the scheduler's slot total), request count,
 * 429s served, cache hits.
 *
 * Standalone:  node -r @hydrooj/register test/ai_load/fake_provider.ts [port]
 */
import { createHash } from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';

export interface FakeProviderOptions {
    port?: number;
    /** Total service time of a call (ms), ± jitterMs. */
    latencyMs?: number;
    jitterMs?: number;
    /** Time to the first streamed token (ms). */
    ttftMs?: number;
    /** Probability [0, 1] that a request is answered with HTTP 429. */
    rate429?: number;
    /** The reply text (streamed word by word). */
    reply?: string | ((body: any) => string);
    /** Prefix cache lifetime (ms). */
    cacheTtlMs?: number;
    /** Reject the `stream_options` field with HTTP 400 (to test the fallback). */
    rejectStreamOptions?: boolean;
    /** Never send a first token (to test the first-token timeout). */
    silent?: boolean;
    /** Keep the connection open this long after the final event (a proxy that does not close the body). */
    holdOpenMs?: number;
    /** Stop sending after this many words; the connection then stays silent for `stallMs` (default 120 s) and closes without any end marker. */
    stallAfterWords?: number;
    stallMs?: number;
    /** Send the stop reason but never `[DONE]` / `message_stop` (a gateway that omits the end marker). */
    omitDoneMarker?: boolean;
    log?: boolean;
}

export interface FakeProviderStats {
    requests: number;
    streamed: number;
    served429: number;
    inflight: number;
    peakInflight: number;
    cacheHits: number;
    cacheMisses: number;
    byPath: Record<string, number>;
}

export interface FakeProvider {
    url: string;
    port: number;
    stats: FakeProviderStats;
    close: () => Promise<void>;
    reset: () => void;
}

const DEFAULT_REPLY = 'Let us look at the loop bound together. When `i` reaches `n`, which index does your array access on that line? Trace it by hand with n = 3 and tell me what you see.';

function sleep(ms: number) {
    return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

function readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

/** Tokens ≈ characters / 4 (only needs to be self-consistent). */
const tokens = (s: string) => Math.max(1, Math.ceil(String(s || '').length / 4));

export function startFakeProvider(opts: FakeProviderOptions = {}): Promise<FakeProvider> {
    const latencyMs = opts.latencyMs ?? 300;
    const jitterMs = opts.jitterMs ?? 0;
    const ttftMs = opts.ttftMs ?? Math.min(80, latencyMs / 4);
    const rate429 = opts.rate429 ?? 0;
    const cacheTtl = opts.cacheTtlMs ?? 5 * 60 * 1000;
    const stats: FakeProviderStats = {
        requests: 0, streamed: 0, served429: 0, inflight: 0, peakInflight: 0, cacheHits: 0, cacheMisses: 0, byPath: {},
    };
    const prefixSeen = new Map<string, number>();

    const replyOf = (body: any) => (typeof opts.reply === 'function' ? opts.reply(body) : (opts.reply || DEFAULT_REPLY));

    /** The cacheable prefix: the system prompt (string or blocks) as one string. */
    const prefixOf = (body: any, style: 'anthropic' | 'openai'): string => {
        if (style === 'anthropic') {
            const sys = body.system;
            if (typeof sys === 'string') return sys;
            if (Array.isArray(sys)) return sys.map((b: any) => b.text || '').join('\n');
            return '';
        }
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        return msgs.filter((m: any) => m.role === 'system').map((m: any) => String(m.content || '')).join('\n');
    };

    const usageOf = (body: any, style: 'anthropic' | 'openai', out: string) => {
        const prefix = prefixOf(body, style);
        const key = createHash('sha1').update(prefix).digest('hex');
        const now = Date.now();
        const seen = prefixSeen.get(key);
        const hit = !!(seen && now - seen < cacheTtl && tokens(prefix) >= 256);
        prefixSeen.set(key, now);
        if (hit) stats.cacheHits += 1; else stats.cacheMisses += 1;
        const prefixTokens = tokens(prefix);
        const rest = tokens(JSON.stringify(body.messages || []));
        if (style === 'anthropic') {
            return {
                input_tokens: hit ? rest : rest + 0,
                cache_read_input_tokens: hit ? prefixTokens : 0,
                cache_creation_input_tokens: hit ? 0 : prefixTokens,
                output_tokens: tokens(out),
            };
        }
        return {
            prompt_tokens: prefixTokens + rest,
            completion_tokens: tokens(out),
            total_tokens: prefixTokens + rest + tokens(out),
            prompt_tokens_details: { cached_tokens: hit ? prefixTokens : 0 },
        };
    };

    const server = http.createServer(async (req, res) => {
        const path = (req.url || '').split('?')[0];
        stats.requests += 1;
        stats.byPath[path] = (stats.byPath[path] || 0) + 1;
        stats.inflight += 1;
        stats.peakInflight = Math.max(stats.peakInflight, stats.inflight);
        const done = () => { stats.inflight -= 1; };
        // The request's own `destroyed` flag flips as soon as its body is
        // consumed (autoDestroy), so "the client went away" is the RESPONSE
        // side closing before it was finished.
        let gone = false;
        res.on('close', () => { gone = !res.writableFinished; });
        try {
            if (req.method !== 'POST' || !['/v1/messages', '/v1/chat/completions'].includes(path)) {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'not found' } }));
                return;
            }
            const style: 'anthropic' | 'openai' = path === '/v1/messages' ? 'anthropic' : 'openai';
            const body = await readBody(req);
            if (opts.log) console.log('[fake-provider]', style, body.stream ? 'stream' : 'json', `${stats.inflight} in flight`);
            if (rate429 > 0 && Math.random() < rate429) {
                stats.served429 += 1;
                res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
                res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited (fake)' } }));
                return;
            }
            if (style === 'anthropic' && body.max_tokens > 32000) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for this model' } }));
                return;
            }
            if (style === 'openai' && opts.rejectStreamOptions && body.stream_options) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }));
                return;
            }
            const out = replyOf(body);
            const total = Math.max(0, latencyMs + (jitterMs ? (Math.random() * 2 - 1) * jitterMs : 0));
            const usage = usageOf(body, style, out);
            if (!body.stream) {
                await sleep(total);
                if (gone) return;
                res.writeHead(200, { 'content-type': 'application/json' });
                if (style === 'anthropic') {
                    res.end(JSON.stringify({
                        id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: out }], stop_reason: 'end_turn', usage,
                    }));
                } else {
                    res.end(JSON.stringify({
                        id: 'chatcmpl_fake', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: out }, finish_reason: 'stop' }], usage,
                    }));
                }
                return;
            }
            stats.streamed += 1;
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            res.flushHeaders(); // like a real provider: the stream opens at once, tokens follow
            const send = (event: string | null, data: any) => {
                if (gone) return;
                res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
            };
            if (opts.silent) {
                await sleep(total);
                res.end();
                return;
            }
            const words = out.split(/(?<=\s)/);
            const perWord = words.length > 1 ? Math.max(1, (total - ttftMs) / (words.length - 1)) : 0;
            const stallAt = opts.stallAfterWords ?? Infinity;
            if (stallAt < words.length) {
                // A dead stream: some words, then silence, for a long time.
                if (style === 'anthropic') {
                    send('message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, usage: { ...usage, output_tokens: 1 } } });
                    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
                }
                await sleep(ttftMs);
                for (let i = 0; i < stallAt; i++) {
                    if (style === 'anthropic') send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words[i] } });
                    else send(null, { id: 'chatcmpl_fake', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: words[i] }, finish_reason: null }] });
                }
                await sleep(opts.stallMs ?? 120000);
                res.end();
                return;
            }
            if (style === 'anthropic') {
                send('message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, usage: { ...usage, output_tokens: 1 } } });
                send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
                await sleep(ttftMs);
                for (let i = 0; i < words.length; i++) {
                    if (gone) break;
                    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words[i] } });
                    if (i < words.length - 1) await sleep(perWord);
                }
                send('content_block_stop', { type: 'content_block_stop', index: 0 });
                send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
                if (!opts.omitDoneMarker) send('message_stop', { type: 'message_stop' });
            } else {
                await sleep(ttftMs);
                for (let i = 0; i < words.length; i++) {
                    if (gone) break;
                    send(null, { id: 'chatcmpl_fake', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: words[i] } : { content: words[i] }, finish_reason: null }] });
                    if (i < words.length - 1) await sleep(perWord);
                }
                send(null, { id: 'chatcmpl_fake', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
                if (body.stream_options?.include_usage) send(null, { id: 'chatcmpl_fake', object: 'chat.completion.chunk', model: body.model, choices: [], usage });
                if (!gone && !opts.omitDoneMarker) res.write('data: [DONE]\n\n');
            }
            if (opts.holdOpenMs) await sleep(opts.holdOpenMs); // the body stays open after the final event
            res.end();
        } catch (e: any) {
            if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: e.message } }));
        } finally {
            done();
        }
    });
    server.keepAliveTimeout = 5000;
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port ?? 0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({
                url: `http://127.0.0.1:${port}`,
                port,
                stats,
                reset: () => {
                    Object.assign(stats, {
                        requests: 0, streamed: 0, served429: 0, peakInflight: stats.inflight, cacheHits: 0, cacheMisses: 0, byPath: {},
                    });
                    prefixSeen.clear();
                },
                close: () => new Promise<void>((res2) => {
                    server.closeAllConnections?.();
                    server.close(() => res2());
                }),
            });
        });
    });
}

if (require.main === module) {
    startFakeProvider({ port: +(process.argv[2] || 18080), latencyMs: 12000, jitterMs: 3000, ttftMs: 1000, rate429: +(process.env.FAKE_429 || 0), log: true })
        .then((p) => console.log(`fake AI provider on ${p.url}  (anthropic: ${p.url}/v1/messages · openai: ${p.url}/v1/chat/completions)`));
}

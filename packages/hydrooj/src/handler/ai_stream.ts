/**
 * PTA fork — AI STREAM TRANSPORT (ai-speedup WP2) and STATUS (WP6).
 *
 *  • ws  /ai/stream            — the browser sends { op: 'subscribe', id, from? }
 *                                for each stream it watches; the server replays
 *                                the buffered text from `from` and then pushes
 *                                { type: 'queue' | 'delta' | 'status' | 'reset'
 *                                | 'done' | 'error' } events live. A stream is
 *                                readable only by its owner (or root). When the
 *                                socket closes the subscriptions are dropped; an
 *                                interactive stream that nobody re-attaches to
 *                                within the grace period is aborted, which frees
 *                                its scheduler slot (lib/ai_stream.ts sweep).
 *  • GET /ai/stream/:id?from=N — polling fallback when websockets are blocked:
 *                                { text: <buffer from N>, length, state, queue,
 *                                stage, done, result, error }. Each poll counts
 *                                as "still watching".
 *  • GET /ai/status            — root only: the scheduler's status plus the
 *                                metrics snapshot, for the AI status card on the
 *                                settings page (pages/ai_status.page.js).
 *
 * Nothing here calls the provider: handlers that own an AI job create the
 * stream (lib/ai_stream.ts startStreamJob) and return its id; this file only
 * carries the events to the browser.
 */
import { Context } from '../context';
import { Logger } from '../logger';
import { ForbiddenError, NotFoundError } from '../error';
import { aiMetrics } from '../lib/ai_metrics';
import { aiScheduler } from '../lib/ai_scheduler';
import { AiStreamEvent, aiStreams } from '../lib/ai_stream';
import {
    effectiveKeyText, ensureKeyPool, providerKeyMap, rememberProviderKeys, streamingEnabled, tutorEnabled,
} from '../lib/ai_tutor';
import { PRIV } from '../model/builtin';
import {
    ConnectionHandler, Handler, param, Types,
} from '../service/server';

const logger = new Logger('ai-stream');

/** Owner, or root: the only readers of a stream. */
function canRead(user: { _id: number, hasPriv: (p: bigint | number) => boolean }, id: string): boolean {
    if (aiStreams.ownedBy(id, user._id)) return true;
    return user.hasPriv(PRIV.PRIV_EDIT_SYSTEM);
}

class AiStreamConnectionHandler extends ConnectionHandler {
    private subscriptions = new Map<string, () => void>();

    async prepare() {
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) throw new ForbiddenError('Please sign in.');
    }

    private forward(id: string, ev: AiStreamEvent) {
        try {
            this.send({ id, ...ev });
        } catch (e) { /* the socket is gone; cleanup drops the subscription */ }
    }

    async message(payload: any) {
        if (!payload || typeof payload !== 'object') return;
        const id = String(payload.id || '');
        if (payload.op === 'unsubscribe') {
            this.subscriptions.get(id)?.();
            this.subscriptions.delete(id);
            return;
        }
        if (payload.op !== 'subscribe' || !id) return;
        if (!aiStreams.get(id)) {
            this.send({ id, type: 'error', message: 'This AI request is no longer available (it may have expired or the server restarted).', gone: true });
            return;
        }
        if (!canRead(this.user, id)) {
            this.send({ id, type: 'error', message: 'Forbidden.', gone: true });
            return;
        }
        // Replay first (from where the client left off), then live events —
        // subscribe before reading so nothing can slip between the two.
        this.subscriptions.get(id)?.();
        const unsubscribe = aiStreams.subscribe(id, (ev) => this.forward(id, ev));
        this.subscriptions.set(id, unsubscribe);
        const from = Number.isFinite(+payload.from) ? Math.max(0, Math.floor(+payload.from)) : 0;
        const snap = aiStreams.read(id, from)!;
        this.send({
            id, type: 'snapshot', text: snap.text, length: snap.length, state: snap.state, queue: snap.queue, stage: snap.stage,
        });
        if (snap.done) {
            unsubscribe();
            this.subscriptions.delete(id);
            if (snap.state === 'done') this.send({ id, type: 'done', result: snap.result });
            else this.send({ id, type: 'error', message: snap.error?.message || 'The AI request failed.', retryAfter: snap.error?.retryAfter });
        }
    }

    async cleanup() {
        for (const unsubscribe of this.subscriptions.values()) unsubscribe();
        this.subscriptions.clear();
    }
}

class AiStreamPollHandler extends Handler {
    noCheckPermView = true;

    @param('id', Types.String)
    @param('from', Types.UnsignedInt, true)
    async get(_: string, id: string, from = 0) {
        this.response.addHeader('Cache-Control', 'no-store');
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) throw new ForbiddenError('Please sign in.');
        if (!aiStreams.get(id)) throw new NotFoundError('This AI request is no longer available (it may have expired or the server restarted).');
        if (!canRead(this.user, id)) throw new ForbiddenError('Forbidden.');
        this.response.body = aiStreams.read(id, from);
    }
}

class AiStatusHandler extends Handler {
    noCheckPermView = true;

    async get() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        this.response.addHeader('Cache-Control', 'no-store');
        this.response.body = {
            at: new Date(),
            streaming: streamingEnabled(),
            scheduler: aiScheduler.status(),
            metrics: aiMetrics.snapshot(),
            streams: aiStreams.count(),
            // Key pool health: ids are short hashes, never the keys.
            keys: tutorEnabled() ? { provider: String((global as any).Hydro?.model?.system?.get?.('ai_tutor.provider') || ''), ...ensureKeyPool().status() } : null,
        };
    }
}

/**
 * Registers the three routes. Exported so handler/self_learning.ts (a file
 * every deployment is known to load) can register them too when a dev-mode
 * watcher never discovered this brand-new file — the global flag keeps a
 * normal boot from registering twice.
 */
export function registerAiStreamRoutes(ctx: Context) {
    if ((global as any).__ptaAiStreamRoutes) return;
    (global as any).__ptaAiStreamRoutes = true;
    ctx.Connection('ai_stream', '/ai/stream', AiStreamConnectionHandler);
    ctx.Route('ai_stream_poll', '/ai/stream/:id', AiStreamPollHandler);
    ctx.Route('ai_status', '/ai/status', AiStatusHandler);
    // Capability flag for the pages: a page only asks for a stream
    // (`stream=1`) when THIS backend can carry one — an older backend, or a
    // process whose watcher never loaded these routes, gets the inline
    // (whole-reply) requests instead of a request it cannot serve.
    ctx.on('handler/after' as any, (h: any) => {
        if (h?.UiContext && typeof h.UiContext === 'object') h.UiContext.aiStream = streamingEnabled();
    });
    // The settings form was saved: remember the API keys under their provider.
    ctx.on('system/setting', (args: any) => {
        rememberProviderKeys(args).catch((e) => logger.warn('api keys not remembered: %s', e.message));
    });
    // The settings page (root, sudo): the API key box shows the keys saved for
    // the selected provider, and the page gets every provider's keys so the
    // box can switch with the dropdown (pages/ai_status.page.js).
    ctx.on('handler/after/SystemSetting#get' as any, (h: any) => {
        if (!h?.response?.body?.current) return;
        const saved = String((global as any).Hydro?.model?.system?.get?.('ai_tutor.provider') || 'claude');
        const provider = String(h.args?.provider || '') || saved;
        const map = { ...providerKeyMap() };
        const current = effectiveKeyText();
        if (current.trim() && !map[saved]) map[saved] = current;
        h.response.body.current['ai_tutor.api_key'] = map[provider] || '';
        if (provider !== saved) h.response.body.current['ai_tutor.provider'] = provider; // ?provider=x previews that provider
        if (h.UiContext) h.UiContext.aiProviderKeys = { provider, map };
    });
    ctx.effect(() => () => { (global as any).__ptaAiStreamRoutes = false; });
}

export async function apply(ctx: Context) {
    registerAiStreamRoutes(ctx);
}

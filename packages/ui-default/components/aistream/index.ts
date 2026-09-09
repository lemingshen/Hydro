/*
 * PTA fork — AI STREAM CLIENT (ai-speedup WP2).
 *
 * `openAiStream(id, handlers)` watches one server-side AI job: it opens the
 * `/ai/stream` websocket (shared per page), subscribes to the stream id and
 * receives { queue, delta, status, reset, done, error } events. It POLLS
 * `GET /ai/stream/:id?from=N` from the first moment as well — every 700 ms
 * until the socket is open, and for good when the socket cannot be
 * established (a proxy without websocket support) — so the first words
 * never wait on a handshake. Every chunk carries its offset, so nothing is
 * ever shown twice whichever path delivered it, and a reconnect resumes
 * from the buffer position.
 *
 * Text is handed to the page through a TYPEWRITER PACER (./pacer.ts):
 * whatever the network does — a token at a time, 700 ms polling batches,
 * or one burst from a buffering proxy — the reply is revealed word by word
 * at a readable rate that keeps up with the stream and drains within about
 * a second once the reply is complete.
 *
 * `MarkdownStreamRenderer` re-renders the growing text at most every
 * 100 ms with a caret, and `formatQueue` / `busyCountdown` turn the
 * scheduler's queue position and its 503 refusals into the small
 * "waiting" lines every AI panel shows.
 */
import $ from 'jquery';
import { aiMarkdown } from 'vj/components/ai-report/pdf';
import Sock from 'vj/components/socket';
import { i18n, request } from 'vj/utils';
import { PacerOptions, TypewriterPacer } from './pacer';

export interface AiStreamHandlers {
  onQueue?: (s: { position: number, eta: number }) => void;
  /** A revealed piece of text and everything revealed so far. */
  onDelta?: (text: string, full: string) => void;
  onStatus?: (stage: string) => void;
  onReset?: () => void;
  /** The final result; `full` is the complete streamed text. */
  onDone?: (result: any, full: string) => void;
  onError?: (err: { message: string, retryAfter?: number, gone?: boolean }) => void;
  /** Typewriter pacing (default on); `false` hands deltas through as they arrive. */
  pace?: boolean | PacerOptions;
}

export interface AiStreamWatch {
  id: string;
  /** Stop watching (does not cancel the job). */
  close: () => void;
  readonly text: string;
}

const POLL_MS = 700;
/** With a live socket the poll is only a safety net (offsets make double delivery impossible). */
const POLL_SLOW_MS = 2500;
const SOCKET_OPEN_TIMEOUT = 3500;

/**
 * Whether this backend serves `/ai/stream` (set on every page by
 * handler/ai_stream.ts). Pages send `stream=1` only when it does; an older
 * backend answers their inline requests as before.
 */
export function streamingSupported(): boolean {
  const UiContext = (window as any).UiContext || {};
  return !!UiContext.aiStream;
}
/** The `stream` field to add to an AI request: 1 when the backend can carry a stream, nothing otherwise. */
export function streamField(): { stream?: 1 } {
  return streamingSupported() ? { stream: 1 } : {};
}

function domainPrefix(): string {
  return (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];
}
/**
 * The websocket URL. Hydro matches websocket routes against the ORIGINAL
 * request path — before the domain layer strips `/d/<domain>/` — so the
 * path must be root-relative and the domain goes in the query, exactly as
 * the judge's record-conn does. (A `/d/<domain>/ai/stream` URL "opens" and
 * is closed by the server as unmatched.)
 */
function streamUrl(): string {
  const UiContext = (window as any).UiContext || {};
  let prefix = String(UiContext.ws_prefix || '/');
  if (!prefix.endsWith('/')) prefix += '/';
  const domainId = UiContext.domainId ? `?domainId=${encodeURIComponent(UiContext.domainId)}` : '';
  return `${prefix}ai/stream${domainId}`;
}
function pollUrl(id: string, from: number): string {
  return `${domainPrefix()}/ai/stream/${encodeURIComponent(id)}?from=${from}`;
}

/* ------------------------------------------------------------------ */
/*  Shared socket                                                      */
/* ------------------------------------------------------------------ */

type Listener = (msg: any) => void;
let shared: { sock: Sock, open: boolean, failed: boolean, listeners: Map<string, Listener>, waiters: ((ok: boolean) => void)[], closes: number[] } | null = null;

/** The socket closed 3 times within 30 s: it is not going to work here — polling carries every stream. */
const FLAP_LIMIT = 3;
const FLAP_WINDOW_MS = 30000;

function ensureSocket(): Promise<boolean> {
  if (shared?.failed) return Promise.resolve(false);
  if (shared?.open) return Promise.resolve(true);
  if (!shared) {
    let sock: Sock;
    try {
      sock = new Sock(streamUrl(), false, false);
    } catch (e) {
      shared = {
        sock: null as any, open: false, failed: true, listeners: new Map(), waiters: [], closes: [],
      };
      return Promise.resolve(false);
    }
    const s = {
      sock, open: false, failed: false, listeners: new Map<string, Listener>(), waiters: [] as ((ok: boolean) => void)[], closes: [] as number[],
    };
    shared = s;
    const settle = (ok: boolean) => {
      const w = s.waiters.splice(0);
      for (const fn of w) fn(ok);
    };
    const giveUp = () => {
      s.failed = true;
      s.open = false;
      settle(false);
      try { sock.close(); } catch (e) { /* ignore */ }
      for (const [id, fn] of s.listeners) fn({ type: '__fallback', id });
    };
    sock.on('open', () => {
      s.open = true;
      settle(true);
      // Re-subscribe every watched stream after a reconnect.
      for (const [id, fn] of s.listeners) fn({ type: '__resubscribe', id });
    });
    sock.on('close', () => {
      s.open = false;
      const now = Date.now();
      s.closes = s.closes.filter((t) => now - t < FLAP_WINDOW_MS);
      s.closes.push(now);
      if (s.closes.length >= FLAP_LIMIT) {
        giveUp();
        return;
      }
      // Until it is back, every watched stream polls at full speed.
      for (const [id, fn] of s.listeners) fn({ type: '__closed', id });
    });
    sock.on('message', (_msg: MessageEvent, data: string) => {
      let payload: any;
      try {
        payload = JSON.parse(data);
      } catch (e) {
        return;
      }
      if (payload?.error) return; // permission / privilege errors close the socket
      const fn = payload?.id ? s.listeners.get(String(payload.id)) : null;
      if (fn) fn(payload);
    });
    setTimeout(() => {
      if (!s.open && !s.failed) giveUp();
    }, SOCKET_OPEN_TIMEOUT);
  }
  return new Promise((resolve) => shared!.waiters.push(resolve));
}

/* ------------------------------------------------------------------ */
/*  openAiStream                                                       */
/* ------------------------------------------------------------------ */

export function openAiStream(id: string, handlers: AiStreamHandlers = {}): AiStreamWatch {
  /** Bytes of the stream received so far (the authoritative offset for polls and resumes). */
  let received = '';
  let closed = false;
  let finished = false;
  let pollTimer: any = null;
  let pollInflight: Promise<void> | null = null;
  /** 'fast' without a working socket, 'slow' (safety net) while the socket carries the stream. */
  let pollMode: 'fast' | 'slow' = 'fast';
  let usingSocket = false;
  let pollErrors = 0;

  const paceOpts = handlers.pace === false ? null : (typeof handlers.pace === 'object' ? handlers.pace : {});
  const pacer = paceOpts ? new TypewriterPacer((piece, revealed) => handlers.onDelta?.(piece, revealed), paceOpts) : null;
  const deliver = (text: string) => {
    if (!text) return;
    if (pacer) pacer.push(text);
    else handlers.onDelta?.(text, received);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (usingSocket && shared) {
      shared.listeners.delete(id);
      if (shared.open) {
        try {
          shared.sock.send(JSON.stringify({ op: 'unsubscribe', id }));
        } catch (e) { /* ignore */ }
      }
    }
  };
  /** Terminal event: let the pacer reveal what is left, then tell the page. */
  const settle = (fn: () => void) => {
    if (finished) return;
    finished = true;
    close();
    if (pacer) pacer.finish(fn); else fn();
  };
  const done = (result: any) => settle(() => handlers.onDone?.(result, received));
  const fail = (err: { message: string, retryAfter?: number, gone?: boolean }) => settle(() => handlers.onError?.(err));

  /**
   * Append a chunk known to end at absolute offset `length` (a poll or a
   * snapshot): whatever part of it we already have is dropped, so a poll
   * that overlaps the socket's replay never shows text twice.
   */
  const absorb = (text: string, length: number) => {
    if (!text) return;
    const start = length - text.length;
    const fresh = start < received.length ? text.slice(received.length - start) : text;
    if (start > received.length) {
      // A gap (should not happen): keep what we have and take the rest.
      received += text;
      deliver(text);
      return;
    }
    if (!fresh) return;
    received += fresh;
    deliver(fresh);
  };

  const apply = (ev: any) => {
    if (closed || finished || !ev) return;
    switch (ev.type) {
      case 'snapshot':
        absorb(ev.text || '', Number.isFinite(+ev.length) ? +ev.length : received.length + String(ev.text || '').length);
        if (ev.queue && ev.state === 'queued') handlers.onQueue?.(ev.queue);
        if (ev.stage && ev.state === 'running') handlers.onStatus?.(ev.stage);
        break;
      case 'queue':
        handlers.onQueue?.({ position: ev.position, eta: ev.eta });
        break;
      case 'delta':
        received += ev.text || '';
        deliver(ev.text || '');
        break;
      case 'status':
        handlers.onStatus?.(ev.stage || '');
        break;
      case 'reset':
        received = '';
        pacer?.reset();
        handlers.onReset?.();
        break;
      case 'done':
        done(ev.result);
        break;
      case 'error':
        fail({ message: ev.message || i18n('The AI request failed.'), retryAfter: ev.retryAfter, gone: !!ev.gone });
        break;
      default:
        break;
    }
  };

  const poll = async () => {
    if (closed || finished) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    pollInflight = (async () => {
      try {
        const r = await request.get(pollUrl(id, received.length));
        if (closed || finished) return;
        pollErrors = 0;
        absorb(r.text || '', Number.isFinite(+r.length) ? +r.length : received.length + String(r.text || '').length);
        if (r.queue && r.state === 'queued') handlers.onQueue?.(r.queue);
        else if (r.stage && r.state === 'running') handlers.onStatus?.(r.stage);
        if (r.done) {
          if (r.state === 'done') done(r.result);
          else fail({ message: (r.error && r.error.message) || i18n('The AI request failed.'), retryAfter: r.error?.retryAfter });
        }
      } catch (e: any) {
        const msg = String(e?.rawMessage || e?.message || '');
        // The stream is gone (expired, another process) or the route does not
        // exist here (NotFoundError): nothing will ever arrive — say so.
        if (/no longer available|NotFoundError|not found/i.test(msg)) {
          fail({ message: e.message, gone: true });
          return;
        }
        pollErrors += 1;
        // A dead socket plus a poll that keeps failing must not hang the page.
        if (pollErrors >= 8 && (!usingSocket || !shared?.open)) fail({ message: e.message || i18n('The AI request failed.') });
        // otherwise: a transient error, keep polling
      }
    })();
    await pollInflight;
    pollInflight = null;
    if (!closed && !finished) pollTimer = setTimeout(poll, pollMode === 'fast' ? POLL_MS : POLL_SLOW_MS);
  };
  const pollFast = () => {
    pollMode = 'fast';
    if (!pollInflight) poll();
  };

  const watch: AiStreamWatch = {
    id,
    get text() { return received; },
    close,
  };

  // Poll at once — the first words must not wait for a handshake. Once the
  // socket is open it carries the events and polling drops to a slow safety
  // net; it never stops until the stream is done, so a socket that opens
  // and dies (a proxy, a route mismatch) can never stall a reply.
  poll();
  ensureSocket().then(async (ok) => {
    if (closed || finished || !ok || !shared) return; // fast polling carries on
    if (pollInflight) await pollInflight; // the offset must be final before subscribing
    if (closed || finished) return;
    usingSocket = true;
    const subscribe = () => {
      try {
        shared!.sock.send(JSON.stringify({ op: 'subscribe', id, from: received.length }));
        pollMode = 'slow';
      } catch (e) {
        pollFast();
      }
    };
    shared.listeners.set(id, (msg) => {
      if (msg.type === '__resubscribe') subscribe();
      else if (msg.type === '__closed' || msg.type === '__fallback') pollFast();
      else apply(msg);
    });
    subscribe();
  });
  return watch;
}

/* ------------------------------------------------------------------ */
/*  Rendering helpers                                                  */
/* ------------------------------------------------------------------ */

/** "Waiting for a free slot · 7 ahead · ~20 s" */
export function formatQueue(s: { position: number, eta: number } | null | undefined): string {
  if (!s) return i18n('Waiting for a free AI slot…');
  const secs = Math.max(1, Math.round((s.eta || 0) / 1000));
  const ahead = Math.max(0, s.position || 0);
  return `${i18n('Waiting for a free AI slot')} · ${i18n('{0} ahead').replace('{0}', String(ahead))} · ~${secs} s`;
}

/**
 * Re-render a Markdown container at most every `intervalMs`, with a caret
 * while the text is still growing. `finish(text)` renders the final text
 * exactly once, without the caret.
 */
export class MarkdownStreamRenderer {
  private text = '';
  private timer: any = null;
  private dirty = false;
  private done = false;

  constructor(private $el: JQuery, private intervalMs = 100, private md: { render: (s: string) => string } = aiMarkdown) {
    this.$el.addClass('ai-stream ai-stream--live');
  }

  append(delta: string) {
    if (this.done) return;
    this.text += delta;
    this.dirty = true;
    this.timer ||= setTimeout(() => {
      this.timer = null;
      if (this.dirty) this.flush();
    }, this.intervalMs);
  }

  reset() {
    this.text = '';
    this.dirty = true;
    this.flush();
  }

  private flush() {
    this.dirty = false;
    this.$el.html(`${this.md.render(this.text)}<span class="ai-stream__caret" aria-hidden="true"></span>`);
  }

  finish(text?: string) {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (typeof text === 'string') this.text = text;
    this.$el.removeClass('ai-stream--live').html(this.md.render(this.text));
    return this.text;
  }

  get value() { return this.text; }
}

/* ------------------------------------------------------------------ */
/*  Busy (503) handling                                                */
/* ------------------------------------------------------------------ */

/** The scheduler refused the request: [ahead, etaSeconds, retryAfterSeconds] from the error params. */
export function busyInfo(err: any): { ahead: number, eta: number, retryAfter: number } | null {
  if (!err) return null;
  const raw = String(err.rawMessage || err.message || '');
  const params = Array.isArray(err.params) ? err.params : [];
  if (!/AI is busy/i.test(raw) && (!err.retryAfter || !/busy|503/i.test(raw))) return null;
  const ahead = Number.isFinite(+params[0]) ? +params[0] : 0;
  const eta = Number.isFinite(+params[1]) ? +params[1] : 10;
  const retryAfter = Number.isFinite(+params[2]) ? Math.max(1, +params[2]) : Math.max(1, Math.ceil(eta / 2));
  return { ahead, eta, retryAfter };
}

/**
 * Show a countdown in `$el` ("AI busy · 7 ahead · retrying in 12 s") and
 * resolve when it is time to retry. Returns a cancel function through
 * the handle; the promise resolves `false` when cancelled.
 */
export function busyCountdown($el: JQuery, info: { ahead: number, eta: number, retryAfter: number }): { promise: Promise<boolean>, cancel: () => void } {
  let left = info.retryAfter;
  let timer: any = null;
  let cancelled = false;
  let resolveFn: (v: boolean) => void = () => { };
  const render = () => {
    $el.text(`${i18n('The AI is busy right now')} · ${i18n('{0} ahead').replace('{0}', String(info.ahead))} · ${i18n('retrying in {0} s').replace('{0}', String(left))}`);
  };
  const promise = new Promise<boolean>((resolve) => {
    resolveFn = resolve;
    render();
    timer = setInterval(() => {
      if (cancelled) return;
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      render();
    }, 1000);
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      resolveFn(false);
    },
  };
}

/** Minimal styles shared by every streaming surface (injected once). */
export function ensureAiStreamStyle() {
  if (document.getElementById('ai-stream-style')) return;
  $('<style id="ai-stream-style">').text([
    '.ai-stream__caret { display: inline-block; width: 7px; height: 1em; margin-left: 2px; vertical-align: -2px; background: currentColor; opacity: .55; animation: aiStreamBlink 1s steps(2, start) infinite; }',
    '@keyframes aiStreamBlink { to { visibility: hidden; } }',
    '.ai-stream__queue { font-size: 12px; color: var(--pta-ink-faint, #7c8aa3); display: inline-flex; align-items: center; gap: 6px; }',
    '.ai-stream__queue::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #f59f00; animation: aiStreamPulse 1.2s ease-in-out infinite; }',
    '.ai-stream__queue--busy::before { background: #e03131; }',
    '@keyframes aiStreamPulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }',
  ].join('\n')).appendTo(document.head);
}

/*
 * PTA fork — TYPEWRITER PACING for streamed AI text (ai-speedup WP2).
 *
 * Deltas arrive however the network delivers them: a token at a time from a
 * streaming provider over a websocket, in 700 ms batches from the polling
 * fallback, or as one burst when a proxy buffered the whole reply. The
 * pacer sits between the transport and the renderer and reveals the text
 * at a steady, readable rate: a small piece every tick, growing with the
 * backlog so it never falls far behind a fast stream, and draining within a
 * bounded time once the reply is complete. Pieces end on word boundaries
 * when one is close, so the reveal reads as words, not letters.
 *
 * No DOM, no timers of its own beyond the injected setTimeout: the stream
 * spec exercises it with a fake clock.
 */

export interface PacerOptions {
  /** Interval between reveals (ms). */
  tickMs?: number;
  /** Fewest characters revealed per tick while there is a backlog. */
  minChars?: number;
  /** Share of the backlog revealed per tick (keeps up with fast streams). */
  ratio?: number;
  /** Once the stream is complete, the remaining text drains within this many ms. */
  maxCatchupMs?: number;
}

export class TypewriterPacer {
  private backlog = '';
  private timer: any = null;
  private onDone: (() => void) | null = null;
  private finishAt = 0;
  private stopped = false;
  revealed = '';

  constructor(
    private onReveal: (piece: string, revealed: string) => void,
    private opts: PacerOptions = {},
    private setTimer: (fn: () => void, ms: number) => any = (fn, ms) => setTimeout(fn, ms),
    private clearTimer: (t: any) => void = (t) => clearTimeout(t),
    private now: () => number = () => Date.now(),
  ) { }

  /** More text arrived. */
  push(text: string) {
    if (this.stopped || !text) return;
    this.backlog += text;
    this.ensure();
  }

  /** The stream is complete: drain what is left (quickly), then call back. */
  finish(cb: () => void) {
    if (this.stopped) return;
    this.onDone = cb;
    this.finishAt = this.now() + (this.opts.maxCatchupMs ?? 1200);
    if (!this.backlog) {
      this.stopAndCall();
      return;
    }
    this.ensure();
  }

  /** Discard everything (the text shown so far was not the answer). */
  reset() {
    this.backlog = '';
    this.revealed = '';
    this.onDone = null;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Stop for good (the caller is gone). */
  stop() {
    this.stopped = true;
    this.reset();
  }

  get pending(): number {
    return this.backlog.length;
  }

  private ensure() {
    if (this.timer || this.stopped) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.tick();
    }, this.opts.tickMs ?? 45);
  }

  private stopAndCall() {
    const cb = this.onDone;
    this.onDone = null;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (cb) cb();
  }

  private tick() {
    if (this.stopped) return;
    if (!this.backlog) {
      if (this.onDone) this.stopAndCall();
      return;
    }
    const tickMs = this.opts.tickMs ?? 45;
    let n = Math.max(this.opts.minChars ?? 3, Math.ceil(this.backlog.length * (this.opts.ratio ?? 0.12)));
    if (this.onDone) {
      // Complete: make sure the remainder is gone by finishAt.
      const ticksLeft = Math.max(1, Math.floor((this.finishAt - this.now()) / tickMs));
      n = Math.max(n, Math.ceil(this.backlog.length / ticksLeft));
    }
    n = Math.min(n, this.backlog.length);
    // Land on a word boundary when one is near, so the reveal reads as words.
    let cut = n;
    if (cut < this.backlog.length) {
      const space = this.backlog.indexOf(' ', n);
      if (space >= 0 && space - n <= 10) cut = space + 1;
    }
    const piece = this.backlog.slice(0, cut);
    this.backlog = this.backlog.slice(cut);
    this.revealed += piece;
    try {
      this.onReveal(piece, this.revealed);
    } catch (e) { /* a renderer error never stops the stream */ }
    if (this.backlog || this.onDone) this.ensure();
  }
}

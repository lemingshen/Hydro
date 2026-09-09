# AI speed-up — operator notes

*PTA fork of Hydro · implements `ai-speedup-development-plan.md` (WP1–WP6).*

Every call to the AI provider in a backend process now goes through **one scheduler** (`packages/hydrooj/src/lib/ai_scheduler.ts`): never more than `sched_slots` provider calls in flight, an interactive lane (tutor, assistant, AI Suggestions) with a reserve that background work (reports, explanations, grading, attribution) can never take, per-student fairness, per-feature caps, admission control with a countdown instead of a hang, retries outside of the slot, and a process-wide 429 cool-down. Interactive replies **stream** to the browser (`lib/ai_stream.ts`, `handler/ai_stream.ts`, `ui-default/components/aistream`), prompts are shaped for **provider prefix caching** (`lib/ai_prompt.ts`), tutoring threads carry a rolling **summary** and send **code diffs**, and the **AI status card** on the settings page shows what is happening.

## Settings (Control Panel → Settings → AI Tutor)

| Key | Default | Meaning |
|---|---|---|
| `ai_tutor.sched_enabled` | on | Route every AI call through the scheduler. **Off = today's direct calls** (rollback switch). |
| `ai_tutor.sched_slots` | 12 | Provider calls in flight, all lanes together — the base and minimum of the adaptive limit. |
| `ai_tutor.sched_adaptive` | on | Adapt the limit to the provider (TCP-style): one slot more after four successful saturated completions with no pressure for a minute and a healthy first-token time; halve on a 429; two down on a timeout; hold/step down when the first-token time drifts to 2.5× / 4× its baseline. Never below `sched_slots`. |
| `ai_tutor.sched_slots_max` | 24 | Ceiling of the adaptive limit (set equal to `sched_slots` for a fixed limit). |
| `ai_tutor.sched_interactive_reserve` | 6 | Slots background work can never occupy. |
| `ai_tutor.sched_background_max` | 4 | Background calls in flight (bounded also by `slots − reserve`). |
| `ai_tutor.sched_user_inflight` | 1 | Calls in flight per student; the rest of their requests queue behind it. |
| `ai_tutor.sched_queue_max` | 200 | Queued calls per lane (counted per priority class) before a request is refused with a retry-after. |
| `ai_tutor.sched_max_wait` | 90 s | Refuse when the estimated wait exceeds this (the browser shows a countdown and retries by itself). |
| `ai_tutor.sched_age_ms` | 30000 | A queued call is promoted one priority class after waiting this long. |
| `ai_tutor.sched_feature_caps` | `explain:3,qr_label:3,report_map:3,attrib:2,summary:2,grade:2,report_reduce:1,qr_points:1,author:2` | Per-feature concurrency caps. |
| `ai_tutor.stream_enabled` | on | Stream tutor / assistant / suggestion replies. Off = the old whole-reply responses. |
| `ai_tutor.cache_enabled` | on | Send cache breakpoints (Anthropic) / `prompt_cache_key` (OpenAI, DeepSeek). |
| `ai_tutor.cache_ttl` | 5m | Anthropic cache lifetime; `1h` suits lecture slots with long pauses. |
| `ai_tutor.summary_model` | *(tutor model)* | Cheaper model for the rolling thread summary. |
| `ai_tutor.summary_every` | 4 | Refresh the thread summary every N student turns (once the thread has 6 messages). |

`ai_tutor.report_concurrency` is no longer read: the `report_map` cap replaces it.

## Rollout

1. Deploy with `sched_enabled=on` in a quiet period; watch the **AI status** card (`/manage/setting`, under "AI Tutor") or `GET /ai/status` (root, JSON).
2. Keep `stream_enabled=on`; the non-streamed path remains for one release (`stream_enabled=off`).
3. Confirm cache reads on the production provider (the card's cache-hit rate); pick `cache_ttl=1h` for lectures with long pauses.
4. Each step needs a backend **restart** (new modules and handler); the UI must be **rebuilt** once for streaming.

### Reverse proxy

Streams use the websocket `/ai/stream?domainId=<domain>` (always root-relative — Hydro matches websocket routes against the original path, so the domain travels in the query, like the judge's `record-conn`) with a polling fallback `GET /ai/stream/:id?from=N`. For nginx:

```nginx
location ~ ^(/d/[^/]+)?/ai/stream {
    proxy_pass http://hydro;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 600s;
}
```

Without websockets everything still works — the client polls every 700 ms, and it polls from the very first moment (the socket only takes over once it is open), so the first words never wait for a handshake. Polling never stops while a stream is open: with a live socket it drops to a 2.5 s safety net (offsets make double delivery impossible), a closed socket brings it back to full speed, and a socket that keeps flapping is abandoned — a reply can never stall on the transport. Text is revealed through a typewriter pacer (`components/aistream/pacer.ts`): even a reply delivered in one burst by a buffering proxy appears word by word.

**Streaming needs the UI build and the backend restart**: the backend answers `{ streamId }` only to pages that send `stream=1`, and a page sends it only when the backend has flagged `UiContext.aiStream` (set by `handler/ai_stream.ts` on every page when its routes are registered and `ai_tutor.stream_enabled` is on). Any mismatch — old bundle, old backend, a dev process whose watcher never loaded the new handler — degrades to the whole-reply requests instead of a request the other side cannot serve. Rebuild with `yarn build:ui:production` (or `node packages/ui-default/build --production`) after deploying.

If an AI chat fails, the reason is shown in the chat itself (AI Studio) or as a notification, and the backend log carries it as `[ai-studio] chat failed …` / `ai.call … outcome=error`.

**No client-side timeouts, by site policy.** The platform never times a provider call out on its own: a call ends when the provider ends it — a completed reply (`[DONE]` / `message_stop`, or 1.5 s of silence after the provider's own stop reason for gateways that omit the marker), an error status or event, or the provider closing the connection — or when the caller cancels it (a student who left; an abandoned interactive stream). If the provider drops a stream after sending part of a reply, what it sent (and billed) is kept. A connection that goes completely silent is reported by Node's HTTP client after its own five-minute limits as a network error; that error, like a provider-reported timeout, is retried at most once. `ai_tutor.timeout` and `sched_first_token_timeout` are no longer used.

### Limits are per process

Slots, queues, single-flight keys and streams are in memory. With several backend workers the effective limit is `sched_slots × workers` and a stream must be read from the worker that created it (sticky sessions, or one worker for `/ai/*`). A restart drops queued work; job runners (Quick Review, reports, Explain) resubmit their units themselves.

## What changed where

- `lib/ai_scheduler.ts` — scheduler, `AiBusyError` (HTTP 503, params `[ahead, etaSeconds, retryAfter]`), `runWhenCapacity`, `mapLimit`.
- `lib/ai_stream.ts` — stream registry, `startStreamJob`, SSE parser + Anthropic/OpenAI decoders, `JsonFieldStreamer`.
- `lib/ai_prompt.ts` — cached prefixes, cache keys, five-line summaries, `codeDelta`.
- `lib/ai_metrics.ts` — rings, counters, usage normalisation, the `ai.call …` log line.
- `lib/ai_tutor.ts` — streaming transport, signals, cache blocks, `scheduled()`, tutor engines on cached prefixes / summaries / diffs.
- `handler/ai_stream.ts` — websocket, polling fallback, `/ai/status`.
- `handler/self_learning.ts`, `handler/knowledge.ts`, `lib/assistant.ts`, `lib/objective_feedback.ts`, `lib/quick_review.ts`, `lib/activity_report.ts`, `lib/knowledge_map.ts`, `handler/ai_author.ts` — call sites on the scheduler; every chat surface as a stream job (tutor card question and reply, assistant, AI Suggestions, the AI Studio statement-review chat, the session-editor advisor); job runners without worker pools, reporting "waiting for capacity".
- `model/selflearning.ts` (`summary`, `lastSentCode`, suggestion `job`), `model/quick_review.ts`, `model/objective_feedback.ts` (`waiting`).
- `ui-default/components/aistream/index.ts`, `pages/self_learning_solve.page.js`, `pages/assistant.page.js`, `pages/auto_scratchpad.page.js`, `pages/ai_studio_detail.page.js`, `pages/self_learning_edit.page.js`, `pages/quick_review.page.js`, `pages/ai_class_report.page.js`, `pages/homework_objective_feedback.page.js`, `pages/ai_status.page.js`, locales.

### Which AI output streams word by word

| Surface | Streamed | How |
|---|---|---|
| Tutor card: the next question | yes | the `question` field, into the waiting chip / overlay while the JSON is written; the card opens with the complete question |
| Tutor card: the reply to an answer | yes | the `reply` field into a live bubble |
| Personal assistant | yes | the final answer; tool phases as status lines |
| AI Suggestions report | yes | Markdown into the result modal |
| AI Studio statement-review chat | yes | the `REPLY:` line; a revised statement (if any) arrives with the final result |
| Session-editor advisor | yes | the "learning path" narrative, then the validated task list |
| Explain (objective answers) — a student's own click | yes | the explanation into the panel (interactive lane, class 1); pre-warmed reports are background jobs |
| AI Studio statement / questions drafting | yes | the draft body into a live preview in the statement pane; the saved draft replaces it |
| Quick Review, class / session reports, grading, attribution | no — jobs | analytics, not chat: generated in the background and shown when complete (with "waiting for capacity" states) |

### What makes the answer arrive sooner

- **Nothing waits inside a web request**: every chat surface answers `{ streamId }` at once and the first words arrive as soon as the provider produces them (polling starts immediately; the socket takes over when open).
- **Prefix caching** (shared task prefix, per-thread summary breakpoint) shortens the provider's time to first token and cost; the Anthropic output ceiling is remembered per model so no call pays a rejected round trip.
- **Interactive lane + reserve, class 0 for every call a student is waiting on** (tutor reply *and* next question), per-user round-robin; a student's background work (thread summary, pre-warm) never counts against their interactive slot.
- **Adaptive concurrency**: the limit grows while the provider keeps up (measured: a 60-student burst's first-words p95 fell from 1.9 s to 1.1 s as the limit rose 12 → 23), and halves on a rate limit — no 429 storms either way.
- **Retry-After honoured**: after a 429 everyone pauses for exactly what the provider asked (≥ 250 ms), not a fixed 4 s (measured under 15 % injected 429s: first words p50 13.2 s → 6.3 s).
- **Fail fast under overload**: a request that could not be served within `sched_max_wait` is refused immediately with a countdown and automatic retry instead of hanging.

## Tests and the load harness

```sh
yarn test:ai            # scheduler (fake clock), streaming/prompt/summary/diff, transport against the fake provider
yarn test:ai-load       # 200 students / 60 s / 12 s latency — asserts the M1/M2 criteria (≈ 5 min)
FAST=1 yarn test:ai-load 60 20 12000 0.15   # quick smoke run with a 15 % 429 rate (latencies scaled down 20×)
node -r @hydrooj/register test/ai_load/fake_provider.ts 18080   # the fake provider alone (point ai_tutor.base_url at it)
```

The unit and transport specs need no database (`global.Hydro` is stubbed and the settings service replaced by a map); `yarn test` runs them before the application test.

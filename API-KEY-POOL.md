# Using many API keys concurrently — design and implementation

*PTA fork · `packages/hydrooj/src/lib/ai_keys.ts` · integrated with the AI scheduler and transport*

## 1. Goal and the one thing to know first

The goal is that the platform's AI throughput is the **sum of what all keys allow**, that one key's rate limit or failure is **that key's problem alone**, and that keys are used in a way that keeps the provider's **prompt cache** effective. All of that is implemented and measured below.

The one thing to know first is what a key actually buys you, because it decides whether 100 keys are 100× or 1×:

| Provider | Where the limit lives | What extra keys of the *same* account give you |
|---|---|---|
| OpenAI | organization (and per-project caps below it) | nothing — keys in one org share the org's RPM/TPM; only separately limited orgs/projects add capacity |
| Anthropic | organization | nothing within one org |
| DeepSeek | account | nothing within one account |

So the pool pays off when the keys belong to **separately limited units**: several organisations or projects with their own limits, an enterprise agreement that grants per-project quotas, or — the natural case for this product — **each customer university bringing its own key** (BYOK), which the pool supports with tenant-scoped keys. Creating many accounts with one provider to evade its limits violates OpenAI's and Anthropic's terms; the pool is not a tool for that, and it will not help there anyway because such accounts get throttled together.

## 2. Design

### 2.1 Per-key state
Every key carries its own:
- **adaptive concurrency limit** `limit ∈ [1, maxInflight]` — AIMD like the scheduler's: +1 after four successes that completed with the key saturated; halved on a 429 (never below 1);
- **request window** for an optional per-key requests-per-minute budget;
- **health**: `ok` → usable; `cooling` (429, back after the provider's `Retry-After`, ≥ 250 ms ≤ 60 s); `paused` (five consecutive errors, 5 min quarantine); `disabled` (401 = invalid key, for good; 402 / "insufficient balance" = quota, re-probed hourly);
- statistics (calls, errors, 429s) and a short **hash id** — secrets never appear in status or logs.

### 2.2 Selection: cache-aware, load-aware, tenant-aware
1. **Tenant first**: a request from domain *d* uses keys scoped `domain=d` if any; otherwise the shared keys.
2. **Affinity**: among keys with room, **rendezvous hashing** of the request's cache key (the same task for every student — `<domain>:<feature>:<pid>:<prefix hash>`) picks the same key every time while that key has room, so a cached prefix lives on as few keys as possible; when it is full the deterministic runner-up takes over. Weights bias the hash.
3. **No affinity** (requests without a cached prefix): least-loaded key (lowest in-flight share of its limit), ties by weight.
4. **No room anywhere**: the caller waits for the next capacity event (a release, a cool-down ending) — never a spin, never a timer of its own.

### 2.3 Integration with the scheduler
- The pool reports `capacity = { limit: Σ limits of usable keys, available, nextFreeAt }`. The scheduler's in-flight limit becomes `min(its own limit, pool.limit)`, it dispatches only while `available > 0`, and the pool **wakes it** the moment a key returns.
- A **429 belongs to one key**: the pool cools that key and halves its limit; the scheduler no longer applies its process-wide cool-down or halves its global limit when other keys have room, and the retry moves to another key after ~250–500 ms instead of waiting the full `Retry-After`. When every key is exhausted, the shared cool-down applies as before.
- A key rejected by the provider (401/402) is sidelined **inside the call**: the transport takes another key and resends, so the student never sees the bad key.
- Everything else (lanes, classes, fairness, admission control, streaming, no client-side timeouts) is unchanged.

### 2.4 Configuration — the API key box
On `/manage/setting` → AI Tutor, root selects the provider, enters the model name (and optionally the base URL), then enters **one or more keys in the API key box, one per line** and saves. That is the whole configuration; the advanced per-line options remain available for those who want them:
```
sk-…A
sk-…B | label=deepseek-02 | max=8 | rpm=600
sk-…C | label=cs101-byok | max=6 | domain=cs101
```
The box shows the keys saved for the selected provider (the page is root-only and behind sudo) and follows the provider dropdown; edit and save to replace, empty it to save no keys for that provider. The keys are **remembered per provider** (hidden settings `provider_keys` / `api_key_provider`, maintained when the form is saved): switching the provider uses that provider's own keys, and switching back restores the previous ones. Defaults per key come from `ai_tutor.key_max_inflight` (8) and `ai_tutor.key_rpm` (0). Keys that stay across a re-save keep their learned limits and health.

### 2.5 Observability
`GET /ai/status` → `keys`: per key (hash id, label, tenant) health and reason, in-flight / learned limit / ceiling, rpm used, calls, 429s, errors, cool-down remaining; plus usable count and capacity. The settings-page card shows the same table.

## 3. Measured

Fake provider, 600 ms per call, **each key limited to 4 concurrent requests** (the pool is deliberately told 6, so it has to learn the real limit from 429s); a burst of 60 tutor calls; one key invalid (401) and one out of balance (402) in the ten-key run.

| Pool | 60 calls finished in | per-call p50 / p95 | provider peak in flight | keys usable |
|---|---|---|---|---|
| 1 key | 12.6 s | 6.9 s / 12.5 s | 5 | 1/1 |
| 3 keys | 5.1 s | 2.9 s / 5.1 s | 13 | 3/3 |
| 10 keys (2 broken) | 3.7 s | 1.8 s / 3.5 s | 17 | 8/10 |

The learned per-key limits settle at the provider's real limit (halved on the first 429, then grown back one step at a time), the two broken keys are sidelined after their first response, no call fails, and the scheduler's process-wide cool-down stays at 0 throughout — a 429 on one key never pauses the others.

Tests: `test/ai_keys.spec.ts` (8, fake clock: parsing, spreading with per-key limits, cache affinity and spill, per-key 429 cool-down and wake-up, invalid/quota/quarantine handling, rpm budgets, tenant keys, AIMD growth surviving reconfiguration) and an end-to-end transport test through the real scheduler and `callProvider` against per-key provider limits with an invalid key in the pool.

## 4. Operating advice
- Set `max=` per key to the provider's documented concurrency (or leave the default and let AIMD find it); set `rpm=` when the tier's request rate is the binding limit, so the key never hits 429 at all.
- Group keys by cache scope: keys of **one** organisation share its prompt cache — affinity does no harm there; keys of different organisations do not, which is exactly when affinity keeps the hit rate high.
- Watch the status card during the first lecture: a key that keeps cooling is one whose real limit is below its `max=`; a `disabled · quota` key needs a top-up.
- For BYOK customers, scope their keys with `domain=`; their traffic never touches the shared keys, and shared traffic never spends their balance.

# context-savings

Compresses the outgoing LLM context to save money on cache-miss requests, then
**stays compressed** so the savings compound with the number of requests. A
running summary of tokens & dollars saved is kept per session and shown with
`/savings`; `/usage` shows full session usage; `/compress` forces a
compression on demand.

## How it works

Prompt caches expire after an idle gap (Anthropic: 5 min default, 1 h after an
extended-cache write). After a guaranteed cache miss — idle gap > TTL, model
switch, or a context rebuild following compaction — every token of the prompt
is re-billed at full price. When that happens (or when you run `/compress`),
the extension trims the outgoing context:

- keeps only the **latest 20 tool outputs**; older tool results are replaced
  with `[tool output removed for context savings]` (tool *calls* in assistant
  messages are left untouched, so the model still sees what it did and with
  what arguments)
- keeps only the **latest 30 thinking blocks**; older thinking is removed from
  assistant messages. The latest assistant message is never modified
  (Anthropic requires it unmodified)

The trim is then **sticky**: every subsequent request sends the same frozen
trim (the exact toolCallIds + thinking-block positions recorded at
compression time). New tool outputs and thinking blocks are only trimmed by
the *next* compression event, not by a sliding window. This is deliberate:

- **cache-stable** — the prompt prefix stays identical request-to-request, so
  warm requests still get full cache hits (a sliding window would move the
  trim boundary forward and re-bill the tail every request)
- **static impact** — the per-request savings of a compression don't change
  until the next compression, which is what makes the accounting exact

### Accounting (no stacking)

Every request accrues `savings += cumulativeTrimmedTokens × (this request's
trim rate)`, where the trim rate is what those tokens *would* have cost on
that request (see [Pricing](#pricing)). A compression
raises the cumulative level, so if compression 1 leaves `T1` tokens trimmed
and there are X requests, then compression 2 raises the level to `T2` and
there are Y requests afterwards, the total is:

```
X × T1 + Y × T2        (T2 = cumulative trim after compression 2)
```

— not `Y × (T1 + T2 + …)` and not `Y × T2 + Y × T1` counted twice. Each period
is counted at its own cumulative level; the compressed request itself is part
of the period that follows it (it was sent trimmed too).

### What is stored

One `custom` entry per **compression** (never per request) in the session
file, containing the frozen set (toolCallIds + thinking positions) and the
cumulative token count. That's enough for `/savings` to recompute the exact
running summary by walking the session branch (snapshots + each assistant
message's usage) — which is what it does, so the numbers stay correct across
`/reload`, `/resume`, `/tree`, and restarts. The trim itself is a
non-destructive per-request context transform: the session file and TUI still
show full tool outputs and thinking blocks, and pi's own compaction is
unaffected.

### Pricing

`CONTEXT_SAVINGS_RATE_MODE` decides how a trimmed token is valued:

- **`counterfactual`** (default) — on a genuine cache miss the whole prompt is
  re-billed at input price, so trimmed tokens are valued at
  `(cost.input + cost.cacheWrite) / (input + cacheWrite)`. On a warm request
  the untrimmed prefix would have been served from cache, so they're valued at
  the cache-read price `cost.cacheRead / cacheRead` (~10% of input on
  Anthropic). If the provider reports cached tokens as free, the savings for
  that request are genuinely zero.
- **`paid`** — always uses the input/cache-write rate. Simpler, noticeably
  more flattering, and only strictly correct for cache-miss requests.

A request is treated as a cache miss when a non-manual compression snapshot
sits immediately before it (idle expiry, model switch, post-compaction — all
guaranteed misses by construction) **or** when more than one cache TTL elapsed
since the previous billed request. A manual `/compress` is assumed to have hit
a warm cache, since that can't be known after the fact.

## Commands

- `/savings` — running summary:

  ```
  Context savings (current branch):
    1 compression; currently trimming 45.0k tokens/request
    last request:
      cost: ~$0.014 saved (13.9% of $0.097)
      tokens: 45.0k saved (22.5% of 200.0k)
    total:
      cost: ~$0.284 saved (24.4% of $1.16)
      tokens: 540.0k saved (22.5% of 2.40M)
  ```

  `last request` is what the trim saved on the most recent billed request
  alone, priced at that request's own rate and shown as a share of what that
  one request actually cost and actually sent; `total` is the same pair over
  the whole branch. The two cost percentages legitimately differ when the last
  request was warm — its trimmed tokens are valued at the cache-read rate,
  while the branch total also contains cache-miss requests billed at full
  input price.

  The first line doubles as a status indicator: `currently trimming N
  tokens/request` when compression is live, `not trimming now — /compress to
  resume` when the totals below are historical (toggled off, or the frozen trim
  was dropped by a compaction). With no compressions at all it prints a single
  line: `No context compressions in this session yet — /compress to start.`

  Both percentages are measured against what this branch **actually** cost and
  sent (`saved / actual`), so they read as "this much on top of the real bill".
  `tokens saved` is Σ of the trim level over every trimmed request — prompt
  tokens that were never transmitted.

  `/savings detail` adds the per-period breakdown and the active pricing model:

  ```
    periods: 3 req × 2.5k (≈$0.023) + 2 req × 3.4k (≈$0.020)
    pricing: counterfactual (cache-read rate on warm requests, input rate on misses)
  ```
- `/usage` — session token & cost totals (overall + per model), cache
  efficiency, compaction costs, plus the context-savings line.
- `/compress` — toggle compression on/off. `/compress on` and `/compress off`
  set it explicitly; bare `/compress` flips it, except when nothing has been
  compressed yet (then it means "compress now"). `on` while already on
  re-runs the keep-window to pick up newly aged-out output. Works even when
  automatic compression is disabled.

  ```
  context-savings: ON — trims 45.0k tokens/request (~$0.135 each)
    breaks cache: ~$0.513 extra on that request, pays back after ~38 requests
  ```

  The estimate uses the last request's real rates: trimmed tokens are valued
  at the input rate when the toggle breaks the cache, at the cache-read rate
  when it doesn't. Cache impact is judged against the prefix **actually sent
  on the last request** (including requests made before a resume, which the
  provider's cache still holds), not against the toggle state — so flipping off
  and straight back on (or on and straight back off) with no request in between
  is correctly reported as free:

  ```
  context-savings: ON — trims 45.0k tokens/request (~$0.014 each); cache unaffected
  ```

  If the last request is older than the cache TTL there is nothing left to
  invalidate, and the toggle reports `cache already expired` instead of quoting
  a cost. A queued manual compression is dropped on resume or a `/tree` switch
  (it belonged to the old branch); the on/off toggle itself persists.

  While off, the full context is sent and automatic compression cannot fire;
  the frozen trim is kept aside so switching back on restores the identical
  prefix rather than recompressing.

After each *compression request* (when the trim level changes) you get a
one-line warning, e.g.:

```
Warning: tool/thinking compression enabled; trimmed 4.1k tokens (~$0.012 / 3.9%) from this request.
```

Plain sticky requests are trimmed silently (no per-request spam).

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTEXT_SAVINGS_TTL_MS` | `0` = auto | Cache TTL in ms. `0` = 5 min, or 1 h if the previous request used extended (1 h) cache retention. |
| `CONTEXT_SAVINGS_KEEP_TOOL_RESULTS` | `20` | Keep the latest N tool outputs. |
| `CONTEXT_SAVINGS_KEEP_THINKING_BLOCKS` | `30` | Keep the latest M thinking blocks. |
| `CONTEXT_SAVINGS_MIN_CONTEXT_TOKENS` | `8000` | Skip *automatic* compression when the estimated context is below this (0 = off). Manual `/compress` bypasses it. |
| `CONTEXT_SAVINGS_DISABLED` | off | Set `1` to turn off *automatic* compression. `/savings`, `/usage` and manual `/compress` still work. |
| `CONTEXT_SAVINGS_RATE_MODE` | `counterfactual` | `counterfactual` prices trimmed tokens at the cache-read rate on warm requests; `paid` always uses the input/cache-write rate. Read per call, so it can be flipped at runtime. |

## Caveats

- The trim level only grows at compression events; between compressions new
  tool outputs are never trimmed (that's the "static impact" guarantee). If
  your sessions grow a lot between cache misses, consider a lower
  `CONTEXT_SAVINGS_TTL_MS` or occasional `/compress`.
- After a compaction, the frozen trim is dropped and recomputed on the next
  (guaranteed-miss) request.
- Token counts for the trim are estimated at ~chars/4 (same heuristic pi uses
  for compaction), so `$` figures are close, not exact. The *paid rate* per
  request comes from the provider's real usage/cost data.
- A manual `/compress` or a compression event deliberately invalidates the
  prompt prefix — expect a large cache miss on that one request.

## Tests

`node test.mjs` in this directory runs an integration suite (76 assertions)
against a mocked pi API: first compression, stickiness, frozen trim on grown
contexts, the X×T1 + Y×T2 accounting, savings percentages, both pricing modes, compact vs `detail` output, the TTL-gap miss
detector, model switch, post-compaction recompression, the min-context guard,
the `/compress` toggle (including off→on cache-neutrality and window refresh),
reseed from the branch (including ISO-timestamp sessions), and
`/savings`/`/usage` output.

# messaging/ — durable team messaging backend

Pure data layer. No pi runtime imports, no timers, no processes. Everything is
persisted under the run directory and every mutation runs inside the single
`withLock(runDir, …)` critical section from `../registry.ts` — the same lock
that protects `claims.json`, so a thread write and a registry write are one
transaction. **Nothing here takes a second lock**; do not call these functions
from inside another `withLock` block.

## Storage

- `<runDir>/claims.json` — registry. This module reads/writes two new fields:
  - `ChildRecord.team?: string` (absent/blank ⇒ `"none"`, the legacy solo mode)
  - `ChildRecord.acceptingMessages?: boolean` (absent ⇒ accepting; only ever set to `false`)
  - `Registry.teams?: Record<string, { name, goal }>`
- `<runDir>/messages/t-<hex>.json` — one file per thread, written to a temp file
  and `rename()`d into place. Thread and message ids are random hex
  (`t-…` / `m-…`) and validated against a strict regex before touching the
  filesystem, so a caller-supplied id can never escape `messages/`.

Corrupt thread data throws (fail closed); missing directories are fine.

## API (`messaging/index.ts`)

```ts
type Actor = { id: string; generation: number };
type Team  = { name: string; goal: string };
type DeliveryReceipt = {
  actor: Actor; preparedAt: number;
  inbound: string[];   // message ids announced
  full: string[];      // subset of inbound whose body was inlined
  failures: string[];  // message ids whose failure notice was announced
};

defineTeam(runDir, name, goal): Team          // idempotent; goal immutable once members exist
validateTeam(reg, team?): string              // undefined/"none" -> "none"; throws on reserved/unknown
listTeams(runDir): Team[]

sendMessage(runDir, actor, { to, text, reply_to?, needs_reply? }): { message_id, thread_id }
readMessages(runDir, actor, { thread_id?, view?, cursor?, limit? }): { text, details }
prepareDelivery(runDir, actor, closing?): { text, receipt } | null
acknowledgeDelivery(runDir, receipt): void
closeInbox(runDir, actor, reason): void
settleMessages(runDir, id, generation, reason): void
summary(runDir): string
```

### Delivery is two-phase, on purpose

`prepareDelivery` **reads only**. The caller appends `text` to the child's
session as a custom message, observes that the entry is persisted, and only
then calls `acknowledgeDelivery(runDir, receipt)`. A crash in between
re-delivers (acceptable); acknowledging first would silently lose messages.
`acknowledgeDelivery` is idempotent and only ever moves `queued → delivered`,
so it cannot resurrect a message that was marked undelivered meanwhile.

- batch ≤ 8 notifications and ≤ 8000 chars, oldest first (by run-wide `seq`)
- body ≤ 2000 chars is inlined verbatim and counts as fully read on ack
- longer bodies get an announcement only (no preview) and stay unread
- `closing: true` with an empty batch closes the inbox in the same transaction,
  so a `sendMessage` racing the shutdown is rejected instead of lost

### Lifecycle

- `closeInbox` — error/abort path: closes the inbox and marks this generation's
  queued inbound as `undelivered`. Never resurrected for a later generation.
- `settleMessages(id, generation, …)` — the child is over: everything still owed
  to *that generation* fails and its senders get a failure notice, but only if
  the sender is still running on the exact generation that sent it (max 8 queued
  notices per sender generation). Otherwise the notice is `retained` and shows
  up in `summary()`. A record already on a later generation is never mutated.

### Reading

- no `thread_id` ⇒ index of the caller's own threads: counts only, no bodies,
  marks nothing read, unread threads first then newest.
- with `thread_id`: `view: "unread"` (default, incoming only), `"recent"` (last
  10, chronological, includes own/read), `"all"` (chronological).
- output is capped at 8000 chars; `details.cursor` continues over a stable
  snapshot (message prefix pinned + paging-session key), so messages arriving
  mid-paging are invisible until a fresh read.
- only the character ranges actually printed are marked read: a long body is not
  "read" until every byte has been handed over.
- bodies of other agents' threads, other teams, and undelivered inbound are
  never shown; the sender can always inspect their own failed outgoing message.

## Tests

```
node --experimental-strip-types --test messaging/*.test.ts     # 52 tests
```

`concurrency.test.ts` spawns real processes that hammer `sendMessage`
concurrently through the file lock.

# subagents

Spawn, supervise and resume child `pi` sessions from a parent session, with a
coordination layer that keeps several agents from writing over each other.

Six tools are added to the parent (run `/subagents-info` for current token
estimates):

| tool | purpose |
| --- | --- |
| `subagent_spawn` | start a child on a scoped task, optionally with a write claim |
| `subagent_peek` | bounded view of a child: `status` / `digest` / `tail` / `final` |
| `subagent_collect` | wait for children and return their final results |
| `subagent_followup` | resume a child in its existing session instead of re-explaining context to a fresh one; `interrupt: true` stops a running child and redirects it |
| `subagent_stop` | stop a running child and release its territory, keeping its transcript |
| `subagent_team` | define a team and its shared goal; omit arguments to list teams |

## Why territory, not files

A child declares `writes` as **globs** (`["src/auth/**"]`), not a file list, so a
claim also covers files that do not exist yet. Two running children may never
hold overlapping territory; an overlapping spawn is refused before any work
starts. Omitting `writes` produces a read-only child, and a read-only child is
never even *given* the write-coordination tools.

Enforcement lives in `guard.ts`, which runs **inside** each child and vetoes
`write`/`edit` calls outside the claim — including writes attempted through
`bash`. The refusal message tells the model to call `claim_paths` rather than
work around the boundary, and in practice models take that route.

Claims are arbitrated in three tiers, so the parent pays no tokens in the common
case: uncontested claims are auto-granted, contested ones queue and poll, and
only a timeout or a genuine deadlock escalates to the parent.

## Teams and direct messages

Children work independently by default. A child spawned with `team: "<name>"`
receives the team's shared goal in addition to its own task and write claim,
and gets two tools for talking to **its own team only**:

| tool | behaviour |
| --- | --- |
| `message_team({ to, text, reply_to?, needs_reply? })` | message one running teammate; returns immediately. `reply_to` continues a thread. |
| `team_messages({ thread_id?, view?, cursor? })` | no arguments: thread index with unread counts. `thread_id`: unread incoming messages; `view: "recent"` or `"all"` for history (paged). |

- Messages of ≤2,000 characters are delivered automatically at the next
  safe turn boundary, never during a tool call. Longer ones arrive as a notice:
  `New message m-17 (6,420 chars), thread t-3, from agent c-api.`
- A message to a finished agent is refused with
  `Not delivered: c-api has finished. Only the parent can resume it.`
  Messages queued when the recipient ends are marked undelivered and the
  sender is told. Messages never restart an agent.
- `team: "none"` (the default) disables direct messaging entirely; the tools
  are not even registered. `note()` / `notes()` remain run-wide for everyone.
- Messages are not assignments or permissions: territory still moves only via
  `claim_paths` / `release_paths`, and scope changes go to the parent.

Threads are stored as JSON in `.pi/runs/<runId>/messages/`, under the same lock
as the claim registry. Undelivered failures appear in `subagent_collect`;
ordinary exchanges do not reach the parent's context.

## Observability is deliberately split

| channel | cost | used for |
| --- | --- | --- |
| widget below the editor | 0 tokens | live status of running children |
| scrollback card | 0 tokens | one per child at start and finish |
| `/subagents-fleet` | 0 tokens | full transcript inspector |
| completion message | ~40 tokens, triggers a turn | a child finished and its result has not reached you: `Subagent c-x (worker, done) finished. Collect its result with subagent_collect({ ids: ["c-x"] }).` |
| escalation | triggers a turn | **facts only** — a child that cannot proceed |

A completion message wakes an idle parent. While the parent is running it is
held until the current LLM call's tools have finished, then delivered before the
next call, so it is dropped if a `subagent_collect` in that call already returned
the result. Children finishing within a second share one message, and children
you stopped are never announced.

Nothing that is merely a *guess* about a child (the "stuck" heuristic) is allowed
to interrupt the agent; it surfaces on the widget and waits to be noticed.

## Commands

| command | what it does |
| --- | --- |
| `/subagents` | one-line status of the current run |
| `/subagents-fleet` | live two-pane inspector: roster + transcript, for every child in the repo including other sessions' |
| `/subagents-info` | opens an editor buffer with the exact prompts, tool schemas and token costs sent to the parent and to children |
| `/subagents-resume-run` | adopt a previous run so its children can be followed up; restarts nothing on its own |

## Children do not outlive their parent

The parent writes a heartbeat; each child polls it (30s) and stands down if the
parent dies, confirming with both `kill(ppid, 0)` and heartbeat staleness so pid
reuse cannot fool it. A broken stdout pipe counts as proof too. Stand-down waits
for a turn boundary (20s deadline) so work is never cut mid-tool-call, then
marks the child `orphaned`, releases its claim, and sweeps any processes the
child's `bash` tool left behind — pi spawns those detached, so they survive
otherwise.

An orphaned child keeps its full transcript and can be resumed later with
`/subagents-resume-run` + `subagent_followup`.

`/reload` is the exception: it re-imports this extension in the same pi
process, so the old instance hands its run to the new one instead of stopping
anything. Running children keep going, finished ones stay collectable, and a
completion that was about to be announced is announced by the new instance.
pi shows `subagents: kept run <id> across /reload — N running, M finished`.
If the new instance never takes over (its code failed to load, or it is an
incompatible version; see `HANDOFF_VERSION` in `handoff.ts`), the children are
stopped after 30 seconds, as a reload always did before. Quitting, `/new`,
`/resume` and forking still stop every child.

## Configuration

Optional `~/.pi/agent/subagents-config.json`, plus a per-project override in
`<project>/.pi/subagents-config.json` that wins setting by setting. Include only
what you change, and run `/reload` after editing. At session start pi shows which
files are in effect, e.g. `Subagent settings: ~/.pi/agent/subagents-config.json + ./.pi/subagents-config.json`,
or `Subagent settings: defaults`.

```jsonc
{
  "childModel":     "inherit",   // "inherit" | "default" | "provider/model-id"
  "childThinking":  "inherit",
  "childExtensions": ["pi-claude-oauth-adapter", "rtk", "..."],
  "maxConcurrentWriters": 3,
  "maxConcurrentTotal": 8,
  "orphanPollMs":  30000,
  "orphanStaleMs": 120000
}
```

A file that is not valid JSON is ignored whole; a setting with the wrong type
keeps the value from the layer below; unknown keys are ignored. Each problem is
listed under that line as a warning.

The project file is only read when pi trusts the project (see `/trust`), and it
cannot set `childExtensions`, which loads code into every child. Children get
the parent's merged settings rather than reading any file themselves.

Spawn and follow-up results show writer usage against the cap, e.g.
`owns[src/api/**] · writers 2/3`.

`childModel: "inherit"` (the default) means children run on the parent's **live**
model, so switching model mid-session actually reaches them. An agent's own
`model:` frontmatter still wins.

Children start with `--no-extensions` and then get `childExtensions` re-injected
explicitly, because auth/provider adapters are infrastructure rather than
optional — a child without them fails to authenticate.

## Agent definitions

Agents come from `~/.pi/agent/agents/<name>.md` and `.pi/agents/<name>.md`
(project-local shadows global), with `worker` and `scout` built in as fallbacks.

Frontmatter supports `name`, `description`, `model`, `thinking`, `excludeTools`,
`extensions`, `inheritExtensions`.

> **Avoid `tools:`.** An allowlist silently strips extension-contributed tools
> (`web_search`, `mcp`, and the coordination tools this extension installs).
> Use `excludeTools:` instead, which is additive-safe.

## Run artifacts

Everything lands in `.pi/runs/<runId>/` in the project, excluded via
`.git/info/exclude` rather than a tracked `.gitignore`:

```
.pi/runs/<runId>/
├── BOARD.md              # who owns what, projected for children to read
├── claims.json           # registry: state, pid, claim, model, generation
├── findings.jsonl        # notes children leave each other
├── messages/t-*.json     # team message threads and delivery/read state
├── escalations.jsonl     # facts and advisories
├── heartbeat             # parent proof-of-life
└── <childId>/
    ├── system.md         # the child's exact system prompt
    ├── task.md           # one section per generation
    ├── result.md
    └── session/*.jsonl   # full transcript — `pi --session <file>` to resume
```

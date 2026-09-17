# subagents

Spawn, supervise and resume child `pi` sessions from a parent session, with a
coordination layer that keeps several agents from writing over each other.

Four tools are added to the parent (~1.2k tokens of definitions, the extension
adds **nothing** to the system prompt):

| tool | purpose |
| --- | --- |
| `subagent_spawn` | start a child on a scoped task, optionally with a write claim |
| `subagent_peek` | bounded view of a child: `status` / `digest` / `tail` / `final` |
| `subagent_collect` | wait for children and return their final results |
| `subagent_followup` | resume a finished child in its existing session instead of re-explaining context to a fresh one |

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

## Observability is deliberately split

| channel | cost | used for |
| --- | --- | --- |
| widget below the editor | 0 tokens | live status of running children |
| scrollback card | 0 tokens | one per child at start and finish |
| `/subagents-fleet` | 0 tokens | full transcript inspector |
| completion digest | ~60 tokens | only for children you never collected |
| escalation | triggers a turn | **facts only** — a child that cannot proceed |

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

## Configuration

Optional `config.json` in this directory:

```jsonc
{
  "childModel":     "inherit",   // "inherit" | "default" | "provider/model-id"
  "childThinking":  "inherit",
  "childExtensions": ["pi-claude-oauth-adapter", "rtk", "..."],
  "maxConcurrentWriters": 3,
  "orphanPollMs":  30000,
  "orphanStaleMs": 120000
}
```

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
├── escalations.jsonl     # facts and advisories
├── heartbeat             # parent proof-of-life
└── <childId>/
    ├── system.md         # the child's exact system prompt
    ├── task.md           # one section per generation
    ├── result.md
    └── session/*.jsonl   # full transcript — `pi --session <file>` to resume
```

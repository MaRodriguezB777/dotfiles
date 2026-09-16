# pi

Config for [pi](https://github.com/badlogic/pi-mono) (the `@earendil-works/pi-coding-agent` coding agent).

Unlike everything else in this repo, pi does **not** read from `~/.config`. Its
home is `~/.pi/agent/`, so these files are not picked up automatically by
cloning `.config` — symlink them:

```sh
mkdir -p ~/.pi/agent
ln -s ~/.config/pi/extensions ~/.pi/agent/extensions
```

Extensions in that directory are auto-discovered on startup; pi loads every
`.ts` and `.js` file at the top level and every directory containing an
`index.ts`/`index.js`. No settings entry is needed.

## Local extensions

Source lives in [`extensions/`](extensions/).

| extension | what it does |
| --- | --- |
| [`context-savings/`](extensions/context-savings/) | Trims old tool outputs and thinking blocks out of the outgoing context on prompt-cache misses, then keeps the trim frozen so later requests stay cache-compatible. `/savings` reports tokens and dollars saved (per request and per branch), `/compress` toggles it, `/usage` shows session cost totals. See its [README](extensions/context-savings/README.md). |
| [`local-vlm/`](extensions/local-vlm/) | Drives a local llama.cpp vision/LLM server: `/start-local-server` (background load with a model picker), `/local-server-status`, and a `local_vlm_query` tool for asking a local VLM about images and video frames. Expects the `local_llm` repo at `~/projects/local_llm` (override with `LOCAL_LLM_REPO`). |
| [`prompt/`](extensions/prompt/) | Inspect and adjust what pi actually sends: `/prompt:system` dumps the real system prompt into `$EDITOR` read-only, plus tool-listing and per-tool enable/disable commands. |
| [`rtk/`](extensions/rtk/) | Routes bash tool calls through `rtk rewrite` to cut command output tokens. Fails open: if `rtk` is missing or errors, the original command runs unchanged. Requires [`rtk`](https://github.com/rtk-ai/rtk) on `PATH` (`curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh \| sh`). |
| [`auto-session-name.ts`](extensions/auto-session-name.ts) | Renames the session every 5 user messages via claude-haiku, as `<broad goal> ---- <current goal>`. `/rename-now` forces it. |
| [`monitors.ts`](extensions/monitors.ts) | Background cron-style monitors: run a command on an interval and either notify or wake the agent with the output. |
| [`omarchy-system-theme.ts`](extensions/omarchy-system-theme.ts) | Follows the active Omarchy theme, flipping pi between light and dark. |

## npm extensions

Installed from npm rather than vendored here, one `pi install` per package:

```sh
pi install npm:pi-subagents
pi install npm:pi-web-access
pi install npm:pi-goal-x
pi install npm:pi-btw
pi install npm:pi-claude-oauth-adapter
pi install npm:@danielmeneses/pi-llama-swap
pi install npm:@shuv1337/pi-mcp-adapter
```

`pi install` records these in `~/.pi/agent/settings.json` under `packages`
(not tracked here, since that file also holds machine-local state). Two of
them need resource filters in that entry to match this setup:
`pi-claude-oauth-adapter` enables `+extensions/index.ts`, and
`@danielmeneses/pi-llama-swap` disables `-index.ts`.

| package | what it does |
| --- | --- |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | Delegation to child agents and scripted multi-agent workflows (parallel lanes, async runs, worktree isolation). |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) | `web_search`, `fetch_content`, `source_check`: web search across many providers, URL/PDF/GitHub fetching, YouTube and local video analysis. |
| [pi-goal-x](https://github.com/tmonk/pi-goal-x) | `/goal`: conversational goal planning with persistent progress and an independent completion auditor. |
| [pi-btw](https://github.com/dbachelder/pi-btw) | `/btw`: parallel side conversations that don't disturb the main thread. |
| [pi-claude-oauth-adapter](https://github.com/minzique/pi-claude-oauth-adapter) | Anthropic OAuth / Claude Code compatibility, so a Claude subscription can be used for auth. |
| [@danielmeneses/pi-llama-swap](https://github.com/danielmeneses/pi-llama-swap) | llama-swap provider with dynamic local model discovery. |
| [@shuv1337/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | MCP client adapter: exposes Model Context Protocol servers as pi tools. |

Installed packages live in `~/.pi/agent/npm/` (not tracked here); `pi install`
rewrites that directory's `package.json`.

## Not tracked

`~/.pi/agent/` also holds `auth.json`, `settings.json`, `models-store.json`,
`sessions/`, and `mcp*.json`. Those carry credentials or machine-local state
and are deliberately left out of this repo.

# prompt/ — inspect what pi actually sends to the model

A pi extension providing slash commands for looking at, and adjusting, the
real prompt payload of the current session.

## Commands

### `/prompt:system`

Dumps the session's system prompt to a temp file (chmod `444`, so most
editors open it read-only) and opens it in `$VISUAL` / `$EDITOR` (falling
back to `vi`, or `notepad` on Windows). In TUI mode the terminal is handed
over to the editor and restored afterwards. The temp file is deleted when
the editor closes.

### `/prompt:tools`

Renders every **active** tool definition as readable markdown instead of raw
JSON schema and opens it the same way. For each tool you get:

- a heading annotated with the size of the *actual* JSON definition sent to
  the model, e.g. `## bash  (1234 chars ~ 309 tokens)` — measured from
  `JSON.stringify({name, description, parameters})`, tokens estimated at
  ~4 chars/token
- source metadata (builtin/extension, scope, file path)
- the full description
- parameters as a nested bullet list with type, `required`, defaults, enum
  values, and nested object properties (up to 3 levels deep)
- prompt guidelines (`string[]`), rendered as a bullet list, when a tool
  declares them

Configured-but-inactive tools are listed at the bottom with their would-be
sizes, so you can see what enabling them would cost.

### `/prompt:tools-toggle`

Opens an interactive checklist overlay to enable/disable individual tools
for the current session. Each row is a `[x]`/`[ ]` checkbox with the tool's
name and the size of its actual JSON definition right there, e.g.:

```
  pi system  (2145 chars ~ 536 tokens):
    › [x] bash    (471 chars ~ 118 tokens)
      [ ] read    (90 chars ~ 23 tokens)
  prompt  (2048 chars ~ 512 tokens):
      [x] tools-toggle  (2048 chars ~ 512 tokens)
  (1/28)
```

Each group header shows the **aggregate size of every tool in that
extension** (`pi system  (2145 chars ~ 536 tokens):`), not just each tool's
individual size, so you can see what a whole extension costs at a glance.
Every top-level line — the warning, the sort-status line, and every group
header — shares the same 2-column left buffer (`SIDE_PADDING`), so nothing
sits flush against the overlay's edge; tool rows nest one level further
under that.

A `(cursor/total)` position indicator (e.g. `(1/28)`) is always shown below
the list, so you always know which tool you're on and how many there are in
total — not just when the list is scrolled.

No tool descriptions are shown in the list — press `v` on a tool to see
those (see below). Keeping the list to name + size makes it easy to scan
for "what's expensive" without extra clutter.

Before the checklist, a warning is shown, word-wrapped to the overlay width
with a 2-column buffer on each side so it never runs edge-to-edge:

> &nbsp;&nbsp;⚠ Toggling tools will invalidate the prompt cache (~12,345
> tokens currently cached).

The token count comes from `ctx.getContextUsage()` — the current session's
context size, i.e. how much of the cached prompt prefix would need to be
reprocessed (cache miss) on the next turn if the active tool set changes.
If the count isn't known yet (e.g. no turns have run), it says so instead
of guessing. Directly below it, a short status line reads `Sorted by
extension` or `Sorted by token count` (see `s` below).

Controls:

| Key         | Action                                          |
|-------------|----------------------------------------------------|
| `↑` / `k`   | Move up (wraps from the first tool to the last)     |
| `↓` / `j`   | Move down (wraps from the last tool to the first)   |
| `space`     | Toggle the highlighted tool                         |
| `a`         | Turn all tools on                                   |
| `z`         | Turn all tools off                                  |
| `v`         | View the highlighted tool's full docs in `$EDITOR`  |
| `s`         | Cycle sort: by extension ↔ by token count           |
| `enter`     | Apply the changes                                   |
| `esc`       | Cancel — no changes are made                        |

`j`/`k` are vim-style home-row equivalents of `↓`/`↑`. Navigation wraps
around at both ends of the list, so moving up from the first tool jumps to
the last, and moving down from the last jumps back to the first.

**`v` — view a tool's full docs.** Opens the *same* markdown rendering used
by `/prompt:tools` (heading with size, source, full description,
parameters, prompt guidelines), but scoped to just the highlighted tool, in
a read-only `$EDITOR` buffer — exactly like `/prompt:system` and
`/prompt:tools` do. Closing the editor returns you to the checklist with
your selections intact.

**`s` — sort mode.** Cycles between two orderings; the status line under the
warning always shows which one is active (`Sorted by extension` /
`Sorted by token count`):
- **By extension** (default): tools are grouped under a header for their
  owning extension, rendered as an indented subpoint list under each
  header, with the header showing that extension's aggregate token size.
  **`pi system`** (builtin tools) is always the first group; the rest are
  ordered alphabetically. Tools within a group are alphabetical.
- **By token count**: a flat list, largest JSON definition first, so the
  most expensive tools to keep active float to the top.

The cursor tries to stay on the same tool across a sort-mode switch (found
by name in the new order), and headers are never selectable — the cursor
only ever lands on a tool row. When scrolling up lands the cursor on a
group's first tool (including wrapping from the last tool back to the
first), the group's header scrolls into view along with it, so you're never
left looking at a tool with no idea which extension it belongs to.

On apply, it calls `pi.setActiveTools(...)` with the new set and reports a
summary (`enabled: ...; disabled: ...`) plus a reminder that the cache was
invalidated. If nothing actually changed, it no-ops with a plain notice.

## Files

| File                    | Purpose                                                        |
|-------------------------|-----------------------------------------------------------------|
| `index.ts`              | Extension entry point; registers all three commands             |
| `system.ts`             | `/prompt:system` command                                        |
| `tools.ts`              | `/prompt:tools` command + pure rendering/size helpers            |
| `tools-toggle.ts`       | `/prompt:tools-toggle` command; wires pure logic to a real TUI   |
| `tools-toggle-logic.ts` | Pure checklist/diff/render logic for `/prompt:tools-toggle`      |
| `editor.ts`             | Shared read-only-temp-file + `$EDITOR` viewing logic             |
| `tests/`                | Unit tests                                                       |

## Gotchas

**Which object has the tool APIs.** `getActiveTools()` / `getAllTools()` /
`setActiveTools()` live on the **`ExtensionAPI`** object (`pi`) passed to
the extension factory — *not* on the per-command `ExtensionContext` (`ctx`).
Calling `ctx.getActiveTools()` throws `ctx.getActiveTools is not a
function`. Commands therefore capture `pi` in their closure.
(`ctx.getSystemPrompt()` and `ctx.getContextUsage()` do exist on the
context.)

**`promptGuidelines` is an array.** `ToolInfo.promptGuidelines` is
`string[]` (one entry per guideline bullet), not a single string. Calling
`.trim()` on it directly throws `tool.promptGuidelines.trim is not a
function`. `tools.ts` iterates the array and renders each entry as its own
bullet.

**`@earendil-works/pi-tui` isn't resolvable outside the pi runtime.** The
interactive checklist in `/prompt:tools-toggle` needs `Key`/`matchesKey`
from `pi-tui` for robust key handling (arrow keys, kitty keyboard protocol,
etc.), but that package isn't installed under this extensions directory, so
importing it at the top of a file breaks plain `node --test` runs with
`ERR_MODULE_NOT_FOUND`. The fix is the `tools-toggle.ts` /
`tools-toggle-logic.ts` split below — all pure, testable logic (including
sorting/grouping/rendering) lives in `tools-toggle-logic.ts` with zero
`pi-tui` dependency, and only the thin `tools-toggle.ts` wrapper imports
`pi-tui`, which is fine because that file only ever runs inside the real pi
process.

**A tool's real "extension name" isn't in `sourceInfo.source`.** For
non-builtin tools the loader sets `sourceInfo.source` to a generic bucket
like `"local"` or `"sdk"`, not the extension's actual name — that identity
lives in `sourceInfo.path` instead. `deriveExtensionLabel()` in
`tools-toggle-logic.ts` special-cases `"builtin"` → `"pi system"`, then
falls back to parsing `path`: the `node_modules/<pkg>` segment for
npm-installed extensions, the containing directory name for multi-file
extensions (`.../extensions/prompt/index.ts` → `"prompt"`), or the bare
filename for single-file extensions (`.../extensions/monitors.ts` →
`"monitors"`).

**Scrolling up must pull a preceding group header along with it.**
`clampViewportStart` originally only guaranteed the *cursor's row* stayed
visible. That's not enough with headers: scrolling up onto (or wrapping
around to) a group's first tool would show the tool with no header above
it, since the header sits one row earlier and fell outside the window. Fix:
`clampViewportStart` now takes the full `rows` array and, when scrolling up
reveals an earlier row, also walks upward through any header rows that
directly precede it so the header comes into view too.

## Tests

The rendering, diffing, and size helpers are pure functions, so they are
tested with mocks — no pi runtime needed.

```sh
cd ~/.pi/agent/extensions/prompt
node --test tests/*.test.ts
```

Requires Node ≥ 23 (native TypeScript type stripping); on Node 22 add
`--experimental-strip-types`. Note the explicit `tests/*.test.ts` glob —
`node --test tests/` alone does not pick up `.ts` files.

### `tests/tools.test.ts` (`/prompt:tools`)

- token estimation (~4 chars/token, rounding) and the
  `(X chars ~ Y tokens)` annotation format
- `toolJsonSize` measures exactly `JSON.stringify({name, description,
  parameters}).length`
- `schemaType` summaries: primitives, arrays, enums, `anyOf`, `const`,
  missing/empty schemas
- full markdown render: active-only header count, per-tool size headings,
  source line, readable parameter bullets (incl. nested required props),
  no raw JSON-schema leakage
- `promptGuidelines` is `string[]` (not a string) and renders as a bullet
  list; section omitted when empty/absent
- tools without parameters render `**Parameters:** none`
- inactive tools get a summary list, not full sections; section omitted
  when everything is active
- header total equals the sum of the active tools' JSON sizes
- `renderSingleToolMarkdown` (used by `/prompt:tools-toggle`'s `v` key)
  renders the same heading/source/description/parameters/guidelines content
  as one tool's block in the aggregate view, for one tool in isolation

### `tests/tools-toggle-logic.test.ts` (`/prompt:tools-toggle`)

- `deriveExtensionLabel`: `"pi system"` for builtins; directory name for a
  multi-file extension's `index.ts`; bare filename for a single-file
  extension; `node_modules/<pkg>` (including scoped `@scope/pkg`) for
  npm-installed extensions; graceful fallback for missing info
- `buildToggleItems` computes each item's JSON size and group label, and
  marks the initially active tools
- `sortToggleItems`: "extension" mode puts `pi system` first, then other
  groups alphabetically, tools alphabetically within a group; "tokens"
  mode sorts by size descending with name as a tiebreaker
- `nextSortMode` cycles between the two modes; `formatSortModeLabel`
  returns the short status text (`"Sorted by extension"` /
  `"Sorted by token count"`)
- `formatCacheWarning` includes a locale-formatted token count when known,
  and degrades to "cache size unknown" for `null`/`undefined`
- `diffToggle` reports newly enabled/disabled tools, and reports nothing
  when the final state matches the initial state
- `moveCursor` wraps from the first item to the last when moving up, from
  the last to the first when moving down, moves normally in between, and
  is safe for an empty list
- `buildDisplayRows` inserts a header before each new group in extension
  mode — annotated with that group's **aggregate** JSON size across all its
  tools — and emits no headers in tokens mode; `findRowForItemIndex` locates
  a tool's row correctly even with headers interspersed
- `renderToggleItemLine` shows `[x]`/`[ ]`, the tool name, and its
  `(chars ~ tokens)` size annotation, **never** a description;
  `cursorLine` styling applies only to the highlighted row
- `renderHeaderLine` includes the group's aggregate `(chars ~ tokens)` size,
  the shared `SIDE_PADDING` left buffer, and applies header styling with a
  trailing colon
- `renderToggleLines` renders headers (with aggregate size and the same
  `SIDE_PADDING` buffer) above their tools in extension mode, and always
  appends a `(cursor/total)` position indicator — sized by tool count, not
  row count — even when the whole list fits without scrolling; omitted
  only when there are no tools at all
- `clampViewportStart` keeps the target row inside the visible window in
  both directions, **and** pulls a group header into view when scrolling
  up lands on that group's first tool (but not when the target row isn't a
  group's first tool)
- `wrapText` greedily wraps to the given width without breaking words,
  collapses internal whitespace/newlines, and returns `[]` for blank input
  (used to word-wrap the cache warning with side padding in the real UI)

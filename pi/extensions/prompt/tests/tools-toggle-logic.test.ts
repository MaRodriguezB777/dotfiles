/**
 * Tests for the /prompt:tools-toggle pure logic module: checklist building,
 * extension-label derivation, sorting (by extension vs. by token count),
 * display-row grouping, cache-warning wording, diffing, cursor movement, and
 * line rendering. This module has no pi-tui import, so it runs with plain
 * `node --test`. The interactive wiring in tools-toggle.ts needs a real TUI
 * and pi-tui on the module path, so it is not exercised here.
 *
 * Run with:  node --test tests/*.test.ts   (from the prompt/ directory)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildDisplayRows,
	buildToggleItems,
	clampViewportStart,
	deriveExtensionLabel,
	diffToggle,
	findRowForItemIndex,
	formatCacheWarning,
	formatSortModeLabel,
	moveCursor,
	nextSortMode,
	PI_SYSTEM_LABEL,
	renderHeaderLine,
	renderToggleItemLine,
	renderToggleLines,
	SIDE_PADDING,
	sortToggleItems,
	type ToggleItem,
	wrapText,
} from "../tools-toggle-logic.ts";
import { toolJsonSize } from "../tools.ts";
import type { ToolInfoLike, ToolsSource } from "../tools.ts";

function makeSource(active: string[], tools: ToolInfoLike[]): ToolsSource {
	return {
		getActiveTools: () => active,
		getAllTools: () => tools,
	};
}

const bash: ToolInfoLike = {
	name: "bash",
	description: "Execute a bash command.",
	sourceInfo: { source: "builtin", path: "<builtin:bash>" },
};
const read: ToolInfoLike = {
	name: "read",
	description: "Read a file.",
	sourceInfo: { source: "builtin", path: "<builtin:read>" },
};
const promptTools: ToolInfoLike = {
	name: "prompt:tools",
	description: "View tool definitions.",
	sourceInfo: { source: "local", path: "/home/user/.pi/agent/extensions/prompt/index.ts" },
};
const monitorTool: ToolInfoLike = {
	name: "monitor",
	description: "Manage monitors.",
	sourceInfo: { source: "local", path: "/home/user/.pi/agent/extensions/monitors.ts" },
};
const npmTool: ToolInfoLike = {
	name: "subagent",
	description: "Delegate work.",
	sourceInfo: { source: "local", path: "/home/user/.pi/agent/npm/node_modules/pi-subagents/dist/index.js" },
};

test("deriveExtensionLabel labels builtin tools as pi system", () => {
	assert.equal(deriveExtensionLabel({ source: "builtin", path: "<builtin:bash>" }), PI_SYSTEM_LABEL);
});

test("deriveExtensionLabel uses the directory name for a multi-file extension's index entry", () => {
	assert.equal(
		deriveExtensionLabel({ source: "local", path: "/home/user/.pi/agent/extensions/prompt/index.ts" }),
		"prompt",
	);
});

test("deriveExtensionLabel uses the filename for a single-file extension", () => {
	assert.equal(deriveExtensionLabel({ source: "local", path: "/home/user/.pi/agent/extensions/monitors.ts" }), "monitors");
});

test("deriveExtensionLabel extracts the package name for npm-installed extensions", () => {
	assert.equal(
		deriveExtensionLabel({ source: "local", path: "/x/npm/node_modules/pi-subagents/dist/index.js" }),
		"pi-subagents",
	);
});

test("deriveExtensionLabel handles scoped npm packages", () => {
	assert.equal(
		deriveExtensionLabel({ source: "local", path: "/x/node_modules/@scope/pkg/dist/index.js" }),
		"@scope/pkg",
	);
});

test("deriveExtensionLabel falls back gracefully for missing info", () => {
	assert.equal(deriveExtensionLabel(undefined), "unknown");
	assert.equal(deriveExtensionLabel({}), "unknown");
});

test("buildToggleItems computes size and group label per tool, active flags from getActiveTools", () => {
	const items = buildToggleItems(makeSource(["bash"], [bash, read]));
	const bashItem = items.find((i) => i.name === "bash");
	assert.equal(bashItem?.active, true);
	assert.equal(bashItem?.groupLabel, PI_SYSTEM_LABEL);
	assert.equal(bashItem?.sizeChars, toolJsonSize(bash));

	const readItem = items.find((i) => i.name === "read");
	assert.equal(readItem?.active, false);
});

test("sortToggleItems in extension mode puts pi system first, then groups alphabetically, tools alphabetically within a group", () => {
	const items = buildToggleItems(makeSource([], [npmTool, monitorTool, read, bash, promptTools]));
	const sorted = sortToggleItems(items, "extension");
	assert.deepEqual(
		sorted.map((i) => [i.groupLabel, i.name]),
		[
			[PI_SYSTEM_LABEL, "bash"],
			[PI_SYSTEM_LABEL, "read"],
			["monitors", "monitor"],
			["pi-subagents", "subagent"],
			["prompt", "prompt:tools"],
		],
	);
});

test("sortToggleItems in tokens mode sorts by size descending, ties broken by name", () => {
	const items: ToggleItem[] = [
		{ name: "b", active: true, sizeChars: 50, groupLabel: "x" },
		{ name: "a", active: true, sizeChars: 100, groupLabel: "x" },
		{ name: "c", active: true, sizeChars: 100, groupLabel: "x" },
	];
	const sorted = sortToggleItems(items, "tokens");
	assert.deepEqual(
		sorted.map((i) => i.name),
		["a", "c", "b"],
	);
});

test("nextSortMode cycles status -> extension -> tokens -> status", () => {
	assert.equal(nextSortMode("status"), "extension");
	assert.equal(nextSortMode("extension"), "tokens");
	assert.equal(nextSortMode("tokens"), "status");
});

test("formatSortModeLabel is a short, plain label", () => {
	assert.equal(formatSortModeLabel("extension"), "Sorted by extension");
	assert.equal(formatSortModeLabel("tokens"), "Sorted by token count");
	assert.equal(formatSortModeLabel("status"), "Sorted by context status");
});

test("formatCacheWarning includes a formatted token count when known", () => {
	const msg = formatCacheWarning(12345);
	assert.match(msg, /invalidate the prompt cache/);
	assert.match(msg, /~12,345 tokens currently cached/);
});

test("formatCacheWarning degrades gracefully when the count is unknown", () => {
	assert.match(formatCacheWarning(null), /cache size unknown for this session/);
	assert.match(formatCacheWarning(undefined), /cache size unknown for this session/);
});

test("diffToggle reports newly enabled and newly disabled tools", () => {
	const initial = new Set(["bash", "read"]);
	const items: ToggleItem[] = [
		{ name: "bash", active: true, sizeChars: 1, groupLabel: "g" },
		{ name: "read", active: false, sizeChars: 1, groupLabel: "g" }, // turned off
		{ name: "write", active: true, sizeChars: 1, groupLabel: "g" }, // turned on
	];
	const { added, removed, finalActive } = diffToggle(initial, items);
	assert.deepEqual(added, ["write"]);
	assert.deepEqual(removed, ["read"]);
	assert.deepEqual(finalActive.sort(), ["bash", "write"]);
});

test("diffToggle reports no changes when nothing moved", () => {
	const initial = new Set(["bash"]);
	const items: ToggleItem[] = [{ name: "bash", active: true, sizeChars: 1, groupLabel: "g" }];
	const { added, removed } = diffToggle(initial, items);
	assert.deepEqual(added, []);
	assert.deepEqual(removed, []);
});

test("moveCursor wraps from the first item to the last when moving up", () => {
	assert.equal(moveCursor(0, -1, 3), 2);
});

test("moveCursor wraps from the last item to the first when moving down", () => {
	assert.equal(moveCursor(2, 1, 3), 0);
});

test("moveCursor moves normally within bounds", () => {
	assert.equal(moveCursor(1, 1, 3), 2);
	assert.equal(moveCursor(1, -1, 3), 0);
});

test("moveCursor is safe for an empty list", () => {
	assert.equal(moveCursor(0, 1, 0), 0);
	assert.equal(moveCursor(0, -1, 0), 0);
});

test("buildDisplayRows inserts a header before each new group in extension mode, with the group's total size", () => {
	const items: ToggleItem[] = [
		{ name: "bash", active: true, sizeChars: 100, groupLabel: PI_SYSTEM_LABEL },
		{ name: "read", active: true, sizeChars: 50, groupLabel: PI_SYSTEM_LABEL },
		{ name: "monitor", active: true, sizeChars: 30, groupLabel: "monitors" },
	];
	const rows = buildDisplayRows(items, "extension");
	assert.deepEqual(rows, [
		{ kind: "header", label: PI_SYSTEM_LABEL, totalChars: 150 },
		{ kind: "item", itemIndex: 0 },
		{ kind: "item", itemIndex: 1 },
		{ kind: "header", label: "monitors", totalChars: 30 },
		{ kind: "item", itemIndex: 2 },
	]);
});

test("buildDisplayRows has no headers in tokens mode", () => {
	const items: ToggleItem[] = [
		{ name: "bash", active: true, sizeChars: 5, groupLabel: PI_SYSTEM_LABEL },
		{ name: "monitor", active: true, sizeChars: 1, groupLabel: "monitors" },
	];
	const rows = buildDisplayRows(items, "tokens");
	assert.deepEqual(rows, [
		{ kind: "item", itemIndex: 0 },
		{ kind: "item", itemIndex: 1 },
	]);
});

test("findRowForItemIndex locates a tool's row accounting for headers", () => {
	const items: ToggleItem[] = [
		{ name: "bash", active: true, sizeChars: 1, groupLabel: PI_SYSTEM_LABEL },
		{ name: "monitor", active: true, sizeChars: 1, groupLabel: "monitors" },
	];
	const rows = buildDisplayRows(items, "extension");
	assert.equal(findRowForItemIndex(rows, 0), 1); // after the "pi system" header
	assert.equal(findRowForItemIndex(rows, 1), 3); // after the "monitors" header
	assert.equal(findRowForItemIndex(rows, 99), -1);
});

test("renderToggleItemLine shows a checkbox, name, and the chars~tokens size annotation", () => {
	const item: ToggleItem = { name: "bash", active: true, sizeChars: 400, groupLabel: "g" };
	const line = renderToggleItemLine(item, false);
	assert.match(line, /\[x\]/);
	assert.match(line, /bash/);
	assert.match(line, /\(400 chars ~ 100 tokens\)/);
});

test("renderToggleItemLine never includes a tool description", () => {
	const item: ToggleItem = { name: "bash", active: true, sizeChars: 400, groupLabel: "g" };
	const line = renderToggleItemLine(item, false);
	assert.doesNotMatch(line, /Execute/i);
});

test("renderToggleItemLine marks the inactive checkbox distinctly", () => {
	const item: ToggleItem = { name: "read", active: false, sizeChars: 10, groupLabel: "g" };
	const line = renderToggleItemLine(item, false);
	assert.match(line, /\[ \]/);
});

test("renderToggleItemLine applies cursorLine style only to the highlighted row", () => {
	const item: ToggleItem = { name: "bash", active: true, sizeChars: 10, groupLabel: "g" };
	const cursorLine = renderToggleItemLine(item, true, { cursorLine: (t) => `>>${t}<<` });
	const normalLine = renderToggleItemLine(item, false, { cursorLine: (t) => `>>${t}<<` });
	assert.match(cursorLine, /^>>/);
	assert.doesNotMatch(normalLine, /^>>/);
});

test("renderHeaderLine includes the group's aggregate size, the shared side padding, and applies the header style", () => {
	const line = renderHeaderLine("pi system", 561, { header: (t) => `**${t}**` });
	assert.equal(line, `${SIDE_PADDING}**pi system  (561 chars ~ 140 tokens):**`);
});

test("renderToggleLines always shows a (cursor/total) position indicator, sized by tool count not row count", () => {
	const items: ToggleItem[] = [
		{ name: "bash", active: true, sizeChars: 1, groupLabel: PI_SYSTEM_LABEL },
		{ name: "read", active: true, sizeChars: 1, groupLabel: PI_SYSTEM_LABEL },
		{ name: "monitor", active: true, sizeChars: 1, groupLabel: "monitors" },
	];
	const rows = buildDisplayRows(items, "extension"); // 5 rows: 2 headers + 3 items
	const clipped = renderToggleLines(rows, items, 0, 0, 3, 40);
	assert.equal(clipped.length, 4); // 3 visible rows + indicator
	assert.match(clipped.at(-1)!, /\(1\/3\)/);

	// Indicator is shown even when the full list fits with room to spare.
	const full = renderToggleLines(rows, items, 0, 0, rows.length, 40);
	assert.equal(full.length, rows.length + 1); // all rows + indicator
	assert.match(full.at(-1)!, /\(1\/3\)/);
});

test("renderToggleLines omits the position indicator only when there are no tools at all", () => {
	const lines = renderToggleLines([], [], 0, 0, 10, 40);
	assert.deepEqual(lines, []);
});

test("renderToggleLines renders group headers with aggregate size and side padding above their tools in extension mode", () => {
	const items: ToggleItem[] = [
		{ name: "bash", active: true, sizeChars: 100, groupLabel: PI_SYSTEM_LABEL },
		{ name: "monitor", active: true, sizeChars: 30, groupLabel: "monitors" },
	];
	const rows = buildDisplayRows(items, "extension");
	const lines = renderToggleLines(rows, items, 0, 0, rows.length, 40);
	assert.match(lines[0], new RegExp(`^${SIDE_PADDING}pi system {2}\\(100 chars ~ 25 tokens\\):$`));
	assert.match(lines[1], /bash/);
	assert.match(lines[2], new RegExp(`^${SIDE_PADDING}monitors {2}\\(30 chars ~ 8 tokens\\):$`));
	assert.match(lines[3], /monitor/);
});

test("clampViewportStart keeps the target row within the visible window", () => {
	const flatRows = [
		{ kind: "item" as const, itemIndex: 0 },
		{ kind: "item" as const, itemIndex: 1 },
		{ kind: "item" as const, itemIndex: 2 },
		{ kind: "item" as const, itemIndex: 3 },
		{ kind: "item" as const, itemIndex: 4 },
		{ kind: "item" as const, itemIndex: 5 },
	];
	assert.equal(clampViewportStart(flatRows, 0, 0, 5), 0);
	assert.equal(clampViewportStart(flatRows, 5, 0, 5), 1); // row past window end
	assert.equal(clampViewportStart(flatRows, 2, 3, 5), 2); // row moved above the window
	assert.equal(clampViewportStart(flatRows, 4, 2, 5), 2); // row still inside, unchanged
});

test("clampViewportStart pulls a group header into view when scrolling up to its first tool", () => {
	const items: ToggleItem[] = [
		{ name: "bash", active: true, sizeChars: 1, groupLabel: PI_SYSTEM_LABEL },
		{ name: "read", active: true, sizeChars: 1, groupLabel: PI_SYSTEM_LABEL },
		{ name: "monitor", active: true, sizeChars: 1, groupLabel: "monitors" },
	];
	const rows = buildDisplayRows(items, "extension");
	// rows: [header pi system, bash, read, header monitors, monitor]
	const bashRow = findRowForItemIndex(rows, 0); // 1

	// Simulate having scrolled down to the "monitors" group, then wrapping
	// the cursor back up to the first tool ("bash").
	const viewportStart = clampViewportStart(rows, bashRow, 3, 2);
	assert.equal(viewportStart, 0); // includes the "pi system" header, not just bash's row
});

test("clampViewportStart does not pull in a header when the target row isn't a group's first tool", () => {
	const items: ToggleItem[] = [
		{ name: "bash", active: true, sizeChars: 1, groupLabel: PI_SYSTEM_LABEL },
		{ name: "read", active: true, sizeChars: 1, groupLabel: PI_SYSTEM_LABEL },
	];
	const rows = buildDisplayRows(items, "extension"); // [header, bash, read]
	const readRow = findRowForItemIndex(rows, 1); // 2
	const viewportStart = clampViewportStart(rows, readRow, 5, 2);
	assert.equal(viewportStart, readRow); // no header directly precedes "read"
});

test("wrapText greedily wraps words to fit the given width", () => {
	const lines = wrapText("the quick brown fox jumps over the lazy dog", 12);
	for (const line of lines) {
		assert.ok(line.length <= 12, `line too long: "${line}" (${line.length})`);
	}
	assert.equal(lines.join(" "), "the quick brown fox jumps over the lazy dog");
});

test("wrapText collapses internal whitespace/newlines and trims", () => {
	assert.deepEqual(wrapText("  hello   \n  world  ", 40), ["hello world"]);
});

test("wrapText returns an empty array for blank input", () => {
	assert.deepEqual(wrapText("", 40), []);
	assert.deepEqual(wrapText("   ", 40), []);
});

test("buildToggleItems sizes use transcript declarations when provided", () => {
	const registered = { name: "codemode", description: "short", sourceInfo: { source: "builtin" } };
	const src = { getActiveTools: () => ["codemode"], getAllTools: () => [registered, { name: "idle", description: "x" }] };
	const plain = buildToggleItems(src as any);
	const declared = buildToggleItems(src as any, [{ name: "codemode", description: "L".repeat(5000) }]);
	assert.ok(declared.find((i) => i.name === "codemode")!.sizeChars > 5000);
	assert.ok(plain.find((i) => i.name === "codemode")!.sizeChars < 200);
	assert.equal(declared.find((i) => i.name === "idle")!.sizeChars, plain.find((i) => i.name === "idle")!.sizeChars);
	assert.equal(declared.find((i) => i.name === "codemode")!.groupLabel, "pi system");
});

// ---- tool deferral (pi >= 0.9x exposure) ----

import {
	describeToggleDiff,
	formatContextSummary,
	supportsNativeToolChanges,
	toggleItemTag,
} from "../tools-toggle-logic.ts";

const dVlm: ToolInfoLike = { name: "vlm", description: "v", exposure: "deferred", sourceInfo: { source: "local", path: "/e/local-vlm/index.ts" } };
const dMcp: ToolInfoLike = { name: "mcp", description: "m", exposure: "codemode", sourceInfo: { source: "builtin" } };
const dHidden: ToolInfoLike = { name: "ghost", description: "g", exposure: "hidden" };

function deferralItems(): ToggleItem[] {
	return buildToggleItems(makeSource(["bash", "vlm"], [bash, read, dVlm, dMcp, dHidden]));
}

test("buildToggleItems records exposure and initial status, and skips hidden tools", () => {
	const items = deferralItems();
	const by = Object.fromEntries(items.map((i) => [i.name, i]));
	assert.equal(by.ghost, undefined);
	assert.equal(by.bash.initialStatus, "always");
	assert.equal(by.read.initialStatus, "disabled");
	assert.equal(by.vlm.initialStatus, "loaded");
	assert.equal(by.mcp.initialStatus, "deferred");
	assert.equal(by.vlm.exposure, "deferred");
});

test("status sort groups always -> loaded -> deferred -> disabled with headers", () => {
	const items = sortToggleItems(deferralItems(), "status");
	assert.deepEqual(items.map((i) => i.name), ["bash", "vlm", "mcp", "read"]);
	const headers = buildDisplayRows(items, "status")
		.filter((r) => r.kind === "header")
		.map((r) => (r as { label: string }).label);
	assert.deepEqual(headers, ["Always active", "Loaded from deferral", "Deferred, not loaded", "Disabled"]);
});

test("status groups stay put when a tool is toggled (grouped by initial status)", () => {
	const items = sortToggleItems(deferralItems(), "status");
	items.find((i) => i.name === "mcp")!.active = true;
	assert.deepEqual(sortToggleItems(items, "status").map((i) => i.name), ["bash", "vlm", "mcp", "read"]);
});

test("toggleItemTag shows deferred/loaded state and pending changes", () => {
	const by = Object.fromEntries(deferralItems().map((i) => [i.name, i]));
	assert.equal(toggleItemTag(by.bash), "");
	assert.equal(toggleItemTag(by.vlm), "loaded");
	assert.equal(toggleItemTag(by.mcp), "deferred");
	by.mcp.active = true;
	by.vlm.active = false;
	by.bash.active = false;
	by.read.active = true;
	assert.equal(toggleItemTag(by.mcp), "will load");
	assert.equal(toggleItemTag(by.vlm), "will unload");
	assert.equal(toggleItemTag(by.bash), "will disable");
	assert.equal(toggleItemTag(by.read), "will enable");
	assert.match(renderToggleItemLine(by.mcp, false), /\[x\] mcp {2}\(\d+ chars ~ \d+ tokens\) {2}will load$/);
	assert.match(renderToggleItemLine(by.bash, true, { cursorLine: (t) => `<${t}>` }), /will disable>$/);
});

test("formatContextSummary counts what the current checkboxes put in context", () => {
	const items = deferralItems();
	const inCtx = items.filter((i) => i.active).reduce((s, i) => s + i.sizeChars, 0);
	assert.equal(
		formatContextSummary(items),
		`In context: 2 tools (${inCtx} chars ~ ${Math.round(inCtx / 4)} tokens) (1 always, 1 loaded) · 1 deferred · 1 disabled`,
	);
});

test("describeToggleDiff splits enable/disable from load/unload", () => {
	const items = deferralItems();
	const out = describeToggleDiff({ added: ["read", "mcp"], removed: ["bash", "vlm"], finalActive: [] }, items);
	assert.equal(out, "enabled: read; loaded: mcp; disabled: bash; unloaded: vlm");
});

test("cache warning reflects native mid-conversation tool changes", () => {
	assert.equal(supportsNativeToolChanges(undefined), undefined);
	assert.equal(supportsNativeToolChanges({}), false);
	assert.equal(supportsNativeToolChanges({ compat: { supportsMidConvoToolChanges: true } }), false);
	assert.equal(
		supportsNativeToolChanges({ compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } }),
		true,
	);
	assert.equal(formatCacheWarning(1000, true), "");
	assert.match(formatCacheWarning(1000, false), /will invalidate the prompt cache/);
});

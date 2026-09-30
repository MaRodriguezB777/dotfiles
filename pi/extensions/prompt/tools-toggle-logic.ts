/**
 * Pure logic for /prompt:tools-toggle: building the checklist, grouping /
 * sorting, the cache invalidation warning, diffing before/after state, and
 * rendering rows as plain strings (styling is injected via callbacks). No
 * pi-tui import here on purpose, so this file can be unit tested with plain
 * `node --test` without the pi runtime's dependency tree available.
 */

import {
	applyDeclared,
	formatSize,
	isDeferredExposure,
	TOOL_STATUS_LABELS,
	TOOL_STATUS_ORDER,
	toolJsonSize,
	toolStatus,
} from "./tools.ts";
import type { DeclaredToolLike, ToolExposureLike, ToolInfoLike, ToolStatus, ToolsSource } from "./tools.ts";

export interface ToggleItem {
	name: string;
	active: boolean;
	/** Size of the tool's actual JSON definition, in characters. */
	sizeChars: number;
	/** Display label for the owning extension/source ("pi system" for builtins). */
	groupLabel: string;
	/** How the model reaches the tool; `deferred`/`codemode` tools wait for tool_search. */
	exposure?: ToolExposureLike;
	/** Status when the checklist opened; the "status" sort mode groups by it so rows don't jump when toggled. */
	initialStatus: ToolStatus;
}

/** The tool's status given its current (possibly toggled) checkbox. */
export function currentStatus(item: ToggleItem): ToolStatus {
	return toolStatus(item.exposure, item.active);
}

/** Group label shown for pi's builtin tools; always sorted first in "extension" mode. */
export const PI_SYSTEM_LABEL = "pi system";

/**
 * Left buffer applied to every top-level line in the checklist overlay (the
 * cache warning, the sort-status line, group headers, and the position
 * indicator) so nothing sits flush against the overlay's edge. Tool rows
 * add their own indentation on top of this for nesting under a header.
 */
export const SIDE_PADDING = "  ";

/**
 * Derive a human-readable extension/source label for grouping. Builtin tools
 * report `sourceInfo.source === "builtin"`; everything else is a real
 * extension whose useful identity actually lives in `sourceInfo.path`
 * (the loader sets `source` to a generic "local"/"sdk" bucket, not the
 * extension's name) — so this pulls a name out of that path:
 *   - npm-installed extension: the `node_modules/<pkg>` package name
 *   - multi-file extension (e.g. `.../extensions/prompt/index.ts`): the
 *     containing directory name ("prompt")
 *   - single-file extension (e.g. `.../extensions/monitors.ts`): the
 *     filename without extension ("monitors")
 */
export function deriveExtensionLabel(sourceInfo?: { source?: string; path?: string }): string {
	if (!sourceInfo) return "unknown";
	if (sourceInfo.source === "builtin") return PI_SYSTEM_LABEL;
	if (sourceInfo.source === "sdk") return "sdk";

	const p = sourceInfo.path;
	if (!p) return sourceInfo.source ?? "unknown";

	if (p.startsWith("<") && p.endsWith(">")) {
		return p.slice(1, -1);
	}

	const nodeModulesMatch = p.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
	if (nodeModulesMatch) return nodeModulesMatch[1];

	const segments = p.split(/[\\/]/).filter(Boolean);
	const base = segments.at(-1) ?? p;
	const isIndexFile = /^index\.(ts|js|mjs|cjs)$/.test(base);
	if (isIndexFile && segments.length >= 2) {
		return segments.at(-2) as string;
	}
	return base.replace(/\.(ts|js|mjs|cjs)$/, "");
}

/**
 * Build the checklist item list from the current tool state (unsorted; see sortToggleItems).
 * `declared` (from the session transcript) makes sizes reflect what the model
 * was really sent, e.g. codemode's per-request description rewrite.
 */
export function buildToggleItems(source: ToolsSource, declared?: DeclaredToolLike[]): ToggleItem[] {
	const activeSet = new Set(source.getActiveTools());
	return (
		applyDeclared(source.getAllTools(), declared)
			// `hidden` tools can't be activated (setActiveTools ignores them).
			.filter((t: ToolInfoLike) => t.exposure !== "hidden")
			.map((t: ToolInfoLike) => ({
				name: t.name,
				active: activeSet.has(t.name),
				sizeChars: toolJsonSize(t),
				groupLabel: deriveExtensionLabel(t.sourceInfo),
				exposure: t.exposure,
				initialStatus: toolStatus(t.exposure, activeSet.has(t.name)),
			}))
	);
}

export type SortMode = "status" | "extension" | "tokens";

const SORT_MODES: SortMode[] = ["status", "extension", "tokens"];

/**
 * Sort checklist items for display.
 *  - "status" (default): grouped by status when the checklist opened
 *    (always active, loaded from deferral, deferred, disabled); tools
 *    alphabetically within a group.
 *  - "extension": grouped by owning extension, "pi system" first,
 *    then other groups alphabetically; tools alphabetically within a group.
 *  - "tokens": flat, largest JSON definition first (most expensive to keep
 *    active), ties broken alphabetically.
 */
export function sortToggleItems(items: ToggleItem[], sortMode: SortMode): ToggleItem[] {
	const copy = [...items];
	if (sortMode === "status") {
		const rank = (i: ToggleItem) => TOOL_STATUS_ORDER.indexOf(i.initialStatus);
		copy.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
		return copy;
	}
	if (sortMode === "tokens") {
		copy.sort((a, b) => b.sizeChars - a.sizeChars || a.name.localeCompare(b.name));
		return copy;
	}
	copy.sort((a, b) => {
		if (a.groupLabel !== b.groupLabel) {
			if (a.groupLabel === PI_SYSTEM_LABEL) return -1;
			if (b.groupLabel === PI_SYSTEM_LABEL) return 1;
			return a.groupLabel.localeCompare(b.groupLabel);
		}
		return a.name.localeCompare(b.name);
	});
	return copy;
}

/** Cycle status -> extension -> tokens -> status. */
export function nextSortMode(mode: SortMode): SortMode {
	return SORT_MODES[(SORT_MODES.indexOf(mode) + 1) % SORT_MODES.length];
}

export function formatSortModeLabel(mode: SortMode): string {
	if (mode === "status") return "Sorted by context status";
	return mode === "extension" ? "Sorted by extension" : "Sorted by token count";
}

/**
 * Warning shown before the checklist. Tool changes are appended to the
 * transcript as system messages; models that accept mid-conversation
 * `tool_addition`/`tool_removal` blocks (Anthropic, `compat.supportsMidConvo
 * ToolChanges`) keep the cached prefix, others get a full checkpoint, which
 * invalidates it. `nativeToolChanges` undefined = unknown, assume the worst.
 * Returns "" (no notice) when the cache is kept.
 */
export function formatCacheWarning(tokens: number | null | undefined, nativeToolChanges?: boolean): string {
	const size =
		typeof tokens === "number"
			? `~${tokens.toLocaleString("en-US")} tokens currently cached`
			: "cache size unknown for this session";
	if (nativeToolChanges) return "";
	return `Toggling tools will invalidate the prompt cache (${size}).`;
}

/** Whether the model can take tool changes mid-conversation without a cache-breaking checkpoint. */
export function supportsNativeToolChanges(model: { compat?: any } | undefined): boolean | undefined {
	if (!model) return undefined;
	return model.compat?.supportsMidConvoSystemMessages === true && model.compat?.supportsMidConvoToolChanges === true;
}

/** One-line summary of what the current checkbox state puts in context. */
export function formatContextSummary(items: ToggleItem[]): string {
	const counts: Record<ToolStatus, number> = { always: 0, loaded: 0, deferred: 0, disabled: 0, hidden: 0 };
	let inContextChars = 0;
	for (const item of items) {
		const status = currentStatus(item);
		counts[status]++;
		if (item.active) inContextChars += item.sizeChars;
	}
	const inContext = counts.always + counts.loaded;
	return (
		`In context: ${inContext} tools ${formatSize(inContextChars)} ` +
		`(${counts.always} always, ${counts.loaded} loaded) · ${counts.deferred} deferred · ${counts.disabled} disabled`
	);
}

export interface ToggleDiff {
	added: string[];
	removed: string[];
	finalActive: string[];
}

/** Human summary of a diff, distinguishing up-front tools (enable/disable) from deferred ones (load/unload). */
export function describeToggleDiff(diff: ToggleDiff, items: ToggleItem[]): string {
	const deferred = new Set(items.filter((i) => isDeferredExposure(i.exposure)).map((i) => i.name));
	const parts: string[] = [];
	const push = (label: string, names: string[]) => {
		if (names.length > 0) parts.push(`${label}: ${names.join(", ")}`);
	};
	push("enabled", diff.added.filter((n) => !deferred.has(n)));
	push("loaded", diff.added.filter((n) => deferred.has(n)));
	push("disabled", diff.removed.filter((n) => !deferred.has(n)));
	push("unloaded", diff.removed.filter((n) => deferred.has(n)));
	return parts.join("; ");
}

/** Compute which tools were enabled/disabled relative to the initial active set. */
export function diffToggle(initialActive: Set<string>, items: ToggleItem[]): ToggleDiff {
	const finalActive = items.filter((i) => i.active).map((i) => i.name);
	const finalSet = new Set(finalActive);
	const added = finalActive.filter((n) => !initialActive.has(n));
	const removed = [...initialActive].filter((n) => !finalSet.has(n));
	return { added, removed, finalActive };
}

/** A row in the rendered checklist: either a non-selectable group header, or a tool. */
export type DisplayRow =
	| { kind: "header"; label: string; totalChars: number }
	| { kind: "item"; itemIndex: number };

/** Header label an item is grouped under in the given mode (undefined = flat list). */
function groupKey(item: ToggleItem, sortMode: SortMode): string | undefined {
	if (sortMode === "extension") return item.groupLabel;
	if (sortMode === "status") return TOOL_STATUS_LABELS[item.initialStatus];
	return undefined;
}

/**
 * Build the rows to render. In "status" and "extension" mode, a header row
 * is inserted before each new group (tools become indented subpoints of it),
 * annotated with the group's aggregate JSON size across all its tools. In
 * "tokens" mode the list is flat with no headers.
 */
export function buildDisplayRows(items: ToggleItem[], sortMode: SortMode): DisplayRow[] {
	const rows: DisplayRow[] = [];
	if (sortMode === "tokens") {
		items.forEach((_, itemIndex) => rows.push({ kind: "item", itemIndex }));
		return rows;
	}

	const groupTotals = new Map<string, number>();
	for (const item of items) {
		const key = groupKey(item, sortMode) as string;
		groupTotals.set(key, (groupTotals.get(key) ?? 0) + item.sizeChars);
	}

	let lastLabel: string | undefined;
	items.forEach((item, itemIndex) => {
		const key = groupKey(item, sortMode) as string;
		if (key !== lastLabel) {
			rows.push({ kind: "header", label: key, totalChars: groupTotals.get(key) ?? 0 });
			lastLabel = key;
		}
		rows.push({ kind: "item", itemIndex });
	});
	return rows;
}

/** Find the row index that renders the given item index (for viewport clamping). */
export function findRowForItemIndex(rows: DisplayRow[], itemIndex: number): number {
	return rows.findIndex((r) => r.kind === "item" && r.itemIndex === itemIndex);
}

export interface ToggleLineStyle {
	cursorLine?: (text: string) => string;
	activeMark?: (text: string) => string;
	inactiveMark?: (text: string) => string;
	name?: (text: string) => string;
	size?: (text: string) => string;
	header?: (text: string) => string;
	tag?: (text: string) => string;
}

const identity = (text: string) => text;

function resolveStyle(style: ToggleLineStyle): Required<ToggleLineStyle> {
	return {
		cursorLine: style.cursorLine ?? identity,
		activeMark: style.activeMark ?? identity,
		inactiveMark: style.inactiveMark ?? identity,
		name: style.name ?? identity,
		size: style.size ?? identity,
		header: style.header ?? identity,
		tag: style.tag ?? identity,
	};
}

const PENDING_TAGS: Partial<Record<ToolStatus, string>> = {
	always: "will enable",
	loaded: "will load",
	deferred: "will unload",
	disabled: "will disable",
};

/**
 * Short status tag after the size: a pending change when the checkbox
 * differs from how the checklist opened, otherwise `deferred`/`loaded` for
 * tools that wait on tool_search (up-front tools need no tag; the checkbox
 * says it all). Empty string = no tag.
 */
export function toggleItemTag(item: ToggleItem): string {
	const status = currentStatus(item);
	if (item.initialStatus && status !== item.initialStatus) return PENDING_TAGS[status] ?? "";
	return isDeferredExposure(item.exposure) ? status : "";
}

/** Render one checklist row: checkbox, name, its JSON-size/token estimate, and a status tag. */
export function renderToggleItemLine(item: ToggleItem, isCursor: boolean, style: ToggleLineStyle = {}): string {
	const s = resolveStyle(style);
	const checkbox = item.active ? "[x]" : "[ ]";
	const prefix = isCursor ? "› " : "  ";
	const sizeLabel = formatSize(item.sizeChars);
	const tag = toggleItemTag(item);
	const tagLabel = tag ? `  ${tag}` : "";

	if (isCursor) {
		return s.cursorLine(`${prefix}  ${checkbox} ${item.name}  ${sizeLabel}${tagLabel}`);
	}

	const coloredCheckbox = item.active ? s.activeMark(checkbox) : s.inactiveMark(checkbox);
	const coloredName = s.name(item.name);
	const coloredSize = s.size(sizeLabel);
	return `${prefix}  ${coloredCheckbox} ${coloredName}  ${coloredSize}${tag ? `  ${s.tag(tag)}` : ""}`;
}

/** Render a non-selectable group header row, annotated with the group's aggregate JSON size. */
export function renderHeaderLine(label: string, totalChars: number, style: ToggleLineStyle = {}): string {
	const s = resolveStyle(style);
	return `${SIDE_PADDING}${s.header(`${label}  ${formatSize(totalChars)}:`)}`;
}

/**
 * Render the visible window of rows, plus a position indicator
 * ("(cursor/total)") showing which tool is currently highlighted out of the
 * full list — shown whenever there's at least one tool, not only when the
 * list is scrolled/clipped.
 */
export function renderToggleLines(
	rows: DisplayRow[],
	items: ToggleItem[],
	cursor: number,
	viewportStart: number,
	viewportSize: number,
	style: ToggleLineStyle = {},
): string[] {
	const end = Math.min(rows.length, viewportStart + viewportSize);
	const lines: string[] = [];
	for (let i = viewportStart; i < end; i++) {
		const row = rows[i];
		if (row.kind === "header") {
			lines.push(renderHeaderLine(row.label, row.totalChars, style));
		} else {
			lines.push(renderToggleItemLine(items[row.itemIndex], row.itemIndex === cursor, style));
		}
	}
	if (items.length > 0) {
		lines.push(`${SIDE_PADDING}(${cursor + 1}/${items.length})`);
	}
	return lines;
}

/**
 * Clamp the viewport start so the given row index stays visible. When
 * scrolling upward to reveal an earlier row, also pulls a group header into
 * view if it directly precedes that row — otherwise wrapping from the last
 * item back to the first (or moving up to a group's first tool) would show
 * the tool without its group header above it.
 */
export function clampViewportStart(
	rows: DisplayRow[],
	rowIndex: number,
	viewportStart: number,
	viewportSize: number,
): number {
	if (rowIndex < viewportStart) {
		let start = rowIndex;
		while (start > 0 && rows[start - 1]?.kind === "header") {
			start--;
		}
		return start;
	}
	if (rowIndex >= viewportStart + viewportSize) {
		return rowIndex - viewportSize + 1;
	}
	return viewportStart;
}

/**
 * Approximate terminal column width. Strips ANSI escapes and counts UTF-16
 * code units. Good enough for the mostly-ASCII text we render here; not a
 * full grapheme/East-Asian-width implementation.
 */
export function approxWidth(text: string): number {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR sequences
	return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Greedy word-wrap plain text to fit within `width` columns. */
export function wrapText(text: string, width: number): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return [];

	const maxWidth = Math.max(1, width);
	const words = normalized.split(" ");
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (current && approxWidth(candidate) > maxWidth) {
			lines.push(current);
			current = word;
		} else {
			current = candidate;
		}
	}
	if (current) lines.push(current);
	return lines;
}

/** Move the cursor by `delta` (±1), wrapping around at the list boundaries. */
export function moveCursor(cursor: number, delta: number, itemCount: number): number {
	if (itemCount <= 0) return 0;
	return (((cursor + delta) % itemCount) + itemCount) % itemCount;
}

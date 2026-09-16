/**
 * /prompt:tools-toggle
 *
 * Interactive checklist to enable/disable individual tools for this session.
 * Each row shows the tool name and the size of its actual JSON definition
 * ("X chars ~ Y tokens"), so you can see what keeping it active costs. Since
 * the active tool list is part of the cached prompt prefix, changing it
 * invalidates the provider's prompt cache for future turns — a warning with
 * the current cached token count is shown before the checklist.
 *
 * Pure rendering/sorting/diffing logic lives in tools-toggle-logic.ts so it
 * can be unit tested without the pi-tui runtime; this file only wires that
 * logic to a real interactive component.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { viewContentInEditor } from "./editor.ts";
import {
	buildDisplayRows,
	buildToggleItems,
	clampViewportStart,
	diffToggle,
	findRowForItemIndex,
	formatCacheWarning,
	formatSortModeLabel,
	moveCursor,
	nextSortMode,
	renderToggleLines,
	SIDE_PADDING,
	sortToggleItems,
	type SortMode,
	type ToggleItem,
	type ToggleLineStyle,
	wrapText,
} from "./tools-toggle-logic.ts";
import { renderSingleToolMarkdown, type ToolInfoLike, type ToolsSource } from "./tools.ts";

export function registerToolsToggleCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prompt:tools-toggle", {
		description: "Interactively enable/disable tools for this session (invalidates the prompt cache)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("prompt:tools-toggle requires an interactive UI.", "warning");
				return;
			}

			const source = pi as unknown as ToolsSource;
			let items = buildToggleItems(source);
			if (items.length === 0) {
				ctx.ui.notify("No tools are configured for this session.", "warning");
				return;
			}

			let sortMode: SortMode = "extension";
			items = sortToggleItems(items, sortMode);

			const initialActive = new Set(source.getActiveTools());
			const cacheTokens = ctx.getContextUsage()?.tokens;
			const warning = formatCacheWarning(cacheTokens);

			let cursor = 0;
			let viewportStart = 0;
			const viewportSize = 16;
			let viewingDocs = false;

			const result = await ctx.ui.custom<ToggleItem[] | null>(
				(tui, theme, _keybindings, done) => {
					const style: ToggleLineStyle = {
						cursorLine: (t) => theme.fg("accent", t),
						activeMark: (t) => theme.fg("success", t),
						inactiveMark: (t) => theme.fg("dim", t),
						name: (t) => theme.bold(t),
						size: (t) => theme.fg("muted", t),
						header: (t) => theme.fg("accent", theme.bold(t)),
					};

					const viewCurrentToolDocs = async () => {
						if (viewingDocs) return;
						viewingDocs = true;
						try {
							const currentName = items[cursor]?.name;
							const fullTool = (pi.getAllTools() as ToolInfoLike[]).find((t) => t.name === currentName);
							if (!fullTool) {
								ctx.ui.notify(`Could not find tool definition for "${currentName}".`, "error");
								return;
							}
							const markdown = renderSingleToolMarkdown(fullTool);
							await viewContentInEditor(ctx, "pi-prompt-tool-", `${fullTool.name}.md`, markdown);
						} finally {
							viewingDocs = false;
							tui.requestRender(true);
						}
					};

					return {
						render(width: number) {
							const rows = buildDisplayRows(items, sortMode);
							const cursorRow = findRowForItemIndex(rows, cursor);
							viewportStart = clampViewportStart(rows, Math.max(0, cursorRow), viewportStart, viewportSize);

							// Leave a 2-column buffer on each side so the wrapped warning text
							// isn't crammed against the overlay's edges (same buffer used for
							// the sort-status line and group headers via SIDE_PADDING).
							const wrapWidth = Math.max(10, width - SIDE_PADDING.length * 2);
							const warningLines = wrapText(`⚠ ${warning}`, wrapWidth);

							const lines: string[] = [];
							for (const line of warningLines) {
								lines.push(theme.fg("warning", theme.bold(`${SIDE_PADDING}${line}`)));
							}
							lines.push(theme.fg("dim", `${SIDE_PADDING}${formatSortModeLabel(sortMode)}`));
							lines.push("");
							lines.push(...renderToggleLines(rows, items, cursor, viewportStart, viewportSize, style));
							lines.push("");
							lines.push(
								theme.fg(
									"dim",
									"↑↓/jk move (wraps) · space toggle · a all on · z all off · v view tool docs · s sort · enter apply · esc cancel",
								),
							);
							return lines;
						},
						invalidate() {},
						handleInput(data: string) {
							if (matchesKey(data, Key.escape)) {
								done(null);
								return;
							}
							if (matchesKey(data, Key.enter)) {
								done(items.slice());
								return;
							}
							if (matchesKey(data, Key.up) || data === "k") {
								cursor = moveCursor(cursor, -1, items.length);
								tui.requestRender();
								return;
							}
							if (matchesKey(data, Key.down) || data === "j") {
								cursor = moveCursor(cursor, 1, items.length);
								tui.requestRender();
								return;
							}
							if (matchesKey(data, Key.space)) {
								items[cursor].active = !items[cursor].active;
								tui.requestRender();
								return;
							}
							if (data === "a") {
								for (const item of items) item.active = true;
								tui.requestRender();
								return;
							}
							if (data === "z") {
								for (const item of items) item.active = false;
								tui.requestRender();
								return;
							}
							if (data === "s") {
								const currentName = items[cursor]?.name;
								sortMode = nextSortMode(sortMode);
								items = sortToggleItems(items, sortMode);
								const restored = items.findIndex((i) => i.name === currentName);
								cursor = restored >= 0 ? restored : 0;
								viewportStart = 0;
								tui.requestRender();
								return;
							}
							if (data === "v") {
								void viewCurrentToolDocs();
								return;
							}
						},
					};
				},
				{ overlay: true, overlayOptions: { width: "80%", maxHeight: "80%" } },
			);

			if (!result) {
				ctx.ui.notify("Tool toggle cancelled — no changes made.", "info");
				return;
			}

			const { added, removed, finalActive } = diffToggle(initialActive, result);
			if (added.length === 0 && removed.length === 0) {
				ctx.ui.notify("No tool changes made.", "info");
				return;
			}

			pi.setActiveTools(finalActive);

			const parts: string[] = [];
			if (added.length > 0) parts.push(`enabled: ${added.join(", ")}`);
			if (removed.length > 0) parts.push(`disabled: ${removed.join(", ")}`);
			ctx.ui.notify(`Tools updated (${parts.join("; ")}). Prompt cache invalidated.`, "warning");
		},
	});
}

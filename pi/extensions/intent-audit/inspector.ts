/**
 * inspector.ts — the `/audit` panel: a live, framed view of audit settings, the queries on the active
 * branch, and every audit round (including the running one) with the auditor's own transcript.
 *
 * Pure rendering + key handling (no I/O besides reading a finished auditor's transcript file), modelled on
 * the subagents extension's /subagents-fleet inspector.
 */

import * as fs from "node:fs";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface PanelTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export type Ev =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "tool"; id?: string; name: string; args: string; output: string; isError: boolean; ms: number; at?: number };

export type RoundState = "running" | "pass" | "fail" | "error" | "stopped";

export interface IssueView {
	severity: string;
	category?: string;
	description: string;
	fix?: string;
}

export interface RoundView {
	key: string; // report entry id, or "live"
	round: number;
	state: RoundState;
	phase?: string; // for the running round
	startedAt?: number;
	durationMs?: number;
	model?: string;
	thinking?: string;
	cost?: number;
	tokens?: number;
	toolCalls?: number;
	intent?: string;
	summary?: string;
	error?: string;
	issues: IssueView[];
	snapshot?: string;
	baseline?: string;
	manual?: boolean;
	kind?: string; // initial | fix | follow-up | recheck
	trigger?: string; // short label: why the round ran
	triggers?: { entryId: string; source: string; text: string }[];
	exhausted?: boolean;
	transcript?: string; // auditor session file (finished rounds)
	liveEvents?: Ev[]; // in-memory events (running round)
}

export interface QueryView {
	key: string;
	text: string;
	entryId?: string;
	baseline?: string;
	current: boolean; // the most recent query on the branch
	rounds: RoundView[];
}

export interface SettingsView {
	enabled: boolean;
	enabledSrc: string;
	model: string;
	modelSrc: string;
	thinking: string;
	thinkingSrc: string;
	maxRounds: number;
	maxSrc: string;
	loopStopped: boolean;
	configPath: string;
	transcriptsDir: string;
	sessionId: string;
	leafId: string | null;
	branchPoints: number;
	notes: { id: number; text: string; once: boolean }[];
}

export interface PanelModel {
	settings: SettingsView;
	queries: QueryView[];
	running: boolean;
}

export type Item = { kind: "settings" } | { kind: "query"; q: QueryView } | { kind: "round"; q: QueryView; r: RoundView };

export function buildItems(m: PanelModel, collapsed: ReadonlySet<string>): Item[] {
	const items: Item[] = [{ kind: "settings" }];
	for (const q of m.queries) {
		items.push({ kind: "query", q });
		if (!collapsed.has(q.key)) for (const r of q.rounds) items.push({ kind: "round", q, r });
	}
	return items;
}

export function itemKey(i: Item | undefined): string {
	if (!i) return "";
	return i.kind === "settings" ? "settings" : i.kind === "query" ? `q:${i.q.key}` : `r:${i.r.key}`;
}

/* ------------------------------------------------------------ transcripts */

const TAIL_BYTES = 96 * 1024;
const MAX_EVENTS = 200;

function briefArgs(name: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	if (name === "bash") return String(args.command ?? "").replace(/\s+/g, " ");
	const v = args.path ?? args.file_path ?? args.pattern ?? args.query;
	return typeof v === "string" ? v : "";
}
export { briefArgs };

const transcriptCache = new Map<string, { size: number; evs: Ev[] }>();

/** Parse the tail of a finished auditor's session file into displayable events. */
export function readTranscript(file: string | undefined): Ev[] {
	if (!file) return [];
	let size: number;
	try {
		size = fs.statSync(file).size;
	} catch {
		return [];
	}
	const cached = transcriptCache.get(file);
	if (cached && cached.size === size) return cached.evs;
	const from = Math.max(0, size - TAIL_BYTES);
	const fd = fs.openSync(file, "r");
	const buf = Buffer.alloc(size - from);
	try {
		fs.readSync(fd, buf, 0, buf.length, from);
	} finally {
		fs.closeSync(fd);
	}
	const lines = buf.toString("utf8").split("\n");
	if (from > 0) lines.shift();

	const evs: Ev[] = [];
	const pending = new Map<string, { name: string; args: string; at: number }>();
	for (const line of lines) {
		if (!line.trim()) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e?.type !== "message") continue;
		const m = e.message;
		const at = Number(m?.timestamp) || Date.parse(e.timestamp ?? "") || 0;
		if (m?.role === "toolResult") {
			const call = pending.get(m.toolCallId);
			pending.delete(m.toolCallId);
			const text = (m.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
			evs.push({
				kind: "tool",
				name: call?.name ?? m.toolName ?? "tool",
				args: call?.args ?? "",
				output: String(text ?? ""),
				isError: Boolean(m.isError),
				ms: call?.at && at ? at - call.at : 0,
			});
			continue;
		}
		for (const part of m?.content ?? []) {
			if (part?.type === "toolCall") pending.set(part.id, { name: part.name, args: briefArgs(part.name, part.arguments), at });
			else if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
				evs.push({ kind: m.role === "user" ? "user" : "assistant", text: part.text.trim() });
			}
		}
	}
	const out = evs.slice(-MAX_EVENTS);
	transcriptCache.set(file, { size, evs: out });
	return out;
}

/* ---------------------------------------------------------------- helpers */

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width));
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function rightAligned(left: string, right: string, width: number): string {
	const rw = visibleWidth(right);
	const lw = Math.max(0, width - rw - 1);
	return fit(left, lw) + " ".repeat(Math.max(1, width - lw - rw)) + fit(right, rw);
}

export function dur(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function tokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
	return String(n);
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function glyph(state: RoundState, theme: PanelTheme): string {
	switch (state) {
		case "running":
			return theme.fg("accent", "●");
		case "pass":
			return theme.fg("success", "✓");
		case "stopped":
			return theme.fg("warning", "■");
		default:
			return theme.fg("error", "✗");
	}
}

function queryGlyph(q: QueryView, theme: PanelTheme): string {
	const last = q.rounds.at(-1);
	return last ? glyph(last.state, theme) : theme.fg("dim", "○");
}

function roundElapsed(r: RoundView): number {
	return r.durationMs ?? (r.startedAt ? Date.now() - r.startedAt : 0);
}

/* --------------------------------------------------------------- state */

export interface InspectorState {
	model: PanelModel;
	items: Item[];
	collapsed: Set<string>;
	selected: number;
	scroll: number;
	maxScroll: number;
	autoFollow: boolean;
	expandedTools: boolean;
	rows: number;
	flash?: { text: string; at: number };
}

/* ---------------------------------------------------------------- panes */

function rosterLines(st: InspectorState, width: number, height: number, theme: PanelTheme): string[] {
	const start = Math.max(0, Math.min(st.selected - height + 1, Math.max(0, st.items.length - height)));
	return st.items.slice(start, start + height).map((item, off) => {
		const sel = start + off === st.selected;
		const marker = sel ? theme.fg("accent", "›") : " ";
		if (item.kind === "settings") {
			const s = st.model.settings;
			const right = s.enabled ? (s.loopStopped ? theme.fg("warning", "ON · paused") : theme.fg("success", "ON")) : theme.fg("dim", "off");
			return rightAligned(`${marker} ${theme.fg("accent", "⚙")} ${sel ? theme.bold("Settings & notes") : "Settings & notes"}`, right, width);
		}
		if (item.kind === "query") {
			const q = item.q;
			const arrow = st.collapsed.has(q.key) ? "▸" : "▾";
			const text = oneLine(q.text) || "(empty query)";
			const right = theme.fg("dim", `${q.rounds.length} round${q.rounds.length === 1 ? "" : "s"}`);
			return rightAligned(`${marker} ${theme.fg("accent", arrow)} ${queryGlyph(q, theme)} ${sel ? theme.bold(text) : text}`, right, width);
		}
		const r = item.r;
		const why = r.kind === "follow-up" || r.kind === "recheck" ? ` · ${r.trigger ?? r.kind}` : "";
		const label = `round ${r.round}${r.manual ? " (manual)" : ""}${why}`;
		const right = r.state === "running" ? (r.phase ?? "running") : r.state;
		return rightAligned(`${marker}     ${glyph(r.state, theme)} ${sel ? theme.bold(label) : label}`, theme.fg("dim", right), width);
	});
}

function wrapInto(out: string[], text: string, width: number, color: string, theme: PanelTheme, indent = "  ") {
	for (const para of text.split("\n")) {
		if (!para.trim()) continue;
		const hang = indent + " ".repeat(para.match(/^ */)?.[0].length ?? 0);
		wrapTextWithAnsi(para.trim(), Math.max(1, width - hang.length)).forEach((l) => out.push(`${hang}${theme.fg(color, l)}`));
	}
}

function settingsDetail(s: SettingsView, width: number, theme: PanelTheme): { header: string[]; body: string[] } {
	const header = [
		rightAligned(` ${theme.fg("accent", "⚙")} ${theme.bold("Intent audit settings")}`, s.enabled ? theme.fg("success", "ON") : theme.fg("dim", "off"), width),
	];
	const src = (v: string) => theme.fg("dim", `(${v})`);
	const body = [
		`  enabled     ${s.enabled ? "on" : "off"} ${src(s.enabledSrc)}${s.loopStopped ? theme.fg("warning", "  · stopped for the current query — resumes on your next message") : ""}`,
		`  model       ${s.model} ${src(s.modelSrc)}`,
		`  thinking    ${s.thinking} ${src(s.thinkingSrc)}`,
		`  max rounds  ${s.maxRounds || "unlimited"} ${src(s.maxSrc)}`,
		"",
		theme.fg("accent", "Private auditor notes") + theme.fg("dim", " · never shown to the agent"),
	];
	if (!s.notes.length) body.push(theme.fg("dim", "  (none) — /audit add <text>  ·  /audit add-once <text>"));
	for (const n of s.notes) {
		const tag = theme.fg(n.once ? "warning" : "muted", `#${n.id}${n.once ? " once" : ""}`);
		const lines: string[] = [];
		wrapInto(lines, n.text, width - 10, "text", theme, "");
		lines.forEach((l, i) => body.push(i === 0 ? `  ${tag}  ${l}` : `        ${l}`));
	}
	body.push(
		"",
		theme.fg("accent", "Session"),
		theme.fg("dim", `  ${s.sessionId} · leaf ${s.leafId ?? "?"}${s.branchPoints ? ` · ${s.branchPoints} branch point(s) on this path` : " · linear"}`),
		theme.fg("dim", `  global defaults ${s.configPath}`),
		theme.fg("dim", `  auditor transcripts ${s.transcriptsDir}`),
		"",
		theme.fg("accent", "Commands"),
		theme.fg("dim", "  /audit run · /audit stop · /audit on|off"),
		theme.fg("dim", "  /audit add <text> · /audit add-once <text> · /audit remove <id>"),
		theme.fg("dim", "  /audit change model <provider/id|current|default>"),
		theme.fg("dim", "  /audit change thinking <level|inherit|default>"),
		theme.fg("dim", "  /audit change max <n|default>"),
	);
	return { header, body: body.map((l) => truncateToWidth(l, width)) };
}

function queryDetail(q: QueryView, width: number, theme: PanelTheme): { header: string[]; body: string[] } {
	const header = [
		rightAligned(` ${queryGlyph(q, theme)} ${theme.bold(q.current ? "Current query" : "Query")}`, theme.fg("dim", q.entryId ? `entry ${q.entryId}` : ""), width),
	];
	const body: string[] = [];
	wrapInto(body, q.text || "(empty)", width, "text", theme);
	body.push("", theme.fg("dim", `  baseline snapshot ${q.baseline?.slice(0, 12) ?? "none (audit was enabled mid-task)"}`), "", theme.fg("accent", "Rounds"));
	if (!q.rounds.length) body.push(theme.fg("dim", "  (not audited yet)"));
	for (const r of q.rounds) {
		const stats = [r.cost !== undefined ? `$${r.cost.toFixed(3)}` : "", r.toolCalls !== undefined ? `${r.toolCalls} tool${r.toolCalls === 1 ? "" : "s"}` : "", dur(roundElapsed(r))].filter(Boolean).join(" · ");
		body.push(`  ${glyph(r.state, theme)} round ${r.round} ${theme.fg("dim", `· ${r.state === "running" ? (r.phase ?? "running") : r.state}${r.trigger ? ` · ${r.trigger}` : ""} · ${stats}`)}`);
		if (r.summary) wrapInto(body, r.summary, width, "muted", theme, "      ");
	}
	return { header, body: body.map((l) => truncateToWidth(l, width)) };
}

function rail(content: string, theme: PanelTheme): string {
	return `${theme.fg("borderMuted", "│")} ${content}`;
}

function eventLines(evs: Ev[], width: number, theme: PanelTheme, expandedTools: boolean): string[] {
	const out: string[] = [];
	const w = Math.max(8, width);
	for (const ev of evs) {
		if (ev.kind === "tool") {
			const g = ev.ms < 0 ? theme.fg("warning", "●") : ev.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const head =
				ev.name === "bash"
					? theme.fg("toolTitle", theme.bold(`$ ${ev.args}`))
					: `${theme.fg("toolTitle", theme.bold(ev.name))}${ev.args ? ` ${theme.fg("dim", ev.args)}` : ""}`;
			out.push(truncateToWidth(rail(`${g} ${head}`, theme), w));
			const body = ev.output.replace(/\s+$/, "").split(/\r?\n/).filter(Boolean);
			const shown = expandedTools ? body.slice(0, 40) : body.slice(0, 3);
			for (const line of shown) {
				for (const wrapped of wrapTextWithAnsi(theme.fg("toolOutput", line), Math.max(1, w - 4))) {
					out.push(truncateToWidth(rail(`  ${wrapped}`, theme), w));
				}
			}
			const hidden = body.length - shown.length;
			if (hidden > 0) out.push(truncateToWidth(rail(theme.fg("dim", `  … ${hidden} more lines · x to expand`), theme), w));
			continue;
		}
		if (ev.kind === "user") {
			// The first user message is the brief (large); show only its opening lines.
			out.push(truncateToWidth(theme.fg("accent", "▌ brief"), w));
			const lines = ev.text.split("\n").filter((l) => l.trim());
			const shown = expandedTools ? lines.slice(0, 60) : lines.slice(0, 2);
			for (const l of shown) out.push(truncateToWidth(`  ${theme.fg("dim", l)}`, w));
			if (lines.length > shown.length) out.push(truncateToWidth(theme.fg("dim", `  … ${lines.length - shown.length} more lines · x to expand`), w));
			out.push("");
			continue;
		}
		out.push(truncateToWidth(theme.fg("success", "▌ auditor"), w));
		for (const para of ev.text.split(/\n/)) {
			if (!para.trim()) continue;
			for (const wrapped of wrapTextWithAnsi(para, Math.max(1, w - 2))) out.push(truncateToWidth(`  ${wrapped}`, w));
		}
		out.push("");
	}
	return out;
}

function roundDetail(r: RoundView, evs: Ev[], width: number, theme: PanelTheme, expandedTools: boolean): { header: string[]; body: string[] } {
	const stateText = r.state === "running" ? (r.phase ?? "running") : r.exhausted ? "fail · max rounds reached" : r.state;
	const header = [
		rightAligned(` ${glyph(r.state, theme)} ${theme.bold(`Round ${r.round}`)}${r.manual ? theme.fg("dim", " · manual") : ""}`, theme.fg("dim", stateText), width),
	];
	const stats = [
		r.cost !== undefined ? `$${r.cost.toFixed(3)}` : "",
		r.tokens ? `${tokens(r.tokens)} tok` : "",
		r.toolCalls !== undefined ? `${r.toolCalls} tool${r.toolCalls === 1 ? "" : "s"}` : "",
		dur(roundElapsed(r)),
		r.model ?? "",
		r.thinking ? `thinking ${r.thinking}` : "",
	].filter(Boolean);
	header.push(`  ${theme.fg("muted", stats.join(" · "))}`);
	header.push(`  ${theme.fg("dim", `snapshot ${r.snapshot?.slice(0, 12) ?? "—"} · baseline ${r.baseline?.slice(0, 12) ?? "—"}`)}`);
	if (r.trigger) header.push(`  ${theme.fg(r.kind === "follow-up" ? "warning" : "dim", `${r.kind ?? "round"} · ${r.trigger}`)}`);

	const body: string[] = [];
	if (r.error) wrapInto(body, `Error: ${r.error}`, width, "error", theme);
	if (r.triggers?.length) {
		body.push(theme.fg("accent", r.kind === "follow-up" ? "Started again by (not a new user query)" : "Extension messages during this round"));
		for (const t of r.triggers) wrapInto(body, `[${t.source}] ${t.text}`, width, "muted", theme);
	}
	if (r.summary) {
		body.push(theme.fg("accent", "Summary"));
		wrapInto(body, r.summary, width, "text", theme);
	}
	if (r.intent) {
		body.push(theme.fg("accent", "Intent (as understood by the auditor)"));
		wrapInto(body, r.intent, width, "muted", theme);
	}
	if (r.issues.length) {
		body.push(theme.fg("accent", "Issues"));
		for (const i of r.issues) {
			const color = i.severity === "high" ? "error" : i.severity === "medium" ? "warning" : "dim";
			const lines: string[] = [];
			wrapInto(lines, i.description, width - 12, "text", theme, "");
			lines.forEach((l, n) => body.push(n === 0 ? `  ${theme.fg(color, `[${i.severity}]`.padEnd(9))} ${l}` : `            ${l}`));
			if (i.fix) wrapInto(body, `→ ${i.fix}`, width, "muted", theme, "            ");
		}
	}
	if (body.length) body.push("");
	body.push(theme.fg("accent", "Auditor transcript") + theme.fg("dim", r.transcript ? ` · ${r.transcript}` : r.state === "running" ? " · live" : ""));
	const ev = eventLines(evs, width, theme, expandedTools);
	body.push(...(ev.length ? ev : [theme.fg("dim", r.state === "running" ? "  (waiting for the auditor…)" : "  (no transcript)")]));
	return { header: header.map((l) => truncateToWidth(l, width)), body: body.map((l) => truncateToWidth(l, width)) };
}

/* --------------------------------------------------------------- render */

export function renderInspector(
	st: InspectorState,
	evs: Ev[],
	width: number,
	theme: PanelTheme,
): { lines: string[]; viewport: number; maxScroll: number } {
	if (width < 40) return { lines: [truncateToWidth("Intent audit panel needs at least 40 columns. Esc closes.", width)], viewport: 1, maxScroll: 0 };
	const inner = width - 2;
	const bodyHeight = Math.max(3, Math.floor(st.rows * 0.85) - 6);
	const rosterWidth = Math.max(24, Math.min(48, Math.floor((inner - 1) * 0.36)));
	const detailWidth = Math.max(1, inner - rosterWidth - 1);

	const item = st.items[st.selected];
	const roster = rosterLines(st, rosterWidth, bodyHeight, theme);
	const detail =
		item?.kind === "round"
			? roundDetail(item.r, evs, detailWidth, theme, st.expandedTools)
			: item?.kind === "query"
				? queryDetail(item.q, detailWidth, theme)
				: settingsDetail(st.model.settings, detailWidth, theme);

	const viewport = Math.max(1, bodyHeight - detail.header.length);
	const maxScroll = Math.max(0, detail.body.length - viewport);
	const scroll = st.autoFollow && item?.kind === "round" ? maxScroll : Math.min(st.scroll, maxScroll);
	const visible = [...detail.header, ...detail.body.slice(scroll, scroll + viewport)];

	const s = st.model.settings;
	const rounds = st.model.queries.reduce((n, q) => n + q.rounds.length, 0);
	const spend = st.model.queries.reduce((n, q) => n + q.rounds.reduce((m, r) => m + (r.cost ?? 0), 0), 0);
	const title =
		` ${theme.bold("Intent audit")} ` +
		theme.fg("dim", `· ${s.enabled ? "on" : "off"} · ${s.model} · ${rounds} round${rounds === 1 ? "" : "s"} on this branch · $${spend.toFixed(3)}`);
	const live = st.model.queries.flatMap((q) => q.rounds).find((r) => r.state === "running");
	const status = live ? `${glyph("running", theme)} round ${live.round} · ${live.phase ?? "running"} · ${dur(roundElapsed(live))} ` : theme.fg("dim", "idle ");

	const lines = [theme.fg("border", `╭${"─".repeat(inner)}╮`)];
	lines.push(theme.fg("border", "│") + rightAligned(title, status, inner) + theme.fg("border", "│"));
	lines.push(theme.fg("border", `├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┤`));
	for (let i = 0; i < bodyHeight; i++) {
		lines.push(theme.fg("border", "│") + fit(roster[i] ?? "", rosterWidth) + theme.fg("border", "│") + fit(visible[i] ?? "", detailWidth) + theme.fg("border", "│"));
	}
	lines.push(theme.fg("border", `├${"─".repeat(rosterWidth)}┴${"─".repeat(detailWidth)}┤`));
	const flash = st.flash && Date.now() - st.flash.at < 5000 ? st.flash.text : undefined;
	const position = `${st.selected + 1}/${st.items.length}`;
	const footer = flash
		? theme.fg("warning", ` ${flash}`)
		: theme.fg(
				"dim",
				` ↑↓/jk select · h/l fold · J/K PgUp/PgDn scroll · x expand · f follow${st.autoFollow ? "*" : ""} · a audit now · s stop · Esc close · ${position}`,
			);
	lines.push(theme.fg("border", "│") + fit(footer, inner) + theme.fg("border", "│"));
	lines.push(theme.fg("border", `╰${"─".repeat(inner)}╯`));
	return { lines: lines.map((l) => truncateToWidth(l, width)), viewport, maxScroll };
}

/** Plain-text fallback for non-TUI modes. */
export function renderPlain(m: PanelModel): string {
	const s = m.settings;
	const out = [
		`INTENT AUDIT — ${s.enabled ? "ON" : "off"} (${s.enabledSrc})${s.loopStopped ? " · stopped for current query" : ""}`,
		`  model=${s.model} (${s.modelSrc}) · thinking=${s.thinking} (${s.thinkingSrc}) · max rounds=${s.maxRounds || "unlimited"} (${s.maxSrc})`,
		`  notes: ${s.notes.length ? s.notes.map((n) => `#${n.id}${n.once ? "(once)" : ""} ${n.text}`).join(" | ") : "(none)"}`,
	];
	for (const q of m.queries) {
		out.push(`${q.current ? "▶" : "·"} ${oneLine(q.text).slice(0, 100)}`);
		for (const r of q.rounds) {
			out.push(
				`    round ${r.round}${r.trigger ? ` (${r.trigger})` : ""}: ${r.state === "running" ? (r.phase ?? "running") : r.state}${r.cost !== undefined ? ` · $${r.cost.toFixed(3)}` : ""}${r.toolCalls !== undefined ? ` · ${r.toolCalls} tool${r.toolCalls === 1 ? "" : "s"}` : ""} · ${dur(roundElapsed(r))}${r.summary ? ` — ${oneLine(r.summary).slice(0, 160)}` : ""}`,
			);
		}
	}
	return out.join("\n");
}

/* ---------------------------------------------------------------- input */

export type KeyResult = { kind: "close" | "moved" | "handled" | "refresh" | "ignored" | "run" | "stop" };

const SCROLL_STEP = 3;

export function handleKey(st: InspectorState, data: string, viewport: number): KeyResult {
	const scrollBy = (delta: number) => {
		const from = st.autoFollow ? st.maxScroll : Math.min(st.scroll, st.maxScroll);
		st.scroll = Math.max(0, Math.min(st.maxScroll, from + delta));
		st.autoFollow = st.items[st.selected]?.kind === "round" && st.scroll >= st.maxScroll;
	};
	const select = (i: number): KeyResult => {
		if (i < 0 || i >= st.items.length) return { kind: "handled" };
		st.selected = i;
		st.scroll = 0;
		st.autoFollow = st.items[i]?.kind === "round" && st.items[i].kind === "round" && (st.items[i] as any).r.state === "running";
		return { kind: "moved" };
	};
	switch (data) {
		case "\x1b":
		case "q":
		case "\x03":
			return { kind: "close" };
		case "\x1b[A":
		case "k":
			return select(st.selected - 1);
		case "\x1b[B":
		case "j":
			return select(st.selected + 1);
		case "K":
			scrollBy(-SCROLL_STEP);
			return { kind: "handled" };
		case "J":
			scrollBy(SCROLL_STEP);
			return { kind: "handled" };
		case "\x1b[5~":
			scrollBy(-Math.max(1, viewport));
			return { kind: "handled" };
		case "\x1b[6~":
			scrollBy(Math.max(1, viewport));
			return { kind: "handled" };
		case "x":
			st.expandedTools = !st.expandedTools;
			return { kind: "handled" };
		case "f":
			st.autoFollow = !st.autoFollow;
			if (!st.autoFollow) st.scroll = st.maxScroll;
			return { kind: "handled" };
		case "\r":
		case "h":
		case "l": {
			const item = st.items[st.selected];
			if (!item || item.kind === "settings") return { kind: "handled" };
			if (item.kind === "round") {
				if (data !== "h") return { kind: "handled" };
				return select(st.items.findIndex((i) => i.kind === "query" && i.q.key === item.q.key));
			}
			const key = item.q.key;
			const collapse = data === "h" ? true : data === "l" ? false : !st.collapsed.has(key);
			if (collapse) st.collapsed.add(key);
			else st.collapsed.delete(key);
			st.items = buildItems(st.model, st.collapsed);
			st.selected = Math.max(0, st.items.findIndex((i) => i.kind === "query" && i.q.key === key));
			st.scroll = 0;
			st.autoFollow = false;
			return { kind: "moved" };
		}
		case "a":
			return { kind: "run" };
		case "s":
			return { kind: "stop" };
		case "r":
			return { kind: "refresh" };
		default:
			return { kind: "ignored" };
	}
}

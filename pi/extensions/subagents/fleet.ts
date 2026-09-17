/**
 * fleet.ts — /subagents-fleet: a live, read-only inspector for every subagent
 * in this repository, including children owned by OTHER pi sessions.
 *
 * Layout follows the pi-subagents fleet inspector: a bordered frame, a narrow
 * roster on the left, a transcript detail pane on the right, and a key-hint
 * footer with a position counter.
 *
 * This module adds NO behaviour. It never spawns, kills, claims or writes; it
 * only reads `.pi/runs/` and session transcripts. Nothing here reaches the
 * model, so the whole view costs zero tokens.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { pidAlive, readRegistry } from "./registry.ts";
import type { ChildRecord } from "./types.ts";

/** Theme surface used here; matches pi's Theme without importing the class. */
export interface FleetTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface ChildView {
	record: ChildRecord;
	runId: string;
	/** The process is genuinely alive right now, not merely recorded "running". */
	alive: boolean;
	mine: boolean;
	cost: number;
	tokens: number;
	turns: number;
	toolCount: number;
	lastText: string;
	lastAt: number;
	sessionFile: string | null;
}

/* ------------------------------------------------------------------ roster */

interface Scan {
	size: number;
	cost: number;
	tokens: number;
	turns: number;
	toolCount: number;
	lastText: string;
	lastAt: number;
}

/**
 * Transcripts are append-only and reach megabytes, so the roster scan parses
 * each file once and afterwards reads only the newly appended bytes.
 */
const scanCache = new Map<string, Scan>();

function emptyScan(): Scan {
	return { size: 0, cost: 0, tokens: 0, turns: 0, toolCount: 0, lastText: "", lastAt: 0 };
}

function readFrom(file: string, from: number, to: number): string {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const len = Math.max(0, to - from);
			const buf = Buffer.allocUnsafe(len);
			fs.readSync(fd, buf, 0, len, from);
			return buf.toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "";
	}
}

function scanSession(file: string): Scan {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		return emptyScan();
	}
	const prev = scanCache.get(file);
	// A shrinking file was replaced rather than appended to: start over.
	const from = prev && stat.size >= prev.size ? prev.size : 0;
	const acc: Scan = prev && from > 0 ? { ...prev } : emptyScan();

	if (stat.size > from) {
		const chunk = readFrom(file, from, stat.size);
		const lines = chunk.split("\n");
		lines.pop(); // a partial trailing line is normal while a child is writing
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
			const at = Date.parse(m?.timestamp ?? e.timestamp ?? "") || 0;
			if (at > acc.lastAt) acc.lastAt = at;
			if (m?.role === "assistant") {
				acc.turns++;
				const c = m.usage?.cost?.total;
				if (typeof c === "number") acc.cost += c;
				const u = m.usage;
				if (u) acc.tokens = Math.max(acc.tokens, (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0));
			}
			for (const part of m?.content ?? []) {
				if (part?.type === "toolCall") acc.toolCount++;
				else if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
					acc.lastText = part.text.replace(/\s+/g, " ").trim();
				}
			}
		}
	}
	acc.size = stat.size;
	if (!acc.lastAt) acc.lastAt = stat.mtimeMs;
	scanCache.set(file, acc);
	return acc;
}

function findSession(dir: string): string | null {
	try {
		const files = fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => path.join(dir, f));
		if (!files.length) return null;
		return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
	} catch {
		return null;
	}
}

export function collectFleet(root: string, currentRunId: string | null): ChildView[] {
	const base = path.join(root, ".pi", "runs");
	let runIds: string[] = [];
	try {
		runIds = fs.readdirSync(base);
	} catch {
		return [];
	}
	const out: ChildView[] = [];
	for (const runId of runIds) {
		const dir = path.join(base, runId);
		if (!fs.existsSync(path.join(dir, "claims.json"))) continue;
		let children: ChildRecord[];
		try {
			children = Object.values(readRegistry(dir, runId, root).children);
		} catch {
			continue;
		}
		for (const record of children) {
			const sessionFile = record.sessionFile ?? findSession(path.join(dir, record.id, "session"));
			const scan = sessionFile ? scanSession(sessionFile) : emptyScan();
			out.push({
				record,
				runId,
				// Recorded state is a claim; a live pid is evidence. They disagree
				// exactly when a parent died without its child standing down.
				alive: record.state === "running" && pidAlive(record.pid),
				mine: runId === currentRunId,
				cost: scan.cost,
				tokens: scan.tokens,
				turns: scan.turns,
				toolCount: scan.toolCount,
				lastText: scan.lastText,
				lastAt: scan.lastAt || record.endedAt || record.startedAt,
				sessionFile,
			});
		}
	}
	return out.sort((a, b) => {
		if (a.alive !== b.alive) return a.alive ? -1 : 1;
		return b.lastAt - a.lastAt;
	});
}

/* -------------------------------------------------------------- transcript */

export type Ev =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "tool"; name: string; args: string; output: string; isError: boolean; ms: number };

const TAIL_BYTES = 64 * 1024;
const MAX_EVENTS = 200;

/**
 * Parse the tail of one transcript into displayable events. Only the selected
 * child is ever parsed this way, and only its last 64 KB, so opening the view
 * on a very long-running agent stays cheap.
 */
export function readTranscript(file: string): Ev[] {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		return [];
	}
	const from = Math.max(0, stat.size - TAIL_BYTES);
	const chunk = readFrom(file, from, stat.size);
	const lines = chunk.split("\n");
	if (from > 0) lines.shift(); // partial first line after seeking mid-file

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
		const at = Date.parse(m?.timestamp ?? "") || 0;

		if (m?.role === "toolResult") {
			const call = pending.get(m.toolCallId);
			pending.delete(m.toolCallId);
			const text = (m.content ?? [])
				.filter((p: any) => p?.type === "text")
				.map((p: any) => p.text)
				.join("\n");
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
			if (part?.type === "toolCall") {
				pending.set(part.id, { name: part.name, args: briefArgs(part.name, part.arguments), at });
			} else if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
				evs.push({ kind: m.role === "user" ? "user" : "assistant", text: part.text.trim() });
			}
		}
	}
	// Still-running calls have no result yet; show them so a working agent is
	// not silent in the view.
	for (const [, c] of pending) {
		evs.push({ kind: "tool", name: c.name, args: c.args, output: "", isError: false, ms: -1 });
	}
	return evs.slice(-MAX_EVENTS);
}

function briefArgs(name: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	if (name === "bash") return String(args.command ?? "").replace(/\s+/g, " ");
	const v = args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.id ?? args.paths;
	if (Array.isArray(v)) return v.join(", ");
	return typeof v === "string" ? v : "";
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

function dur(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function tokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
	return String(n);
}

function glyph(v: ChildView, theme: FleetTheme): string {
	if (v.alive) return theme.fg("accent", "●");
	switch (v.record.state) {
		case "done":
			return theme.fg("success", "✓");
		case "orphaned":
		case "killed":
			return theme.fg("warning", "■");
		case "running":
			return theme.fg("warning", "■"); // recorded running, process gone
		default:
			return theme.fg("error", "✗");
	}
}

function stateLabel(v: ChildView): string {
	if (v.alive) return "running";
	// The most valuable thing this view can say: the record disagrees with reality.
	if (v.record.state === "running") return "stale";
	return v.record.state;
}

/* --------------------------------------------------------------- rendering */

export interface InspectorState {
	fleet: ChildView[];
	selected: number;
	scroll: number;
	autoFollow: boolean;
	expandedTools: boolean;
	rows: number;
}

function rosterLines(st: InspectorState, width: number, height: number, theme: FleetTheme): string[] {
	if (!st.fleet.length) return [theme.fg("dim", " No tracked children")];
	const start = Math.max(0, Math.min(st.selected - height + 1, Math.max(0, st.fleet.length - height)));
	return st.fleet.slice(start, start + height).map((v, off) => {
		const i = start + off;
		const sel = i === st.selected;
		const marker = sel ? theme.fg("accent", "›") : " ";
		// Several children of the same agent in the same run are common, so the
		// unique child id is what makes a row identifiable; the run id only
		// matters for telling sessions apart.
		const agent = sel ? theme.bold(v.record.agent) : v.record.agent;
		const tag = v.mine ? v.record.id : `${v.record.id} ${v.runId.slice(0, 4)}`;
		const left = `${marker} ${glyph(v, theme)} ${agent} ${theme.fg("dim", `· ${tag}`)}`;
		return rightAligned(left, theme.fg("dim", stateLabel(v)), width);
	});
}

function detailHeader(v: ChildView, width: number, theme: FleetTheme, convo: string): string[] {
	const r = v.record;
	const lines: string[] = [];
	lines.push(rightAligned(` ${glyph(v, theme)} ${theme.bold(r.agent)}`, theme.fg("dim", stateLabel(v)), width));
	const identity = [
		v.mine ? "this session" : "other session",
		r.writes.length ? `owns ${r.writes.length}` : "read-only",
		v.runId.slice(0, 8),
		`gen${r.generation}`,
		r.pid ? `pid ${r.pid}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	lines.push(`  ${theme.fg("dim", identity)}`);
	const stats = [
		v.tokens ? `${tokens(v.tokens)} tok` : "",
		`${v.toolCount} tools`,
		`$${v.cost.toFixed(3)}`,
		dur((r.endedAt ?? Date.now()) - r.startedAt),
		r.model ?? "",
	].filter(Boolean);
	lines.push(`  ${theme.fg("muted", stats.join(" · "))}`);
	lines.push(`  ${theme.fg("muted", `Task ${r.task.replace(/\s+/g, " ")}`)}`);
	lines.push(`${theme.fg("accent", "Conversation")} ${theme.fg("dim", `· ${convo}`)}`);
	return lines.map((l) => truncateToWidth(l, width));
}

function rail(content: string, theme: FleetTheme): string {
	return `${theme.fg("borderMuted", "│")} ${content}`;
}

function detailBody(evs: Ev[], width: number, theme: FleetTheme, expandedTools: boolean): string[] {
	const out: string[] = [];
	const w = Math.max(8, width);
	for (const ev of evs) {
		if (ev.kind === "tool") {
			const g =
				ev.ms < 0 ? theme.fg("warning", "●") : ev.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
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
			if (hidden > 0) {
				out.push(truncateToWidth(rail(theme.fg("dim", `  … ${hidden} more lines · x to expand`), theme), w));
			}
			if (ev.ms > 0) out.push(truncateToWidth(rail(theme.fg("dim", `  Took ${(ev.ms / 1000).toFixed(1)}s`), theme), w));
			continue;
		}
		const label = ev.kind === "user" ? theme.fg("accent", "▌ task") : theme.fg("success", "▌ agent");
		out.push(truncateToWidth(label, w));
		for (const para of ev.text.split(/\n/)) {
			if (!para.trim()) continue;
			for (const wrapped of wrapTextWithAnsi(para, Math.max(1, w - 2))) {
				out.push(truncateToWidth(`  ${wrapped}`, w));
			}
		}
		out.push("");
	}
	return out;
}

/**
 * Pure renderer. Given the state and a terminal size, produce the framed view.
 * Kept free of I/O (the caller supplies the parsed transcript) so the layout
 * can be verified without spawning anything.
 */
export function renderInspector(
	st: InspectorState,
	evs: Ev[],
	width: number,
	theme: FleetTheme,
): { lines: string[]; viewport: number; bodyLines: number } {
	if (width < 36) {
		return {
			lines: [truncateToWidth("Subagent fleet needs at least 36 columns. Esc closes.", width)],
			viewport: 1,
			bodyLines: 0,
		};
	}
	const inner = width - 2;
	const bodyHeight = Math.max(3, Math.floor(st.rows * 0.85) - 6);
	const rosterWidth = Math.max(22, Math.min(46, Math.floor((inner - 1) * 0.38)));
	const detailWidth = Math.max(1, inner - rosterWidth - 1);

	const v = st.fleet[st.selected];
	const roster = rosterLines(st, rosterWidth, bodyHeight, theme);

	let header: string[] = [];
	let body: string[] = [];
	if (v) {
		const last = evs.at(-1);
		const convo =
			last?.kind === "tool"
				? `${last.name} · ${last.ms < 0 ? "running" : last.isError ? "error" : "complete"}`
				: last?.kind === "assistant"
					? "assistant response"
					: last?.kind === "user"
						? "task"
						: "no activity";
		header = detailHeader(v, detailWidth, theme, convo);
		body = detailBody(evs, detailWidth, theme, st.expandedTools);
		if (!body.length) body = [theme.fg("dim", "  (no transcript yet)")];
	} else {
		header = [theme.fg("dim", " No subagents found under .pi/runs/")];
	}

	const viewport = Math.max(1, bodyHeight - header.length);
	const maxScroll = Math.max(0, body.length - viewport);
	const scroll = st.autoFollow ? maxScroll : Math.min(st.scroll, maxScroll);
	const visible = [...header, ...body.slice(scroll, scroll + viewport)];

	const liveCount = st.fleet.filter((f) => f.alive).length;
	const foreign = st.fleet.filter((f) => f.alive && !f.mine).length;
	const spend = st.fleet.reduce((s, f) => s + f.cost, 0);

	const lines = [theme.fg("border", `╭${"─".repeat(inner)}╮`)];
	const title =
		` ${theme.bold("Subagent fleet")} ` +
		theme.fg("dim", `· ${liveCount} live${foreign ? ` (${foreign} elsewhere)` : ""} · $${spend.toFixed(3)}`);
	const status = v ? `${glyph(v, theme)} ${v.record.agent} · ${stateLabel(v)} ` : theme.fg("dim", "no children ");
	lines.push(theme.fg("border", "│") + rightAligned(title, status, inner) + theme.fg("border", "│"));
	lines.push(theme.fg("border", `├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┤`));
	for (let i = 0; i < bodyHeight; i++) {
		lines.push(
			theme.fg("border", "│") +
				fit(roster[i] ?? "", rosterWidth) +
				theme.fg("border", "│") +
				fit(visible[i] ?? "", detailWidth) +
				theme.fg("border", "│"),
		);
	}
	lines.push(theme.fg("border", `├${"─".repeat(rosterWidth)}┴${"─".repeat(detailWidth)}┤`));
	const position = st.fleet.length ? `${st.selected + 1}/${st.fleet.length}` : "0/0";
	const footer =
		` ↑↓/jk agent · PgUp/PgDn scroll · x tools · f follow${st.autoFollow ? "*" : ""} · r refresh · Esc close · ${position}`;
	lines.push(theme.fg("border", "│") + fit(theme.fg("dim", footer), inner) + theme.fg("border", "│"));
	lines.push(theme.fg("border", `╰${"─".repeat(inner)}╯`));

	return { lines: lines.map((l) => truncateToWidth(l, width)), viewport, bodyLines: body.length };
}

/** Plain-text fallback for non-TUI modes (pi -p, json). */
export function renderPlain(fleet: ChildView[]): string {
	if (!fleet.length) return "No subagents found under .pi/runs/.";
	const rows = fleet.map((v) => {
		const r = v.record;
		return (
			`${v.alive ? "●" : "·"} ${r.id.padEnd(7)} ${r.agent.padEnd(8)} ${stateLabel(v).padEnd(8)} ` +
			`${dur(Date.now() - v.lastAt).padStart(7)} $${v.cost.toFixed(3).padStart(7)} ` +
			`${r.writes.length ? `owns[${r.writes.length}]` : "read-only"}${v.mine ? "" : `  run ${v.runId}`}`
		);
	});
	const live = fleet.filter((f) => f.alive).length;
	return [`SUBAGENT FLEET — ${live} live · ${fleet.length} total`, ...rows].join("\n");
}

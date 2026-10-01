/**
 * fleet.ts — /subagents-fleet: a live, read-only inspector for every subagent
 * in this repository, including children owned by OTHER pi sessions.
 *
 * Layout follows the pi-subagents fleet inspector: a bordered frame, a narrow
 * roster on the left, a transcript detail pane on the right, and a key-hint
 * footer with a position counter.
 *
 * Hovering an agent or team and pressing `t` (Enter on an agent) lists its
 * message threads; opening one shows the messages live.
 *
 * This module adds NO behaviour. It never spawns, kills, claims or writes; it
 * only reads `.pi/runs/`, thread files and session transcripts. Nothing here reaches the
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
	/** Largest single request (context size), not tokens spent. */
	tokens: number;
	/** Lifetime billed usage summed over every request. */
	usage: Usage;
	/** Model of the latest request, falling back to the record's. */
	model: string | null;
	/** Lifetime usage split by the model that served each request. */
	byModel: Record<string, ModelUsage>;
	turns: number;
	toolCount: number;
	lastText: string;
	lastAt: number;
	sessionFile: string | null;
	/** Every task given to the child: spawn task, then follow-ups, in order. */
	tasks: string[];
	/** Team message counts; human display only, never sent to a model. */
	messages: MessageCounts;
	/** Threads this child takes part in. */
	threads: ThreadView[];
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelUsage {
	usage: Usage;
	cost: number;
}

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh)$/;
/** A record's model may carry a thinking level ("…:xhigh"); that is not a different model. */
const normalizeModel = (m: string | null | undefined) => (m ? m.replace(THINKING_SUFFIX, "") : null);

const usageTotal = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite;

interface MessageCounts {
	sent: number;
	received: number;
	unread: number;
	undelivered: number;
}

export interface ThreadView {
	id: string;
	/** Thread JSON on disk, re-read only when the thread is opened. */
	file: string;
	team: string;
	/** The two participants, in the order the thread records them. */
	between: [string, string];
	messages: number;
	chars: number;
	unread: number;
	undelivered: number;
	lastAt: number;
	/** Messages sent by each participant. */
	sentBy: Record<string, number>;
}

export interface TeamView {
	runId: string;
	/** "none" collects children without a team, across every run. */
	name: string;
	goal: string;
	mine: boolean;
	members: ChildView[];
	threads: ThreadView[];
	lastAt: number;
}

export type Item = { kind: "team"; team: TeamView } | { kind: "agent"; view: ChildView; team: TeamView };

const EMPTY_COUNTS: MessageCounts = { sent: 0, received: 0, unread: 0, undelivered: 0 };

/** Lock-free read of thread files: a display that is one poll stale is fine. */
function readThreads(runDir: string): ThreadView[] {
	let files: string[] = [];
	try {
		files = fs.readdirSync(path.join(runDir, "messages")).filter((f) => /^t-[0-9a-f]+\.json$/.test(f));
	} catch {
		return [];
	}
	const out: ThreadView[] = [];
	for (const f of files) {
		try {
			const file = path.join(runDir, "messages", f);
			const th = JSON.parse(fs.readFileSync(file, "utf8"));
			const ids = (th.participants ?? []).map((p: any) => String(p.id));
			const t: ThreadView = {
				id: String(th.id),
				file,
				team: String(th.team ?? "none"),
				between: [ids[0] ?? "?", ids[1] ?? "?"],
				messages: 0,
				chars: 0,
				unread: 0,
				undelivered: 0,
				lastAt: 0,
				sentBy: {},
			};
			for (const m of th.messages ?? []) {
				t.messages++;
				t.chars += String(m.text ?? "").length;
				t.lastAt = Math.max(t.lastAt, Number(m.at) || 0);
				t.sentBy[m.from.id] = (t.sentBy[m.from.id] ?? 0) + 1;
				if (m.inbound?.state === "undelivered") t.undelivered++;
				else if (!m.read?.full) t.unread++;
			}
			if (t.messages) out.push(t);
		} catch {
			/* torn or foreign file: skip for display */
		}
	}
	return out.sort((a, b) => b.lastAt - a.lastAt);
}

function countsFor(id: string, threads: ThreadView[], runDir: string): MessageCounts {
	const c = { ...EMPTY_COUNTS };
	for (const t of threads) {
		if (!t.between.includes(id)) continue;
		// Per-message direction is needed for unread/undelivered, so recount.
		try {
			const th = JSON.parse(fs.readFileSync(path.join(runDir, "messages", `${t.id}.json`), "utf8"));
			for (const m of th.messages ?? []) {
				if (m.from.id === id) {
					c.sent++;
					if (m.inbound?.state === "undelivered") c.undelivered++;
				} else if (m.to.id === id) {
					c.received++;
					if (m.inbound?.state !== "undelivered" && !m.read?.full) c.unread++;
				}
			}
		} catch {
			/* skip */
		}
	}
	return c;
}

/* ------------------------------------------------------------------ roster */

interface Scan {
	size: number;
	cost: number;
	tokens: number;
	usage: Usage;
	model: string | null;
	byModel: Record<string, ModelUsage>;
	turns: number;
	toolCount: number;
	lastText: string;
	lastAt: number;
	/** Every task the child was given: the spawn task, then each follow-up. */
	tasks: string[];
}

/** Bounds memory for pathological transcripts; real children get a handful. */
const MAX_TASKS = 50;
const MAX_TASK_CHARS = 20_000;

/**
 * Transcripts are append-only and reach megabytes, so the roster scan parses
 * each file once and afterwards reads only the newly appended bytes.
 */
const scanCache = new Map<string, Scan>();

function emptyScan(): Scan {
	return {
		size: 0,
		cost: 0,
		tokens: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		model: null,
		byModel: {},
		turns: 0,
		toolCount: 0,
		lastText: "",
		lastAt: 0,
		tasks: [],
	};
}

function readBytes(file: string, from: number, to: number): Buffer {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const len = Math.max(0, to - from);
			const buf = Buffer.allocUnsafe(len);
			const n = fs.readSync(fd, buf, 0, len, from);
			return buf.subarray(0, n);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return Buffer.alloc(0);
	}
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
	const acc: Scan =
		prev && from > 0
			? {
					...prev,
					usage: { ...prev.usage },
					tasks: [...prev.tasks],
					byModel: Object.fromEntries(
						Object.entries(prev.byModel).map(([k, v]) => [k, { cost: v.cost, usage: { ...v.usage } }]),
					),
				}
			: emptyScan();

	// Only whole lines are consumed: a child mid-write leaves a partial last
	// line, which is read on a later poll once complete instead of skipped.
	let consumed = from;
	if (stat.size > from) {
		const buf = readBytes(file, from, stat.size);
		const end = buf.lastIndexOf(0x0a);
		consumed = end < 0 ? from : from + end + 1;
		const lines = end < 0 ? [] : buf.subarray(0, end).toString("utf8").split("\n");
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
			if (m?.role === "user") {
				const text = (m.content ?? [])
					.filter((p: any) => p?.type === "text" && typeof p.text === "string")
					.map((p: any) => p.text)
					.join("\n")
					.trim();
				if (text && acc.tasks.length < MAX_TASKS) acc.tasks.push(text.slice(0, MAX_TASK_CHARS));
			}
			if (m?.role === "assistant") {
				acc.turns++;
				const c = m.usage?.cost?.total;
				if (typeof c === "number") acc.cost += c;
				// "" = request without a model name; attributed to the record's model later.
				const model = m.model ? (m.provider ? `${m.provider}/${m.model}` : String(m.model)) : "";
				if (model) acc.model = model;
				const u = m.usage;
				if (u) {
					acc.tokens = Math.max(acc.tokens, (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
					const slot = (acc.byModel[model] ??= { cost: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
					for (const [total, add] of [[acc.usage, u], [slot.usage, u]] as const) {
						total.input += add.input ?? 0;
						total.output += add.output ?? 0;
						total.cacheRead += add.cacheRead ?? 0;
						total.cacheWrite += add.cacheWrite ?? 0;
					}
					if (typeof c === "number") slot.cost += c;
				}
			}
			for (const part of m?.content ?? []) {
				if (part?.type === "toolCall") acc.toolCount++;
				else if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
					acc.lastText = part.text.replace(/\s+/g, " ").trim();
				}
			}
		}
	}
	acc.size = consumed;
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

/** Threads per run from the most recent collectFleet, reused by collectTeams. */
const threadCache = new Map<string, ThreadView[]>();

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
		const threads = readThreads(dir);
		threadCache.set(runId, threads);
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
				usage: scan.usage,
				model: scan.model ?? normalizeModel(record.model),
				byModel: Object.fromEntries(
					Object.entries(scan.byModel).map(([k, v]) => [k || normalizeModel(record.model) || "unknown model", v]),
				),
				turns: scan.turns,
				toolCount: scan.toolCount,
				lastText: scan.lastText,
				tasks: scan.tasks.length ? scan.tasks : [record.task],
				lastAt: scan.lastAt || record.endedAt || record.startedAt,
				sessionFile,
				messages: countsFor(record.id, threads, dir),
				threads: threads.filter((t) => t.between.includes(record.id)),
			});
		}
	}
	return out.sort((a, b) => {
		if (a.alive !== b.alive) return a.alive ? -1 : 1;
		return b.lastAt - a.lastAt;
	});
}

/**
 * Group children by (run, team). Teams are per run, so the same name in two
 * runs is two teams. Children without a team share one "none" group.
 */
export function collectTeams(root: string, currentRunId: string | null, fleet: ChildView[]): TeamView[] {
	const groups = new Map<string, TeamView>();
	const base = path.join(root, ".pi", "runs");
	const ensure = (runId: string, name: string, goal = ""): TeamView => {
		const key = name === "none" ? "none" : `${runId}\0${name}`;
		let g = groups.get(key);
		if (!g) {
			g = { runId: name === "none" ? "" : runId, name, goal, mine: runId === currentRunId, members: [], threads: [], lastAt: 0 };
			groups.set(key, g);
		}
		return g;
	};
	// Defined teams appear even before their first member is spawned.
	for (const runId of new Set(fleet.map((v) => v.runId).concat(currentRunId ? [currentRunId] : []))) {
		try {
			const reg = readRegistry(path.join(base, runId), runId, root);
			for (const t of Object.values(reg.teams ?? {})) ensure(runId, t.name, t.goal);
		} catch {
			/* unreadable run */
		}
	}
	for (const v of fleet) {
		const g = ensure(v.runId, v.record.team ?? "none");
		g.members.push(v);
		g.lastAt = Math.max(g.lastAt, v.lastAt);
	}
	for (const g of groups.values()) {
		if (g.name === "none") continue;
		g.threads = (threadCache.get(g.runId) ?? []).filter((t) => t.team === g.name);
		for (const t of g.threads) g.lastAt = Math.max(g.lastAt, t.lastAt);
	}
	const live = (g: TeamView) => g.members.some((m) => m.alive);
	return [...groups.values()]
		.filter((g) => g.members.length || g.mine)
		.sort((a, b) => {
			if (live(a) !== live(b)) return live(a) ? -1 : 1;
			if ((a.name === "none") !== (b.name === "none")) return a.name === "none" ? 1 : -1;
			return b.lastAt - a.lastAt;
		});
}

export function teamKey(t: TeamView): string {
	return `team:${t.runId}:${t.name}`;
}

/** Flatten into roster rows: each team header followed by its members unless collapsed. */
export function buildItems(_fleet: ChildView[], teams: TeamView[], collapsed: ReadonlySet<string> = new Set()): Item[] {
	const items: Item[] = [];
	for (const team of teams) {
		items.push({ kind: "team", team });
		if (collapsed.has(teamKey(team))) continue;
		for (const view of team.members) items.push({ kind: "agent", view, team });
	}
	return items;
}

/** Stable identity for a row, so a refresh never moves the selection. */
export function itemKey(item: Item | undefined): string {
	if (!item) return "";
	return item.kind === "team" ? teamKey(item.team) : `agent:${item.view.runId}:${item.view.record.id}`;
}

/* -------------------------------------------------------------- transcript */

export type Ev =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| {
			kind: "tool";
			name: string;
			/** One-line summary for the collapsed view. */
			args: string;
			/** The whole call, line breaks kept, for the expanded view (x). */
			call: string;
			output: string;
			isError: boolean;
			ms: number;
	  };

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
	const pending = new Map<string, { name: string; args: string; call: string; at: number }>();
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
				call: call?.call ?? "",
				output: String(text ?? ""),
				isError: Boolean(m.isError),
				ms: call?.at && at ? at - call.at : 0,
			});
			continue;
		}
		for (const part of m?.content ?? []) {
			if (part?.type === "toolCall") {
				pending.set(part.id, {
					name: part.name,
					args: briefArgs(part.name, part.arguments),
					call: fullCall(part.name, part.arguments),
					at,
				});
			} else if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
				evs.push({ kind: m.role === "user" ? "user" : "assistant", text: part.text.trim() });
			}
		}
	}
	// Still-running calls have no result yet; show them so a working agent is
	// not silent in the view.
	for (const [, c] of pending) {
		evs.push({ kind: "tool", name: c.name, args: c.args, call: c.call, output: "", isError: false, ms: -1 });
	}
	return evs.slice(-MAX_EVENTS);
}

/**
 * The whole call as text: bash shows its command as written; other tools one
 * "key: value" per argument, multi-line values continuing on their own lines.
 */
function fullCall(name: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	if (name === "bash" && typeof args.command === "string") {
		const rest = Object.entries(args).filter(([k]) => k !== "command");
		return [args.command, ...rest.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)].join("\n");
	}
	return Object.entries(args)
		.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
		.join("\n");
}

function briefArgs(name: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	if (name === "bash") return String(args.command ?? "").replace(/\s+/g, " ");
	const v = args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.id ?? args.paths;
	if (Array.isArray(v)) return v.join(", ");
	return typeof v === "string" ? v : "";
}

/* ------------------------------------------------------------------ threads */

/** One message of an opened thread, flattened for display. */
export interface ThreadMessage {
	id: string;
	seq: number;
	from: string;
	to: string;
	at: number;
	text: string;
	needsReply: boolean;
	replyTo: string | null;
	inbound: "queued" | "delivered" | "undelivered";
	inboundReason: string | null;
	/** Characters of `text` the recipient has read (unions of read ranges). */
	readChars: number;
	readFull: boolean;
	failure: string | null;
}

/**
 * Read every message of one thread, oldest first. Lock-free like readThreads:
 * the file is replaced by rename, so a read sees either the old or new
 * version, and a torn read just shows nothing until the next poll.
 */
export function readThreadMessages(file: string): ThreadMessage[] {
	let th: any;
	try {
		th = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return [];
	}
	const out: ThreadMessage[] = [];
	for (const m of th?.messages ?? []) {
		const text = String(m?.text ?? "");
		let readChars = 0;
		for (const r of m?.read?.ranges ?? []) {
			if (Array.isArray(r)) readChars += Math.max(0, Number(r[1]) - Number(r[0]) || 0);
		}
		out.push({
			id: String(m?.id ?? "?"),
			seq: Number(m?.seq) || 0,
			from: String(m?.from?.id ?? "?"),
			to: String(m?.to?.id ?? "?"),
			at: Number(m?.at) || 0,
			text,
			needsReply: Boolean(m?.needs_reply),
			replyTo: m?.reply_to ? String(m.reply_to) : null,
			inbound: m?.inbound?.state === "undelivered" || m?.inbound?.state === "queued" ? m.inbound.state : "delivered",
			inboundReason: m?.inbound?.reason ? String(m.inbound.reason) : null,
			readFull: Boolean(m?.read?.full),
			readChars: m?.read?.full ? text.length : Math.min(text.length, readChars),
			failure: m?.failure?.reason ? String(m.failure.reason) : null,
		});
	}
	return out.sort((a, b) => a.seq - b.seq || a.at - b.at);
}

/** Threads reachable from a roster row: a team's threads, or those an agent takes part in. */
export function threadsOf(item: Item | undefined): ThreadView[] {
	if (!item) return [];
	return item.kind === "team" ? item.team.threads : item.view.threads;
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
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
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
	teams: TeamView[];
	/** Keys (teamKey) of collapsed teams; survives refreshes. */
	collapsed: Set<string>;
	/** Roster rows: team headers and the agents under them. */
	items: Item[];
	selected: number;
	/** Detail-pane scroll; meaningful only when autoFollow is off. */
	scroll: number;
	/** Largest useful scroll for the current detail, written back by the renderer. */
	maxScroll: number;
	autoFollow: boolean;
	expandedTools: boolean;
	rows: number;
	/**
	 * Thread browsing for the selected row. null = normal roster/detail view.
	 * "pick" lists the row's threads with `threadId` highlighted; "open" shows
	 * that thread's messages. The roster selection is frozen while browsing.
	 */
	threadNav?: ThreadNav | null;
}

export interface ThreadNav {
	mode: "pick" | "open";
	/** Highlighted (pick) or opened (open) thread; kept by id so refreshes don't move it. */
	threadId: string;
}

/** The thread list for the selected row and the index of the nav's thread in it (-1 if gone). */
export function navPosition(st: InspectorState): { threads: ThreadView[]; index: number } {
	const threads = threadsOf(st.items[st.selected]);
	const id = st.threadNav?.threadId;
	return { threads, index: id ? threads.findIndex((t) => t.id === id) : -1 };
}

const n = (x: number) => x.toLocaleString("en-US");
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;

function ago(at: number): string {
	return at ? `${dur(Date.now() - at)} ago` : "";
}

function teamLabel(t: TeamView): string {
	return t.name === "none" ? "no team" : t.mine ? t.name : `${t.name} · ${t.runId.slice(0, 4)}`;
}

function teamTotals(threads: ThreadView[]): string {
	const msgs = threads.reduce((x, t) => x + t.messages, 0);
	const chars = threads.reduce((x, t) => x + t.chars, 0);
	return `${plural(threads.length, "thread")} · ${plural(msgs, "msg")} · ${n(chars)} chars`;
}

function flags(t: { unread: number; undelivered: number }): string {
	return (t.unread ? ` · ${n(t.unread)} unread` : "") + (t.undelivered ? ` · ${n(t.undelivered)} undelivered` : "");
}

function rosterLines(st: InspectorState, width: number, height: number, theme: FleetTheme): string[] {
	if (!st.items.length) return [theme.fg("dim", " No tracked children")];
	const start = Math.max(0, Math.min(st.selected - height + 1, Math.max(0, st.items.length - height)));
	return st.items.slice(start, start + height).map((item, off) => {
		const sel = start + off === st.selected;
		const marker = sel ? theme.fg("accent", "›") : " ";
		if (item.kind === "team") {
			const t = item.team;
			const name = t.name === "none" ? theme.fg("dim", teamLabel(t)) : theme.bold(teamLabel(t));
			const msgs = t.threads.reduce((x, th) => x + th.messages, 0);
			const cost = t.members.reduce((x, m) => x + m.cost, 0);
			const right =
				(t.name === "none" ? plural(t.members.length, "agent") : `${plural(t.members.length, "agent")} · ${n(msgs)}✉`) +
				` · $${cost.toFixed(2)}`;
			const arrow = st.collapsed.has(teamKey(t)) ? "▸" : "▾";
			return rightAligned(`${marker} ${theme.fg("accent", arrow)} ${name}`, theme.fg("dim", right), width);
		}
		const v = item.view;
		// Several children of the same agent in the same run are common, so the
		// unique child id is what makes a row identifiable; the run id only
		// matters for telling sessions apart.
		const agent = sel ? theme.bold(v.record.agent) : v.record.agent;
		const tag = v.mine ? v.record.id : `${v.record.id} ${v.runId.slice(0, 4)}`;
		const left = `${marker}   ${glyph(v, theme)} ${agent} ${theme.fg("dim", `· ${tag}`)}`;
		return rightAligned(left, theme.fg("dim", stateLabel(v)), width);
	});
}

/** Per-agent thread summary, bounded so the header never crowds out the transcript. */
function messageLines(v: ChildView, theme: FleetTheme): string[] {
	if ((v.record.team ?? "none") === "none") return [];
	if (!v.threads.length) return [`  ${theme.fg("accent", "Messages")} ${theme.fg("dim", "· none yet")}`];
	const out = [`  ${theme.fg("accent", "Messages")} ${theme.fg("dim", `· ${teamTotals(v.threads)}${flags(v.messages)}`)}`];
	const MAX = 3;
	for (const t of v.threads.slice(0, MAX)) {
		const other = t.between[0] === v.record.id ? t.between[1] : t.between[0];
		const mine = t.sentBy[v.record.id] ?? 0;
		out.push(
			`    ${theme.fg("muted", `↔ ${other} · ${t.id} · ${plural(t.messages, "msg")} (${mine}↑ ${t.messages - mine}↓) · ${n(t.chars)} chars${flags(t)} · ${ago(t.lastAt)}`)}`,
		);
	}
	if (v.threads.length > MAX) out.push(`    ${theme.fg("dim", `… ${v.threads.length - MAX} more threads`)}`);
	return out;
}

function detailHeader(v: ChildView, width: number, theme: FleetTheme, convo: string): string[] {
	const r = v.record;
	const lines: string[] = [];
	lines.push(rightAligned(` ${glyph(v, theme)} ${theme.bold(r.agent)}`, theme.fg("dim", stateLabel(v)), width));
	const identity = [
		v.mine ? "this session" : "other session",
		r.writes.length ? `owns ${r.writes.length}` : "read-only",
		`team ${r.team ?? "none"}`,
		v.runId.slice(0, 8),
		`gen${r.generation}`,
		r.pid ? `pid ${r.pid}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	lines.push(`  ${theme.fg("dim", identity)}`);
	const spent = usageTotal(v.usage);
	const stats = [
		`$${v.cost.toFixed(3)}`,
		spent ? `${tokens(spent)} tok` : "",
		v.tokens ? `ctx ${tokens(v.tokens)}` : "",
		`${v.toolCount} tools`,
		dur((r.endedAt ?? Date.now()) - r.startedAt),
		v.model ?? "",
	].filter(Boolean);
	lines.push(`  ${theme.fg("muted", stats.join(" · "))}`);
	lines.push(`  ${theme.fg("muted", `Task ${r.task.replace(/\s+/g, " ")}`)}`);
	lines.push(...messageLines(v, theme));
	lines.push(`${theme.fg("accent", "Conversation")} ${theme.fg("dim", `· ${convo}`)}`);
	return lines.map((l) => truncateToWidth(l, width));
}

const cachedShare = (u: Usage) => {
	// Output is never cached, so the share is over the prompt side only.
	const prompt = u.input + u.cacheRead + u.cacheWrite;
	return prompt ? Math.round((u.cacheRead / prompt) * 100) : 0;
};

/**
 * Team usage: cost and activity overall, tokens per model. Token counts from
 * different models use different tokenizers and prices, so one total would
 * add unlike units; cost is already in a common currency.
 */
function usageLines(members: ChildView[]): string[] {
	if (!members.length) return [];
	let cost = 0;
	let turns = 0;
	let tools = 0;
	let first = Infinity;
	let last = 0;
	const models = new Map<string, { count: number; cost: number; usage: Usage }>();
	for (const m of members) {
		cost += m.cost;
		turns += m.turns;
		tools += m.toolCount;
		first = Math.min(first, m.record.startedAt);
		last = Math.max(last, m.record.endedAt ?? Date.now());
		// ×N counts agents that used the model; one agent may use several.
		for (const [key, mu] of Object.entries(m.byModel)) {
			const e = models.get(key) ?? { count: 0, cost: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
			e.count++;
			e.cost += mu.cost;
			e.usage.input += mu.usage.input;
			e.usage.output += mu.usage.output;
			e.usage.cacheRead += mu.usage.cacheRead;
			e.usage.cacheWrite += mu.usage.cacheWrite;
			models.set(key, e);
		}
	}
	const lines = [`$${cost.toFixed(3)} · ${n(turns)} turns · ${n(tools)} tools · ${dur(last - first)}`, "Models"];
	for (const [k, e] of [...models].sort((a, b) => b[1].cost - a[1].cost)) {
		const u = e.usage;
		lines.push(
			`  ${k} ×${e.count} · $${e.cost.toFixed(3)} · ${tokens(usageTotal(u))} tok ` +
				`(${tokens(u.input)} in · ${tokens(u.output)} out · ${tokens(u.cacheRead)} cache read · ` +
				`${tokens(u.cacheWrite)} cache write · ${cachedShare(u)}% cached)`,
		);
	}
	return lines;
}

/** Detail pane for a selected team header: goal, members, and every thread. */
function teamDetail(t: TeamView, width: number, theme: FleetTheme, folded = false): { header: string[]; body: string[] } {
	const w = Math.max(8, width);
	const live = t.members.filter((m) => m.alive).length;
	const header = [
		rightAligned(
			` ${theme.fg("accent", folded ? "▸" : "▾")} ${theme.bold(teamLabel(t))}`,
			theme.fg("dim", `${live} live / ${plural(t.members.length, "agent")}`),
			w,
		),
	];
	// Only the title is pinned; the rest scrolls, so a short terminal can reach it all.
	const summary: string[] = [];
	const wrapped = (text: string, color: string) => {
		// Continuation lines hang two columns past the line's own indent.
		const indent = " ".repeat((text.match(/^ */)?.[0].length ?? 0) + 2);
		// Wrap at the narrower width so indented continuations are never clipped.
		wrapTextWithAnsi(text, Math.max(1, w - 2 - indent.length)).forEach((line, i) => {
			summary.push(`  ${theme.fg(color, i ? indent + line.trimStart() : line)}`);
		});
	};
	if (t.name === "none") {
		summary.push(`  ${theme.fg("dim", "Agents without a team; direct messaging disabled.")}`);
	}
	for (const line of usageLines(t.members)) wrapped(line, "muted");
	if (t.name !== "none") {
		wrapped(`Goal ${t.goal.replace(/\s+/g, " ")}`, "muted");
		const unread = t.threads.reduce((x, th) => x + th.unread, 0);
		const undelivered = t.threads.reduce((x, th) => x + th.undelivered, 0);
		summary.push(`  ${theme.fg("dim", `${teamTotals(t.threads)}${flags({ unread, undelivered })}`)}`);
	}

	const body: string[] = [...summary, "", theme.fg("accent", "Members")];
	for (const m of t.members) {
		const c = m.messages;
		const traffic = t.name === "none" ? "" : ` · ${c.sent}↑ ${c.received}↓`;
		body.push(
			`  ${glyph(m, theme)} ${m.record.id} ${theme.fg("dim", `· ${m.record.agent} · ${stateLabel(m)}${traffic} · $${m.cost.toFixed(3)} · ${tokens(usageTotal(m.usage))} tok · ${m.model ?? "model ?"}`)}`,
		);
		body.push(`    ${theme.fg("muted", m.record.task.replace(/\s+/g, " "))}`);
	}
	if (!t.members.length) body.push(theme.fg("dim", "  (no members yet)"));
	if (t.name !== "none") {
		body.push("", theme.fg("accent", "Threads"));
		for (const th of t.threads) {
			body.push(
				`  ${th.between[0]} ↔ ${th.between[1]} ${theme.fg("dim", `· ${th.id} · ${plural(th.messages, "msg")} · ${n(th.chars)} chars${flags(th)} · ${ago(th.lastAt)}`)}`,
			);
		}
		if (!t.threads.length) body.push(theme.fg("dim", "  (no messages yet)"));
	}
	return { header: header.map((l) => truncateToWidth(l, w)), body: body.map((l) => truncateToWidth(l, w)) };
}

/** Label for whose threads are being browsed. */
function ownerLabel(item: Item): string {
	return item.kind === "team" ? `team ${teamLabel(item.team)}` : `${item.view.record.agent} · ${item.view.record.id}`;
}

/** Thread picker: one row per thread, the highlighted one marked. */
function threadPicker(item: Item, threads: ThreadView[], cursor: number, width: number, theme: FleetTheme): { header: string[]; body: string[] } {
	const w = Math.max(8, width);
	const header = [
		rightAligned(` ${theme.fg("accent", "✉")} ${theme.bold(`Threads of ${ownerLabel(item)}`)}`, theme.fg("dim", teamTotals(threads)), w),
		"",
	];
	const self = item.kind === "agent" ? item.view.record.id : null;
	const body = threads.map((t, i) => {
		const sel = i === cursor;
		const marker = sel ? theme.fg("accent", "›") : " ";
		// From an agent, name the other side; from a team, both sides.
		const who = self ? `↔ ${t.between[0] === self ? t.between[1] : t.between[0]}` : `${t.between[0]} ↔ ${t.between[1]}`;
		const mine = self ? ` (${t.sentBy[self] ?? 0}↑ ${t.messages - (t.sentBy[self] ?? 0)}↓)` : "";
		const meta = `· ${t.id} · ${plural(t.messages, "msg")}${mine} · ${n(t.chars)} chars${flags(t)} · ${ago(t.lastAt)}`;
		return `${marker} ${sel ? theme.bold(who) : who} ${theme.fg("dim", meta)}`;
	});
	return { header: header.map((l) => truncateToWidth(l, w)), body: body.map((l) => truncateToWidth(l, w)) };
}

/** Status words for one message; empty for a delivered, fully read message with nothing special. */
function messageFlags(m: ThreadMessage, theme: FleetTheme): string[] {
	const out: string[] = [];
	if (m.replyTo) out.push(theme.fg("dim", `↩ ${m.replyTo}`));
	if (m.needsReply) out.push(theme.fg("warning", "needs reply"));
	if (m.inbound === "undelivered") {
		out.push(theme.fg("error", `undelivered${m.inboundReason ? `: ${m.inboundReason}` : ""}`));
	} else {
		if (m.inbound === "queued") out.push(theme.fg("warning", "queued"));
		if (!m.readFull) {
			out.push(theme.fg("warning", m.readChars ? `read ${n(m.readChars)}/${n(m.text.length)} chars` : "unread"));
		}
	}
	if (m.failure) out.push(theme.fg("error", `failed: ${m.failure}`));
	return out;
}

/** An opened thread: pinned title, then every message in send order. */
function threadMessagesDetail(
	item: Item,
	thread: ThreadView,
	msgs: ThreadMessage[],
	position: string,
	width: number,
	theme: FleetTheme,
): { header: string[]; body: string[] } {
	const w = Math.max(8, width);
	// Each participant keeps one colour, so the conversation reads at a glance.
	const color = (id: string) => (id === thread.between[0] ? "accent" : "success");
	const header = [
		rightAligned(
			` ${theme.fg("accent", "✉")} ${theme.bold(`${thread.between[0]} ↔ ${thread.between[1]}`)} ${theme.fg("dim", `· ${thread.id}`)}`,
			theme.fg("dim", `${plural(thread.messages, "msg")} · ${n(thread.chars)} chars`),
			w,
		),
		`  ${theme.fg("dim", `team ${thread.team} · from ${ownerLabel(item)} · thread ${position}${flags(thread)}`)}`,
		"",
	];
	const body: string[] = [];
	for (const m of msgs) {
		const head =
			`${theme.fg(color(m.from), `▌ ${m.from}`)} ${theme.fg("dim", "→")} ${theme.fg(color(m.to), m.to)} ` +
			theme.fg("dim", `· ${m.id} · ${n(m.text.length)} chars · ${ago(m.at)}`);
		const extra = messageFlags(m, theme);
		body.push(truncateToWidth(extra.length ? `${head} ${theme.fg("dim", "·")} ${extra.join(theme.fg("dim", " · "))}` : head, w));
		for (const para of m.text.split(/\r?\n/)) {
			if (!para.trim()) {
				body.push("");
				continue;
			}
			for (const wrapped of wrapTextWithAnsi(para, Math.max(1, w - 2))) body.push(truncateToWidth(`  ${wrapped}`, w));
		}
		body.push("");
	}
	if (!msgs.length) body.push(theme.fg("dim", "  (thread could not be read)"));
	return { header: header.map((l) => truncateToWidth(l, w)), body };
}

function rail(content: string, theme: FleetTheme): string {
	return `${theme.fg("borderMuted", "│")} ${content}`;
}

/** Call lines shown when expanded; a huge write/edit should not bury everything. */
const MAX_CALL_LINES = 60;

/** Every task the agent was given, in full, oldest first. */
function tasksSection(tasks: string[], width: number, theme: FleetTheme): string[] {
	const w = Math.max(8, width);
	const out = [theme.fg("accent", `Tasks · ${tasks.length}`)];
	tasks.forEach((task, i) => {
		out.push(truncateToWidth(theme.fg("accent", i === 0 ? "▌ Initial task" : `▌ Follow-up ${i}`), w));
		for (const para of task.split(/\n/)) {
			if (!para.trim()) continue;
			for (const wrapped of wrapTextWithAnsi(para, Math.max(1, w - 2))) out.push(truncateToWidth(`  ${wrapped}`, w));
		}
	});
	out.push("", theme.fg("dim", "── transcript ──"));
	return out;
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
			const callLines = ev.call.replace(/\s+$/, "").split(/\r?\n/);
			if (expandedTools && ev.call && (callLines.length > 1 || visibleWidth(`${g} ${head}`) + 2 > w)) {
				// The headline would be cut: show the name, then the whole call wrapped.
				out.push(truncateToWidth(rail(`${g} ${theme.fg("toolTitle", theme.bold(ev.name === "bash" ? "$" : ev.name))}`, theme), w));
				const shownCall = callLines.slice(0, MAX_CALL_LINES);
				for (const cl of shownCall) {
					for (const wrapped of wrapTextWithAnsi(theme.fg("toolTitle", cl || " "), Math.max(1, w - 4))) {
						out.push(truncateToWidth(rail(`  ${wrapped}`, theme), w));
					}
				}
				if (callLines.length > shownCall.length) {
					out.push(truncateToWidth(rail(theme.fg("dim", `  … ${callLines.length - shownCall.length} more lines of call`), theme), w));
				}
			} else {
				out.push(truncateToWidth(rail(`${g} ${head}`, theme), w));
			}
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
	/** Messages of the open thread (threadNav.mode "open"); ignored otherwise. */
	threadMsgs: ThreadMessage[] = [],
): { lines: string[]; viewport: number; bodyLines: number; scroll: number; maxScroll: number } {
	if (width < 36) {
		return {
			lines: [truncateToWidth("Subagent fleet needs at least 36 columns. Esc closes.", width)],
			viewport: 1,
			bodyLines: 0,
			scroll: 0,
			maxScroll: 0,
		};
	}
	const inner = width - 2;
	const bodyHeight = Math.max(3, Math.floor(st.rows * 0.85) - 6);
	const rosterWidth = Math.max(22, Math.min(46, Math.floor((inner - 1) * 0.38)));
	const detailWidth = Math.max(1, inner - rosterWidth - 1);

	const item = st.items[st.selected];
	const v = item?.kind === "agent" ? item.view : undefined;
	const roster = rosterLines(st, rosterWidth, bodyHeight, theme);

	let header: string[] = [];
	let body: string[] = [];
	const nav = st.threadNav ?? null;
	const { threads, index: navIndex } = navPosition(st);
	const openThread = nav?.mode === "open" && navIndex >= 0 ? threads[navIndex] : undefined;
	if (item && nav?.mode === "pick" && threads.length) {
		({ header, body } = threadPicker(item, threads, Math.max(0, navIndex), detailWidth, theme));
	} else if (item && openThread) {
		({ header, body } = threadMessagesDetail(item, openThread, threadMsgs, `${navIndex + 1}/${threads.length}`, detailWidth, theme));
	} else if (item?.kind === "team") {
		({ header, body } = teamDetail(item.team, detailWidth, theme, st.collapsed.has(teamKey(item.team))));
	} else if (v) {
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
		const convoBody = detailBody(evs, detailWidth, theme, st.expandedTools);
		body = [
			...tasksSection(v.tasks, detailWidth, theme),
			...(convoBody.length ? convoBody : [theme.fg("dim", "  (no transcript yet)")]),
		];
	} else {
		header = [theme.fg("dim", " No subagents found under .pi/runs/")];
	}

	const viewport = Math.max(1, bodyHeight - header.length);
	const maxScroll = Math.max(0, body.length - viewport);
	// Following is for live transcripts and open threads; a team summary
	// always reads from the top, and the picker keeps its cursor in view.
	let scroll: number;
	if (nav?.mode === "pick" && threads.length) {
		scroll = Math.min(maxScroll, Math.max(0, navIndex - viewport + 1));
	} else if (st.autoFollow && (openThread || (!nav && item?.kind === "agent"))) {
		scroll = maxScroll;
	} else {
		scroll = Math.min(st.scroll, maxScroll);
	}
	const visible = [...header, ...body.slice(scroll, scroll + viewport)];

	const liveCount = st.fleet.filter((f) => f.alive).length;
	const foreign = st.fleet.filter((f) => f.alive && !f.mine).length;
	const spend = st.fleet.reduce((s, f) => s + f.cost, 0);

	const lines = [theme.fg("border", `╭${"─".repeat(inner)}╮`)];
	const title =
		` ${theme.bold("Subagent fleet")} ` +
		theme.fg("dim", `· ${liveCount} live${foreign ? ` (${foreign} elsewhere)` : ""} · $${spend.toFixed(3)}`);
	const status = openThread
		? `${theme.fg("accent", "✉")} ${openThread.id} `
		: nav?.mode === "pick"
			? `${theme.fg("accent", "✉")} ${plural(threads.length, "thread")} `
			: v
		? `${glyph(v, theme)} ${v.record.agent} · ${stateLabel(v)} `
		: item?.kind === "team"
			? `${theme.fg("accent", st.collapsed.has(teamKey(item.team)) ? "▸" : "▾")} ${teamLabel(item.team)} `
			: theme.fg("dim", "no children ");
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
	const position = st.items.length ? `${st.selected + 1}/${st.items.length}` : "0/0";
	const follow = `f follow${st.autoFollow ? "*" : ""}`;
	const footer =
		nav?.mode === "pick"
			? ` ↑↓/jk pick thread · ⏎/l open · Esc/h back · q close · ${Math.max(0, navIndex) + 1}/${threads.length}`
			: openThread
				? ` ↑↓/jk/J/K scroll · PgUp/PgDn page · [/] prev/next thread · ${follow} · Esc/h back · q close · ${navIndex + 1}/${threads.length}`
				: ` ↑↓/jk select · h/l/⏎ fold · ${threads.length ? "t threads · " : ""}J/K scroll · g tasks · G end · x tools · ${follow} · r refresh · Esc close · ${position}`;
	lines.push(theme.fg("border", "│") + fit(theme.fg("dim", footer), inner) + theme.fg("border", "│"));
	lines.push(theme.fg("border", `╰${"─".repeat(inner)}╯`));

	return { lines: lines.map((l) => truncateToWidth(l, width)), viewport, bodyLines: body.length, scroll, maxScroll };
}

/** Plain-text fallback for non-TUI modes (pi -p, json). */
export function renderPlain(items: Item[]): string {
	const agents = items.filter((i) => i.kind === "agent");
	if (!agents.length) return "No subagents found under .pi/runs/.";
	const rows = items.map((item) => {
		if (item.kind === "team") {
			const t = item.team;
			return t.name === "none" ? `no team` : `${teamLabel(t)} — ${teamTotals(t.threads)} — ${t.goal.replace(/\s+/g, " ").slice(0, 80)}`;
		}
		const v = item.view;
		const r = v.record;
		return (
			`  ${v.alive ? "●" : "·"} ${r.id.padEnd(7)} ${r.agent.padEnd(8)} ${stateLabel(v).padEnd(8)} ` +
			`${dur(Date.now() - v.lastAt).padStart(7)} $${v.cost.toFixed(3).padStart(7)} ` +
			`${r.writes.length ? `owns[${r.writes.length}]` : "read-only"}` +
			`${v.messages.unread ? ` ${v.messages.unread} unread` : ""}${v.mine ? "" : `  run ${v.runId}`}`
		);
	});
	const live = agents.filter((i) => i.kind === "agent" && i.view.alive).length;
	return [`SUBAGENT FLEET — ${live} live · ${agents.length} total`, ...rows].join("\n");
}

/* ------------------------------------------------------------------- input */

export type KeyResult = { kind: "close" | "moved" | "handled" | "refresh" | "ignored" };

const SCROLL_STEP = 3;

/**
 * Pure key handling. j/k select a row; Shift+J/K scroll the detail pane a few
 * lines, PgUp/PgDn a page. Scrolling starts from what is on screen: while
 * following, that is the bottom, not line 0.
 */
export function handleInspectorKey(st: InspectorState, data: string, viewport: number): KeyResult {
	const scrollBy = (delta: number) => {
		const from = st.autoFollow ? st.maxScroll : Math.min(st.scroll, st.maxScroll);
		st.scroll = Math.max(0, Math.min(st.maxScroll, from + delta));
		// Scrolling back to the bottom resumes following new output.
		st.autoFollow = st.scroll >= st.maxScroll;
	};
	if (st.threadNav) return handleThreadKey(st, st.threadNav, data, viewport, scrollBy);
	const openPicker = (): KeyResult => {
		const threads = threadsOf(st.items[st.selected]);
		if (!threads.length) return { kind: "handled" };
		st.threadNav = { mode: "pick", threadId: threads[0]!.id };
		st.scroll = 0;
		st.autoFollow = false;
		return { kind: "moved" };
	};
	const move = (delta: number): KeyResult => {
		const next = st.selected + delta;
		if (next < 0 || next >= st.items.length) return { kind: "handled" };
		st.selected = next;
		st.scroll = 0;
		st.autoFollow = st.items[next]?.kind === "agent";
		return { kind: "moved" };
	};
	switch (data) {
		case "\x1b":
		case "q":
		case "\x03":
			return { kind: "close" };
		case "\x1b[A":
		case "k":
			return move(-1);
		case "\x1b[B":
		case "j":
			return move(1);
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
		case "t":
			return openPicker();
		// Top of the detail (an agent's task list) and back to the live bottom.
		case "g":
			st.scroll = 0;
			st.autoFollow = false;
			return { kind: "handled" };
		case "G":
			st.scroll = st.maxScroll;
			st.autoFollow = true;
			return { kind: "handled" };
		case "\r":
		case "h":
		case "l": {
			const item = st.items[st.selected];
			if (!item) return { kind: "handled" };
			if (item.kind === "agent") {
				// Tree convention: h on a child goes to its parent. Enter on an
				// agent picks one of its threads; l does nothing.
				if (data === "\r") return openPicker();
				if (data !== "h") return { kind: "handled" };
				const key = teamKey(item.team);
				st.selected = Math.max(0, st.items.findIndex((i) => i.kind === "team" && teamKey(i.team) === key));
				st.scroll = 0;
				st.autoFollow = false;
				return { kind: "moved" };
			}
			const key = teamKey(item.team);
			const collapse = data === "h" ? true : data === "l" ? false : !st.collapsed.has(key);
			if (collapse) st.collapsed.add(key);
			else st.collapsed.delete(key);
			st.items = buildItems(st.fleet, st.teams, st.collapsed);
			st.selected = Math.max(0, st.items.findIndex((i) => i.kind === "team" && teamKey(i.team) === key));
			st.scroll = 0;
			st.autoFollow = false;
			return { kind: "moved" };
		}
		case "r":
			return { kind: "refresh" };
		default:
			return { kind: "ignored" };
	}
}

/**
 * Keys while browsing threads. In the picker, ↑↓/jk move the highlight and
 * Enter/l opens it. In an open thread, ↑↓/jk scroll a line, J/K a few,
 * PgUp/PgDn a page, and [ / ] step to the previous/next thread. Esc/h/Backspace
 * go back one level; q and Ctrl+C still close the whole view.
 */
function handleThreadKey(
	st: InspectorState,
	nav: ThreadNav,
	data: string,
	viewport: number,
	scrollBy: (delta: number) => void,
): KeyResult {
	const { threads, index } = navPosition(st);
	const leave = (): KeyResult => {
		if (nav.mode === "open" && threads.length) {
			st.threadNav = { mode: "pick", threadId: nav.threadId };
		} else {
			st.threadNav = null;
			st.autoFollow = st.items[st.selected]?.kind === "agent";
		}
		st.scroll = 0;
		return { kind: "moved" };
	};
	const select = (i: number, mode: ThreadNav["mode"]): KeyResult => {
		const t = threads[Math.max(0, Math.min(threads.length - 1, i))];
		if (!t) return leave();
		const changed = t.id !== nav.threadId || mode !== nav.mode;
		st.threadNav = { mode, threadId: t.id };
		if (changed && mode === "open") {
			// A thread opens at its latest message and follows new ones, like a transcript.
			st.scroll = 0;
			st.autoFollow = true;
		}
		return { kind: changed ? "moved" : "handled" };
	};
	switch (data) {
		case "q":
		case "\x03":
			return { kind: "close" };
		case "\x1b":
		case "h":
		case "\x7f":
			return leave();
		case "r":
			return { kind: "refresh" };
	}
	if (nav.mode === "pick") {
		switch (data) {
			case "\x1b[A":
			case "k":
				return select(index - 1, "pick");
			case "\x1b[B":
			case "j":
				return select(index + 1, "pick");
			case "\r":
			case "l":
				return select(index, "open");
			default:
				return { kind: "ignored" };
		}
	}
	switch (data) {
		case "\x1b[A":
		case "k":
			scrollBy(-1);
			return { kind: "handled" };
		case "\x1b[B":
		case "j":
			scrollBy(1);
			return { kind: "handled" };
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
		case "[":
			return index > 0 ? select(index - 1, "open") : { kind: "handled" };
		case "]":
			return index < threads.length - 1 ? select(index + 1, "open") : { kind: "handled" };
		case "f":
			st.autoFollow = !st.autoFollow;
			if (!st.autoFollow) st.scroll = st.maxScroll;
			return { kind: "handled" };
		default:
			return { kind: "ignored" };
	}
}

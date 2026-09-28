/**
 * Durable team messaging between subagents.
 *
 * Design rules this file obeys:
 *   - No pi runtime imports. This is a plain data layer; the tool/extension
 *     layer above it decides when to call in.
 *   - One lock. Every mutation runs inside `withLock` from ../registry.ts, the
 *     same lock that protects claims.json, so a thread write and a registry
 *     write are one transaction. Nothing here ever takes a second lock.
 *   - Delivery is two-phase. prepareDelivery only *reads*; the caller persists
 *     the notification and then calls acknowledgeDelivery. A crash in between
 *     re-delivers, which is the failure we can live with.
 *   - Fail closed. Corrupt thread data throws instead of being skipped.
 */

import * as crypto from "node:crypto";
import type { ChildRecord, Registry } from "../types.ts";
import { pidAlive, withLock } from "../registry.ts";
import {
	isMessageId,
	isThreadId,
	loadRegistry,
	loadThread,
	loadThreads,
	newMessageId,
	newThreadId,
	saveRegistry,
	saveThread,
} from "./store.ts";
import type {
	Actor,
	DeliveryReceipt,
	ReadOptions,
	ReadResult,
	SendInput,
	StoredMessage,
	Team,
	Thread,
} from "./types.ts";

export type { Actor, DeliveryReceipt, ReadOptions, ReadResult, SendInput, StoredMessage, Team, Thread };

// ---------------------------------------------------------------------------
// Limits. Small, fixed, and deliberately boring.
// ---------------------------------------------------------------------------

export const MAX_TEXT_CHARS = 32_000;
export const MAX_OUTSTANDING_PER_SENDER = 32;
export const MAX_MESSAGES_PER_RUN = 1000;
export const MAX_DELIVERY_MESSAGES = 8;
export const MAX_DELIVERY_CHARS = 8000;
export const INLINE_BODY_CHARS = 2000;
export const MAX_READ_CHARS = 8000;
export const RECENT_WINDOW = 10;
export const MAX_QUEUED_NOTICES_PER_SENDER = 8;

const TEAM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,31}$/;
const RESERVED_TEAMS = new Set(["none", "all", "any", "self", "parent", "everyone", "team", "*"]);

/** A ChildRecord once the parent has added the messaging fields. */
type MsgChild = ChildRecord & { team?: string; acceptingMessages?: boolean };
type MsgRegistry = Registry & { teams?: Record<string, Team> };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(msg: string): never {
	throw new Error(`subagents: ${msg}`);
}

function child(reg: MsgRegistry, id: string): MsgChild | undefined {
	return reg.children[id] as MsgChild | undefined;
}

/** A record counts as running only if its process is actually there. */
function isRunning(rec: MsgChild | undefined): boolean {
	if (!rec || rec.state !== "running") return false;
	if (rec.pid === null) return Date.now() - rec.startedAt < 60_000; // admitted, not spawned yet
	return pidAlive(rec.pid);
}

function teamOf(rec: MsgChild | undefined): string {
	const t = rec?.team;
	return typeof t === "string" && t.trim() ? t.trim() : "none";
}

function accepting(rec: MsgChild | undefined): boolean {
	return !!rec && rec.acceptingMessages !== false;
}

function normalizeTeamName(name: unknown): string {
	const n = typeof name === "string" ? name.trim() : "";
	if (!n) fail("team name is empty");
	if (!TEAM_NAME_RE.test(n)) fail(`invalid team name ${JSON.stringify(n.slice(0, 40))}`);
	if (RESERVED_TEAMS.has(n.toLowerCase())) fail(`team name ${JSON.stringify(n)} is reserved`);
	return n;
}

function ago(at: number): string {
	const s = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	return `${Math.round(s / 3600)}h ago`;
}

function sameActor(a: Actor, b: Actor): boolean {
	return a.id === b.id && a.generation === b.generation;
}

function participantIds(th: Thread): string[] {
	return th.participants.map((p) => p.id);
}

function mergeRange(m: StoredMessage, start: number, end: number, session: string | null = null): void {
	if (end <= start) return;
	const ranges = [...m.read.ranges, [start, end] as [number, number]].sort((a, b) => a[0] - b[0]);
	const out: [number, number][] = [];
	for (const r of ranges) {
		const last = out[out.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else out.push([r[0], r[1]]);
	}
	m.read.ranges = out;
	m.read.full = out.length === 1 && out[0][0] <= 0 && out[0][1] >= m.text.length;
	m.read.at = Date.now();
	if (session !== null) m.read.session = session;
}

/**
 * Unread from the reader's point of view. `session` is the key of the current
 * paging run: a message this very run finished off still counts as unread, so
 * the page list cannot shift underneath an outstanding cursor.
 */
function isUnreadFor(m: StoredMessage, actor: Actor, session: string | null): boolean {
	if (m.to.id !== actor.id) return false;
	if (m.inbound.state === "undelivered") return false;
	if (!m.read.full) return true;
	return session !== null && m.read.session === session;
}

/** Bodies the caller is allowed to see: their own, or delivered-to-them. */
function bodyVisible(m: StoredMessage, actor: Actor): boolean {
	if (m.from.id === actor.id) return true;
	return m.to.id === actor.id && m.inbound.state !== "undelivered";
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/**
 * Create or confirm a team. The goal is immutable once anyone is on the team —
 * members were spawned against the old goal and cannot be re-briefed.
 */
export function defineTeam(runDir: string, name: string, goal: string): Team {
	const n = normalizeTeamName(name);
	const g = typeof goal === "string" ? goal.trim() : "";
	if (!g) fail("a team needs a non-empty goal");
	if (g.length > 2000) fail("team goal is too long (limit 2,000 chars)");

	return withLock(runDir, () => {
		const reg = loadRegistry(runDir) as MsgRegistry;
		if (!reg.teams) reg.teams = {};
		const existing = reg.teams[n];
		if (existing) {
			if (existing.goal === g) return existing;
			const members = Object.values(reg.children).filter((c) => teamOf(c as MsgChild) === n);
			if (members.length > 0) {
				fail(
					`team "${n}" already has ${members.length} member(s); its goal is immutable ` +
						`(define a new team instead)`,
				);
			}
		}
		const team: Team = { name: n, goal: g };
		reg.teams[n] = team;
		saveRegistry(runDir, reg);
		return team;
	});
}

/** Resolve a spawn-time team argument. Absent means the legacy solo mode. */
export function validateTeam(reg: Registry, team?: string | null): string {
	if (team === undefined || team === null) return "none";
	const t = String(team).trim();
	if (!t || t.toLowerCase() === "none") return "none";
	const n = normalizeTeamName(t); // throws for reserved/malformed
	const teams = (reg as MsgRegistry).teams ?? {};
	if (!teams[n]) fail(`unknown team "${n}" — create it first with defineTeam()`);
	return n;
}

export function listTeams(runDir: string): Team[] {
	const reg = loadRegistry(runDir) as MsgRegistry;
	return Object.values(reg.teams ?? {});
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export function sendMessage(
	runDir: string,
	actor: Actor,
	input: SendInput,
): { message_id: string; thread_id: string } {
	const text = typeof input?.text === "string" ? input.text : "";
	if (!text.trim()) fail("message text is empty");
	if (text.length > MAX_TEXT_CHARS) {
		fail(`message text is too long (${text.length.toLocaleString("en-US")} chars, limit 32,000)`);
	}
	const to = typeof input?.to === "string" ? input.to.trim() : "";
	if (!to) fail("no recipient given");
	const replyTo = input?.reply_to == null ? null : String(input.reply_to).trim();
	if (replyTo !== null && !isThreadId(replyTo) && !isMessageId(replyTo)) {
		fail(`invalid reply_to ${JSON.stringify(replyTo.slice(0, 40))}`);
	}

	return withLock(runDir, () => {
		const reg = loadRegistry(runDir) as MsgRegistry;
		const sender = child(reg, actor.id);
		if (!sender) fail(`unknown sender "${actor.id}"`);
		if (sender.generation !== actor.generation) {
			fail(
				`sender generation ${actor.generation} is stale (agent ${actor.id} is on generation ` +
					`${sender.generation}); messages from a finished turn are not delivered`,
			);
		}
		if (!isRunning(sender)) fail(`sender ${actor.id} is not running`);
		if (to === actor.id) fail("you cannot message yourself");

		const recipient = child(reg, to);
		if (!recipient) fail(`no such agent "${to}". ${teammates(runDir, actor.id).trim()}`);

		const myTeam = teamOf(sender);
		const theirTeam = teamOf(recipient);
		if (myTeam === "none") fail("you are not on a team, so you cannot send messages");
		if (theirTeam === "none") fail(`agent ${to} is not on a team`);
		if (myTeam !== theirTeam) fail(`agent ${to} is on a different team ("${theirTeam}", you are on "${myTeam}")`);
		// A finishing child has closed its inbox; to the sender that is the same as finished.
		if (!isRunning(recipient) || !accepting(recipient)) {
			const why = recipient.state === "running" || recipient.state === "done" ? "has finished" : `is ${recipient.state}`;
			fail(`Not delivered: ${to} ${why}. Only the parent can resume it.`);
		}

		const threads = loadThreads(runDir);
		let total = 0;
		let maxSeq = -1;
		let outstanding = 0;
		for (const th of threads) {
			total += th.messages.length;
			for (const m of th.messages) {
				if (typeof m.seq === "number" && m.seq > maxSeq) maxSeq = m.seq;
				if (m.from.id === actor.id && m.inbound.state === "queued") outstanding++;
			}
		}
		if (total >= MAX_MESSAGES_PER_RUN) {
			fail(`this run has reached the message limit (${MAX_MESSAGES_PER_RUN.toLocaleString("en-US")})`);
		}
		if (outstanding >= MAX_OUTSTANDING_PER_SENDER) {
			fail(
				`you have ${outstanding} undelivered messages outstanding (limit ${MAX_OUTSTANDING_PER_SENDER}); ` +
					`wait for replies instead of sending more`,
			);
		}

		let thread: Thread | null = null;
		if (replyTo) {
			thread = isThreadId(replyTo)
				? loadThread(runDir, replyTo)
				: (threads.find((t) => t.messages.some((m) => m.id === replyTo)) ?? null);
			if (!thread) fail(`no such reply_to "${replyTo}"`);
			const ids = participantIds(thread);
			if (!ids.includes(actor.id) || !ids.includes(to)) {
				fail(`reply_to thread ${thread.id} has different participants (${ids.join(", ")})`);
			}
			if (thread.team !== myTeam) fail(`reply_to thread ${thread.id} belongs to team "${thread.team}"`);
		} else {
			thread = {
				version: 1,
				id: newThreadId(),
				team: myTeam,
				participants: [
					{ id: actor.id, generation: sender.generation },
					{ id: to, generation: recipient.generation },
				],
				createdAt: Date.now(),
				messages: [],
			};
		}

		const message: StoredMessage = {
			id: newMessageId(),
			seq: maxSeq + 1,
			from: { id: actor.id, generation: sender.generation },
			to: { id: to, generation: recipient.generation },
			at: Date.now(),
			text,
			needs_reply: !!input.needs_reply,
			reply_to: replyTo && isMessageId(replyTo) ? replyTo : null,
			inbound: { state: "queued", at: null, reason: null },
			read: { ranges: [], full: false, at: null, session: null },
			failure: null,
		};
		thread.messages.push(message);
		saveThread(runDir, thread);
		return { message_id: message.id, thread_id: thread.id };
	});
}

// ---------------------------------------------------------------------------
// Delivery (two-phase)
// ---------------------------------------------------------------------------

interface Candidate {
	kind: "inbound" | "failure";
	/** Sort key: send order for inbound, failure order for notices. */
	seq: number;
	thread: Thread;
	msg: StoredMessage;
}

function inlineBlock(m: StoredMessage, threadId: string): string {
	const reply = m.needs_reply ? " (reply requested)" : "";
	return `New message ${m.id}, thread ${threadId}, from agent ${m.from.id}${reply}:\n${m.text}`;
}

function noticeBlock(m: StoredMessage, threadId: string): string {
	return (
		`New message ${m.id} (${m.text.length.toLocaleString("en-US")} chars), thread ${threadId}, ` +
		`from agent ${m.from.id}.\nRead with team_messages({ thread_id: "${threadId}" }).`
	);
}

function failureBlock(m: StoredMessage): string {
	const reason = m.failure?.reason ?? "recipient finished";
	return `Message ${m.id} to agent ${m.to.id} was not delivered (${reason}).`;
}

/**
 * Collect the next notification batch for `actor` WITHOUT marking anything
 * delivered. The caller must append the returned text to the agent's session
 * and only then call acknowledgeDelivery with the receipt.
 *
 * `closing = true` means "this agent is about to stop": if there is nothing to
 * hand over, the inbox is closed in the same transaction, so a send racing the
 * shutdown is rejected rather than lost.
 */
export function prepareDelivery(
	runDir: string,
	actor: Actor,
	closing = false,
): { text: string; receipt: DeliveryReceipt } | null {
	return withLock(runDir, () => {
		const reg = loadRegistry(runDir) as MsgRegistry;
		const rec = child(reg, actor.id);
		const threads = loadThreads(runDir);
		const candidates: Candidate[] = [];

		for (const th of threads) {
			for (const m of th.messages) {
				if (
					accepting(rec) &&
					sameActor(m.to, actor) &&
					m.inbound.state === "queued"
				) {
					candidates.push({ kind: "inbound", seq: m.seq ?? m.at, thread: th, msg: m });
				}
				if (sameActor(m.from, actor) && m.failure && m.failure.notice.state === "queued") {
					candidates.push({ kind: "failure", seq: m.seq ?? m.at, thread: th, msg: m });
				}
			}
		}
		candidates.sort((a, b) => a.seq - b.seq || a.msg.id.localeCompare(b.msg.id));

		const receipt: DeliveryReceipt = {
			actor: { id: actor.id, generation: actor.generation },
			preparedAt: Date.now(),
			inbound: [],
			full: [],
			failures: [],
		};
		const blocks: string[] = [];
		let used = 0;

		for (const c of candidates) {
			if (receipt.inbound.length + receipt.failures.length >= MAX_DELIVERY_MESSAGES) break;
			let block: string;
			let isFull = false;
			if (c.kind === "failure") {
				block = failureBlock(c.msg);
			} else if (c.msg.text.length <= INLINE_BODY_CHARS) {
				block = inlineBlock(c.msg, c.thread.id);
				isFull = true;
			} else {
				block = noticeBlock(c.msg, c.thread.id);
			}
			const cost = block.length + (blocks.length ? 2 : 0);
			if (blocks.length > 0 && used + cost > MAX_DELIVERY_CHARS) break;
			blocks.push(block);
			used += cost;
			if (c.kind === "failure") receipt.failures.push(c.msg.id);
			else {
				receipt.inbound.push(c.msg.id);
				if (isFull) receipt.full.push(c.msg.id);
			}
		}

		if (blocks.length === 0) {
			if (closing && rec && rec.generation === actor.generation && rec.acceptingMessages !== false) {
				rec.acceptingMessages = false;
				saveRegistry(runDir, reg);
			}
			return null;
		}
		return { text: blocks.join("\n\n"), receipt };
	});
}

/**
 * Second phase: the notification is now durably in the agent's session, so the
 * messages count as delivered. Idempotent — replaying a receipt is a no-op.
 */
export function acknowledgeDelivery(runDir: string, receipt: DeliveryReceipt): void {
	if (!receipt || !receipt.actor) fail("invalid delivery receipt");
	const inbound = new Set(receipt.inbound ?? []);
	const full = new Set(receipt.full ?? []);
	const failures = new Set(receipt.failures ?? []);
	if (inbound.size === 0 && failures.size === 0) return;

	withLock(runDir, () => {
		const now = Date.now();
		for (const th of loadThreads(runDir)) {
			let dirty = false;
			for (const m of th.messages) {
				if (inbound.has(m.id) && sameActor(m.to, receipt.actor)) {
					// Only ever queued -> delivered: never resurrect an undelivered message.
					if (m.inbound.state === "queued") {
						m.inbound.state = "delivered";
						m.inbound.at = now;
						dirty = true;
					}
					if (full.has(m.id) && !m.read.full && m.inbound.state === "delivered") {
						mergeRange(m, 0, m.text.length);
						dirty = true;
					}
				}
				if (failures.has(m.id) && sameActor(m.from, receipt.actor) && m.failure?.notice.state === "queued") {
					m.failure.notice.state = "delivered";
					m.failure.notice.at = now;
					dirty = true;
				}
			}
			if (dirty) saveThread(runDir, th);
		}
	});
}

/**
 * Hard stop for the error/abort path: the inbox closes and anything still
 * queued for this generation is marked undelivered. Nothing is ever resurrected
 * for a later generation.
 */
export function closeInbox(runDir: string, actor: Actor, reason: string): void {
	const why = (reason || "agent stopped").slice(0, 200);
	withLock(runDir, () => {
		const reg = loadRegistry(runDir) as MsgRegistry;
		const rec = child(reg, actor.id);
		if (rec && rec.generation === actor.generation && rec.acceptingMessages !== false) {
			rec.acceptingMessages = false;
			saveRegistry(runDir, reg);
		}
		for (const th of loadThreads(runDir)) {
			let dirty = false;
			for (const m of th.messages) {
				if (sameActor(m.to, actor) && m.inbound.state === "queued") {
					m.inbound.state = "undelivered";
					m.inbound.reason = why;
					dirty = true;
				}
			}
			if (dirty) saveThread(runDir, th);
		}
	});
}

/**
 * The child (id, generation) is over. Everything still owed to it fails, and
 * its senders are told — but only senders that are still on the very generation
 * that sent the message. Anyone else's loss is reported through summary().
 */
export function settleMessages(runDir: string, id: string, generation: number, reason: string): void {
	const why = (reason || "agent finished").slice(0, 200);
	withLock(runDir, () => {
		const reg = loadRegistry(runDir) as MsgRegistry;
		const rec = child(reg, id);
		// Never touch a record that has already moved on to a later generation.
		if (rec && rec.generation === generation && rec.acceptingMessages !== false) {
			rec.acceptingMessages = false;
			saveRegistry(runDir, reg);
		}
		const now = Date.now();
		const queuedPerSender = new Map<string, number>();
		for (const th of loadThreads(runDir)) {
			for (const m of th.messages) {
				if (m.failure?.notice.state === "queued") {
					const k = `${m.from.id}#${m.from.generation}`;
					queuedPerSender.set(k, (queuedPerSender.get(k) ?? 0) + 1);
				}
			}
		}

		for (const th of loadThreads(runDir)) {
			let dirty = false;
			for (const m of th.messages) {
				if (m.to.id !== id || m.to.generation !== generation) continue;
				if (m.inbound.state === "delivered" || m.failure) continue;
				m.inbound.state = "undelivered";
				m.inbound.reason = why;
				const sender = child(reg, m.from.id);
				const k = `${m.from.id}#${m.from.generation}`;
				const queued = queuedPerSender.get(k) ?? 0;
				const reachable =
					!!sender &&
					sender.generation === m.from.generation &&
					isRunning(sender) &&
					accepting(sender) &&
					queued < MAX_QUEUED_NOTICES_PER_SENDER;
				m.failure = { reason: why, at: now, notice: { state: reachable ? "queued" : "retained", at: null } };
				if (reachable) queuedPerSender.set(k, queued + 1);
				dirty = true;
			}
			if (dirty) saveThread(runDir, th);
		}
	});
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface Cursor {
	a: string;
	g: number;
	t: string | null;
	v: "unread" | "recent" | "all" | "index";
	/** Snapshot instant, used by the index view only. */
	s: number;
	/** Paging-session key, so marking read does not reshuffle the page list. */
	k: string;
	/** Thread message-prefix length at snapshot time: later arrivals are invisible. */
	n: number;
	i: number;
	o: number;
}

function newSessionKey(): string {
	return crypto.randomBytes(4).toString("hex");
}

function encodeCursor(c: Cursor): string {
	return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string, actor: Actor): Cursor {
	let c: any;
	try {
		c = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
	} catch {
		fail("invalid cursor");
	}
	if (
		!c ||
		typeof c.a !== "string" ||
		typeof c.g !== "number" ||
		typeof c.s !== "number" ||
		typeof c.i !== "number" ||
		typeof c.o !== "number" ||
		typeof c.k !== "string" ||
		!["unread", "recent", "all", "index"].includes(c.v)
	) {
		fail("invalid cursor");
	}
	if (c.t !== null && !isThreadId(String(c.t))) fail("invalid cursor (thread)");
	if (c.a !== actor.id || c.g !== actor.generation) fail("this cursor belongs to another agent");
	return c as Cursor;
}

function messageHeader(m: StoredMessage, actor: Actor, from: number, to: number, visible: boolean): string {
	const bits = [
		m.id,
		m.from.id === actor.id ? `to ${m.to.id}` : `from ${m.from.id}`,
		ago(m.at),
		`${m.text.length.toLocaleString("en-US")} chars`,
	];
	if (m.needs_reply) bits.push("reply requested");
	if (m.reply_to) bits.push(`re ${m.reply_to}`);
	if (m.failure) bits.push(`NOT DELIVERED: ${m.failure.reason}`);
	else if (m.inbound.state === "undelivered") bits.push(`not delivered: ${m.inbound.reason ?? "unknown"}`);
	if (!visible) bits.push("body withheld");
	else if (from > 0 || to < m.text.length) bits.push(`chars ${from}-${to} of ${m.text.length}`);
	return `[${bits.join(" · ")}]`;
}

/**
 * Read the inbox. With no thread_id this is an index of the caller's own
 * threads (counts only, no bodies, marks nothing read). With a thread_id it is
 * a bounded page of that thread; bodies shown are marked read, and only the
 * character ranges actually shown are marked.
 */
export function readMessages(runDir: string, actor: Actor, opts: ReadOptions = {}): ReadResult {
	const rawCursor = opts.cursor ? String(opts.cursor) : null;
	const cursor = rawCursor ? decodeCursor(rawCursor, actor) : null;
	const threadId = cursor ? cursor.t : opts.thread_id ? String(opts.thread_id).trim() : null;
	if (threadId !== null && !isThreadId(threadId)) {
		fail(`invalid thread id ${JSON.stringify(String(threadId).slice(0, 40))}`);
	}
	const view = cursor && cursor.v !== "index" ? cursor.v : (opts.view ?? "unread");
	if (!["unread", "recent", "all"].includes(view)) fail(`unknown view "${view}"`);
	const budget = Math.max(
		500,
		Math.min(MAX_READ_CHARS, typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : MAX_READ_CHARS),
	);

	return withLock(runDir, () =>
		threadId
			? readThreadPage(runDir, actor, threadId, view as "unread" | "recent" | "all", cursor, budget)
			: readIndex(runDir, actor, cursor, budget),
	);
}

/** Bounded teammate list: ids are what the model needs to address anyone. */
function teammates(runDir: string, actorId: string): string {
	const reg = loadRegistry(runDir) as MsgRegistry;
	const me = child(reg, actorId);
	const team = me ? teamOf(me) : "none";
	if (team === "none") return "";
	const mates = Object.values(reg.children)
		.filter((c) => c.id !== actorId && teamOf(c as MsgChild) === team)
		.slice(0, 20)
		.map((c) => `- ${c.id} (${c.state === "running" && accepting(c as MsgChild) ? "running" : c.state === "running" ? "finishing" : c.state}): ${String(c.task ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
	return mates.length ? `Teammates (team ${team}):\n${mates.join("\n")}\n` : `No teammates on team ${team} yet.\n`;
}

function readIndex(runDir: string, actor: Actor, cursor: Cursor | null, budget: number): ReadResult {
	const snapshot = cursor ? cursor.s : Date.now();
	const start = cursor ? cursor.i : 0;
	const rows: any[] = [];

	for (const th of loadThreads(runDir)) {
		if (!participantIds(th).includes(actor.id)) continue;
		const msgs = th.messages.filter((m) => m.at <= snapshot);
		if (msgs.length === 0) continue;
		// The index never marks anything read, so it has no paging session.
		const unread = msgs.filter((m) => isUnreadFor(m, actor, null)).length;
		const other = participantIds(th).find((p) => p !== actor.id) ?? actor.id;
		rows.push({
			thread_id: th.id,
			team: th.team,
			with: other,
			unread,
			total: msgs.length,
			last_at: msgs[msgs.length - 1].at,
			last_seq: msgs[msgs.length - 1].seq ?? 0,
			failed: msgs.filter((m) => m.from.id === actor.id && m.failure).length,
		});
	}
	rows.sort(
		(a, b) =>
			(b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) ||
			b.last_seq - a.last_seq ||
			b.last_at - a.last_at ||
			a.thread_id.localeCompare(b.thread_id),
	);

	// Only the first page carries the roster; continuation pages are threads only.
	const roster = start === 0 ? teammates(runDir, actor.id) : "";
	if (rows.length === 0) {
		return {
			text: `${roster}No team messages.`,
			details: { view: "index", threads: [], cursor: null, truncated: false },
		};
	}

	const totalUnread = rows.reduce((n, r) => n + r.unread, 0);
	let text = `${roster}Threads: ${rows.length}, unread messages: ${totalUnread}.\n`;
	const shown: any[] = [];
	let next: number | null = null;
	const room = budget - 220;
	for (let i = start; i < rows.length; i++) {
		const r = rows[i];
		const line =
			`- ${r.thread_id} · with ${r.with} · team ${r.team} · ${r.unread} unread of ${r.total} · ` +
			`last ${ago(r.last_at)}${r.failed ? ` · ${r.failed} of yours undelivered` : ""}\n`;
		if (shown.length > 0 && text.length + line.length > room) {
			next = i;
			break;
		}
		text += line;
		shown.push(r);
	}

	let cursorOut: string | null = null;
	if (next !== null) {
		cursorOut = encodeCursor({
			a: actor.id,
			g: actor.generation,
			t: null,
			v: "index",
			s: snapshot,
			k: cursor?.k ?? newSessionKey(),
			n: rows.length,
			i: next,
			o: 0,
		});
		text += `\n${rows.length - next} more thread(s): team_messages({ cursor: "${cursorOut}" })`;
	} else {
		text += `\nRead one with team_messages({ thread_id: "${shown[0].thread_id}" }).`;
	}
	return {
		text,
		details: { view: "index", threads: shown, total_threads: rows.length, cursor: cursorOut, truncated: next !== null },
	};
}

function readThreadPage(
	runDir: string,
	actor: Actor,
	threadId: string,
	view: "unread" | "recent" | "all",
	cursor: Cursor | null,
	budget: number,
): ReadResult {
	const th = loadThread(runDir, threadId);
	if (!th) fail(`no such thread ${threadId}`);
	if (!participantIds(th).includes(actor.id)) fail(`you are not a participant in thread ${threadId}`);

	const snapshot = cursor ? cursor.s : Date.now();
	const session = cursor ? cursor.k : newSessionKey();
	// The prefix is the whole snapshot: messages appended after it stay invisible
	// until the caller starts a fresh read.
	const prefix = cursor ? cursor.n : th.messages.length;
	const pool = th.messages.slice(0, prefix);

	let list: StoredMessage[];
	if (view === "unread") list = pool.filter((m) => isUnreadFor(m, actor, session));
	else if (view === "recent") list = pool.slice(-RECENT_WINDOW);
	else list = pool;

	const other = participantIds(th).find((p) => p !== actor.id) ?? actor.id;
	const head = `Thread ${th.id} (team ${th.team}, with agent ${other}) — ${view}, ${list.length} message(s):\n`;

	if (list.length === 0) {
		const empty =
			view === "unread"
				? `No unread messages in thread ${th.id}. Use view "recent" to see the last ${RECENT_WINDOW}.`
				: `Thread ${th.id} has no messages.`;
		return { text: empty, details: { view, thread_id: th.id, messages: [], cursor: null, truncated: false } };
	}

	let text = head;
	const shown: any[] = [];
	const room = budget - 220;
	let i = cursor ? cursor.i : 0;
	let off = cursor ? cursor.o : 0;
	let nextI: number | null = null;
	let nextO = 0;
	let dirty = false;

	for (; i < list.length; i++) {
		const m = list[i];
		const visible = bodyVisible(m, actor);
		const probe = messageHeader(m, actor, off, m.text.length, visible).length + 48;
		const space = room - text.length - probe;
		if (shown.length > 0 && space < 200) {
			nextI = i;
			nextO = off;
			break;
		}
		const end = visible ? Math.min(m.text.length, off + Math.max(space, 0)) : off;
		const header = messageHeader(m, actor, off, end, visible);
		text += `${header}\n`;
		if (visible) text += `${m.text.slice(off, end)}\n`;
		text += "\n";
		shown.push({
			id: m.id,
			from: m.from.id,
			to: m.to.id,
			at: m.at,
			size: m.text.length,
			needs_reply: m.needs_reply,
			shown: visible ? [off, end] : null,
			failed: !!m.failure,
		});
		if (visible && m.to.id === actor.id) {
			mergeRange(m, off, end, session);
			dirty = true;
		}
		if (visible && end < m.text.length) {
			nextI = i;
			nextO = end;
			break;
		}
		off = 0;
	}

	let cursorOut: string | null = null;
	if (nextI !== null) {
		cursorOut = encodeCursor({
			a: actor.id,
			g: actor.generation,
			t: th.id,
			v: view,
			s: snapshot,
			k: session,
			n: prefix,
			i: nextI,
			o: nextO,
		});
		text += `More to read: team_messages({ cursor: "${cursorOut}" })`;
	}
	if (dirty) saveThread(runDir, th);
	return {
		text: text.trimEnd(),
		details: { view, thread_id: th.id, messages: shown, cursor: cursorOut, truncated: nextI !== null },
	};
}

// ---------------------------------------------------------------------------
// Parent-facing summary
// ---------------------------------------------------------------------------

/** Counts only — never message bodies. Safe for the board and fleet views. */
export function summary(runDir: string): string {
	return withLock(runDir, () => {
		const reg = loadRegistry(runDir) as MsgRegistry;
		let threads: Thread[];
		try {
			threads = loadThreads(runDir);
		} catch (err) {
			return `Team messaging: unreadable (${(err as Error).message}).`;
		}
		const totals = { messages: 0, delivered: 0, unread: 0, undelivered: 0, retained: 0 };
		const per = new Map<string, { sent: number; received: number; unread: number; undelivered: number }>();
		const perTeam = new Map<string, { threads: number; messages: number }>();

		const bump = (id: string) => {
			let p = per.get(id);
			if (!p) per.set(id, (p = { sent: 0, received: 0, unread: 0, undelivered: 0 }));
			return p;
		};

		for (const th of threads) {
			const t = perTeam.get(th.team) ?? { threads: 0, messages: 0 };
			t.threads++;
			t.messages += th.messages.length;
			perTeam.set(th.team, t);
			for (const m of th.messages) {
				totals.messages++;
				bump(m.from.id).sent++;
				bump(m.to.id).received++;
				if (m.inbound.state === "delivered") totals.delivered++;
				if (m.inbound.state === "undelivered") {
					totals.undelivered++;
					bump(m.from.id).undelivered++;
				} else if (!m.read.full) {
					totals.unread++;
					bump(m.to.id).unread++;
				}
				if (m.failure?.notice.state === "retained") totals.retained++;
			}
		}

		if (totals.messages === 0) {
			const teams = Object.keys(reg.teams ?? {});
			return teams.length ? `Team messaging: no messages yet (teams: ${teams.join(", ")}).` : "No team messages.";
		}

		const lines: string[] = [
			`Team messaging: ${totals.messages} message(s), ${totals.delivered} delivered, ` +
				`${totals.unread} unread, ${totals.undelivered} undelivered` +
				(totals.retained ? `, ${totals.retained} failure notice(s) retained (sender gone)` : "") +
				".",
		];
		for (const [name, t] of [...perTeam.entries()].sort()) {
			const members = Object.values(reg.children).filter((c) => teamOf(c as MsgChild) === name).length;
			const goal = reg.teams?.[name]?.goal ?? "";
			lines.push(
				`- team ${name}: ${members} member(s), ${t.threads} thread(s), ${t.messages} message(s)` +
					(goal ? ` — goal: ${goal.slice(0, 80)}` : ""),
			);
		}
		const agents = [...per.entries()].sort((a, b) => b[1].sent + b[1].received - (a[1].sent + a[1].received));
		for (const [id, p] of agents.slice(0, 20)) {
			lines.push(
				`- ${id}: sent ${p.sent}, received ${p.received}, unread ${p.unread}, undelivered ${p.undelivered}`,
			);
		}
		if (agents.length > 20) lines.push(`- … ${agents.length - 20} more agent(s)`);

		let out = lines.join("\n");
		if (out.length > 4000) out = `${out.slice(0, 3960)}\n… (truncated)`;
		return out;
	});
}

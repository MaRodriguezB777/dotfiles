/**
 * Thread storage: one JSON file per thread under <runDir>/messages/.
 *
 * Every function here assumes the caller already holds the run lock from
 * ../registry.ts. There is exactly one lock in this system and it is never
 * taken twice.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Registry } from "../types.ts";
import { readRegistry, writeRegistry } from "../registry.ts";
import type { Thread } from "./types.ts";

export const THREAD_ID_RE = /^t-[0-9a-f]{8,32}$/;
export const MESSAGE_ID_RE = /^m-[0-9a-f]{8,32}$/;

export function messagesDir(runDir: string): string {
	return path.join(runDir, "messages");
}

export function newThreadId(): string {
	return `t-${crypto.randomBytes(6).toString("hex")}`;
}

export function newMessageId(): string {
	return `m-${crypto.randomBytes(6).toString("hex")}`;
}

export function isThreadId(id: string): boolean {
	return THREAD_ID_RE.test(id);
}

export function isMessageId(id: string): boolean {
	return MESSAGE_ID_RE.test(id);
}

/** Thread ids are the only user-supplied component of a path: keep them opaque. */
export function threadPath(runDir: string, threadId: string): string {
	if (!isThreadId(threadId)) throw new Error(`subagents: invalid thread id "${String(threadId).slice(0, 40)}"`);
	return path.join(messagesDir(runDir), `${threadId}.json`);
}

function parseThread(file: string, raw: string): Thread {
	let th: any;
	try {
		th = JSON.parse(raw);
	} catch {
		throw new Error(`subagents: thread file ${path.basename(file)} is corrupt (unreadable JSON)`);
	}
	if (!th || typeof th !== "object" || !Array.isArray(th.messages) || !Array.isArray(th.participants)) {
		throw new Error(`subagents: thread file ${path.basename(file)} is corrupt (unexpected shape)`);
	}
	return th as Thread;
}

/** Returns null only when the thread genuinely does not exist. Corrupt = throw. */
export function loadThread(runDir: string, threadId: string): Thread | null {
	const file = threadPath(runDir, threadId);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`subagents: thread ${threadId} is unreadable: ${(err as Error).message}`);
	}
	return parseThread(file, raw);
}

/** All threads, oldest first. An absent or empty messages/ dir yields []. */
export function loadThreads(runDir: string): Thread[] {
	const dir = messagesDir(runDir);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const out: Thread[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".json")) continue;
		const id = name.slice(0, -5);
		if (!isThreadId(id)) continue; // ignore stray files, never guess at them
		const file = path.join(dir, name);
		out.push(parseThread(file, fs.readFileSync(file, "utf8")));
	}
	out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	return out;
}

export function saveThread(runDir: string, th: Thread): void {
	const dir = messagesDir(runDir);
	fs.mkdirSync(dir, { recursive: true });
	const final = threadPath(runDir, th.id);
	const tmp = `${final}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(th));
	fs.renameSync(tmp, final); // atomic within the filesystem
}

export function loadRegistry(runDir: string): Registry {
	return readRegistry(runDir, path.basename(runDir), runDir);
}

export function saveRegistry(runDir: string, reg: Registry): void {
	writeRegistry(runDir, reg);
}

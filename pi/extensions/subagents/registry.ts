/**
 * The claims registry: a lock-protected JSON file that any process (parent or
 * child) can compare-and-swap.
 *
 * The safety property of this whole extension lives in `admit()` and
 * `matchesAny()`. Everything else is ergonomics.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildRecord, Registry } from "./types.ts";

// ---------------------------------------------------------------------------
// Path + glob handling
// ---------------------------------------------------------------------------

/** Normalize any path to a posix path relative to the run root. */
export function rel(root: string, p: string): string {
	const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
	let r = path.relative(root, abs).split(path.sep).join("/");
	if (r === "") r = ".";
	return r;
}

/** True if the path escapes the run root entirely. */
export function isOutsideRoot(root: string, p: string): boolean {
	const r = rel(root, p);
	return r === ".." || r.startsWith("../");
}

function globToRegex(glob: string): RegExp {
	let g = glob.trim().replace(/^\.\//, "").replace(/\/+$/, "");
	// A bare directory means the whole subtree.
	if (!/[*?]/.test(g) && !g.includes(".")) g = `${g}/**`;

	let out = "";
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === "*") {
			if (g[i + 1] === "*") {
				// `**/` should also match zero directories.
				if (g[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") {
			out += "[^/]";
		} else if ("\\^$.|+()[]{}".includes(c)) {
			out += `\\${c}`;
		} else {
			out += c;
		}
	}
	return new RegExp(`^${out}$`);
}

const regexCache = new Map<string, RegExp>();
function cachedRegex(glob: string): RegExp {
	let r = regexCache.get(glob);
	if (!r) {
		r = globToRegex(glob);
		regexCache.set(glob, r);
	}
	return r;
}

/** Precise membership test — used by the guard to police actual writes. */
export function matchesAny(relPath: string, globs: string[]): boolean {
	const p = relPath.replace(/^\.\//, "");
	return globs.some((g) => cachedRegex(g).test(p));
}

/**
 * Conservative territory prefix for a glob. Deliberately widens: for admission
 * we would rather reject a spawn that might be safe than admit one that is not.
 */
function territory(glob: string): string {
	const g = glob.trim().replace(/^\.\//, "").replace(/\/+$/, "");
	const star = g.search(/[*?]/);
	if (star === -1) return /\.[^/]*$/.test(g) ? g : `${g}/`;
	const cut = g.lastIndexOf("/", star);
	return cut === -1 ? "" : `${g.slice(0, cut)}/`;
}

function territoriesOverlap(a: string, b: string): boolean {
	return a === b || a.startsWith(b) || b.startsWith(a);
}

/** Returns the first overlapping pair, or null. */
export function overlaps(a: string[], b: string[]): { a: string; b: string } | null {
	for (const ga of a) {
		const ta = territory(ga);
		for (const gb of b) {
			if (territoriesOverlap(ta, territory(gb))) return { a: ga, b: gb };
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 15_000;

export function pidAlive(pid: number | null | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` inside a cross-process critical section. mkdir is atomic on every
 * filesystem we care about, which is the whole trick.
 */
export function withLock<T>(runDir: string, fn: () => T): T {
	const lockDir = path.join(runDir, ".lock");
	const ownerFile = path.join(lockDir, "owner");
	const deadline = Date.now() + 10_000;

	for (;;) {
		try {
			fs.mkdirSync(lockDir, { recursive: false });
			fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, at: Date.now() }));
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			// Reclaim a lock whose owner died or that is simply ancient.
			try {
				const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
				const stale = Date.now() - owner.at > LOCK_STALE_MS;
				if (stale && !pidAlive(owner.pid)) {
					fs.rmSync(lockDir, { recursive: true, force: true });
					continue;
				}
			} catch {
				// Owner file missing or unreadable: treat as stale after the grace period.
				try {
					const st = fs.statSync(lockDir);
					if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
						fs.rmSync(lockDir, { recursive: true, force: true });
						continue;
					}
				} catch {
					continue;
				}
			}
			if (Date.now() > deadline) throw new Error("subagents: timed out acquiring registry lock");
			sleepSync(25 + Math.floor(Math.random() * 50));
		}
	}

	try {
		return fn();
	} finally {
		try {
			fs.rmSync(lockDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

// ---------------------------------------------------------------------------
// Registry read/write
// ---------------------------------------------------------------------------

export function registryPath(runDir: string): string {
	return path.join(runDir, "claims.json");
}

export function readRegistry(runDir: string, runId: string, root: string): Registry {
	try {
		const raw = fs.readFileSync(registryPath(runDir), "utf8");
		const reg = JSON.parse(raw) as Registry;
		if (!reg.children) reg.children = {};
		return reg;
	} catch {
		return { runId, root, children: {} };
	}
}

export function writeRegistry(runDir: string, reg: Registry): void {
	const tmp = `${registryPath(runDir)}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
	fs.renameSync(tmp, registryPath(runDir)); // atomic within a filesystem
}

/**
 * Mark records whose process is gone. Called inside the lock.
 *
 * The `pid === null` branch matters: a record is written at admission, before
 * the process exists. If the parent dies in that window the claim would
 * otherwise be held forever by a child that never started.
 */
export function reap(reg: Registry): void {
	const now = Date.now();
	for (const c of Object.values(reg.children)) {
		if (c.state !== "running") continue;
		if (c.pid !== null && !pidAlive(c.pid)) {
			c.state = "killed";
			c.endedAt = now;
		} else if (c.pid === null && now - c.startedAt > 60_000) {
			c.state = "killed";
			c.endedAt = now;
		}
	}
}

/**
 * Locked read-modify-write of the registry. This is the ONLY correct way to
 * persist a child's state transition: the in-memory ChildRecord held by the
 * parent and the record inside claims.json are distinct objects, so mutating
 * the former does not release the latter's claim.
 */
export function mutateRegistry(
	runDir: string,
	runId: string,
	root: string,
	fn: (reg: Registry) => void,
): Registry {
	return withLock(runDir, () => {
		const reg = readRegistry(runDir, runId, root);
		reap(reg);
		fn(reg);
		writeRegistry(runDir, reg);
		return reg;
	});
}

/** Persist the fields of a live record that admission and reaping depend on. */
export function syncChildRecord(reg: Registry, rec: ChildRecord): void {
	const c = reg.children[rec.id];
	if (!c) return;
	c.pid = rec.pid;
	c.state = rec.state;
	c.endedAt = rec.endedAt;
	c.exitCode = rec.exitCode;
	c.sessionFile = rec.sessionFile;
	c.sessionId = rec.sessionId;
	c.generation = rec.generation;
	// `writes` is deliberately NOT synced: the child mutates its own claim via
	// claim_paths/release_paths, so the on-disk copy is authoritative and the
	// parent's in-memory copy is stale. A finished child stops being a live
	// writer by virtue of its state, which is what releases the territory.
}

export function liveWriters(reg: Registry, exceptId?: string): ChildRecord[] {
	return Object.values(reg.children).filter(
		(c) => c.state === "running" && c.id !== exceptId && c.writes.length > 0,
	);
}

// ---------------------------------------------------------------------------
// Admission control — the safety property
// ---------------------------------------------------------------------------

export interface AdmitResult {
	ok: boolean;
	reason?: string;
	holder?: ChildRecord;
	conflict?: { a: string; b: string };
}

export function admit(reg: Registry, id: string, writes: string[]): AdmitResult {
	if (writes.length === 0) return { ok: true };

	for (const other of liveWriters(reg, id)) {
		const hit = overlaps(writes, other.writes);
		if (hit) {
			const age = Math.round((Date.now() - other.startedAt) / 1000);
			return {
				ok: false,
				holder: other,
				conflict: hit,
				reason:
					`Write conflict: "${hit.a}" overlaps "${hit.b}", already claimed by child ` +
					`${other.id} ("${other.task.slice(0, 70)}${other.task.length > 70 ? "…" : ""}", ` +
					`running ${age}s).\n` +
					`Resolve by one of:\n` +
					`  1. subagent_collect({ ids: ["${other.id}"] }) and then spawn this one, or\n` +
					`  2. re-partition so the two children own disjoint paths, or\n` +
					`  3. merge the two tasks into one child (overlapping ownership usually means\n` +
					`     they share a mental model and should not have been split).`,
			};
		}
	}
	return { ok: true };
}

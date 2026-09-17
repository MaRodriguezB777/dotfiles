/**
 * guard.ts — loaded INTO each child with `pi -e`.
 *
 * Two jobs:
 *   1. Police writes against the child's claim (the boundary).
 *   2. Provide the cooperative tools: claim_paths, release_paths, note, notes,
 *      request_edit.
 *
 * Claim arbitration happens here, in the child, via compare-and-swap on the
 * lock-protected registry. The parent is not involved for tiers 1 and 2 —
 * which is what keeps the orchestrator's token cost at zero for the common case.
 *
 * Honest limitation: bash is unbounded. `looksLikeWrite` catches redirects,
 * tee, sed -i, mv/cp/rm and friends, but `python -c`, heredocs into scripts and
 * Makefile targets can all escape it. This is an airbag, not a sandbox.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { writeBoard, countLines } from "./board.ts";
import { DEFAULT_SHARED_PATHS as CFG_SHARED, loadConfig } from "./config.ts";
import { CLAIM_SPEC, NOTES_SPEC, NOTE_SPEC, RELEASE_SPEC, REQUEST_EDIT_SPEC } from "./text.ts";
import { matchesAny, readRegistry, rel, reap, writeRegistry, withLock, liveWriters, overlaps } from "./registry.ts";

const CHILD_ID = process.env.PI_SUBAGENT_ID ?? "";
const RUN_DIR = process.env.PI_SUBAGENT_RUN_DIR ?? "";
const ROOT = process.env.PI_SUBAGENT_ROOT ?? process.cwd();

const PARENT_PID = Number(process.env.PI_SUBAGENT_PARENT_PID ?? "0");
/** Grace for a turn boundary to arrive once the parent is known dead. */
const STAND_DOWN_DEADLINE_MS = 20_000;

/**
 * Kill anything this child started that is still running.
 *
 * pi's bash tool spawns its shell with `detached: true`, giving it its own
 * session, so a `for` loop or dev server started by a tool call is NOT in our
 * process group and survives us - it just gets reparented to init and keeps
 * writing to the repository. Those processes do inherit our environment, so
 * PI_SUBAGENT_ID identifies them precisely.
 *
 * Linux-only (/proc); elsewhere this is a no-op and the group kill is all we
 * have.
 */
function sweepDescendants(): void {
	if (!CHILD_ID) return;
	const victims: number[] = [];
	try {
		for (const entry of fs.readdirSync("/proc")) {
			const pid = Number(entry);
			if (!Number.isInteger(pid) || pid === process.pid) continue;
			try {
				const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
				if (env.includes(`PI_SUBAGENT_ID=${CHILD_ID}\0`)) victims.push(pid);
			} catch {
				/* vanished or not ours to read */
			}
		}
	} catch {
		return; // no /proc
	}
	for (const pid of victims) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			/* already gone */
		}
	}
	setTimeout(() => {
		for (const pid of victims) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	}, 2_000).unref?.();
}
const CLAIM_POLL_MS = 1500;
const CLAIM_WAIT_MS = loadConfig().claimWaitMs;
const DEFAULT_SHARED = loadConfig().sharedPaths ?? CFG_SHARED;

function findingsFile() {
	return path.join(RUN_DIR, "findings.jsonl");
}
function escalationsFile() {
	return path.join(RUN_DIR, "escalations.jsonl");
}
function requestsFile() {
	return path.join(RUN_DIR, "requests.jsonl");
}

/** Append-only writes are atomic for small records; no lock needed. */
function appendJSONL(file: string, obj: unknown): void {
	try {
		fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
	} catch {
		/* ignore */
	}
}

/* ---------------------------------------------------------------- orphans */

/**
 * A child is a plain OS process; nothing reparents or reaps it when the parent
 * dies. Without this it would keep thinking, keep spending, and keep WRITING to
 * the repository with nobody reading its output.
 *
 * Two signals, because neither alone is sound:
 *   - kill(ppid, 0) is instant but lies after pid reuse.
 *   - the heartbeat file cannot be impersonated, but is only as fresh as the
 *     parent's timer, so it needs generous slack to avoid false positives.
 * The parent is considered gone only when BOTH agree.
 */
function parentGone(): boolean {
	if (PARENT_PID > 0) {
		try {
			process.kill(PARENT_PID, 0);
			return false; // pid alive: trust it, whoever it now is
		} catch {
			/* fall through to the heartbeat, which is authoritative */
		}
	}
	try {
		const age = Date.now() - fs.statSync(path.join(RUN_DIR, "heartbeat")).mtimeMs;
		return age > loadConfig().orphanStaleMs;
	} catch {
		return true; // run dir or heartbeat destroyed: nothing to report back to
	}
}

/**
 * Records the child as orphaned and RELEASES ITS CLAIM, so a later session is
 * not blocked out of that territory by a process that no longer exists.
 */
function markOrphaned(): void {
	try {
		withLock(RUN_DIR, () => {
			const reg = readRegistry(RUN_DIR, "", ROOT);
			const me = reg.children[CHILD_ID];
			if (me) {
				me.state = "orphaned";
				me.endedAt = Date.now();
			}
			writeRegistry(RUN_DIR, reg);
			refreshBoard(reg);
		});
	} catch {
		/* ignore */
	}
	// The parent normally writes result.md on exit; there is no parent now, so
	// leave a marker rather than an empty file, and point at the session that can
	// actually be resumed.
	try {
		const rp = path.join(RUN_DIR, CHILD_ID, "result.md");
		if (!fs.existsSync(rp) || fs.readFileSync(rp, "utf8").trim() === "") {
			fs.writeFileSync(
				rp,
				"(orphaned: the parent session ended while this child was working. " +
					"Its full transcript is intact and it can be resumed with " +
					"/subagents-resume-run followed by subagent_followup.)\n",
			);
		}
	} catch {
		/* ignore */
	}
	appendJSONL(findingsFile(), {
		kind: "orphaned",
		child: CHILD_ID,
		text: "parent session gone; stood down at a safe boundary",
		at: Date.now(),
	});
}

function myClaim(): { writes: string[]; shared: string[] } {
	const reg = readRegistry(RUN_DIR, "", ROOT);
	const me = reg.children[CHILD_ID];
	return { writes: me?.writes ?? [], shared: DEFAULT_SHARED };
}

function refreshBoard(reg: any): void {
	writeBoard(RUN_DIR, reg, countLines(findingsFile()));
}

// ---------------------------------------------------------------------------
// bash write-target extraction (best effort, deliberately conservative)
// ---------------------------------------------------------------------------

export const DEFAULT_SHARED_PATHS = DEFAULT_SHARED;

const WRITE_CMD = /\b(tee|dd|truncate)\b/;
const WRITE_VERB = /\b(mv|cp|rm|rmdir|install|ln|touch|mkdir|chmod|chown)\s+/;
const SED_INPLACE = /\bsed\s+[^|;&]*-i\b/;
const GIT_MUTATE = /\bgit\s+(checkout|restore|apply|stash|reset|clean|rebase|merge|cherry-pick)\b/;

export function looksLikeWrite(cmd: string): boolean {
	return (
		/(^|[^>])>>?[^>]/.test(cmd) ||
		WRITE_CMD.test(cmd) ||
		WRITE_VERB.test(cmd) ||
		SED_INPLACE.test(cmd) ||
		GIT_MUTATE.test(cmd)
	);
}

export function extractWriteTargets(cmd: string): string[] {
	const out = new Set<string>();
	for (const m of cmd.matchAll(/>>?\s*([^\s;|&()<>]+)/g)) out.add(m[1]);
	for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?([^\s;|&()<>]+)/g)) out.add(m[1]);
	for (const m of cmd.matchAll(/\bsed\s+[^|;&]*-i[^\s]*\s+(?:'[^']*'|"[^"]*"|\S+)\s+([^\s;|&()<>]+)/g))
		out.add(m[1]);
	for (const m of cmd.matchAll(/\b(?:mv|cp|ln|install)\s+(?:-\S+\s+)*\S+\s+([^\s;|&()<>]+)/g)) out.add(m[1]);
	for (const m of cmd.matchAll(/\b(?:rm|touch|mkdir|rmdir)\s+(?:-\S+\s+)*([^\s;|&()<>]+)/g)) out.add(m[1]);
	return [...out]
		.map((t) => t.replace(/^["']|["']$/g, ""))
		.filter((t) => t && !t.startsWith("-") && !t.startsWith("/dev/"));
}

// ---------------------------------------------------------------------------
// Pure decision logic, exported so it can be tested without a model in the loop.
// ---------------------------------------------------------------------------

export interface WriteVerdict {
	block: true;
	kind: "outside_root" | "shared_file" | "outside_claim";
	reason: string;
}

export function evaluateWrite(
	rawPath: string,
	opts: {
		root: string;
		writes: string[];
		shared: string[];
		/** Resolve which other live child owns a path, if any. */
		holderOf?: (relPath: string) => string | undefined;
	},
): WriteVerdict | undefined {
	const p = rel(opts.root, rawPath);
	if (p === ".." || p.startsWith("../")) {
		return {
			block: true,
			kind: "outside_root",
			reason: `"${rawPath}" is outside the project root. Refused.`,
		};
	}
	if (matchesAny(p, opts.shared)) {
		return {
			block: true,
			kind: "shared_file",
			reason:
				`"${p}" is a shared file that no agent may write directly (other agents depend ` +
				`on it concurrently). Use request_edit("${p}", <patch>, <why>) instead and the ` +
				`orchestrator will apply it serially.`,
		};
	}
	if (!matchesAny(p, opts.writes)) {
		const holder = opts.holderOf?.(p);
		return {
			block: true,
			kind: "outside_claim",
			reason:
				`"${p}" is outside your write claim (${opts.writes.length ? opts.writes.join(", ") : "read-only"}).` +
				(holder ? ` It is currently owned by child ${holder}.` : " No other agent owns it.") +
				`\nDo NOT work around this with bash — that silently destroys another agent's work.` +
				`\nEither call claim_paths(["${p}"], "<why>")` +
				(holder ? ` (you will wait for ${holder} to release it)` : " (this will be granted immediately)") +
				`, or stay inside your claim and report the need in your final message.`,
		};
	}
	return undefined;
}

/** Evaluate a whole bash command; returns the first offending target's verdict. */
export function evaluateBash(
	cmd: string,
	opts: Parameters<typeof evaluateWrite>[1],
): WriteVerdict | undefined {
	if (!looksLikeWrite(cmd)) return undefined;
	for (const target of extractWriteTargets(cmd)) {
		const v = evaluateWrite(target, opts);
		if (v) return v;
	}
	return undefined;
}

// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	if (!CHILD_ID || !RUN_DIR) return; // not running as a managed child

	// ---- forced compaction on follow-up -------------------------------------
	//
	/* ------------------------------------------------- orphan watchdog ----- */
	// Stopping mid-tool-call is how you get half-applied work: a write that
	// landed with no verification, or an edit sequence cut in two. So a dead
	// parent does not kill this child on the spot - it raises a flag, and the
	// child stands down at the next turn boundary. The deadline exists because a
	// child stuck inside a very long tool call must not outlive its parent
	// indefinitely just because no boundary ever arrives.
	const cfg = loadConfig();
	let standDown = false;
	let standDownAt = 0;
	let latestCtx: any;

	let exiting = false;
	const exitNow = (why: string) => {
		if (exiting) return;
		exiting = true;
		void why;
		markOrphaned();
		try {
			latestCtx?.shutdown();
		} catch {
			/* fall through to the hard exit below */
		}
		// Take the whole process group down, not just this process: a bash tool
		// call can leave a loop or a server running that would otherwise keep
		// writing to the repo long after the agent that started it is gone.
		// Delayed so ctx.shutdown() can flush the session file first.
		sweepDescendants();
		setTimeout(() => {
			try {
				process.kill(-process.pid, "SIGTERM");
			} catch {
				/* not a group leader: fall through to plain exit */
			}
			process.exit(0);
		}, 3_000).unref?.();
	};

	// The parent reads our JSON events over a pipe. If it dies, that pipe breaks
	// and the next write raises EPIPE, which by default kills this process before
	// the watchdog ever runs - exiting without releasing the claim or writing a
	// result. A broken pipe IS proof the parent is gone, so treat it as such.
	for (const s of [process.stdout, process.stderr]) {
		s.on?.("error", (err: NodeJS.ErrnoException) => {
			if (err?.code !== "EPIPE") return;
			exitNow("epipe");
		});
	}

	const watchdog = setInterval(() => {
		if (!standDown) {
			if (!parentGone()) return;
			standDown = true;
			standDownAt = Date.now();
			// Nothing in flight: no boundary is coming, so go now.
			if (latestCtx?.isIdle?.()) {
				clearInterval(watchdog);
				exitNow("idle");
			}
			return;
		}
		// Flagged already. A turn boundary is the clean exit, but for a child deep
		// inside one long tool call none may ever arrive, and every second past
		// this point is work nobody will read.
		if (Date.now() - standDownAt > STAND_DOWN_DEADLINE_MS) {
			clearInterval(watchdog);
			exitNow("deadline");
		}
	}, cfg.orphanPollMs);
	watchdog.unref?.();

	const boundary = (_event: unknown, ctx: any) => {
		latestCtx = ctx;
		if (standDown) {
			clearInterval(watchdog);
			exitNow("boundary");
		}
	};
	pi.on("agent_end", boundary);
	pi.on("session_start", (_e, ctx) => {
		latestCtx = ctx;
	});

	// ctx.compact() is fire-and-forget, so we await it inside before_agent_start
	// to guarantee the follow-up turn runs against the compacted context rather
	// than racing it. The timeout is deliberate: if compaction cannot complete
	// here, the correct failure is a slightly larger context, not a hung child.
	let compactPending = process.env.PI_SUBAGENT_COMPACT === "1";
	if (compactPending) {
		pi.on("before_agent_start", async (_event, ctx) => {
			if (!compactPending) return;
			compactPending = false;
			await new Promise<void>((resolve) => {
				const done = (outcome: string, detail?: string) => {
					clearTimeout(timer);
					// Record what actually happened. pi legitimately refuses to compact a
					// session with nothing old enough to summarize, and the orchestrator
					// must not be left believing a compaction occurred when it did not.
					appendJSONL(findingsFile(), {
						t: Date.now(),
						child: CHILD_ID,
						kind: "compaction",
						outcome,
						detail: detail ?? "",
					});
					resolve();
				};
				const timer = setTimeout(() => done("timeout"), 90_000);
				try {
					ctx.compact({
						customInstructions:
							"Preserve: the task you were given, every file you changed and why, " +
							"anything you verified, and any path you needed but could not get. " +
							"Discard exploratory reading that led nowhere.",
						onComplete: (r: { tokensBefore?: number; estimatedTokensAfter?: number }) =>
							done("compacted", `${r?.tokensBefore ?? "?"} -> ${r?.estimatedTokensAfter ?? "?"} tok`),
						onError: (e: Error) => done("skipped", e?.message ?? "unknown"),
					});
				} catch (e) {
					done("failed", (e as Error)?.message);
				}
			});
		});
	}

	// ---- the boundary -------------------------------------------------------

	pi.on("tool_call", async (event) => {
		const { writes, shared } = myClaim();

		const opts = {
			root: ROOT,
			writes,
			shared,
			holderOf: (p: string) => {
				const reg = readRegistry(RUN_DIR, "", ROOT);
				return liveWriters(reg, CHILD_ID).find((c) => matchesAny(p, c.writes))?.id;
			},
		};

		const checkPath = (raw: string): { block: true; reason: string } | undefined => {
			const v = evaluateWrite(raw, opts);
			if (!v) return undefined;
			appendJSONL(findingsFile(), {
				t: Date.now(),
				child: CHILD_ID,
				kind: "blocked",
				path: rel(ROOT, raw),
				text: v.reason,
			});
			return { block: true, reason: v.reason };
		};

		if (isToolCallEventType("write", event)) {
			const r = checkPath((event.input as any).path);
			if (r) return r;
		}
		if (isToolCallEventType("edit", event)) {
			const r = checkPath((event.input as any).path);
			if (r) return r;
		}
		if (isToolCallEventType("bash", event)) {
			const cmd = (event.input as any).command ?? "";
			if (looksLikeWrite(cmd)) {
				for (const target of extractWriteTargets(cmd)) {
					const r = checkPath(target);
					if (r) {
						return {
							block: true,
							reason: `${r.reason}\n(Detected in bash command: ${cmd.slice(0, 120)})`,
						};
					}
				}
			}
		}
	});

	// ---- cooperative tools --------------------------------------------------
	//
	// A child spawned with no write claim is read-only for its whole life: it
	// never receives the claim/release/request tools at all. That saves it ~400
	// tokens per request and removes any ambiguity about whether "read-only"
	// really means read-only. If such a child turns out to need a write, it says
	// so in its final message and the orchestrator re-spawns it with a claim.
	const isReadOnly = myClaim().writes.length === 0;

	pi.registerTool({
		...NOTE_SPEC,
		async execute(_id, params: { text: string; paths?: string[] }) {
			appendJSONL(findingsFile(), {
				t: Date.now(),
				child: CHILD_ID,
				kind: "finding",
				text: params.text,
				paths: params.paths ?? [],
			});
			return { content: [{ type: "text", text: "Shared." }], details: undefined };
		},
	});

	pi.registerTool({
		...NOTES_SPEC,
		async execute(_id, params: { grep?: string; limit?: number }) {
			let rows: any[] = [];
			try {
				rows = fs
					.readFileSync(findingsFile(), "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => {
						try {
							return JSON.parse(l);
						} catch {
							return null;
						}
					})
					.filter((r) => r && r.kind === "finding");
			} catch {
				/* no findings yet */
			}
			if (params.grep) {
				const re = new RegExp(params.grep, "i");
				rows = rows.filter((r) => re.test(r.text) || (r.paths ?? []).some((p: string) => re.test(p)));
			}
			const limit = Math.min(params.limit ?? 20, 50);
			rows = rows.slice(-limit).filter((r) => r.child !== CHILD_ID);

			if (rows.length === 0) {
				return { content: [{ type: "text", text: "No findings from other agents yet." }], details: undefined };
			}
			const text = rows
				.map((r) => `- [${r.child}] ${r.text}${r.paths?.length ? ` (${r.paths.join(", ")})` : ""}`)
				.join("\n");
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	if (isReadOnly) return;

	pi.registerTool({
		...CLAIM_SPEC,
		async execute(_id, params: { paths: string[]; why: string }, signal) {
			const wanted = params.paths.map((p) => rel(ROOT, p));
			const deadline = Date.now() + CLAIM_WAIT_MS;
			let waitedOn: string | null = null;

			for (;;) {
				const outcome = withLock(RUN_DIR, () => {
					const reg = readRegistry(RUN_DIR, "", ROOT);
					reap(reg);
					const me = reg.children[CHILD_ID];
					if (!me) return { kind: "error" as const, msg: "child not in registry" };

					const blocking = liveWriters(reg, CHILD_ID).find((c) => overlaps(wanted, c.writes));
					if (blocking) return { kind: "wait" as const, holder: blocking.id, task: blocking.task };

					// Tier 1: uncontested -> grant.
					me.writes = [...new Set([...me.writes, ...wanted])];
					writeRegistry(RUN_DIR, reg);
					refreshBoard(reg);
					return { kind: "granted" as const, writes: me.writes };
				});

				if (outcome.kind === "error") {
					return { content: [{ type: "text", text: `claim_paths failed: ${outcome.msg}` }], isError: true, details: undefined };
				}

				if (outcome.kind === "granted") {
					appendJSONL(findingsFile(), {
						t: Date.now(),
						child: CHILD_ID,
						kind: "claimed",
						paths: wanted,
						text: params.why,
					});
					return {
						content: [
							{
								type: "text",
								text:
									`Granted. Your claim is now: ${outcome.writes.join(", ")}\n` +
									(waitedOn ? `(waited for ${waitedOn} to release)\n` : "") +
									`Release with release_paths() as soon as you are done with any of it.`,
							},
						],
						details: { writes: outcome.writes },
					};
				}

				// Tier 2: contested but the holder is alive -> wait.
				waitedOn = outcome.holder;
				if (Date.now() > deadline || signal?.aborted) {
					// Tier 3: give up gracefully and tell the orchestrator. We do NOT wait
					// for a parent decision — that is the deadlock we refuse to build.
					appendJSONL(escalationsFile(), {
						kind: "claim_timeout",
						child: CHILD_ID,
						paths: wanted,
						holder: outcome.holder,
						detail: `waited ${Math.round(CLAIM_WAIT_MS / 1000)}s for ${outcome.holder}: ${params.why}`,
						at: Date.now(),
					});
					return {
						content: [
							{
								type: "text",
								text:
									`Not granted: ${outcome.holder} still owns these paths after ` +
									`${Math.round(CLAIM_WAIT_MS / 1000)}s ("${outcome.task.slice(0, 60)}").\n` +
									`The orchestrator has been notified. Do not keep retrying and do not use ` +
									`bash to work around it. Complete whatever you can inside your existing ` +
									`claim, then stop and state clearly in your final message that you still ` +
									`need: ${wanted.join(", ")}`,
							},
						],
						isError: true,
						details: undefined,
					};
				}
				await new Promise((r) => setTimeout(r, CLAIM_POLL_MS));
			}
		},
	});

	pi.registerTool({
		...RELEASE_SPEC,
		async execute(_id, params: { paths: string[] }) {
			const result = withLock(RUN_DIR, () => {
				const reg = readRegistry(RUN_DIR, "", ROOT);
				const me = reg.children[CHILD_ID];
				if (!me) return null;
				const all = params.paths.some((p) => p === "*" || p === "**");
				const drop = params.paths.map((p) => rel(ROOT, p));
				const before = me.writes;
				me.writes = all ? [] : me.writes.filter((w) => !drop.includes(w) && !drop.includes(rel(ROOT, w)));
				writeRegistry(RUN_DIR, reg);
				refreshBoard(reg);
				return { before, after: me.writes };
			});

			if (!result) {
				return { content: [{ type: "text", text: "release_paths: child not in registry" }], isError: true, details: undefined };
			}
			appendJSONL(findingsFile(), {
				t: Date.now(),
				child: CHILD_ID,
				kind: "released",
				paths: result.before.filter((w) => !result.after.includes(w)),
			});
			return {
				content: [
					{
						type: "text",
						text: result.after.length
							? `Released. Remaining claim: ${result.after.join(", ")}`
							: `Released everything. You are now read-only — do not attempt further writes.`,
					},
				],
				details: { writes: result.after },
			};
		},
	});

	pi.registerTool({
		...REQUEST_EDIT_SPEC,
		async execute(_id, params: { path: string; patch: string; why: string }) {
			appendJSONL(requestsFile(), {
				t: Date.now(),
				child: CHILD_ID,
				path: rel(ROOT, params.path),
				patch: params.patch,
				why: params.why,
			});
			return {
				content: [
					{
						type: "text",
						text: `Queued for the orchestrator. Continue with the rest of your task; do not wait for it.`,
					},
				],
				details: undefined,
			};
		},
	});
}

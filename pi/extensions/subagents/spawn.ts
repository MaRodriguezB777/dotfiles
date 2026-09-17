/**
 * Child process launch + JSONL stream consumption.
 *
 * Non-blocking by design: `launch()` returns as soon as the process exists.
 * Everything after that is event-driven, and none of it touches LLM context
 * unless the caller explicitly asks for it.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { childExtensionFiles } from "./config.ts";
import { CHILD_TOOL_NAMES, childSystemPrompt, childToolNames } from "./text.ts";
import type { AgentDef, ChildRecord, LiveChild, ToolTrace, Usage } from "./types.ts";

const MAX_TOOL_TRACE = 12;
const MAX_TAIL = 10;
const TAIL_CHARS = 400;
const MAX_STDERR = 8000;

/** Resolve how to re-invoke pi, mirroring the official example's logic. */
export function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	const isBunVirtual = script?.startsWith("/$bunfs/root/");
	if (script && !isBunVirtual && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const exec = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exec)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function briefArgs(toolName: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	const pick = (k: string) => (typeof args[k] === "string" ? args[k] : undefined);
	const v =
		pick("path") ??
		pick("file_path") ??
		pick("command") ??
		pick("pattern") ??
		pick("query") ??
		pick("text") ??
		"";
	const s = String(v).replace(/\s+/g, " ").trim();
	return s.length > 70 ? `${s.slice(0, 67)}…` : s;
}

/** Cap on in-flight tool calls tracked per child, so a long run cannot leak. */
const MAX_PENDING_ARGS = 64;

/**
 * Full argument fingerprint for loop detection. Keys are sorted so that an
 * argument-order difference is not mistaken for a different call.
 */
function fullArgs(args: any): string {
	if (!args || typeof args !== "object") return "";
	try {
		const keys = Object.keys(args).sort();
		return JSON.stringify(keys.map((k) => [k, args[k]]));
	} catch {
		return "";
	}
}

function textOf(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("\n")
		.trim();
}

export interface LaunchOptions {
	record: ChildRecord;
	agent: AgentDef;
	runDir: string;
	childDir: string;
	root: string;
	guardPath: string;
	model?: string;
	/** Resume an existing session file instead of starting a fresh one. */
	resumeFrom?: string | null;
	/** Force compaction before the resumed turn. */
	compact?: boolean;
	/** Carry cumulative usage across generations. */
	seedUsage?: Usage;
	onEvent: (live: LiveChild, kind: string) => void;
}

export function newLive(record: ChildRecord, seedUsage?: Usage): LiveChild {
	return {
		record,
		usage: seedUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		tools: [],
		tail: [],
		lastText: "",
		lastEventAt: Date.now(),
		startedAt: Date.now(),
		consecutiveErrors: 0,
		repeatSignature: null,
		repeatCount: 0,
		blockCount: 0,
		stderr: "",
		stuckNotified: false,
		settled: false,
		onSettle: [],
	};
}

export function launch(opts: LaunchOptions): { proc: ChildProcess; live: LiveChild } {
	const { record, agent, runDir, childDir, root, guardPath, onEvent } = opts;
	const live = newLive(record, opts.seedUsage);

	fs.mkdirSync(childDir, { recursive: true });
	const sessionDir = path.join(childDir, "session");
	fs.mkdirSync(sessionDir, { recursive: true });

	const boardRel = path.relative(root, path.join(runDir, "BOARD.md")).split(path.sep).join("/");
	const systemPath = path.join(childDir, "system.md");
	fs.writeFileSync(systemPath, childSystemPrompt(agent, record.writes, boardRel));
	// Append rather than overwrite: the task file is the record of every request
	// this child has been given, not just the latest one.
	if (opts.resumeFrom) {
		fs.appendFileSync(
			path.join(childDir, "task.md"),
			`\n\n--- follow-up (generation ${record.generation}) ---\n${record.task}\n`,
		);
	} else {
		fs.writeFileSync(path.join(childDir, "task.md"), record.task);
	}

	const args = ["--mode", "json", "-p"];
	args.push("--session-dir", sessionDir);
	if (opts.resumeFrom) {
		// Resume the existing transcript: the child keeps everything it already
		// learned, which is the entire point of a follow-up.
		args.push("--session", opts.resumeFrom);
	} else {
		// Let pi mint the session id; we locate the file by scanning the private dir.
		args.push("--name", `${record.agent}: ${record.task.slice(0, 50)}`);
	}
	args.push("--append-system-prompt", systemPath);
	if (!agent.inheritExtensions) {
		// Deterministic tool surface, but auth/provider adapters are infrastructure,
		// not features: -e still works under --no-extensions, so we re-inject the
		// configured set (globally, or per-agent via `extensions:` frontmatter).
		args.push("--no-extensions");
		for (const ext of childExtensionFiles(agent.extensions)) args.push("-e", ext);
	}
	args.push("-e", guardPath);
	// Already resolved by the caller (see resolveModel in index.ts) and recorded,
	// so a resumed child keeps the model it started on.
	if (record.model) args.push("--model", record.model);
	if (record.thinking) args.push("--thinking", record.thinking);
	const readOnly = record.writes.length === 0;
	if (agent.tools?.length) {
		// An explicit allowlist must still include the guard's own tools, or the
		// child loses the ability to cooperate at all.
		args.push("--tools", [...agent.tools, ...childToolNames(readOnly)].join(","));
	}
	// A read-only child can never write, so it should not carry the definitions
	// of tools it may only be refused. Saves tokens and prevents doomed attempts.
	const exclude = [...(agent.excludeTools ?? []), ...(readOnly ? ["write", "edit"] : [])];
	if (exclude.length) args.push("--exclude-tools", [...new Set(exclude)].join(","));
	args.push("--", record.task);

	const inv = piInvocation(args);
	const proc = spawn(inv.command, inv.args, {
		cwd: record.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		// Own process group per child. A child's bash tool spawns grandchildren
		// (build loops, servers, sleeps) that outlive the child itself, so both
		// shutdown paths need to signal a GROUP rather than a single pid. Without
		// this, a stood-down child leaves its `for` loop still writing files.
		detached: true,
		env: {
			...process.env,
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_ID: record.id,
			PI_SUBAGENT_RUN_DIR: runDir,
			PI_SUBAGENT_ROOT: root,
			// Lets the child detect that this parent has died and stand itself down
			// instead of running on as an orphan.
			PI_SUBAGENT_PARENT_PID: String(process.pid),
			...(opts.compact ? { PI_SUBAGENT_COMPACT: "1" } : {}),
		},
	});

	record.pid = proc.pid ?? null;

	let buffer = "";
	// Per-child: correlates tool_execution_start args with its _end event.
	const pendingArgs = new Map<string, { brief: string; sig: string }>();
	const handleLine = (line: string) => {
		const t = line.trim();
		if (!t) return;
		let event: any;
		try {
			event = JSON.parse(t);
		} catch {
			return;
		}
		live.lastEventAt = Date.now();

		switch (event.type) {
			case "session":
				if (typeof event.id === "string") {
					record.sessionId = event.id;
					record.sessionFile = findSessionFile(sessionDir, event.id) ?? null;
				}
				break;

			// Only tool_execution_start carries `args`; the matching _end event does
			// not. Stash them by toolCallId so the trace and the repeat signature can
			// see what the tool was actually called WITH. Without this every read
			// collapses to the signature "read:" and three reads of three different
			// files look like a loop.
			case "tool_execution_start":
				if (typeof event.toolCallId === "string") {
					pendingArgs.set(event.toolCallId, {
						brief: briefArgs(event.toolName, event.args),
						sig: fullArgs(event.args),
					});
					if (pendingArgs.size > MAX_PENDING_ARGS) {
						pendingArgs.delete(pendingArgs.keys().next().value as string);
					}
				}
				break;

			case "tool_execution_end": {
				const pend = pendingArgs.get(event.toolCallId);
				pendingArgs.delete(event.toolCallId);
				const trace: ToolTrace = {
					name: event.toolName,
					brief: pend?.brief ?? "",
					isError: Boolean(event.isError),
					at: Date.now(),
				};
				live.tools.push(trace);
				if (live.tools.length > MAX_TOOL_TRACE) live.tools.shift();

				live.consecutiveErrors = trace.isError ? live.consecutiveErrors + 1 : 0;
				// Repeat detection must compare EVERY argument, not just the headline
				// one. Paging through a long file is read(f, offset:0), read(f,
				// offset:100), read(f, offset:200) - same path, entirely different
				// calls, and legitimate work. Only a byte-identical call is a loop.
				const sig = `${trace.name}:${pend?.sig ?? ""}`;
				if (sig === live.repeatSignature) live.repeatCount++;
				else {
					live.repeatSignature = sig;
					live.repeatCount = 1;
				}
				onEvent(live, "tool");
				break;
			}

			case "message_end": {
				const msg = event.message;
				if (!msg) break;
				if (msg.role === "assistant") {
					live.usage.turns++;
					const u = msg.usage;
					if (u) {
						live.usage.input += u.input || 0;
						live.usage.output += u.output || 0;
						live.usage.cacheRead += u.cacheRead || 0;
						live.usage.cacheWrite += u.cacheWrite || 0;
						live.usage.cost += u.cost?.total || 0;
					}
					const text = textOf(msg);
					if (text) live.lastText = text;
				}
				const text = textOf(msg);
				if (text) {
					live.tail.push({
						role: msg.role,
						text: text.length > TAIL_CHARS ? `${text.slice(0, TAIL_CHARS)}…` : text,
						at: Date.now(),
					});
					if (live.tail.length > MAX_TAIL) live.tail.shift();
				}
				onEvent(live, "message");
				break;
			}

			case "agent_end":
				onEvent(live, "agent_end");
				break;
		}
	};

	proc.stdout.on("data", (d: Buffer) => {
		buffer += d.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const l of lines) handleLine(l);
	});

	proc.stderr.on("data", (d: Buffer) => {
		live.stderr = (live.stderr + d.toString()).slice(-MAX_STDERR);
	});

	const finish = (code: number | null) => {
		if (live.settled) return;
		if (buffer.trim()) handleLine(buffer);
		live.settled = true;
		record.exitCode = code;
		record.endedAt = Date.now();
		record.state = code === 0 ? "done" : "failed";
		if (!record.sessionFile) record.sessionFile = findSessionFile(sessionDir) ?? null;
		try {
			fs.writeFileSync(record.resultPath, live.lastText || "(no final message)");
		} catch {
			/* ignore */
		}
		onEvent(live, "settled");
		for (const cb of live.onSettle) cb();
		live.onSettle = [];
	};

	proc.on("close", finish);
	proc.on("error", () => finish(1));

	return { proc, live };
}

function findSessionFile(dir: string, id?: string): string | undefined {
	try {
		const files = fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl") && (!id || f.includes(id)))
			.map((f) => path.join(dir, f));
		if (files.length === 0) return undefined;
		return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
	} catch {
		return undefined;
	}
}

export { CHILD_TOOL_NAMES as CHILD_TOOLS };

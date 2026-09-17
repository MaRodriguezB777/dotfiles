/**
 * BOARD.md — a projection of the registry, not a source of truth.
 *
 * Single writer (whichever process holds the registry lock), many readers.
 * Advisory only: nothing breaks if a child ignores it, because correctness
 * lives in admission control and the guard.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Registry } from "./types.ts";

function pad(s: string, n: number): string {
	return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function age(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

export function boardPath(runDir: string): string {
	return path.join(runDir, "BOARD.md");
}

/** Call inside the registry lock. */
export function writeBoard(runDir: string, reg: Registry, findingsCount: number): void {
	const now = Date.now();
	const rows = Object.values(reg.children).sort((a, b) => a.startedAt - b.startedAt);

	const lines: string[] = [];
	lines.push(`# Concurrent agents — run ${reg.runId}`);
	lines.push("");
	lines.push(`Updated ${new Date(now).toISOString().slice(11, 19)}Z · ${rows.length} agent(s)`);
	lines.push("");

	if (rows.length === 0) {
		lines.push("_No agents yet._");
	} else {
		lines.push(
			`| ${pad("child", 8)} | ${pad("agent", 10)} | ${pad("state", 8)} | ${pad("owns (write claim)", 34)} | task |`,
		);
		lines.push(`|${"-".repeat(10)}|${"-".repeat(12)}|${"-".repeat(10)}|${"-".repeat(36)}|------|`);
		for (const c of rows) {
			const owns = c.writes.length ? c.writes.join(", ") : "(read-only)";
			const state = c.state === "running" ? `running ${age(now - c.startedAt)}` : c.state;
			lines.push(
				`| ${pad(c.id, 8)} | ${pad(c.agent, 10)} | ${pad(state, 8)} | ${pad(owns, 34)} | ` +
					`${c.task.replace(/\n/g, " ").slice(0, 80)} |`,
			);
		}
	}

	lines.push("");
	lines.push(`Shared findings: \`findings.jsonl\` (${findingsCount} entries) — read with \`notes()\`.`);
	lines.push("");
	lines.push("## Rules");
	lines.push("");
	lines.push("- Write **only** inside your own claim. Writes outside it are blocked, not warned.");
	lines.push("- Need another path? `claim_paths([...], why)`. Usually granted instantly.");
	lines.push("- Finished with part of your territory? `release_paths([...])` so siblings can proceed.");
	lines.push("- Learned something a sibling would otherwise rediscover? `note(text, paths)`.");
	lines.push("- **Never** edit this file. It is regenerated automatically and your edits will vanish.");

	const tmp = `${boardPath(runDir)}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${lines.join("\n")}\n`);
	fs.renameSync(tmp, boardPath(runDir));
}

export function countLines(file: string): number {
	try {
		const raw = fs.readFileSync(file, "utf8");
		return raw.split("\n").filter((l) => l.trim()).length;
	} catch {
		return 0;
	}
}

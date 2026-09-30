/**
 * Shared fixtures for the messaging tests. Not a test file itself
 * (the runner only picks up *.test.ts).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface FakeChildOverrides {
	state?: string;
	generation?: number;
	team?: string;
	acceptingMessages?: boolean;
	pid?: number | null;
	name?: string;
}

export function tmpRun(): string {
	// Deliberately does NOT create messages/ — the module must cope with an
	// empty run directory.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-msg-"));
	writeReg(dir, { runId: "run-test", root: dir, children: {} });
	return dir;
}

export function regPath(runDir: string): string {
	return path.join(runDir, "claims.json");
}

export function readReg(runDir: string): any {
	return JSON.parse(fs.readFileSync(regPath(runDir), "utf8"));
}

export function writeReg(runDir: string, reg: any): void {
	fs.writeFileSync(regPath(runDir), JSON.stringify(reg, null, 2));
}

export function addChild(runDir: string, id: string, over: FakeChildOverrides = {}): any {
	const reg = readReg(runDir);
	reg.children[id] = {
		id,
		agent: "worker",
		task: `task for ${id}`,
		writes: [],
		reads: [],
		cwd: runDir,
		pid: process.pid,
		state: "running",
		startedAt: Date.now(),
		endedAt: null,
		sessionFile: null,
		sessionId: null,
		model: null,
		thinking: null,
		resultPath: path.join(runDir, `${id}.json`),
		exitCode: null,
		generation: 1,
		...over,
	};
	writeReg(runDir, reg);
	return reg.children[id];
}

export function patchChild(runDir: string, id: string, over: FakeChildOverrides): void {
	const reg = readReg(runDir);
	Object.assign(reg.children[id], over);
	writeReg(runDir, reg);
}

export function actor(id: string, generation = 1) {
	return { id, generation };
}

export function threadFiles(runDir: string): string[] {
	const dir = path.join(runDir, "messages");
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => f.startsWith("t-") && f.endsWith(".json"))
			.sort();
	} catch {
		return [];
	}
}

export function readThreadFile(runDir: string, threadId: string): any {
	return JSON.parse(fs.readFileSync(path.join(runDir, "messages", `${threadId}.json`), "utf8"));
}

/** Two running children on the same team, ready to talk. */
export function pair(runDir: string, team = "alpha"): { runDir: string; a: string; b: string } {
	const reg = readReg(runDir);
	reg.teams = { ...(reg.teams ?? {}), [team]: { name: team, goal: `goal of ${team}` } };
	writeReg(runDir, reg);
	addChild(runDir, "c-a", { team });
	addChild(runDir, "c-b", { team });
	return { runDir, a: "c-a", b: "c-b" };
}

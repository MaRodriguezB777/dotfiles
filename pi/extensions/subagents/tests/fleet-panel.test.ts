import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDOFF_VERSION, leave, resetForTests } from "../handoff.ts";
import { newLive } from "../spawn.ts";

// The fleet replaces the editor but widgets above it stay, so the panel plus
// the fleet overflowed the terminal and cut the fleet off. The panel steps
// aside while the fleet is open, and comes back when it closes.
test("the panel is hidden while /subagents-fleet is open, and restored after", async () => {
	resetForTests();
	const root = mkdtempSync(join(tmpdir(), "fleet-panel-"));
	const runDir = join(root, ".pi", "runs", "r1");
	mkdirSync(runDir, { recursive: true });
	const record: any = { id: "c-a", agent: "worker", task: "t", team: "none", writes: [], reads: [], cwd: root, pid: null, state: "running", startedAt: Date.now(), endedAt: null, sessionFile: null, sessionId: null, model: null, thinking: null, resultPath: join(runDir, "c-a", "result.md"), exitCode: null, generation: 1 };
	writeFileSync(join(runDir, "claims.json"), JSON.stringify({ runId: "r1", root, children: { "c-a": record } }));
	leave(
		{ version: HANDOFF_VERSION, runId: "r1", runDir, root, live: new Map([["c-a", newLive(record)]]), procs: new Map(), advisories: new Map(), stoppedByParent: [], escalationOffset: 0, pendingCompletions: [], abandon() {} },
		60_000,
	);

	const { default: extension } = await import("../index.ts");
	const hooks = new Map<string, Function[]>();
	const commands = new Map<string, any>();
	extension({ registerTool() {}, registerEntryRenderer() {}, registerCommand: (n: string, o: any) => commands.set(n, o), on: (n: string, f: Function) => hooks.set(n, [...(hooks.get(n) ?? []), f]) } as any);

	const widget: unknown[] = [];
	let closeFleet: () => void = () => {};
	const ctx = {
		cwd: root,
		mode: "tui",
		hasUI: true,
		isProjectTrusted: () => true,
		ui: {
			notify() {},
			setWidget: (key: string, value: unknown) => key === "subagents" && widget.push(value),
			custom: () => new Promise<void>((resolve) => (closeFleet = resolve)),
		},
	};
	try {
		for (const f of hooks.get("session_start") ?? []) await f({}, ctx);
		assert.equal(typeof widget.at(-1), "function", "panel mounted for the running child");

		const open = commands.get("subagents-fleet").handler("", ctx);
		await new Promise((r) => setImmediate(r));
		assert.equal(widget.at(-1), undefined, "panel hidden while the fleet is open");

		closeFleet();
		await open;
		assert.equal(typeof widget.at(-1), "function", "panel back after the fleet closes");
	} finally {
		for (const f of hooks.get("session_shutdown") ?? []) await f({}, ctx);
		resetForTests();
		rmSync(root, { recursive: true, force: true });
	}
});

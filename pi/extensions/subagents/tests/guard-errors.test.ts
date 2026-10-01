import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// pi ignores a returned `isError`; only a thrown error is reported as a failed
// tool call. Observed live: a rejected send looked like success to the model.
test("team tools throw on rejection instead of returning isError", async () => {
	const dir = mkdtempSync(join(tmpdir(), "guard-errors-"));
	const child = (id: string) => ({ id, agent: "scout", task: id, team: "t", writes: [], reads: [], cwd: dir, pid: process.pid, state: "running", startedAt: Date.now(), endedAt: null, sessionFile: null, sessionId: null, model: null, thinking: null, resultPath: join(dir, id), exitCode: null, generation: 1 });
	writeFileSync(join(dir, "claims.json"), JSON.stringify({ runId: "r", root: dir, teams: { t: { name: "t", goal: "g" } }, children: { a: child("a"), b: child("b") } }));
	Object.assign(process.env, { PI_SUBAGENT_ID: "a", PI_SUBAGENT_RUN_DIR: dir, PI_SUBAGENT_ROOT: dir, PI_SUBAGENT_TEAM: "t", PI_SUBAGENT_GENERATION: "1", PI_SUBAGENT_PARENT_PID: String(process.pid) });
	const tools = new Map<string, any>();
	try {
		const guard = (await import("../guard.ts")).default;
		guard({ registerTool: (s: any) => tools.set(s.name, s), on() {} } as any);
		await assert.rejects(tools.get("message_team").execute("x", { to: "nobody", text: "hi" }), /no such agent/);
		await assert.rejects(tools.get("team_messages").execute("x", { thread: "t-zz" }), /.+/);
		const ok = await tools.get("message_team").execute("x", { to: "b", text: "hi" });
		assert.match(ok.content[0].text, /^Sent to b \(default thread\)\./);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

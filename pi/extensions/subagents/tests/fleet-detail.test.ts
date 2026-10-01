import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildItems, collectFleet, collectTeams, handleInspectorKey, type InspectorState, readTranscript, renderInspector } from "../fleet.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const line = (role: string, content: unknown[]) =>
	JSON.stringify({ type: "message", message: { role, timestamp: new Date().toISOString(), content } }) + "\n";
const user = (text: string) => line("user", [{ type: "text", text }]);

const LONG_CMD = `cd /home/u/proj && python - <<'PY'\nimport json\nprint(json.dumps({"a": ${"1, ".repeat(60)}0}))\nPY`;

function fixture(sessionText: string) {
	const root = mkdtempSync(join(tmpdir(), "fleet-detail-"));
	const run = join(root, ".pi", "runs", "r1");
	mkdirSync(run, { recursive: true });
	const sessionFile = join(run, "c-a.jsonl");
	writeFileSync(sessionFile, sessionText);
	const rec = { id: "c-a", agent: "worker", task: "latest task only", writes: [], reads: [], cwd: root, pid: null, state: "done", startedAt: Date.now() - 60_000, endedAt: Date.now(), sessionFile, sessionId: null, model: null, thinking: null, resultPath: "", exitCode: 0, generation: 2 };
	writeFileSync(join(run, "claims.json"), JSON.stringify({ runId: "r1", root, children: { "c-a": rec } }));
	const fleet = collectFleet(root, "r1");
	const teams = collectTeams(root, "r1", fleet);
	const st: InspectorState = { fleet, teams, collapsed: new Set(), items: buildItems(fleet, teams, new Set()), selected: 0, scroll: 0, maxScroll: 0, autoFollow: false, expandedTools: false, rows: 400 };
	st.selected = st.items.findIndex((i) => i.kind === "agent");
	return { root, sessionFile, st, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function session() {
	return (
		user("Initial task: build the JEPA pretraining loop.\nUse fox_v2 until fox_full is ready.") +
		line("assistant", [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: LONG_CMD } }]) +
		line("toolResult", [{ type: "text", text: "ok" }]).replace('"role":"toolResult"', '"role":"toolResult","toolCallId":"t1","toolName":"bash"') +
		line("assistant", [{ type: "text", text: "Loop built." }]) +
		user("Follow-up: switch to fox_full and rerun the benchmark.") +
		line("assistant", [{ type: "text", text: "Rerunning." }])
	);
}

test("the agent detail lists every task given to it: the initial one and each follow-up, in full", () => {
	const f = fixture(session());
	try {
		const text = renderInspector(f.st, readTranscript(f.sessionFile), 120, theme).lines.join("\n");
		assert.match(text, /Tasks · 2/);
		assert.match(text, /Initial task[\s\S]*build the JEPA pretraining loop\.[\s\S]*Use fox_v2 until fox_full is ready\./);
		assert.match(text, /Follow-up 1[\s\S]*switch to fox_full and rerun the benchmark\./);
		assert.ok(text.indexOf("Initial task") < text.indexOf("Follow-up 1"));
	} finally {
		f.cleanup();
	}
});

test("x shows the whole tool call, wrapped, instead of cutting it with …", () => {
	const f = fixture(session());
	try {
		const evs = readTranscript(f.sessionFile);
		const collapsed = renderInspector(f.st, evs, 90, theme).lines.join("\n");
		assert.ok(!collapsed.includes("0}))"), "collapsed: the end of the command is cut");
		handleInspectorKey(f.st, "x", 10);
		const lines = renderInspector(f.st, evs, 90, theme).lines;
		const expanded = lines.join("\n");
		for (const piece of ["python - <<'PY'", "import json", "0}))", "PY"]) assert.ok(expanded.includes(piece), piece);
		for (const l of lines) assert.ok(visibleWidth(l) <= 90, l);
	} finally {
		f.cleanup();
	}
});

test("non-bash tool calls expand to every argument", () => {
	const f = fixture(
		user("t") +
			line("assistant", [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "src/a.ts", oldText: "const a = 1;", newText: "const a = 2;\nconst b = 3;" } }]),
	);
	try {
		handleInspectorKey(f.st, "x", 10);
		const text = renderInspector(f.st, readTranscript(f.sessionFile), 100, theme).lines.join("\n");
		assert.match(text, /oldText: const a = 1;/);
		assert.match(text, /newText: const a = 2;/);
		assert.match(text, /const b = 3;/);
	} finally {
		f.cleanup();
	}
});

test("a half-written last line is read once it is complete, not skipped", () => {
	const half = user("second task arrives in two writes");
	const f = fixture(user("first task"));
	try {
		appendFileSync(f.sessionFile, half.slice(0, 20)); // child mid-write
		collectFleet(f.root, "r1");
		appendFileSync(f.sessionFile, half.slice(20));
		const fleet = collectFleet(f.root, "r1");
		assert.equal(fleet[0].tasks.length, 2);
		assert.equal(fleet[0].tasks[1], "second task arrives in two writes");
	} finally {
		f.cleanup();
	}
});

test("g jumps to the task list at the top, G back to the live bottom", () => {
	const f = fixture(session());
	try {
		f.st.autoFollow = true;
		f.st.maxScroll = 30;
		handleInspectorKey(f.st, "g", 10);
		assert.equal(f.st.scroll, 0);
		assert.equal(f.st.autoFollow, false);
		handleInspectorKey(f.st, "G", 10);
		assert.equal(f.st.autoFollow, true);
	} finally {
		f.cleanup();
	}
});

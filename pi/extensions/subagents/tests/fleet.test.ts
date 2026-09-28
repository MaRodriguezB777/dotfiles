import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildItems,
	collectFleet,
	collectTeams,
	handleInspectorKey,
	type InspectorState,
	renderInspector,
	renderPlain,
} from "../fleet.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function child(dir: string, id: string, team?: string, state = "done") {
	return { id, agent: "scout", task: `task of ${id}`, team, writes: [], reads: [], cwd: dir, pid: null, state, startedAt: Date.now() - 60_000, endedAt: Date.now(), sessionFile: null, sessionId: null, model: null, thinking: null, resultPath: "", exitCode: 0, generation: 1 };
}
function assistant(model: string, cost: number, input: number, output: number, cacheRead: number, cacheWrite = 0) {
	return JSON.stringify({ type: "message", message: { role: "assistant", provider: "anthropic", model, timestamp: new Date().toISOString(), content: [{ type: "toolCall", id: "x", name: "read", arguments: {} }], usage: { input, output, cacheRead, cacheWrite, cost: { total: cost } } } });
}
function msg(id: string, from: string, to: string, text: string, extra: any = {}) {
	return { id, seq: 0, from: { id: from, generation: 1 }, to: { id: to, generation: 1 }, at: Date.now() - 5_000, text, needs_reply: false, reply_to: null, inbound: { state: "delivered", at: 1, reason: null }, read: { ranges: [], full: true, at: 1, session: null }, ...extra };
}

/** One run: team "audio" with a/b talking, team "ui" with c alone, d with no team. */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "fleet-"));
	const run = join(root, ".pi", "runs", "r1");
	mkdirSync(join(run, "messages"), { recursive: true });
	writeFileSync(
		join(run, "claims.json"),
		JSON.stringify({
			runId: "r1",
			root,
			teams: { audio: { name: "audio", goal: "Map the audio pipeline end to end." }, ui: { name: "ui", goal: "Polish menus." } },
			children: { "c-a": child(run, "c-a", "audio"), "c-b": child(run, "c-b", "audio"), "c-c": child(run, "c-c", "ui"), "c-d": child(run, "c-d") },
		}),
	);
	const session = (id: string, lines: string[]) => {
		const f = join(run, `${id}.jsonl`);
		writeFileSync(f, lines.join("\n") + "\n");
		return f;
	};
	const reg = JSON.parse(readFileSync(join(run, "claims.json"), "utf8"));
	reg.children["c-a"].sessionFile = session("c-a", [assistant("claude-haiku-4-5", 0.1, 1000, 200, 3000), assistant("claude-haiku-4-5", 0.05, 500, 100, 4000, 200)]);
	reg.children["c-b"].sessionFile = session("c-b", [assistant("claude-sonnet-4-5", 0.25, 2000, 300, 0, 1000)]);
	reg.children["c-b"].model = "anthropic/claude-sonnet-4-5";
	writeFileSync(join(run, "claims.json"), JSON.stringify(reg));
	const thread = (id: string, messages: any[]) =>
		writeFileSync(join(run, "messages", `${id}.json`), JSON.stringify({ version: 1, id, team: "audio", participants: [{ id: "c-a", generation: 1 }, { id: "c-b", generation: 1 }], createdAt: 1, messages }));
	thread("t-01", [msg("m-1", "c-a", "c-b", "x".repeat(300)), msg("m-2", "c-b", "c-a", "y".repeat(700))]);
	thread("t-02", [msg("m-3", "c-b", "c-a", "z".repeat(50), { read: { ranges: [], full: false, at: null, session: null } })]);
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function state(root: string): InspectorState {
	const fleet = collectFleet(root, "r1");
	const teams = collectTeams(root, "r1", fleet);
	return { fleet, teams, collapsed: new Set(), items: buildItems(fleet, teams, new Set()), selected: 0, scroll: 0, maxScroll: 0, autoFollow: true, expandedTools: false, rows: 40 };
}

test("roster groups agents under their team, with a no-team group", () => {
	const { root, cleanup } = fixture();
	try {
		const st = state(root);
		const shape = st.items.map((i) => (i.kind === "team" ? `T:${i.team.name}` : `A:${i.view.record.id}`));
		// Every agent appears exactly once, directly after its own team header.
		for (const [team, members] of [["audio", ["c-a", "c-b"]], ["ui", ["c-c"]], ["none", ["c-d"]]] as const) {
			const h = shape.indexOf(`T:${team}`);
			assert.ok(h >= 0, `header for ${team}`);
			assert.deepEqual(shape.slice(h + 1, h + 1 + members.length).sort(), members.map((m) => `A:${m}`));
		}
		assert.equal(shape.filter((s) => s.startsWith("A:")).length, 4);
	} finally {
		cleanup();
	}
});

test("selecting a team shows goal, threads between which agents, message count and chars", () => {
	const { root, cleanup } = fixture();
	try {
		const st = state(root);
		st.selected = st.items.findIndex((i) => i.kind === "team" && i.team.name === "audio");
		const text = renderInspector(st, [], 160, theme).lines.join("\n");
		assert.match(text, /Map the audio pipeline end to end\./);
		assert.match(text, /c-a ↔ c-b/);
		assert.match(text, /2 threads · 3 msgs · 1,050 chars/);
		assert.match(text, /t-01.*2 msgs · 1,000 chars/);
		assert.match(text, /t-02.*1 msg · 50 chars · 1 unread/);
		assert.match(text, /c-a · scout[^\n]*\n[^\n]*task of c-a/);
	} finally {
		cleanup();
	}
});

test("selecting an agent shows its own thread summary", () => {
	const { root, cleanup } = fixture();
	try {
		const st = state(root);
		st.selected = st.items.findIndex((i) => i.kind === "agent" && i.view.record.id === "c-a");
		const text = renderInspector(st, [], 160, theme).lines.join("\n");
		assert.match(text, /Messages.*2 threads · 3 msgs · 1,050 chars/);
		assert.match(text, /↔ c-b · t-01 · 2 msgs \(1↑ 1↓\) · 1,000 chars/);
		st.selected = st.items.findIndex((i) => i.kind === "agent" && i.view.record.id === "c-d");
		assert.doesNotMatch(renderInspector(st, [], 160, theme).lines.join("\n"), /Messages/);
	} finally {
		cleanup();
	}
});

test("every rendered line fits the terminal at every width", () => {
	const { root, cleanup } = fixture();
	try {
		const st = state(root);
		for (let sel = 0; sel < st.items.length; sel++) {
			st.selected = sel;
			for (let w = 36; w <= 200; w += 7) {
				for (const line of renderInspector(st, [], w, theme).lines) assert.ok(visibleWidth(line) <= w, `w=${w} sel=${sel}: ${line}`);
			}
		}
	} finally {
		cleanup();
	}
});

test("Shift+J/K scroll the detail pane starting from the followed bottom", () => {
	const st = { items: [{}, {}], selected: 0, scroll: 0, maxScroll: 30, autoFollow: true } as any;
	assert.equal(handleInspectorKey(st, "K", 10).kind, "handled");
	assert.equal(st.autoFollow, false);
	assert.equal(st.scroll, 27, "scrolls up from the bottom being shown, not from the top");
	handleInspectorKey(st, "K", 10);
	assert.equal(st.scroll, 24);
	handleInspectorKey(st, "J", 10);
	handleInspectorKey(st, "J", 10);
	assert.equal(st.scroll, 30);
	assert.equal(st.autoFollow, true, "reaching the bottom resumes following");
	assert.equal(st.selected, 0, "scrolling never changes the selected agent");
	handleInspectorKey(st, "\x1b[5~", 10);
	assert.equal(st.scroll, 20);
	assert.equal(handleInspectorKey(st, "j", 10).kind, "moved");
	assert.equal(st.selected, 1);
	assert.equal(handleInspectorKey(st, "q", 10).kind, "close");
});

test("plain output groups by team too", () => {
	const { root, cleanup } = fixture();
	try {
		const st = state(root);
		const text = renderPlain(st.items);
		assert.match(text, /audio.*3 msgs/);
		assert.ok(text.indexOf("c-a") > text.indexOf("audio"));
	} finally {
		cleanup();
	}
});

test("team summary aggregates cost overall but reports tokens per model", () => {
	const { root, cleanup } = fixture();
	try {
		const st = state(root);
		st.selected = st.items.findIndex((i) => i.kind === "team" && i.team.name === "audio");
		const text = renderInspector(st, [], 200, theme).lines.join("\n");
		// Overall line: cost and activity, deliberately no token total.
		assert.match(text, /\$0\.400 · 3 turns · 3 tools/);
		assert.doesNotMatch(text, /\$0\.400 · [^\n]*tok/, "no cross-model token total");
		// haiku (c-a): 1,500 in · 300 out · 7,000 read · 200 write = 9.0k; cached 7000/8700
		assert.match(text, /anthropic\/claude-haiku-4-5 ×1 · \$0\.150 · 9\.0k tok \(1\.5k in · 300 out · 7\.0k cache read · 200 cache write · 80% cached\)/);
		// sonnet (c-b): 2,000 in · 300 out · 0 read · 1,000 write = 3.3k; cached 0/3000
		assert.match(text, /anthropic\/claude-sonnet-4-5 ×1 · \$0\.250 · 3\.3k tok \(2\.0k in · 300 out · 0 cache read · 1\.0k cache write · 0% cached\)/);
		// Costliest model first.
		assert.ok(text.indexOf("claude-sonnet-4-5 ×1") < text.indexOf("claude-haiku-4-5 ×1"));
		// Each member row carries its own cost and model.
		assert.match(text, /c-a · scout · done[^\n]*\$0\.150[^\n]*claude-haiku-4-5/);
	} finally {
		cleanup();
	}
});

test("agent header separates lifetime tokens from peak context", () => {
	const { root, cleanup } = fixture();
	try {
		const st = state(root);
		st.selected = st.items.findIndex((i) => i.kind === "agent" && i.view.record.id === "c-a");
		const text = renderInspector(st, [], 180, theme).lines.join("\n");
		assert.match(text, /9\.0k tok/); // 1500 in + 300 out + 7000 read + 200 write
		assert.match(text, /ctx 4\.8k/); // largest single request: 500 + 100 + 4000 + 200
	} finally {
		cleanup();
	}
});

test("Enter and h/l collapse and expand teams; h on an agent jumps to its team", () => {
	const { root, cleanup } = fixture();
	try {
		const st = state(root);
		const audio = () => st.items.findIndex((i) => i.kind === "team" && i.team.name === "audio");
		const members = () => st.items.filter((i) => i.kind === "agent" && i.team.name === "audio").length;
		st.selected = audio();
		assert.equal(members(), 2);
		assert.equal(handleInspectorKey(st, "\r", 10).kind, "moved");
		assert.equal(members(), 0, "Enter collapses");
		assert.equal(st.selected, audio(), "selection stays on the header");
		assert.match(renderInspector(st, [], 120, theme).lines.join("\n"), /▸ audio/);
		handleInspectorKey(st, "\r", 10);
		assert.equal(members(), 2, "Enter again expands");
		handleInspectorKey(st, "h", 10);
		assert.equal(members(), 0, "h collapses");
		handleInspectorKey(st, "h", 10);
		assert.equal(members(), 0, "h is idempotent");
		handleInspectorKey(st, "l", 10);
		assert.equal(members(), 2, "l expands");
		handleInspectorKey(st, "l", 10);
		assert.equal(members(), 2, "l is idempotent");
		// On an agent row, h moves to the team header rather than collapsing blindly.
		st.selected = audio() + 2;
		handleInspectorKey(st, "h", 10);
		assert.equal(st.selected, audio());
		assert.equal(members(), 2);
		// Collapsed state survives a rebuild from fresh data.
		handleInspectorKey(st, "h", 10);
		st.items = buildItems(st.fleet, st.teams, st.collapsed);
		assert.equal(members(), 0);
	} finally {
		cleanup();
	}
});

test("a team summary opens at its top even when it overflows, and J scrolls it", () => {
	const { root, cleanup } = fixture();
	try {
		const st = state(root);
		st.rows = 14; // tiny terminal: the team detail cannot fit
		st.selected = 1; // an agent row
		handleInspectorKey(st, "k", 5); // move onto the audio header, as a user would
		assert.equal(st.items[st.selected].kind, "team");
		let r = renderInspector(st, [], 120, theme);
		st.maxScroll = r.maxScroll;
		assert.ok(r.maxScroll > 0, "fixture must overflow for this test to mean anything");
		assert.equal(r.scroll, 0, "opens at the top");
		assert.match(r.lines.join("\n"), /\$0\.400 · 3 turns/, "first thing shown is the usage summary");
		handleInspectorKey(st, "J", r.viewport);
		r = renderInspector(st, [], 120, theme);
		assert.equal(r.scroll, 3);
		// Everything, including the last thread, is reachable by scrolling.
		for (let i = 0; i < 20; i++) handleInspectorKey(st, "J", r.viewport);
		r = renderInspector(st, [], 120, theme);
		assert.equal(r.scroll, r.maxScroll);
		assert.match(r.lines.join("\n"), /t-02/);
	} finally {
		cleanup();
	}
});

test("tokens are attributed per message model, and large counts use M", () => {
	const { root, cleanup } = fixture();
	try {
		// c-a was followed up on sonnet: its later usage belongs to sonnet, not haiku.
		const run = join(root, ".pi", "runs", "r1");
		writeFileSync(join(run, "c-a.jsonl"), readFileSync(join(run, "c-a.jsonl"), "utf8") + assistant("claude-sonnet-4-5", 1, 2_000_000, 0, 0) + "\n");
		// And a record whose model field carries a thinking suffix must not create a separate row.
		const reg = JSON.parse(readFileSync(join(run, "claims.json"), "utf8"));
		reg.children["c-b"].model = "anthropic/claude-sonnet-4-5:xhigh";
		writeFileSync(join(run, "claims.json"), JSON.stringify(reg));
		const st = state(root);
		st.selected = st.items.findIndex((i) => i.kind === "team" && i.team.name === "audio");
		const text = renderInspector(st, [], 220, theme).lines.join("\n");
		// sonnet: c-b (2,000 in · 300 out · 1,000 write) + c-a's follow-up (2,000,000 in) = 2,003,300
		assert.match(text, /anthropic\/claude-sonnet-4-5 ×2 · \$1\.250 · 2\.0M tok \(2\.0M in · 300 out/);
		assert.match(text, /anthropic\/claude-haiku-4-5 ×1 · \$0\.150 · 9\.0k tok/);
		assert.doesNotMatch(text, /:xhigh/);
	} finally {
		cleanup();
	}
});

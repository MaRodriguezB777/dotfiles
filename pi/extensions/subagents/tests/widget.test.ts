import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type PanelChild, SPINNER, briefOwns, panelLines } from "../widget.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const NOW = 10 * 60_000;

let seq = 0;
function child(over: Partial<PanelChild> = {}): PanelChild {
	seq++;
	return {
		id: `c-${String(seq).padStart(4, "0")}`,
		agent: "worker",
		team: "none",
		state: "running",
		writes: [],
		startedAt: NOW - 72_000,
		endedAt: null,
		toolCount: 3,
		cost: 0.1,
		begun: true,
		...over,
	};
}
const render = (children: PanelChild[], width = 120, now = NOW) =>
	panelLines({ children, spent: children.reduce((s, c) => s + c.cost, 0), now }, width, theme);

test("owns shows the first path and a count, never the whole list", () => {
	assert.equal(briefOwns([]), "read-only");
	assert.equal(briefOwns(["scripts/world/**"]), "owns scripts/world/**");
	assert.equal(briefOwns(["scripts/world/**", "tests/a/**", "NOTES.md"]), "owns scripts/world/** +2");
});

test("header carries a spinner while anything runs, and the counts", () => {
	const lines = render([child(), child({ state: "done", endedAt: NOW - 1000 })], 120, 0);
	assert.equal(lines[0], `${SPINNER[0]} Subagents · 1 running · 1 done · $0.20`);
	// The frame advances with time, so the panel visibly spins.
	assert.ok(render([child()], 120, 80)[0].startsWith(SPINNER[1]));
	// Nothing running: a check mark instead of a spinner.
	assert.ok(render([child({ state: "done", endedAt: NOW })])[0].startsWith("✓ Subagents · 0 running · 1 done"));
});

test("without teams the agents form one flat tree, with each running agent's activity under it", () => {
	const a = child({ id: "c-a", activity: "bash npm test" });
	const b = child({ id: "c-b" }); // no tool running: the model is thinking
	const c = child({ id: "c-c", state: "done", endedAt: NOW - 5000, toolCount: 1 });
	const body = render([a, b, c]).slice(1);
	assert.deepEqual(body, [
		`├─ ${SPINNER[0]} c-a worker · 3 tools · 1m 12s`,
		"│  └ bash npm test",
		`├─ ${SPINNER[0]} c-b worker · 3 tools · 1m 12s`,
		"│  └ thinking…",
		"└─ ✓ c-c worker · 1 tool · 1m 07s",
	]);
});

test("finished, failed and stopped agents get distinct marks; running ones come first", () => {
	const body = render([
		child({ id: "c-done", state: "done", endedAt: NOW }),
		child({ id: "c-fail", state: "failed", endedAt: NOW }),
		child({ id: "c-kill", state: "killed", endedAt: NOW }),
		child({ id: "c-run" }),
	]).slice(1);
	assert.match(body[0], /c-run/);
	assert.ok(body.some((l) => /✗ c-fail/.test(l)));
	assert.ok(body.some((l) => /■ c-kill/.test(l)));
	assert.ok(body.some((l) => /✓ c-done/.test(l)));
});

test("teams group their members, each team shows +X more, and the panel +Y more teams", () => {
	const kids = [
		...Array.from({ length: 5 }, (_, i) => child({ id: `c-a${i}`, team: "audio", activity: "read x" })),
		child({ id: "c-b0", team: "ui", state: "done", endedAt: NOW }),
		child({ id: "c-c0", team: "world" }),
		child({ id: "c-c1", team: "world" }),
		child({ id: "c-x0", team: "x" }),
		child({ id: "c-y0", team: "y" }),
		child({ id: "c-n0" }), // no team
	];
	const lines = render(kids);
	const text = lines.join("\n");
	// The busiest team is listed first, with its own counts.
	assert.equal(lines[1], "├─ audio  5 running");
	assert.match(text, /│  ├─ .* c-a0 worker/);
	// Members beyond the per-team limit are counted, not listed.
	assert.match(text, /│  └─ \+\d more/);
	assert.ok(!text.includes("c-a4"), "fifth member is folded into +X more");
	// Teams that do not fit are counted on the last line, with how many agents they hold.
	assert.match(lines.at(-1)!, /^└─ \+\d more teams? \(\d agents?\)$/);
	// The panel stays a glance: bounded however many children there are.
	assert.ok(lines.length <= 14, `${lines.length} lines`);
});

test("everything fits: no overflow lines, and the last team closes the tree", () => {
	const lines = render([child({ id: "c-a", team: "audio", activity: "bash ls" }), child({ id: "c-z", state: "done", endedAt: NOW })]);
	assert.deepEqual(lines.slice(1), [
		"├─ audio  1 running",
		`│  └─ ${SPINNER[0]} c-a worker · 3 tools · 1m 12s`,
		"│     └ bash ls",
		"└─ no team  1 done",
		"   └─ ✓ c-z worker · 3 tools · 1m 12s",
	]);
});

test("rows drop detail before they are cut, and never exceed the width", () => {
	const wide = child({ id: "c-a", writes: ["scripts/layers/depression/**", "a", "b"], advisory: "no activity for 94s" });
	assert.match(render([wide], 160)[1], /owns scripts\/layers\/depression\/\*\* \+2/);
	assert.match(render([wide], 160)[2], /⚠ no activity for 94s/);
	const kids = [
		wide,
		child({ team: "a-very-long-team-name-that-goes-on", activity: "bash " + "x".repeat(300) }),
		child({ state: "failed", endedAt: NOW, team: "z" }),
	];
	for (let w = 24; w <= 160; w += 4) {
		for (const line of render(kids, w)) assert.ok(visibleWidth(line) <= w, `w=${w}: ${line}`);
	}
	// Just above the compact threshold the row keeps id and agent, losing owns first.
	const row = render([wide], 66)[1];
	assert.match(row, /c-a worker/);
	assert.doesNotMatch(row, /owns/);
});

test("before its first turn an agent shows starting…, not thinking…", () => {
	const body = render([child({ id: "c-new", begun: false, toolCount: 0 })]).slice(1);
	assert.deepEqual(body, [`└─ ${SPINNER[0]} c-new worker · 0 tools · 1m 12s`, "   └ starting…"]);
});

// ---- children adopted across /reload ---------------------------------------------
// They keep the event handler of the code that launched them, which never sets
// begun/activity/toolCount. Observed live: 9h-old agents stuck on "starting…".

test("an adopted child with no live activity tracking shows its last tool, not starting…", () => {
	const old = child({ id: "c-old", begun: undefined, toolCount: undefined, lastTool: { text: "bash cd /x && pytest", at: NOW - 95_000 } });
	const body = render([old]).slice(1);
	assert.equal(body[0], `└─ ${SPINNER[0]} c-old worker · 1m 12s`, "no misleading tool count");
	assert.equal(body[1], "   └ last: bash cd /x && pytest · 1m 35s ago");
});

// ---- small terminals: teams only ---------------------------------------------------

test("a short terminal shows one line per team: agents, cost, time alive", () => {
	const kids = [
		child({ id: "c-a", team: "jepa", cost: 10, startedAt: NOW - 3_600_000 }),
		child({ id: "c-b", team: "jepa", cost: 5.5, state: "done", startedAt: NOW - 600_000, endedAt: NOW - 60_000 }),
		child({ id: "c-c", team: "ssm", cost: 2, state: "done", startedAt: NOW - 120_000, endedAt: NOW - 30_000 }),
		child({ id: "c-n", cost: 1 }),
	];
	const lines = panelLines({ children: kids, spent: 18.5, now: NOW }, 120, theme, 20);
	assert.deepEqual(lines, [
		`${SPINNER[0]} Subagents · 2 running · 2 done · $18.50`,
		`├─ ${SPINNER[0]} jepa  2 agents · $15.50 · 1h 00m`,
		"├─ ✓ ssm  1 agent · $2.00 · 1m 30s",
		`└─ ${SPINNER[0]} no team  1 agent · $1.00 · 1m 12s`,
	]);
});

test("a narrow terminal is compact too, and many teams overflow into +N more teams", () => {
	const kids = Array.from({ length: 9 }, (_, i) => child({ id: `c-${i}`, team: `t${i}` }));
	const lines = panelLines({ children: kids, spent: 0.9, now: NOW }, 50, theme, 60);
	assert.ok(lines.length <= 7, `${lines.length}`);
	assert.match(lines.at(-1)!, /^└─ \+\d more teams \(\d agents\)$/);
	for (const l of lines) assert.ok(visibleWidth(l) <= 50, l);
	assert.ok(!lines.some((l) => /c-\d/.test(l)), "no agent rows in compact mode");
});

test("a roomy terminal keeps the full tree", () => {
	const lines = panelLines({ children: [child({ id: "c-a", team: "jepa" })], spent: 0.1, now: NOW }, 120, theme, 60);
	assert.ok(lines.some((l) => /c-a/.test(l)));
});

// ---- fair layout across teams ------------------------------------------------------
// Observed live: jepa showed 3 members with activity, ssm only its header and
// one member, the no-team group nothing.

const memberRows = (lines: string[], team: string) => {
	const start = lines.findIndex((l) => new RegExp(`^[├└]─ ${team}\\b`).test(l));
	let n = 0;
	for (let i = start + 1; i < lines.length && /^[│ ] /.test(lines[i]); i++) if (/[├└]─ \S+ c-/.test(lines[i])) n++;
	return n;
};

test("every shown team gets the same number of members", () => {
	const kids = [
		...Array.from({ length: 4 }, (_, i) => child({ id: `c-j${i}`, team: "jepa", activity: "bash x" })),
		...Array.from({ length: 4 }, (_, i) => child({ id: `c-s${i}`, team: "ssm", activity: "bash y" })),
		...Array.from({ length: 3 }, (_, i) => child({ id: `c-n${i}`, state: "done", endedAt: NOW - i })),
	];
	const lines = render(kids);
	assert.equal(memberRows(lines, "jepa"), memberRows(lines, "ssm"));
	assert.equal(memberRows(lines, "jepa"), memberRows(lines, "no team"));
	assert.ok(memberRows(lines, "jepa") >= 1);
	assert.ok(lines.length <= 14, `${lines.length}`);
});

test("small teams are shown in full while big ones are capped evenly", () => {
	const kids = [
		...Array.from({ length: 2 }, (_, i) => child({ id: `c-a${i}`, team: "a", state: "done", endedAt: NOW })),
		...Array.from({ length: 2 }, (_, i) => child({ id: `c-b${i}`, team: "b", state: "done", endedAt: NOW })),
	];
	const lines = render(kids);
	assert.equal(memberRows(lines, "a"), 2);
	assert.equal(memberRows(lines, "b"), 2);
	assert.ok(!lines.some((l) => /more/.test(l)));
});

test("teams that do not fit even one member are counted in +N more teams", () => {
	const kids = Array.from({ length: 8 }, (_, i) => child({ id: `c-${i}`, team: `t${i}`, activity: "bash z" }));
	const lines = render(kids);
	const shown = lines.filter((l) => /^[├└]─ t\d/.test(l)).length;
	assert.ok(shown >= 2 && shown < 8, `${shown}`);
	assert.match(lines.at(-1)!, new RegExp(`^└─ \\+${8 - shown} more teams \\(${8 - shown} agents\\)$`));
	assert.ok(lines.length <= 14);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { WIDGET_ROWS, briefOwns, widgetLines } from "../widget.ts";

const child = (id: string, writes: string[], startedAt: number, tool?: string) => ({
	id,
	agent: "worker",
	writes,
	startedAt,
	tool,
	advisory: undefined as string | undefined,
});

test("owns shows the first path and a count, never the whole list", () => {
	assert.equal(briefOwns([]), "read-only");
	assert.equal(briefOwns(["scripts/world/**"]), "owns scripts/world/**");
	assert.equal(briefOwns(["scripts/world/**", "tests/a/**", "NOTES.md"]), "owns scripts/world/** +2");
	// A single very long path is cut, not wrapped over lines.
	const long = briefOwns(["screenshots/user/videos/depression/deeply/nested/folder/**"]);
	assert.ok(long.length <= 40, long);
	assert.match(long, /…$/);
});

test("header, a few rows, then how many more", () => {
	const now = 1_000_000;
	const running = Array.from({ length: 6 }, (_, i) =>
		child(`c-${i}`, ["scripts/layers/x/**", "assets/x/**", "tests/x/**"], now - (600 - i * 60) * 1000, "bash"),
	);
	const lines = widgetLines({ running, done: 7, spent: 95.132, now });
	assert.equal(lines[0], "subagents: 6 active · 7 done · $95.132 spent");
	const rows = lines.slice(1, -1);
	assert.equal(rows.length, WIDGET_ROWS);
	assert.ok(WIDGET_ROWS <= 3, "only the first couple");
	assert.equal(lines.at(-1), `  +${6 - WIDGET_ROWS} more — /subagents for all`);
	assert.match(rows[0], /c-0\s+worker\s+10m\s+owns scripts\/layers\/x\/\*\* \+2 · bash/);
	for (const l of lines) assert.ok(l.length <= 80, `fits one line: ${l}`);
});

test("no overflow line when everything fits", () => {
	const lines = widgetLines({ running: [child("c-a", [], 0)], done: 0, spent: 0, now: 5000 });
	assert.deepEqual(lines, ["subagents: 1 active · $0.000 spent", "  c-a  worker     5s  read-only"]);
});

test("an advisory still shows, trimmed to keep the row on one line", () => {
	const c = child("c-a", ["src/**"], 0, "bash");
	c.advisory = "no activity for 94s, and a very long explanation that goes on and on and on";
	const [, row] = widgetLines({ running: [c], done: 0, spent: 0, now: 1000 });
	assert.match(row, /⚠ no activity for 94s/);
	assert.ok(row.length <= 80, row);
});

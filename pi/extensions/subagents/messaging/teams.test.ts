import assert from "node:assert/strict";
import { test } from "node:test";
import { defineTeam, validateTeam } from "./index.ts";
import { addChild, readReg, tmpRun } from "./test-helpers.ts";

test("defineTeam persists a team into the registry", () => {
	const run = tmpRun();
	const t = defineTeam(run, "alpha", "ship the parser");
	assert.deepEqual(t, { name: "alpha", goal: "ship the parser" });
	assert.deepEqual(readReg(run).teams.alpha, { name: "alpha", goal: "ship the parser" });
});

test("defineTeam is idempotent for the same goal", () => {
	const run = tmpRun();
	defineTeam(run, "alpha", "ship the parser");
	const again = defineTeam(run, "alpha", "ship the parser");
	assert.equal(again.goal, "ship the parser");
});

test("defineTeam may change the goal while the team has no members", () => {
	const run = tmpRun();
	defineTeam(run, "alpha", "first goal");
	const t = defineTeam(run, "alpha", "second goal");
	assert.equal(t.goal, "second goal");
	assert.equal(readReg(run).teams.alpha.goal, "second goal");
});

test("defineTeam refuses to change the goal once members are assigned", () => {
	const run = tmpRun();
	defineTeam(run, "alpha", "first goal");
	addChild(run, "c-1", { team: "alpha" });
	assert.throws(() => defineTeam(run, "alpha", "second goal"), /member|immutable/i);
	// idempotent redefinition still fine
	assert.equal(defineTeam(run, "alpha", "first goal").goal, "first goal");
});

test("defineTeam rejects reserved and malformed names", () => {
	const run = tmpRun();
	for (const bad of ["none", "None", "all", "", "   ", "../escape", "a/b", "x".repeat(40)]) {
		assert.throws(() => defineTeam(run, bad, "g"), /team/i, `expected reject: ${JSON.stringify(bad)}`);
	}
});

test("defineTeam rejects an empty goal", () => {
	const run = tmpRun();
	assert.throws(() => defineTeam(run, "alpha", "  "), /goal/i);
});

test("validateTeam defaults to none and accepts none explicitly", () => {
	const reg = { runId: "r", root: "/", children: {} } as any;
	assert.equal(validateTeam(reg), "none");
	assert.equal(validateTeam(reg, undefined), "none");
	assert.equal(validateTeam(reg, "none"), "none");
});

test("validateTeam throws for unknown teams and accepts defined ones", () => {
	const reg = { runId: "r", root: "/", children: {}, teams: { alpha: { name: "alpha", goal: "g" } } } as any;
	assert.equal(validateTeam(reg, "alpha"), "alpha");
	assert.throws(() => validateTeam(reg, "ghost"), /unknown team/i);
	assert.throws(() => validateTeam(reg, "all"), /reserved|invalid/i);
	assert.throws(() => validateTeam(reg, "../x"), /invalid/i);
});

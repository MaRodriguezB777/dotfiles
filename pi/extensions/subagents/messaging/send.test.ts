import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { sendMessage } from "./index.ts";
import {
	actor,
	addChild,
	pair,
	patchChild,
	readReg,
	readThreadFile,
	threadFiles,
	tmpRun,
	writeReg,
} from "./test-helpers.ts";

test("sendMessage creates a thread and stores original generations", () => {
	const { runDir } = pair(tmpRun());
	const res = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "hello there" });
	assert.match(res.message_id, /^m-[a-z0-9]+$/);
	assert.match(res.thread_id, /^t-[a-z0-9]+$/);

	const th = readThreadFile(runDir, res.thread_id);
	assert.equal(th.team, "alpha");
	assert.equal(th.messages.length, 1);
	const m = th.messages[0];
	assert.deepEqual(m.from, { id: "c-a", generation: 1 });
	assert.deepEqual(m.to, { id: "c-b", generation: 1 });
	assert.equal(m.text, "hello there");
	assert.equal(m.inbound.state, "queued");
	assert.equal(m.read.full, false);
});

test("sendMessage records the generation current at send time, not later", () => {
	const { runDir } = pair(tmpRun());
	patchChild(runDir, "c-b", { generation: 3 });
	const res = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "hi" });
	const m = readThreadFile(runDir, res.thread_id).messages[0];
	assert.equal(m.to.generation, 3);
	patchChild(runDir, "c-b", { generation: 4 });
	assert.equal(readThreadFile(runDir, res.thread_id).messages[0].to.generation, 3);
});

// Thread selection (default, named, unknown, duplicate) is covered in threads.test.ts.

test("sendMessage rejects traversal-shaped thread references", () => {
	const { runDir } = pair(tmpRun());
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "x", thread: "../../etc/passwd" }), /no thread/);
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "x", new_thread: "../../etc" }), /thread name/i);
});

test("sendMessage rejects a sender that is not running or is a stale generation", () => {
	const { runDir } = pair(tmpRun());
	assert.throws(() => sendMessage(runDir, actor("c-a", 2), { to: "c-b", text: "x" }), /generation/i);
	patchChild(runDir, "c-a", { state: "done" });
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "x" }), /not running|sender/i);
	assert.throws(() => sendMessage(runDir, actor("c-ghost", 1), { to: "c-b", text: "x" }), /sender/i);
});

test("sendMessage rejects a recipient that is gone, closed, unknown, or self", () => {
	const { runDir } = pair(tmpRun());
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-a", text: "x" }), /yourself|self/i);
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-ghost", text: "x" }), /no (such )?agent|unknown/i);

	patchChild(runDir, "c-b", { acceptingMessages: false });
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "x" }), /Not delivered: c-b has finished\. Only the parent can resume it\./);

	patchChild(runDir, "c-b", { acceptingMessages: true, state: "done" });
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "x" }), /Not delivered: c-b has finished\. Only the parent can resume it\./);

	patchChild(runDir, "c-b", { acceptingMessages: true, state: "failed" });
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "x" }), /Not delivered: c-b failed\. Only the parent can resume it\./);
});

test("sendMessage rejects team none and cross-team sends", () => {
	const run = tmpRun();
	const { runDir } = pair(run);
	const reg = readReg(run);
	reg.teams.beta = { name: "beta", goal: "other" };
	writeReg(run, reg);
	addChild(run, "c-solo"); // legacy record: no team field at all
	addChild(run, "c-beta", { team: "beta" });

	assert.throws(() => sendMessage(runDir, actor("c-solo", 1), { to: "c-a", text: "x" }), /team/i);
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-solo", text: "x" }), /team/i);
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-beta", text: "x" }), /team/i);
});

test("sendMessage enforces the 32000 char text limit and rejects empty text", () => {
	const { runDir } = pair(tmpRun());
	const ok = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "y".repeat(32000) });
	assert.ok(ok.message_id);
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "y".repeat(32001) }), /32,?000|too long/i);
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "   " }), /empty|text/i);
});

test("sendMessage caps outstanding undelivered messages per sender at 32", () => {
	const { runDir } = pair(tmpRun());
	let last = "";
	for (let i = 0; i < 32; i++) {
		last = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: `m${i}` }).message_id;
	}
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "over" }), /outstanding|undelivered/i);
});

test("sendMessage resolves a unique teammate name to its full id", () => {
	const runDir = tmpRun();
	const reg = readReg(runDir);
	reg.teams = { api: { name: "api", goal: "g" }, ui: { name: "ui", goal: "g" } };
	writeReg(runDir, reg);
	addChild(runDir, "lead-0001", { team: "api", name: "lead" });
	addChild(runDir, "cleanup-aaaa", { team: "api", name: "cleanup" });
	addChild(runDir, "cleanup-bbbb", { team: "ui", name: "cleanup" });
	const res = sendMessage(runDir, actor("lead-0001"), { to: "cleanup", text: "hi" });
	assert.equal(res.to, "cleanup-aaaa");
	const th = readThreadFile(runDir, res.thread_id);
	assert.deepEqual(th.messages[0].to, { id: "cleanup-aaaa", generation: 1 }, "stored under the full id");
	assert.deepEqual(th.participants.map((p: any) => p.id), ["lead-0001", "cleanup-aaaa"]);
	// Replying by name continues the same thread.
	const again = sendMessage(runDir, actor("lead-0001"), { to: "cleanup", text: "more" });
	assert.equal(again.thread_id, res.thread_id);
	// And the recipient can answer by name too.
	assert.equal(sendMessage(runDir, actor("cleanup-aaaa"), { to: "lead", text: "ok" }).to, "lead-0001");
});

test("sendMessage refuses a name shared by two teammates, naming both full ids", () => {
	const runDir = tmpRun();
	const reg = readReg(runDir);
	reg.teams = { api: { name: "api", goal: "g" } };
	writeReg(runDir, reg);
	addChild(runDir, "lead-0001", { team: "api", name: "lead" });
	addChild(runDir, "cleanup-aaaa", { team: "api", name: "cleanup" });
	addChild(runDir, "cleanup-bbbb", { team: "api", name: "cleanup", state: "done" });
	assert.throws(
		() => sendMessage(runDir, actor("lead-0001"), { to: "cleanup", text: "hi" }),
		/"cleanup" is ambiguous on team api: cleanup-aaaa, cleanup-bbbb\. Use the full ID\./,
	);
	assert.equal(sendMessage(runDir, actor("lead-0001"), { to: "cleanup-aaaa", text: "hi" }).to, "cleanup-aaaa");
	assert.equal(threadFiles(runDir).length, 1);
});

test("a name on another team does not resolve", () => {
	const runDir = tmpRun();
	const reg = readReg(runDir);
	reg.teams = { api: { name: "api", goal: "g" }, ui: { name: "ui", goal: "g" } };
	writeReg(runDir, reg);
	addChild(runDir, "lead-0001", { team: "api", name: "lead" });
	addChild(runDir, "cleanup-bbbb", { team: "ui", name: "cleanup" });
	assert.throws(() => sendMessage(runDir, actor("lead-0001"), { to: "cleanup", text: "hi" }), /no such agent "cleanup"/);
});

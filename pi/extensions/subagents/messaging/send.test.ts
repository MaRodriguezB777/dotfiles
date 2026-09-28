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

test("sendMessage reuses the thread when reply_to points at it", () => {
	const { runDir } = pair(tmpRun());
	const first = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "q?", needs_reply: true });
	const second = sendMessage(runDir, actor("c-b", 1), {
		to: "c-a",
		text: "a!",
		reply_to: first.message_id,
	});
	assert.equal(second.thread_id, first.thread_id);
	assert.equal(threadFiles(runDir).length, 1);
	const th = readThreadFile(runDir, first.thread_id);
	assert.equal(th.messages.length, 2);
	assert.equal(th.messages[0].needs_reply, true);
	assert.equal(th.messages[1].reply_to, first.message_id);
});

test("sendMessage accepts a thread id as reply_to", () => {
	const { runDir } = pair(tmpRun());
	const first = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "q?" });
	const second = sendMessage(runDir, actor("c-b", 1), {
		to: "c-a",
		text: "a!",
		reply_to: first.thread_id,
	});
	assert.equal(second.thread_id, first.thread_id);
});

test("sendMessage rejects a reply_to whose thread has other participants", () => {
	const run = tmpRun();
	const { runDir } = pair(run);
	addChild(run, "c-c", { team: "alpha" });
	const first = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "q?" });
	assert.throws(
		() => sendMessage(runDir, actor("c-a", 1), { to: "c-c", text: "x", reply_to: first.thread_id }),
		/participant/i,
	);
});

test("sendMessage rejects unknown reply_to and traversal-shaped ids", () => {
	const { runDir } = pair(tmpRun());
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "x", reply_to: "m-nope" }), /reply_to/i);
	assert.throws(
		() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "x", reply_to: "../../etc/passwd" }),
		/reply_to|invalid/i,
	);
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
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "x" }), /Not delivered: c-b is failed\. Only the parent can resume it\./);
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
		last = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: `m${i}`, reply_to: last || undefined })
			.message_id;
	}
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "over" }), /outstanding|undelivered/i);
});

test("sendMessage caps the whole run at 1000 messages", () => {
	const run = tmpRun();
	const { runDir } = pair(run);
	// Fabricate a full run cheaply instead of sending 1000 times.
	const first = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "seed" });
	const th = readThreadFile(runDir, first.thread_id);
	const proto = th.messages[0];
	for (let i = 1; i < 1000; i++) {
		th.messages.push({ ...proto, id: `m-fab${i}`, inbound: { ...proto.inbound, state: "delivered" } });
	}
	fs.writeFileSync(path.join(runDir, "messages", `${first.thread_id}.json`), JSON.stringify(th));
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "over" }), /1,?000|limit/i);
});

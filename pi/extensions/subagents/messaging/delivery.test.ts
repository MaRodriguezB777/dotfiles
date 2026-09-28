import assert from "node:assert/strict";
import { test } from "node:test";
import {
	acknowledgeDelivery,
	closeInbox,
	prepareDelivery,
	readMessages,
	sendMessage,
	settleMessages,
	summary,
} from "./index.ts";
import { actor, addChild, pair, patchChild, readReg, readThreadFile, tmpRun } from "./test-helpers.ts";

test("prepareDelivery returns null on an empty run", () => {
	const run = tmpRun();
	addChild(run, "c-a", { team: "none" });
	assert.equal(prepareDelivery(run, actor("c-a", 1)), null);
});

test("prepareDelivery inlines small messages in full", () => {
	const { runDir } = pair(tmpRun());
	const sent = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "please rebase onto main" });
	const batch = prepareDelivery(runDir, actor("c-b", 1));
	assert.ok(batch);
	assert.match(batch.text, /please rebase onto main/);
	assert.match(batch.text, new RegExp(sent.message_id));
	assert.deepEqual(batch.receipt.inbound, [sent.message_id]);
	assert.deepEqual(batch.receipt.actor, { id: "c-b", generation: 1 });
	assert.deepEqual(JSON.parse(JSON.stringify(batch.receipt)), batch.receipt);
});

test("prepareDelivery announces long messages with the exact notice and no preview", () => {
	const { runDir } = pair(tmpRun());
	const body = `SECRETBODY${"x".repeat(2490)}`;
	const sent = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: body });
	const batch = prepareDelivery(runDir, actor("c-b", 1))!;
	const expected =
		`New message ${sent.message_id} (${body.length.toLocaleString("en-US")} chars), thread ${sent.thread_id}, ` +
		`from agent c-a.\nRead with team_messages({ thread_id: "${sent.thread_id}" }).`;
	assert.equal(batch.text, expected);
	assert.ok(!batch.text.includes("SECRETBODY"));
});

test("prepareDelivery batches oldest first, at most 8 messages", () => {
	const { runDir } = pair(tmpRun());
	const ids: string[] = [];
	for (let i = 0; i < 10; i++) {
		ids.push(sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: `msg ${i}` }).message_id);
	}
	const batch = prepareDelivery(runDir, actor("c-b", 1))!;
	assert.equal(batch.receipt.inbound.length, 8);
	assert.deepEqual(batch.receipt.inbound, ids.slice(0, 8));
});

test("prepareDelivery keeps the batch under 8000 chars", () => {
	const { runDir } = pair(tmpRun());
	for (let i = 0; i < 8; i++) {
		sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: `${i}`.repeat(1900) });
	}
	const batch = prepareDelivery(runDir, actor("c-b", 1))!;
	assert.ok(batch.text.length <= 8000, `batch was ${batch.text.length} chars`);
	assert.ok(batch.receipt.inbound.length < 8);
});

test("prepareDelivery does not mark anything delivered until acknowledged", () => {
	const { runDir } = pair(tmpRun());
	const sent = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "hi" });
	const first = prepareDelivery(runDir, actor("c-b", 1))!;
	assert.equal(readThreadFile(runDir, sent.thread_id).messages[0].inbound.state, "queued");
	const second = prepareDelivery(runDir, actor("c-b", 1))!;
	assert.deepEqual(second.receipt.inbound, first.receipt.inbound);

	acknowledgeDelivery(runDir, first.receipt);
	assert.equal(readThreadFile(runDir, sent.thread_id).messages[0].inbound.state, "delivered");
	assert.equal(prepareDelivery(runDir, actor("c-b", 1)), null);
});

test("acknowledgeDelivery marks small bodies read, long bodies unread, and is idempotent", () => {
	const { runDir } = pair(tmpRun());
	const small = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "short one" });
	const big = sendMessage(runDir, actor("c-a", 1), {
		to: "c-b",
		text: "z".repeat(2500),
		reply_to: small.thread_id,
	});
	const batch = prepareDelivery(runDir, actor("c-b", 1))!;
	acknowledgeDelivery(runDir, batch.receipt);
	acknowledgeDelivery(runDir, batch.receipt); // idempotent

	const th = readThreadFile(runDir, small.thread_id);
	const byId = Object.fromEntries(th.messages.map((m: any) => [m.id, m]));
	assert.equal(byId[small.message_id].read.full, true);
	assert.equal(byId[big.message_id].read.full, false);
	assert.equal(byId[big.message_id].inbound.state, "delivered");

	const unread = readMessages(runDir, actor("c-b", 1), { thread_id: small.thread_id });
	assert.match(unread.text, /zzz/);
	assert.ok(!unread.text.includes("short one"));
});

test("prepareDelivery with closing=true closes the inbox only when the batch is empty", () => {
	const { runDir } = pair(tmpRun());
	const sent = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "wait for me" });

	const batch = prepareDelivery(runDir, actor("c-b", 1), true)!;
	assert.ok(batch);
	assert.notEqual(readReg(runDir).children["c-b"].acceptingMessages, false);
	acknowledgeDelivery(runDir, batch.receipt);

	assert.equal(prepareDelivery(runDir, actor("c-b", 1), true), null);
	assert.equal(readReg(runDir).children["c-b"].acceptingMessages, false);
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "too late" }), /not accepting|finish/i);
	assert.ok(sent.message_id);
});

test("closeInbox stops delivery, marks queued inbound undelivered and never resurrects", () => {
	const { runDir } = pair(tmpRun());
	const sent = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "orphan me" });
	closeInbox(runDir, actor("c-b", 1), "child crashed");

	assert.equal(readReg(runDir).children["c-b"].acceptingMessages, false);
	assert.equal(readThreadFile(runDir, sent.thread_id).messages[0].inbound.state, "undelivered");
	assert.equal(prepareDelivery(runDir, actor("c-b", 1)), null);
	patchChild(runDir, "c-b", { acceptingMessages: true });
	assert.equal(prepareDelivery(runDir, actor("c-b", 1)), null);
});

test("settleMessages fails queued inbound and notifies an active sender of the same generation", () => {
	const { runDir } = pair(tmpRun());
	const sent = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "did you get this?" });
	settleMessages(runDir, "c-b", 1, "child finished");

	const m = readThreadFile(runDir, sent.thread_id).messages[0];
	assert.equal(m.inbound.state, "undelivered");
	assert.equal(m.failure.reason, "child finished");
	assert.equal(m.failure.notice.state, "queued");

	const batch = prepareDelivery(runDir, actor("c-a", 1))!;
	assert.deepEqual(batch.receipt.failures, [sent.message_id]);
	assert.match(batch.text, /not delivered|failed/i);
	assert.ok(!batch.text.includes("did you get this?"));
	acknowledgeDelivery(runDir, batch.receipt);
	assert.equal(readThreadFile(runDir, sent.thread_id).messages[0].failure.notice.state, "delivered");
	assert.equal(prepareDelivery(runDir, actor("c-a", 1)), null);
});

test("settleMessages retains the notice when the sender generation is gone", () => {
	const { runDir } = pair(tmpRun());
	const sent = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "hello" });
	patchChild(runDir, "c-a", { generation: 2 });
	settleMessages(runDir, "c-b", 1, "child finished");
	const m = readThreadFile(runDir, sent.thread_id).messages[0];
	assert.equal(m.failure.notice.state, "retained");
	assert.equal(prepareDelivery(runDir, actor("c-a", 2)), null);
	assert.match(summary(runDir), /retained|undeliver/i);
});

test("settleMessages never touches a future generation of the same child", () => {
	const { runDir } = pair(tmpRun());
	const g1 = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "for gen 1" });
	patchChild(runDir, "c-b", { generation: 2 });
	const g2 = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "for gen 2", reply_to: g1.thread_id });

	settleMessages(runDir, "c-b", 1, "generation 1 ended");
	const msgs = readThreadFile(runDir, g1.thread_id).messages;
	const byId = Object.fromEntries(msgs.map((m: any) => [m.id, m]));
	assert.equal(byId[g1.message_id].inbound.state, "undelivered");
	assert.equal(byId[g2.message_id].inbound.state, "queued");
	assert.deepEqual(prepareDelivery(runDir, actor("c-b", 2))!.receipt.inbound, [g2.message_id]);
});

test("a failed outgoing message stays inspectable by its sender", () => {
	const { runDir } = pair(tmpRun());
	const sent = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "unlucky payload" });
	settleMessages(runDir, "c-b", 1, "child finished");
	const view = readMessages(runDir, actor("c-a", 1), { thread_id: sent.thread_id, view: "all" });
	assert.match(view.text, new RegExp(sent.message_id));
	assert.match(view.text, /not delivered|failed/i);
	assert.match(view.text, /unlucky payload/);
});

test("summary is bounded, counts work, and an empty run is harmless", () => {
	const empty = tmpRun();
	const s0 = summary(empty);
	assert.equal(typeof s0, "string");
	assert.ok(s0.length < 500);

	const { runDir } = pair(tmpRun());
	for (let i = 0; i < 5; i++) sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: `SECRET${i}` });
	settleMessages(runDir, "c-b", 1, "child finished");
	const s = summary(runDir);
	assert.ok(!s.includes("SECRET"), "summary must not contain message bodies");
	assert.match(s, /c-a/);
	assert.match(s, /alpha/);
	assert.ok(s.length <= 4000, `summary was ${s.length} chars`);
});

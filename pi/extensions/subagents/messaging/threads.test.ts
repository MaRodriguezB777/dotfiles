/**
 * Default thread per pair, named threads, and carrying mail across an
 * interrupt-and-resume. The behaviour the redesign exists for.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	abortRestart,
	acknowledgeDelivery,
	beginRestart,
	finishRestart,
	prepareDelivery,
	readMessages,
	sendMessage,
	settleMessages,
} from "./index.ts";
import { actor, addChild, pair, patchChild, readReg, readThreadFile, threadFiles, tmpRun } from "./test-helpers.ts";

const A = actor("c-a");
const B = actor("c-b");
const deliver = (runDir: string, who: { id: string; generation: number }) => {
	const d = prepareDelivery(runDir, who);
	if (d) acknowledgeDelivery(runDir, d.receipt);
	return d?.text ?? null;
};

// ---- default thread ----------------------------------------------------------

test("messages between a pair share one default thread, in both directions", () => {
	const { runDir } = pair(tmpRun());
	const one = sendMessage(runDir, A, { to: "c-b", text: "first" });
	const two = sendMessage(runDir, B, { to: "c-a", text: "answer" });
	const three = sendMessage(runDir, A, { to: "c-b", text: "again" });
	assert.equal(threadFiles(runDir).length, 1);
	assert.equal(one.thread, "default");
	assert.equal(two.thread_id, one.thread_id);
	assert.equal(three.thread_id, one.thread_id);
	const th = readThreadFile(runDir, one.thread_id);
	assert.equal(th.name, "default");
	assert.deepEqual(th.messages.map((m: any) => m.text), ["first", "answer", "again"]);
});

test("each pair has its own default thread", () => {
	const { runDir } = pair(tmpRun());
	addChild(runDir, "c-c", { team: "alpha" });
	sendMessage(runDir, A, { to: "c-b", text: "x" });
	sendMessage(runDir, A, { to: "c-c", text: "y" });
	assert.equal(threadFiles(runDir).length, 2);
});

test("there is no per-run message cap", () => {
	const { runDir } = pair(tmpRun());
	for (let i = 0; i < 1001; i++) {
		sendMessage(runDir, i % 2 ? B : A, { to: i % 2 ? "c-a" : "c-b", text: `m${i}` });
		// keep the outstanding (undelivered) count below its own, separate limit
		if (i % 20 === 19) {
			while (deliver(runDir, A));
			while (deliver(runDir, B));
		}
	}
	assert.equal(readThreadFile(runDir, threadFiles(runDir)[0].replace(/\.json$/, "")).messages.length, 1001);
});

// ---- named threads -----------------------------------------------------------------

test("new_thread creates a named thread with a unique handle; thread: by name or handle continues it", () => {
	const { runDir } = pair(tmpRun());
	const made = sendMessage(runDir, A, { to: "c-b", new_thread: "bench-v2", text: "open" });
	assert.equal(made.thread, "bench-v2");
	assert.match(made.handle, /^bench-v2-[0-9a-f]{4}$/);
	const byName = sendMessage(runDir, B, { to: "c-a", thread: "bench-v2", text: "by name" });
	const byHandle = sendMessage(runDir, A, { to: "c-b", thread: made.handle, text: "by handle" });
	assert.equal(byName.thread_id, made.thread_id);
	assert.equal(byHandle.thread_id, made.thread_id);
	// The default thread is untouched by named-thread traffic.
	const plain = sendMessage(runDir, A, { to: "c-b", text: "plain" });
	assert.notEqual(plain.thread_id, made.thread_id);
	assert.equal(threadFiles(runDir).length, 2);
});

test("creating a thread that already exists with that teammate is an error", () => {
	const { runDir } = pair(tmpRun());
	sendMessage(runDir, A, { to: "c-b", new_thread: "bench-v2", text: "open" });
	assert.throws(
		() => sendMessage(runDir, B, { to: "c-a", new_thread: "bench-v2", text: "dup" }),
		/Thread "bench-v2" with c-a already exists\. Send to it with thread: "bench-v2"\./,
	);
	assert.throws(() => sendMessage(runDir, A, { to: "c-b", new_thread: "default", text: "x" }), /reserved/);
	// The same name with a different teammate is a different thread.
	addChild(runDir, "c-c", { team: "alpha" });
	assert.doesNotThrow(() => sendMessage(runDir, A, { to: "c-c", new_thread: "bench-v2", text: "ok" }));
});

test("an unknown thread is refused with the threads that do exist with that teammate", () => {
	const { runDir } = pair(tmpRun());
	sendMessage(runDir, A, { to: "c-b", new_thread: "bench-v2", text: "open" });
	assert.throws(
		() => sendMessage(runDir, A, { to: "c-b", thread: "bench-v3", text: "typo" }),
		(e: Error) => /no thread "bench-v3" with c-b/.test(e.message) && /bench-v2/.test(e.message) && /new_thread/.test(e.message),
	);
	assert.throws(() => sendMessage(runDir, A, { to: "c-b", thread: "x", new_thread: "y", text: "both" }), /either thread or new_thread/);
	assert.throws(() => sendMessage(runDir, A, { to: "c-b", new_thread: "Bad Name!", text: "x" }), /thread name/i);
});

test("a named thread belongs to its pair: a third teammate cannot use it", () => {
	const { runDir } = pair(tmpRun());
	addChild(runDir, "c-c", { team: "alpha" });
	sendMessage(runDir, A, { to: "c-b", new_thread: "bench-v2", text: "open" });
	assert.throws(() => sendMessage(runDir, actor("c-c"), { to: "c-b", thread: "bench-v2", text: "x" }), /no thread "bench-v2"/);
});

// ---- delivery text -----------------------------------------------------------------

test("a delivered message names its thread and shows the exact reply call", () => {
	const { runDir } = pair(tmpRun());
	sendMessage(runDir, A, { to: "c-b", text: "loss curve?", needs_reply: true });
	assert.equal(deliver(runDir, B), '[c-a · default] (reply requested)\nloss curve?\nReply: message_team({ to: "c-a" })');
	sendMessage(runDir, A, { to: "c-b", new_thread: "bench-v2", text: "numbers" });
	assert.equal(deliver(runDir, B), '[c-a · bench-v2]\nnumbers\nReply: message_team({ to: "c-a", thread: "bench-v2" })');
});

test("a long message is a size-only notice pointing at the right read call", () => {
	const { runDir } = pair(tmpRun());
	sendMessage(runDir, A, { to: "c-b", text: "x".repeat(6420) });
	assert.equal(
		deliver(runDir, B),
		'New message (6,420 chars), thread default, from agent c-a.\nRead with team_messages({ with: "c-a" }).',
	);
	sendMessage(runDir, A, { to: "c-b", thread: "default", text: "y".repeat(3000) });
	sendMessage(runDir, A, { to: "c-b", new_thread: "spec", text: "z".repeat(3000) });
	assert.match(deliver(runDir, B)!, /thread spec, from agent c-a\.\nRead with team_messages\(\{ thread: "spec" \}\)\./);
});

test("a failure notice says which message, in which thread, and the real reason", () => {
	const { runDir } = pair(tmpRun());
	sendMessage(runDir, A, { to: "c-b", text: "m4 pilot finished, loss 0.41, want the config?" });
	patchChild(runDir, "c-b", { state: "killed" });
	settleMessages(runDir, "c-b", 1, "was stopped by the parent");
	assert.equal(
		deliver(runDir, A),
		'Your message to c-b (default thread) "m4 pilot finished, loss 0.41, want the config?" was not delivered: ' +
			"c-b was stopped by the parent. Only the parent can resume it.",
	);
});

// ---- interrupt and resume: the same agent continues ---------------------------------

test("mail queued for an interrupted agent is carried into its resumed generation", () => {
	const { runDir } = pair(tmpRun());
	sendMessage(runDir, A, { to: "c-b", text: "before the interrupt" });
	beginRestart(runDir, "c-b", 1);
	// What the stop does to a recipient: process gone, inbox closed, state killed.
	patchChild(runDir, "c-b", { state: "killed", acceptingMessages: false, pid: null });
	settleMessages(runDir, "c-b", 1, "was stopped by the parent"); // must be a no-op while restarting
	// A teammate keeps talking during the gap instead of being told "has finished".
	sendMessage(runDir, A, { to: "c-b", text: "during the gap" });
	// The parent resumes it as generation 2.
	patchChild(runDir, "c-b", { state: "running", acceptingMessages: true, pid: process.pid, generation: 2 });
	finishRestart(runDir, "c-b", 1, 2);
	assert.equal(deliver(runDir, actor("c-a")), null, "the sender is told nothing: nothing was lost");
	const text = deliver(runDir, actor("c-b", 2))!;
	assert.match(text, /before the interrupt/);
	assert.match(text, /during the gap/);
	assert.equal(readReg(runDir).children["c-b"].restarting, undefined);
});

test("failure notices owed to an interrupted sender reach its resumed generation", () => {
	const { runDir } = pair(tmpRun());
	addChild(runDir, "c-c", { team: "alpha" });
	sendMessage(runDir, A, { to: "c-c", text: "for c" });
	beginRestart(runDir, "c-a", 1);
	patchChild(runDir, "c-a", { state: "killed", acceptingMessages: false, pid: null });
	// c-c really fails while c-a is between generations.
	patchChild(runDir, "c-c", { state: "failed" });
	settleMessages(runDir, "c-c", 1, "failed");
	patchChild(runDir, "c-a", { state: "running", acceptingMessages: true, pid: process.pid, generation: 2 });
	finishRestart(runDir, "c-a", 1, 2);
	assert.match(deliver(runDir, actor("c-a", 2))!, /Your message to c-c .* was not delivered: c-c failed/);
});

test("if the resume never happens, the carried mail fails with the real reason", () => {
	const { runDir } = pair(tmpRun());
	sendMessage(runDir, A, { to: "c-b", text: "stranded" });
	beginRestart(runDir, "c-b", 1);
	patchChild(runDir, "c-b", { state: "killed", acceptingMessages: false, pid: null });
	abortRestart(runDir, "c-b", 1, "could not be resumed (writer limit reached)");
	assert.match(deliver(runDir, A)!, /"stranded" was not delivered: c-b could not be resumed \(writer limit reached\)/);
	assert.throws(() => sendMessage(runDir, A, { to: "c-b", text: "late" }), /Not delivered: c-b was stopped/);
});

test("a plain stop (no resume) still fails mail and refuses new sends", () => {
	const { runDir } = pair(tmpRun());
	sendMessage(runDir, A, { to: "c-b", text: "q" });
	patchChild(runDir, "c-b", { state: "killed", acceptingMessages: false, pid: null });
	settleMessages(runDir, "c-b", 1, "was stopped by the parent");
	assert.match(deliver(runDir, A)!, /was not delivered: c-b was stopped by the parent/);
	assert.throws(() => sendMessage(runDir, A, { to: "c-b", text: "x" }), /Not delivered: c-b was stopped by the parent\. Only the parent can resume it\./);
});

// ---- reading -------------------------------------------------------------------------

test("team_messages() lists teammates with their threads and unread counts", () => {
	const { runDir } = pair(tmpRun());
	addChild(runDir, "c-c", { team: "alpha" });
	sendMessage(runDir, B, { to: "c-a", text: "x".repeat(3000) }); // long: stays unread
	sendMessage(runDir, B, { to: "c-a", new_thread: "bench-v2", text: "y".repeat(3000) });
	deliver(runDir, A);
	const text = readMessages(runDir, A, {}).text;
	assert.match(text, /c-b \(running\)/);
	assert.match(text, /default with c-b · 1 unread of 1/);
	assert.match(text, /bench-v2 with c-b · 1 unread of 1/);
	assert.match(text, /c-c \(running\)/);
	assert.match(text, /team_messages\(\{ with: "c-b" \}\)/);
});

test("with: reads the default thread with a teammate; thread: a named thread by name", () => {
	const { runDir } = pair(tmpRun());
	sendMessage(runDir, B, { to: "c-a", text: `DEF${"x".repeat(3000)}` });
	sendMessage(runDir, B, { to: "c-a", new_thread: "bench-v2", text: `NAMED${"y".repeat(3000)}` });
	const def = readMessages(runDir, A, { with: "c-b" }).text;
	assert.match(def, /^Thread default with c-b/);
	assert.match(def, /DEF/);
	assert.doesNotMatch(def, /NAMED/);
	const named = readMessages(runDir, A, { thread: "bench-v2" }).text;
	assert.match(named, /^Thread bench-v2 \(bench-v2-[0-9a-f]{4}\) with c-b/);
	assert.match(named, /NAMED/);
	assert.match(readMessages(runDir, A, { with: "c-b", view: "recent" }).text, /DEF/);
});

test("a thread name shared with two teammates is ambiguous; the handle or with: settles it", () => {
	const { runDir } = pair(tmpRun());
	addChild(runDir, "c-c", { team: "alpha" });
	const b = sendMessage(runDir, B, { to: "c-a", new_thread: "spec", text: "from b" });
	sendMessage(runDir, actor("c-c"), { to: "c-a", new_thread: "spec", text: "from c" });
	assert.throws(() => readMessages(runDir, A, { thread: "spec" }), /ambiguous.*spec-[0-9a-f]{4}.*spec-[0-9a-f]{4}/);
	assert.match(readMessages(runDir, A, { thread: b.handle }).text, /from b/);
	assert.match(readMessages(runDir, A, { thread: "spec", with: "c-c" }).text, /from c/);
});

test("threads from before this change stay readable by their t- id", () => {
	const { runDir } = pair(tmpRun());
	fs.mkdirSync(path.join(runDir, "messages"), { recursive: true });
	const legacy = {
		version: 1,
		id: "t-0123456789ab",
		team: "alpha",
		participants: [A, B],
		createdAt: 1,
		messages: [
			{ id: "m-0123456789ab", seq: 0, from: B, to: A, at: Date.now(), text: "old topic", needs_reply: false, reply_to: null, inbound: { state: "delivered", at: 1, reason: null }, read: { ranges: [], full: false, at: null, session: null }, failure: null },
		],
	};
	fs.writeFileSync(path.join(runDir, "messages", "t-0123456789ab.json"), JSON.stringify(legacy));
	assert.match(readMessages(runDir, A, {}).text, /t-0123456789ab \(older thread\) with c-b · 1 unread of 1/);
	assert.match(readMessages(runDir, A, { thread: "t-0123456789ab" }).text, /old topic/);
	// New messages go to the default thread, not the old topic thread.
	const r = sendMessage(runDir, A, { to: "c-b", text: "new" });
	assert.notEqual(r.thread_id, "t-0123456789ab");
});

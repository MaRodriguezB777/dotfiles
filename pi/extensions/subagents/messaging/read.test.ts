import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { acknowledgeDelivery, prepareDelivery, readMessages, sendMessage, settleMessages } from "./index.ts";
import { actor, addChild, pair, readReg, readThreadFile, tmpRun, writeReg } from "./test-helpers.ts";

function deliver(runDir: string, id: string, generation = 1) {
	for (;;) {
		const batch = prepareDelivery(runDir, actor(id, generation));
		if (!batch) return;
		acknowledgeDelivery(runDir, batch.receipt);
	}
}

test("readMessages is graceful on an empty run", () => {
	const run = tmpRun();
	addChild(run, "c-a", { team: "none" });
	const out = readMessages(run, actor("c-a", 1), {});
	assert.equal(typeof out.text, "string");
	assert.match(out.text, /no (team )?(messages|threads)/i);
	assert.deepEqual(out.details.threads, []);
});

test("the index lists only the caller's threads, unread first, with counts and no bodies", () => {
	const run = tmpRun();
	const { runDir } = pair(run);
	addChild(run, "c-c", { team: "alpha" });

	const t1 = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "BODYONE" });
	deliver(runDir, "c-b"); // read t1 for c-b (small body auto-read)
	const t2 = sendMessage(runDir, actor("c-c", 1), { to: "c-b", text: "BODYTWO".repeat(500) });

	const out = readMessages(runDir, actor("c-b", 1), {});
	assert.ok(!out.text.includes("BODYONE"));
	assert.ok(!out.text.includes("BODYTWO"));
	assert.equal(out.details.threads.length, 2);
	assert.equal(out.details.threads[0].thread_id, t2.thread_id, "unread thread must sort first");
	assert.equal(out.details.threads[0].unread, 1);
	assert.equal(out.details.threads[1].unread, 0);
	assert.match(out.text, new RegExp(t1.thread_id));

	// listing does not mark anything read
	const again = readMessages(runDir, actor("c-b", 1), {});
	assert.equal(again.details.threads[0].unread, 1);
});

test("the index hides threads the caller is not part of, including other teams", () => {
	const run = tmpRun();
	const { runDir } = pair(run);
	const reg = readReg(run);
	reg.teams.beta = { name: "beta", goal: "other" };
	writeReg(run, reg);
	addChild(run, "c-x", { team: "beta" });
	addChild(run, "c-y", { team: "beta" });
	const other = sendMessage(runDir, actor("c-x", 1), { to: "c-y", text: "PRIVATEBETA" });

	const out = readMessages(runDir, actor("c-a", 1), {});
	assert.ok(!out.text.includes(other.thread_id));
	assert.ok(!out.text.includes("PRIVATEBETA"));
	assert.throws(() => readMessages(runDir, actor("c-a", 1), { thread_id: other.thread_id }), /participant|no such thread/i);
});

test("thread ids that look like path traversal are rejected", () => {
	const { runDir } = pair(tmpRun());
	for (const bad of ["../claims", "t-../../x", "/etc/passwd", "t-x/../y", "claims"]) {
		assert.throws(() => readMessages(runDir, actor("c-a", 1), { thread_id: bad }), /invalid|no such thread/i);
	}
});

test("a corrupt thread file fails closed", () => {
	const { runDir } = pair(tmpRun());
	const t = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "fine" });
	fs.writeFileSync(path.join(runDir, "messages", `${t.thread_id}.json`), "{not json");
	assert.throws(() => readMessages(runDir, actor("c-b", 1), { thread_id: t.thread_id }), /corrupt|unreadable/i);
	assert.throws(() => readMessages(runDir, actor("c-b", 1), {}), /corrupt|unreadable/i);
});

test("the default thread view shows unread incoming messages and marks them read", () => {
	const { runDir } = pair(tmpRun());
	const t = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "alpha body" });
	sendMessage(runDir, actor("c-b", 1), { to: "c-a", text: "my own reply", reply_to: t.thread_id });

	const out = readMessages(runDir, actor("c-b", 1), { thread_id: t.thread_id });
	assert.match(out.text, /alpha body/);
	assert.ok(!out.text.includes("my own reply"), "unread view is incoming-only");
	assert.equal(readThreadFile(runDir, t.thread_id).messages[0].read.full, true);

	const second = readMessages(runDir, actor("c-b", 1), { thread_id: t.thread_id });
	assert.match(second.text, /no unread/i);
});

test("recent shows the tail chronologically including own and already-read messages", () => {
	const { runDir } = pair(tmpRun());
	let tid = "";
	for (let i = 0; i < 14; i++) {
		const from = i % 2 === 0 ? "c-a" : "c-b";
		const to = i % 2 === 0 ? "c-b" : "c-a";
		const r = sendMessage(runDir, actor(from, 1), { to, text: `body-${i}`, reply_to: tid || undefined });
		tid = r.thread_id;
	}
	const out = readMessages(runDir, actor("c-b", 1), { thread_id: tid, view: "recent" });
	assert.equal(out.details.messages.length, 10);
	assert.equal(out.details.messages[0].id, out.details.messages[0].id);
	assert.ok(!out.text.includes("body-3"), "older messages are outside the recent window");
	assert.match(out.text, /body-4[^0-9]/);
	assert.match(out.text, /body-13/);
	assert.ok(out.text.indexOf("body-4") < out.text.indexOf("body-13"), "chronological order");

	const all = readMessages(runDir, actor("c-b", 1), { thread_id: tid, view: "all" });
	assert.equal(all.details.messages.length, 14);
	assert.ok(all.text.indexOf("body-0") < all.text.indexOf("body-13"));
});

test("output is bounded and long bodies page through a cursor, marking only covered ranges", () => {
	const { runDir } = pair(tmpRun());
	const body = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
	assert.ok(body.length > 16000);
	const t = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: body });

	let out = readMessages(runDir, actor("c-b", 1), { thread_id: t.thread_id });
	assert.ok(out.text.length <= 8000, `page was ${out.text.length} chars`);
	assert.ok(out.details.cursor, "expected a continuation cursor");
	let stored = readThreadFile(runDir, t.thread_id).messages[0];
	assert.equal(stored.read.full, false);
	assert.equal(stored.read.ranges.length, 1);
	const firstCovered = stored.read.ranges[0][1];
	assert.ok(firstCovered > 0 && firstCovered < body.length);

	let seen = out.details.messages[0].shown[1] - out.details.messages[0].shown[0];
	let pages = 1;
	while (out.details.cursor) {
		out = readMessages(runDir, actor("c-b", 1), { cursor: out.details.cursor });
		assert.ok(out.text.length <= 8000);
		seen += out.details.messages[0].shown[1] - out.details.messages[0].shown[0];
		pages++;
		assert.ok(pages < 20, "paging did not terminate");
	}
	assert.ok(pages >= 3, `expected multiple pages, got ${pages}`);
	assert.equal(seen, body.length);
	stored = readThreadFile(runDir, t.thread_id).messages[0];
	assert.equal(stored.read.full, true);
	assert.match(readMessages(runDir, actor("c-b", 1), { thread_id: t.thread_id }).text, /no unread/i);
});

test("a cursor continues over a stable snapshot and ignores messages that arrive mid-paging", () => {
	const { runDir } = pair(tmpRun());
	const a = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: `A${"a".repeat(6000)}` });
	sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: `B${"b".repeat(6000)}`, reply_to: a.thread_id });

	let out = readMessages(runDir, actor("c-b", 1), { thread_id: a.thread_id });
	assert.ok(out.details.cursor);
	const late = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "LATEARRIVAL", reply_to: a.thread_id });

	const texts: string[] = [out.text];
	while (out.details.cursor) {
		out = readMessages(runDir, actor("c-b", 1), { cursor: out.details.cursor });
		texts.push(out.text);
	}
	assert.ok(!texts.join("").includes("LATEARRIVAL"), "snapshot must not grow while paging");
	const fresh = readMessages(runDir, actor("c-b", 1), { thread_id: a.thread_id });
	assert.match(fresh.text, /LATEARRIVAL/);
	assert.ok(fresh.details.messages.some((m: any) => m.id === late.message_id));
});

test("a cursor is rejected for the wrong actor or when malformed", () => {
	const { runDir } = pair(tmpRun());
	const t = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "x".repeat(20000) });
	const out = readMessages(runDir, actor("c-b", 1), { thread_id: t.thread_id });
	assert.throws(() => readMessages(runDir, actor("c-a", 1), { cursor: out.details.cursor }), /cursor/i);
	assert.throws(() => readMessages(runDir, actor("c-b", 1), { cursor: "garbage" }), /cursor/i);
});

test("undelivered inbound bodies are never shown to the recipient", () => {
	const { runDir } = pair(tmpRun());
	const t = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "NEVERSHOWME" });
	settleMessages(runDir, "c-b", 1, "child finished");

	for (const view of ["unread", "recent", "all"] as const) {
		const out = readMessages(runDir, actor("c-b", 1), { thread_id: t.thread_id, view });
		assert.ok(!out.text.includes("NEVERSHOWME"), `view ${view} leaked an undelivered body`);
	}
	const idx = readMessages(runDir, actor("c-b", 1), {});
	assert.equal(idx.details.threads[0].unread, 0);
});

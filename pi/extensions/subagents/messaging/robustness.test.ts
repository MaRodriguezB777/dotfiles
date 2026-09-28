import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	acknowledgeDelivery,
	closeInbox,
	defineTeam,
	prepareDelivery,
	readMessages,
	sendMessage,
	settleMessages,
	summary,
} from "./index.ts";
import { actor, pair, threadFiles, tmpRun } from "./test-helpers.ts";

function bareDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "subagents-bare-"));
}

test("every entry point survives a run directory with nothing in it", () => {
	const d = bareDir();
	const me = actor("c-a", 1);
	assert.equal(summary(d), "No team messages.");
	assert.match(readMessages(d, me, {}).text, /no team messages/i);
	assert.equal(prepareDelivery(d, me), null);
	assert.equal(prepareDelivery(d, me, true), null);
	assert.equal(settleMessages(d, "c-a", 1, "gone"), undefined);
	assert.equal(closeInbox(d, me, "gone"), undefined);
	assert.equal(acknowledgeDelivery(d, { actor: me, preparedAt: 0, inbound: [], full: [], failures: [] }), undefined);
	assert.equal(fs.existsSync(path.join(d, ".lock")), false, "the run lock must always be released");
});

test("defineTeam bootstraps claims.json when the parent has not written one yet", () => {
	const d = bareDir();
	defineTeam(d, "alpha", "goal");
	const reg = JSON.parse(fs.readFileSync(path.join(d, "claims.json"), "utf8"));
	assert.equal(reg.teams.alpha.goal, "goal");
	assert.equal(reg.runId, path.basename(d));
	assert.deepEqual(reg.children, {});
});

test("stray files in messages/ are ignored, not guessed at", () => {
	const { runDir } = pair(tmpRun());
	sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "real" });
	fs.writeFileSync(path.join(runDir, "messages", "notes.txt"), "junk");
	fs.writeFileSync(path.join(runDir, "messages", "t-nothex.json"), "junk");
	assert.equal(threadFiles(runDir).length, 2, "one real thread plus the bogus t-nothex.json");
	assert.equal(readMessages(runDir, actor("c-b", 1), {}).details.threads.length, 1);
	assert.match(summary(runDir), /1 message/);
});

test("a rejected send leaves no trace and releases the lock", () => {
	const { runDir } = pair(tmpRun());
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "" }));
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-nope", text: "hi" }));
	assert.equal(threadFiles(runDir).length, 0);
	assert.equal(fs.existsSync(path.join(runDir, ".lock")), false);
});

test("a corrupt thread file does not stop sends from failing closed", () => {
	const { runDir } = pair(tmpRun());
	const t = sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "ok" });
	fs.writeFileSync(path.join(runDir, "messages", `${t.thread_id}.json`), '{"version":1}');
	assert.throws(() => sendMessage(runDir, actor("c-a", 1), { to: "c-b", text: "again" }), /corrupt/i);
	assert.match(summary(runDir), /unreadable/i);
	assert.equal(fs.existsSync(path.join(runDir, ".lock")), false);
});

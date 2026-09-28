import assert from "node:assert/strict";
import { test } from "node:test";
import { readMessages, sendMessage } from "./index.ts";
import { actor, addChild, tmpRun } from "./test-helpers.ts";

// Observed live: an agent that never read BOARD.md invented a recipient name.
// Both the index and the rejection must hand it the real teammate ids.
function team() {
	const runDir = tmpRun();
	addChild(runDir, "c-a", { team: "audio" });
	addChild(runDir, "c-b", { team: "audio" });
	addChild(runDir, "c-x", { team: "other" });
	addChild(runDir, "c-done", { team: "audio", state: "done" });
	return runDir;
}

test("team_messages() index lists teammates with ids, state and task even with no threads", () => {
	const runDir = team();
	const text = readMessages(runDir, actor("c-a"), {}).text;
	assert.match(text, /Teammates/);
	assert.match(text, /c-b \(running\)/);
	assert.match(text, /task for c-b/);
	assert.match(text, /c-done \(done\)/);
	assert.doesNotMatch(text, /c-x/, "other teams are not teammates");
	assert.doesNotMatch(text, /c-a \(/, "self is not listed");
});

test("an unknown recipient is rejected with the sender's real teammates", () => {
	const runDir = team();
	assert.throws(
		() => sendMessage(runDir, actor("c-a"), { to: "player_audio_teammate", text: "hi" }),
		(e: Error) => /no such agent/.test(e.message) && /c-b/.test(e.message) && !/c-x/.test(e.message),
	);
});

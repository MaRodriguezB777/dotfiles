import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompletionNotifier } from "../completion.ts";

function harness(awaited: string[] = [], running = { value: false }) {
	const sent: string[] = [];
	const timers: (() => void)[] = [];
	const n = createCompletionNotifier({
		send: (text) => sent.push(text),
		awaited: (id) => awaited.includes(id),
		parentRunning: () => running.value,
		// Manual clock: tests decide when the batching window closes.
		schedule: (fn) => {
			timers.push(fn);
			return () => {};
		},
	});
	const tick = () => {
		for (const fn of timers.splice(0)) fn();
	};
	return { n, sent, tick };
}

test("a finished child produces one message naming it and how to collect it", () => {
	const { n, sent, tick } = harness();
	n.finished({ id: "c-3ad0", agent: "worker", state: "done" });
	assert.equal(sent.length, 0, "batched, not sent synchronously");
	tick();
	assert.equal(sent.length, 1);
	assert.match(sent[0], /c-3ad0/);
	assert.match(sent[0], /worker/);
	assert.match(sent[0], /finished/);
	assert.match(sent[0], /subagent_collect\(\{ ids: \["c-3ad0"\] \}\)/);
});

test("children finishing together share one message and one collect call", () => {
	const { n, sent, tick } = harness();
	n.finished({ id: "c-a", agent: "worker", state: "done" });
	n.finished({ id: "c-b", agent: "scout", state: "failed" });
	tick();
	assert.equal(sent.length, 1);
	assert.match(sent[0], /c-a \(worker, done\)/);
	assert.match(sent[0], /c-b \(scout, failed\)/);
	assert.match(sent[0], /subagent_collect\(\{ ids: \["c-a", "c-b"\] \}\)/);
});

test("a child an in-flight collect is waiting for is not announced", () => {
	const { n, sent, tick } = harness(["c-a"]);
	n.finished({ id: "c-a", agent: "worker", state: "done" });
	tick();
	assert.equal(sent.length, 0);
});

test("a child reported before the window closes is dropped from the message", () => {
	const { n, sent, tick } = harness();
	n.finished({ id: "c-a", agent: "worker", state: "done" });
	n.finished({ id: "c-b", agent: "worker", state: "done" });
	n.reported(["c-a"]); // e.g. subagent_peek level=final, or subagent_stop
	tick();
	assert.equal(sent.length, 1);
	assert.doesNotMatch(sent[0], /c-a/);
	n.reported(["c-b"]);
	n.finished({ id: "c-c", agent: "worker", state: "done" });
	n.reported(["c-c"]);
	tick();
	assert.equal(sent.length, 1, "nothing left to say, nothing sent");
});

test("each finish is announced once, and a later generation is announced again", () => {
	const { n, sent, tick } = harness();
	n.finished({ id: "c-a", agent: "worker", state: "done" });
	tick();
	tick();
	assert.equal(sent.length, 1);
	n.finished({ id: "c-a", agent: "worker", state: "done" }); // resumed via followup, finished again
	tick();
	assert.equal(sent.length, 2);
});

test("a failing send does not throw into the child's exit path", () => {
	const n = createCompletionNotifier({
		send: () => {
			throw new Error("stale ctx");
		},
		awaited: () => false,
		parentRunning: () => false,
		schedule: (fn) => {
			fn();
			return () => {};
		},
	});
	assert.doesNotThrow(() => n.finished({ id: "c-a", agent: "worker", state: "done" }));
});

// Observed live: a child finished during the parent's LLM call, the message was
// handed to pi at once, then the parent's own collect returned the result and
// the message still arrived, so it collected twice. Once pi has a message it
// cannot be withdrawn, so while the parent runs we hold it until the LLM call's
// tools have run, then decide.
test("while the parent runs, the message waits for the end of the LLM call", () => {
	const running = { value: true };
	const { n, sent, tick } = harness([], running);
	n.finished({ id: "c-a", agent: "worker", state: "done" });
	tick();
	assert.equal(sent.length, 0, "not sent mid-call, even after the batching window");
	n.turnEnded();
	assert.equal(sent.length, 1, "sent at the end of the LLM call, before the next one");
	assert.match(sent[0], /c-a/);
});

test("a collect in that same LLM call suppresses the message", () => {
	const running = { value: true };
	const { n, sent } = harness([], running);
	n.finished({ id: "c-a", agent: "worker", state: "done" });
	n.reported(["c-a"]); // the parent's subagent_collect returned it
	n.turnEnded();
	assert.equal(sent.length, 0);
});

test("a child finishing after the parent's last LLM call is sent when the parent settles", () => {
	const running = { value: true };
	const { n, sent, tick } = harness([], running);
	n.finished({ id: "c-a", agent: "worker", state: "done" });
	running.value = false;
	n.settled();
	assert.equal(sent.length, 1);
	tick();
	assert.equal(sent.length, 1, "the batching timer does not send it again");
});

test("a parent that starts running before the window closes gets it at turn end instead", () => {
	const running = { value: false };
	const { n, sent, tick } = harness([], running);
	n.finished({ id: "c-a", agent: "worker", state: "done" });
	running.value = true; // the user typed something
	tick();
	assert.equal(sent.length, 0);
	n.turnEnded();
	assert.equal(sent.length, 1);
});

// /reload hands unsent completions to the next instance instead of losing them
// to a timer that would fire into a dead one.
test("drain returns unsent completions, cancels them here, and sends nothing", () => {
	const running = { value: true };
	const { n, sent, tick } = harness([], running);
	n.finished({ id: "c-a", agent: "worker", state: "done" });
	n.finished({ id: "c-b", agent: "scout", state: "failed" });
	n.reported(["c-b"]);
	assert.deepEqual(n.drain(), [{ id: "c-a", agent: "worker", state: "done" }]);
	n.turnEnded();
	n.settled();
	tick();
	assert.equal(sent.length, 0);
	assert.deepEqual(n.drain(), []);
});

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { HANDOFF_VERSION, type Handoff, claimSink, leave, resetForTests, routeChildEvent, take } from "../handoff.ts";

const child = (id: string) => ({ record: { id } }) as any;

function handoff(overrides: Partial<Handoff> = {}): Handoff & { abandoned: number } {
	const h: any = {
		version: HANDOFF_VERSION,
		runId: "r1",
		runDir: "/runs/r1",
		root: "/proj",
		live: new Map([["c-a", child("c-a")]]),
		procs: new Map(),
		advisories: new Map(),
		stoppedByParent: [],
		escalationOffset: 42,
		pendingCompletions: [],
		abandoned: 0,
		...overrides,
	};
	h.abandon ??= () => h.abandoned++;
	return h;
}

beforeEach(() => resetForTests());

test("events go to the current owner's sink", () => {
	const got: string[] = [];
	claimSink((c, kind) => got.push(`${c.record.id}:${kind}`));
	routeChildEvent(child("c-a"), "event");
	routeChildEvent(child("c-a"), "settled");
	assert.deepEqual(got, ["c-a:event", "c-a:settled"]);
});

test("between owners, settles are buffered and replayed to the next; progress is dropped", () => {
	const old: string[] = [];
	const release = claimSink((c, kind) => old.push(`${c.record.id}:${kind}`));
	release(); // old instance shutting down for reload
	routeChildEvent(child("c-a"), "event");
	routeChildEvent(child("c-a"), "settled");
	routeChildEvent(child("c-b"), "settled");
	assert.deepEqual(old, [], "nothing reaches a released sink");
	const next: string[] = [];
	claimSink((c, kind) => next.push(`${c.record.id}:${kind}`));
	assert.deepEqual(next, ["c-a:settled", "c-b:settled"]);
	routeChildEvent(child("c-a"), "event");
	assert.deepEqual(next.at(-1), "c-a:event");
});

test("releasing a sink that was already replaced does not unregister the new owner", () => {
	const releaseOld = claimSink(() => {});
	const got: string[] = [];
	claimSink((c, kind) => got.push(kind));
	releaseOld();
	routeChildEvent(child("c-a"), "settled");
	assert.deepEqual(got, ["settled"]);
});

test("a stashed run is taken once, with its state intact", () => {
	const h = handoff();
	leave(h, 60_000);
	const got = take();
	assert.equal(got, h);
	assert.equal(got!.escalationOffset, 42);
	assert.equal(take(), null, "only one instance can take it");
	assert.equal(h.abandoned, 0);
});

test("a handoff from different code is abandoned rather than adopted", () => {
	const h = handoff({ version: HANDOFF_VERSION + 1 });
	leave(h, 60_000);
	assert.equal(take(), null);
	assert.equal(h.abandoned, 1, "its children are stopped, as before this feature");
});

test("a handoff nobody takes is abandoned after the deadline", async () => {
	const h = handoff();
	leave(h, 20);
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(h.abandoned, 1);
	assert.equal(take(), null);
});

test("a taken handoff is never abandoned by its deadline", async () => {
	const h = handoff();
	leave(h, 20);
	take();
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(h.abandoned, 0);
});

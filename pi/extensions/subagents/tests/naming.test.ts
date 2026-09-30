import assert from "node:assert/strict";
import { test } from "node:test";
import { newChildId, normalizeName, resolveRecipient, unknownChildText } from "../naming.ts";
import * as text from "../text.ts";

test("normalizeName accepts slugs, folds case, treats blank as no name", () => {
	assert.equal(normalizeName(undefined), undefined);
	assert.equal(normalizeName("   "), undefined);
	assert.equal(normalizeName("cleanup"), "cleanup");
	assert.equal(normalizeName(" API-Tests "), "api-tests");
	assert.equal(normalizeName("a"), "a");
	assert.equal(normalizeName("x".repeat(32)), "x".repeat(32));
	for (const bad of ["-lead", "trail-", "has space", "../up", "a/b", "dots.no", "x".repeat(33), "é"]) {
		assert.throws(() => normalizeName(bad), /Invalid subagent name/, bad);
	}
});

test("newChildId suffixes the name, falls back to c-, and never reuses a taken id", () => {
	assert.match(newChildId("cleanup", new Set()), /^cleanup-[0-9a-f]{4}$/);
	assert.match(newChildId(undefined, new Set()), /^c-[0-9a-f]{4}$/);
	// Every 4-hex id taken: it must widen rather than collide or spin forever.
	const all = new Set(Array.from({ length: 65536 }, (_, i) => `x-${i.toString(16).padStart(4, "0")}`));
	assert.match(newChildId("x", all), /^x-[0-9a-f]{8}$/);
});

const kids = {
	"lead-0001": { id: "lead-0001", name: "lead", team: "api" },
	"cleanup-aaaa": { id: "cleanup-aaaa", name: "cleanup", team: "api" },
	"cleanup-bbbb": { id: "cleanup-bbbb", name: "cleanup", team: "ui" },
	"cleanup-cccc": { id: "cleanup-cccc", name: "cleanup", team: "ui" },
	"ui-lead-0002": { id: "ui-lead-0002", name: "ui-lead", team: "ui" },
	"c-9b02": { id: "c-9b02", team: "api" },
};

test("resolveRecipient: a name unique on the sender's team resolves to its full id", () => {
	// Two other cleanups exist, but on another team: not in scope.
	assert.equal(resolveRecipient(kids, "lead-0001", "cleanup"), "cleanup-aaaa");
	assert.equal(resolveRecipient(kids, "lead-0001", "cleanup-aaaa"), "cleanup-aaaa", "full id passes through");
	assert.equal(resolveRecipient(kids, "lead-0001", "c-9b02"), "c-9b02", "unnamed children by id");
});

test("resolveRecipient: a tie on the team is refused with the full ids", () => {
	assert.throws(() => resolveRecipient(kids, "ui-lead-0002", "cleanup"), /"cleanup" is ambiguous on team ui: cleanup-bbbb, cleanup-cccc\. Use the full ID\./);
	assert.equal(resolveRecipient(kids, "ui-lead-0002", "cleanup-cccc"), "cleanup-cccc");
});

test("resolveRecipient: other teams, yourself and unknown names are left to the caller", () => {
	assert.equal(resolveRecipient(kids, "lead-0001", "ui-lead"), "ui-lead", "name on another team does not resolve");
	assert.equal(resolveRecipient(kids, "cleanup-aaaa", "cleanup"), "cleanup", "your own name is not a teammate");
	assert.equal(resolveRecipient(kids, "lead-0001", "nobody"), "nobody");
	assert.equal(resolveRecipient(kids, "ghost", "cleanup"), "cleanup");
});

test("unknownChildText points the orchestrator from a bare name to the full ids", () => {
	const recs = Object.values(kids);
	assert.equal(unknownChildText("cleanup", recs), 'Unknown subagent "cleanup". Subagents are addressed by full ID: cleanup-aaaa, cleanup-bbbb, cleanup-cccc.');
	assert.match(unknownChildText("zzz", recs), /^Unknown subagent "zzz"\. Known: lead-0001, cleanup-aaaa/);
	assert.equal(unknownChildText("zzz", []), 'Unknown subagent "zzz". Known: (none)');
});

test("spawn and message_team schemas describe naming", () => {
	assert.equal(text.SPAWN_SPEC.parameters.properties.name.type, "string");
	assert.ok(!text.SPAWN_SPEC.parameters.required.includes("name"));
	assert.match(text.SPAWN_SPEC.parameters.properties.name.description, /cleanup-3a1f/);
	assert.match(text.MESSAGE_TEAM_SPEC.parameters.properties.to.description, /just its name/);
	const agent = { name: "worker", description: "", prompt: "p", source: "test" };
	assert.match(text.childSystemPrompt(agent, [], "BOARD.md", { name: "api", goal: "g" }), /by name alone when no other teammate/);
});

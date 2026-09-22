/**
 * Single source of truth for every byte this extension puts into any context
 * window — parent or child.
 *
 * index.ts and guard.ts register tools from these specs; spawn.ts builds child
 * system prompts from these builders; info.ts reports on them. Nothing here is
 * duplicated elsewhere, so `/subagents-info` cannot drift from reality.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentDef } from "./types.ts";

export interface ToolSpec {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	// biome-ignore lint/suspicious/noExplicitAny: typebox schema, spread into registerTool
	parameters: any;
}

// ---------------------------------------------------------------------------
// Parent-side tools (only ever visible to the top-level agent)
// ---------------------------------------------------------------------------

export const SPAWN_SPEC: ToolSpec = {
	name: "subagent_spawn",
	label: "Spawn subagent",
	description:
		"Run a scoped task in an independent pi session; returns a handle at once. The child has " +
		"its own context window, so none of its intermediate work reaches yours.\n\n" +
		"Give it an objective, an output format, and boundaries — vague tasks produce misaimed work.\n\n" +
		"Most tasks need no subagent. Fan out reads freely; prefer ONE writer — two writers wanting " +
		"the same files should be merged into one child. If a finished child already knows this " +
		"code, subagent_followup is cheaper.",
	promptSnippet: "Start a background subagent on a scoped task and return a handle",
	promptGuidelines: [
		"Use subagent_spawn for work whose intermediate output you do not need to see — broad searches, isolated implementation, verification runs.",
		"Prefer 2-4 concurrent subagents at most; needing more is a sign the work should be consolidated.",
		"Give every subagent_spawn call a concrete objective and output format, not a topic.",
	],
	parameters: Type.Object({
		agent: Type.String({ description: "Agent name (e.g. worker, scout)" }),
		task: Type.String({ description: "Objective, output format, and boundaries" }),
		writes: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Write claim as directory globs relative to repo root, not file lists. Omit for a " +
					"read-only child. Two running children may not overlap; an overlapping spawn is refused.",
			}),
		),
		reads: Type.Optional(Type.Array(Type.String(), { description: "Advisory: areas this child will read" })),
		cwd: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
	}),
};

export const PEEK_SPEC: ToolSpec = {
	name: "subagent_peek",
	label: "Peek at subagents",
	description:
		"Bounded view of running subagents. Omit `id` for a one-line status of every child. " +
		"Levels: status (~40 tok), digest (~150), tail (~800), final (~2000). Never returns a " +
		"transcript — to read one, open the session file printed by level=final.",
	promptSnippet: "Check on running subagents without pulling in their transcripts",
	promptGuidelines: [
		"Do not call subagent_peek to answer a question you already know the answer to; you are notified automatically when a subagent finishes.",
	],
	parameters: Type.Object({
		id: Type.Optional(Type.String()),
		level: Type.Optional(StringEnum(["status", "digest", "tail", "final"] as const, { default: "digest" })),
		limit: Type.Optional(Type.Number()),
	}),
};

export const COLLECT_SPEC: ToolSpec = {
	name: "subagent_collect",
	label: "Collect subagents",
	description:
		"Wait for subagents to finish and return only their final results plus artifact paths. " +
		"Returns early — with everything known so far — if a subagent needs a decision from you, " +
		"or on timeout. Never throws.",
	promptSnippet: "Wait for subagents and collect their final results",
	parameters: Type.Object({
		ids: Type.Optional(Type.Array(Type.String(), { description: "Omit to wait for all running children" })),
		timeoutMs: Type.Optional(Type.Number()),
	}),
};

export const FOLLOWUP_SPEC: ToolSpec = {
	name: "subagent_followup",
	label: "Follow up with subagent",
	description:
		"Continue a subagent in its existing session, keeping everything it learned.\n\n" +
		"Prefer this over subagent_spawn whenever the work continues what that child already did — " +
		"fixing its mistake, extending its change, answering a question about its findings. A fresh " +
		"child must rediscover the same files. Spawn instead when the new work is unrelated.\n\n" +
		"Its write claim is re-acquired on resume, so the same conflict rules apply as for a spawn.",
	promptSnippet: "Send a follow-up request to a finished subagent, reusing its context",
	promptGuidelines: [
		"Prefer subagent_followup over a new subagent_spawn when a finished child already understands the relevant code; re-explaining context to a fresh child is usually the more expensive option.",
	],
	parameters: Type.Object({
		id: Type.String({ description: "The finished subagent to continue (e.g. c-3a1f)" }),
		task: Type.String({ description: "The follow-up request. It already knows what it did." }),
		writes: Type.Optional(
			Type.Array(Type.String(), {
				description: "New write claim. Omit to re-acquire the claim it had before.",
			}),
		),
		compact: Type.Optional(
			Type.Boolean({ description: "Summarize its history before the new turn. Default false." }),
		),
		interrupt: Type.Optional(
			Type.Boolean({
				description:
					"Stop the child now if it is still running, then resume it with this task. " +
					"Its work so far is kept. Default false (a running child is refused).",
			}),
		),
	}),
};

export const STOP_SPEC: ToolSpec = {
	name: "subagent_stop",
	label: "Stop subagent",
	description:
		"Stop a running subagent and release its territory. Use when it is looping, working from a " +
		"wrong premise, or now redundant. Not destructive — its transcript and partial result are " +
		"kept and subagent_followup can restart it. To redirect rather than end it, use " +
		"subagent_followup({ interrupt: true }).",
	promptSnippet: "Stop a running subagent and free its write claim",
	promptGuidelines: [
		"Stop a subagent as soon as you know its work is wasted; a running child keeps spending and keeps its territory locked.",
	],
	parameters: Type.Object({
		id: Type.String({ description: "The subagent to stop (e.g. c-3a1f). Use 'all' to stop every running child." }),
		reason: Type.Optional(
			Type.String({ description: "Recorded in the run log and shown to the user." }),
		),
	}),
};

export const PARENT_SPECS = [SPAWN_SPEC, PEEK_SPEC, COLLECT_SPEC, FOLLOWUP_SPEC, STOP_SPEC];

// ---------------------------------------------------------------------------
// Child-side tools (registered by guard.ts, only inside a managed child)
// ---------------------------------------------------------------------------

export const CLAIM_SPEC: ToolSpec = {
	name: "claim_paths",
	label: "Claim paths",
	description:
		"Request write access to paths outside your current claim. Granted immediately if no " +
		"other running agent owns them; otherwise waits for the owner to release them. Use " +
		"directory globs (src/foo/**) rather than long file lists.",
	promptSnippet: "Request write access to additional paths",
	parameters: Type.Object({
		paths: Type.Array(Type.String(), { description: "Globs relative to the project root" }),
		why: Type.String({ description: "One sentence: why you need these" }),
	}),
};

export const RELEASE_SPEC: ToolSpec = {
	name: "release_paths",
	label: "Release paths",
	description:
		"Give up write access to paths you are finished with, so a waiting sibling can proceed. " +
		"Call this as soon as you finish a file or directory — do not hold territory until you exit.",
	promptSnippet: "Release paths you have finished with",
	parameters: Type.Object({
		paths: Type.Array(Type.String(), { description: "Globs to release, or ['*'] for all of them" }),
	}),
};

export const NOTE_SPEC: ToolSpec = {
	name: "note",
	label: "Share a finding",
	description:
		"Record something a sibling agent would otherwise have to rediscover: a root cause, a " +
		"gotcha, a file that matters, a dead end worth not repeating. Append-only and shared " +
		"across all agents in this run.",
	promptSnippet: "Share a finding with the other running agents",
	parameters: Type.Object({
		text: Type.String({ description: "The finding, one or two sentences, concrete" }),
		paths: Type.Optional(Type.Array(Type.String(), { description: "Relevant file paths" })),
	}),
};

export const NOTES_SPEC: ToolSpec = {
	name: "notes",
	label: "Read findings",
	description:
		"Read findings shared by the other agents in this run. Call this before any non-trivial " +
		"investigation — someone may have already answered your question.",
	promptSnippet: "Read findings shared by other running agents",
	parameters: Type.Object({
		grep: Type.Optional(Type.String({ description: "Case-insensitive filter" })),
		limit: Type.Optional(Type.Number({ description: "Max entries, default 20" })),
	}),
};

export const REQUEST_EDIT_SPEC: ToolSpec = {
	name: "request_edit",
	label: "Request shared-file edit",
	description:
		"Request a change to a shared file (lockfile, manifest, schema) that no agent may write " +
		"directly. The orchestrator applies these serially after you finish.",
	promptSnippet: "Request an edit to a shared file you may not write",
	parameters: Type.Object({
		path: Type.String(),
		patch: Type.String({ description: "The exact change: a diff, or a precise description" }),
		why: Type.String(),
	}),
};

export const CHILD_SPECS = [CLAIM_SPEC, RELEASE_SPEC, NOTE_SPEC, NOTES_SPEC, REQUEST_EDIT_SPEC];

/** A read-only child never receives the claim/release/request tools at all. */
export const READONLY_CHILD_SPECS = [NOTE_SPEC, NOTES_SPEC];
export const WRITER_CHILD_SPECS = CHILD_SPECS;

export function childToolNames(readOnly: boolean): string[] {
	return (readOnly ? READONLY_CHILD_SPECS : WRITER_CHILD_SPECS).map((s) => s.name);
}

export const CHILD_TOOL_NAMES = CHILD_SPECS.map((s) => s.name);

// ---------------------------------------------------------------------------
// The collective preamble appended to every child's system prompt
// ---------------------------------------------------------------------------

export function collectivePreamble(claim: string[], boardRelPath: string): string {
	const claimText = claim.length ? claim.join(", ") : "(none — you are read-only)";
	const readOnly = claim.length === 0;

	// Deliberately terse: every coordination tool already carries its own
	// description in this child's context, so re-explaining them here is paid
	// twice on every request. This states only what a tool description cannot --
	// the claim, the prohibition, and when to reach for them.
	return `---

## Other agents are editing this repository right now

You see their work only through \`${boardRelPath}\` and \`notes()\` — check both
before any non-trivial investigation; a sibling may have answered it already.

**Your write claim:** ${claimText}

${
	readOnly
		? `Every write and edit is blocked by design — investigate and report, do not
change files.`
		: `Writes outside it are blocked at the tool layer. Never route around that with
bash: it silently destroys a colleague's work. Use \`claim_paths\` to widen,
\`release_paths\` the moment you finish with part of your territory, and
\`request_edit\` for shared files nobody may write directly.`
}

Call \`note(text, paths)\` whenever you learn something a sibling would otherwise
rediscover — cheap for you, expensive for them.

**Your final message is the only thing the orchestrator reads.** Make it
self-contained: what you did, what you verified, what you could not do and why.
`;
}

export function childSystemPrompt(agent: AgentDef, claim: string[], boardRelPath: string): string {
	return `${agent.prompt}\n\n${collectivePreamble(claim, boardRelPath)}`;
}

// ---------------------------------------------------------------------------
// Runtime-injected text. These DO cost parent tokens, so they are counted too.
// ---------------------------------------------------------------------------

export const RUNTIME_TEMPLATES: { name: string; when: string; channel: string; sample: string }[] = [
	{
		name: "completion digest",
		when: "a subagent finishes",
		channel: 'pi.sendMessage(deliverAs:"nextTurn") — queued, non-interrupting',
		sample:
			`[subagent c-3a1f done] worker: Added refresh-token rotation in src/auth/rotate.ts; ` +
			`migration added; 14 tests pass. Could not update package.json (shared file) — ` +
			`filed a request_edit.\n` +
			`full result: subagent_peek({ id: "c-3a1f", level: "final" })`,
	},
	{
		name: "escalation / needs decision (FACT)",
		when: "claim timeout or repeated claim blocks — the child has stopped and cannot continue alone",
		channel: 'pi.sendMessage(deliverAs:"followUp", triggerTurn:true) — interrupts, OR returned as the subagent_collect result if a collect is in flight',
		sample:
			`[subagents] 1 issue(s) need a decision:\n` +
			`- [claim_timeout] c-3a1f blocked by c-9b02 on db/migrations/**: waited 120s for c-9b02\n` +
			`This is a territory conflict: subagent_collect the child holding the claim, ` +
			`re-partition the work, or let the blocked child finish with a partial result.`,
	},
	{
		name: "advisory (GUESS)",
		when: "stuck heuristic fires: idle >90s, repeated identical tool call, or consecutive tool errors — the child is still running",
		channel:
			"widget row only (0 tok, never triggers a turn); also listed in a subagent_collect result you asked for",
		sample: `  c-3a1f     worker      47s  owns[src/api/**] · read · ⚠ no activity for 94s`,
	},
	{
		name: "spawn handle",
		when: "subagent_spawn succeeds",
		channel: "tool result",
		sample:
			`c-3a1f started (worker) · owns[src/auth/**]\n` +
			`Running in the background. Continue working; you will be told when it finishes.\n` +
			`board: .pi/runs/a1b2c3d4/BOARD.md`,
	},
	{
		name: "admission refusal",
		when: "subagent_spawn claims territory another running child owns",
		channel: "tool result (isError)",
		sample:
			`Write conflict: "src/auth/**" overlaps "src/auth/jwt.ts", already claimed by child ` +
			`c-9b02 ("wire session endpoints", running 84s).\nResolve by one of:\n` +
			`  1. subagent_collect({ ids: ["c-9b02"] }) and then spawn this one, or\n` +
			`  2. re-partition so the two children own disjoint paths, or\n` +
			`  3. merge the two tasks into one child (overlapping ownership usually means\n` +
			`     they share a mental model and should not have been split).`,
	},
];

export const GUARD_TEMPLATES: { name: string; when: string; sample: string }[] = [
	{
		name: "outside claim",
		when: "child calls write/edit, or a bash command that appears to write, outside its claim",
		sample:
			`"src/api/routes.ts" is outside your write claim (src/auth/**). It is currently owned ` +
			`by child c-9b02.\nDo NOT work around this with bash — that silently destroys another ` +
			`agent's work.\nEither call claim_paths(["src/api/routes.ts"], "<why>") (you will wait ` +
			`for c-9b02 to release it), or stay inside your claim and report the need in your ` +
			`final message.`,
	},
	{
		name: "shared file",
		when: "child attempts to write a file in sharedPaths (lockfiles, manifests, schemas)",
		sample:
			`"package.json" is a shared file that no agent may write directly (other agents depend ` +
			`on it concurrently). Use request_edit("package.json", <patch>, <why>) instead and the ` +
			`orchestrator will apply it serially.`,
	},
	{
		name: "outside project root",
		when: "child attempts any write resolving outside the repository root",
		sample: `"../../etc/hosts" is outside the project root. Refused.`,
	},
	{
		name: "claim granted",
		when: "claim_paths succeeds (tier 1, uncontested)",
		sample:
			`Granted. Your claim is now: src/auth/**, db/migrations/**\n` +
			`Release with release_paths() as soon as you are done with any of it.`,
	},
	{
		name: "claim timeout",
		when: "claim_paths waits 120s and the holder never releases (tier 3)",
		sample:
			`Not granted: c-9b02 still owns these paths after 120s ("wire session endpoints").\n` +
			`The orchestrator has been notified. Do not keep retrying and do not use bash to work ` +
			`around it. Complete whatever you can inside your existing claim, then stop and state ` +
			`clearly in your final message that you still need: db/migrations/**`,
	},
];

export const BOARD_RULES_SAMPLE = `## Rules

- Write **only** inside your own claim. Writes outside it are blocked, not warned.
- Need another path? \`claim_paths([...], why)\`. Usually granted instantly.
- Finished with part of your territory? \`release_paths([...])\` so siblings can proceed.
- Learned something a sibling would otherwise rediscover? \`note(text, paths)\`.
- **Never** edit this file. It is regenerated automatically and your edits will vanish.`;

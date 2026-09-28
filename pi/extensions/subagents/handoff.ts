/**
 * Keeps running subagents alive across /reload.
 *
 * /reload shuts the old extension instance down, re-imports the code, then
 * starts a new instance in the SAME process. Children are OS processes whose
 * stdout is read by callbacks created by the old instance; those callbacks keep
 * running after the reload. So instead of killing the children, the old
 * instance leaves its run here and the new instance takes it over.
 *
 * Two pieces, both on globalThis because the old and new instances are
 * different module copies:
 *   - an event route: children's callbacks always go to whichever instance owns
 *     the run now. Between owners, settles are buffered and replayed; progress
 *     events are dropped (the next one redraws everything).
 *   - the handoff: the run's state, taken exactly once. A handoff nobody takes
 *     (the new code failed to load, or the extension was removed) is abandoned
 *     after a deadline, which stops the children as a plain reload used to.
 *
 * The shape of `G[KEY]` must stay compatible across versions, since old code
 * reads it after new code wrote it. Bump HANDOFF_VERSION whenever the handoff
 * contents or LiveChild/ChildRecord change incompatibly: a mismatched handoff is
 * abandoned rather than adopted.
 */

import type { ChildProcess } from "node:child_process";
import type { FinishedChild } from "./completion.ts";
import type { Escalation, LiveChild } from "./types.ts";

export const HANDOFF_VERSION = 1;

export type Sink = (child: LiveChild, kind: string) => void;

export interface Handoff {
	version: number;
	runId: string;
	runDir: string;
	root: string;
	live: Map<string, LiveChild>;
	procs: Map<string, ChildProcess>;
	advisories: Map<string, Escalation[]>;
	/** `${id}:${generation}` of children the parent stopped. */
	stoppedByParent: string[];
	escalationOffset: number;
	/** Completion messages the old instance had not sent yet. */
	pendingCompletions: FinishedChild[];
	/** Stop every child (the pre-handoff behaviour). Provided by the old instance. */
	abandon: () => void;
}

interface Slot {
	sink: Sink | null;
	buffered: [LiveChild, string][];
	handoff: Handoff | null;
	deadline: ReturnType<typeof setTimeout> | null;
}

const KEY = Symbol.for("pi-subagents.runtime");
/** Settles buffered while no instance owns the run; far above any real fleet. */
const MAX_BUFFERED = 256;

function slot(): Slot {
	const g = globalThis as unknown as Record<symbol, Slot | undefined>;
	return (g[KEY] ??= { sink: null, buffered: [], handoff: null, deadline: null });
}

/** The onEvent every child is launched with. */
export function routeChildEvent(child: LiveChild, kind: string): void {
	const s = slot();
	if (s.sink) {
		s.sink(child, kind);
		return;
	}
	if (kind === "settled" && s.buffered.length < MAX_BUFFERED) s.buffered.push([child, kind]);
}

/**
 * Become the owner of child events. Replays settles that arrived while nobody
 * owned them. Returns a release that is a no-op once another owner took over.
 */
export function claimSink(sink: Sink): () => void {
	const s = slot();
	s.sink = sink;
	for (const [child, kind] of s.buffered.splice(0)) sink(child, kind);
	return () => {
		if (s.sink === sink) s.sink = null;
	};
}

/** Leave a run for the next instance; abandoned if nobody takes it in time. */
export function leave(h: Handoff, deadlineMs: number): void {
	const s = slot();
	if (s.deadline) clearTimeout(s.deadline);
	s.handoff = h;
	s.deadline = setTimeout(() => {
		s.deadline = null;
		if (s.handoff !== h) return;
		s.handoff = null;
		h.abandon();
	}, deadlineMs);
	s.deadline.unref?.();
}

/** Take the run left by the previous instance, or null. */
export function take(): Handoff | null {
	const s = slot();
	const h = s.handoff;
	if (!h) return null;
	s.handoff = null;
	if (s.deadline) clearTimeout(s.deadline);
	s.deadline = null;
	if (h.version !== HANDOFF_VERSION) {
		// Different code produced these objects; adopting them could misbehave in
		// ways that are hard to see. Stopping them is the known-safe old behaviour.
		h.abandon();
		return null;
	}
	return h;
}

export function resetForTests(): void {
	const s = slot();
	if (s.deadline) clearTimeout(s.deadline);
	s.sink = null;
	s.buffered = [];
	s.handoff = null;
	s.deadline = null;
}

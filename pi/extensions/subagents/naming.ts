/**
 * naming.ts — child IDs, optional names, and short-name resolution.
 *
 * A child spawned with `name: "cleanup"` gets the ID `cleanup-3a1f`; without a
 * name it gets `c-3a1f`. The ID is the only handle anywhere: the orchestrator's
 * tools, the board, the fleet view and every message show and take it in full.
 *
 * The one convenience is `message_team`: a teammate may address `cleanup`
 * instead of `cleanup-3a1f` when exactly one agent on its own team carries that
 * name. Any tie is refused with the full IDs, so a short name never silently
 * picks the wrong agent.
 *
 * Pure: no pi imports, no I/O.
 */

/**
 * Lowercase letters, digits, `-` and `_`, starting and ending alphanumeric, at
 * most 32 chars. The ID doubles as a directory name, so nothing else is allowed.
 */
export const NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;

/** Unnamed children keep the historical `c-` prefix. */
const UNNAMED_PREFIX = "c";

/**
 * Validate an optional spawn name. Returns undefined for "no name" (absent or
 * blank). Uppercase is folded; anything else invalid throws with a message
 * meant for the orchestrator model.
 */
export function normalizeName(raw: unknown): string | undefined {
	if (raw == null) return undefined;
	const name = String(raw).trim().toLowerCase();
	if (!name) return undefined;
	if (!NAME_RE.test(name)) {
		throw new Error(
			`Invalid subagent name ${JSON.stringify(String(raw).slice(0, 40))}: use 1-32 lowercase letters, digits, ` +
				`"-" or "_", starting and ending with a letter or digit (e.g. "cleanup", "api-tests").`,
		);
	}
	return name;
}

function hex(len: number): string {
	let s = "";
	while (s.length < len) s += Math.random().toString(16).slice(2);
	return s.slice(0, len);
}

/** `<name>-<hex>` (or `c-<hex>`), never one of `taken`. */
export function newChildId(name: string | undefined, taken: ReadonlySet<string>): string {
	const prefix = name ?? UNNAMED_PREFIX;
	for (let attempt = 0; ; attempt++) {
		// 4 hex digits is plenty per run; widen only if a run is somehow crowded.
		const id = `${prefix}-${hex(attempt < 20 ? 4 : 8)}`;
		if (!taken.has(id)) return id;
	}
}

/** The fields resolution needs from a child record. */
export interface NamedChild {
	id: string;
	name?: string;
	team?: string;
}

const teamOf = (c: NamedChild) => (c.team && c.team.trim() ? c.team : "none");

/**
 * Resolve a `message_team` recipient. An exact ID always wins. Otherwise `to`
 * is taken as a name and must match exactly one other member of the sender's
 * team, whatever that member's state. Returns the full ID, or throws with the
 * candidates' full IDs. Returns `to` unchanged when nothing matches, so the
 * caller's own "no such agent" message applies.
 */
export function resolveRecipient(children: Record<string, NamedChild>, senderId: string, to: string): string {
	if (children[to]) return to;
	const sender = children[senderId];
	if (!sender) return to;
	const team = teamOf(sender);
	const matches = Object.values(children)
		.filter((c) => c.id !== senderId && c.name === to && teamOf(c) === team)
		.map((c) => c.id)
		.sort();
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) {
		throw new Error(`"${to}" is ambiguous on team ${team}: ${matches.join(", ")}. Use the full ID.`);
	}
	return to;
}

/**
 * Error text for an orchestrator tool given an ID it does not know. If the
 * value is a bare name, point at the full IDs carrying it; the orchestrator
 * always addresses children by full ID.
 */
export function unknownChildText(given: string, known: Iterable<{ id: string; name?: string }>): string {
	const all = [...known];
	const named = all.filter((c) => c.name === given).map((c) => c.id);
	if (named.length) {
		return `Unknown subagent "${given}". Subagents are addressed by full ID: ${named.join(", ")}.`;
	}
	return `Unknown subagent "${given}". Known: ${all.map((c) => c.id).join(", ") || "(none)"}`;
}

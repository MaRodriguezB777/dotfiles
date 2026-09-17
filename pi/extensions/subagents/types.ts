/**
 * Shared types for the subagents extension.
 *
 * Design note: the registry is a *file* protected by an on-disk lock, not an
 * in-memory structure owned by the parent. That is deliberate — it lets a child
 * process arbitrate its own claim amendments (tiers 1 and 2) with zero parent
 * involvement and zero IPC. The parent is only needed for tier 3.
 */

/**
 * "orphaned" is distinct from "killed" on purpose: killed means the parent
 * deliberately stopped it at shutdown, orphaned means the parent died and the
 * child stood itself down. Only the latter is a candidate for resumption.
 */
export type ChildState = "running" | "done" | "failed" | "killed" | "orphaned";

export interface ChildRecord {
	id: string;
	agent: string;
	task: string;
	/** Write claim, as globs relative to the run root. Empty = read-only. */
	writes: string[];
	/** Advisory only; shown on the board so siblings can avoid duplicate reading. */
	reads: string[];
	cwd: string;
	pid: number | null;
	state: ChildState;
	startedAt: number;
	endedAt: number | null;
	sessionFile: string | null;
	sessionId: string | null;
	/** Resolved at spawn and reused on follow-up, so a child never silently swaps models. */
	model: string | null;
	thinking: string | null;
	resultPath: string;
	exitCode: number | null;
	/** 1 for the initial run, incremented by each subagent_followup. */
	generation: number;
}

export interface Registry {
	runId: string;
	root: string;
	children: Record<string, ChildRecord>;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface ToolTrace {
	name: string;
	brief: string;
	isError: boolean;
	at: number;
}

/** Live, in-parent-memory view of a running child. Never persisted wholesale. */
export interface LiveChild {
	record: ChildRecord;
	/** Cumulative across all generations, so cost never appears to reset. */
	usage: Usage;
	tools: ToolTrace[];
	/** Last few finalized messages, already truncated at capture time. */
	tail: { role: string; text: string; at: number }[];
	lastText: string;
	lastEventAt: number;
	startedAt: number;
	consecutiveErrors: number;
	repeatSignature: string | null;
	repeatCount: number;
	blockCount: number;
	stderr: string;
	stuckNotified: boolean;
	settled: boolean;
	onSettle: (() => void)[];
}

export interface Escalation {
	kind: "deadlock" | "claim_timeout" | "stuck" | "blocked_repeatedly";
	child: string;
	paths?: string[];
	holder?: string;
	detail: string;
	at: number;
}

export interface AgentDef {
	name: string;
	description: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	/** Denylist. Preferred over `tools`, which silently strips extension tools. */
	excludeTools?: string[];
	/** Load the user's normal extension set in the child. Default false. */
	inheritExtensions?: boolean;
	/**
	 * Override the global childExtensions list for this agent.
	 * undefined = use the global list; [] = only the auth adapter + guard.
	 */
	extensions?: string[];
	prompt: string;
	source: string;
}

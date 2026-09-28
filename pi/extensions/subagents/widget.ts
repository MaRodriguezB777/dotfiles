/**
 * The status widget under the editor: a glance, not a report. One header, the
 * oldest few running children on one line each, and a count of the rest.
 * Full claims and every child are in /subagents and /subagents-fleet.
 */

/** Running children listed individually; the rest become "+N more". */
export const WIDGET_ROWS = 3;
/** Keeps every row on one line in a normal terminal. */
const ROW_WIDTH = 80;

export interface WidgetChild {
	id: string;
	agent: string;
	writes: string[];
	startedAt: number;
	/** Latest tool the child called. */
	tool?: string;
	/** Latest stuck advisory, shown until asked about. */
	advisory?: string;
}

function cut(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** "owns scripts/world/** +2": first path and how many others. */
export function briefOwns(writes: string[]): string {
	if (!writes.length) return "read-only";
	const more = writes.length > 1 ? ` +${writes.length - 1}` : "";
	return `owns ${cut(writes[0], 34 - more.length)}${more}`;
}

function elapsed(ms: number): string {
	const secs = Math.round(ms / 1000);
	return secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`;
}

export function widgetLines(opts: { running: WidgetChild[]; done: number; spent: number; now: number }): string[] {
	const { running, done, spent, now } = opts;
	const idW = Math.max(...running.map((c) => c.id.length), 0);
	const lines = [`subagents: ${running.length} active${done ? ` · ${done} done` : ""} · $${spent.toFixed(3)} spent`];
	const oldestFirst = [...running].sort((a, b) => a.startedAt - b.startedAt);
	for (const c of oldestFirst.slice(0, WIDGET_ROWS)) {
		let row =
			`  ${c.id.padEnd(idW)}  ${c.agent.padEnd(8)} ${elapsed(now - c.startedAt).padStart(4)}  ${briefOwns(c.writes)}` +
			(c.tool ? ` · ${c.tool}` : "");
		if (c.advisory) row += ` · ⚠ ${c.advisory}`;
		lines.push(cut(row, ROW_WIDTH));
	}
	if (running.length > WIDGET_ROWS) lines.push(`  +${running.length - WIDGET_ROWS} more — /subagents for all`);
	return lines;
}

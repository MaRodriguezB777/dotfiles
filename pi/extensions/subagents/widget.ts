/**
 * The live panel above the editor: a glance, not a report.
 *
 *   ⠹ Subagents · 4 running · 3 done · $12.40
 *   ├─ audio  2 running · 1 done
 *   │  ├─ ⠹ c-2ce6 worker · 3 tools · 1m 12s
 *   │  │  └ bash npm test
 *   │  ├─ ✓ c-36ef scout · 9 tools · 4m 02s
 *   │  └─ +2 more
 *   └─ +1 more team (3 agents)
 *
 * Teams group their members (flat when no child has a team). Running agents
 * come first and show what they are doing right now underneath. The panel is
 * bounded: a few members per team, a fixed line budget, and counts for the rest.
 * Everything else lives in /subagents and /subagents-fleet.
 */

import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** pi's own loader frames and speed, so the panel spins like "Working…". */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPIN_MS = 80;
/** Members listed per team before "+X more". */
const PER_TEAM = 3;
/** Lines under the header, overflow lines included. */
const BODY_LINES = 13;
/** Below either size, show one line per team instead of the agent tree. */
export const COMPACT_ROWS = 36;
export const COMPACT_WIDTH = 64;
/** Team lines in compact mode before "+N more teams". */
const COMPACT_TEAMS = 5;

export interface PanelTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface PanelChild {
	id: string;
	agent: string;
	/** "none" when the child has no team. */
	team: string;
	state: string;
	writes: string[];
	startedAt: number;
	endedAt: number | null;
	/** Tool calls so far; undefined when this child's handler does not count them. */
	toolCount?: number;
	cost: number;
	/**
	 * The agent loop has started (pi loaded, first turn begun). Undefined when
	 * not tracked: children adopted across /reload keep the event handler of
	 * the code that launched them, which records neither this nor `activity`.
	 */
	begun?: boolean;
	/** Tool running right now ("bash npm test"); absent while the model is thinking. */
	activity?: string;
	/** Most recent finished tool, shown when `begun`/`activity` are not tracked. */
	lastTool?: { text: string; at: number };
	/** Latest stuck advisory, shown until asked about. */
	advisory?: string;
}

export interface PanelInput {
	children: PanelChild[];
	/** Session total, finished children included, so it never drops. */
	spent: number;
	now: number;
}

/** "owns scripts/world/** +2": first path and how many others. */
export function briefOwns(writes: string[]): string {
	if (!writes.length) return "read-only";
	return `owns ${writes[0]}${writes.length > 1 ? ` +${writes.length - 1}` : ""}`;
}

function elapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const running = (c: PanelChild) => c.state === "running";

function mark(c: PanelChild, now: number, theme: PanelTheme): string {
	switch (c.state) {
		case "running":
			return theme.fg("accent", SPINNER[Math.floor(now / SPIN_MS) % SPINNER.length]);
		case "done":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "killed":
			return theme.fg("muted", "■");
		default:
			return theme.fg("warning", "◌");
	}
}

/** Running first (oldest first), then failures, then the most recently finished. */
function order(a: PanelChild, b: PanelChild): number {
	if (running(a) !== running(b)) return running(a) ? -1 : 1;
	if (running(a)) return a.startedAt - b.startedAt;
	const failed = (c: PanelChild) => (c.state === "failed" ? 0 : 1);
	return failed(a) - failed(b) || (b.endedAt ?? 0) - (a.endedAt ?? 0);
}

function counts(members: PanelChild[]): string {
	const r = members.filter(running).length;
	const d = members.length - r;
	return [r ? `${r} running` : "", d ? `${d} done` : ""].filter(Boolean).join(" · ");
}

/** One agent row; drops owns, then tool count, then time before cutting. */
function agentRow(prefix: string, c: PanelChild, input: PanelInput, width: number, theme: PanelTheme): string {
	const head = `${prefix}${mark(c, input.now, theme)} ${theme.bold(c.id)} ${theme.fg("dim", c.agent)}`;
	const time = elapsed((c.endedAt ?? input.now) - c.startedAt);
	const tools = c.toolCount === undefined ? "" : plural(c.toolCount, "tool");
	const owns = c.writes.length ? briefOwns(c.writes) : "";
	const tries = [[tools, time, owns], [tools, time], [time], []].map((parts) => parts.filter(Boolean));
	for (const parts of tries) {
		const line = parts.length ? `${head}${theme.fg("dim", ` · ${parts.join(" · ")}`)}` : head;
		if (visibleWidth(line) <= width) return line;
	}
	return truncateToWidth(head, width, "…");
}

function activityRow(prefix: string, c: PanelChild, now: number, width: number, theme: PanelTheme): string {
	const one = (t: string) => t.replace(/\s+/g, " ");
	const doing =
		c.begun === undefined
			? c.lastTool
				? `last: ${one(c.lastTool.text)} · ${elapsed(now - c.lastTool.at)} ago`
				: "working…"
			: c.activity
				? one(c.activity)
				: c.begun
					? "thinking…"
					: "starting…";
	const what = theme.fg("muted", doing);
	const adv = c.advisory ? theme.fg("warning", ` · ⚠ ${c.advisory}`) : "";
	return truncateToWidth(`${prefix}└ ${what}${adv}`, width, "…");
}

/** Lines one member takes: its row, plus an activity line while it runs. */
const cost = (c: PanelChild) => (running(c) ? 2 : 1);

interface Group {
	name: string;
	members: PanelChild[];
}

function groupsOf(children: PanelChild[]): Group[] {
	const byTeam = new Map<string, PanelChild[]>();
	for (const c of children) byTeam.set(c.team, [...(byTeam.get(c.team) ?? []), c]);
	const groups = [...byTeam].map(([name, members]) => ({ name, members: members.sort(order) }));
	const latest = (g: Group) => Math.max(...g.members.map((c) => c.endedAt ?? c.startedAt));
	// Busiest team first; children without a team always last.
	return groups.sort(
		(a, b) =>
			Number(a.name === "none") - Number(b.name === "none") ||
			b.members.filter(running).length - a.members.filter(running).length ||
			latest(b) - latest(a),
	);
}

/** How many of `members` fit in `avail` lines, keeping a line for "+X more" if any are left out. */
function fitMembers(members: PanelChild[], avail: number, cap: number): number {
	for (let k = Math.min(cap, members.length); k >= 1; k--) {
		const lines = members.slice(0, k).reduce((n, c) => n + cost(c), 0) + (k < members.length ? 1 : 0);
		if (lines <= avail) return k;
	}
	return 0;
}

/** One line per team: state, agent count, cost, time alive. */
function compactLines(groups: Group[], input: PanelInput, width: number, theme: PanelTheme): string[] {
	const branch = (last: boolean) => theme.fg("borderMuted", last ? "└─ " : "├─ ");
	const fit = groups.length > COMPACT_TEAMS ? COMPACT_TEAMS - 1 : groups.length;
	const out: string[] = [];
	groups.slice(0, fit).forEach((g, i) => {
		const last = i === groups.length - 1;
		const live = g.members.some(running);
		const markText = live
			? theme.fg("accent", SPINNER[Math.floor(input.now / SPIN_MS) % SPINNER.length])
			: g.members.some((c) => c.state === "failed")
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");
		const start = Math.min(...g.members.map((c) => c.startedAt));
		const end = live ? input.now : Math.max(...g.members.map((c) => c.endedAt ?? input.now));
		const cost = g.members.reduce((n, c) => n + c.cost, 0);
		const name = g.name === "none" ? theme.fg("dim", "no team") : theme.bold(g.name);
		const stats = `${plural(g.members.length, "agent")} · $${cost.toFixed(2)} · ${elapsed(end - start)}`;
		out.push(truncateToWidth(`${branch(last)}${markText} ${name}  ${theme.fg("dim", stats)}`, width, "…"));
	});
	const hidden = groups.slice(fit);
	if (hidden.length) {
		const agents = hidden.reduce((n, g) => n + g.members.length, 0);
		const text = `+${hidden.length} more team${hidden.length === 1 ? "" : "s"} (${plural(agents, "agent")})`;
		out.push(truncateToWidth(`${branch(true)}${theme.fg("dim", text)}`, width, "…"));
	}
	return out;
}

/**
 * `rows` is the terminal height; with no height (tests, RPC) the panel
 * assumes a roomy terminal.
 */
export function panelLines(input: PanelInput, width: number, theme: PanelTheme, rows = Infinity): string[] {
	if (width <= 0) return [];
	const { children, now } = input;
	const nRunning = children.filter(running).length;
	const header =
		`${nRunning ? theme.fg("accent", SPINNER[Math.floor(now / SPIN_MS) % SPINNER.length]) : theme.fg("success", "✓")} ` +
		`${theme.bold(theme.fg("accent", "Subagents"))}` +
		theme.fg("dim", ` · ${nRunning} running · ${children.length - nRunning} done · $${input.spent.toFixed(2)}`);
	const lines = [truncateToWidth(header, width, "…")];
	if (!children.length) return lines;

	const branch = (last: boolean) => theme.fg("borderMuted", last ? "└─ " : "├─ ");
	const rail = (last: boolean) => theme.fg("borderMuted", last ? "   " : "│  ");
	const groups = groupsOf(children);
	if (rows < COMPACT_ROWS || width < COMPACT_WIDTH) return [...lines, ...compactLines(groups, input, width, theme)];

	// Lay out first, then draw: whether an item is the last at its level
	// decides its branch glyph, and that depends on what overflows.
	type Shown = { group: Group; k: number };
	const shown: Shown[] = [];
	let left = BODY_LINES;

	if (groups.length === 1 && groups[0].name === "none") {
		// No teams: one flat list at the top level.
		const members = groups[0].members;
		const k = fitMembers(members, left, members.length);
		const items = members.slice(0, k);
		items.forEach((c, i) => {
			const last = i === items.length - 1 && k === members.length;
			lines.push(agentRow(branch(last), c, input, width, theme));
			if (running(c)) lines.push(activityRow(rail(last), c, now, width, theme));
		});
		if (k < members.length) lines.push(truncateToWidth(`${branch(true)}${theme.fg("dim", `+${members.length - k} more`)}`, width, "…"));
		return lines;
	}

	// Fair share: every shown team gets one member, then one more each per
	// round, a round applied only if it fits whole. Filling teams one after
	// another would give the first team everything and the rest nothing.
	const teamLines = (g: Group, k: number) =>
		1 + g.members.slice(0, k).reduce((n, c) => n + cost(c), 0) + (k < g.members.length ? 1 : 0);
	const total = (sel: Shown[], hiddenTeams: number) =>
		sel.reduce((n, x) => n + teamLines(x.group, x.k), 0) + (hiddenTeams ? 1 : 0);
	for (const group of groups) {
		const next = [...shown, { group, k: 1 }];
		if (total(next, groups.length - next.length) > left) break;
		shown.push({ group, k: 1 });
	}
	const nHidden = groups.length - shown.length;
	for (;;) {
		const growable = shown.filter((x) => x.k < Math.min(PER_TEAM, x.group.members.length));
		if (!growable.length) break;
		for (const x of growable) x.k++;
		if (total(shown, nHidden) <= left) continue;
		for (const x of growable) x.k--;
		break;
	}
	const hidden = groups.slice(shown.length);

	shown.forEach(({ group, k }, gi) => {
		const lastGroup = gi === shown.length - 1 && !hidden.length;
		const name = group.name === "none" ? theme.fg("dim", "no team") : theme.bold(group.name);
		lines.push(truncateToWidth(`${branch(lastGroup)}${name}  ${theme.fg("dim", counts(group.members))}`, width, "…"));
		const cont = rail(lastGroup);
		const more = group.members.length - k;
		group.members.slice(0, k).forEach((c, i) => {
			const last = i === k - 1 && !more;
			lines.push(agentRow(`${cont}${branch(last)}`, c, input, width, theme));
			if (running(c)) lines.push(activityRow(`${cont}${rail(last)}`, c, now, width, theme));
		});
		if (more) lines.push(truncateToWidth(`${cont}${branch(true)}${theme.fg("dim", `+${more} more`)}`, width, "…"));
	});
	if (hidden.length) {
		const agents = hidden.reduce((n, g) => n + g.members.length, 0);
		const text = `+${hidden.length} more team${hidden.length === 1 ? "" : "s"} (${plural(agents, "agent")})`;
		lines.push(truncateToWidth(`${branch(true)}${theme.fg("dim", text)}`, width, "…"));
	}
	return lines;
}

/**
 * The live component. Data is read at render time from `input`, and while any
 * child runs it repaints every SPIN_MS so the spinner turns and elapsed times
 * tick without any event having to arrive.
 */
export class SubagentPanel implements Component {
	private readonly tui: TUI;
	private readonly theme: PanelTheme;
	private readonly input: () => PanelInput;
	private readonly timer: NodeJS.Timeout;

	constructor(tui: TUI, theme: PanelTheme, input: () => PanelInput) {
		this.tui = tui;
		this.theme = theme;
		this.input = input;
		this.timer = setInterval(() => {
			if (this.input().children.some(running)) this.tui.requestRender();
		}, SPIN_MS);
		this.timer.unref?.();
	}

	/** Data changed while nothing spins (a child just finished): repaint now. */
	refresh(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return panelLines(this.input(), width, this.theme, this.tui.terminal?.rows ?? Infinity);
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}
}

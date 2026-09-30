/**
 * subagents — spawn, watch, and coordinate concurrent pi sessions.
 *
 * Three principles this file exists to enforce:
 *   1. A subagent is a context firewall. The parent holds handles and digests,
 *      never transcripts.
 *   2. Human observability (appendEntry) costs zero LLM tokens. Model
 *      observability (sendMessage) costs one line. Never conflate them.
 *   3. Never block on something only the blocked party can unblock — see
 *      `resolveCollects`, which is why an escalation during subagent_collect
 *      is delivered as the collect return value rather than an injected message.
 */

import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { discoverAgents } from "./agents.ts";
import { boardPath, countLines, writeBoard } from "./board.ts";
import { type SubagentsConfig, loadSettings, settingsTable } from "./config.ts";
import {
	type Ev,
	type FleetTheme,
	type InspectorState,
	buildItems,
	collectFleet,
	collectTeams,
	handleInspectorKey,
	itemKey,
	navPosition,
	readThreadMessages,
	readTranscript,
	renderInspector,
	type ThreadMessage,
	renderPlain,
} from "./fleet.ts";
import { buildInfoReport, buildInfoSummary } from "./info.ts";
import { newChildId, normalizeName, unknownChildText } from "./naming.ts";
import { type PeekLevel, digest, render, statusLine } from "./peek.ts";
import {
	admit,
	mutateRegistry,
	pidAlive,
	readRegistry,
	reap,
	rel,
	syncChildRecord,
	withLock,
	writeRegistry,
} from "./registry.ts";
import { launch } from "./spawn.ts";
import { widgetLines } from "./widget.ts";
import { createCompletionNotifier } from "./completion.ts";
import { HANDOFF_VERSION, claimSink, leave, routeChildEvent, take } from "./handoff.ts";
import { defineTeam, validateTeam, closeInbox, settleMessages, summary as messageSummary } from "./messaging/index.ts";
import { reconcileSessionFile } from "./team-runtime.ts";
import { COLLECT_SPEC, FOLLOWUP_SPEC, PEEK_SPEC, SPAWN_SPEC, STOP_SPEC, TEAM_SPEC } from "./text.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDef, ChildRecord, Escalation, LiveChild, Registry, Usage } from "./types.ts";

const PROGRESS_THROTTLE_MS = 1000;
const STUCK_IDLE_MS = 90_000;
const STUCK_REPEAT = 3;
const STUCK_ERRORS = 3;
const BLOCK_ESCALATE_AT = 3;
const DEFAULT_COLLECT_TIMEOUT = 600_000;
/** How long a /reload's run waits for the new instance before its children are stopped. */
const RELOAD_HANDOFF_MS = 30_000;

export default function (pi: ExtensionAPI) {
	// A managed child must never get the orchestration tools. Bailing out here
	// makes recursion structurally impossible rather than merely discouraged.
	if (process.env.PI_SUBAGENT_CHILD) return;

	// A /reload leaves the previous instance's run (and its still-running
	// children) behind for us; see handoff.ts.
	const adopted = take();

	// The project root is the SESSION's cwd (ctx.cwd), which is not necessarily
	// pi's process cwd: pi launched from $HOME can run a session in a project.
	// Until a context arrives, the process cwd is the best guess.
	let root = adopted?.root ?? process.cwd();
	// Mutable: /subagents-resume-run adopts a previous run in place, so these are
	// rebound rather than fixed for the life of the session.
	let runId = adopted?.runId ?? Math.random().toString(16).slice(2, 10);
	let runDir = adopted?.runDir ?? path.join(root, ".pi", "runs", runId);

	/**
	 * Follow the session cwd until the run starts. After that the root is fixed:
	 * live children's claims and cwd are relative to it.
	 */
	function bindRoot(cwd: string | undefined): void {
		if (started || !cwd || cwd === root) return;
		root = cwd;
		runDir = path.join(root, ".pi", "runs", runId);
	}

	/** Pi's trust decision for this project; gates ./.pi/subagents-config.json. */
	let projectTrusted = true;
	function bindTrust(ctx: { isProjectTrusted?: () => boolean }): void {
		try {
			if (typeof ctx.isProjectTrusted === "function") projectTrusted = ctx.isProjectTrusted();
		} catch {
			/* stale ctx: keep the last decision */
		}
	}

	/** User file + project file for the current root, merged. */
	const settings = () => loadSettings(root, projectTrusted);
	const config = (): SubagentsConfig => settings().config;

	/**
	 * "writers 2/3": running writers (after this spawn) against the cap, so the
	 * model sees both that a cap exists and how close it is, before a refusal.
	 */
	function writerGauge(isWriter: boolean): string {
		const others = [...live.values()].filter((l) => !l.settled && l.record.writes.length > 0).length;
		// The child just started counts once, whether or not it is already in `live`.
		const n = Math.max(others, isWriter ? 1 : 0);
		return `writers ${n}/${config().maxConcurrentWriters}`;
	}
	const guardPath = path.join(import.meta.dirname, "guard.ts");

	/**
	 * Proof-of-life for children. A bare kill(ppid, 0) is not enough: pids are
	 * recycled, so a dead parent's pid can be reused by an unrelated process and
	 * every orphan would then believe its parent is alive forever. A file whose
	 * mtime only this parent advances cannot be impersonated that way.
	 */
	function heartbeatPath(dir = runDir): string {
		return path.join(dir, "heartbeat");
	}

	function beat(): void {
		try {
			fs.writeFileSync(heartbeatPath(), `${process.pid} ${Date.now()}\n`);
		} catch {
			/* the run dir may be gone; children will stand down, which is correct */
		}
	}

	/** ms since the given run was last touched by its parent, or Infinity. */
	function heartbeatAge(dir: string): number {
		try {
			return Date.now() - fs.statSync(path.join(dir, "heartbeat")).mtimeMs;
		} catch {
			return Number.POSITIVE_INFINITY;
		}
	}

	const live = adopted?.live ?? new Map<string, LiveChild>();
	const procs = adopted?.procs ?? new Map<string, ChildProcess>();
	const lastProgressAt = new Map<string, number>();
	/**
	 * Escalation kinds that are a GUESS about a still-running child rather than a
	 * measured fact. These never trigger a turn; they surface passively.
	 */
	const ADVISORY_KINDS = new Set<Escalation["kind"]>(["stuck"]);

	/** child id -> advisories raised, shown in the widget and on collect/peek. */
	const advisories = adopted?.advisories ?? new Map<string, Escalation[]>();

	let escalationOffset = adopted?.escalationOffset ?? 0;
	let escalationTimer: NodeJS.Timeout | null = null;
	let started = false;
	let adoptionAnnounced = false;

	// A single persistent panel updated in place, never a growing list of chat
	// entries. This is the whole answer to "don't overpopulate the screen":
	// live status lives below the editor and disappears when nothing is running;
	// the scrollback only ever gets one entry per child at start and one at finish.
	let uiCtx: ExtensionContext | undefined;

	/**
	 * Children are OS processes that outlive session replacement and teardown, so
	 * their callbacks fire at moments when the host APIs are no longer valid:
	 * after /resume, fork, reload, or once a -p run has ended. Every one of
	 * appendEntry, sendMessage and ctx.hasUI throws "stale ctx" in that state, and
	 * an exception on a child's exit callback takes down the entire pi process.
	 *
	 * None of these calls is load-bearing - they are all reporting. Reporting must
	 * never be able to kill the thing it reports on.
	 */
	function safely(what: () => void): void {
		try {
			what();
		} catch {
			/* host session is gone or replaced: nothing to report to */
		}
	}

	function refreshWidget(): void {
		safely(renderWidget);
	}

	function renderWidget(): void {
		if (!uiCtx?.hasUI) return;
		const running = [...live.values()].filter((l) => l.record.state === "running");
		if (running.length === 0) {
			uiCtx.ui.setWidget("subagents", undefined);
			return;
		}
		// Spend is cumulative over every child this session, including finished
		// ones. Summing only the running set makes the total visibly drop each
		// time a child exits, which reads as a bug even though it is only a
		// display choice.
		const spent = [...live.values()].reduce((sum, l) => sum + (l.usage.cost ?? 0), 0);
		const lines = widgetLines({
			running: running.map((l) => {
				// Advisories are shown here and nowhere else until asked for: visible
				// if you look, silent if you do not.
				const adv = advisories.get(l.record.id);
				return {
					id: l.record.id,
					agent: l.record.agent,
					writes: l.record.writes,
					startedAt: l.startedAt,
					tool: l.tools.at(-1)?.name,
					advisory: adv?.length ? adv[adv.length - 1].detail : undefined,
				};
			}),
			done: live.size - running.length,
			spent,
			now: Date.now(),
		});
		uiCtx.ui.setWidget("subagents", lines, { placement: "belowEditor" });
	}

	// Refresh the captured ctx at every opportunity, so a replaced session gets a
	// live one rather than leaving the widget permanently disabled.
	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx;
		bindRoot(ctx.cwd);
		bindTrust(ctx);
		refreshWidget();
		// Which files are in effect, so an edit that did nothing is visible.
		const s = settings();
		safely(() => ctx.ui.notify(s.summary, s.level));
		if (adopted && !adoptionAnnounced) {
			adoptionAnnounced = true;
			const running = [...live.values()].filter((l) => !l.settled).map((l) => l.record.id);
			const finished = live.size - running.length;
			safely(() =>
				ctx.ui.notify(
					`subagents: kept run ${runId} across /reload — ${running.length} running` +
						`${running.length ? ` (${running.join(", ")})` : ""}, ${finished} finished`,
					"info",
				),
			);
		}
	});

	/** Collects currently blocked inside execute(), keyed for early resolution. */
	const inflightCollects = new Set<{ resolve: (reason: Escalation[] | null) => void }>();

	// -----------------------------------------------------------------------
	// Setup
	// -----------------------------------------------------------------------

	function ensureRun(): void {
		if (started) return;
		started = true;
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(path.join(runDir, "findings.jsonl"), "", { flag: "a" });
		fs.writeFileSync(path.join(runDir, "escalations.jsonl"), "", { flag: "a" });
		excludeRunDirFromGit();
		beat();
		withLock(runDir, () => {
			const reg = readRegistry(runDir, runId, root);
			writeRegistry(runDir, reg);
			writeBoard(runDir, reg, 0);
		});
		startRunTimers();
	}

	/** Heartbeat (children watch it) and escalation polling. */
	function startRunTimers(): void {
		if (escalationTimer) clearInterval(escalationTimer);
		escalationTimer = setInterval(() => {
			beat();
			pollEscalations();
		}, 2000);
		escalationTimer.unref?.();
	}

	/** Local-only ignore: never touches the repo's tracked .gitignore. */
	function excludeRunDirFromGit(): void {
		try {
			const ex = path.join(root, ".git", "info", "exclude");
			if (!fs.existsSync(ex)) return;
			const cur = fs.readFileSync(ex, "utf8");
			if (!cur.includes(".pi/runs/")) {
				fs.appendFileSync(ex, `${cur.endsWith("\n") ? "" : "\n"}.pi/runs/\n`);
			}
		} catch {
			/* not a git repo, or read-only: harmless */
		}
	}

	function refreshBoard(): void {
		const reg = mutateRegistry(runDir, runId, root, () => {});
		writeBoard(runDir, reg, countLines(path.join(runDir, "findings.jsonl")));
	}

	/**
	 * Persist a child's state to claims.json. Without this the on-disk record
	 * stays "running" forever and its territory is never released, so a later
	 * spawn claiming the same paths would be refused by a child that has
	 * already finished.
	 */
	function syncChild(record: ChildRecord): void {
		const ended = record.state !== "running";
		const reg = mutateRegistry(runDir, runId, root, (r) => {
			syncChildRecord(r, record);
			// Close before settling, so no send can slip in between the two.
			if (ended && r.children[record.id]) r.children[record.id].acceptingMessages = false;
		});
		if (ended) {
			// Acknowledge what the session actually persisted, then fail the rest.
			safely(() => reconcileSessionFile(runDir, record.sessionFile));
			safely(() => settleMessages(runDir, record.id, record.generation, record.state === "done" ? "recipient finished; only the parent can resume it" : `recipient ${record.state}`));
		}
		writeBoard(runDir, reg, countLines(path.join(runDir, "findings.jsonl")));
	}

	// -----------------------------------------------------------------------
	// Notification channels — strictly separated by who pays
	// -----------------------------------------------------------------------

	/**
	 * Stop a running child and free its territory.
	 *
	 * Signals the whole process group, because pi's bash tool spawns detached
	 * shells that outlive the agent and would keep writing to the repo. Waits
	 * briefly for a clean exit so the child can flush its session file, then
	 * escalates to SIGKILL.
	 *
	 * Deliberately NOT destructive: the transcript and any partial result stay on
	 * disk, so subagent_followup can resume the same session afterwards. A stop
	 * is a pause with the claim released, not a delete.
	 */
	async function stopChild(l: LiveChild, reason: string): Promise<void> {
		stoppedByParent.add(`${l.record.id}:${l.record.generation}`);
		// Close first so a send racing the stop is refused rather than queued for a
		// child that will never read it.
		safely(() => reconcileSessionFile(runDir, l.record.sessionFile));
		safely(() => closeInbox(runDir, { id: l.record.id, generation: l.record.generation }, "stopped by parent"));
		const proc = procs.get(l.record.id);
		if (proc) {
			const signalGroup = (sig: NodeJS.Signals) => {
				try {
					if (proc.pid) process.kill(-proc.pid, sig);
				} catch {
					try {
						proc.kill(sig);
					} catch {
						/* already gone */
					}
				}
			};
			signalGroup("SIGTERM");
			await new Promise<void>((resolve) => {
				if (l.settled) return resolve();
				const timer = setTimeout(() => {
					signalGroup("SIGKILL");
					resolve();
				}, 4000);
				timer.unref?.();
				l.onSettle.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		procs.delete(l.record.id);
		l.settled = true;
		// You asked for this stop, so announcing it would only report back
		// something you already know.
		markReported([l.record.id]);
		// Written after the exit handler has had its say, so a stop is recorded as
		// a stop rather than as the failure its non-zero exit code looks like.
		l.record.state = "killed";
		l.record.endedAt = Date.now();
		try {
			syncChild(l.record);
		} catch {
			/* registry unavailable */
		}
		try {
			fs.appendFileSync(
				path.join(runDir, "findings.jsonl"),
				`${JSON.stringify({ kind: "stopped", child: l.record.id, text: reason, at: Date.now() })}\n`,
			);
		} catch {
			/* run dir gone */
		}
		refreshBoard();
		progress(l, true);
		refreshWidget();
	}

	/**
	 * Decide which model and thinking level a child runs on.
	 *
	 * Precedence, most specific first:
	 *   1. the `model` argument on the spawn call
	 *   2. the agent definition's `model:` frontmatter
	 *   3. config.childModel: "inherit" | "default" | an explicit id
	 *
	 * "inherit" reads the orchestrator's LIVE model, not settings.defaultModel,
	 * so switching model mid-session with /model actually reaches the children.
	 */
	function resolveModel(
		ctx: ExtensionContext | undefined,
		agent: AgentDef,
		explicit?: string,
	): { model: string | null; thinking: string | null } {
		const cfg = config();

		const pick = (setting: string, inherited: string | undefined): string | null => {
			if (setting === "default") return null; // omit the flag entirely
			if (setting === "inherit") return inherited ?? null;
			return setting || null;
		};

		const inheritedModel = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const model = explicit ?? agent.model ?? pick(cfg.childModel, inheritedModel);
		const thinking = agent.thinking ?? pick(cfg.childThinking, ctx?.thinkingLevel as string | undefined);
		return { model: model ?? null, thinking: thinking ?? null };
	}

	/**
	 * Launch (or relaunch) a child and wire its events. Shared by subagent_spawn
	 * and subagent_followup so a resumed child behaves identically to a new one.
	 */
	function startChild(opts: {
		record: ChildRecord;
		agent: AgentDef;
		childDir: string;
		model?: string;
		resumeFrom?: string | null;
		compact?: boolean;
		seedUsage?: Usage;
	}): LiveChild {
		const teamName = opts.record.team ?? "none";
		const team = teamName === "none" ? undefined : readRegistry(runDir, runId, root).teams?.[teamName];
		const { proc, live: l } = launch({
			record: opts.record,
			team,
			config: config(),
			agent: opts.agent,
			runDir,
			childDir: opts.childDir,
			root,
			guardPath,
			model: opts.model,
			resumeFrom: opts.resumeFrom,
			compact: opts.compact,
			seedUsage: opts.seedUsage,
			// Routed rather than bound to this instance: after a /reload the next
			// instance must receive this child's events.
			onEvent: routeChildEvent,
		});
		live.set(opts.record.id, l);
		procs.set(opts.record.id, proc);
		syncChild(opts.record); // persist the pid, which reaping depends on
		progress(l, true);
		return l;
	}

	/** Every child event, whichever instance launched the child. */
	function onChildEvent(child: LiveChild, kind: string): void {
		if (kind === "settled") {
			procs.delete(child.record.id);
			syncChild(child.record);
			progress(child, true);
			notifyDone(child);
		} else {
			progress(child);
			detectStuck(child);
		}
	}

	/**
	 * Human-facing, zero LLM tokens either way. Two separate channels with
	 * separate budgets:
	 *   - the widget is live and cheap to redraw, so it refreshes on every
	 *     throttled tick and never grows the transcript.
	 *   - appendEntry writes a permanent scrollback card, so it only fires once
	 *     per lifecycle EDGE (spawned, then done/failed/killed) rather than once
	 *     per tick — a long-running child would otherwise flood the screen with
	 *     one card per tool call.
	 */
	function progress(l: LiveChild, edge = false): void {
		const now = Date.now();
		const last = lastProgressAt.get(l.record.id) ?? 0;
		if (!edge && now - last < PROGRESS_THROTTLE_MS) {
			return;
		}
		lastProgressAt.set(l.record.id, now);
		refreshWidget();
		if (!edge) return;
		safely(() =>
			pi.appendEntry("subagent-progress", {
			id: l.record.id,
			agent: l.record.agent,
			state: l.record.state,
			task: l.record.task.slice(0, 120),
			turns: l.usage.turns,
			cost: l.usage.cost,
			owns: l.record.writes,
			lastTool: l.tools.at(-1) ? `${l.tools.at(-1)!.name}(${l.tools.at(-1)!.brief})` : "",
			lastText: l.lastText.slice(0, 200),
				elapsedMs: (l.record.endedAt ?? now) - l.startedAt,
				blocked: l.blockCount,
			}),
		);
	}

	/**
	 * Children an in-flight subagent_collect is waiting on, with how many
	 * collects are waiting. Their result arrives through that collect, so the
	 * completion message would only repeat it.
	 */
	const awaitedByCollect = new Map<string, number>();

	/**
	 * A finished child wakes the parent model. When it is idle this starts a new
	 * rollout; mid-rollout, pi delivers the message before the next LLM call
	 * ("steer"). Without this, a parent that ended its turn expecting to be told
	 * would sit idle until the user typed something.
	 */
	let parentRunning = false;
	const completion = createCompletionNotifier({
		parentRunning: () => parentRunning,
		send: (text) =>
			safely(() =>
				pi.sendMessage(
					{ customType: "subagent", content: text, display: true },
					{ deliverAs: "steer", triggerTurn: true },
				),
			),
		awaited: (id) => (awaitedByCollect.get(id) ?? 0) > 0,
	});

	/** Called when a child's result reached the model another way (final peek, stop, collect). */
	function markReported(ids: string[]): void {
		completion.reported(ids);
	}

	/**
	 * `${id}:${generation}` of children the parent stopped. Their exit can land
	 * after stopChild gave up waiting, and must not read as a completion.
	 */
	const stoppedByParent = new Set<string>(adopted?.stoppedByParent ?? []);

	function notifyDone(l: LiveChild): void {
		if (stoppedByParent.has(`${l.record.id}:${l.record.generation}`)) return;
		completion.finished({ id: l.record.id, agent: l.record.agent, state: l.record.state });
	}

	pi.on("before_agent_start", (_event, ctx) => {
		uiCtx = ctx; // always the freshest ctx we have seen
		bindRoot(ctx.cwd);
		bindTrust(ctx);
	});
	pi.on("agent_start", () => {
		parentRunning = true;
	});
	// After this LLM call's tools ran (so a collect there has been accounted
	// for) and before the next call: a steered message lands in time for it.
	pi.on("turn_end", () => {
		completion.turnEnded();
	});
	// Finished after the last LLM call: pi runs this send once settling is done.
	pi.on("agent_settled", () => {
		parentRunning = false;
		completion.settled();
	});

	/** Model-facing, interrupting. Only for things the parent must act on now. */
	function notifyAttention(text: string): void {
		safely(() =>
			pi.sendMessage(
				{ customType: "subagent", content: text, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			),
		);
	}

	// -----------------------------------------------------------------------
	// Escalations. If a collect is in flight, the collect IS the channel.
	// -----------------------------------------------------------------------

	function resolveCollects(esc: Escalation[]): boolean {
		if (inflightCollects.size === 0) return false;
		for (const c of [...inflightCollects]) c.resolve(esc);
		return true;
	}

	function pollEscalations(): void {
		let raw: string;
		try {
			const file = path.join(runDir, "escalations.jsonl");
			const st = fs.statSync(file);
			if (st.size <= escalationOffset) return;
			const fd = fs.openSync(file, "r");
			const buf = Buffer.alloc(st.size - escalationOffset);
			fs.readSync(fd, buf, 0, buf.length, escalationOffset);
			fs.closeSync(fd);
			escalationOffset = st.size;
			raw = buf.toString("utf8");
		} catch {
			return;
		}

		const esc: Escalation[] = raw
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l) as Escalation;
				} catch {
					return null;
				}
			})
			.filter((e): e is Escalation => e !== null);

		// Every escalation kind concerns a RUNNING child. Once the child has exited
		// there is nothing to decide, and the poll interval plus queued delivery
		// means a child can easily finish between raising the escalation and you
		// reading it. Interrupting for a child that is already done is pure noise.
		const actionable = esc.filter((e) => {
			const l = live.get(e.child);
			return l ? !l.settled && l.record.state === "running" : false;
		});
		if (actionable.length === 0) return;

		// A FACT means the child has stopped and cannot continue without a decision
		// from you: it is owed a turn. An ADVISORY is a heuristic about a child that
		// is still running fine, and a suspicion must never be allowed to seize the
		// agent - it goes to the widget and waits to be noticed.
		const facts = actionable.filter((e) => !ADVISORY_KINDS.has(e.kind));
		const advice = actionable.filter((e) => ADVISORY_KINDS.has(e.kind));

		if (advice.length) {
			for (const e of advice) {
				const list = advisories.get(e.child) ?? [];
				list.push(e);
				advisories.set(e.child, list);
			}
			refreshWidget();
		}

		if (facts.length === 0) return;
		if (resolveCollects(facts)) return; // delivered as the collect return value
		notifyAttention(formatEscalations(facts));
	}

	function formatEscalations(esc: Escalation[]): string {
		const lines = esc.map(
			(e) =>
				`- [${e.kind}] ${e.child}${e.holder ? ` blocked by ${e.holder}` : ""}` +
				`${e.paths?.length ? ` on ${e.paths.join(", ")}` : ""}: ${e.detail}`,
		);
		// The right advice depends on the kind. Telling the user to "collect the
		// blocking child" when nothing is blocked is actively misleading.
		const kinds = new Set(esc.map((e) => e.kind));
		const advice: string[] = [];
		if (kinds.has("blocked_repeatedly") || kinds.has("claim_timeout") || kinds.has("deadlock")) {
			advice.push(
				`This is a territory conflict: subagent_collect the child holding the claim, ` +
					`re-partition the work, or let the blocked child finish with a partial result.`,
			);
		}
		if (kinds.has("stuck")) {
			advice.push(
				`This child may be looping or idle - nothing is blocking it. Inspect with ` +
					`subagent_peek({ level: "tail" }), let it run, or subagent_collect for what it has.`,
			);
		}
		return `[subagents] ${esc.length} issue(s) need a decision:\n${lines.join("\n")}\n${advice.join("\n")}`;
	}

	function detectStuck(l: LiveChild): void {
		if (l.stuckNotified || l.record.state !== "running") return;
		const idle = Date.now() - l.lastEventAt;
		let why: string | null = null;
		if (idle > STUCK_IDLE_MS) why = `no activity for ${Math.round(idle / 1000)}s`;
		else if (l.repeatCount >= STUCK_REPEAT) why = `repeated ${l.repeatSignature} ×${l.repeatCount}`;
		else if (l.consecutiveErrors >= STUCK_ERRORS) why = `${l.consecutiveErrors} consecutive tool errors`;
		else if (l.blockCount >= BLOCK_ESCALATE_AT)
			// The most valuable signal available: this is a partition error, not an agent error.
			why = `blocked by its claim ${l.blockCount}× — the work was probably partitioned wrong`;
		if (!why) return;
		l.stuckNotified = true;
		const esc: Escalation = {
			kind: l.blockCount >= BLOCK_ESCALATE_AT ? "blocked_repeatedly" : "stuck",
			child: l.record.id,
			detail: why,
			at: Date.now(),
		};
		if (!resolveCollects([esc])) notifyAttention(formatEscalations([esc]));
	}

	// -----------------------------------------------------------------------
	// Tools
	// -----------------------------------------------------------------------

	pi.registerTool({
		...TEAM_SPEC,
		async execute(_id, params: { name?: string; goal?: string }) {
			ensureRun();
			try {
				if (params.name !== undefined || params.goal !== undefined) {
					if (!params.name || !params.goal) throw new Error("Provide both name and goal, or neither to list teams.");
					const team = defineTeam(runDir, params.name, params.goal);
					refreshBoard();
					return {
						content: [{ type: "text" as const, text: `Team ${team.name}: ${team.goal}\nSpawn members with team: "${team.name}", individual tasks, and separate claims.` }],
						details: team,
					};
				}
				const reg = readRegistry(runDir, runId, root);
				const text = Object.values(reg.teams ?? {})
					.map((t) => {
						const members = Object.values(reg.children).filter((c) => c.team === t.name).map((c) => `${c.id} (${c.state})`);
						return `${t.name}: ${t.goal}\n  members: ${members.join(", ") || "none yet"}`;
					})
					.join("\n");
				return {
					content: [{ type: "text" as const, text: text || 'No teams defined. Omitted team defaults to "none" (no direct messaging).' }],
					details: undefined,
				};
			} catch (e) {
				return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true, details: undefined };
			}
		},
	});

	pi.registerTool({
		...SPAWN_SPEC,
		async execute(
			_id,
			params: {
				agent: string;
				name?: string;
				task: string;
				writes?: string[];
				reads?: string[];
				cwd?: string;
				model?: string;
				team?: string;
			},
			_signal?: AbortSignal,
			_onUpdate?: unknown,
			ctx?: ExtensionContext,
		) {
			ensureRun();
			const agents = discoverAgents(root);
			const agent = agents.get(params.agent);
			if (!agent) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown agent "${params.agent}". Available: ${[...agents.keys()].join(", ")}`,
						},
					],
					isError: true,
					details: undefined,
				};
			}

			let team: string;
			let name: string | undefined;
			try {
				name = normalizeName(params.name);
				team = validateTeam(readRegistry(runDir, runId, root), params.team);
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], isError: true, details: undefined };
			}
			const writes = (params.writes ?? []).map((p) => rel(root, p));
			const { maxConcurrentWriters, maxConcurrentTotal } = config();
			const running = [...live.values()].filter((l) => l.record.state === "running");
			const runningWriters = running.filter((l) => l.record.writes.length > 0);
			if (running.length >= maxConcurrentTotal) {
				return {
					content: [{ type: "text", text: `Refused: ${maxConcurrentTotal} subagents already running.` }],
					isError: true,
					details: undefined,
				};
			}
			if (writes.length && runningWriters.length >= maxConcurrentWriters) {
				return {
					content: [
						{
							type: "text",
							text:
								`Refused: writers ${runningWriters.length}/${maxConcurrentWriters} already running ` +
								`(${runningWriters.map((l) => l.record.id).join(", ")}). Collect one first, or ` +
								`spawn this child read-only.`,
						},
					],
					isError: true,
					details: undefined,
				};
			}

			// Unique across this run's registry (every generation, finished or not) and
			// the live map; the admission lock below re-checks before inserting.
			const id = newChildId(name, new Set([...Object.keys(readRegistry(runDir, runId, root).children), ...live.keys()]));
			const childDir = path.join(runDir, id);
			const record: ChildRecord = {
				id,
				...(name ? { name } : {}),
				agent: agent.name,
				task: params.task,
				team,
				acceptingMessages: true,
				writes,
				reads: (params.reads ?? []).map((p) => rel(root, p)),
				cwd: params.cwd ? path.resolve(root, params.cwd) : root,
				pid: null,
				state: "running",
				startedAt: Date.now(),
				endedAt: null,
				sessionFile: null,
				sessionId: null,
				...resolveModel(ctx, agent, params.model),
				resultPath: path.join(childDir, "result.md"),
				exitCode: null,
				generation: 1,
			};

			// Admission control: the entire safety property, resolved before any
			// work happens and therefore at almost zero cost.
			const verdict = withLock(runDir, () => {
				const reg = readRegistry(runDir, runId, root);
				reap(reg);
				try {
					validateTeam(reg, team);
				} catch (e) {
					return { ok: false, reason: (e as Error).message };
				}
				if (reg.children[id]) return { ok: false, reason: `Subagent ID ${id} was taken concurrently; spawn again.` };
				const a = admit(reg, id, writes);
				if (!a.ok) return a;
				reg.children[id] = record;
				writeRegistry(runDir, reg);
				writeBoard(runDir, reg, countLines(path.join(runDir, "findings.jsonl")));
				return a;
			});
			if (!verdict.ok) {
				return { content: [{ type: "text", text: verdict.reason! }], isError: true, details: undefined };
			}

			startChild({ record, agent, childDir });

			return {
				content: [
					{
						type: "text",
						text:
							`${id} started (${agent.name}${record.model ? ` on ${record.model}` : ""}) · team[${team}] · ` +
							`owns[${writes.length ? writes.join(",") : "read-only"}] · ` +
							writerGauge(writes.length > 0) +
							`\nRunning in the background. Continue working; you will be told when it finishes.\n` +
							`board: ${path.relative(root, boardPath(runDir))}`,
					},
				],
				details: { id, name, agent: agent.name, writes, model: record.model, team },
			};
		},
	});

	pi.registerTool({
		...FOLLOWUP_SPEC,
		async execute(
			_id,
			params: { id: string; task: string; writes?: string[]; compact?: boolean; interrupt?: boolean },
		) {
			const l = live.get(params.id);
			if (!l) {
				return {
					content: [
						{
							type: "text",
							text: unknownChildText(params.id, [...live.values()].map((l) => l.record)),
						},
					],
					isError: true,
					details: undefined,
				};
			}
			let interrupted = false;
			if (!l.settled) {
				if (!params.interrupt) {
					return {
						content: [
							{
								type: "text",
								text:
									`${params.id} is still running — a follow-up would race its current turn.\n` +
									`Either subagent_collect({ ids: ["${params.id}"] }) and then follow up, or ` +
									`re-send with interrupt: true to stop it now and redirect it.`,
							},
						],
						isError: true,
						details: undefined,
					};
				}
				// Stop it where it stands; the session file survives, so the resume
				// below picks up everything it had already worked out.
				await stopChild(l, `interrupted by follow-up: ${params.task.replace(/\s+/g, " ").slice(0, 120)}`);
				interrupted = true;
			}
			void interrupted;
			if (!l.record.sessionFile || !fs.existsSync(l.record.sessionFile)) {
				return {
					content: [
						{
							type: "text",
							text:
								`${params.id} has no readable session file, so its context cannot be ` +
								`resumed. Spawn a new child with the necessary background instead.`,
						},
					],
					isError: true,
					details: undefined,
				};
			}

			const agents = discoverAgents(root);
			const agent = agents.get(l.record.agent);
			if (!agent) {
				return {
					content: [{ type: "text", text: `Agent "${l.record.agent}" no longer exists.` }],
					isError: true,
					details: undefined,
				};
			}

			// The claim was released when the child finished, so it must be re-acquired
			// under exactly the same rules a new spawn faces — another child may own
			// this territory now.
			const writes = (params.writes ?? l.record.writes).map((p) => rel(root, p));
			const runningWriters = [...live.values()].filter(
				(c) => !c.settled && c.record.writes.length > 0 && c.record.id !== params.id,
			);
			const { maxConcurrentWriters } = config();
			if (writes.length && runningWriters.length >= maxConcurrentWriters) {
				return {
					content: [
						{
							type: "text",
							text: `Refused: writers ${runningWriters.length}/${maxConcurrentWriters} already running.`,
						},
					],
					isError: true,
					details: undefined,
				};
			}

			// The previous generation's undelivered mail is settled now, so a resumed
			// child never receives messages addressed to a run it no longer is.
			safely(() => reconcileSessionFile(runDir, l.record.sessionFile));
			safely(() => settleMessages(runDir, l.record.id, l.record.generation, "previous generation ended"));
			const verdict = withLock(runDir, () => {
				const reg = readRegistry(runDir, runId, root);
				reap(reg);
				const a = admit(reg, params.id, writes);
				if (!a.ok) return a;
				const c = reg.children[params.id];
				if (c) {
					c.writes = writes;
					c.state = "running";
					c.acceptingMessages = true;
					c.pid = null;
					c.startedAt = Date.now();
					c.endedAt = null;
					c.exitCode = null;
					c.generation = l.record.generation + 1;
					c.task = params.task;
				}
				writeRegistry(runDir, reg);
				writeBoard(runDir, reg, countLines(path.join(runDir, "findings.jsonl")));
				return a;
			});
			if (!verdict.ok) {
				return { content: [{ type: "text", text: verdict.reason! }], isError: true, details: undefined };
			}

			const record: ChildRecord = {
				...l.record,
				acceptingMessages: true,
				pid: null,
				startedAt: Date.now(),
				task: params.task,
				writes,
				state: "running",
				endedAt: null,
				exitCode: null,
				generation: l.record.generation + 1,
			};

			startChild({
				record,
				agent,
				childDir: path.join(runDir, params.id),
				resumeFrom: l.record.sessionFile,
				compact: params.compact,
				seedUsage: { ...l.usage },
			});

			return {
				content: [
					{
						type: "text",
						text:
							`${params.id} resumed (generation ${record.generation}, ${l.usage.turns} prior turns) · ` +
							`owns[${writes.length ? writes.join(",") : "read-only"}] · ` +
							writerGauge(writes.length > 0) +
							`\nIt keeps everything it already learned. You will be told when it finishes.` +
							(params.compact
								? `\nCompaction requested; pi applies it only if there is history old enough ` +
									`to summarize, otherwise the full context is kept.`
								: ""),
					},
				],
				details: { id: params.id, generation: record.generation, writes },
			};
		},
	});

	pi.registerTool({
		...PEEK_SPEC,
		async execute(_id, params: { id?: string; level?: string; limit?: number }) {
			if (live.size === 0) {
				return { content: [{ type: "text", text: "No subagents in this session." }], details: undefined };
			}
			const level = (params.level ?? "digest") as PeekLevel;

			if (!params.id) {
				const lines = [...live.values()].map((l) => statusLine(l));
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { count: lines.length },
				};
			}
			const l = live.get(params.id);
			if (!l) {
				return {
					content: [
						{
							type: "text",
							text: unknownChildText(params.id, [...live.values()].map((l) => l.record)),
						},
					],
					isError: true,
					details: undefined,
				};
			}
			// A "final" peek hands over the child's whole result, same as a collect,
			// so it also settles the debt. Lighter levels are only a status glance
			// and leave the digest owed.
			if (level === "final" && l.settled) markReported([l.record.id]);
			return { content: [{ type: "text", text: render(l, level) }], details: { id: l.record.id, level } };
		},
	});

	pi.registerTool({
		...STOP_SPEC,
		async execute(_id, params: { id: string; reason?: string }) {
			const reason = params.reason?.trim() || "stopped by the orchestrator";
			const targets =
				params.id === "all"
					? [...live.values()].filter((l) => !l.settled)
					: [live.get(params.id)].filter((l): l is LiveChild => Boolean(l));

			if (params.id !== "all" && targets.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: unknownChildText(params.id, [...live.values()].map((l) => l.record)),
						},
					],
					isError: true,
					details: undefined,
				};
			}
			const running = targets.filter((l) => !l.settled);
			if (running.length === 0) {
				return {
					content: [{ type: "text", text: `Nothing to stop — no matching subagent is running.` }],
					details: { stopped: [] },
				};
			}
			for (const l of running) await stopChild(l, reason);
			// Its result is now whatever it managed to produce, so the model should be
			// told where to find it rather than left assuming the work is lost.
			const lines = running.map(
				(l) =>
					`${l.record.id} (${l.record.agent}) stopped after ${Math.round((Date.now() - l.startedAt) / 1000)}s` +
					`${l.record.writes.length ? `, released owns[${l.record.writes.join(",")}]` : ""}`,
			);
			return {
				content: [
					{
						type: "text",
						text:
							`${lines.join("\n")}\n` +
							`Partial work is kept. subagent_peek({ id, level: "final" }) to read what it got ` +
							`to, or subagent_followup to restart it from where it left off.`,
					},
				],
				details: { stopped: running.map((l) => l.record.id), reason },
			};
		},
	});

	pi.registerTool({
		...COLLECT_SPEC,
		async execute(_id, params: { ids?: string[]; timeoutMs?: number }, signal) {
			const targets = (params.ids ?? [...live.keys()])
				.map((id) => live.get(id))
				.filter((l): l is LiveChild => Boolean(l));
			if (targets.length === 0) {
				const unknown = (params.ids ?? []).find((id) => !live.has(id));
				const text = unknown ? unknownChildText(unknown, [...live.values()].map((l) => l.record)) : "No matching subagents.";
				return { content: [{ type: "text", text }], details: undefined };
			}

			const pending = targets.filter((l) => !l.settled);
			let escalations: Escalation[] | null = null;
			let timedOut = false;

			if (pending.length > 0) {
				const timeout = params.timeoutMs ?? DEFAULT_COLLECT_TIMEOUT;
				escalations = await new Promise<Escalation[] | null>((resolve) => {
					let done = false;
					const finish = (v: Escalation[] | null) => {
						if (done) return;
						done = true;
						inflightCollects.delete(handle);
						for (const l of pending) {
							const n = (awaitedByCollect.get(l.record.id) ?? 1) - 1;
							if (n > 0) awaitedByCollect.set(l.record.id, n);
							else awaitedByCollect.delete(l.record.id);
						}
						clearTimeout(timer);
						signal?.removeEventListener?.("abort", onAbort);
						resolve(v);
					};
					const handle = { resolve: finish };
					inflightCollects.add(handle);
					// Until this collect returns, it is the channel for these children.
					for (const l of pending) awaitedByCollect.set(l.record.id, (awaitedByCollect.get(l.record.id) ?? 0) + 1);

					const timer = setTimeout(() => {
						timedOut = true;
						finish(null);
					}, timeout);
					const onAbort = () => finish(null);
					signal?.addEventListener?.("abort", onAbort, { once: true });

					let remaining = pending.length;
					for (const l of pending) {
						l.onSettle.push(() => {
							remaining--;
							if (remaining === 0) finish(null);
						});
					}
				});
			}

			const settled = targets.filter((l) => l.settled);
			const stillRunning = targets.filter((l) => !l.settled);

			const parts: string[] = [];
			if (escalations?.length) {
				parts.push(`STATUS: needs_decision`, formatEscalations(escalations), "");
			} else if (timedOut) {
				parts.push(`STATUS: timeout after ${Math.round((params.timeoutMs ?? DEFAULT_COLLECT_TIMEOUT) / 1000)}s`, "");
			}

			for (const l of settled) {
				parts.push(`── ${l.record.id} (${l.record.state}) ──`);
				parts.push(l.lastText || "(no final message)");
				parts.push(`session: pi --session ${l.record.sessionFile ?? "(unavailable)"}`);
				parts.push("");
			}
			if (stillRunning.length) {
				parts.push(`── still running ──`);
				for (const l of stillRunning) parts.push(digest(l));
				parts.push("");
			}

			// Free to include: you asked for this, so it costs no extra turn.
			const adv = targets.flatMap((l) => advisories.get(l.record.id) ?? []);
			if (adv.length) {
				parts.push(`── ${adv.length} advisory(ies), FYI only — no decision required ──`);
				for (const e of adv) parts.push(`- [${e.kind}] ${e.child}: ${e.detail}`);
				parts.push("");
			}

			let communication = "";
			safely(() => {
				communication = messageSummary(runDir);
			});
			// Ordinary exchanges are the children's business; only surface failures,
			// which may mean some agent is still missing an answer.
			if (/[1-9]\d* undelivered|retained/.test(communication)) {
				parts.push("\u2500\u2500 team messages \u2500\u2500", communication, "");
			}

			const reqs = readRequests();
			if (reqs.length) {
				parts.push(`── ${reqs.length} shared-file edit request(s) awaiting you ──`);
				for (const r of reqs) parts.push(`- ${r.path} (from ${r.child}): ${r.why}`);
				parts.push(`Full patches: ${path.relative(root, path.join(runDir, "requests.jsonl"))}`);
			}

			// This result carries each settled child's full final message, so the
			// model has been told; drop any completion message still being batched.
			markReported(settled.map((l) => l.record.id));

			return {
				content: [{ type: "text", text: parts.join("\n").trim() }],
				details: {
					settled: settled.map((l) => l.record.id),
					running: stillRunning.map((l) => l.record.id),
					needsDecision: Boolean(escalations?.length),
				},
			};
		},
	});

	function readRequests(): { child: string; path: string; why: string }[] {
		try {
			return fs
				.readFileSync(path.join(runDir, "requests.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
		} catch {
			return [];
		}
	}

	// -----------------------------------------------------------------------
	// TUI rendering — free, because custom entries never enter LLM context
	// -----------------------------------------------------------------------

	pi.registerEntryRenderer("subagent-progress", (entry, { expanded }, theme) => {
		const d = entry.data as any;
		// Text defaults to paddingY=1, which puts a blank line ABOVE AND BELOW every
		// child. Four children then cost eight blank lines and the card reads as
		// though it were double-spaced. Always pass (text, 0, 0) here.
		const box = new Box(1, 0, (t: string) => theme.bg("customMessageBg", t));
		const line = (s: string) => box.addChild(new Text(s, 0, 0));

		const icon = d.state === "running" ? "●" : d.state === "done" ? "✓" : "✗";
		const secs = Math.round((d.elapsedMs ?? 0) / 1000);
		const elapsed = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
		const owns = d.owns?.length ? d.owns.join(",") : "read-only";

		// Collapsed: exactly one line. Everything else is available on expand.
		line(
			`${icon} ${theme.bold(d.id)} ${d.agent} ` +
				theme.fg("dim", `${d.turns ?? 0}t · ${elapsed} · $${(d.cost ?? 0).toFixed(3)} · ${owns}`) +
				(d.lastTool ? theme.fg("dim", ` · ${d.lastTool}`) : "") +
				(d.blocked ? theme.fg("warning", ` · ⚠${d.blocked} blocked`) : ""),
		);
		if (expanded) {
			if (d.task) line(theme.fg("dim", `   task: ${d.task}`));
			if (d.lastText) line(theme.fg("dim", `   ${d.lastText}`));
		}
		return box;
	});

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Rebuild an in-memory LiveChild from a record on disk. The process is long
	 * gone, so it is reconstructed as already-settled: peek can read it and
	 * subagent_followup can resume it, but nothing believes it is running.
	 */
	function adoptLive(record: ChildRecord): LiveChild {
		let lastText = "";
		try {
			lastText = fs.readFileSync(record.resultPath, "utf8").slice(-4000);
		} catch {
			/* no result file: an empty summary is honest */
		}
		return {
			record,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			tools: [],
			tail: [],
			lastText,
			lastEventAt: record.endedAt ?? record.startedAt,
			startedAt: record.startedAt,
			consecutiveErrors: 0,
			repeatSignature: null,
			repeatCount: 0,
			blockCount: 0,
			stderr: "",
			stuckNotified: false,
			settled: true,
			onSettle: [],
		};
	}

	interface RunSummary {
		id: string;
		dir: string;
		reg: Registry;
		mtime: number;
		live: boolean;
		counts: Record<string, number>;
	}

	function listRuns(): RunSummary[] {
		const base = path.join(root, ".pi", "runs");
		let ids: string[] = [];
		try {
			ids = fs.readdirSync(base);
		} catch {
			return [];
		}
		const out: RunSummary[] = [];
		for (const id of ids) {
			if (id === runId) continue; // the run this session already owns
			const dir = path.join(base, id);
			const claims = path.join(dir, "claims.json");
			if (!fs.existsSync(claims)) continue;
			try {
				const reg = readRegistry(dir, id, root);
				reap(reg); // clear children whose pids are gone
				const counts: Record<string, number> = {};
				for (const c of Object.values(reg.children)) counts[c.state] = (counts[c.state] ?? 0) + 1;
				// A run is OFF LIMITS if its parent is still beating OR any of its
				// children is still a live process. The heartbeat alone is not enough:
				// runs created before heartbeats existed have none, and a child that
				// survived an extension reload keeps working under a parent that is
				// very much alive. Adopting such a run would let this session spawn
				// writers onto territory somebody is actively editing.
				const childAlive = Object.values<ChildRecord>(reg.children).some(
					(c) => c.pid !== null && pidAlive(c.pid),
				);
				out.push({
					id,
					dir,
					reg,
					mtime: fs.statSync(claims).mtimeMs,
					live: heartbeatAge(dir) < config().orphanStaleMs || childAlive,
					counts,
				});
			} catch {
				/* unreadable run: skip */
			}
		}
		return out.sort((a, b) => b.mtime - a.mtime);
	}

	function describeRun(r: RunSummary): string {
		const mins = Math.round((Date.now() - r.mtime) / 60000);
		const age = mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
		const states = Object.entries(r.counts)
			.map(([s, n]) => `${n} ${s}`)
			.join(", ");
		const tasks = Object.values<ChildRecord>(r.reg.children)
			.slice(0, 2)
			.map((c) => c.task.replace(/\s+/g, " ").slice(0, 46))
			.join(" | ");
		return `${r.id}  ${age.padEnd(8)} ${states.padEnd(28)} ${r.live ? "[LIVE - owned by another session] " : ""}${tasks}`;
	}

	pi.registerCommand("subagents-fleet", {
		description: "Live view of every subagent on this repo, including other sessions'",
		handler: async (_args, ctx) => {
			bindRoot(ctx.cwd);
			bindTrust(ctx);
			const current = () => (started ? runId : null);
			// Folded teams, kept for the life of this view across 1s refreshes.
			const collapsed = new Set<string>();
			const snapshot = () => {
				const fleet = collectFleet(root, current());
				const teams = collectTeams(root, current(), fleet);
				return { fleet, teams, items: buildItems(fleet, teams, collapsed) };
			};

			if (ctx.mode !== "tui") {
				console.log(renderPlain(snapshot().items));
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				const st: InspectorState = {
					...snapshot(),
					collapsed,
					selected: 0,
					scroll: 0,
					maxScroll: 0,
					// Row 0 is a team header, which reads from the top.
					autoFollow: false,
					expandedTools: false,
					rows: 32,
					threadNav: null,
				};
				let evs: Ev[] = [];
				let threadMsgs: ThreadMessage[] = [];
				let loadedFrom: string | null = null;
				let viewport = 1;

				// Only the SELECTED child's transcript is parsed, and only its tail, so
				// opening this on a long-running agent stays cheap. Team rows need none.
				// While a thread is open, only that thread's file is read instead.
				const loadDetail = (force = false) => {
					const item = st.items[st.selected];
					const { threads, index } = navPosition(st);
					const thread = st.threadNav?.mode === "open" ? threads[index] : undefined;
					const file = thread ? thread.file : item?.kind === "agent" ? item.view.sessionFile : null;
					if (!file) {
						evs = [];
						threadMsgs = [];
						loadedFrom = null;
						return;
					}
					if (!force && file === loadedFrom) return;
					loadedFrom = file;
					if (thread) threadMsgs = readThreadMessages(file);
					else evs = readTranscript(file);
				};
				loadDetail();

				// Keep the same row selected across refreshes even as the order changes.
				const refresh = () => {
					const key = itemKey(st.items[st.selected]);
					Object.assign(st, snapshot());
					const at = st.items.findIndex((i) => itemKey(i) === key);
					st.selected = at >= 0 ? at : Math.min(st.selected, Math.max(0, st.items.length - 1));
					// The row being browsed vanished, or its thread did: back to the normal view.
					if (st.threadNav && (at < 0 || navPosition(st).index < 0)) {
						st.threadNav = null;
						st.scroll = 0;
					}
					loadDetail(true);
				};

				const redraw = () => {
					tui.requestRender();
				};

				// Children are separate processes; nothing notifies us when they act,
				// so the view polls. The roster scan is incremental and only the open
				// transcript is re-read.
				const timer = setInterval(() => {
					refresh();
					redraw();
				}, 1000);

				const component = {
					render: (width: number) => {
						st.rows = tui.terminal?.rows ?? 32;
						const r = renderInspector(st, evs, width, theme as unknown as FleetTheme, threadMsgs);
						viewport = r.viewport;
						st.maxScroll = r.maxScroll;
						return r.lines;
					},
					invalidate: () => {},
					dispose: () => clearInterval(timer),
					handleInput: (data: string) => {
						const r = handleInspectorKey(st, data, viewport);
						if (r.kind === "ignored") return;
						if (r.kind === "close") {
							clearInterval(timer);
							done();
							return;
						}
						if (r.kind === "moved") loadDetail();
						if (r.kind === "refresh") refresh();
						redraw();
					},
				};
				return component;
			});
		},
	});

	pi.registerCommand("subagents-resume-run", {
		description: "Adopt a previous subagent run so its children can be followed up",
		handler: async (_args, ctx) => {
			bindRoot(ctx.cwd);
			bindTrust(ctx);
			const runs = listRuns();
			if (runs.length === 0) {
				ctx.ui.notify("No previous subagent runs found under .pi/runs/.", "info");
				return;
			}
			const labels = runs.map(describeRun);
			const picked = await ctx.ui.select("Resume which subagent run?", labels);
			if (!picked) return;
			const chosen = runs[labels.indexOf(picked)];
			if (!chosen) return;

			// Two parents adopting one run would both spawn into the same claims
			// file and silently share territory. The lock protects the file's
			// integrity, not the intent behind it.
			if (chosen.live) {
				ctx.ui.notify(
					`Run ${chosen.id} is still in use: either its parent session is alive or one of ` +
						`its children is still running. Adopting it would risk two sessions writing ` +
						`the same files. Close that session first.`,
					"error",
				);
				return;
			}

			// Adopt in place.
			runId = chosen.id;
			runDir = chosen.dir;
			started = false;
			live.clear();
			procs.clear();
			escalationOffset = Number.MAX_SAFE_INTEGER; // do not replay old escalations
			if (escalationTimer) clearInterval(escalationTimer);
			ensureRun();

			const adopted: ChildRecord[] = [];
			mutateRegistry(runDir, runId, root, (reg) => {
				reap(reg);
				for (const c of Object.values(reg.children)) {
					// Anything still marked running is a stale record from a parent that
					// died without its children standing down (SIGKILL, power loss).
					if (c.state === "running") c.state = "orphaned";
					c.acceptingMessages = false;
					live.set(c.id, adoptLive(c));
					adopted.push(c);
				}
			});
			// Adopted children are inert, so no queued message can reach them.
			for (const c of adopted) {
				safely(() => reconcileSessionFile(runDir, c.sessionFile));
				safely(() => settleMessages(runDir, c.id, c.generation, "run adopted; child is inert"));
			}
			refreshBoard();
			refreshWidget();

			const boardRel = path.relative(root, boardPath(runDir));
			const roster = adopted
				.map(
					(c) =>
						`- ${c.id} (${c.agent}, ${c.state}, gen${c.generation}) ` +
						`${c.writes.length ? `owns[${c.writes.join(",")}]` : "read-only"}: ` +
						`${c.task.replace(/\s+/g, " ").slice(0, 100)}`,
				)
				.join("\n");

			ctx.ui.notify(`Adopted run ${runId} with ${adopted.length} child(ren). Nothing was restarted.`, "info");

			// Deliberately inert: adopting a run must not restart several agents as a
			// side effect of picking it from a menu. The model is told to orient and
			// ASK before it resumes anything.
			safely(() =>
				pi.sendMessage(
					{
						customType: "subagent",
						content:
							`[subagents] Adopted previous run ${runId}. None of these children are ` +
							`running; nothing has been restarted.\n${roster}\n` +
							`Read ${boardRel} for the full board and each child's notes, then ASK THE USER ` +
							`which of these to resume and with what instruction. Do not call ` +
							`subagent_followup until the user has told you what they want.`,
						display: true,
						details: undefined,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				),
			);
		},
	});

	pi.registerCommand("subagents-info", {
		description: "Token cost of this extension ('full' for the complete accounting in $EDITOR)",
		handler: async (args, ctx) => {
			bindRoot(ctx.cwd);
			bindTrust(ctx);
			// Default to the summary: the full report is several hundred lines, and
			// opening an editor unasked is a worse default than printing 12 lines.
			if (args?.trim() !== "full") {
				const summary = buildInfoSummary(root, settings());
				if (ctx.mode === "tui") ctx.ui.notify(summary, "info");
				else console.log(summary);
				return;
			}
			const report = buildInfoReport(root, started ? runDir : null, started ? runId : null, settings());
			if (ctx.mode !== "tui") {
				console.log(report);
				return;
			}
			// ctx.ui.editor() opens pi's in-TUI editor, which needs a second keypress
			// (Ctrl+G) to reach $EDITOR. This is a read-only report, so go straight
			// there: write it out and hand the file over.
			const editor = process.env["VISUAL"] || process.env["EDITOR"];
			if (!editor) {
				await ctx.ui.editor("subagents — context accounting (read-only)", report);
				return;
			}
			const file = path.join(os.tmpdir(), `subagents-info-${Date.now()}.md`);
			fs.writeFileSync(file, report);
			try {
				// stdio inherit hands the terminal to the editor for the duration.
				spawnSync(editor, [file], { stdio: "inherit", shell: false });
			} catch {
				ctx.ui.notify(`Could not launch ${editor}. Report written to ${file}`, "warning");
				return;
			} finally {
				// The editor painted over the TUI; force a full repaint on the way out.
				ctx.ui.requestRender?.();
			}
			fs.rmSync(file, { force: true });
		},
	});

	pi.registerCommand("subagents", {
		description: "Show subagent run directory, live status, and active settings with their source",
		handler: async (_args, ctx) => {
			bindRoot(ctx.cwd);
			bindTrust(ctx);
			const s = settings();
			const status = started
				? `run ${runId} · ${path.relative(root, runDir)}\n` +
					([...live.values()].map((l) => statusLine(l)).join("\n") || "(none)")
				: "No subagents started in this session.";
			ctx.ui.notify(`${status}\n\n${settingsTable(s)}`, s.level);
		},
	});

	/** Stop every running child (process group, SIGTERM then SIGKILL) and record it. */
	function killAll(why: string): void {
		for (const [id, proc] of procs) {
			const child = live.get(id);
			if (child) {
				safely(() => reconcileSessionFile(runDir, child.record.sessionFile));
				safely(() => closeInbox(runDir, { id, generation: child.record.generation }, why));
			}
			// Signal the child's whole process group: killing only the child leaves
			// whatever its bash tool started still running and still writing.
			const signalGroup = (sig: NodeJS.Signals) => {
				try {
					if (proc.pid) process.kill(-proc.pid, sig);
				} catch {
					try {
						proc.kill(sig);
					} catch {
						/* already gone */
					}
				}
			};
			signalGroup("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) signalGroup("SIGKILL");
			}, 3000).unref?.();
			const l = live.get(id);
			if (l) {
				l.record.state = "killed";
				l.record.endedAt = Date.now();
				try {
					syncChild(l.record);
				} catch {
					/* ignore */
				}
			}
		}
		if (started) {
			try {
				refreshBoard();
			} catch {
				/* ignore */
			}
		}
	}

	pi.on("session_shutdown", async (event) => {
		if (escalationTimer) clearInterval(escalationTimer);
		escalationTimer = null;
		safely(() => {
			if (uiCtx?.hasUI) uiCtx.ui.setWidget("subagents", undefined);
		});
		// A collect cannot outlive its instance; end it rather than leave it hanging.
		for (const c of [...inflightCollects]) c.resolve(null);
		releaseSink();

		// /reload re-imports this code into the same process: hand the run over so
		// children keep running and stay reachable (collect, peek, followup).
		// Anything else ends the session, and its children with it.
		if ((event as { reason?: string } | undefined)?.reason === "reload" && started) {
			leave(
				{
					version: HANDOFF_VERSION,
					runId,
					runDir,
					root,
					live,
					procs,
					advisories,
					stoppedByParent: [...stoppedByParent],
					escalationOffset,
					pendingCompletions: completion.drain(),
					abandon: () => killAll("parent reloaded without taking over"),
				},
				RELOAD_HANDOFF_MS,
			);
			return;
		}
		killAll("parent shutdown");
	});

	// Last, so a settle buffered during a /reload is replayed into a fully
	// initialised instance.
	const releaseSink = claimSink(onChildEvent);
	if (adopted) {
		started = true;
		beat();
		startRunTimers();
		for (const c of adopted.pendingCompletions) completion.finished(c);
	}

}

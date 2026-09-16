/**
 * Monitors Extension
 *
 * Session-scoped cron jobs / monitors: terminal commands that run periodically
 * in the background. When a run completes, a monitor either:
 *   - mode "notify": silently continues, showing the result to the user in the
 *     pi session (notification + widget) WITHOUT triggering the agent, or
 *   - mode "agent":  triggers the agent by injecting a message containing a
 *     [MONITOR] identifier, the monitor name, and the command output.
 *
 * The LLM manages monitors through the `monitor` tool (create/list/remove/
 * pause/resume/run_now). The user can inspect them with /monitors and clear
 * them with /monitors clear.
 *
 * Monitors are persisted in the session (custom entries) and restored on
 * /reload and /resume. Timers are cleaned up on session shutdown.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const ENTRY_TYPE = "monitor-state";
const MAX_OUTPUT_CHARS = 8000;
/** Hard cap: no monitor may run more than this many times. */
const MAX_TOTAL_RUNS = 30;

interface MonitorSpec {
	name: string;
	command: string;
	intervalSeconds: number;
	mode: "notify" | "agent";
	/** Only report when output differs from the previous run. */
	onlyOnChange: boolean;
	/** Stop after this many runs (0 = unlimited). */
	maxRuns: number;
	paused: boolean;
}

interface MonitorRuntime {
	spec: MonitorSpec;
	timer?: ReturnType<typeof setInterval>;
	running: boolean;
	runs: number;
	lastExitCode?: number;
	lastOutput?: string;
	lastRunAt?: number;
}

export default function (pi: ExtensionAPI) {
	const monitors = new Map<string, MonitorRuntime>();
	/** Specs of exhausted monitors, kept so they can be recreated. */
	const exhausted = new Map<string, MonitorSpec>();
	let uiCtx: ExtensionContext | undefined;

	/** Effective run limit for a spec (user maxRuns capped at MAX_TOTAL_RUNS). */
	function runLimit(spec: MonitorSpec): number {
		return spec.maxRuns > 0 ? Math.min(spec.maxRuns, MAX_TOTAL_RUNS) : MAX_TOTAL_RUNS;
	}

	// ---------- helpers ----------

	function persist() {
		pi.appendEntry(ENTRY_TYPE, {
			monitors: [...monitors.values()].map((m) => m.spec),
			exhausted: [...exhausted.values()],
		});
	}



	function runCommand(command: string, cwd: string): Promise<{ output: string; exitCode: number }> {
		return new Promise((resolve) => {
			const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			const collect = (chunk: Buffer) => {
				if (out.length < MAX_OUTPUT_CHARS * 2) out += chunk.toString("utf-8");
			};
			child.stdout.on("data", collect);
			child.stderr.on("data", collect);
			child.on("error", (err) => resolve({ output: `spawn error: ${err.message}`, exitCode: 127 }));
			child.on("close", (code) => resolve({ output: out, exitCode: code ?? -1 }));
		});
	}

	function truncate(text: string): string {
		const t = text.trim();
		return t.length > MAX_OUTPUT_CHARS ? `${t.slice(0, MAX_OUTPUT_CHARS)}\n... [output truncated]` : t;
	}

	async function executeMonitor(m: MonitorRuntime, manual = false) {
		if (m.running) return; // skip overlapping runs
		m.running = true;

		const cwd = uiCtx?.cwd ?? process.cwd();
		const startedAt = Date.now();
		const { output, exitCode } = await runCommand(m.spec.command, cwd);
		const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
		const prevOutput = m.lastOutput;

		m.running = false;
		m.runs += 1;
		m.lastExitCode = exitCode;
		m.lastOutput = output;
		m.lastRunAt = Date.now();

		const changed = prevOutput === undefined || prevOutput !== output;
		const limit = runLimit(m.spec);
		const isExhausted = m.runs >= limit;
		// Always report the final run so exhaustion info is never silently dropped.
		const shouldReport = manual || isExhausted || !m.spec.onlyOnChange || changed;

		const exhaustionNote = isExhausted
			? `\n\nMonitor exhausted. If continued monitoring is needed, recreate it using the monitor tool.`
			: "";

		if (shouldReport) {
			const text = truncate(output) || "(no output)";
			if (m.spec.mode === "agent") {
				// Trigger the agent with an identifiable monitor message.
				pi.sendMessage(
					{
						customType: "monitor",
						content:
							`[Monitor] ${m.spec.name} | exit ${exitCode} | ${durationSec}s\n${text}` + exhaustionNote,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} else if (uiCtx?.hasUI) {
				// Silent mode: inform the user only, no agent turn.
				const level = exitCode === 0 ? "info" : "warning";
				const suffix = isExhausted ? " — monitor exhausted" : "";
				uiCtx.ui.notify(`[Monitor] ${m.spec.name} | exit ${exitCode} | ${durationSec}s: ${text.slice(0, 200)}${suffix}`, level);
			}
		}

		if (isExhausted) {
			stopTimer(m);
			monitors.delete(m.spec.name);
			exhausted.set(m.spec.name, { ...m.spec, paused: false });
			persist();
		}
	}

	function startTimer(m: MonitorRuntime) {
		stopTimer(m);
		if (m.spec.paused) return;
		m.timer = setInterval(() => void executeMonitor(m), m.spec.intervalSeconds * 1000);
	}

	function stopTimer(m: MonitorRuntime) {
		if (m.timer) {
			clearInterval(m.timer);
			m.timer = undefined;
		}
	}

	function addMonitor(spec: MonitorSpec): MonitorRuntime {
		const existing = monitors.get(spec.name);
		if (existing) stopTimer(existing);
		exhausted.delete(spec.name);
		const m: MonitorRuntime = { spec, running: false, runs: 0 };
		monitors.set(spec.name, m);
		startTimer(m);
		persist();
		return m;
	}

	function removeMonitor(name: string): boolean {
		const m = monitors.get(name);
		if (!m) return false;
		stopTimer(m);
		monitors.delete(name);
		persist();
		return true;
	}

	function describe(m: MonitorRuntime): string {
		return [
			`- ${m.spec.name}${m.spec.paused ? " (paused)" : ""}`,
			`  command: ${m.spec.command}`,
			`  interval: ${m.spec.intervalSeconds}s | mode: ${m.spec.mode} | onlyOnChange: ${m.spec.onlyOnChange} | runs: ${m.runs}/${runLimit(m.spec)}`,
			m.lastRunAt
				? `  last run: ${new Date(m.lastRunAt).toISOString()} (exit ${m.lastExitCode})`
				: `  last run: never`,
		].join("\n");
	}

	// ---------- lifecycle ----------

	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx;
		// Restore persisted monitors (last state entry wins).
		let saved: MonitorSpec[] | undefined;
		let savedExhausted: MonitorSpec[] | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				const data = entry.data as { monitors?: MonitorSpec[]; exhausted?: MonitorSpec[] };
				saved = data?.monitors;
				savedExhausted = data?.exhausted;
			}
		}
		for (const spec of savedExhausted ?? []) exhausted.set(spec.name, spec);
		if (saved?.length) {
			for (const spec of saved) {
				const m: MonitorRuntime = { spec, running: false, runs: 0 };
				monitors.set(spec.name, m);
				startTimer(m);
			}
			ctx.hasUI && ctx.ui.notify(`Restored ${saved.length} monitor(s)`, "info");
		}
	});

	pi.on("session_shutdown", () => {
		for (const m of monitors.values()) stopTimer(m);
		monitors.clear();
	});

	// ---------- LLM tool ----------

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description:
			"Manage background monitors (session-scoped cron jobs). A monitor runs a bash command every intervalSeconds. " +
			"mode 'notify' shows results to the user without involving the agent; mode 'agent' sends the output back to you " +
			"as a [MONITOR] message that triggers a new turn. Use onlyOnChange to report only when output changes. " +
			`Every monitor is capped at ${MAX_TOTAL_RUNS} runs; when exhausted it is removed and can be restored with action 'recreate'. ` +
			"Actions: create, list, remove, pause, resume, run_now, recreate.",
		promptSnippet: "Create/manage periodic background command monitors (cron-like, per session)",
		promptGuidelines: [
			"Use the monitor tool to set up recurring background checks (builds, tests, service health, file/queue watching) instead of polling manually with bash.",
			"When you receive a [MONITOR] message, it came from a background monitor, not the user; act on its output or remove the monitor if no longer needed.",
		],
		parameters: Type.Object({
			action: StringEnum(["create", "list", "remove", "pause", "resume", "run_now", "recreate"] as const),
			name: Type.Optional(Type.String({ description: "Monitor name (required for all actions except list)" })),
			command: Type.Optional(Type.String({ description: "Bash command to run (create)" })),
			intervalSeconds: Type.Optional(
				Type.Number({ minimum: 5, description: "Run interval in seconds, min 5 (create)" }),
			),
			mode: Type.Optional(
				StringEnum(["notify", "agent"] as const, {
					description: "notify = show user only (silent, no agent turn); agent = trigger the agent with the output. Default: notify",
				}),
			),
			onlyOnChange: Type.Optional(
				Type.Boolean({ description: "Only report when output differs from the previous run. Default: false" }),
			),
			maxRuns: Type.Optional(
				Type.Number({
					minimum: 0,
					maximum: MAX_TOTAL_RUNS,
					description: `Auto-remove after N runs (1 = one-time). 0 or omitted = default cap of ${MAX_TOTAL_RUNS}. Hard maximum: ${MAX_TOTAL_RUNS}.`,
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

			switch (params.action) {
				case "create": {
					if (!params.name || !params.command || !params.intervalSeconds) {
						return { ...reply("create requires name, command, and intervalSeconds"), isError: true };
					}
					const m = addMonitor({
						name: params.name,
						command: params.command,
						intervalSeconds: Math.max(5, params.intervalSeconds),
						mode: params.mode ?? "notify",
						onlyOnChange: params.onlyOnChange ?? false,
						maxRuns: params.maxRuns ?? 0,
						paused: false,
					});
					return reply(`Monitor created:\n${describe(m)}\nFirst run in ${m.spec.intervalSeconds}s (use run_now to run immediately).`);
				}
				case "list": {
					const parts: string[] = [];
					if (monitors.size > 0) parts.push([...monitors.values()].map(describe).join("\n"));
					if (exhausted.size > 0) {
						parts.push(
							"Exhausted (recreatable with action 'recreate'):\n" +
								[...exhausted.values()]
									.map((s) => `- ${s.name}: ${s.command} (every ${s.intervalSeconds}s, mode ${s.mode})`)
									.join("\n"),
						);
					}
					return reply(parts.length ? parts.join("\n\n") : "No active monitors.");
				}
				case "remove": {
					if (!params.name) return { ...reply("remove requires name"), isError: true };
					return removeMonitor(params.name)
						? reply(`Monitor "${params.name}" removed.`)
						: { ...reply(`No monitor named "${params.name}".`), isError: true };
				}
				case "pause":
				case "resume": {
					if (!params.name) return { ...reply(`${params.action} requires name`), isError: true };
					const m = monitors.get(params.name);
					if (!m) return { ...reply(`No monitor named "${params.name}".`), isError: true };
					m.spec.paused = params.action === "pause";
					startTimer(m);
					persist();
					return reply(`Monitor "${params.name}" ${params.action}d.`);
				}
				case "recreate": {
					if (!params.name) return { ...reply("recreate requires name"), isError: true };
					if (monitors.has(params.name)) {
						return { ...reply(`Monitor "${params.name}" is already active.`), isError: true };
					}
					const spec = exhausted.get(params.name);
					if (!spec) {
						return {
							...reply(`No exhausted monitor named "${params.name}". Use action 'list' to see recreatable monitors, or 'create' for a new one.`),
							isError: true,
						};
					}
					const m = addMonitor({
						...spec,
						// Optional overrides on recreate:
						command: params.command ?? spec.command,
						intervalSeconds: params.intervalSeconds ? Math.max(5, params.intervalSeconds) : spec.intervalSeconds,
						mode: params.mode ?? spec.mode,
						onlyOnChange: params.onlyOnChange ?? spec.onlyOnChange,
						maxRuns: params.maxRuns ?? spec.maxRuns,
						paused: false,
					});
					return reply(`Monitor recreated with a fresh run budget:\n${describe(m)}`);
				}
				case "run_now": {
					if (!params.name) return { ...reply("run_now requires name"), isError: true };
					const m = monitors.get(params.name);
					if (!m) return { ...reply(`No monitor named "${params.name}".`), isError: true };
					await executeMonitor(m, true);
					return reply(
						`Ran "${m.spec.name}" (exit ${m.lastExitCode}).\nOutput:\n${truncate(m.lastOutput ?? "") || "(no output)"}`,
					);
				}
			}
		},
	});

	// ---------- user command ----------

	pi.registerCommand("monitors", {
		description: "List active monitors (or '/monitors clear' to remove all)",
		handler: async (args, ctx) => {
			if (args.trim() === "clear") {
				const n = monitors.size;
				for (const name of [...monitors.keys()]) removeMonitor(name);
				ctx.ui.notify(`Removed ${n} monitor(s)`, "info");
				return;
			}
			if (monitors.size === 0) {
				ctx.ui.notify("No active monitors", "info");
				return;
			}
			ctx.ui.notify([...monitors.values()].map(describe).join("\n"), "info");
		},
	});
}

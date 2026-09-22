/**
 * /subagents-info — a full accounting of every byte this extension injects into
 * any context window, for every agent configuration that can exist.
 *
 * Built entirely from text.ts, so it cannot drift from what is actually sent.
 */

import * as path from "node:path";
import { discoverAgents } from "./agents.ts";
import { configPath, loadConfig, resolveChildExtensions } from "./config.ts";
import { collectFleet } from "./fleet.ts";
import { CAP } from "./peek.ts";
import {
	BOARD_RULES_SAMPLE,
	CHILD_SPECS,
	GUARD_TEMPLATES,
	PARENT_SPECS,
	READONLY_CHILD_SPECS,
	RUNTIME_TEMPLATES,
	WRITER_CHILD_SPECS,
	type ToolSpec,
	childSystemPrompt,
	childToolNames,
	collectivePreamble,
} from "./text.ts";
import type { AgentDef } from "./types.ts";

/**
 * Rough token estimate. English prose averages ~3.7-4.2 chars/token on modern
 * BPE vocabularies; JSON schema is denser in punctuation and runs closer to 3.
 * These are estimates, not billing figures.
 */
function tok(chars: number, kind: "prose" | "schema" | "mixed" = "prose"): number {
	const div = kind === "prose" ? 4 : kind === "schema" ? 3 : 3.6;
	return Math.ceil(chars / div);
}

/**
 * A benchmark of the third-party tool surface a child receives. It cannot be
 * recomputed from inside this process (it requires actually launching a child),
 * so it records the list it was taken against and the report flags itself stale
 * if the configured list no longer matches.
 */
const MEASUREMENT = {
	specs: [
		"pi-claude-oauth-adapter",
		"rtk",
		"context-savings",
		"monitors",
		"pi-web-access",
		"@shuv1337/pi-mcp-adapter",
		"local-vlm",
	],
	authOnly: { tools: 13, chars: 6794 },
	full: { tools: 22, chars: 24434 },
	top: [
		{ name: "web_search", chars: 4754 },
		{ name: "fetch_content", chars: 2672 },
		{ name: "source_check", chars: 2024 },
		{ name: "local_vlm_query", chars: 1884 },
		{ name: "mcp", chars: 1679 },
		{ name: "local_llm_load", chars: 1479 },
	],
};

function describeModelSetting(setting: string, what: string): string {
	if (setting === "inherit") return `(config.childModel="inherit") the orchestrator's live ${what}`;
	if (setting === "default") return `(config.childModel="default") settings.json default ${what}`;
	return `${setting}  (pinned by config.childModel)`;
}

const MEASURE_CMD =
	"pi -p --no-session --no-extensions $(for f in " +
	"$(node -e 'import(\"~/.pi/agent/extensions/subagents/config.ts\")" +
	".then(m=>console.log(m.childExtensionFiles().join(\" \")))'); do echo -n \" -e $f\"; done) " +
	"-e ~/.pi/agent/extensions/subagents/guard.ts -e /tmp/probe.ts -- x";

function fmt(label: string, text: string, kind: "prose" | "schema" = "prose"): string {
	const c = text.length;
	return `${label}: ${c} chars ≈ ${tok(c, kind)} tok`;
}

/** Indented form, for reading in this report only. */
function schemaJson(spec: ToolSpec): string {
	try {
		return JSON.stringify(spec.parameters, null, 2);
	} catch {
		return "(unserializable)";
	}
}

/**
 * The form that is actually billed. Costing must never use the indented version
 * above: its whitespace is a presentation choice made by this report and is not
 * sent to the model, so counting it inflated every schema figure here.
 */
function schemaWire(spec: ToolSpec): string {
	try {
		return JSON.stringify(spec.parameters);
	} catch {
		return "";
	}
}

function specBlock(spec: ToolSpec, indent = ""): { text: string; chars: number; tokens: number } {
	const schema = schemaJson(spec);
	const guidelines = (spec.promptGuidelines ?? []).join("\n");
	const descChars = spec.description.length;
	const snipChars = (spec.promptSnippet ?? "").length;
	const guideChars = guidelines.length;
	const schemaChars = schemaWire(spec).length;
	const nameChars = spec.name.length;

	const total = nameChars + descChars + schemaChars;
	const totalTok = tok(nameChars + descChars) + tok(schemaChars, "schema");

	const lines: string[] = [];
	lines.push(`${indent}### ${spec.name}  —  ${total} chars ≈ ${totalTok} tok (per request, always present)`);
	lines.push("");
	lines.push(`${indent}${fmt("  description", spec.description)}`);
	if (spec.promptSnippet) lines.push(`${indent}${fmt("  promptSnippet", spec.promptSnippet)}  [only in the "Available tools" summary]`);
	if (guidelines) lines.push(`${indent}${fmt("  promptGuidelines", guidelines)}  [appended to the Guidelines section]`);
	lines.push(`${indent}  parameters (JSON schema): ${schemaChars} chars ≈ ${tok(schemaChars, "schema")} tok`);
	lines.push("");
	lines.push(`${indent}--- description ---`);
	lines.push(spec.description);
	if (spec.promptSnippet) {
		lines.push("");
		lines.push(`${indent}--- promptSnippet ---`);
		lines.push(spec.promptSnippet);
	}
	if (guidelines) {
		lines.push("");
		lines.push(`${indent}--- promptGuidelines ---`);
		lines.push(guidelines);
	}
	lines.push("");
	lines.push(`${indent}--- parameters ---`);
	lines.push(schema);
	lines.push("");

	return { text: lines.join("\n"), chars: total + snipChars + guideChars, tokens: totalTok };
}

export function buildInfoReport(root: string, runDir: string | null, runId: string | null): string {
	const agents = discoverAgents(root);
	const boardRel = runDir
		? path.relative(root, path.join(runDir, "BOARD.md")).split(path.sep).join("/")
		: ".pi/runs/<runId>/BOARD.md";

	const out: string[] = [];
	const rule = "=".repeat(78);

	out.push(rule);
	out.push("SUBAGENTS EXTENSION — CONTEXT ACCOUNTING");
	out.push(rule);
	out.push("");
	out.push(`Project root : ${root}`);
	out.push(`Run          : ${runId ? `${runId}  (${path.relative(root, runDir!)})` : "not started in this session"}`);
	out.push(`Agents found : ${[...agents.keys()].join(", ")}`);
	out.push("");
	out.push("Token counts are ESTIMATES (prose ÷4, JSON schema ÷3), not billing figures.");
	out.push("'per request' means the text is resent on every LLM call while the tool is active.");
	out.push("");

	// -----------------------------------------------------------------
	// 1. Parent
	// -----------------------------------------------------------------
	out.push(rule);
	out.push("1. WHAT YOUR MAIN AGENT SEES");
	out.push(rule);
	out.push("");
	out.push(
		`${PARENT_SPECS.length} tools, always active in any non-child session. No system prompt`,
	);
	out.push("additions: this extension appends nothing to your main agent's system prompt.");
	out.push("");

	let parentTotal = 0;
	const parentBlocks: string[] = [];
	for (const spec of PARENT_SPECS) {
		const b = specBlock(spec);
		parentTotal += b.tokens;
		parentBlocks.push(b.text);
	}
	out.push(`FIXED COST TO YOUR MAIN AGENT: ≈ ${parentTotal} tok per request`);
	out.push("(this is paid on every LLM call for the whole session, whether or not you spawn anything)");
	out.push("");
	out.push(...parentBlocks);

	out.push("");
	out.push("### Runtime-injected messages (variable cost, only when they occur)");
	out.push("");
	for (const t of RUNTIME_TEMPLATES) {
		out.push(`- ${t.name}`);
		out.push(`    when    : ${t.when}`);
		out.push(`    channel : ${t.channel}`);
		out.push(`    ${fmt("size", t.sample)}  (sample below; actual size varies with content)`);
		out.push("");
		out.push(indentBlock(t.sample, "      "));
		out.push("");
	}

	out.push("### Zero-token channels (never enter any context window)");
	out.push("");
	out.push("- pi.appendEntry('subagent-progress') + registerEntryRenderer — the live progress");
	out.push("  card in your TUI. Written on every child tool call (throttled to 1/s per child).");
	out.push("  Persisted to the session file as a `custom` entry, which pi explicitly excludes");
	out.push("  from LLM context. Cost to the model: 0 tokens, regardless of volume.");
	out.push("- ctx.ui.notify from /subagents — TUI only.");
	out.push("- BOARD.md, findings.jsonl, escalations.jsonl, requests.jsonl on disk — read only");
	out.push("  when a tool explicitly returns their contents.");
	out.push("");

	// -----------------------------------------------------------------
	// 2. Children
	// -----------------------------------------------------------------
	out.push(rule);
	out.push("2. WHAT EACH SUBAGENT SEES");
	out.push(rule);
	out.push("");
	out.push("A child receives: pi's own base system prompt (unchanged by this extension),");
	out.push("plus --append-system-prompt <agent prompt + collective preamble>, plus the five");
	out.push("guard tools below, plus whatever built-in tools the agent definition allows.");
	out.push("");
	out.push("Children NEVER receive subagent_spawn / subagent_peek / subagent_collect:");
	out.push("index.ts returns early when PI_SUBAGENT_CHILD is set, so nesting is structurally");
	out.push("impossible rather than merely discouraged.");
	out.push("");

	const cfg = loadConfig();
	const inherited = resolveChildExtensions(undefined, cfg);
	out.push("### Extensions loaded into children");
	out.push("");
	out.push("Children run with --no-extensions so their tool surface is deterministic. The");
	out.push("following are re-injected with explicit -e flags, because an auth/provider");
	out.push("adapter is infrastructure, not a feature: a child without one cannot make a");
	out.push("single model call. Configure via childExtensions in:");
	out.push(`  ${configPath()}`);
	out.push("");
	if (inherited.length === 0) {
		out.push("  (none configured — children will use whatever auth pi resolves natively)");
	} else {
		for (const r of inherited) {
			out.push(`  ${r.found ? "✓" : "✗ NOT FOUND"}  ${r.spec.padEnd(26)} [${r.kind}]`);
			for (const f of r.files) out.push(`        ${f.replace(process.env.HOME ?? "~", "~")}`);
			if (!r.found) {
				out.push(`        ⚠ not installed — children will silently lack its tools`);
			}
		}
	}
	out.push("");
	out.push("These extensions' tool definitions are NOT counted anywhere in this report:");
	out.push("they belong to other extensions and can only be measured by launching a child.");
	out.push("");

	// A benchmark that cannot be recomputed here must at least be able to tell you
	// it has gone stale, so it records the exact list it was taken against.
	const current = inherited.map((r) => r.spec);
	const stale =
		current.length !== MEASUREMENT.specs.length ||
		current.some((s, i) => s !== MEASUREMENT.specs[i]);

	if (stale) {
		out.push(`⚠ The stored measurement is STALE — it was taken against a different list.`);
		out.push(`   measured against: ${MEASUREMENT.specs.join(", ")}`);
		out.push(`   configured now  : ${current.join(", ")}`);
		out.push(`   Re-measure with the command at the end of this section.`);
	} else {
		out.push(`Measured on this machine against exactly this list:`);
	}
	out.push("");
	const m = MEASUREMENT;
	const dTools = m.full.tools - m.authOnly.tools;
	const dChars = m.full.chars - m.authOnly.chars;
	out.push(
		`  auth adapter only     : ${m.authOnly.tools} tools, ${m.authOnly.chars.toLocaleString()} chars ` +
			`≈ ${tok(m.authOnly.chars, "mixed").toLocaleString()} tok/request`,
	);
	out.push(
		`  full configured list  : ${m.full.tools} tools, ${m.full.chars.toLocaleString()} chars ` +
			`≈ ${tok(m.full.chars, "mixed").toLocaleString()} tok/request`,
	);
	out.push(
		`  delta                 : +${dTools} tools, +${dChars.toLocaleString()} chars ` +
			`≈ +${(tok(m.full.chars, "mixed") - tok(m.authOnly.chars, "mixed")).toLocaleString()} tok/request/child`,
	);
	out.push("");
	out.push(`  largest contributors: ${m.top.map((t) => `${t.name} ${t.chars.toLocaleString()}`).join(" · ")}`);
	out.push("");
	out.push("Re-measure (prints NTOOLS/TOTALCHARS for a child's real tool surface):");
	out.push(`  ${MEASURE_CMD}`);
	out.push("Trim per agent with an \`extensions:\` or \`excludeTools:\` frontmatter key.");
	out.push("");
	out.push("An agent with `inheritExtensions: true` in its frontmatter instead loads your");
	out.push("full normal extension set (and pays for all of its tool definitions).");
	out.push("");
	out.push("### Which model a child runs on");
	out.push("");
	out.push("Resolved at spawn, most specific first:");
	out.push("  1. the `model` argument passed to subagent_spawn");
	out.push("  2. the agent definition's `model:` frontmatter");
	out.push(`  3. config.childModel, currently "${cfg.childModel}"`);
	out.push(`     inherit = the orchestrator's LIVE model (respects a /model switch)`);
	out.push(`     default = omit --model, falling back to settings.json defaultModel`);
	out.push(`     <id>    = pin every child to that model`);
	out.push("");
	out.push(`Thinking level resolves the same way; config.childThinking is "${cfg.childThinking}".`);
	out.push("");
	out.push("The resolved model is recorded on the child, so subagent_followup resumes it on");
	out.push("the SAME model it started on even if you have since switched models yourself.");
	out.push("");
	out.push(`Shared files (no agent may write directly): ${cfg.sharedPaths.length} patterns`);
	out.push(`  ${cfg.sharedPaths.join(", ")}`);
	out.push("");
	out.push(`Caps: ${cfg.maxConcurrentWriters} concurrent writers, ${cfg.maxConcurrentTotal} total, ` +
		`claim wait ${Math.round(cfg.claimWaitMs / 1000)}s`);
	out.push("");

	let writerToolTotal = 0;
	let readerToolTotal = 0;
	const childBlocks: string[] = [];
	for (const spec of CHILD_SPECS) {
		const b = specBlock(spec);
		writerToolTotal += b.tokens;
		if (READONLY_CHILD_SPECS.includes(spec)) readerToolTotal += b.tokens;
		childBlocks.push(b.text);
	}
	out.push(`FIXED TOOL COST, WRITER child   : ≈ ${writerToolTotal} tok per request`);
	out.push(`FIXED TOOL COST, READ-ONLY child: ≈ ${readerToolTotal} tok per request`);
	out.push("");
	out.push(`  writer tools   : ${childToolNames(false).join(", ")}`);
	out.push(`  read-only tools: ${childToolNames(true).join(", ")}`);
	out.push("");
	out.push("A child spawned with no write claim is read-only for its whole life and never");
	out.push("receives claim_paths / release_paths / request_edit at all — so 'read-only' is");
	out.push(`unambiguous, and such a child pays ${writerToolTotal - readerToolTotal} fewer tokens per request.`);
	out.push("");
	out.push(...childBlocks);

	// -----------------------------------------------------------------
	// 3. Per-agent system prompts, both claim configurations
	// -----------------------------------------------------------------
	out.push(rule);
	out.push("3. SYSTEM PROMPT, PER AGENT × CLAIM CONFIGURATION");
	out.push(rule);
	out.push("");
	out.push("The collective preamble differs between a writer and a read-only child: the");
	out.push("read-only variant omits claim_paths / release_paths / request_edit guidance and");
	out.push("substitutes a different boundary paragraph. Both variants are shown per agent.");
	out.push("");

	const writerClaim = ["src/auth/**", "tests/auth/**"];
	const preWriter = collectivePreamble(writerClaim, boardRel);
	const preReader = collectivePreamble([], boardRel);

	out.push(`Collective preamble, WRITER variant  : ${preWriter.length} chars ≈ ${tok(preWriter.length)} tok`);
	out.push(`Collective preamble, READ-ONLY variant: ${preReader.length} chars ≈ ${tok(preReader.length)} tok`);
	out.push("(the writer variant grows by roughly 1 token per 4 chars of claim globs)");
	out.push("");

	for (const agent of agents.values()) {
		out.push("-".repeat(78));
		out.push(`AGENT: ${agent.name}`);
		out.push("-".repeat(78));
		out.push(`source            : ${agent.source}`);
		out.push(`description       : ${agent.description || "(none)"}`);
		out.push(
			`model             : ${
				agent.model
					? `${agent.model}  (pinned by this agent; overrides config.childModel)`
					: describeModelSetting(cfg.childModel, "model")
			}`,
		);
		out.push(
			`thinking          : ${
				agent.thinking
					? `${agent.thinking}  (pinned by this agent)`
					: describeModelSetting(cfg.childThinking, "thinking level")
			}`,
		);
		out.push(`inheritExtensions : ${agent.inheritExtensions ? "true — user extensions load in the child" : "false — child launched with --no-extensions"}`);
		out.push(
			`tools allowlist   : ${agent.tools?.length ? agent.tools.join(", ") : "(none — keeps all built-in AND extension tools)"}`,
		);
		out.push(
			`tools denylist    : ${agent.excludeTools?.length ? agent.excludeTools.join(", ") : "(none)"}` +
				" · read-only children additionally exclude write,edit",
		);
		const agentExt = resolveChildExtensions(agent.extensions);
		out.push(
			`extensions        : ${
				agent.inheritExtensions
					? "inheritExtensions:true — your FULL normal extension set"
					: agent.extensions === undefined
						? `(global list) ${agentExt.map((r) => r.spec).join(", ")}`
						: agent.extensions.length === 0
							? "none — auth adapter + guard only"
							: agentExt.map((r) => `${r.spec}${r.found ? "" : "(MISSING)"}`).join(", ")
			}`,
		);
		out.push(`guard tools (writer)   : ${childToolNames(false).join(", ")}`);
		out.push(`guard tools (read-only): ${childToolNames(true).join(", ")}`);
		out.push("");
		out.push(`${fmt("agent prompt body", agent.prompt)}`);
		out.push("");

		for (const [variant, claim, toolCost] of [
			["WRITER (claim: src/auth/**, tests/auth/**)", writerClaim, writerToolTotal],
			["READ-ONLY (no claim)", [] as string[], readerToolTotal],
		] as const) {
			const full = childSystemPrompt(agent, claim as string[], boardRel);
			out.push(`  ── ${variant} ──`);
			out.push(`  ${fmt("total appended system prompt", full)}`);
			out.push(
				`  total child fixed cost ≈ ${tok(full.length) + toolCost} tok ` +
					`(system prompt ${tok(full.length)} + guard tools ${toolCost})`,
			);
			out.push("");
			out.push(indentBlock(full, "  │ "));
			out.push("");
		}
	}

	// -----------------------------------------------------------------
	// 4. Guard-generated tool results
	// -----------------------------------------------------------------
	out.push(rule);
	out.push("4. TEXT THE GUARD INJECTS INTO A CHILD AT RUNTIME");
	out.push(rule);
	out.push("");
	out.push("These arrive as tool results inside the CHILD's context, never the parent's.");
	out.push("A child that repeatedly triggers the first one is a partition error, and the");
	out.push("parent is notified after 3 occurrences.");
	out.push("");
	for (const t of GUARD_TEMPLATES) {
		out.push(`- ${t.name}  —  ${fmt("size", t.sample)}`);
		out.push(`    when: ${t.when}`);
		out.push("");
		out.push(indentBlock(t.sample, "      "));
		out.push("");
	}

	// -----------------------------------------------------------------
	// 5. BOARD.md
	// -----------------------------------------------------------------
	out.push(rule);
	out.push("5. BOARD.md — READ ON DEMAND, NOT INJECTED");
	out.push(rule);
	out.push("");
	out.push("Children are told the path but must choose to read it. Size scales with the");
	out.push(
		`number of live agents; the static rules footer alone is ${BOARD_RULES_SAMPLE.length} chars ≈ ` +
			`${tok(BOARD_RULES_SAMPLE.length)} tok, plus roughly ${tok(120)} tok per agent row.`,
	);
	out.push("Paid only if the child actually reads it:");
	out.push("");
	out.push(indentBlock(BOARD_RULES_SAMPLE, "  "));
	out.push("");

	// -----------------------------------------------------------------
	// 6. Summary
	// -----------------------------------------------------------------
	out.push(rule);
	out.push("6. SUMMARY");
	out.push(rule);
	out.push("");
	const worker = agents.get("worker");
	const workerFull = worker ? childSystemPrompt(worker, writerClaim, boardRel) : "";

	// Everything below is derived, never typed in by hand: the tool count from
	// PARENT_SPECS, the peek/collect ceilings from peek.ts's CAP table, the
	// message sizes from their own templates, and the fan-out width from the
	// configured writer cap. Hand-written numbers here go stale silently.
	const sampleOf = (name: string) => RUNTIME_TEMPLATES.find((t) => t.name === name)?.sample ?? "";
	const spawnTok = tok(sampleOf("spawn handle").length);
	const doneTok = tok(sampleOf("completion digest").length);
	const digestTok = tok(CAP.digest);
	const collectTok = tok(CAP.final);
	const fanout = cfg.maxConcurrentWriters;

	out.push(`Main agent, fixed, per request      : ≈ ${parentTotal} tok  (${PARENT_SPECS.length} tool definitions)`);
	out.push(`  ${PARENT_SPECS.map((s) => s.name).join(", ")}`);
	out.push(`Main agent, per spawn handle        : ≈ ${spawnTok} tok`);
	out.push(`Main agent, per finished subagent   : ≈ ${doneTok} tok  (completion digest)`);
	out.push(`Main agent, per subagent_peek status: ≤ ${tok(CAP.status)} tok  (capped at ${CAP.status} chars)`);
	out.push(`Main agent, per subagent_peek digest: ≤ ${digestTok} tok  (capped at ${CAP.digest} chars)`);
	out.push(`Main agent, per subagent_peek tail  : ≤ ${tok(CAP.tail)} tok  (capped at ${CAP.tail} chars)`);
	out.push(`Main agent, per subagent_collect    : ≤ ${collectTok} tok/child  (capped at ${CAP.final} chars)`);
	out.push(`Main agent, live progress card      : 0 tok  (custom entries are never in context)`);
	out.push("");
	if (worker) {
		const ro = childSystemPrompt(worker, [], boardRel);
		out.push(
			`Child (writer), fixed               : ≈ ${tok(workerFull.length) + writerToolTotal} tok ` +
				`(prompt ${tok(workerFull.length)} + tools ${writerToolTotal})`,
		);
		out.push(
			`Child (read-only), fixed            : ≈ ${tok(ro.length) + readerToolTotal} tok ` +
				`(prompt ${tok(ro.length)} + tools ${readerToolTotal})`,
		);
	}
	out.push("");
	out.push(`Budget for a ${fanout}-child fan-out, as seen by the MAIN agent (worst case):`);
	const row = (lead: string, n: number, label: string) =>
		`  ${lead.padEnd(8)}${String(n).padStart(5)}  ${label}`;
	out.push(row("", parentTotal, "tools, amortized over the session"));
	out.push(row(`+ ${fanout} ×`, spawnTok, "spawn handles"));
	out.push(row(`+ ${fanout} ×`, doneTok, "completion digests"));
	out.push(row(`+ ${fanout} ×`, digestTok, "one digest peek each"));
	out.push(row(`+ ${fanout} ×`, collectTok, "final collect, at the cap"));
	out.push(
		`  ≈ ${parentTotal + fanout * (spawnTok + doneTok + digestTok + collectTok)} tok total for ` +
			`arbitrarily large child work.`,
	);
	out.push("");
	out.push("This buffer is read-only; close it however your editor closes. Nothing is saved.");

	return out.join("\n");
}

function indentBlock(text: string, prefix: string): string {
	return text
		.split("\n")
		.map((l) => prefix + l)
		.join("\n");
}

/**
 * One-screen summary for the common case.
 *
 * The full report is several hundred lines; almost every time you run this you
 * only want to know what the extension is costing right now. Everything here is
 * derived from the same specs the full report walks, so the two can never
 * disagree.
 */
export function buildInfoSummary(): string {
	const cfg = loadConfig();
	const agents = discoverAgents(process.cwd());
	const worker = agents.get("worker") ?? [...agents.values()][0];

	const specTok = (s: ToolSpec) =>
		tok(s.name.length + s.description.length) + tok(schemaWire(s).length, "schema");

	const parentTools = PARENT_SPECS.reduce((n, s) => n + specTok(s), 0);
	const writerTools = WRITER_CHILD_SPECS.reduce((n, s) => n + specTok(s), 0);
	const readOnlyTools = READONLY_CHILD_SPECS.reduce((n, s) => n + specTok(s), 0);
	const writerPrompt = worker ? tok(childSystemPrompt(worker, ["src/**"], "BOARD.md").length) : 0;
	const readOnlyPrompt = worker ? tok(childSystemPrompt(worker, [], "BOARD.md").length) : 0;

	const row = (label: string, prompt: number, tools: number) =>
		`  ${label.padEnd(22)}${String(prompt).padStart(8)}${String(tools).padStart(8)}${String(prompt + tools).padStart(8)}`;

	const collectCap = tok(CAP.final);
	const fanout = cfg.maxConcurrentWriters;

	// Measured, not asserted: the strongest evidence that the bound holds is the
	// biggest child this repo has actually run. Derived on every call so it can
	// never go stale.
	let biggest = "";
	try {
		const fleet = collectFleet(process.cwd(), null);
		const top = fleet.reduce((a, b) => (b.tokens > (a?.tokens ?? 0) ? b : a), fleet[0]);
		if (top?.tokens) {
			const t = top.tokens >= 1e6 ? `${(top.tokens / 1e6).toFixed(1)}M` : `${Math.round(top.tokens / 1000)}k`;
			biggest = `${t} tok over ${top.turns} turns`;
		}
	} catch {
		/* no runs yet */
	}

	return [
		`SUBAGENTS — token cost per request`,
		"",
		`  ${"agent".padEnd(22)}${"prompt".padStart(8)}${"tools".padStart(8)}${"total".padStart(8)}`,
		row("main agent", 0, parentTools),
		row("child (writer)", writerPrompt, writerTools),
		row("child (read-only)", readOnlyPrompt, readOnlyTools),
		"",
    "",
		`*Progressive context disclosure and background agents for productivity at token efficiency*`,
		`/subagents-info full - see more in $EDITOR`,
	].join("\n");
}

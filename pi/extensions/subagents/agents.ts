/**
 * Agent discovery: markdown files with YAML-ish frontmatter.
 *
 *   ~/.pi/agent/agents/<name>.md   (global)
 *   .pi/agents/<name>.md           (project-local)
 *
 * ---
 * name: worker
 * description: Implements a well-scoped change
 * model: anthropic/claude-fable-5
 * thinking: medium
 * tools: read,write,edit,bash,grep,glob   # allowlist; OMIT to keep extension tools
 * excludeTools: write,edit                # denylist; preferred over `tools`
 * extensions: rtk, pi-web-access      # override the global childExtensions list
 * inheritExtensions: false            # or load the user's FULL extension set
 * ---
 * <system prompt body>
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDef } from "./types.ts";

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
	if (!raw.startsWith("---")) return { meta: {}, body: raw };
	const end = raw.indexOf("\n---", 3);
	if (end === -1) return { meta: {}, body: raw };
	const head = raw.slice(3, end);
	const body = raw.slice(end + 4).replace(/^\r?\n/, "");
	const meta: Record<string, string> = {};
	for (const line of head.split("\n")) {
		const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
	}
	return { meta, body };
}

function loadDir(dir: string, out: Map<string, AgentDef>): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const f of entries) {
		if (!f.endsWith(".md")) continue;
		const full = path.join(dir, f);
		try {
			const { meta, body } = parseFrontmatter(fs.readFileSync(full, "utf8"));
			const name = meta.name || path.basename(f, ".md");
			out.set(name, {
				name,
				description: meta.description || "",
				model: meta.model || undefined,
				thinking: meta.thinking || undefined,
				tools: meta.tools
					? meta.tools
							.split(",")
							.map((t) => t.trim())
							.filter(Boolean)
					: undefined,
				excludeTools: meta.excludeTools
					? meta.excludeTools
							.split(",")
							.map((t) => t.trim())
							.filter(Boolean)
					: undefined,
				inheritExtensions: meta.inheritExtensions === "true",
				extensions:
					meta.extensions === undefined
						? undefined
						: /^(none|false)$/i.test(meta.extensions.trim())
							? []
							: meta.extensions
									.split(",")
									.map((e) => e.trim())
									.filter(Boolean),
				prompt: body.trim(),
				source: full,
			});
		} catch {
			/* skip unreadable agent files */
		}
	}
}

/** Project-local agents shadow global ones of the same name. */
export function discoverAgents(cwd: string): Map<string, AgentDef> {
	const out = new Map<string, AgentDef>();
	loadDir(path.join(os.homedir(), ".pi", "agent", "agents"), out);
	loadDir(path.join(cwd, ".pi", "agents"), out);
	if (!out.has("worker")) out.set("worker", BUILTIN_WORKER);
	if (!out.has("scout")) out.set("scout", BUILTIN_SCOUT);
	return out;
}

// NOTE: the builtins deliberately declare no `tools` allowlist. An allowlist is
// a denylist for everything you forgot, and it would silently strip the tools
// contributed by childExtensions (web_search, mcp, local_vlm_query, ...).
// Write access is enforced by the guard, not by hiding the write tool.
const BUILTIN_WORKER: AgentDef = {
	name: "worker",
	description: "Implements a well-scoped change inside its write claim.",
	prompt: `You implement one well-scoped change and then stop.

Work only inside your write claim. Verify your change (build, tests, or a
targeted run) before reporting. If verification is impossible, say so plainly
rather than claiming success.

Your final message is the only thing your orchestrator will read. Make it
self-contained: what you changed, file by file; what you verified and how;
what you could not do and why.`,
	source: "(builtin)",
};

const BUILTIN_SCOUT: AgentDef = {
	name: "scout",
	description: "Read-only investigation of the codebase. Never writes.",
	prompt: `You investigate and report. You have no write claim and cannot modify files.

Start broad, then narrow. Prefer reading the code over guessing from names.
Record anything a sibling agent would otherwise have to rediscover with note().

Your final message must be a dense, self-contained briefing with concrete file
paths and line numbers. Do not pad it with narration about your search process.`,
	source: "(builtin)",
};

/**
 * /prompt:tools
 *
 * Renders the session's tools in a readable markdown form instead of raw
 * JSON, split by where they stand relative to the model's context (pi >=
 * 0.9x tool exposure):
 *   - Always active: direct/model-only tools declared up front (full sections)
 *   - Loaded from deferral: deferred/codemode tools that tool_search (or a
 *     toggle) has activated, now declared (full sections)
 *   - Deferred, not loaded: waiting for tool_search (list, by namespace)
 *   - Disabled / Hidden (lists)
 * Each tool is annotated with the size of its actual JSON definition, e.g.
 * "(1234 chars ~ 309 tokens)", so you can judge how much prompt space it
 * really occupies (or would occupy once loaded).
 *
 * Note: getActiveTools()/getAllTools() live on the ExtensionAPI (`pi`), not
 * on the per-command ExtensionContext, so the handler uses the `pi` closure.
 *
 * getAllTools() returns descriptions as *registered*. Some tools (notably
 * `codemode`) rewrite their description per request via prepareLoadout(), so
 * the true prompt text is only in the session transcript: the first system
 * message declares every tool and later ones patch it with toolsAdded /
 * toolsRemoved. The command replays those (`replayDeclaredTools`) and falls
 * back to getAllTools() when nothing has been recorded yet.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { viewContentInEditor } from "./editor.ts";

/**
 * How the model reaches a tool (pi >= 0.9x). `direct`/`model-only` tools are
 * declared up front while active; `deferred`/`codemode` tools start inactive
 * and are declared only once something (tool_search, a toggle) activates
 * them; `hidden` tools are unreachable. Missing = registered before exposure
 * existed, i.e. `direct`.
 */
export type ToolExposureLike = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

export interface ToolInfoLike {
	name: string;
	description?: string;
	parameters?: any;
	promptGuidelines?: string[];
	sourceInfo?: { source?: string; scope?: string; path?: string };
	exposure?: ToolExposureLike;
	namespace?: { name: string; description?: string };
}

export interface ToolsSource {
	getActiveTools(): string[];
	getAllTools(): ToolInfoLike[];
	getSettings?(): any;
}

/**
 * Where a tool stands relative to the model's context:
 *  - always:   up-front tool (direct/model-only), in context
 *  - loaded:   deferred/codemode tool that has been activated (e.g. by tool_search), in context
 *  - deferred: deferred/codemode tool waiting to be loaded, not in context
 *  - disabled: up-front tool that has been turned off, not in context
 *  - hidden:   `hidden` exposure, unreachable
 */
export type ToolStatus = "always" | "loaded" | "deferred" | "disabled" | "hidden";

export const TOOL_STATUS_ORDER: ToolStatus[] = ["always", "loaded", "deferred", "disabled", "hidden"];

export const TOOL_STATUS_LABELS: Record<ToolStatus, string> = {
	always: "Always active",
	loaded: "Loaded from deferral",
	deferred: "Deferred, not loaded",
	disabled: "Disabled",
	hidden: "Hidden",
};

/** Whether a tool with this exposure waits to be loaded instead of being declared up front. */
export function isDeferredExposure(exposure?: ToolExposureLike): boolean {
	return exposure === "deferred" || exposure === "codemode";
}

export function toolStatus(exposure: ToolExposureLike | undefined, inContext: boolean): ToolStatus {
	if (exposure === "hidden") return "hidden";
	if (isDeferredExposure(exposure)) return inContext ? "loaded" : "deferred";
	return inContext ? "always" : "disabled";
}

/**
 * With codemode active in `codemode.mode: "only"`, codemode's prepareLoadout
 * hides the declarations of active direct tools from requests: they are
 * listed inside codemode's description instead. That hidden set isn't
 * exposed to extensions, so we can only detect the mode and warn.
 */
export function codemodeOnlyActive(source: ToolsSource): boolean {
	try {
		return source.getActiveTools().includes("codemode") && source.getSettings?.()?.codemode?.mode === "only";
	} catch {
		return false;
	}
}

/** A tool declaration as recorded in a transcript system message. */
export interface DeclaredToolLike {
	name: string;
	description?: string;
	parameters?: any;
}

/**
 * Replay transcript system messages (in order) into the currently declared
 * tool set. Each message removes `toolsRemoved` first, then adds `toolsAdded`
 * (so a tool that is removed and re-added ends up with the new declaration).
 * Returns undefined when no message ever declared tools.
 */
export function replayDeclaredTools(messages: ReadonlyArray<any>): DeclaredToolLike[] | undefined {
	let declared: Map<string, DeclaredToolLike> | undefined;
	for (const m of messages) {
		if (m?.role !== "system" || !(m.toolsAdded || m.toolsRemoved)) continue;
		declared ??= new Map();
		for (const t of m.toolsRemoved ?? []) declared.delete(t.name);
		for (const t of m.toolsAdded ?? []) declared.set(t.name, t);
	}
	return declared ? [...declared.values()] : undefined;
}

/**
 * Overlay transcript declarations onto registered tool info: for every tool
 * the model was actually sent, the declared name/description/parameters win
 * while registry-only metadata (source, prompt guidelines) is kept. Tools
 * without a declaration (inactive) are returned unchanged. With no
 * declarations at all the input is returned as-is.
 */
export function applyDeclared(allTools: ToolInfoLike[], declared?: DeclaredToolLike[]): ToolInfoLike[] {
	if (!declared) return allTools;
	const byName = new Map(declared.map((d) => [d.name, d]));
	return allTools.map((t) => (byName.has(t.name) ? ({ ...t, ...byName.get(t.name) } as ToolInfoLike) : t));
}

/** Declared tools for the current branch of this session, or undefined if none recorded yet. */
export async function loadDeclaredTools(ctx: {
	sessionManager: { getBranch(): any[] };
}): Promise<DeclaredToolLike[] | undefined> {
	// Imported lazily so the pure helpers stay loadable without the pi runtime.
	const { buildSessionContext } = await import("@earendil-works/pi-coding-agent");
	return replayDeclaredTools(buildSessionContext(ctx.sessionManager.getBranch()).messages);
}

/** Rough LLM token estimate: ~4 chars per token. */
export function estimateTokens(chars: number): number {
	return Math.round(chars / 4);
}

export function formatSize(chars: number): string {
	return `(${chars} chars ~ ${estimateTokens(chars)} tokens)`;
}

/** Summarize a JSON-schema node into a short human-readable type string. */
export function schemaType(schema: any): string {
	if (!schema || typeof schema !== "object") return "unknown";
	if (schema.enum) return schema.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	if (schema.anyOf) return schema.anyOf.map(schemaType).join(" | ");
	if (schema.oneOf) return schema.oneOf.map(schemaType).join(" | ");
	if (schema.allOf) return schema.allOf.map(schemaType).join(" & ");
	if (schema.type === "array") {
		return `${schema.items ? schemaType(schema.items) : "unknown"}[]`;
	}
	if (Array.isArray(schema.type)) return schema.type.join(" | ");
	return schema.type ?? "object";
}

function indentBlock(text: string, indent: string): string {
	return text
		.split("\n")
		.map((line) => (line.trim().length > 0 ? indent + line : line))
		.join("\n");
}

/** Render one property (recursing into nested object properties). */
function renderProperty(
	name: string,
	schema: any,
	required: boolean,
	depth: number,
	lines: string[],
): void {
	const indent = "  ".repeat(depth);
	const flags: string[] = [schemaType(schema)];
	if (required) flags.push("required");
	if (schema?.default !== undefined) flags.push(`default: ${JSON.stringify(schema.default)}`);

	lines.push(`${indent}- \`${name}\` *${flags.join(", ")}*`);
	const desc: string | undefined = schema?.description;
	if (desc) {
		lines.push(indentBlock(desc.trim(), `${indent}  `));
	}

	// Recurse into nested object properties (also covers array-of-object items).
	const nested = schema?.properties ?? schema?.items?.properties;
	if (nested && depth < 3) {
		const nestedRequired: string[] = schema?.required ?? schema?.items?.required ?? [];
		for (const [childName, childSchema] of Object.entries(nested)) {
			renderProperty(childName, childSchema, nestedRequired.includes(childName), depth + 1, lines);
		}
	}
}

/** Size of the actual JSON definition sent to the model. */
export function toolJsonSize(tool: ToolInfoLike): number {
	return JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}).length;
}

/**
 * Render one tool's full documentation block (heading with size, source,
 * description, parameters, prompt guidelines) as markdown lines. Shared by
 * the aggregate /prompt:tools view and the single-tool view opened from
 * /prompt:tools-toggle's "v" key.
 */
export function renderToolSection(tool: ToolInfoLike, headingLevel = "##"): string[] {
	const lines: string[] = [];
	lines.push(`${headingLevel} ${tool.name}  ${formatSize(toolJsonSize(tool))}`);
	const src = tool.sourceInfo;
	if (src?.source || src?.path) {
		const parts = [src.source, src.scope, src.path].filter(Boolean);
		lines.push(`*Source: ${parts.join(" · ")}*`);
	}
	if (tool.exposure && tool.exposure !== "direct") {
		const ns = tool.namespace ? ` · namespace: ${tool.namespace.name}` : "";
		lines.push(`*Exposure: ${tool.exposure}${ns}*`);
	}
	lines.push("");
	if (tool.description) {
		lines.push(tool.description.trim());
		lines.push("");
	}

	const props = tool.parameters?.properties;
	if (props && Object.keys(props).length > 0) {
		const required: string[] = tool.parameters?.required ?? [];
		lines.push("**Parameters:**");
		lines.push("");
		for (const [name, schema] of Object.entries(props)) {
			renderProperty(name, schema, required.includes(name), 0, lines);
		}
	} else {
		lines.push("**Parameters:** none");
	}
	lines.push("");

	if (tool.promptGuidelines && tool.promptGuidelines.length > 0) {
		lines.push("**Prompt guidelines:**");
		lines.push("");
		for (const guideline of tool.promptGuidelines) {
			lines.push(`- ${guideline.trim()}`);
		}
		lines.push("");
	}

	return lines;
}

/** Render the full markdown doc for a single tool (used by /prompt:tools-toggle's "v" key). */
export function renderSingleToolMarkdown(tool: ToolInfoLike): string {
	const lines: string[] = [`# ${tool.name}`, ""];
	lines.push(...renderToolSection(tool, "##"));
	return lines.join("\n");
}

const sumSize = (tools: ToolInfoLike[]) => tools.reduce((sum, t) => sum + toolJsonSize(t), 0);

/** Short list lines for tools that are not in context, grouped under their namespace when they have one. */
function renderToolList(tools: ToolInfoLike[], lines: string[]): void {
	const groups = new Map<string, { description?: string; tools: ToolInfoLike[] }>();
	const loose: ToolInfoLike[] = [];
	for (const tool of tools) {
		if (!tool.namespace) {
			loose.push(tool);
			continue;
		}
		const group = groups.get(tool.namespace.name) ?? { description: tool.namespace.description, tools: [] };
		group.tools.push(tool);
		groups.set(tool.namespace.name, group);
	}
	for (const [name, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
		const desc = group.description?.trim().split(/\r?\n/)[0];
		lines.push(`- **${name}**  ${formatSize(sumSize(group.tools))}${desc ? ` — ${desc}` : ""}`);
		for (const tool of group.tools) lines.push(`  - ${tool.name}  ${formatSize(toolJsonSize(tool))}`);
	}
	for (const tool of loose) lines.push(`- ${tool.name}  ${formatSize(toolJsonSize(tool))}`);
}

export function renderToolsMarkdown(source: ToolsSource, declared?: DeclaredToolLike[]): string {
	const activeNames = new Set<string>(source.getActiveTools());
	const allTools = source.getAllTools();
	const byName = new Map(allTools.map((t) => [t.name, t]));

	// What is in the model's context right now. Transcript declarations are
	// what the model saw (incl. prepareLoadout rewrites); registry metadata
	// (source, exposure, prompt guidelines) is layered on top by name.
	let inContext: ToolInfoLike[];
	const notes: string[] = [];
	if (declared) {
		inContext = declared.map((d) => ({ ...byName.get(d.name), ...d }) as ToolInfoLike);
		const declaredNames = new Set(declared.map((d) => d.name));
		const pendingAdd = [...activeNames].filter((n) => !declaredNames.has(n));
		const pendingRemove = [...declaredNames].filter((n) => !activeNames.has(n));
		if (pendingAdd.length > 0) notes.push(`Pending, sent from the next request: +${pendingAdd.join(", +")}`);
		if (pendingRemove.length > 0) notes.push(`Pending, dropped from the next request: -${pendingRemove.join(", -")}`);
		const unregistered = declared.filter((d) => !byName.has(d.name)).map((d) => d.name);
		if (unregistered.length > 0) {
			notes.push(
				`Declared in the transcript but not registered in this session (exposure unknown, counted as always active): ${unregistered.join(", ")}`,
			);
		}
	} else {
		inContext = allTools.filter((t) => activeNames.has(t.name));
	}
	const inContextNames = new Set(inContext.map((t) => t.name));

	const byStatus = new Map<ToolStatus, ToolInfoLike[]>(TOOL_STATUS_ORDER.map((s) => [s, []]));
	for (const tool of inContext) byStatus.get(toolStatus(tool.exposure, true))!.push(tool);
	for (const tool of allTools) {
		if (!inContextNames.has(tool.name)) byStatus.get(toolStatus(tool.exposure, false))!.push(tool);
	}
	const always = byStatus.get("always")!;
	const loaded = byStatus.get("loaded")!;
	const deferred = byStatus.get("deferred")!;
	const disabled = byStatus.get("disabled")!;
	const hidden = byStatus.get("hidden")!;

	const totalChars = sumSize(inContext);

	const lines: string[] = [];
	lines.push("# Tool definitions in this session's prompt");
	lines.push("");
	lines.push(
		`${inContext.length} tool(s) in context (${always.length} always active, ${loaded.length} loaded from deferral), total JSON size ${formatSize(totalChars)}. Sizes are the actual JSON definition sent to the model; token counts are estimated at ~4 chars/token.`,
	);
	lines.push("");
	lines.push(
		`${deferred.length} deferred tool(s) not loaded (${formatSize(sumSize(deferred))} if all were loaded), ${disabled.length} disabled.`,
	);
	lines.push("");
	lines.push(
		declared
			? "*Source of truth: tool declarations recorded in the session transcript (includes per-request description rewrites such as codemode's).*"
			: "*No tool declarations recorded in the transcript yet; showing registered descriptions, which may differ from what is sent (e.g. codemode).*",
	);
	lines.push("");
	for (const note of notes) lines.push(`*${note}*`, "");
	if (codemodeOnlyActive(source)) {
		lines.push(
			'*codemode.mode is "only": the declarations of always-active direct tools are left out of requests and listed in the codemode description instead, so their sizes below overstate what is sent.*',
			"",
		);
	}

	// Full sections for everything the model currently has.
	lines.push(`# ${TOOL_STATUS_LABELS.always} (${always.length})  ${formatSize(sumSize(always))}`);
	lines.push("");
	lines.push("*Declared to the model up front (`direct` / `model-only` exposure).*");
	lines.push("");
	for (const tool of always) lines.push(...renderToolSection(tool, "##"));

	if (loaded.length > 0) {
		lines.push("---", "");
		lines.push(`# ${TOOL_STATUS_LABELS.loaded} (${loaded.length})  ${formatSize(sumSize(loaded))}`);
		lines.push("");
		lines.push("*Deferred tools that have since been activated (e.g. by `tool_search`) and are now declared to the model.*");
		lines.push("");
		for (const tool of loaded) lines.push(...renderToolSection(tool, "##"));
	}

	// Not in context: short lists with would-be sizes.
	if (deferred.length > 0) {
		lines.push("---", "");
		lines.push(`## ${TOOL_STATUS_LABELS.deferred} (${deferred.length}, not in the prompt)`);
		lines.push("");
		lines.push(
			"*`deferred` / `codemode` exposure: not declared until `tool_search` (or /prompt:tools-toggle) loads them. Only their namespaces appear, in the `tool_search` description. Sizes are what loading would add.*",
		);
		lines.push("");
		renderToolList(deferred, lines);
		lines.push("");
	}

	if (disabled.length > 0) {
		lines.push("---", "");
		lines.push(`## ${TOOL_STATUS_LABELS.disabled} tools (${disabled.length}, not in the prompt)`);
		lines.push("");
		renderToolList(disabled, lines);
		lines.push("");
	}

	if (hidden.length > 0) {
		lines.push("---", "");
		lines.push(`## ${TOOL_STATUS_LABELS.hidden} tools (${hidden.length}, registered but unreachable)`);
		lines.push("");
		for (const tool of hidden) lines.push(`- ${tool.name}`);
		lines.push("");
	}

	return lines.join("\n");
}

export function registerToolsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prompt:tools", {
		description: "View this session's tool definitions (pretty, with JSON size) in $EDITOR",
		handler: async (_args, ctx) => {
			let markdown: string;
			try {
				const declared = await loadDeclaredTools(ctx);
				// Tool listing lives on the ExtensionAPI, not the command context.
				markdown = renderToolsMarkdown(pi as unknown as ToolsSource, declared);
			} catch (err) {
				ctx.ui.notify(`Failed to collect tool definitions: ${(err as Error).message}`, "error");
				return;
			}

			await viewContentInEditor(ctx, "pi-prompt-tools-", "prompt-tools.md", markdown);
		},
	});
}

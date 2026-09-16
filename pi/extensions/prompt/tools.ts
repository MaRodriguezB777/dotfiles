/**
 * /prompt:tools
 *
 * Renders every active tool definition (name, description, parameters) in a
 * readable markdown form instead of raw JSON. Each tool is annotated with the
 * size of its actual JSON definition, e.g. "(1234 chars ~ 309 tokens)", so
 * you can judge how much prompt space it really occupies.
 *
 * Note: getActiveTools()/getAllTools() live on the ExtensionAPI (`pi`), not
 * on the per-command ExtensionContext, so the handler uses the `pi` closure.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { viewContentInEditor } from "./editor.ts";

export interface ToolInfoLike {
	name: string;
	description?: string;
	parameters?: any;
	promptGuidelines?: string[];
	sourceInfo?: { source?: string; scope?: string; path?: string };
}

export interface ToolsSource {
	getActiveTools(): string[];
	getAllTools(): ToolInfoLike[];
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

export function renderToolsMarkdown(source: ToolsSource): string {
	const activeNames = new Set<string>(source.getActiveTools());
	const allTools = source.getAllTools();

	const active = allTools.filter((t) => activeNames.has(t.name));
	const inactive = allTools.filter((t) => !activeNames.has(t.name));

	const totalChars = active.reduce((sum, t) => sum + toolJsonSize(t), 0);

	const lines: string[] = [];
	lines.push("# Tool definitions in this session's prompt");
	lines.push("");
	lines.push(
		`${active.length} active tool(s), total JSON size ${formatSize(totalChars)}. Sizes are the actual JSON definition sent to the model; token counts are estimated at ~4 chars/token.`,
	);
	lines.push("");

	for (const tool of active) {
		lines.push(...renderToolSection(tool, "##"));
	}

	if (inactive.length > 0) {
		lines.push("---");
		lines.push("");
		lines.push(`## Inactive tools (${inactive.length}, not in the prompt)`);
		lines.push("");
		for (const tool of inactive) {
			lines.push(`- ${tool.name}  ${formatSize(toolJsonSize(tool))}`);
		}
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
				// Tool listing lives on the ExtensionAPI, not the command context.
				markdown = renderToolsMarkdown(pi as unknown as ToolsSource);
			} catch (err) {
				ctx.ui.notify(`Failed to collect tool definitions: ${(err as Error).message}`, "error");
				return;
			}

			await viewContentInEditor(ctx, "pi-prompt-tools-", "prompt-tools.md", markdown);
		},
	});
}

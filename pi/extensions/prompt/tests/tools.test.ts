/**
 * Tests for the /prompt:tools markdown rendering.
 *
 * Run with:  node --test tests/   (from the prompt/ directory)
 * Node >= 23 strips TypeScript types natively; on Node 22 add
 * --experimental-strip-types.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	estimateTokens,
	formatSize,
	renderSingleToolMarkdown,
	renderToolsMarkdown,
	schemaType,
	toolJsonSize,
	type ToolInfoLike,
	type ToolsSource,
} from "../tools.ts";

function makeSource(active: string[], tools: ToolInfoLike[]): ToolsSource {
	return {
		getActiveTools: () => active,
		getAllTools: () => tools,
	};
}

const bashTool: ToolInfoLike = {
	name: "bash",
	description: "Execute a bash command.\nReturns stdout and stderr.",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "Shell command to execute" },
			timeout: { type: "number", description: "Timeout in seconds" },
			opts: {
				type: "object",
				properties: { cwd: { type: "string", description: "Working dir" } },
				required: ["cwd"],
			},
			mode: { enum: ["a", "b"] },
			list: { type: "array", items: { type: "string" } },
		},
		required: ["command"],
	},
	sourceInfo: { source: "builtin", scope: "user", path: "/x/bash.ts" },
};

const readTool: ToolInfoLike = {
	name: "read",
	description: "Read a file",
	parameters: { type: "object", properties: {} },
	sourceInfo: { source: "builtin" },
};

const hiddenTool: ToolInfoLike = {
	name: "hidden_tool",
	description: "not active",
	parameters: {},
	sourceInfo: {},
};

test("estimateTokens uses ~4 chars per token", () => {
	assert.equal(estimateTokens(400), 100);
	assert.equal(estimateTokens(0), 0);
	assert.equal(estimateTokens(6), 2); // rounds
});

test("formatSize produces the (X chars ~ Y tokens) annotation", () => {
	assert.equal(formatSize(400), "(400 chars ~ 100 tokens)");
});

test("toolJsonSize measures the actual JSON definition", () => {
	const expected = JSON.stringify({
		name: bashTool.name,
		description: bashTool.description,
		parameters: bashTool.parameters,
	}).length;
	assert.equal(toolJsonSize(bashTool), expected);
});

test("schemaType summarizes schema shapes", () => {
	assert.equal(schemaType({ type: "string" }), "string");
	assert.equal(schemaType({ type: "array", items: { type: "string" } }), "string[]");
	assert.equal(schemaType({ enum: ["a", "b"] }), '"a" | "b"');
	assert.equal(schemaType({ anyOf: [{ type: "string" }, { type: "number" }] }), "string | number");
	assert.equal(schemaType({ const: 5 }), "5");
	assert.equal(schemaType(undefined), "unknown");
	assert.equal(schemaType({}), "object");
});

test("renderToolsMarkdown includes active tools with size annotations", () => {
	const md = renderToolsMarkdown(makeSource(["bash", "read"], [bashTool, readTool, hiddenTool]));

	// Header counts only active tools.
	assert.match(md, /^# Tool definitions in this session's prompt/);
	assert.match(md, /2 tool\(s\) in context \(2 always active, 0 loaded from deferral\), total JSON size \(\d+ chars ~ \d+ tokens\)/);

	// Per-tool heading carries the real JSON size.
	assert.match(md, new RegExp(`## bash {2}\\(${toolJsonSize(bashTool)} chars ~ \\d+ tokens\\)`));
	assert.match(md, /## read {2}\(\d+ chars ~ \d+ tokens\)/);

	// Source line and description survive.
	assert.match(md, /\*Source: builtin · user · \/x\/bash\.ts\*/);
	assert.match(md, /Execute a bash command\./);
});

test("renderToolsMarkdown renders parameters readably, not as raw JSON", () => {
	const md = renderToolsMarkdown(makeSource(["bash"], [bashTool]));

	assert.match(md, /- `command` \*string, required\*/);
	assert.match(md, /Shell command to execute/);
	assert.match(md, /- `timeout` \*number\*/);
	assert.match(md, /- `mode` \*"a" \| "b"\*/);
	assert.match(md, /- `list` \*string\[\]\*/);
	// Nested object property is indented and marked required.
	assert.match(md, /\n {2}- `cwd` \*string, required\*/);
	// No raw JSON braces from the schema leak into the body.
	assert.doesNotMatch(md, /"properties"/);
});

test("renderToolsMarkdown renders promptGuidelines as a bullet list (array, not string)", () => {
	const toolWithGuidelines: ToolInfoLike = {
		...readTool,
		name: "read_with_guidelines",
		promptGuidelines: ["Prefer this over cat.", "Use offset/limit for large files."],
	};
	const md = renderToolsMarkdown(makeSource(["read_with_guidelines"], [toolWithGuidelines]));

	assert.match(md, /\*\*Prompt guidelines:\*\*/);
	assert.match(md, /- Prefer this over cat\./);
	assert.match(md, /- Use offset\/limit for large files\./);
});

test("renderToolsMarkdown omits the guidelines section when there are none", () => {
	const md = renderToolsMarkdown(makeSource(["read"], [readTool]));
	assert.doesNotMatch(md, /Prompt guidelines/);
});

test("renderToolsMarkdown handles tools without parameters", () => {
	const md = renderToolsMarkdown(makeSource(["read"], [readTool]));
	assert.match(md, /\*\*Parameters:\*\* none/);
});

test("renderToolsMarkdown lists inactive tools separately", () => {
	const md = renderToolsMarkdown(makeSource(["bash"], [bashTool, hiddenTool]));

	assert.match(md, /## Disabled tools \(1, not in the prompt\)/);
	assert.match(md, /- hidden_tool {2}\(\d+ chars ~ \d+ tokens\)/);
	// Inactive tool must not get a full section.
	assert.doesNotMatch(md, /## hidden_tool/);
});

test("renderToolsMarkdown with no inactive tools omits the inactive section", () => {
	const md = renderToolsMarkdown(makeSource(["bash"], [bashTool]));
	assert.doesNotMatch(md, /Disabled tools/);
});

test("renderSingleToolMarkdown renders one tool's full doc (used by /prompt:tools-toggle's 'v' key)", () => {
	const md = renderSingleToolMarkdown(bashTool);

	assert.match(md, /^# bash/);
	assert.match(md, new RegExp(`## bash {2}\\(${toolJsonSize(bashTool)} chars ~ \\d+ tokens\\)`));
	assert.match(md, /\*Source: builtin · user · \/x\/bash\.ts\*/);
	assert.match(md, /Execute a bash command\./);
	assert.match(md, /- `command` \*string, required\*/);
});

test("renderSingleToolMarkdown handles a tool with no parameters or guidelines", () => {
	const md = renderSingleToolMarkdown(readTool);
	assert.match(md, /^# read/);
	assert.match(md, /\*\*Parameters:\*\* none/);
	assert.doesNotMatch(md, /Prompt guidelines/);
});

test("renderToolsMarkdown total equals the sum of active tool sizes", () => {
	const md = renderToolsMarkdown(makeSource(["bash", "read"], [bashTool, readTool]));
	const total = toolJsonSize(bashTool) + toolJsonSize(readTool);
	assert.match(md, new RegExp(`total JSON size \\(${total} chars ~ ${estimateTokens(total)} tokens\\)`));
});

import { replayDeclaredTools } from "../tools.ts";

test("replayDeclaredTools returns undefined when no system message declares tools", () => {
	assert.equal(replayDeclaredTools([{ role: "user", content: "hi" }, { role: "system", content: "" }]), undefined);
});

test("replayDeclaredTools applies removals before additions, in order", () => {
	const out = replayDeclaredTools([
		{ role: "system", toolsAdded: [{ name: "a", description: "a1" }, { name: "codemode", description: "old" }] },
		{ role: "user", content: "x" },
		{ role: "system", toolsRemoved: [{ name: "a" }, { name: "codemode" }], toolsAdded: [{ name: "codemode", description: "new" }] },
	]);
	assert.deepEqual(out, [{ name: "codemode", description: "new" }]);
});

test("renderToolsMarkdown prefers transcript declarations over registered descriptions", () => {
	const registered: ToolInfoLike = { name: "codemode", description: "short", sourceInfo: { source: "builtin" } };
	const md = renderToolsMarkdown(makeSource(["codemode"], [registered]), [
		{ name: "codemode", description: "LONG PREPARED DESCRIPTION" },
	]);
	assert.match(md, /LONG PREPARED DESCRIPTION/);
	assert.doesNotMatch(md, /\nshort\n/);
	assert.match(md, /Source: builtin/);
	assert.match(md, /recorded in the session transcript/);
});

test("renderToolsMarkdown reports pending active-set changes and inactive tools", () => {
	const md = renderToolsMarkdown(makeSource(["bash", "read"], [bashTool, readTool, hiddenTool]), [
		{ name: "bash", description: "b" },
		{ name: "gone", description: "g" },
	]);
	assert.match(md, /next request: \+read/);
	assert.match(md, /dropped from the next request: -gone/);
	assert.match(md, /Disabled tools \(2/);
});

// ---- tool deferral (pi >= 0.9x exposure) ----

const vlmNs = { name: "local_vlm", description: "Local vision model.\nSecond line." };
const vlmQuery: ToolInfoLike = {
	name: "local_vlm_query",
	description: "Ask the VLM",
	exposure: "deferred",
	namespace: vlmNs,
	sourceInfo: { source: "local", path: "/x/local-vlm/index.ts" },
};
const vlmStatus: ToolInfoLike = { ...vlmQuery, name: "local_llm_status", description: "Status" };
const mcpTool: ToolInfoLike = { name: "mcp_thing", description: "MCP", exposure: "codemode" };
const toolSearch: ToolInfoLike = { name: "tool_search", description: "Search", exposure: "model-only" };
const ghost: ToolInfoLike = { name: "ghost", description: "gone", exposure: "hidden" };

import { isDeferredExposure, toolStatus } from "../tools.ts";

test("toolStatus classifies exposure x in-context", () => {
	assert.equal(toolStatus(undefined, true), "always");
	assert.equal(toolStatus("direct", false), "disabled");
	assert.equal(toolStatus("model-only", true), "always");
	assert.equal(toolStatus("deferred", true), "loaded");
	assert.equal(toolStatus("deferred", false), "deferred");
	assert.equal(toolStatus("codemode", false), "deferred");
	assert.equal(toolStatus("hidden", true), "hidden");
	assert.equal(isDeferredExposure("codemode"), true);
	assert.equal(isDeferredExposure("direct"), false);
});

test("renderToolsMarkdown separates always-active, loaded, deferred, disabled and hidden tools", () => {
	const md = renderToolsMarkdown(
		makeSource(["bash", "tool_search", "local_vlm_query"], [bashTool, readTool, toolSearch, vlmQuery, vlmStatus, mcpTool, ghost]),
	);
	assert.match(md, /3 tool\(s\) in context \(2 always active, 1 loaded from deferral\)/);
	assert.match(md, /2 deferred tool\(s\) not loaded \(\(\d+ chars ~ \d+ tokens\) if all were loaded\), 1 disabled\./);

	const always = md.indexOf("# Always active (2)");
	const loaded = md.indexOf("# Loaded from deferral (1)");
	const deferred = md.indexOf("## Deferred, not loaded (2, not in the prompt)");
	const disabled = md.indexOf("## Disabled tools (1, not in the prompt)");
	const hidden = md.indexOf("## Hidden tools (1, registered but unreachable)");
	assert.ok(always >= 0 && always < loaded && loaded < deferred && deferred < disabled && disabled < hidden);

	// Loaded deferred tool gets a full section with its exposure/namespace.
	assert.match(md, /## local_vlm_query {2}\(\d+ chars/);
	assert.match(md, /\*Exposure: deferred · namespace: local_vlm\*/);
	// Waiting deferred tools are listed (grouped by namespace), not given sections.
	assert.doesNotMatch(md, /## local_llm_status/);
	assert.match(md, /- \*\*local_vlm\*\* {2}\(\d+ chars ~ \d+ tokens\) — Local vision model\.\n {2}- local_llm_status/);
	assert.match(md, /\n- mcp_thing {2}\(/);
	assert.match(md, /- read {2}\(/);
	assert.match(md, /- ghost\n/);
});

test("renderToolsMarkdown classifies by transcript declarations and flags a pending tool_search load", () => {
	const md = renderToolsMarkdown(makeSource(["bash", "local_vlm_query"], [bashTool, vlmQuery]), [
		{ name: "bash", description: "b" },
	]);
	assert.match(md, /1 tool\(s\) in context \(1 always active, 0 loaded from deferral\)/);
	assert.match(md, /next request: \+local_vlm_query/);
	assert.match(md, /Deferred, not loaded \(1/);
});

test("renderToolsMarkdown warns when codemode.mode is only", () => {
	const source: ToolsSource = {
		getActiveTools: () => ["bash", "codemode"],
		getAllTools: () => [bashTool, { name: "codemode", description: "c", exposure: "model-only" }],
		getSettings: () => ({ codemode: { mode: "only" } }),
	};
	assert.match(renderToolsMarkdown(source), /codemode\.mode is "only"/);
	assert.doesNotMatch(renderToolsMarkdown(makeSource(["bash"], [bashTool])), /codemode\.mode/);
});

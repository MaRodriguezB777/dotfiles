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
	assert.match(md, /2 active tool\(s\), total JSON size \(\d+ chars ~ \d+ tokens\)/);

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

	assert.match(md, /## Inactive tools \(1, not in the prompt\)/);
	assert.match(md, /- hidden_tool {2}\(\d+ chars ~ \d+ tokens\)/);
	// Inactive tool must not get a full section.
	assert.doesNotMatch(md, /## hidden_tool/);
});

test("renderToolsMarkdown with no inactive tools omits the inactive section", () => {
	const md = renderToolsMarkdown(makeSource(["bash"], [bashTool]));
	assert.doesNotMatch(md, /Inactive tools/);
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, configPath, loadSettings, parseConfig, projectConfigPath } from "../config.ts";

test("user config at ~/.pi/agent/subagents-config.json, project config at ./.pi/subagents-config.json", () => {
	assert.equal(configPath(), join(homedir(), ".pi", "agent", "subagents-config.json"));
	assert.equal(projectConfigPath("/p/game"), "/p/game/.pi/subagents-config.json");
});

// ---- parsing one file ------------------------------------------------------------

test("a missing, empty or whitespace-only file is silent and contributes nothing", () => {
	for (const raw of [null, "", "  \n"]) {
		const r = parseConfig(raw);
		assert.deepEqual(r.config, DEFAULTS);
		assert.deepEqual(r.problems, []);
		assert.equal(r.used, false);
	}
});

test("invalid JSON or a non-object is reported and the whole file is ignored", () => {
	for (const raw of ['{ "maxConcurrentWriters": 5, }', "[1,2]", "null", "5"]) {
		const r = parseConfig(raw);
		assert.deepEqual(r.config, DEFAULTS, raw);
		assert.equal(r.used, false, raw);
		assert.match(r.problems[0], /(not valid JSON|must be a JSON object).*ignored/, raw);
	}
});

test("a bad value keeps the value from below it; valid ones still apply", () => {
	const base = { ...DEFAULTS, maxConcurrentWriters: 6 };
	const r = parseConfig(JSON.stringify({ maxConcurrentWriters: "5", maxConcurrentTotal: 12, orphanPollMs: -1 }), base);
	assert.equal(r.used, true);
	assert.equal(r.config.maxConcurrentTotal, 12);
	assert.equal(r.config.maxConcurrentWriters, 6, "the layer below, not the built-in default");
	assert.equal(r.config.orphanPollMs, DEFAULTS.orphanPollMs);
	const text = r.problems.join("\n");
	assert.match(text, /"maxConcurrentWriters" must be a non-negative number; ignored, stays 6/);
	assert.match(text, /"orphanPollMs" must be/);
	assert.doesNotMatch(text, /maxConcurrentTotal/);
});

test("an unknown key is reported with a suggestion for a likely typo", () => {
	const r = parseConfig(JSON.stringify({ maxConcurrentWriter: 5 }));
	assert.match(r.problems[0], /unknown setting "maxConcurrentWriter" ignored \(did you mean "maxConcurrentWriters"\?\)/);
});

test("childExtensions cannot be set by a project file", () => {
	const r = parseConfig(JSON.stringify({ childExtensions: ["./evil.ts"], maxConcurrentWriters: 5 }), DEFAULTS, { project: true });
	assert.deepEqual(r.config.childExtensions, DEFAULTS.childExtensions);
	assert.equal(r.config.maxConcurrentWriters, 5);
	assert.match(r.problems[0], /"childExtensions" can only be set in ~\/\.pi\/agent\/subagents-config\.json; ignored/);
});

// ---- layering and the user-facing summary ---------------------------------------------

function world(global: string | null, project: string | null) {
	const home = mkdtempSync(join(tmpdir(), "cfg-home-"));
	const root = join(home, "projects", "game");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	mkdirSync(join(root, ".pi"), { recursive: true });
	if (global !== null) writeFileSync(join(home, ".pi", "agent", "subagents-config.json"), global);
	if (project !== null) writeFileSync(join(root, ".pi", "subagents-config.json"), project);
	const saved = process.env.HOME;
	process.env.HOME = home;
	return {
		root,
		done: () => {
			process.env.HOME = saved;
			rmSync(home, { recursive: true, force: true });
		},
	};
}

test("no files: defaults", () => {
	const w = world(null, null);
	try {
		const s = loadSettings(w.root, true);
		assert.deepEqual(s.config, DEFAULTS);
		assert.equal(s.summary, "Subagent settings: defaults");
		assert.equal(s.level, "info");
	} finally {
		w.done();
	}
});

test("user file only", () => {
	const w = world('{ "maxConcurrentWriters": 5 }', null);
	try {
		const s = loadSettings(w.root, true);
		assert.equal(s.config.maxConcurrentWriters, 5);
		assert.equal(s.summary, "Subagent settings: ~/.pi/agent/subagents-config.json");
	} finally {
		w.done();
	}
});

test("user + project: the project overrides per setting", () => {
	const w = world('{ "maxConcurrentWriters": 5, "maxConcurrentTotal": 10 }', '{ "maxConcurrentWriters": 2 }');
	try {
		const s = loadSettings(w.root, true);
		assert.equal(s.config.maxConcurrentWriters, 2, "project wins");
		assert.equal(s.config.maxConcurrentTotal, 10, "user value kept where the project is silent");
		assert.equal(s.summary, "Subagent settings: ~/.pi/agent/subagents-config.json + ./.pi/subagents-config.json");
	} finally {
		w.done();
	}
});

test("project file only", () => {
	const w = world(null, '{ "maxConcurrentWriters": 2 }');
	try {
		assert.equal(loadSettings(w.root, true).summary, "Subagent settings: ./.pi/subagents-config.json");
	} finally {
		w.done();
	}
});

test("a broken user file is left out of the list and reported; the project still applies", () => {
	const w = world("{ nope", '{ "maxConcurrentWriters": 2 }');
	try {
		const s = loadSettings(w.root, true);
		assert.equal(s.config.maxConcurrentWriters, 2);
		assert.equal(s.level, "warning");
		const [first, ...rest] = s.summary.split("\n");
		assert.equal(first, "Subagent settings: ./.pi/subagents-config.json");
		assert.match(rest.join("\n"), /~\/\.pi\/agent\/subagents-config\.json: not valid JSON .*ignored/);
	} finally {
		w.done();
	}
});

test("everything broken: says defaults, with the reasons", () => {
	const w = world("{ nope", null);
	try {
		const s = loadSettings(w.root, true);
		assert.deepEqual(s.config, DEFAULTS);
		assert.match(s.summary, /^Subagent settings: defaults\n/);
		assert.match(s.summary, /not valid JSON/);
	} finally {
		w.done();
	}
});

test("an untrusted project's file is ignored, and the user is told why", () => {
	const w = world('{ "maxConcurrentWriters": 5 }', '{ "maxConcurrentWriters": 2 }');
	try {
		const s = loadSettings(w.root, false);
		assert.equal(s.config.maxConcurrentWriters, 5);
		assert.match(s.summary, /^Subagent settings: ~\/\.pi\/agent\/subagents-config\.json\n/);
		assert.match(s.summary, /\.\/\.pi\/subagents-config\.json: ignored, project not trusted/);
	} finally {
		w.done();
	}
});

test("a child uses the parent's merged settings instead of reading files", async () => {
	const w = world('{ "maxConcurrentWriters": 5 }', null);
	const saved = process.env.PI_SUBAGENT_CONFIG;
	try {
		process.env.PI_SUBAGENT_CONFIG = JSON.stringify({ ...DEFAULTS, claimWaitMs: 7 });
		const { loadConfig } = await import(`../config.ts?child=${Date.now()}`);
		assert.equal(loadConfig(w.root).claimWaitMs, 7);
		assert.equal(loadConfig(w.root).maxConcurrentWriters, DEFAULTS.maxConcurrentWriters, "files not read");
	} finally {
		if (saved === undefined) delete process.env.PI_SUBAGENT_CONFIG;
		else process.env.PI_SUBAGENT_CONFIG = saved;
		w.done();
	}
});

test("the parent shows the settings line at session start", async () => {
	const w = world(null, '{ "maxConcurrentWriters": 2 }');
	const hooks = new Map<string, Function[]>();
	const notes: [string, string | undefined][] = [];
	const cwd = process.cwd();
	try {
		const { default: extension } = await import(`../index.ts?cfg=${Date.now()}`);
		extension({ registerTool() {}, registerCommand() {}, registerEntryRenderer() {}, on(n: string, f: Function) { hooks.set(n, [...(hooks.get(n) ?? []), f]); } } as any);
		const ctx = { cwd: w.root, hasUI: true, isProjectTrusted: () => true, ui: { setWidget() {}, notify: (m: string, t?: string) => notes.push([m, t]) } };
		for (const f of hooks.get("session_start") ?? []) await f({}, ctx);
		assert.deepEqual(notes, [["Subagent settings: ./.pi/subagents-config.json", "info"]]);
	} finally {
		for (const f of hooks.get("session_shutdown") ?? []) await f({}, {});
		process.chdir(cwd);
		w.done();
	}
});

// ---- /subagents: effective settings with their source --------------------------

test("each setting records the file that supplied it", () => {
	const w = world('{ "maxConcurrentWriters": 5, "maxConcurrentTotal": 10 }', '{ "maxConcurrentWriters": 2, "maxConcurrentTotal": "x" }');
	try {
		const s = loadSettings(w.root, true);
		assert.equal(s.sources.maxConcurrentWriters, "./.pi/subagents-config.json");
		assert.equal(s.sources.maxConcurrentTotal, "~/.pi/agent/subagents-config.json", "invalid project value did not take over");
		assert.equal(s.sources.claimWaitMs, "default");
	} finally {
		w.done();
	}
});

test("settingsTable lists every setting with its value and source", async () => {
	const { settingsTable } = await import("../config.ts");
	const w = world('{ "maxConcurrentTotal": 10 }', '{ "maxConcurrentWriters": 2 }');
	try {
		const text = settingsTable(loadSettings(w.root, true));
		assert.match(text, /^Subagent settings: ~\/\.pi\/agent\/subagents-config\.json \+ \.\/\.pi\/subagents-config\.json/);
		assert.match(text, /maxConcurrentWriters\s+2\s+\.\/\.pi\/subagents-config\.json/);
		assert.match(text, /maxConcurrentTotal\s+10\s+~\/\.pi\/agent\/subagents-config\.json/);
		assert.match(text, /claimWaitMs\s+120000\s+default/);
		assert.match(text, /childModel\s+"inherit"\s+default/);
		// Long lists are summarized, not dumped.
		assert.match(text, /sharedPaths\s+\d+ patterns\s+default/);
		for (const key of Object.keys(DEFAULTS)) assert.match(text, new RegExp(`\\b${key}\\b`), key);
	} finally {
		w.done();
	}
});

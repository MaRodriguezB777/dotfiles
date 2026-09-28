/**
 * Configuration + resolution of extensions that children must inherit.
 *
 * Children are launched with `--no-extensions` so their tool surface is
 * deterministic and they cannot recursively acquire orchestration tools. But
 * some extensions are not optional features — they are infrastructure. An auth
 * or provider adapter is the clearest case: a child that cannot authenticate
 * cannot make a single model call, so stripping it does not isolate the child,
 * it lobotomises it.
 *
 * Hence: `childExtensions` is an allowlist of packages re-injected into every
 * child with explicit `-e` flags, which work even under `--no-extensions`.
 *
 * Override in ~/.pi/agent/subagents-config.json, and per project in
 * <project>/.pi/subagents-config.json (project wins, setting by setting):
 *   {
 *     "childExtensions": ["pi-claude-oauth-adapter", "/abs/path/to/ext.ts"],
 *     "sharedPaths": ["package.json", "db/schema.sql"],
 *     "maxConcurrentWriters": 3
 *   }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SubagentsConfig {
	/**
	 * Which model children run on.
	 *   "inherit" (default) - the orchestrator's CURRENT model, so a deliberate
	 *                         /model switch is respected instead of silently ignored
	 *   "default"           - omit --model; children fall back to settings.defaultModel
	 *   "<provider/id>"     - pin every child to one model
	 * An agent's `model:` frontmatter always wins over this.
	 */
	childModel: string;
	/** Same semantics as childModel, for the thinking level. */
	childThinking: string;
	/**
	 * How often a child checks that its parent is still alive, and how stale the
	 * parent's heartbeat may get before the child stands itself down.
	 *
	 * The gap between them is slack: at 30s/120s a busy parent may miss three
	 * heartbeats without any child giving up on it, while a dead parent strands
	 * a child for at most ~2.5 minutes rather than indefinitely.
	 */
	orphanPollMs: number;
	orphanStaleMs: number;
	/** Package names or absolute paths loaded into every child via -e. */
	childExtensions: string[];
	/** Files no agent may write directly; routed through request_edit. */
	sharedPaths: string[];
	maxConcurrentWriters: number;
	maxConcurrentTotal: number;
	claimWaitMs: number;
}

export const DEFAULT_SHARED_PATHS = [
	"package.json",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
	"Cargo.toml",
	"Cargo.lock",
	"go.mod",
	"go.sum",
	"requirements.txt",
	"pyproject.toml",
	"poetry.lock",
	"Gemfile.lock",
	"tsconfig.json",
];

/**
 * Extensions loaded into every child.
 *
 * `pi-claude-oauth-adapter` is non-negotiable infrastructure: without it a
 * child cannot authenticate and cannot make a single model call.
 *
 * The rest are capability extensions. Each one costs every child its tool
 * definitions on every request, so this list is a real budget, not a free
 * convenience — run /subagents-info to see the current per-child price.
 * Override globally here, or per agent with an `extensions:` frontmatter key.
 */
const DEFAULT_CHILD_EXTENSIONS = [
	"pi-claude-oauth-adapter",
	"rtk",
	"context-savings",
	"monitors",
	"pi-web-access",
	"@shuv1337/pi-mcp-adapter",
	"local-vlm",
];

export const DEFAULTS: SubagentsConfig = {
	// Inherit by default. The worst failure mode is the silent one: you switch to
	// a cheap model to save money and every child keeps burning the expensive
	// default, or you switch to a stronger model for a hard task and the children
	// doing the actual work quietly stay weak.
	childModel: "inherit",
	childThinking: "inherit",
	orphanPollMs: 30_000,
	orphanStaleMs: 120_000,
	childExtensions: DEFAULT_CHILD_EXTENSIONS,
	sharedPaths: DEFAULT_SHARED_PATHS,
	maxConcurrentWriters: 3,
	maxConcurrentTotal: 8,
	claimWaitMs: 120_000,
};

/** User-level settings. */
export function configPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "subagents-config.json");
}

/** Project-level settings; override the user file setting by setting. */
export function projectConfigPath(root: string): string {
	return path.join(root, ".pi", "subagents-config.json");
}

/**
 * Settings a project file may not set. childExtensions loads code into every
 * child, and this file is not one pi asks for project trust over, so a cloned
 * repo could otherwise run code without any prompt. Same rule as pi's own
 * defaultProjectTrust, which only the agent directory may set.
 */
const USER_ONLY = new Set<keyof SubagentsConfig>(["childExtensions"]);

export interface ParsedConfig {
	config: SubagentsConfig;
	/** Settings this file actually supplied (valid values only). */
	applied: (keyof SubagentsConfig)[];
	/** One line per problem, for the user; empty when the file is fine or absent. */
	problems: string[];
	/** The file contributed settings (it exists and is a JSON object). */
	used: boolean;
}

/** Why `v` is unusable for `key`, or null when it is fine. */
function invalid(key: keyof SubagentsConfig, v: unknown): string | null {
	const expected = DEFAULTS[key];
	if (Array.isArray(expected)) {
		return Array.isArray(v) && v.every((x) => typeof x === "string") ? null : "must be an array of strings";
	}
	if (typeof expected === "number") {
		return typeof v === "number" && Number.isFinite(v) && v >= 0 ? null : "must be a non-negative number";
	}
	return typeof v === typeof expected ? null : `must be a ${typeof expected}`;
}

/** Closest known key within two edits, for "did you mean". */
function suggest(key: string): string | null {
	const dist = (a: string, b: string) => {
		const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
		for (let j = 1; j <= b.length; j++) d[0][j] = j;
		for (let i = 1; i <= a.length; i++)
			for (let j = 1; j <= b.length; j++)
				d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		return d[a.length][b.length];
	};
	let best: string | null = null;
	let bestD = 3;
	for (const k of Object.keys(DEFAULTS)) {
		const d = dist(key.toLowerCase(), k.toLowerCase());
		if (d < bestD) [best, bestD] = [k, d];
	}
	return best;
}

/**
 * Apply one file's text (null = no file) on top of `base`. Never throws: an
 * unusable file is ignored whole, a bad setting keeps the value from `base`,
 * and each is reported so the user is not left wondering why a change did nothing.
 */
export function parseConfig(raw: string | null, base: SubagentsConfig = DEFAULTS, opts: { project?: boolean } = {}): ParsedConfig {
	// No file, or a freshly created empty one: nothing configured.
	if (raw === null || !raw.trim()) return { config: { ...base }, applied: [], problems: [], used: false };
	let user: unknown;
	try {
		user = JSON.parse(raw);
	} catch (e) {
		return { config: { ...base }, applied: [], problems: [`not valid JSON (${(e as Error).message}); ignored`], used: false };
	}
	if (typeof user !== "object" || user === null || Array.isArray(user)) {
		return { config: { ...base }, applied: [], problems: ["must be a JSON object; ignored"], used: false };
	}
	const config: SubagentsConfig = { ...base };
	const applied: (keyof SubagentsConfig)[] = [];
	const problems: string[] = [];
	for (const [key, value] of Object.entries(user)) {
		if (!(key in DEFAULTS)) {
			const near = suggest(key);
			problems.push(`unknown setting "${key}" ignored${near ? ` (did you mean "${near}"?)` : ""}`);
			continue;
		}
		const k = key as keyof SubagentsConfig;
		if (opts.project && USER_ONLY.has(k)) {
			problems.push(`"${key}" can only be set in ~/.pi/agent/subagents-config.json; ignored`);
			continue;
		}
		const why = invalid(k, value);
		if (why) problems.push(`"${key}" ${why}; ignored, stays ${JSON.stringify(base[k])}`);
		else {
			(config as any)[k] = value;
			applied.push(k);
		}
	}
	return { config, applied, problems, used: true };
}

export interface Settings {
	config: SubagentsConfig;
	/** Where each setting's value came from: a file as shown to the user, or "default". */
	sources: Record<keyof SubagentsConfig, string>;
	/** For the user: which files are in effect, then any problems. */
	summary: string;
	level: "info" | "warning";
}

function readFile(file: string): { raw: string | null; error: string | null } {
	try {
		return { raw: fs.readFileSync(file, "utf8"), error: null };
	} catch (e) {
		// Absent is normal; any other read failure is worth telling the user.
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { raw: null, error: null };
		return { raw: null, error: `could not be read (${(e as Error).message}); ignored` };
	}
}

const cache = new Map<string, Settings>();

/**
 * Defaults, then the user file, then the project file (when the project is
 * trusted). Cached per root and trust; /reload re-imports this module, which
 * is how edits are picked up.
 */
export function loadSettings(root: string, trusted: boolean): Settings {
	const key = `${root}\0${trusted}`;
	const hit = cache.get(key);
	if (hit) return hit;

	const layers = [
		{ file: configPath(), shown: "~/.pi/agent/subagents-config.json", project: false },
		{ file: projectConfigPath(root), shown: "./.pi/subagents-config.json", project: true },
	];
	let config: SubagentsConfig = { ...DEFAULTS };
	const sources = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, "default"])) as Settings["sources"];
	const used: string[] = [];
	const problems: string[] = [];
	for (const layer of layers) {
		const { raw, error } = readFile(layer.file);
		if (error) {
			problems.push(`${layer.shown}: ${error}`);
			continue;
		}
		if (layer.project && !trusted) {
			if (raw !== null && raw.trim()) problems.push(`${layer.shown}: ignored, project not trusted (see /trust)`);
			continue;
		}
		const r = parseConfig(raw, config, { project: layer.project });
		config = r.config;
		for (const k of r.applied) sources[k] = layer.shown;
		if (r.used) used.push(layer.shown);
		for (const p of r.problems) problems.push(`${layer.shown}: ${p}`);
	}
	const settings: Settings = {
		config,
		sources,
		summary: [`Subagent settings: ${used.length ? used.join(" + ") : "defaults"}`, ...problems.map((p) => `- ${p}`)].join("\n"),
		level: problems.length ? "warning" : "info",
	};
	cache.set(key, settings);
	return settings;
}

/** A value short enough for one table cell: lists become counts. */
function brief(key: keyof SubagentsConfig, v: unknown): string {
	if (!Array.isArray(v)) return JSON.stringify(v);
	const noun = key === "childExtensions" ? "extension" : "pattern";
	return `${v.length} ${noun}${v.length === 1 ? "" : "s"}`;
}

/** The summary line, every effective setting with its source, then any problems. */
export function settingsTable(s: Settings): string {
	const [head, ...problems] = s.summary.split("\n");
	const keys = Object.keys(DEFAULTS) as (keyof SubagentsConfig)[];
	const values = keys.map((k) => brief(k, s.config[k]));
	const kw = Math.max(...keys.map((k) => k.length));
	const vw = Math.max(...values.map((v) => v.length));
	const rows = keys.map((k, i) => `  ${k.padEnd(kw)}  ${values[i].padEnd(vw)}  ${s.sources[k]}`);
	return [head, ...rows, ...problems].join("\n");
}

/**
 * The effective settings. In a child: exactly what its parent used, passed in
 * PI_SUBAGENT_CONFIG, so parent and child never disagree and a child does not
 * re-decide trust. In the parent: loadSettings for `root` (user file only when
 * no root is given).
 */
export function loadConfig(root?: string, trusted = true): SubagentsConfig {
	const inherited = process.env.PI_SUBAGENT_CONFIG;
	if (inherited) {
		try {
			return { ...DEFAULTS, ...JSON.parse(inherited) };
		} catch {
			/* malformed env: fall through to files */
		}
	}
	if (root === undefined) return parseConfig(readFile(configPath()).raw).config;
	return loadSettings(root, trusted).config;
}

// ---------------------------------------------------------------------------
// Resolving package extensions
// ---------------------------------------------------------------------------

function npmRoot(): string {
	return path.join(os.homedir(), ".pi", "agent", "npm", "node_modules");
}

function settingsPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

function localExtensionsRoot(): string {
	return path.join(os.homedir(), ".pi", "agent", "extensions");
}

/**
 * Which extension files a package contributes. Three sources, in priority
 * order, because pi packages are not uniform:
 *   1. an explicit per-package list in settings.json ("+extensions/index.ts")
 *   2. the `pi.extensions` field in the package's own package.json
 *   3. a plain `extensions/` directory scan
 */
function packageExtensionFiles(pkg: string): string[] {
	const dir = path.join(npmRoot(), pkg);
	if (!fs.existsSync(dir)) return [];

	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
		for (const entry of settings.packages ?? []) {
			if (typeof entry === "object" && entry.source === `npm:${pkg}` && Array.isArray(entry.extensions)) {
				const files = entry.extensions
					.filter((e: string) => !e.startsWith("-"))
					.map((e: string) => path.join(dir, e.replace(/^\+/, "")))
					.filter((p: string) => fs.existsSync(p));
				if (files.length) return files;
			}
		}
	} catch {
		/* fall through */
	}

	try {
		const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
		const declared: string[] = pj?.pi?.extensions ?? [];
		const files = declared.map((e) => path.resolve(dir, e)).filter((p) => fs.existsSync(p));
		if (files.length) return files;
	} catch {
		/* fall through */
	}

	const extDir = path.join(dir, "extensions");
	try {
		return fs
			.readdirSync(extDir)
			.filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
			.map((f) => path.join(extDir, f));
	} catch {
		return [];
	}
}

/** A locally installed extension: either <name>/index.ts or a bare <name>.ts. */
function localExtensionFiles(name: string): string[] {
	const root = localExtensionsRoot();
	for (const candidate of [
		path.join(root, name, "index.ts"),
		path.join(root, name, "index.js"),
		path.join(root, `${name}.ts`),
		path.join(root, `${name}.js`),
	]) {
		if (fs.existsSync(candidate)) return [candidate];
	}
	return [];
}

export interface ResolvedChildExtension {
	spec: string;
	files: string[];
	found: boolean;
	kind: "path" | "local" | "package" | "unresolved";
}

/**
 * Resolve one spec to concrete files. Accepts an absolute/relative path, a
 * locally installed extension name, or an npm package name.
 */
export function resolveChildExtension(spec: string): ResolvedChildExtension {
	if (spec.startsWith("/") || spec.startsWith(".") || spec.endsWith(".ts") || spec.endsWith(".js")) {
		const abs = path.isAbsolute(spec) ? spec : path.resolve(spec);
		if (fs.existsSync(abs)) return { spec, files: [abs], found: true, kind: "path" };
	}
	const local = localExtensionFiles(spec);
	if (local.length) return { spec, files: local, found: true, kind: "local" };

	const pkg = packageExtensionFiles(spec);
	if (pkg.length) return { spec, files: pkg, found: true, kind: "package" };

	return { spec, files: [], found: false, kind: "unresolved" };
}

/**
 * Resolve a list of specs (defaults to the configured global list).
 *
 * `specs` is tolerated rather than trusted: it arrives from user-authored agent
 * frontmatter and from subagents-config.json, so a non-array here should degrade to the
 * global list instead of throwing inside a slash command.
 */
export function resolveChildExtensions(specs?: string[], cfg = loadConfig()): ResolvedChildExtension[] {
	const list = Array.isArray(specs)
		? specs
		: Array.isArray(cfg?.childExtensions)
			? cfg.childExtensions
			: DEFAULT_CHILD_EXTENSIONS;
	return list.filter((s) => typeof s === "string" && s.trim()).map(resolveChildExtension);
}

export function childExtensionFiles(specs?: string[], cfg = loadConfig()): string[] {
	return resolveChildExtensions(specs, cfg).flatMap((r) => r.files);
}

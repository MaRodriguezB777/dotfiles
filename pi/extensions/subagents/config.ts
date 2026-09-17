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
 * Override in ~/.pi/agent/extensions/subagents/config.json:
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

const DEFAULTS: SubagentsConfig = {
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

export function configPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "extensions", "subagents", "config.json");
}

let cached: SubagentsConfig | null = null;

export function loadConfig(): SubagentsConfig {
	if (cached) return cached;
	let user: Partial<SubagentsConfig> = {};
	try {
		user = JSON.parse(fs.readFileSync(configPath(), "utf8"));
	} catch {
		/* no config file: defaults */
	}
	cached = { ...DEFAULTS, ...user };
	return cached;
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
 * frontmatter and from config.json, so a non-array here should degrade to the
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

/**
 * local-vlm — pi extension for the local_llm llama.cpp stack.
 *
 *   /start-local-server                          start the server in ROUTER mode,
 *                                                serving every installed model
 *   /start-local-server <user>/<model> [quant]   same, fetching that model first
 *   /start-local-server single <model> [quant]   pin one model (old behaviour)
 *   local_vlm_query                              tool: ask the local VLM about
 *                                                text / images / a video
 *
 * Video is converted to frames with ffmpeg before sending. Every request runs a
 * context precheck (a real 1-frame and 2-frame probe against the live server)
 * so we can never overflow the KV cache that llama.cpp preallocated on the GPU.
 *
 * Requires the local_llm repo (for scripts/serve_model.sh). Override its
 * location with LOCAL_LLM_REPO if it does not live at the default path.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_DIR =
  process.env.LOCAL_LLM_REPO ?? join(homedir(), "projects", "local_llm");
const SERVE_SCRIPT = join(REPO_DIR, "scripts", "serve_model.sh");

/** Hard ceiling requested by the operator: 60fps x 10s, or 120fps x 5s. */
const MAX_FRAMES = 600;
/** Widths offered when a request has to be scaled back. */
const WIDTH_LADDER = [256, 384, 512, 768, 1024] as const;
/**
 * VRAM the image batch transiently allocates on top of the loaded model,
 * per image token. Measured with scripts/probe_vram.sh on Qwen3.8-27B:
 * a 600-frame / 87,615-token batch peaked 2,163 MiB above idle.
 */
const VRAM_MIB_PER_IMAGE_TOKEN = 2163 / 87615;
/** Free VRAM to keep untouched; overridable for tighter or looser machines. */
const VRAM_BUFFER_MIB = Number(process.env.LOCAL_LLM_VRAM_BUFFER_MIB ?? 3072);
/** Tokens held back for the model's own answer. */
const OUTPUT_RESERVE = 1024;
/** Extra safety margin on top of the measured projection. */
const SAFETY_MARGIN = 0.9;

type ModelStatus = {
  id: string;
  loaded: boolean;
  ctxSize?: number;
};

// ---------------------------------------------------------------------------
// server plumbing
// ---------------------------------------------------------------------------

function baseUrl(): string {
  const port = process.env.LOCAL_LLM_PORT ?? "30000";
  return `http://localhost:${port}`;
}

async function httpJson<T>(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(url, { ...init, signal });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${url} -> ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 300)}`);
  }
}

/** Ask the server what it is serving. Throws a user-actionable error if down. */
async function listModels(signal?: AbortSignal): Promise<ModelStatus[]> {
  let payload: any;
  try {
    payload = await httpJson<any>(`${baseUrl()}/v1/models`, undefined, signal);
  } catch (err) {
    throw new Error(
      `Local LLM server is not reachable at ${baseUrl()}.\n` +
        `Start it with:  /start-local-server   (router mode, serves every installed model)\n` +
        `(underlying error: ${(err as Error).message})`,
    );
  }
  return (payload.data ?? []).map((m: any): ModelStatus => {
    // Router mode reports status.value + the argv it would launch with;
    // single-model mode reports neither, and is loaded by definition.
    const statusValue: string | undefined = m.status?.value;
    const args: string[] = m.status?.args ?? [];
    const ctxIdx = args.findIndex((a) => a === "--ctx-size" || a === "-c");
    const ctxSize = ctxIdx >= 0 ? Number(args[ctxIdx + 1]) : undefined;
    return {
      id: m.id,
      loaded: statusValue === undefined ? true : statusValue === "loaded",
      ctxSize: Number.isFinite(ctxSize) ? ctxSize : undefined,
    };
  });
}

/** Context window actually in force, preferring the live /props reading. */
async function resolveContextWindow(
  model: ModelStatus,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const props = await httpJson<any>(`${baseUrl()}/props`, undefined, signal);
    const n = props?.default_generation_settings?.n_ctx;
    if (typeof n === "number" && n > 0) return n;
  } catch {
    /* router mode reports n_ctx 0 until a model is loaded; fall through */
  }
  if (model.ctxSize && model.ctxSize > 0) return model.ctxSize;
  throw new Error(
    `Could not determine the context window for "${model.id}". ` +
      `Refusing to send a request that might overflow the GPU KV cache.`,
  );
}

type ChatContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

async function chat(
  model: string,
  content: ChatContent[],
  maxTokens: number,
  signal?: AbortSignal,
  thinking = false,
): Promise<{
  text: string;
  reasoning: string;
  truncated: boolean;
  promptTokens: number;
}> {
  const payload = await httpJson<any>(
    `${baseUrl()}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        max_tokens: maxTokens,
        temperature: 0.1,
        stream: false,
        // Reasoning models (Qwen3.x, GLM, ...) think by default and spend the
        // whole token budget in reasoning_content, returning an EMPTY content
        // string. For description/QA work we want the answer, not the monologue.
        chat_template_kwargs: { enable_thinking: thinking },
      }),
    },
    signal,
  );
  const choice = payload.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    reasoning: choice?.message?.reasoning_content ?? "",
    truncated: choice?.finish_reason === "length",
    promptTokens: payload.usage?.prompt_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// video -> frames
// ---------------------------------------------------------------------------

async function run(
  pi: ExtensionAPI,
  cmd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const r = await pi.exec(cmd, args, { signal });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
}

async function probeDuration(
  pi: ExtensionAPI,
  path: string,
  signal?: AbortSignal,
): Promise<number> {
  const r = await run(
    pi,
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    signal,
  );
  const d = Number.parseFloat(r.stdout.trim());
  if (!Number.isFinite(d) || d <= 0) {
    throw new Error(
      `ffprobe could not read a duration from ${path}: ${r.stderr.slice(0, 300)}`,
    );
  }
  return d;
}

type ExtractResult = {
  dir: string;
  files: string[];
  fps: number;
  duration: number;
  window: number;
};

function parseTime(v: string): number {
  if (/^\d+(\.\d+)?$/.test(v)) return Number.parseFloat(v);
  const parts = v.split(":").map(Number.parseFloat);
  if (parts.some((p) => !Number.isFinite(p))) {
    throw new Error(
      `Unparseable timestamp: "${v}" (use seconds, MM:SS, or HH:MM:SS)`,
    );
  }
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

async function extractFrames(
  pi: ExtensionAPI,
  opts: {
    video: string;
    fps?: number;
    maxFrames: number;
    start?: string;
    end?: string;
    frameWidth: number;
  },
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const duration = await probeDuration(pi, opts.video, signal);

  const startSec = opts.start ? parseTime(opts.start) : 0;
  const endSec = opts.end ? parseTime(opts.end) : duration;
  const window = Math.max(0.001, endSec - startSec);

  // Choose an fps that cannot exceed maxFrames over the selected window.
  let fps = opts.fps ?? opts.maxFrames / window;
  if (fps * window > opts.maxFrames) fps = opts.maxFrames / window;
  fps = Math.max(0.05, fps);

  const dir = await mkdtemp(join(tmpdir(), "pi-local-vlm-"));
  const args = [
    "-v", "error", "-y",
    "-ss", String(startSec),
    "-t", String(window),
    "-i", opts.video,
    "-vf", `fps=${fps.toFixed(4)},scale=${opts.frameWidth}:-2:flags=bicubic`,
    "-frames:v", String(opts.maxFrames),
    "-q:v", "4",
    join(dir, "f%05d.jpg"),
  ];
  const r = await run(pi, "ffmpeg", args, signal);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
  if (files.length === 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(
      `ffmpeg produced no frames from ${opts.video}: ${r.stderr.slice(0, 400)}`,
    );
  }
  return {
    dir,
    files: files.map((f) => join(dir, f)),
    fps,
    duration,
    window,
  };
}

// ---------------------------------------------------------------------------
// local model inventory + serving
// ---------------------------------------------------------------------------

type LocalInventory = {
  models: {
    /** Path relative to the models dir, e.g. "unsloth__Qwen3.8-27B-GGUF/x.gguf". */
    file: string;
    bytes: number;
    /** Per-repo directory the model lives in; null for legacy flat files. */
    group: string | null;
    /** Projector sitting beside this model, so pairing is structural. */
    mmproj: string | null;
  }[];
  modelsDir: string;
};

function quoteArgs(
  repo: string,
  quant?: string,
  mmproj?: string,
  redownload?: boolean,
): string {
  const env =
    (mmproj ? `MMPROJ=${JSON.stringify(mmproj)} ` : "") +
    (redownload ? "REDOWNLOAD=1 " : "");
  return `${env}${JSON.stringify(SERVE_SCRIPT)} ${JSON.stringify(repo)} ${
    quant ? JSON.stringify(quant) : ""
  }`;
}

function requireScript(): void {
  if (!existsSync(SERVE_SCRIPT)) {
    throw new Error(
      `serve_model.sh not found at ${SERVE_SCRIPT}. ` +
        `Set LOCAL_LLM_REPO to the local_llm checkout.`,
    );
  }
}

/** Models already on disk, servable with no download. */
async function localInventory(pi: ExtensionAPI): Promise<LocalInventory> {
  requireScript();
  const r = await pi.exec(
    "bash",
    ["-c", `LIST=1 ${JSON.stringify(SERVE_SCRIPT)}`],
    {},
  );
  if ((r.code ?? 0) !== 0) {
    throw new Error(`Could not list local models: ${r.stderr || r.stdout}`);
  }
  const start = r.stdout.indexOf("{");
  if (start < 0) throw new Error(`Unexpected LIST output: ${r.stdout.slice(0, 300)}`);
  return JSON.parse(r.stdout.slice(start)) as LocalInventory;
}

function fmtBytes(b: number): string {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(0)} MB`;
}

/** Container state, for when the HTTP endpoint is not answering. */
async function containerState(
  pi: ExtensionAPI,
): Promise<{ status: string; logTail: string }> {
  const ps = await pi.exec(
    "bash",
    [
      "-c",
      `docker ps -a --filter name=local-llm-llm-general --format '{{.Status}}'`,
    ],
    {},
  );
  const status = (ps.stdout ?? "").trim() || "not created";
  const logs = await pi.exec(
    "bash",
    ["-c", `docker logs --tail 20 local-llm-llm-general 2>&1 || true`],
    {},
  );
  return { status, logTail: (logs.stdout ?? "").trim() };
}

// ---------------------------------------------------------------------------
// server state machine
// ---------------------------------------------------------------------------

type ServerState = "offline" | "starting" | "idle" | "ready" | "error";

const STATE_LABEL: Record<ServerState, string> = {
  offline: "offline  (no server running)",
  starting: "starting (container up, model loading)",
  idle: "idle     (server up, no model resident yet)",
  ready: "ready    (model loaded on the GPU)",
  error: "error    (server failed to start or is restart-looping)",
};

let serverState: ServerState = "offline";
let serverDetail = "";
let startInFlight = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

function clearPoll(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}

/** Observe the real server; never throws. */
async function refreshState(pi: ExtensionAPI): Promise<{
  state: ServerState;
  detail: string;
  models: ModelStatus[];
}> {
  let models: ModelStatus[] = [];
  try {
    models = await listModels();
    const loaded = models.filter((m) => m.loaded);
    if (loaded.length > 0) {
      serverState = "ready";
      serverDetail = loaded.map((m) => m.id).join(", ");
    } else {
      serverState = "idle";
      serverDetail = models.map((m) => m.id).join(", ") || "no models";
    }
    return { state: serverState, detail: serverDetail, models };
  } catch {
    // No HTTP answer: distinguish "not running" from "crash-looping".
    try {
      const c = await containerState(pi);
      if (/restarting/i.test(c.status)) {
        serverState = "error";
        serverDetail = `container ${c.status}`;
      } else if (/^up/i.test(c.status)) {
        serverState = "starting";
        serverDetail = `container ${c.status}, not answering yet`;
      } else {
        serverState = "offline";
        serverDetail = `container ${c.status}`;
      }
    } catch {
      serverState = "offline";
      serverDetail = "no container";
    }
    return { state: serverState, detail: serverDetail, models };
  }
}

/** Free VRAM in MiB, or null when nvidia-smi is unavailable. */
async function gpuFreeMib(pi: ExtensionAPI): Promise<number | null> {
  const r = await pi.exec(
    "bash",
    [
      "-c",
      "nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | head -1",
    ],
    {},
  );
  const n = Number((r.stdout ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Per-frame token cost at other widths, extrapolated from one exact
 * measurement. Frames keep the source aspect ratio, so cost scales with pixel
 * count, i.e. with width squared. Checked against measurements on this model:
 * predicting from 512 gives 1% error at 1024, 5% at 768, 7% at 256 - close
 * enough to choose a setting, while the requested width stays exact.
 */
function perFrameAtWidth(
  measuredPerFrame: number,
  measuredWidth: number,
  width: number,
): number {
  return Math.max(
    1,
    Math.round(measuredPerFrame * (width / measuredWidth) ** 2),
  );
}

function framesThatFit(
  budget: number,
  overhead: number,
  perFrame: number,
): number {
  return Math.max(0, Math.min(MAX_FRAMES, Math.floor((budget - overhead) / perFrame)));
}

/** The "what can I actually ask for" table shown on refusal and on dry runs. */
function optionsTable(
  measuredPerFrame: number,
  measuredWidth: number,
  overhead: number,
  budget: number,
): string {
  const rows = WIDTH_LADDER.map((w) => {
    const pf = perFrameAtWidth(measuredPerFrame, measuredWidth, w);
    const fits = framesThatFit(budget, overhead, pf);
    const exact = w === measuredWidth;
    return (
      `    ${String(w).padEnd(6)} ${String(pf).padStart(5)} tok/frame` +
      `   max ${String(fits).padStart(3)} frames` +
      (fits >= MAX_FRAMES ? "  (hard cap)" : "") +
      (exact ? "   <- measured" : "   (estimated)")
    );
  });
  return `    width  tok/frame        frames\n${rows.join("\n")}`;
}

async function toDataUrl(path: string): Promise<ChatContent> {
  const buf = await readFile(path);
  return {
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` },
  };
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerCommand("start-local-server", {
    description:
      "Start the local llama.cpp server in router mode (all installed models); " +
      "optional <user>/<model> [quant] is downloaded first. 'single <model>' pins one model",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      // Router mode is the default: it serves every installed model and loads
      // them on demand, which is what pi's own llama.cpp provider requires
      // (/login llama.cpp rejects a single-model server with "Server is not
      // running in llama.cpp router mode"). "single" opts back out.
      let router = true;
      if (/^(--)?single$/.test(tokens[0] ?? "")) {
        router = false;
        tokens.shift();
      } else if (/^(--)?router$/.test(tokens[0] ?? "")) {
        tokens.shift();
      }
      let [repo, quant] = tokens;

      if (!existsSync(SERVE_SCRIPT)) {
        ctx.ui.notify(
          `serve_model.sh not found at ${SERVE_SCRIPT}. Set LOCAL_LLM_REPO to the local_llm checkout.`,
          "error",
        );
        return;
      }

      // No model given: in router mode that is the normal case — everything on
      // disk is served, so there is nothing to choose. Single-model mode still
      // needs a pick, so offer what is already installed.
      if (!repo && !router) {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            "Usage: /start-local-server single <user>/<model> [quant]",
            "error",
          );
          return;
        }
        let inv: LocalInventory;
        try {
          ctx.ui.setStatus("local-vlm", "listing local models...");
          inv = await localInventory(pi);
        } catch (err) {
          ctx.ui.notify((err as Error).message, "error");
          return;
        } finally {
          ctx.ui.setStatus("local-vlm", undefined);
        }

        if (inv.models.length === 0) {
          ctx.ui.notify(
            `No models in ${inv.modelsDir}. Pass a HuggingFace repo: ` +
              `/start-local-server single <user>/<model> [quant]`,
            "error",
          );
          return;
        }

        // Show the bare model name plus its group and vision status; keep the
        // full relative path as the value we hand back to the script.
        const options = inv.models.map((m) => {
          const name = m.file.split("/").pop() ?? m.file;
          const vision = m.mmproj ? " [vision]" : "";
          return {
            label: `${name}   ${fmtBytes(m.bytes)}${vision}   ${m.group ?? "(ungrouped)"}`,
            value: m.file,
          };
        });

        const choice = await ctx.ui.select(
          "Serve which model?",
          options.map((o) => o.label),
        );
        if (!choice) {
          ctx.ui.notify("Cancelled.", "warning");
          return;
        }
        repo = options.find((o) => o.label === choice)?.value ?? choice;
        quant = undefined;
      }

      // A model argument still resolves (and downloads) exactly as before; in
      // router mode it is then served by the router along with everything else.
      let plan:
        | {
            repo: string;
            model: string;
            mmproj: string | null;
            modelBytes: number;
            missingBytes: number;
            installed: boolean;
            modelsDir: string;
          }
        | null = null;
      const quoted = repo ? quoteArgs(repo, quant) : "";

      if (repo) {
        ctx.ui.setStatus("local-vlm", `resolving ${repo}...`);
        try {
          const planRun = await pi.exec("bash", ["-c", `PLAN=1 ${quoted}`], {
            timeout: 60_000,
          });
          if ((planRun.code ?? 0) !== 0) {
            ctx.ui.setStatus("local-vlm", undefined);
            ctx.ui.notify(
              `Could not resolve model:\n${planRun.stderr || planRun.stdout}`,
              "error",
            );
            return;
          }
          const jsonStart = planRun.stdout.indexOf("{");
          if (jsonStart < 0) throw new Error(planRun.stdout || planRun.stderr);
          plan = JSON.parse(planRun.stdout.slice(jsonStart));
        } catch (err) {
          ctx.ui.setStatus("local-vlm", undefined);
          ctx.ui.notify(
            `Failed to resolve ${repo}: ${(err as Error).message}`,
            "error",
          );
          return;
        }
        ctx.ui.setStatus("local-vlm", undefined);

        if (plan && !plan.installed) {
          const gb = (plan.missingBytes / 1e9).toFixed(1);
          const ok = await ctx.ui.confirm(
            "Model not installed",
            `${plan.repo}\n  file   : ${plan.model}\n` +
              (plan.mmproj ? `  mmproj : ${plan.mmproj}\n` : "") +
              `\nDownload ${gb} GB to ${plan.modelsDir}?`,
          );
          if (!ok) {
            ctx.ui.notify("Aborted; server not started.", "warning");
            return;
          }
        }
      }

      if (startInFlight) {
        ctx.ui.notify(
          "A server start is already in progress — /local-server-status to watch it.",
          "warning",
        );
        return;
      }

      const label = router
        ? plan
          ? `router (+ ${plan.model})`
          : "router (all installed models)"
        : (plan?.model ?? repo);

      // Start WITHOUT awaiting. Waiting here blocks the whole TUI for as long
      // as the model takes to load (minutes for a 27B), which looks like pi
      // has frozen. DETACH=1 returns as soon as the container is up; readiness
      // is then polled in the background and reported when it resolves.
      startInFlight = true;
      serverState = "starting";
      serverDetail = label;
      clearPoll();
      ctx.ui.setStatus("local-vlm", `starting ${label}...`);
      ctx.ui.notify(
        `Starting ${label}… you can keep working; ` +
          `/local-server-status shows progress.`,
        "info",
      );

      const finish = (
        ok: boolean,
        headline: string,
        detail: string,
      ): void => {
        startInFlight = false;
        ctx.ui.setStatus("local-vlm", undefined);
        serverState = ok ? "ready" : "error";
        serverDetail = ok ? label : headline;
        ctx.ui.notify(`${headline}\n${detail}`, ok ? "info" : "error");
        // Durable record in the transcript; notifications are transient.
        pi.appendEntry("local-vlm-start", {
          ok,
          headline,
          detail,
          model: label,
          mmproj: plan?.mmproj ?? null,
        });
      };

      void (async () => {
        try {
          // ROUTER=1 short-circuits serve_model.sh before it looks at a model
          // argument, so a requested model is fetched in a separate NO_START
          // pass first; the router then picks it up from disk.
          if (router && quoted) {
            const dl = await pi.exec(
              "bash",
              ["-c", `YES=1 NO_START=1 ${quoted}`],
              { timeout: 30 * 60_000 },
            );
            if ((dl.code ?? 0) !== 0) {
              finish(
                false,
                `Failed to fetch ${plan?.model ?? repo}`,
                (dl.stderr || dl.stdout).trim().slice(-1200) ||
                  "no output from serve_model.sh",
              );
              return;
            }
          }

          const cmd = router
            ? `ROUTER=1 YES=1 DETACH=1 ${JSON.stringify(SERVE_SCRIPT)}`
            : `YES=1 DETACH=1 SINGLE=1 ${quoted}`;
          const start = await pi.exec(
            "bash",
            ["-c", cmd],
            { timeout: 30 * 60_000 }, // a cold download can be long; never infinite
          );
          if ((start.code ?? 0) !== 0) {
            finish(
              false,
              `Failed to start ${label}`,
              (start.stderr || start.stdout).trim().slice(-1200) ||
                "no output from serve_model.sh",
            );
            return;
          }

          // Container is up; wait for the model to actually become resident.
          // In router mode "idle" is the expected steady state: every model is
          // registered and loads on its first request.
          const deadline = Date.now() + 10 * 60_000;
          for (;;) {
            await new Promise<void>((r) => {
              pollTimer = setTimeout(r, 3000);
            });
            const { state, detail } = await refreshState(pi);

            if (state === "ready" || state === "idle") {
              finish(
                true,
                `Local server ready on ${baseUrl()}`,
                (router
                  ? `mode   : router (models load on demand)\n` +
                    `models : ${detail}\n`
                  : `model  : ${plan?.model ?? repo}\n` +
                    `mmproj : ${plan?.mmproj ?? "none (text only)"}\n`) +
                  `loaded : ${state === "ready" ? detail : "registered, loads on first request"}` +
                  (router
                    ? `\nIn pi  : /login llama.cpp -> ${baseUrl()}, then /llama`
                    : ""),
              );
              return;
            }
            if (state === "error") {
              const c = await containerState(pi).catch(() => null);
              finish(
                false,
                `${label} failed to load`,
                (c?.logTail ?? detail).split("\n").slice(-12).join("\n"),
              );
              return;
            }
            if (Date.now() > deadline) {
              finish(
                false,
                `Timed out waiting for ${label}`,
                `Server did not become ready within 10 minutes (state: ${state}).`,
              );
              return;
            }
            ctx.ui.setStatus("local-vlm", `loading ${label}... (${state})`);
          }
        } catch (err) {
          finish(false, `Error starting ${label}`, (err as Error).message);
        } finally {
          clearPoll();
        }
      })();
    },
  });

  // Durable, readable record of each start attempt.
  pi.registerEntryRenderer("local-vlm-start", (entry, _opts, theme) => {
    const d = entry.data as {
      ok: boolean;
      headline: string;
      detail: string;
    };
    const box = new Box(1, 1, (text: string) =>
      theme.bg("customMessageBg", text),
    );
    box.addChild(
      new Text(
        `${d.ok ? "✓" : "✗"} ${theme.bold(d.headline)}`,
      ),
    );
    for (const line of d.detail.split("\n")) {
      box.addChild(new Text(theme.fg("dim", `  ${line}`)));
    }
    return box;
  });

  pi.registerCommand("local-server-status", {
    description:
      "Show the local llama.cpp server state: offline, starting, idle, ready, or error",
    handler: async (_args, ctx) => {
      if (startInFlight) {
        ctx.ui.notify(
          `state: starting\n${serverDetail} — still loading, check again shortly.`,
          "info",
        );
        return;
      }

      ctx.ui.setStatus("local-vlm", "checking server...");
      const { state, detail, models } = await refreshState(pi);
      ctx.ui.setStatus("local-vlm", undefined);

      const lines = [`state: ${STATE_LABEL[state]}`, `url  : ${baseUrl()}`];
      if (detail) lines.push(`info : ${detail}`);
      for (const m of models) {
        lines.push(
          `  ${m.loaded ? "*" : " "} ${m.id}${m.ctxSize ? `  ctx=${m.ctxSize}` : ""}`,
        );
      }
      if (state === "offline") {
        lines.push("", "Start one with /start-local-server");
      }

      ctx.ui.notify(lines.join("\n"), state === "error" ? "error" : "info");
    },
  });

  pi.on("session_shutdown", async () => {
    clearPoll();
  });

  pi.registerTool({
    name: "local_llm_status",
    label: "Local LLM Status",
    description:
      "Report the state of the local llama.cpp server: whether it is reachable, " +
      "which models it serves, which one is loaded on the GPU, each model's context " +
      "window, whether a vision projector is attached, GPU memory use, and which " +
      "model files exist on disk. Use this before local_vlm_query to see what is available.",
    promptSnippet: "Check which local model is loaded and what else is available",
    parameters: Type.Object({}),

    async execute(_id, _params, signal) {
      const lines: string[] = [];
      let served: ModelStatus[] = [];
      let reachable = true;

      try {
        served = await listModels(signal);
      } catch {
        reachable = false;
      }

      if (reachable) {
        lines.push(`server: up at ${baseUrl()}`);
        const loaded = served.filter((m) => m.loaded);
        lines.push(
          loaded.length
            ? `loaded: ${loaded.map((m) => m.id).join(", ")}`
            : `loaded: none (models load on first request)`,
        );
        lines.push("", "served models:");
        for (const m of served) {
          const vision = /mmproj/i.test(m.id) ? "  [PROJECTOR, not a model]" : "";
          lines.push(
            `  ${m.loaded ? "*" : " "} ${m.id}` +
              (m.ctxSize ? `  ctx=${m.ctxSize}` : "") +
              vision,
          );
        }
        if (served.some((m) => /mmproj/i.test(m.id))) {
          lines.push(
            "",
            "WARNING: a projector is exposed as its own model, which means the server",
            "is in router mode and the real model has NO vision. Restart via",
            "/start-local-server single <model> so it is attached with --mmproj.",
          );
        }
      } else {
        lines.push(`server: DOWN (no response at ${baseUrl()})`);
        try {
          const c = await containerState(pi);
          lines.push(`container: ${c.status}`);
          if (c.logTail) {
            lines.push("", "last container log lines:");
            lines.push(
              ...c.logTail.split("\n").slice(-12).map((l) => `  ${l}`),
            );
          }
        } catch {
          /* docker may not be available */
        }
      }

      try {
        const inv = await localInventory(pi);
        lines.push("", `models on disk (${inv.modelsDir}):`);
        for (const m of inv.models) {
          lines.push(
            `  ${m.file}  ${fmtBytes(m.bytes)}` +
              (m.mmproj ? `  [vision: ${m.mmproj}]` : "  [text only]"),
          );
        }
      } catch (err) {
        lines.push("", `could not list local models: ${(err as Error).message}`);
      }

      const gpu = await pi.exec(
        "bash",
        [
          "-c",
          "nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader 2>/dev/null || true",
        ],
        {},
      );
      if ((gpu.stdout ?? "").trim()) {
        lines.push("", `gpu: ${gpu.stdout.trim()}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          reachable,
          served: served.map((m) => ({
            id: m.id,
            loaded: m.loaded,
            ctxSize: m.ctxSize,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "local_llm_load",
    label: "Load Local Model",
    description:
      "Start or restart the local llama.cpp server on a specific model, and wait " +
      "until it is loaded on the GPU. Accepts either a local GGUF filename (as " +
      "reported by local_llm_status) or a HuggingFace <user>/<model> repo plus an " +
      "optional quant. A local file never downloads anything; a HuggingFace repo " +
      "that is not already on disk WILL download it, so check the size first. " +
      "Any vision projector found alongside the model is attached automatically.",
    promptSnippet: "Load a specific model into the local llama.cpp server",
    parameters: Type.Object({
      model: Type.String({
        description:
          "Local GGUF filename (e.g. 'Qwen3.8-27B-UD-IQ4_XS.gguf') or a HuggingFace repo ('user/model').",
      }),
      quant: Type.Optional(
        Type.String({
          description:
            "Quant to pick when the HuggingFace repo has several (e.g. 'Q4_K_M'). Ignored for local files.",
        }),
      ),
      mmproj: Type.Optional(
        Type.String({
          description:
            "Vision projector filename to attach, or 'none' for text-only. A projector only works with the model it was built from; a mismatch crashes the server. For a local file with several models on disk this must be given explicitly, otherwise the server starts text-only.",
        }),
      ),
      redownload: Type.Optional(
        Type.Boolean({
          description:
            "Re-fetch every file for this model even if already on disk and the right size. Use to repair a corrupt or truncated file. Requires allowDownload: true, since it always re-transfers the full model.",
        }),
      ),
      allowDownload: Type.Optional(
        Type.Boolean({
          description:
            "Permit downloading if the model is not on disk. Default false — the tool refuses and reports the size instead.",
        }),
      ),
    }),

    async execute(_id, params, signal, onUpdate) {
      requireScript();
      const quoted = quoteArgs(
        params.model,
        params.quant,
        params.mmproj,
        params.redownload,
      );

      // Resolve first so we can refuse an unexpected multi-GB download.
      onUpdate?.({ content: [{ type: "text", text: `Resolving ${params.model}...` }] });
      const planRun = await pi.exec("bash", ["-c", `PLAN=1 ${quoted}`], {});
      if ((planRun.code ?? 0) !== 0) {
        throw new Error(
          `Could not resolve "${params.model}":\n${planRun.stderr || planRun.stdout}`,
        );
      }
      const jsonStart = planRun.stdout.indexOf("{");
      if (jsonStart < 0) {
        throw new Error(`Unexpected output: ${planRun.stdout.slice(0, 400)}`);
      }
      const plan = JSON.parse(planRun.stdout.slice(jsonStart)) as {
        repo: string;
        model: string;
        mmproj: string | null;
        missingBytes: number;
        installed: boolean;
        modelsDir: string;
      };

      if (!plan.installed && !params.allowDownload) {
        throw new Error(
          params.redownload
            ? `Re-downloading "${plan.model}" would re-transfer ` +
              `${fmtBytes(plan.missingBytes)} from ${plan.repo}.\n` +
              `Re-call with allowDownload: true to confirm.`
            : `"${plan.model}" is not on disk and would need a ` +
              `${fmtBytes(plan.missingBytes)} download from ${plan.repo}.\n` +
              `Re-call with allowDownload: true to proceed, or pick a model that is ` +
              `already installed (see local_llm_status).`,
        );
      }

      onUpdate?.({
        content: [{ type: "text", text: `Starting server on ${plan.model}...` }],
      });
      const start = await pi.exec("bash", ["-c", `YES=1 ${quoted}`], {});
      if ((start.code ?? 0) !== 0) {
        const c = await containerState(pi).catch(() => null);
        throw new Error(
          `Server failed to start on ${plan.model}.\n` +
            `${(start.stderr || start.stdout).slice(-1200)}` +
            (c ? `\n\ncontainer: ${c.status}\n${c.logTail.split("\n").slice(-12).join("\n")}` : ""),
        );
      }

      // Confirm it is genuinely resident, not merely registered.
      const models = await listModels(signal);
      const target =
        models.find((m) => m.id === plan.model.replace(/\.gguf$/, "")) ??
        models.find((m) => !/mmproj/i.test(m.id)) ??
        models[0];
      if (target && !target.loaded) {
        onUpdate?.({
          content: [{ type: "text", text: `Loading ${target.id} onto the GPU...` }],
        });
        await chat(target.id, [{ type: "text", text: "hi" }], 1, signal);
      }
      const after = await listModels(signal);
      const nowLoaded = after.filter((m) => m.loaded).map((m) => m.id);

      return {
        content: [
          {
            type: "text",
            text:
              `Server up on ${baseUrl()}\n` +
              `  model  : ${plan.model}\n` +
              `  mmproj : ${plan.mmproj ?? "none (text only)"}\n` +
              `  loaded : ${nowLoaded.length ? nowLoaded.join(", ") : "not yet resident"}`,
          },
        ],
        details: { model: plan.model, mmproj: plan.mmproj, loaded: nowLoaded },
      };
    },
  });

  pi.registerTool({
    name: "local_vlm_query",
    label: "Local VLM",
    description:
      "Ask the locally hosted vision-language model about text, images, or a video. " +
      "Video is sampled into frames with ffmpeg and sent as images. " +
      "Always state exactly what to look for and what correct behaviour would be; " +
      "broad prompts like 'find bugs' produce hallucinations. " +
      `Frame count is capped at ${MAX_FRAMES}. Before sending, the tool verifies the ` +
      "model is downloaded, loaded on the GPU, and that the request fits the context window.",
    promptSnippet:
      "Ask the local vision-language model about an image or a video clip (frames + prompt)",
    promptGuidelines: [
      "Use local_vlm_query for questions about the visual content of a video or image, not for code reasoning.",
      "When calling local_vlm_query on a video, prefer a narrow start/end window over the whole clip.",
      "Call local_vlm_query with dryRun:true first when planning a large request; it reports tokens/frame and the max frames available at each resolution without spending a full inference.",
      "For local_vlm_query, reading on-screen text (HUD, debug overlays) needs frameWidth 1024 or more; at 512px small text is illegible and the model will invent values.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "What to look for. Be specific and state the expected-correct behaviour.",
      }),
      video: Type.Optional(
        Type.String({
          description: "Path to a video file to sample into frames.",
        }),
      ),
      images: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Paths to still images to send instead of / alongside a video.",
        }),
      ),
      start: Type.Optional(
        Type.String({ description: "Clip start: seconds, MM:SS, or HH:MM:SS." }),
      ),
      end: Type.Optional(
        Type.String({ description: "Clip end: seconds, MM:SS, or HH:MM:SS." }),
      ),
      fps: Type.Optional(
        Type.Number({
          description:
            "Sampling rate. Omit to spread maxFrames over the window.",
        }),
      ),
      maxFrames: Type.Optional(
        Type.Number({
          description: `Maximum frames to send (default 16, hard cap ${MAX_FRAMES}).`,
        }),
      ),
      frameWidth: Type.Optional(
        Type.Number({
          description: "Resize frames to this width in px (default 512).",
        }),
      ),
      maxTokens: Type.Optional(
        Type.Number({
          description: "Maximum tokens in the model's answer (default 800).",
        }),
      ),
      thinking: Type.Optional(
        Type.Boolean({
          description:
            "Let the model reason before answering. Default false. Reasoning models can spend the entire token budget thinking and return nothing, so raise maxTokens well above 2000 if enabling this.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          description:
            "Measure and report the cost of this request (tokens/frame, total tokens, VRAM, and the max frames available at each resolution) WITHOUT sending it or getting an answer. Use this to choose frameWidth and maxFrames before committing to a large request.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
      const maxFrames = Math.min(params.maxFrames ?? 16, MAX_FRAMES);
      if (params.maxFrames && params.maxFrames > MAX_FRAMES) {
        throw new Error(
          `maxFrames=${params.maxFrames} exceeds the hard cap of ${MAX_FRAMES} frames.`,
        );
      }
      if (!params.video && !params.images?.length) {
        throw new Error("Provide either `video` or `images`.");
      }

      // --- precheck 1: server up, model present ----------------------------
      onUpdate?.({ content: [{ type: "text", text: "Checking local server..." }] });
      const models = await listModels(signal);
      if (models.length === 0) {
        throw new Error("Local server is running but serving no models.");
      }
      const wanted = process.env.LOCAL_LLM_MODEL;
      const model =
        (wanted && models.find((m) => m.id === wanted)) ??
        models.find((m) => !/mmproj/i.test(m.id)) ??
        models[0];
      if (wanted && model.id !== wanted) {
        throw new Error(
          `Model "${wanted}" is not served. Available: ${models
            .map((m) => m.id)
            .join(", ")}`,
        );
      }
      if (/mmproj/i.test(model.id)) {
        throw new Error(
          `The server is exposing the projector "${model.id}" as a model. ` +
            `Restart with /start-local-server single <model> so it is attached via --mmproj.`,
        );
      }

      // --- precheck 2: actually loaded on the GPU --------------------------
      // Router mode loads lazily. Force the load now with a 1-token text-only
      // request so "model is on the GPU" is verified before we spend time on
      // ffmpeg, and so the probes below measure a warm server.
      if (!model.loaded) {
        onUpdate?.({
          content: [{ type: "text", text: `Loading ${model.id} onto the GPU...` }],
        });
        await chat(model.id, [{ type: "text", text: "hi" }], 1, signal);
        const after = (await listModels(signal)).find((m) => m.id === model.id);
        if (after && !after.loaded) {
          throw new Error(`Model "${model.id}" failed to load onto the GPU.`);
        }
      }

      // --- precheck 3: context window is knowable --------------------------
      const ctxWindow = await resolveContextWindow(model, signal);

      // --- gather frames ----------------------------------------------------
      let tmpDir: string | undefined;
      const framePaths: string[] = [];
      let sampling = "";
      try {
        if (params.video) {
          const videoPath = resolve(ctx.cwd, params.video.replace(/^@/, ""));
          await stat(videoPath).catch(() => {
            throw new Error(`Video not found: ${videoPath}`);
          });
          onUpdate?.({ content: [{ type: "text", text: "Extracting frames..." }] });
          const ex = await extractFrames(
            pi,
            {
              video: videoPath,
              fps: params.fps,
              maxFrames,
              start: params.start,
              end: params.end,
              frameWidth: params.frameWidth ?? 512,
            },
            signal,
          );
          tmpDir = ex.dir;
          framePaths.push(...ex.files);
          sampling =
            `${ex.files.length} frames @ ${ex.fps.toFixed(2)} fps ` +
            `over ${ex.window.toFixed(2)}s of a ${ex.duration.toFixed(2)}s video`;
        }
        for (const img of params.images ?? []) {
          framePaths.push(resolve(ctx.cwd, img.replace(/^@/, "")));
        }
        if (framePaths.length > MAX_FRAMES) {
          throw new Error(
            `${framePaths.length} images exceeds the hard cap of ${MAX_FRAMES}.`,
          );
        }

        const frames = await Promise.all(framePaths.map(toDataUrl));
        const textPart: ChatContent = { type: "text", text: params.prompt };

        // --- precheck 4: vision available + measure real token cost ---------
        // One probe with 1 frame and one with 2 frames. The difference is the
        // true per-frame cost for this projector at this resolution; the
        // remainder is the fixed overhead. No guessing, no overflow.
        onUpdate?.({ content: [{ type: "text", text: "Probing context cost..." }] });
        let one: { promptTokens: number };
        try {
          one = await chat(model.id, [textPart, frames[0]], 1, signal);
        } catch (err) {
          const msg = (err as Error).message;
          if (/mmproj|projector|image|vision|multimodal/i.test(msg)) {
            throw new Error(
              `The served model "${model.id}" cannot accept images — no vision projector is loaded.\n` +
                `Restart with /start-local-server <repo> <quant> using a repo that ships an mmproj file.\n` +
                `Server said: ${msg.slice(0, 300)}`,
            );
          }
          throw err;
        }

        let perFrame: number;
        let overhead: number;
        if (frames.length >= 2) {
          const two = await chat(
            model.id,
            [textPart, frames[0], frames[1]],
            1,
            signal,
          );
          perFrame = Math.max(1, two.promptTokens - one.promptTokens);
          overhead = Math.max(0, one.promptTokens - perFrame);
        } else {
          perFrame = one.promptTokens;
          overhead = 0;
        }

        // --- precheck 5: dry run — does the real request fit? ---------------
        const maxTokens = params.maxTokens ?? 800;
        const width = params.frameWidth ?? 512;
        const projected = overhead + perFrame * frames.length;
        const budget = Math.floor(
          (ctxWindow - maxTokens - OUTPUT_RESERVE) * SAFETY_MARGIN,
        );
        const fits = framesThatFit(budget, overhead, perFrame);

        // Transient VRAM the image batch needs on top of the loaded model.
        const freeMib = await gpuFreeMib(pi);
        const vramNeed = Math.round(projected * VRAM_MIB_PER_IMAGE_TOKEN);
        const vramShort =
          freeMib !== null && vramNeed > freeMib - VRAM_BUFFER_MIB;

        const costReport =
          `  model    : ${model.id}\n` +
          `  frames   : ${frames.length} @ ${width}px` +
          (sampling ? `  (${sampling})` : "") +
          `\n` +
          `  measured : ${perFrame} tokens/frame, ${overhead} tokens overhead\n` +
          `  tokens   : ~${projected} of ${budget} budget ` +
          `(ctx ${ctxWindow} - ${maxTokens} answer - ${OUTPUT_RESERVE} reserve, x${SAFETY_MARGIN})\n` +
          `  vram     : ~${vramNeed} MiB transient` +
          (freeMib !== null
            ? `, ${freeMib} MiB free, keeping ${VRAM_BUFFER_MIB} MiB buffer`
            : " (nvidia-smi unavailable)") +
          `\n\n` +
          `  available at this context:\n${optionsTable(perFrame, width, overhead, budget)}`;

        if (projected > budget || vramShort) {
          const why = projected > budget ? "context window" : "available VRAM";
          throw new Error(
            `Request would exceed the ${why} — NOT SENT.\n\n` +
              costReport +
              `\n\n  fix: keep ${width}px and use maxFrames <= ${fits}, ` +
              `or drop frameWidth to fit more frames (see table). ` +
              `Fewer, larger frames read on-screen text; more, smaller frames ` +
              `track motion.`,
          );
        }

        if (params.dryRun) {
          return {
            content: [
              {
                type: "text",
                text:
                  `DRY RUN — request is within limits, nothing was sent.\n\n` +
                  costReport +
                  `\n\n  Re-call without dryRun to get the answer.`,
              },
            ],
            details: {
              dryRun: true,
              frames: frames.length,
              frameWidth: width,
              perFrameTokens: perFrame,
              projectedTokens: projected,
              budget,
              contextWindow: ctxWindow,
              vramNeedMib: vramNeed,
              freeMib,
              maxFramesAtThisWidth: fits,
            },
          };
        }

        // --- send -----------------------------------------------------------
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Sending ${frames.length} frames (~${projected}/${ctxWindow} tokens)...`,
            },
          ],
        });
        const answer = await chat(
          model.id,
          [textPart, ...frames],
          maxTokens,
          signal,
          params.thinking ?? false,
        );

        // A reasoning model that ran out of budget mid-thought returns empty
        // content; surface the reasoning rather than an empty result.
        let body = answer.text.trim();
        let note = "";
        if (!body && answer.reasoning.trim()) {
          body = answer.reasoning.trim();
          note =
            `NOTE: the model returned only reasoning, no final answer` +
            (answer.truncated ? ` (hit the ${maxTokens}-token limit)` : "") +
            `. Raise maxTokens or set thinking:false.\n\n`;
        } else if (!body) {
          throw new Error(
            `The model returned an empty answer (finish_reason=${
              answer.truncated ? "length" : "stop"
            }). Try raising maxTokens.`,
          );
        } else if (answer.truncated) {
          note = `NOTE: answer truncated at ${maxTokens} tokens.\n\n`;
        }

        const header =
          `model: ${model.id}\n` +
          (sampling ? `sampling: ${sampling}\n` : `images: ${frames.length}\n`) +
          `context: ${answer.promptTokens}/${ctxWindow} tokens used\n\n` +
          note;

        return {
          content: [{ type: "text", text: header + body }],
          details: {
            model: model.id,
            frames: frames.length,
            perFrameTokens: perFrame,
            promptTokens: answer.promptTokens,
            contextWindow: ctxWindow,
            sampling,
          },
        };
      } finally {
        if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  });
}

# local-vlm — pi extension

Integrates the `local_llm` llama.cpp stack with pi. Lives in the pi home
directory (`~/.pi/agent/extensions/local-vlm/`) and is auto-discovered — no
symlink or settings entry needed.

It shells out to `scripts/serve_model.sh` from the `local_llm` repo, which it
expects at `~/projects/local_llm`. Override with `LOCAL_LLM_REPO`.

## Commands

| command | purpose |
|---|---|
| `/start-local-server [<user>/<model>] [quant]` | start a model; with no argument, shows a dropdown of installed models |
| `/local-server-status` | report server state: `offline`, `starting`, `idle`, `ready`, `error` |

`/start-local-server` returns immediately and loads in the background, so the
TUI stays usable while a 27B loads. It reports the outcome twice: a transient
notification, and a durable ✓/✗ card in the transcript. Waiting inline instead
would freeze pi for minutes and look like a crash.

States:

| state | meaning |
|---|---|
| `offline` | no container running |
| `starting` | container up, model not resident yet |
| `idle` | server answering, no model loaded (loads on first request) |
| `ready` | model loaded on the GPU |
| `error` | start failed, or the container is restart-looping |

## Tools

| tool | purpose |
|---|---|
| `local_llm_status` | what is served, what is loaded on the GPU, context windows, vision availability, models on disk, GPU memory. Falls back to container status + log tail when the server is down. |
| `local_llm_load` | start/restart the server on a model and wait until it is resident. Refuses an unexpected download unless `allowDownload: true`; `redownload: true` re-fetches a model that is already on disk, to repair a corrupt file. |
| `local_vlm_query` | ask the model about text, images, or a video sampled into frames. |

## Model layout

Everything a repo ships lands in that repo's own directory, so weights,
projectors and any extra files stay grouped with the model they belong to:

```
infra/models/
  unsloth__Qwen3.8-27B-GGUF/
    Qwen3.8-27B-UD-IQ4_XS.gguf
    mmproj-BF16.gguf
  Jackrong__Qwen3.5-27B-...-GGUF/
    Qwen3.5-27B.Q4_K_M.gguf
```

This makes projector pairing **structural**: the projector for a model is the
one sitting next to it. Names like `mmproj-BF16.gguf` describe the projector's
own precision, not the model it belongs to, so in a flat directory two repos
collide and silently mispair — which crashes llama.cpp with
`mismatch between text model (n_embd=X) and mmproj (n_embd=Y)` and puts the
container into a restart loop.

## `/start-local-server [<user>/<model>] [quant]`

With no arguments, shows a dropdown of models already on disk (with size, group,
and whether vision is available) and serves the chosen one — no network access.


Resolves the repo against the HuggingFace API via `serve_model.sh PLAN=1`.
If the model is not installed it shows the download size and asks for
confirmation in pi's UI before fetching, then starts the server and waits for
readiness.

```
/start-local-server Jackrong/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-GGUF Q4_K_M
```

Omit the quant when the repo has exactly one GGUF; if it has several, the
script lists them with sizes.

## `local_vlm_query` tool

Callable by the agent. Sends text + images, or text + a video sampled into
frames with ffmpeg.

| param | meaning |
|---|---|
| `prompt` | what to look for (be specific; state expected-correct behaviour) |
| `video` | path to a clip, sampled with ffmpeg |
| `images` | still image paths instead of/alongside a video |
| `start` / `end` | clip window — seconds, `MM:SS`, or `HH:MM:SS` |
| `fps` | sampling rate; omit to spread `maxFrames` across the window |
| `maxFrames` | default 16, **hard cap 600** (60fps×10s or 120fps×5s) |
| `frameWidth` | resize width, default 512 — the main token-cost lever |
| `maxTokens` | answer length, default 800 |

### Prechecks (in order)

Every request is validated before any large payload is sent:

1. **Server reachable** — otherwise tells you to run `/start-local-server`.
2. **Model present** — `/v1/models`; refuses if an `mmproj` file is being
   exposed as a model (see below).
3. **Loaded on device** — router mode loads lazily, so a 1-token text request
   forces the load, then `/v1/models` is re-read to confirm `status=loaded`.
4. **Context window known** — from `/props` `n_ctx`, falling back to the
   `--ctx-size` in the model's launch argv. Refuses to proceed if unknown.
5. **Vision available** — a 1-frame probe; a projector error is translated into
   an actionable message rather than a raw 500.
6. **Context fits** — measured, not guessed. A 1-frame and a 2-frame probe are
   sent with `max_tokens=1`; the difference in `usage.prompt_tokens` is the true
   per-frame cost for this projector at this resolution, and the remainder is
   fixed overhead. The full request is sent only if

   ```
   overhead + perFrame × frames  ≤  (n_ctx − maxTokens − 1024) × 0.90
   ```

   Otherwise it fails *without sending*, reporting the measured cost and the
   exact `maxFrames` value that would fit.

### Env overrides

- `LOCAL_LLM_REPO` — path to the local_llm checkout (default `~/projects/local_llm`)
- `LOCAL_LLM_PORT` — server port (default `30000`)
- `LOCAL_LLM_MODEL` — pin a specific served model id
- `MMPROJ` (script-level) — force a projector, or `none` for text-only

## Note: reasoning models return empty answers by default

Qwen3.x / GLM and friends think by default. The whole `maxTokens` budget goes
into `reasoning_content` and `content` comes back as an empty string with
`finish_reason: length`. `local_vlm_query` therefore sends
`chat_template_kwargs: {enable_thinking: false}` unless `thinking: true` is
asked for, and falls back to showing the reasoning (with a note) rather than
returning nothing.

## Note: pin the llama.cpp image

`ghcr.io/ggml-org/llama.cpp:server-cuda` is a floating tag. A cached copy can
sit months stale while still looking current in `docker images`, and an old
build fails on newer architectures with errors like `missing tensor
'blk.64.ssm_conv1d.weight'`. `infra/.env` pins an immutable `server-cuda-b<N>`
tag for that reason.

## Note: router mode cannot do vision

`llama-server --models-dir` registers every `*.gguf` as its own model, so a
`mmproj-*.gguf` projector becomes a bogus standalone "model" and the real VLM
loads with no vision at all. `serve_model.sh` therefore sets `SINGLE_MODEL=1`
and `MMPROJ_FILE=...`, which makes the entrypoint serve one model explicitly
with `--mmproj` attached.

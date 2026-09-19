/**
 * context-savings — pi extension
 *
 * Prompt caches expire after an idle gap (Anthropic: 5 min default, 1 h with
 * extended-cache writes). Once the prompt cache is gone, every request is
 * re-billed at full price. This extension compresses the outgoing context:
 *
 *   - keeps only the latest N tool outputs (default 20); older tool results
 *     are replaced with a short marker. Tool calls in assistant messages are
 *     left untouched, so the model still sees what it did and with what
 *     arguments.
 *   - keeps only the latest M thinking blocks (default 30); older thinking
 *     blocks are removed from assistant messages. The latest assistant
 *     message is never modified (Anthropic requires it to be unmodified).
 *
 * Compression first fires on a guaranteed cache miss (idle gap > TTL, model
 * switch, or context rebuild after compaction), or manually via /compress.
 * It is then STICKY: every subsequent request sends the same frozen trim, so
 * the savings compound with the number of requests. The frozen set (exact
 * toolCallIds + thinking block positions) is deliberately NOT a sliding
 * window: new tool outputs are only trimmed by the next compression event,
 * which keeps the prompt prefix identical request-to-request (warm requests
 * still hit the cache fully) and makes the per-request impact static.
 *
 * Accounting is a running summary: every request accrues
 *   savings += cumulativeTrimmedTokens × (this request's trim rate)
 * where the trim rate is what those tokens would have cost on that request:
 * the input/cacheWrite rate on a genuine cache miss, the cache-read rate on a
 * warm request (see CONTEXT_SAVINGS_RATE_MODE).
 * A compression event raises the cumulative level, so a period of X requests
 * after compression 1 and Y requests after compression 2 saves
 *   X × T1 + Y × T2          (T2 = cumulative trim after compression 2)
 * not Y × (T1 + T2 + …). One snapshot entry is appended per compression
 * (never per request); /savings recomputes the running total by walking the
 * session branch, so it stays exact across /reload, /resume, and /tree.
 *
 * Commands:
 *   /savings  — running savings: total trimmed tokens, dollars saved, and the
 *               per-period breakdown (X req × T1 + Y req × T2 + …)
 *   /usage    — full session usage & cost totals, per-model breakdown,
 *               cache efficiency, plus the context-savings line
 *   /compress — force compression on the very next LLM call, regardless of
 *               cache state (a large cache miss on that request is expected
 *               and intentional)
 *
 * A one-line warning is shown after each compression request, e.g.
 *   Warning: tool/thinking compression enabled; trimmed 15.5k tokens (~$0.42 / 18.3%) from this request.
 *
 * Nothing in the session file is modified by the trim itself — it is a
 * non-destructive per-request context transform (the TUI still shows full
 * tool outputs and thinking blocks, and pi's own compaction is unaffected).
 *
 * Configuration (environment variables, all optional):
 *   CONTEXT_SAVINGS_TTL_MS              cache TTL in ms; 0 (default) = auto:
 *                                       5 min, or 1 h if the previous request
 *                                       used extended (1 h) cache retention
 *   CONTEXT_SAVINGS_KEEP_TOOL_RESULTS   keep the latest N tool outputs (20)
 *   CONTEXT_SAVINGS_KEEP_THINKING_BLOCKS
 *                                       keep the latest M thinking blocks (30)
 *   CONTEXT_SAVINGS_MIN_CONTEXT_TOKENS  skip automatic compression when the
 *                                       estimated context is below this
 *                                       (8000; 0 = off). Manual /compress
 *                                       overrides this.
 *   CONTEXT_SAVINGS_DISABLED=1          turn off *automatic* compression;
 *                                       /savings, /usage and manual /compress
 *                                       still work.
 *   CONTEXT_SAVINGS_RATE_MODE           counterfactual (default) prices
 *                                       trimmed tokens at the cache-read rate
 *                                       on warm requests; paid always uses the
 *                                       input/cache-write rate (optimistic).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // Anthropic default prompt-cache TTL
const EXTENDED_TTL_MS = 60 * 60 * 1000; // Anthropic extended cache TTL (1h)

const TTL_MS = envInt("CONTEXT_SAVINGS_TTL_MS", 0); // 0 = auto (5m / 1h)
const KEEP_TOOL_RESULTS = envInt("CONTEXT_SAVINGS_KEEP_TOOL_RESULTS", 20);
const KEEP_THINKING_BLOCKS = envInt("CONTEXT_SAVINGS_KEEP_THINKING_BLOCKS", 30);
const MIN_CONTEXT_TOKENS = envInt("CONTEXT_SAVINGS_MIN_CONTEXT_TOKENS", 8000);
const TRIM_MIN_TOKENS = 16; // don't bother replacing tiny outputs
const DISABLED = process.env["CONTEXT_SAVINGS_DISABLED"] === "1";

/**
 * Growing the trim edits history that has already been sent, which invalidates
 * the provider's cached prefix from that point. That is only worth paying for
 * when the saving is large relative to the rewrite it forces.
 *
 * Anthropic pricing, relative to base input: cache read 0.1x, cache write
 * 1.25x. Invalidating a context of C tokens therefore costs ~1.15*C extra,
 * while trimming T tokens saves 0.1*T per later request — so a growth only
 * breaks even after ~11.5*C/T requests. With C=250k and T=10k that is ~287
 * requests, and a per-turn sliding window re-grows long before then.
 *
 * These two guards make the "grow every turn" death spiral impossible
 * regardless of how the keep-windows or TTL are configured.
 */
const MIN_REQUESTS_BETWEEN_GROWTH = envInt("CONTEXT_SAVINGS_MIN_REQUESTS_BETWEEN_GROWTH", 8);
/** A growth must remove at least this fraction of the context to be worth a rewrite. */
const MIN_GROWTH_FRACTION = 0.05;

/**
 * How trimmed tokens are priced.
 *   counterfactual (default) — price them at what they *would* have cost on
 *     that request: full input rate on a genuine cache miss, cache-read rate
 *     on a warm request (where an untrimmed prefix would have been cached).
 *   paid — always price at the request's input/cache-write rate. Simpler and
 *     more flattering; correct only for cache-miss requests.
 * Read lazily so it can be flipped at runtime (and by tests).
 */
function rateMode(): "counterfactual" | "paid" {
	return process.env["CONTEXT_SAVINGS_RATE_MODE"] === "paid" ? "paid" : "counterfactual";
}

const ENTRY_TYPE = "context-savings";
const TOOL_OUTPUT_MARKER = "[tool output removed for context savings]";
const MANUAL_REASON = "manual compression via /compress";

// ---------------------------------------------------------------------------
// Structural types (loose on purpose — event payloads are untyped)
// ---------------------------------------------------------------------------

type ContentBlock = { type: string; [key: string]: unknown };

interface LlmMessage {
	role: string;
	content?: unknown;
	[key: string]: unknown;
}

/** The frozen trim applied to every request after a compression. */
interface TrimSpec {
	toolCallIds: Set<string>;
	/**
	 * Identities of removed thinking blocks, NOT positions.
	 *
	 * This used to be [msgIdx, blockIdx] into the context list as it looked at
	 * compression time. Any later change to the shape of that list — a
	 * compaction replacing N messages with one summary, an extension prepending
	 * a message, this very function dropping an emptied message — re-aims every
	 * entry at different content. The trim then edits the wrong message (or
	 * fails to edit the right one), which silently changes the prompt prefix and
	 * destroys the provider cache. Keying on the block's own signature makes the
	 * spec immune to reordering, exactly as toolCallIds already are.
	 */
	thinking: Set<string>;
	/** Total estimated tokens removed by this spec (all compressions so far). */
	cumulativeTokens: number;
}

/**
 * Stable identity for a thinking block. Anthropic returns a `signature` for
 * every thinking block and pi round-trips it as `thinkingSignature`; redacted
 * blocks carry an opaque payload there instead. Fall back to a hash of the
 * text so a block without either is still addressable rather than untrimmable.
 */
function thinkingKey(b: any): string {
	const sig = typeof b?.thinkingSignature === "string" ? b.thinkingSignature : "";
	if (sig.length > 0) return sig;
	const text = typeof b?.thinking === "string" ? b.thinking : "";
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	return `h${h.toString(36)}:${text.length}`;
}

/** Snapshot persisted at each compression event (v2: running-summary design). */
interface SnapshotRecord {
	v: 2;
	ts: number;
	modelKey: string;
	reason: string;
	idleMs: number;
	cumulativeTokens: number;
	deltaTokens: number;
	toolCallIds: string[];
	/** v2 wrote [msgIdx, blockIdx] pairs; v3 writes stable block identities. */
	thinking: string[];
}

interface Period {
	T: number; // cumulative tokens trimmed during this period
	requests: number;
	saved: number;
}

interface WalkResult {
	savings: number; // running $ saved over the whole branch
	compressions: number;
	requestsAfterFirst: number;
	/** Prompt tokens never sent: Σ cumulativeTokens over every trimmed request. */
	savedTokens: number;
	/** $ and tokens saved on the most recent billed request, and what it cost/sent. */
	lastRequestSaved: number;
	lastRequestTokens: number;
	lastRequestCost: number;
	lastRequestPrompt: number;
	/** $ actually billed across the whole branch. */
	totalCost: number;
	/** Prompt tokens actually sent across the whole branch. */
	totalPromptTokens: number;
	spec: TrimSpec | null; // latest frozen trim
	periods: Period[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTextTokens(s: string): number {
	return Math.ceil(s.length / 4);
}

/** Approximate text chars in user/toolResult/custom message content (images ≈ 1500 tokens). */
function contentTextChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as ContentBlock;
		if (b.type === "text" && typeof b.text === "string") chars += b.text.length;
		else if (b.type === "image") chars += 6000;
	}
	return chars;
}

/** Conservative chars/4 token estimate for one message (mirrors pi's compaction heuristic). */
function estimateMessageTokens(m: LlmMessage): number {
	switch (m.role) {
		case "user":
		case "toolResult":
		case "custom":
			return Math.ceil(contentTextChars(m.content) / 4);
		case "assistant": {
			let chars = 0;
			if (Array.isArray(m.content)) {
				for (const block of m.content as ContentBlock[]) {
					if (!block || typeof block !== "object") continue;
					if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
					else if (block.type === "thinking" && typeof block.thinking === "string") chars += block.thinking.length;
					else if (block.type === "toolCall") {
						chars += (typeof block.name === "string" ? block.name.length : 0) + JSON.stringify(block.arguments ?? {}).length;
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case "bashExecution":
			return estimateTextTokens(`${m.command ?? ""}\n${m.output ?? ""}`);
		case "compactionSummary":
		case "branchSummary":
			return estimateTextTokens(String(m.summary ?? ""));
		default:
			return 0;
	}
}

/** Total prompt tokens reported by the provider (input + cache read/write). */
function promptTokensOf(usage: any): number {
	return (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
}

/** The rate tokens were actually paid at on this request (incl. any cache-write premium). */
function paidRate(usage: any): number {
	const paidTokens = (usage?.input ?? 0) + (usage?.cacheWrite ?? 0);
	const paidCost = (usage?.cost?.input ?? 0) + (usage?.cost?.cacheWrite ?? 0);
	return paidTokens > 0 ? paidCost / paidTokens : 0;
}

/** Unit price of cached prompt tokens on this request, or null if nothing was read from cache. */
function cacheReadRate(usage: any): number | null {
	const tokens = usage?.cacheRead ?? 0;
	if (tokens <= 0) return null;
	return (usage?.cost?.cacheRead ?? 0) / tokens;
}

/**
 * Price of the tokens we removed, for THIS request.
 *
 * On a genuine cache miss the whole prompt is re-billed at input price, so
 * the trimmed tokens really would have cost `paidRate`. On a warm request the
 * untrimmed prefix would have been served from cache, so the honest
 * counterfactual is the cache-read price (~10% of input on Anthropic). If the
 * provider reports cached tokens as free, the savings are genuinely zero.
 */
function trimRate(usage: any, definiteMiss: boolean): number {
	if (definiteMiss || rateMode() === "paid") return paidRate(usage);
	const cached = cacheReadRate(usage);
	return cached === null ? paidRate(usage) : cached;
}

/** Best-effort wall-clock time of a session entry (ms since epoch). */
function entryTime(e: any): number {
	for (const raw of [e?.message?.timestamp, e?.timestamp]) {
		if (typeof raw === "number" && Number.isFinite(raw)) return raw;
		if (typeof raw === "string") {
			const parsed = Date.parse(raw);
			if (!Number.isNaN(parsed)) return parsed;
		}
	}
	return Date.now();
}

/** Cache TTL that applied to a request, given whether the previous one wrote extended cache. */
function ttlFor(extendedCache: boolean): number {
	return TTL_MS > 0 ? TTL_MS : extendedCache ? EXTENDED_TTL_MS : DEFAULT_TTL_MS;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${Math.round(n)}`;
}

function fmtMoney(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "$0.00";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

function fmtDurationMs(ms: number): string {
	if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

function isMarkerMessage(m: LlmMessage): boolean {
	return Array.isArray(m.content) && m.content.length === 1 && (m.content[0] as ContentBlock)?.type === "text" && (m.content[0] as ContentBlock)?.text === TOOL_OUTPUT_MARKER;
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/**
 * Apply the keep-window to the current context: trim everything older than
 * the latest KEEP_TOOL_RESULTS tool outputs and KEEP_THINKING_BLOCKS thinking
 * blocks. Returns null when there is nothing worth trimming. Also returns the
 * frozen references (toolCallIds + thinking positions) of what was trimmed.
 */
function compressMessages(
	messages: LlmMessage[],
): { messages: LlmMessage[]; removedTokens: number; removedThinkingBlocks: number; removedToolOutputs: number; toolCallIds: string[]; thinking: string[] } | null {
	let removedTokens = 0;
	let removedThinkingBlocks = 0;
	let removedToolOutputs = 0;
	let changed = false;
	const toolCallIds: string[] = [];
	const thinking: string[] = [];

	// Anthropic requires the *latest* assistant message to be unmodified —
	// never remove thinking blocks from it.
	let latestAssistantIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			latestAssistantIdx = i;
			break;
		}
	}

	// --- pass 1: thinking blocks — keep the latest KEEP_THINKING_BLOCKS, drop older ones ---
	const toRemoveBlocks = new Map<number, Set<number>>(); // msgIdx -> blockIdx to drop
	{
		let keep = KEEP_THINKING_BLOCKS;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
			const content = m.content as ContentBlock[];
			for (let j = content.length - 1; j >= 0; j--) {
				if (content[j]?.type !== "thinking") continue;
				if (keep > 0) {
					keep--;
					continue;
				}
				if (i === latestAssistantIdx) continue;
				const set = toRemoveBlocks.get(i) ?? new Set<number>();
				set.add(j);
				toRemoveBlocks.set(i, set);
				const b = content[j];
				removedTokens += estimateTextTokens(typeof b.thinking === "string" ? b.thinking : "");
				removedThinkingBlocks++;
				changed = true;
				thinking.push(thinkingKey(b));
			}
		}
	}

	let msgs = messages;
	if (toRemoveBlocks.size > 0) {
		msgs = [];
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			const drop = toRemoveBlocks.get(i);
			if (m?.role === "assistant" && Array.isArray(m.content) && drop?.size) {
				const content = (m.content as ContentBlock[]).filter((_, j) => !drop.has(j));
				if (content.length === 0) continue; // thinking-only message: drop it entirely
				msgs.push({ ...m, content });
				continue;
			}
			msgs.push(m);
		}
	}

	// --- pass 2: tool outputs — keep the latest KEEP_TOOL_RESULTS, replace older with a marker ---
	{
		const toolResultIdxs: number[] = [];
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i]?.role === "toolResult") toolResultIdxs.push(i);
		}
		for (const idx of toolResultIdxs.slice(KEEP_TOOL_RESULTS)) {
			const m = msgs[idx];
			const contentTokens = Math.ceil(contentTextChars(m.content) / 4);
			if (contentTokens < TRIM_MIN_TOKENS) continue; // too small to bother
			removedTokens += contentTokens;
			removedToolOutputs++;
			changed = true;
			if (typeof m.toolCallId === "string") toolCallIds.push(m.toolCallId);
			msgs[idx] = { ...m, content: [{ type: "text", text: TOOL_OUTPUT_MARKER }] };
		}
	}

	if (!changed) return null;
	return { messages: msgs, removedTokens, removedThinkingBlocks, removedToolOutputs, toolCallIds, thinking };
}

/**
 * Estimate what a fresh compression would remove from this context, without
 * building any new arrays. Mirrors compressMessages' accounting exactly so
 * /compress can quote a number before committing to anything.
 */
function projectTrim(messages: LlmMessage[]): { tokens: number; toolOutputs: number; thinkingBlocks: number } {
	let tokens = 0;
	let toolOutputs = 0;
	let thinkingBlocks = 0;

	let latestAssistantIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			latestAssistantIdx = i;
			break;
		}
	}

	let keepThinking = KEEP_THINKING_BLOCKS;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		const content = m.content as ContentBlock[];
		for (let j = content.length - 1; j >= 0; j--) {
			if (content[j]?.type !== "thinking") continue;
			if (keepThinking > 0) {
				keepThinking--;
				continue;
			}
			if (i === latestAssistantIdx) continue;
			const b = content[j];
			tokens += estimateTextTokens(typeof b.thinking === "string" ? b.thinking : "");
			thinkingBlocks++;
		}
	}

	let seenToolResults = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "toolResult") continue;
		seenToolResults++;
		if (seenToolResults <= KEEP_TOOL_RESULTS) continue;
		if (isMarkerMessage(m)) continue; // already trimmed on the way in
		const contentTokens = Math.ceil(contentTextChars(m.content) / 4);
		if (contentTokens < TRIM_MIN_TOKENS) continue;
		tokens += contentTokens;
		toolOutputs++;
	}

	return { tokens, toolOutputs, thinkingBlocks };
}

/**
 * Apply a frozen TrimSpec to the current context. Returns the modified list,
 * or null when nothing needed trimming (all references already absent).
 */
/**
 * Apply a frozen spec by IDENTITY.
 *
 * Returns `matched`: how many of the spec's targets were actually found in
 * this context. The caller needs that to tell two very different situations
 * apart, which the old boolean `changed` conflated:
 *
 *   matched > 0, changed false — already in the trimmed shape. Re-sending it
 *     unchanged is correct and keeps the prefix stable (idempotent).
 *   matched === 0 — the spec addresses turns this context no longer contains
 *     (a compaction summarised them away). Falling through to the untrimmed
 *     context here is what silently rewrote the prefix mid-session.
 */
function applySpec(
	messages: LlmMessage[],
	spec: TrimSpec,
): { messages: LlmMessage[]; matched: number; changed: boolean } {
	let changed = false;
	let matched = 0;
	const out: LlmMessage[] = [];
	for (const m of messages) {
		if (m?.role === "toolResult" && typeof m.toolCallId === "string" && spec.toolCallIds.has(m.toolCallId)) {
			matched++;
			if (!isMarkerMessage(m)) {
				out.push({ ...m, content: [{ type: "text", text: TOOL_OUTPUT_MARKER }] });
				changed = true;
			} else {
				out.push(m);
			}
			continue;
		}
		if (m?.role === "assistant" && Array.isArray(m.content) && spec.thinking.size > 0) {
			const blocks = m.content as ContentBlock[];
			const keep = blocks.filter((b: any) => {
				if (b?.type !== "thinking") return true;
				if (!spec.thinking.has(thinkingKey(b))) return true;
				matched++;
				return false;
			});
			if (keep.length !== blocks.length) {
				changed = true;
				if (keep.length === 0) continue; // thinking-only message: drop entirely
				out.push({ ...m, content: keep });
				continue;
			}
		}
		out.push(m);
	}
	return { messages: out, matched, changed };
}

// ---------------------------------------------------------------------------
// Branch walk: recompute the running savings summary from session entries
// ---------------------------------------------------------------------------

/**
 * Walk the session branch in order. Snapshot entries (appended at each
 * compression, right before the compressed request's assistant message) set
 * the cumulative trim level; each assistant message afterwards accrues
 * cumulativeTokens × trimRate(that request). Periods between compressions are
 * therefore counted at their own level: X×T1 + Y×T2 + …
 *
 * A request counts as a definite cache miss (full input pricing) when either
 * a non-manual compression snapshot sits immediately before it, or the gap
 * since the previous billed request exceeded the cache TTL.
 */
function walkBranch(branch: any[]): WalkResult {
	let spec: TrimSpec | null = null;
	let savings = 0;
	let compressions = 0;
	let savedTokens = 0;
	let totalCost = 0;
	let totalPromptTokens = 0;
	let lastRequestSaved = 0;
	let lastRequestTokens = 0;
	let lastRequestCost = 0;
	let lastRequestPrompt = 0;
	const periods: Period[] = [];
	let cur: Period = { T: 0, requests: 0, saved: 0 };
	let nextIsMiss = false; // set by a snapshot, consumed by the next billed request
	let prevRequestAt: number | null = null;
	let prevExtendedCache = false;

	for (const e of branch) {
		if (e.type === "custom" && e.customType === ENTRY_TYPE && e.data?.v === 2) {
			if (cur.requests > 0 || cur.T > 0) periods.push(cur);
			compressions++;
			const d = e.data;
			spec = {
				toolCallIds: new Set(Array.isArray(d.toolCallIds) ? d.toolCallIds : []),
				// v2 snapshots stored [msgIdx, blockIdx] pairs. Those positions cannot
				// be resolved against a context that has since changed shape, and
				// guessing would edit the wrong message, so only string identities
				// (v3) are restored. A stale v2 snapshot simply contributes no
				// thinking trim, which is the safe direction.
				thinking: new Set(
					(Array.isArray(d.thinking) ? d.thinking : []).filter((x: unknown): x is string => typeof x === "string"),
				),
				cumulativeTokens: typeof d.cumulativeTokens === "number" ? d.cumulativeTokens : 0,
			};
			// A manual /compress may well have hit a warm cache; every other
			// trigger is a guaranteed miss by construction.
			nextIsMiss = d.reason !== MANUAL_REASON;
			cur = { T: spec.cumulativeTokens, requests: 0, saved: 0 };
		} else if (e.type === "message" && e.message?.role === "assistant") {
			const usage = e.message.usage;
			const prompt = promptTokensOf(usage);
			if (prompt <= 0) continue; // aborted/errored: never billed
			totalCost += usage?.cost?.total ?? 0;
			totalPromptTokens += prompt;
			// Reset per request: only the final one survives the loop.
			lastRequestSaved = 0;
			lastRequestTokens = 0;
			lastRequestCost = usage?.cost?.total ?? 0;
			lastRequestPrompt = prompt;
			const at = entryTime(e);
			const gapMiss = prevRequestAt !== null && at - prevRequestAt > ttlFor(prevExtendedCache);
			const miss = nextIsMiss || gapMiss;
			nextIsMiss = false;
			prevRequestAt = at;
			prevExtendedCache = (usage?.cacheWrite1h ?? 0) > 0;
			if (spec) {
				const s = spec.cumulativeTokens * trimRate(usage, miss);
				savings += s;
				cur.saved += s;
				cur.requests++;
				savedTokens += spec.cumulativeTokens;
				lastRequestSaved = s;
				lastRequestTokens = spec.cumulativeTokens;
			}
		}
	}
	if (cur.requests > 0 || cur.T > 0) periods.push(cur);

	const requestsAfterFirst = periods.reduce((s, p) => s + p.requests, 0);
	return {
		savings,
		compressions,
		requestsAfterFirst,
		savedTokens,
		totalCost,
		totalPromptTokens,
		lastRequestSaved,
		lastRequestTokens,
		lastRequestCost,
		lastRequestPrompt,
		spec,
		periods,
	};
	// NOTE: periods with 0 requests (e.g. a compression whose request was
	// aborted before billing) contribute nothing and are filtered when printed.
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// State tracking the last LLM request, used for cache-miss detection.
	let lastRequestAt: number | null = null;
	let lastModelKey: string | null = null;
	let lastUsedExtendedCache = false;
	let lastCompactionSummaryCount = 0;
	let contextRebuiltSinceLastRequest = false;
	// The frozen trim + running savings summary.
	let spec: TrimSpec | null = null;
		let forceNextCompression = false; // set by /compress — applies to the next LLM call no matter what
	let pending: { reason: string } | null = null; // compression event awaiting its response (for the warning)
	let lastRequestWasMiss = false; // did the request in flight hit a cold cache?
	// Toggle state for /compress.
	let enabled = true; // false = send the full context, keeping the frozen spec aside
	// Trim level (in tokens) actually applied to the last request we sent. This,
	// not the toggle state, decides whether flipping the toggle breaks the cache:
	// on→off→on with no request in between returns the exact same prefix.
	let lastSentLevel: number | null = null;
	let lastProjection = { tokens: 0, toolOutputs: 0, thinkingBlocks: 0 };
	let lastUsage: any = null;

	// --- prefix-stability bookkeeping (fix 2) + diagnostics (fix 5) ---------
	/** Per-message fingerprints of the last context we actually sent. */
	let lastSentPrefix: string[] = [];
	/** Requests since the last compression, used to rate-limit trim growth. */
	let requestsSinceCompression = Number.POSITIVE_INFINITY;
	let prefixBreaks = 0;
	const diagnostics: string[] = [];

	/**
	 * Record something that must not be swallowed. The original code wrapped the
	 * snapshot write in a bare `catch {}`; after a session replacement
	 * pi.appendEntry throws "stale ctx", so every compression after a /reload
	 * left no trace at all — which is precisely why this class of bug survived
	 * for days of sessions without showing up in any log.
	 */
	function diag(msg: string): void {
		const line = `[context-savings] ${new Date().toISOString()} ${msg}`;
		diagnostics.push(line);
		if (diagnostics.length > 200) diagnostics.shift();
		try {
			process.stderr.write(`${line}\n`);
		} catch {
			/* stderr closed: the in-memory ring above still holds it for /savings */
		}
	}

	/** Cheap per-message fingerprint; only used to compare consecutive requests. */
	function fingerprint(messages: LlmMessage[]): string[] {
		return messages.map((m) => {
			const s = `${m?.role}:${JSON.stringify(m?.content ?? "")}`;
			let h = 5381;
			for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
			return `${h.toString(36)}:${s.length}`;
		});
	}

	/**
	 * The one invariant this extension must never break: consecutive requests may
	 * differ only by appended messages. Anything else rewrites the provider's
	 * cached prefix from the point of difference. Nothing checked this before,
	 * which is how a per-turn history edit went unnoticed.
	 *
	 * `expectReset` is true when the cache is already dead (compaction, model
	 * switch, long idle), where a changed prefix costs nothing.
	 */
	function verifyPrefix(outgoing: LlmMessage[], expectReset: boolean): void {
		const next = fingerprint(outgoing);
		if (!expectReset && lastSentPrefix.length > 0) {
			const n = Math.min(lastSentPrefix.length, next.length);
			let diverge = -1;
			for (let i = 0; i < n; i++) {
				if (lastSentPrefix[i] !== next[i]) {
					diverge = i;
					break;
				}
			}
			if (diverge >= 0) {
				prefixBreaks++;
				diag(
					`PREFIX BROKEN at message ${diverge}/${lastSentPrefix.length} on a warm cache — ` +
						`everything from there is re-billed at write price.`,
				);
				// Deliberately does NOT touch `spec`. A detector must not change
				// behaviour: dropping the trim here would throw away a correct,
				// sticky spec on any false positive (a genuinely new conversation,
				// a branch switch) and send the whole context untrimmed — the exact
				// failure it is meant to report. Oscillation is prevented upstream,
				// by the growth gate and by resetting only when the spec matches
				// nothing at all.
			}
		}
		lastSentPrefix = next;
	}

	/**
	 * Re-derive all tracking state from the current session branch.
	 * Used on session start (startup/resume/fork) and after /tree navigation.
	 */
	function reseed(ctx: any) {
		const branch: any[] = ctx.sessionManager.getBranch() ?? [];
		let lastAt: number | null = null;
		let key: string | null = null;
		let ext = false;
		let compactionsAfterLastRequest = false;
		let compactionTotal = 0;
		let lastBilled: any = null;
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type === "compaction") {
				compactionTotal++;
				if (lastAt === null) compactionsAfterLastRequest = true;
				continue;
			}
			if (e.type === "message" && e.message?.role === "assistant") {
				if (lastAt === null) {
					// Must tolerate numeric epochs AND ISO strings: getting this wrong
					// silently dates a resumed session to "now" and suppresses the
					// idle-gap trigger entirely.
					lastAt = entryTime(e);
					key = `${e.message.provider ?? "?"}/${e.message.model ?? "?"}`;
					ext = (e.message.usage?.cacheWrite1h ?? 0) > 0;
					if (promptTokensOf(e.message.usage) > 0) lastBilled = e.message.usage;
				}
				continue;
			}
		}
		lastRequestAt = lastAt;
		lastModelKey = key;
		lastUsedExtendedCache = ext;
		lastCompactionSummaryCount = compactionTotal;
		contextRebuiltSinceLastRequest = compactionsAfterLastRequest;
		// Restore the frozen trim from the branch (the branch is authoritative;
		// dollar totals are always recomputed by walkBranch on demand).
		const walk = walkBranch(branch);
		spec = walk.spec;
		pending = null;
		lastRequestWasMiss = false;
		// A queued manual compression belongs to the branch it was requested on;
		// after a switch it would fire against an unrelated context. The `enabled`
		// toggle is a user preference and deliberately survives.
		forceNextCompression = false;
		// The provider's cache does not care that we restarted: if the branch
		// already has billed requests after a compression, the prefix sitting in
		// that cache is the trimmed one. Saying "no idea" here made every toggle
		// right after startup/resume claim "cache unaffected" when flipping it
		// would in fact rewrite the whole prefix.
		lastSentLevel = spec !== null && walk.requestsAfterFirst > 0 ? spec.cumulativeTokens : 0;
		lastUsage = lastBilled;
		// The provider's cached prefix belongs to the previous process; we have not
		// sent anything yet, so there is nothing to compare the next request
		// against. Claiming otherwise would make verifyPrefix report a phantom
		// break on the first request after every resume.
		lastSentPrefix = [];
		// Growth is rate-limited per run; a fresh run starts eligible.
		requestsSinceCompression = Number.POSITIVE_INFINITY;
	}

	// -------------------------------------------------------------------------
	// Core: compress outgoing context
	// -------------------------------------------------------------------------

	pi.on("context", (event, ctx) => {
		const now = Date.now();
		const messages = event.messages as LlmMessage[];
		const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
		const compactionCount = messages.reduce((n, m) => n + (m?.role === "compactionSummary" ? 1 : 0), 0);

		const idleMs = lastRequestAt !== null ? now - lastRequestAt : null;
		const ttl = ttlFor(lastUsedExtendedCache);
		const rebuilt = contextRebuiltSinceLastRequest || compactionCount > lastCompactionSummaryCount;

		lastProjection = projectTrim(messages);

		let manual = false;
		let reason: string | null = null;
		if (forceNextCompression && enabled) {
			// /compress: explicit user intent — compress the next call no matter
			// what, and bypass the size guard. The cache miss is expected.
			manual = true;
			reason = MANUAL_REASON;
			forceNextCompression = false;
		} else if (idleMs !== null && idleMs > ttl) reason = `cache miss after ${fmtDurationMs(idleMs)} idle`;
		else if (lastModelKey !== null && modelKey !== null && modelKey !== lastModelKey) reason = "cache miss after model switch";
		else if (rebuilt) reason = "cache miss after context rebuild (compaction)";

		// Everything except a manual /compress implies the prompt cache is cold
		// for this request, which decides how trimmed tokens are priced.
		lastRequestWasMiss = reason !== null && !manual;

		// Update trackers for the *next* decision, whatever we do this time.
		lastRequestAt = now;
		lastModelKey = modelKey;
		lastCompactionSummaryCount = compactionCount;
		contextRebuiltSinceLastRequest = false;

		// A rebuild (compaction) replaces whole runs of messages. The spec is now
		// identity-keyed so it survives reordering, but the turns it references may
		// genuinely be gone; a fresh compression below recomputes it, and a rebuild
		// is a definite cache miss anyway.
		if (rebuilt) spec = null;

		// The cache is already dead on any of these, so a changed prefix is free.
		const cacheAlreadyCold = reason !== null;
		requestsSinceCompression++;

		if (!enabled) {
			// Toggled off: send the untouched context, but keep `spec` so toggling
			// back on restores the identical prefix instead of recompressing.
			lastSentLevel = 0;
			return;
		}

		const totalTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
		const shouldCompress = manual || (reason !== null && !DISABLED && !(MIN_CONTEXT_TOKENS > 0 && totalTokens < MIN_CONTEXT_TOKENS));

		if (shouldCompress) {
			const result = compressMessages(messages);
			if (result) {
				const prevCum = spec?.cumulativeTokens ?? 0;
				const delta = result.removedTokens - prevCum;

				// Recomputing the keep-window is a SUPERSET of the frozen trim, and
				// the extra it catches is always older history that has already been
				// sent untrimmed. Committing it edits the live cached prefix. That is
				// free when the cache is already cold, and ruinous when it is warm:
				// a fixed keep-window slides once per turn, so an unguarded grow is
				// one full-context rewrite per turn, forever.
				const grows = spec !== null && delta > 0;
				const worthIt = delta >= Math.max(TRIM_MIN_TOKENS * 4, totalTokens * MIN_GROWTH_FRACTION);
				const spacedOut = requestsSinceCompression >= MIN_REQUESTS_BETWEEN_GROWTH;
				const allowed = manual || rebuilt || !grows || (cacheAlreadyCold && worthIt && spacedOut);

				if (!allowed) {
					diag(
						`skipped trim growth (+${delta} tok of ${totalTokens}): ` +
							`${requestsSinceCompression} requests since last compression, ` +
							`warm=${!cacheAlreadyCold} — rewriting the prefix would cost more than it saves.`,
					);
				} else {
					spec = {
						toolCallIds: new Set(result.toolCallIds),
						thinking: new Set(result.thinking),
						cumulativeTokens: result.removedTokens,
					};
					const snapshot: SnapshotRecord = {
						v: 2,
						ts: now,
						modelKey: modelKey ?? "unknown",
						reason: reason ?? "unknown",
						idleMs: idleMs ?? 0,
						cumulativeTokens: spec.cumulativeTokens,
						deltaTokens: delta,
						toolCallIds: result.toolCallIds,
						thinking: result.thinking,
					};
					try {
						pi.appendEntry(ENTRY_TYPE, snapshot);
					} catch (err) {
						// Must never be silent: pi.appendEntry throws "stale ctx" after a
						// session replacement, so swallowing this hid every compression
						// that happened after a /reload. State still lives in memory; the
						// branch walk just won't see it after a restart.
						diag(`snapshot NOT persisted (${String(err)}); /savings will under-report after a restart.`);
					}
					requestsSinceCompression = 0;
					pending = { reason: reason ?? "unknown" };
					lastSentLevel = spec.cumulativeTokens;
					verifyPrefix(result.messages, true); // compression always resets the prefix
					return { messages: result.messages };
				}
			}
		}

		// Sticky: apply the frozen trim to this request too.
		if (spec && (spec.toolCallIds.size > 0 || spec.thinking.size > 0)) {
			const applied = applySpec(messages, spec);
			if (applied.matched > 0) {
				// Found its targets. Re-send the same shape even when nothing needed
				// changing this time: identical output is exactly what keeps the
				// prefix stable.
				lastSentLevel = spec.cumulativeTokens;
				verifyPrefix(applied.messages, cacheAlreadyCold);
				return { messages: applied.messages };
			}
			// Nothing the spec references exists any more. Silently sending the
			// untrimmed context here is what used to flip the prefix mid-session;
			// drop the spec deliberately so the reset is recorded and happens once.
			diag(`trim spec no longer matches this context (0 targets found) — resetting baseline.`);
			spec = null;
		}
		lastSentLevel = 0;
		verifyPrefix(messages, cacheAlreadyCold);
		return;
	});

	// -------------------------------------------------------------------------
	// Accounting: running savings summary
	// -------------------------------------------------------------------------

	pi.on("message_end", (event, ctx) => {
		const message = event.message as any;
		if (message?.role !== "assistant") return;
		const usage = message.usage;
		const promptTokens = promptTokensOf(usage);
		if (promptTokens <= 0) return; // aborted/errored without usage

		// Track whether the latest request wrote extended (1h) cache, so the
		// TTL for the next idle-gap decision matches what the provider kept.
		lastUsedExtendedCache = (usage.cacheWrite1h ?? 0) > 0;
		lastUsage = usage;
		// Cache lifetime runs from when the response completed, not from when the
		// request started — otherwise a long streaming turn or a slow tool loop
		// looks like idle time and triggers a pointless compression.
		lastRequestAt = Date.now();

		if (!pending) return;
		const cumulative = spec?.cumulativeTokens ?? 0;
		const savedThis = cumulative * trimRate(usage, lastRequestWasMiss);
		const pct = cumulative > 0 ? (100 * cumulative) / (promptTokens + cumulative) : 0;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Warning: tool/thinking compression enabled; trimmed ${fmtTokens(cumulative)} tokens (~${fmtMoney(savedThis)} / ${pct.toFixed(1)}%) from this request.`,
				"warning",
			);
		}
		pending = null;
	});

	// -------------------------------------------------------------------------
	// Session lifecycle
	// -------------------------------------------------------------------------

	pi.on("session_start", (event, ctx) => {
		reseed(ctx);
		if (ctx.hasUI && event.reason === "startup") {
			if (DISABLED) {
				ctx.ui.notify("context-savings: automatic compression disabled (CONTEXT_SAVINGS_DISABLED=1). /savings, /usage and manual /compress still work.", "info");
			} else {
				const ttl = TTL_MS > 0 ? fmtDurationMs(TTL_MS) : "5m (1h after extended-cache writes)";
				ctx.ui.notify(
					`context-savings: enabled — compresses on cache-miss requests (idle > ${ttl}, model switch, or post-compaction) and stays compressed afterwards; keeps latest ${KEEP_TOOL_RESULTS} tool outputs and ${KEEP_THINKING_BLOCKS} thinking blocks. See /savings and /usage.`,
					"info",
				);
			}
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		reseed(ctx);
	});

	// -------------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------------

	pi.registerCommand("savings", {
		description: "Show tokens & cost saved by context-savings compression ('detail' for per-period, 'diag' for cache diagnostics)",
		handler: async (args, ctx) => {
			const walk = walkBranch(ctx.sessionManager.getBranch() ?? []);
			if (args?.trim() === "diag") {
				ctx.ui.notify(
					diagnostics.length === 0
						? "context-savings: no diagnostics recorded (no skipped growths, spec resets or prefix breaks)."
						: `${prefixBreaks} warm-cache prefix break(s) this run\n${diagnostics.slice(-20).join("\n")}`,
					prefixBreaks > 0 ? "warning" : "info",
				);
				return;
			}
			if (walk.compressions === 0) {
				ctx.ui.notify(`No context compressions in this session yet — /compress to start.`, "info");
				return;
			}
			// Percentages are measured against what this session actually cost/sent,
			// so "1.9% of $4.27" reads as "this much on top of the real bill".
			const costPct = walk.totalCost > 0 ? ` (${((100 * walk.savings) / walk.totalCost).toFixed(1)}% of ${fmtMoney(walk.totalCost)})` : "";
			const tokenPct = walk.totalPromptTokens > 0 ? ` (${((100 * walk.savedTokens) / walk.totalPromptTokens).toFixed(1)}% of ${fmtTokens(walk.totalPromptTokens)})` : "";
			// Same saved/actual convention as the totals, but scoped to that one
			// request: its own billed cost and the prompt tokens it really sent.
			const lastCostPct = walk.lastRequestCost > 0 ? ` (${((100 * walk.lastRequestSaved) / walk.lastRequestCost).toFixed(1)}% of ${fmtMoney(walk.lastRequestCost)})` : "";
			const lastTokenPct =
				walk.lastRequestPrompt > 0 ? ` (${((100 * walk.lastRequestTokens) / walk.lastRequestPrompt).toFixed(1)}% of ${fmtTokens(walk.lastRequestPrompt)})` : "";
			const lastLines =
				walk.lastRequestTokens > 0
					? [
							`  last request:`,
							`    cost: ~${fmtMoney(walk.lastRequestSaved)} saved${lastCostPct}`,
							`    tokens: ${fmtTokens(walk.lastRequestTokens)} saved${lastTokenPct}`,
						]
					: [`  last request: nothing trimmed`];
			const lines = [
				`Context savings (current branch):`,
				// Make it unmistakable whether these are live savings or a historical
				// total from a branch that is no longer being trimmed.
				`  ${walk.compressions} compression${walk.compressions === 1 ? "" : "s"}; ` +
					(enabled && spec !== null
						? `currently trimming ${fmtTokens(walk.spec?.cumulativeTokens ?? 0)} tokens/request`
						: `not trimming now — /compress to resume`),
				...lastLines,
				`  total:`,
				`    cost: ~${fmtMoney(walk.savings)} saved${costPct}`,
				`    tokens: ${fmtTokens(walk.savedTokens)} saved${tokenPct}`,
			];
			if (/\b(detail|verbose|-v)\b/.test(args ?? "")) {
				const shown = walk.periods.filter((p) => p.requests > 0);
				if (shown.length > 0) {
					lines.push(`  periods: ${shown.map((p) => `${p.requests} req × ${fmtTokens(p.T)} (≈${fmtMoney(p.saved)})`).join(" + ")}`);
				}
				lines.push(
					rateMode() === "counterfactual"
						? `  pricing: counterfactual (cache-read rate on warm requests, input rate on misses)`
						: `  pricing: paid (input/cache-write rate on every request — optimistic on warm requests)`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("compress", {
		description: "Toggle context compression on/off, with the expected saving on the next request",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			const wasEnabled = enabled;
			const forceAlreadyQueued = forceNextCompression;
			if (arg === "on") enabled = true;
			else if (arg === "off") enabled = false;
			// Nothing trimmed yet: a bare /compress means "compress now" rather than
			// "turn off something you have never seen". But once that request is
			// queued, a second bare /compress must be able to cancel it again.
			else if (enabled && spec === null && !forceAlreadyQueued) enabled = true;
			else enabled = !enabled;

			// Asking for compression while it is already on means "compress again",
			// which re-runs the keep-window and picks up newly aged-out output.
			// Switching it back on after an off, by contrast, restores the frozen
			// prefix verbatim so the prompt cache can survive.
			forceNextCompression = enabled && (wasEnabled || spec === null);

			// Tokens the next request will drop: a refresh re-runs the window over
			// the last context we saw, otherwise it is the frozen level.
			const nextLevel = !enabled ? 0 : forceNextCompression ? lastProjection.tokens || (spec?.cumulativeTokens ?? 0) : (spec?.cumulativeTokens ?? 0);

			// There is nothing to break if the cache has already expired on its own.
			const idleMs = lastRequestAt !== null ? Date.now() - lastRequestAt : null;
			const cacheAlreadyCold = idleMs === null || idleMs > ttlFor(lastUsedExtendedCache);
			// Otherwise the prompt cache survives only if the next request's prefix
			// matches the one we last sent — so on→off→on (or off→on→off) with no
			// request in between is free, while a genuine change re-bills the prefix.
			const breaksCache = !cacheAlreadyCold && lastSentLevel !== null && nextLevel !== lastSentLevel;

			const paid = paidRate(lastUsage);
			const cached = cacheReadRate(lastUsage) ?? paid;
			const perRequest = nextLevel * (breaksCache ? paid : cached);

			const head = enabled
				? `context-savings: ON — trims ${fmtTokens(nextLevel)} tokens/request` + (perRequest > 0 ? ` (~${fmtMoney(perRequest)} each)` : "")
				: `context-savings: OFF — full context restored`;

			const lines = [head];
			if (!breaksCache) {
				lines[0] += cacheAlreadyCold ? "; cache already expired" : "; cache unaffected";
			} else {
				// Changing the prefix re-bills whatever was being served from cache.
				const cachedTokens = lastUsage?.cacheRead ?? 0;
				const extra = cachedTokens * Math.max(0, paid - cached);
				const recurring = nextLevel * cached; // per-request saving once warm again
				const payback = extra > 0 && recurring > 0 ? Math.ceil(extra / recurring) : 0;
				lines.push(
					extra > 0
						? `  breaks cache: ~${fmtMoney(extra)} extra on that request` + (payback > 0 ? `, pays back after ~${payback} requests` : "")
						: `  breaks cache: expect a full re-read of the prompt on that request`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("usage", {
		description: "Show session token usage & cost (totals, per-model breakdown, cache efficiency)",
		handler: async (_args, ctx) => {
			const branch: any[] = ctx.sessionManager.getBranch() ?? [];

			const empty = (): UsageAgg => ({
				requests: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: 0,
				costInput: 0,
				costOutput: 0,
				costCacheRead: 0,
				costCacheWrite: 0,
			});
			const addUsage = (agg: UsageAgg, usage: any) => {
				if (!usage) return;
				agg.requests++;
				const uInput = usage.input ?? 0;
				const uOutput = usage.output ?? 0;
				const uCacheRead = usage.cacheRead ?? 0;
				const uCacheWrite = usage.cacheWrite ?? 0;
				agg.input += uInput;
				agg.output += uOutput;
				agg.cacheRead += uCacheRead;
				agg.cacheWrite += uCacheWrite;
				agg.totalTokens += usage.totalTokens ?? uInput + uOutput + uCacheRead + uCacheWrite;
				const c = usage.cost ?? {};
				agg.cost += c.total ?? 0;
				agg.costInput += c.input ?? 0;
				agg.costOutput += c.output ?? 0;
				agg.costCacheRead += c.cacheRead ?? 0;
				agg.costCacheWrite += c.cacheWrite ?? 0;
			};

			const total = empty();
			const byModel = new Map<string, UsageAgg>();
			let summaryRequests = 0;
			let summaryCost = 0;
			for (const e of branch) {
				if (e.type === "message" && e.message?.role === "assistant") {
					addUsage(total, e.message.usage);
					const key = `${e.message.provider ?? "?"}/${e.message.model ?? "?"}`;
					const agg = byModel.get(key) ?? empty();
					addUsage(agg, e.message.usage);
					byModel.set(key, agg);
				} else if ((e.type === "compaction" || e.type === "branch_summary") && e.usage) {
					summaryRequests++;
					summaryCost += e.usage.cost?.total ?? 0;
				}
			}

			if (total.requests === 0) {
				ctx.ui.notify("No LLM requests in this session yet.", "info");
				return;
			}

			const promptTokens = total.input + total.cacheRead + total.cacheWrite;
			const cachePct = promptTokens > 0 ? (100 * total.cacheRead) / promptTokens : 0;

			const lines = [
				`Session usage (current branch, ${total.requests} requests):`,
				`  tokens: ${fmtTokens(total.totalTokens)} total — ${fmtTokens(total.input)} input, ${fmtTokens(total.output)} output, ${fmtTokens(total.cacheRead)} cache-read, ${fmtTokens(total.cacheWrite)} cache-write`,
				`  cost:   ${fmtMoney(total.cost)} total — ${fmtMoney(total.costInput)} input, ${fmtMoney(total.costOutput)} output, ${fmtMoney(total.costCacheRead)} cache-read, ${fmtMoney(total.costCacheWrite)} cache-write`,
				`  cache efficiency: ${cachePct.toFixed(1)}% of prompt tokens served from cache`,
			];
			if (byModel.size > 1) {
				lines.push("", "  by model:");
				for (const [key, agg] of [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
					lines.push(`    ${key}: ${agg.requests} req, ${fmtTokens(agg.totalTokens)} tokens, ${fmtMoney(agg.cost)}`);
				}
			}
			if (summaryRequests > 0) {
				lines.push(`  compaction/branch summaries: ${summaryRequests} req, ${fmtMoney(summaryCost)}`);
			}
			const walk = walkBranch(branch);
			if (walk.compressions > 0) {
				const pct = walk.totalCost > 0 ? ` (${((100 * walk.savings) / walk.totalCost).toFixed(1)}% of total)` : "";
				lines.push(`  context-savings: ~${fmtMoney(walk.savings)} saved${pct}, ${fmtTokens(walk.savedTokens)} tokens trimmed — see /savings`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

interface UsageAgg {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
}

// Integration test for the context-savings extension (no real pi session needed).
//
// Covers:
//   S1  first compression on idle: window applied, v2 snapshot persisted
//       (before the compressed request's assistant message), one-line warning
//   S2  sticky: the next WARM request is still trimmed; no new snapshot;
//       running savings accrue; /savings = X×T
//   S3  warm request BEFORE any compression: untouched
//   S4  model switch -> compression event
//   S5  post-compaction rebuild -> recompression
//   S6  min-context guard skips auto compression on tiny contexts
//   S7  /compress on warm: forces compression, flag consumed, sticky after
//   S8  /compress bypasses the min-context guard
//   S9  /savings + /usage walk math on a hand-built branch (X×T1 + Y×T2)
//   S10 growing context: frozen trim (new tool outputs NOT trimmed until the
//       next compression), then compression #2 raises the level; total is
//       X×T1 + Y×T2, never Y×(T1+T2+…)
//   S11 reseed (/tree, resume) restores spec + running savings from the branch
//   S12 counterfactual pricing: warm requests at cache-read rate, misses at
//       input rate; 0-request periods filtered from the display
//   S13 gap detector: a request >TTL after the previous one is priced as a miss
//       even without a snapshot of its own
//   S14 ISO-string timestamps on resume still produce a real idle gap

// Scenarios S1-S11 assert exact dollar strings, so pin the simple rate model.
process.env.CONTEXT_SAVINGS_RATE_MODE = "paid";

import contextSavings from "./index.ts";

const handlers = {};
const appended = [];
const registered = {};
const notifications = [];
let branchEntries = [];

const fakePi = {
	on(name, fn) { handlers[name] = fn; },
	appendEntry(type, data) {
		appended.push({ type, data });
		branchEntries.push({ type: "custom", customType: type, data, parentId: null, id: "entry-" + appended.length });
		return "entry-" + appended.length;
	},
	registerCommand(name, opts) { registered[name] = opts; },
	registerTool() {},
	registerShortcut() {},
	registerFlag() {},
};

contextSavings(fakePi);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let idc = 0;
const msg = (m) => ({ id: ++idc, timestamp: Date.now(), ...m });
const text = (t) => ({ type: "text", text: t });
const think = (t) => ({ type: "thinking", thinking: t, thinkingSignature: "sig" });
const toolCall = (name, args) => ({ type: "toolCall", id: "call_" + ++idc, name, arguments: args });
const toolResult = (toolCallId, out) => ({
	role: "toolResult", toolCallId, toolName: "bash",
	content: [text(out)], isError: false, timestamp: Date.now(),
});

const MARKER = "[tool output removed for context savings]";
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Usage with an exact paid rate (input+cacheWrite at `rate`, cache-read at 0.1×rate). */
function mkUsage(rate, promptTokens = 100000) {
	const input = 1000, cacheWrite = 9000;
	const cacheRead = promptTokens - input - cacheWrite;
	return {
		input, output: 500, cacheRead, cacheWrite, cacheWrite1h: 0,
		totalTokens: promptTokens + 500,
		cost: { input: input * rate, output: 0.01, cacheRead: cacheRead * rate * 0.1, cacheWrite: cacheWrite * rate, total: (input + cacheWrite) * rate + cacheRead * rate * 0.1 + 0.01 },
	};
}

/** Mirror of the extension's money formatter, for building expected strings. */
function money(n) {
	if (!Number.isFinite(n) || n <= 0) return "$0.00";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mirror of the extension's token formatter. */
function fmtTok(n) {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${Math.round(n)}`;
}

/** `rounds` tool rounds (1 thinking block each) + `extraThink` thinking-only assistants. */
function buildMessages(rounds = 30, extraThink = 10) {
	const msgs = [msg({ role: "user", content: [text("do the big task")] })];
	for (let i = 0; i < rounds; i++) {
		msgs.push(msg({
			role: "assistant",
			content: [think("thinking block number " + i + " ".repeat(600)), toolCall("bash", { command: "cmd" + i })],
		}));
		msgs.push(toolResult("call_" + i, "output number " + i + " ".repeat(1000)));
	}
	for (let i = rounds; i < rounds + extraThink; i++) {
		msgs.push(msg({ role: "assistant", content: [think("late thinking " + i + " ".repeat(600)), text("ok " + i)] }));
	}
	return msgs;
}

const results = [];
function check(name, cond, extra = "") {
	results.push({ name, pass: !!cond, extra });
	console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  [" + extra + "]" : ""));
}

const ctxBase = {
	ui: { notify: (m, t) => notifications.push({ m, t }) },
	confirm: async () => true, select: async () => undefined, input: async () => undefined,
	hasUI: true,
	mode: "tui",
	model: { provider: "anthropic", id: "claude-sonnet-4-5" },
	sessionManager: { getBranch: () => branchEntries },
};
const ctxOpenAI = { ...ctxBase, model: { provider: "openai", id: "gpt-5" } };

function reseed() { return handlers.session_tree({ type: "session_tree" }, ctxBase); }

/** Fresh state: one assistant request on the branch `msAgo` ms ago (zero usage). */
async function branchWithLastRequest(msAgo, model = { provider: "anthropic", model: "claude-sonnet-4-5" }) {
	branchEntries = [{
		type: "message",
		message: { role: "assistant", ...model, timestamp: Date.now() - msAgo, usage: zeroUsage },
	}];
	notifications.length = 0;
	await reseed();
}

/** One full LLM request: context handler -> assistant message lands on branch -> message_end. */
async function simulateRequest(msgs, ctx = ctxBase, usage = zeroUsage) {
	const r = await handlers.context({ type: "context", messages: msgs }, ctx);
	const assistantMsg = { role: "assistant", provider: ctx.model?.provider ?? "anthropic", model: ctx.model?.id ?? "claude-sonnet-4-5", timestamp: Date.now(), usage };
	branchEntries.push({ type: "message", message: assistantMsg });
	await handlers.message_end({ type: "message_end", message: assistantMsg }, ctx);
	return r;
}

const markersIn = (m) => m.filter((x) => x.role === "toolResult" && x.content?.[0]?.text === MARKER).length;
const markerCallIds = (m) => m.filter((x) => x.role === "toolResult" && x.content?.[0]?.text === MARKER).map((x) => x.toolCallId).sort();
const lastNote = () => notifications[notifications.length - 1];
const lastWarning = () => [...notifications].reverse().find((n) => n.t === "warning");

// startup notification (once)
await handlers.session_start({ type: "session_start", reason: "startup" }, ctxBase);

// ---------------------------------------------------------------------------
// S1: long idle -> first compression; v2 snapshot; one-line warning
// ---------------------------------------------------------------------------
await branchWithLastRequest(12 * 60_000);
const R1 = 3e-6; // paid rate for this scenario
const r1 = await simulateRequest(buildMessages(), ctxBase, mkUsage(R1));

check("S1: context handler returned modified messages", r1 && Array.isArray(r1.messages));
const m1 = r1?.messages ?? [];
check("S1: 10 old tool outputs trimmed (keep 20 of 30)", markersIn(m1) === 10, `got ${markersIn(m1)}`);
check("S1: 20 newest tool outputs intact", m1.filter((x) => x.role === "toolResult" && x.content?.[0]?.text?.startsWith("output number")).length === 20);
let thinkingLeft = 0;
for (const x of m1) if (x.role === "assistant") thinkingLeft += (x.content ?? []).filter((b) => b.type === "thinking").length;
check("S1: 30 thinking blocks kept (40 total)", thinkingLeft === 30, `got ${thinkingLeft}`);
const firstAssistant = m1.find((x) => x.role === "assistant");
check("S1: oldest assistant thinking removed, toolCall kept",
	firstAssistant.content.some((b) => b.type === "toolCall") && !firstAssistant.content.some((b) => b.type === "thinking"),
	JSON.stringify(firstAssistant.content.map((b) => b.type)));
const lastAssistant = [...m1].reverse().find((x) => x.role === "assistant");
check("S1: latest assistant message unmodified", lastAssistant.content.some((b) => b.type === "thinking") && lastAssistant.content.some((b) => b.type === "text"));

// snapshot: v2, appended once, BEFORE the compressed request's assistant message
check("S1: exactly one v2 snapshot appended", appended.length === 1 && appended[0].type === "context-savings" && appended[0].data.v === 2, JSON.stringify(appended[0]?.data));
const snap1 = appended[0]?.data;
check("S1: cumulativeTokens in sane range (3k-10k)", (snap1?.cumulativeTokens ?? 0) > 3000 && (snap1?.cumulativeTokens ?? 0) < 10000, `got ${snap1?.cumulativeTokens}`);
check("S1: deltaTokens == cumulative (first compression)", snap1?.deltaTokens === snap1?.cumulativeTokens);
check("S1: frozen set recorded (10 toolCallIds, 10 thinking refs)", snap1?.toolCallIds?.length === 10 && snap1?.thinking?.length === 10, `tools=${snap1?.toolCallIds?.length} think=${snap1?.thinking?.length}`);
const snapIdx = branchEntries.findIndex((e) => e.type === "custom" && e.customType === "context-savings");
const asstIdx = branchEntries.findIndex((e) => e.type === "message" && e.message?.usage?.totalTokens > 0);
check("S1: snapshot lands before the compressed request's assistant message", snapIdx !== -1 && asstIdx !== -1 && snapIdx < asstIdx, `snap=${snapIdx} asst=${asstIdx}`);
const T1 = snap1?.cumulativeTokens ?? 0;

// warning: trimmed C tokens (~$C*rate / C/(prompt+C)%) — one line
check("S1: one-line warning (tokens, $, %)",
	/^Warning: tool\/thinking compression enabled; trimmed 4\.1k tokens \(~\$0\.012 \/ 3\.9%\) from this request\.$/.test(lastWarning()?.m ?? ""),
	lastWarning()?.m);

// ---------------------------------------------------------------------------
// S2: sticky — next WARM request is still trimmed; running summary accrues
// ---------------------------------------------------------------------------
const notesBeforeS2 = notifications.length;
const r2 = await simulateRequest(buildMessages(), ctxBase, mkUsage(R1));
check("S2: warm request after compression is still compressed (sticky)", r2 !== undefined && markersIn(r2.messages) === 10, r2 ? `markers=${markersIn(r2.messages)}` : "no result");
check("S2: no new snapshot for sticky request", appended.length === 1);
check("S2: no warning on plain sticky request", notifications.length === notesBeforeS2, `delta=${notifications.length - notesBeforeS2}`);

await registered.savings.handler("detail", ctxBase);
let sav = lastNote().m;
check("S2: /savings = running summary (1 compression, 2 req, ~$0.025 = 2×T1×rate)",
	/1 compression; currently trimming 4\.1k tokens\/request/.test(sav) && /cost: ~\$0\.025 saved/.test(sav) && /periods: 2 req × 4\.1k \(≈\$0\.025\)/.test(sav),
	sav.replace(/\n/g, " | "));
await registered.savings.handler("", ctxBase);
check("S2: /savings default output is 8 grouped lines, no periods/pricing noise",
	lastNote().m.split("\n").length === 8 && !/periods:|pricing:/.test(lastNote().m), lastNote().m.replace(/\n/g, " | "));
check("S2: last request grouped under its own header, with cost+token shares",
	/ {2}last request:\n {4}cost: ~\$0\.012 saved \(18\.4% of \$0\.067\)\n {4}tokens: 4\.1k saved \(4\.1% of 100\.0k\)/.test(lastNote().m), lastNote().m.replace(/\n/g, " | "));
check("S2: totals grouped under their own header",
	/ {2}total:\n {4}cost: ~\$0\.025 saved \(18\.4% of \$0\.134\)\n {4}tokens: 8\.2k saved \(4\.1% of 200\.0k\)/.test(lastNote().m), lastNote().m.replace(/\n/g, " | "));

// ---------------------------------------------------------------------------
// S3: warm request BEFORE any compression -> untouched
// ---------------------------------------------------------------------------
await branchWithLastRequest(1 * 60_000);
const r3 = await simulateRequest(buildMessages(), ctxBase, zeroUsage);
check("S3: no compression when warm and never compressed", r3 === undefined);

// ---------------------------------------------------------------------------
// S4: model switch -> compression event
// ---------------------------------------------------------------------------
await branchWithLastRequest(1 * 60_000);
const r4warm = await simulateRequest(buildMessages(), ctxBase, zeroUsage);
check("S4: warm same-model request untouched", r4warm === undefined);
const r4 = await simulateRequest(buildMessages(), ctxOpenAI, mkUsage(R1));
check("S4: compression on model switch", r4 !== undefined && markersIn(r4.messages) === 10, r4 ? `markers=${markersIn(r4.messages)}` : "no result");
check("S4: snapshot recorded with model-switch reason", appended.length === 2 && appended[1].data.reason === "cache miss after model switch", appended[1]?.data?.reason);

// ---------------------------------------------------------------------------
// S5: post-compaction rebuild -> recompression
// ---------------------------------------------------------------------------
branchEntries = [
	{ type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", timestamp: Date.now() - 10_000, usage: zeroUsage } },
	{ type: "compaction", summary: "sum", firstKeptEntryId: "x", tokensBefore: 100, timestamp: Date.now() - 5_000 },
];
notifications.length = 0;
await reseed();
const msgs5 = buildMessages();
msgs5.splice(1, 0, msg({ role: "compactionSummary", summary: "the summary of old stuff" }));
const r5 = await simulateRequest(msgs5, ctxBase, mkUsage(R1));
check("S5: compression after compaction (context rebuilt)", r5 !== undefined && markersIn(r5.messages) === 10, r5 ? `markers=${markersIn(r5.messages)}` : "no result");

// ---------------------------------------------------------------------------
// S6: min-context guard — tiny context not auto-compressed
// ---------------------------------------------------------------------------
await branchWithLastRequest(30 * 60_000);
const tiny = [msg({ role: "user", content: [text("hi")] }), msg({ role: "assistant", content: [text("hello!")] })];
const r6 = await handlers.context({ type: "context", messages: tiny }, ctxBase);
check("S6: tiny context skipped (min-context guard)", r6 === undefined);

// ---------------------------------------------------------------------------
// S7: /compress on WARM cache; flag consumed; sticky afterwards
// ---------------------------------------------------------------------------
await branchWithLastRequest(1 * 60_000);
await registered.compress.handler("on", ctxBase);
const r7 = await simulateRequest(buildMessages(), ctxBase, mkUsage(R1));
check("S7: /compress forces compression even on warm cache", r7 !== undefined && markersIn(r7.messages) === 10, r7 ? `markers=${markersIn(r7.messages)}` : "no result");
check("S7: persisted reason is manual", appended[appended.length - 1]?.data?.reason === "manual compression via /compress", appended[appended.length - 1]?.data?.reason);
const r7b = await simulateRequest(buildMessages(), ctxBase, zeroUsage);
check("S7: flag consumed — following warm request is NOT a new compression (no snapshot) but stays trimmed",
	r7b !== undefined && markersIn(r7b.messages) === 10, r7b ? `markers=${markersIn(r7b.messages)} snapshots=${appended.length}` : "no result");

// ---------------------------------------------------------------------------
// S8: /compress bypasses the min-context guard
// ---------------------------------------------------------------------------
function buildMedium() {
	const msgs = [msg({ role: "user", content: [text("medium task")] })];
	for (let i = 0; i < 25; i++) {
		msgs.push(msg({
			role: "assistant",
			content: [think("medium thinking " + i + " ".repeat(380)), toolCall("bash", { command: "m" + i })],
		}));
		msgs.push(toolResult("call_m" + i, "medium output " + i + " ".repeat(780)));
	}
	return msgs;
}
await branchWithLastRequest(12 * 60_000);
const medium = buildMedium();
const est = medium.reduce((s, m) => s + (m.role === "toolResult" ? Math.ceil(m.content[0].text.length / 4) : m.role === "assistant" ? Math.ceil((m.content[0].thinking.length + JSON.stringify(m.content[1].arguments).length) / 4) : 0), 0);
check("S8: pre-check — medium context is below the 8k guard", est < 8000, `est=${est}`);
const r8auto = await handlers.context({ type: "context", messages: medium }, ctxBase);
check("S8: auto path skips (idle miss but under guard)", r8auto === undefined);
await registered.compress.handler("on", ctxBase);
const r8 = await simulateRequest(buildMedium(), ctxBase, mkUsage(R1));
check("S8: manual path compresses despite size guard", r8 !== undefined && markersIn(r8.messages) === 5, r8 ? `markers=${markersIn(r8.messages)}` : "no result");
const r8b = await handlers.context({ type: "context", messages: buildMedium() }, ctxBase);
check("S8: sticky after manual compression", r8b !== undefined && markersIn(r8b.messages) === 5, r8b ? `markers=${markersIn(r8b.messages)}` : "no result");

// ---------------------------------------------------------------------------
// S9: /savings + /usage walk math on a hand-built branch: X×T1 + Y×T2
// ---------------------------------------------------------------------------
const snap = (cum, delta, ts) => ({ type: "custom", customType: "context-savings", data: { v: 2, ts, modelKey: "a/b", reason: "idle", idleMs: 1, cumulativeTokens: cum, deltaTokens: delta, toolCallIds: [], thinking: [] } });
const asst = (rate) => ({ type: "message", message: { role: "assistant", provider: "a", model: "b", usage: mkUsage(rate) } });
const R9 = 3e-6;
const cmdCtx = {
	hasUI: true,
	ui: { notify: (m, t) => notifications.push({ m, t }) },
	// pre-compression request accrues nothing; X=2 at T1=4100; Y=3 at T2=6670
	sessionManager: { getBranch: () => [
		asst(0), snap(4100, 4100, 1), asst(R9), asst(R9), snap(6670, 2570, 2), asst(R9), asst(R9), asst(R9),
	] },
};
const expected9 = 2 * 4100 * R9 + 3 * 6670 * R9; // 0.0246 + 0.06003 = 0.08463

await registered.savings.handler("detail", cmdCtx);
sav = lastNote().m;
check("S9: /savings = X×T1 + Y×T2 (not Y×all)", /2 compressions/.test(sav) && /cost: ~\$0\.085 saved/.test(sav) && /periods: 2 req × 4\.1k \(≈\$0\.025\) \+ 3 req × 6\.7k \(≈\$0\.060\)/.test(sav), sav.replace(/\n/g, " | "));
check("S9: total matches 2×4100×r + 3×6670×r", Math.abs(expected9 - 0.08463) < 1e-12, `expected=${expected9}`);

await registered.usage.handler("", cmdCtx);
let use = lastNote().m;
check("S9: /usage totals + savings line",
	/6 requests/.test(use) && /context-savings: ~\$0\.085 saved \(\d+\.\d% of total\), 28\.2k tokens trimmed — see \/savings/.test(use) && /cache efficiency: 90\.0%/.test(use),
	use.replace(/\n/g, " | "));

await registered.savings.handler("", { hasUI: true, ui: ctxBase.ui, sessionManager: { getBranch: () => [asst(0)] } });
check("S9: /savings with no compressions points at /compress", /No context compressions in this session yet — \/compress to start\./.test(lastNote().m), lastNote().m);

// ---------------------------------------------------------------------------
// S10: growing context — frozen trim, then compression #2 raises the level.
// Scenario: compression on 30 rounds; X=2 requests with 32 rounds; compression
// #2 on 32 rounds; Y=1 request with 33 rounds. Total = 2×T1 + 1×T2.
// ---------------------------------------------------------------------------
await branchWithLastRequest(12 * 60_000);
await registered.compress.handler("on", ctxBase);
const c10 = await simulateRequest(buildMessages(30, 0), ctxBase, mkUsage(R1));
const T10a = appended[appended.length - 1]?.data?.cumulativeTokens ?? 0;
check("S10: compression #1 on 30 rounds (10 tools trimmed, 0 thinking)", c10 !== undefined && markersIn(c10.messages) === 10, `cum=${T10a}`);

// X = 2 sticky requests on the GROWN context (32 rounds): only the ORIGINAL 10
// may be trimmed — new outputs call_30/call_31 stay full (frozen trim).
const snapsBeforeS10x = appended.length;
const grown32 = buildMessages(32, 0);
const g1 = await simulateRequest(grown32, ctxBase, mkUsage(R1));
check("S10: sticky request #1 — only original 10 trimmed (frozen)", g1 !== undefined && markersIn(g1.messages) === 10 && JSON.stringify(markerCallIds(g1.messages)) === JSON.stringify(["call_0", "call_1", "call_2", "call_3", "call_4", "call_5", "call_6", "call_7", "call_8", "call_9"]), `markers=${markersIn(g1.messages)}`);
check("S10: new tool outputs call_30/call_31 intact", g1.messages.filter((x) => x.toolCallId === "call_30" || x.toolCallId === "call_31").every((x) => x.content?.[0]?.text?.startsWith("output number")));
const g2 = await simulateRequest(buildMessages(32, 0), ctxBase, mkUsage(R1));
check("S10: sticky request #2 — still frozen at 10, no new snapshot", g2 !== undefined && markersIn(g2.messages) === 10 && appended.length === snapsBeforeS10x, `markers=${markersIn(g2.messages)} snapshots=${appended.length - snapsBeforeS10x}`);

// Compression #2: window over 32 rounds trims 12 -> T2 = T1 + 2 tool outputs
await registered.compress.handler("on", ctxBase);
const c10b = await simulateRequest(buildMessages(32, 0), ctxBase, mkUsage(R1));
const snap10b = appended[appended.length - 1]?.data;
const T10b = snap10b?.cumulativeTokens ?? 0;
check("S10: compression #2 trims 12 of 32 (window superset of frozen 10)", c10b !== undefined && markersIn(c10b.messages) === 12, `markers=${markersIn(c10b.messages)} cum=${T10b}`);
check("S10: delta = T2 - T1 (2 tool outputs)", (snap10b?.deltaTokens ?? -1) === T10b - T10a, `delta=${snap10b?.deltaTokens} T2-T1=${T10b - T10a}`);

// Y = 1 sticky request on 33 rounds: frozen at 12; call_32 intact.
const grown33 = buildMessages(33, 0);
const y1 = await simulateRequest(grown33, ctxBase, mkUsage(R1));
check("S10: sticky after compression #2 — frozen at 12 (call_32 intact)",
	y1 !== undefined && markersIn(y1.messages) === 12 && y1.messages.find((x) => x.toolCallId === "call_32")?.content?.[0]?.text?.startsWith("output number"), `markers=${markersIn(y1.messages)}`);

// Periods include the compressed request itself (it was sent trimmed too):
// period 1 = c10 + g1 + g2 = 3 req at T1; period 2 = c10b + y1 = 2 req at T2.
const expected10 = 3 * T10a * R1 + 2 * T10b * R1;
const expectedTokens10 = 3 * T10a + 2 * T10b;
await registered.savings.handler("detail", ctxBase);
sav = lastNote().m;
check("S10: /savings = 3×T1 + 2×T2 (periods counted at their own cumulative level)",
	/2 compressions; currently trimming/.test(sav) && new RegExp(`cost: ~\\$${expected10.toFixed(3)} saved`).test(sav), sav.replace(/\n/g, " | ") + ` expected=${expected10}`);
check("S10: tokens line sums the per-request trim (3×T1 + 2×T2)",
	new RegExp(`tokens: ${rx(fmtTok(expectedTokens10))} saved`).test(sav), sav.replace(/\n/g, " | ") + ` expected=${expectedTokens10}`);
// T2 includes 2 newly-aging-out thinking blocks: 12×254 + 2×156 = 3360 (3.4k)
check("S10: periods line shows both levels", /periods: 3 req × 2\.5k \(≈\$0\.023\) \+ 2 req × 3\.4k \(≈\$0\.020\)/.test(sav), sav.replace(/\n/g, " | "));

// ---------------------------------------------------------------------------
// S11: reseed (/tree, resume) restores spec + running savings from the branch
// ---------------------------------------------------------------------------
await reseed();
const r11 = await handlers.context({ type: "context", messages: buildMessages(33, 0) }, ctxBase);
check("S11: after reseed, warm request still trimmed at frozen 12", r11 !== undefined && markersIn(r11.messages) === 12, r11 ? `markers=${markersIn(r11.messages)}` : "no result");
await registered.savings.handler("", ctxBase);
check("S11: /savings total unchanged after reseed", new RegExp(`cost: ~\\$${expected10.toFixed(3)} saved`).test(lastNote().m), lastNote().m.replace(/\n/g, " | "));

// ---------------------------------------------------------------------------
// S12: counterfactual pricing (default mode)
// ---------------------------------------------------------------------------
process.env.CONTEXT_SAVINGS_RATE_MODE = "counterfactual";
const snapR = (cum, reason) => ({ type: "custom", customType: "context-savings", data: { v: 2, ts: 1, modelKey: "a/b", reason, idleMs: 0, cumulativeTokens: cum, deltaTokens: cum, toolCallIds: [], thinking: [] } });
const MANUAL = "manual compression via /compress";
const IDLE = "cache miss after 12m idle";
const asstAt = (rate, ts) => ({ type: "message", message: { role: "assistant", provider: "a", model: "b", timestamp: ts, usage: mkUsage(rate) } });
const R12 = 3e-6;
const branch12 = [snapR(4100, MANUAL), asst(R12), asst(R12), snapR(6670, IDLE), asst(R12), asst(R12)];
const ctx12 = { hasUI: true, ui: ctxBase.ui, sessionManager: { getBranch: () => branch12 } };
// warm requests priced at cache-read rate (0.1×); the request right after a
// non-manual compression is a genuine miss and priced at the input rate.
const expected12 = 2 * 4100 * R12 * 0.1 + 6670 * R12 + 6670 * R12 * 0.1;
await registered.savings.handler("detail", ctx12);
sav = lastNote().m;
check("S12: warm requests priced at cache-read rate, post-miss request at input rate",
	new RegExp(`cost: ~${rx(money(expected12))} saved`).test(sav), sav.replace(/\n/g, " | ") + ` expected=${money(expected12)}`);
check("S12: /savings detail states the pricing model", /pricing: counterfactual/.test(sav), sav.replace(/\n/g, " | "));

process.env.CONTEXT_SAVINGS_RATE_MODE = "paid";
await registered.savings.handler("", ctx12);
const expected12paid = (2 * 4100 + 2 * 6670) * R12;
check("S12: paid mode prices every request at the input rate (strictly larger)",
	new RegExp(`~${rx(money(expected12paid))} saved`).test(lastNote().m) && expected12paid > expected12, lastNote().m.replace(/\n/g, " | "));
process.env.CONTEXT_SAVINGS_RATE_MODE = "counterfactual";

// 0-request period (compression whose request was never billed) is hidden
const ctx12b = { hasUI: true, ui: ctxBase.ui, sessionManager: { getBranch: () => [snapR(4100, MANUAL), snapR(6670, MANUAL), asst(R12)] } };
await registered.savings.handler("detail", ctx12b);
check("S12: empty period filtered from the periods line", /2 compressions/.test(lastNote().m) && /periods: 1 req × 6\.7k/.test(lastNote().m) && !/0 req/.test(lastNote().m), lastNote().m.replace(/\n/g, " | "));

// S12c: percentages are measured against what the session ACTUALLY cost/sent.
// Branch: 1 untrimmed request, then snapshot(manual) + 2 warm trimmed requests.
// Per request: prompt = 100k tokens, total cost = 10000*r + 90000*0.1r + 0.01.
{
	const perTotal = (1000 + 9000) * R12 + 90000 * R12 * 0.1 + 0.01;
	const saved = 2 * 4100 * R12 * 0.1; // 2 warm trimmed requests
	const savedTokens = 2 * 4100;
	const totalCost = 3 * perTotal; // all 3 billed requests, trimmed or not
	const totalPrompt = 3 * 100000;
	const ctx12c = { hasUI: true, ui: ctxBase.ui, sessionManager: { getBranch: () => [asst(R12), snapR(4100, MANUAL), asst(R12), asst(R12)] } };
	const cPct = ((100 * saved) / totalCost).toFixed(1);
	const tkPct = ((100 * savedTokens) / totalPrompt).toFixed(1);
	await registered.savings.handler("", ctx12c);
	check("S12: cost % is measured against actual session cost",
		new RegExp(`cost: ~${rx(money(saved))} saved \\(${rx(cPct)}% of ${rx(money(totalCost))}\\)`).test(lastNote().m),
		lastNote().m.replace(/\n/g, " | ") + ` expected ${cPct}% of ${money(totalCost)}`);
	check("S12: token % is measured against prompt tokens actually sent",
		new RegExp(`tokens: ${rx(fmtTok(savedTokens))} saved \\(${rx(tkPct)}% of ${rx(fmtTok(totalPrompt))}\\)`).test(lastNote().m),
		lastNote().m.replace(/\n/g, " | ") + ` expected ${tkPct}% of ${fmtTok(totalPrompt)}`);
	await registered.usage.handler("", ctx12c);
	check("S12: /usage savings line carries the same percentage",
		new RegExp(`context-savings: ~${rx(money(saved))} saved \\(${rx(cPct)}% of total\\), ${rx(fmtTok(savedTokens))} tokens trimmed`).test(lastNote().m), lastNote().m.replace(/\n/g, " | "));
}

// ---------------------------------------------------------------------------
// S15: /compress as a toggle — off restores the full context, on restores the
// frozen prefix, and the cache-impact claim tracks the LAST SENT prefix.
// ---------------------------------------------------------------------------
process.env.CONTEXT_SAVINGS_RATE_MODE = "paid";
await branchWithLastRequest(12 * 60_000);
const c15 = await simulateRequest(buildMessages(), ctxBase, mkUsage(R1)); // idle -> compressed
const T15 = appended[appended.length - 1]?.data?.cumulativeTokens ?? 0;
check("S15: baseline compressed request", c15 !== undefined && markersIn(c15.messages) === 10);

await registered.compress.handler("", ctxBase); // toggle OFF
check("S15: toggling off reports OFF and warns about the cache break",
	/^context-savings: OFF — full context restored$/m.test(lastNote().m) && /breaks cache: ~\$[\d.]+ extra on that request/.test(lastNote().m), lastNote().m.replace(/\n/g, " | "));

await registered.compress.handler("", ctxBase); // toggle back ON, no request in between
check("S15: off->on with no request in between is cache-free",
	new RegExp(`^context-savings: ON — trims ${rx(fmtTok(T15))} tokens/request \\(~\\$[\\d.]+ each\\); cache unaffected$`).test(lastNote().m),
	lastNote().m.replace(/\n/g, " | "));
check("S15: toggle message is at most 2 lines", lastNote().m.split("\n").length <= 2, lastNote().m.replace(/\n/g, " | "));

const r15on = await simulateRequest(buildMessages(), ctxBase, mkUsage(R1));
check("S15: re-enabled request is trimmed at the frozen level", r15on !== undefined && markersIn(r15on.messages) === 10, r15on ? `markers=${markersIn(r15on.messages)}` : "no result");

await registered.compress.handler("off", ctxBase);
const r15off = await simulateRequest(buildMessages(), ctxBase, mkUsage(R1));
check("S15: while off, the full context is sent (no trimming)", r15off === undefined);
const snapsBefore15 = appended.length;
const r15off2 = await simulateRequest(buildMessages(), ctxBase, mkUsage(R1));
check("S15: while off, automatic compression cannot fire either", r15off2 === undefined && appended.length === snapsBefore15);

await registered.compress.handler("on", ctxBase); // last sent was untrimmed -> breaks cache
check("S15: on after an untrimmed request warns and quotes payback",
	/breaks cache: ~\$[\d.]+ extra on that request, pays back after ~\d+ requests/.test(lastNote().m), lastNote().m.replace(/\n/g, " | "));
const r15back = await simulateRequest(buildMessages(), ctxBase, mkUsage(R1));
check("S15: trimming resumes after switching back on", r15back !== undefined && markersIn(r15back.messages) === 10, r15back ? `markers=${markersIn(r15back.messages)}` : "no result");

// "on" while already on = re-compress: picks up newly aged-out tool outputs
await registered.compress.handler("on", ctxBase);
check("S15: refresh quotes the larger window level, not the stale frozen one",
	new RegExp(`trims ${rx(fmtTok(T15))} tokens/request`).test(lastNote().m), lastNote().m.replace(/\n/g, " | "));
const r15refresh = await simulateRequest(buildMessages(34, 0), ctxBase, mkUsage(R1));
check("S15: refresh re-runs the keep-window (14 of 34 trimmed)", r15refresh !== undefined && markersIn(r15refresh.messages) === 14, r15refresh ? `markers=${markersIn(r15refresh.messages)}` : "no result");
process.env.CONTEXT_SAVINGS_RATE_MODE = "counterfactual";

// ---------------------------------------------------------------------------
// S16: toggle claims after reseed (startup/resume/tree) — the provider cache
// does not reset just because we restarted.
// ---------------------------------------------------------------------------
process.env.CONTEXT_SAVINGS_RATE_MODE = "paid";
const recentAsst = (msAgo) => ({ type: "message", timestamp: new Date(Date.now() - msAgo).toISOString(), message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", timestamp: Date.now() - msAgo, usage: mkUsage(R1) } });

// resumed session: snapshot + a billed request 1 minute ago -> cache is warm
// AND holds the trimmed prefix, so disabling must warn.
branchEntries = [snapR(4100, IDLE), recentAsst(60_000)];
notifications.length = 0;
await reseed();
await registered.compress.handler("off", ctxBase);
check("S16: disabling right after resume reports the cache break (was: 'unaffected')",
	/^context-savings: OFF/m.test(lastNote().m) && /breaks cache: ~\$[\d.]+ extra/.test(lastNote().m) && !/cache unaffected/.test(lastNote().m),
	lastNote().m.replace(/\n/g, " | "));
await registered.compress.handler("on", ctxBase);
check("S16: switching straight back on after resume is free again", /cache unaffected/.test(lastNote().m), lastNote().m.replace(/\n/g, " | "));

// /savings must say whether the numbers are live or historical
await registered.savings.handler("", ctxBase);
check("S16: /savings marks trimming as active", /currently trimming 4\.1k tokens\/request/.test(lastNote().m), lastNote().m.replace(/\n/g, " | "));
await registered.compress.handler("off", ctxBase);
await registered.savings.handler("", ctxBase);
check("S16: /savings flags paused compression and points at /compress",
	/not trimming now — \/compress to resume/.test(lastNote().m) && !/currently trimming/.test(lastNote().m), lastNote().m.replace(/\n/g, " | "));
await registered.compress.handler("on", ctxBase);

// same branch, but the last request was 30 minutes ago: nothing left to break
branchEntries = [snapR(4100, IDLE), recentAsst(30 * 60_000)];
await reseed();
await registered.compress.handler("off", ctxBase);
check("S16: expired cache is reported as expired, not as a costly break",
	/cache already expired/.test(lastNote().m) && !/breaks cache/.test(lastNote().m), lastNote().m.replace(/\n/g, " | "));

// bare toggle must be able to cancel a queued first compression
branchEntries = [recentAsst(60_000)];
await reseed();
await registered.compress.handler("", ctxBase);
check("S16: first bare /compress queues a compression (ON)", /^context-savings: ON/m.test(lastNote().m), lastNote().m.replace(/\n/g, " | "));
await registered.compress.handler("", ctxBase);
check("S16: second bare /compress cancels it instead of sticking ON", /^context-savings: OFF/m.test(lastNote().m), lastNote().m.replace(/\n/g, " | "));
const r16 = await handlers.context({ type: "context", messages: buildMessages() }, ctxBase);
check("S16: cancelled compression really does not fire", r16 === undefined);
await registered.compress.handler("on", ctxBase);
process.env.CONTEXT_SAVINGS_RATE_MODE = "counterfactual";

// ---------------------------------------------------------------------------
// S13: a >TTL gap between billed requests is a miss, snapshot or not
// ---------------------------------------------------------------------------
const t0 = Date.now();
const ctx13 = { hasUI: true, ui: ctxBase.ui, sessionManager: { getBranch: () => [snapR(4100, MANUAL), asstAt(R12, t0), asstAt(R12, t0 + 10 * 60_000)] } };
const expected13 = 4100 * R12 * 0.1 + 4100 * R12; // warm, then cold after 10m
await registered.savings.handler("", ctx13);
check("S13: request after a >TTL gap is priced as a cache miss",
	new RegExp(`cost: ~${rx(money(expected13))} saved`).test(lastNote().m), lastNote().m.replace(/\n/g, " | ") + ` expected=${money(expected13)}`);

// ---------------------------------------------------------------------------
// S14: ISO-string timestamps must still yield a real idle gap on resume
// ---------------------------------------------------------------------------
branchEntries = [{
	type: "message",
	timestamp: new Date(Date.now() - 20 * 60_000).toISOString(), // entry-level ISO only
	message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage: zeroUsage },
}];
notifications.length = 0;
await reseed();
const r14 = await handlers.context({ type: "context", messages: buildMessages() }, ctxBase);
check("S14: resumed session with ISO timestamps detects the idle gap",
	r14 !== undefined && markersIn(r14.messages) === 10 && /idle/.test(appended[appended.length - 1]?.data?.reason ?? ""),
	appended[appended.length - 1]?.data?.reason);

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(" | ")); process.exit(1); }

/**
 * Bounded views over a running child.
 *
 * Every level has a hard cap enforced in code, and truncation happens BOTH
 * per-entry and per-response. A response-level cap alone does not save you:
 * real pi sessions contain single entries of several megabytes (base64 images),
 * so one entry can blow the budget on its own.
 *
 * This module never reads a session file. All state comes from the streamed
 * events already held in memory.
 */

import type { LiveChild } from "./types.ts";

/** Hard caps in characters. Exported so /subagents-info reports the real values. */
export const CAP = {
	status: 400,
	digest: 1200,
	tail: 4000,
	final: 8000,
} as const;

export type PeekLevel = keyof typeof CAP;

function clip(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]`;
}

function age(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function tokens(l: LiveChild): string {
	const t = l.usage.input + l.usage.output + l.usage.cacheRead + l.usage.cacheWrite;
	return t > 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
}

export function statusLine(l: LiveChild): string {
	const r = l.record;
	const dur = age((r.endedAt ?? Date.now()) - l.startedAt);
	const owns = r.writes.length ? r.writes.join(",") : "read-only";
	const gen = r.generation > 1 ? ` · gen${r.generation}` : "";
	let s = `${r.id} · ${r.agent}${gen} · ${r.state} · ${l.usage.turns} turns · ${dur} · ${tokens(l)} tok · $${l.usage.cost.toFixed(3)} · owns[${owns}]`;
	if (l.blockCount) s += ` · ⚠${l.blockCount} blocked`;
	if (r.state === "failed" && r.exitCode !== null) s += ` · exit ${r.exitCode}`;
	return s;
}

export function digest(l: LiveChild): string {
	const parts = [statusLine(l)];
	if (l.tools.length) {
		const recent = l.tools
			.slice(-6)
			.map((t) => `${t.isError ? "✗" : ""}${t.name}(${t.brief})`)
			.join(" ");
		parts.push(`recent: ${recent}`);
	}
	if (l.lastText) parts.push(`last: ${clip(l.lastText.replace(/\s+/g, " "), 200)}`);
	return clip(parts.join("\n"), CAP.digest);
}

export function tail(l: LiveChild): string {
	const parts = [statusLine(l), ""];
	for (const m of l.tail.slice(-8)) {
		parts.push(`[${m.role}] ${m.text}`);
	}
	if (l.record.state === "failed" && l.stderr) {
		parts.push("", `stderr: ${clip(l.stderr.trim().split("\n").slice(-12).join("\n"), 800)}`);
	}
	return clip(parts.join("\n"), CAP.tail);
}

export function final(l: LiveChild): string {
	const parts = [statusLine(l), ""];
	parts.push(l.lastText || "(no final message)");
	if (l.record.state === "failed" && l.stderr) {
		parts.push("", `stderr: ${clip(l.stderr.trim().split("\n").slice(-12).join("\n"), 800)}`);
	}
	parts.push("", `full session: pi --session ${l.record.sessionFile ?? "(unavailable)"}`);
	return clip(parts.join("\n"), CAP.final);
}

export function render(l: LiveChild, level: PeekLevel): string {
	switch (level) {
		case "status":
			return clip(statusLine(l), CAP.status);
		case "tail":
			return tail(l);
		case "final":
			return final(l);
		default:
			return digest(l);
	}
}

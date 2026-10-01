/**
 * Bridges pi session boundaries to the durable messaging store.
 *
 * Delivery is two-phase: a boundary appends a custom message carrying its
 * receipt, and the receipt is acknowledged only after that entry is visible in
 * the persisted session (next boundary, or the parent reading the file after
 * the child exits). A crash between the two re-delivers rather than losing mail.
 */

import * as fs from "node:fs";
import { acknowledgeDelivery, closeInbox, prepareDelivery, type Actor, type DeliveryReceipt } from "./messaging/index.ts";

export const TEAM_MESSAGE_TYPE = "subagent-team-message";

interface BoundaryLike {
	type: string;
	outcome?: string;
	entries?: unknown[];
}

function receiptOf(entry: any): DeliveryReceipt | null {
	if (entry?.type !== "custom_message" || entry.customType !== TEAM_MESSAGE_TYPE) return null;
	const r = entry.details?.receipt;
	return r && typeof r === "object" && r.actor ? (r as DeliveryReceipt) : null;
}

/** Acknowledge every delivery receipt present in already-persisted entries. */
export function acknowledgePersisted(runDir: string, entries: Iterable<unknown>): void {
	for (const e of entries) {
		const r = receiptOf(e);
		if (r) acknowledgeDelivery(runDir, r);
	}
}

/** Parent-side recovery once a child has exited: its session file is final. */
export function reconcileSessionFile(runDir: string, sessionFile: string | null | undefined): void {
	if (!sessionFile) return;
	let raw: string;
	try {
		raw = fs.readFileSync(sessionFile, "utf8");
	} catch {
		return;
	}
	const entries: unknown[] = [];
	for (const line of raw.split("\n")) {
		if (!line.includes(TEAM_MESSAGE_TYPE)) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			/* torn final line: never persisted, so never acknowledged */
		}
	}
	acknowledgePersisted(runDir, entries);
}

/**
 * turn_end / agent_before_settle handler body. Returns a boundary result that
 * appends one batched message and asks for one more model turn, or undefined.
 */
export function deliveryBoundary(
	runDir: string,
	actor: Actor,
	event: BoundaryLike,
	persisted: Iterable<unknown>,
	standingDown = false,
): { entries: unknown[]; continue: boolean } | undefined {
	acknowledgePersisted(runDir, persisted);
	const final = event.type === "agent_before_settle";
	// Never extend a run that was aborted, errored, or is being stood down: the
	// mail stays queued and the parent's settlement reports it as undelivered.
	if (standingDown || (event.outcome && event.outcome !== "completed")) {
		if (final) closeInbox(runDir, actor, standingDown ? "stood down (its parent session ended)" : `stopped (run ${event.outcome})`);
		return undefined;
	}
	const prepared = prepareDelivery(runDir, actor, final);
	if (!prepared) return undefined;
	return {
		entries: [
			...(event.entries ?? []),
			{
				type: "custom_message",
				customType: TEAM_MESSAGE_TYPE,
				content: prepared.text,
				display: true,
				details: { receipt: prepared.receipt },
			},
		],
		continue: true,
	};
}

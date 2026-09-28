/**
 * On-disk shapes for team messaging.
 *
 * Everything here is plain JSON. A thread file is the unit of atomic write:
 * it is rewritten wholesale under the run lock and renamed into place.
 */

/** Who is acting, pinned to the generation that is actually running. */
export interface Actor {
	id: string;
	generation: number;
}

export interface Team {
	name: string;
	goal: string;
}

/** Whether the recipient's session has been told the message exists. */
export type InboundState = "queued" | "delivered" | "undelivered";

/** Whether the *sender* has been told their message died. */
export type NoticeState = "queued" | "delivered" | "retained";

export interface ReadState {
	/** Half-open [start, end) character ranges of `text` the agent has seen. */
	ranges: [number, number][];
	full: boolean;
	at: number | null;
	/**
	 * Key of the paging session that finished this message off, if any. Lets a
	 * cursor keep showing a message it just marked read, instead of having the
	 * page list shift underneath it. Clocks are too coarse for this job.
	 */
	session: string | null;
}

export interface Failure {
	reason: string;
	at: number;
	notice: { state: NoticeState; at: number | null };
}

export interface StoredMessage {
	id: string;
	/** Run-wide monotonic send order. Wall-clock ties are common; this never ties. */
	seq: number;
	from: Actor;
	to: Actor;
	at: number;
	text: string;
	needs_reply: boolean;
	/** Message id this replies to, or null. Thread membership is separate. */
	reply_to: string | null;
	inbound: { state: InboundState; at: number | null; reason: string | null };
	read: ReadState;
	failure: Failure | null;
}

export interface Thread {
	version: 1;
	id: string;
	team: string;
	/** Exactly two, with the generations current when the thread opened. */
	participants: Actor[];
	createdAt: number;
	messages: StoredMessage[];
}

/**
 * Handed back by prepareDelivery. The caller persists the notification text
 * first (e.g. as a session message) and only then acknowledges, so a crash in
 * between re-delivers rather than silently swallowing the message.
 */
export interface DeliveryReceipt {
	actor: Actor;
	preparedAt: number;
	/** Inbound message ids announced in this batch. */
	inbound: string[];
	/** Subset of `inbound` whose body was included verbatim. */
	full: string[];
	/** Message ids whose *failure notice* was announced to the sender. */
	failures: string[];
}

export interface SendInput {
	to: string;
	text: string;
	reply_to?: string | null;
	needs_reply?: boolean;
}

export interface ReadOptions {
	thread_id?: string;
	view?: "unread" | "recent" | "all";
	cursor?: string | null;
	limit?: number;
}

export interface ReadResult {
	text: string;
	details: any;
}

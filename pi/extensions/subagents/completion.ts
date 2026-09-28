/**
 * Tells the parent MODEL that a child finished, so work that waits on a child
 * never stalls with an idle parent.
 *
 * The message is deliberately short: the child's id and the call that fetches
 * its result. The result itself is not included; subagent_collect returns it
 * once, in full, when the parent asks.
 *
 * Nothing is sent for a child an in-flight collect is waiting on (that collect
 * returns it), or one already reported (final peek, stop). Children finishing
 * within one batching window share a single message.
 *
 * Timing, because pi cannot withdraw a message once it has it:
 *   - parent idle: send after the batching window; this starts a new rollout.
 *   - parent running: hold until the end of its current LLM call (turn_end),
 *     after that call's tools ran, so a collect it made there is accounted for.
 *     The message then lands before the next LLM call.
 *   - finished after the last LLM call: send when the parent settles.
 */

export interface FinishedChild {
	id: string;
	agent: string;
	state: string;
}

export interface CompletionNotifier {
	/** A child settled. */
	finished(child: FinishedChild): void;
	/** These children's results already reached the model; don't announce them. */
	reported(ids: string[]): void;
	/** The parent's LLM call and its tools finished; the next call has not started. */
	turnEnded(): void;
	/** The parent stopped and will not continue on its own. */
	settled(): void;
	/** Take every unsent completion and send nothing; for handing over on /reload. */
	drain(): FinishedChild[];
}

export const BATCH_MS = 1000;

export function createCompletionNotifier(opts: {
	send: (text: string) => void;
	/** True while an in-flight subagent_collect is waiting on this child. */
	awaited: (id: string) => boolean;
	/** True from the parent's agent_start until agent_settled. */
	parentRunning: () => boolean;
	schedule?: (fn: () => void) => () => void;
}): CompletionNotifier {
	const schedule =
		opts.schedule ??
		((fn: () => void) => {
			const t = setTimeout(fn, BATCH_MS);
			t.unref?.();
			return () => clearTimeout(t);
		});
	const pending = new Map<string, FinishedChild>();
	let cancel: (() => void) | null = null;

	const flush = () => {
		cancel?.();
		cancel = null;
		const due = [...pending.values()].filter((c) => !opts.awaited(c.id));
		pending.clear();
		if (!due.length) return;
		const ids = due.map((c) => JSON.stringify(c.id)).join(", ");
		const who = due.map((c) => `${c.id} (${c.agent}, ${c.state})`).join(", ");
		const text =
			due.length === 1
				? `Subagent ${who} finished. Collect its result with subagent_collect({ ids: [${ids}] }).`
				: `Subagents ${who} finished. Collect their results with subagent_collect({ ids: [${ids}] }).`;
		try {
			opts.send(text);
		} catch {
			/* reporting must never break a child's exit path */
		}
	};

	return {
		finished(child) {
			if (opts.awaited(child.id)) return;
			pending.set(child.id, child);
			if (opts.parentRunning()) return; // turnEnded/settled will send it
			cancel ??= schedule(() => {
				cancel = null;
				// Started running since (the user typed): wait for its turn end.
				if (!opts.parentRunning()) flush();
			});
		},
		reported(ids) {
			for (const id of ids) pending.delete(id);
		},
		turnEnded: flush,
		settled: flush,
		drain() {
			cancel?.();
			cancel = null;
			const out = [...pending.values()];
			pending.clear();
			return out;
		},
	};
}

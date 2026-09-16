/**
 * RTK Extension for Pi
 *
 * Transparently rewrites bash tool calls through `rtk rewrite` to reduce
 * LLM token consumption by 60-90% via output filtering.
 *
 * Based on the Hermes plugin pattern: intercept tool calls, delegate to
 * `rtk rewrite` for the rewrite decision, mutate command before execution.
 * Fail-open: if rtk is missing or any error occurs, original command runs unchanged.
 *
 * Usage:
 *   pi -e ~/.pi/agent/extensions/rtk/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REWRITE_TIMEOUT_MS = 100;

interface RtkExtensionState {
	rtkAvailable: boolean;
	warnedMissing: boolean;
}

export default function (pi: ExtensionAPI) {
	const state: RtkExtensionState = {
		rtkAvailable: false,
		warnedMissing: false,
	};

	// Detect rtk binary at session start
	pi.on("session_start", async () => {
		try {
			const result = await pi.exec("rtk", ["--version"]);
			state.rtkAvailable = result.code === 0;
		} catch {
			state.rtkAvailable = false;
		}
	});

	// Intercept bash tool calls and rewrite through rtk
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		if (!state.rtkAvailable) {
			if (!state.warnedMissing) {
				ctx.ui.notify(
					"rtk not found in PATH — commands pass through unchanged",
					"warning",
				);
				state.warnedMissing = true;
			}
			return undefined;
		}

		const command = event.input.command as string;
		const rewritten = await rewriteCommand(pi, command);

		if (rewritten) {
			event.input.command = rewritten;
		}

		return undefined;
	});

	// /rtk command: show status and token savings
	pi.registerCommand("rtk", {
		description: "Show RTK status and token savings",
		async handler(_args, ctx) {
			if (!state.rtkAvailable) {
				ctx.ui.notify(
					"rtk not installed. Install: curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh",
					"warning",
				);
				return;
			}

			try {
				const gain = await pi.exec("rtk", ["gain"]);
				if (gain.code === 0 && gain.stdout) {
					ctx.ui.notify(`rtk savings:\n${gain.stdout.trim()}`, "info");
				} else {
					ctx.ui.notify("rtk available — no gain data yet. Run commands to accumulate stats.", "info");
				}
			} catch {
				ctx.ui.notify("rtk available but failed to query gain", "warning");
			}
		},
	});
}

/**
 * Call `rtk rewrite <command>` and return rewritten command or null.
 *
 * rtk exits non-1 (typically 3 in v0.40.0) with the rewritten command on stdout
 * if a rule matches, exits 1 if no RTK equivalent exists or RTK_DISABLED=1 is set.
 *
 * Fail-open: any error (timeout, spawn failure) returns null,
 * and the original command runs unchanged.
 */
export async function rewriteCommand(
	pi: { exec: ExtensionAPI["exec"] },
	command: string,
): Promise<string | null> {
	try {
		const result = await pi.exec("rtk", ["rewrite", command], {
			timeout: REWRITE_TIMEOUT_MS,
		});

		// rtk exits 3 (v0.40.0) on success, exit 1 means no rewrite.
		// Check non-1 to handle both 0 and 3 (future-proof).
		if (result.code !== 1 && result.stdout) {
			const rewritten = result.stdout.trim();
			if (rewritten && rewritten !== command.trim()) {
				return rewritten;
			}
		}
		return null;
	} catch {
		return null;
	}
}

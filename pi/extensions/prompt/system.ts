/**
 * /prompt:system
 *
 * Dumps the current session's system prompt to a temp file (chmod 444, so
 * most editors open it read-only) and launches $VISUAL / $EDITOR to view it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { viewContentInEditor } from "./editor.ts";

export function registerSystemPromptCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prompt:system", {
		description: "View this session's system prompt read-only in $EDITOR",
		handler: async (_args, ctx) => {
			const prompt = ctx.getSystemPrompt();

			if (!prompt || prompt.trim().length === 0) {
				ctx.ui.notify("No system prompt available for this session.", "warning");
				return;
			}

			await viewContentInEditor(ctx, "pi-system-prompt-", "system-prompt.md", prompt);
		},
	});
}

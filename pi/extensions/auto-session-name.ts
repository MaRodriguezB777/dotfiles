/**
 * Auto session naming.
 *
 * Every N user messages (default 5), asks anthropic/claude-haiku-4-5 to
 * rename the session as:
 *   "<broad goal, ~7 words> ---- <current goal, ~7 words>"
 *
 * Also provides /rename-now to trigger a rename immediately.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RENAME_EVERY_N_USER_MESSAGES = 5;
const PROVIDER = "anthropic";
const MODEL_ID = "claude-haiku-4-5";
const MAX_CONVERSATION_CHARS = 60_000;

type ContentBlock = { type?: string; text?: string; name?: string };

const extractText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(p): p is ContentBlock =>
				!!p && typeof p === "object" && (p as ContentBlock).type === "text",
		)
		.map((p) => p.text ?? "")
		.join("\n");
};

const buildConversationText = (entries: any[]): { text: string; userCount: number } => {
	const sections: string[] = [];
	let userCount = 0;

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		if (role === "user") userCount++;

		const text = extractText(entry.message.content).trim();
		if (text) sections.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
	}

	let text = sections.join("\n\n");
	if (text.length > MAX_CONVERSATION_CHARS) {
		// Keep the beginning (broad goal) and the end (current goal).
		const head = text.slice(0, MAX_CONVERSATION_CHARS / 3);
		const tail = text.slice(-(2 * MAX_CONVERSATION_CHARS) / 3);
		text = `${head}\n\n[... middle of conversation truncated ...]\n\n${tail}`;
	}
	return { text, userCount };
};

const buildPrompt = (conversationText: string): string =>
	[
		"You name coding-agent sessions. Read this conversation and produce a session name",
		"with EXACTLY this format (a broad part, then ' ---- ', then a current part):",
		"",
		"<broad overall goal of the session, approximately 7 words> ---- <what is being worked on right now, approximately 7 words>",
		"",
		"Rules:",
		"- One single line, plain text, no quotes, no markdown.",
		"- Each part approximately 7 words (5-9 is fine).",
		"- The broad part describes the session as a whole; the current part describes the most recent focus.",
		"- Output ONLY the name, nothing else.",
		"",
		"<conversation>",
		conversationText,
		"</conversation>",
	].join("\n");

const sanitize = (raw: string): string | undefined => {
	const line = raw
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.find((l) => l.includes("----"));
	const name = (line ?? raw.trim().split("\n")[0] ?? "").replace(/^["'`]+|["'`]+$/g, "").trim();
	return name.length > 0 ? name.slice(0, 200) : undefined;
};

export default function (pi: ExtensionAPI) {
	let lastRenamedAtUserCount = 0;
	let hasRenamedThisSession = false;
	let renaming = false;

	const rename = async (ctx: any, force: boolean): Promise<void> => {
		if (renaming) return;

		const { text, userCount } = buildConversationText(ctx.sessionManager.getBranch());
		if (!text.trim()) return;

		const isFirstEverRename = lastRenamedAtUserCount === 0 && !hasRenamedThisSession;
		const dueForPeriodicRename =
			userCount - lastRenamedAtUserCount >= RENAME_EVERY_N_USER_MESSAGES;

		if (!force && !isFirstEverRename && !dueForPeriodicRename) return;
		if (!force && userCount < 1) return;

		const model = ctx.modelRegistry.find(PROVIDER, MODEL_ID);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			if (force && ctx.hasUI) {
				ctx.ui.notify(`${PROVIDER}/${MODEL_ID} unavailable or not authenticated`, "warning");
			}
			return;
		}

		renaming = true;
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: buildPrompt(text) }],
							timestamp: Date.now(),
						},
					],
				},
				{ cacheRetention: "none", sessionId: uuidv7() },
			);

			const raw = response.content
				.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");

			const name = sanitize(raw);
			if (name) {
				pi.setSessionName(name);
				lastRenamedAtUserCount = userCount;
				hasRenamedThisSession = true;
				if (force && ctx.hasUI) ctx.ui.notify(`Session renamed: ${name}`, "info");
			}
		} catch {
			// Non-fatal: try again at the next threshold.
		} finally {
			renaming = false;
		}
	};

	pi.on("agent_settled", async (_event, ctx) => {
		await rename(ctx, false);
	});

	pi.registerCommand("rename-now", {
		description: "Rename the session now using claude-haiku-4-5",
		handler: async (_args, ctx) => {
			await rename(ctx, true);
		},
	});
}

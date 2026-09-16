/**
 * prompt/ extension — inspect what pi actually sends to the model.
 *
 *   /prompt:system         view the session system prompt read-only in $EDITOR
 *   /prompt:tools          view all active tool definitions, pretty-printed with
 *                          the true JSON size of each ("X chars ~ Y tokens")
 *   /prompt:tools-toggle   interactively enable/disable tools for this session
 *                          (warns that this invalidates the prompt cache)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSystemPromptCommand } from "./system.ts";
import { registerToolsCommand } from "./tools.ts";
import { registerToolsToggleCommand } from "./tools-toggle.ts";

export default function (pi: ExtensionAPI) {
	registerSystemPromptCommand(pi);
	registerToolsCommand(pi);
	registerToolsToggleCommand(pi);
}

/**
 * prompt/ extension — inspect what pi actually sends to the model.
 *
 *   /prompt:system         view the session system prompt read-only in $EDITOR
 *   /prompt:tools          view tool definitions, pretty-printed with the true
 *                          JSON size of each ("X chars ~ Y tokens"), split into
 *                          always active / loaded from deferral / deferred /
 *                          disabled
 *   /prompt:tools-toggle   interactively enable/disable (or load/unload deferred)
 *                          tools for this session
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

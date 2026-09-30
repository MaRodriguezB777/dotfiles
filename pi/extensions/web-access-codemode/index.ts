// Loads pi-web-access with its tools reachable only through the `codemode` tool.
// The package's own extension entry is disabled in settings.json
// ({ "source": "npm:pi-web-access", "extensions": ["-dist/index.js"] }).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webAccess from "../../npm/node_modules/pi-web-access/dist/index.js";

export default function (pi: ExtensionAPI) {
	const proxied = new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop === "registerTool") {
				return (tool: any) => {
					// The web_enable loader is pointless when the tools are never declared directly.
					if (tool.name === "web_enable") return;
					return target.registerTool({
						...tool,
						exposure: "codemode",
						namespace: { name: "web", description: "pi-web-access: web search, source check, URL/content fetching, stored results" },
					});
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return webAccess(proxied);
}

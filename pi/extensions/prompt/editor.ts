/**
 * Shared helper: dump content to a read-only temp file and open it in
 * $VISUAL / $EDITOR (falling back to vi/notepad), suspending the TUI while
 * the external editor owns the terminal.
 */

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function resolveEditorCommand(): string {
	return (
		process.env.VISUAL ||
		process.env.EDITOR ||
		(process.platform === "win32" ? "notepad" : "vi")
	);
}

async function openReadOnlyInEditor(filePath: string): Promise<{ ok: boolean; message?: string }> {
	const command = resolveEditorCommand();
	const [editorBin, ...editorArgs] = command.split(" ");

	return new Promise((resolve) => {
		const child = spawn(editorBin, [...editorArgs, filePath], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.on("error", (err) => {
			resolve({ ok: false, message: `Failed to launch "${command}": ${err.message}` });
		});
		child.on("close", (code) => {
			if (code !== 0 && code !== null) {
				resolve({ ok: false, message: `Editor "${command}" exited with code ${code}` });
			} else {
				resolve({ ok: true });
			}
		});
	});
}

/** Write content to a read-only temp file and open it in $VISUAL/$EDITOR. */
export async function viewContentInEditor(
	ctx: any,
	tmpPrefix: string,
	fileName: string,
	content: string,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), tmpPrefix));
	const filePath = join(dir, fileName);

	try {
		writeFileSync(filePath, content, "utf-8");
		// Best-effort read-only: most editors (vim, nano, code, etc.)
		// will warn/refuse writes against a non-writable file.
		chmodSync(filePath, 0o444);

		if (ctx.mode === "tui") {
			// Suspend the TUI's raw-mode input handling while the
			// external editor owns the terminal, then resume.
			await ctx.ui.custom<void>((tui: any, _theme: any, _keybindings: any, done: any) => {
				const placeholder = {
					render: () => [] as string[],
				};

				setImmediate(async () => {
					tui.stop();
					try {
						const result = await openReadOnlyInEditor(filePath);
						if (!result.ok) {
							ctx.ui.notify(result.message ?? "Editor exited with an error.", "error");
						}
					} finally {
						tui.start();
						tui.requestRender(true);
						done();
					}
				});

				return placeholder;
			});
		} else {
			const result = await openReadOnlyInEditor(filePath);
			if (!result.ok) {
				ctx.ui.notify(result.message ?? "Editor exited with an error.", "error");
			}
		}
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup.
		}
	}
}

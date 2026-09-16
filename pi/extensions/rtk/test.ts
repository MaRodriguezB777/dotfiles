/**
 * RTK Extension Unit Tests
 *
 * Run: npx tsx ~/.pi/agent/extensions/rtk/test.ts
 *
 * Tests the rewriteCommand function with mocked pi.exec.
 * Integration tests require rtk installed (gated by RTK_INSTALLED=1 env).
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { describe, it, afterEach } from "node:test";
import { rewriteCommand } from "./index.js";

// --- Helpers ---

type ExecResult = { code: number; stdout: string; stderr: string };
type ExecFn = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<ExecResult>;

interface MockPi {
	execCalls: Array<{ cmd: string; args: string[]; opts?: { timeout?: number } }>;
	responses: ExecResult[];
	throwOnNext: boolean;
}

function createMockPi(responses: ExecResult[]): MockPi {
	return {
		execCalls: [],
		responses,
		throwOnNext: false,
	};
}

function mockExec(pi: MockPi): ExecFn {
	return async (cmd: string, args: string[], opts?: { timeout?: number }) => {
		pi.execCalls.push({ cmd, args, opts });
		if (pi.throwOnNext) {
			throw new Error("spawn failed");
		}
		if (pi.responses.length === 0) {
			throw new Error("no responses left in mock");
		}
		return pi.responses.shift()!;
	};
}

// --- Unit Tests ---

describe("rewriteCommand", () => {
	let pi: MockPi;

	afterEach(() => {
		// verify all responses consumed
		if (pi && pi.responses.length > 0) {
			assert.fail(`Unconsumed mock responses: ${pi.responses.length}`);
		}
	});

	it("rewrites command when rtk returns rewritten version", async () => {
		pi = createMockPi([
			{ code: 0, stdout: "rtk git status\n", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"git status",
		);

		assert.equal(result, "rtk git status");
		assert.equal(pi.execCalls.length, 1);
		assert.deepEqual(pi.execCalls[0], {
			cmd: "rtk",
			args: ["rewrite", "git status"],
			opts: { timeout: 100 },
		});
	});

	it("returns null when rtk exits 1 (no equivalent)", async () => {
		pi = createMockPi([
			{ code: 1, stdout: "", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"echo hello",
		);

		assert.equal(result, null);
	});

	it("returns null when rtk exit 0 but stdout is empty", async () => {
		pi = createMockPi([
			{ code: 0, stdout: "", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"git status",
		);

		assert.equal(result, null);
	});

	it("returns null when rewritten equals original (sanity check)", async () => {
		pi = createMockPi([
			{ code: 0, stdout: "git status\n", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"git status",
		);

		assert.equal(result, null);
	});

	it("returns null on spawn failure (rtk binary missing)", async () => {
		pi = createMockPi([]);
		pi.throwOnNext = true;

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"git status",
		);

		assert.equal(result, null);
	});

	it("handles compound commands (rewritten by rtk binary)", async () => {
		pi = createMockPi([
			{ code: 0, stdout: "rtk git add . && rtk cargo test\n", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"git add . && cargo test",
		);

		assert.equal(result, "rtk git add . && rtk cargo test");
	});

	it("handles commands with env prefix", async () => {
		pi = createMockPi([
			{ code: 0, stdout: "FOO=bar rtk cargo test\n", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"FOO=bar cargo test",
		);

		assert.equal(result, "FOO=bar rtk cargo test");
	});

	it("handles commands with sudo prefix", async () => {
		pi = createMockPi([
			{ code: 0, stdout: "sudo rtk docker ps\n", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"sudo docker ps",
		);

		assert.equal(result, "sudo rtk docker ps");
	});

	it("handles commands with redirects", async () => {
		pi = createMockPi([
			{ code: 0, stdout: "rtk cargo test 2>&1\n", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"cargo test 2>&1",
		);

		assert.equal(result, "rtk cargo test 2>&1");
	});

	it("handles rtk cargo subcommands", async () => {
		pi = createMockPi([
			{ code: 0, stdout: "rtk cargo check\n", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"cargo check",
		);

		assert.equal(result, "rtk cargo check");
	});

	it("handles npm subcommands", async () => {
		pi = createMockPi([
			{ code: 0, stdout: "rtk npm test\n", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"npm test",
		);

		assert.equal(result, "rtk npm test");
	});

	it("handles kubectl commands", async () => {
		pi = createMockPi([
			{ code: 0, stdout: "rtk kubectl get pods\n", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"kubectl get pods",
		);

		assert.equal(result, "rtk kubectl get pods");
	});

	it("handles Go commands", async () => {
		pi = createMockPi([
			{ code: 0, stdout: "rtk go test ./...\n", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"go test ./...",
		);

		assert.equal(result, "rtk go test ./...");
	});

	it("handles psql commands", async () => {
		pi = createMockPi([
			{ code: 0, stdout: 'rtk psql -c "SELECT * FROM users"\n', stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			'psql -c "SELECT * FROM users"',
		);

		assert.equal(result, 'rtk psql -c "SELECT * FROM users"');
	});

	it("preserves RTK_DISABLED commands (handled by rtk binary, exits 1)", async () => {
		// rtk rewrite exits 0 with same command (or exits 1), either way extension passes through
		pi = createMockPi([
			{ code: 1, stdout: "", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"RTK_DISABLED=1 git status",
		);

		assert.equal(result, null);
	});

	it("already rtk-prefixed commands pass through (rtk binary returns same)", async () => {
		pi = createMockPi([
			{ code: 0, stdout: "rtk git status\n", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"rtk git status",
		);

		// rewritten === original → null
		assert.equal(result, null);
	});

	it("passes timeout option to pi.exec", async () => {
		pi = createMockPi([
			{ code: 0, stdout: "rtk git status\n", stderr: "" },
		]);

		await rewriteCommand({ exec: mockExec(pi) }, "git status");

		assert.equal(pi.execCalls[0].opts?.timeout, 100);
	});

	it("trims whitespace from rtk output", async () => {
		pi = createMockPi([
			{ code: 3, stdout: "  rtk git status  \n", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"git status",
		);

		assert.equal(result, "rtk git status");
	});

	it("accepts exit code 0 as rewrite (future-proof)", async () => {
		pi = createMockPi([
			{ code: 0, stdout: "rtk git status\n", stderr: "" },
		]);

		const result = await rewriteCommand(
			{ exec: mockExec(pi) },
			"git status",
		);

		assert.equal(result, "rtk git status");
	});
});

// --- Integration Tests (requires rtk installed) ---

describe("integration tests", { skip: !process.env.RTK_INSTALLED && "set RTK_INSTALLED=1 to run" }, async () => {
	function rewriteUnsafe(cmd: string): string | null {
		try {
			const out = execSync(`rtk rewrite ${JSON.stringify(cmd)}`, {
				encoding: "utf-8",
				timeout: 5000,
			});
			const trimmed = out.trim();
			return trimmed && trimmed !== cmd.trim() ? trimmed : null;
		} catch (e: any) {
			// rtk exits non-zero on both success (3) and unsupported (1).
			// execSync throws on non-zero, but stdout may still have content.
			const out = (e as { stdout?: string }).stdout;
			if (out) {
				const trimmed = String(out).trim();
				return trimmed && trimmed !== cmd.trim() ? trimmed : null;
			}
			return null;
		}
	}

	it("rtk binary is available", () => {
		try {
			execSync("rtk --version", { timeout: 5000 });
		} catch {
			assert.fail("rtk binary not found");
		}
	});

		it("rewrites git status → rtk git status", () => {
			assert.equal(rewriteUnsafe("git status"), "rtk git status");
		});

		it("rewrites cargo check → rtk cargo check", () => {
			assert.equal(rewriteUnsafe("cargo check"), "rtk cargo check");
		});

		it("rewrites kubectl get pods → rtk kubectl get pods", () => {
			assert.equal(rewriteUnsafe("kubectl get pods"), "rtk kubectl get pods");
		});

		it("rewrites npm run test → rtk npm run test", () => {
			assert.equal(rewriteUnsafe("npm run test"), "rtk npm run test");
		});

		it("rewrites docker ps → rtk docker ps", () => {
			assert.equal(rewriteUnsafe("docker ps"), "rtk docker ps");
		});

		it("rewrites compound commands", () => {
			const out = rewriteUnsafe("git add . && cargo test");
			assert.ok(out?.includes("rtk git add ."));
			assert.ok(out?.includes("rtk cargo test"));
			assert.ok(out?.includes("&&"));
		});

		it("rewrites commands with env prefix", () => {
			const out = rewriteUnsafe("FOO=bar cargo check");
			assert.ok(out?.includes("FOO=bar"));
			assert.ok(out?.includes("rtk cargo check"));
		});

		it("rewrites commands with sudo", () => {
			const out = rewriteUnsafe("sudo docker ps");
			assert.ok(out?.includes("sudo"));
			assert.ok(out?.includes("rtk docker ps"));
		});

		it("passes through echo (unsupported)", () => {
			assert.equal(rewriteUnsafe("echo hello"), null);
		});

		it("passes through cd (unsupported)", () => {
			assert.equal(rewriteUnsafe("cd /tmp"), null);
		});

		it("passes through unsupported commands", () => {
			assert.equal(rewriteUnsafe("htop"), null);
		});

		it("passes through RTK_DISABLED prefixed commands", () => {
			assert.equal(rewriteUnsafe("RTK_DISABLED=1 git status"), null);
		});

		it("passes through already rtk-prefixed commands (same output)", () => {
			const out = rewriteUnsafe("rtk git status");
			// rtk rewrite returns same string → null
			assert.equal(out, null);
		});

	it("preserves redirects", () => {
		const out = rewriteUnsafe("cargo test 2>&1");
		assert.ok(out?.includes("rtk cargo test"));
		assert.ok(out?.includes("2>&1"));
	});
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import { acknowledgeDelivery, prepareDelivery } from "./index.ts";
import { actor, addChild, readReg, readThreadFile, threadFiles, tmpRun, writeReg } from "./test-helpers.ts";

const worker = path.join(import.meta.dirname, "concurrency-worker.ts");

test("concurrent senders in separate processes never lose or corrupt a message", { timeout: 60_000 }, () => {
	const run = tmpRun();
	const reg = readReg(run);
	reg.teams = { alpha: { name: "alpha", goal: "g" } };
	writeReg(run, reg);
	addChild(run, "c-hub", { team: "alpha" });
	const senders = ["c-w1", "c-w2", "c-w3", "c-w4"];
	for (const s of senders) addChild(run, s, { team: "alpha" });

	const perSender = 8;
	const procs = senders.map((s) =>
		new Promise<any[]>((resolve, reject) => {
			import("node:child_process").then(({ execFile }) => {
				execFile(
					process.execPath,
					["--experimental-strip-types", "--no-warnings", worker, run, s, "c-hub", String(perSender)],
					{ encoding: "utf8" },
					(err, stdout, stderr) => {
						if (err) reject(new Error(`${s} failed: ${err.message}\n${stderr}`));
						else resolve(JSON.parse(stdout));
					},
				);
			});
		}),
	);

	return Promise.all(procs).then((results) => {
		const ids = results.flat().map((r: any) => r.message_id);
		assert.equal(ids.length, senders.length * perSender);
		assert.equal(new Set(ids).size, ids.length, "message ids must be unique");

		const files = threadFiles(run);
		let total = 0;
		for (const f of files) {
			const th = readThreadFile(run, f.replace(/\.json$/, ""));
			total += th.messages.length;
		}
		assert.equal(total, ids.length, "every message survived the race");
		assert.equal(typeof readReg(run).runId, "string", "registry stayed valid JSON");

		let delivered = 0;
		for (;;) {
			const batch = prepareDelivery(run, actor("c-hub", 1));
			if (!batch) break;
			delivered += batch.receipt.inbound.length;
			acknowledgeDelivery(run, batch.receipt);
		}
		assert.equal(delivered, ids.length);
	});
});

test("execFileSync smoke: the worker runs under --experimental-strip-types", () => {
	const run = tmpRun();
	const reg = readReg(run);
	reg.teams = { alpha: { name: "alpha", goal: "g" } };
	writeReg(run, reg);
	addChild(run, "c-hub", { team: "alpha" });
	addChild(run, "c-one", { team: "alpha" });
	const out = execFileSync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", worker, run, "c-one", "c-hub", "2"],
		{ encoding: "utf8" },
	);
	assert.equal(JSON.parse(out).length, 2);
});

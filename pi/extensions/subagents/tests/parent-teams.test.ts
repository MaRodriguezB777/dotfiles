import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../index.ts';

test('parent team tool persists definitions and refuses unknown spawn teams before launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parent-teams-'));
  const cwd = process.cwd();
  const tools = new Map<string,any>();
  const hooks = new Map<string,Function[]>();
  process.chdir(dir);
  try {
    extension({ registerTool: (s:any) => tools.set(s.name,s), registerCommand(){}, registerEntryRenderer(){}, on(n:string,f:Function){hooks.set(n,[...(hooks.get(n)??[]),f]);} } as any);
    assert.ok(tools.has('subagent_team'), 'parent team tool registered');
    const create = await tools.get('subagent_team').execute('x',{name:'api',goal:'Maintain compatibility'});
    assert.ok(!create.isError, JSON.stringify(create));
    const run = join(dir,'.pi','runs',readdirSync(join(dir,'.pi','runs'))[0]);
    const registry = JSON.parse(readFileSync(join(run,'claims.json'),'utf8'));
    assert.equal(registry.teams.api.goal,'Maintain compatibility');
    const list = await tools.get('subagent_team').execute('x',{});
    assert.match(list.content[0].text,/api/);
    assert.match(list.content[0].text,/Maintain compatibility/);
    const bad = await tools.get('subagent_spawn').execute('x',{agent:'scout',task:'DO NOT LAUNCH',team:'missing'});
    assert.equal(bad.isError,true);
    assert.match(bad.content[0].text,/team/i);
    assert.deepEqual(JSON.parse(readFileSync(join(run,'claims.json'),'utf8')).children,{});
  } finally {
    for (const f of hooks.get('session_shutdown')??[]) await f({},{});
    process.chdir(cwd);
    rmSync(dir,{recursive:true,force:true});
  }
});

// pi can be launched from one directory ($HOME) while the session works in
// another; ctx.cwd is the session's. Claims, runs and child cwd must use it.
test("the run lives under the session cwd, not pi's process cwd", async () => {
	const project = mkdtempSync(join(tmpdir(), "session-cwd-"));
	const elsewhere = mkdtempSync(join(tmpdir(), "process-cwd-"));
	const cwd = process.cwd();
	const tools = new Map<string, any>();
	const hooks = new Map<string, Function[]>();
	process.chdir(elsewhere);
	try {
		extension({ registerTool: (s: any) => tools.set(s.name, s), registerCommand() {}, registerEntryRenderer() {}, on(n: string, f: Function) { hooks.set(n, [...(hooks.get(n) ?? []), f]); } } as any);
		const ctx = { cwd: project, hasUI: false, ui: { setWidget() {}, notify() {} } };
		for (const f of hooks.get("session_start") ?? []) await f({}, ctx);
		const r = await tools.get("subagent_team").execute("x", { name: "api", goal: "g" }, undefined, undefined, ctx);
		assert.ok(!r.isError, JSON.stringify(r));
		assert.equal(readdirSync(join(project, ".pi", "runs")).length, 1, "run created under the session cwd");
		const run = join(project, ".pi", "runs", readdirSync(join(project, ".pi", "runs"))[0]);
		assert.equal(JSON.parse(readFileSync(join(run, "claims.json"), "utf8")).root, project);
		assert.throws(() => readdirSync(join(elsewhere, ".pi")), "nothing written under the process cwd");
	} finally {
		for (const f of hooks.get("session_shutdown") ?? []) await f({}, {});
		process.chdir(cwd);
		rmSync(project, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
	}
});

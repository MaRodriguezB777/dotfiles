import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRegistry } from '../registry.ts';
import { defineTeam, sendMessage, readMessages } from '../messaging/index.ts';
import { TEAM_MESSAGE_TYPE, deliveryBoundary, reconcileSessionFile } from '../team-runtime.ts';

function run() {
  const dir = mkdtempSync(join(tmpdir(), 'team-runtime-'));
  const child = (id: string, team = 'api') => ({ id, agent: 'worker', task: id, team, acceptingMessages: true, writes: [], reads: [], cwd: dir, pid: process.pid, state: 'running', startedAt: Date.now(), endedAt: null, sessionFile: null, sessionId: null, model: null, thinking: null, resultPath: join(dir, id), exitCode: null, generation: 1 });
  writeRegistry(dir, { runId: 'r', root: dir, children: { a: child('a'), b: child('b') } } as any);
  defineTeam(dir, 'api', 'Ship API');
  return dir;
}
const b = { id: 'b', generation: 1 };
const event = (type = 'turn_end', outcome = 'completed') => ({ type, outcome, entries: [{ type: 'custom', customType: 'other' }] });

test('boundary appends one custom message and preserves prior drafts', () => {
  const dir = run();
  try {
    sendMessage(dir, { id: 'a', generation: 1 }, { to: 'b', text: 'Use null.' });
    const r = deliveryBoundary(dir, b, event() as any, []);
    assert.equal(r?.continue, true);
    assert.equal(r?.entries?.length, 2);
    const draft: any = r!.entries![1];
    assert.equal(draft.type, 'custom_message');
    assert.equal(draft.customType, TEAM_MESSAGE_TYPE);
    assert.match(draft.content, /Use null\./);
    // Not yet persisted, so the message remains queued rather than being marked delivered.
    const again = deliveryBoundary(dir, b, event() as any, []);
    assert.match((again!.entries![1] as any).content, /Use null\./);
    // Once the draft appears in the branch it is acknowledged exactly once.
    const persisted = [{ type: 'custom_message', customType: TEAM_MESSAGE_TYPE, details: draft.details }];
    assert.equal(deliveryBoundary(dir, b, event() as any, persisted), undefined);
    assert.match(readMessages(dir, b, {}).text, /0 unread|unread 0|\b0\b/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('session file reconciliation acknowledges committed drafts after a child exits', () => {
  const dir = run();
  try {
    sendMessage(dir, { id: 'a', generation: 1 }, { to: 'b', text: 'Interface ready.' });
    const draft: any = deliveryBoundary(dir, b, event() as any, [])!.entries![1];
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'custom_message', customType: TEAM_MESSAGE_TYPE, details: draft.details })}\n{partial`);
    reconcileSessionFile(dir, file);
    assert.equal(deliveryBoundary(dir, b, event() as any, []), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('aborted or stood-down boundaries never request continuation', () => {
  const dir = run();
  try {
    sendMessage(dir, { id: 'a', generation: 1 }, { to: 'b', text: 'late' });
    assert.equal(deliveryBoundary(dir, b, event('turn_end', 'aborted') as any, []), undefined);
    assert.equal(deliveryBoundary(dir, b, event() as any, [], true), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('final boundary without mail closes the inbox so later sends fail visibly', () => {
  const dir = run();
  try {
    assert.equal(deliveryBoundary(dir, b, event('agent_before_settle') as any, []), undefined);
    assert.throws(() => sendMessage(dir, { id: 'a', generation: 1 }, { to: 'b', text: 'too late' }), /finished|not accepting/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

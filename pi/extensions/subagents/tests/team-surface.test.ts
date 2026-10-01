import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as text from '../text.ts';
import { writeBoard } from '../board.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('parent can define teams and select a team on spawn', () => {
  assert.ok(text.PARENT_SPECS.some(s => s.name === 'subagent_team'));
  assert.equal(text.SPAWN_SPEC.parameters.properties.team.type, 'string');
});

test('team messaging is optional for both read-only and writing children', () => {
  for (const readOnly of [true, false]) {
    assert.ok(!text.childToolNames(readOnly).includes('message_team'));
    assert.ok(!text.childToolNames(readOnly, 'none').includes('team_messages'));
    assert.ok(text.childToolNames(readOnly, 'api').includes('message_team'));
    assert.ok(text.childToolNames(readOnly, 'api').includes('team_messages'));
    assert.ok(text.childToolNames(readOnly, 'none').includes('notes'));
  }
});

test('team prompt includes overall goal without replacing individual task boundaries', () => {
  const agent = { name: 'worker', description: '', prompt: 'Individual specialist.', source: 'test' };
  const prompt = text.childSystemPrompt(agent, ['src/api/**'], 'BOARD.md', { name: 'pagination', goal: 'Preserve old clients.' });
  assert.match(prompt, /pagination/);
  assert.match(prompt, /Preserve old clients\./);
  assert.match(prompt, /src\/api\/\*\*/);
  assert.match(prompt, /not.*(assignment|permission)|not.*scope/i);
  assert.match(prompt, /independently/i);
  const solo = text.childSystemPrompt(agent, [], 'BOARD.md');
  assert.match(solo, /none|disabled/i);
  assert.doesNotMatch(solo, /message_team\(/);
});

test('board exposes team goals and membership, legacy children default to none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-board-'));
  try {
    writeBoard(dir, {runId:'r',root:dir, teams:{api:{name:'api',goal:'Keep compatibility'}},children:{a:{id:'a',agent:'worker',state:'running',startedAt:Date.now(),writes:[],task:'Endpoint',team:'api'},b:{id:'b',agent:'scout',state:'done',startedAt:Date.now(),writes:[],task:'Review'}}} as any, 0);
    const board = readFileSync(join(dir, 'BOARD.md'), 'utf8');
    assert.match(board, /Keep compatibility/);
    assert.match(board, /team/);
    assert.match(board, /none/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("message_team: thread and new_thread, no reply_to; team_messages: with and thread", () => {
	const send = text.MESSAGE_TEAM_SPEC.parameters.properties;
	assert.ok(send.thread && send.new_thread && send.needs_reply);
	assert.equal(send.reply_to, undefined);
	const read = text.TEAM_MESSAGES_SPEC.parameters.properties;
	assert.ok(read.with && read.thread && read.view && read.cursor);
	assert.equal(read.thread_id, undefined);
	assert.match(text.MESSAGE_TEAM_SPEC.description, /default thread/);
	assert.match(text.MESSAGE_TEAM_SPEC.description, /new_thread/);
});

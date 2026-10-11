import test from 'node:test';
import assert from 'node:assert/strict';
import { startTaskActivity, recordTaskActivity, MAX_ACTIVITY_ENTRIES } from './taskActivity.ts';

test('keepalives do not invent progress; actual transitions and public notes stay ordered and bounded', () => {
  let activity = startTaskActivity('turn-a');
  const stage = { kind: 'stage' as const, text: '正在查看实际方块' };
  activity = recordTaskActivity(activity, 'turn-a', stage)!;
  assert.equal(recordTaskActivity(activity, 'turn-a', stage), activity);
  activity = recordTaskActivity(activity, 'turn-a', { kind: 'message', text: '我会先搭船身。' })!;
  assert.deepEqual(activity.entries.slice(-2).map(entry => entry.text), ['正在查看实际方块', '我会先搭船身。']);
  for (let index = 0; index < 30; index++) activity = recordTaskActivity(activity, 'turn-a', { kind: 'stage', text: `第${index}部分` })!;
  assert.equal(activity.entries.length, MAX_ACTIVITY_ENTRIES);
  assert.equal(activity.entries.at(-1)?.text, '第29部分');
  assert.equal(new Set(activity.entries.map(entry => entry.id)).size, MAX_ACTIVITY_ENTRIES);
});

for (const status of ['completed', 'stopped', 'failed'] as const) test(`${status} retains the last result and rejects late/older-turn updates`, () => {
  const initial = startTaskActivity('turn-a');
  const ended = recordTaskActivity(initial, 'turn-a', { kind: 'result', text: '终态说明', status })!;
  assert.equal(ended.status, status);
  assert.equal(recordTaskActivity(ended, 'turn-a', { kind: 'stage', text: '迟到的状态' }), ended);
  const next = startTaskActivity('turn-b');
  assert.equal(recordTaskActivity(next, 'turn-a', { kind: 'result', text: '旧任务完成', status: 'completed' }), next);
  assert.equal(next.entries.length, 1);
});

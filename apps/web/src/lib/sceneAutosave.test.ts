import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreferences, preferencesChanged, preferencesPending, flushPreferenceChanges, type PreferenceValues } from './sceneAutosave.ts';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const values = (draft = ''): PreferenceValues => ({ draft, speakerEnabled: true });

test('idle checks and edits reverted before saving produce no request', async () => {
  const local = createPreferences(values()); const writes: PreferenceValues[] = [];
  const flush = () => flushPreferenceChanges(local, async data => { writes.push(data); }, () => true);
  await flush(); local.draft = '临时想法'; local.draft = ''; await flush();
  assert.equal(preferencesChanged(local), false); assert.equal(writes.length, 0);
  local.draft = '需要保存'; await flush(); await flush(); await flush();
  assert.deepEqual(writes, [values('需要保存')]); assert.equal(preferencesPending(local), false);
});

test('overlapping checks share the current request and coalesce subsequent edits to their latest value', async () => {
  const wait = gate(), local = createPreferences(values()), writes: PreferenceValues[] = [];
  const flush = () => flushPreferenceChanges(local, async data => { writes.push(data); if (writes.length === 1) await wait.promise; }, () => true);
  local.draft = '第一次'; const first = flush(), duplicate = flush();
  local.draft = '被后续编辑替代'; const waiting = flush(); local.draft = '最终内容'; const last = flush();
  assert.equal(writes.length, 1); wait.resolve(); await Promise.all([first, duplicate, waiting, last]);
  assert.deepEqual(writes, [values('第一次'), values('最终内容')]);
  await flush(); assert.equal(writes.length, 2);
});

test('reverting during a write saves the final original value, while discard cancels queued writes', async () => {
  const wait = gate(), local = createPreferences(values()), writes: PreferenceValues[] = [];
  const save = async (data: PreferenceValues) => { writes.push(data); if (writes.length === 1) await wait.promise; };
  local.draft = '正在提交'; const first = flushPreferenceChanges(local, save, () => true);
  local.draft = ''; const restore = flushPreferenceChanges(local, save, () => true);
  wait.resolve(); await Promise.all([first, restore]); assert.deepEqual(writes, [values('正在提交'), values()]);
  local.draft = '不保存退出'; await flushPreferenceChanges(local, save, () => false); assert.equal(writes.length, 2);
});

test('an uncertain response is retried even if the user reverted to the old acknowledged value', async () => {
  const wait = gate(), local = createPreferences(values()); local.draft = '服务器可能已保存';
  const first = flushPreferenceChanges(local, async () => { await wait.promise; throw new Error('lost response'); }, () => true);
  local.draft = ''; wait.resolve(); await assert.rejects(first, /lost response/);
  assert.equal(preferencesChanged(local), true); const writes: PreferenceValues[] = [];
  await flushPreferenceChanges(local, async data => { writes.push(data); }, () => true);
  assert.deepEqual(writes, [values()]); assert.equal(preferencesPending(local), false);
});

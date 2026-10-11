import test from 'node:test';
import assert from 'node:assert/strict';
import { HoldToTalk } from './holdToTalk.ts';

function fixture() {
  const calls: string[] = []; let enabled = true;
  const control = new HoldToTalk({ canStart: () => enabled, start: () => calls.push('start'), send: () => calls.push('send'), cancel: () => calls.push('cancel') });
  return { calls, control, disable: () => { enabled = false; } };
}
test('holding Space starts once and only its release sends once', () => {
  const { control, calls } = fixture();
  assert.equal(control.begin('space'), true);
  for (let i = 0; i < 20; i++) assert.equal(control.begin('space'), false);
  assert.equal(control.begin(1), false); assert.equal(control.end(1), false);
  assert.deepEqual(calls, ['start']);
  assert.equal(control.end('space'), true); assert.equal(control.end('space'), false);
  assert.deepEqual(calls, ['start', 'send']);
});
test('blur, Escape, or lost pointer capture cancel without sending on later release', () => {
  for (const source of ['space', 'enter', 12] as const) {
    const { control, calls } = fixture();
    control.begin(source); control.cancel(); control.end(source); control.cancel();
    assert.deepEqual(calls, ['start', 'cancel']);
    assert.equal(control.begin(source), true);
  }
});
test('pointer capture loss after release and unrelated pointers cannot cancel a submitted turn', () => {
  const { control, calls } = fixture();
  control.begin(1); control.cancel(2); control.end(2);
  assert.deepEqual(calls, ['start']);
  control.end(1); control.cancel(1);
  assert.deepEqual(calls, ['start', 'send']);
});
test('busy/disabled controls do not record; an accepted hold still releases after state changes', () => {
  const a = fixture(); a.disable(); assert.equal(a.control.begin('space'), false); a.control.end('space'); assert.deepEqual(a.calls, []);
  const b = fixture(); b.control.begin('space'); b.disable(); b.control.end('space'); assert.deepEqual(b.calls, ['start', 'send']);
});

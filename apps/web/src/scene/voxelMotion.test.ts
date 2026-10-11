import test from 'node:test';
import assert from 'node:assert/strict';
import type { SceneSnapshot } from '../../../../packages/protocol/src/index.ts';
import { DROP_DURATION, DROP_HEIGHT, MOVE_DURATION, VoxelMotion } from './voxelMotion.ts';

type Voxel = SceneSnapshot['voxels'][number];
const voxel = (id: number, x = 0, y = 0, z = 0, color = '#AA7733'): Voxel => ({ id, partId: 'object', cell: { x, y, z }, color });
const position = (motion: VoxelMotion, id: number) => motion.get(id)!.position.toArray();
const visible = (motion: VoxelMotion, voxels: Voxel[]) => voxels.filter(value => motion.get(value.id)?.visible).map(value => value.id);

test('existing documents are immediately complete without a creation queue', () => {
  const motion = new VoxelMotion(), source = [voxel(1, 500, -200, 1000), voxel(2, 501, -200, 1000)];
  motion.sync(source, false, 0);
  assert.equal(motion.running, false); assert.deepEqual(visible(motion, source), [1, 2]);
  assert.deepEqual(position(motion, 1), [500.5, -199.5, 1000.5]); assert.equal(motion.isPickable(1), true);
});

test('a new model is complete on its first frame and settles as one shape without mutating data', () => {
  const motion = new VoxelMotion(), source = [voxel(4, 1, 1), voxel(3, 1, 0, 1), voxel(2, 1), voxel(1)];
  const before = structuredClone(source);
  motion.sync(source, true, 1000);
  assert.deepEqual(visible(motion, source), [4, 3, 2, 1]);
  for (const value of source) {
    assert.deepEqual(position(motion, value.id), [value.cell.x + 0.5, value.cell.y + 0.5 + DROP_HEIGHT, value.cell.z + 0.5]);
    assert.equal(motion.isPickable(value.id), false);
  }
  // After 800 ms the descent must still be clearly in progress, not an almost-still easing tail.
  motion.advance(1800);
  const offset = position(motion, 1)[1] - 0.5;
  assert.ok(offset > DROP_HEIGHT * 0.25 && offset < DROP_HEIGHT * 0.75);
  assert.equal(motion.running, true);
  for (const value of source) assert.ok(Math.abs(position(motion, value.id)[1] - value.cell.y - 0.5 - offset) < 1e-9);
  motion.advance(1000 + DROP_DURATION);
  assert.ok(source.every(value => motion.isPickable(value.id)));
  assert.equal(motion.running, false); assert.deepEqual(source, before);
  assert.equal(motion.advance(100_000).size, 0);
});

test('a following batch appears immediately without delaying or restarting the previous batch', () => {
  const motion = new VoxelMotion(), first = [voxel(10), voxel(20, 1), voxel(30, 2)];
  motion.sync(first, true, 0); motion.advance(40);
  const displayed = position(motion, 10);
  const next = [voxel(40, -20), ...first.slice().reverse()];
  motion.sync(next, true, 40);
  assert.deepEqual(position(motion, 10), displayed);
  assert.equal(visible(motion, next).length, 4);
  assert.deepEqual(position(motion, 40), [-19.5, 0.5 + DROP_HEIGHT, 0.5]);
  motion.advance(DROP_DURATION);
  assert.ok(first.every(value => motion.isPickable(value.id)));
  assert.equal(motion.isPickable(40), false);
  motion.advance(40 + DROP_DURATION); assert.equal(motion.running, false);
});

test('repaint and reordering do not restart arrivals; IDs retain their own positions', () => {
  const motion = new VoxelMotion(), first = [voxel(1), voxel(2, 1)];
  motion.sync(first, true, 0); motion.advance(200);
  const before = position(motion, 1);
  motion.sync([{ ...first[1], color: '#AA00FF' }, { ...first[0], color: '#00FFFF' }], true, 200);
  assert.deepEqual(position(motion, 1), before); assert.equal(motion.get(1)!.target.color, '#00FFFF');
  motion.advance(DROP_DURATION); assert.equal(motion.isPickable(1), true);
  assert.deepEqual(position(motion, 1), [0.5, 0.5, 0.5]);
  motion.advance(DROP_DURATION); assert.equal(motion.running, false);
});

test('interrupted entrance and moves continue from the current visual pose', () => {
  const motion = new VoxelMotion();
  motion.sync([voxel(1), voxel(2, 1)], true, 0);
  motion.advance(40); const entering = position(motion, 2);
  motion.sync([voxel(1), voxel(2, 500, -200, 1000)], true, 40);
  assert.equal(motion.get(2)!.visible, true);
  assert.deepEqual(position(motion, 2), entering);
  motion.advance(740);
  assert.ok(position(motion, 2)[0] > 100 && position(motion, 2)[0] < 400);
  assert.equal(motion.isPickable(2), false);
  motion.advance(40 + MOVE_DURATION); assert.deepEqual(position(motion, 2), [500.5, -199.5, 1000.5]);
  motion.finish();
  motion.sync([voxel(1, 10), voxel(2, 500, -200, 1000)], true, 1000);
  motion.advance(1100); const displayed = position(motion, 1);
  motion.sync([voxel(1, -10), voxel(2, 500, -200, 1000)], true, 1100);
  assert.deepEqual(position(motion, 1), displayed);
  const bounds = motion.bounds();
  assert.ok(bounds.min.x <= -10 && bounds.max.x >= displayed[0] + 0.5);
  motion.advance(1100 + MOVE_DURATION); assert.deepEqual(position(motion, 1), [-9.5, 0.5, 0.5]);
});

test('deletion and undo remove in-flight cubes immediately without ghosts on late frames', () => {
  const motion = new VoxelMotion(), first = [voxel(1), voxel(2, 1), voxel(3, 2)];
  motion.sync(first, true, 0); motion.sync([first[1]], true, 100);
  assert.equal(motion.get(1), undefined); assert.equal(motion.get(3), undefined);
  motion.advance(DROP_DURATION);
  assert.equal(motion.get(1), undefined); assert.equal(motion.get(3), undefined);
  motion.sync([], true, 50_000); assert.equal(motion.running, false); assert.equal(motion.bounds().isEmpty(), true);
  assert.equal(motion.advance(60_000).size, 0);
});

test('reduced motion or replacement finishes immediately, while disposal leaves no live clock state', () => {
  const motion = new VoxelMotion(), first = [voxel(1), voxel(2, 1)];
  motion.sync(first, true, 0); motion.finish();
  assert.equal(motion.running, false); assert.ok(first.every(value => motion.isPickable(value.id)));
  assert.deepEqual(position(motion, 2), [1.5, 0.5, 0.5]);
  motion.sync([...first, voxel(3, 2)], true, 1000); motion.dispose();
  assert.equal(motion.running, false); assert.equal(motion.advance(10_000).size, 0);
  assert.equal(motion.get(3), undefined);
  // A replacement document (or React effect replay) explicitly synchronizes afresh.
  motion.sync([voxel(1, 2000)], false, 11_000);
  assert.deepEqual(position(motion, 1), [2000.5, 0.5, 0.5]); assert.equal(motion.running, false);
});

test('a 16000-cube batch has bounded playback and retains every voxel', () => {
  const source = Array.from({ length: 16_000 }, (_, index) => voxel(index + 1, index % 40, Math.floor(index / 1600), Math.floor(index / 40) % 40));
  const motion = new VoxelMotion(); motion.sync(source, true, 1000);
  assert.equal(visible(motion, source).length, 16_000);
  motion.advance(1000 + DROP_DURATION);
  assert.equal(motion.running, false); assert.equal(visible(motion, source).length, 16_000);
  for (const value of source) assert.deepEqual(position(motion, value.id), [value.cell.x + 0.5, value.cell.y + 0.5, value.cell.z + 0.5]);
});

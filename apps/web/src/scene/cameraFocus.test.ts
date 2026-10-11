import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelEngine } from '../../../../packages/scene/src/index.ts';
import type { SceneSnapshot, Part } from '../../../../packages/protocol/src/index.ts';
import { changedSceneVoxels } from './cameraFocus.ts';

const part = (id: string, role: Part['role'], groupId?: string): Part => ({ id, name: id, role, groupId, origin: { x: 0, y: 0, z: 0 } });
const voxel = (id: number, partId: string, x: number, color = '#FFFFFF') => ({ id, partId, cell: { x, y: 0, z: 0 }, color });
function scene(): SceneSnapshot {
  return { ...new VoxelEngine().snapshot(),
    parts: [part('wall', 'wall', 'house'), part('roof', 'roof', 'house'), part('tree', 'plant', 'tree'), part('ground', 'terrain', 'island'), part('water', 'water', 'island')],
    voxels: [voxel(1, 'wall', 10), voxel(2, 'roof', 11), voxel(3, 'tree', 500), voxel(4, 'ground', -100), voxel(5, 'water', 100), voxel(6, 'water', 101)],
  };
}

test('changing one roof frames its whole house, excluding distant objects and landscape', () => {
  const before = scene(), after = structuredClone(before);
  after.voxels[1].color = '#CC2244';
  assert.deepEqual(changedSceneVoxels(before, after).map(v => v.id), [1, 2]);
});

test('each received batch focuses its own edit rather than the union of the entire turn', () => {
  const before = scene(), first = structuredClone(before), second = structuredClone(before);
  first.voxels[1].color = '#CC2244';
  second.voxels = structuredClone(first.voxels);
  second.voxels[2].cell.x = 520;
  assert.deepEqual(changedSceneVoxels(first, second), [second.voxels[2]]);
  assert.equal(changedSceneVoxels(first, second)[0].cell.x, 520);
});

test('local water and terrain edits do not expand to the full shared environment group', () => {
  const before = scene(), after = structuredClone(before);
  after.voxels[4].color = '#2266AA';
  assert.deepEqual(changedSceneVoxels(before, after), [after.voxels[4]]);
});

test('a deletion follows the surviving object, or the former location if entirely removed', () => {
  const before = scene(), after = structuredClone(before);
  after.voxels = after.voxels.filter(v => v.partId !== 'roof');
  after.parts = after.parts.filter(p => p.id !== 'roof');
  assert.deepEqual(changedSceneVoxels(before, after).map(v => v.id), [1]);
  after.voxels = after.voxels.filter(v => v.partId !== 'wall');
  after.parts = after.parts.filter(p => p.id !== 'wall');
  assert.deepEqual(changedSceneVoxels(before, after).map(v => v.id), [1, 2]);
});

test('a new ungrouped part stays local and unchanged/metadata-only snapshots have no camera target', () => {
  const before = scene(), after = structuredClone(before);
  after.parts.push(part('new', 'detail'));
  after.voxels.push(voxel(7, 'new', -30));
  assert.deepEqual(changedSceneVoxels(before, after).map(v => v.id), [7]);
  assert.deepEqual(changedSceneVoxels(after, structuredClone(after)), []);
  const renamed = structuredClone(after); renamed.model.name = '新名称'; renamed.parts[0].name = '新部件名称';
  assert.deepEqual(changedSceneVoxels(after, renamed), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialScene } from './initialScene.ts';
import { createPrefabGeometry } from './prefabs.ts';

const scene = createInitialScene();
const groupCells = (id: string) => {
  const parts = new Set(scene.parts.filter(part => part.groupId === id).map(part => part.id));
  return scene.voxels.filter(voxel => parts.has(voxel.partId));
};

test('starter landmarks occupy separate areas of the enlarged meadow with clear space between silhouettes', () => {
  const bounds = ['home', 'tree-back', 'tree-right'].map(id => {
    const cells = groupCells(id).map(voxel => voxel.cell);
    return { minX: Math.min(...cells.map(cell => cell.x)), maxX: Math.max(...cells.map(cell => cell.x)) + 1,
      minZ: Math.min(...cells.map(cell => cell.z)), maxZ: Math.max(...cells.map(cell => cell.z)) + 1 };
  });
  // This is a composition constraint, not a duplicate of the chosen anchor coordinates.
  assert.ok(Math.max(...bounds.map(b => b.maxX)) - Math.min(...bounds.map(b => b.minX)) >= 60);
  assert.ok(Math.max(...bounds.map(b => b.maxZ)) - Math.min(...bounds.map(b => b.minZ)) >= 40);
  for (let i = 0; i < bounds.length; i++) for (let j = i + 1; j < bounds.length; j++) {
    const a = bounds[i], b = bounds[j];
    const gapX = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
    const gapZ = Math.max(0, a.minZ - b.maxZ, b.minZ - a.maxZ);
    assert.ok(Math.hypot(gapX, gapZ) >= 16, 'keep an open area between each house/tree footprint');
  }
});

test('starter arrangement preserves every prefab cell and color without decorations overwriting models', () => {
  for (const [id, kind] of [['home', 'house'], ['tree-back', 'tree'], ['tree-right', 'tree'], ['duck', 'duck'],
    ['flowers-left', 'flowers'], ['flowers-right', 'flowers']] as const) {
    const origin = scene.parts.find(part => part.groupId === id)!.origin;
    const expected = createPrefabGeometry({ op: 'add_prefab', id, name: id, prefab: kind, origin });
    const actual = new Map(groupCells(id).map(voxel => [`${voxel.cell.x - origin.x},${voxel.cell.y - origin.y},${voxel.cell.z - origin.z}`, voxel]));
    assert.equal(actual.size, expected.voxels.length, `${id} keeps its full geometry`);
    for (const voxel of expected.voxels) {
      const placed = actual.get(`${voxel.cell.x},${voxel.cell.y},${voxel.cell.z}`);
      assert.equal(placed?.partId, voxel.partId); assert.equal(placed?.color, voxel.color);
    }
  }
});

test('relocated ground plants stand on terrain and every lily floats on exposed water', () => {
  const occupied = new Map(scene.voxels.map(voxel => [`${voxel.cell.x},${voxel.cell.y},${voxel.cell.z}`, voxel]));
  const parts = new Map(scene.parts.map(part => [part.id, part]));
  const onGround = new Set(['home-floor', 'tree-back-trunk', 'tree-right-trunk', 'flowers-left-stems', 'flowers-right-stems', 'grass-tufts']);
  for (const voxel of scene.voxels) {
    const { x, y, z } = voxel.cell;
    const below = occupied.get(`${x},${y - 1},${z}`);
    if (voxel.partId === 'lily-pads') {
      assert.equal(parts.get(below?.partId ?? '')?.role, 'water', 'lilies stay above water, not buried in the island');
      assert.ok(!occupied.has(`${x},${y + 1},${z}`));
    }
    if (!onGround.has(voxel.partId)) continue;
    // Trunk branches are supported by the trunk; check ground-level cells, not overhanging branches.
    const part = parts.get(voxel.partId)!;
    if (part.id === 'grass-tufts') {
      if (below?.partId === part.id) continue;
    } else if (y !== part.origin.y) continue;
    assert.equal(parts.get(below?.partId ?? '')?.role, 'terrain', `${voxel.partId} must rest on terrain at ${x},${y},${z}`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Color, InstancedMesh, Matrix4, Mesh, Raycaster, Vector3 } from 'three';
import type { SceneSnapshot } from '../../../../packages/protocol/src/index.ts';
import { VoxelSurface } from './voxelSurface.ts';
import { VoxelSurfaceView } from './voxelSurfaceView.ts';
import { DROP_DURATION, VoxelMotion } from './voxelMotion.ts';

type Voxel = SceneSnapshot['voxels'][number];
const voxel = (id: number, x = 0, y = 0, z = 0, color = '#AA7733'): Voxel => ({ id, partId: 'object', cell: { x, y, z }, color });
const faces = (surface: VoxelSurface) => [...surface.chunks.values()].reduce((n, chunk) => n + chunk.faceCount, 0);
const cube = (size: number): Voxel[] => {
  const result: Voxel[] = [];
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) for (let z = 0; z < size; z++) result.push(voxel(result.length + 1, x, y, z));
  return result;
};

test('solid volumes retain all six exterior sides, omit interior faces, and reveal a carved cavity', () => {
  const surface = new VoxelSurface(), source = cube(3), before = structuredClone(source);
  try {
    surface.sync(source, new Set()); assert.equal(faces(surface), 54);
    const inner = source.find(v => v.cell.x === 1 && v.cell.y === 1 && v.cell.z === 1)!;
    surface.sync(source.filter(v => v.id !== inner.id), new Set()); assert.equal(faces(surface), 60);
    surface.sync(source, new Set()); assert.equal(faces(surface), 54);
    assert.deepEqual(source, before);
  } finally { surface.dispose(); }
});

test('negative chunk boundaries cull neighbours and local edits preserve remote geometry identity', () => {
  const surface = new VoxelSurface(), source = [voxel(1, -1), voxel(2), voxel(3, 128)];
  try {
    surface.sync(source, new Set()); assert.equal(faces(surface), 16);
    const far = surface.chunks.get('128,0,0')!, left = surface.chunks.get('-32,0,0')!;
    surface.sync([source[0], source[2]], new Set());
    assert.equal(faces(surface), 12); assert.notEqual(surface.chunks.get('-32,0,0'), left);
    assert.equal(surface.chunks.get('128,0,0'), far);
    assert.equal(surface.sync([source[2], source[0]].map(v => structuredClone(v)), new Set()).size, 0);
  } finally { surface.dispose(); }
});

test('recolor rebuilds only its page, preserves unit UVs and linear color, and releases replaced geometry', () => {
  const surface = new VoxelSurface(), source = [...cube(4), voxel(1000, 32)];
  try {
    surface.sync(source, new Set());
    const neighbour = surface.chunks.get('32,0,0')!;
    const old = surface.chunks.get('0,0,0')!; assert.equal(old.kind, 'surface');
    let disposed = 0; if (old.kind === 'surface') old.geometry.addEventListener('dispose', () => disposed++);
    const dirty = surface.sync([{ ...source[0], color: '#3366FF' }, ...source.slice(1)], new Set());
    assert.deepEqual([...dirty], ['0,0,0']); assert.equal(surface.chunks.get('32,0,0'), neighbour); assert.equal(disposed, 1);
    const chunk = surface.chunks.get('0,0,0')!; assert.equal(chunk.kind, 'surface');
    if (chunk.kind !== 'surface') throw new Error('expected a dense surface');
    const geometry = chunk.geometry, color = new Color('#3366FF');
    assert.ok(Math.abs(geometry.getAttribute('color').getX(0) - color.r) < 1e-7);
    assert.ok(Math.abs(geometry.getAttribute('color').getY(0) - color.g) < 1e-7);
    assert.equal(geometry.getAttribute('color').getZ(0), color.b);
    assert.ok([...geometry.getAttribute('uv').array].every(v => v === 0 || v === 1));
    assert.equal(faces(surface), 102);
  } finally { surface.dispose(); }
});

test('atomic ID swaps, full document replacement and empty scenes leave no stale occupancy', () => {
  const surface = new VoxelSurface();
  try {
    surface.sync([voxel(1), voxel(2, 1)], new Set());
    surface.sync([voxel(1, 1), voxel(2)], new Set()); assert.equal(faces(surface), 10);
    surface.sync([voxel(1, 200, 12, -100)], new Set()); assert.equal(faces(surface), 6);
    assert.equal(surface.chunks.size, 1);
    surface.sync([], new Set()); assert.equal(surface.chunks.size, 0);
  } finally { surface.dispose(); }
});

test('sparse pages retain shared cubes instead of allocating six faces per isolated voxel', () => {
  const surface = new VoxelSurface(), source = Array.from({ length: 8 }, (_, i) => voxel(i + 1, i * 3));
  try {
    surface.sync(source, new Set());
    const chunk = surface.chunks.get('0,0,0')!;
    assert.equal(chunk.kind, 'instances'); assert.equal(chunk.faceCount, 48);
    if (chunk.kind === 'instances') assert.deepEqual(chunk.voxels, source);
    surface.sync(cube(4), new Set()); assert.equal(surface.chunks.get('0,0,0')!.kind, 'surface');
    surface.sync(source, new Set()); assert.equal(surface.chunks.get('0,0,0')!.kind, 'instances');
  } finally { surface.dispose(); }
});

test('dense surface picks recover the exact outer cell after geometry merges into a chunk', () => {
  const view = new VoxelSurfaceView(), motion = new VoxelMotion(), source = cube(3);
  try {
    motion.sync(source, false, 0); view.sync(source, motion); view.group.updateMatrixWorld(true);
    assert.equal(view.surface.chunks.get('0,0,0')!.kind, 'surface');
    for (const normal of [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, -1, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1)]) {
      const center = new Vector3(1.5, 1.5, 1.5);
      const hit = new Raycaster(center.addScaledVector(normal, 5), normal.clone().negate()).intersectObject(view.group, true)[0];
      const cell = hit.point.clone().addScaledVector(normal, -0.01).floor();
      const expected = source.find(v => v.cell.x === cell.x && v.cell.y === cell.y && v.cell.z === cell.z)!;
      assert.equal(view.pick(hit)?.voxelId, expected.id);
      assert.deepEqual(view.pick(hit)?.normal, { x: normal.x, y: normal.y, z: normal.z });
    }
  } finally { view.dispose(); motion.dispose(); }
});

test('all six ray directions map exterior triangles to original voxel IDs and outward normals', () => {
  const view = new VoxelSurfaceView(), motion = new VoxelMotion(), source = [voxel(72, -32, 2, 32)];
  try {
    motion.sync(source, false, 0); view.sync(source, motion); view.group.updateMatrixWorld(true);
    const center = new Vector3(-31.5, 2.5, 32.5);
    for (const normal of [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, -1, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1)]) {
      const hit = new Raycaster(center.clone().addScaledVector(normal, 4), normal.clone().negate()).intersectObject(view.group, true)[0];
      assert.ok(hit); const pick = view.pick(hit);
      assert.equal(pick?.voxelId, 72); assert.deepEqual(pick?.normal, { x: normal.x, y: normal.y, z: normal.z });
    }
  } finally { view.dispose(); motion.dispose(); }
});

test('animated neighbours expose static faces until settling; later batches settle independently', () => {
  const view = new VoxelSurfaceView(), motion = new VoxelMotion();
  try {
    const first = [voxel(1)]; motion.sync(first, false, 0); view.sync(first, motion);
    const second = [...first, voxel(2, 1)]; motion.sync(second, true, 10); view.sync(second, motion);
    assert.equal(faces(view.surface), 6);
    const moving = view.group.children.find(v => v.name === 'Moving voxels') as InstancedMesh;
    assert.equal(moving.count, 1);
    const matrix = new Matrix4(); moving.getMatrixAt(0, matrix);
    assert.ok(Math.abs(matrix.elements[13] - 1.4) < 1e-6);
    const third = [...second, voxel(3, 32)]; motion.sync(third, true, 810); view.sync(third, motion);
    view.advance(motion.advance(10 + DROP_DURATION), motion);
    assert.equal(faces(view.surface), 10);
    assert.equal((view.group.children.find(v => v.name === 'Moving voxels') as InstancedMesh).count, 1);
    view.advance(motion.advance(810 + DROP_DURATION), motion);
    assert.equal(faces(view.surface), 16); assert.ok(view.group.children.every(v => !(v.name === 'Moving voxels')));
    assert.deepEqual(third[1], voxel(2, 1));
  } finally { view.dispose(); motion.dispose(); }
});

test('moving, cancel by document replacement and reduced motion preserve current geometry and release GPU objects', () => {
  const view = new VoxelSurfaceView(), motion = new VoxelMotion();
  const source = [voxel(1), voxel(2, 1)];
  motion.sync(source, false, 0); view.sync(source, motion);
  motion.sync([voxel(1), voxel(2, 8)], true, 10); view.sync([voxel(1), voxel(2, 8)], motion);
  assert.equal(faces(view.surface), 6);
  let movingDisposed = 0;
  view.group.children.find(v => v.name === 'Moving voxels')!.addEventListener('dispose', () => movingDisposed++);
  motion.finish(); view.sync([voxel(1), voxel(2, 8)], motion);
  assert.equal(faces(view.surface), 12); assert.equal(movingDisposed, 1);
  motion.dispose(); motion.sync(source, false, 0); view.sync(source, motion);
  assert.equal(faces(view.surface), 10);
  motion.sync(cube(4), false, 0); view.sync(cube(4), motion);
  let geometryDisposed = 0, materialDisposed = 0, textureDisposed = 0;
  const mesh = view.group.children.find(v => v.name.startsWith('Voxel surface')) as Mesh;
  mesh.geometry.addEventListener('dispose', () => geometryDisposed++);
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  material.addEventListener('dispose', () => materialDisposed++);
  if ('map' in material) (material.map as import('three').Texture).addEventListener('dispose', () => textureDisposed++);
  view.dispose(); motion.dispose();
  assert.equal(view.group.children.length, 0); assert.equal(geometryDisposed, 1); assert.equal(materialDisposed, 1); assert.equal(textureDisposed, 1);
});

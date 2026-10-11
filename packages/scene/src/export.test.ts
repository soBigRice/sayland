import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExportMeshes, inspectExport, selectExportSnapshot, type ExportMesh, type Point } from './export.ts';
import { createInitialScene } from './initialScene.ts';
import type { SceneSnapshot } from '../../protocol/src/index.ts';

function fixture(cells: Point[], colors: string[] = []): SceneSnapshot {
  return { schemaVersion: 2, revision: 0, model: { id: 'test', name: '测试' }, source: null,
    grid: { cellSize: 1, up: '+Y', front: '+Z', coordinates: 'minimum-corner' },
    groups: [], parts: [{ id: 'piece', name: '部件', role: 'other', origin: { x: 0, y: 0, z: 0 } }],
    voxels: cells.map(([x,y,z], i) => ({ id: i + 1, partId: 'piece', cell: { x,y,z }, color: colors[i] ?? '#AABBCC' })) };
}
const options = { scope: { kind: 'all' as const }, millimetersPerVoxel: 2 };
function checkClosed(mesh: ExportMesh) {
  const edges = new Map<string, { count: number; direction: number }>();
  let volume = 0;
  for (const triangle of mesh.triangles) {
    const [a,b,c] = triangle.map(index => mesh.vertices[index]);
    volume += (a[0]*(b[1]*c[2]-b[2]*c[1]) + a[1]*(b[2]*c[0]-b[0]*c[2]) + a[2]*(b[0]*c[1]-b[1]*c[0])) / 6;
    for (let i = 0; i < 3; i++) {
      const x = triangle[i], y = triangle[(i+1)%3], k = `${Math.min(x,y)}/${Math.max(x,y)}`;
      const edge = edges.get(k) ?? { count: 0, direction: 0 }; edge.count++; edge.direction += x < y ? 1 : -1; edges.set(k, edge);
    }
  }
  for (const edge of edges.values()) { assert.equal(edge.count, 2); assert.equal(edge.direction, 0); }
  return volume;
}

test('every 2x2x2 occupancy including edge/point contact has closed, outward surfaces and exact volume', () => {
  for (let mask = 1; mask < 256; mask++) {
    const cells: Point[] = [];
    for (let i = 0; i < 8; i++) if (mask & 1 << i) cells.push([i & 1, (i >> 1) & 1, (i >> 2) & 1]);
    const meshes = buildExportMeshes(inspectExport(fixture(cells), options));
    assert.ok(Math.abs(meshes.reduce((sum, mesh) => sum + checkClosed(mesh), 0) - cells.length) < 1e-6, `volume mask ${mask}`);
  }
});
test('removes internal same-material faces but preserves closed color interfaces', () => {
  const mono = buildExportMeshes(inspectExport(fixture([[0,0,0],[1,0,0]]), options));
  assert.equal(mono[0].triangles.length, 20);
  const color = buildExportMeshes(inspectExport(fixture([[0,0,0],[1,0,0]], ['#aabbcc', '#FF0000']), options));
  assert.equal(color.length, 2); color.forEach(mesh => { assert.equal(mesh.triangles.length, 12); assert.ok(Math.abs(checkClosed(mesh) - 1) < 1e-10); });
});
test('partial export uses explicit part membership, no source changes or unrelated objects', () => {
  const scene = createInitialScene(), before = JSON.stringify(scene);
  const selected = selectExportSnapshot(scene, { kind: 'parts', partIds: ['home-roof'] });
  assert.deepEqual(selected.parts.map(p => p.id), ['home-roof']);
  assert.deepEqual(selected.groups?.map(g => g.id), ['home']);
  assert.ok(selected.voxels.every(v => v.partId === 'home-roof'));
  assert.equal(JSON.stringify(scene), before);
  assert.throws(() => selectExportSnapshot(scene, { kind: 'parts', partIds: [] }), /至少选择/);
  assert.throws(() => selectExportSnapshot(scene, { kind: 'parts', partIds: ['missing'] }), /已变化/);
});
test('dimensions use all voxel corners and Y-up to print Z-up without independent part drops', () => {
  const info = inspectExport(fixture([[-20,-5,8],[-18,0,12]]), options);
  assert.deepEqual(info.dimensions, [6,10,12]);
  assert.equal(info.components, 2); assert.equal(info.floatingComponents, 1);
  assert.equal(info.unsupportedFaces, 1);
  assert.deepEqual(buildExportMeshes(info)[0].vertices.reduce((max, p) => p.map((n,i) => Math.max(n,max[i])) as Point, [0,0,0]), [3,6,5]);
});
test('export handles very large absolute positions by rebasing, rejects unrepresentable spans and scales', () => {
  const info = inspectExport(fixture([[Number.MAX_SAFE_INTEGER,0,0]]), options);
  assert.ok(Math.abs(checkClosed(buildExportMeshes(info)[0]) - 1) < 1e-10);
  assert.throws(() => inspectExport(fixture([[0,0,0],[2_000_000,0,0]]), options), /相距太远/);
  for (const scale of [NaN, Infinity, 0, -1, 101]) assert.throws(() => inspectExport(fixture([[0,0,0]]), { ...options, millimetersPerVoxel: scale }), /尺寸/);
});
test('complete starter island exports all material volume with manifold edges', () => {
  const scene = createInitialScene(), info = inspectExport(scene, options);
  const meshes = buildExportMeshes(info);
  const volume = meshes.reduce((sum, mesh) => sum + checkClosed(mesh), 0);
  assert.ok(Math.abs(volume - scene.voxels.length) < 1e-5);
  assert.equal(info.selected.voxels.length, scene.voxels.length);
  assert.deepEqual(new Set(meshes.map(m => m.partId)), new Set(scene.voxels.map(v => v.partId)));
});

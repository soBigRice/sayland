import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { createInitialScene } from '../../../../packages/scene/src/index.ts';
import { framePerspectiveScene, sceneObjectVoxels, updatePerspectiveRange } from './cameraFraming.ts';

const layouts = [
  { width: 1440, height: 900, frame: { left: 240, top: 150, width: 960, height: 600 } },
  { width: 390, height: 844, frame: { left: 12, top: 212, width: 366, height: 420 } },
  { width: 844, height: 390, frame: { left: 132, top: 80, width: 580, height: 230 } },
];

test('completion bounds include all scene objects but are not enlarged by distant terrain or water', () => {
  const snapshot = createInitialScene(), before = structuredClone(snapshot);
  snapshot.voxels.push({ id: 100000, partId: 'lagoon', cell: { x: 10000, y: 0, z: 10000 }, color: '#FFFFFF' });
  const objects = sceneObjectVoxels(snapshot);
  assert.ok(objects.some(voxel => voxel.partId === 'home-roof'));
  assert.ok(objects.some(voxel => voxel.partId === 'tree-back-leaves'));
  assert.ok(objects.some(voxel => voxel.partId === 'duck'));
  assert.ok(objects.every(voxel => !['lagoon', 'island-soil', 'island-grass', 'beach'].includes(voxel.partId)));
  const camera = new PerspectiveCamera(40, 1, 0.1, 500), layout = layouts[0];
  const currentDirection = new Vector3(-50, 32, -80).normalize();
  const fitted = framePerspectiveScene(camera, objects, layout, layout.frame, currentDirection);
  assert.ok(camera.position.clone().sub(fitted.target).normalize().distanceTo(currentDirection) < 1e-9);
  assert.ok(camera.position.distanceTo(fitted.target) < 200, 'distant environment cannot shrink the buildings');
  assert.deepEqual(snapshot.voxels.slice(0, -1), before.voxels);
  const terrainOnly = { ...snapshot, voxels: snapshot.voxels.filter(voxel => voxel.partId === 'lagoon') };
  assert.deepEqual(sceneObjectVoxels(terrainOnly), terrainOnly.voxels);
  assert.deepEqual(sceneObjectVoxels({ ...snapshot, voxels: [] }), []);
});
for (const layout of layouts) test(`perspective fits every occupied corner in the free frame at ${layout.width}x${layout.height}`, () => {
  const camera = new PerspectiveCamera(40, 1, 0.1, 500);
  const voxels = createInitialScene().voxels;
  const { target, minDistance, maxDistance } = framePerspectiveScene(camera, voxels, layout, layout.frame);
  assert.ok(camera.position.distanceTo(target) > minDistance);
  assert.ok(minDistance <= 12, 'large landscapes must still allow voxel-level close-up editing');
  assert.ok(camera.position.distanceTo(target) < maxDistance);
  const point = new Vector3();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { cell } of voxels) for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) {
    point.set(cell.x + x, cell.y + y, cell.z + z).project(camera);
    const px = (point.x + 1) * layout.width / 2, py = (1 - point.y) * layout.height / 2;
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    assert.ok(px >= layout.frame.left && px <= layout.frame.left + layout.frame.width);
    assert.ok(py >= layout.frame.top && py <= layout.frame.top + layout.frame.height);
    assert.ok(point.z > -1 && point.z < 1);
  }
  // The occupied silhouette, rather than its 3D pivot, is centered on the whole screen.
  assert.ok(Math.abs((minX + maxX) / 2 - layout.width / 2) < 1e-6);
  assert.ok(Math.abs((minY + maxY) / 2 - layout.height / 2) < 1e-6);
});

test('empty and distant scenes have finite perspective framing and valid clipping planes', () => {
  const layout = layouts[1];
  for (const voxels of [[], [-10000, 10000].map((n, id) => ({ id: id + 1, partId: 'edge', color: '#ffffff', cell: { x: n, y: n, z: n } }))]) {
    const camera = new PerspectiveCamera(40, 1, 0.1, 500);
    const fitted = framePerspectiveScene(camera, voxels, layout, layout.frame);
    assert.ok(camera.position.toArray().every(Number.isFinite));
    assert.ok(camera.near > 0 && camera.far > fitted.maxDistance);
    for (const voxel of voxels) assert.ok(Math.abs(new Vector3(voxel.cell.x, voxel.cell.y, voxel.cell.z).project(camera).z) < 1);
  }
});

test('distant edits extend clipping and zoom limits without changing current pose, pivot or view offset', () => {
  const camera = new PerspectiveCamera(40, 1, 0.1, 500), layout = layouts[0];
  const fitted = framePerspectiveScene(camera, createInitialScene().voxels, layout, layout.frame);
  const position = camera.position.clone(), rotation = camera.quaternion.clone();
  const target = fitted.target.clone(), view = structuredClone(camera.view);
  const voxel = { id: 1, partId: 'far', color: '#ffffff', cell: { x: 500, y: -200, z: 1000 } };
  const ranges = updatePerspectiveRange(camera, [voxel], target, fitted);
  assert.deepEqual(camera.position, position); assert.deepEqual(camera.quaternion.toArray(), rotation.toArray());
  assert.deepEqual(target, fitted.target); assert.deepEqual(camera.view, view);
  assert.equal(ranges.minDistance, fitted.minDistance); assert.ok(ranges.maxDistance > fitted.maxDistance);
  const distance = camera.position.distanceTo(target);
  assert.ok(ranges.minDistance <= distance && ranges.maxDistance >= distance);
  assert.ok(camera.far > camera.position.distanceTo(new Vector3(501, -199, 1001)));
  assert.ok(Number.isFinite(camera.far));
});

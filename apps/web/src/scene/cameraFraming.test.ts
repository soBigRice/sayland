import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { createInitialScene } from '../../../../packages/scene/src/index.ts';
import { framePerspectiveScene } from './cameraFraming.ts';

const layouts = [
  { width: 1440, height: 900, frame: { left: 90, top: 110, width: 960, height: 600 } },
  { width: 390, height: 844, frame: { left: 12, top: 175, width: 366, height: 420 } },
  { width: 844, height: 390, frame: { left: 80, top: 55, width: 580, height: 230 } },
];
for (const layout of layouts) test(`perspective fits every occupied corner in the free frame at ${layout.width}x${layout.height}`, () => {
  const camera = new PerspectiveCamera(40, 1, 0.1, 500);
  const voxels = createInitialScene().voxels;
  const { target, minDistance, maxDistance } = framePerspectiveScene(camera, voxels, layout, layout.frame);
  assert.ok(camera.position.distanceTo(target) > minDistance);
  assert.ok(camera.position.distanceTo(target) < maxDistance);
  const point = new Vector3();
  for (const { cell } of voxels) for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) {
    point.set(cell.x + x, cell.y + y, cell.z + z).project(camera);
    const px = (point.x + 1) * layout.width / 2, py = (1 - point.y) * layout.height / 2;
    assert.ok(px >= layout.frame.left && px <= layout.frame.left + layout.frame.width);
    assert.ok(py >= layout.frame.top && py <= layout.frame.top + layout.frame.height);
    assert.ok(point.z > -1 && point.z < 1);
  }
  // Off-axis framing must keep the orbit pivot at the same visible location.
  point.copy(target).project(camera);
  assert.ok(Math.abs((point.x + 1) * layout.width / 2 - layout.frame.left - layout.frame.width / 2) < 1e-6);
  assert.ok(Math.abs((1 - point.y) * layout.height / 2 - layout.frame.top - layout.frame.height / 2) < 1e-6);
});

test('empty and world-edge scenes have finite perspective framing and valid clipping planes', () => {
  const layout = layouts[1];
  for (const voxels of [[], [-128, 128].map((n, id) => ({ id: id + 1, partId: 'edge', color: '#ffffff', cell: { x: n, y: n, z: n } }))]) {
    const camera = new PerspectiveCamera(40, 1, 0.1, 500);
    const fitted = framePerspectiveScene(camera, voxels, layout, layout.frame);
    assert.ok(camera.position.toArray().every(Number.isFinite));
    assert.ok(camera.near > 0 && camera.far > fitted.maxDistance);
    for (const voxel of voxels) assert.ok(Math.abs(new Vector3(voxel.cell.x, voxel.cell.y, voxel.cell.z).project(camera).z) < 1);
  }
});

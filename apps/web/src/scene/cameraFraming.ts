import { Box3, PerspectiveCamera, Vector3 } from 'three';
import type { SceneSnapshot } from '../../../../packages/protocol/src/index.ts';

type Frame = { left: number; top: number; width: number; height: number };

/** Fit actual voxel corners into the UI's free area without moving the orbit target off the island. */
export function framePerspectiveScene(camera: PerspectiveCamera, voxels: SceneSnapshot['voxels'], viewport: { width: number; height: number }, frame: Frame) {
  const bounds = new Box3(), point = new Vector3();
  for (const { cell } of voxels) {
    bounds.expandByPoint(point.set(cell.x, cell.y, cell.z));
    bounds.expandByPoint(point.set(cell.x + 1, cell.y + 1, cell.z + 1));
  }
  if (bounds.isEmpty()) bounds.set(new Vector3(-12, -1, -12), new Vector3(12, 12, 12));
  const target = bounds.getCenter(new Vector3());
  const direction = new Vector3(48, 39, 56).normalize();
  camera.position.copy(target).add(direction); camera.lookAt(target); camera.updateMatrixWorld(true);
  const rotation = camera.quaternion.clone().invert();
  const width = Math.max(1, viewport.width), height = Math.max(1, viewport.height);
  camera.zoom = 1; camera.aspect = width / height;
  const tanY = Math.tan(camera.fov * Math.PI / 360);
  const usableX = tanY * camera.aspect * Math.max(1, frame.width) / width * 0.91;
  const usableY = tanY * Math.max(1, frame.height) / height * 0.91;
  let distance = 1;
  const includeCorner = (x: number, y: number, z: number) => {
    point.set(x, y, z).sub(target).applyQuaternion(rotation);
    // Perspective depth varies across the object: both side-plane inequalities must hold.
    distance = Math.max(distance, point.z + Math.abs(point.x) / usableX, point.z + Math.abs(point.y) / usableY, point.z + camera.near * 2);
  };
  if (voxels.length) for (const { cell } of voxels) {
    for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) includeCorner(cell.x + x, cell.y + y, cell.z + z);
  } else {
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) includeCorner(x, y, z);
  }
  camera.position.copy(target).addScaledVector(direction, distance);
  // An off-axis frustum centers the island in the free frame while the canvas stays full-screen.
  camera.setViewOffset(width, height, width / 2 - (frame.left + frame.width / 2), height / 2 - (frame.top + frame.height / 2), width, height);
  const minDistance = distance / 3.5, maxDistance = distance / 0.55;
  camera.far = Math.max(500, maxDistance + bounds.getSize(point).length() + 100);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  return { target, minDistance, maxDistance };
}

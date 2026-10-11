import { Box3, PerspectiveCamera, Vector3 } from 'three';
import type { SceneSnapshot } from '../../../../packages/protocol/src/index.ts';

type Frame = { left: number; top: number; width: number; height: number };

/** Only authored objects drive completion framing. Ground/water remain visible but do not dominate its bounds. */
export function sceneObjectVoxels(snapshot: SceneSnapshot): SceneSnapshot['voxels'] {
  const environment = new Set(snapshot.parts.filter(part => part.role === 'terrain' || part.role === 'water').map(part => part.id));
  const objects = snapshot.voxels.filter(voxel => !environment.has(voxel.partId));
  // A terrain-only or empty creation still needs a useful, finite view.
  return objects.length ? objects : snapshot.voxels;
}

/** Extend navigation/clipping for edits without moving the camera or its orbit pivot. */
export function updatePerspectiveRange(camera: PerspectiveCamera, voxels: SceneSnapshot['voxels'], target: Vector3,
  limits: { minDistance: number; maxDistance: number }) {
  let radius = 1;
  const point = new Vector3();
  for (const { cell } of voxels) {
    for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) {
      radius = Math.max(radius, point.set(cell.x + x, cell.y + y, cell.z + z).distanceTo(target));
    }
  }
  const distance = camera.position.distanceTo(target);
  // Keep the current distance legal. A distant addition must not force an orbit jump.
  const minDistance = Math.min(limits.minDistance, distance);
  const maxDistance = Math.max(limits.maxDistance, distance, radius * 3.5);
  camera.far = Math.max(500, maxDistance + radius + 100);
  camera.updateProjectionMatrix();
  return { minDistance, maxDistance };
}

/** Fit and center the projected silhouette; the orbit pivot remains inside the actual scene. */
export function framePerspectiveScene(camera: PerspectiveCamera, voxels: SceneSnapshot['voxels'], viewport: { width: number; height: number }, frame: Frame,
  viewingDirection = new Vector3(48, 39, 56)) {
  const bounds = new Box3(), point = new Vector3();
  for (const { cell } of voxels) {
    bounds.expandByPoint(point.set(cell.x, cell.y, cell.z));
    bounds.expandByPoint(point.set(cell.x + 1, cell.y + 1, cell.z + 1));
  }
  if (bounds.isEmpty()) bounds.set(new Vector3(-12, -1, -12), new Vector3(12, 12, 12));
  const target = bounds.getCenter(new Vector3());
  const direction = viewingDirection.clone();
  if (!direction.lengthSq()) direction.set(48, 39, 56);
  direction.normalize();
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
  // A 3D bounds center is not the visual center under perspective (e.g. a tall chimney above a wide island).
  // Center the actual projected extrema, while preserving the orbit target and complete silhouette.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const projectCorner = (x: number, y: number, z: number) => {
    point.set(x, y, z).sub(target).applyQuaternion(rotation);
    const depth = distance - point.z;
    const px = point.x / (depth * tanY * camera.aspect), py = point.y / (depth * tanY);
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  };
  if (voxels.length) for (const { cell } of voxels) {
    for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) projectCorner(cell.x + x, cell.y + y, cell.z + z);
  } else {
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) projectCorner(x, y, z);
  }
  camera.setViewOffset(width, height,
    width / 2 - (frame.left + frame.width / 2) + (minX + maxX) * width / 4,
    height / 2 - (frame.top + frame.height / 2) - (minY + maxY) * height / 4, width, height);
  // A bigger landscape must still allow close-up work on individual voxels.
  const minDistance = Math.min(12, distance / 3.5), maxDistance = distance / 0.55;
  camera.far = Math.max(500, maxDistance + bounds.getSize(point).length() + 100);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  return { target, minDistance, maxDistance };
}

import type { SceneSnapshot } from '../../../../packages/protocol/src/index.ts';

/** Follow the objects changed in this received batch, never unrelated scenery. */
export function changedSceneVoxels(before: SceneSnapshot, after: SceneSnapshot): SceneSnapshot['voxels'] {
  const previous = new Map(before.voxels.map(voxel => [voxel.id, voxel]));
  const current = new Map(after.voxels.map(voxel => [voxel.id, voxel]));
  const parts = new Map(after.parts.map(part => [part.id, part]));
  const oldParts = new Map(before.parts.map(part => [part.id, part]));
  const groups = new Set<string>(), partIds = new Set<string>(), cells = new Set<number>();
  const removed: SceneSnapshot['voxels'] = [];
  const include = (voxel: SceneSnapshot['voxels'][number], deleted = false) => {
    const part = parts.get(voxel.partId) ?? oldParts.get(voxel.partId);
    // A small river/ground edit must not pull the camera back to the entire landscape.
    if (part?.role === 'terrain' || part?.role === 'water') {
      if (deleted) removed.push(voxel); else cells.add(voxel.id);
    } else {
      if (part?.groupId) groups.add(part.groupId); else partIds.add(voxel.partId);
      if (deleted) removed.push(voxel);
    }
  };
  for (const voxel of after.voxels) {
    const old = previous.get(voxel.id);
    if (!old || old.color !== voxel.color || old.cell.x !== voxel.cell.x || old.cell.y !== voxel.cell.y || old.cell.z !== voxel.cell.z) include(voxel);
  }
  for (const voxel of before.voxels) if (!current.has(voxel.id)) include(voxel, true);
  const focused = after.voxels.filter(voxel => {
    if (cells.has(voxel.id) || partIds.has(voxel.partId)) return true;
    const part = parts.get(voxel.partId);
    return part?.role !== 'terrain' && part?.role !== 'water' && Boolean(part?.groupId && groups.has(part.groupId));
  });
  // Deleted objects have no current silhouette; retain their former location as the focus.
  return focused.length ? focused : removed;
}

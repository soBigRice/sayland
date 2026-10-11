import type { SceneSnapshot } from '../../../packages/protocol/src/index.ts';
import type { ViewsQuery } from './geometry-views.ts';

/** Compare actual ACK snapshots, not operation names: removals, recolors and compiled placements all count. */
export function changedObjectViews(before: SceneSnapshot, after: SceneSnapshot): ViewsQuery[] {
  const previous = new Map(before.voxels.map(voxel => [voxel.id, voxel]));
  const changedParts = new Set<string>();
  for (const voxel of after.voxels) {
    const old = previous.get(voxel.id);
    if (!old || old.partId !== voxel.partId || old.color !== voxel.color
      || old.cell.x !== voxel.cell.x || old.cell.y !== voxel.cell.y || old.cell.z !== voxel.cell.z) {
      changedParts.add(voxel.partId);
      if (old) changedParts.add(old.partId);
    }
    previous.delete(voxel.id);
  }
  for (const removed of previous.values()) changedParts.add(removed.partId);
  const groups = new Set(after.groups?.map(group => group.id));
  const affectedGroups = new Set<string>();
  // Include the remaining body when a removed appendage no longer exists in after.parts.
  for (const part of [...before.parts, ...after.parts]) {
    if (changedParts.has(part.id) && part.groupId && groups.has(part.groupId)) affectedGroups.add(part.groupId);
  }
  const occupied = new Set(after.voxels.map(voxel => voxel.partId));
  const scopes = new Map<string, ViewsQuery>();
  for (const part of after.parts) {
    if (!occupied.has(part.id)) continue;
    const groupId = part.groupId && affectedGroups.has(part.groupId) ? part.groupId : null;
    if (!groupId && !changedParts.has(part.id)) continue;
    // Frame each complete object independently so the island cannot shrink a small object into a few pixels.
    scopes.set(groupId ? `group:${groupId}` : `part:${part.id}`, {
      revision: after.revision, groupIds: groupId ? [groupId] : null, partIds: groupId ? null : [part.id], region: null,
    });
  }
  return [...scopes.values()];
}

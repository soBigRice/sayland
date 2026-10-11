import type { SceneBatch, SceneSnapshot } from '../../../packages/protocol/src/index.ts';
import type { PlanDiagnostic } from './errors.ts';

/** Existing legacy parts may stay ungrouped; AI-created identities need explicit membership. */
export function newPartGroupingIssue(before: SceneSnapshot, after: SceneSnapshot, batch: SceneBatch): PlanDiagnostic | undefined {
  const inherited = new Map(before.parts.map(part => [part.id, part.groupId ?? null]));
  for (const operation of batch.operations) {
    if (operation.op === 'clear_scene') inherited.clear();
    if (operation.op === 'remove_part') inherited.delete(operation.partId);
    // Omitted groupId on an existing part preserves membership, matching the shared engine contract.
    if (operation.op === 'define_part' && inherited.has(operation.part.id) && operation.part.groupId !== undefined) inherited.set(operation.part.id, operation.part.groupId);
    if (operation.op === 'assign_part_group' && inherited.has(operation.partId)) inherited.set(operation.partId, operation.groupId);
    // Removed group members recreated with the same IDs are new identities as well.
    if (operation.op === 'remove_group') {
      for (const [id, groupId] of inherited) if (groupId === operation.groupId) inherited.delete(id);
    }
  }
  const groups = new Set((after.groups ?? []).map(group => group.id));
  const missing = after.parts.filter(part => !inherited.has(part.id) && (!part.groupId || !groups.has(part.groupId)));
  if (!missing.length) return;
  const first = missing[0];
  const operationIndex = batch.operations.findIndex(operation => operation.op === 'define_part' && operation.part.id === first.id);
  return {
    kind: 'schema', code: 'GROUP_REQUIRED',
    message: '新生成的AI部件必须明确归属有效物件组。先define_group，再在define_part中设置groupId或使用assign_part_group。独立物件分别建组，不能把同轮无关物件合成一组；已有未归组部件可保持。请保留全部原目标并重写完整批次。',
    ...(operationIndex >= 0 ? { operationIndex, operation: { op: 'define_part', part: {
      id: first.id, origin: first.origin, role: first.role, groupId: first.groupId ?? null,
    } } } : {}),
    partIds: missing.slice(0, 16).map(part => part.id), partCount: missing.length, partIdsComplete: missing.length <= 16,
  };
}

// The active UI reads server-owned scenes; legacy turn helpers remain for protocol compatibility tests.
export * from './workshopTurn.ts';
export { projectSchema } from '../../../../packages/protocol/src/workspace.ts';
export { useWorkspaceWorkshop as useWorkshop } from './useWorkspaceWorkshop.ts';

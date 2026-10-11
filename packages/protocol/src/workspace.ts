import { z } from 'zod';
import { batchSchema } from './index.ts';

export const savedMessageSchema = z.object({ id: z.string().max(200), role: z.enum(['user', 'assistant']), text: z.string().max(5000), kind: z.literal('progress').optional(), status: z.enum(['pending', 'error']).optional() });
export const projectSchema = z.object({ format: z.literal('sayland-project'), version: z.literal(1), engine: z.unknown(), messages: z.array(savedMessageSchema).max(100), speakerEnabled: z.boolean(), draft: z.string().max(1500).optional() });
export type Project = z.infer<typeof projectSchema>;
export type SavedMessage = z.infer<typeof savedMessageSchema>;
export const workspaceId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
export const scenePreviewSchema = z.object({
  revision: z.number().int().nonnegative(), resetKey: z.number().int().nonnegative(),
  image: z.string().max(1_400_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/),
  viewKey: z.string().min(1).max(1200).optional(),
}).strict();
export type ScenePreview = z.infer<typeof scenePreviewSchema>;
export interface PreviewSummary { key: string; revision: number; resetKey: number; updatedAt: number; viewKey?: string }
export const createSceneSchema = z.object({ id: workspaceId, name: z.string().trim().min(1).max(32), template: z.enum(['empty', 'island']), project: projectSchema.optional() }).strict();
export const enqueueTaskSchema = z.object({ id: workspaceId, text: z.string().trim().min(1).max(1500) }).strict();
export const sceneCommandSchema = z.object({ id: workspaceId, version: z.number().int().nonnegative(), action: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('batch'), operations: batchSchema.shape.operations }).strict(),
  z.object({ kind: z.literal('rename'), name: z.string().trim().min(1).max(32) }).strict(),
  z.object({ kind: z.literal('undo') }).strict(), z.object({ kind: z.literal('redo') }).strict(),
  z.object({ kind: z.literal('reset') }).strict(),
  z.object({ kind: z.literal('import'), project: projectSchema }).strict(),
]) }).strict();
export type SceneCommand = z.infer<typeof sceneCommandSchema>;
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface WorkspaceTask {
  id: string; sceneId: string; text: string; status: TaskStatus; phase: string;
  committedBatches: number; reply?: string; error?: string; createdAt: number; updatedAt: number;
  activity: { id: number; kind: 'stage' | 'message' | 'result'; text: string }[];
}
export interface SceneSummary { id: string; name: string; template: 'empty' | 'island'; version: number; resetKey: number; updatedAt: number; voxelCount: number; preview?: PreviewSummary }
export interface SceneView { scene: SceneSummary; project?: Project; tasks: WorkspaceTask[] }
export interface WorkspaceView { scenes: SceneSummary[]; tasks: WorkspaceTask[] }
export const taskIsActive = (task: WorkspaceTask) => task.status === 'queued' || task.status === 'running';

/** Preserve complete conversation turns within the version-1 export limit. */
export function boundMessages(messages: SavedMessage[]): SavedMessage[] {
  while (messages.length > 100) {
    const next = messages.findIndex((message, index) => index > 0 && message.role === 'user');
    if (next < 0) return messages.slice(-100);
    messages = messages.slice(next);
  }
  return messages;
}

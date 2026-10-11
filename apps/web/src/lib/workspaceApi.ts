import type { PreviewSummary, Project, SceneCommand, ScenePreview, SceneView, WorkspaceTask, WorkspaceView } from '../../../../packages/protocol/src/workspace.ts';
import { apiFetch, jsonRequest } from './api.ts';

const post = <T>(path: string, data: unknown) => jsonRequest<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
export const readWorkspace = (signal?: AbortSignal) => jsonRequest<WorkspaceView>('/api/workspace', { signal });
export async function scenePreviewKey(preview: ScenePreview): Promise<string> {
  const prefix = new TextEncoder().encode(`${preview.resetKey}:${preview.revision}:`);
  const png = Uint8Array.from(atob(preview.image.slice('data:image/png;base64,'.length)), char => char.charCodeAt(0));
  const bytes = new Uint8Array(prefix.length + png.length); bytes.set(prefix); bytes.set(png, prefix.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export const saveScenePreview = (id: string, preview: ScenePreview) => jsonRequest<PreviewSummary>(`/api/scenes/${encodeURIComponent(id)}/preview`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preview), signal: AbortSignal.timeout(8000),
});
export async function readScenePreview(id: string, key: string, signal: AbortSignal): Promise<Blob> {
  const response = await apiFetch(`/api/scenes/${encodeURIComponent(id)}/preview?version=${encodeURIComponent(key)}`, { signal });
  if (!response.ok) throw new Error('暂时无法读取场景缩略图。');
  return response.blob();
}
export const bootstrapWorkspace = (project?: Project) => post<SceneView | null>('/api/workspace/bootstrap', project ? { project } : {});
export const readScene = (id: string, since?: number, signal?: AbortSignal, geometry?: string) => jsonRequest<SceneView>(`/api/scenes/${encodeURIComponent(id)}?${new URLSearchParams({ ...(since === undefined ? {} : { since: String(since) }), ...(geometry ? { geometry } : {}) })}`, { signal });
export const createScene = (id: string, name: string, template: 'empty' | 'island') => post<SceneView>('/api/scenes', { id, name, template });
export const deleteScene = (id: string) => jsonRequest<{ ok: true }>(`/api/scenes/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) });
export const commandScene = (id: string, command: SceneCommand) => post<SceneView>(`/api/scenes/${encodeURIComponent(id)}/commands`, command);
export const saveScenePreferences = (id: string, data: { draft?: string; speakerEnabled?: boolean }) => jsonRequest<{ ok: true }>(`/api/scenes/${encodeURIComponent(id)}/preferences`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), keepalive: true });
export const enqueueTask = (sceneId: string, id: string, text: string) => post<WorkspaceTask>(`/api/scenes/${encodeURIComponent(sceneId)}/tasks`, { id, text });
export const stopTask = (id: string) => post<WorkspaceTask>(`/api/tasks/${encodeURIComponent(id)}/cancel`, {});
export const readTaskDiagnostics = (id: string, signal: AbortSignal) => jsonRequest<unknown>(`/api/tasks/${encodeURIComponent(id)}`, { signal });

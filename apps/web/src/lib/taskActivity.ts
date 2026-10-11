export type ActivityStatus = 'running' | 'completed' | 'stopped' | 'failed';
export type ActivityKind = 'stage' | 'message' | 'result';
export interface ActivityEntry { id: number; kind: ActivityKind; text: string }
export interface TaskActivity { requestId: string; status: ActivityStatus; entries: ActivityEntry[]; nextId: number }
export const MAX_ACTIVITY_ENTRIES = 16;

export function startTaskActivity(requestId: string): TaskActivity {
  return { requestId, status: 'running', entries: [{ id: 0, kind: 'stage', text: '收到你的想法，开始准备…' }], nextId: 1 };
}

/** Display-only trace: ignore repeated keepalives and late events from a stopped/older turn. */
export function recordTaskActivity(current: TaskActivity | null, requestId: string,
  event: { kind: ActivityKind; text: string; status?: Exclude<ActivityStatus, 'running'> }): TaskActivity | null {
  if (!current || current.requestId !== requestId || current.status !== 'running') return current;
  const text = event.text.trim();
  if (!text) return current;
  const last = current.entries.at(-1);
  if (!event.status && last?.kind === event.kind && last.text === text) return current;
  return { ...current, status: event.status ?? 'running', nextId: current.nextId + 1,
    entries: [...current.entries, { id: current.nextId, kind: event.kind, text }].slice(-MAX_ACTIVITY_ENTRIES) };
}

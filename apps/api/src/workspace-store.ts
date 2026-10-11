import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PreviewSummary, Project, SceneSummary, WorkspaceTask } from '../../../packages/protocol/src/workspace.ts';
import type { PlanTrace } from './errors.ts';

export interface StoredScene extends SceneSummary { project: Project }
export interface StoredTask extends WorkspaceTask { diagnostics?: PlanTrace }
type SceneRow = { id: string; name: string; template: 'empty' | 'island'; version: number; reset_key: number; updated_at: number; voxel_count: number; project: string };

/** One API process owns this local database. Scene + task changes share a transaction. */
export class WorkspaceStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS scenes (id TEXT PRIMARY KEY, name TEXT NOT NULL, template TEXT NOT NULL, version INTEGER NOT NULL, reset_key INTEGER NOT NULL, updated_at INTEGER NOT NULL, voxel_count INTEGER NOT NULL, project TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, scene_id TEXT NOT NULL REFERENCES scenes(id), status TEXT NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_queue ON tasks(status, sequence);
      CREATE INDEX IF NOT EXISTS scene_tasks ON tasks(scene_id, sequence);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, scene_id TEXT NOT NULL REFERENCES scenes(id), fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scene_previews (scene_id TEXT PRIMARY KEY REFERENCES scenes(id), metadata TEXT NOT NULL, image BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS deleted_scenes (id TEXT PRIMARY KEY);
      PRAGMA user_version = 1;`);
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  listScenes(): SceneSummary[] {
    const previews = new Map(this.db.prepare('SELECT scene_id, metadata FROM scene_previews').all().map(row => [row.scene_id as string, JSON.parse(row.metadata as string) as PreviewSummary]));
    return (this.db.prepare('SELECT id, name, template, version, reset_key, updated_at, voxel_count FROM scenes ORDER BY updated_at DESC, id').all() as unknown as SceneRow[]).map(row => ({ ...this.summary(row), ...(previews.has(row.id) ? { preview: previews.get(row.id)! } : {}) }));
  }
  putPreview(id: string, metadata: PreviewSummary, image: Buffer): void {
    this.db.prepare('INSERT INTO scene_previews VALUES (?, ?, ?) ON CONFLICT(scene_id) DO UPDATE SET metadata=excluded.metadata, image=excluded.image').run(id, JSON.stringify(metadata), image);
  }
  getPreview(id: string): { metadata: PreviewSummary; image: Buffer } | undefined {
    const row = this.db.prepare('SELECT metadata, image FROM scene_previews WHERE scene_id = ?').get(id);
    return row ? { metadata: JSON.parse(row.metadata as string) as PreviewSummary, image: Buffer.from(row.image as Uint8Array) } : undefined;
  }
  private summary(row: SceneRow): SceneSummary {
    return { id: row.id, name: row.name, template: row.template, version: row.version, resetKey: row.reset_key, updatedAt: row.updated_at, voxelCount: row.voxel_count };
  }
  getScene(id: string): StoredScene | undefined {
    const row = this.db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as unknown as SceneRow | undefined;
    return row && { ...this.summary(row), project: JSON.parse(row.project) as Project };
  }
  putScene(scene: StoredScene): void {
    this.db.prepare(`INSERT INTO scenes VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, reset_key=excluded.reset_key, updated_at=excluded.updated_at, voxel_count=excluded.voxel_count, project=excluded.project`)
      .run(scene.id, scene.name, scene.template, scene.version, scene.resetKey, scene.updatedAt, scene.voxelCount, JSON.stringify(scene.project));
  }
  isDeleted(id: string): boolean { return Boolean(this.db.prepare('SELECT id FROM deleted_scenes WHERE id = ?').get(id)); }
  deleteScene(id: string): void {
    this.transaction(() => {
      // Retain only the ID so a delayed create/import cannot resurrect deleted project data.
      this.db.prepare('INSERT OR IGNORE INTO deleted_scenes SELECT id FROM scenes WHERE id = ?').run(id);
      for (const table of ['scene_previews', 'commands', 'tasks']) this.db.prepare(`DELETE FROM ${table} WHERE scene_id = ?`).run(id);
      this.db.prepare('DELETE FROM scenes WHERE id = ?').run(id);
    });
  }
  getTask(id: string): StoredTask | undefined {
    const row = this.db.prepare('SELECT document FROM tasks WHERE id = ?').get(id);
    return row ? JSON.parse(row.document as string) as StoredTask : undefined;
  }
  tasks(sceneId?: string, activeOnly = false): StoredTask[] {
    // Active tasks are never hidden by the bounded recent-history window.
    const filter = sceneId ? 'scene_id = ? AND ' : '';
    const args = sceneId ? [sceneId] : [];
    const rows = this.db.prepare(`SELECT document FROM tasks WHERE ${filter}status IN ('queued', 'running') ORDER BY sequence`).all(...args);
    if (!activeOnly) rows.push(...this.db.prepare(`SELECT document FROM tasks WHERE ${filter}status NOT IN ('queued', 'running') ORDER BY sequence DESC LIMIT 40`).all(...args));
    return rows.map(row => JSON.parse(row.document as string) as StoredTask);
  }
  putTask(task: StoredTask): void {
    this.db.prepare(`INSERT INTO tasks(id, scene_id, status, document) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, document=excluded.document`)
      .run(task.id, task.sceneId, task.status, JSON.stringify(task));
  }
  command(id: string): { scene_id: string; fingerprint: string } | undefined {
    return this.db.prepare('SELECT scene_id, fingerprint FROM commands WHERE id = ?').get(id) as { scene_id: string; fingerprint: string } | undefined;
  }
  rememberCommand(id: string, sceneId: string, fingerprint: string): void {
    this.db.prepare('INSERT INTO commands VALUES (?, ?, ?)').run(id, sceneId, fingerprint);
  }
  close(): void { this.db.close(); }
}

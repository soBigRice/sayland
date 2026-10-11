import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.ts';
import type { ApiConfig } from '../src/config.ts';
import type { Providers } from '../src/providers.ts';
import { VoxelEngine } from '../../../packages/scene/src/index.ts';
import type { SceneBatch, SceneSnapshot } from '../../../packages/protocol/src/index.ts';
import type { SceneView, WorkspaceView, Project } from '../../../packages/protocol/src/workspace.ts';
import { WorkspaceStore, type StoredTask } from '../src/workspace-store.ts';
import { BackgroundWorkspace } from '../src/workspace.ts';

const config: ApiConfig = { port: 4311, allowedOrigins: ['http://127.0.0.1:4310'], deepseek: { apiKey: 'fixture', baseUrl: 'https://api.deepseek.com', model: 'fixture' }, mimo: { apiKey: '', baseUrl: 'https://api.xiaomimimo.com/v1', asrModel: '', ttsModel: '', voice: '' } };
const headers = { host: '127.0.0.1:4311', 'x-sayland-session': 'workspace-fixture-session' };
const provider = (plan: Providers['plan']): Providers => ({ plan, transcribe: async () => '', synthesize: async () => Buffer.alloc(0) });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate: () => boolean | Promise<boolean>) { for (let n = 0; n < 200; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('condition not reached'); }
function batch(snapshot: SceneSnapshot, id: string, x = 0): SceneBatch {
  return { protocolVersion: 1, baseRevision: snapshot.revision, operations: [
    { op: 'define_group', group: { id, name: id } },
    { op: 'define_part', part: { id, name: id, role: 'other', origin: { x, y: 0, z: 0 }, groupId: id } },
    { op: 'fill_shape', partId: id, color: '#55AAFF', shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } } },
  ] };
}
type App = ReturnType<typeof createApp>;
async function send(app: App, url: string, payload: unknown) {
  const result = await app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  assert.ok(result.statusCode < 300, `${result.statusCode}: ${result.body}`); return result;
}
async function scene(app: App, id: string): Promise<SceneView> { return (await app.inject({ url: `/api/scenes/${id}`, headers })).json(); }
async function list(app: App): Promise<WorkspaceView> { return (await app.inject({ url: '/api/workspace', headers })).json(); }
async function create(app: App, id: string) { await send(app, '/api/scenes', { id, name: id, template: 'empty' }); }

test('unchanged preferences, previews and status polling never write project data or advance saved timestamps', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sayland-noop-save-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite'), app = createApp(config, { databasePath: path, providers: provider(async () => ({ reply: '完成' })) });
  t.after(() => app.close()); await create(app, 'no-op-project');
  const db = new DatabaseSync(path); t.after(() => db.close());
  db.exec('CREATE TABLE save_writes (kind TEXT); CREATE TRIGGER scene_write AFTER UPDATE ON scenes BEGIN INSERT INTO save_writes VALUES (\'scene\'); END; CREATE TRIGGER preview_write AFTER UPDATE ON scene_previews BEGIN INSERT INTO save_writes VALUES (\'preview\'); END;');
  const before = (await scene(app, 'no-op-project')).scene;
  const preview = { image: thumbnailPng(), revision: 0, resetKey: 0 };
  const savedPreview = (await send(app, '/api/scenes/no-op-project/preview', preview)).json();
  for (let n = 0; n < 3; n++) {
    await list(app); await scene(app, 'no-op-project');
    await send(app, '/api/scenes/no-op-project/preferences', { draft: '', speakerEnabled: true });
    assert.deepEqual((await send(app, '/api/scenes/no-op-project/preview', preview)).json(), savedPreview);
  }
  await send(app, '/api/scenes/no-op-project/preferences', {});
  assert.deepEqual(db.prepare('SELECT kind FROM save_writes').all(), []);
  assert.equal((await scene(app, 'no-op-project')).scene.version, before.version);
  assert.equal((await scene(app, 'no-op-project')).scene.updatedAt, before.updatedAt);
  await send(app, '/api/scenes/no-op-project/preferences', { draft: '真正变化' });
  await send(app, '/api/scenes/no-op-project/preferences', { draft: '真正变化' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM save_writes').get()!.count, 1);
  await send(app, '/api/scenes/no-op-project/preview', { ...preview, image: thumbnailPng(211) });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM save_writes').get()!.count, 2);
  const viewed = (await send(app, '/api/scenes/no-op-project/preview', { ...preview, viewKey: 'same-camera', image: thumbnailPng(212) })).json();
  assert.deepEqual((await send(app, '/api/scenes/no-op-project/preview', { ...preview, viewKey: 'same-camera', image: thumbnailPng(213) })).json(), viewed, 'renderer noise is not a scene/view change');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM save_writes').get()!.count, 3);
  await send(app, '/api/scenes/no-op-project/preview', { ...preview, viewKey: 'moved-camera', image: thumbnailPng(214) });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM save_writes').get()!.count, 4);
});

test('deleting a project removes all its data, aborts its running work, and never starts its queued work', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sayland-delete-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'workspace.sqlite'), release = gate();
  const signals = new Map<string, AbortSignal>(), calls: string[] = [];
  const services = provider(async (input, signal, options) => {
    calls.push(input.requestId); signals.set(input.requestId, signal);
    if (input.requestId === 'delete-running') {
      const first = await options!.commitBatch!(batch(input.snapshot, 'before-delete'), '已保存一部分');
      await release.promise;
      assert.throws(() => options!.onCommentary!('迟到消息'));
      await assert.rejects(() => options!.commitBatch!(batch(first, 'after-delete', 2), '迟到提交'));
      return { reply: '迟到完成' };
    }
    if (input.requestId === 'keep-running') await release.promise;
    signal.throwIfAborted(); return { reply: '其他项目正常完成' };
  });
  const app = createApp(config, { databasePath, providers: services });
  t.after(async () => { release.resolve(); await app.close(); });
  await create(app, 'delete-project'); await create(app, 'keep-project');
  await send(app, '/api/scenes/delete-project/commands', { id: 'delete-command', version: 1, action: { kind: 'rename', name: '待删除' } });
  await send(app, '/api/scenes/delete-project/preferences', { draft: '删除草稿', speakerEnabled: false });
  const before = await scene(app, 'delete-project');
  await send(app, '/api/scenes/delete-project/preview', { image: thumbnailPng(), revision: VoxelEngine.restore(before.project!.engine).snapshot().revision, resetKey: 0 });
  await send(app, '/api/scenes/delete-project/tasks', { id: 'delete-running', text: '搭建' });
  await send(app, '/api/scenes/delete-project/tasks', { id: 'delete-queued', text: '排队' });
  await send(app, '/api/scenes/keep-project/tasks', { id: 'keep-running', text: '其他项目' });
  await until(async () => (await scene(app, 'delete-project')).scene.voxelCount === 1 && signals.has('keep-running'));
  for (const invalidHeaders of [{ host: headers.host }, { ...headers, origin: 'https://evil.example' }]) {
    assert.ok((await app.inject({ method: 'DELETE', url: '/api/scenes/delete-project', headers: invalidHeaders })).statusCode >= 400);
    assert.equal(signals.get('delete-running')!.aborted, false);
  }
  const remove = () => app.inject({ method: 'DELETE', url: '/api/scenes/delete-project', headers });
  assert.equal((await remove()).statusCode, 200); assert.equal((await remove()).statusCode, 200);
  assert.equal(signals.get('delete-running')!.aborted, true); assert.equal(signals.get('keep-running')!.aborted, false);
  assert.deepEqual((await list(app)).scenes.map(value => value.id), ['keep-project']);
  assert.ok((await list(app)).tasks.every(task => task.sceneId === 'keep-project'));
  for (const url of ['/api/scenes/delete-project', '/api/scenes/delete-project/preview', '/api/tasks/delete-running', '/api/tasks/delete-queued']) assert.equal((await app.inject({ url, headers })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/scenes/delete-project/preferences', headers, payload: { draft: '旧页面自动保存' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/scenes/delete-project/tasks', headers, payload: { id: 'late-task', text: '旧页面提交' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/scenes', headers, payload: { id: 'delete-project', name: '重复创建', template: 'empty' } })).statusCode, 410);
  release.resolve();
  await until(async () => (await list(app)).tasks.every(task => task.status === 'completed'));
  await send(app, '/api/scenes/keep-project/tasks', { id: 'keep-next', text: '继续正常工作' });
  await until(async () => (await list(app)).tasks.every(task => task.status === 'completed'));
  assert.equal(calls.includes('delete-queued'), false);
  await app.close();
  const stored = new DatabaseSync(databasePath);
  for (const table of ['scene_previews', 'commands', 'tasks']) assert.equal(stored.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE scene_id = ?`).get('delete-project')!.count, 0);
  assert.equal(stored.prepare('SELECT COUNT(*) AS count FROM scenes WHERE id = ?').get('delete-project')!.count, 0);
  stored.close();
  const reopened = createApp(config, { databasePath, providers: services }); t.after(() => reopened.close());
  assert.deepEqual((await list(reopened)).scenes.map(value => value.id), ['keep-project']);
});

test('delete transaction failure preserves the project and running task; deleted legacy copies stay deleted', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sayland-delete-rollback-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite'), store = new WorkspaceStore(path), release = gate(); let runningSignal: AbortSignal | undefined;
  const workspace = new BackgroundWorkspace(store, provider(async (_input, signal) => { runningSignal = signal; await release.promise; signal.throwIfAborted(); return { reply: '完成' }; }));
  t.after(async () => { release.resolve(); await workspace.close(); });
  const legacy: Project = { format: 'sayland-project', version: 1, engine: new VoxelEngine().serialize(), messages: [], draft: '', speakerEnabled: false };
  const imported = workspace.bootstrap(legacy)!;
  workspace.savePreview(imported.scene.id, { image: thumbnailPng(), revision: 0, resetKey: 0 });
  workspace.enqueue(imported.scene.id, { id: 'delete-rollback-task', text: '进行中' }); await until(() => Boolean(runningSignal));
  const db = new DatabaseSync(path); t.after(() => db.close());
  db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON scenes BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  assert.throws(() => workspace.deleteScene(imported.scene.id), /fixture failure/);
  assert.ok(store.getScene(imported.scene.id)); assert.ok(store.getPreview(imported.scene.id)); assert.ok(store.getTask('delete-rollback-task'));
  assert.equal(store.isDeleted(imported.scene.id), false); assert.equal(runningSignal!.aborted, false);
  db.exec('DROP TRIGGER reject_delete'); workspace.deleteScene(imported.scene.id);
  assert.equal(runningSignal!.aborted, true); assert.equal(workspace.bootstrap(legacy), null);
  assert.deepEqual(workspace.list(), { scenes: [], tasks: [] });
});

test('accepted task outlives its response and commits successive batches without a browser ACK; undo groups the whole turn', async t => {
  const release = gate(); let entered = false;
  const app = createApp(config, { providers: provider(async (input, signal, options) => {
    entered = true; await release.promise; signal.throwIfAborted();
    const first = await options!.commitBatch!(batch(input.snapshot, 'first'), '第一部分');
    await options!.commitBatch!(batch(first, 'second', 2), '第二部分'); return { reply: '全部完成' };
  }) }); t.after(async () => { release.resolve(); await app.close(); });
  await create(app, 'scene-first');
  assert.equal(VoxelEngine.restore((await scene(app, 'scene-first')).project!.engine).canUndo, false);
  const response = await send(app, '/api/scenes/scene-first/tasks', { id: 'task-first', text: '搭两部分' });
  assert.equal(response.statusCode, 202); await until(() => entered);
  // POST is fully over. There is no open stream, subscriber, or ACK request.
  release.resolve();
  await until(async () => (await list(app)).tasks[0]?.status === 'completed');
  const view = await scene(app, 'scene-first');
  const engine = VoxelEngine.restore(view.project!.engine);
  assert.equal(engine.snapshot().voxels.length, 2); assert.equal(view.tasks[0].committedBatches, 2);
  assert.equal(view.project!.messages.at(-1)?.text, '全部完成');
  assert.deepEqual(view.project!.messages.filter(m => m.kind === 'progress').map(m => m.text), ['第一部分', '第二部分']);
  const payload = { id: 'undo-once', version: view.scene.version, action: { kind: 'undo' } };
  const undone = (await send(app, '/api/scenes/scene-first/commands', payload)).json<SceneView>();
  assert.equal(VoxelEngine.restore(undone.project!.engine).snapshot().voxels.length, 0);
  const replay = (await send(app, '/api/scenes/scene-first/commands', payload)).json<SceneView>();
  assert.equal(replay.scene.version, undone.scene.version);
  const unchanged = await app.inject({ url: `/api/scenes/scene-first?since=${undone.scene.version}`, headers });
  assert.equal(unchanged.json().project, undefined);
  const compact = await app.inject({ url: `/api/scenes/scene-first?geometry=${undone.scene.resetKey}:${VoxelEngine.restore(undone.project!.engine).snapshot().revision}`, headers });
  assert.equal(compact.json().project.engine, undefined); assert.ok(compact.json().project.messages.length > 0);
});

test('scene and task rollback together when a batch cannot be persisted; no uncommitted success is reported', async () => {
  class FailingStore extends WorkspaceStore {
    failed = false;
    override putTask(task: StoredTask) {
      if (!this.failed && task.committedBatches === 1) { this.failed = true; throw new Error('simulated disk failure'); }
      super.putTask(task);
    }
  }
  const store = new FailingStore(':memory:');
  const workspace = new BackgroundWorkspace(store, provider(async (input, _signal, options) => {
    await options!.commitBatch!(batch(input.snapshot, 'atomic'), '不可见的成功'); return { reply: '不可返回' };
  }));
  try {
    workspace.create({ id: 'scene-atomic', name: '事务', template: 'empty' });
    workspace.enqueue('scene-atomic', { id: 'task-atomic', text: '测试事务' });
    await until(() => workspace.list().tasks[0]?.status === 'failed');
    const result = workspace.view('scene-atomic');
    assert.equal(VoxelEngine.restore(result.project!.engine).count, 0);
    assert.equal(result.tasks[0].committedBatches, 0);
    assert.equal(result.project!.messages.some(message => message.text === '不可见的成功'), false);
  } finally { await workspace.close(); }
});

test('crash recovery detects persisted running tasks without replaying any provider calls', async () => {
  const store = new WorkspaceStore(':memory:'); let calls = 0;
  const initial: Project = { format: 'sayland-project', version: 1, engine: new VoxelEngine().serialize(), speakerEnabled: true,
    messages: [{ id: 'task-crashed', role: 'user', text: '建房子' }, { id: 'task-crashed-answer', role: 'assistant', text: '进行中', status: 'pending' }] };
  store.putScene({ id: 'scene-crashed', name: '保留', template: 'empty', version: 1, resetKey: 0, updatedAt: 1, voxelCount: 0, project: initial });
  store.putTask({ id: 'task-crashed', sceneId: 'scene-crashed', text: '建房子', status: 'running', phase: '进行中', committedBatches: 0, createdAt: 1, updatedAt: 1, activity: [] });
  const workspace = new BackgroundWorkspace(store, provider(async () => { calls++; return { reply: '不得调用' }; }));
  try {
    assert.equal(workspace.list().tasks[0].status, 'interrupted'); assert.equal(calls, 0);
    assert.equal(workspace.view('scene-crashed').project!.messages[1].status, 'error');
  } finally { await workspace.close(); }
});

test('different scenes run concurrently up to four; same-scene jobs wait and read the newly committed world', async t => {
  const releases = new Map<string, ReturnType<typeof gate>>(); const inputs = new Map<string, SceneSnapshot>();
  let live = 0, peak = 0;
  const app = createApp(config, { providers: provider(async (input, signal, options) => {
    live++; peak = Math.max(peak, live); inputs.set(input.requestId, input.snapshot);
    const wait = gate(); releases.set(input.requestId, wait); await wait.promise; signal.throwIfAborted();
    await options!.commitBatch!(batch(input.snapshot, input.requestId, input.snapshot.voxels.length * 2), '搭好一部分'); live--; return { reply: '完成' };
  }) }); t.after(async () => { releases.forEach(wait => wait.resolve()); await app.close(); });
  for (let n = 1; n <= 5; n++) await create(app, `scene-concurrent-${n}`);
  await send(app, '/api/scenes/scene-concurrent-1/tasks', { id: 'task-concurrent-1', text: '一' });
  await send(app, '/api/scenes/scene-concurrent-1/tasks', { id: 'task-same-scene-2', text: '二' });
  for (let n = 2; n <= 5; n++) await send(app, `/api/scenes/scene-concurrent-${n}/tasks`, { id: `task-concurrent-${n}`, text: '搭一个' });
  await until(() => releases.size === 4);
  assert.equal(inputs.has('task-same-scene-2'), false); assert.equal(inputs.has('task-concurrent-5'), false); assert.equal(peak, 4);
  releases.get('task-concurrent-1')!.resolve();
  await until(() => releases.has('task-same-scene-2'));
  assert.equal(inputs.get('task-same-scene-2')!.voxels.length, 1);
  releases.forEach(wait => wait.resolve()); await until(() => releases.has('task-concurrent-5')); releases.get('task-concurrent-5')!.resolve();
  await until(async () => (await list(app)).tasks.every(task => task.status === 'completed'));
  assert.equal(peak, 4);
  assert.equal(VoxelEngine.restore((await scene(app, 'scene-concurrent-1')).project!.engine).snapshot().voxels.length, 2);
  for (let n = 2; n <= 5; n++) assert.equal(VoxelEngine.restore((await scene(app, `scene-concurrent-${n}`)).project!.engine).snapshot().voxels.length, 1);
});

test('cancel preserves earlier batches, forbids late writes, and cancelling queued work never calls the provider', async t => {
  const release = gate(); let committed = false, calls = 0;
  const app = createApp(config, { providers: provider(async (input, _signal, options) => {
    calls++; const first = await options!.commitBatch!(batch(input.snapshot, 'kept'), '保留'); committed = true;
    await release.promise;
    await options!.commitBatch!(batch(first, 'late', 2), '不能提交'); return { reply: '完成' };
  }) }); t.after(async () => { release.resolve(); await app.close(); });
  await create(app, 'scene-cancel');
  await send(app, '/api/scenes/scene-cancel/tasks', { id: 'task-cancel-1', text: '继续搭' }); await until(() => committed);
  await send(app, '/api/scenes/scene-cancel/tasks', { id: 'task-cancel-2', text: '排队' });
  await send(app, '/api/tasks/task-cancel-2/cancel', {}); await send(app, '/api/tasks/task-cancel-1/cancel', {}); release.resolve();
  await until(async () => (await list(app)).tasks.every(task => task.status === 'cancelled'));
  assert.equal(calls, 1); assert.equal(VoxelEngine.restore((await scene(app, 'scene-cancel')).project!.engine).snapshot().voxels.length, 1);
});

test('disk restart retains scenes/history/results and marks interrupted work without repeating paid calls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sayland-workspace-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'workspace.sqlite'); let committed = false, calls = 0;
  const services = provider(async (input, signal, options) => {
    calls++; await options!.commitBatch!(batch(input.snapshot, 'saved'), '已经保存'); committed = true;
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); return { reply: 'never' };
  });
  const app = createApp(config, { databasePath, providers: services });
  await create(app, 'scene-persist'); await send(app, '/api/scenes/scene-persist/tasks', { id: 'task-persist', text: '搭建' }); await until(() => committed);
  await app.close();
  const reopened = createApp(config, { databasePath, providers: services }); t.after(() => reopened.close());
  const view = await scene(reopened, 'scene-persist'); assert.equal(view.tasks[0].status, 'interrupted'); assert.equal(calls, 1);
  const engine = VoxelEngine.restore(view.project!.engine); assert.equal(engine.snapshot().voxels.length, 1); assert.equal(engine.canUndo, true);
  assert.equal(view.project!.messages.at(-1)?.status, 'error');
  const duplicate = await send(reopened, '/api/scenes/scene-persist/tasks', { id: 'task-persist', text: '搭建' }); assert.equal(duplicate.json().status, 'interrupted'); assert.equal(calls, 1);
});

test('legacy migration is idempotent and non-destructive; stale edits and host/origin violations are rejected', async t => {
  const app = createApp(config, { providers: provider(async () => ({ reply: '你好' })) }); t.after(() => app.close());
  const legacy: Project = { format: 'sayland-project', version: 1, engine: new VoxelEngine().serialize(), messages: [{ id: 'old', role: 'assistant', text: '旧对话' }], draft: '草稿', speakerEnabled: false };
  const original = structuredClone(legacy);
  const imported = (await send(app, '/api/workspace/bootstrap', { project: legacy })).json<SceneView>();
  await send(app, '/api/workspace/bootstrap', { project: legacy });
  assert.equal((await list(app)).scenes.length, 1); assert.deepEqual(legacy, original); assert.deepEqual(imported.project, legacy);
  const renamed = (await send(app, `/api/scenes/${imported.scene.id}/commands`, { id: 'rename-valid', version: imported.scene.version, action: { kind: 'rename', name: '新名字' } })).json<SceneView>();
  const conflict = await app.inject({ method: 'POST', url: `/api/scenes/${imported.scene.id}/commands`, headers, payload: { id: 'stale-edit', version: imported.scene.version, action: { kind: 'undo' } } });
  assert.equal(conflict.statusCode, 409); assert.equal((await scene(app, imported.scene.id)).scene.name, renamed.scene.name);
  const malicious = await app.inject({ url: '/api/workspace', headers: { ...headers, origin: 'https://evil.example' } }); assert.equal(malicious.statusCode, 403);
  const missingSession = await app.inject({ url: '/api/workspace', headers: { host: headers.host } }); assert.equal(missingSession.statusCode, 400);
});


function thumbnailPng(red = 100, width = 1) {
  const chunk = (name: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
    const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); content.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, red, 150, 80, 255]))), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

test('exit previews persist independently; invalid and stale captures cannot replace the previous saved picture', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sayland-preview-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'workspace.sqlite'), services = provider(async () => ({ reply: 'fixture' }));
  const app = createApp(config, { databasePath, providers: services }); t.after(() => app.close());
  await create(app, 'scene-preview');
  const path = '/api/scenes/scene-preview/preview', image = thumbnailPng();
  assert.equal((await list(app)).scenes[0].preview, undefined);
  const original = await scene(app, 'scene-preview');
  const metadata = (await send(app, path, { image, revision: 0, resetKey: 0 })).json();
  assert.deepEqual((await list(app)).scenes[0].preview, metadata);
  assert.equal((await scene(app, 'scene-preview')).scene.version, original.scene.version, 'cover writes never change model revision, history, or edit version');
  const response = await app.inject({ url: path, headers });
  assert.match(response.headers['content-type']!, /^image\/png/); assert.equal(response.rawPayload.toString('base64'), image.split(',')[1]);
  assert.equal((await app.inject({ url: path, headers: { host: headers.host } })).statusCode, 400, 'images retain the same session boundary');
  await send(app, '/api/scenes/scene-preview/preferences', { draft: '已经自动保存的新草稿' });
  assert.deepEqual((await list(app)).scenes[0].preview, metadata, 'autosaves alone never replace the last exit cover');
  for (const bad of ['data:image/png;base64,AAAA', thumbnailPng(99, 10000), image.slice(0, -20), 'data:image/svg+xml;base64,PHN2Zy8+']) {
    assert.equal((await app.inject({ method: 'POST', url: path, headers, payload: { image: bad, revision: 0, resetKey: 0 } })).statusCode, 400);
    assert.deepEqual((await list(app)).scenes[0].preview, metadata);
  }
  const before = await scene(app, 'scene-preview');
  const modified = (await send(app, '/api/scenes/scene-preview/commands', { id: 'preview-add-one', version: before.scene.version, action: { kind: 'batch', operations: batch(new VoxelEngine().snapshot(), 'preview-part').operations } })).json<SceneView>();
  const revision = VoxelEngine.restore(modified.project!.engine).snapshot().revision;
  const latest = (await send(app, path, { image: thumbnailPng(210), revision, resetKey: modified.scene.resetKey })).json();
  assert.notEqual(latest.key, metadata.key);
  for (const stale of [{ revision: 0, resetKey: 0 }, { revision, resetKey: 999 }]) assert.equal((await app.inject({ method: 'POST', url: path, headers, payload: { image, ...stale } })).statusCode, 409);
  assert.deepEqual((await list(app)).scenes[0].preview, latest);
  await app.close();
  const reopened = createApp(config, { databasePath, providers: services }); t.after(() => reopened.close());
  assert.deepEqual((await list(reopened)).scenes[0].preview, latest);
  assert.equal((await reopened.inject({ url: path, headers })).rawPayload.toString('base64'), thumbnailPng(210).split(',')[1]);
});

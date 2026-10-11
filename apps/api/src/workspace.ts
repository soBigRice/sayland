import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { VoxelEngine, createInitialScene, type EngineSerialized } from '../../../packages/scene/src/index.ts';
import { batchSchema, MAX_PROJECT_FILE_BYTES, type SceneBatch } from '../../../packages/protocol/src/index.ts';
import { boundMessages, createSceneSchema, enqueueTaskSchema, projectSchema, sceneCommandSchema, scenePreviewSchema, workspaceId,
  type Project, type SceneCommand, type ScenePreview, type SceneView, type WorkspaceTask } from '../../../packages/protocol/src/workspace.ts';
import { ApiError, diagnoseBatchFailure, planningError, publicError, throwIfAborted } from './errors.ts';
import { newPartGroupingIssue } from './grouping.ts';
import type { Providers, PlannerPhase } from './providers.ts';
import { WorkspaceStore, type StoredScene, type StoredTask } from './workspace-store.ts';
import { previewPng } from './scene-preview.ts';

const welcome = (empty: boolean): Project['messages'] => [{ id: 'welcome', role: 'assistant', text: empty ? '这里是属于你的空白世界。\n想创造什么？我们一起搭！' : '你好呀！这是送给你的小岛。\n想添点什么？说出来，我们一起搭！' }];
const phases: Record<PlannerPhase, string> = {
  thinking: '正在思考接下来怎么搭…', answering: '正在整理想法和回复…', 'tool-input': '正在设计这一批方块…',
  inspect: '正在查看物件和空间…', 'read-region': '正在读取实际方块…', 'get-views': '正在查看场景三视图…', validate: '正在检查这一批搭建…', repair: '正在调整搭建方案…',
};
const publicTask = ({ diagnostics: _diagnostics, ...task }: StoredTask): WorkspaceTask => task;
const valid = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError('INVALID_REQUEST', 400, '这次内容没有传完整，请检查后重试。');
  return parsed.data;
};

export class BackgroundWorkspace {
  private running = new Map<string, { controller: AbortController; sceneId: string; promise: Promise<void> }>();
  private closing = false;
  private faulted = false;
  private modelWindows = new Map<string, { start: number; calls: number }>();
  constructor(readonly store: WorkspaceStore, private providers: Providers, private now = Date.now, private maxRunning = 4) {
    // Never replay an uncertain paid call after a server restart.
    for (const task of store.tasks(undefined, true)) this.finish(task, 'interrupted', '后台服务已重启，任务中断；已保存的部分保留。请查看结果后重新提出想法。');
  }
  private scene(id: string): StoredScene {
    valid(workspaceId, id);
    const scene = this.store.getScene(id);
    if (!scene) throw new ApiError('SCENE_NOT_FOUND', 404, '这个场景不存在，请从场景列表重新打开。');
    return scene;
  }
  private touch(scene: StoredScene): void {
    scene.version++; scene.updatedAt = this.now();
    this.store.putScene(scene);
  }
  list() { return { scenes: this.store.listScenes(), tasks: this.store.tasks().map(publicTask) }; }
  savePreview(id: string, input: ScenePreview) {
    const scene = this.scene(id), previous = this.store.getPreview(id);
    const revision = (scene.project.engine as EngineSerialized).snapshot.revision;
    // Background work may already be ahead of the departing browser. Keep the captured
    // frame's revision, but reject a superseded document or an older preview from another tab.
    if (scene.resetKey !== input.resetKey || input.revision > revision || previous && previous.metadata.resetKey === input.resetKey && previous.metadata.revision > input.revision) {
      throw new ApiError('STALE_PREVIEW', 409, '场景已经变化，请取消退出，等画面更新后再保存缩略图。');
    }
    const image = previewPng(input.image);
    const metadata = { key: createHash('sha256').update(`${input.resetKey}:${input.revision}:`).update(image).digest('hex'), revision: input.revision, resetKey: input.resetKey, updatedAt: this.now(), ...(input.viewKey ? { viewKey: input.viewKey } : {}) };
    const sameView = input.viewKey && previous?.metadata.viewKey === input.viewKey && previous.metadata.revision === input.revision && previous.metadata.resetKey === input.resetKey;
    if (previous?.metadata.key === metadata.key || sameView) return previous.metadata;
    this.store.putPreview(id, metadata, image);
    return metadata;
  }
  preview(id: string) {
    valid(workspaceId, id);
    const preview = this.store.getPreview(id);
    if (!preview) throw new ApiError('PREVIEW_NOT_FOUND', 404, '这个项目还没有保存场景缩略图。');
    return preview;
  }
  view(id: string, since?: number, geometry?: string): SceneView {
    const summary = this.store.listScenes().find(scene => scene.id === id);
    if (!summary) throw new ApiError('SCENE_NOT_FOUND', 404, '这个场景不存在，请从场景列表重新打开。');
    const project = since === summary.version ? undefined : this.scene(id).project;
    // Progress and preferences must not retransmit a large unchanged voxel history.
    if (project && geometry === `${summary.resetKey}:${(project.engine as EngineSerialized).snapshot.revision}`) project.engine = undefined;
    return { scene: summary, ...(project ? { project } : {}), tasks: this.store.tasks(id).map(publicTask) };
  }
  create(input: z.infer<typeof createSceneSchema>): SceneView {
    if (this.store.isDeleted(input.id)) throw new ApiError('SCENE_DELETED', 410, '这个项目已经删除，请创建一个新项目。');
    const existing = this.store.getScene(input.id);
    if (existing) return this.view(existing.id);
    let project: Project;
    let engine: VoxelEngine;
    if (input.project) {
      project = projectSchema.parse(input.project);
      try { engine = VoxelEngine.restore(project.engine); }
      catch { throw new ApiError('INVALID_PROJECT', 400, '旧作品校验未通过，原始备份仍保留。'); }
      project.messages = project.messages.map(message => message.status === 'pending' ? { ...message, status: 'error', text: '迁入前的搭建已经中断，已保存部分保留。' } : message);
    } else {
      engine = input.template === 'island' ? VoxelEngine.fromSnapshot(createInitialScene()) : new VoxelEngine();
      const initial = engine.snapshot(); initial.model.name = input.name; engine = VoxelEngine.fromSnapshot(initial);
      project = { format: 'sayland-project', version: 1, engine: engine.serialize(), messages: welcome(input.template === 'empty'), speakerEnabled: true, draft: '' };
    }
    project.engine = engine.serialize();
    const snapshot = engine.snapshot();
    this.store.putScene({ id: input.id, name: snapshot.model.name, template: input.template, version: 1, resetKey: 0, updatedAt: this.now(), voxelCount: snapshot.voxels.length, project });
    return this.view(input.id);
  }
  bootstrap(legacy?: Project): SceneView | null {
    if (legacy) {
      // Content identity makes migration safe across reloads and ambiguous POST responses.
      const id = `legacy-${createHash('sha256').update(JSON.stringify(legacy)).digest('hex').slice(0, 40)}`;
      if (this.store.isDeleted(id)) return null;
      return this.create({ id, name: '原来的小岛', template: 'island', project: legacy });
    }
    const first = this.store.listScenes()[0];
    return first ? this.view(first.id) : this.create({ id: 'first-island', name: '我的第一座小岛', template: 'island' });
  }
  command(id: string, command: SceneCommand): SceneView {
    const scene = this.scene(id);
    const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const prior = this.store.command(command.id);
    if (prior) {
      if (prior.scene_id !== id || prior.fingerprint !== fingerprint) throw new ApiError('REQUEST_ID_REUSED', 409, '这次操作编号已用于其他内容。');
      return this.view(id);
    }
    if (this.store.tasks(id, true).length) throw new ApiError('SCENE_BUSY', 409, '这个场景还有任务，请完成或停止后再手动编辑。');
    if (scene.version !== command.version) throw new ApiError('SCENE_CONFLICT', 409, '场景已在别处更新，已读取最新结果，请重新操作。');
    let engine = VoxelEngine.restore(scene.project.engine);
    const action = command.action;
    switch (action.kind) {
      case 'batch': engine.executeBatch({ protocolVersion: 1, baseRevision: engine.snapshot().revision, operations: action.operations }, command.id); break;
      case 'rename': engine.rename(action.name); break;
      case 'undo': engine.undo(); scene.resetKey++; break;
      case 'redo': engine.redo(); scene.resetKey++; break;
      case 'reset':
        engine = scene.template === 'empty' ? new VoxelEngine() : VoxelEngine.fromSnapshot(createInitialScene());
        { const initial = engine.snapshot(); initial.model.name = scene.name; engine = VoxelEngine.fromSnapshot(initial); }
        scene.project.messages = welcome(scene.template === 'empty'); scene.project.draft = ''; scene.resetKey++; break;
      case 'import':
        try { engine = VoxelEngine.restore(action.project.engine); }
        catch { throw new ApiError('INVALID_PROJECT', 400, '这份作品无法读取，当前场景没有改变。'); }
        scene.project = { ...action.project, messages: action.project.messages.map(message => message.status === 'pending' ? { ...message, status: 'error', text: '导入的回合已中断，已保存部分保留。' } : message) }; scene.resetKey++; break;
    }
    scene.project.engine = engine.serialize(); scene.name = (scene.project.engine as EngineSerialized).snapshot.model.name; scene.voxelCount = engine.count;
    this.store.transaction(() => { this.touch(scene); this.store.rememberCommand(command.id, id, fingerprint); });
    return this.view(id);
  }
  preferences(id: string, preferences: { draft?: string; speakerEnabled?: boolean }): void {
    const scene = this.scene(id);
    if ((preferences.draft === undefined || preferences.draft === (scene.project.draft ?? ''))
      && (preferences.speakerEnabled === undefined || preferences.speakerEnabled === scene.project.speakerEnabled)) return;
    scene.project = { ...scene.project, ...preferences }; this.touch(scene);
  }
  deleteScene(id: string): void {
    valid(workspaceId, id);
    // Synchronous transaction + abort: callbacks cannot interleave, and a failed delete
    // leaves both the project and its running work intact for a retry.
    this.store.deleteScene(id);
    for (const job of this.running.values()) if (job.sceneId === id) job.controller.abort();
    this.modelWindows.delete(id);
    this.drain();
  }
  enqueue(sceneId: string, input: { id: string; text: string }): WorkspaceTask {
    this.scene(sceneId);
    const existing = this.store.getTask(input.id);
    if (existing) {
      if (existing.sceneId !== sceneId || existing.text !== input.text) throw new ApiError('REQUEST_ID_REUSED', 409, '同一任务编号不能发送不同的想法。');
      return publicTask(existing);
    }
    if (this.closing || this.faulted) throw new ApiError('SERVICE_BUSY', 503, '后台暂时无法开始新任务，请稍后重试。');
    if (this.store.tasks(undefined, true).length >= 64) throw new ApiError('QUEUE_FULL', 429, '等待中的想法太多了，请先等伙伴完成一些。');
    const task: StoredTask = { ...input, sceneId, status: 'queued', phase: '等待开始', committedBatches: 0, createdAt: this.now(), updatedAt: this.now(), activity: [] };
    this.store.putTask(task);
    this.drain();
    return publicTask(this.store.getTask(task.id)!);
  }
  private activity(task: StoredTask, kind: 'stage' | 'message' | 'result', text: string): void {
    const previous = task.activity.at(-1);
    if (previous?.kind !== kind || previous.text !== text) task.activity = [...task.activity, { id: (previous?.id ?? -1) + 1, kind, text }].slice(-16);
    task.updatedAt = this.now();
  }
  private finish(task: StoredTask, status: StoredTask['status'], text: string): void {
    task.status = status; task.phase = text;
    if (status === 'completed') task.reply = text; else task.error = text;
    this.activity(task, 'result', text);
    const scene = this.scene(task.sceneId);
    const answer = scene.project.messages.find(message => message.id === `${task.id}-answer`);
    if (answer) { answer.text = text; answer.status = status === 'failed' || status === 'interrupted' ? 'error' : undefined; }
    this.store.transaction(() => { if (answer) this.touch(scene); this.store.putTask(task); });
  }
  cancel(id: string): WorkspaceTask {
    const task = this.store.getTask(valid(workspaceId, id));
    if (!task) throw new ApiError('TASK_NOT_FOUND', 404, '没有找到这条任务。');
    if (task.status === 'queued' || task.status === 'running') {
      this.running.get(id)?.controller.abort();
      this.finish(task, 'cancelled', task.committedBatches ? '已停止，搭好的部分保留，可以一次撤销。' : '任务已停止，场景没有改变。');
      this.drain();
    }
    return publicTask(this.store.getTask(id)!);
  }
  diagnostic(id: string) {
    const task = this.store.getTask(valid(workspaceId, id));
    if (!task) throw new ApiError('TASK_NOT_FOUND', 404, '没有找到这条任务。');
    return { requestId: task.id, status: task.status, committedBatches: task.committedBatches, diagnostics: task.diagnostics, error: task.error ? { message: task.error } : undefined };
  }
  speechApproved(text: string): boolean { return this.store.tasks().some(task => task.status === 'completed' && task.reply === text); }
  activeCount() { return this.running.size; }
  private drain(): void {
    if (this.closing || this.faulted) return;
    const busyScenes = new Set([...this.running.values()].map(job => job.sceneId));
    for (const task of this.store.tasks(undefined, true)) {
      if (this.running.size >= this.maxRunning) break;
      if (task.status !== 'queued' || busyScenes.has(task.sceneId)) continue;
      busyScenes.add(task.sceneId);
      const controller = new AbortController();
      task.status = 'running'; this.store.putTask(task);
      const promise = Promise.resolve().then(() => this.run(task, controller)).catch(() => {
        // A storage failure must not silently launch more paid calls.
        this.faulted = true; controller.abort(); process.stderr.write('Sayland background storage failed; new tasks are paused.\n');
      }).finally(() => { this.running.delete(task.id); this.drain(); });
      this.running.set(task.id, { controller, sceneId: task.sceneId, promise });
    }
  }
  private async run(task: StoredTask, controller: AbortController): Promise<void> {
    let timedOut = false, commentary = 0;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 360_000);
    const signal = controller.signal;
    const persistProgress = (text: string, kind: 'message' | 'stage') => {
      throwIfAborted(signal); this.activity(task, kind, text); task.phase = text; this.store.putTask(task);
    };
    try {
      throwIfAborted(signal);
      let scene = this.scene(task.sceneId);
      const engine = VoxelEngine.restore(scene.project.engine);
      const context = scene.project.messages.filter(message => message.id !== 'welcome' && !message.kind && !message.status).slice(-10).map(message => ({ role: message.role, content: message.text.slice(0, 3000) }));
      scene.project.messages = boundMessages([...scene.project.messages, { id: task.id, role: 'user', text: task.text }, { id: `${task.id}-answer`, role: 'assistant', text: '伙伴正在后台搭建…', status: 'pending' }]);
      this.touch(scene);
      const addMessage = (text: string, id: string) => {
        scene = this.scene(task.sceneId);
        const index = scene.project.messages.findIndex(message => message.id === `${task.id}-answer`);
        const progress = scene.project.messages.filter(message => message.id.startsWith(`${task.id}-progress-`));
        if (index >= 0 && progress.length < 88) {
          scene.project.messages.splice(index, 0, { id, role: 'assistant', text, kind: 'progress' });
          scene.project.messages = boundMessages(scene.project.messages);
        }
      };
      const commit = async (input: SceneBatch, text: string) => {
        throwIfAborted(signal);
        const batch = valid(batchSchema, input), reply = valid(z.string().trim().min(1).max(600), text);
        const before = engine.snapshot();
        // Validate against a separate engine before touching the authoritative history.
        let preview;
        try { preview = VoxelEngine.fromSnapshot(before).executeBatch(batch, `${task.id}-b${task.committedBatches + 1}`, task.id); }
        catch (error) { throw planningError(diagnoseBatchFailure(before, batch, error, signal)); }
        const issue = newPartGroupingIssue(before, preview.snapshot, batch);
        if (issue) throw planningError(issue);
        if (preview.snapshot.revision <= before.revision) throw new ApiError('EMPTY_EDIT', 422, '这批没有实际改变。');
        throwIfAborted(signal);
        const committed = engine.executeBatch(batch, `${task.id}-b${task.committedBatches + 1}`, task.id);
        task.committedBatches++;
        addMessage(reply, `${task.id}-progress-b${task.committedBatches}`);
        scene.project.engine = engine.serialize(); scene.name = committed.snapshot.model.name; scene.voxelCount = engine.count;
        this.activity(task, 'message', reply); task.phase = `已保存第 ${task.committedBatches} 批，继续搭建中…`;
        this.store.transaction(() => { this.touch(scene); this.store.putTask(task); });
        return committed.snapshot;
      };
      let calls = 0;
      const result = await this.providers.plan({ requestId: task.id, text: task.text, snapshot: engine.snapshot(), messages: context }, signal, {
        beforeModelCall: () => {
          throwIfAborted(signal);
          for (const [id, window] of this.modelWindows) if (this.now() - window.start >= 60_000) this.modelWindows.delete(id);
          let window = this.modelWindows.get(task.sceneId);
          if (!window || this.now() - window.start >= 60_000) { window = { start: this.now(), calls: 0 }; this.modelWindows.set(task.sceneId, window); }
          if (++calls > 24 || window.calls >= 24) throw new ApiError('MODEL_BUDGET', 429, '这次搭建已达到调用上限，已完成部分保留，请稍后继续。');
          window.calls++;
        },
        onProgress(phase = 'thinking') { if (task.phase !== phases[phase]) persistProgress(phases[phase], 'stage'); },
        onDiagnostics: trace => { throwIfAborted(signal); task.diagnostics = structuredClone(trace); },
        onCommentary: text => {
          throwIfAborted(signal);
          const parsed = z.string().trim().min(1).max(600).safeParse(text); if (!parsed.success) return;
          addMessage(parsed.data, `${task.id}-progress-m${++commentary}`);
          this.activity(task, 'message', parsed.data);
          this.store.transaction(() => { this.touch(scene); this.store.putTask(task); });
        },
        commitBatch: commit,
      });
      throwIfAborted(signal);
      if (result.batch) await commit(result.batch, result.reply);
      throwIfAborted(signal);
      this.finish(task, 'completed', valid(z.string().trim().min(1).max(600), result.reply));
    } catch (error) {
      const persisted = this.store.getTask(task.id);
      if (!persisted || persisted.status === 'cancelled') return;
      if (persisted) { task.committedBatches = persisted.committedBatches; task.activity = persisted.activity; }
      const status = this.closing ? 'interrupted' : signal.aborted && !timedOut ? 'cancelled' : 'failed';
      const text = this.closing ? '后台服务已停止，任务中断，已保存部分保留。' : timedOut ? '搭建达到 6 分钟上限，已保存部分保留。' : `${publicError(error).message}${task.committedBatches ? ' 已搭好的部分保留，可以一次撤销。' : ''}`;
      this.finish(task, status, text);
    } finally { clearTimeout(deadline); }
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const task of this.store.tasks(undefined, true)) if (task.status === 'queued') this.finish(task, 'interrupted', '后台服务已停止，尚未开始的任务保留在记录中。');
    for (const job of this.running.values()) job.controller.abort();
    await Promise.all([...this.running.values()].map(job => job.promise));
    this.store.close();
  }
}

export function registerWorkspace(app: FastifyInstance, workspace: BackgroundWorkspace, sessionFor: (request: FastifyRequest) => string): void {
  const access = (request: FastifyRequest) => { sessionFor(request); };
  app.get('/api/workspace', async request => { access(request); return workspace.list(); });
  app.post<{ Params: { id: string } }>('/api/scenes/:id/preview', { bodyLimit: 1_410_000 }, async request => { access(request); return workspace.savePreview(request.params.id, valid(scenePreviewSchema, request.body)); });
  app.get<{ Params: { id: string } }>('/api/scenes/:id/preview', async (request, reply) => { access(request); return reply.type('image/png').send(workspace.preview(request.params.id).image); });
  app.post('/api/workspace/bootstrap', { bodyLimit: MAX_PROJECT_FILE_BYTES }, async request => { access(request); const input = valid(z.object({ project: projectSchema.optional() }).strict(), request.body); return workspace.bootstrap(input.project); });
  app.post('/api/scenes', { bodyLimit: MAX_PROJECT_FILE_BYTES }, async request => { access(request); return workspace.create(valid(createSceneSchema, request.body)); });
  app.delete<{ Params: { id: string } }>('/api/scenes/:id', async request => { access(request); workspace.deleteScene(request.params.id); return { ok: true }; });
  app.get<{ Params: { id: string }; Querystring: { since?: string; geometry?: string } }>('/api/scenes/:id', async request => { access(request); return workspace.view(valid(workspaceId, request.params.id), request.query.since === undefined ? undefined : Number(request.query.since), request.query.geometry); });
  app.post<{ Params: { id: string } }>('/api/scenes/:id/commands', { bodyLimit: MAX_PROJECT_FILE_BYTES }, async request => { access(request); return workspace.command(request.params.id, valid(sceneCommandSchema, request.body)); });
  app.post<{ Params: { id: string } }>('/api/scenes/:id/preferences', async request => { access(request); workspace.preferences(request.params.id, valid(z.object({ draft: z.string().max(1500).optional(), speakerEnabled: z.boolean().optional() }).strict(), request.body)); return { ok: true }; });
  app.post<{ Params: { id: string } }>('/api/scenes/:id/tasks', async (request, reply) => { access(request); return reply.code(202).send(workspace.enqueue(request.params.id, valid(enqueueTaskSchema, request.body))); });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async request => { access(request); return workspace.cancel(request.params.id); });
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async request => { access(request); return workspace.diagnostic(request.params.id); });
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { VoxelEngine, type EngineSerialized } from '../../../../packages/scene/src/index.ts';
import { MAX_PROJECT_FILE_BYTES, type Operation, type SceneSnapshot, type ServiceHealth } from '../../../../packages/protocol/src/index.ts';
import { projectSchema, taskIsActive, type Project, type SceneCommand, type SceneSummary, type SceneView, type WorkspaceTask, type WorkspaceView } from '../../../../packages/protocol/src/workspace.ts';
import type { ChatMessage, ComposerState } from '../components/SceneShell.tsx';
import type { ViewAction } from '../scene/SceneCanvas.tsx';
import type { CaptureScenePreview } from '../scene/ScenePreviewCapture.tsx';
import type { TaskActivity } from '../lib/taskActivity.ts';
import { readHealth, synthesize, transcribe } from '../lib/api.ts';
import { bootstrapWorkspace, readWorkspace, readScene, createScene, deleteScene, commandScene, saveScenePreferences, saveScenePreview, scenePreviewKey, enqueueTask, stopTask } from '../lib/workspaceApi.ts';
import { loadProject } from '../lib/storage.ts';
import { appliedTurnEvidence, restoreChatMessages, retryPromptForMessage } from './workshopTurn.ts';
import { useRecorder } from './useRecorder.ts';
import { readProjectRoute } from '../lib/projectRoute.ts';
import { changedSceneVoxels } from '../scene/cameraFocus.ts';

import { AUTOSAVE_INTERVAL_MS, createPreferences, preferencesChanged, preferencesPending, flushPreferenceChanges, type Preferences } from '../lib/sceneAutosave.ts';

const messageOf = (error: unknown) => error instanceof Error ? error.message : '这次没有完成，请再试一下。';
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Server data remains authoritative when browser storage is unavailable. */ } };
const remembered = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };

export function useWorkspaceWorkshop() {
  const [workspace, setWorkspace] = useState<WorkspaceView>({ scenes: [], tasks: [] });
  const [ready, setReady] = useState(false);
  const hasBackgroundTasks = useRef(false); hasBackgroundTasks.current = workspace.tasks.some(taskIsActive);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const route = readProjectRoute(window.location.pathname);
    return route.kind === 'project' ? route.id : null;
  });
  const selected = useRef<string | null>(selectedId), sceneRef = useRef<SceneSummary | null>(null);
  const engine = useRef<VoxelEngine | null>(null), project = useRef<Project | null>(null);
  const [snapshot, setSnapshot] = useState<SceneSnapshot | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]), taskRef = useRef<WorkspaceTask[]>([]);
  const [draft, setDraftState] = useState(''), [speakerEnabled, setSpeakerState] = useState(true);
  const preferences = useRef(new Map<string, Preferences>());
  const [notice, setNotice] = useState(''), [loadError, setLoadError] = useState(''), [health, setHealth] = useState<ServiceHealth | null>(null);
  const [saveState, setSaveState] = useState<'saving' | 'saved' | 'error'>('saved');
  const [localPhase, setLocalPhase] = useState<ComposerState>('idle'), localPhaseRef = useRef<ComposerState>('idle');
  const [mutating, setMutating] = useState(false), mutationRef = useRef(false);
  const [submitting, setSubmitting] = useState(false), submissionRef = useRef(false);
  const [switching, setSwitching] = useState(false), switchRef = useRef(false);
  const [deletingId, setDeletingId] = useState<string | null>(null), deletingRef = useRef(false), workspaceEpoch = useRef(0);
  const [animationResetKey, setAnimationResetKey] = useState(0), [viewAction, setViewAction] = useState<ViewAction>(null);
  const mounted = useRef(true), speech = useRef<{ controller: AbortController; audio?: HTMLAudioElement; url?: string } | null>(null);
  const seenTaskStatus = useRef(new Map<string, WorkspaceTask['status']>());
  const speechCallback = useRef<(text: string) => void>(() => undefined);
  const pollRefresh = useRef<() => void>(() => undefined);
  const recordAttempt = useRef(0), recordHeld = useRef(false), recordingEnd = useRef<AbortController | null>(null);
  const limitCallback = useRef<() => void>(() => undefined);
  const recorder = useRecorder(() => limitCallback.current());
  const setPhase = (phase: ComposerState) => { localPhaseRef.current = phase; setLocalPhase(phase); };
  const stopSpeech = useCallback(() => {
    const current = speech.current; speech.current = null; current?.controller.abort();
    if (current?.audio) { current.audio.pause(); current.audio.removeAttribute('src'); current.audio.load(); }
    if (current?.url) URL.revokeObjectURL(current.url);
  }, []);
  const flushPreferences = useCallback(async (id: string) => {
    const value = preferences.current.get(id); if (!value || !preferencesPending(value)) return;
    if (selected.current === id && mounted.current) setSaveState('saving');
    try {
      await flushPreferenceChanges(value, data => saveScenePreferences(id, data), () => preferences.current.get(id) === value);
      const current = preferences.current.get(id);
      if (mounted.current && selected.current === id) {
        setSaveState(current && preferencesPending(current) || mutationRef.current || submissionRef.current ? 'saving' : 'saved');
        setNotice(value => value.startsWith('草稿未保存：') ? '' : value);
      }
    } catch (error) {
      if (mounted.current && selected.current === id) setSaveState('error');
      throw error;
    }
  }, []);
  const accept = useCallback((value: SceneView, opening = false, syncPreferences = true) => {
    if (!mounted.current || selected.current !== value.scene.id) return;
    if (!opening && sceneRef.current?.id === value.scene.id && sceneRef.current.version > value.scene.version) return;
    const previousScene = sceneRef.current;
    const previousSnapshot = (project.current?.engine as EngineSerialized | undefined)?.snapshot;
    const receivedBatch = value.tasks.some(task => task.committedBatches > (taskRef.current.find(previous => previous.id === task.id)?.committedBatches ?? 0));
    if (value.project) {
      if (value.project.engine !== undefined) {
        engine.current = VoxelEngine.restore(value.project.engine);
        const nextSnapshot = engine.current.snapshot();
        setSnapshot(nextSnapshot);
        if (!opening && previousScene?.resetKey === value.scene.resetKey && previousSnapshot && receivedBatch) {
          const voxels = changedSceneVoxels(previousSnapshot, nextSnapshot);
          if (voxels.length) setViewAction(action => ({ kind: 'frameChanges', voxels, seq: (action?.seq ?? 0) + 1 }));
        }
      }
      if (!engine.current) throw new Error('没有收到完整的场景数据，请重新打开。');
      project.current = { ...value.project, engine: value.project.engine ?? project.current?.engine };
      const restored = restoreChatMessages(value.project.messages, appliedTurnEvidence(project.current.engine as EngineSerialized));
      setMessages(restored.map((message, index) => value.project!.messages[index].status === 'pending'
        && value.tasks.some(task => taskIsActive(task) && message.id === `${task.id}-answer`)
        ? { ...value.project!.messages[index], retryable: false } : message));
      const local = preferences.current.get(value.scene.id);
      if (syncPreferences && (!local || !preferencesPending(local))) {
        preferences.current.set(value.scene.id, createPreferences({ draft: value.project.draft ?? '', speakerEnabled: value.project.speakerEnabled }));
        setDraftState(value.project.draft ?? ''); setSpeakerState(value.project.speakerEnabled);
      }
    }
    if (opening || previousScene?.resetKey !== value.scene.resetKey) setAnimationResetKey(key => key + 1);
    const completed = value.tasks.filter(task => task.status === 'completed' && seenTaskStatus.current.has(task.id) && seenTaskStatus.current.get(task.id) !== 'completed');
    if (!opening && completed.length) {
      const latest = completed.sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latest.reply && document.visibilityState === 'visible') speechCallback.current(latest.reply);
    }
    seenTaskStatus.current = new Map(value.tasks.map(task => [task.id, task.status]));
    sceneRef.current = value.scene; taskRef.current = value.tasks; setTasks(value.tasks);
    const pending = preferences.current.get(value.scene.id);
    if (!pending || !preferencesPending(pending)) setSaveState(mutationRef.current || submissionRef.current ? 'saving' : 'saved');
    setWorkspace(previous => ({ scenes: [value.scene, ...previous.scenes.filter(scene => scene.id !== value.scene.id)], tasks: [...value.tasks, ...previous.tasks.filter(task => task.sceneId !== value.scene.id)] }));
  }, []);
  useEffect(() => {
    let disposed = false; mounted.current = true;
    void (async () => {
      try {
        if (!remembered('sayland.backend-migrated')) {
          // Read/copy only; never delete or overwrite the original IndexedDB archive.
          let legacy: Project | undefined, readable = true;
          try {
            const saved = await loadProject();
            if (saved) { legacy = projectSchema.parse(saved); VoxelEngine.restore(legacy.engine); }
          } catch {
            legacy = undefined; readable = false;
            if (!disposed) setNotice('浏览器里的旧作品暂时无法迁入，原备份仍保留。可以从首页打开后台项目。');
          }
          // Opening an address never creates a project. Only copy an existing legacy archive.
          if (legacy) await bootstrapWorkspace(legacy);
          if (readable) remember('sayland.backend-migrated', '1');
        }
        if (disposed) return;
        const list = await readWorkspace();
        if (disposed) return;
        setWorkspace(list);
        const route = readProjectRoute(window.location.pathname);
        if (route.kind === 'invalid' || route.kind === 'project' && !list.scenes.some(scene => scene.id === route.id)) {
          selected.current = null; setSelectedId(null);
          window.history.replaceState(window.history.state, '', `/${window.location.search}`);
          setNotice(route.kind === 'invalid' ? '项目地址不正确，请从首页选择项目。' : '这个项目不存在，请从首页选择其他项目。');
        } else if (route.kind === 'project') {
          const next = await readScene(route.id);
          if (disposed) return;
          accept(next, true);
        }
        setReady(true);
      } catch (error) { if (!disposed) setLoadError(`暂时无法打开后台场景：${messageOf(error)} 原来的浏览器作品仍保留。`); }
    })();
    void readHealth().then(value => { if (!disposed) setHealth(value); }).catch(() => { if (!disposed) setNotice('后台还没有连接上，请稍后重试。'); });
    return () => { disposed = true; mounted.current = false; stopSpeech(); recordingEnd.current?.abort(); };
  }, [accept, stopSpeech]);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, fetching = false;
    const refresh = async () => {
      if (fetching || controller.signal.aborted) return;
      clearTimeout(timer); fetching = true;
      try {
        if (document.visibilityState === 'visible' && !switchRef.current && !deletingRef.current) {
          const epoch = workspaceEpoch.current;
          const list = await readWorkspace(controller.signal);
          if (controller.signal.aborted || epoch !== workspaceEpoch.current) return;
          if (selectedId && !list.scenes.some(scene => scene.id === selectedId)) {
            // A project deleted in another tab must not leave an editable stale copy here.
            preferences.current.delete(selectedId); window.location.replace('/'); return;
          }
          const summary = sceneRef.current;
          const geometry = summary && snapshotRevision.current !== null ? `${summary.resetKey}:${snapshotRevision.current}` : undefined;
          const local = selectedId ? preferences.current.get(selectedId) : undefined;
          const savedAtRead = local?.saved, writingAtRead = local?.pending;
          const view = selectedId ? await readScene(selectedId, summary?.version, controller.signal, geometry) : null;
          if (!controller.signal.aborted && selected.current === selectedId && epoch === workspaceEpoch.current) {
            setWorkspace(list); if (view) accept(view, false, !writingAtRead && !local?.pending && savedAtRead === local?.saved);
            setNotice(value => value.startsWith('与后台的连接暂时断开') ? '' : value);
          }
        }
      } catch (error) { if (!controller.signal.aborted && mounted.current) { setSaveState('error'); setNotice(`与后台的连接暂时断开，会自动重连。${messageOf(error)}`); } }
      finally { fetching = false; if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), hasBackgroundTasks.current ? 900 : 2500); }
    };
    pollRefresh.current = () => void refresh();
    const saveBeforeLeaving = () => { if (selected.current) void flushPreferences(selected.current).catch(() => { /* Keep unsaved preferences for the next retry. */ }); };
    const visibility = () => { if (document.visibilityState === 'visible') void refresh(); else saveBeforeLeaving(); };
    document.addEventListener('visibilitychange', visibility); void refresh();
    window.addEventListener('pagehide', saveBeforeLeaving);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', saveBeforeLeaving); };
  }, [ready, selectedId, accept, flushPreferences]);
  const snapshotRevision = useRef<number | null>(null); snapshotRevision.current = snapshot?.revision ?? null;
  useEffect(() => {
    if (!selectedId) return;
    const timer = setInterval(() => {
      const local = preferences.current.get(selectedId);
      if (document.visibilityState !== 'visible' || !local || local.pending || !preferencesChanged(local)) return;
      void flushPreferences(selectedId).catch(error => { if (mounted.current) setNotice(`草稿未保存：${messageOf(error)}`); });
    }, AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [selectedId, flushPreferences]);
  const setDraft = (value: string) => {
    if (switchRef.current) return;
    const id = selected.current, local = id && preferences.current.get(id);
    if (!local || local.draft === value) return;
    local.draft = value; setDraftState(value); setSaveState(preferencesPending(local) ? 'saving' : 'saved');
  };
  const setSpeakerEnabled = (enabled: boolean) => {
    if (switchRef.current) return;
    const id = selected.current, local = id && preferences.current.get(id);
    if (!local || local.speakerEnabled === enabled) return;
    local.speakerEnabled = enabled; setSpeakerState(enabled); setSaveState(preferencesPending(local) ? 'saving' : 'saved'); if (!enabled) stopSpeech();
  };
  speechCallback.current = text => {
    const id = selected.current; if (!id || !preferences.current.get(id)?.speakerEnabled || !health?.ttsConfigured) return;
    stopSpeech(); const current: NonNullable<typeof speech.current> = { controller: new AbortController() }; speech.current = current;
    void (async () => {
      try {
        const blob = await synthesize(text, current.controller.signal);
        if (speech.current !== current || current.controller.signal.aborted || selected.current !== id) return;
        current.url = URL.createObjectURL(blob); current.audio = new Audio(current.url);
        current.audio.onended = () => { if (speech.current === current) stopSpeech(); };
        current.audio.onerror = () => { if (speech.current === current) { stopSpeech(); setNotice('声音没有播放成功，文字回复还在。'); } };
        await current.audio.play();
      } catch (error) { if (!current.controller.signal.aborted && mounted.current) { stopSpeech(); setNotice(messageOf(error)); } }
    })();
  };
  const cancelRecording = useCallback(() => {
    recordHeld.current = false; recordAttempt.current++; recorder.cancel(); recordingEnd.current?.abort(); recordingEnd.current = null;
    setPhase('idle'); stopSpeech();
  }, [recorder, stopSpeech]);
  const switchScene = async (id: string) => {
    if (id === selected.current) return true;
    if (switchRef.current || mutationRef.current || submissionRef.current || deletingRef.current) return false;
    switchRef.current = true; setSwitching(true); cancelRecording();
    const previous = selected.current;
    try {
      if (previous) await flushPreferences(previous);
      const next = await readScene(id);
      if (!mounted.current) return false;
      selected.current = id; sceneRef.current = null; setSelectedId(id); accept(next, true); setNotice('');
      setViewAction(action => ({ kind: 'reset', seq: (action?.seq ?? 0) + 1 })); return true;
    } catch (error) { setNotice(messageOf(error)); return false; }
    finally { switchRef.current = false; setSwitching(false); }
  };
  const leaveScene = async ({ capture, discard = false, destination }: { capture: CaptureScenePreview; discard?: boolean; destination?: string }): Promise<{ ok: boolean; error?: string }> => {
    if (switchRef.current || mutationRef.current || submissionRef.current) return { ok: false, error: '当前操作还没有完成，请稍后再退出。' };
    switchRef.current = true; setSwitching(true); cancelRecording();
    try {
      // Read the destination first: a failed navigation must not discard the current scene or draft.
      const next = destination ? await readScene(destination) : null;
      const id = selected.current;
      if (id && discard) preferences.current.delete(id);
      else if (id) {
        await flushPreferences(id);
        const image = await capture();
        if (!image) throw new Error('暂时没有截取到场景画面，请重试，或选择不保存退出以保留上次缩略图。');
        const previous = sceneRef.current?.preview;
        const sameView = image.viewKey && image.viewKey === previous?.viewKey && image.revision === previous.revision && image.resetKey === previous.resetKey;
        if (!sameView && await scenePreviewKey(image) !== previous?.key) {
          const preview = await saveScenePreview(id, image);
          setWorkspace(previous => ({ ...previous, scenes: previous.scenes.map(scene => scene.id === id ? { ...scene, preview } : scene) }));
        }
      }
      if (next) {
        selected.current = next.scene.id; sceneRef.current = null; setSelectedId(next.scene.id); accept(next, true); setNotice('');
        setViewAction(action => ({ kind: 'reset', seq: (action?.seq ?? 0) + 1 }));
        return { ok: true };
      }
      // Leaving stops local media and releases the canvas, never the server task.
      selected.current = null; sceneRef.current = null; engine.current = null; project.current = null;
      taskRef.current = []; seenTaskStatus.current.clear(); setTasks([]); setMessages([]); setSnapshot(null); setSelectedId(null); setNotice('');
      return { ok: true };
    } catch (error) { const text = messageOf(error); setNotice(text); return { ok: false, error: text }; }
    finally { switchRef.current = false; setSwitching(false); }
  };
  const removeScene = async (id: string): Promise<{ ok: boolean; error?: string }> => {
    if (selected.current || switchRef.current || deletingRef.current) return { ok: false, error: '请先回到首页，等待当前操作完成。' };
    deletingRef.current = true; setDeletingId(id); workspaceEpoch.current++;
    try {
      await deleteScene(id);
      preferences.current.delete(id);
      setWorkspace(value => ({ scenes: value.scenes.filter(scene => scene.id !== id), tasks: value.tasks.filter(task => task.sceneId !== id) }));
      setNotice('项目已删除，对应的后台任务已停止。');
      return { ok: true };
    } catch (error) { return { ok: false, error: messageOf(error) }; }
    finally { deletingRef.current = false; setDeletingId(null); workspaceEpoch.current++; }
  };
  const newScene = async (name: string, template: 'empty' | 'island') => {
    if (selected.current || switchRef.current || mutationRef.current || submissionRef.current || deletingRef.current) return false;
    switchRef.current = true; setSwitching(true); cancelRecording();
    try {
      if (selected.current) await flushPreferences(selected.current);
      const next = await createScene(crypto.randomUUID(), name, template);
      if (!mounted.current) return false;
      selected.current = next.scene.id; sceneRef.current = null; setSelectedId(next.scene.id); accept(next, true); setNotice('');
      setViewAction(action => ({ kind: 'reset', seq: (action?.seq ?? 0) + 1 })); return next.scene.id;
    } catch (error) { setNotice(messageOf(error)); return false; }
    finally { switchRef.current = false; setSwitching(false); }
  };
  const send = async (input: string) => {
    const id = selected.current, text = input.trim();
    if (!id || !text || submissionRef.current || mutationRef.current || switchRef.current || localPhaseRef.current !== 'idle') return;
    if (text.length > 1500) { setNotice('一句话有点长，请分几次告诉我。'); return; }
    submissionRef.current = true; setSubmitting(true); stopSpeech(); setNotice('');
    let requestId = crypto.randomUUID();
    try {
      const saved: unknown = JSON.parse(remembered('sayland.pending-submission') ?? 'null');
      if (saved && typeof saved === 'object' && 'sceneId' in saved && saved.sceneId === id && 'text' in saved && saved.text === text && 'id' in saved && typeof saved.id === 'string') requestId = saved.id as typeof requestId;
    } catch { /* An invalid browser-only retry hint cannot invalidate server scenes. */ }
    remember('sayland.pending-submission', JSON.stringify({ sceneId: id, text, id: requestId }));
    try {
      const task = await enqueueTask(id, requestId, text);
      remember('sayland.pending-submission', 'null');
      if (selected.current === id && mounted.current) {
        setDraft(''); seenTaskStatus.current.set(task.id, task.status === 'completed' ? 'running' : task.status);
        const current = [...taskRef.current.filter(value => value.id !== task.id), task]; taskRef.current = current; setTasks(current);
        pollRefresh.current();
      }
    } catch (error) { if (mounted.current) setNotice(`任务提交状态尚未确认：${messageOf(error)} 重发同一想法不会重复执行。`); }
    finally { submissionRef.current = false; if (mounted.current) setSubmitting(false); }
  };
  const finishRecording = async () => {
    if (!recorder.isRecording() || recordingEnd.current) return;
    const id = selected.current, controller = new AbortController(); recordingEnd.current = controller; setPhase('transcribing');
    try {
      const audio = await recorder.stop(); if (!audio || controller.signal.aborted) return;
      const text = await transcribe(audio, controller.signal);
      if (controller.signal.aborted || selected.current !== id) return;
      if (!text.trim()) throw new Error('刚才没有听清，再试着说一句吧。');
      recordingEnd.current = null; setPhase('idle'); await send(text);
    } catch (error) { if (!controller.signal.aborted) setNotice(messageOf(error)); }
    finally { if (recordingEnd.current === controller) { recordingEnd.current = null; setPhase('idle'); } }
  };
  const startRecording = async () => {
    if (localPhaseRef.current !== 'idle' || mutationRef.current || submissionRef.current || switchRef.current) return;
    if (health && !health.asrConfigured) { setNotice('语音识别还没有配置好，可以先打字。'); return; }
    stopSpeech(); setNotice(''); setPhase('requesting'); recordHeld.current = true; const attempt = ++recordAttempt.current;
    try { const started = await recorder.start(); if (attempt === recordAttempt.current) setPhase(started ? 'recording' : 'idle'); }
    catch (error) { if (attempt === recordAttempt.current) { recordHeld.current = false; setPhase('idle'); setNotice(messageOf(error)); } }
  };
  const endRecording = async () => {
    if (!recordHeld.current) return; recordHeld.current = false;
    if (recorder.isRecording()) { await finishRecording(); return; }
    recordAttempt.current++; recorder.cancel(); setPhase('idle'); setNotice('麦克风还没准备好，请允许权限后再次按住。');
  };
  limitCallback.current = () => { cancelRecording(); setNotice('本次录音已达到 120 秒上限，已取消且未发送。'); };
  const cancelTask = async (id: string) => {
    try { await stopTask(id); stopSpeech(); pollRefresh.current(); return true; }
    catch (error) { setNotice(`没有确认停止成功：${messageOf(error)}`); return false; }
  };
  const cancel = () => {
    if (localPhaseRef.current !== 'idle') { cancelRecording(); return; }
    const active = taskRef.current.find(task => task.status === 'running') ?? taskRef.current.find(task => task.status === 'queued');
    if (active) void cancelTask(active.id);
  };
  const command = async (action: SceneCommand['action']): Promise<{ ok: boolean; error?: string }> => {
    const id = selected.current;
    if (!id || !sceneRef.current || mutationRef.current || switchRef.current || submissionRef.current || taskRef.current.some(taskIsActive) || localPhaseRef.current !== 'idle') return { ok: false, error: '当前场景还有任务，请完成或停止后再编辑。' };
    mutationRef.current = true; setMutating(true); setSaveState('saving'); stopSpeech();
    try {
      const baseRevision = snapshotRevision.current, baseReset = sceneRef.current.resetKey;
      await flushPreferences(id);
      // Preferences may advance the document version; obtain the latest version before editing.
      const fresh = await readScene(id, sceneRef.current.version);
      accept(fresh);
      if (fresh.scene.resetKey !== baseReset || (fresh.project?.engine !== undefined && (fresh.project.engine as EngineSerialized).snapshot.revision !== baseRevision)) throw new Error('场景已在别处更新，已读取最新结果，请重新操作。');
      const result = await commandScene(id, { id: crypto.randomUUID(), version: fresh.scene.version, action });
      accept(result); setSaveState('saved'); setNotice('已保存到后台。'); return { ok: true };
    } catch (error) {
      const text = messageOf(error); setNotice(text);
      try { accept(await readScene(id)); } catch { /* Preserve the last confirmed world while the server is unavailable. */ }
      setSaveState('error');
      return { ok: false, error: text };
    } finally { mutationRef.current = false; if (mounted.current) setMutating(false); }
  };
  const retrySave = async () => {
    const id = selected.current; if (!id) return;
    setSaveState('saving');
    try { await flushPreferences(id); accept(await readScene(id)); setNotice('作品与对话已保存在后台。'); }
    catch (error) { setSaveState('error'); setNotice(messageOf(error)); }
  };
  const exportProject = () => {
    if (!project.current || !engine.current) return;
    const local = selected.current && preferences.current.get(selected.current);
    const value = { ...project.current, engine: engine.current.serialize(), ...(local ? { draft: local.draft, speakerEnabled: local.speakerEnabled } : {}) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' })), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${sceneRef.current?.name ?? '我的小岛'}.sayland.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importProject = async (file: File) => {
    try {
      if (file.size > MAX_PROJECT_FILE_BYTES) throw new Error(`作品文件不能超过 ${MAX_PROJECT_FILE_BYTES / 1024 / 1024} MB。`);
      const imported = projectSchema.parse(JSON.parse(await file.text())); VoxelEngine.restore(imported.engine);
      if (!window.confirm('导入后会替换当前场景。确认已导出需要保留的作品？')) return;
      await command({ kind: 'import', project: imported });
    } catch (error) { setNotice(messageOf(error)); }
  };
  const undo = () => { void command({ kind: 'undo' }); }, redo = () => { void command({ kind: 'redo' }); };
  const undoRef = useRef(undo), redoRef = useRef(redo); undoRef.current = undo; redoRef.current = redo;
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!selected.current) return;
      const target = event.target;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z' || target instanceof HTMLElement && (target.isContentEditable || /INPUT|TEXTAREA/.test(target.tagName))) return;
      event.preventDefault(); if (event.shiftKey) redoRef.current(); else undoRef.current();
    };
    window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle);
  }, []);
  const activeTask = tasks.find(task => task.status === 'running') ?? tasks.find(task => task.status === 'queued');
  const latestTask = activeTask ?? [...tasks].sort((a, b) => b.createdAt - a.createdAt)[0];
  const phase: ComposerState = localPhase !== 'idle' ? localPhase : activeTask ? activeTask.committedBatches ? 'building' : 'thinking' : 'idle';
  const taskActivity: TaskActivity | null = latestTask ? { requestId: latestTask.id,
    status: taskIsActive(latestTask) ? 'running' : latestTask.status === 'completed' ? 'completed' : latestTask.status === 'cancelled' ? 'stopped' : 'failed',
    entries: latestTask.activity.length ? latestTask.activity : [{ id: 0, kind: 'stage', text: latestTask.phase }], nextId: (latestTask.activity.at(-1)?.id ?? 0) + 1 } : null;
  return {
    snapshot, messages, draft, setDraft, phase, status: activeTask?.phase ?? '', taskActivity, notice, health, speakerEnabled, setSpeakerEnabled, saveState,
    animationResetKey, viewAction,
    view: (kind: 'zoomIn' | 'zoomOut' | 'reset') => setViewAction(value => ({ kind, seq: (value?.seq ?? 0) + 1 })),
    retrySave, exportProject, importProject, send, startRecording, endRecording, cancel, cancelRecording, cancelTask,
    undo, redo, rename: (name: string) => { void command({ kind: 'rename', name }); }, reset: () => { void command({ kind: 'reset' }); },
    debugApply: (operations: Operation[]) => command({ kind: 'batch', operations }),
    retry: async (messageId: string) => { const text = retryPromptForMessage(messages, messageId); if (text) await send(text); },
    recentTurns: [...tasks].sort((a, b) => a.createdAt - b.createdAt).slice(-5).map(task => ({ id: task.id, text: task.text, status: task.status, appliedBatches: task.committedBatches, acknowledgedBatches: task.committedBatches })),
    elapsed: recorder.elapsed, canUndo: engine.current?.canUndo ?? false, canRedo: engine.current?.canRedo ?? false,
    busy: Boolean(activeTask) || localPhase !== 'idle' || mutating || switching,
    canRecord: localPhase === 'idle' && !mutating && !submitting && !switching,
    allowQueue: localPhase === 'idle' && !mutating && !submitting && !switching,
    workspace, selectedId, switchScene, leaveScene, newScene, switching, deletingId, removeScene, loadError, ready,
    previewResetKey: sceneRef.current?.resetKey ?? 0,
    needsSaveBeforeExit: saveState === 'error' || Boolean(selectedId && preferences.current.get(selectedId) && preferencesPending(preferences.current.get(selectedId)!)),
  };
}

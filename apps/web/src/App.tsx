import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Header, ToolRail, ChatPanel, VoiceComposer, SceneShell, SceneControls, SuggestionChips, SettingsDialog } from './components/SceneShell.tsx';
import { ModelExportDialog } from './components/ModelExportDialog.tsx';
import { TaskActivityPanel } from './components/TaskActivityPanel.tsx';
import { ProjectHome } from './components/ProjectHome.tsx';
import { ExitProjectDialog } from './components/ExitProjectDialog.tsx';
import type { CaptureScenePreview } from './scene/ScenePreviewCapture.tsx';
import { taskIsActive } from '../../../packages/protocol/src/workspace.ts';
import { SceneCanvas } from './scene/SceneCanvas.tsx';
import { useWorkshop } from './hooks/useWorkshop.ts';
import { useHoldToTalk } from './hooks/useHoldToTalk.ts';
import { readTaskDiagnostics } from './lib/workspaceApi.ts';
import { createProjectHistory, type ProjectRoute } from './lib/projectRoute.ts';
import type { DebugSelection } from './components/DebugPanel.tsx';
const DebugPanel = lazy(() => import('./components/DebugPanel.tsx').then(module => ({ default: module.DebugPanel })));


class CanvasBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="scene-fallback" role="alert"><img src="/mascot.png" alt="" /><p>这个浏览器暂时没有打开 3D 画面。</p><p>试试更新浏览器或开启硬件加速，作品仍然保留着。</p></div> : this.props.children; }
}
export default function App() {
  const app = useWorkshop();
  const [settings, setSettings] = useState(false);
  const [exitPrompt, setExitPrompt] = useState(false), [exitFailure, setExitFailure] = useState('');
  const projectHistory = useRef<ReturnType<typeof createProjectHistory> | null>(null);
  const navigateHistory = useRef<(route: ProjectRoute) => Promise<boolean>>(async () => false);
  const exitRequest = useRef<{ destination?: string; promise: Promise<boolean>; resolve(ok: boolean): void } | null>(null);
  const sceneCapture = useRef<CaptureScenePreview | null>(null);
  const [exportingModel, setExportingModel] = useState(false);
  const [debugOpen, setDebugOpen] = useState(() => new URLSearchParams(window.location.search).get('debug') === '1');
  const [debugSelection, setDebugSelection] = useState<DebugSelection>(null);
  const holdToTalk = useHoldToTalk({
    enabled: Boolean(app.snapshot) && !settings && !debugOpen && !exportingModel && !exitPrompt,
    canStart: app.canRecord && Boolean(navigator.mediaDevices?.getUserMedia),
    start: () => { void app.startRecording(); }, send: () => { void app.endRecording(); }, cancel: app.cancelRecording,
  });
  const closeDebug = useCallback(() => { setDebugOpen(false); setDebugSelection(null); }, []);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!app.selectedId) return;
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'd' || event.repeat) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(target.tagName))) return;
      event.preventDefault(); setDebugOpen(open => !open); setDebugSelection(null);
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [app.selectedId]);
  const sceneFrameRef = useRef<HTMLDivElement>(null);
  const exitProject = async (discard = false) => {
    setExitFailure('');
    const result = await app.leaveScene({ capture: () => sceneCapture.current?.() ?? Promise.resolve(null), discard, destination: exitRequest.current?.destination });
    if (result.ok) {
      setExitPrompt(false); setSettings(false); setExportingModel(false); closeDebug();
      exitRequest.current?.resolve(true); exitRequest.current = null;
    }
    else { setExitFailure(result.error ?? '暂时无法保存，请重试。'); setExitPrompt(true); }
  };
  const requestExit = (destination?: string) => {
    if (exitRequest.current) return exitRequest.current.promise;
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    exitRequest.current = { destination, promise, resolve };
    if (app.needsSaveBeforeExit) { setExitFailure(''); setExitPrompt(true); } else void exitProject();
    return promise;
  };
  const cancelExit = () => { setExitPrompt(false); exitRequest.current?.resolve(false); exitRequest.current = null; };
  navigateHistory.current = async route => {
    if (!app.ready || app.switching || route.kind === 'invalid') return false;
    const id = route.kind === 'project' ? route.id : null;
    if (id === app.selectedId) return true;
    return app.selectedId ? requestExit(id ?? undefined) : id ? app.switchScene(id) : true;
  };
  useEffect(() => {
    const history = createProjectHistory(route => navigateHistory.current(route)); projectHistory.current = history;
    return () => { history.dispose(); projectHistory.current = null; exitRequest.current?.resolve(false); exitRequest.current = null; };
  }, []);
  const goHome = async () => { if (await requestExit()) projectHistory.current?.push(null); };
  const openProject = async (id: string) => { const ok = await app.switchScene(id); if (ok) projectHistory.current?.push(id); return ok; };
  const createProject = async (name: string, template: 'empty' | 'island') => {
    const id = await app.newScene(name, template);
    if (id) projectHistory.current?.push(id);
    return Boolean(id);
  };
  if (!app.selectedId) return <ProjectHome workspace={app.workspace} ready={app.ready} error={app.loadError} notice={app.notice} switching={app.switching} onSelect={openProject} onCreate={createProject} onCancel={app.cancelTask} onDelete={app.removeScene} deletingId={app.deletingId} />;
  if (!app.snapshot) return <main className="app-loading"><img src="/mascot.png" alt="" /><p role={app.loadError ? 'alert' : 'status'}>{app.loadError || '正在读取后台的小岛…'}</p>{app.loadError && <><button className="secondary-button" onClick={() => window.location.reload()}>重新连接</button><button className="text-button" onClick={() => window.location.assign('/')}>返回项目首页</button></>}</main>;
  return <>
    <SceneShell
      sceneFrameRef={sceneFrameRef}
      activity={app.phase}
      taskActivity={<TaskActivityPanel activity={app.taskActivity} />}
      header={<Header title={app.snapshot.model.name} onTitleChange={app.rename} onRetrySave={() => void app.retrySave()} onOpenSettings={() => setSettings(true)} saveState={app.saveState} onGoHome={() => void goHome()} leaving={app.switching} backgroundTasks={app.workspace.tasks.filter(taskIsActive).length} />}
      toolbar={<ToolRail onUndo={app.undo} canUndo={app.canUndo} disabled={app.busy} />}
      controls={<SceneControls onZoomIn={() => app.view('zoomIn')} onZoomOut={() => app.view('zoomOut')} onResetView={() => app.view('reset')} />}
      suggestions={<SuggestionChips onSelect={text => void app.send(text)} disabled={app.busy} />}
      composer={<VoiceComposer disabled={app.switching} conversation={<ChatPanel messages={app.messages} busy={app.busy} status={app.status} onSuggestion={text => void app.send(text)} onRetry={messageId => void app.retry(messageId)} />} value={app.draft} onChange={app.setDraft} onSend={() => void app.send(app.draft)} recordControl={holdToTalk} onCancelRecording={app.cancelRecording} onCancelTask={app.cancel} state={app.phase} allowQueue={app.allowQueue} elapsedSeconds={app.elapsed} error={app.notice || undefined} microphoneAvailable={Boolean(navigator.mediaDevices?.getUserMedia)} />}>
      <CanvasBoundary key={app.selectedId}><SceneCanvas sceneFrameRef={sceneFrameRef} snapshot={app.snapshot} animationResetKey={app.animationResetKey} viewAction={app.viewAction} debugSelection={debugOpen ? debugSelection : null} captureRef={sceneCapture} previewResetKey={app.previewResetKey} /></CanvasBoundary>
    </SceneShell>
    {debugOpen && <Suspense fallback={<div role="status" className="debug-loading">正在打开调试面板…</div>}>
      <DebugPanel open onClose={closeDebug} snapshot={app.snapshot} health={app.health} busy={app.busy}
        canUndo={app.canUndo} canRedo={app.canRedo} onUndo={app.undo} onRedo={app.redo} onApply={app.debugApply}
        recentTurns={app.recentTurns} onReadTurn={readTaskDiagnostics} onSelectionChange={setDebugSelection} />
    </Suspense>}
    <SettingsDialog open={settings} onClose={() => setSettings(false)} speakerEnabled={app.speakerEnabled} onSpeakerChange={app.setSpeakerEnabled}
      modelStatus={{ configured: app.health?.aiConfigured ?? false }} asrStatus={{ configured: app.health?.asrConfigured ?? false }} ttsStatus={{ configured: app.health?.ttsConfigured ?? false }}
      onExport={app.exportProject} onExportModel={() => { setSettings(false); setExportingModel(true); }} onImport={file => void app.importProject(file)} onReset={app.reset} onRedo={app.redo} canRedo={app.canRedo} busy={app.busy} />
    {exportingModel && <ModelExportDialog snapshot={app.snapshot} onClose={() => setExportingModel(false)} />}
    {exitPrompt && <ExitProjectDialog busy={app.switching} error={exitFailure} onSave={() => void exitProject()} onDiscard={() => void exitProject(true)} onCancel={cancelExit} />}
  </>;
}

import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Header, ToolRail, ChatPanel, VoiceComposer, SceneShell, SceneControls, SuggestionChips, SettingsDialog } from './components/SceneShell.tsx';
import { SceneCanvas } from './scene/SceneCanvas.tsx';
import { useWorkshop } from './hooks/useWorkshop.ts';
import { readTurnDiagnostics } from './lib/api.ts';
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
  const [debugOpen, setDebugOpen] = useState(() => new URLSearchParams(window.location.search).get('debug') === '1');
  const [debugSelection, setDebugSelection] = useState<DebugSelection>(null);
  const closeDebug = useCallback(() => { setDebugOpen(false); setDebugSelection(null); }, []);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'd' || event.repeat) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(target.tagName))) return;
      event.preventDefault(); setDebugOpen(open => !open); setDebugSelection(null);
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);
  const sceneFrameRef = useRef<HTMLDivElement>(null);
  if (!app.snapshot) return <main className="app-loading"><img src="/mascot.png" alt="" /><p>正在唤醒你的小岛…</p></main>;
  return <>
    <SceneShell
      sceneFrameRef={sceneFrameRef}
      activity={app.phase}
      header={<Header title={app.snapshot.model.name} onTitleChange={app.rename} onSave={() => void app.save()} onOpenSettings={() => setSettings(true)} saveState={app.saveState} />}
      toolbar={<ToolRail mode={app.mode} onModeChange={app.setMode} onUndo={app.undo} canUndo={app.canUndo} selectedColor={app.selectedColor} onColorChange={app.setSelectedColor} disabled={app.busy} />}
      chat={<ChatPanel messages={app.messages} busy={app.busy} onSuggestion={text => void app.send(text)} onRetry={() => void app.retry()} />}
      controls={<SceneControls onZoomIn={() => app.view('zoomIn')} onZoomOut={() => app.view('zoomOut')} onResetView={() => app.view('reset')} />}
      suggestions={<SuggestionChips onSelect={text => void app.send(text)} disabled={app.busy} />}
      status={app.status ? <span role="status">{app.status}</span> : app.mode !== 'orbit' ? <span>{app.mode === 'paint' ? '点一下方块，涂上喜欢的颜色' : '点一下方块的表面，搭上新方块'}</span> : undefined}
      composer={<VoiceComposer value={app.draft} onChange={app.setDraft} onSend={() => void app.send(app.draft)} onRecordToggle={() => void app.toggleRecord()} onCancelRecording={app.cancel} onCancelTask={app.cancel} state={app.phase} elapsedSeconds={app.elapsed} error={app.notice || undefined} microphoneAvailable={Boolean(navigator.mediaDevices?.getUserMedia)} />}>
      <CanvasBoundary><SceneCanvas sceneFrameRef={sceneFrameRef} snapshot={app.snapshot} mode={app.busy ? 'orbit' : app.mode} selectedColor={app.selectedColor} onPick={app.pick} viewAction={app.viewAction} debugSelection={debugOpen ? debugSelection : null} /></CanvasBoundary>
    </SceneShell>
    {debugOpen && <Suspense fallback={<div role="status" className="debug-loading">正在打开调试面板…</div>}>
      <DebugPanel open onClose={closeDebug} snapshot={app.snapshot} health={app.health} busy={app.busy}
        canUndo={app.canUndo} canRedo={app.canRedo} onUndo={app.undo} onRedo={app.redo} onApply={app.debugApply}
        recentTurns={app.recentTurns} onReadTurn={readTurnDiagnostics} onSelectionChange={setDebugSelection} />
    </Suspense>}
    <SettingsDialog open={settings} onClose={() => setSettings(false)} speakerEnabled={app.speakerEnabled} onSpeakerChange={app.setSpeakerEnabled}
      modelStatus={{ configured: app.health?.aiConfigured ?? false }} asrStatus={{ configured: app.health?.asrConfigured ?? false }} ttsStatus={{ configured: app.health?.ttsConfigured ?? false }}
      onExport={app.exportProject} onImport={file => void app.importProject(file)} onReset={app.reset} onRedo={app.redo} canRedo={app.canRedo} busy={app.busy} />
  </>;
}

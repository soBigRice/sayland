import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { VoxelEngine, createInitialScene } from '../../../../packages/scene/src/index.ts';
import { snapshotDigest, type ServiceHealth, type SceneSnapshot, type Operation } from '../../../../packages/protocol/src/index.ts';
import type { ChatMessage, ComposerState, ToolMode } from '../components/SceneShell.tsx';
import type { DebugTurn } from '../components/DebugPanel.tsx';
import { acknowledge, cancelTurn, chat, readHealth, synthesize, transcribe } from '../lib/api.ts';
import { loadProject, saveProject } from '../lib/storage.ts';
import { useRecorder } from './useRecorder.ts';

const messageSchema = z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string().max(5000), status: z.enum(['pending', 'error']).optional() });
const projectSchema = z.object({ format: z.literal('sayland-project'), version: z.literal(1), engine: z.unknown(), messages: z.array(messageSchema).max(100), speakerEnabled: z.boolean(), draft: z.string().max(1500).optional() });
type Project = z.infer<typeof projectSchema>;
const initialMessages: ChatMessage[] = [{ id: 'welcome', role: 'assistant', text: '你好呀！这是送给你的小岛。\n想添点什么？说出来，我们一起搭！' }];
const messageOf = (error: unknown) => error instanceof Error ? error.message : '这次没有完成，请再试一下。';

export function useWorkshop() {
  const engine = useRef<VoxelEngine | null>(null);
  const [snapshot, setSnapshot] = useState<SceneSnapshot | null>(null);
  // Ephemeral, bounded diagnostics for this page session; never included in saved projects.
  const [recentTurns, setRecentTurns] = useState<DebugTurn[]>([]);
  const updateTurn = useCallback((id: string, patch: Partial<DebugTurn>) => {
    setRecentTurns(turns => turns.map(turn => turn.id === id ? { ...turn, ...patch } : turn));
  }, []);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const messagesRef = useRef(messages); messagesRef.current = messages;
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<ComposerState>('idle');
  const [status, setStatus] = useState('');
  const [notice, setNotice] = useState('');
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [speakerEnabled, setSpeakerEnabled] = useState(true);
  const speakerEnabledRef = useRef(speakerEnabled); speakerEnabledRef.current = speakerEnabled;
  const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle');
  const [mode, setMode] = useState<ToolMode>('orbit');
  const [selectedColor, setSelectedColor] = useState('#80be45');
  const [viewAction, setViewAction] = useState<{ kind: 'zoomIn' | 'zoomOut' | 'reset'; seq: number } | null>(null);
  const busyRef = useRef(false), mounted = useRef(true), restoreDone = useRef(false), persistenceEnabled = useRef(true);
  const request = useRef<{ id: string; controller: AbortController } | null>(null);
  const speech = useRef<{ controller: AbortController; audio?: HTMLAudioElement; url?: string } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastPrompt = useRef('');
  const recordAttempt = useRef(0), recordingEnd = useRef<string | null>(null);
  const limitCallback = useRef<() => void>(() => undefined);
  const recorder = useRecorder(() => limitCallback.current());
  const sync = useCallback(() => { if (engine.current) setSnapshot(engine.current.snapshot()); }, []);
  const stopSpeech = useCallback(() => {
    const current = speech.current; speech.current = null;
    current?.controller.abort();
    if (current?.audio) { current.audio.pause(); current.audio.removeAttribute('src'); current.audio.load(); }
    if (current?.url) URL.revokeObjectURL(current.url);
  }, []);

  useEffect(() => {
    mounted.current = true; let disposed = false;
    void (async () => {
      try {
        const saved = await loadProject(); if (disposed) return;
        if (saved) {
          const project = projectSchema.parse(saved);
          engine.current = VoxelEngine.restore(project.engine);
          setMessages(project.messages.map(m => m.status === 'pending' ? { ...m, status: 'error', text: '上一次搭建中断了，已经搭好的部分保留着。' } : m));
          setSpeakerEnabled(project.speakerEnabled); setDraft(project.draft ?? '');
        } else engine.current = VoxelEngine.fromSnapshot(createInitialScene());
      } catch {
        if (disposed) return;
        engine.current = VoxelEngine.fromSnapshot(createInitialScene());
        persistenceEnabled.current = false;
        setNotice('旧作品暂时无法读取，原备份仍保留。当前小岛可导出；手动保存会替换旧备份。');
      }
      restoreDone.current = true; sync();
    })();
    void readHealth().then(value => { if (!disposed) setHealth(value); }).catch(() => { if (!disposed) setNotice('小岛伙伴还没连接上，手动搭建和保存仍可使用。'); });
    return () => { disposed = true; mounted.current = false; request.current?.controller.abort(); stopSpeech(); clearTimeout(saveTimer.current); };
  }, [stopSpeech, sync]);

  const project = useCallback((): Project => {
    if (!engine.current) throw new Error('小岛还在准备中');
    return { format: 'sayland-project', version: 1, engine: engine.current.serialize(), messages: messagesRef.current.slice(-100), speakerEnabled, draft };
  }, [speakerEnabled, draft]);
  useEffect(() => {
    if (!snapshot || !restoreDone.current || !persistenceEnabled.current) return;
    const timer = setTimeout(() => { void saveProject(project()).catch(error => { if (mounted.current) setNotice(messageOf(error)); }); }, 600);
    return () => clearTimeout(timer);
  }, [snapshot, messages, project]);

  const save = useCallback(async () => {
    try {
      if (!persistenceEnabled.current && !window.confirm('替换浏览器中暂时无法读取的旧备份？建议先导出当前作品。')) return;
      await saveProject(project()); persistenceEnabled.current = true;
      setSaveState('saved'); setNotice('作品保存在这台设备啦。');
      clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => setSaveState('idle'), 2500);
    } catch (error) { setNotice(messageOf(error)); }
  }, [project]);
  const exportProject = useCallback(() => {
    const blob = new Blob([JSON.stringify(project())], { type: 'application/json' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${engine.current?.snapshot().model.name ?? '我的小岛'}.sayland.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [project]);
  const importProject = useCallback(async (file: File) => {
    if (busyRef.current) return;
    try {
      if (file.size > 24 * 1024 * 1024) throw new Error('作品文件太大了，请选择小于24MB的作品。');
      const imported = projectSchema.parse(JSON.parse(await file.text()));
      const next = VoxelEngine.restore(imported.engine);
      if (!window.confirm('导入后会替换当前小岛。确认已保存或导出当前作品？')) return;
      stopSpeech(); engine.current = next; setMessages(imported.messages.filter(m => m.status !== 'pending'));
      setSpeakerEnabled(imported.speakerEnabled); setDraft(imported.draft ?? ''); persistenceEnabled.current = true; sync();
      setNotice('作品导入成功，继续你的想象吧。');
    } catch { setNotice('这份作品文件无法读取，当前小岛没有改变。'); }
  }, [stopSpeech, sync]);

  const speak = useCallback(async (text: string) => {
    if (!speakerEnabledRef.current || !health?.ttsConfigured) return;
    stopSpeech(); const current = { controller: new AbortController() } as NonNullable<typeof speech.current>;
    speech.current = current;
    try {
      const blob = await synthesize(text, current.controller.signal);
      if (current.controller.signal.aborted || speech.current !== current || !speakerEnabledRef.current) return;
      current.url = URL.createObjectURL(blob); current.audio = new Audio(current.url);
      current.audio.onended = () => { if (speech.current === current) stopSpeech(); };
      current.audio.onerror = () => { if (speech.current === current) { stopSpeech(); setNotice('声音没有播放成功，文字回复还在。'); } };
      await current.audio.play();
    } catch (error) { if (!current.controller.signal.aborted && mounted.current) { stopSpeech(); setNotice(messageOf(error)); } }
  }, [health?.ttsConfigured, speakerEnabled, stopSpeech]);

  const send = useCallback(async (input: string) => {
    const text = input.trim();
    if (!text || busyRef.current || !engine.current) return;
    if (text.length > 1500) { setNotice('一句话有点长，试着分几次告诉我吧。'); return; }
    busyRef.current = true; setPhase('thinking'); setStatus('伙伴正在想办法…'); setNotice(''); setDraft(''); stopSpeech();
    const id = crypto.randomUUID(), controller = new AbortController(); request.current = { id, controller }; lastPrompt.current = text;
    const answerId = `${id}-answer`;
    setRecentTurns(turns => [...turns.slice(-4), { id, text, status: 'thinking' }]);
    const context = messagesRef.current.filter(m => m.id !== 'welcome' && !m.status).slice(-10).map(m => ({ role: m.role, content: m.text }));
    setMessages(previous => [...previous.slice(-96), { id, role: 'user', text }, { id: answerId, role: 'assistant', text: '让我想想怎么搭…', status: 'pending' }]);
    let reply = '', confirmedReply = '', committed = false, acknowledged = false;
    const updateAnswer = (answer: string, status?: 'error' | 'pending') => setMessages(previous => previous.map(m => m.id === answerId ? { ...m, text: answer, status } : m));
    try {
      await chat({ requestId: id, text, snapshot: engine.current.snapshot(), messages: context }, controller.signal, {
        onStatus: value => { if (!controller.signal.aborted) { setStatus(value); updateAnswer(value, 'pending'); } },
        onPlan: async plan => {
          if (controller.signal.aborted) return;
          if (plan.requestId !== id || !engine.current) throw new Error('伙伴的回复对应了另一个请求，请再试一次。');
          updateTurn(id, { plan, status: 'applying' });
          setPhase('building'); setStatus('方块正在排好队…');
          engine.current.executeBatch(plan.batch, id, id); committed = true; sync();
          const applied = engine.current.snapshot();
          const digest = await snapshotDigest(applied);
          // An actual commit must be acknowledged even if the user just cancelled playback.
          const receipt = await acknowledge(id, applied.revision, digest, AbortSignal.timeout(12000));
          acknowledged = true;
          updateTurn(id, { status: controller.signal.aborted ? 'committed-cancelled' : 'committed' });
          if (!controller.signal.aborted && request.current?.id === id) {
            confirmedReply = receipt.reply; reply = confirmedReply; updateAnswer(confirmedReply);
          }
        },
        onReply: value => { if (!controller.signal.aborted) { reply = confirmedReply || value; updateAnswer(reply); updateTurn(id, { status: confirmedReply ? 'committed' : 'replied' }); } },
      });
      if (!controller.signal.aborted && request.current?.id === id) {
        if (reply) { updateAnswer(reply); void speak(reply); }
        else { updateTurn(id, { status: 'incomplete' }); updateAnswer('这次没有收到完整的回应，作品仍然保留着。', 'error'); }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        updateTurn(id, { status: acknowledged ? 'committed-cancelled' : committed ? 'applied-cancelled' : 'cancelled' });
        updateAnswer(committed ? '已停下来，搭好的部分保留着。可以撤销这次搭建。' : '已停下来，小岛没有改变。');
      }
      // The matching ACK proves this transaction succeeded even if SSE's final frame is lost.
      else if (confirmedReply) {
        if (request.current?.id === id && mounted.current) { updateAnswer(confirmedReply); void speak(confirmedReply); }
      }
      else { updateTurn(id, { status: committed ? 'applied-unconfirmed' : 'failed' }); const text = `${messageOf(error)}${committed ? ' 已搭建的部分保留着，可以撤销。' : ''}`; updateAnswer(text, 'error'); setNotice(text); }
    } finally {
      if (request.current?.id === id) { request.current = null; busyRef.current = false; setPhase('idle'); setStatus(''); }
    }
  }, [speak, stopSpeech, sync, updateTurn]);

  const finishRecording = useCallback(async () => {
    if (!recorder.recording || recordingEnd.current) return;
    setPhase('transcribing'); busyRef.current = true;
    const id = crypto.randomUUID(), controller = new AbortController(); request.current = { id, controller }; recordingEnd.current = id;
    try {
      const audio = await recorder.stop();
      if (!audio || controller.signal.aborted) return;
      const text = await transcribe(audio, controller.signal);
      if (controller.signal.aborted) return;
      if (!text.trim()) throw new Error('刚才没有听清，再试着说一句吧。');
      busyRef.current = false; request.current = null; recordingEnd.current = null; setPhase('idle'); await send(text);
    } catch (error) { if (!controller.signal.aborted) setNotice(messageOf(error)); }
    finally { if (recordingEnd.current === id) recordingEnd.current = null; if (request.current?.id === id) { request.current = null; busyRef.current = false; setPhase('idle'); } }
  }, [recorder, send]);
  limitCallback.current = () => { void finishRecording(); };
  const toggleRecord = useCallback(async () => {
    if (recorder.recording) { await finishRecording(); return; }
    if (busyRef.current) return;
    if (health && !health.asrConfigured) { setNotice('语音识别还没有配置好，可以先打字创作。'); return; }
    stopSpeech(); setNotice(''); busyRef.current = true; setPhase('requesting');
    const attempt = ++recordAttempt.current;
    try { const started = await recorder.start(); if (attempt !== recordAttempt.current) return; setPhase(started ? 'recording' : 'idle'); if (!started) busyRef.current = false; }
    catch (error) { if (attempt === recordAttempt.current) { setNotice(messageOf(error)); setPhase('idle'); busyRef.current = false; } }
  }, [finishRecording, health, recorder, stopSpeech]);
  const cancel = useCallback(() => {
    recordAttempt.current++; recordingEnd.current = null; recorder.cancel(); stopSpeech();
    const current = request.current;
    if (current) { current.controller.abort(); void cancelTurn(current.id).catch(() => undefined); }
    request.current = null; busyRef.current = false; setPhase('idle'); setStatus('');
  }, [recorder, stopSpeech]);

  const apply = useCallback((operations: Operation[]) => {
    if (busyRef.current || !engine.current) return;
    try { engine.current.executeBatch({ protocolVersion: 1, baseRevision: engine.current.snapshot().revision, operations }, crypto.randomUUID()); sync(); setNotice(''); }
    catch (error) { setNotice(messageOf(error)); }
  }, [sync]);
  const debugApply = useCallback((operations: Operation[]): { ok: boolean; error?: string } => {
    if (busyRef.current || !engine.current) return { ok: false, error: '当前任务进行中，请完成或停止后再调整。' };
    try {
      engine.current.executeBatch({ protocolVersion: 1, baseRevision: engine.current.snapshot().revision, operations }, crypto.randomUUID());
      stopSpeech(); sync();
      return { ok: true };
    } catch (error) { return { ok: false, error: messageOf(error) }; }
  }, [sync, stopSpeech]);
  const pick = useCallback(({ voxelId, normal }: { voxelId: number; normal: { x: number; y: number; z: number } }) => {
    if (busyRef.current || mode === 'orbit') return;
    const voxel = snapshot?.voxels.find(v => v.id === voxelId);
    if (!voxel) return;
    if (mode === 'paint') apply([{ op: 'paint', voxelIds: [voxelId], color: selectedColor }]);
    else apply([{ op: 'put', cell: { x: voxel.cell.x + Math.round(normal.x), y: voxel.cell.y + Math.round(normal.y), z: voxel.cell.z + Math.round(normal.z) }, color: selectedColor }]);
  }, [apply, mode, selectedColor, snapshot]);
  const undo = useCallback(() => { if (!busyRef.current && engine.current?.canUndo) { stopSpeech(); engine.current.undo(); sync(); setNotice('已撤销上一次搭建。'); } }, [sync, stopSpeech]);
  const redo = useCallback(() => { if (!busyRef.current && engine.current?.canRedo) { engine.current.redo(); sync(); setNotice('已经重新搭好啦。'); } }, [sync]);
  const rename = useCallback((name: string) => { if (!busyRef.current && engine.current && name.trim()) { engine.current.rename(name.trim().slice(0, 32)); sync(); } }, [sync]);
  const reset = useCallback(() => {
    if (busyRef.current) return;
    stopSpeech(); engine.current = VoxelEngine.fromSnapshot(createInitialScene()); setMessages(initialMessages); setDraft(''); persistenceEnabled.current = true; sync(); setViewAction(v => ({ kind: 'reset', seq: (v?.seq ?? 0) + 1 })); setNotice('又回到最初的小岛啦。');
  }, [sync, stopSpeech]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z' || /INPUT|TEXTAREA/.test((event.target as HTMLElement).tagName)) return;
      event.preventDefault(); if (event.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle);
  }, [undo, redo]);
  return { snapshot, messages, draft, setDraft, phase, status, notice, health, speakerEnabled,
    setSpeakerEnabled: (enabled: boolean) => { speakerEnabledRef.current = enabled; setSpeakerEnabled(enabled); if (!enabled) stopSpeech(); }, saveState,
    mode, setMode, selectedColor, setSelectedColor, viewAction,
    view: (kind: 'zoomIn' | 'zoomOut' | 'reset') => setViewAction(v => ({ kind, seq: (v?.seq ?? 0) + 1 })),
    save, exportProject, importProject, send, toggleRecord, cancel, pick, undo, redo, rename, reset, debugApply, recentTurns,
    retry: () => send(lastPrompt.current), elapsed: recorder.elapsed,
    canUndo: engine.current?.canUndo ?? false, canRedo: engine.current?.canRedo ?? false,
    busy: phase !== 'idle',
  };
}

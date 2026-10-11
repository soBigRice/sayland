import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { animate, AnimatePresence, LayoutGroup, motion, MotionConfig, useReducedMotion } from 'motion/react';
import { FloatingPanel, panelSpring } from './FloatingPanel.tsx';
import type { HoldToTalk } from '../lib/holdToTalk.ts';
import { IslandCompanion } from './IslandCompanion.tsx';
import {
  ArrowDownToLine, ArrowUpFromLine, Box, Check, Focus, House, CircleAlert, Leaf, Minimize2, PanelsTopLeft,
  LoaderCircle, MessageCircle, Mic, Minus, Palette, Pencil, Plus, Redo2,
  RotateCcw, Send, Settings, Sparkles, Square, TreePine, Undo2,
  Volume2, Waves, X,
} from 'lucide-react';
import '../styles/styles.css';
import '../styles/companion-composer.css';

export type ComposerState = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'thinking' | 'building';
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Ordinary intermediate model text or an acknowledged batch reply; excluded from future model context. */
  kind?: 'progress';
  status?: 'pending' | 'error';
  /** Derived for the current UI; omitted from saved projects. */
  retryable?: boolean;
}
export interface ServiceStatus { configured: boolean; label?: string }

export interface HeaderProps {
  title: string;
  onTitleChange: (title: string) => void;
  onRetrySave: () => void;
  onOpenSettings: () => void;
  saveState: 'saving' | 'saved' | 'error';
  onGoHome: () => void;
  leaving: boolean;
  backgroundTasks?: number;
}

export function Header({ title, onTitleChange, onRetrySave, onOpenSettings, saveState, onGoHome, leaving, backgroundTasks = 0 }: HeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const editCycle = useRef(false);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);
  function startEditing() {
    setDraftTitle(title);
    editCycle.current = true;
    setEditing(true);
  }
  function finishEditing(commit = true) {
    if (!editCycle.current) return;
    editCycle.current = false;
    if (commit) {
      const nextTitle = draftTitle.trim() || '我的第一座小岛';
      if (nextTitle !== title) onTitleChange(nextTitle);
    }
    setEditing(false);
  }
  return <header className="app-header">
    <div className="brand" aria-label="说说岛 Sayland">
      <img className="brand-mascot" src="/mascot.png" alt="" />
      <div className="brand-wordmark"><span>说说岛</span><small>Sayland</small></div>
    </div>
    <div className="project-name">
      {editing ? <input ref={inputRef} aria-label="作品名称" value={draftTitle} maxLength={32}
        onChange={(event) => setDraftTitle(event.target.value)} onBlur={() => finishEditing()}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) finishEditing(); if (event.key === 'Escape') finishEditing(false); }} />
        : <button className="project-name-button" onClick={startEditing} aria-label={`修改作品名称：${title}`}>
          <span>{title}</span><Pencil size={21} aria-hidden="true" />
        </button>}
    </div>
    <div className="header-actions">
      <button type="button" className="icon-button scene-library-button" disabled={leaving} onClick={onGoHome} aria-label="返回项目首页" title="返回首页，后台任务会继续"><House aria-hidden="true" />{backgroundTasks > 0 && <span className="background-count">{backgroundTasks}</span>}</button>
      <div className={`project-save-status save-${saveState}`} role="status" aria-live="polite" title="作品、对话与草稿自动保存到后台">
        {saveState === 'saving' ? <LoaderCircle className="spin" aria-hidden="true" /> : saveState === 'error' ? <CircleAlert aria-hidden="true" /> : <Check aria-hidden="true" />}
        <span>{saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : '已自动保存'}</span>
        {saveState === 'error' && <button type="button" onClick={onRetrySave}>重试</button>}
      </div>
      <button className="icon-button settings-button" onClick={onOpenSettings} aria-label="打开设置"><Settings aria-hidden="true" /></button>
    </div>
  </header>;
}

export interface ToolRailProps {
  onUndo: () => void;
  canUndo: boolean;
  disabled?: boolean;
}

export function ToolRail({ onUndo, canUndo, disabled = false }: ToolRailProps) {
  return <div className="tool-area">
    <nav className="tool-rail" aria-label="小岛工具">
      <button className="tool-button" disabled={!canUndo || disabled} onClick={onUndo} aria-label="撤销上一次搭建"><Undo2 aria-hidden="true" /><span>撤销</span></button>
    </nav>
  </div>;
}

export interface ChatPanelProps {
  messages: ChatMessage[];
  busy?: boolean;
  status?: string;
  onSuggestion?: (prompt: string) => void;
  onRetry?: (messageId: string) => void;
}

export function ChatPanel({ messages, busy = false, status, onSuggestion, onRetry }: ChatPanelProps) {
  const [historyOpen, setHistoryOpen] = useState(true);
  const [following, setFollowing] = useState(true);
  const historyId = useId();
  const historyButton = useRef<HTMLButtonElement>(null);
  const historyScroll = useRef<HTMLDivElement>(null);
  const previousUser = useRef<string | undefined>(undefined);
  const lastUser = messages.findLastIndex(message => message.role === 'user');
  // Progress bubbles precede the pending final answer; prefer the newest actual reply in this turn.
  const latest = messages.findLast((message, index) => index > lastUser && message.role === 'assistant' && message.status !== 'pending')
    ?? messages.findLast(message => message.role === 'assistant');
  // New user turns resume following; incoming progress must not interrupt reading older messages.
  useEffect(() => {
    const userId = messages[lastUser]?.id;
    const newTurn = userId !== previousUser.current;
    previousUser.current = userId;
    if (newTurn) setFollowing(true);
    if (historyOpen && (following || newTurn) && historyScroll.current) historyScroll.current.scrollTop = historyScroll.current.scrollHeight;
  }, [historyOpen, messages, following, lastUser]);
  function closeHistory() { setHistoryOpen(false); historyButton.current?.focus({ preventScroll: true }); }
  return <section className="companion-dialogue" aria-label="小岛伙伴对话" onKeyDown={event => {
    if (event.key === 'Escape' && historyOpen && !event.defaultPrevented) { event.preventDefault(); closeHistory(); }
  }}>
    <div className="companion-dialogue-heading">
      <span className="companion-name"><span aria-hidden="true" />小岛伙伴</span>
      <button ref={historyButton} type="button" className="history-toggle" aria-expanded={historyOpen} aria-controls={historyOpen ? historyId : undefined} onClick={() => { setFollowing(true); setHistoryOpen(open => !open); }}>
        <MessageCircle size={15} aria-hidden="true" />{historyOpen ? '收起对话' : '完整对话'}
      </button>
    </div>
    {!historyOpen && <div className={`companion-latest ${latest?.status === 'error' ? 'is-error' : ''}`} role="log" tabIndex={0} aria-label="伙伴的最新回复" aria-live="polite" aria-atomic="true">
      <p>{latest?.status === 'pending' && <LoaderCircle className="spin pending-icon" size={16} aria-hidden="true" />}{latest?.text || '想搭点什么？说出来，我们一起搭！'}</p>
    </div>}
    {!historyOpen && latest?.status === 'error' && latest.retryable === true && onRetry && <button type="button" className="retry-button" disabled={busy} onClick={() => onRetry(latest.id)}><RotateCcw size={15} aria-hidden="true" />再试一次</button>}
    {historyOpen && <div id={historyId} className="companion-history" role="region" aria-label="完整对话记录">
      <div ref={historyScroll} className="chat-messages" role="log" aria-live={following ? 'polite' : 'off'} aria-relevant="additions text" tabIndex={0} aria-label="滚动查看对话记录"
        onScroll={event => { const element = event.currentTarget; setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 24); }}
        onKeyDown={event => { if (event.code === 'Space') event.stopPropagation(); }}>
        {messages.length === 0 && <p className="history-empty">还没有聊过，告诉我你的第一个想法吧。</p>}
        {messages.map(message => <div key={message.id} className={`chat-bubble ${message.role} ${message.kind === 'progress' ? 'is-progress' : ''} ${message.status === 'error' ? 'is-error' : ''}`}>
          <span className="sr-only">{message.role === 'user' ? '你说：' : '小岛伙伴：'}</span>
          {message.status === 'pending' && <LoaderCircle className="spin pending-icon" size={16} aria-hidden="true" />}
          <p>{message.text}</p>
          {message.status === 'error' && message.retryable === true && onRetry && <button type="button" className="retry-button" disabled={busy} onClick={() => onRetry(message.id)}><RotateCcw size={15} aria-hidden="true" />再试一次</button>}
        </div>)}
        {onSuggestion && !busy && messages.some(message => message.role === 'assistant' && message.kind !== 'progress' && !message.status) && <button type="button" className="chat-suggestion" onClick={() => onSuggestion('把小房子的屋顶换成紫色')}><Palette size={17} aria-hidden="true" />换个颜色</button>}
      </div>
      {!following && <button type="button" className="history-follow" onClick={() => setFollowing(true)}><ArrowDownToLine size={13} aria-hidden="true" />回到最新</button>}
    </div>}
    {busy && status && <div className="dialogue-task" role="status"><LoaderCircle size={12} className="spin" aria-hidden="true" /><span>{status}</span></div>}
  </section>;
}

export interface VoiceComposerProps {
  conversation?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  recordControl: Pick<HoldToTalk, 'begin' | 'end' | 'cancel'>;
  onCancelRecording: () => void;
  onCancelTask: () => void;
  state: ComposerState;
  elapsedSeconds?: number;
  error?: string;
  microphoneAvailable?: boolean;
  allowQueue?: boolean;
  disabled?: boolean;
}

const composerLabels: Record<ComposerState, string> = {
  idle: '按住空格说话，松开发送', requesting: '正在打开麦克风，请继续按住…', recording: '我在听，松开就发送', transcribing: '听到了，让我认一认…',
  thinking: '让我想想怎么搭…', building: '方块正在排好队…',
};

export function VoiceComposer({ conversation, value, onChange, onSend, recordControl, onCancelRecording, onCancelTask, state,
  elapsedSeconds = 0, error, microphoneAvailable = true, allowQueue = false, disabled = false }: VoiceComposerProps) {
  const recording = state === 'recording';
  const busy = state !== 'idle' && !recording;
  const background = state === 'thinking' || state === 'building';
  const canSend = !disabled && (state === 'idle' || background && allowQueue) && value.trim().length > 0;
  function handleSubmit(event: FormEvent) { event.preventDefault(); if (canSend) onSend(); }
  return <div className="composer-area">
    {error && <div className="composer-notice" role="alert">{error}</div>}
    <form className={`voice-composer composer-${state}`} onSubmit={handleSubmit} aria-label="告诉小岛伙伴你的想法">
      <button className="companion-record" type="button" data-hold-to-talk disabled={disabled || (busy && state !== 'requesting' && !(background && allowQueue)) || !microphoneAvailable}
        onPointerDown={event => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          if (recordControl.begin(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={event => { event.preventDefault(); recordControl.end(event.pointerId); }}
        onPointerCancel={event => recordControl.cancel(event.pointerId)}
        onLostPointerCapture={event => recordControl.cancel(event.pointerId)}
        onContextMenu={event => event.preventDefault()}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) recordControl.begin('enter'); } }}
        onKeyUp={event => { if (event.key === 'Enter') { event.preventDefault(); recordControl.end('enter'); } }}
        aria-label="按住说话，松开发送" aria-pressed={recording} aria-keyshortcuts="Space"
        title={!microphoneAvailable ? '当前浏览器不能录音，可以打字创作' : '按住伙伴或空格键说话，松开发送；Esc 取消'}>
        <IslandCompanion state={state} />
        <span className="companion-record-label" aria-hidden="true">
          {recording ? <Square size={12} fill="currentColor" /> : busy ? <LoaderCircle size={13} className="spin" /> : <Mic size={13} />}
          {recording ? '松开发送' : busy ? '陪你一起搭' : !microphoneAvailable ? '可以打字哦' : '按住说话'}
        </span>
      </button>
      <div className="composer-bubble">
        {conversation}
        <div className="composer-entry">
        <div className="composer-content">
          <div className="composer-title" aria-live="polite"><span>{background && allowQueue ? '后台搭建中，还可以添加下一个想法' : composerLabels[state]}</span></div>
          {recording ? <div className="recording-detail">
            <div className="voice-wave" aria-hidden="true">{Array.from({ length: 10 }, (_, index) => <i key={index} style={{ animationDelay: `${index * 0.08}s` }} />)}</div>
            <span className="recording-time" aria-label={`已录音 ${elapsedSeconds} 秒`}>{Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, '0')}</span>
            <button type="button" className="text-button" onClick={onCancelRecording}>取消录音</button>
          </div> : busy && !(background && allowQueue) ? <div className="working-detail">
            {state === 'requesting' ? '显示“我在听”后再说话；此时松开会取消' : state === 'transcribing' ? '正在把声音变成文字' : state === 'building' ? '看，你的想象正在小岛上出现' : '想法收到啦，让我准备一下'}
          </div> : <textarea aria-label="输入你的搭建想法" disabled={disabled} rows={2} maxLength={1500} value={value} onChange={(event) => onChange(event.target.value)} placeholder="也可以在这里打字告诉我…"
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSend) onSend(); } }} />}
        </div>
        {recording ? <span className="composer-action finish-recording" aria-hidden="true"><Mic size={18} /><span>松开发送</span></span>
          : background && allowQueue ? <div className="composer-queue-actions"><button type="submit" className="send-button" disabled={!canSend} aria-label="添加到任务队列"><Plus size={23} aria-hidden="true" /></button><button type="button" className="queue-stop" onClick={onCancelTask}>停止本轮</button></div>
          : busy ? <button type="button" className="composer-action stop-task" onClick={onCancelTask}><Square size={17} fill="currentColor" aria-hidden="true" /><span>{state === 'requesting' ? '取消' : '停止'}</span></button>
            : <button type="submit" className="send-button" disabled={!canSend} aria-label="发送搭建想法"><Send size={23} aria-hidden="true" /></button>}
        </div>
      </div>
    </form>
  </div>;
}

export interface SceneShellProps {
  sceneFrameRef?: RefObject<HTMLDivElement | null>;
  activity?: ComposerState;
  taskActivity?: ReactNode;
  header: ReactNode;
  toolbar: ReactNode;
  composer: ReactNode;
  children: ReactNode;
  controls?: ReactNode;
  suggestions?: ReactNode;
  status?: ReactNode;
}

type PanelName = 'header' | 'tools' | 'view' | 'suggestions' | 'composer';

export function SceneShell({ sceneFrameRef, activity = 'idle', taskActivity, header, toolbar, composer, children, controls, suggestions, status }: SceneShellProps) {
  const [collapsed, setCollapsed] = useState<Record<PanelName, boolean>>(() => ({
    header: false, tools: false, view: false, suggestions: false, composer: false,
  }));
  const [focused, setFocused] = useState(false);
  const focusButton = useRef<HTMLButtonElement>(null);
  const reduced = useReducedMotion();
  const groupId = useId();
  const active = activity !== 'idle';
  function toggle(name: PanelName) {
    if (focused) setFocused(false);
    setCollapsed(current => ({ ...current, [name]: !current[name] }));
  }
  function toggleFocus() {
    focusButton.current?.focus({ preventScroll: true });
    setFocused(value => !value);
  }
  useEffect(() => {
    if (!focused) return;
    const restore = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { setFocused(false); focusButton.current?.focus({ preventScroll: true }); }
    };
    window.addEventListener('keydown', restore);
    return () => window.removeEventListener('keydown', restore);
  }, [focused]);
  return <MotionConfig reducedMotion="user" transition={panelSpring}><LayoutGroup id={groupId}>
    <main className={`sayland-app ${focused ? 'is-focused' : ''}`} onKeyDownCapture={event => {
      // Let the existing hold-to-talk listener cancel before any panel consumes Escape to collapse.
      if (event.key === 'Escape' && (activity === 'recording' || activity === 'requesting')) event.preventDefault();
    }}>
      <section className="scene-stage" aria-label="可以旋转和搭建的三维小岛">
        <div className="scene-canvas">{children}</div>
      </section>
      <div className="scene-overlay">
        {taskActivity && <div className="task-activity-slot" hidden={focused}>{taskActivity}</div>}
        <FloatingPanel name="header" label="作品栏" icon={<img src="/mascot.png" alt="" />} collapsed={collapsed.header} hidden={focused} onToggle={() => toggle('header')}>{header}</FloatingPanel>
        <div className="creation-layout">
          <div ref={sceneFrameRef} className="scene-tools">
            <FloatingPanel name="tools" label="工具栏" icon={<Box aria-hidden="true" />} collapsed={collapsed.tools} hidden={focused} onToggle={() => toggle('tools')}>{toolbar}</FloatingPanel>
            <FloatingPanel name="view" label="视角控制" icon={<Focus aria-hidden="true" />} collapsed={collapsed.view} hidden={focused} onToggle={() => toggle('view')}>
              <div className="scene-controls-group">{controls}{status && <div className="scene-status" aria-live="polite">{status}</div>}</div>
            </FloatingPanel>
          </div>
        </div>
        <div className="creation-dock">
          <FloatingPanel name="suggestions" label="灵感建议" icon={<Sparkles aria-hidden="true" />} collapsed={collapsed.suggestions} hidden={focused} onToggle={() => toggle('suggestions')}>{suggestions}</FloatingPanel>
          <FloatingPanel name="composer" label="创作输入" icon={<IslandCompanion state={activity} />} collapsed={focused || collapsed.composer} hidden={focused && !active} active={active}
            summary={active ? composerLabels[activity] : undefined} onToggle={() => { if (focused) { setFocused(false); setCollapsed(value => ({ ...value, composer: false })); } else toggle('composer'); }}>{composer}</FloatingPanel>
        </div>
        <motion.button ref={focusButton} className="focus-toggle" type="button" aria-label={focused ? '展开全部界面' : '收起全部界面'}
          aria-pressed={focused} title={focused ? '展开界面 · Esc' : '专心看小岛'} onClick={toggleFocus}
          whileHover={reduced ? undefined : { scale: 1.055, transition: { duration: 0.18 } }} whileTap={reduced ? undefined : { scale: 0.94, transition: { duration: 0.1 } }}>
          <motion.span animate={{ rotate: reduced ? 0 : focused ? 180 : 0 }} transition={panelSpring}>
            {focused ? <PanelsTopLeft aria-hidden="true" /> : <Minimize2 aria-hidden="true" />}
          </motion.span>
        </motion.button>
      </div>
    </main>
  </LayoutGroup></MotionConfig>;
}

export interface SceneControlsProps { onZoomIn: () => void; onZoomOut: () => void; onResetView: () => void }
export function SceneControls({ onZoomIn, onZoomOut, onResetView }: SceneControlsProps) {
  return <div className="scene-controls" role="group" aria-label="小岛视角">
    <button className="icon-button" onClick={onZoomIn} aria-label="放大小岛"><Plus aria-hidden="true" /></button>
    <button className="icon-button" onClick={onZoomOut} aria-label="缩小小岛"><Minus aria-hidden="true" /></button>
    <button className="icon-button" onClick={onResetView} aria-label="回到初始视角"><Focus aria-hidden="true" /></button>
  </div>;
}

export function SuggestionChips({ onSelect, disabled = false }: { onSelect: (prompt: string) => void; disabled?: boolean }) {
  return <div className="suggestion-chips" aria-label="试试这些想法">
    <button onClick={() => onSelect('在小房子旁边种一棵大树')} disabled={disabled}><TreePine aria-hidden="true" /><span>种一棵大树</span></button>
    <button onClick={() => onSelect('在小岛上加一条小河')} disabled={disabled}><Waves aria-hidden="true" /><span>加一条小河</span></button>
  </div>;
}

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  speakerEnabled: boolean;
  onSpeakerChange: (enabled: boolean) => void;
  modelStatus: ServiceStatus;
  asrStatus: ServiceStatus;
  ttsStatus: ServiceStatus;
  onExport: () => void;
  onExportModel: () => void;
  onImport: (file: File) => void;
  onReset: () => void;
  onRedo: () => void;
  canRedo: boolean;
  busy?: boolean;
}

export function SettingsDialog({ open, onClose, speakerEnabled, onSpeakerChange, modelStatus, asrStatus, ttsStatus,
  onExport, onExportModel, onImport, onReset, onRedo, canRedo, busy = false }: SettingsDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const headingId = useId();
  const reduced = useReducedMotion();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || (!open && !dialog.open)) return;
    let cancelled = false;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.style.opacity = '0';
      dialog.style.transform = reduced ? 'none' : 'translateY(12px) scale(0.97)';
    }
    const playback = animate(dialog, { opacity: open ? 1 : 0, y: reduced || open ? 0 : 10, scale: reduced || open ? 1 : 0.97 }, { duration: reduced ? 0 : open ? 0.55 : 0.35, ease: [0.22, 1, 0.36, 1] });
    void playback.then(() => { if (!cancelled && !open) { dialog.close(); setConfirmReset(false); } });
    return () => { cancelled = true; playback.stop(); };
  }, [open, reduced]);
  const services = [{ name: '想象力 · DeepSeek', status: modelStatus }, { name: '听你说 · 小米 ASR', status: asrStatus }, { name: '说给你听 · 小米 TTS', status: ttsStatus }];
  return <dialog ref={ref} className="settings-dialog" aria-labelledby={headingId} onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="settings-content">
      <div className="dialog-heading"><div><span className="settings-leaf"><Leaf size={21} aria-hidden="true" /></span><h2 id={headingId}>小岛设置</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭设置"><X /></button></div>
      <section className="settings-section" aria-labelledby="voice-setting-heading">
        <h3 id="voice-setting-heading">伙伴的声音</h3>
        <div className="setting-row"><div className="setting-label"><Volume2 size={22} aria-hidden="true" /><div><strong>语音回应</strong><p>搭建完成后，伙伴会念给你听</p></div></div>
          <button className={`toggle-switch ${speakerEnabled ? 'is-on' : ''}`} role="switch" aria-checked={speakerEnabled} aria-label="语音回应" onClick={() => onSpeakerChange(!speakerEnabled)}><span /></button>
        </div>
      </section>
      <section className="settings-section" aria-labelledby="works-setting-heading">
        <h3 id="works-setting-heading">我的小岛作品</h3>
        <p className="section-hint">当前场景已由本机后台保存，导出一份就能随身带走。</p>
        <div className="settings-actions">
          <button className="secondary-button" onClick={onExport} disabled={busy}><ArrowDownToLine size={20} aria-hidden="true" />导出作品</button>
          <button className="secondary-button" onClick={() => importRef.current?.click()} disabled={busy}><ArrowUpFromLine size={20} aria-hidden="true" />导入作品</button>
          <button className="secondary-button" onClick={onRedo} disabled={!canRedo || busy}><Redo2 size={20} aria-hidden="true" />重做一步</button>
        </div>
        <input ref={importRef} className="sr-only" type="file" accept=".json,application/json" aria-label="选择小岛作品文件" tabIndex={-1}
          onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = ''; }} />
      </section>
      <section className="settings-section" aria-labelledby="model-export-heading">
        <h3 id="model-export-heading">把小岛带到现实</h3>
        <p className="section-hint">选择全部或部分模型，打包 3MF、FBX 和材质，送到切片软件继续准备。</p>
        <button className="secondary-button" onClick={onExportModel} disabled={busy}><Box size={20} aria-hidden="true" />导出 3D 模型</button>
      </section>
      <section className="settings-section" aria-labelledby="service-setting-heading">
        <h3 id="service-setting-heading">伙伴的连接</h3>
        <div className="service-list">{services.map(({ name, status }) => <div className="service-row" key={name}><span>{name}</span><span className={`service-state ${status.configured ? 'is-ready' : ''}`}><i />{status.label ?? (status.configured ? '已配置' : '待连接')}</span></div>)}</div>
      </section>
      <div className="reset-section">
        {confirmReset ? <div className="reset-confirm"><p>回到最初的小岛？现在的作品会被替换，请先导出备份。</p><div><button className="secondary-button" onClick={() => setConfirmReset(false)}>先不恢复</button><button className="reset-confirm-button" disabled={busy} onClick={() => { onReset(); setConfirmReset(false); onClose(); }}>确认恢复</button></div></div>
          : <button className="text-button reset-button" disabled={busy} onClick={() => setConfirmReset(true)}><RotateCcw size={17} aria-hidden="true" />恢复最初的小岛</button>}
      </div>
      <div className="settings-footnote"><Sparkles size={15} aria-hidden="true" /><span>每一个小想法，都能变成大世界。</span></div>
    </div>
  </dialog>;
}

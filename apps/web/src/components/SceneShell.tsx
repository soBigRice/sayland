import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { animate, AnimatePresence, LayoutGroup, motion, MotionConfig, useReducedMotion } from 'motion/react';
import { FloatingPanel, panelSpring } from './FloatingPanel.tsx';
import {
  ArrowDownToLine, ArrowUpFromLine, Box, Check, Focus, Leaf, Minimize2, PanelsTopLeft,
  LoaderCircle, MessageCircle, Mic, Minus, Palette, Pencil, Plus, Redo2,
  RotateCcw, RotateCw, Send, Settings, Sparkles, Square, TreePine, Undo2,
  Volume2, Waves, X,
} from 'lucide-react';
import '../styles/styles.css';

export type ToolMode = 'orbit' | 'build' | 'paint';
export type ComposerState = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'thinking' | 'building';
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: 'pending' | 'error';
}
export interface ServiceStatus { configured: boolean; label?: string }

export interface HeaderProps {
  title: string;
  onTitleChange: (title: string) => void;
  onSave: () => void;
  onOpenSettings: () => void;
  saveState?: 'idle' | 'saved';
}

export function Header({ title, onTitleChange, onSave, onOpenSettings, saveState = 'idle' }: HeaderProps) {
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
      <button className={`save-button ${saveState === 'saved' ? 'is-saved' : ''}`} onClick={onSave} aria-label="保存作品到这台设备">
        {saveState === 'saved' ? <Check size={22} aria-hidden="true" /> : <ArrowUpFromLine size={22} aria-hidden="true" />}
        <span>{saveState === 'saved' ? '已保存' : '保存作品'}</span>
      </button>
      <button className="icon-button settings-button" onClick={onOpenSettings} aria-label="打开设置"><Settings aria-hidden="true" /></button>
    </div>
  </header>;
}

export interface ToolRailProps {
  mode: ToolMode;
  onModeChange: (mode: ToolMode) => void;
  onUndo: () => void;
  canUndo: boolean;
  selectedColor: string;
  onColorChange: (color: string) => void;
  disabled?: boolean;
}

const colors = [
  { value: '#80be45', name: '小草绿' }, { value: '#f9d968', name: '阳光黄' },
  { value: '#ef7551', name: '珊瑚红' }, { value: '#64c4e8', name: '天空蓝' },
  { value: '#a697dd', name: '葡萄紫' }, { value: '#f1b8cb', name: '桃子粉' },
  { value: '#f5ead0', name: '奶油白' }, { value: '#a47951', name: '树干棕' },
];

export function ToolRail({ mode, onModeChange, onUndo, canUndo, selectedColor, onColorChange, disabled = false }: ToolRailProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteId = useId();
  return <div className="tool-area">
    <nav className="tool-rail" aria-label="小岛工具">
      <button className={`tool-button ${mode === 'orbit' ? 'is-active' : ''}`} aria-pressed={mode === 'orbit'} disabled={disabled}
        onClick={() => { onModeChange('orbit'); setPaletteOpen(false); }} aria-label="旋转小岛"><RotateCw aria-hidden="true" /><span>旋转</span></button>
      <button className={`tool-button ${mode === 'build' ? 'is-active' : ''}`} aria-pressed={mode === 'build'} disabled={disabled}
        onClick={() => { onModeChange('build'); setPaletteOpen(false); }} aria-label="添加方块"><Box aria-hidden="true" /><span>方块</span></button>
      <button className={`tool-button ${mode === 'paint' ? 'is-active' : ''}`} aria-pressed={mode === 'paint'} disabled={disabled}
        aria-expanded={paletteOpen} aria-controls={paletteId} onClick={() => { onModeChange('paint'); setPaletteOpen(!paletteOpen); }} aria-label="选择颜色并涂色">
        <Palette aria-hidden="true" /><span>颜色</span><i className="selected-color-dot" style={{ background: selectedColor }} />
      </button>
      <span className="tool-divider" aria-hidden="true" />
      <button className="tool-button" disabled={!canUndo || disabled} onClick={onUndo} aria-label="撤销上一次搭建"><Undo2 aria-hidden="true" /><span>撤销</span></button>
    </nav>
    <AnimatePresence initial={false}>{paletteOpen && <motion.div id={paletteId} className="color-popover" role="group" aria-label="选择方块颜色"
      initial={{ opacity: 0, scale: 0.94, x: -8 }} animate={{ opacity: 1, scale: 1, x: 0 }}
      exit={{ opacity: 0, scale: 0.96, x: -6 }} transition={{ duration: 0.18 }} style={{ transformOrigin: 'top left' }}>
      <div className="popover-heading"><strong>选个喜欢的颜色</strong><button className="small-icon-button" onClick={() => setPaletteOpen(false)} aria-label="收起颜色"><X size={17} /></button></div>
      <div className="color-swatches">{colors.map((color) => <button key={color.value} className="color-swatch" style={{ backgroundColor: color.value }}
        aria-label={color.name} aria-pressed={selectedColor.toLowerCase() === color.value} title={color.name} onClick={() => onColorChange(color.value)}>
        {selectedColor.toLowerCase() === color.value && <Check size={21} aria-hidden="true" />}
      </button>)}</div>
      <label className="custom-color"><span>更多颜色</span><input type="color" aria-label="自定义方块颜色" value={selectedColor} onChange={(event) => onColorChange(event.target.value)} /></label>
      <p>选好后，点一下小岛上的方块。</p>
    </motion.div>}</AnimatePresence>
  </div>;
}

export interface ChatPanelProps {
  messages: ChatMessage[];
  busy?: boolean;
  onSuggestion?: (prompt: string) => void;
  onRetry?: () => void;
}

export function ChatPanel({ messages, busy = false, onSuggestion, onRetry }: ChatPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' }); }, [messages]);
  return <div className="chat-panel">
    <div className="companion-heading">
      <img src="/mascot.png" alt="头上长着小绿芽的黄色方块伙伴" className="companion-mascot" />
      <h2>小岛伙伴</h2>
    </div>
    <div className="chat-messages" role="log" aria-label="与小岛伙伴的对话" aria-live="polite" aria-relevant="additions text">
      {messages.length === 0 && <div className="chat-bubble assistant"><p>你好呀！<br />我们一起把想象变成小岛吧。</p></div>}
      {messages.map((message) => <div key={message.id} className={`chat-bubble ${message.role} ${message.status === 'error' ? 'is-error' : ''}`}>
        <span className="sr-only">{message.role === 'user' ? '你说：' : '小岛伙伴：'}</span>
        {message.status === 'pending' && <LoaderCircle className="spin pending-icon" size={18} aria-hidden="true" />}
        <p>{message.text}</p>
        {message.status === 'error' && onRetry && <button className="retry-button" disabled={busy} onClick={onRetry}><RotateCcw size={15} aria-hidden="true" />再试一次</button>}
      </div>)}
      {onSuggestion && !busy && messages.some((message) => message.role === 'assistant' && message.status !== 'error' && message.status !== 'pending') && <button className="chat-suggestion" onClick={() => onSuggestion('把小房子的屋顶换成紫色')}><Palette size={19} aria-hidden="true" />换个颜色</button>}
      <div ref={endRef} />
    </div>
  </div>;
}

export interface VoiceComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onRecordToggle: () => void;
  onCancelRecording: () => void;
  onCancelTask: () => void;
  state: ComposerState;
  elapsedSeconds?: number;
  error?: string;
  microphoneAvailable?: boolean;
}

const composerLabels: Record<ComposerState, string> = {
  idle: '点一下，说出你的想象', requesting: '正在打开麦克风…', recording: '我在听，说完再点一下', transcribing: '听到了，让我认一认…',
  thinking: '让我想想怎么搭…', building: '方块正在排好队…',
};

export function VoiceComposer({ value, onChange, onSend, onRecordToggle, onCancelRecording, onCancelTask, state,
  elapsedSeconds = 0, error, microphoneAvailable = true }: VoiceComposerProps) {
  const recording = state === 'recording';
  const busy = state !== 'idle' && !recording;
  const canSend = state === 'idle' && value.trim().length > 0;
  function handleSubmit(event: FormEvent) { event.preventDefault(); if (canSend) onSend(); }
  return <div className="composer-area">
    {error && <div className="composer-notice" role="alert">{error}</div>}
    <form className={`voice-composer ${recording ? 'is-recording' : ''}`} onSubmit={handleSubmit} aria-label="告诉小岛伙伴你的想法">
      <button className={`record-button ${recording ? 'is-recording' : ''}`} type="button" onClick={onRecordToggle} disabled={busy || !microphoneAvailable}
        aria-label={recording ? '结束录音并识别' : '开始录音'} title={!microphoneAvailable ? '当前浏览器不能录音，可以打字创作' : undefined}>
        {busy ? <LoaderCircle size={38} className="spin" aria-hidden="true" /> : recording ? <Square size={29} fill="currentColor" aria-hidden="true" /> : <Mic size={43} strokeWidth={2.1} aria-hidden="true" />}
      </button>
      <div className="composer-content">
        <div className="composer-title" aria-live="polite">
          <span>{composerLabels[state]}</span>
          {recording && <span className="recording-time">{Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, '0')}</span>}
        </div>
        {recording ? <div className="recording-detail"><div className="voice-wave" aria-hidden="true">{Array.from({ length: 15 }, (_, index) => <i key={index} style={{ animationDelay: `${index * 0.08}s` }} />)}</div><button type="button" className="text-button" onClick={onCancelRecording}>取消录音</button></div>
          : busy ? <div className="working-detail"><span>{state === 'requesting' ? '请允许使用麦克风，也可以取消后打字' : state === 'transcribing' ? '正在把声音变成文字' : '小岛马上就有新变化了'}</span><button type="button" className="text-button" onClick={onCancelTask}>停止</button></div>
            : <textarea aria-label="输入你的搭建想法" rows={1} maxLength={1500} value={value} onChange={(event) => onChange(event.target.value)} placeholder="也可以打字告诉我…"
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSend) onSend(); } }} />}
      </div>
      <span className="composer-divider" aria-hidden="true" />
      <button type="submit" className="send-button" disabled={!canSend} aria-label="发送搭建想法"><Send size={27} fill="currentColor" strokeWidth={1.3} aria-hidden="true" /></button>
    </form>
  </div>;
}

export interface SceneShellProps {
  sceneFrameRef?: RefObject<HTMLDivElement | null>;
  activity?: ComposerState;
  header: ReactNode;
  toolbar: ReactNode;
  chat: ReactNode;
  composer: ReactNode;
  children: ReactNode;
  controls?: ReactNode;
  suggestions?: ReactNode;
  status?: ReactNode;
}

type PanelName = 'header' | 'tools' | 'chat' | 'view' | 'suggestions' | 'composer';

export function SceneShell({ sceneFrameRef, activity = 'idle', header, toolbar, chat, composer, children, controls, suggestions, status }: SceneShellProps) {
  const [collapsed, setCollapsed] = useState<Record<PanelName, boolean>>(() => ({
    header: false, tools: false, chat: window.matchMedia('(max-width: 850px)').matches, view: false, suggestions: false, composer: false,
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
    <main className={`sayland-app ${focused ? 'is-focused' : ''}`}>
      <section className="scene-stage" aria-label="可以旋转和搭建的三维小岛">
        <div className="scene-canvas">{children}</div>
      </section>
      <div className="scene-overlay">
        <FloatingPanel name="header" label="作品栏" icon={<img src="/mascot.png" alt="" />} collapsed={collapsed.header} hidden={focused} onToggle={() => toggle('header')}>{header}</FloatingPanel>
        <div className="creation-layout">
          <div ref={sceneFrameRef} className="scene-tools">
            <FloatingPanel name="tools" label="工具栏" icon={<Box aria-hidden="true" />} collapsed={collapsed.tools} hidden={focused} onToggle={() => toggle('tools')}>{toolbar}</FloatingPanel>
            <FloatingPanel name="view" label="视角控制" icon={<Focus aria-hidden="true" />} collapsed={collapsed.view} hidden={focused} onToggle={() => toggle('view')}>
              <div className="scene-controls-group">{controls}{status && <div className="scene-status" aria-live="polite">{status}</div>}</div>
            </FloatingPanel>
          </div>
          <FloatingPanel name="chat" label="伙伴对话" icon={<MessageCircle aria-hidden="true" />} collapsed={collapsed.chat} hidden={focused} onToggle={() => toggle('chat')}>
            <aside className="companion-sidebar" aria-label="小岛伙伴对话">{chat}</aside>
          </FloatingPanel>
        </div>
        <div className="creation-dock">
          <FloatingPanel name="suggestions" label="灵感建议" icon={<Sparkles aria-hidden="true" />} collapsed={collapsed.suggestions} hidden={focused} onToggle={() => toggle('suggestions')}>{suggestions}</FloatingPanel>
          <FloatingPanel name="composer" label="创作输入" icon={<Mic aria-hidden="true" />} collapsed={focused || collapsed.composer} hidden={focused && !active} active={active}
            summary={active ? composerLabels[activity] : undefined} onToggle={() => { if (focused) { setFocused(false); setCollapsed(value => ({ ...value, composer: false })); } else toggle('composer'); }}>{composer}</FloatingPanel>
        </div>
        <motion.button ref={focusButton} className="focus-toggle" type="button" aria-label={focused ? '展开全部界面' : '收起全部界面'}
          aria-pressed={focused} title={focused ? '展开界面 · Esc' : '专心看小岛'} onClick={toggleFocus}
          whileHover={reduced ? undefined : { scale: 1.055 }} whileTap={reduced ? undefined : { scale: 0.94 }}>
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
  onImport: (file: File) => void;
  onReset: () => void;
  onRedo: () => void;
  canRedo: boolean;
  busy?: boolean;
}

export function SettingsDialog({ open, onClose, speakerEnabled, onSpeakerChange, modelStatus, asrStatus, ttsStatus,
  onExport, onImport, onReset, onRedo, canRedo, busy = false }: SettingsDialogProps) {
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
    const playback = animate(dialog, { opacity: open ? 1 : 0, y: reduced || open ? 0 : 10, scale: reduced || open ? 1 : 0.97 }, { duration: reduced ? 0 : open ? 0.24 : 0.16, ease: [0.22, 1, 0.36, 1] });
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
        <p className="section-hint">作品保存在这台设备，导出一份就能随身带走。</p>
        <div className="settings-actions">
          <button className="secondary-button" onClick={onExport} disabled={busy}><ArrowDownToLine size={20} aria-hidden="true" />导出作品</button>
          <button className="secondary-button" onClick={() => importRef.current?.click()} disabled={busy}><ArrowUpFromLine size={20} aria-hidden="true" />导入作品</button>
          <button className="secondary-button" onClick={onRedo} disabled={!canRedo || busy}><Redo2 size={20} aria-hidden="true" />重做一步</button>
        </div>
        <input ref={importRef} className="sr-only" type="file" accept=".json,application/json" aria-label="选择小岛作品文件" tabIndex={-1}
          onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = ''; }} />
      </section>
      <section className="settings-section" aria-labelledby="service-setting-heading">
        <h3 id="service-setting-heading">伙伴的连接</h3>
        <div className="service-list">{services.map(({ name, status }) => <div className="service-row" key={name}><span>{name}</span><span className={`service-state ${status.configured ? 'is-ready' : ''}`}><i />{status.label ?? (status.configured ? '已配置' : '待连接')}</span></div>)}</div>
      </section>
      <div className="reset-section">
        {confirmReset ? <div className="reset-confirm"><p>回到最初的小岛？现在的作品会被替换，请先保存或导出。</p><div><button className="secondary-button" onClick={() => setConfirmReset(false)}>先不恢复</button><button className="reset-confirm-button" disabled={busy} onClick={() => { onReset(); setConfirmReset(false); onClose(); }}>确认恢复</button></div></div>
          : <button className="text-button reset-button" disabled={busy} onClick={() => setConfirmReset(true)}><RotateCcw size={17} aria-hidden="true" />恢复最初的小岛</button>}
      </div>
      <div className="settings-footnote"><Sparkles size={15} aria-hidden="true" /><span>每一个小想法，都能变成大世界。</span></div>
    </div>
  </dialog>;
}

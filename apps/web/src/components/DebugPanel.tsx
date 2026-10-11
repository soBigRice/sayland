import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Box, ChevronDown, ChevronRight, Code2, Folder, Layers, LoaderCircle, RefreshCw, Search, Undo2, Redo2, X } from 'lucide-react';
import { type Operation, type ScenePlan, type SceneSnapshot, type ServiceHealth } from '../../../../packages/protocol/src/index.ts';
import '../styles/debug-panel.css';

export type DebugSelection = { kind: 'group' | 'part'; id: string } | null;
export interface DebugTurn { id: string; text: string; status?: string; plan?: ScenePlan; appliedBatches?: number; acknowledgedBatches?: number }
export interface DebugPanelProps {
  open: boolean;
  onClose: () => void;
  snapshot: SceneSnapshot;
  health: ServiceHealth | null;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onApply: (operations: Operation[]) => Promise<{ ok: boolean; error?: string }>;
  recentTurns: DebugTurn[];
  onReadTurn: (id: string, signal: AbortSignal) => Promise<unknown>;
  onSelectionChange?: (selection: DebugSelection) => void;
}

type Cell = { x: number; y: number; z: number };
type Bounds = { min: Cell; max: Cell };
type Part = SceneSnapshot['parts'][number];
type PartStats = { part: Part; count: number; bounds: Bounds | null; colors: Set<string> };
type GroupStats = { id: string; name: string; parts: PartStats[]; count: number; bounds: Bounds | null; colors: Set<string> };
const axes = ['x', 'y', 'z'] as const;
const roleNames: Record<Part['role'], string> = {
  floor: '地板', wall: '墙体', roof: '屋顶', door: '门', window: '窗', detail: '细节', other: '其他',
  terrain: '地形', water: '水体', plant: '植物', animal: '动物',
};

function extendBounds(bounds: Bounds | null, cell: Cell): Bounds {
  if (!bounds) return { min: { ...cell }, max: { ...cell } };
  for (const axis of axes) { bounds.min[axis] = Math.min(bounds.min[axis], cell[axis]); bounds.max[axis] = Math.max(bounds.max[axis], cell[axis]); }
  return bounds;
}

function sceneStatistics(snapshot: SceneSnapshot) {
  const parts = new Map<string, PartStats>(snapshot.parts.map(part => [part.id, { part, count: 0, bounds: null, colors: new Set<string>() }]));
  let bounds: Bounds | null = null;
  const colors = new Set<string>();
  for (const voxel of snapshot.voxels) {
    bounds = extendBounds(bounds, voxel.cell); colors.add(voxel.color.toLowerCase());
    const stats = parts.get(voxel.partId);
    if (stats) { stats.count++; stats.bounds = extendBounds(stats.bounds, voxel.cell); stats.colors.add(voxel.color.toLowerCase()); }
  }
  const groups = new Map<string, GroupStats>((snapshot.groups ?? []).map(group => [group.id, { ...group, parts: [], count: 0, bounds: null, colors: new Set<string>() }]));
  const ungrouped: PartStats[] = [];
  for (const stats of parts.values()) {
    const group = stats.part.groupId ? groups.get(stats.part.groupId) : undefined;
    if (!group) { ungrouped.push(stats); continue; }
    group.parts.push(stats); group.count += stats.count;
    for (const color of stats.colors) group.colors.add(color);
    if (stats.bounds) { group.bounds = extendBounds(group.bounds, stats.bounds.min); group.bounds = extendBounds(group.bounds, stats.bounds.max); }
  }
  return { parts, groups, ungrouped, bounds, colors };
}

function vectorText(cell: Cell) { return `${cell.x}, ${cell.y}, ${cell.z}`; }
function boundsText(bounds: Bounds | null) { return bounds ? `(${vectorText(bounds.min)}) → (${vectorText(bounds.max)})` : '没有方块'; }
function sizeText(bounds: Bounds | null) { return bounds ? axes.map(axis => bounds.max[axis] - bounds.min[axis] + 1).join(' × ') : '—'; }
function jsonText(value: unknown): string {
  // Diagnostics stay in component memory; credential-shaped fields are never displayed.
  return JSON.stringify(value, (key, item: unknown) => /^(authorization|api[-_]?key|(?:deepseek|mimo)[-_]api[-_]key|access[-_]?token|password|secret|reasoning_content|reasoning|chain_of_thought)$/i.test(key) ? '[已隐藏]' : item, 2) ?? '没有可显示的 JSON 内容';
}

export function DebugPanel({ open, onClose, snapshot, health, busy, canUndo, canRedo, onUndo, onRedo,
  onApply, recentTurns, onReadTurn, onSelectionChange }: DebugPanelProps) {
  const panelId = useId();
  const [tab, setTab] = useState<'scene' | 'requests'>('scene');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<DebugSelection>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [color, setColor] = useState('#80be45');
  const [delta, setDelta] = useState({ x: '0', y: '0', z: '0' });
  const [groupName, setGroupName] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [turnId, setTurnId] = useState('');
  const [diagnostics, setDiagnostics] = useState('');
  const [readError, setReadError] = useState('');
  const [reading, setReading] = useState(false);
  const reader = useRef<AbortController | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onClose, onSelectionChange }); callbacks.current = { onClose, onSelectionChange };
  const stats = useMemo(() => sceneStatistics(snapshot), [snapshot]);
  const selectedPart = selection?.kind === 'part' ? stats.parts.get(selection.id) : undefined;
  const selectedGroup = selection?.kind === 'group' ? stats.groups.get(selection.id) : undefined;
  const selectedStats = selectedPart ?? selectedGroup;
  const selectedName = selectedPart?.part.name ?? selectedGroup?.name;
  const selectedTurn = recentTurns.find(turn => turn.id === turnId);
  const query = search.trim().toLowerCase();

  useEffect(() => {
    if (!open) { setSelection(null); setDiagnostics(''); setReadError(''); setReading(false); return; }
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); callbacks.current.onClose(); } };
    document.addEventListener('keydown', escape);
    return () => {
      reader.current?.abort(); reader.current = null;
      document.removeEventListener('keydown', escape);
      callbacks.current.onSelectionChange?.(null);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [open]);

  useEffect(() => { callbacks.current.onSelectionChange?.(open ? selection : null); }, [open, selection]);
  useEffect(() => {
    if (selection && !(selection.kind === 'group' ? stats.groups.has(selection.id) : stats.parts.has(selection.id))) setSelection(null);
  }, [selection, stats]);
  useEffect(() => { setConfirmDelete(false); setFeedback(null); setDelta({ x: '0', y: '0', z: '0' }); }, [selection?.kind, selection?.id]);
  useEffect(() => { setGroupName(selectedGroup?.name ?? ''); }, [selectedGroup?.id, selectedGroup?.name]);
  useEffect(() => {
    if (!recentTurns.some(turn => turn.id === turnId)) setTurnId(recentTurns.at(-1)?.id ?? '');
  }, [recentTurns, turnId]);
  useEffect(() => {
    reader.current?.abort(); reader.current = null; setReading(false); setDiagnostics(''); setReadError('');
  }, [turnId]);

  async function apply(operations: Operation[], message: string): Promise<boolean> {
    if (busy) return false;
    try {
      const result = await onApply(operations);
      setFeedback({ text: result.ok ? message : result.error || '修改没有提交，场景保持原样。', error: !result.ok });
      return result.ok;
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : '修改没有提交，场景保持原样。', error: true }); return false;
    }
  }
  function toggleCollapsed(id: string) {
    setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function matchesPart(part: Part) { return !query || `${part.name} ${part.id} ${part.role} ${roleNames[part.role]}`.toLowerCase().includes(query); }
  function select(next: NonNullable<DebugSelection>) { setSelection(next); }
  function move(event: FormEvent) {
    event.preventDefault(); if (!selection) return;
    const parsed = { x: Number(delta.x), y: Number(delta.y), z: Number(delta.z) };
    if (axes.some(axis => !delta[axis].trim() || !Number.isSafeInteger(parsed[axis]))) {
      setFeedback({ text: '每个轴都需填写有限安全整数。', error: true }); return;
    }
    if (axes.every(axis => parsed[axis] === 0)) { setFeedback({ text: '至少一个轴需要移动一格。', error: true }); return; }
    apply([selection.kind === 'group' ? { op: 'translate_group', groupId: selection.id, delta: parsed } : { op: 'translate_part', partId: selection.id, delta: parsed }], '位移已提交，可撤销。');
  }
  function paint() {
    if (!selection) return;
    apply([selection.kind === 'group' ? { op: 'paint_group', groupId: selection.id, color } : { op: 'paint_part', partId: selection.id, color, region: null }], '颜色已提交，可撤销。');
  }
  async function remove() {
    if (!selection) return;
    if (await apply([selection.kind === 'group' ? { op: 'remove_group', groupId: selection.id } : { op: 'remove_part', partId: selection.id }], '已删除，可用撤销恢复。')) { setSelection(null); setConfirmDelete(false); }
  }
  async function createGroup(event: FormEvent) {
    event.preventDefault(); const name = newGroupName.trim(); if (!name) return;
    const id = `group-${crypto.randomUUID().slice(0, 12)}`;
    if (await apply([{ op: 'define_group', group: { id, name } }], '物件组已建立，可以为部件设置归属。')) { setNewGroupName(''); setSelection({ kind: 'group', id }); }
  }
  async function readTurn() {
    if (!turnId) return;
    reader.current?.abort(); const controller = new AbortController(); reader.current = controller;
    setReading(true); setReadError(''); setDiagnostics('');
    try {
      const value = await onReadTurn(turnId, controller.signal);
      if (!controller.signal.aborted && reader.current === controller) setDiagnostics(jsonText(value));
    } catch (error) {
      if (!controller.signal.aborted && reader.current === controller) setReadError(error instanceof Error ? error.message : '诊断信息读取失败。');
    } finally { if (reader.current === controller) { reader.current = null; setReading(false); } }
  }
  function partRow(item: PartStats) {
    return <li className="debug-part-item" key={item.part.id}>
      <button className={`debug-tree-row debug-part-row ${selection?.kind === 'part' && selection.id === item.part.id ? 'is-selected' : ''}`}
        onClick={() => select({ kind: 'part', id: item.part.id })} aria-pressed={selection?.kind === 'part' && selection.id === item.part.id} title={item.part.id}>
        <Box size={15} aria-hidden="true" /><span className="debug-tree-label"><strong>{item.part.name}</strong><code>{item.part.id}</code></span><span className="debug-row-count">{item.count.toLocaleString()}</span>
      </button>
    </li>;
  }
  if (!open) return null;

  return <aside className="sayland-debug" aria-labelledby={`${panelId}-title`}>
    <header className="debug-header">
      <div><span className="debug-eyebrow"><Code2 size={13} aria-hidden="true" />DEVELOPMENT</span><h2 id={`${panelId}-title`}>场景调试</h2></div>
      <button ref={closeRef} className="debug-icon-button" aria-label="关闭场景调试面板" onClick={onClose}><X size={20} aria-hidden="true" /></button>
    </header>
    <div className="debug-status-line"><span><i className={busy ? 'is-busy' : ''} />{busy ? '正在生成 · 修改已锁定' : '当前场景可编辑'}</span><code>revision {snapshot.revision}</code></div>
    <nav className="debug-tabs" aria-label="调试内容">
      <button className={tab === 'scene' ? 'is-active' : ''} aria-pressed={tab === 'scene'} onClick={() => setTab('scene')}><Layers size={16} aria-hidden="true" />场景与物件</button>
      <button className={tab === 'requests' ? 'is-active' : ''} aria-pressed={tab === 'requests'} onClick={() => setTab('requests')}><Code2 size={16} aria-hidden="true" />请求与计划</button>
    </nav>
    <div className="debug-content">
      {tab === 'scene' ? <>
        <section className="debug-section" aria-labelledby={`${panelId}-overview`}>
          <div className="debug-section-heading"><h3 id={`${panelId}-overview`}>已提交场景</h3><div className="debug-history"><button disabled={busy || !canUndo} onClick={() => { setFeedback(null); onUndo(); }} aria-label="撤销场景修改"><Undo2 size={15} aria-hidden="true" />撤销</button><button disabled={busy || !canRedo} onClick={() => { setFeedback(null); onRedo(); }} aria-label="重做场景修改"><Redo2 size={15} aria-hidden="true" />重做</button></div></div>
          <dl className="debug-metrics"><div><dt>物件组</dt><dd>{stats.groups.size}</dd></div><div><dt>部件</dt><dd>{snapshot.parts.length}</dd></div><div><dt>方块</dt><dd>{snapshot.voxels.length.toLocaleString()}</dd></div><div><dt>颜色</dt><dd>{stats.colors.size}</dd></div></dl>
          <div className="debug-world-bounds"><span>世界范围</span><code>{boundsText(stats.bounds)}</code></div>
          <p className="debug-help">世界格坐标显示方块的最小角；范围两端均包含在内。统计来自已提交的场景。</p>
        </section>
        <section className="debug-section" aria-labelledby={`${panelId}-tree`}>
          <div className="debug-section-heading"><h3 id={`${panelId}-tree`}>物件组 → 部件</h3><span className="debug-dim">点击条目查看和修改</span></div>
          <label className="debug-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索物件组或部件" placeholder="搜索名称、稳定 ID 或角色" value={search} onChange={event => setSearch(event.target.value)} /></label>
          <div className="debug-tree" aria-label="已提交场景的物件层级">
            {[...stats.groups.values()].map(group => {
              const groupMatches = !query || `${group.name} ${group.id}`.toLowerCase().includes(query);
              const parts = group.parts.filter(item => groupMatches || matchesPart(item.part));
              if (!groupMatches && !parts.length) return null;
              const expanded = Boolean(query) || !collapsed.has(group.id);
              return <div className="debug-group" key={group.id}>
                <div className={`debug-group-row ${selection?.kind === 'group' && selection.id === group.id ? 'is-selected' : ''}`}>
                  <button className="debug-disclosure" aria-label={`${expanded ? '收起' : '展开'}${group.name}`} aria-expanded={expanded} onClick={() => toggleCollapsed(group.id)} disabled={Boolean(query)}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>
                  <button className="debug-tree-row" onClick={() => select({ kind: 'group', id: group.id })} aria-pressed={selection?.kind === 'group' && selection.id === group.id} title={group.id}>
                    <Folder size={16} aria-hidden="true" /><span className="debug-tree-label"><strong>{group.name}</strong><code>{group.id}</code></span><span className="debug-row-count">{group.parts.length} 部件 · {group.count.toLocaleString()} 格</span>
                  </button>
                </div>
                {expanded && (parts.length ? <ul>{parts.map(partRow)}</ul> : <p className="debug-tree-empty">空物件组</p>)}
              </div>;
            })}
            {stats.ungrouped.some(item => matchesPart(item.part)) && <div className="debug-group debug-ungrouped"><div className="debug-ungrouped-heading"><Layers size={15} aria-hidden="true" /><span>未归组</span><small>{stats.ungrouped.length} 部件</small></div><ul>{stats.ungrouped.filter(item => matchesPart(item.part)).map(partRow)}</ul></div>}
            {!snapshot.parts.length && !stats.groups.size && <p className="debug-empty">场景里还没有物件或部件。</p>}
            {query && ![...stats.groups.values()].some(group => `${group.name} ${group.id}`.toLowerCase().includes(query) || group.parts.some(item => matchesPart(item.part))) && !stats.ungrouped.some(item => matchesPart(item.part)) && <p className="debug-empty">没有匹配的物件或部件。</p>}
          </div>
          <form className="debug-inline-form debug-new-group" onSubmit={createGroup}><label className="debug-field"><span>新物件组</span><input aria-label="新物件组名称" value={newGroupName} maxLength={80} disabled={busy} placeholder="例如：左边的小房子" onChange={event => setNewGroupName(event.target.value)} /></label><button className="debug-secondary" disabled={busy || !newGroupName.trim()} type="submit">新建</button></form>
        </section>
        <section className="debug-section debug-inspector" aria-labelledby={`${panelId}-inspector`}>
          <div className="debug-section-heading"><h3 id={`${panelId}-inspector`}>{selectedStats ? `${selection?.kind === 'group' ? '物件组' : '部件'} · ${selectedName}` : '选中项'}</h3>{selection && <button className="debug-text-button" onClick={() => setSelection(null)}>清除选中</button>}</div>
          {selectedStats && selection ? <>
            <dl className="debug-properties"><div><dt>稳定 ID</dt><dd><code>{selection.id}</code></dd></div>{selectedPart && <><div><dt>角色</dt><dd>{roleNames[selectedPart.part.role]} <code>{selectedPart.part.role}</code></dd></div><div><dt>部件原点</dt><dd><code>{vectorText(selectedPart.part.origin)}</code></dd></div></>}<div><dt>方块 / 颜色</dt><dd>{selectedStats.count.toLocaleString()} / {selectedStats.colors.size}</dd></div><div><dt>包围尺寸</dt><dd><code>{sizeText(selectedStats.bounds)}</code></dd></div><div><dt>世界范围</dt><dd><code>{boundsText(selectedStats.bounds)}</code></dd></div></dl>
            <fieldset className="debug-mutations" disabled={busy}>
              <legend className="debug-sr-only">修改选中的{selection.kind === 'group' ? '物件组' : '部件'}</legend>
              {selectedGroup && <form className="debug-inline-form" onSubmit={event => { event.preventDefault(); if (groupName.trim()) apply([{ op: 'rename_group', groupId: selectedGroup.id, name: groupName.trim() }], '物件组已重命名。'); }}><label className="debug-field"><span>物件组名称</span><input value={groupName} maxLength={80} aria-label="物件组名称" onChange={event => setGroupName(event.target.value)} /></label><button className="debug-secondary" disabled={!groupName.trim() || groupName.trim() === selectedGroup.name}>重命名</button></form>}
              {selectedPart && <label className="debug-field"><span>部件归属</span><select aria-label="部件所属物件组" value={selectedPart.part.groupId ?? ''} onChange={event => apply([{ op: 'assign_part_group', partId: selectedPart.part.id, groupId: event.target.value || null }], '部件归属已更新。')}><option value="">未归组</option>{[...stats.groups.values()].map(group => <option value={group.id} key={group.id}>{group.name} · {group.id}</option>)}</select></label>}
              <div className="debug-paint-row"><label className="debug-field"><span>整{selection.kind === 'group' ? '组' : '个部件'}改色</span><span className="debug-color-input"><input type="color" aria-label="调试改色" value={color} onChange={event => setColor(event.target.value)} /><code>{color.toUpperCase()}</code></span></label><button className="debug-secondary" onClick={paint} type="button" disabled={!selectedStats.count}>应用颜色</button></div>
              <form className="debug-move-form" onSubmit={move}><span className="debug-field-label">整数位移 · 世界坐标</span><div className="debug-move-inputs">{axes.map(axis => <label key={axis}><span>{axis.toUpperCase()}</span><input type="number" step={1} required aria-label={`${axis.toUpperCase()} 轴位移格数`} value={delta[axis]} onChange={event => setDelta(previous => ({ ...previous, [axis]: event.target.value }))} /></label>)}<button className="debug-secondary" type="submit">移动</button></div><p className="debug-help">+Y 向上，+Z 为正前方。碰撞或数值精度溢出时整笔修改不会提交。</p></form>
              {confirmDelete ? <div className="debug-delete-confirm"><p>{selection.kind === 'group' ? '删除物件组及组内所有部件和方块？' : '删除这个部件及其全部方块？'}可用撤销恢复。</p><div><button className="debug-secondary" type="button" onClick={() => setConfirmDelete(false)}>取消</button><button className="debug-danger" type="button" onClick={remove}>确认删除</button></div></div> : <button className="debug-text-button debug-delete" type="button" onClick={() => setConfirmDelete(true)}>删除{selection.kind === 'group' ? '整个物件组' : '部件'}</button>}
            </fieldset>
          </> : <p className="debug-empty">在上方选择一个物件组或部件。修改会经过同一场景事务，并进入保存与撤销记录。</p>}
          {feedback && <p className={`debug-feedback ${feedback.error ? 'is-error' : ''}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
        </section>
      </> : <>
        <section className="debug-section" aria-labelledby={`${panelId}-connection`}><h3 id={`${panelId}-connection`}>服务状态</h3><dl className="debug-properties"><div><dt>模型</dt><dd>{health?.model ?? '尚未获取'}</dd></div><div><dt>推理</dt><dd>{health?.thinking === 'enabled' ? `已开启${health.reasoningEffort ? ` / ${health.reasoningEffort}` : ''}` : '尚未报告'}</dd></div><div><dt>DeepSeek / ASR / TTS</dt><dd>{health ? [health.aiConfigured, health.asrConfigured, health.ttsConfigured].map(value => value ? '已配置' : '未配置').join(' / ') : '尚未获取'}</dd></div></dl><p className="debug-help">配置状态不代表本次调用成功。这里不显示密钥或原始推理内容。</p></section>
        <section className="debug-section" aria-labelledby={`${panelId}-requests`}>
          <h3 id={`${panelId}-requests`}>本页最近回合</h3>
          <label className="debug-field"><span>选择请求</span><select aria-label="选择本页最近请求" value={turnId} onChange={event => setTurnId(event.target.value)} disabled={!recentTurns.length}><option value="" disabled>尚无请求</option>{[...recentTurns].reverse().map(turn => <option value={turn.id} key={turn.id}>{turn.text.slice(0, 45)}{turn.text.length > 45 ? '…' : ''}</option>)}</select></label>
          {selectedTurn ? <><dl className="debug-properties debug-request-info"><div><dt>请求 ID</dt><dd><code>{selectedTurn.id}</code></dd></div><div><dt>本地状态</dt><dd>{selectedTurn.status ?? '未提供'}</dd></div>{selectedTurn.appliedBatches !== undefined && <div><dt>本地已执行 / 已确认批次</dt><dd>{selectedTurn.appliedBatches} / {selectedTurn.acknowledgedBatches ?? 0}</dd></div>}</dl><p className="debug-prompt">{selectedTurn.text}</p>
            <button className="debug-secondary debug-refresh" disabled={reading} onClick={() => void readTurn()}>{reading ? <LoaderCircle size={15} className="debug-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}{reading ? '正在读取…' : '读取 / 刷新服务端状态'}</button>
            {readError && <p className="debug-feedback is-error" role="alert">{readError}</p>}
            {diagnostics && <details className="debug-json" open><summary>同会话诊断 · JSON</summary><pre><code>{diagnostics}</code></pre></details>}
            <details className="debug-json" open><summary>本页最近一批计划</summary>{selectedTurn.plan ? <pre><code>{jsonText(selectedTurn.plan)}</code></pre> : <p className="debug-empty">这个回合还没有收到场景计划。</p>}</details>
          </> : <p className="debug-empty">发送一次创作想法后，这里会显示当前页面保留的回合。</p>}
          <p className="debug-help">只有手动点击才读取服务端；切换回合或关闭面板会取消读取。服务端过期后，本页已有计划仍可查看。所有 JSON 仅作为文本显示。</p>
        </section>
      </>}
    </div>
    <footer className="debug-footer"><span>当前设备 · 开发调试</span><span>Esc 关闭</span></footer>
  </aside>;
}

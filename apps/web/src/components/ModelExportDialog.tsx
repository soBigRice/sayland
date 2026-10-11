import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Box, LoaderCircle, X } from 'lucide-react';
import type { SceneSnapshot } from '../../../../packages/protocol/src/index.ts';
import { inspectExport, type ExportOptions } from '../../../../packages/scene/src/export.ts';
import '../styles/model-export.css';

function SelectionCheckbox({ checked, mixed = false, disabled, label, onChange }: {
  checked: boolean; mixed?: boolean; disabled: boolean; label: string; onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <label className="model-export-check"><input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} /><span>{label}</span></label>;
}

export function ModelExportDialog({ snapshot, onClose }: { snapshot: SceneSnapshot; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), worker = useRef<Worker | null>(null);
  const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [scope, setScope] = useState<'all' | 'parts'>('all');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [scale, setScale] = useState('2');
  const [exporting, setExporting] = useState(false), [message, setMessage] = useState(''), [failure, setFailure] = useState('');
  const heading = useId(), scaleId = useId(), scopeName = useId();
  const options: ExportOptions = useMemo(() => ({ scope: scope === 'all' ? { kind: 'all' } : { kind: 'parts', partIds: [...selected] }, millimetersPerVoxel: Number(scale) }), [scope, selected, scale]);
  const inspection = useMemo(() => {
    try { return { info: inspectExport(snapshot, options, false), error: '' }; }
    catch (error) { return { info: null, error: error instanceof Error ? error.message : '暂时无法读取所选模型。' }; }
  }, [snapshot, options]);
  const sections = useMemo(() => {
    const occupied = new Set(snapshot.voxels.map(v => v.partId));
    const parts = snapshot.parts.filter(p => occupied.has(p.id));
    return [...(snapshot.groups ?? []).map(group => ({ id: group.id, name: group.name, parts: parts.filter(p => p.groupId === group.id) })),
      { id: '', name: '未分组部件', parts: parts.filter(p => !p.groupId) }].filter(group => group.parts.length);
  }, [snapshot]);
  useEffect(() => {
    dialog.current?.showModal();
    const urls = downloads.current;
    return () => { worker.current?.terminate(); worker.current = null; urls.forEach((timer, url) => { clearTimeout(timer); URL.revokeObjectURL(url); }); urls.clear(); };
  }, []);
  const changeSelection = (ids: string[], value: boolean) => {
    setSelected(previous => { const next = new Set(previous); ids.forEach(id => value ? next.add(id) : next.delete(id)); return next; });
    setMessage(''); setFailure('');
  };
  const cancelExport = () => { worker.current?.terminate(); worker.current = null; setExporting(false); setMessage('已取消导出。'); };
  const download = () => {
    if (worker.current || !inspection.info) return;
    setExporting(true); setMessage(''); setFailure('');
    try {
      const task = new Worker(new URL('../export/worker.ts', import.meta.url), { type: 'module' }); worker.current = task;
      const stop = () => { task.terminate(); if (worker.current === task) worker.current = null; setExporting(false); };
      task.onerror = () => { if (worker.current !== task) return; stop(); setFailure('模型打包失败，请重试；较大的场景可以选择部分导出。'); };
      task.onmessage = (event: MessageEvent<{ ok: true; bytes: Uint8Array<ArrayBuffer>; filename: string } | { ok: false; message: string }>) => {
        if (worker.current !== task) return;
        stop();
        if (!event.data.ok) { setFailure(event.data.message); return; }
        try {
          const url = URL.createObjectURL(new Blob([event.data.bytes], { type: 'application/zip' }));
          const timer = setTimeout(() => { URL.revokeObjectURL(url); downloads.current.delete(url); }, 30_000);
          downloads.current.set(url, timer);
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = event.data.filename;
          document.body.append(anchor); anchor.click(); anchor.remove();
          setMessage('模型包已生成，下载已发起。解压后将 model.3mf 导入 Bambu Studio。');
        } catch { setFailure('浏览器未能下载模型包，请重试。'); }
      };
      task.postMessage({ snapshot, options });
    } catch { worker.current?.terminate(); worker.current = null; setExporting(false); setFailure('浏览器未能启动模型导出，请重试。'); }
  };
  const info = inspection.info;
  return <dialog ref={dialog} className="settings-dialog model-export-dialog" aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="settings-content">
      <div className="dialog-heading"><div><span className="settings-leaf"><Box size={21} aria-hidden="true" /></span><h2 id={heading}>导出 3D 模型</h2></div><button className="icon-button" aria-label="关闭模型导出" onClick={onClose}><X /></button></div>
      <p className="section-hint">把小岛变成手中的作品。打印用 3MF，继续编辑用 FBX。</p>
      <fieldset className="model-export-scope" disabled={exporting}><legend>导出范围</legend>
        <label><input type="radio" name={scopeName} checked={scope === 'all'} onChange={() => { setScope('all'); setMessage(''); setFailure(''); }} />全部场景</label>
        <label><input type="radio" name={scopeName} checked={scope === 'parts'} onChange={() => { setScope('parts'); setMessage(''); setFailure(''); }} />选择物件 / 部件</label>
      </fieldset>
      {scope === 'parts' && <div className="model-export-selection">
        <div className="model-export-selection-actions"><button className="text-button" disabled={exporting} onClick={() => changeSelection(snapshot.parts.map(p => p.id), true)}>全选</button><button className="text-button" disabled={exporting} onClick={() => changeSelection(snapshot.parts.map(p => p.id), false)}>清空选择</button></div>
        <div className="model-export-tree" aria-label="选择导出的物件和部件">{sections.map(group => {
          const count = group.parts.filter(p => selected.has(p.id)).length;
          return <div className="model-export-group" key={group.id}>
            <SelectionCheckbox checked={count === group.parts.length} mixed={count > 0 && count < group.parts.length} disabled={exporting} label={group.name} onChange={() => changeSelection(group.parts.map(p => p.id), count !== group.parts.length)} />
            <div className="model-export-parts">{group.parts.map(part => <SelectionCheckbox key={part.id} checked={selected.has(part.id)} disabled={exporting} label={part.name} onChange={() => changeSelection([part.id], !selected.has(part.id))} />)}</div>
          </div>;
        })}</div>
      </div>}
      <div className="model-export-scale"><label htmlFor={scaleId}>每格实际尺寸</label><div><input id={scaleId} type="number" min="0.1" max="100" step="0.1" value={scale} disabled={exporting} onChange={event => { setScale(event.target.value); setMessage(''); setFailure(''); }} /><span>毫米</span></div></div>
      {info ? <div className="model-export-summary" aria-live="polite"><strong>{info.dimensions.map(n => Number(n.toFixed(2))).join(' × ')} mm</strong><span>长 × 宽 × 高 · {info.selected.parts.length} 个部件 · {info.colors.length} 种颜色</span>
        <div className="model-export-colors" aria-label="模型颜色">{info.colors.slice(0, 32).map(color => <i key={color} style={{ backgroundColor: color }} title={color} />)}{info.colors.length > 32 && <span>+{info.colors.length - 32}</span>}</div>
        {Number(scale) < 0.8 && <p className="model-export-warning">单格细节较薄，请在切片预览中检查最薄处。</p>}
      </div> : <p className="model-export-warning" role="status">{inspection.error}</p>}
      <p className="model-export-help">ZIP 内含 3MF、FBX、材质清单、原始快照和贴图。保留所选内容的相对位置，整体底部归零。</p>
      <p className="model-export-help">在 Bambu Studio 选择你的机型、耗材与支撑后再切片。包内附有悬空与分离检查结果。颜色需对应实际耗材，贴图和屏幕光影不会变成打印材质。</p>
      {failure && <p className="model-export-warning" role="alert">{failure}</p>}{message && <p className="model-export-message" role="status">{message}</p>}
      <div className="model-export-footer"><button className="secondary-button" disabled={!info || exporting} onClick={download}>{exporting ? <LoaderCircle size={19} className="spin" aria-hidden="true" /> : <ArrowDownToLine size={19} aria-hidden="true" />}{exporting ? '正在打包…' : '下载模型包 · ZIP'}</button>{exporting && <button className="text-button" onClick={cancelExport}>取消导出</button>}</div>
    </div>
  </dialog>;
}

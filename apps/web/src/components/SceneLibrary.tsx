import { useEffect, useId, useRef, useState } from 'react';
import { Check, Clock3, LoaderCircle, Plus, Square, X } from 'lucide-react';
import { taskIsActive, type WorkspaceTask, type WorkspaceView } from '../../../../packages/protocol/src/workspace.ts';
import { ProjectIllustration } from './ProjectIllustration.tsx';
import '../styles/scene-library.css';

const taskLabels: Record<WorkspaceTask['status'], string> = { queued: '排队中', running: '搭建中', completed: '已完成', failed: '未完成', cancelled: '已停止', interrupted: '已中断' };
/** Home-only dialogs. Creating another project requires leaving the editor first. */
export function SceneLibrary({ mode, workspace, switching, onClose, onSelect, onCreate, onCancel }: {
  mode: 'create' | 'tasks'; workspace: WorkspaceView; switching: boolean; onClose(): void;
  onSelect(id: string): Promise<boolean>; onCreate(name: string, template: 'empty' | 'island'): Promise<boolean>; onCancel(id: string): Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useId(), templateName = useId();
  const [name, setName] = useState(''), [template, setTemplate] = useState<'empty' | 'island'>('empty');
  const [cancelling, setCancelling] = useState<string | null>(null), [failure, setFailure] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const tasks = [...workspace.tasks].sort((a, b) => Number(taskIsActive(b)) - Number(taskIsActive(a)) || b.createdAt - a.createdAt);
  const select = async (id: string) => { if (await onSelect(id)) onClose(); else setFailure('暂时无法进入项目，请稍后重试。'); };
  return <dialog ref={dialog} className="scene-library home-dialog" aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); if (!switching) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !switching) onClose(); }}>
    <div className="library-content">
      <header className="library-heading"><div><span className="library-eyebrow">SAYLAND · 想象出发站</span><h2 id={heading}>{mode === 'create' ? '创造一个新世界' : '伙伴的任务本'}</h2><p>{mode === 'create' ? '选一个起点，剩下的交给想象。' : '你去别处逛逛，伙伴也会接着搭。'}</p></div><button type="button" className="icon-button" disabled={switching} aria-label="关闭窗口" onClick={onClose}><X /></button></header>
      {mode === 'create' ? <form className="scene-create" onSubmit={async event => {
        event.preventDefault(); if (switching) return; setFailure('');
        if (await onCreate(name.trim() || (template === 'empty' ? '新的空白世界' : '新的一座小岛'), template)) onClose();
        else setFailure('项目尚未创建成功，请检查后台连接后重试。原来的项目仍保留。');
      }}>
        <fieldset className="scene-templates" disabled={switching}><legend className="visually-hidden">选择初始场景</legend>
          <label className={template === 'empty' ? 'selected' : ''}><input type="radio" name={templateName} value="empty" checked={template === 'empty'} onChange={() => setTemplate('empty')} /><ProjectIllustration template="empty" /><strong>空白场景</strong><small>从零开始，什么都能创造</small></label>
          <label className={template === 'island' ? 'selected' : ''}><input type="radio" name={templateName} value="island" checked={template === 'island'} onChange={() => setTemplate('island')} /><ProjectIllustration template="island" /><strong>默认小岛</strong><small>草地、水面，还有小房子</small></label>
        </fieldset>
        <label className="scene-name-field">给项目起个名字<input value={name} onChange={event => setName(event.target.value)} maxLength={32} placeholder={template === 'empty' ? '新的空白世界' : '新的一座小岛'} disabled={switching} /></label>
        <div className="scene-create-actions"><button type="button" className="text-button" disabled={switching} onClick={onClose}>再想想</button><button className="library-new" disabled={switching}>{switching ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}{switching ? '正在创建…' : '创建并进入'}</button></div>
      </form> : <section aria-label="后台任务列表" className="workspace-tasks">
        {tasks.map(task => <article className={`workspace-task task-${task.status}`} key={task.id}>
          <span className="task-status-icon">{task.status === 'running' ? <LoaderCircle size={20} className="spin" /> : task.status === 'completed' ? <Check size={20} /> : <Clock3 size={20} />}</span>
          <div className="workspace-task-info"><div><span className="task-state-label">{taskLabels[task.status]}</span><button type="button" disabled={switching} onClick={() => void select(task.sceneId)}>{workspace.scenes.find(scene => scene.id === task.sceneId)?.name ?? '打开项目'}</button></div><strong>{task.text}</strong><p>{task.phase}</p></div>
          {taskIsActive(task) && <button type="button" className="task-cancel" disabled={cancelling === task.id} aria-label={`停止任务：${task.text}`} onClick={async () => { setCancelling(task.id); setFailure(''); try { if (!await onCancel(task.id)) setFailure('尚未确认任务停止，请检查后台连接后重试。'); } finally { setCancelling(null); } }}><Square size={12} fill="currentColor" />停止</button>}
        </article>)}
        {!tasks.length && <p className="library-empty">还没有任务。进入项目，告诉伙伴你的第一个想法吧。</p>}
      </section>}
      {failure && <p className="library-failure" role="alert">{failure}</p>}
      <footer className="library-footer"><span className="backend-dot" />项目自动保存 · 关闭页面后，后台继续搭建</footer>
    </div>
  </dialog>;
}

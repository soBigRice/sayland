import { useEffect, useId, useRef } from 'react';
import { LoaderCircle, Trash2, X } from 'lucide-react';

export function DeleteProjectDialog({ name, taskCount, busy, error, onDelete, onCancel }: {
  name: string; taskCount: number; busy: boolean; error: string; onDelete(): void; onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), title = useId(), description = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="scene-library home-dialog delete-project-dialog" aria-labelledby={title} aria-describedby={description} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <div className="library-content">
      <header className="library-heading"><div><span className="library-eyebrow">和这个小世界告别</span><h2 id={title}>删除项目？</h2></div><button type="button" className="icon-button" aria-label="取消删除" disabled={busy} onClick={onCancel}><X /></button></header>
      <p className="delete-project-name">{name}</p>
      <p id={description} className="exit-project-detail">作品、对话、草稿、缩略图和任务记录都会被删除，无法恢复。</p>
      <p className="delete-project-tasks">{taskCount ? `这个项目有 ${taskCount} 个进行中或排队的任务，删除时会全部停止。` : '删除时也会停止这个项目新接收的后台任务。'}其他项目不受影响。</p>
      {error && <p className="library-failure" role="alert">{error}</p>}
      <div className="exit-project-actions"><button type="button" className="secondary-button" autoFocus disabled={busy} onClick={onCancel}>保留项目</button><button type="button" className="delete-project-confirm" disabled={busy} onClick={onDelete}>{busy ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}{busy ? '正在删除…' : '删除项目'}</button></div>
    </div>
  </dialog>;
}

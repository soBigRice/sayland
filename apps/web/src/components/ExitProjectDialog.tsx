import { useEffect, useId, useRef } from 'react';
import { LoaderCircle, X } from 'lucide-react';

export function ExitProjectDialog({ busy, error, onSave, onDiscard, onCancel }: {
  busy: boolean; error: string; onSave(): void; onDiscard(): void; onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), title = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="scene-library home-dialog exit-project-dialog" aria-labelledby={title} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <div className="library-content">
      <header className="library-heading"><div><span className="library-eyebrow">离开之前</span><h2 id={title}>还有内容没有保存</h2></div><button type="button" className="icon-button" aria-label="继续留在项目" disabled={busy} onClick={onCancel}><X /></button></header>
      <p className="exit-project-copy">保存后再走，把现在的画面留在首页吧。</p>
      <p className="exit-project-detail">选择不保存，会保留上次缩略图。已自动保存的作品和后台任务不受影响。</p>
      {error && <p className="library-failure" role="alert">{error}</p>}
      <div className="exit-project-actions"><button type="button" className="text-button" disabled={busy} onClick={onCancel}>取消</button><button type="button" className="secondary-button" disabled={busy} onClick={onDiscard}>不保存退出</button><button type="button" className="library-new" disabled={busy} onClick={onSave}>{busy && <LoaderCircle size={16} className="spin" />}{busy ? '正在保存…' : '保存并退出'}</button></div>
    </div>
  </dialog>;
}

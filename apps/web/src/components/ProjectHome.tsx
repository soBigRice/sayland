import { useState } from 'react';
import { ArrowRight, Check, Clock3, LoaderCircle, Plus, Sparkles, Trash2 } from 'lucide-react';
import { taskIsActive, type WorkspaceView } from '../../../../packages/protocol/src/workspace.ts';
import { IslandCompanion } from './IslandCompanion.tsx';
import { ProjectCover } from './ProjectCover.tsx';
import { DeleteProjectDialog } from './DeleteProjectDialog.tsx';
import { SceneLibrary } from './SceneLibrary.tsx';
import '../styles/project-home.css';

const dateLabel = (timestamp: number) => new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);

export function ProjectHome({ workspace, ready, error, notice, switching, onSelect, onCreate, onCancel, onDelete, deletingId }: {
  workspace: WorkspaceView; ready: boolean; error: string; notice: string; switching: boolean; deletingId: string | null;
  onDelete(id: string): Promise<{ ok: boolean; error?: string }>;
  onSelect(id: string): Promise<boolean>; onCreate(name: string, template: 'empty' | 'island'): Promise<boolean>; onCancel(id: string): Promise<boolean>;
}) {
  const [dialog, setDialog] = useState<'create' | 'tasks' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null), [deleteError, setDeleteError] = useState('');
  const blocked = switching || deletingId !== null;
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteError('');
    const result = await onDelete(deleteTarget.id);
    if (result.ok) setDeleteTarget(null); else setDeleteError(result.error ?? '删除没有完成，请重试。');
  };
  const active = workspace.tasks.filter(taskIsActive).length;
  return <main className="project-home">
    <div className="home-cloud cloud-left" aria-hidden="true" /><div className="home-cloud cloud-right" aria-hidden="true" />
    <div className="home-wrap">
      <header className="home-header">
        <div className="brand" aria-label="说说岛 Sayland"><img className="brand-mascot" src="/mascot.png" alt="" /><div className="brand-wordmark"><span>说说岛</span><small>Sayland</small></div></div>
        <button type="button" className="home-tasks" onClick={() => setDialog('tasks')} disabled={!ready || blocked}><Clock3 size={18} /><span>后台任务</span>{active > 0 && <b>{active}</b>}</button>
      </header>
      <section className="home-welcome" aria-labelledby="home-title">
        <div className="home-welcome-copy"><span className="home-hello"><Sparkles size={16} />欢迎来到你的想象小天地</span><h1 id="home-title">小小想法，<br /><span>大大世界。</span></h1><p>继续昨天的奇思妙想，<br className="home-mobile-break" />或者，今天从一个新世界开始。</p></div>
        <div className="home-mascot-scene" aria-hidden="true"><span className="home-greeting">今天，我们创造什么？</span><span className="home-spark spark-one">✦</span><span className="home-spark spark-two">✧</span><span className="home-mascot-ground" /><IslandCompanion /><span className="home-flower flower-one">✿</span><span className="home-flower flower-two">✿</span></div>
      </section>
      <section className="home-projects" aria-labelledby="projects-title">
        <div className="home-section-heading"><div><h2 id="projects-title">我的项目 <span>{workspace.scenes.length}</span></h2><p>选一个小世界，进去玩吧。</p></div><span className="home-save-hint"><Check size={15} />自动保存每个想法</span></div>
        {error ? <div className="home-state home-error" role="alert"><p>{error}</p><button type="button" className="library-new" onClick={() => window.location.reload()}>重新连接</button></div> : !ready ? <div className="home-state" role="status"><LoaderCircle className="spin" /><p>正在找回你的小世界…</p></div> : <div className="home-project-grid" aria-busy={blocked}>
          <button type="button" className="home-project-card home-create-card" disabled={blocked} onClick={() => setDialog('create')}><span className="home-plus"><Plus size={35} strokeWidth={2.3} /></span><strong>创建新项目</strong><span>一片空白，或一座小岛<br />想象从这里出发</span><span className="home-create-cta">开始创造 <ArrowRight size={17} /></span></button>
          {[...workspace.scenes].sort((a, b) => b.updatedAt - a.updatedAt).map(scene => {
            const jobs = workspace.tasks.filter(task => task.sceneId === scene.id && taskIsActive(task));
            const running = jobs.some(task => task.status === 'running');
            return <div className="home-project-entry" key={scene.id}><button type="button" className={`home-project-card home-saved-card project-${scene.template}`} disabled={blocked} onClick={() => void onSelect(scene.id)} aria-label={`进入项目：${scene.name}`}>
              <ProjectCover scene={scene} />
              <span className="home-project-details"><strong>{scene.name}</strong><span className="home-project-meta">{scene.voxelCount.toLocaleString()} 个方块 · {dateLabel(scene.updatedAt)}</span><span className="home-card-footer"><span className={jobs.length ? 'home-job-active' : 'home-job-saved'}>{jobs.length ? <><LoaderCircle size={13} className="spin" />{running ? '伙伴正在搭建' : '等待开始'}{jobs.length > 1 && ` · ${jobs.length - (running ? 1 : 0)} 个排队`}</> : <><Check size={13} />已保存</>}</span><span className="home-enter">进入 <ArrowRight size={15} /></span></span></span>
            </button><button type="button" className="home-delete-project" aria-label={`删除项目：${scene.name}`} title="删除项目" disabled={blocked} onClick={() => { setDeleteError(''); setDeleteTarget({ id: scene.id, name: scene.name }); }}><Trash2 size={17} /></button></div>;
          })}
        </div>}
        {switching && <p className="home-opening" role="status"><LoaderCircle className="spin" size={16} />正在打开你的世界…</p>}
        {notice && <p className="home-notice" role="status">{notice}</p>}
      </section>
      <footer className="home-footer"><span>一砖一瓦，让想象长大。</span><span><span className="backend-dot" />离开页面，后台伙伴也会继续搭建</span></footer>
    </div>
    {deleteTarget && <DeleteProjectDialog name={deleteTarget.name} taskCount={workspace.tasks.filter(task => task.sceneId === deleteTarget.id && taskIsActive(task)).length} busy={deletingId !== null} error={deleteError} onDelete={() => void confirmDelete()} onCancel={() => setDeleteTarget(null)} />}
    {dialog && <SceneLibrary mode={dialog} workspace={workspace} switching={switching} onClose={() => setDialog(null)} onSelect={onSelect} onCreate={onCreate} onCancel={onCancel} />}
  </main>;
}

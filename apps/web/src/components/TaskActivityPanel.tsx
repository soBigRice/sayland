import { useEffect, useId, useRef, useState } from 'react';
import { Check, LoaderCircle, Pause, Sparkles, TriangleAlert, X } from 'lucide-react';
import type { TaskActivity } from '../lib/taskActivity.ts';
import '../styles/task-activity.css';

const compactQuery = '(max-width: 1359px), (max-height: 620px)';
export function TaskActivityPanel({ activity }: { activity: TaskActivity | null }) {
  const [compact, setCompact] = useState(() => window.matchMedia(compactQuery).matches);
  const [expanded, setExpanded] = useState(false);
  const [following, setFollowing] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const launch = useRef<HTMLButtonElement>(null);
  const lastRequest = useRef(activity?.requestId);
  const id = useId();
  const open = !compact || expanded;
  const running = activity?.status === 'running';
  const label = !activity ? '等待想法' : ({ running: '进行中', completed: '已完成', stopped: '已停止', failed: '未完成' } as const)[activity.status];
  const statusIcon = running ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : activity?.status === 'completed' ? <Check size={13} aria-hidden="true" />
    : activity?.status === 'failed' ? <TriangleAlert size={13} aria-hidden="true" /> : activity?.status === 'stopped' ? <Pause size={13} aria-hidden="true" /> : null;
  useEffect(() => {
    const query = window.matchMedia(compactQuery);
    const update = () => setCompact(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const changed = lastRequest.current !== activity?.requestId;
    lastRequest.current = activity?.requestId;
    if (changed) setFollowing(true);
    if (open && (changed || following) && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [activity, following, open]);
  function close() { setExpanded(false); launch.current?.focus({ preventScroll: true }); }
  return <aside className={`task-activity ${compact ? 'is-compact' : ''} activity-${activity?.status ?? 'idle'}`} aria-label="实时搭建动态">
    {compact && <button ref={launch} className="activity-launch" type="button" aria-expanded={expanded} aria-controls={id}
      aria-label={`${expanded ? '收起' : '展开'}搭建动态，${label}`} onClick={() => setExpanded(value => !value)}>
      <Sparkles size={18} aria-hidden="true" /><span>搭建动态</span>{running && <i aria-hidden="true" />}
    </button>}
    <section id={id} className="activity-window" hidden={!open} onKeyDown={event => {
      if (event.key === 'Escape' && compact) { event.preventDefault(); close(); }
    }}>
      <header className="activity-heading"><span><Sparkles size={14} aria-hidden="true" />搭建动态</span>
        {compact ? <button type="button" className="activity-close" aria-label="关闭搭建动态" onClick={close}><X size={16} aria-hidden="true" /></button>
          : <span className="activity-status">{statusIcon}{label}</span>}
      </header>
      <div ref={scroll} className="activity-feed" role="log" aria-label="本轮搭建进度" aria-live={running && open ? 'polite' : 'off'} aria-relevant="additions text" tabIndex={open ? 0 : -1}
        onScroll={event => { const element = event.currentTarget; setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 24); }}
        onKeyDown={event => { if (event.code === 'Space') event.stopPropagation(); }}>
        {activity ? <ol>{activity.entries.map(entry => <li key={entry.id} className={`activity-entry entry-${entry.kind}`}><span aria-hidden="true" /><p>{entry.text}</p></li>)}</ol>
          : <p className="activity-empty">说出你的想法后，<br />在这里看看伙伴正忙什么。</p>}
      </div>
      <footer className="activity-footer"><span>{compact ? label : running ? '随任务实时更新' : activity ? '本轮记录' : '观察 · 规划 · 搭建'}</span>
        {!following && <button type="button" onClick={() => setFollowing(true)}>回到最新</button>}
      </footer>
    </section>
  </aside>;
}

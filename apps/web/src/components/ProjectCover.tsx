import { useEffect, useState } from 'react';
import type { SceneSummary } from '../../../../packages/protocol/src/workspace.ts';
import { readScenePreview } from '../lib/workspaceApi.ts';
import { ProjectIllustration } from './ProjectIllustration.tsx';

export function ProjectCover({ scene }: { scene: SceneSummary }) {
  const [image, setImage] = useState<{ key: string; url: string } | null>(null);
  const key = scene.preview?.key;
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController(); let url: string | undefined;
    void readScenePreview(scene.id, key, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob); setImage({ key, url });
    }).catch(() => { /* The template remains visible when a saved cover cannot be fetched. */ });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [scene.id, key]);
  const visible = image?.key === key ? image : null;
  return <span className={`home-project-art ${visible ? 'has-scene-preview' : ''}`}>
    <span className="home-template-label">{visible ? '离开时的画面' : scene.template === 'island' ? '小岛起点' : '空白起点'}</span>
    {visible ? <img src={visible.url} alt={`${scene.name}上次退出时保存的场景`} className="home-scene-preview" onError={() => setImage(null)} /> : <ProjectIllustration template={scene.template} />}
  </span>;
}

import type { SceneSnapshot } from '../../../../packages/protocol/src/index.ts';
import type { ExportOptions } from '../../../../packages/scene/src/export.ts';
import { createExportArchive } from './serialize.ts';

self.onmessage = (event: MessageEvent<{ snapshot: SceneSnapshot; options: ExportOptions }>) => {
  try {
    const result = createExportArchive(event.data.snapshot, event.data.options);
    self.postMessage({ ok: true, ...result }, { transfer: [result.bytes.buffer] });
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : '模型导出失败，请重试。' });
  }
};

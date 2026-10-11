import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { ScenePreview } from '../../../../packages/protocol/src/workspace.ts';

export type CaptureScenePreview = () => Promise<ScenePreview | null>;

/** Capture after the existing postprocessing pass, before WebGL discards its drawing buffer. */
export function ScenePreviewCapture({ captureRef, revision, resetKey }: {
  captureRef?: RefObject<CaptureScenePreview | null>; revision: number; resetKey: number;
}) {
  const { gl, camera, invalidate } = useThree();
  const pending = useRef<{ finish(value: ScenePreview | null): void } | null>(null);
  useLayoutEffect(() => {
    if (!captureRef) return;
    const capture: CaptureScenePreview = () => new Promise(resolve => {
      pending.current?.finish(null);
      const timer = window.setTimeout(() => request.finish(null), 2500);
      const request = { finish(value: ScenePreview | null) { clearTimeout(timer); if (pending.current === request) pending.current = null; resolve(value); } };
      pending.current = request; invalidate();
    });
    captureRef.current = capture;
    return () => { if (captureRef.current === capture) captureRef.current = null; pending.current?.finish(null); };
  }, [captureRef, invalidate]);
  // ScenePostprocessing owns priority 1. This only copies its finished frame on explicit exit.
  useFrame(() => {
    const request = pending.current; if (!request) return;
    const source = gl.domElement;
    if (!source.width || !source.height || gl.getContext().isContextLost()) { request.finish(null); return; }
    try {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 384;
      const context = canvas.getContext('2d'); if (!context) { request.finish(null); return; }
      const scale = Math.min(canvas.width / source.width, canvas.height / source.height);
      const width = source.width * scale, height = source.height * scale;
      context.drawImage(source, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
      // The scene is transparent. Ignore its faint helper grid when finding the solid
      // objects, then leave generous room for shadows; no camera or renderer changes.
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (pixels[(y * canvas.width + x) * 4 + 3] > 127) {
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
      let sx = 0, sy = 0, sw = source.width, sh = source.height;
      if (right >= left) {
        const pad = Math.max(8, Math.ceil(Math.max(right - left + 1, bottom - top + 1) * .16));
        sx = Math.max(0, left - pad) / scale; sy = Math.max(0, top - pad) / scale;
        sw = Math.min(width, right + pad + 1) / scale - sx; sh = Math.min(height, bottom + pad + 1) / scale - sy;
      }
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#fbfaf2'; context.fillRect(0, 0, canvas.width, canvas.height);
      const fit = Math.min(canvas.width / sw, canvas.height / sh), dw = sw * fit, dh = sh * fit;
      context.drawImage(source, sx, sy, sw, sh, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
      // AO noise can differ between mounts with the same world and view. Fingerprint
      // the view, not that incidental pixel noise; rounding removes subpixel float drift.
      const viewKey = JSON.stringify(['preview-v1', source.width, source.height,
        ...camera.matrixWorld.elements.map(value => Number(value.toFixed(6))),
        ...camera.projectionMatrix.elements.map(value => Number(value.toFixed(6)))]);
      request.finish({ image: canvas.toDataURL('image/png'), revision, resetKey, viewKey });
      canvas.width = 0; canvas.height = 0;
    } catch { request.finish(null); }
  }, 2);
  return null;
}

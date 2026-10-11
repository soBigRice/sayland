import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Box3, PerspectiveCamera, PCFShadowMap, Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { SceneSnapshot } from '../../../../packages/protocol/src/index.ts';
import { SceneLighting } from './SceneLighting.tsx';
import { ScenePostprocessing } from './ScenePostprocessing.tsx';
import { framePerspectiveScene, sceneObjectVoxels, updatePerspectiveRange } from './cameraFraming.ts';
import { CameraTween } from './cameraTween.ts';
import { DROP_HEIGHT, VoxelMotion } from './voxelMotion.ts';
import { VoxelSurfaceView } from './voxelSurfaceView.ts';
import { ScenePreviewCapture, type CaptureScenePreview } from './ScenePreviewCapture.tsx';

export type ViewAction = { kind: 'zoomIn' | 'zoomOut' | 'reset' | 'frameObjects'; seq: number }
  | { kind: 'frameChanges'; seq: number; voxels: SceneSnapshot['voxels'] } | null;
export type SceneCanvasProps = {
  sceneFrameRef?: RefObject<HTMLDivElement | null>;
  snapshot: SceneSnapshot;
  viewAction: ViewAction;
  debugSelection?: { kind: 'group' | 'part'; id: string } | null;
  /** Increment when replacing the document, so saved work does not replay as new construction. */
  animationResetKey?: number;
  captureRef?: RefObject<CaptureScenePreview | null>;
  previewResetKey?: number;
};

function SceneCamera({ snapshot, viewAction, sceneFrameRef, animationResetKey }: Pick<SceneCanvasProps, 'snapshot' | 'viewAction' | 'sceneFrameRef' | 'animationResetKey'>) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, size, gl, invalidate } = useThree();
  const latest = useRef(snapshot); latest.current = snapshot;
  const applied = useRef(-1);
  const tween = useMemo(() => new CameraTween(), []);
  const reducedMotion = useRef(false);
  const initialized = useRef(false);
  const cancelTween = useCallback(() => { tween.stop(); }, [tween]);
  const fit = useCallback((objects: boolean, animate = false, focus?: SceneSnapshot['voxels']) => {
    const orbit = controls.current;
    if (!(camera instanceof PerspectiveCamera) || !orbit) return;
    tween.stop();
    const canvasBounds = gl.domElement.getBoundingClientRect();
    const frame = sceneFrameRef?.current?.getBoundingClientRect() ?? canvasBounds;
    // Compute the destination on a clone; the visible camera must not teleport before the tween starts.
    const destination = camera.clone();
    const voxels = focus ?? (objects ? sceneObjectVoxels(latest.current) : latest.current.voxels);
    const fitted = framePerspectiveScene(destination, voxels, size, {
      // Keep the useful fit size, but center the world in the whole screen rather than above the composer.
      left: (size.width - frame.width) / 2, top: (size.height - frame.height) / 2,
      width: frame.width, height: frame.height,
    }, objects ? camera.position.clone().sub(orbit.target) : undefined);
    // Environment and distant objects still need valid clipping even when excluded from the focus bounds.
    const ranges = updatePerspectiveRange(destination, latest.current.voxels, fitted.target, fitted);
    if (animate && !reducedMotion.current) tween.start(camera, orbit, destination, { ...fitted, ...ranges }, performance.now());
    else {
      const damping = orbit.enableDamping;
      orbit.enableDamping = false; orbit.update();
      camera.copy(destination, false); orbit.target.copy(fitted.target);
      orbit.minDistance = ranges.minDistance; orbit.maxDistance = ranges.maxDistance;
      orbit.update(); orbit.enableDamping = damping;
    }
    invalidate();
  }, [camera, gl, size.width, size.height, sceneFrameRef, tween, invalidate]);
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      reducedMotion.current = media.matches;
      if (media.matches && tween.running) { tween.finish(); invalidate(); }
    };
    update(); media.addEventListener('change', update);
    return () => { media.removeEventListener('change', update); tween.stop(); };
  }, [tween, invalidate]);
  useLayoutEffect(() => {
    // Restoring a document/undoing must cancel an in-flight focus on the superseded geometry.
    tween.stop();
  }, [animationResetKey, tween]);
  useLayoutEffect(() => {
    if (!initialized.current) { initialized.current = true; fit(false); return; }
    // Resizing UI or the viewport must not replace the user's current focus with a whole-scene fit.
    if (!(camera instanceof PerspectiveCamera)) return;
    tween.stop();
    const view = camera.view;
    if (view?.enabled) camera.setViewOffset(size.width, size.height,
      view.offsetX * size.width / view.fullWidth, view.offsetY * size.height / view.fullHeight, size.width, size.height);
    camera.aspect = size.width / size.height; camera.updateProjectionMatrix(); invalidate();
  }, [fit, camera, size.width, size.height, tween, invalidate]);
  useLayoutEffect(() => {
    const orbit = controls.current;
    if (!(camera instanceof PerspectiveCamera) || !orbit) return;
    const ranges = updatePerspectiveRange(camera, snapshot.voxels, orbit.target, orbit);
    orbit.minDistance = ranges.minDistance; orbit.maxDistance = ranges.maxDistance;
    invalidate();
  }, [snapshot, camera, invalidate]);
  useEffect(() => {
    if (!viewAction || viewAction.seq === applied.current || !(camera instanceof PerspectiveCamera)) return;
    applied.current = viewAction.seq;
    if (viewAction.kind === 'frameChanges') fit(true, true, viewAction.voxels);
    else if (viewAction.kind === 'reset' || viewAction.kind === 'frameObjects') fit(viewAction.kind === 'frameObjects', true);
    else {
      tween.stop();
      const orbit = controls.current; if (!orbit) return;
      const offset = camera.position.clone().sub(orbit.target);
      const distance = Math.min(orbit.maxDistance, Math.max(orbit.minDistance,
        offset.length() * (viewAction.kind === 'zoomIn' ? 1 / 1.2 : 1.2)));
      camera.position.copy(orbit.target).add(offset.setLength(distance));
      orbit.update(); invalidate();
    }
  }, [viewAction, camera, fit, tween, invalidate]);
  useFrame(() => {
    if (!tween.running) return;
    tween.advance(performance.now());
    if (tween.running) invalidate();
  });
  return <OrbitControls ref={controls} makeDefault onStart={cancelTween} enableRotate enablePan enableDamping dampingFactor={0.12} minPolarAngle={Math.PI / 9} maxPolarAngle={Math.PI / 2.3} />;
}

function VoxelWorld({ snapshot, animationResetKey = 0, onMotionBounds }: Omit<SceneCanvasProps, 'viewAction'> & { onMotionBounds(bounds: Box3): void }) {
  const view = useRef<VoxelSurfaceView | null>(null);
  const [group, setGroup] = useState<VoxelSurfaceView['group'] | null>(null);
  const motion = useMemo(() => new VoxelMotion(), []);
  const initialized = useRef(false);
  const resetKey = useRef(animationResetKey);
  const { gl, invalidate } = useThree();
  const reducedMotion = useRef(false);
  const latest = useRef(snapshot); latest.current = snapshot;
  useLayoutEffect(() => {
    // Build resources in the effect, so StrictMode's setup/cleanup/setup owns each instance exactly once.
    const renderer = new VoxelSurfaceView(); view.current = renderer; setGroup(renderer.group);
    return () => { renderer.dispose(); view.current = null; motion.dispose(); initialized.current = false; };
  }, [motion]);
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      reducedMotion.current = media.matches;
      if (!media.matches || !motion.running) return;
      motion.finish(); view.current?.sync(latest.current.voxels, motion);
      gl.shadowMap.needsUpdate = true;
      onMotionBounds(motion.bounds()); invalidate();
    };
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [motion, gl, onMotionBounds, invalidate]);
  useLayoutEffect(() => {
    const documentReplaced = resetKey.current !== animationResetKey;
    if (documentReplaced) motion.dispose();
    motion.sync(snapshot.voxels, initialized.current && !documentReplaced && !reducedMotion.current, performance.now());
    resetKey.current = animationResetKey; initialized.current = true;
    view.current?.sync(snapshot.voxels, motion);
    gl.shadowMap.needsUpdate = true;
    onMotionBounds(motion.bounds()); invalidate();
  }, [snapshot, animationResetKey, motion, gl, onMotionBounds, invalidate]);
  useFrame(() => {
    if (!motion.running) return;
    view.current?.advance(motion.advance(performance.now()), motion);
    // Every moving frame, including the final settled geometry, changes the caster positions.
    gl.shadowMap.needsUpdate = true;
    if (motion.running) invalidate();
    else onMotionBounds(motion.bounds());
  });
  // Children create through conversation. No R3F handlers means navigation never raycasts the world.
  return group && <primitive object={group} dispose={null} />;
}

function SelectionBounds({ snapshot, selection }: { snapshot: SceneSnapshot; selection: SceneCanvasProps['debugSelection'] }) {
  const bounds = useMemo(() => {
    if (!selection) return null;
    const partIds = new Set(selection.kind === 'part' ? [selection.id]
      : snapshot.parts.filter(part => part.groupId === selection.id).map(part => part.id));
    const box = new Box3();
    for (const voxel of snapshot.voxels) if (partIds.has(voxel.partId)) {
      box.expandByPoint(new Vector3(voxel.cell.x, voxel.cell.y, voxel.cell.z));
      box.expandByPoint(new Vector3(voxel.cell.x + 1, voxel.cell.y + 1, voxel.cell.z + 1));
    }
    return box.isEmpty() ? null : box.expandByScalar(0.05);
  }, [snapshot, selection]);
  // A read-only helper: no snapshot mutation, picking, shadows, or GTAO occlusion.
  return bounds ? <box3Helper args={[bounds, '#F2A53B']} material-depthTest={false} renderOrder={10} raycast={() => undefined} /> : null;
}

export function SceneCanvas(props: SceneCanvasProps) {
  const previous = useRef(props.snapshot);
  const [motionBounds, setMotionBounds] = useState<Box3 | null>(null);
  const onMotionBounds = useCallback((bounds: Box3) => setMotionBounds(bounds), []);
  const lighting = useMemo(() => {
    const bounds = new Box3();
    for (const snapshot of [previous.current, props.snapshot]) for (const { cell } of snapshot.voxels) {
      bounds.expandByPoint(new Vector3(cell.x, cell.y, cell.z));
      bounds.expandByPoint(new Vector3(cell.x + 1, cell.y + DROP_HEIGHT + 1, cell.z + 1));
    }
    if (motionBounds) bounds.union(motionBounds);
    if (bounds.isEmpty()) bounds.set(new Vector3(-12, 0, -12), new Vector3(12, 12, 12));
    const floorY = Math.min(-3.09, bounds.min.y - 0.09);
    // Project the full caster bounds onto the receiving plane along the main light direction.
    const fall = bounds.max.y - floorY;
    const ground = new Box3(
      new Vector3(bounds.min.x - 4, floorY, bounds.min.z - fall * 18 / 55 - 4),
      new Vector3(bounds.max.x + fall * 22 / 55 + 4, floorY, bounds.max.z + 4),
    );
    const center = ground.getCenter(new Vector3());
    const size = ground.getSize(new Vector3());
    bounds.union(ground);
    return { bounds, center, size };
  }, [props.snapshot, motionBounds]);
  useLayoutEffect(() => { previous.current = props.snapshot; }, [props.snapshot]);
  return <div className="scene-canvas" style={{ width: '100%', height: '100%', touchAction: 'none' }} role="img" aria-label="可以旋转、缩放和平移的三维体素小岛">
    <Canvas shadows frameloop="demand" dpr={[1, 1.65]} camera={{ position: [48, 39, 56], near: 0.1, far: 500, fov: 40 }}
      flat onCreated={({ gl }) => { gl.shadowMap.type = PCFShadowMap; }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}>
      <SceneLighting bounds={lighting.bounds} />
      <VoxelWorld {...props} onMotionBounds={onMotionBounds} />
      <SelectionBounds snapshot={props.snapshot} selection={props.debugSelection} />
      <gridHelper args={[180, 90, '#DCE7CB', '#DCE7CB']} position={[0, -3.1, 0]} material-transparent material-opacity={0.22} />
      <mesh position={lighting.center} rotation={[-Math.PI / 2, 0, 0]} receiveShadow raycast={() => undefined}>
        <planeGeometry args={[lighting.size.x, lighting.size.z]} />
        <shadowMaterial transparent opacity={0.16} color="#64724D" depthWrite={false} />
      </mesh>
      <SceneCamera snapshot={props.snapshot} viewAction={props.viewAction} sceneFrameRef={props.sceneFrameRef} animationResetKey={props.animationResetKey} />
      <ScenePostprocessing />
      <ScenePreviewCapture captureRef={props.captureRef} revision={props.snapshot.revision} resetKey={props.previewResetKey ?? 0} />
    </Canvas>
  </div>;
}
export default SceneCanvas;

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Box3, Color, DataTexture, InstancedMesh, LinearFilter, LinearMipmapLinearFilter, Object3D, PerspectiveCamera, PCFShadowMap, RGBAFormat, Sphere, SRGBColorSpace, Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { SceneSnapshot } from '../../../../packages/protocol/src/index.ts';
import { SceneLighting } from './SceneLighting.tsx';
import { ScenePostprocessing } from './ScenePostprocessing.tsx';
import { framePerspectiveScene } from './cameraFraming.ts';

type Voxel = SceneSnapshot['voxels'][number];
export type ScenePick = { voxelId: number; normal: { x: number; y: number; z: number } };
export type ViewAction = { kind: 'zoomIn' | 'zoomOut' | 'reset'; seq: number } | null;
export type SceneCanvasProps = {
  sceneFrameRef?: RefObject<HTMLDivElement | null>;
  snapshot: SceneSnapshot;
  mode: 'orbit' | 'build' | 'paint';
  selectedColor: string;
  onPick: (pick: ScenePick) => void;
  viewAction: ViewAction;
  debugSelection?: { kind: 'group' | 'part'; id: string } | null;
};

function makeEdgeTexture(): DataTexture {
  const size = 64;
  const bytes = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const distance = Math.min(x, y, size - 1 - x, size - 1 - y);
    // Full-sized adjacent cubes share a boundary. A faint material edge reveals the grid without gaps.
    const tone = distance === 0 ? 222 : distance === 1 ? 244 : 255;
    const offset = (y * size + x) * 4;
    bytes[offset] = bytes[offset + 1] = bytes[offset + 2] = tone; bytes[offset + 3] = 255;
  }
  const texture = new DataTexture(bytes, size, size, RGBAFormat);
  texture.colorSpace = SRGBColorSpace; texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter; texture.generateMipmaps = true; texture.needsUpdate = true;
  return texture;
}

function SceneCamera({ snapshot, mode, viewAction, sceneFrameRef }: Pick<SceneCanvasProps, 'snapshot' | 'mode' | 'viewAction' | 'sceneFrameRef'>) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, size, gl, invalidate } = useThree();
  const latest = useRef(snapshot); latest.current = snapshot;
  const applied = useRef(-1);
  const fit = () => {
    if (!(camera instanceof PerspectiveCamera)) return;
    const canvasBounds = gl.domElement.getBoundingClientRect();
    const frame = sceneFrameRef?.current?.getBoundingClientRect() ?? canvasBounds;
    const fitted = framePerspectiveScene(camera, latest.current.voxels, size, {
      left: frame.left - canvasBounds.left, top: frame.top - canvasBounds.top,
      width: frame.width, height: frame.height,
    });
    if (controls.current) {
      controls.current.target.copy(fitted.target);
      controls.current.minDistance = fitted.minDistance; controls.current.maxDistance = fitted.maxDistance;
      controls.current.update();
    }
    invalidate();
  };
  useLayoutEffect(() => {
    fit();
    const frame = sceneFrameRef?.current;
    if (!frame) return;
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [size.width, size.height, camera, sceneFrameRef]);
  useEffect(() => {
    if (!viewAction || viewAction.seq === applied.current || !(camera instanceof PerspectiveCamera)) return;
    applied.current = viewAction.seq;
    if (viewAction.kind === 'reset') fit();
    else {
      const orbit = controls.current; if (!orbit) return;
      const offset = camera.position.clone().sub(orbit.target);
      const distance = Math.min(orbit.maxDistance, Math.max(orbit.minDistance,
        offset.length() * (viewAction.kind === 'zoomIn' ? 1 / 1.2 : 1.2)));
      camera.position.copy(orbit.target).add(offset.setLength(distance));
      orbit.update(); invalidate();
    }
  }, [viewAction, camera, invalidate]);
  return <OrbitControls ref={controls} makeDefault enableRotate={mode === 'orbit'} enablePan={mode === 'orbit'} enableDamping dampingFactor={0.12} minPolarAngle={Math.PI / 9} maxPolarAngle={Math.PI / 2.3} />;
}

type Motion = { index: number; from: Vector3; to: Vector3; start: number; duration: number };
function VoxelWorld({ snapshot, mode, selectedColor, onPick }: Omit<SceneCanvasProps, 'viewAction'>) {
  const mesh = useRef<InstancedMesh>(null);
  const previous = useRef<Map<number, Voxel> | null>(null);
  const motions = useRef<Motion[]>([]);
  const [hovered, setHovered] = useState<number | null>(null);
  const { invalidate } = useThree();
  const edgeTexture = useMemo(makeEdgeTexture, []);
  const transform = useMemo(() => new Object3D(), []);
  const color = useMemo(() => new Color(), []);
  const reducedMotion = useRef(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { reducedMotion.current = media.matches; };
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => () => edgeTexture.dispose(), [edgeTexture]);
  useLayoutEffect(() => {
    const target = mesh.current; if (!target) return;
    const old = previous.current;
    // The demand-loop clock is idle between edits; use wall time for animation start and progress.
    const now = performance.now() / 1000;
    const nextMotions: Motion[] = [];
    const sweptBounds = new Box3();
    for (let index = 0; index < snapshot.voxels.length; index++) {
      const voxel = snapshot.voxels[index];
      const destination = new Vector3(voxel.cell.x + 0.5, voxel.cell.y + 0.5, voxel.cell.z + 0.5);
      sweptBounds.expandByPoint(destination);
      const before = old?.get(voxel.id);
      const moved = before && (before.cell.x !== voxel.cell.x || before.cell.y !== voxel.cell.y || before.cell.z !== voxel.cell.z);
      if (old && !reducedMotion.current && (!before || moved)) {
        const from = before ? new Vector3(before.cell.x + 0.5, before.cell.y + 0.5, before.cell.z + 0.5) : destination.clone().add(new Vector3(0, 2.5, 0));
        nextMotions.push({ index, from, to: destination, start: now + (index % 14) * 0.012, duration: 0.32 });
        sweptBounds.expandByPoint(from);
        transform.position.copy(from);
      } else transform.position.copy(destination);
      transform.updateMatrix(); target.setMatrixAt(index, transform.matrix);
      target.setColorAt(index, color.set(voxel.color));
    }
    motions.current = nextMotions;
    target.count = snapshot.voxels.length;
    target.instanceMatrix.needsUpdate = true;
    if (target.instanceColor) target.instanceColor.needsUpdate = true;
    if (nextMotions.length) {
      // Include both endpoints so a moving instance is not culled by the view or shadow camera.
      target.boundingBox = sweptBounds.expandByScalar(0.5);
      target.boundingSphere = target.boundingBox.getBoundingSphere(new Sphere());
    } else { target.computeBoundingBox(); target.computeBoundingSphere(); }
    previous.current = new Map(snapshot.voxels.map(voxel => [voxel.id, voxel]));
    setHovered(null); invalidate();
  }, [snapshot, color, transform, invalidate]);
  useFrame(() => {
    const target = mesh.current;
    if (!target || !motions.current.length) return;
    const remaining: Motion[] = [];
    const now = performance.now() / 1000;
    for (const motion of motions.current) {
      const raw = reducedMotion.current ? 1 : Math.min(1, Math.max(0, (now - motion.start) / motion.duration));
      const progress = 1 - (1 - raw) ** 3;
      transform.position.lerpVectors(motion.from, motion.to, progress); transform.updateMatrix();
      target.setMatrixAt(motion.index, transform.matrix);
      if (raw < 1) remaining.push(motion);
    }
    target.instanceMatrix.needsUpdate = true;
    motions.current = remaining;
    if (!remaining.length) { target.computeBoundingBox(); target.computeBoundingSphere(); }
    invalidate();
  });
  const select = (event: ThreeEvent<MouseEvent>) => {
    if (mode === 'orbit' || event.instanceId === undefined || !event.face) return;
    const voxel = snapshot.voxels[event.instanceId]; if (!voxel) return;
    event.stopPropagation();
    onPick({ voxelId: voxel.id, normal: { x: Math.round(event.face.normal.x), y: Math.round(event.face.normal.y), z: Math.round(event.face.normal.z) } });
  };
  const hover = snapshot.voxels.find(voxel => voxel.id === hovered);
  const capacity = Math.max(1, snapshot.voxels.length);
  // Recreate only when capacity changes; IDs are re-associated with slots after every transaction.
  return <>
    <instancedMesh key={capacity} ref={mesh} args={[undefined, undefined, capacity]} castShadow receiveShadow onClick={select}
      onPointerMove={event => {
        if (mode === 'orbit' || event.instanceId === undefined) return;
        const id = snapshot.voxels[event.instanceId]?.id ?? null;
        setHovered(value => value === id ? value : id);
      }} onPointerOut={() => setHovered(null)}>
      <boxGeometry args={[1, 1, 1]} />
      <meshLambertMaterial map={edgeTexture} />
    </instancedMesh>
    {hover && mode !== 'orbit' && <mesh position={[hover.cell.x + 0.5, hover.cell.y + 0.5, hover.cell.z + 0.5]} raycast={() => undefined}>
      <boxGeometry args={[1.035, 1.035, 1.035]} />
      <meshBasicMaterial color={mode === 'paint' ? selectedColor : '#FFFFFF'} transparent opacity={0.36} depthWrite={false} />
    </mesh>}
  </>;
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
  const lighting = useMemo(() => {
    const bounds = new Box3();
    for (const snapshot of [previous.current, props.snapshot]) for (const { cell } of snapshot.voxels) {
      bounds.expandByPoint(new Vector3(cell.x, cell.y, cell.z));
      bounds.expandByPoint(new Vector3(cell.x + 1, cell.y + 3.5, cell.z + 1));
    }
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
  }, [props.snapshot]);
  useLayoutEffect(() => { previous.current = props.snapshot; }, [props.snapshot]);
  return <div className="scene-canvas" style={{ width: '100%', height: '100%', touchAction: 'none' }} role="img" aria-label="可以旋转、缩放和搭建的三维体素小岛">
    <Canvas shadows frameloop="demand" dpr={[1, 1.65]} camera={{ position: [48, 39, 56], near: 0.1, far: 500, fov: 40 }}
      flat onCreated={({ gl }) => { gl.shadowMap.type = PCFShadowMap; }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}>
      <SceneLighting bounds={lighting.bounds} />
      <VoxelWorld {...props} />
      <SelectionBounds snapshot={props.snapshot} selection={props.debugSelection} />
      <gridHelper args={[180, 90, '#DCE7CB', '#DCE7CB']} position={[0, -3.1, 0]} material-transparent material-opacity={0.22} />
      <mesh position={lighting.center} rotation={[-Math.PI / 2, 0, 0]} receiveShadow raycast={() => undefined}>
        <planeGeometry args={[lighting.size.x, lighting.size.z]} />
        <shadowMaterial transparent opacity={0.16} color="#64724D" depthWrite={false} />
      </mesh>
      <SceneCamera snapshot={props.snapshot} mode={props.mode} viewAction={props.viewAction} sceneFrameRef={props.sceneFrameRef} />
      <ScenePostprocessing />
    </Canvas>
  </div>;
}
export default SceneCanvas;

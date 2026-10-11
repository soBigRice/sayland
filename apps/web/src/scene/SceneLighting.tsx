import { useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { Box3, DirectionalLight, Object3D, PCFShadowMap, Vector3 } from 'three';

const SUN_DIRECTION = new Vector3(-22, 55, 18).normalize();
const SHADOW_PADDING = 1;

/** Bounds include complete cubes and the full path of any active build animation. */
export function SceneLighting({ bounds }: { bounds: Box3 }) {
  const mainLight = useRef<DirectionalLight>(null);
  const target = useMemo(() => new Object3D(), []);
  const { scene, gl, invalidate } = useThree();

  useLayoutEffect(() => {
    const shadow = mainLight.current?.shadow;
    scene.add(target);
    gl.shadowMap.type = PCFShadowMap;
    return () => {
      scene.remove(target);
      // R3F disposes the declarative light too; clear handles so effect replay is safe.
      shadow?.dispose();
      if (shadow) { shadow.map = null; shadow.mapPass = null; }
    };
  }, [scene, gl, target]);

  useLayoutEffect(() => {
    const light = mainLight.current;
    if (!light) return;
    const occupied = bounds.isEmpty()
      ? new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1))
      : bounds;
    const center = occupied.getCenter(new Vector3());
    const radius = occupied.getSize(new Vector3()).length() / 2;
    target.position.copy(center);
    // Moving the light and its target together keeps the established sunlight direction.
    light.position.copy(center).addScaledVector(SUN_DIRECTION, radius + 10);
    target.updateMatrixWorld(true);
    light.updateMatrixWorld(true);
    light.shadow.updateMatrices(light);

    const camera = light.shadow.camera;
    const projected = new Box3();
    const corner = new Vector3();
    for (const x of [occupied.min.x, occupied.max.x]) {
      for (const y of [occupied.min.y, occupied.max.y]) {
        for (const z of [occupied.min.z, occupied.max.z]) {
          projected.expandByPoint(corner.set(x, y, z).applyMatrix4(camera.matrixWorldInverse));
        }
      }
    }
    camera.left = projected.min.x - SHADOW_PADDING;
    camera.right = projected.max.x + SHADOW_PADDING;
    camera.bottom = projected.min.y - SHADOW_PADDING;
    camera.top = projected.max.y + SHADOW_PADDING;
    // Camera-space forward is negative Z; fit depth as well as the image plane.
    camera.near = Math.max(0.1, -projected.max.z - SHADOW_PADDING);
    camera.far = Math.max(camera.near + 1, -projected.min.z + SHADOW_PADDING);
    camera.updateProjectionMatrix();
    light.shadow.updateMatrices(light);
    light.shadow.needsUpdate = true;
    invalidate();
  }, [bounds, target, invalidate]);

  return <>
    <ambientLight intensity={Math.PI * 0.60} />
    <hemisphereLight args={['#FFFDF5', '#E4ECD8', Math.PI * 0.22]} />
    {/* Keep automatic shadow updates: demand frames already stop when motion is idle. */}
    <directionalLight ref={mainLight} target={target} castShadow intensity={Math.PI * 0.46} color="#FFF6E7"
      shadow-mapSize={[2048, 2048]} shadow-normalBias={0.03} shadow-radius={2} />
    <directionalLight position={[30, 18, -20]} intensity={Math.PI * 0.12} color="#EDF5FF" />
  </>;
}

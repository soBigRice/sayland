import { useLayoutEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Mesh, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';

class VoxelGTAOPass extends GTAOPass {
  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget, deltaTime: number, maskActive: boolean) {
    const overlays: Mesh[] = [];
    // The transparent contact-shadow receiver is an overlay, not a solid occluder.
    // Beauty has already been rendered; only exclude them from GTAO's depth/normal pass.
    this.scene.traverseVisible(object => {
      if (!(object instanceof Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.every(material => material.transparent)) overlays.push(object);
    });
    for (const overlay of overlays) overlay.visible = false;
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    // Beauty already updated the shadows for this animation frame; normals do not need them again.
    renderer.shadowMap.autoUpdate = false;
    try { super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive); }
    finally {
      renderer.shadowMap.autoUpdate = shadowAutoUpdate;
      for (const overlay of overlays) overlay.visible = true;
    }
  }

  override dispose() {
    // r186's GTAOPass.dispose omits these two owned shader materials.
    this.gtaoMaterial.dispose();
    this.blendMaterial.dispose();
    super.dispose();
  }
}

/** One demand-driven frame: beauty → GTAO/denoise → output color conversion → FXAA. */
export function ScenePostprocessing() {
  const { gl, scene, camera, size, viewport, invalidate } = useThree();
  const composer = useRef<EffectComposer | null>(null);

  useLayoutEffect(() => {
    const pipeline = new EffectComposer(gl);
    const beauty = new RenderPass(scene, camera);
    // RenderPass clears before WebGLBackground updates GL state; explicitly keep the canvas transparent.
    beauty.clearAlpha = 0;
    const ao = new VoxelGTAOPass(scene, camera);
    // A voxel is one world unit. World-space AO keeps its physical radius as the camera moves or zooms.
    ao.updateGtaoMaterial({ radius: 2.2, thickness: 1, distanceFallOff: 1, samples: 16, screenSpaceRadius: false });
    ao.updatePdMaterial({ radius: 3, samples: 16, rings: 2 });
    ao.blendIntensity = 0.85;
    // Canvas is intentionally flat (NoToneMapping). Offscreen blending stores premultiplied
    // linear RGB: unpremultiply before sRGB conversion, then restore it for browser compositing.
    // Applying ordinary OutputPass directly makes the translucent grid and shadow edges glow.
    const output = new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: CopyShader.vertexShader,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() {
          vec4 color = texture2D(tDiffuse, vUv);
          color.rgb = color.a > 0.00001 ? color.rgb / color.a : vec3(0.0);
          gl_FragColor = vec4(sRGBTransferOETF(color).rgb * color.a, color.a);
        }
      `,
    });
    const antialias = new FXAAPass();
    pipeline.addPass(beauty); pipeline.addPass(ao); pipeline.addPass(output); pipeline.addPass(antialias);
    composer.current = pipeline;
    invalidate();
    return () => {
      composer.current = null;
      for (const pass of pipeline.passes) pass.dispose();
      pipeline.dispose();
    };
  }, [gl, scene, camera, invalidate]);

  useLayoutEffect(() => {
    composer.current?.setPixelRatio(viewport.dpr);
    composer.current?.setSize(size.width, size.height);
    invalidate();
  }, [size.width, size.height, viewport.dpr, gl, scene, camera, invalidate]);

  // Positive priority replaces R3F's beauty render; it does not request a continuous frame loop.
  useFrame((_, delta) => { composer.current?.render(delta); }, 1);
  return null;
}

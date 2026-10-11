import { PerspectiveCamera, Spherical, Vector3 } from 'three';
import { Easing, Tween } from 'three/addons/libs/tween.module.js';

export const CAMERA_TWEEN_DURATION = 2200;
type Orbit = { target: Vector3; minDistance: number; maxDistance: number; enableDamping: boolean; update(): unknown };
type Fit = { target: Vector3; minDistance: number; maxDistance: number };

/** One owned tween, advanced only by R3F. No global tween group, RAF or timer survives cancellation. */
export class CameraTween {
  private tween?: Tween<{ progress: number }>;
  private finishFrame?: () => void;
  private restoreDamping?: () => void;
  get running() { return this.tween?.isPlaying() ?? false; }

  start(camera: PerspectiveCamera, orbit: Orbit, destination: PerspectiveCamera, fitted: Fit, now: number) {
    this.stop();
    const target = orbit.target.clone(), position = camera.position.clone();
    const from = new Spherical().setFromVector3(position.clone().sub(target));
    const to = new Spherical().setFromVector3(destination.position.clone().sub(fitted.target));
    // Spherical interpolation avoids cutting through the target when resetting from its opposite side.
    const angle = Math.atan2(Math.sin(to.theta - from.theta), Math.cos(to.theta - from.theta));
    const spherical = new Spherical(), offset = new Vector3();
    const view = destination.view!;
    const fromX = camera.view?.enabled ? camera.view.offsetX : 0;
    const fromY = camera.view?.enabled ? camera.view.offsetY : 0;
    const zoom = camera.zoom;
    const damping = orbit.enableDamping;
    // Drain existing orbit momentum, then restore the displayed pose so the first tween frame cannot jump.
    orbit.enableDamping = false; orbit.update();
    orbit.target.copy(target); camera.position.copy(position); orbit.update();
    this.restoreDamping = () => { orbit.enableDamping = damping; };
    // Both endpoints and the entire interpolated orbit must be legal before controls.update() clamps them.
    orbit.minDistance = Math.min(orbit.minDistance, fitted.minDistance, from.radius, to.radius);
    orbit.maxDistance = Math.max(orbit.maxDistance, fitted.maxDistance, from.radius, to.radius);
    camera.far = Math.max(camera.far, destination.far);
    const apply = (progress: number) => {
      orbit.target.lerpVectors(target, fitted.target, progress);
      spherical.set(from.radius + (to.radius - from.radius) * progress,
        from.phi + (to.phi - from.phi) * progress, from.theta + angle * progress);
      camera.position.copy(orbit.target).add(offset.setFromSpherical(spherical));
      camera.zoom = zoom + (destination.zoom - zoom) * progress;
      camera.setViewOffset(view.fullWidth, view.fullHeight,
        fromX + (view.offsetX - fromX) * progress, fromY + (view.offsetY - fromY) * progress,
        view.width, view.height);
      orbit.update(); camera.updateMatrixWorld(true);
    };
    this.finishFrame = () => {
      apply(1);
      orbit.minDistance = fitted.minDistance; orbit.maxDistance = fitted.maxDistance;
      this.restoreDamping?.(); this.restoreDamping = undefined;
    };
    this.tween = new Tween({ progress: 0 }, false).to({ progress: 1 }, CAMERA_TWEEN_DURATION)
      .easing(Easing.Cubic.InOut).onUpdate(({ progress }) => apply(progress))
      .onComplete(() => { this.finishFrame?.(); this.finishFrame = undefined; this.tween = undefined; }).start(now);
  }

  advance(now: number) { this.tween?.update(now, false); }
  finish() {
    this.tween?.stop(); this.tween = undefined;
    this.finishFrame?.(); this.finishFrame = undefined;
  }
  stop() {
    this.tween?.stop(); this.tween = undefined; this.finishFrame = undefined;
    this.restoreDamping?.(); this.restoreDamping = undefined;
  }
}

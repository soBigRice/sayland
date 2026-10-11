import { Box3, Vector3 } from 'three';
import { Easing } from 'three/addons/libs/tween.module.js';
import type { SceneSnapshot } from '../../../../packages/protocol/src/index.ts';

type Voxel = SceneSnapshot['voxels'][number];
// Reveal the entire committed batch immediately; animation time never grows with voxel count.
export const DROP_HEIGHT = 0.9;
export const DROP_DURATION = 1600;
export const MOVE_DURATION = 1400;
type Motion = { from: Vector3; to: Vector3; start: number; duration: number };
type Visual = { target: Voxel; position: Vector3; visible: boolean; motion?: Motion };
const center = (voxel: Voxel) => new Vector3(voxel.cell.x + 0.5, voxel.cell.y + 0.5, voxel.cell.z + 0.5);

/** Display-only state keyed by stable IDs; R3F supplies one demand-driven clock. */
export class VoxelMotion {
  private states = new Map<number, Visual>();
  private active = new Set<number>();
  private changed = new Set<number>();
  get running() { return this.active.size > 0; }
  get activeIds(): ReadonlySet<number> { return this.active; }
  get(id: number) { return this.states.get(id); }
  isPickable(id: number) { const state = this.states.get(id); return !!state?.visible && !state.motion; }

  sync(voxels: readonly Voxel[], animate: boolean, now: number): void {
    // Continue from what was actually displayed, including an interrupted move.
    this.advance(now);
    const ids = new Set(voxels.map(voxel => voxel.id));
    for (const id of this.states.keys()) if (!ids.has(id)) { this.states.delete(id); this.active.delete(id); }
    for (const voxel of voxels) {
      const to = center(voxel);
      let state = this.states.get(voxel.id);
      if (!state) {
        state = { target: voxel, position: to.clone(), visible: true };
        if (animate) {
          state.position.y += DROP_HEIGHT;
          state.motion = { from: state.position.clone(), to, start: now, duration: DROP_DURATION };
        }
        this.states.set(voxel.id, state);
      } else if (voxel.cell.x !== state.target.cell.x || voxel.cell.y !== state.target.cell.y || voxel.cell.z !== state.target.cell.z) {
        if (animate) {
          state.motion = { from: state.position.clone(), to, start: now, duration: MOVE_DURATION };
        }
      }
      state.target = voxel;
      if (!animate) { state.position.copy(to); state.visible = true; delete state.motion; }
      if (state.motion) this.active.add(voxel.id); else this.active.delete(voxel.id);
    }
  }

  advance(now: number): ReadonlySet<number> {
    this.changed.clear();
    for (const id of this.active) {
      const state = this.states.get(id)!, motion = state.motion!;
      if (now < motion.start) continue;
      state.visible = true;
      const ratio = Math.min(1, Math.max(0, (now - motion.start) / motion.duration));
      // Keep the journey visible throughout; an ease-out spends most of a longer duration almost still.
      state.position.lerpVectors(motion.from, motion.to, Easing.Cubic.InOut(ratio));
      if (ratio === 1) { state.position.copy(motion.to); delete state.motion; this.active.delete(id); }
      this.changed.add(id);
    }
    return this.changed;
  }

  finish(): void {
    for (const state of this.states.values()) {
      state.position.copy(center(state.target)); state.visible = true; delete state.motion;
    }
    this.active.clear(); this.changed.clear();
  }

  bounds(): Box3 {
    const bounds = new Box3();
    for (const state of this.states.values()) {
      bounds.expandByPoint(state.position);
      if (state.motion) { bounds.expandByPoint(state.motion.from); bounds.expandByPoint(state.motion.to); }
    }
    return bounds.isEmpty() ? bounds : bounds.expandByScalar(0.5);
  }

  dispose(): void {
    // No own RAF, timers or GPU objects. A late frame after removal cannot revive any IDs.
    this.states.clear(); this.active.clear(); this.changed.clear();
  }
}

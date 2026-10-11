import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three-stdlib';
import { getAll } from 'three/addons/libs/tween.module.js';
import { CameraTween, CAMERA_TWEEN_DURATION } from './cameraTween.ts';
import { framePerspectiveScene } from './cameraFraming.ts';

const viewport = { width: 1000, height: 800 }, frame = { left: 100, top: 150, width: 800, height: 500 };
function fixture() {
  const camera = new PerspectiveCamera(40, 1.25, .1, 1000);
  camera.position.set(-50, 40, -60);
  const orbit = new OrbitControls(camera); orbit.enableDamping = true; orbit.update();
  const destination = camera.clone();
  const fit = framePerspectiveScene(destination, [{ id: 1, partId: 'building', color: '#FFFFFF', cell: { x: 150, y: 20, z: 90 } },
    { id: 2, partId: 'building', color: '#FFFFFF', cell: { x: 170, y: 45, z: 110 } }], viewport, frame);
  const tween = new CameraTween();
  return { camera, orbit, destination, fit, tween };
}

test('camera tween has no first-frame jump, moves the orbit and projection together, then reaches the exact fit', () => {
  const { camera, orbit, destination, fit, tween } = fixture();
  const position = camera.position.clone(), target = orbit.target.clone(), all = getAll().length;
  tween.start(camera, orbit, destination, fit, 1000);
  assert.ok(camera.position.distanceTo(position) < 1e-9); assert.deepEqual(orbit.target, target);
  assert.equal(tween.running, true); assert.equal(orbit.enableDamping, false);
  assert.equal(getAll().length, all, 'camera tween is never retained in a global tween group');
  tween.advance(1850);
  assert.equal(tween.running, true, 'the former 850 ms duration must not finish the camera journey');
  assert.ok(camera.position.distanceTo(destination.position) > 1);
  tween.advance(1000 + CAMERA_TWEEN_DURATION / 2);
  assert.ok(orbit.target.distanceTo(target.clone().lerp(fit.target, .5)) < 1e-9);
  const startRadius = position.distanceTo(target), endRadius = destination.position.distanceTo(fit.target);
  assert.ok(Math.abs(camera.position.distanceTo(orbit.target) - (startRadius + endRadius) / 2) < 1e-8);
  assert.ok(Math.abs(camera.view!.offsetX - destination.view!.offsetX / 2) < 1e-9);
  assert.ok(camera.position.distanceTo(position) > 1);
  tween.advance(1000 + CAMERA_TWEEN_DURATION);
  assert.ok(camera.position.distanceTo(destination.position) < 1e-8);
  assert.deepEqual(orbit.target, fit.target); assert.deepEqual(camera.view, destination.view);
  assert.equal(orbit.minDistance, fit.minDistance); assert.equal(orbit.maxDistance, fit.maxDistance);
  assert.equal(tween.running, false); assert.equal(orbit.enableDamping, true);
  const settled = camera.position.clone(); tween.advance(99999); assert.deepEqual(camera.position, settled);
  orbit.dispose();
});

test('interrupted and replacement tweens preserve the displayed pose without stale updates', () => {
  const { camera, orbit, destination, fit, tween } = fixture();
  tween.start(camera, orbit, destination, fit, 0); tween.advance(230);
  const pose = camera.position.clone(), target = orbit.target.clone(), view = structuredClone(camera.view);
  tween.stop(); tween.advance(5000);
  assert.deepEqual(camera.position, pose); assert.deepEqual(orbit.target, target); assert.deepEqual(camera.view, view);
  assert.equal(orbit.enableDamping, true); assert.equal(tween.running, false);
  const next = destination.clone(); next.position.add(new Vector3(20, 0, 0));
  tween.start(camera, orbit, next, fit, 6000);
  assert.ok(camera.position.distanceTo(pose) < 1e-8);
  tween.finish();
  assert.ok(camera.position.distanceTo(next.position) < 1e-8);
  assert.equal(tween.running, false); assert.equal(orbit.enableDamping, true);
  tween.stop(); orbit.dispose();
});

test('auto-fit preserves the current orbit direction throughout the tween', () => {
  const { camera, orbit, destination, tween } = fixture();
  const direction = camera.position.clone().sub(orbit.target).normalize();
  const fit = framePerspectiveScene(destination, [], viewport, frame, direction);
  tween.start(camera, orbit, destination, fit, 0);
  for (const progress of [0, .1, .4, .8, 1]) {
    tween.advance(CAMERA_TWEEN_DURATION * progress);
    assert.ok(camera.position.clone().sub(orbit.target).normalize().distanceTo(direction) < 1e-8);
  }
  orbit.dispose();
});

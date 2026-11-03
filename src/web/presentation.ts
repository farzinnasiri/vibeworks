import * as THREE from 'three';

/** Topology outlines are display-only; selection, tooling and review feedback remain visible. */
export const showOutline = (edges: boolean, selected: boolean, hovered: boolean, ghost: boolean, flagged: boolean, picked: boolean) => edges || selected || hovered || ghost || flagged || picked;

/** Multiple interaction/effect updates produce one draw. Idle viewports have no scheduled work. */
export function onDemandFrame(draw: () => void, request = requestAnimationFrame, cancel = cancelAnimationFrame) {
  let handle = 0;
  return {
    request: () => { if (!handle) handle = request(() => { handle = 0; draw(); }); },
    cancel: () => { if (handle) cancel(handle); handle = 0; },
  };
}

/** Linear world-Z turntable: preserve target, radius, elevation and orthographic zoom. */
export function advanceOrbit(camera: THREE.Camera, target: THREE.Vector3, seconds: number): void {
  camera.position.sub(target).applyAxisAngle(new THREE.Vector3(0, 0, 1), Math.max(0, seconds) * Math.PI / 18).add(target);
  camera.lookAt(target);
}

/** A pole view has no azimuth. Starting there deliberately tilts to 45 degrees at the same distance. */
export function prepareOrbit(camera: THREE.Camera, target: THREE.Vector3): void {
  const offset = camera.position.clone().sub(target), distance = offset.length();
  if (Math.hypot(offset.x, offset.y) < distance * 1e-6)
    camera.position.copy(target).add(new THREE.Vector3(distance / 2, -distance / 2, Math.sign(offset.z || 1) * distance / Math.SQRT2));
  camera.up.set(0, 0, 1); camera.lookAt(target);
}

/** At most one scheduled frame. Hidden tabs stop explicitly rather than accumulating elapsed time. */
export function orbitLoop(step: (seconds: number) => void, request = requestAnimationFrame, cancel = cancelAnimationFrame) {
  let previous: number | undefined, handle = 0, stopped = false;
  const frame = (now: number) => {
    if (stopped) return;
    if (previous !== undefined) step((now - previous) / 1000);
    previous = now;
    if (!stopped) handle = request(frame);
  };
  handle = request(frame);
  return () => { stopped = true; cancel(handle); };
}

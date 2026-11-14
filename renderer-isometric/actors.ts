import * as THREE from 'three';
import { StructureKind, UnitState } from '../game-sim/components';
import { ACCENT } from './palette';

/** Mesh factories for the animated things in a sector: colonists, drop pods and structures. */

const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
const matCache = new Map<string, THREE.MeshStandardMaterial>();

function solid(color: THREE.Color, roughness = 0.85, metalness = 0): THREE.MeshStandardMaterial {
  const key = color.getHexString() + roughness + metalness;
  let m = matCache.get(key);
  if (!m) matCache.set(key, (m = new THREE.MeshStandardMaterial({ color, roughness, metalness })));
  return m;
}

function part(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

const GEO = {
  torso: new THREE.BoxGeometry(0.2, 0.3, 0.32),
  head: new THREE.SphereGeometry(0.11, 10, 8),
  limb: new THREE.BoxGeometry(0.1, 0.34, 0.11).translate(0, -0.17, 0),
  arm: new THREE.BoxGeometry(0.08, 0.28, 0.08).translate(0, -0.14, 0),
  pack: new THREE.BoxGeometry(0.12, 0.24, 0.24),
  tool: new THREE.BoxGeometry(0.36, 0.045, 0.045),
  ring: new THREE.RingGeometry(0.42, 0.5, 28).rotateX(-Math.PI / 2),
};

export interface UnitView {
  group: THREE.Group;
  ring: THREE.Mesh;
  /** Advance the walk / work cycle. */
  animate(state: UnitState, time: number, dt: number): void;
}

export function makeUnit(color: THREE.Color): UnitView {
  const group = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(1.65);
  const cloth = solid(color);
  const dark = solid(color.clone().multiplyScalar(0.45));
  const gear = solid(srgb(0.16, 0.17, 0.17), 0.6, 0.3);
  const legL = part(GEO.limb, dark, 0, 0.36, 0.085), legR = part(GEO.limb, dark, 0, 0.36, -0.085);
  const armL = part(GEO.arm, cloth, 0, 0.66, 0.2), armR = part(GEO.arm, cloth, 0, 0.66, -0.2);
  const tool = part(GEO.tool, gear, 0.16, -0.24, 0);
  armR.add(tool);
  body.add(
    part(GEO.torso, cloth, 0, 0.52, 0), part(GEO.head, dark, 0.01, 0.79, 0), part(GEO.pack, gear, -0.15, 0.54, 0),
    legL, legR, armL, armR,
  );
  const ring = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9, depthTest: false }));
  ring.position.y = 0.05;
  ring.renderOrder = 5;
  ring.visible = false;
  group.add(body, ring);
  let phase = 0;
  return {
    group, ring,
    animate(state, time, dt) {
      const moving = state === UnitState.Moving, working = state === UnitState.Harvesting || state === UnitState.Building;
      if (moving) phase += dt * 11;
      const swing = moving ? Math.sin(phase) * 0.7 : 0;
      legL.rotation.z = swing; legR.rotation.z = -swing;
      armL.rotation.z = -swing * 0.7;
      // Working swings the tool arm from the shoulder.
      armR.rotation.z = working ? 1.1 + Math.sin(time * 9) * 0.7 : swing * 0.7;
      body.position.y = moving ? Math.abs(Math.sin(phase)) * 0.035 : 0;
    },
  };
}

export interface PodView {
  group: THREE.Group;
  /** Position the hull for a fall progress of 0 (just entered the sky) .. 1 (touched down). */
  setFall(progress: number, time: number): void;
}

export function makePod(color: THREE.Color): PodView {
  const group = new THREE.Group();
  const hull = new THREE.Group();
  const metal = solid(srgb(0.3, 0.31, 0.32), 0.5, 0.6);
  const darkMetal = solid(srgb(0.14, 0.15, 0.16), 0.6, 0.5);
  hull.add(
    part(new THREE.CylinderGeometry(0.5, 0.72, 1.3, 8), metal, 0, 0.9, 0),
    part(new THREE.ConeGeometry(0.5, 0.55, 8), darkMetal, 0, 1.82, 0),
    part(new THREE.CylinderGeometry(0.73, 0.73, 0.14, 8), solid(color, 0.7), 0, 0.5, 0),
    part(new THREE.CylinderGeometry(0.45, 0.3, 0.25, 8), darkMetal, 0, 0.15, 0),
  );
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = part(new THREE.BoxGeometry(0.1, 0.75, 0.1), darkMetal, Math.cos(a) * 0.78, 0.3, Math.sin(a) * 0.78);
    leg.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
    hull.add(leg);
  }
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.42, 2.6, 10).rotateX(Math.PI).translate(0, -1.2, 0),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 2.6, 0.8), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  hull.add(flame);
  // Scorched landing mark; fades in as the pod arrives.
  const scorch = new THREE.Mesh(
    new THREE.CircleGeometry(1.5, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false }),
  );
  scorch.position.y = 0.04;
  group.add(hull, scorch);
  return {
    group,
    setFall(progress, time) {
      const p = Math.min(1, Math.max(0, progress));
      // Decelerating burn: fast high up, gentle at the ground.
      hull.position.y = 90 * (1 - p) * (1 - p);
      flame.visible = p < 1;
      flame.scale.set(1, 0.6 + (1 - p) * 0.8 + Math.sin(time * 40) * 0.12, 1);
      (scorch.material as THREE.MeshBasicMaterial).opacity = 0.3 * THREE.MathUtils.smoothstep(p, 0.85, 1);
    },
  };
}

const STRUCT_GEO = {
  [StructureKind.Wall]: new THREE.BoxGeometry(1, 1.25, 1).translate(0, 0.625, 0),
  [StructureKind.Floor]: new THREE.BoxGeometry(0.98, 0.08, 0.98).translate(0, 0.04, 0),
  [StructureKind.Beacon]: new THREE.BoxGeometry(0.7, 0.5, 0.7).translate(0, 0.25, 0),
};
const STRUCT_EDGES = {
  [StructureKind.Wall]: new THREE.EdgesGeometry(STRUCT_GEO[StructureKind.Wall]),
  [StructureKind.Floor]: new THREE.EdgesGeometry(STRUCT_GEO[StructureKind.Floor]),
  [StructureKind.Beacon]: new THREE.EdgesGeometry(new THREE.BoxGeometry(0.7, 2.4, 0.7).translate(0, 1.2, 0)),
};
const STRUCT_COLOR = {
  [StructureKind.Wall]: srgb(0.56, 0.53, 0.47),
  [StructureKind.Floor]: srgb(0.34, 0.35, 0.36),
  [StructureKind.Beacon]: srgb(0.3, 0.31, 0.33),
};
const blueprintLine = new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.95, depthTest: false });
const blueprintFill = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.1, depthWrite: false });

export interface StructureView {
  group: THREE.Group;
  /** progress 0..100; built switches the blueprint wireframe off. */
  setState(progress: number, built: boolean): void;
  animate(time: number): void;
}

/**
 * A structure renders as a cyan wireframe zone box while it is a blueprint,
 * with the solid body rising inside it as construction progresses.
 */
export function makeStructure(kind: StructureKind, ghost = false): StructureView {
  const group = new THREE.Group();
  const wire = new THREE.LineSegments(STRUCT_EDGES[kind], blueprintLine);
  wire.renderOrder = 4;
  const fill = new THREE.Mesh(STRUCT_GEO[kind], blueprintFill);
  const body = new THREE.Group();
  if (!ghost) {
    const base = new THREE.Mesh(STRUCT_GEO[kind], solid(STRUCT_COLOR[kind], kind === StructureKind.Wall ? 0.95 : 0.55, kind === StructureKind.Wall ? 0 : 0.5));
    base.castShadow = base.receiveShadow = true;
    body.add(base);
  }
  let lamp: THREE.Mesh | null = null;
  if (kind === StructureKind.Beacon && !ghost) {
    body.add(part(new THREE.CylinderGeometry(0.05, 0.08, 1.7, 6), solid(srgb(0.2, 0.21, 0.22), 0.5, 0.6), 0, 1.35, 0));
    lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 4, 3.4) }));
    lamp.position.y = 2.28;
    body.add(lamp);
  }
  group.add(wire, fill, body);
  return {
    group,
    setState(progress, built) {
      wire.visible = fill.visible = !built;
      body.visible = built || progress > 0;
      body.scale.y = built ? 1 : Math.max(0.04, progress / 100);
    },
    animate(time) {
      if (lamp) lamp.scale.setScalar(0.85 + 0.3 * Math.max(0, Math.sin(time * 2.5)));
    },
  };
}

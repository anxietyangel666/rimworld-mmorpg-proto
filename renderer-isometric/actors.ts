import * as THREE from 'three';
import { CropStage, UnitState } from '../game-sim/components';
import { ITEMS, StructureKind, type Item } from '../game-sim/items';
import { ACCENT } from './palette';

/** Mesh factories for the animated things on the surface: people, the drop pod, structures and item piles. */

const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
const matCache = new Map<string, THREE.MeshStandardMaterial>();

function solid(color: THREE.Color, roughness = 0.9, metalness = 0): THREE.MeshStandardMaterial {
  const key = color.getHexString() + roughness + metalness;
  let m = matCache.get(key);
  if (!m) matCache.set(key, (m = new THREE.MeshStandardMaterial({ color, roughness, metalness })));
  return m;
}

function part(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
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
const SKIN = srgb(0.62, 0.48, 0.38), WOOD = srgb(0.36, 0.27, 0.18), DARK_WOOD = srgb(0.22, 0.17, 0.13), ROCK = srgb(0.42, 0.41, 0.39);

export interface UnitView {
  group: THREE.Group;
  ring: THREE.Mesh;
  /** Advance the walk / work cycle. */
  animate(state: UnitState, time: number, dt: number): void;
}

export function makeUnit(color: THREE.Color, hero: boolean): UnitView {
  const group = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(hero ? 1.7 : 1.55);
  const cloth = solid(color), dark = solid(color.clone().multiplyScalar(0.5));
  const legL = part(GEO.limb, dark, 0, 0.36, 0.085), legR = part(GEO.limb, dark, 0, 0.36, -0.085);
  const armL = part(GEO.arm, cloth, 0, 0.66, 0.2), armR = part(GEO.arm, cloth, 0, 0.66, -0.2);
  armR.add(part(GEO.tool, solid(DARK_WOOD), 0.16, -0.24, 0));
  body.add(part(GEO.torso, cloth, 0, 0.52, 0), part(GEO.head, solid(SKIN), 0.01, 0.79, 0), legL, legR, armL, armR);
  if (hero) body.add(part(GEO.pack, solid(srgb(0.33, 0.28, 0.2)), -0.15, 0.54, 0));
  const ring = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9, depthTest: false }));
  ring.position.y = 0.06;
  ring.renderOrder = 5;
  ring.visible = false;
  group.add(body, ring);
  let phase = 0;
  return {
    group, ring,
    animate(state, time, dt) {
      const moving = state === UnitState.Moving, working = state >= UnitState.Harvesting;
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
  const metal = solid(srgb(0.3, 0.3, 0.3), 0.6, 0.5), darkMetal = solid(srgb(0.15, 0.15, 0.15), 0.7, 0.4);
  hull.add(
    part(new THREE.CylinderGeometry(0.5, 0.72, 1.3, 8), metal, 0, 0.9, 0),
    part(new THREE.ConeGeometry(0.5, 0.55, 8), darkMetal, 0, 1.82, 0),
    part(new THREE.CylinderGeometry(0.73, 0.73, 0.14, 8), solid(color, 0.8), 0, 0.5, 0),
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
    new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 2.6, 0.8), transparent: true, opacity: 0.85, depthWrite: false }),
  );
  hull.add(flame);
  // Scorched landing mark. Polygon offset keeps it from z-fighting with the ground it lies on.
  const scorch = new THREE.Mesh(
    new THREE.CircleGeometry(1.5, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
  );
  scorch.position.y = 0.06;
  group.add(hull, scorch);
  return {
    group,
    setFall(progress, time) {
      const p = Math.min(1, Math.max(0, progress));
      // Decelerating burn: fast high up, gentle at the ground.
      hull.position.y = 90 * (1 - p) * (1 - p);
      flame.visible = p < 1;
      flame.scale.set(1, 0.6 + (1 - p) * 0.8 + Math.sin(time * 14) * 0.08, 1);
      (scorch.material as THREE.MeshBasicMaterial).opacity = 0.3 * THREE.MathUtils.smoothstep(p, 0.85, 1);
    },
  };
}

// --- structures -----------------------------------------------------------------

/** Bounding box (width, height, depth) of each structure, used for its blueprint wireframe. */
const BOUNDS: Record<StructureKind, [number, number, number]> = {
  [StructureKind.Wall]: [1, 1.25, 1], [StructureKind.Floor]: [0.98, 0.1, 0.98], [StructureKind.Campfire]: [0.8, 0.5, 0.8],
  [StructureKind.ChoppingBlock]: [0.6, 0.5, 0.6], [StructureKind.CraftingTable]: [0.95, 0.75, 0.75], [StructureKind.PitKiln]: [0.95, 0.4, 0.95],
  [StructureKind.Forge]: [0.95, 1.3, 0.95], [StructureKind.GardenPlot]: [0.96, 0.1, 0.96],
};
const edgeCache = new Map<StructureKind, THREE.BufferGeometry>();

export function blueprintEdges(kind: StructureKind): THREE.BufferGeometry {
  let g = edgeCache.get(kind);
  if (!g) {
    const [w, h, d] = BOUNDS[kind];
    edgeCache.set(kind, (g = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0))));
  }
  return g;
}

const blueprintLine = new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.95, depthTest: false });
const FLAME = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 2.2, 0.6) });
const EMBER = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.9, 0.2) });
const LEAF = srgb(0.3, 0.42, 0.2);

export interface StructureView {
  group: THREE.Group;
  setState(progress: number, built: boolean, crop: CropStage): void;
  animate(time: number): void;
}

/**
 * A structure is a chalk-line wireframe box while it is a blueprint, with the
 * solid body rising inside it as construction progresses.
 */
export function makeStructure(kind: StructureKind): StructureView {
  const group = new THREE.Group();
  const wire = new THREE.LineSegments(blueprintEdges(kind), blueprintLine);
  wire.renderOrder = 4;
  const body = new THREE.Group();
  let flame: THREE.Mesh | null = null;
  const crops: THREE.Mesh[] = [];
  const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) =>
    part(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), mat, x, y, z);
  switch (kind) {
    case StructureKind.Wall:
      for (let i = 0; i < 4; i++) {
        const log = part(new THREE.CylinderGeometry(0.16, 0.16, 1, 7).rotateZ(Math.PI / 2), solid(i % 2 ? WOOD : DARK_WOOD), 0, 0.16 + i * 0.31, 0);
        log.scale.set(1, 1, 3);
        body.add(log);
      }
      break;
    case StructureKind.Floor: body.add(box(0.98, 0.1, 0.98, solid(ROCK), 0, 0, 0)); break;
    case StructureKind.Campfire:
      for (let i = 0; i < 6; i++) body.add(part(new THREE.DodecahedronGeometry(0.11), solid(ROCK), Math.cos(i * 1.05) * 0.3, 0.07, Math.sin(i * 1.05) * 0.3));
      body.add(box(0.5, 0.07, 0.09, solid(DARK_WOOD), 0, 0.03, 0), box(0.09, 0.07, 0.5, solid(DARK_WOOD), 0, 0.06, 0));
      flame = part(new THREE.ConeGeometry(0.15, 0.5, 6), FLAME, 0, 0.36, 0, false);
      body.add(flame);
      break;
    case StructureKind.ChoppingBlock: body.add(part(new THREE.CylinderGeometry(0.28, 0.32, 0.45, 9), solid(WOOD), 0, 0.225, 0)); break;
    case StructureKind.CraftingTable:
      body.add(box(0.95, 0.08, 0.75, solid(WOOD), 0, 0.62, 0));
      for (const [x, z] of [[-0.4, -0.3], [0.4, -0.3], [-0.4, 0.3], [0.4, 0.3]]) body.add(box(0.08, 0.62, 0.08, solid(DARK_WOOD), x, 0, z));
      break;
    case StructureKind.PitKiln:
      for (let i = 0; i < 9; i++) body.add(part(new THREE.DodecahedronGeometry(0.15), solid(ROCK), Math.cos(i * 0.7) * 0.36, 0.1, Math.sin(i * 0.7) * 0.36));
      body.add(part(new THREE.CylinderGeometry(0.28, 0.28, 0.08, 10), EMBER, 0, 0.06, 0, false));
      break;
    case StructureKind.Forge:
      body.add(box(0.95, 0.7, 0.95, solid(ROCK), 0, 0, 0), box(0.4, 0.6, 0.4, solid(srgb(0.3, 0.29, 0.28)), 0, 0.7, -0.2));
      body.add(part(new THREE.BoxGeometry(0.36, 0.26, 0.06), EMBER, 0, 0.36, 0.48, false));
      break;
    case StructureKind.GardenPlot:
      body.add(box(0.96, 0.1, 0.96, solid(srgb(0.2, 0.15, 0.11)), 0, 0, 0));
      for (let i = 0; i < 4; i++) {
        const plant = part(new THREE.ConeGeometry(0.12, 0.4, 5), solid(LEAF), (i % 2 ? 0.22 : -0.22), 0.3, (i > 1 ? 0.22 : -0.22));
        crops.push(plant);
        body.add(plant);
      }
      break;
  }
  group.add(wire, body);
  return {
    group,
    setState(progress, built, crop) {
      wire.visible = !built;
      body.visible = built || progress > 0;
      body.scale.y = built ? 1 : Math.max(0.04, progress / 100);
      for (const p of crops) {
        p.visible = crop !== CropStage.Empty;
        p.scale.setScalar(crop === CropStage.Sown ? 0.25 : crop === CropStage.Sprout ? 0.6 : 1);
        (p as THREE.Mesh).material = solid(crop === CropStage.Ripe ? srgb(0.42, 0.2, 0.24) : LEAF);
      }
    },
    animate(time) {
      // Slow, low-amplitude flicker: lively without strobing.
      if (flame) flame.scale.set(1 + Math.sin(time * 5.3) * 0.08, 1 + Math.sin(time * 4.1) * 0.14, 1 + Math.cos(time * 4.7) * 0.08);
    },
  };
}

const PILE_GEO = new THREE.BoxGeometry(0.42, 0.22, 0.34).translate(0, 0.11, 0);

/** Goods lying on the ground: a small bundle tinted like the item. */
export function makePile(item: Item): THREE.Mesh {
  return part(PILE_GEO, solid(new THREE.Color(ITEMS[item]?.color ?? '#777777')), 0, 0, 0);
}

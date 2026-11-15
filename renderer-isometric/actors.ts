import * as THREE from 'three';
import { CropStage, UnitState } from '../game-sim/components';
import { ITEMS, StructureKind, type Item } from '../game-sim/items';
import { Prof } from '../game-sim/village';
import { ACCENT } from './palette';

/** Mesh factories for the animated things on the surface: people, wolves, the drop pod, structures and item piles. */

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
  brim: new THREE.CylinderGeometry(0.2, 0.2, 0.03, 10),
  cap: new THREE.CylinderGeometry(0.1, 0.13, 0.09, 8),
  apron: new THREE.BoxGeometry(0.03, 0.3, 0.26),
};
const SKIN = srgb(0.62, 0.48, 0.38), WOOD = srgb(0.36, 0.27, 0.18), DARK_WOOD = srgb(0.22, 0.17, 0.13), ROCK = srgb(0.42, 0.41, 0.39);

/** Working clothes by trade, so a villager's job can be read at a glance. */
const TRADE_CLOTH: Partial<Record<Prof, THREE.Color>> = {
  [Prof.Elder]: srgb(0.36, 0.2, 0.22), [Prof.Farmer]: srgb(0.5, 0.45, 0.28), [Prof.Lumberjack]: srgb(0.36, 0.27, 0.2),
  [Prof.Miner]: srgb(0.34, 0.35, 0.37), [Prof.Smith]: srgb(0.24, 0.22, 0.21), [Prof.Carpenter]: srgb(0.5, 0.38, 0.24),
  [Prof.Baker]: srgb(0.74, 0.71, 0.64), [Prof.Innkeeper]: srgb(0.42, 0.3, 0.2), [Prof.Merchant]: srgb(0.25, 0.36, 0.4),
  [Prof.Builder]: srgb(0.55, 0.42, 0.25), [Prof.Guard]: srgb(0.3, 0.33, 0.3),
};

export interface UnitView {
  group: THREE.Group;
  ring: THREE.Mesh;
  /** Advance the walk / work cycle. */
  animate(state: UnitState, time: number, dt: number): void;
}

function selectionRing(): THREE.Mesh {
  const ring = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9, depthTest: false }));
  ring.position.y = 0.06;
  ring.renderOrder = 5;
  ring.visible = false;
  return ring;
}

export function makeUnit(color: THREE.Color, hero: boolean, prof: Prof = Prof.None): UnitView {
  const group = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(hero ? 1.7 : 1.55);
  const cloth = solid(TRADE_CLOTH[prof] ?? color), dark = solid((TRADE_CLOTH[prof] ?? color).clone().multiplyScalar(0.5));
  const legL = part(GEO.limb, dark, 0, 0.36, 0.085), legR = part(GEO.limb, dark, 0, 0.36, -0.085);
  const armL = part(GEO.arm, cloth, 0, 0.66, 0.2), armR = part(GEO.arm, cloth, 0, 0.66, -0.2);
  armR.add(part(GEO.tool, solid(DARK_WOOD), 0.16, -0.24, 0));
  body.add(part(GEO.torso, cloth, 0, 0.52, 0), part(GEO.head, solid(SKIN), 0.01, 0.79, 0), legL, legR, armL, armR);
  if (hero) body.add(part(GEO.pack, solid(srgb(0.33, 0.28, 0.2)), -0.15, 0.54, 0));
  // A little costume per trade: straw hat, helmet, apron.
  if (prof === Prof.Farmer) body.add(part(GEO.brim, solid(srgb(0.7, 0.62, 0.36)), 0.01, 0.88, 0));
  if (prof === Prof.Guard) body.add(part(GEO.cap, solid(srgb(0.45, 0.46, 0.47), 0.5, 0.6), 0.01, 0.9, 0));
  if (prof === Prof.Elder) body.add(part(GEO.cap, solid(srgb(0.2, 0.12, 0.13)), 0.01, 0.9, 0));
  if (prof === Prof.Smith || prof === Prof.Baker || prof === Prof.Innkeeper) body.add(part(GEO.apron, solid(prof === Prof.Smith ? srgb(0.3, 0.2, 0.13) : srgb(0.8, 0.78, 0.7)), 0.11, 0.48, 0));
  const ring = selectionRing();
  group.add(body, ring);
  let phase = 0;
  return {
    group, ring,
    animate(state, time, dt) {
      const moving = state === UnitState.Moving;
      const working = state === UnitState.Harvesting || state === UnitState.Building || state === UnitState.Crafting || state === UnitState.Fighting;
      const asleep = state === UnitState.Sleeping;
      if (moving) phase += dt * 11;
      const swing = moving ? Math.sin(phase) * 0.7 : 0;
      legL.rotation.z = swing; legR.rotation.z = -swing;
      armL.rotation.z = state === UnitState.Eating ? 1.2 + Math.sin(time * 3) * 0.3 : -swing * 0.7;
      // Working swings the tool arm from the shoulder.
      armR.rotation.z = working ? 1.1 + Math.sin(time * 9) * 0.7 : swing * 0.7;
      // Sleepers lie down.
      body.rotation.z = asleep ? Math.PI / 2 : 0;
      body.position.y = asleep ? 0.22 : moving ? Math.abs(Math.sin(phase)) * 0.035 : 0;
    },
  };
}

export function makeWolf(): UnitView {
  const group = new THREE.Group();
  const body = new THREE.Group();
  const fur = solid(srgb(0.3, 0.3, 0.31)), dark = solid(srgb(0.17, 0.17, 0.18));
  const leg = new THREE.BoxGeometry(0.09, 0.34, 0.09).translate(0, -0.17, 0);
  const legs = [[0.26, 0.11], [0.26, -0.11], [-0.26, 0.11], [-0.26, -0.11]].map(([x, z]) => part(leg, dark, x, 0.36, z));
  const tail = part(new THREE.BoxGeometry(0.3, 0.07, 0.07).translate(-0.15, 0, 0), dark, -0.38, 0.5, 0);
  tail.rotation.z = 0.5;
  body.add(
    part(new THREE.BoxGeometry(0.8, 0.3, 0.3), fur, 0, 0.48, 0), part(new THREE.BoxGeometry(0.28, 0.25, 0.26), fur, 0.5, 0.6, 0),
    part(new THREE.BoxGeometry(0.2, 0.11, 0.14), dark, 0.7, 0.55, 0), part(new THREE.BoxGeometry(0.06, 0.12, 0.06), dark, 0.45, 0.78, 0.09),
    part(new THREE.BoxGeometry(0.06, 0.12, 0.06), dark, 0.45, 0.78, -0.09), tail, ...legs,
  );
  const ring = selectionRing();
  group.add(body, ring);
  let phase = 0;
  return {
    group, ring,
    animate(state, time, dt) {
      const moving = state === UnitState.Moving;
      if (moving) phase += dt * 14;
      legs.forEach((l, i) => { l.rotation.z = moving ? Math.sin(phase + (i % 3 ? Math.PI : 0)) * 0.6 : 0; });
      body.rotation.z = state === UnitState.Fighting ? Math.sin(time * 12) * 0.08 : 0;
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
  [StructureKind.Forge]: [0.95, 1.3, 0.95], [StructureKind.GardenPlot]: [0.96, 0.1, 0.96], [StructureKind.Well]: [0.95, 1.5, 0.95],
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
const LEAF = srgb(0.3, 0.42, 0.2), GRAIN = srgb(0.72, 0.6, 0.28), BERRY = srgb(0.42, 0.2, 0.24);
const CROP_GEO = new THREE.ConeGeometry(0.12, 0.4, 5);
const PLOT_GEO = new THREE.BoxGeometry(0.96, 0.1, 0.96).translate(0, 0.05, 0);

export interface StructureView {
  group: THREE.Group;
  setState(progress: number, built: boolean, crop: CropStage, villageOwned: boolean): void;
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
    case StructureKind.Well:
      body.add(part(new THREE.CylinderGeometry(0.44, 0.46, 0.55, 10), solid(ROCK), 0, 0.275, 0));
      body.add(part(new THREE.CylinderGeometry(0.34, 0.34, 0.04, 10), solid(srgb(0.08, 0.12, 0.15)), 0, 0.5, 0, false));
      body.add(box(0.08, 1.3, 0.08, solid(DARK_WOOD), -0.42, 0, 0), box(0.08, 1.3, 0.08, solid(DARK_WOOD), 0.42, 0, 0));
      body.add(box(1.0, 0.08, 0.5, solid(WOOD), 0, 1.3, 0), box(0.14, 0.16, 0.14, solid(WOOD), 0, 0.85, 0));
      break;
    case StructureKind.GardenPlot:
      // One merged-looking bed and four plants: village fields hold dozens of these.
      body.add(part(PLOT_GEO, solid(srgb(0.2, 0.15, 0.11)), 0, 0, 0, false));
      for (let i = 0; i < 4; i++) {
        const plant = part(CROP_GEO, solid(LEAF), (i % 2 ? 0.22 : -0.22), 0.3, (i > 1 ? 0.22 : -0.22), false);
        crops.push(plant);
        body.add(plant);
      }
      break;
  }
  group.add(wire, body);
  return {
    group,
    setState(progress, built, crop, villageOwned) {
      wire.visible = !built;
      body.visible = built || progress > 0;
      body.scale.y = built ? 1 : Math.max(0.04, progress / 100);
      for (const p of crops) {
        p.visible = crop !== CropStage.Empty;
        p.scale.setScalar(crop === CropStage.Sown ? 0.25 : crop === CropStage.Sprout ? 0.6 : 1);
        // Village fields grow grain, which ripens gold; a settler's own plots grow berries.
        p.material = solid(crop === CropStage.Ripe ? (villageOwned ? GRAIN : BERRY) : LEAF);
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

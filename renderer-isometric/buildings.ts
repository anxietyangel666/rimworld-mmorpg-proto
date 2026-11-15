import * as THREE from 'three';
import { BUILDINGS, layoutOf, Piece, type BuildingType, type Layout } from '../game-sim/village';
import { WATER_LEVEL } from '../world-gen/surface';
import { MeshBuilder } from './meshBuilder';

/**
 * Village buildings and roads. A building is drawn from the same floor plan
 * the server uses for its walls and doors: one merged mesh for floor, walls
 * and fittings, appended in build order so construction can be shown piece by
 * piece with a draw range, plus a separate roof that is faded away while the
 * player is inside.
 */

const c = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
const STONE = c(0.42, 0.41, 0.39), PLASTER = c(0.7, 0.64, 0.52), TIMBER = c(0.28, 0.21, 0.15), WOOD = c(0.45, 0.34, 0.22);
const PLANK = c(0.43, 0.33, 0.22), FLAG = c(0.4, 0.39, 0.37), COBBLE = c(0.45, 0.43, 0.4);
const THATCH = c(0.6, 0.5, 0.29), SHINGLE = c(0.33, 0.24, 0.2), IRON = c(0.16, 0.16, 0.17), CLOTH = c(0.5, 0.26, 0.22);
const SACK = c(0.72, 0.65, 0.47), PANE = c(0.95, 0.8, 0.45), FIRE = c(1, 0.5, 0.15), CLAY = c(0.55, 0.36, 0.27), CREAM = c(0.78, 0.74, 0.62);
/** Foundations and floors reach this far below the base, so a building on a slope has no gap under it. */
const FOOT = 0.7;

function emit(mb: MeshBuilder, L: Layout, type: BuildingType, p: Piece, x: number, y: number): void {
  const def = BUILDINGS[type], H = def.wallH, cx = x + 0.5, cz = y + 0.5;
  const is = (px: number, py: number, ...kinds: Piece[]) => L.pieces.some((q) => q.x === px && q.y === py && kinds.includes(q.p));
  const legs = (h: number, inset: number, color: THREE.Color) => {
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) mb.box(cx + dx * inset, 0, cz + dz * inset, 0.08, h, 0.08, color);
  };
  switch (p) {
    case Piece.Floor:
      mb.box(cx, -FOOT, cz, 1, FOOT + 0.05, 1, def.floor === 'plank' ? PLANK : def.floor === 'stone' ? FLAG : COBBLE);
      break;
    case Piece.Wall:
      mb.box(cx, -FOOT, cz, 1, FOOT + 0.45, 1, STONE);
      mb.box(cx, 0.45, cz, 0.94, H - 0.59, 0.94, PLASTER);
      mb.box(cx, H - 0.14, cz, 1, 0.14, 1, TIMBER);
      break;
    case Piece.Window:
      mb.box(cx, -FOOT, cz, 1, FOOT + 0.45, 1, STONE);
      mb.box(cx, 0.45, cz, 0.94, 0.45, 0.94, PLASTER);
      mb.box(cx, 0.9, cz, 1, 0.08, 1, TIMBER);
      mb.box(cx, 0.98, cz, 0.9, 0.5, 0.9, PANE, 1);
      mb.box(cx, 1.48, cz, 1, 0.08, 1, TIMBER);
      mb.box(cx, 1.56, cz, 0.94, H - 1.7, 0.94, PLASTER);
      mb.box(cx, H - 0.14, cz, 1, 0.14, 1, TIMBER);
      break;
    case Piece.Door:
      mb.box(cx, -FOOT, cz, 1, FOOT + 0.04, 1, STONE);
      mb.box(cx - 0.44, 0, cz, 0.12, H, 0.96, TIMBER);
      mb.box(cx + 0.44, 0, cz, 0.12, H, 0.96, TIMBER);
      mb.box(cx, 1.7, cz, 0.8, H - 1.7, 0.94, PLASTER);
      break;
    case Piece.Post:
      mb.box(cx, 0, cz, 0.2, H, 0.2, TIMBER);
      break;
    case Piece.Fence: case Piece.Gate: {
      const alongX = is(x - 1, y, Piece.Fence, Piece.Gate) || is(x + 1, y, Piece.Fence, Piece.Gate);
      const alongZ = is(x, y - 1, Piece.Fence, Piece.Gate) || is(x, y + 1, Piece.Fence, Piece.Gate);
      if (p === Piece.Gate) { mb.box(cx - 0.45, 0, cz, 0.12, 1.1, 0.12, TIMBER); mb.box(cx + 0.45, 0, cz, 0.12, 1.1, 0.12, TIMBER); break; }
      mb.box(cx, 0, cz, 0.12, 0.85, 0.12, TIMBER);
      for (const h of [0.35, 0.65]) {
        if (alongX) mb.box(cx, h, cz, 1, 0.07, 0.06, WOOD);
        if (alongZ) mb.box(cx, h, cz, 0.06, 0.07, 1, WOOD);
      }
      break;
    }
    case Piece.Bed:
      mb.box(cx, 0.05, cz, 0.62, 0.3, 0.94, WOOD);
      mb.box(cx, 0.35, cz + 0.1, 0.58, 0.08, 0.66, CLOTH);
      mb.box(cx, 0.35, cz - 0.32, 0.4, 0.1, 0.2, CREAM);
      break;
    case Piece.Hearth:
      mb.box(cx, 0.05, cz, 0.94, 0.5, 0.94, STONE);
      mb.box(cx, 0.55, cz, 0.44, 0.26, 0.44, FIRE, 1);
      mb.box(cx, 0.95, cz, 0.6, H + 0.9, 0.6, STONE);
      break;
    case Piece.Chest:
      mb.box(cx, 0.05, cz, 0.74, 0.4, 0.5, WOOD);
      mb.box(cx, 0.45, cz, 0.78, 0.1, 0.54, TIMBER);
      mb.box(cx, 0.3, cz + 0.26, 0.1, 0.12, 0.03, IRON);
      break;
    case Piece.Table:
      legs(0.62, 0.36, TIMBER);
      mb.box(cx, 0.62, cz, 0.92, 0.08, 0.92, WOOD);
      mb.box(cx + 0.15, 0.7, cz - 0.1, 0.16, 0.1, 0.16, CLAY);
      break;
    case Piece.Seat:
      mb.box(cx, 0.05, cz, 0.42, 0.34, 0.42, WOOD);
      break;
    case Piece.Forge:
      mb.box(cx, 0.05, cz, 0.96, 0.75, 0.96, STONE);
      mb.box(cx, 0.8, cz, 0.6, 0.08, 0.6, FIRE, 1);
      mb.box(cx, 1.5, cz, 0.8, 0.2, 0.8, IRON);
      mb.box(cx, 1.7, cz, 0.4, H, 0.4, STONE);
      break;
    case Piece.Anvil:
      mb.box(cx, 0.05, cz, 0.36, 0.4, 0.36, TIMBER);
      mb.box(cx, 0.45, cz, 0.24, 0.12, 0.2, IRON);
      mb.box(cx, 0.57, cz, 0.62, 0.16, 0.26, IRON);
      break;
    case Piece.Rack:
      mb.box(cx, 0.05, cz, 0.92, 1.3, 0.14, TIMBER);
      for (let i = 0; i < 3; i++) { mb.box(cx - 0.28 + i * 0.28, 0.5, cz + 0.1, 0.06, 0.7, 0.05, WOOD); mb.box(cx - 0.28 + i * 0.28, 1.1, cz + 0.1, 0.16, 0.14, 0.05, IRON); }
      break;
    case Piece.Sawbench:
      legs(0.5, 0.3, TIMBER);
      mb.box(cx, 0.5, cz, 0.9, 0.1, 0.6, WOOD);
      mb.box(cx, 0.6, cz - 0.1, 0.8, 0.2, 0.2, c(0.36, 0.26, 0.17));
      mb.box(cx + 0.1, 0.6, cz + 0.16, 0.5, 0.26, 0.03, IRON);
      break;
    case Piece.Oven:
      mb.box(cx, 0.05, cz, 0.96, 0.6, 0.96, STONE);
      mb.box(cx, 0.65, cz, 0.86, 0.5, 0.86, CLAY);
      mb.box(cx, 0.72, cz + 0.42, 0.36, 0.26, 0.06, FIRE, 1);
      mb.box(cx, 1.15, cz - 0.2, 0.34, H, 0.34, CLAY);
      break;
    case Piece.Barrel:
      mb.box(cx, 0.05, cz, 0.6, 0.78, 0.6, WOOD);
      mb.box(cx, 0.2, cz, 0.64, 0.06, 0.64, IRON);
      mb.box(cx, 0.62, cz, 0.64, 0.06, 0.64, IRON);
      break;
    case Piece.Crate:
      mb.box(cx, 0.05, cz, 0.74, 0.55, 0.74, WOOD);
      mb.box(cx + 0.08, 0.6, cz - 0.06, 0.5, 0.4, 0.5, c(0.5, 0.39, 0.25));
      break;
    case Piece.Sacks:
      mb.box(cx - 0.18, 0.05, cz, 0.5, 0.38, 0.8, SACK);
      mb.box(cx + 0.24, 0.05, cz + 0.05, 0.42, 0.34, 0.7, c(0.66, 0.59, 0.42));
      mb.box(cx, 0.4, cz, 0.5, 0.3, 0.6, SACK);
      break;
    case Piece.Counter:
      mb.box(cx, 0.05, cz, 0.98, 0.8, 0.6, WOOD);
      mb.box(cx, 0.85, cz, 1, 0.07, 0.7, TIMBER);
      mb.box(cx - 0.2, 0.92, cz, 0.22, 0.14, 0.22, CLAY);
      break;
    case Piece.Scale:
      mb.box(cx, 0.05, cz, 0.5, 0.7, 0.5, WOOD);
      mb.box(cx, 0.75, cz, 0.06, 0.5, 0.06, IRON);
      mb.box(cx, 1.2, cz, 0.7, 0.05, 0.05, IRON);
      mb.box(cx - 0.32, 0.95, cz, 0.22, 0.04, 0.22, IRON);
      mb.box(cx + 0.32, 1.02, cz, 0.22, 0.04, 0.22, IRON);
      break;
    case Piece.Desk:
      legs(0.62, 0.36, TIMBER);
      mb.box(cx, 0.62, cz, 0.92, 0.08, 0.8, WOOD);
      mb.box(cx, 0.7, cz, 0.4, 0.06, 0.3, CREAM);
      mb.box(cx + 0.3, 0.7, cz - 0.2, 0.08, 0.2, 0.08, PANE, 1);
      break;
    case Piece.Board:
      mb.box(cx - 0.4, 0.05, cz, 0.08, 1.5, 0.08, TIMBER);
      mb.box(cx + 0.4, 0.05, cz, 0.08, 1.5, 0.08, TIMBER);
      mb.box(cx, 0.75, cz, 0.9, 0.7, 0.07, WOOD);
      for (const [dx, dy] of [[-0.25, 1.1], [0.05, 1.0], [0.28, 1.15], [-0.1, 0.82]]) mb.box(cx + dx, dy, cz + 0.045, 0.18, 0.2, 0.02, CREAM);
      break;
    case Piece.Stall:
      mb.box(cx, 0.05, cz, 0.98, 0.75, 0.7, WOOD);
      mb.box(cx - 0.2, 0.8, cz, 0.3, 0.16, 0.3, SACK);
      mb.box(cx + 0.22, 0.8, cz + 0.05, 0.26, 0.12, 0.26, x % 2 ? c(0.5, 0.2, 0.2) : c(0.62, 0.5, 0.22));
      for (const dz of [-0.42, 0.42]) mb.box(cx - 0.45, 0.8, cz + dz, 0.06, 1.0, 0.06, TIMBER);
      mb.box(cx, 1.8, cz, 1.02, 0.07, 1.1, x % 2 ? CLOTH : CREAM);
      break;
  }
}

export interface BuildingView {
  group: THREE.Group;
  body: THREE.Mesh;
  roof: THREE.Mesh | null;
  /** 1 shown .. 0 hidden; eased by the scene. */
  fade: { value: number };
  layout: Layout;
  type: BuildingType;
  built: boolean;
  setProgress(progress: number, built: boolean): void;
}

/** A gabled roof over a w x h footprint, ridge along the long (x) axis, with overhanging eaves. */
function roofGeometry(L: Layout, type: BuildingType): THREE.BufferGeometry {
  const def = BUILDINGS[type], mb = new MeshBuilder();
  const color = def.roof === 'thatch' ? THATCH : SHINGLE, under = color.clone().multiplyScalar(0.6);
  const x0 = -0.4, x1 = L.w + 0.4, z0 = -0.4, z1 = L.h + 0.4, zm = L.h / 2, e = def.wallH - 0.08, r = def.wallH + 0.34 * L.h;
  // Each slope in courses, alternately shaded, so it reads as rows of thatch or shingle.
  const courses = Math.max(3, Math.round(L.h * 0.9));
  for (let i = 0; i < courses; i++) {
    const a = i / courses, b = (i + 1) / courses, tone = i % 2 ? color : color.clone().multiplyScalar(0.88);
    const za = z1 + (zm - z1) * a, zb = z1 + (zm - z1) * b, ya = e + (r - e) * a, yb = e + (r - e) * b;
    mb.quad([x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb], tone);
    const na = z0 + (zm - z0) * a, nb = z0 + (zm - z0) * b;
    mb.quad([x1, ya, na], [x0, ya, na], [x0, yb, nb], [x1, yb, nb], tone);
  }
  // Gable ends close the triangle between wall top and ridge.
  mb.tri([0, e, L.h], [0, e, 0], [0, r, zm], PLASTER);
  mb.tri([L.w, e, 0], [L.w, e, L.h], [L.w, r, zm], PLASTER);
  mb.box(L.w / 2, r - 0.06, zm, x1 - x0, 0.12, 0.16, under);
  return mb.build();
}

export function makeBuilding(type: BuildingType, flip: boolean, wallMat: THREE.Material, roofMat: (fade: { value: number }) => THREE.Material): BuildingView {
  const L = layoutOf(type, flip), mb = new MeshBuilder();
  for (const p of L.pieces) { emit(mb, L, type, p.p, p.x, p.y); mb.mark(); }
  const geo = mb.build();
  const body = new THREE.Mesh(geo, wallMat);
  body.castShadow = body.receiveShadow = true;
  body.frustumCulled = false;
  const group = new THREE.Group();
  group.add(body);
  const fade = { value: 1 };
  let roof: THREE.Mesh | null = null;
  if (BUILDINGS[type].roof !== 'none') {
    roof = new THREE.Mesh(roofGeometry(L, type), roofMat(fade));
    roof.castShadow = true;
    roof.frustumCulled = false;
    group.add(roof);
  }
  const view: BuildingView = {
    group, body, roof, fade, layout: L, type, built: false,
    setProgress(progress, built) {
      view.built = built;
      // Floors first, then walls, then fittings; the roof goes on last.
      const shown = built ? mb.marks.length : Math.floor((Math.min(progress, 92) / 92) * mb.marks.length);
      geo.setDrawRange(0, shown === 0 ? 0 : mb.marks[shown - 1]);
      if (roof) roof.visible = built || progress >= 93;
    },
  };
  return view;
}

/**
 * A stretch of road: one quad per tile it covers, draped over the terrain.
 * `pts` are render-space points; trails are one tile wide, streets two. Where
 * the route crosses water it becomes a plank causeway at the surface.
 */
export function buildRoad(pts: number[], wide: boolean, material: THREE.Material, vertexHeight: (x: number, y: number) => number, isWater: (x: number, y: number) => boolean): { mesh: THREE.Mesh; tiles: [number, number][] } {
  const tiles = new Map<string, [number, number]>();
  const touch = (tx: number, ty: number) => tiles.set(tx + ',' + ty, [tx, ty]);
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const dx = pts[i + 2] - pts[i], dy = pts[i + 3] - pts[i + 1], steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) * 4));
    for (let s = 0; s <= steps; s++) {
      const x = pts[i] + (dx * s) / steps, y = pts[i + 1] + (dy * s) / steps;
      if (!wide) { touch(Math.floor(x), Math.floor(y)); continue; }
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const tx = Math.floor(x) + ox, ty = Math.floor(y) + oy;
        if (Math.hypot(tx + 0.5 - x, ty + 0.5 - y) <= 0.8) touch(tx, ty);
      }
    }
  }
  const mb = new MeshBuilder();
  const dirt = c(0.37, 0.3, 0.22), cobble = c(0.43, 0.41, 0.38), plank = c(0.42, 0.32, 0.21);
  for (const [tx, ty] of tiles.values()) {
    if (isWater(tx, ty)) {
      const y = WATER_LEVEL + 0.07;
      mb.quad([tx, y, ty + 1], [tx + 1, y, ty + 1], [tx + 1, y, ty], [tx, y, ty], plank);
      continue;
    }
    const lift = 0.035;
    // Alternate tiles a shade apart so a street reads as laid stone rather than a flat band.
    const tone = (wide ? cobble : dirt).clone().multiplyScalar((tx + ty) % 2 ? 1 : 0.9);
    mb.quad([tx, vertexHeight(tx, ty + 1) + lift, ty + 1], [tx + 1, vertexHeight(tx + 1, ty + 1) + lift, ty + 1],
      [tx + 1, vertexHeight(tx + 1, ty) + lift, ty], [tx, vertexHeight(tx, ty) + lift, ty], tone);
  }
  const mesh = new THREE.Mesh(mb.build(), material);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return { mesh, tiles: [...tiles.values()] };
}

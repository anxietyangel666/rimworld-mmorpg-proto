import { hash01 } from '../core-ecs/rng';
import { Biome, classifyBiome, sampleClimate, SECTOR_COLS, SECTOR_ROWS, uvToDir, type Climate } from './planet';

/**
 * The walkable surface of the home planet: one continuous tile grid that wraps
 * on both axes, so walking far enough in any direction returns you to where you
 * started. It is the planet's equirectangular map unrolled — tile x is
 * longitude, tile y is latitude — and each orbital sector is a 32x32 tile
 * block of it.
 *
 * Terrain is a pure function of (seed, tile), generated a chunk at a time on
 * demand. Nothing here is ever sent over the wire: server and clients derive
 * identical chunks.
 */

export const SECTOR_TILES = 32;
export const WORLD_W = SECTOR_COLS * SECTOR_TILES;
export const WORLD_H = SECTOR_ROWS * SECTOR_TILES;
export const CHUNK_SIZE = 16;
export const CHUNKS_X = WORLD_W / CHUNK_SIZE;
export const CHUNKS_Y = WORLD_H / CHUNK_SIZE;

export const wrapX = (x: number) => ((x % WORLD_W) + WORLD_W) % WORLD_W;
export const wrapY = (y: number) => ((y % WORLD_H) + WORLD_H) % WORLD_H;

/** Shortest signed distance along a wrapping axis. */
function wrapDelta(d: number, size: number): number {
  d = ((d % size) + size) % size;
  return d > size / 2 ? d - size : d;
}
export const wrapDX = (d: number) => wrapDelta(d, WORLD_W);
export const wrapDY = (d: number) => wrapDelta(d, WORLD_H);

/** Straight-line distance the short way around the world. */
export function wrapDist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(wrapDX(bx - ax), wrapDY(by - ay));
}

export function tileIndex(tx: number, ty: number): number {
  return wrapX(Math.floor(tx)) + wrapY(Math.floor(ty)) * WORLD_W;
}

export function sectorOfTile(x: number, y: number): number {
  return Math.floor(wrapX(x) / SECTOR_TILES) + Math.floor(wrapY(y) / SECTOR_TILES) * SECTOR_COLS;
}

export enum TileType { Dirt, Grass, Sand, Rock, Snow, Water, Gravel, Steppe, RedEarth }
export enum NodeKind { Tree, Stone, Ore, Clay, Bush, Reeds }

export interface PropSpawn { x: number; y: number; scale: number; rot: number }
export interface NodeSpawn { kind: NodeKind; x: number; y: number }

export interface ChunkData {
  cx: number;
  cy: number;
  /** CHUNK_SIZE^2 tile types and biomes. */
  tiles: Uint8Array;
  biomes: Uint8Array;
  /** (CHUNK_SIZE + 1)^2 vertex heights. */
  heights: Float32Array;
  /** 1 where the terrain itself is impassable (boulders). Water is wadeable, not blocked. */
  blocked: Uint8Array;
  boulders: PropSpawn[];
  nodes: NodeSpawn[];
}

// --- periodic noise -----------------------------------------------------------

function lattice(xi: number, yi: number, seed: number): number {
  let h = Math.imul(xi, 374761393) ^ Math.imul(yi, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise in [-1, 1] whose lattice repeats every (px, py) cells. */
function pnoise(x: number, y: number, px: number, py: number, seed: number): number {
  const xf0 = Math.floor(x), yf0 = Math.floor(y);
  const xf = x - xf0, yf = y - yf0;
  const x0 = ((xf0 % px) + px) % px, y0 = ((yf0 % py) + py) % py;
  const x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const a = lattice(x0, y0, seed), b = lattice(x1, y0, seed), c = lattice(x0, y1, seed), d = lattice(x1, y1, seed);
  return (a + (b - a) * u + (c + (d - c) * u - a - (b - a) * u) * v) * 2 - 1;
}

/**
 * Fractal noise that tiles exactly across the world. `cells` is the number of
 * base lattice cells around the equator, so a feature is WORLD_W / cells tiles wide.
 */
export function pfbm(x: number, y: number, cells: number, octaves: number, seed: number): number {
  let fx = cells, fy = cells / 2, amp = 0.5, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += pnoise((x / WORLD_W) * fx, (y / WORLD_H) * fy, fx, fy, seed + o * 101) * amp;
    norm += amp;
    amp *= 0.5; fx *= 2; fy *= 2;
  }
  return sum / norm;
}

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// --- climate ------------------------------------------------------------------

const CLIMATE_STEP = 4;
const LW = WORLD_W / CLIMATE_STEP, LH = WORLD_H / CLIMATE_STEP;

/**
 * Planet climate resampled onto a coarse tile lattice and interpolated. The
 * poles are forced to the same frozen plateau so the north edge of the map
 * joins the south edge without a seam.
 */
class ClimateField {
  private readonly data = new Float32Array(LW * LH * 3).fill(NaN);

  constructor(private readonly seed: number) {}

  private node(gx: number, gy: number): number {
    const o = (gx + gy * LW) * 3;
    if (Number.isNaN(this.data[o])) {
      const v = (gy * CLIMATE_STEP) / WORLD_H;
      const c = sampleClimate(this.seed, ...uvToDir((gx * CLIMATE_STEP) / WORLD_W, v));
      const polar = smooth(0.84, 0.95, Math.abs(v * 2 - 1));
      this.data[o] = c.elevation + (0.12 - c.elevation) * polar;
      this.data[o + 1] = c.moisture + (0.5 - c.moisture) * polar;
      this.data[o + 2] = c.temperature * (1 - polar);
    }
    return o;
  }

  at(x: number, y: number, out: Climate): Climate {
    const gx = wrapX(x) / CLIMATE_STEP, gy = wrapY(y) / CLIMATE_STEP;
    const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    const x1 = (x0 + 1) % LW, y1 = (y0 + 1) % LH;
    const a = this.node(x0, y0), b = this.node(x1, y0), c = this.node(x0, y1), d = this.node(x1, y1);
    const D = this.data;
    const mix = (k: number) => {
      const top = D[a + k] + (D[b + k] - D[a + k]) * fx, bottom = D[c + k] + (D[d + k] - D[c + k]) * fx;
      return top + (bottom - top) * fy;
    };
    out.elevation = mix(0); out.moisture = mix(1); out.temperature = mix(2);
    return out;
  }
}

/** [tree, stone, ore, clay, bush, reeds] chance per tile, before local modifiers. */
const NODE_DENSITY: Record<Biome, number[]> = {
  [Biome.Ocean]: [0.004, 0.006, 0, 0.004, 0.004, 0.01],
  [Biome.Ice]: [0, 0.006, 0.002, 0, 0, 0],
  [Biome.Tundra]: [0.02, 0.014, 0.006, 0.002, 0.008, 0.004],
  [Biome.Forest]: [0.15, 0.01, 0.004, 0.004, 0.022, 0.008],
  [Biome.Grassland]: [0.035, 0.01, 0.004, 0.004, 0.022, 0.016],
  [Biome.Desert]: [0.006, 0.016, 0.006, 0.002, 0.005, 0.002],
  [Biome.Badlands]: [0.008, 0.022, 0.012, 0.003, 0.005, 0.002],
};

const BIOME_TILES: Record<Biome, [TileType, TileType]> = {
  [Biome.Ocean]: [TileType.Sand, TileType.Sand],
  [Biome.Ice]: [TileType.Snow, TileType.Snow],
  [Biome.Tundra]: [TileType.Snow, TileType.Gravel],
  [Biome.Forest]: [TileType.Grass, TileType.Dirt],
  [Biome.Grassland]: [TileType.Steppe, TileType.Grass],
  [Biome.Desert]: [TileType.Sand, TileType.Gravel],
  [Biome.Badlands]: [TileType.RedEarth, TileType.Gravel],
};

/**
 * Chunk generator and cache for one world seed. The server keeps every chunk
 * it has touched; clients pass `maxChunks` so terrain far behind the player is
 * dropped and regenerated if they ever come back.
 */
export class Surface {
  private readonly cache = new Map<number, ChunkData>();
  private readonly field: ClimateField;
  private readonly c: Climate = { elevation: 0, moisture: 0, temperature: 0 };

  constructor(readonly seed: number, private readonly maxChunks = Infinity) {
    this.field = new ClimateField(seed);
  }

  /** Climate at a tile position; the returned object is reused between calls. */
  climate(x: number, y: number): Climate {
    return this.field.at(x, y, this.c);
  }

  /**
   * Signed "landness": negative under water, rising to ~1 on dry ground. Seas
   * come from planetary elevation, lakes from a local basin field in wet
   * climates; frozen regions are solid ice.
   */
  private land(x: number, y: number, c: Climate): number {
    const sea = c.elevation * 26 + pfbm(x, y, 128, 2, this.seed + 12) * 0.35;
    const lake = (pfbm(x, y, 32, 3, this.seed + 11) + 0.52 - c.moisture * 0.26) * 7;
    const v = Math.min(sea, lake);
    const frozen = smooth(0.18, 0.13, c.temperature);
    return v + (Math.max(v, 1) - v) * frozen;
  }

  private heightRaw(x: number, y: number): number {
    const c = this.field.at(x, y, this.c);
    const land = this.land(x, y, c);
    const amp = 0.5 + Math.min(1, Math.max(0, c.elevation)) * 2.4;
    const h = (pfbm(x, y, 32, 4, this.seed + 1) * 0.5 + 0.5) * amp + pfbm(x, y, 256, 2, this.seed + 2) * 0.1;
    return h * smooth(0, 0.9, land) - 0.5 * (1 - smooth(-0.7, 0.1, land));
  }

  chunk(cx: number, cy: number): ChunkData {
    cx = ((cx % CHUNKS_X) + CHUNKS_X) % CHUNKS_X;
    cy = ((cy % CHUNKS_Y) + CHUNKS_Y) % CHUNKS_Y;
    const key = cx + cy * CHUNKS_X;
    let data = this.cache.get(key);
    if (data) {
      if (this.maxChunks !== Infinity) { this.cache.delete(key); this.cache.set(key, data); }
      return data;
    }
    data = this.generate(cx, cy);
    this.cache.set(key, data);
    if (this.cache.size > this.maxChunks) this.cache.delete(this.cache.keys().next().value!);
    return data;
  }

  private generate(cx: number, cy: number): ChunkData {
    const n = CHUNK_SIZE, s = this.seed;
    const tiles = new Uint8Array(n * n), biomes = new Uint8Array(n * n), blocked = new Uint8Array(n * n);
    const heights = new Float32Array((n + 1) * (n + 1));
    const boulders: PropSpawn[] = [], nodes: NodeSpawn[] = [];
    const ox = cx * n, oy = cy * n;
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) heights[i + j * (n + 1)] = this.heightRaw(ox + i, oy + j);

    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const tx = ox + i, ty = oy + j, x = tx + 0.5, y = ty + 0.5, k = i + j * n;
      const c = this.field.at(x, y, this.c);
      const land = this.land(x, y, c);
      // Jitter the climate a little so biome borders wander instead of following lattice lines.
      c.moisture += pfbm(x, y, 128, 2, s + 21) * 0.05;
      c.temperature += pfbm(x, y, 128, 2, s + 22) * 0.03;
      const biome = classifyBiome(c);
      biomes[k] = biome;
      if (land < 0) { tiles[k] = TileType.Water; continue; }
      const rocky = Math.abs(pfbm(x, y, 64, 3, s + 3));
      const patch = pfbm(x, y, 64, 3, s + 4);
      const [base, alt] = BIOME_TILES[biome];
      const snowy = base === TileType.Snow;
      tiles[k] = rocky < 0.035 && biome !== Biome.Ice ? TileType.Rock : patch > 0.1 ? alt : base;
      const shore = land < 0.45;
      if (shore && !snowy) tiles[k] = TileType.Sand;

      const r = hash01(s, tx, ty);
      if (r < 0.006 + (rocky < 0.06 ? 0.05 : 0) && !shore) {
        blocked[k] = 1;
        boulders.push({ x: i + 0.5, y: j + 0.5, scale: 0.6 + hash01(s, tx, ty, 1) * 0.9, rot: hash01(s, tx, ty, 2) * 6.28 });
        continue;
      }
      // One roll picks at most one resource node per tile from stacked probability bands.
      const d = NODE_DENSITY[biome];
      const grove = smooth(-0.15, 0.3, pfbm(x, y, 64, 3, s + 5));
      const wet = shore ? 6 : 1;
      const weights = [
        shore ? 0 : d[0] * (0.08 + grove * 1.5), d[1] * (rocky < 0.1 ? 4 : 1), d[2] * (rocky < 0.08 ? 8 : 0.5),
        d[3] * wet, shore ? 0 : d[4] * (0.4 + grove), d[5] * wet,
      ];
      let roll = hash01(s, tx, ty, 3);
      for (let kind = 0; kind < weights.length; kind++) {
        if (roll < weights[kind]) { nodes.push({ kind, x: tx + 0.5, y: ty + 0.5 }); break; }
        roll -= weights[kind];
      }
    }
    return { cx, cy, tiles, biomes, heights, blocked, boulders, nodes };
  }

  private cell(tx: number, ty: number): [ChunkData, number] {
    tx = wrapX(Math.floor(tx)); ty = wrapY(Math.floor(ty));
    const data = this.chunk(Math.floor(tx / CHUNK_SIZE), Math.floor(ty / CHUNK_SIZE));
    return [data, (tx % CHUNK_SIZE) + (ty % CHUNK_SIZE) * CHUNK_SIZE];
  }

  tile(tx: number, ty: number): TileType {
    const [d, k] = this.cell(tx, ty);
    return d.tiles[k];
  }

  biome(tx: number, ty: number): Biome {
    const [d, k] = this.cell(tx, ty);
    return d.biomes[k];
  }

  isWater(tx: number, ty: number): boolean {
    return this.tile(tx, ty) === TileType.Water;
  }

  terrainBlocked(tx: number, ty: number): boolean {
    const [d, k] = this.cell(tx, ty);
    return d.blocked[k] === 1;
  }

  /** Height of the vertex at integer tile corner (vx, vy). */
  vertexHeight(vx: number, vy: number): number {
    vx = wrapX(vx); vy = wrapY(vy);
    const d = this.chunk(Math.floor(vx / CHUNK_SIZE), Math.floor(vy / CHUNK_SIZE));
    return d.heights[(vx % CHUNK_SIZE) + (vy % CHUNK_SIZE) * (CHUNK_SIZE + 1)];
  }

  /** Bilinear terrain height at any world position. */
  height(x: number, y: number): number {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const a = this.vertexHeight(xi, yi), b = this.vertexHeight(xi + 1, yi);
    const c = this.vertexHeight(xi, yi + 1), d = this.vertexHeight(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  /** Air temperature in degrees C at a tile, from planetary climate. */
  ambientC(x: number, y: number): number {
    return this.field.at(x, y, this.c).temperature * 48 - 18;
  }
}

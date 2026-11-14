import { hash01, hashInts } from '../core-ecs/rng';
import { fbm3, ridged3 } from './noise';
import { Biome, BIOME_RESOURCES } from './planet';

/**
 * Surface generation for one planetary sector: a square tile map with a smooth
 * heightfield, static obstacles and the initial resource nodes. It is a pure
 * function of (world seed, sector id, biome), so the server never ships
 * terrain — clients rebuild the identical map locally.
 */

export const SECTOR_SIZE = 128;
export const CHUNK_SIZE = 16;

export enum TileType { Dirt, Grass, Sand, Rock, Snow, Water, Gravel }
export enum NodeKind { Tree, Ore, Scrap }

export interface PropSpawn { x: number; y: number; scale: number; rot: number }
export interface NodeSpawn { kind: NodeKind; x: number; y: number; amount: number }

export interface SectorTerrain {
  size: number;
  biome: Biome;
  tiles: Uint8Array;
  /** Vertex heights, (size + 1)^2, world units. */
  heights: Float32Array;
  /** 1 where terrain itself is impassable (water, boulders). */
  blocked: Uint8Array;
  boulders: PropSpawn[];
  nodes: NodeSpawn[];
}

interface BiomeParams {
  base: TileType;
  alt: TileType;
  /** Tiles below this noise level flood; -2 disables water. */
  water: number;
  heightAmp: number;
  boulders: number;
}

const PARAMS: Record<Biome, BiomeParams> = {
  [Biome.Ocean]: { base: TileType.Sand, alt: TileType.Sand, water: 0.2, heightAmp: 0.4, boulders: 0 },
  [Biome.Ice]: { base: TileType.Snow, alt: TileType.Snow, water: -2, heightAmp: 0.8, boulders: 0.02 },
  [Biome.Tundra]: { base: TileType.Snow, alt: TileType.Gravel, water: -0.42, heightAmp: 1.0, boulders: 0.05 },
  [Biome.Forest]: { base: TileType.Grass, alt: TileType.Dirt, water: -0.36, heightAmp: 1.3, boulders: 0.03 },
  [Biome.Grassland]: { base: TileType.Grass, alt: TileType.Dirt, water: -0.42, heightAmp: 1.0, boulders: 0.03 },
  [Biome.Desert]: { base: TileType.Sand, alt: TileType.Gravel, water: -2, heightAmp: 1.5, boulders: 0.05 },
  [Biome.Badlands]: { base: TileType.Dirt, alt: TileType.Gravel, water: -2, heightAmp: 1.8, boulders: 0.09 },
};

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function generateSector(seed: number, sectorId: number, biome: Biome): SectorTerrain {
  const s = hashInts(seed, sectorId, 0x5ec7) | 0;
  const p = PARAMS[biome];
  const size = SECTOR_SIZE;
  const tiles = new Uint8Array(size * size);
  const blocked = new Uint8Array(size * size);
  const heights = new Float32Array((size + 1) * (size + 1));
  const boulders: PropSpawn[] = [];
  const nodes: NodeSpawn[] = [];
  const [woodRich, oreRich, scrapRich] = BIOME_RESOURCES[biome];

  // Basin noise decides where water pools; sampled per vertex so shorelines
  // slope into the water instead of stepping.
  const basin = (x: number, y: number) => fbm3(x / 44, y / 44, 0.5, 4, s);

  for (let y = 0; y <= size; y++) for (let x = 0; x <= size; x++) {
    const b = basin(x, y);
    let h = (fbm3(x / 36, y / 36, 9.5, 4, s + 1) * 0.5 + 0.5) * p.heightAmp + fbm3(x / 6, y / 6, 3.3, 2, s + 2) * 0.12;
    if (p.water > -2) h = h * smooth(p.water, p.water + 0.16, b) - 0.55 * (1 - smooth(p.water - 0.08, p.water + 0.03, b));
    heights[x + y * (size + 1)] = h;
  }

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = x + y * size;
    const cx = x + 0.5, cy = y + 0.5;
    const rock = ridged3(cx / 30, cy / 30, 1.5, 3, s + 3);
    const patch = fbm3(cx / 18, cy / 18, 6.5, 3, s + 4);
    if (basin(cx, cy) < p.water) {
      tiles[i] = TileType.Water;
      blocked[i] = 1;
      continue;
    }
    tiles[i] = rock > 0.74 ? TileType.Rock : patch > 0.08 ? p.alt : p.base;
    const shore = p.water > -2 && basin(cx, cy) < p.water + 0.06;
    if (shore) { tiles[i] = TileType.Sand; continue; }

    const r = hash01(s, x, y);
    if (rock > 0.7 && r < p.boulders * 3 || r < p.boulders * 0.15) {
      blocked[i] = 1;
      boulders.push({ x: cx, y: cy, scale: 0.6 + hash01(s, x, y, 1) * 0.9, rot: hash01(s, x, y, 2) * 6.28 });
      continue;
    }
    // Trees clump along a low-frequency density field; ore follows rock
    // outcrops; scrap gathers in a few tight wreck fields.
    const grove = smooth(-0.1, 0.35, fbm3(cx / 22, cy / 22, 12.5, 3, s + 5));
    const wreck = smooth(0.3, 0.5, fbm3(cx / 12, cy / 12, 20.5, 2, s + 6));
    const r2 = hash01(s, x, y, 3);
    if (tiles[i] !== TileType.Rock && r2 < woodRich * (0.012 + grove * 0.2)) {
      nodes.push({ kind: NodeKind.Tree, x: cx, y: cy, amount: 20 });
    } else if (r2 > 0.5 && r2 < 0.5 + oreRich * (0.004 + smooth(0.6, 0.8, rock) * 0.16)) {
      nodes.push({ kind: NodeKind.Ore, x: cx, y: cy, amount: 30 });
    } else if (r2 > 0.9 && r2 < 0.9 + scrapRich * (0.002 + wreck * 0.09)) {
      nodes.push({ kind: NodeKind.Scrap, x: cx, y: cy, amount: 15 });
    }
  }
  return { size, biome, tiles, heights, blocked, boulders, nodes };
}

/** Bilinear terrain height at a world position (tile units). */
export function heightAt(t: SectorTerrain, x: number, y: number): number {
  const n = t.size;
  x = Math.min(n - 1e-4, Math.max(0, x));
  y = Math.min(n - 1e-4, Math.max(0, y));
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const w = n + 1, h = t.heights;
  const a = h[xi + yi * w], b = h[xi + 1 + yi * w], c = h[xi + (yi + 1) * w], d = h[xi + 1 + (yi + 1) * w];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

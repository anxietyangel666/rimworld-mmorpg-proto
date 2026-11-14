import { fbm3, ridged3 } from './noise';

/**
 * The shared home planet. Climate is a pure function of (seed, direction on the
 * unit sphere); the sector grid, the baked maps the orbit shader samples, and
 * the surface generator all read from it, so what you see from orbit is what
 * you land on.
 */

/** Sectors are latitude/longitude quads: 32 around the equator, 16 pole to pole. */
export const SECTOR_COLS = 32;
export const SECTOR_ROWS = 16;
export const SECTOR_COUNT = SECTOR_COLS * SECTOR_ROWS;

export enum Biome { Ocean, Ice, Tundra, Forest, Grassland, Desert, Badlands }

export const BIOME_NAMES: Record<Biome, string> = {
  [Biome.Ocean]: 'Open Ocean',
  [Biome.Ice]: 'Ice Sheet',
  [Biome.Tundra]: 'Tundra',
  [Biome.Forest]: 'Boreal Forest',
  [Biome.Grassland]: 'Steppe',
  [Biome.Desert]: 'Arid Desert',
  [Biome.Badlands]: 'Badlands',
};

export interface Climate {
  /** Height relative to sea level, -1..1. */
  elevation: number;
  /** 0 dry .. 1 wet. */
  moisture: number;
  /** 0 frozen .. 1 hot. */
  temperature: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function sampleClimate(seed: number, x: number, y: number, z: number): Climate {
  const continents = fbm3(x * 1.25 + 11.3, y * 1.25 + 4.1, z * 1.25 - 7.7, 6, seed);
  const mountains = ridged3(x * 2.6, y * 2.6, z * 2.6, 4, seed + 911);
  let elevation = continents * 2.4 + 0.03;
  if (elevation > 0) elevation += (mountains - 0.45) * 0.55 * Math.min(1, elevation * 4);
  elevation = clamp(elevation, -1, 1);
  const moisture = clamp(0.5 + fbm3(x * 2.1 + 31.7, y * 2.1, z * 2.1 + 3.3, 4, seed + 77) * 1.5, 0, 1);
  const temperature = clamp(
    1.1 - y * y - Math.max(elevation, 0) * 0.3 + fbm3(x * 3, y * 3, z * 3, 3, seed + 177) * 0.25,
    0, 1,
  );
  return { elevation, moisture, temperature };
}

/** Must stay in step with the biome ramp in renderer-orbit's planet shader. */
export function classifyBiome(c: Climate): Biome {
  if (c.temperature < 0.14) return Biome.Ice;
  if (c.elevation < 0) return Biome.Ocean;
  if (c.temperature < 0.3) return Biome.Tundra;
  if (c.elevation > 0.5) return Biome.Badlands;
  if (c.moisture < 0.36) return c.temperature > 0.5 ? Biome.Desert : Biome.Badlands;
  if (c.moisture > 0.56) return Biome.Forest;
  return Biome.Grassland;
}

/** Equirectangular UV of a unit direction. The GLSL side uses the same mapping. */
export function dirToUv(x: number, y: number, z: number): [number, number] {
  return [Math.atan2(z, x) / (2 * Math.PI) + 0.5, Math.asin(clamp(y, -1, 1)) / Math.PI + 0.5];
}

export function uvToDir(u: number, v: number): [number, number, number] {
  const lon = (u - 0.5) * 2 * Math.PI, lat = (v - 0.5) * Math.PI;
  const c = Math.cos(lat);
  return [Math.cos(lon) * c, Math.sin(lat), Math.sin(lon) * c];
}

export function sectorFromDir(x: number, y: number, z: number): number {
  const [u, v] = dirToUv(x, y, z);
  const col = Math.min(SECTOR_COLS - 1, Math.floor(u * SECTOR_COLS));
  const row = Math.min(SECTOR_ROWS - 1, Math.floor(v * SECTOR_ROWS));
  return col + row * SECTOR_COLS;
}

export function sectorCenterDir(id: number): [number, number, number] {
  const col = id % SECTOR_COLS, row = Math.floor(id / SECTOR_COLS);
  return uvToDir((col + 0.5) / SECTOR_COLS, (row + 0.5) / SECTOR_ROWS);
}

export interface SectorInfo {
  id: number;
  name: string;
  biome: Biome;
  /** Oceans and ice sheets cannot host a colony. */
  landable: boolean;
  /** Resource richness, 0..100. */
  wood: number;
  ore: number;
  scrap: number;
  /** Mean climate, for the orbital readout. */
  temperatureC: number;
}

/** Relative richness of [wood, ore, scrap] per biome; the surface generator scales node density by it. */
export const BIOME_RESOURCES: Record<Biome, [number, number, number]> = {
  [Biome.Ocean]: [0, 0, 0],
  [Biome.Ice]: [0, 0.2, 0.1],
  [Biome.Tundra]: [0.3, 0.5, 0.35],
  [Biome.Forest]: [1, 0.3, 0.2],
  [Biome.Grassland]: [0.55, 0.4, 0.4],
  [Biome.Desert]: [0.12, 0.55, 0.9],
  [Biome.Badlands]: [0.15, 1, 0.55],
};

const infoCache = new Map<string, SectorInfo>();

export function sectorInfo(seed: number, id: number): SectorInfo {
  const key = seed + ':' + id;
  const hit = infoCache.get(key);
  if (hit) return hit;
  const col = id % SECTOR_COLS, row = Math.floor(id / SECTOR_COLS);
  // Majority vote over a 3x3 lattice inside the quad, so a sector is named for
  // what most of it looks like from orbit rather than for its exact centre.
  const votes = new Array<number>(7).fill(0);
  let temp = 0, rich = 0;
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    const [x, y, z] = uvToDir((col + (i + 0.5) / 3) / SECTOR_COLS, (row + (j + 0.5) / 3) / SECTOR_ROWS);
    const c = sampleClimate(seed, x, y, z);
    votes[classifyBiome(c)]++;
    temp += c.temperature;
    rich += fbm3(x * 5, y * 5, z * 5, 2, seed + 4242);
  }
  let biome = Biome.Ocean;
  for (let b = 0; b < votes.length; b++) if (votes[b] > votes[biome]) biome = b as Biome;
  const [w, o, s] = BIOME_RESOURCES[biome];
  const vary = 0.75 + (rich / 9) * 0.6;
  const pct = (v: number) => Math.round(clamp(v * vary, 0, 1) * 100);
  const info: SectorInfo = {
    id,
    name: String.fromCharCode(65 + row) + '-' + String(col + 1).padStart(2, '0'),
    biome,
    landable: biome !== Biome.Ocean && biome !== Biome.Ice,
    wood: pct(w), ore: pct(o), scrap: pct(s),
    temperatureC: Math.round((temp / 9) * 70 - 35),
  };
  infoCache.set(key, info);
  return info;
}

/**
 * Bake climate into an equirectangular RGBA8 map for the orbit shader:
 * R = elevation (-1..1 mapped to 0..255), G = moisture, B = temperature.
 */
export function bakePlanetMaps(seed: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const [x, y, z] = uvToDir((i + 0.5) / width, (j + 0.5) / height);
      const c = sampleClimate(seed, x, y, z);
      const o = (i + j * width) * 4;
      out[o] = Math.round((c.elevation * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round(c.moisture * 255);
      out[o + 2] = Math.round(c.temperature * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

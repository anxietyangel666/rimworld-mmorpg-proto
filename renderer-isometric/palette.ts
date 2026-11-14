import * as THREE from 'three';
import { Biome } from '../world-gen/planet';
import { TileType } from '../world-gen/sector';

/** Muted, desaturated look per biome: surface colours, light and haze. */
export interface Palette {
  /** Indexed by TileType. */
  tiles: THREE.Color[];
  canopy: THREE.Color;
  trunk: THREE.Color;
  boulder: THREE.Color;
  /** Pines where true, bare dead trees otherwise. */
  leafy: boolean;
  haze: THREE.Color;
  hazeAmount: number;
  sun: THREE.Color;
  sunIntensity: number;
  sky: THREE.Color;
  bounce: THREE.Color;
  /** Final grade. */
  tint: THREE.Color;
  desaturate: number;
}

const c = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

function base(): Palette {
  const tiles: THREE.Color[] = [];
  tiles[TileType.Dirt] = c(0.36, 0.31, 0.24);
  tiles[TileType.Grass] = c(0.31, 0.35, 0.22);
  tiles[TileType.Sand] = c(0.58, 0.52, 0.4);
  tiles[TileType.Rock] = c(0.4, 0.39, 0.37);
  tiles[TileType.Snow] = c(0.8, 0.82, 0.84);
  tiles[TileType.Water] = c(0.2, 0.25, 0.25);
  tiles[TileType.Gravel] = c(0.45, 0.43, 0.39);
  return {
    tiles, canopy: c(0.19, 0.27, 0.16), trunk: c(0.3, 0.24, 0.18), boulder: c(0.42, 0.41, 0.39), leafy: true,
    haze: c(0.66, 0.69, 0.66), hazeAmount: 0.5, sun: c(1.0, 0.93, 0.82), sunIntensity: 3.0,
    sky: c(0.62, 0.7, 0.8), bounce: c(0.3, 0.27, 0.22), tint: new THREE.Color(1, 1, 1), desaturate: 0.32,
  };
}

export function paletteFor(biome: Biome): Palette {
  const p = base();
  switch (biome) {
    case Biome.Grassland:
      p.tiles[TileType.Grass] = c(0.42, 0.41, 0.25);
      p.tiles[TileType.Dirt] = c(0.43, 0.36, 0.26);
      p.canopy = c(0.27, 0.31, 0.17);
      p.haze = c(0.74, 0.71, 0.6);
      p.tint.setRGB(1.03, 1.0, 0.94);
      break;
    case Biome.Desert:
      p.tiles[TileType.Sand] = c(0.68, 0.58, 0.42);
      p.tiles[TileType.Gravel] = c(0.56, 0.48, 0.38);
      p.tiles[TileType.Rock] = c(0.5, 0.43, 0.36);
      p.boulder = c(0.52, 0.44, 0.36);
      p.trunk = c(0.4, 0.34, 0.27);
      p.leafy = false;
      p.haze = c(0.82, 0.72, 0.54);
      p.hazeAmount = 0.75;
      p.sun = c(1.0, 0.9, 0.74);
      p.sunIntensity = 3.4;
      p.tint.setRGB(1.05, 1.0, 0.9);
      p.desaturate = 0.38;
      break;
    case Biome.Badlands:
      p.tiles[TileType.Dirt] = c(0.44, 0.33, 0.26);
      p.tiles[TileType.Gravel] = c(0.4, 0.35, 0.31);
      p.tiles[TileType.Rock] = c(0.33, 0.3, 0.29);
      p.boulder = c(0.37, 0.31, 0.28);
      p.trunk = c(0.33, 0.28, 0.24);
      p.leafy = false;
      p.haze = c(0.64, 0.54, 0.46);
      p.hazeAmount = 0.65;
      p.tint.setRGB(1.04, 0.99, 0.93);
      p.desaturate = 0.4;
      break;
    case Biome.Tundra:
    case Biome.Ice:
      p.tiles[TileType.Gravel] = c(0.46, 0.47, 0.47);
      p.canopy = c(0.22, 0.29, 0.25);
      p.haze = c(0.8, 0.84, 0.88);
      p.hazeAmount = 0.7;
      p.sun = c(0.92, 0.94, 1.0);
      p.sunIntensity = 2.6;
      p.tint.setRGB(0.95, 0.99, 1.04);
      p.desaturate = 0.42;
      break;
    default:
      break;
  }
  return p;
}

/** Stable muted colour for a player; the local player always gets desert tan. */
export function playerColor(playerId: number, isLocal: boolean): THREE.Color {
  if (isLocal) return c(0.62, 0.55, 0.38);
  const hue = ((playerId * 0.61803398875) % 1 + 1) % 1;
  return new THREE.Color().setHSL(hue, 0.32, 0.42, THREE.SRGBColorSpace);
}

export const ACCENT = 0x3fe6d2;
export const ACCENT_OTHER = 0xe0a040;

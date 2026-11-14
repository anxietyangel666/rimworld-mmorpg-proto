import * as THREE from 'three';
import { TileType } from '../world-gen/surface';

/** Muted, earthy colours for the surface, and the climate-driven grade applied on top. */

const c = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

/** Ground colour per tile type. Biomes differ by which tiles they are made of. */
export const TILE_COLORS: THREE.Color[] = [];
TILE_COLORS[TileType.Dirt] = c(0.37, 0.31, 0.24);
TILE_COLORS[TileType.Grass] = c(0.31, 0.36, 0.22);
TILE_COLORS[TileType.Sand] = c(0.58, 0.53, 0.42);
TILE_COLORS[TileType.Rock] = c(0.41, 0.4, 0.38);
TILE_COLORS[TileType.Snow] = c(0.8, 0.82, 0.84);
TILE_COLORS[TileType.Water] = c(0.2, 0.25, 0.25);
TILE_COLORS[TileType.Gravel] = c(0.46, 0.44, 0.4);
TILE_COLORS[TileType.Steppe] = c(0.45, 0.43, 0.27);
TILE_COLORS[TileType.RedEarth] = c(0.43, 0.34, 0.28);

export const SUN_COLOR = c(1.0, 0.93, 0.82);
export const SKY_COLOR = c(0.62, 0.7, 0.8);
export const BOUNCE_COLOR = c(0.3, 0.27, 0.22);

export interface Grade { haze: THREE.Color; hazeAmount: number; tint: THREE.Color; desaturate: number }

/** Look of the air for a climate: cold is blue-grey and crisp, hot and dry is dusty ochre. */
export function gradeFor(temperature: number, moisture: number, out: Grade): Grade {
  const heat = THREE.MathUtils.smoothstep(temperature, 0.25, 0.75), dry = 1 - THREE.MathUtils.smoothstep(moisture, 0.3, 0.6);
  out.haze.setRGB(0.72 + heat * 0.1, 0.76 - heat * 0.06 * dry, 0.8 - heat * 0.26 * (0.4 + dry * 0.6), THREE.SRGBColorSpace);
  out.hazeAmount = 0.45 + dry * heat * 0.3 + (1 - heat) * 0.2;
  out.tint.setRGB(0.96 + heat * 0.08, 0.99, 1.04 - heat * 0.12);
  out.desaturate = 0.42 + (1 - heat) * 0.1 + dry * 0.06;
  return out;
}

/** Stable muted colour for a player's clothing; drifters (owner 0) wear undyed grey-brown. */
export function playerColor(owner: number, isLocal: boolean): THREE.Color {
  if (owner === 0) return c(0.42, 0.4, 0.36);
  if (isLocal) return c(0.6, 0.52, 0.36);
  const hue = ((owner * 0.61803398875) % 1 + 1) % 1;
  return new THREE.Color().setHSL(hue, 0.3, 0.42, THREE.SRGBColorSpace);
}

/** Overlay ink: chalk-white for your own orders, ochre for other people. */
export const ACCENT = 0xe9dfc0;
export const ACCENT_OTHER = 0xd39a45;
export const WARN = 0xc8452f;

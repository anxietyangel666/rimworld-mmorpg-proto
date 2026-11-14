import { Item, ITEMS } from '../game-sim/items';

/**
 * Item icons, drawn in code at a few pixels per inventory cell and scaled up
 * with nearest-neighbour filtering, so they read as chunky pixel art in the
 * same key as the world. One drawing routine per kind of object; the item's
 * own colour tints it.
 */

const PX = 8;
const cache = new Map<string, string>();

type Draw = (g: CanvasRenderingContext2D, w: number, h: number, color: string) => void;
const DARK = '#15130f', WOOD = '#7a5a3a', LIGHT = 'rgba(255,255,255,0.28)';

const rect = (g: CanvasRenderingContext2D, c: string, x: number, y: number, w: number, h: number) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); };

/** A shaft running the long way down the icon, with a head drawn at the top by the caller. */
const shaft = (g: CanvasRenderingContext2D, w: number, h: number) => rect(g, WOOD, w / 2 - 1, h * 0.2, 2, h * 0.76);

const SHAPES: Record<string, Draw> = {
  stone: (g, w, h, c) => { rect(g, DARK, 1, 2, w - 2, h - 3); rect(g, c, 2, 1, w - 4, h - 3); rect(g, c, 1, 3, w - 2, h - 5); rect(g, LIGHT, 2, 2, 2, 1); },
  lump: (g, w, h, c) => { rect(g, DARK, 1, 3, w - 2, h - 4); rect(g, c, 2, 2, w - 4, h - 4); rect(g, c, 1, 4, w - 2, h - 6); },
  stick: (g, w, h, c) => { rect(g, DARK, w / 2 - 2, 1, 3, h - 2); rect(g, c, w / 2 - 1, 1, 2, h - 2); rect(g, c, w / 2 + 1, h * 0.3, 1, 2); },
  plank: (g, w, h, c) => { rect(g, DARK, 1, 1, w - 2, h - 2); rect(g, c, 2, 1, w - 4, h - 2); rect(g, 'rgba(0,0,0,0.25)', w / 2, 3, 1, h - 6); },
  log: (g, w, h, c) => { rect(g, DARK, 1, 1, w - 2, h - 2); rect(g, c, 2, 2, w - 4, h - 4); rect(g, '#c9a877', 2, 2, w - 4, 2); rect(g, 'rgba(0,0,0,0.25)', 3, 6, 1, h - 9); rect(g, 'rgba(0,0,0,0.25)', w - 4, 5, 1, h - 10); },
  fiber: (g, w, h, c) => { for (let i = 0; i < 3; i++) rect(g, c, 1 + i * 2, 1 + i, 1, h - 2 - i); rect(g, DARK, 1, h - 3, w - 2, 1); },
  coil: (g, w, h, c) => { rect(g, DARK, 1, 1, w - 2, h - 2); rect(g, c, 2, 2, w - 4, h - 4); rect(g, DARK, 3, 3, w - 6, h - 6); },
  berry: (g, w, h, c) => { rect(g, c, 1, 3, 3, 3); rect(g, c, 4, 2, 3, 3); rect(g, c, 3, 5, 3, 2); rect(g, '#4a6a2a', 3, 1, 2, 1); rect(g, LIGHT, 2, 3, 1, 1); },
  ingot: (g, w, h, c) => { rect(g, DARK, 1, 2, w - 2, h - 4); rect(g, c, 2, 3, w - 4, h - 6); rect(g, LIGHT, 2, 3, w - 4, 1); },
  head: (g, w, h, c) => { rect(g, DARK, 1, 1, w - 2, h - 2); rect(g, c, 2, 2, w - 3, h - 4); rect(g, LIGHT, 2, 2, 1, h - 4); },
  blade: (g, w, h, c) => { rect(g, DARK, 2, 1, 4, h - 2); rect(g, c, 3, 1, 2, h - 3); rect(g, LIGHT, 3, 2, 1, h - 5); },
  axe: (g, w, h, c) => { shaft(g, w, h); rect(g, DARK, w / 2 - 1, 1, w / 2, 7); rect(g, c, w / 2, 2, w / 2 - 2, 5); rect(g, LIGHT, w - 3, 2, 1, 5); },
  pick: (g, w, h, c) => { shaft(g, w, h); rect(g, DARK, 1, 2, w - 2, 4); rect(g, c, 2, 3, w - 4, 2); rect(g, c, 1, 5, 2, 2); rect(g, c, w - 3, 5, 2, 2); },
  knife: (g, w, h, c) => { rect(g, WOOD, w / 2 - 1, h * 0.6, 2, h * 0.35); rect(g, DARK, w / 2 - 2, 1, 4, h * 0.6); rect(g, c, w / 2 - 1, 1, 2, h * 0.58); },
  shovel: (g, w, h, c) => { shaft(g, w, h); rect(g, DARK, 1, 1, w - 2, 8); rect(g, c, 2, 2, w - 4, 6); },
  pot: (g, w, h, c) => { rect(g, DARK, 2, 2, w - 4, h - 3); rect(g, c, 3, 4, w - 6, h - 6); rect(g, c, 2, 6, w - 4, h - 10); rect(g, DARK, 4, 3, w - 8, 2); rect(g, LIGHT, 3, 6, 1, h - 11); },
  cup: (g, w, h, c) => { rect(g, DARK, 1, 2, w - 2, h - 3); rect(g, c, 2, 3, w - 4, h - 5); rect(g, DARK, 3, 3, w - 6, 2); },
  cloth: (g, w, h, c) => { rect(g, DARK, 2, 2, w - 4, h - 3); rect(g, c, 3, 3, w - 6, h - 5); rect(g, c, 1, 3, 3, 5); rect(g, c, w - 4, 3, 3, 5); rect(g, DARK, w / 2 - 1, 3, 2, 2); },
  hat: (g, w, h, c) => { rect(g, DARK, 1, h - 6, w - 2, 3); rect(g, c, 2, h - 5, w - 4, 1); rect(g, DARK, 4, 4, w - 8, h - 9); rect(g, c, 5, 5, w - 10, h - 10); },
  bag: (g, w, h, c) => { rect(g, DARK, 2, 3, w - 4, h - 4); rect(g, c, 3, 4, w - 6, h - 6); rect(g, DARK, 3, h / 2, w - 6, 1); rect(g, DARK, w / 2 - 2, 1, 4, 3); rect(g, c, w / 2 - 1, 2, 2, 1); },
};

/** Data URL of an item's icon at its inventory footprint, optionally turned a quarter turn. */
export function iconUrl(item: Item, rot = 0): string {
  const key = item + ':' + rot;
  let url = cache.get(key);
  if (url) return url;
  const def = ITEMS[item];
  const w = def.w * PX, h = def.h * PX;
  const base = document.createElement('canvas');
  base.width = w; base.height = h;
  const g = base.getContext('2d')!;
  (SHAPES[def.icon] ?? SHAPES.stone)(g, w, h, def.color);
  if (!rot) url = base.toDataURL();
  else {
    const turned = document.createElement('canvas');
    turned.width = h; turned.height = w;
    const t = turned.getContext('2d')!;
    t.translate(h, 0);
    t.rotate(Math.PI / 2);
    t.drawImage(base, 0, 0);
    url = turned.toDataURL();
  }
  cache.set(key, url);
  return url;
}

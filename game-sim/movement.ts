import { wrapX, wrapY } from '../world-gen/surface';
import { LOAD_SPEED, type LoadTier } from './character';

/**
 * Direct (WASD) movement, shared by the server and the client. The client runs
 * the same step on its own inputs to predict the hero's position, then replays
 * unacknowledged inputs on top of each authoritative update.
 */

export const BASE_SPEED = 3.6;
const RADIUS = 0.28;

export function moveSpeed(tier: LoadTier, inWater: boolean, exhausted: boolean, sprained: boolean): number {
  return BASE_SPEED * LOAD_SPEED[tier] * (inWater ? 0.55 : 1) * (exhausted ? 0.6 : 1) * (sprained ? 0.75 : 1);
}

function hits(x: number, y: number, blocked: (tx: number, ty: number) => boolean): boolean {
  const x0 = Math.floor(x - RADIUS), x1 = Math.floor(x + RADIUS), y0 = Math.floor(y - RADIUS), y1 = Math.floor(y + RADIUS);
  return blocked(x0, y0) || blocked(x1, y0) || blocked(x0, y1) || blocked(x1, y1);
}

/**
 * Move `p` by `dist` along (dx, dy), sliding along obstacles one axis at a
 * time and wrapping around the world. A body already inside an obstacle (a
 * wall finished around it) may always move, so it can never be trapped.
 */
export function moveStep(p: { x: number; y: number }, dx: number, dy: number, dist: number, blocked: (tx: number, ty: number) => boolean): void {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const sx = (dx / len) * dist, sy = (dy / len) * dist;
  const stuck = hits(p.x, p.y, blocked);
  if (stuck || !hits(p.x + sx, p.y, blocked)) p.x += sx;
  if (stuck || !hits(p.x, p.y + sy, blocked)) p.y += sy;
  p.x = wrapX(p.x);
  p.y = wrapY(p.y);
}

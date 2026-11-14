import type { EntityState } from '../game-sim/view';
import type { MoveUpdate } from './protocol';

/** A replicated entity as the client sees it: latest state plus a smoothed render position. */
export interface MirrorEntity {
  state: EntityState;
  /** Interpolated position and facing to draw at. */
  rx: number;
  ry: number;
  rfacing: number;
  /** Recent authoritative positions as flat [timeMs, x, y] triples. */
  samples: number[];
}

/** How far behind the newest snapshot the client renders, in ms (1.5 snapshot intervals). */
const INTERP_DELAY_MS = 150;
const MAX_SAMPLES = 8;

/**
 * Client-side mirror of the server's entities with snapshot interpolation.
 *
 * Snapshots arrive at 10 Hz and with network jitter; drawing them directly
 * would stutter. Instead every position is stamped with its server time and
 * the mirror renders slightly in the past, blending between the two samples
 * that bracket the render time.
 */
export class EntityMirror {
  readonly entities = new Map<number, MirrorEntity>();
  onSpawn: ((e: MirrorEntity) => void) | null = null;
  onChange: ((e: MirrorEntity) => void) | null = null;
  onDespawn: ((e: MirrorEntity) => void) | null = null;

  /** Estimated (server time - local time), smoothed. */
  private offset: number | null = null;
  private readonly tickMs: number;
  private readonly snapshotMs: number;

  constructor(tickRate: number, snapshotEvery: number) {
    this.tickMs = 1000 / tickRate;
    this.snapshotMs = this.tickMs * snapshotEvery;
  }

  reset(): void {
    for (const e of this.entities.values()) this.onDespawn?.(e);
    this.entities.clear();
    this.offset = null;
  }

  /** Fractional server tick right now, for effects keyed to sim time. */
  serverTick(nowMs: number): number {
    return this.offset === null ? 0 : (nowMs + this.offset) / this.tickMs;
  }

  apply(snap: { tick: number; full: EntityState[]; moves: MoveUpdate[]; gone: number[] }, nowMs: number): void {
    const t = snap.tick * this.tickMs;
    const estimate = t - nowMs;
    if (this.offset === null || Math.abs(estimate - this.offset) > 500) this.offset = estimate;
    else this.offset += (estimate - this.offset) * 0.1;

    for (const s of snap.full) {
      let e = this.entities.get(s.id);
      if (!e) {
        e = { state: s, rx: s.x, ry: s.y, rfacing: s.unit?.facing ?? 0, samples: [t, s.x, s.y] };
        this.entities.set(s.id, e);
        this.onSpawn?.(e);
      } else {
        e.state = s;
        this.pushSample(e, t, s.x, s.y);
        this.onChange?.(e);
      }
    }
    for (const m of snap.moves) {
      const e = this.entities.get(m.id);
      if (!e) continue;
      e.state.x = m.x; e.state.y = m.y;
      if (e.state.unit) e.state.unit.facing = m.facing;
      this.pushSample(e, t, m.x, m.y);
    }
    for (const id of snap.gone) {
      const e = this.entities.get(id);
      if (!e) continue;
      this.entities.delete(id);
      this.onDespawn?.(e);
    }
  }

  /** Advance render positions to the interpolation time for this frame. */
  update(nowMs: number, dt: number): void {
    if (this.offset === null) return;
    const rt = nowMs + this.offset - INTERP_DELAY_MS;
    for (const e of this.entities.values()) {
      const u = e.state.unit;
      if (!u) continue;
      const s = e.samples;
      const last = s.length - 3;
      if (rt >= s[last]) { e.rx = s[last + 1]; e.ry = s[last + 2]; }
      else if (rt <= s[0]) { e.rx = s[1]; e.ry = s[2]; }
      else {
        let i = last - 3;
        while (i > 0 && s[i] > rt) i -= 3;
        const k = (rt - s[i]) / (s[i + 3] - s[i]);
        e.rx = s[i + 1] + (s[i + 4] - s[i + 1]) * k;
        e.ry = s[i + 2] + (s[i + 5] - s[i + 2]) * k;
      }
      // Turn through the short arc.
      let d = (u.facing - e.rfacing) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      e.rfacing += d * Math.min(1, dt * 12);
    }
  }

  private pushSample(e: MirrorEntity, t: number, x: number, y: number): void {
    const s = e.samples;
    const last = s.length - 3;
    if (t <= s[last]) { s[last + 1] = x; s[last + 2] = y; return; }
    // After standing still there is no recent sample; without this hold the
    // unit would start drifting toward the new position before it really left.
    if (t - s[last] > this.snapshotMs * 1.5) s.push(t - this.snapshotMs, s[last + 1], s[last + 2]);
    s.push(t, x, y);
    while (s.length > MAX_SAMPLES * 3) s.splice(0, 3);
  }
}

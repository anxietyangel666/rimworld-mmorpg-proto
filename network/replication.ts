import type { ChunkGrid } from '../core-ecs/spatial';
import type { Entity } from '../core-ecs/world';
import type { EntityState } from '../game-sim/view';
import { ByteWriter } from './bytes';
import { S2C, writeEntityFull, writeEntityMove } from './protocol';

/** What the replicator needs to know about a simulation, kept free of game rules. */
export interface ReplicationSource {
  grid: ChunkGrid;
  tick: number;
  /** Counter that changes whenever non-positional state changes. */
  version(e: Entity): number;
  /** Tick of the entity's last position change. */
  moveTick(e: Entity): number;
  describe(e: Entity): EntityState;
}

/** Cap on full entity records per packet; the remainder trickles in over the next snapshots. */
const MAX_FULL_PER_SNAPSHOT = 500;

/**
 * Per-client delta encoder with chunk-based area of interest.
 *
 * It remembers which entities the client has and at what version. Each
 * snapshot then carries only: full records for entities that entered the area
 * or changed state, 9-byte position records for ones that merely moved, and
 * ids for ones that left or died. A client in a quiet area receives a
 * 11-byte heartbeat.
 */
export class Replicator {
  private readonly known = new Map<Entity, number>();
  private lastTick = -1;
  private readonly visible = new Set<Entity>();

  /** Forget everything, e.g. when the client changes sector. */
  reset(): void {
    this.known.clear();
    this.lastTick = -1;
  }

  /**
   * Encode the next snapshot for a client viewing chunk (cx, cy).
   * `always` lists entities replicated regardless of distance (the player's own units).
   */
  build(src: ReplicationSource, cx: number, cy: number, radius: number, always: Iterable<Entity>): Uint8Array {
    const visible = this.visible;
    visible.clear();
    src.grid.forEachInChunks(cx, cy, radius, (e) => visible.add(e));
    for (const e of always) visible.add(e);

    const w = new ByteWriter(256).u8(S2C.Snapshot).u32(src.tick);
    const fullCountAt = w.length;
    w.u16(0);
    let full = 0;
    const movers: Entity[] = [];
    for (const e of visible) {
      const v = src.version(e);
      if (this.known.get(e) !== v) {
        if (full >= MAX_FULL_PER_SNAPSHOT) continue;
        writeEntityFull(w, src.describe(e));
        this.known.set(e, v);
        full++;
      } else if (src.moveTick(e) > this.lastTick) movers.push(e);
    }
    w.patchU16(fullCountAt, full);

    w.u16(movers.length);
    for (const e of movers) {
      const s = src.describe(e);
      writeEntityMove(w, { id: e, x: s.x, y: s.y, facing: s.unit?.facing ?? 0 });
    }

    const goneCountAt = w.length;
    w.u16(0);
    let gone = 0;
    for (const e of this.known.keys()) {
      if (visible.has(e)) continue;
      w.u32(e);
      this.known.delete(e);
      gone++;
    }
    w.patchU16(goneCountAt, gone);

    this.lastTick = src.tick;
    return w.finish();
  }
}

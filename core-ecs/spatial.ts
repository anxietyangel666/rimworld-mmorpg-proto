import type { Entity } from './world';

/**
 * Uniform chunk grid over a square map. It is both the broad phase for
 * gameplay queries and the unit of network interest: a client subscribes to a
 * square of chunks rather than to individual entities.
 */
export class ChunkGrid {
  private readonly chunks: Set<Entity>[];
  private readonly where = new Map<Entity, number>();

  constructor(
    readonly chunkSize: number,
    /** Chunks per side. */
    readonly side: number,
  ) {
    this.chunks = Array.from({ length: side * side }, () => new Set<Entity>());
  }

  chunkCoord(v: number): number {
    return Math.min(this.side - 1, Math.max(0, Math.floor(v / this.chunkSize)));
  }

  /** Insert or move an entity. Cheap when it stays in the same chunk. */
  update(e: Entity, x: number, y: number): void {
    const key = this.chunkCoord(x) + this.chunkCoord(y) * this.side;
    const prev = this.where.get(e);
    if (prev === key) return;
    if (prev !== undefined) this.chunks[prev].delete(e);
    this.chunks[key].add(e);
    this.where.set(e, key);
  }

  remove(e: Entity): void {
    const prev = this.where.get(e);
    if (prev === undefined) return;
    this.chunks[prev].delete(e);
    this.where.delete(e);
  }

  /** Visit every entity in the square of chunks within `radius` of (cx, cy). */
  forEachInChunks(cx: number, cy: number, radius: number, fn: (e: Entity) => void): void {
    const x0 = Math.max(0, cx - radius), x1 = Math.min(this.side - 1, cx + radius);
    const y0 = Math.max(0, cy - radius), y1 = Math.min(this.side - 1, cy + radius);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (const e of this.chunks[x + y * this.side]) fn(e);
  }

  /** Visit entities whose chunk overlaps a world-space circle (broad phase only). */
  forEachNear(x: number, y: number, r: number, fn: (e: Entity) => void): void {
    const x0 = this.chunkCoord(x - r), x1 = this.chunkCoord(x + r);
    const y0 = this.chunkCoord(y - r), y1 = this.chunkCoord(y + r);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) for (const e of this.chunks[cx + cy * this.side]) fn(e);
  }
}

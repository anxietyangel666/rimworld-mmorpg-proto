import type { Entity } from './world';

/**
 * Uniform chunk grid. It is both the broad phase for gameplay queries and the
 * unit of network interest: a client is sent a square of chunks, not a list of
 * entities. With `wrap` set the grid is a torus, so queries near an edge see
 * the chunks on the opposite side.
 */
export class ChunkGrid {
  private readonly chunks: Set<Entity>[];
  private readonly where = new Map<Entity, number>();

  constructor(
    readonly chunkSize: number,
    /** Chunks along x. */
    readonly sideX: number,
    /** Chunks along y. */
    readonly sideY: number = sideX,
    readonly wrap = false,
  ) {
    this.chunks = Array.from({ length: sideX * sideY }, () => new Set<Entity>());
  }

  private fit(c: number, side: number): number {
    return this.wrap ? ((c % side) + side) % side : Math.min(side - 1, Math.max(0, c));
  }

  chunkX(v: number): number {
    return this.fit(Math.floor(v / this.chunkSize), this.sideX);
  }

  chunkY(v: number): number {
    return this.fit(Math.floor(v / this.chunkSize), this.sideY);
  }

  chunkIndex(x: number, y: number): number {
    return this.chunkX(x) + this.chunkY(y) * this.sideX;
  }

  /** Insert or move an entity. Cheap when it stays in the same chunk. */
  update(e: Entity, x: number, y: number): void {
    const key = this.chunkIndex(x, y);
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

  /** Visit every entity in the square of chunks within `radius` of chunk (cx, cy). */
  forEachInChunks(cx: number, cy: number, radius: number, fn: (e: Entity) => void): void {
    // On a torus a radius that spans the whole axis would visit chunks twice.
    const rx = this.wrap ? Math.min(radius, (this.sideX - 1) >> 1) : radius;
    const ry = this.wrap ? Math.min(radius, (this.sideY - 1) >> 1) : radius;
    for (let dy = -ry; dy <= ry; dy++) {
      const y = cy + dy;
      if (!this.wrap && (y < 0 || y >= this.sideY)) continue;
      for (let dx = -rx; dx <= rx; dx++) {
        const x = cx + dx;
        if (!this.wrap && (x < 0 || x >= this.sideX)) continue;
        for (const e of this.chunks[this.fit(x, this.sideX) + this.fit(y, this.sideY) * this.sideX]) fn(e);
      }
    }
  }

  /** Visit entities whose chunk overlaps a world-space circle (broad phase only). */
  forEachNear(x: number, y: number, r: number, fn: (e: Entity) => void): void {
    const x0 = Math.floor((x - r) / this.chunkSize), x1 = Math.floor((x + r) / this.chunkSize);
    const y0 = Math.floor((y - r) / this.chunkSize), y1 = Math.floor((y + r) / this.chunkSize);
    for (let cy = y0; cy <= y1; cy++) {
      if (!this.wrap && (cy < 0 || cy >= this.sideY)) continue;
      for (let cx = x0; cx <= x1; cx++) {
        if (!this.wrap && (cx < 0 || cx >= this.sideX)) continue;
        for (const e of this.chunks[this.fit(cx, this.sideX) + this.fit(cy, this.sideY) * this.sideX]) fn(e);
      }
    }
  }
}

/**
 * Grid A* with line-of-sight smoothing over a rectangular map that may wrap on
 * both axes. Shared by the server (authoritative routes) and the client
 * (instant predicted route while the order is in flight).
 *
 * Scratch arrays are allocated once per map and invalidated by a generation
 * stamp, so a search allocates nothing but its result.
 */
export class Pathfinder {
  private readonly g: Float32Array;
  private readonly parent: Int32Array;
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  private gen = 0;
  private heapF: number[] = [];
  private heapI: number[] = [];

  constructor(
    private readonly w: number,
    private readonly h: number,
    /** Tile passability; always called with in-range coordinates. */
    private readonly blockedAt: (tx: number, ty: number) => boolean,
    private readonly wrap = false,
    private readonly maxExpansions = 20000,
  ) {
    const n = w * h;
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  private fx(x: number): number { return this.wrap ? ((x % this.w) + this.w) % this.w : x; }
  private fy(y: number): number { return this.wrap ? ((y % this.h) + this.h) % this.h : y; }
  /** Shortest signed step from a to b along an axis of the given size. */
  private delta(d: number, size: number): number {
    if (!this.wrap) return d;
    d = ((d % size) + size) % size;
    return d > size / 2 ? d - size : d;
  }

  isBlocked(tx: number, ty: number): boolean {
    if (this.wrap) return this.blockedAt(this.fx(tx), this.fy(ty));
    return tx < 0 || ty < 0 || tx >= this.w || ty >= this.h || this.blockedAt(tx, ty);
  }

  /** Closest walkable tile to (tx, ty) by expanding rings, or null within maxR. */
  nearestFree(tx: number, ty: number, maxR = 10): [number, number] | null {
    for (let r = 0; r <= maxR; r++) {
      let best: [number, number] | null = null, bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || this.isBlocked(tx + dx, ty + dy)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = [this.fx(tx + dx), this.fy(ty + dy)]; }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * Route between two world positions, the short way around a wrapping map.
   * Returns flat waypoints (wrapped into range) excluding the start, or null
   * when unreachable. A blocked goal is moved to the nearest walkable tile.
   */
  findPath(fromX: number, fromY: number, toX: number, toY: number): number[] | null {
    // Work in coordinates unwrapped around the start so segments are continuous.
    let gx = fromX + this.delta(toX - fromX, this.w), gy = fromY + this.delta(toY - fromY, this.h);
    if (!this.wrap) {
      gx = Math.min(this.w - 1e-3, Math.max(0, gx));
      gy = Math.min(this.h - 1e-3, Math.max(0, gy));
    }
    const sx = Math.floor(fromX), sy = Math.floor(fromY);
    let tx = Math.floor(gx), ty = Math.floor(gy);
    if (this.isBlocked(tx, ty)) {
      const free = this.nearestFree(tx, ty);
      if (!free) return null;
      tx = sx + this.delta(free[0] - sx, this.w); ty = sy + this.delta(free[1] - sy, this.h);
      gx = tx + 0.5; gy = ty + 0.5;
    }
    if (sx === tx && sy === ty) return [this.fx(gx), this.fy(gy)];
    const tilePath = this.astar(this.fx(sx), this.fy(sy), this.fx(tx), this.fy(ty));
    if (!tilePath) return null;

    const xs: number[] = [fromX], ys: number[] = [fromY];
    for (let i = 1; i < tilePath.length - 1; i++) {
      const px = tilePath[i] % this.w, py = Math.floor(tilePath[i] / this.w);
      xs.push(xs[i - 1] + this.delta(px + 0.5 - xs[i - 1], this.w));
      ys.push(ys[i - 1] + this.delta(py + 0.5 - ys[i - 1], this.h));
    }
    xs.push(gx); ys.push(gy);

    // String-pull: from each kept point, jump to the farthest visible one.
    const out: number[] = [];
    let i = 0;
    const last = xs.length - 1;
    while (i < last) {
      let j = last;
      while (j > i + 1 && !this.lineClear(xs[i], ys[i], xs[j], ys[j])) j--;
      out.push(this.fx(xs[j]), this.fy(ys[j]));
      i = j;
    }
    return out;
  }

  /** True if a unit-wide corridor between two (unwrapped) points crosses no blocked tile. */
  lineClear(x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return true;
    const px = (-dy / len) * 0.3, py = (dx / len) * 0.3;
    const steps = Math.ceil(len / 0.25);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + dx * t, y = y0 + dy * t;
      if (this.isBlocked(Math.floor(x), Math.floor(y))
        || this.isBlocked(Math.floor(x + px), Math.floor(y + py))
        || this.isBlocked(Math.floor(x - px), Math.floor(y - py))) return false;
    }
    return true;
  }

  private astar(sx: number, sy: number, tx: number, ty: number): number[] | null {
    const w = this.w;
    const gen = ++this.gen;
    const start = sx + sy * w, goal = tx + ty * w;
    this.heapF.length = 0; this.heapI.length = 0;
    this.g[start] = 0; this.parent[start] = -1; this.seen[start] = gen;
    this.heapPush(0, start);
    let expansions = 0;
    while (this.heapI.length > 0) {
      const cur = this.heapPop();
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      if (cur === goal) {
        const path: number[] = [];
        for (let c = cur; c !== -1; c = this.parent[c]) path.push(c);
        return path.reverse();
      }
      if (++expansions > this.maxExpansions) return null;
      const cx = cur % w, cy = (cur - cx) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (this.isBlocked(cx + dx, cy + dy)) continue;
        // No squeezing diagonally between two blocked corners.
        if (dx !== 0 && dy !== 0 && (this.isBlocked(cx + dx, cy) || this.isBlocked(cx, cy + dy))) continue;
        const nx = this.fx(cx + dx), ny = this.fy(cy + dy);
        const ni = nx + ny * w;
        if (this.closed[ni] === gen) continue;
        const ng = this.g[cur] + (dx !== 0 && dy !== 0 ? 1.41421356 : 1);
        if (this.seen[ni] === gen && ng >= this.g[ni]) continue;
        this.seen[ni] = gen; this.g[ni] = ng; this.parent[ni] = cur;
        const hx = Math.abs(this.delta(tx - nx, this.w)), hy = Math.abs(this.delta(ty - ny, this.h));
        this.heapPush(ng + Math.max(hx, hy) + 0.41421356 * Math.min(hx, hy), ni);
      }
    }
    return null;
  }

  // Binary min-heap on parallel arrays; stale entries are skipped on pop.
  private heapPush(f: number, i: number): void {
    const F = this.heapF, I = this.heapI;
    let c = F.length;
    F.push(f); I.push(i);
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (F[p] <= f) break;
      F[c] = F[p]; I[c] = I[p];
      c = p;
    }
    F[c] = f; I[c] = i;
  }

  private heapPop(): number {
    const F = this.heapF, I = this.heapI;
    const top = I[0];
    const f = F.pop()!, i = I.pop()!;
    const len = F.length;
    if (len > 0) {
      let p = 0;
      for (;;) {
        let c = p * 2 + 1;
        if (c >= len) break;
        if (c + 1 < len && F[c + 1] < F[c]) c++;
        if (F[c] >= f) break;
        F[p] = F[c]; I[p] = I[c];
        p = c;
      }
      F[p] = f; I[p] = i;
    }
    return top;
  }
}

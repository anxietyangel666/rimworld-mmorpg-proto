/**
 * Grid A* with line-of-sight smoothing. Shared by the server (authoritative
 * routes) and the client (instant predicted route while the command is in flight).
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
    private readonly size: number,
    /** Live view of blocked tiles; the owner mutates it as the world changes. */
    private readonly blocked: Uint8Array,
    private readonly maxExpansions = 24000,
  ) {
    const n = size * size;
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  isBlocked(tx: number, ty: number): boolean {
    return tx < 0 || ty < 0 || tx >= this.size || ty >= this.size || this.blocked[tx + ty * this.size] === 1;
  }

  /** Closest walkable tile to (tx, ty) by expanding rings, or null within maxR. */
  nearestFree(tx: number, ty: number, maxR = 10): [number, number] | null {
    for (let r = 0; r <= maxR; r++) {
      let best: [number, number] | null = null, bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || this.isBlocked(tx + dx, ty + dy)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = [tx + dx, ty + dy]; }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * Route between two world positions. Returns flat waypoints excluding the
   * start, or null when unreachable. A blocked goal is moved to the nearest
   * walkable tile.
   */
  findPath(fromX: number, fromY: number, toX: number, toY: number): number[] | null {
    const n = this.size;
    const clampT = (v: number) => Math.min(n - 1, Math.max(0, Math.floor(v)));
    const sx = clampT(fromX), sy = clampT(fromY);
    let tx = clampT(toX), ty = clampT(toY);
    if (toX < 0 || toY < 0 || toX >= n || toY >= n || this.isBlocked(tx, ty)) {
      const free = this.nearestFree(tx, ty);
      if (!free) return null;
      [tx, ty] = free;
      toX = tx + 0.5; toY = ty + 0.5;
    }
    if (sx === tx && sy === ty) return [toX, toY];
    const tilePath = this.astar(sx, sy, tx, ty);
    if (!tilePath) return null;

    const xs: number[] = [fromX], ys: number[] = [fromY];
    for (let i = 1; i < tilePath.length - 1; i++) {
      xs.push((tilePath[i] % n) + 0.5);
      ys.push(Math.floor(tilePath[i] / n) + 0.5);
    }
    xs.push(toX); ys.push(toY);

    // String-pull: from each kept point, jump to the farthest visible one.
    const out: number[] = [];
    let i = 0;
    const last = xs.length - 1;
    while (i < last) {
      let j = last;
      while (j > i + 1 && !this.lineClear(xs[i], ys[i], xs[j], ys[j])) j--;
      out.push(xs[j], ys[j]);
      i = j;
    }
    return out;
  }

  /** True if a unit-wide corridor between two points crosses no blocked tile. */
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
    const n = this.size;
    const gen = ++this.gen;
    const start = sx + sy * n, goal = tx + ty * n;
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
      const cx = cur % n, cy = (cur - cx) / n;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx, ny = cy + dy;
        if (this.isBlocked(nx, ny)) continue;
        // No squeezing diagonally between two blocked corners.
        if (dx !== 0 && dy !== 0 && (this.isBlocked(cx + dx, cy) || this.isBlocked(cx, cy + dy))) continue;
        const ni = nx + ny * n;
        if (this.closed[ni] === gen) continue;
        const ng = this.g[cur] + (dx !== 0 && dy !== 0 ? 1.41421356 : 1);
        if (this.seen[ni] === gen && ng >= this.g[ni]) continue;
        this.seen[ni] = gen; this.g[ni] = ng; this.parent[ni] = cur;
        const hx = Math.abs(nx - tx), hy = Math.abs(ny - ty);
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

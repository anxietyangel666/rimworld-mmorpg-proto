/** Deterministic integer hashing and PRNG. No Math.random anywhere in the sim. */

/** Avalanche-mix a 32-bit integer (murmur3 finaliser). */
export function mix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Combine integers into one 32-bit hash. */
export function hashInts(...v: number[]): number {
  let h = 0x9e3779b9;
  for (const x of v) h = mix32(h ^ Math.imul(x | 0, 0x27d4eb2d));
  return h;
}

/** Hash to a float in [0, 1). */
export function hash01(...v: number[]): number {
  return hashInts(...v) / 4294967296;
}

/** mulberry32: small, fast, seedable generator with a full 2^32 period. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
}

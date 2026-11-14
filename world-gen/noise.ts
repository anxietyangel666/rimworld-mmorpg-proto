/**
 * Seeded 3D value noise and fractal sums. Pure integer hashing, so the server
 * and every client derive bit-identical worlds from the same seed.
 */

function lattice(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Value noise in [-1, 1] with quintic interpolation. */
export function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const w = zf * zf * zf * (zf * (zf * 6 - 15) + 10);
  const c000 = lattice(xi, yi, zi, seed), c100 = lattice(xi + 1, yi, zi, seed);
  const c010 = lattice(xi, yi + 1, zi, seed), c110 = lattice(xi + 1, yi + 1, zi, seed);
  const c001 = lattice(xi, yi, zi + 1, seed), c101 = lattice(xi + 1, yi, zi + 1, seed);
  const c011 = lattice(xi, yi + 1, zi + 1, seed), c111 = lattice(xi + 1, yi + 1, zi + 1, seed);
  const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return (y0 + (y1 - y0) * w) * 2 - 1;
}

/** Fractal Brownian motion, normalised to roughly [-1, 1]. */
export function fbm3(x: number, y: number, z: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise3(x, y, z, seed + i * 101) * amp;
    norm += amp;
    amp *= 0.5;
    x *= 2.03; y *= 2.03; z *= 2.03;
  }
  return sum / norm;
}

/** Ridged multifractal in [0, 1]; sharp crests suit mountain chains. */
export function ridged3(x: number, y: number, z: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise3(x, y, z, seed + i * 131));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    x *= 2.1; y *= 2.1; z *= 2.1;
  }
  return sum / norm;
}

/** GLSL building blocks shared by the orbit, surface and post-processing shaders. */

/** Hash-based 3D value noise and a 5-octave fbm, both in [0, 1). */
export const NOISE_GLSL = /* glsl */ `
float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x), mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x), mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.02 + vec3(13.1, 7.7, 3.3);
    a *= 0.5;
  }
  return s;
}
float fbm3(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p = p * 2.02 + vec3(13.1, 7.7, 3.3);
    a *= 0.5;
  }
  return s;
}
`;

/** Same equirectangular mapping as world-gen/planet.ts dirToUv. */
export const SPHERE_UV_GLSL = /* glsl */ `
vec2 dirToUv(vec3 d) {
  return vec2(atan(d.z, d.x) / 6.28318530718 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / 3.14159265359 + 0.5);
}
`;

/**
 * Pixel-art sampling on a sphere. snapDir replaces a direction with the centre
 * of the texel it falls in on an n x n cube-face grid, so everything computed
 * from it is constant across that texel: hard-edged, fixed to the surface, and
 * free of the shimmer that sub-pixel procedural detail produces. bayer4 is a
 * 4x4 ordered-dither threshold in [0, 1) for the texel's integer coordinates.
 */
export const PIXEL_GLSL = /* glsl */ `
vec3 snapDir(vec3 d, float n, out vec2 cell) {
  vec3 a = abs(d);
  vec3 p = d / max(a.x, max(a.y, a.z));
  vec3 c = floor((p * 0.5 + 0.5) * n);
  vec3 q = (c + 0.5) / n * 2.0 - 1.0;
  if (a.x >= a.y && a.x >= a.z) { q.x = p.x; cell = c.yz; }
  else if (a.y >= a.z) { q.y = p.y; cell = c.xz; }
  else { q.z = p.z; cell = c.xy; }
  return normalize(q);
}
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
`;

/**
 * Cloud cover. cloudFrame turns a planet-space direction into the slowly
 * rotating cloud layer's frame; cloudAt evaluates coverage there. The planet
 * shader and the cloud shell both snap to texels in that frame, so pixel
 * clouds and their pixel shadows always line up.
 */
export const CLOUDS_GLSL = /* glsl */ `
vec3 cloudFrame(vec3 d, float t) {
  float a = t * 0.006;
  float c = cos(a), s = sin(a);
  return vec3(c * d.x - s * d.z, d.y, s * d.x + c * d.z);
}
float cloudAt(vec3 r, float t) {
  vec3 p = r * 3.2;
  float warp = fbm3(p + vec3(0.0, t * 0.003, 0.0));
  float n = fbm(p * 2.1 + warp * 1.7 + vec3(t * 0.004, 0.0, 0.0));
  float band = 1.0 - abs(r.y) * 0.3;
  return smoothstep(0.53, 0.8, n * band + warp * 0.26);
}
`;

/**
 * 2D Voronoi: distances to the nearest and second-nearest feature point. The
 * difference between them is small along cell borders, which makes crisp
 * ripple lines and caustic nets when thresholded.
 */
export const VORONOI_GLSL = /* glsl */ `
vec2 hash22(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}
vec2 voronoi(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    float d = length(g + hash22(i + g) - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return vec2(d1, d2);
}
`;

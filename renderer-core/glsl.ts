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
 * Cloud coverage on the unit sphere at time t. The planet shader samples it
 * (offset toward the sun) for cloud shadows and the cloud shell samples it for
 * the clouds themselves, so the two always line up.
 */
export const CLOUDS_GLSL = /* glsl */ `
float cloudDensity(vec3 d, float t) {
  float a = t * 0.006;
  float c = cos(a), s = sin(a);
  vec3 p = vec3(c * d.x - s * d.z, d.y, s * d.x + c * d.z) * 3.2;
  float warp = fbm3(p + vec3(0.0, t * 0.004, 0.0));
  float n = fbm(p * 2.1 + warp * 1.7 + vec3(t * 0.008, 0.0, 0.0));
  float band = 1.0 - abs(d.y) * 0.3;
  return smoothstep(0.53, 0.8, n * band + warp * 0.26);
}
`;

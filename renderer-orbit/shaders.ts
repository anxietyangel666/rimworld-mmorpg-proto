import { CLOUDS_GLSL, NOISE_GLSL, PIXEL_GLSL, SPHERE_UV_GLSL } from '../renderer-core/glsl';
import { SECTOR_COLS, SECTOR_ROWS } from '../world-gen/planet';

/**
 * Home planet, drawn as retro pixel art on a 3D sphere. Every fragment is
 * snapped to a texel fixed on the surface (see PIXEL_GLSL); biome, lighting
 * and cloud shadow are then decided once per texel from a small palette with
 * ordered dithering, which gives hard coastlines and stepped shading instead
 * of blurred gradients.
 *
 * Lighting is done in the planet's object space (uSunLocal / uCamLocal), so
 * the planet can spin without re-deriving the sector grid.
 */

/** Texels along one cube face; 4x this around the equator. */
const TEXELS = '112.0';

export const PLANET_VERT = /* glsl */ `
uniform sampler2D uMap;
uniform float uRadius;
varying vec3 vDir;
varying vec3 vPos;
${SPHERE_UV_GLSL}
void main() {
  vec3 d = normalize(position);
  float e = texture2D(uMap, dirToUv(d)).r * 2.0 - 1.0;
  // Real geometric relief, exaggerated enough to break the limb silhouette.
  vec3 p = d * uRadius * (1.0 + max(e, 0.0) * 0.012);
  vDir = d;
  vPos = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

export const PLANET_FRAG = /* glsl */ `
uniform sampler2D uMap;    // R elevation, G moisture, B temperature
uniform sampler2D uStats;  // per sector: R colonies, G players online, B landable
uniform vec3 uSunLocal;
uniform vec3 uCamLocal;
uniform float uTime;
uniform float uHover;
uniform float uSelected;
uniform float uGrid;
varying vec3 vDir;
varying vec3 vPos;
${NOISE_GLSL}
${SPHERE_UV_GLSL}
${PIXEL_GLSL}
${CLOUDS_GLSL}

const vec2 SECTORS = vec2(${SECTOR_COLS}.0, ${SECTOR_ROWS}.0);
const vec2 MAP_STEP = vec2(1.0 / 400.0, 1.0 / 200.0);

float elevationAt(vec2 uv) { return texture2D(uMap, uv).r * 2.0 - 1.0; }

void main() {
  vec3 smoothDir = normalize(vDir);
  vec2 cell;
  vec3 d = snapDir(smoothDir, ${TEXELS}, cell);
  float dith = bayer4(cell) - 0.5;
  vec2 uv = dirToUv(d);
  vec3 climate = texture2D(uMap, uv).rgb;
  // Per-texel detail on top of the baked climate: ragged coasts and mottled biomes.
  float detail = fbm(d * 40.0);
  float e = climate.r * 2.0 - 1.0 + (detail - 0.5) * 0.08 + dith * 0.02;
  float m = climate.g + dith * 0.07;
  float t = climate.b + dith * 0.04;

  // --- palette pick (thresholds mirror classifyBiome) ---
  vec3 albedo;
  float water = 0.0;
  if (t < 0.14) albedo = vec3(0.80, 0.85, 0.90);
  else if (e < -0.3) { albedo = vec3(0.02, 0.06, 0.16); water = 1.0; }
  else if (e < -0.08) { albedo = vec3(0.03, 0.11, 0.22); water = 1.0; }
  else if (e < 0.0) { albedo = vec3(0.06, 0.20, 0.28); water = 1.0; }
  else if (e < 0.025) albedo = vec3(0.55, 0.49, 0.33);
  else if (e > 0.78) albedo = vec3(0.80, 0.85, 0.90);
  else if (t < 0.3) albedo = vec3(0.38, 0.40, 0.34);
  else if (e > 0.5) albedo = vec3(0.30, 0.27, 0.25);
  else if (m < 0.36) albedo = t > 0.5 ? vec3(0.62, 0.48, 0.29) : vec3(0.42, 0.28, 0.20);
  else if (m > 0.56) albedo = vec3(0.07, 0.19, 0.09);
  else albedo = vec3(0.26, 0.34, 0.14);

  // --- stepped lighting from the elevation gradient ---
  float cosLat = max(0.08, sqrt(1.0 - d.y * d.y));
  vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), d));
  vec3 north = cross(d, east);
  float dEdu = elevationAt(uv + vec2(MAP_STEP.x, 0.0)) - elevationAt(uv - vec2(MAP_STEP.x, 0.0));
  float dEdv = elevationAt(uv + vec2(0.0, MAP_STEP.y)) - elevationAt(uv - vec2(0.0, MAP_STEP.y));
  vec3 n = normalize(d - (east * dEdu / cosLat + north * dEdv) * 9.0 * (1.0 - water));
  vec3 L = normalize(uSunLocal);
  vec3 V = normalize(uCamLocal - vPos);
  float sunUp = dot(d, L);
  float lit = max(dot(n, L), 0.0) * smoothstep(-0.05, 0.12, sunUp);
  // Cloud shadows are cast by the same texels the cloud shell draws, displaced toward the sun.
  vec2 cloudCell;
  vec3 cloudDir = snapDir(cloudFrame(normalize(d + L * 0.016), uTime), ${TEXELS}, cloudCell);
  if (cloudAt(cloudDir, uTime) > 0.5) lit *= 0.5;
  float band = floor(clamp(lit * 1.2 + dith * 0.2, 0.0, 0.999) * 5.0) / 4.0;
  vec3 sunCol = sunUp < 0.12 ? vec3(1.0, 0.58, 0.32) : vec3(1.0, 0.97, 0.92);
  vec3 col = albedo * (0.035 * vec3(0.5, 0.7, 1.3) + band * 1.05 * sunCol);

  // Sun glint: a few hard bright pixels on open water.
  float glint = pow(max(dot(d, normalize(L + V)), 0.0), 140.0) * water;
  if (glint + dith * 0.25 > 0.5 && band > 0.0) col = vec3(1.0, 0.95, 0.82);

  // --- sharp atmospheric rim, in three bands ---
  float fres = pow(1.0 - max(dot(smoothDir, V), 0.0), 4.0);
  float rim = floor(clamp(fres * 1.6, 0.0, 0.999) * 4.0) / 3.0;
  vec3 scatter = sunUp < 0.1 ? vec3(1.0, 0.42, 0.18) : vec3(0.25, 0.5, 1.0);
  col += scatter * rim * (sunUp < 0.1 ? 0.2 : 0.34) * step(-0.08, dot(smoothDir, L));

  // --- sector grid, hover/selection and colony markers ---
  vec2 g = dirToUv(smoothDir) * SECTORS;
  vec2 sector = floor(g);
  vec2 f = fract(g);
  float id = sector.x + sector.y * SECTORS.x;
  vec3 stats = texture2D(uStats, (sector + 0.5) / SECTORS).rgb;
  // The longitude seam makes fwidth spike; clamp so it reads as a normal line.
  vec2 fw = min(max(fwidth(g), vec2(1e-4)), vec2(0.08));
  vec2 edge = min(f, 1.0 - f) / fw;
  float nearest = min(edge.x, edge.y);
  vec3 accent = stats.b > 0.5 ? vec3(0.93, 0.80, 0.50) : vec3(0.75, 0.30, 0.25);
  col += vec3(0.75, 0.68, 0.50) * step(nearest, 0.9) * 0.10 * uGrid;
  float isHover = 1.0 - step(0.5, abs(id - uHover));
  float isSel = 1.0 - step(0.5, abs(id - uSelected));
  float border = step(nearest, 2.2);
  col += accent * (isHover * (0.05 + border * 0.6) + isSel * (0.08 + border * (0.75 + 0.25 * sin(uTime * 4.0)))) * uGrid;

  // Colonies: a square marker by day (bright while someone is down there), firelight by night.
  vec2 c = abs(f - 0.5) * vec2(cosLat * 2.0, 1.0);
  float box = max(c.x, c.y);
  float colony = step(0.004, stats.r);
  float marker = step(0.16, box) * step(box, 0.22) * colony;
  col += (stats.g > 0.004 ? vec3(1.0, 0.75, 0.3) * (0.75 + 0.25 * sin(uTime * 5.0)) : vec3(0.6, 0.55, 0.42)) * marker * uGrid;
  if (colony > 0.5 && band == 0.0 && box < 0.12 && hash31(vec3(cell, 7.0)) > 0.45) col = vec3(1.0, 0.66, 0.3);

  gl_FragColor = vec4(col, 1.0);
}`;

/** Cloud shell: slightly above the surface, so it parallaxes against the terrain as the camera moves. */
export const CLOUD_VERT = /* glsl */ `
varying vec3 vDir;
varying vec3 vPos;
void main() {
  vDir = normalize(position);
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const CLOUD_FRAG = /* glsl */ `
uniform vec3 uSunLocal;
uniform float uTime;
uniform float uFade;
varying vec3 vDir;
varying vec3 vPos;
${NOISE_GLSL}
${PIXEL_GLSL}
${CLOUDS_GLSL}
void main() {
  vec3 d = normalize(vDir);
  vec3 L = normalize(uSunLocal);
  vec2 cell;
  vec3 r = snapDir(cloudFrame(d, uTime), ${TEXELS}, cell);
  float dith = bayer4(cell) - 0.5;
  float dens = cloudAt(r, uTime);
  // Hard-edged cloud pixels; the fade (used while diving through them) dissolves by dither.
  if (dens <= 0.5 || uFade < bayer4(cell) + 0.03) discard;
  float sunUp = dot(d, L);
  // Two tones: a lit top, and a shaded underside where thicker cloud lies toward the sun.
  vec2 unused;
  float toward = cloudAt(snapDir(cloudFrame(normalize(d + L * 0.03), uTime), ${TEXELS}, unused), uTime);
  float tone = toward > 0.75 ? 0.62 : 1.0;
  float band = floor(clamp(smoothstep(-0.1, 0.25, sunUp) + dith * 0.2, 0.0, 0.999) * 4.0) / 3.0;
  vec3 sunCol = sunUp < 0.12 ? vec3(1.0, 0.6, 0.38) : vec3(1.0);
  gl_FragColor = vec4(sunCol * band * tone * 0.92 + vec3(0.012, 0.016, 0.03), 1.0);
}`;

/** Atmosphere shell: additive rim in hard concentric bands, blue by day and amber where the sun grazes. */
export const ATMO_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const ATMO_FRAG = /* glsl */ `
uniform vec3 uSunDir;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 n = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float f = 1.0 - max(dot(n, V), 0.0);
  // Three stepped rings instead of a soft falloff.
  float glow = floor(clamp(pow(f, 3.0) * (1.0 - smoothstep(0.78, 0.98, f)) * 3.2, 0.0, 0.999) * 3.0) / 3.0;
  float sunUp = dot(n, normalize(uSunDir));
  vec3 col = sunUp < 0.08 ? vec3(1.0, 0.4, 0.15) : vec3(0.22, 0.46, 1.0);
  gl_FragColor = vec4(col * glow * 0.85 * step(-0.18, sunUp), 1.0);
}`;

/** Other bodies in the system: banded gas giants, mottled rock and ice, in the same pixel style. */
export const BODY_VERT = /* glsl */ `
varying vec3 vDir;
varying vec3 vN;
varying vec3 vW;
void main() {
  vDir = normalize(position);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const BODY_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uKind; // 0 rock, 1 gas, 2 ice
uniform float uTime;
varying vec3 vDir;
varying vec3 vN;
varying vec3 vW;
${NOISE_GLSL}
${PIXEL_GLSL}
void main() {
  vec2 cell;
  vec3 d = snapDir(normalize(vDir), 56.0, cell);
  float dith = bayer4(cell) - 0.5;
  float pattern;
  if (uKind > 0.5 && uKind < 1.5) {
    float turb = fbm(d * vec3(2.0, 7.0, 2.0) + vec3(uTime * 0.003, 0.0, 0.0));
    pattern = 0.5 + 0.5 * sin(d.y * 22.0 + turb * 7.0);
  } else {
    pattern = fbm(d * 5.0) * 1.3 - 0.15;
  }
  vec3 albedo = mix(uColorB, uColorA, floor(clamp(pattern + dith * 0.25, 0.0, 0.999) * 4.0) / 3.0);
  // Light the snapped direction (rotated into world space by the same matrix as the normal).
  vec3 n = normalize(vN);
  float lit = max(dot(n, normalize(uSunDir)), 0.0);
  float band = floor(clamp(lit * 1.2 + dith * 0.2, 0.0, 0.999) * 5.0) / 4.0;
  gl_FragColor = vec4(albedo * (0.02 + band * 1.3), 1.0);
}`;

/** Planetary ring: radial dust bands with a gap, darkened where the planet shadows it. */
export const RING_VERT = /* glsl */ `
varying vec2 vP;
varying vec3 vW;
void main() {
  vP = position.xy;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uSunDir;
uniform vec3 uPlanetPos;
uniform float uPlanetR;
uniform float uInner;
uniform float uOuter;
varying vec2 vP;
varying vec3 vW;
${NOISE_GLSL}
void main() {
  float k = (length(vP) - uInner) / (uOuter - uInner);
  float bands = 0.3 + 0.7 * vnoise(vec3(k * 30.0, 0.0, 0.0));
  bands *= smoothstep(0.0, 0.06, k) * smoothstep(1.0, 0.9, k);
  bands *= 1.0 - 0.9 * smoothstep(0.03, 0.0, abs(k - 0.58));
  // Ray from this ring particle toward the sun: if it hits the planet, we are in its shadow.
  vec3 oc = vW - uPlanetPos;
  float b = dot(oc, uSunDir);
  float lit = (b < 0.0 && b * b - dot(oc, oc) + uPlanetR * uPlanetR > 0.0) ? 0.06 : 1.0;
  gl_FragColor = vec4(uColor * bands * lit, bands * 0.85);
}`;

/** Star surface: granulation plus limb darkening, emitted well above 1.0 so the tone mapper blooms it. */
export const STAR_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
varying vec3 vDir;
varying vec3 vN;
varying vec3 vW;
${NOISE_GLSL}
void main() {
  vec3 d = normalize(vDir);
  float gran = floor((fbm(d * 9.0 + uTime * 0.02) * 0.6 + fbm3(d * 30.0 - uTime * 0.05) * 0.4) * 5.0) / 5.0;
  float mu = max(dot(normalize(vN), normalize(cameraPosition - vW)), 0.0);
  gl_FragColor = vec4(uColor * (2.2 + gran * 3.0) * (0.45 + 0.55 * mu), 1.0);
}`;

/** Camera-facing corona around the star. */
export const GLOW_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float g = exp(-r * 7.0) * 2.4 + exp(-r * 2.6) * 0.35;
  gl_FragColor = vec4(uColor * g * (1.0 - smoothstep(0.75, 1.0, r)), 1.0);
}`;

/** Procedural star field with a faint galactic band; drawn on a sphere that follows the camera. */
export const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
${NOISE_GLSL}
float starLayer(vec3 d, float scale, float density) {
  vec3 p = d * scale;
  vec3 cell = floor(p);
  float h = hash31(cell);
  if (h < density) return 0.0;
  vec3 centre = cell + 0.25 + 0.5 * vec3(hash31(cell + 11.0), hash31(cell + 23.0), hash31(cell + 37.0));
  float dist = length(p - centre);
  float bright = (h - density) / (1.0 - density);
  return step(dist, 0.09) * (0.25 + bright * bright * 2.2);
}
void main() {
  vec3 d = normalize(vDir);
  float band = exp(-pow(dot(d, normalize(vec3(0.25, 0.9, 0.35))) * 3.2, 2.0));
  float dust = fbm(d * 3.5 + 2.0);
  vec3 col = vec3(0.004, 0.005, 0.01);
  col += mix(vec3(0.05, 0.035, 0.07), vec3(0.03, 0.05, 0.09), dust) * band * dust * 0.45;
  col += vec3(0.05, 0.02, 0.06) * smoothstep(0.55, 0.9, fbm3(d * 2.0 - 4.0)) * 0.15;
  float density = 0.972 - band * 0.03;
  float s = starLayer(d, 170.0, density) + starLayer(d, 320.0, density) * 0.6 + starLayer(d, 90.0, 0.985) * 1.8;
  vec3 tint = mix(vec3(1.0, 0.82, 0.7), vec3(0.75, 0.86, 1.0), hash31(floor(d * 170.0) + 5.0));
  gl_FragColor = vec4(col + tint * s, 1.0);
}`;

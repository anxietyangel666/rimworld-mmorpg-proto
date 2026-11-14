import { CLOUDS_GLSL, NOISE_GLSL, SPHERE_UV_GLSL } from '../renderer-core/glsl';
import { SECTOR_COLS, SECTOR_ROWS } from '../world-gen/planet';

/**
 * Home planet surface. All lighting is done in the planet's object space
 * (uSunLocal / uCamLocal), so the planet can spin without re-deriving the
 * sector grid: a direction on the unit sphere is the lookup key for climate,
 * clouds and sectors alike.
 */
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
  vec3 p = d * uRadius * (1.0 + max(e, 0.0) * 0.014);
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
${CLOUDS_GLSL}

const vec2 SECTORS = vec2(${SECTOR_COLS}.0, ${SECTOR_ROWS}.0);
const vec2 MAP_TEXEL = vec2(1.0 / 1024.0, 1.0 / 512.0);

float elevationAt(vec2 uv) { return texture2D(uMap, uv).r * 2.0 - 1.0; }

void main() {
  vec3 d = normalize(vDir);
  vec2 uv = dirToUv(d);
  vec3 climate = texture2D(uMap, uv).rgb;
  // High-frequency procedural detail on top of the baked climate: fractal
  // coastlines and mottled biomes without a bigger texture.
  float detail = fbm(d * 42.0);
  float detail2 = fbm3(d * 17.0 + 5.0);
  float e = climate.r * 2.0 - 1.0 + (detail - 0.5) * 0.07;
  float m = climate.g + (detail2 - 0.5) * 0.12;
  float t = climate.b + (detail2 - 0.5) * 0.05;

  // --- biome ramp (thresholds mirror classifyBiome) ---
  vec3 desert = vec3(0.56, 0.44, 0.29), badlands = vec3(0.38, 0.27, 0.20);
  vec3 grass = vec3(0.23, 0.30, 0.15), forest = vec3(0.07, 0.16, 0.08);
  vec3 tundra = vec3(0.36, 0.36, 0.30), rock = vec3(0.31, 0.29, 0.27);
  float dry = 1.0 - smoothstep(0.33, 0.39, m);
  float wet = smoothstep(0.53, 0.59, m);
  vec3 land = mix(grass, forest, wet);
  land = mix(land, mix(badlands, desert, smoothstep(0.46, 0.54, t)), dry);
  land = mix(land, mix(badlands, rock, 0.5), smoothstep(0.44, 0.56, e));
  land = mix(land, tundra, 1.0 - smoothstep(0.27, 0.33, t));
  land = mix(vec3(0.50, 0.46, 0.35), land, smoothstep(0.0, 0.035, e));
  land *= 0.82 + detail * 0.36;
  float water = 1.0 - smoothstep(-0.006, 0.006, e);
  vec3 sea = mix(vec3(0.045, 0.17, 0.24), vec3(0.01, 0.035, 0.10), smoothstep(0.0, 0.4, -e));
  float snow = max(1.0 - smoothstep(0.12, 0.16, t), smoothstep(0.72, 0.9, e) * (1.0 - water));
  vec3 albedo = mix(mix(land, sea, water), vec3(0.84, 0.87, 0.91), snow);

  // --- normal from the elevation gradient plus fine bump ---
  float cosLat = max(0.08, sqrt(1.0 - d.y * d.y));
  vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), d));
  vec3 north = cross(d, east);
  float dEdu = elevationAt(uv + vec2(MAP_TEXEL.x, 0.0)) - elevationAt(uv - vec2(MAP_TEXEL.x, 0.0));
  float dEdv = elevationAt(uv + vec2(0.0, MAP_TEXEL.y)) - elevationAt(uv - vec2(0.0, MAP_TEXEL.y));
  float bumpE = fbm(d * 42.0 + east * 0.02) - detail;
  float bumpN = fbm(d * 42.0 + north * 0.02) - detail;
  vec3 grad = east * (dEdu * 22.0 / cosLat + bumpE * 9.0) + north * (dEdv * 22.0 + bumpN * 9.0);
  vec3 n = normalize(d - grad * (1.0 - water) * (1.0 - snow * 0.6));

  vec3 L = normalize(uSunLocal);
  vec3 V = normalize(uCamLocal - vPos);
  float sunUp = dot(d, L);
  // Wide, soft terminator; the geometric term keeps bumped normals from lighting the night side.
  float day = smoothstep(-0.12, 0.22, sunUp);
  float diffuse = max(dot(n, L), 0.0) * day;

  // Clouds cast shadows displaced along the sun direction (they float above the ground).
  float shadow = 1.0 - 0.62 * cloudDensity(normalize(d + L * 0.014), uTime);

  vec3 H = normalize(L + V);
  float spec = pow(max(dot(normalize(mix(n, d, 0.85)), H), 0.0), 90.0) * water * (1.0 - snow) * 1.6;
  vec3 sunCol = mix(vec3(1.0, 0.5, 0.25), vec3(1.0, 0.96, 0.9), smoothstep(0.0, 0.2, sunUp));
  vec3 col = albedo * (diffuse * sunCol * 1.15 * shadow + vec3(0.008, 0.012, 0.024)) + sunCol * spec * shadow * day;

  // --- atmosphere seen against the surface: Rayleigh rim, warm at the terminator ---
  float fres = pow(1.0 - max(dot(d, V), 0.0), 3.2);
  vec3 scatter = mix(vec3(1.0, 0.4, 0.16), vec3(0.22, 0.45, 1.0), smoothstep(-0.08, 0.14, sunUp));
  col += scatter * fres * smoothstep(-0.2, 0.2, sunUp) * 0.5;
  col += vec3(0.008, 0.016, 0.035) * day;

  // --- sector grid, hover/selection and colony markers ---
  vec2 g = uv * SECTORS;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  float id = cell.x + cell.y * SECTORS.x;
  vec3 stats = texture2D(uStats, (cell + 0.5) / SECTORS).rgb;
  vec2 fw = max(fwidth(g), vec2(1e-4));
  // The longitude seam makes fwidth spike; clamp so it reads as a normal line.
  fw = min(fw, vec2(0.08));
  vec2 edge = min(f, 1.0 - f) / fw;
  float line = 1.0 - smoothstep(0.6, 1.6, min(edge.x, edge.y));
  vec3 accent = stats.b > 0.5 ? vec3(0.25, 0.95, 0.85) : vec3(0.75, 0.3, 0.25);
  col += vec3(0.25, 0.8, 0.75) * line * 0.10 * uGrid;
  float isHover = 1.0 - step(0.5, abs(id - uHover));
  float isSel = 1.0 - step(0.5, abs(id - uSelected));
  float border = 1.0 - smoothstep(1.2, 3.0, min(edge.x, edge.y));
  col += accent * (isHover * (0.07 + border * 0.55) + isSel * (0.10 + border * (0.75 + 0.25 * sin(uTime * 4.0)))) * uGrid;

  // Colonies: a ring by day (amber when someone is online), warm lights by night.
  vec2 c = (f - 0.5) * vec2(cosLat * 2.0, 1.0);
  float rc = length(c);
  float colony = step(0.004, stats.r);
  float ring = (1.0 - smoothstep(0.02, 0.05, abs(rc - 0.2))) * colony;
  vec3 ringCol = stats.g > 0.004 ? vec3(1.0, 0.72, 0.25) * (0.75 + 0.25 * sin(uTime * 5.0)) : vec3(0.3, 0.75, 0.7);
  col += ringCol * ring * 0.9 * uGrid;
  float lights = colony * exp(-rc * rc * 60.0) * (0.5 + 0.5 * vnoise(vec3(f * 40.0, 1.0)));
  col += vec3(1.0, 0.7, 0.35) * lights * (1.0 - day) * 1.4;

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
uniform vec3 uCamLocal;
uniform float uTime;
uniform float uFade;
varying vec3 vDir;
varying vec3 vPos;
${NOISE_GLSL}
${CLOUDS_GLSL}
void main() {
  vec3 d = normalize(vDir);
  vec3 L = normalize(uSunLocal);
  float dens = cloudDensity(d, uTime);
  if (dens < 0.01) discard;
  float sunUp = dot(d, L);
  float day = smoothstep(-0.15, 0.25, sunUp);
  // Self-shadowing: thicker cloud toward the sun darkens this sample.
  float occl = cloudDensity(normalize(d + L * 0.02), uTime);
  float lit = mix(1.0, 0.55, occl * dens);
  vec3 sunCol = mix(vec3(1.0, 0.45, 0.2), vec3(1.0), smoothstep(0.0, 0.2, sunUp));
  vec3 col = sunCol * day * lit * 0.9 + vec3(0.01, 0.014, 0.025);
  float limb = pow(1.0 - max(dot(d, normalize(uCamLocal - vPos)), 0.0), 2.0);
  gl_FragColor = vec4(col, dens * (0.92 - limb * 0.3) * uFade);
}`;

/** Atmosphere shell: additive Fresnel glow, blue on the day side and amber where the sun grazes. */
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
  // Optical depth is longest at grazing angles; fade the very outer edge so the shell has no hard rim.
  float f = 1.0 - max(dot(n, V), 0.0);
  float glow = pow(f, 3.5) * (1.0 - smoothstep(0.7, 1.0, f)) * 1.0;
  float sunUp = dot(n, normalize(uSunDir));
  vec3 col = mix(vec3(1.0, 0.4, 0.15), vec3(0.22, 0.46, 1.0), smoothstep(-0.12, 0.16, sunUp));
  gl_FragColor = vec4(col * glow * smoothstep(-0.3, 0.25, sunUp), 1.0);
}`;

/** Other bodies in the system: banded gas giants, mottled rock and ice. */
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
void main() {
  vec3 d = normalize(vDir);
  float pattern;
  if (uKind > 0.5 && uKind < 1.5) {
    float turb = fbm(d * vec3(2.0, 7.0, 2.0) + vec3(uTime * 0.003, 0.0, 0.0));
    pattern = 0.5 + 0.5 * sin(d.y * 22.0 + turb * 7.0);
  } else {
    pattern = fbm(d * 5.0) * 1.3 - 0.15;
  }
  vec3 albedo = mix(uColorB, uColorA, clamp(pattern, 0.0, 1.0));
  vec3 n = normalize(vN);
  float sunUp = dot(n, normalize(uSunDir));
  vec3 col = albedo * (smoothstep(-0.08, 0.3, sunUp) * max(sunUp, 0.0) * 1.5 + 0.012);
  float f = pow(1.0 - max(dot(n, normalize(cameraPosition - vW)), 0.0), 3.0);
  col += mix(uColorA, vec3(0.5, 0.7, 1.0), 0.5) * f * smoothstep(-0.2, 0.3, sunUp) * (uKind > 0.5 ? 0.6 : 0.08);
  gl_FragColor = vec4(col, 1.0);
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
  float gran = fbm(d * 9.0 + uTime * 0.02) * 0.6 + fbm3(d * 30.0 - uTime * 0.05) * 0.4;
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
  return smoothstep(0.16, 0.0, dist) * (0.25 + bright * bright * 2.2);
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

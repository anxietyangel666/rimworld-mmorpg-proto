import * as THREE from 'three';
import { NOISE_GLSL, PIXEL_GLSL, VORONOI_GLSL } from '../renderer-core/glsl';
import { CHUNK_SIZE, WATER_LEVEL, type Surface } from '../world-gen/surface';
import { TILE_COLORS } from './palette';

/** Screen positions (framebuffer pixels) and depths of the people the view must never lose sight of. */
export interface CutUniforms {
  uCut: { value: THREE.Vector3[] };
  uCutN: { value: number };
  /** Radius of the cut-away, in framebuffer pixels. */
  uCutR: { value: number };
}

export const makeCutUniforms = (): CutUniforms => ({
  uCut: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) }, uCutN: { value: 0 }, uCutR: { value: 60 },
});

export interface PatchOptions {
  /** Unique per combination of options: materials with the same key share a compiled program. */
  key: string;
  /** World-space ground detail. */
  grit?: boolean;
  /** Wind sway for instanced vegetation. */
  sway?: boolean;
  /** Dither a hole in anything standing between the camera and a tracked person. */
  cut?: CutUniforms;
  /** 0..1 night factor: vertices with a `glow` attribute light up as it rises. */
  night?: { value: number };
  /** 0..1 dithered fade of the whole material, for roofs. */
  fade?: { value: number };
}

/**
 * Patch a standard material with the surface view's shared behaviour: ground
 * detail, drifting cloud shadow, wind sway, cut-away and night glow. All of it
 * is computed from world position, so it lines up across chunk and instance
 * boundaries.
 *
 * Everything is built to be temporally stable. Fine detail is quantised to a
 * fixed world-space texel grid and faded out by screen-space derivatives
 * before a texel gets smaller than a pixel; sway is slow and low-amplitude;
 * cut-aways and fades use an ordered dither rather than blending.
 */
export function patchMaterial(mat: THREE.MeshStandardMaterial, time: { value: number }, o: PatchOptions): void {
  mat.customProgramCacheKey = () => o.key;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    if (o.cut) Object.assign(shader.uniforms, o.cut);
    if (o.night) shader.uniforms.uNight = o.night;
    if (o.fade) shader.uniforms.uFade = o.fade;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        varying vec3 vGritPos;
        varying float vCutH;
        ${o.night ? 'attribute float glow;\nvarying float vGlow;' : ''}`)
      .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
        vCutH = position.y;
        ${o.night ? 'vGlow = glow;' : ''}
        ${o.sway ? /* glsl */ `
        #ifdef USE_INSTANCING
          // Trunks stay put; the crown leans a little, each tree on its own phase.
          float swayH = max(position.y - 0.45, 0.0);
          vec2 swayAt = instanceMatrix[3].xz;
          transformed.x += sin(uTime * 1.3 + swayAt.x * 0.7 + swayAt.y * 0.5) * 0.045 * swayH;
          transformed.z += cos(uTime * 1.05 + swayAt.x * 0.4 - swayAt.y * 0.3) * 0.03 * swayH;
        #endif` : ''}`)
      .replace('#include <project_vertex>', /* glsl */ `#include <project_vertex>
        vec4 gritW = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          gritW = instanceMatrix * gritW;
        #endif
        vGritPos = (modelMatrix * gritW).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        varying vec3 vGritPos;
        varying float vCutH;
        ${o.cut ? 'uniform vec3 uCut[8];\nuniform int uCutN;\nuniform float uCutR;' : ''}
        ${o.night ? 'uniform float uNight;\nvarying float vGlow;' : ''}
        ${o.fade ? 'uniform float uFade;' : ''}
        ${NOISE_GLSL}
        ${PIXEL_GLSL}`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        ${o.fade ? 'if (uFade < 0.995 && bayer4(gl_FragCoord.xy) >= uFade) discard;' : ''}
        ${o.cut ? /* glsl */ `
        if (vCutH > 0.5) {
          for (int i = 0; i < 8; i++) {
            if (i >= uCutN) break;
            // Only what is nearer the camera than the person can hide them.
            if (gl_FragCoord.z > uCut[i].z - 0.0004) continue;
            vec2 q = (gl_FragCoord.xy - uCut[i].xy) / uCutR;
            q.y *= 0.8;
            float r2 = dot(q, q);
            if (r2 < 1.0 && bayer4(gl_FragCoord.xy) < 1.25 - r2 * 1.1) discard;
          }
        }` : ''}
        ${o.grit ? /* glsl */ `
        float gritBroad = vnoise(vec3(vGritPos.xz * 0.3, 1.0));
        float gritMid = vnoise(vec3(vGritPos.xz * 1.7, 2.0));
        float texelPx = max(fwidth(vGritPos.x), fwidth(vGritPos.z)) * 6.0;
        float gritFine = (hash31(vec3(floor(vGritPos.xz * 6.0), 3.0)) - 0.5) * (1.0 - smoothstep(0.3, 0.8, texelPx));
        diffuseColor.rgb *= 0.74 + gritBroad * 0.3 + gritMid * 0.16 + gritFine * 0.1;` : ''}
        float cloudShade = smoothstep(0.5, 0.72, fbm3(vec3(vGritPos.xz * 0.02 + uTime * vec2(0.012, 0.005), 1.0)));
        diffuseColor.rgb *= 1.0 - cloudShade * 0.32;`);
    if (o.night) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * vGlow * (0.5 + uNight * 2.6);`);
    }
  };
}

/**
 * Heightfield mesh for one terrain chunk, in chunk-local coordinates. Colours
 * and normals are taken from the shared surface function rather than from the
 * chunk's own triangles, so neighbouring chunks meet without a visible seam.
 */
export function buildChunkGeometry(surface: Surface, cx: number, cy: number): THREE.BufferGeometry {
  const n = CHUNK_SIZE, w = n + 1;
  const pos = new Float32Array(w * w * 3), col = new Float32Array(w * w * 3), nor = new Float32Array(w * w * 3);
  const ox = cx * n, oy = cy * n;
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
    const k = (i + j * w) * 3, vx = ox + i, vy = oy + j;
    pos[k] = i; pos[k + 1] = surface.vertexHeight(vx, vy); pos[k + 2] = j;
    // A vertex takes the mean colour of the four tiles that share it, which blends ground types softly.
    let r = 0, g = 0, b = 0;
    for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) {
      const t = TILE_COLORS[surface.tile(vx + dx, vy + dy)];
      r += t.r; g += t.g; b += t.b;
    }
    col[k] = r / 4; col[k + 1] = g / 4; col[k + 2] = b / 4;
    const nx = surface.vertexHeight(vx - 1, vy) - surface.vertexHeight(vx + 1, vy);
    const nz = surface.vertexHeight(vx, vy - 1) - surface.vertexHeight(vx, vy + 1);
    const inv = 1 / Math.hypot(nx, 2, nz);
    nor[k] = nx * inv; nor[k + 1] = 2 * inv; nor[k + 2] = nz * inv;
  }
  const idx = new Uint16Array(n * n * 6);
  let o = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = i + j * w, b = a + w, c = a + 1, d = b + 1;
    idx[o++] = a; idx[o++] = b; idx[o++] = c;
    idx[o++] = c; idx[o++] = b; idx[o++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

/**
 * Water surface for one chunk, or null where the chunk is all dry land. It is a
 * flat sheet at the water level carrying, per vertex, how far below it the
 * ground lies; the shader turns that depth into colour, foam and caustics.
 */
export function buildWaterGeometry(surface: Surface, cx: number, cy: number): THREE.BufferGeometry | null {
  const n = CHUNK_SIZE, w = n + 1;
  const pos = new Float32Array(w * w * 3), depth = new Float32Array(w * w);
  let wet = false;
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
    const k = i + j * w;
    pos[k * 3] = i; pos[k * 3 + 1] = WATER_LEVEL; pos[k * 3 + 2] = j;
    depth[k] = WATER_LEVEL - surface.vertexHeight(cx * n + i, cy * n + j);
    if (depth[k] > 0) wet = true;
  }
  if (!wet) return null;
  // Only cells that touch water are emitted; the shader discards the dry part of shoreline cells.
  const idx: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = i + j * w, b = a + w, c = a + 1, d = b + 1;
    if (depth[a] <= 0 && depth[b] <= 0 && depth[c] <= 0 && depth[d] <= 0) continue;
    idx.push(a, b, c, c, b, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('depth', new THREE.BufferAttribute(depth, 1));
  geo.setIndex(idx);
  return geo;
}

export interface WaterUniforms { uSunDir: { value: THREE.Vector3 }; uViewDir: { value: THREE.Vector3 }; uNight: { value: number } }

/**
 * Pixel-art water. Every fragment is snapped to a world-space texel (eight to
 * a tile) and animation advances in steps, six a second, so the surface reads
 * as hand-animated pixels and nothing on it can shimmer between frames.
 *
 * Layers, bottom to top: depth absorption from clear shallows to slate-blue
 * deeps, pebbles and a caustic net on the bed where it is shallow, Voronoi
 * ripple crests, a banded sky reflection that darkens under cloud, hard sun
 * glints, and foam: a constant line at the water's edge plus rings that
 * travel out from it.
 */
export function makeWaterMaterial(time: { value: number }, u: WaterUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: time, ...u },
    vertexShader: /* glsl */ `
      attribute float depth;
      varying vec3 vW;
      varying float vDepth;
      void main() {
        vDepth = depth;
        vW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uNight;
      uniform vec3 uSunDir, uViewDir;
      varying vec3 vW;
      varying float vDepth;
      ${NOISE_GLSL}
      ${PIXEL_GLSL}
      ${VORONOI_GLSL}
      const float TEXELS = 8.0;
      void main() {
        float d = vDepth;
        if (d <= 0.0) discard;
        vec2 cell = floor(vW.xz * TEXELS);
        vec2 p = (cell + 0.5) / TEXELS;
        float t = floor(uTime * 6.0) / 6.0;
        float dith = bayer4(cell) - 0.5;

        // Depth absorption, in five dithered bands.
        float absorb = 1.0 - exp(-d * 5.0);
        float band = floor(clamp(absorb + dith * 0.14, 0.0, 0.999) * 5.0) / 4.0;
        vec3 col = mix(vec3(0.34, 0.44, 0.38), vec3(0.055, 0.10, 0.155), band);
        float alpha = mix(0.4, 0.95, band);
        float shallow = 1.0 - band;

        // The bed shows through the shallows: scattered pebbles and a drifting caustic net.
        float pebble = step(0.82, hash31(vec3(floor(p * 4.0), 5.0)));
        col *= 1.0 - pebble * shallow * 0.3;
        vec2 ca = voronoi(p * 2.6 + vec2(t * 0.22, -t * 0.16));
        col += step(ca.y - ca.x, 0.085) * shallow * step(0.04, d) * vec3(0.12, 0.13, 0.09);

        // Surface: ripple crests, and a wobbling normal for reflection and glint.
        vec2 rp = voronoi(p * 1.15 + vec2(-t * 0.12, t * 0.2));
        float crest = step(rp.y - rp.x, 0.05);
        vec3 n = normalize(vec3((vnoise(vec3(p * 1.7, t * 0.6)) - 0.5) * 0.55, 1.0, (vnoise(vec3(p * 1.7 + 9.0, t * 0.6)) - 0.5) * 0.55));
        float fres = pow(1.0 - max(dot(n, -uViewDir), 0.0), 3.0);
        // The same cloud field that shades the ground darkens the sky the water mirrors.
        float cloud = smoothstep(0.5, 0.72, fbm3(vec3(p * 0.02 + uTime * vec2(0.012, 0.005), 1.0)));
        vec3 sky = mix(vec3(0.50, 0.58, 0.64), vec3(0.27, 0.31, 0.35), cloud);
        float mirror = floor(clamp(0.2 + fres * 2.4 + crest * 0.12, 0.0, 0.999) * 4.0) / 4.0;
        col = mix(col, sky, mirror * 0.5) * (1.0 - cloud * 0.22);
        float glint = step(0.972, dot(reflect(uViewDir, n), uSunDir)) * (1.0 - cloud);
        col = mix(col, vec3(1.0, 0.96, 0.84), glint * 0.9);

        // Whitewater: a line where water meets land, and broken rings travelling out from it.
        float edge = 1.0 - step(0.03 + dith * 0.02, d);
        float ringAt = fract(t * 0.28 + vnoise(vec3(p * 0.55, 3.0))) * 0.22;
        float ring = step(abs(d - ringAt), 0.011) * (1.0 - ringAt / 0.22) * step(0.3, hash31(vec3(cell, 1.0)));
        float foam = max(edge, step(0.25, ring));
        col = mix(col, vec3(0.86, 0.88, 0.84), foam * 0.85);
        alpha = max(alpha, foam * 0.9);

        gl_FragColor = vec4(col * (1.0 - uNight * 0.6), alpha);
      }`,
  });
}

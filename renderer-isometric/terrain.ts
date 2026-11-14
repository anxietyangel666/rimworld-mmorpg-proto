import * as THREE from 'three';
import { NOISE_GLSL } from '../renderer-core/glsl';
import { CHUNK_SIZE, type Surface } from '../world-gen/surface';
import { TILE_COLORS } from './palette';

/**
 * Patch a standard material with world-space ground detail and drifting cloud
 * shadow. Both are computed from world position, so they line up across chunk
 * and instance boundaries.
 *
 * Detail is built to be temporally stable: the fine layer is quantised to a
 * fixed world-space texel grid and faded out by screen-space derivatives
 * before a texel gets smaller than a pixel, so it never aliases into shimmer
 * when the camera moves or zooms out.
 */
export function patchGround(mat: THREE.MeshStandardMaterial, time: { value: number }, grit: boolean): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGritPos;')
      .replace('#include <project_vertex>', /* glsl */ `#include <project_vertex>
        vec4 gritW = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          gritW = instanceMatrix * gritW;
        #endif
        vGritPos = (modelMatrix * gritW).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vGritPos;\n' + NOISE_GLSL)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        ${grit ? /* glsl */ `
        float gritBroad = vnoise(vec3(vGritPos.xz * 0.3, 1.0));
        float gritMid = vnoise(vec3(vGritPos.xz * 1.7, 2.0));
        float texelPx = max(fwidth(vGritPos.x), fwidth(vGritPos.z)) * 6.0;
        float gritFine = (hash31(vec3(floor(vGritPos.xz * 6.0), 3.0)) - 0.5) * (1.0 - smoothstep(0.3, 0.8, texelPx));
        diffuseColor.rgb *= 0.74 + gritBroad * 0.3 + gritMid * 0.16 + gritFine * 0.1;` : ''}
        float cloudShade = smoothstep(0.5, 0.72, fbm3(vec3(vGritPos.xz * 0.02 + uTime * vec2(0.012, 0.005), 1.0)));
        diffuseColor.rgb *= 1.0 - cloudShade * 0.32;`);
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

/** One large sheet of still, murky water that travels with the camera; its pattern is fixed in world space. */
export function buildWater(time: { value: number }): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uTime: time },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() { vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vW;
      ${NOISE_GLSL}
      void main() {
        // Low-frequency, slow ripples only: nothing here changes faster than a pixel can follow.
        float ripple = fbm3(vec3(vW.xz * 0.5 + vec2(uTime * 0.06, uTime * 0.035), uTime * 0.05));
        vec3 col = mix(vec3(0.035, 0.065, 0.075), vec3(0.1, 0.15, 0.16), smoothstep(0.3, 0.7, ripple));
        gl_FragColor = vec4(col, 0.88);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(260, 260).rotateX(-Math.PI / 2), mat);
  mesh.position.y = -0.22;
  return mesh;
}

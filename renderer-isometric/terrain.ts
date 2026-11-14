import * as THREE from 'three';
import { NOISE_GLSL } from '../renderer-core/glsl';
import { TileType, type SectorTerrain } from '../world-gen/sector';
import type { Palette } from './palette';

/**
 * Heightfield mesh for a sector. Colour comes from per-vertex tile blends; a
 * small shader patch on the standard material adds world-space grit and a
 * faint tile grid so the ground reads as worn terrain, not flat paint.
 */
export function buildTerrainMesh(t: SectorTerrain, pal: Palette): THREE.Mesh {
  const n = t.size, w = n + 1;
  const pos = new Float32Array(w * w * 3);
  const col = new Float32Array(w * w * 3);
  const tmp = new THREE.Color();
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const i = (x + y * w) * 3;
    pos[i] = x; pos[i + 1] = t.heights[x + y * w]; pos[i + 2] = y;
    // A vertex takes the mean colour of the tiles that share it, which blends biome patches softly.
    let r = 0, g = 0, b = 0, k = 0;
    for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) {
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
      tmp.copy(pal.tiles[t.tiles[tx + ty * n] as TileType]);
      r += tmp.r; g += tmp.g; b += tmp.b; k++;
    }
    col[i] = r / k; col[i + 1] = g / k; col[i + 2] = b / k;
  }
  const idx = new Uint32Array(n * n * 6);
  let o = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = x + y * w, b = a + w, c = a + 1, d = b + 1;
    idx[o++] = a; idx[o++] = b; idx[o++] = c;
    idx[o++] = c; idx[o++] = b; idx[o++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGritPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGritPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGritPos;\n' + NOISE_GLSL)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        float gritBroad = vnoise(vec3(vGritPos.xz * 0.3, 1.0));
        float gritMid = vnoise(vec3(vGritPos.xz * 2.3, 2.0));
        float gritFine = hash31(vec3(floor(vGritPos.xz * 14.0), 3.0));
        diffuseColor.rgb *= 0.68 + gritBroad * 0.3 + gritMid * 0.22 + gritFine * 0.12;
        vec2 tileEdge = abs(fract(vGritPos.xz) - 0.5);
        diffuseColor.rgb *= 1.0 - smoothstep(0.47, 0.5, max(tileEdge.x, tileEdge.y)) * 0.06;`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

/** Still, murky water with slow ripples. Returns null for sectors without any. */
export function buildWater(t: SectorTerrain, time: { value: number }): THREE.Mesh | null {
  if (!t.tiles.includes(TileType.Water)) return null;
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
        float ripple = fbm3(vec3(vW.xz * 0.9 + vec2(uTime * 0.12, uTime * 0.07), uTime * 0.15));
        float glint = smoothstep(0.62, 0.7, vnoise(vec3(vW.xz * 3.0 - uTime * 0.3, uTime * 0.4)));
        vec3 col = mix(vec3(0.035, 0.065, 0.075), vec3(0.09, 0.14, 0.15), ripple) + glint * 0.05;
        gl_FragColor = vec4(col, 0.86);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(t.size, t.size), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(t.size / 2, -0.2, t.size / 2);
  return mesh;
}

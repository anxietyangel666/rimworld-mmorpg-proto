import * as THREE from 'three';
import { NOISE_GLSL } from './glsl';

/**
 * Single-pass post pipeline shared by both views. Scenes render in linear HDR
 * to a multisampled target; one fullscreen pass then tone-maps, grades
 * (desaturation, tint, vignette, grain) and composites the atmospheric-entry
 * overlay, so the orbit-to-surface cut happens behind one continuous effect.
 */
export class PostFX {
  /** Colour grade. */
  desaturate = 0;
  vignette = 0.25;
  grain = 0.03;
  exposure = 1;
  contrast = 1;
  readonly tint = new THREE.Color(1, 1, 1);
  /** 0..1 cloud white-out and 0..1 re-entry glow used during the landing sequence. */
  cloud = 0;
  heat = 0;

  private readonly target: THREE.WebGLRenderTarget;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true });
    this.material = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: this.target.texture }, uTime: { value: 0 }, uAspect: { value: 1 },
        uDesat: { value: 0 }, uVignette: { value: 0 }, uGrain: { value: 0 }, uExposure: { value: 1 },
        uContrast: { value: 1 }, uTint: { value: this.tint }, uCloud: { value: 0 }, uHeat: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene;
        uniform float uTime, uAspect, uDesat, uVignette, uGrain, uExposure, uContrast, uCloud, uHeat;
        uniform vec3 uTint;
        varying vec2 vUv;
        ${NOISE_GLSL}
        void main() {
          vec3 c = max(texture2D(tScene, vUv).rgb, 0.0) * uExposure;
          // ACES-style filmic curve keeps the star and speculars from clipping.
          c = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
          float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(c, vec3(luma), uDesat) * uTint;
          c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);

          vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
          float r = length(q);
          c *= 1.0 - uVignette * smoothstep(0.35, 1.05, r);

          if (uCloud > 0.001 || uHeat > 0.001) {
            // Cloud deck rushing past: noise stretched radially and scrolled toward the viewer.
            float ang = atan(q.y, q.x);
            vec3 p = vec3(cos(ang) * 1.6, sin(ang) * 1.6, r * 3.0 - uTime * 2.4);
            float streak = fbm3(p * 1.4);
            float billow = fbm(vec3(q * (2.2 + uCloud), uTime * 0.7));
            float n = mix(billow, streak, 0.45);
            float a = clamp(n * 0.95 + uCloud * 1.95 - 0.95, 0.0, 1.0);
            c = mix(c, mix(vec3(0.60, 0.62, 0.64), vec3(0.93, 0.93, 0.91), n), a);
            c += vec3(1.0, 0.42, 0.12) * uHeat * (0.25 + streak) * smoothstep(0.15, 0.9, r);
          }

          c += (hash31(vec3(gl_FragCoord.xy, uTime * 60.0)) - 0.5) * uGrain;
          gl_FragColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
        }`,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.target.setSize(Math.max(1, Math.floor(width * pixelRatio)), Math.max(1, Math.floor(height * pixelRatio)));
    this.material.uniforms.uAspect.value = width / height;
  }

  render(scene: THREE.Scene, camera: THREE.Camera, time: number): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uDesat.value = this.desaturate;
    u.uVignette.value = this.vignette;
    u.uGrain.value = this.grain;
    u.uExposure.value = this.exposure;
    u.uContrast.value = this.contrast;
    u.uCloud.value = this.cloud;
    u.uHeat.value = this.heat;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCamera);
  }
}

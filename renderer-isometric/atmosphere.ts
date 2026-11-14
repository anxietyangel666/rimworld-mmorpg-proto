import * as THREE from 'three';
import { NOISE_GLSL } from '../renderer-core/glsl';
import type { Palette } from './palette';

/**
 * Atmosphere for the surface view, built from cheap layered volumes rather
 * than a ray-march: three drifting noise sheets at different heights (a dark
 * one hugging the ground for cloud shadow, two pale ones above head height for
 * haze) parallax against each other under the tilted camera, and a field of
 * dust motes fills the air between them.
 */
export class Atmosphere {
  readonly group = new THREE.Group();
  private readonly time = { value: 0 };
  private readonly dust: THREE.Points;
  private readonly dustCentre = { value: new THREE.Vector3() };
  private readonly dustScale = { value: 20 };

  constructor(size: number, pal: Palette) {
    const sheet = (y: number, color: THREE.Color, amount: number, scale: number, wind: THREE.Vector2, seed: number) => {
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false,
        uniforms: { uTime: this.time, uColor: { value: color }, uAmount: { value: amount }, uScale: { value: scale }, uWind: { value: wind }, uSeed: { value: seed } },
        vertexShader: /* glsl */ `
          varying vec3 vW;
          void main() { vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uTime, uAmount, uScale, uSeed;
          uniform vec3 uColor;
          uniform vec2 uWind;
          varying vec3 vW;
          ${NOISE_GLSL}
          void main() {
            vec2 p = vW.xz * uScale + uWind * uTime;
            float broad = fbm(vec3(p, uTime * 0.015 + uSeed));
            float wisps = fbm3(vec3(p * 3.1 - uWind * uTime * 1.6, uSeed + 4.0));
            float a = smoothstep(0.5, 0.86, broad + wisps * 0.3) * uAmount;
            gl_FragColor = vec4(uColor, a);
          }`,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size * 2.2, size * 2.2), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(size / 2, y, size / 2);
      mesh.renderOrder = 2;
      this.group.add(mesh);
    };
    sheet(0.35, new THREE.Color(0.02, 0.02, 0.025), 0.4, 0.022, new THREE.Vector2(0.012, 0.005), 1);
    sheet(2.6, pal.haze, 0.26 * pal.hazeAmount, 0.03, new THREE.Vector2(0.02, 0.008), 2);
    sheet(5.5, pal.haze, 0.34 * pal.hazeAmount, 0.018, new THREE.Vector2(0.014, 0.011), 3);

    // Dust motes live in a box that wraps around the camera target, so a few hundred points cover any view.
    const count = 420;
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
    this.dust = new THREE.Points(geo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: this.time, uCentre: this.dustCentre, uPx: this.dustScale, uColor: { value: pal.haze } },
      vertexShader: /* glsl */ `
        uniform float uTime, uPx;
        uniform vec3 uCentre;
        varying float vFade;
        void main() {
          vec3 box = vec3(70.0, 9.0, 70.0);
          vec3 drift = vec3(uTime * 0.6, sin(uTime * 0.3 + position.x * 40.0) * 0.4, uTime * 0.25);
          vec3 p = mod(position * box + drift - uCentre, box) - box * 0.5 + uCentre;
          p.y = mod(position.y * box.y + drift.y, box.y) + 0.3;
          vFade = 0.35 + 0.65 * fract(position.z * 91.7);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          gl_PointSize = max(1.0, uPx * (0.03 + 0.05 * fract(position.x * 57.3)));
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vFade;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          gl_FragColor = vec4(uColor * 0.2 * vFade * smoothstep(1.0, 0.2, d), 1.0);
        }`,
    }));
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 3;
    this.group.add(this.dust);
  }

  /** `pxPerUnit` keeps motes a constant world size under the orthographic zoom. */
  update(time: number, centre: THREE.Vector3, pxPerUnit: number): void {
    this.time.value = time;
    this.dustCentre.value.copy(centre);
    this.dustScale.value = pxPerUnit;
  }
}

/** Short-lived ground puffs: landing dust and order pings. */
export class Puffs {
  readonly group = new THREE.Group();
  private readonly live: { mesh: THREE.Mesh; age: number; life: number; grow: number; vx: number; vz: number; alpha: number }[] = [];
  private readonly geo = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);

  constructor(private readonly color: THREE.Color) {}

  /** Ring of dust rolling outward from a touchdown. */
  burst(x: number, y: number, z: number): void {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + Math.random() * 0.3, speed = 1.5 + Math.random() * 2.5;
      this.spawn(x, y + 0.3 + Math.random() * 0.6, z, 0.5 + Math.random() * 0.5, 2.2 + Math.random(), 1.3, Math.cos(a) * speed, Math.sin(a) * speed, 0.5);
    }
  }

  private spawn(x: number, y: number, z: number, size: number, life: number, grow: number, vx: number, vz: number, alpha: number): void {
    const mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: alpha, depthWrite: false }));
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(size);
    mesh.renderOrder = 3;
    this.group.add(mesh);
    this.live.push({ mesh, age: 0, life, grow, vx, vz, alpha });
  }

  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        this.group.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        this.live.splice(i, 1);
        continue;
      }
      const drag = Math.exp(-p.age * 1.6);
      p.mesh.position.x += p.vx * drag * dt;
      p.mesh.position.z += p.vz * drag * dt;
      p.mesh.scale.addScalar(p.grow * dt * (1 - k));
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = p.alpha * (1 - k) * Math.min(1, p.age * 6);
    }
  }
}

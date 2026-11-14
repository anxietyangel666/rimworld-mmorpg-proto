import * as THREE from 'three';
import { NOISE_GLSL } from '../renderer-core/glsl';

/**
 * Air between the camera and the ground: two pale haze sheets at different
 * heights that parallax against each other, and slow dust motes.
 *
 * Everything here is deliberately low-frequency and drawn without depth
 * testing. Haze that intersected terrain and trees used to leave crawling
 * edges where the sheet cut through geometry; drawn as a pure overlay it
 * cannot. Cloud shadow is not a sheet at all but part of the ground shader.
 */
export class Atmosphere {
  readonly group = new THREE.Group();
  readonly hazeColor = new THREE.Color(0.7, 0.72, 0.7);
  /** 0..1 overall haze strength. */
  amount = 0.5;
  private readonly time = { value: 0 };
  private readonly amounts: { value: number }[] = [];
  private readonly sheets: THREE.Mesh[] = [];
  private readonly dustCentre = { value: new THREE.Vector3() };
  private readonly dustPx = { value: 20 };

  constructor() {
    const sheet = (y: number, weight: number, scale: number, wind: THREE.Vector2, seed: number) => {
      const amount = { value: weight };
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, depthTest: false,
        uniforms: { uTime: this.time, uColor: { value: this.hazeColor }, uAmount: amount, uScale: { value: scale }, uWind: { value: wind }, uSeed: { value: seed } },
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
            float n = fbm3(vec3(vW.xz * uScale + uWind * uTime, uTime * 0.01 + uSeed));
            gl_FragColor = vec4(uColor, smoothstep(0.38, 0.8, n) * uAmount);
          }`,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(300, 300).rotateX(-Math.PI / 2), mat);
      mesh.position.y = y;
      mesh.renderOrder = 2;
      this.amounts.push(amount);
      this.sheets.push(mesh);
      this.group.add(mesh);
    };
    sheet(3, 0.34, 0.022, new THREE.Vector2(0.016, 0.006), 2);
    sheet(7, 0.46, 0.013, new THREE.Vector2(0.01, 0.009), 3);

    // Dust motes live in a box that wraps around the camera target, so a hundred points cover any view.
    const count = 110;
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
    const dust = new THREE.Points(geo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false,
      uniforms: { uTime: this.time, uCentre: this.dustCentre, uPx: this.dustPx, uColor: { value: this.hazeColor } },
      vertexShader: /* glsl */ `
        uniform float uTime, uPx;
        uniform vec3 uCentre;
        varying float vFade;
        void main() {
          vec3 box = vec3(70.0, 8.0, 70.0);
          vec3 drift = vec3(uTime * 0.35, 0.0, uTime * 0.15);
          vec3 p = mod(position * box + drift - uCentre, box) - box * 0.5 + uCentre;
          p.y = position.y * box.y + 0.5 + sin(uTime * 0.2 + position.x * 40.0) * 0.3;
          // Fade motes in and out at the box faces so none ever pops into view.
          vec3 edge = abs((p - uCentre) / (box * 0.5));
          vFade = (1.0 - smoothstep(0.8, 1.0, max(edge.x, edge.z))) * (0.4 + 0.6 * fract(position.z * 91.7));
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          // Never smaller than a few pixels: sub-pixel points are what sparkle.
          gl_PointSize = max(3.0, uPx * (0.1 + 0.08 * fract(position.x * 57.3)));
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vFade;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          gl_FragColor = vec4(uColor, 0.16 * vFade * (1.0 - smoothstep(0.1, 1.0, d)));
        }`,
    }));
    dust.frustumCulled = false;
    dust.renderOrder = 3;
    this.group.add(dust);
  }

  /** `pxPerUnit` keeps motes a constant world size under the orthographic zoom. */
  update(time: number, centre: THREE.Vector3, pxPerUnit: number): void {
    this.time.value = time;
    this.dustCentre.value.copy(centre);
    this.dustPx.value = pxPerUnit;
    this.amounts[0].value = 0.34 * this.amount;
    this.amounts[1].value = 0.46 * this.amount;
    for (const s of this.sheets) { s.position.x = Math.round(centre.x); s.position.z = Math.round(centre.z); }
  }
}

/** Short-lived ground puffs for the pod touchdown. */
export class Puffs {
  readonly group = new THREE.Group();
  private readonly live: { mesh: THREE.Mesh; age: number; life: number; vx: number; vz: number; alpha: number }[] = [];
  private readonly geo = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);

  constructor(private readonly color: THREE.Color) {}

  /** Ring of dust rolling outward from a touchdown. */
  burst(x: number, y: number, z: number): void {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + Math.random() * 0.3, speed = 1.5 + Math.random() * 2.5;
      const mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
      mesh.position.set(x, y + 0.5 + i * 0.01, z);
      mesh.scale.setScalar(0.6 + Math.random() * 0.4);
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.live.push({ mesh, age: 0, life: 2.2 + Math.random(), vx: Math.cos(a) * speed, vz: Math.sin(a) * speed, alpha: 0.4 });
    }
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
      p.mesh.scale.addScalar(1.3 * dt * (1 - k));
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = p.alpha * (1 - k) * Math.min(1, p.age * 4);
    }
  }
}

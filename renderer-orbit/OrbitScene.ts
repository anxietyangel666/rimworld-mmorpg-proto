import * as THREE from 'three';
import {
  bakePlanetMaps, planetPosition, SECTOR_COLS, SECTOR_COUNT, SECTOR_ROWS, sectorCenterDir, sectorFromDir, sectorInfo,
  type PlanetDesc, type SolarSystem,
} from '../world-gen';
import {
  ATMO_FRAG, ATMO_VERT, BODY_FRAG, BODY_VERT, CLOUD_FRAG, CLOUD_VERT, GLOW_FRAG, GLOW_VERT, PLANET_FRAG, PLANET_VERT,
  RING_FRAG, RING_VERT, SKY_FRAG, SKY_VERT, STAR_FRAG,
} from './shaders';

const HOME_RADIUS = 10;
const MIN_DIST = HOME_RADIUS * 1.45;
const MAX_DIST = 2600;
/** Seconds for one rotation of the home planet. */
const SPIN_PERIOD = 900;
const DESCENT_SECONDS = 3.4;

/**
 * Orbital view: the star, its planets and the shared home world with its
 * sector grid. Owns its camera rig (orbit / pan / zoom) and the first half of
 * the landing sequence, the dive from orbit into the chosen sector.
 */
export class OrbitScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 30000);
  hovered = -1;
  selected = -1;

  private readonly home = new THREE.Group();
  private readonly spin = new THREE.Group();
  private readonly planetMat: THREE.ShaderMaterial;
  private readonly cloudMat: THREE.ShaderMaterial;
  private readonly atmoMat: THREE.ShaderMaterial;
  private readonly statsTex: THREE.DataTexture;
  private readonly bodies: { desc: PlanetDesc; group: THREE.Group; mats: THREE.ShaderMaterial[] }[] = [];
  private readonly sky: THREE.Mesh;
  private readonly glow: THREE.Mesh;
  private readonly starMat: THREE.ShaderMaterial;
  private readonly sunDir = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private time = 0;

  // Camera rig: current values ease toward targets every frame.
  private yaw = 0; private pitch = 0.35; private dist = 46;
  private tYaw = 0; private tPitch = 0.35; private tDist = 46;
  private readonly pan = new THREE.Vector3();
  private readonly tPan = new THREE.Vector3();
  private descent: { sector: number; t: number; from: THREE.Vector3 } | null = null;

  constructor(private readonly system: SolarSystem, seed: number) {
    const homeDesc = system.planets[system.home];

    // --- sky and star ---
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(20000, 32, 16),
      new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false }),
    );
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    const starColor = new THREE.Color(...system.starColor);
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: BODY_VERT, fragmentShader: STAR_FRAG, uniforms: { uColor: { value: starColor }, uTime: { value: 0 } },
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(system.starRadius, 48, 24), this.starMat));
    this.glow = new THREE.Mesh(
      new THREE.PlaneGeometry(system.starRadius * 16, system.starRadius * 16),
      new THREE.ShaderMaterial({
        vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, uniforms: { uColor: { value: starColor } },
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
      }),
    );
    this.scene.add(this.glow);

    // --- home planet ---
    const mapW = 1024, mapH = 512;
    const map = new THREE.DataTexture(bakePlanetMaps(seed, mapW, mapH), mapW, mapH, THREE.RGBAFormat);
    map.wrapS = THREE.RepeatWrapping;
    map.magFilter = map.minFilter = THREE.NearestFilter;
    map.needsUpdate = true;

    const stats = new Uint8Array(SECTOR_COUNT * 4);
    for (let id = 0; id < SECTOR_COUNT; id++) stats[id * 4 + 2] = sectorInfo(seed, id).landable ? 255 : 0;
    this.statsTex = new THREE.DataTexture(stats, SECTOR_COLS, SECTOR_ROWS, THREE.RGBAFormat);
    this.statsTex.magFilter = this.statsTex.minFilter = THREE.NearestFilter;
    this.statsTex.needsUpdate = true;

    const shared = { uSunLocal: { value: new THREE.Vector3() }, uCamLocal: { value: new THREE.Vector3() }, uTime: { value: 0 } };
    this.planetMat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT, fragmentShader: PLANET_FRAG,
      uniforms: {
        ...shared, uMap: { value: map }, uStats: { value: this.statsTex }, uRadius: { value: HOME_RADIUS },
        uHover: { value: -1 }, uSelected: { value: -1 }, uGrid: { value: 1 },
      },
    });
    const planet = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), this.planetMat);
    planet.frustumCulled = false;
    this.cloudMat = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG, uniforms: { ...shared, uFade: { value: 1 } },
      // Opaque cut-out pixels: no blending, so no sorting artefacts against the surface.
    });
    const clouds = new THREE.Mesh(new THREE.SphereGeometry(HOME_RADIUS * 1.022, 128, 64), this.cloudMat);
    this.atmoMat = new THREE.ShaderMaterial({
      vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG, uniforms: { uSunDir: { value: this.sunDir } },
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    });
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(HOME_RADIUS * 1.055, 96, 48), this.atmoMat);
    this.spin.add(planet, clouds);
    this.home.add(this.spin, atmo);
    this.scene.add(this.home);

    // --- the rest of the system ---
    system.planets.forEach((desc, i) => {
      this.scene.add(this.makeOrbitLine(desc.orbitRadius, i === system.home));
      if (i === system.home) return;
      const group = new THREE.Group();
      const kind = desc.kind === 'gas' ? 1 : desc.kind === 'ice' ? 2 : 0;
      const mat = new THREE.ShaderMaterial({
        vertexShader: BODY_VERT, fragmentShader: BODY_FRAG,
        uniforms: {
          uSunDir: { value: new THREE.Vector3() }, uColorA: { value: new THREE.Color(...desc.colorA) },
          uColorB: { value: new THREE.Color(...desc.colorB) }, uKind: { value: kind }, uTime: { value: 0 },
        },
      });
      const mats = [mat];
      group.add(new THREE.Mesh(new THREE.SphereGeometry(desc.radius, 64, 32), mat));
      if (desc.rings) {
        const inner = desc.radius * 1.35, outer = desc.radius * 2.3;
        const ringMat = new THREE.ShaderMaterial({
          vertexShader: RING_VERT, fragmentShader: RING_FRAG, side: THREE.DoubleSide, transparent: true, depthWrite: false,
          uniforms: {
            uColor: { value: new THREE.Color(...desc.colorA).multiplyScalar(0.9) }, uSunDir: mat.uniforms.uSunDir,
            uPlanetPos: { value: group.position }, uPlanetR: { value: desc.radius }, uInner: { value: inner }, uOuter: { value: outer },
          },
        });
        const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 160, 1), ringMat);
        ring.rotation.set(-Math.PI / 2 + 0.42, 0, 0.2);
        group.add(ring);
        mats.push(ringMat);
      }
      this.scene.add(group);
      this.bodies.push({ desc, group, mats });
    });

    // Open on the day side with the terminator in view.
    const p = planetPosition(homeDesc, 0);
    this.yaw = this.tYaw = Math.atan2(-p[2], -p[0]) + 0.95;
    this.update(0);
  }

  private makeOrbitLine(radius: number, highlight: boolean): THREE.LineLoop {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 256; i++) pts.push(new THREE.Vector3(Math.cos((i / 256) * Math.PI * 2) * radius, 0, Math.sin((i / 256) * Math.PI * 2) * radius));
    return new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: highlight ? 0x1c5a5a : 0x1a2630, transparent: true, opacity: 0.55 }),
    );
  }

  // --- input ---------------------------------------------------------------

  rotate(dx: number, dy: number): void {
    this.tYaw += dx * 0.005;
    this.tPitch = THREE.MathUtils.clamp(this.tPitch + dy * 0.005, -1.45, 1.45);
  }

  /** Slide the look-at point in the view plane; double-click recentres via resetPan(). */
  panBy(dx: number, dy: number): void {
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const k = this.dist * 0.0012;
    this.tPan.addScaledVector(right, -dx * k).addScaledVector(up, dy * k).clampLength(0, 600);
  }

  resetPan(): void {
    this.tPan.set(0, 0, 0);
  }

  zoom(deltaY: number): void {
    this.tDist = THREE.MathUtils.clamp(this.tDist * Math.exp(deltaY * 0.0012), MIN_DIST, MAX_DIST);
  }

  /** Sector under the given normalised device coordinates, or -1 when the planet is not hit. */
  pick(ndcX: number, ndcY: number): number {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = this.raycaster.ray.intersectSphere(new THREE.Sphere(this.home.position, HOME_RADIUS), new THREE.Vector3());
    if (!hit) return -1;
    const d = this.spin.worldToLocal(hit).normalize();
    return sectorFromDir(d.x, d.y, d.z);
  }

  /** Feed live per-sector colony and player counts into the planet shader. */
  setSectorStats(statsBySector: Map<number, { online: number; colonies: number }>): void {
    const data = this.statsTex.image.data as Uint8Array;
    for (let id = 0; id < SECTOR_COUNT; id++) {
      const s = statsBySector.get(id);
      data[id * 4] = s && s.colonies > 0 ? 255 : 0;
      data[id * 4 + 1] = s && s.online > 0 ? 255 : 0;
    }
    this.statsTex.needsUpdate = true;
  }

  // --- landing dive ----------------------------------------------------------

  beginDescent(sector: number): void {
    this.selected = sector;
    this.descent = { sector, t: 0, from: this.camera.position.clone().sub(this.home.position) };
  }

  /** 0..1 progress of the dive, or -1 when not descending. */
  get descentProgress(): number {
    return this.descent ? Math.min(1, this.descent.t / DESCENT_SECONDS) : -1;
  }

  endDescent(): void {
    this.descent = null;
    this.cloudMat.uniforms.uFade.value = 1;
    this.planetMat.uniforms.uGrid.value = 1;
  }

  // --- frame -----------------------------------------------------------------

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    const homeDesc = this.system.planets[this.system.home];
    this.home.position.set(...planetPosition(homeDesc, t));
    // The planet stops turning during the dive so the target sector stays put.
    if (!this.descent) this.spin.rotation.y = (t / SPIN_PERIOD) * Math.PI * 2;
    this.spin.updateMatrixWorld(true);
    this.sunDir.copy(this.home.position).multiplyScalar(-1).normalize();

    for (const b of this.bodies) {
      b.group.position.set(...planetPosition(b.desc, t));
      (b.mats[0].uniforms.uSunDir.value as THREE.Vector3).copy(b.group.position).multiplyScalar(-1).normalize();
      b.mats[0].uniforms.uTime.value = t;
    }

    if (this.descent) this.updateDescent(dt);
    else {
      const k = 1 - Math.exp(-dt * 9);
      this.yaw += (this.tYaw - this.yaw) * k;
      this.pitch += (this.tPitch - this.pitch) * k;
      this.dist *= Math.pow(this.tDist / this.dist, k);
      this.pan.lerp(this.tPan, k);
      const target = this.home.position.clone().add(this.pan);
      const cp = Math.cos(this.pitch);
      this.camera.position.set(Math.cos(this.yaw) * cp, Math.sin(this.pitch), Math.sin(this.yaw) * cp).multiplyScalar(this.dist).add(target);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(target);
      // The grid is a close-range tool; fade it out as the view pulls back to the whole system.
      this.planetMat.uniforms.uGrid.value = 1 - THREE.MathUtils.smoothstep(this.dist, 90, 220);
    }
    // Keep depth precision usable from low orbit out to the edge of the system.
    this.camera.near = Math.max(0.02, this.camera.position.distanceTo(this.home.position) * 0.01);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    const inv = this.spin.quaternion.clone().invert();
    (this.planetMat.uniforms.uSunLocal.value as THREE.Vector3).copy(this.sunDir).applyQuaternion(inv);
    (this.planetMat.uniforms.uCamLocal.value as THREE.Vector3).copy(this.camera.position).sub(this.home.position).applyQuaternion(inv);
    this.planetMat.uniforms.uTime.value = t;
    this.planetMat.uniforms.uHover.value = this.hovered;
    this.planetMat.uniforms.uSelected.value = this.selected;
    this.starMat.uniforms.uTime.value = t;
    this.sky.position.copy(this.camera.position);
    this.glow.quaternion.copy(this.camera.quaternion);
  }

  private updateDescent(dt: number): void {
    const d = this.descent!;
    d.t += dt;
    const k = Math.min(1, d.t / DESCENT_SECONDS);
    const ease = k * k * (3 - 2 * k);
    const [sx, sy, sz] = sectorCenterDir(d.sector);
    const goal = new THREE.Vector3(sx, sy, sz).applyQuaternion(this.spin.quaternion);
    // Swing over the sector early, then fall: direction settles well before altitude does.
    const dir = d.from.clone().normalize().lerp(goal, THREE.MathUtils.smoothstep(k, 0, 0.6)).normalize();
    const alt = (d.from.length() - HOME_RADIUS) * Math.pow(1 - ease, 2.4) + HOME_RADIUS * 0.035;
    this.camera.position.copy(dir).multiplyScalar(HOME_RADIUS + alt).add(this.home.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.home.position);
    this.planetMat.uniforms.uGrid.value = 1 - THREE.MathUtils.smoothstep(k, 0.3, 0.6);
    // We pass through the cloud shell, so it thins out around the camera instead of clipping.
    this.cloudMat.uniforms.uFade.value = 1 - THREE.MathUtils.smoothstep(k, 0.55, 0.8);
  }
}

import * as THREE from 'three';
import { EntityKind, STRUCTURES, StructureKind, UnitState } from '../game-sim/components';
import { Pathfinder } from '../game-sim/pathfinding';
import type { MirrorEntity } from '../network/mirror';
import type { Biome } from '../world-gen/planet';
import { generateSector, heightAt, SECTOR_SIZE, type SectorTerrain } from '../world-gen/sector';
import { makePod, makeStructure, makeUnit, type PodView, type StructureView, type UnitView } from './actors';
import { Atmosphere, Puffs } from './atmosphere';
import { TacticalOverlay } from './overlays';
import { paletteFor, playerColor, type Palette } from './palette';
import { PropLayer } from './props';
import { buildTerrainMesh, buildWater } from './terrain';

/** Server ticks a drop pod takes from sky to ground. Crew deploy shortly after (POD_DEPLOY_TICKS). */
export const POD_FALL_TICKS = 50;

const ISO_PITCH = THREE.MathUtils.degToRad(42);
const ISO_YAW = Math.PI / 4;
const INTRO_SECONDS = 3.6;
const MIN_VIEW = 9, MAX_VIEW = 64;
const SUN_OFFSET = new THREE.Vector3(-38, 46, 22);
const GHOST_EDGES: Record<StructureKind, THREE.BufferGeometry> = {
  [StructureKind.Wall]: new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1.25, 1).translate(0, 0.625, 0)),
  [StructureKind.Floor]: new THREE.EdgesGeometry(new THREE.BoxGeometry(0.98, 0.08, 0.98).translate(0, 0.04, 0)),
  [StructureKind.Beacon]: new THREE.EdgesGeometry(new THREE.BoxGeometry(0.7, 2.4, 0.7).translate(0, 1.2, 0)),
};
const STATE_LABEL: Record<UnitState, string> = {
  [UnitState.Idle]: '', [UnitState.Moving]: '', [UnitState.Harvesting]: 'HARVEST', [UnitState.Building]: 'BUILD',
};

interface View {
  e: MirrorEntity;
  unit?: UnitView;
  pod?: PodView;
  structure?: StructureView;
  plate?: { root: HTMLElement; hp: HTMLElement; tag: HTMLElement };
  /** Pod only: whether touchdown effects have played. */
  landed?: boolean;
}

export interface IsoOptions {
  seed: number;
  sectorId: number;
  biome: Biome;
  /** Local player id, to tell own units from everyone else's. */
  playerId: number;
  /** DOM layer that unit name plates are appended to. */
  plateRoot: HTMLElement;
  ownerName: (playerId: number) => string;
}

/**
 * Surface view of one sector: a true 3D scene under an orthographic camera
 * locked to an isometric angle. Renders replicated entities from the network
 * mirror; owns the camera rig, ground picking and the client-side blocked grid
 * used to predict routes before the server confirms them.
 */
export class IsoScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 800);
  readonly terrain: SectorTerrain;
  readonly palette: Palette;
  /** Ground point the camera looks at. */
  readonly target = new THREE.Vector3(SECTOR_SIZE / 2, 0, SECTOR_SIZE / 2);
  readonly selection = new Set<number>();

  private readonly views = new Map<number, View>();
  private readonly props: PropLayer;
  private readonly overlay: TacticalOverlay;
  private readonly atmosphere: Atmosphere;
  private readonly puffs: Puffs;
  private readonly sun: THREE.DirectionalLight;
  private readonly waterTime = { value: 0 };
  private readonly blocked: Uint8Array;
  private readonly pathfinder: Pathfinder;
  private readonly predictions = new Map<number, { pts: number[]; until: number }>();
  private readonly tmp = new THREE.Vector3();

  private width = 1; private height = 1;
  private viewSize = 21; private tViewSize = 21;
  private yaw = ISO_YAW; private tYaw = ISO_YAW;
  private pitch = ISO_PITCH;
  private intro = -1;
  private shadowExtent = 0;

  constructor(private readonly opts: IsoOptions) {
    this.terrain = generateSector(opts.seed, opts.sectorId, opts.biome);
    this.palette = paletteFor(opts.biome);
    const pal = this.palette;
    this.blocked = Uint8Array.from(this.terrain.blocked);
    this.pathfinder = new Pathfinder(SECTOR_SIZE, this.blocked);

    this.scene.background = pal.haze.clone().multiplyScalar(0.16);
    this.scene.add(buildTerrainMesh(this.terrain, pal));
    const water = buildWater(this.terrain, this.waterTime);
    if (water) this.scene.add(water);
    this.props = new PropLayer(this.terrain, pal);
    this.overlay = new TacticalOverlay(this.terrain);
    this.atmosphere = new Atmosphere(SECTOR_SIZE, pal);
    this.puffs = new Puffs(pal.haze.clone().multiplyScalar(0.8));
    this.scene.add(this.props.group, this.atmosphere.group, this.puffs.group, this.overlay.group);

    // Low sun for long, soft shadows; a sky/ground hemisphere fills them so they stay readable.
    this.sun = new THREE.DirectionalLight(pal.sun, pal.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.05;
    this.sun.shadow.radius = 5;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 220;
    this.scene.add(this.sun, this.sun.target, new THREE.HemisphereLight(pal.sky, pal.bounce, 0.8));
  }

  // --- replicated entities ---------------------------------------------------

  spawn(e: MirrorEntity): void {
    const s = e.state;
    const view: View = { e };
    this.views.set(s.id, view);
    if (s.kind === EntityKind.Unit && s.unit) {
      const own = s.unit.owner === this.opts.playerId;
      view.unit = makeUnit(playerColor(s.unit.owner, own));
      this.scene.add(view.unit.group);
      view.plate = this.makePlate(own);
    } else if (s.kind === EntityKind.Pod && s.pod) {
      view.pod = makePod(playerColor(s.pod.owner, s.pod.owner === this.opts.playerId));
      view.pod.group.position.set(s.x, heightAt(this.terrain, s.x, s.y), s.y);
      this.scene.add(view.pod.group);
      this.setBlocked(s.x, s.y, true);
    } else if (s.kind === EntityKind.Structure && s.structure) {
      view.structure = makeStructure(s.structure.kind);
      view.structure.group.position.set(s.x, heightAt(this.terrain, s.x, s.y), s.y);
      this.scene.add(view.structure.group);
    }
    this.change(e);
  }

  change(e: MirrorEntity): void {
    const s = e.state;
    const view = this.views.get(s.id);
    if (!view) return;
    view.e = e;
    if (s.node) {
      this.props.set(s.id, s.node.kind, s.x, s.y, s.node.amount);
      this.setBlocked(s.x, s.y, true);
    } else if (s.structure && view.structure) {
      view.structure.setState(s.structure.progress, s.structure.built);
      if (s.structure.built && STRUCTURES[s.structure.kind].blocks) this.setBlocked(s.x, s.y, true);
    } else if (s.unit && view.plate) {
      const own = s.unit.owner === this.opts.playerId;
      const label = STATE_LABEL[s.unit.state];
      view.plate.tag.textContent = (own ? s.unit.name : s.unit.name + ' · ' + this.opts.ownerName(s.unit.owner)) + (label ? '  ' + label : '');
      view.plate.hp.style.width = Math.round((s.unit.hp / s.unit.maxHp) * 100) + '%';
      // The server's route supersedes any local prediction.
      if (s.unit.path.length > 0) this.predictions.delete(s.id);
    }
  }

  despawn(e: MirrorEntity): void {
    const s = e.state;
    const view = this.views.get(s.id);
    if (!view) return;
    this.views.delete(s.id);
    this.selection.delete(s.id);
    if (view.unit) this.scene.remove(view.unit.group);
    if (view.pod) this.scene.remove(view.pod.group);
    if (view.structure) this.scene.remove(view.structure.group);
    view.plate?.root.remove();
    this.overlay.removePath(s.id);
    if (s.node) {
      this.props.delete(s.id);
      this.setBlocked(s.x, s.y, false);
    }
  }

  private makePlate(own: boolean): View['plate'] {
    const root = document.createElement('div');
    root.className = own ? 'plate own' : 'plate';
    const tag = document.createElement('span');
    const bar = document.createElement('div');
    bar.className = 'hp';
    const hp = document.createElement('i');
    bar.append(hp);
    root.append(tag, bar);
    this.opts.plateRoot.append(root);
    return { root, hp, tag };
  }

  private setBlocked(x: number, y: number, on: boolean): void {
    const i = Math.floor(x) + Math.floor(y) * SECTOR_SIZE;
    this.blocked[i] = on ? 1 : this.terrain.blocked[i];
  }

  // --- camera ----------------------------------------------------------------

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** Start the touchdown shot: straight down from high altitude, easing into the isometric angle. */
  startIntro(): void {
    this.intro = 0;
  }

  get introActive(): boolean {
    return this.intro >= 0;
  }

  focus(x: number, y: number): void {
    this.target.set(x, 0, y);
  }

  /** Drag the ground under the cursor by a pixel delta. */
  pan(dxPx: number, dyPx: number): void {
    const unitsPerPx = this.viewSize / this.height;
    // Screen-right and screen-up directions projected onto the ground plane.
    const rx = Math.sin(this.yaw), rz = -Math.cos(this.yaw);
    const fx = -Math.cos(this.yaw), fz = -Math.sin(this.yaw);
    const fwd = (dyPx * unitsPerPx) / Math.sin(this.pitch);
    this.target.x += rx * -dxPx * unitsPerPx + fx * fwd;
    this.target.z += rz * -dxPx * unitsPerPx + fz * fwd;
    this.clampTarget();
  }

  zoom(deltaY: number): void {
    this.tViewSize = THREE.MathUtils.clamp(this.tViewSize * Math.exp(deltaY * 0.0012), MIN_VIEW, MAX_VIEW);
  }

  /** Rotate the view a quarter turn; dir is +1 or -1. */
  rotate(dir: number): void {
    this.tYaw += (dir * Math.PI) / 2;
  }

  private clampTarget(): void {
    this.target.x = THREE.MathUtils.clamp(this.target.x, 4, SECTOR_SIZE - 4);
    this.target.z = THREE.MathUtils.clamp(this.target.z, 4, SECTOR_SIZE - 4);
  }

  private applyCamera(dt: number): void {
    const k = 1 - Math.exp(-dt * 10);
    this.viewSize += (this.tViewSize - this.viewSize) * k;
    this.yaw += (this.tYaw - this.yaw) * k;
    let view = this.viewSize, pitch = ISO_PITCH, yaw = this.yaw;
    if (this.intro >= 0) {
      this.intro += dt / INTRO_SECONDS;
      const t = Math.min(1, this.intro);
      const ease = 1 - Math.pow(1 - t, 3);
      view = THREE.MathUtils.lerp(260, this.viewSize, ease);
      pitch = THREE.MathUtils.lerp(THREE.MathUtils.degToRad(88), ISO_PITCH, ease * ease * (3 - 2 * ease));
      yaw = this.yaw - (1 - ease) * 0.9;
      if (this.intro >= 1) this.intro = -1;
    }
    this.pitch = pitch;
    const aspect = this.width / this.height;
    const cam = this.camera;
    cam.left = (-view * aspect) / 2; cam.right = (view * aspect) / 2;
    cam.top = view / 2; cam.bottom = -view / 2;
    cam.updateProjectionMatrix();
    this.target.y = heightAt(this.terrain, this.target.x, this.target.z);
    const cp = Math.cos(pitch);
    cam.position.set(Math.cos(yaw) * cp, Math.sin(pitch), Math.sin(yaw) * cp).multiplyScalar(300).add(this.target);
    cam.lookAt(this.target);
    cam.updateMatrixWorld(true);

    // The shadow frustum follows the view, snapped to whole units so shadow texels do not swim.
    const extent = THREE.MathUtils.clamp(Math.ceil(view * 0.95 * Math.max(1, aspect * 0.7)), 18, 90);
    if (extent !== this.shadowExtent) {
      this.shadowExtent = extent;
      const sc = this.sun.shadow.camera;
      sc.left = -extent; sc.right = extent; sc.top = extent; sc.bottom = -extent;
      sc.updateProjectionMatrix();
    }
    this.sun.target.position.set(Math.round(this.target.x), 0, Math.round(this.target.z));
    this.sun.position.copy(this.sun.target.position).add(SUN_OFFSET);
  }

  /** 0..1 touchdown shot progress while it plays, else 1. */
  get introProgress(): number {
    return this.intro >= 0 ? Math.min(1, this.intro) : 1;
  }

  // --- picking and projection ------------------------------------------------

  /** Ground point (tile coordinates) under normalised device coordinates. */
  groundAt(ndcX: number, ndcY: number): { x: number; y: number } | null {
    const origin = this.tmp.set(ndcX, ndcY, -1).unproject(this.camera).clone();
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    if (dir.y > -1e-4) return null;
    // Terrain relief is gentle, so a few plane re-intersections converge on the heightfield.
    let h = 0, x = 0, z = 0;
    for (let i = 0; i < 4; i++) {
      const t = (h - origin.y) / dir.y;
      x = origin.x + dir.x * t; z = origin.z + dir.z * t;
      h = heightAt(this.terrain, x, z);
    }
    if (x < 0 || z < 0 || x >= SECTOR_SIZE || z >= SECTOR_SIZE) return null;
    return { x, y: z };
  }

  /** Screen position in CSS pixels of a point `up` units above the ground. */
  screenOf(x: number, y: number, up = 0): { x: number; y: number } {
    const v = this.tmp.set(x, heightAt(this.terrain, x, y) + up, y).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height };
  }

  /** Harvestable node or unfinished structure on a tile. */
  targetAtTile(tx: number, ty: number): MirrorEntity | null {
    for (const v of this.views.values()) {
      const s = v.e.state;
      if (Math.floor(s.x) !== tx || Math.floor(s.y) !== ty) continue;
      if (s.node || (s.structure && !s.structure.built && s.structure.owner === this.opts.playerId)) return v.e;
    }
    return null;
  }

  /** True when a structure could be placed on the tile, as far as this client knows. */
  canBuildAt(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= SECTOR_SIZE || ty >= SECTOR_SIZE || this.blocked[tx + ty * SECTOR_SIZE]) return false;
    for (const v of this.views.values()) {
      const s = v.e.state;
      if (s.kind !== EntityKind.Unit && Math.floor(s.x) === tx && Math.floor(s.y) === ty) return false;
    }
    return true;
  }

  // --- tactical overlays -----------------------------------------------------

  /**
   * Client-side prediction of a move order: plan the route locally with the
   * same pathfinder the server runs and show it at once, instead of waiting a
   * round trip for the authoritative path.
   */
  predictMove(unitIds: number[], x: number, y: number, nowMs: number): void {
    for (const id of unitIds) {
      const e = this.views.get(id)?.e;
      if (!e) continue;
      const pts = this.pathfinder.findPath(e.rx, e.ry, x, y);
      if (pts) this.predictions.set(id, { pts, until: nowMs + 600 });
    }
    this.overlay.ping(x, y);
  }

  setHover(tx: number, ty: number, visible: boolean): void {
    this.overlay.setHover(tx, ty, visible);
  }

  setGhost(kind: StructureKind | null, tx: number, ty: number): void {
    this.overlay.setGhost(kind === null ? null : GHOST_EDGES[kind], tx, ty, kind !== null && this.canBuildAt(tx, ty));
  }

  // --- frame -----------------------------------------------------------------

  update(dt: number, time: number, nowMs: number, serverTick: number): void {
    this.applyCamera(dt);
    this.waterTime.value = time;
    this.props.flush();
    const platesVisible = this.intro < 0 || this.intro > 0.85;

    for (const [id, view] of this.views) {
      const e = view.e, s = e.state;
      if (view.unit && s.unit) {
        const h = heightAt(this.terrain, e.rx, e.ry);
        view.unit.group.position.set(e.rx, h, e.ry);
        view.unit.group.rotation.y = -e.rfacing;
        view.unit.animate(s.unit.state, time, dt);
        const selected = this.selection.has(id);
        view.unit.ring.visible = selected;
        const own = s.unit.owner === this.opts.playerId;
        if (own) {
          const predicted = this.predictions.get(id);
          if (predicted && predicted.until < nowMs) this.predictions.delete(id);
          const pts = s.unit.path.length > 0 ? s.unit.path : (this.predictions.get(id)?.pts ?? null);
          this.overlay.setPath(id, e.rx, e.ry, pts, selected);
        }
        if (view.plate) {
          const p = this.screenOf(e.rx, e.ry, 1.95);
          const on = platesVisible && p.x > -60 && p.y > -30 && p.x < this.width + 60 && p.y < this.height + 30;
          view.plate.root.style.display = on ? '' : 'none';
          if (on) view.plate.root.style.transform = 'translate(' + p.x.toFixed(1) + 'px,' + p.y.toFixed(1) + 'px) translate(-50%,-100%)';
          view.plate.root.classList.toggle('selected', selected);
        }
      } else if (view.pod && s.pod) {
        const progress = (serverTick - s.pod.spawnTick) / POD_FALL_TICKS;
        view.pod.setFall(progress, time);
        if (view.landed === undefined) view.landed = progress >= 1;
        else if (!view.landed && progress >= 1) {
          view.landed = true;
          this.puffs.burst(s.x, heightAt(this.terrain, s.x, s.y), s.y);
        }
      } else if (view.structure) view.structure.animate(time);
    }

    this.overlay.update(dt);
    this.puffs.update(dt);
    this.atmosphere.update(time, this.target, this.height / this.viewSize);
  }

  /** Own units whose screen position falls inside a CSS-pixel rectangle. */
  unitsInRect(x0: number, y0: number, x1: number, y1: number): number[] {
    const out: number[] = [];
    for (const [id, v] of this.views) {
      if (v.e.state.unit?.owner !== this.opts.playerId) continue;
      const p = this.screenOf(v.e.rx, v.e.ry, 0.7);
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) out.push(id);
    }
    return out;
  }

  /** Closest own unit within `radiusPx` of a screen point. */
  unitAtScreen(x: number, y: number, radiusPx = 26): number | null {
    let best: number | null = null, bestD = radiusPx * radiusPx;
    for (const [id, v] of this.views) {
      if (v.e.state.unit?.owner !== this.opts.playerId) continue;
      const p = this.screenOf(v.e.rx, v.e.ry, 0.7);
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  dispose(): void {
    for (const v of this.views.values()) v.plate?.root.remove();
    this.views.clear();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
    });
    this.sun.shadow.map?.dispose();
  }
}

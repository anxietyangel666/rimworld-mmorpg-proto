import * as THREE from 'three';
import { EntityKind, ORDER_NAMES, UnitState } from '../game-sim/components';
import { STRUCTURES, type StructureKind } from '../game-sim/items';
import { Pathfinder } from '../game-sim/pathfinding';
import type { MirrorEntity } from '../network/mirror';
import { Biome } from '../world-gen/planet';
import { CHUNK_SIZE, Surface, tileIndex, WORLD_H, WORLD_W, wrapDX, wrapDY, wrapX, wrapY } from '../world-gen/surface';
import { blueprintEdges, makePile, makePod, makeStructure, makeUnit, type PodView, type StructureView, type UnitView } from './actors';
import { Atmosphere, Puffs } from './atmosphere';
import { TacticalOverlay } from './overlays';
import { BOUNCE_COLOR, gradeFor, playerColor, SKY_COLOR, SUN_COLOR, type Grade } from './palette';
import { makeBoulders, PropLayer } from './props';
import { buildChunkGeometry, buildWater, patchGround } from './terrain';

/** Server ticks a drop pod takes from sky to ground. The passenger steps out shortly after (POD_DEPLOY_TICKS). */
export const POD_FALL_TICKS = 50;

const ISO_PITCH = THREE.MathUtils.degToRad(42);
const ISO_YAW = Math.PI / 4;
const INTRO_SECONDS = 3.6;
const MIN_VIEW = 9, MAX_VIEW = 46;
const SUN_OFFSET = new THREE.Vector3(-38, 46, 22);
const SHADOW_MAP = 2048;
const STATE_LABEL: Record<UnitState, string> = {
  [UnitState.Idle]: '', [UnitState.Moving]: '', [UnitState.Harvesting]: 'gathering', [UnitState.Building]: 'building', [UnitState.Crafting]: 'crafting',
};

interface View {
  e: MirrorEntity;
  unit?: UnitView;
  pod?: PodView;
  structure?: StructureView;
  pile?: THREE.Mesh;
  plate?: { root: HTMLElement; hp: HTMLElement; tag: HTMLElement };
  /** Pod only: whether touchdown effects have played. */
  landed?: boolean;
}

export interface IsoOptions {
  seed: number;
  /** Local player id, to tell your own people from everyone else's. */
  playerId: number;
  /** DOM layer that name plates are appended to. */
  plateRoot: HTMLElement;
  ownerName: (playerId: number) => string;
}

/**
 * Surface view: a true 3D scene under an orthographic camera locked to an
 * isometric angle, following the player's character across a world that wraps.
 *
 * The camera lives in continuous "unwrapped" coordinates and never jumps;
 * terrain chunks are generated around it from the shared surface function and
 * dropped behind it, and every replicated entity is drawn at whichever copy of
 * its wrapped position is nearest the camera. Walking around the planet is
 * therefore seamless: there is no edge to see.
 */
export class IsoScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 800);
  readonly surface: Surface;
  /** Ground point the camera looks at, in unwrapped coordinates. */
  readonly target = new THREE.Vector3();
  readonly grade: Grade = { haze: new THREE.Color(), hazeAmount: 0.5, tint: new THREE.Color(1, 1, 1), desaturate: 0.3 };
  /** Entity id of the local player's character, once it has been replicated. */
  heroId = -1;
  /** Follower currently selected in the HUD, or -1. */
  selected = -1;

  private readonly views = new Map<number, View>();
  private readonly chunks = new Map<string, THREE.Group>();
  private readonly terrainMat: THREE.MeshStandardMaterial;
  private readonly props: PropLayer;
  private readonly overlay: TacticalOverlay;
  private readonly atmosphere = new Atmosphere();
  private readonly puffs = new Puffs(new THREE.Color(0.55, 0.52, 0.46));
  private readonly sun: THREE.DirectionalLight;
  private readonly water: THREE.Mesh;
  private readonly time = { value: 0 };
  /** Tiles blocked by replicated things (nodes, pods, finished solid structures). */
  private readonly dynBlocked = new Set<number>();
  private readonly pathfinder: Pathfinder;
  private predicted: { pts: number[]; until: number } | null = null;
  private readonly tmp = new THREE.Vector3();
  private readonly lightRight = new THREE.Vector3();
  private readonly lightUp = new THREE.Vector3();

  private width = 1; private height = 1; private dpr = 1;
  private viewSize = 21; private tViewSize = 21;
  private yaw = ISO_YAW; private tYaw = ISO_YAW;
  private intro = -1;
  private shadowExtent = 0;

  constructor(private readonly opts: IsoOptions) {
    // Enough cached chunks for the widest view plus a margin; older terrain is regenerated on return.
    this.surface = new Surface(opts.seed, 420);
    const heightAt = (x: number, y: number) => this.surface.height(x, y);
    this.pathfinder = new Pathfinder(WORLD_W, WORLD_H, (tx, ty) => this.blockedAt(tx, ty), true);

    this.scene.background = new THREE.Color(0.07, 0.075, 0.07);
    this.terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
    patchGround(this.terrainMat, this.time, true);
    const propMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true });
    patchGround(propMat, this.time, false);
    this.props = new PropLayer(propMat);
    this.overlay = new TacticalOverlay(heightAt);
    this.water = buildWater(this.time);
    this.scene.add(this.water, this.props.group, this.atmosphere.group, this.puffs.group, this.overlay.group);

    // Low sun for long shadows; a sky/ground hemisphere fills them so they stay readable.
    this.sun = new THREE.DirectionalLight(SUN_COLOR, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.06;
    this.sun.shadow.radius = 3;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.scene.add(this.sun, this.sun.target, new THREE.HemisphereLight(SKY_COLOR, BOUNCE_COLOR, 0.8));
    // Axes of the light's view, for snapping the shadow frustum to whole shadow texels.
    const dir = SUN_OFFSET.clone().normalize();
    this.lightRight.crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
    this.lightUp.crossVectors(dir, this.lightRight).normalize();
  }

  // --- coordinates ------------------------------------------------------------

  /** Render-space x of a wrapped world x: the copy nearest the camera. */
  private ux(x: number): number { return this.target.x + wrapDX(x - this.target.x); }
  private uz(y: number): number { return this.target.z + wrapDY(y - this.target.z); }

  /** Whether a tile is impassable, as far as this client knows. Used to predict movement and routes. */
  blockedAt(tx: number, ty: number): boolean {
    return this.surface.terrainBlocked(tx, ty) || this.dynBlocked.has(tileIndex(tx, ty));
  }

  /** Route from the hero to a point, planned locally with the same pathfinder the server runs. */
  planRoute(x: number, y: number): number[] | null {
    const hero = this.views.get(this.heroId)?.e;
    return hero ? this.pathfinder.findPath(hero.rx, hero.ry, x, y) : null;
  }

  // --- replicated entities ----------------------------------------------------

  spawn(e: MirrorEntity): void {
    const s = e.state;
    const view: View = { e };
    this.views.set(s.id, view);
    const x = this.ux(s.x), z = this.uz(s.y), h = this.surface.height(s.x, s.y);
    if (s.kind === EntityKind.Unit && s.unit) {
      const own = s.unit.owner === this.opts.playerId;
      if (own && s.unit.hero) this.heroId = s.id;
      view.unit = makeUnit(playerColor(s.unit.owner, own), s.unit.hero);
      this.scene.add(view.unit.group);
      view.plate = this.makePlate();
    } else if (s.kind === EntityKind.Pod && s.pod) {
      view.pod = makePod(playerColor(s.pod.owner, s.pod.owner === this.opts.playerId));
      view.pod.group.position.set(x, h, z);
      this.scene.add(view.pod.group);
      this.dynBlocked.add(tileIndex(s.x, s.y));
    } else if (s.kind === EntityKind.Structure && s.structure) {
      view.structure = makeStructure(s.structure.kind);
      view.structure.group.position.set(x, h, z);
      this.scene.add(view.structure.group);
    } else if (s.kind === EntityKind.Pile && s.pile) {
      view.pile = makePile(s.pile.item);
      view.pile.position.set(x, h, z);
      view.pile.rotation.y = (s.id * 2.4) % Math.PI;
      this.scene.add(view.pile);
    }
    this.change(e);
  }

  change(e: MirrorEntity): void {
    const s = e.state;
    const view = this.views.get(s.id);
    if (!view) return;
    view.e = e;
    if (s.node) {
      const arid = [Biome.Desert, Biome.Badlands].includes(this.surface.biome(s.x, s.y));
      this.props.set(s.id, s.node.kind, this.ux(s.x), this.uz(s.y), this.surface.height(s.x, s.y), s.node.amount, arid);
      this.dynBlocked.add(tileIndex(s.x, s.y));
    } else if (s.structure && view.structure) {
      view.structure.setState(s.structure.progress, s.structure.built, s.structure.crop);
      if (s.structure.built && STRUCTURES[s.structure.kind].blocks) this.dynBlocked.add(tileIndex(s.x, s.y));
    } else if (s.pile && view.pile) {
      view.pile.scale.setScalar(Math.min(1.6, 0.7 + s.pile.qty * 0.08));
    } else if (s.unit && view.plate) {
      const u = s.unit, own = u.owner === this.opts.playerId;
      const role = u.hero ? '' : u.owner === 0 ? 'drifter' : own ? ORDER_NAMES[u.order].toLowerCase() : this.opts.ownerName(u.owner);
      const doing = STATE_LABEL[u.state];
      view.plate.tag.textContent = u.name + (role ? ' · ' + role : '') + (doing && u.hero ? ' · ' + doing : '');
      view.plate.root.className = 'plate' + (own ? ' own' : u.owner === 0 ? ' neutral' : '');
      view.plate.hp.style.width = Math.round((u.hp / u.maxHp) * 100) + '%';
      // The server's route supersedes the local prediction.
      if (s.id === this.heroId && u.path.length > 0) this.predicted = null;
    }
  }

  despawn(e: MirrorEntity): void {
    const s = e.state;
    const view = this.views.get(s.id);
    if (!view) return;
    this.views.delete(s.id);
    if (this.selected === s.id) this.selected = -1;
    if (view.unit) this.scene.remove(view.unit.group);
    if (view.pod) this.scene.remove(view.pod.group);
    if (view.structure) this.scene.remove(view.structure.group);
    if (view.pile) this.scene.remove(view.pile);
    view.plate?.root.remove();
    if (s.node) this.props.delete(s.id);
    if (s.kind !== EntityKind.Unit && s.kind !== EntityKind.Pile) this.dynBlocked.delete(tileIndex(s.x, s.y));
  }

  private makePlate(): View['plate'] {
    const root = document.createElement('div');
    const tag = document.createElement('span');
    const bar = document.createElement('div');
    bar.className = 'hp';
    const hp = document.createElement('i');
    bar.append(hp);
    root.append(tag, bar);
    this.opts.plateRoot.append(root);
    return { root, hp, tag };
  }

  // --- terrain streaming ------------------------------------------------------

  /**
   * Keep a square of chunk meshes around the camera: build the missing ones
   * nearest-first within a per-frame budget, and drop those left far behind.
   */
  private streamChunks(viewRadius: number): void {
    const ccx = Math.floor(this.target.x / CHUNK_SIZE), ccy = Math.floor(this.target.z / CHUNK_SIZE);
    const r = Math.min(6, Math.max(2, Math.ceil(viewRadius / CHUNK_SIZE) + 1));
    const missing: [number, number, number][] = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (!this.chunks.has((ccx + dx) + ',' + (ccy + dy))) missing.push([dx * dx + dy * dy, ccx + dx, ccy + dy]);
    }
    missing.sort((a, b) => a[0] - b[0]);
    // The first frame fills the whole view at once; after that a few per frame keeps walking smooth.
    const budget = this.chunks.size === 0 ? missing.length : 3;
    for (const [, cx, cy] of missing.slice(0, budget)) {
      const group = new THREE.Group();
      group.position.set(cx * CHUNK_SIZE, 0, cy * CHUNK_SIZE);
      const mesh = new THREE.Mesh(buildChunkGeometry(this.surface, cx, cy), this.terrainMat);
      mesh.receiveShadow = true;
      group.add(mesh);
      const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE;
      const boulders = makeBoulders(this.surface.chunk(cx, cy), this.props.material, (x, y) => this.surface.height(ox + x, oy + y));
      if (boulders) group.add(boulders);
      this.scene.add(group);
      this.chunks.set(cx + ',' + cy, group);
    }
    for (const [key, group] of this.chunks) {
      const [cx, cy] = key.split(',').map(Number);
      if (Math.max(Math.abs(cx - ccx), Math.abs(cy - ccy)) <= r + 2) continue;
      this.scene.remove(group);
      (group.children[0] as THREE.Mesh).geometry.dispose();
      (group.children[1] as THREE.InstancedMesh | undefined)?.dispose();
      this.chunks.delete(key);
    }
  }

  // --- camera -----------------------------------------------------------------

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
  }

  /** Start the touchdown shot: straight down from altitude, easing into the isometric angle. */
  startIntro(): void {
    this.intro = 0;
  }

  get introActive(): boolean {
    return this.intro >= 0;
  }

  /** 0..1 touchdown shot progress while it plays, else 1. */
  get introProgress(): number {
    return this.intro >= 0 ? Math.min(1, this.intro) : 1;
  }

  /** Jump the camera to a wrapped world position. */
  focus(x: number, y: number): void {
    this.target.set(x, 0, y);
  }

  /** Ease the camera toward a wrapped world position, the short way round. */
  follow(x: number, y: number, dt: number): void {
    const k = 1 - Math.exp(-dt * 7);
    this.target.x += wrapDX(x - this.target.x) * k;
    this.target.z += wrapDY(y - this.target.z) * k;
  }

  zoom(deltaY: number): void {
    this.tViewSize = THREE.MathUtils.clamp(this.tViewSize * Math.exp(deltaY * 0.0012), MIN_VIEW, MAX_VIEW);
  }

  /** Rotate the view a quarter turn; dir is +1 or -1. */
  rotate(dir: number): void {
    this.tYaw += (dir * Math.PI) / 2;
  }

  /** World-space direction for a screen-space input (x right, y up), for camera-relative WASD. */
  screenToWorldDir(sx: number, sy: number): [number, number] {
    const rx = Math.sin(this.tYaw), rz = -Math.cos(this.tYaw);
    const fx = -Math.cos(this.tYaw), fz = -Math.sin(this.tYaw);
    return [rx * sx + fx * sy, rz * sx + fz * sy];
  }

  private applyCamera(dt: number): number {
    const k = 1 - Math.exp(-dt * 10);
    this.viewSize += (this.tViewSize - this.viewSize) * k;
    this.yaw += (this.tYaw - this.yaw) * k;
    let view = this.viewSize, pitch = ISO_PITCH, yaw = this.yaw;
    if (this.intro >= 0) {
      this.intro += dt / INTRO_SECONDS;
      const t = Math.min(1, this.intro);
      const ease = 1 - Math.pow(1 - t, 3);
      view = THREE.MathUtils.lerp(96, this.viewSize, ease);
      pitch = THREE.MathUtils.lerp(THREE.MathUtils.degToRad(88), ISO_PITCH, ease * ease * (3 - 2 * ease));
      yaw = this.yaw - (1 - ease) * 0.9;
      if (this.intro >= 1) this.intro = -1;
    }
    const aspect = this.width / this.height;
    const cam = this.camera;
    cam.left = (-view * aspect) / 2; cam.right = (view * aspect) / 2;
    cam.top = view / 2; cam.bottom = -view / 2;
    cam.updateProjectionMatrix();
    this.target.y = this.surface.height(this.target.x, this.target.z);
    const cp = Math.cos(pitch);
    cam.position.set(Math.cos(yaw) * cp, Math.sin(pitch), Math.sin(yaw) * cp).multiplyScalar(300).add(this.target);
    cam.lookAt(this.target);
    cam.updateMatrixWorld(true);
    // Snap the view to whole device pixels. An orthographic camera gliding by fractions of a
    // pixel makes every edge and texel crawl; snapped, the scene scrolls like a tile map.
    if (this.intro < 0 && Math.abs(this.tYaw - this.yaw) < 1e-3) {
      const upp = view / (this.height * this.dpr);
      const right = this.tmp.setFromMatrixColumn(cam.matrixWorld, 0);
      const a = this.target.dot(right);
      cam.position.addScaledVector(right, Math.round(a / upp) * upp - a);
      const up = this.tmp.setFromMatrixColumn(cam.matrixWorld, 1);
      const b = this.target.dot(up);
      cam.position.addScaledVector(up, Math.round(b / upp) * upp - b);
      cam.updateMatrixWorld(true);
    }

    // Shadow frustum: a fixed size per zoom band (so texel density never drifts) and
    // moved only in whole shadow texels (so shadow edges never swim as the camera pans).
    const extent = this.intro >= 0 ? 110 : this.tViewSize > 28 ? 62 : 36;
    const sc = this.sun.shadow.camera;
    if (extent !== this.shadowExtent) {
      this.shadowExtent = extent;
      sc.left = -extent; sc.right = extent; sc.top = extent; sc.bottom = -extent;
      sc.updateProjectionMatrix();
    }
    const texel = (extent * 2) / SHADOW_MAP;
    const la = this.target.dot(this.lightRight), lb = this.target.dot(this.lightUp);
    this.sun.target.position.copy(this.target)
      .addScaledVector(this.lightRight, Math.round(la / texel) * texel - la)
      .addScaledVector(this.lightUp, Math.round(lb / texel) * texel - lb);
    this.sun.position.copy(this.sun.target.position).add(SUN_OFFSET);
    return Math.hypot((view * aspect) / 2, view / 2 / Math.sin(pitch));
  }

  // --- picking and projection -------------------------------------------------

  /** Wrapped world point under normalised device coordinates. */
  groundAt(ndcX: number, ndcY: number): { x: number; y: number } | null {
    const origin = this.tmp.set(ndcX, ndcY, -1).unproject(this.camera).clone();
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    if (dir.y > -1e-4) return null;
    // Terrain relief is gentle, so a few plane re-intersections converge on the heightfield.
    let h = 0, x = 0, z = 0;
    for (let i = 0; i < 4; i++) {
      const t = (h - origin.y) / dir.y;
      x = origin.x + dir.x * t; z = origin.z + dir.z * t;
      h = this.surface.height(x, z);
    }
    return { x: wrapX(x), y: wrapY(z) };
  }

  /** Screen position in CSS pixels of a wrapped world point `up` units above the ground. */
  screenOf(x: number, y: number, up = 0): { x: number; y: number } {
    const v = this.tmp.set(this.ux(x), this.surface.height(x, y) + up, this.uz(y)).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height };
  }

  /** The thing standing on a tile: a pile, node, structure or pod. */
  entityAtTile(tx: number, ty: number): MirrorEntity | null {
    let best: MirrorEntity | null = null;
    for (const v of this.views.values()) {
      const s = v.e.state;
      if (s.kind === EntityKind.Unit || Math.floor(s.x) !== tx || Math.floor(s.y) !== ty) continue;
      if (!best || s.kind === EntityKind.Pile) best = v.e;
    }
    return best;
  }

  /** Closest person other than the hero within `radiusPx` of a screen point. */
  unitAtScreen(x: number, y: number, radiusPx = 24): MirrorEntity | null {
    let best: MirrorEntity | null = null, bestD = radiusPx * radiusPx;
    for (const [id, v] of this.views) {
      if (!v.unit || id === this.heroId) continue;
      const p = this.screenOf(v.e.rx, v.e.ry, 0.7);
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) { bestD = d; best = v.e; }
    }
    return best;
  }

  /** True when a structure could be placed on the tile, as far as this client knows. */
  canBuildAt(tx: number, ty: number): boolean {
    return !this.blockedAt(tx, ty) && !this.surface.isWater(tx, ty) && !this.entityAtTile(tx, ty);
  }

  // --- tactical overlays ------------------------------------------------------

  /** Show a locally planned route at once, until the server's own route replaces it. */
  showPredictedRoute(pts: number[] | null, nowMs: number): void {
    this.predicted = pts ? { pts, until: nowMs + 700 } : null;
  }

  ping(x: number, y: number): void {
    this.overlay.ping(this.ux(x), this.uz(y));
  }

  setHover(tx: number, ty: number, visible: boolean): void {
    this.overlay.setHover(this.ux(tx + 0.5), this.uz(ty + 0.5), visible);
  }

  setGhost(kind: StructureKind | null, tx: number, ty: number): void {
    this.overlay.setGhost(kind === null ? null : blueprintEdges(kind), this.ux(tx + 0.5), this.uz(ty + 0.5), kind !== null && this.canBuildAt(tx, ty));
  }

  // --- frame ------------------------------------------------------------------

  update(dt: number, time: number, nowMs: number, serverTick: number): void {
    const viewRadius = this.applyCamera(dt);
    this.streamChunks(viewRadius);
    this.time.value = time;
    this.props.flush();
    this.water.position.x = Math.round(this.target.x);
    this.water.position.z = Math.round(this.target.z);
    const platesVisible = this.intro < 0 || this.intro > 0.85;

    for (const [id, view] of this.views) {
      const e = view.e, s = e.state;
      if (view.unit && s.unit) {
        const x = this.ux(e.rx), z = this.uz(e.ry);
        // Wading: the body sinks a little where the ground is under water.
        view.unit.group.position.set(x, Math.max(this.surface.height(e.rx, e.ry), -0.5), z);
        view.unit.group.rotation.y = -e.rfacing;
        view.unit.animate(s.unit.state, time, dt);
        view.unit.ring.visible = id === this.selected;
        if (id === this.heroId) {
          if (this.predicted && this.predicted.until < nowMs) this.predicted = null;
          const pts = s.unit.path.length > 0 ? s.unit.path : (this.predicted?.pts ?? null);
          this.overlay.setPath(x, z, pts ? pts.map((v, i) => (i % 2 === 0 ? this.ux(v) : this.uz(v))) : null);
        }
        if (view.plate) {
          const p = this.screenOf(e.rx, e.ry, 2.0);
          const on = platesVisible && p.x > -60 && p.y > -30 && p.x < this.width + 60 && p.y < this.height + 30;
          view.plate.root.style.display = on ? '' : 'none';
          // Whole-pixel positions keep the label text from blurring as the unit moves.
          if (on) view.plate.root.style.transform = 'translate(' + Math.round(p.x) + 'px,' + Math.round(p.y) + 'px) translate(-50%,-100%)';
          view.plate.root.classList.toggle('selected', id === this.selected);
        }
      } else if (view.pod && s.pod) {
        const progress = (serverTick - s.pod.spawnTick) / POD_FALL_TICKS;
        view.pod.setFall(progress, time);
        if (view.landed === undefined) view.landed = progress >= 1;
        else if (!view.landed && progress >= 1) {
          view.landed = true;
          this.puffs.burst(view.pod.group.position.x, view.pod.group.position.y, view.pod.group.position.z);
        }
      } else if (view.structure) view.structure.animate(time);
    }

    // The air takes its colour from the climate under the camera, eased so biome borders blend.
    const c = this.surface.climate(this.target.x, this.target.z);
    const want = gradeFor(c.temperature, c.moisture, GRADE_SCRATCH);
    const k = 1 - Math.exp(-dt * 1.5);
    this.grade.haze.lerp(want.haze, k);
    this.grade.tint.lerp(want.tint, k);
    this.grade.hazeAmount += (want.hazeAmount - this.grade.hazeAmount) * k;
    this.grade.desaturate += (want.desaturate - this.grade.desaturate) * k;
    this.atmosphere.hazeColor.copy(this.grade.haze);
    this.atmosphere.amount = this.grade.hazeAmount;

    this.overlay.update(dt);
    this.puffs.update(dt);
    this.atmosphere.update(time, this.target, this.height / this.viewSize);
  }

  dispose(): void {
    for (const v of this.views.values()) v.plate?.root.remove();
    this.views.clear();
    this.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
    this.sun.shadow.map?.dispose();
  }
}

const GRADE_SCRATCH: Grade = { haze: new THREE.Color(), hazeAmount: 0, tint: new THREE.Color(), desaturate: 0 };

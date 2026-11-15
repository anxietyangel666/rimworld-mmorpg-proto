import * as THREE from 'three';
import { EntityKind, ORDER_NAMES, UnitState } from '../game-sim/components';
import { STRUCTURES, type StructureKind } from '../game-sim/items';
import { Pathfinder } from '../game-sim/pathfinding';
import type { MirrorEntity } from '../network/mirror';
import { PROF_NAMES, VILLAGE_OWNER, WOLF, type Prof } from '../game-sim/village';
import { CHUNK_SIZE, CHUNKS_X, CHUNKS_Y, Surface, tileIndex, WORLD_H, WORLD_W, wrapDX, wrapDY, wrapX, wrapY } from '../world-gen/surface';
import { blueprintEdges, makePile, makePod, makeStructure, makeUnit, makeWolf, type PodView, type StructureView, type UnitView } from './actors';
import { Atmosphere, Puffs } from './atmosphere';
import { buildRoad, makeBuilding, type BuildingView } from './buildings';
import { TacticalOverlay } from './overlays';
import { BOUNCE_COLOR, gradeFor, playerColor, SKY_COLOR, SUN_COLOR, type Grade } from './palette';
import { buildDecor, makeBoulders, PropLayer } from './props';
import { buildChunkGeometry, buildWaterGeometry, makeCutUniforms, makeWaterMaterial, patchMaterial } from './terrain';

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
  [UnitState.Sleeping]: 'asleep', [UnitState.Eating]: 'eating', [UnitState.Fighting]: 'fighting',
};

interface Chunk {
  group: THREE.Group;
  /** Undergrowth and boulders, rebuilt when a road or building lands on the chunk. */
  scatter: THREE.Object3D[];
}

interface View {
  e: MirrorEntity;
  unit?: UnitView;
  pod?: PodView;
  structure?: StructureView;
  pile?: THREE.Mesh;
  building?: BuildingView;
  road?: THREE.Mesh;
  /** Wrapped tile indices this road or building covers: no undergrowth is drawn there. */
  covers?: number[];
  /** Tiles this building blocks once built. */
  solid?: number[];
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
  private readonly chunks = new Map<string, Chunk>();
  private readonly terrainMat: THREE.MeshStandardMaterial;
  private readonly props: PropLayer;
  private readonly overlay: TacticalOverlay;
  private readonly atmosphere = new Atmosphere();
  private readonly puffs = new Puffs(new THREE.Color(0.55, 0.52, 0.46));
  private readonly sun: THREE.DirectionalLight;
  private readonly waterMat: THREE.ShaderMaterial;
  private readonly decorMat: THREE.MeshStandardMaterial;
  private readonly rockMat: THREE.MeshStandardMaterial;
  private readonly wallMat: THREE.MeshStandardMaterial;
  private readonly roadMat: THREE.MeshStandardMaterial;
  private readonly hemi = new THREE.HemisphereLight(SKY_COLOR, BOUNCE_COLOR, 0.8);
  private readonly cut = makeCutUniforms();
  private readonly night = { value: 0 };
  private readonly waterU = { uSunDir: { value: SUN_OFFSET.clone().normalize() }, uViewDir: { value: new THREE.Vector3() }, uNight: this.night };
  /** Wrapped tiles under a road or building, counted so overlapping roads can come and go. */
  private readonly covered = new Map<number, number>();
  /** Hour of the local day, 0..24, as last reported by the server. */
  hour = 12;
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
    patchMaterial(this.terrainMat, this.time, { key: 'ground', grit: true });
    const std = () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true });
    // Only tall things are cut away: trees and walls. Rocks and undergrowth never hide anyone.
    const plantMat = std();
    patchMaterial(plantMat, this.time, { key: 'plant', sway: true, cut: this.cut });
    patchMaterial((this.rockMat = std()), this.time, { key: 'rock' });
    patchMaterial((this.decorMat = std()), this.time, { key: 'rock' });
    patchMaterial((this.wallMat = std()), this.time, { key: 'wall', cut: this.cut, night: this.night });
    this.roadMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    patchMaterial(this.roadMat, this.time, { key: 'ground', grit: true });
    this.waterMat = makeWaterMaterial(this.time, this.waterU);
    this.props = new PropLayer(plantMat, this.rockMat);
    this.overlay = new TacticalOverlay(heightAt);
    this.scene.add(this.props.group, this.atmosphere.group, this.puffs.group, this.overlay.group);

    // Low sun for long shadows; a sky/ground hemisphere fills them so they stay readable.
    this.sun = new THREE.DirectionalLight(SUN_COLOR, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.06;
    this.sun.shadow.radius = 3;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.scene.add(this.sun, this.sun.target, this.hemi);
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
      view.unit = s.unit.prof === WOLF ? makeWolf() : makeUnit(playerColor(s.unit.owner, own), s.unit.hero, s.unit.prof as Prof);
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
    } else if (s.kind === EntityKind.Building && s.building) {
      const b = (view.building = makeBuilding(s.building.type, s.building.flip, this.wallMat, (fade) => this.roofMaterial(fade)));
      const L = b.layout, ox = Math.round(s.x - L.w / 2), oy = Math.round(s.y - L.h / 2);
      b.group.position.set(Math.round(x - L.w / 2), h, Math.round(z - L.h / 2));
      this.scene.add(b.group);
      view.covers = [];
      for (let ty = 0; ty < L.h; ty++) for (let tx = 0; tx < L.w; tx++) view.covers.push(tileIndex(ox + tx, oy + ty));
      view.solid = L.solid.map(([tx, ty]) => tileIndex(ox + tx, oy + ty));
      this.cover(view.covers, 1);
    } else if (s.kind === EntityKind.Road && s.road) {
      // Road points are wrapped; unwrap each relative to the previous so a road crossing the seam stays in one piece.
      const pts: number[] = [];
      for (let i = 0; i < s.road.pts.length; i += 2) {
        const px = i === 0 ? this.ux(s.road.pts[0]) : pts[i - 2] + wrapDX(s.road.pts[i] - s.road.pts[i - 2]);
        const pz = i === 0 ? this.uz(s.road.pts[1]) : pts[i - 1] + wrapDY(s.road.pts[i + 1] - s.road.pts[i - 1]);
        pts.push(px, pz);
      }
      const road = buildRoad(pts, s.road.wide, this.roadMat, (vx, vy) => this.surface.vertexHeight(vx, vy), (tx, ty) => this.surface.isWater(tx, ty));
      view.road = road.mesh;
      this.scene.add(road.mesh);
      view.covers = road.tiles.map(([tx, ty]) => tileIndex(tx, ty));
      this.cover(view.covers, 1);
    }
    this.change(e);
  }

  change(e: MirrorEntity): void {
    const s = e.state;
    const view = this.views.get(s.id);
    if (!view) return;
    view.e = e;
    if (s.node) {
      this.props.set(s.id, s.node.kind, this.ux(s.x), this.uz(s.y), this.surface.height(s.x, s.y), s.node.amount, this.surface.treeSpecies(Math.floor(s.x), Math.floor(s.y)));
      this.dynBlocked.add(tileIndex(s.x, s.y));
    } else if (s.structure && view.structure) {
      view.structure.setState(s.structure.progress, s.structure.built, s.structure.crop, s.structure.owner === VILLAGE_OWNER);
      if (s.structure.built && STRUCTURES[s.structure.kind].blocks) this.dynBlocked.add(tileIndex(s.x, s.y));
    } else if (s.building && view.building) {
      view.building.setProgress(s.building.progress, s.building.built);
      if (s.building.built) for (const t of view.solid!) this.dynBlocked.add(t);
    } else if (s.pile && view.pile) {
      view.pile.scale.setScalar(Math.min(1.6, 0.7 + s.pile.qty * 0.08));
    } else if (s.unit && view.plate) {
      const u = s.unit, own = u.owner === this.opts.playerId;
      const role = u.hero || u.prof === WOLF ? '' : u.owner === VILLAGE_OWNER ? PROF_NAMES[u.prof].toLowerCase() : u.owner === 0 ? 'drifter' : own ? ORDER_NAMES[u.order].toLowerCase() : this.opts.ownerName(u.owner);
      const doing = STATE_LABEL[u.state];
      view.plate.tag.textContent = u.name + (role ? ' · ' + role : '') + (doing && (u.hero || u.owner === VILLAGE_OWNER) ? ' · ' + doing : '');
      view.plate.root.className = 'plate' + (own ? ' own' : u.prof === WOLF ? ' hostile' : u.owner === 0 || u.owner === VILLAGE_OWNER ? ' neutral' : '');
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
    if (view.building) this.scene.remove(view.building.group);
    if (view.road) { this.scene.remove(view.road); view.road.geometry.dispose(); }
    if (view.covers) this.cover(view.covers, -1);
    for (const t of view.solid ?? []) this.dynBlocked.delete(t);
    if (s.node) this.props.delete(s.id);
    if (s.kind === EntityKind.Node || s.kind === EntityKind.Pod || s.kind === EntityKind.Structure) this.dynBlocked.delete(tileIndex(s.x, s.y));
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
      const waterGeo = buildWaterGeometry(this.surface, cx, cy);
      if (waterGeo) {
        const water = new THREE.Mesh(waterGeo, this.waterMat);
        water.renderOrder = 1;
        group.add(water);
      }
      this.scene.add(group);
      const chunk: Chunk = { group, scatter: [] };
      this.chunks.set(cx + ',' + cy, chunk);
      this.scatter(chunk, cx, cy);
    }
    for (const [key, chunk] of this.chunks) {
      const [cx, cy] = key.split(',').map(Number);
      if (Math.max(Math.abs(cx - ccx), Math.abs(cy - ccy)) <= r + 2) continue;
      this.scene.remove(chunk.group);
      for (const o of chunk.group.children) disposeMesh(o);
      this.chunks.delete(key);
    }
  }

  /** (Re)build a chunk's undergrowth and boulders, leaving out whatever a road or building has replaced. */
  private scatter(chunk: Chunk, cx: number, cy: number): void {
    for (const o of chunk.scatter) { chunk.group.remove(o); disposeMesh(o); }
    const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE;
    const heightAt = (x: number, y: number) => this.surface.height(ox + x, oy + y);
    const skip = (lx: number, ly: number) => this.covered.has(tileIndex(ox + lx, oy + ly));
    const data = this.surface.chunk(cx, cy);
    chunk.scatter = [buildDecor(data, this.decorMat, heightAt, skip), makeBoulders(data, this.rockMat, heightAt, skip)].filter((o) => o !== null);
    for (const o of chunk.scatter) chunk.group.add(o);
  }

  /** Count tiles in or out of the covered set and refresh the undergrowth of every loaded chunk they touch. */
  private cover(tiles: number[], delta: number): void {
    const touched = new Set<number>();
    for (const t of tiles) {
      const n = (this.covered.get(t) ?? 0) + delta;
      if (n > 0) this.covered.set(t, n); else this.covered.delete(t);
      touched.add(Math.floor((t % WORLD_W) / CHUNK_SIZE) + Math.floor(Math.floor(t / WORLD_W) / CHUNK_SIZE) * CHUNKS_X);
    }
    for (const [key, chunk] of this.chunks) {
      const [cx, cy] = key.split(',').map(Number);
      const wx = ((cx % CHUNKS_X) + CHUNKS_X) % CHUNKS_X, wy = ((cy % CHUNKS_Y) + CHUNKS_Y) % CHUNKS_Y;
      if (touched.has(wx + wy * CHUNKS_X)) this.scatter(chunk, cx, cy);
    }
  }

  private roofMaterial(fade: { value: number }): THREE.Material {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true, side: THREE.DoubleSide });
    patchMaterial(mat, this.time, { key: 'roof', cut: this.cut, fade });
    return mat;
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
      if (s.kind === EntityKind.Unit || s.kind === EntityKind.Road || s.kind === EntityKind.Building || Math.floor(s.x) !== tx || Math.floor(s.y) !== ty) continue;
      if (!best || s.kind === EntityKind.Pile) best = v.e;
    }
    return best;
  }

  /** The village building whose footprint covers a tile. */
  buildingAt(tx: number, ty: number): MirrorEntity | null {
    for (const v of this.views.values()) {
      if (!v.building) continue;
      const L = v.building.layout, s = v.e.state;
      const lx = wrapDX(tx + 0.5 - s.x) + L.w / 2, ly = wrapDY(ty + 0.5 - s.y) + L.h / 2;
      if (lx >= 0 && ly >= 0 && lx < L.w && ly < L.h) return v.e;
    }
    return null;
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
    this.applyDaylight(dt);
    this.camera.getWorldDirection(this.waterU.uViewDir.value);
    const hero = this.views.get(this.heroId)?.e;
    // Cut-aways: the hero first, then the player's own people, as far as the uniform array goes.
    this.cut.uCutR.value = ((this.height * this.dpr) / this.viewSize) * 1.5;
    let cuts = 0;
    const track = (e: MirrorEntity) => {
      if (cuts >= this.cut.uCut.value.length) return;
      const v = this.tmp.set(this.ux(e.rx), this.surface.height(e.rx, e.ry) + 0.8, this.uz(e.ry)).project(this.camera);
      this.cut.uCut.value[cuts++].set((v.x * 0.5 + 0.5) * this.width * this.dpr, (v.y * 0.5 + 0.5) * this.height * this.dpr, v.z * 0.5 + 0.5);
    };
    if (hero) track(hero);
    for (const [id, v] of this.views) if (id !== this.heroId && v.e.state.unit?.owner === this.opts.playerId) track(v.e);
    this.cut.uCutN.value = this.intro >= 0 ? 0 : cuts;
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
      else if (view.building?.roof) {
        // Lift the roof off whatever building the hero is standing in.
        const b = view.building, L = b.layout, roof = view.building.roof;
        let inside = false;
        if (hero) {
          const lx = Math.floor(wrapDX(hero.rx - s.x) + L.w / 2), ly = Math.floor(wrapDY(hero.ry - s.y) + L.h / 2);
          inside = lx >= 0 && ly >= 0 && lx < L.w && ly < L.h && L.inside[lx + ly * L.w];
        }
        b.fade.value = THREE.MathUtils.clamp(b.fade.value + (inside ? -dt : dt) * 4, 0, 1);
        roof.visible = b.fade.value > 0.01 && (b.built || (s.building?.progress ?? 0) >= 93);
        roof.castShadow = !inside;
      }
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

  /** Sun, sky fill and the night factor from the hour of day. Lamps and windows glow as it gets dark. */
  private applyDaylight(dt: number): void {
    const h = this.hour;
    const day = THREE.MathUtils.smoothstep(h, 5, 7.5) * (1 - THREE.MathUtils.smoothstep(h, 18.5, 21));
    this.night.value += (1 - day - this.night.value) * (1 - Math.exp(-dt * 2));
    const n = this.night.value;
    this.sun.intensity = 3.0 * (1 - n * 0.9);
    this.hemi.intensity = 0.8 - n * 0.45;
    this.sun.color.copy(SUN_COLOR).lerp(NIGHT_SUN, n);
    this.hemi.color.copy(SKY_COLOR).lerp(NIGHT_SKY, n);
  }

  dispose(): void {
    for (const v of this.views.values()) v.plate?.root.remove();
    this.views.clear();
    this.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
    this.sun.shadow.map?.dispose();
  }
}

const GRADE_SCRATCH: Grade = { haze: new THREE.Color(), hazeAmount: 0, tint: new THREE.Color(), desaturate: 0 };
const NIGHT_SUN = new THREE.Color(0.45, 0.55, 0.8), NIGHT_SKY = new THREE.Color(0.2, 0.26, 0.42);

function disposeMesh(o: THREE.Object3D): void {
  if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
  else (o as THREE.Mesh).geometry?.dispose();
}

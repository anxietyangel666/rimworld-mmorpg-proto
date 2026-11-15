import { ChunkGrid } from '../core-ecs/spatial';
import { hash01, hashInts, Rng } from '../core-ecs/rng';
import { World, type Entity } from '../core-ecs/world';
import { SECTOR_COLS } from '../world-gen/planet';
import {
  CHUNK_SIZE, CHUNKS_X, CHUNKS_Y, NodeKind, SECTOR_TILES, sectorOfTile, Surface, tileIndex, WORLD_H, WORLD_W, wrapDist,
  wrapDX, wrapDY, wrapX, wrapY,
} from '../world-gen/surface';
import { carryCapacity, loadTier, LoadTier, newSkills, newVitals, Status, tickVitals } from './character';
import {
  AOI_RADIUS, BUILD_RATE, Char, CROP_RIPE, CROP_SPROUT, CropStage, EntityKind, Follower, Inv, Job, JobKind, Net, Node,
  NPC_SPEED, Order, Path, Pile, Pod, POD_DEPLOY_TICKS, Position, RECRUIT_BERRIES, SITE_RADIUS, Structure, TICK_RATE, Unit,
  Building, DAY_START_HOUR, DAY_TICKS, Wolf,
  UnitState, type CharData, type JobData, type UnitData,
} from './components';
import {
  addItem, bestTool, Cont, countItem, equipped, findSpace, moveItem, newInventory, removeItem, totalWeight, wornWarmth,
  type Inventory,
} from './inventory';
import {
  Item, ITEMS, levelOf, NODES, PATTERN_SIZE, PATTERNS, RECIPES, Skill, Slot, StructureKind, STRUCTURES, workSpeed,
  type PatternId, type Recipe,
} from './items';
import { moveSpeed, moveStep } from './movement';
import { Pathfinder } from './pathfinding';
import { BuildingType, layoutOf } from './village';
import { VillageSystem } from './villageSim';

export type Command =
  | { type: 'moveTo'; player: number; x: number; y: number }
  | { type: 'interact'; player: number; target: Entity }
  | { type: 'build'; player: number; kind: StructureKind; tx: number; ty: number }
  | { type: 'invMove'; player: number; uid: number; c: Cont; x: number; y: number; rot: number }
  | { type: 'invDrop'; player: number; uid: number }
  | { type: 'invUse'; player: number; uid: number }
  | { type: 'craftStart'; player: number; pattern: PatternId }
  | { type: 'craftHit'; player: number; x: number; y: number }
  | { type: 'craftCancel'; player: number }
  | { type: 'recipe'; player: number; recipe: number; station: Entity }
  | { type: 'order'; player: number; npc: Entity; order: Order }
  | { type: 'drink'; player: number }
  | { type: 'trade'; player: number; building: Entity; item: Item; qty: number; sell: boolean }
  | { type: 'contract'; player: number; building: Entity; id: number; deliver: boolean };

/** What a client is told about its own character every snapshot. */
export interface SelfState {
  ack: number; x: number; y: number;
  hp: number; satiety: number; hydration: number; stamina: number; temp: number; status: number;
  kg: number; capacity: number; tier: LoadTier; work: number; ambient: number;
  coins: number;
  /** Time of day, 0..24. */
  hour: number;
}

const DRIFTER_NAMES = ['Aldo', 'Bren', 'Cora', 'Dell', 'Edda', 'Finn', 'Gus', 'Hale', 'Ida', 'Jory', 'Kit', 'Lena', 'Moss', 'Nell', 'Odo', 'Pia', 'Rook', 'Sela', 'Tam', 'Una', 'Wren'];
/** Longest route, in tiles, a single order may plan. */
const MAX_PATH_RANGE = 90;
const FULL_PATTERN = (1 << PATTERN_SIZE) - 1;

/**
 * Authoritative simulation of the whole planetary surface: one wrapping world
 * shared by every player. Terrain and resource nodes stream in around players
 * and their followers and are put away again when nobody is near; what players
 * changed (felled trees, structures, stockpiles) is remembered.
 *
 * System order per tick: commands -> pods -> streaming -> hero input ->
 * followers -> jobs -> path movement -> crops -> vitals.
 */
export class WorldSim {
  readonly world = new World();
  readonly surface: Surface;
  readonly grid = new ChunkGrid(CHUNK_SIZE, CHUNKS_X, CHUNKS_Y, true);
  readonly heroes = new Map<number, Entity>();
  readonly pods = new Map<number, Entity>();
  readonly online = new Set<number>();
  /** Players whose inventory / skills / carving session changed since the server last sent them. */
  readonly invDirty = new Set<number>();
  readonly skillDirty = new Set<number>();
  readonly craftDirty = new Set<number>();
  readonly notices: { player: number; text: string }[] = [];

  /** Terrain obstacles plus nodes, pods and finished blocking structures, for generated chunks. */
  private readonly blocked = new Uint8Array(WORLD_W * WORLD_H);
  private readonly generated = new Uint8Array(CHUNKS_X * CHUNKS_Y);
  /** Tiles a village has levelled: boulders there no longer block. */
  private readonly cleared = new Set<number>();
  readonly villages: VillageSystem;
  readonly pf: Pathfinder;
  readonly rng: Rng;
  private readonly queue: Command[] = [];
  /** Tile -> node, pod or structure standing on it. */
  readonly occupant = new Map<number, Entity>();
  private readonly piles = new Map<number, Entity>();
  /** Tiles whose natural node has been used up, and partial amounts of ones put away half-harvested. */
  readonly depleted = new Set<number>();
  private readonly nodeAmounts = new Map<number, number>();
  private readonly active = new Map<number, { nodes: Entity[]; idle: number }>();
  private readonly populated = new Set<number>();
  readonly crops = new Set<Entity>();
  private readonly fires = new Set<Entity>();
  private readonly names = new Map<number, string>();

  constructor(readonly seed: number) {
    this.surface = new Surface(seed);
    this.pf = new Pathfinder(WORLD_W, WORLD_H, (tx, ty) => this.blockedAt(tx, ty), true);
    this.villages = new VillageSystem(this);
    this.rng = new Rng(hashInts(seed, 0x10ad));
    this.world.onDestroy = (e) => this.grid.remove(e);
    const sys = (name: string, update: (dt: number) => void) => this.world.addSystem({ name, update: (_w, dt) => update(dt) });
    sys('commands', () => this.runCommands());
    sys('pods', () => this.runPods());
    sys('streaming', () => { if (this.tick % 10 === 0) this.runStreaming(); });
    sys('heroInput', (dt) => this.runHeroInput(dt));
    sys('followers', () => this.runFollowers());
    sys('villages', (dt) => this.villages.update(dt));
    sys('jobs', (dt) => this.runJobs(dt));
    sys('movement', (dt) => this.runMovement(dt));
    sys('crops', (dt) => this.runCrops(dt));
    sys('vitals', (dt) => this.runVitals(dt));
  }

  get tick(): number {
    return this.world.tick;
  }

  /** Time of day, 0..24. */
  get hour(): number {
    return ((this.world.tick / DAY_TICKS) * 24 + DAY_START_HOUR) % 24;
  }

  setBlocked(tx: number, ty: number, on: boolean): void {
    this.blockedAt(tx, ty);
    this.blocked[tileIndex(tx, ty)] = on ? 1 : 0;
  }

  /** Remove the resource node on a tile for good, as when ground is cleared for a settlement. */
  clearNode(tx: number, ty: number): void {
    const idx = tileIndex(tx, ty);
    this.depleted.add(idx);
    this.nodeAmounts.delete(idx);
    const e = this.occupant.get(idx);
    if (e !== undefined && this.world.has(e, Node)) {
      this.occupant.delete(idx);
      this.world.remove(e, Node);
      this.world.destroy(e);
      this.blocked[idx] = 0;
    } else if (e === undefined && this.generated[Math.floor(wrapX(tx) / CHUNK_SIZE) + Math.floor(wrapY(ty) / CHUNK_SIZE) * CHUNKS_X]) {
      this.blocked[idx] = this.surface.terrainBlocked(tx, ty) && !this.cleared.has(idx) ? 1 : 0;
    }
  }

  /** Level a tile completely: no node, and any boulder is hauled away. Clients learn of it from what is built there. */
  clearTile(tx: number, ty: number): void {
    const idx = tileIndex(tx, ty);
    this.cleared.add(idx);
    this.clearNode(tx, ty);
    if (!this.occupant.has(idx)) this.blocked[idx] = 0;
  }

  /** Place a finished structure directly, for things a village is founded with. */
  spawnStructure(kind: StructureKind, tx: number, ty: number, owner: number): Entity {
    tx = wrapX(Math.floor(tx)); ty = wrapY(Math.floor(ty));
    const e = this.spawn(EntityKind.Structure, tx + 0.5, ty + 0.5);
    this.world.add(e, Structure, { kind, owner, progress: 100, built: true, crop: CropStage.Empty, cropTimer: 0, seed: Item.Berries, watered: false });
    this.occupant.set(tileIndex(tx, ty), e);
    if (STRUCTURES[kind].blocks) this.setBlocked(tx, ty, true);
    return e;
  }

  step(): void {
    this.world.step(1 / TICK_RATE);
  }

  enqueue(cmd: Command): void {
    if (this.queue.length < 4096) this.queue.push(cmd);
  }

  /** Queue one tick of direct movement input for a player's hero. */
  pushInput(player: number, seq: number, dx: number, dy: number): void {
    const hero = this.heroes.get(player);
    const char = hero !== undefined ? this.world.get(hero, Char) : undefined;
    if (char && char.inputs.length < 12) char.inputs.push({ seq, dx, dy });
  }

  // --- terrain ----------------------------------------------------------------

  private ensureTerrain(cx: number, cy: number): void {
    const ci = cx + cy * CHUNKS_X;
    if (this.generated[ci]) return;
    this.generated[ci] = 1;
    const data = this.surface.chunk(cx, cy);
    for (let j = 0; j < CHUNK_SIZE; j++) for (let i = 0; i < CHUNK_SIZE; i++) {
      const idx = cx * CHUNK_SIZE + i + (cy * CHUNK_SIZE + j) * WORLD_W;
      if (data.blocked[i + j * CHUNK_SIZE] && !this.cleared.has(idx)) this.blocked[idx] = 1;
    }
    for (const n of data.nodes) {
      const idx = tileIndex(n.x, n.y);
      if (!this.depleted.has(idx)) this.blocked[idx] = 1;
    }
  }

  /** Passability of any tile, generating its chunk's terrain on first touch. */
  blockedAt(tx: number, ty: number): boolean {
    tx = wrapX(tx); ty = wrapY(ty);
    this.ensureTerrain(Math.floor(tx / CHUNK_SIZE), Math.floor(ty / CHUNK_SIZE));
    return this.blocked[tx + ty * WORLD_W] === 1;
  }

  /** Bring resource nodes into (and out of) existence around players and their followers. */
  private runStreaming(): void {
    const needed = new Set<number>();
    const want = (x: number, y: number, r: number) => {
      const cx = Math.floor(wrapX(x) / CHUNK_SIZE), cy = Math.floor(wrapY(y) / CHUNK_SIZE);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        needed.add(((cx + dx + CHUNKS_X) % CHUNKS_X) + ((cy + dy + CHUNKS_Y) % CHUNKS_Y) * CHUNKS_X);
      }
    };
    for (const player of this.online) {
      const c = this.viewCenter(player);
      if (c) want(c.x, c.y, AOI_RADIUS);
    }
    // Villages live whether or not anyone is watching, so their land stays loaded.
    for (const v of this.villages.villages) want(v.cx, v.cy + 5, 3);
    // Colonies keep working while their owner is away, so owned units hold their surroundings loaded.
    for (const u of this.world.query(Unit)) {
      if (this.world.get(u, Unit)!.owner === 0) continue;
      const p = this.world.get(u, Position)!;
      want(p.x, p.y, 1);
    }
    for (const ci of needed) {
      const a = this.active.get(ci);
      if (a) a.idle = 0;
      else this.activate(ci);
    }
    for (const [ci, a] of this.active) {
      if (needed.has(ci) || ++a.idle <= 10) continue;
      for (const e of a.nodes) {
        const n = this.world.get(e, Node);
        if (!n || !this.world.isAlive(e)) continue;
        const p = this.world.get(e, Position)!;
        const idx = tileIndex(p.x, p.y);
        if (n.amount < NODES[n.kind].amount) this.nodeAmounts.set(idx, n.amount);
        this.occupant.delete(idx);
        this.world.destroy(e);
      }
      this.active.delete(ci);
    }
  }

  private activate(ci: number): void {
    const cx = ci % CHUNKS_X, cy = Math.floor(ci / CHUNKS_X);
    this.ensureTerrain(cx, cy);
    const nodes: Entity[] = [];
    for (const n of this.surface.chunk(cx, cy).nodes) {
      const idx = tileIndex(n.x, n.y);
      if (this.depleted.has(idx)) continue;
      const e = this.spawn(EntityKind.Node, n.x, n.y);
      this.world.add(e, Node, { kind: n.kind, amount: this.nodeAmounts.get(idx) ?? NODES[n.kind].amount });
      this.occupant.set(idx, e);
      nodes.push(e);
    }
    this.active.set(ci, { nodes, idle: 0 });
    // A few chunks are home to a drifter who can be talked into joining a colony.
    if (!this.populated.has(ci) && hash01(this.seed, cx, cy, 77) < 0.1) {
      this.populated.add(ci);
      this.spawnDrifter((cx + 0.5) * CHUNK_SIZE, (cy + 0.5) * CHUNK_SIZE);
    }
  }

  // --- entity construction ----------------------------------------------------

  spawn(kind: EntityKind, x: number, y: number): Entity {
    const e = this.world.create();
    this.world.add(e, Position, { x, y });
    this.world.add(e, Net, { kind, version: 1, moveTick: this.tick });
    this.grid.update(e, x, y);
    return e;
  }

  bump(e: Entity): void {
    const n = this.world.get(e, Net);
    if (n) n.version++;
  }

  spawnUnit(x: number, y: number, owner: number, name: string, hero: boolean): Entity {
    const e = this.spawn(EntityKind.Unit, x, y);
    this.world.add(e, Unit, { owner, name, hp: 100, maxHp: 100, state: UnitState.Idle, facing: Math.PI / 2, hero, work: 0 });
    this.world.add(e, Inv, newInventory());
    return e;
  }

  private spawnDrifter(x: number, y: number): Entity | null {
    const spot = this.pf.nearestFree(Math.floor(x), Math.floor(y), 8);
    if (!spot || this.surface.isWater(spot[0], spot[1])) return null;
    return this.spawnUnit(spot[0] + 0.5, spot[1] + 0.5, 0, DRIFTER_NAMES[this.rng.int(0, DRIFTER_NAMES.length - 1)], false);
  }

  /** Teleport a unit (used on collapse, and by tests). */
  placeUnit(e: Entity, x: number, y: number): void {
    const p = this.world.get(e, Position)!;
    p.x = wrapX(x); p.y = wrapY(y);
    this.world.get(e, Net)!.moveTick = this.tick;
    this.grid.update(e, p.x, p.y);
  }

  // --- players ----------------------------------------------------------------

  /**
   * Bring a player to the surface. A first visit drops a pod on clear ground in
   * the chosen sector; a returning player is pointed back at their character.
   */
  landPlayer(player: number, name: string, sector: number): { x: number; y: number; fresh: boolean } {
    this.names.set(player, name);
    const existing = this.viewCenter(player);
    if (existing) return { ...existing, fresh: false };
    const [tx, ty] = this.findLandingSite(sector);
    const e = this.spawn(EntityKind.Pod, tx + 0.5, ty + 0.5);
    this.world.add(e, Pod, { owner: player, spawnTick: this.tick, deployed: false, sector });
    this.occupant.set(tileIndex(tx, ty), e);
    this.blocked[tileIndex(tx, ty)] = 1;
    this.pods.set(player, e);
    // Every landing site has a settlement within a few minutes' walk, joined to it by a trail.
    this.villages.ensureNear(tx + 0.5, ty + 0.5);
    return { x: tx + 0.5, y: ty + 0.5, fresh: true };
  }

  /** Where a player's view is centred: their hero, or their pod while it is still falling. */
  viewCenter(player: number): { x: number; y: number } | null {
    const e = this.heroes.get(player) ?? this.pods.get(player);
    const p = e !== undefined ? this.world.get(e, Position) : undefined;
    return p ? { x: p.x, y: p.y } : null;
  }

  private findLandingSite(sector: number): [number, number] {
    const cx = ((sector % SECTOR_COLS) + 0.5) * SECTOR_TILES, cy = (Math.floor(sector / SECTOR_COLS) + 0.5) * SECTOR_TILES;
    for (let attempt = 0; attempt < 500; attempt++) {
      const reach = 3 + attempt * 0.024;
      const tx = wrapX(Math.round(cx + (this.rng.next() * 2 - 1) * reach)), ty = wrapY(Math.round(cy + (this.rng.next() * 2 - 1) * reach));
      let clear = true;
      for (let dy = -2; dy <= 2 && clear; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (this.blockedAt(tx + dx, ty + dy) || this.surface.isWater(tx + dx, ty + dy) || this.occupant.has(tileIndex(tx + dx, ty + dy))) { clear = false; break; }
      }
      if (clear) return [tx, ty];
    }
    return this.pf.nearestFree(Math.floor(cx), Math.floor(cy), 40) ?? [Math.floor(cx), Math.floor(cy)];
  }

  private runPods(): void {
    for (const e of this.world.query(Pod)) {
      const pod = this.world.get(e, Pod)!;
      if (pod.deployed || this.tick < pod.spawnTick + POD_DEPLOY_TICKS) continue;
      pod.deployed = true;
      this.bump(e);
      const pos = this.world.get(e, Position)!;
      const door = this.pf.nearestFree(Math.floor(pos.x), Math.floor(pos.y) + 1, 4) ?? [Math.floor(pos.x), Math.floor(pos.y)];
      const hero = this.spawnUnit(door[0] + 0.5, door[1] + 0.5, pod.owner, this.names.get(pod.owner) ?? 'Colonist', true);
      this.world.add(hero, Char, { player: pod.owner, vitals: newVitals(), skills: newSkills(), craft: null, inputs: [], ack: 0, moved: false, drinkAt: 0, coins: 0 });
      const inv = this.world.get(hero, Inv)!;
      addItem(inv, Item.Shirt); addItem(inv, Item.Trousers); addItem(inv, Item.Berries, 6);
      for (const it of inv.items) if (ITEMS[it.def].slot !== undefined) moveItem(inv, it.uid, Cont.Equip, ITEMS[it.def].slot!, 0, 0);
      this.heroes.set(pod.owner, hero);
      this.invDirty.add(pod.owner); this.skillDirty.add(pod.owner); this.craftDirty.add(pod.owner);
      // Two drifters camp near every landing site, so there is always someone to recruit.
      for (let i = 0; i < 2; i++) {
        const a = this.rng.next() * Math.PI * 2, r = 5 + this.rng.next() * 4;
        this.spawnDrifter(pos.x + Math.cos(a) * r, pos.y + Math.sin(a) * r);
      }
    }
  }

  private notify(u: Entity, text: string): void {
    const c = this.world.get(u, Char);
    if (c) this.notices.push({ player: c.player, text });
  }

  private addXp(u: Entity, skill: Skill, xp: number): void {
    const c = this.world.get(u, Char);
    if (!c) return;
    const before = Math.floor(c.skills[skill]);
    c.skills[skill] += xp;
    if (Math.floor(c.skills[skill]) !== before) this.skillDirty.add(c.player);
    if (levelOf(c.skills[skill]) > levelOf(before)) this.notify(u, 'Skill improved');
  }

  private load(u: Entity): { kg: number; capacity: number; tier: LoadTier } {
    const kg = totalWeight(this.world.get(u, Inv)!);
    const capacity = carryCapacity(this.world.get(u, Char)?.skills[Skill.Conditioning] ?? 0);
    return { kg, capacity, tier: loadTier(kg, capacity) };
  }

  private speedOf(u: Entity, pos: { x: number; y: number }): number {
    const inWater = this.surface.isWater(pos.x, pos.y);
    const c = this.world.get(u, Char);
    if (!c) return NPC_SPEED * (inWater ? 0.55 : 1);
    return moveSpeed(this.load(u).tier, inWater, (c.vitals.status & Status.Exhausted) !== 0, (c.vitals.status & Status.Sprain) !== 0);
  }

  selfState(player: number): SelfState | null {
    const u = this.heroes.get(player);
    if (u === undefined) return null;
    const c = this.world.get(u, Char)!, p = this.world.get(u, Position)!, v = c.vitals;
    return {
      ack: c.ack, x: p.x, y: p.y, hp: v.hp, satiety: v.satiety, hydration: v.hydration, stamina: v.stamina, temp: v.temp,
      status: v.status, ...this.load(u), work: this.world.get(u, Unit)!.work, ambient: this.surface.ambientC(p.x, p.y),
      coins: c.coins, hour: this.hour,
    };
  }

  /** Colonies and players currently on the surface, per orbital sector. */
  sectorCounts(): Map<number, { online: number; colonies: number }> {
    const out = new Map<number, { online: number; colonies: number }>();
    const at = (s: number) => out.get(s) ?? out.set(s, { online: 0, colonies: 0 }).get(s)!;
    for (const e of this.pods.values()) at(this.world.get(e, Pod)!.sector).colonies++;
    for (const player of this.online) {
      const c = this.viewCenter(player);
      if (c) at(sectorOfTile(c.x, c.y)).online++;
    }
    return out;
  }

  // --- commands ---------------------------------------------------------------

  private runCommands(): void {
    for (const cmd of this.queue) {
      const hero = this.heroes.get(cmd.player);
      if (hero === undefined) continue;
      const inv = this.world.get(hero, Inv)!, char = this.world.get(hero, Char)!;
      switch (cmd.type) {
        case 'moveTo':
          this.clearWork(hero);
          if (!this.setPath(hero, cmd.x, cmd.y)) this.notify(hero, 'No way there');
          break;
        case 'interact': this.interact(hero, cmd.target, cmd.player); break;
        case 'build': this.placeBlueprint(hero, cmd.player, cmd.kind, cmd.tx, cmd.ty); break;
        case 'invMove': {
          const err = moveItem(inv, cmd.uid, cmd.c, cmd.x, cmd.y, cmd.rot);
          if (err) this.notify(hero, err);
          this.invDirty.add(cmd.player);
          break;
        }
        case 'invDrop': this.dropFromInventory(hero, inv, cmd.uid); break;
        case 'invUse': this.useItem(hero, inv, char, cmd.uid); break;
        case 'craftStart': this.craftStart(hero, inv, char, cmd.pattern); break;
        case 'craftHit': this.craftHit(hero, inv, char, cmd.x, cmd.y); break;
        case 'craftCancel': if (char.craft) { char.craft = null; this.craftDirty.add(cmd.player); } break;
        case 'recipe': this.startRecipe(hero, cmd.recipe, cmd.station); break;
        case 'order': this.giveOrder(hero, cmd.npc, cmd.order); break;
        case 'drink': this.drink(hero, char); break;
        case 'trade': { const err = this.villages.trade(hero, cmd.building, cmd.item, cmd.qty, cmd.sell); if (err) this.notify(hero, err); break; }
        case 'contract': { const err = this.villages.contract(hero, cmd.building, cmd.id, cmd.deliver); this.notify(hero, err ?? (cmd.deliver ? 'Job done - paid in full' : 'Job accepted')); break; }
      }
    }
    this.queue.length = 0;
  }

  private clearWork(u: Entity): void {
    this.world.remove(u, Job);
    const c = this.world.get(u, Char);
    if (c?.craft) { c.craft = null; this.craftDirty.add(c.player); }
    const unit = this.world.get(u, Unit)!;
    unit.work = 0;
  }

  private setJob(u: Entity, kind: JobKind, target: Entity, extra: Partial<JobData> = {}): void {
    this.clearWork(u);
    this.world.remove(u, Path);
    this.world.add(u, Job, { kind, target, timer: 0, harvest: null, recipe: 0, ...extra });
    this.bump(u);
  }

  private interact(hero: Entity, target: Entity, player: number): void {
    if (!this.world.isAlive(target) || target === hero) return;
    const node = this.world.get(target, Node), st = this.world.get(target, Structure), unit = this.world.get(target, Unit);
    if (node) this.setJob(hero, JobKind.Harvest, target, { harvest: node.kind });
    else if (this.world.has(target, Pile)) this.setJob(hero, JobKind.Pickup, target);
    else if (st && !st.built) {
      if (st.owner === player) this.setJob(hero, JobKind.Build, target);
    } else if (st) this.setJob(hero, st.kind === StructureKind.GardenPlot ? JobKind.Tend : JobKind.Goto, target);
    else if (this.world.has(target, Wolf)) this.setJob(hero, JobKind.Attack, target);
    else if (this.world.has(target, Building)) {
      // Walk to the doorstep; trading and the job board are separate, explicit commands.
      const b = this.world.get(target, Building)!, front = layoutOf(b.type as BuildingType, b.flip).front;
      this.clearWork(hero);
      this.setPath(hero, b.ox + front[0] + 0.5, b.oy + front[1] + 0.5);
    } else if (unit && !unit.hero && unit.owner === 0) this.setJob(hero, JobKind.Recruit, target);
  }

  private nearWater(p: { x: number; y: number }): boolean {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (this.surface.isWater(p.x + dx, p.y + dy)) return true;
      const e = this.occupant.get(tileIndex(p.x + dx, p.y + dy));
      if (e !== undefined && this.world.get(e, Structure)?.kind === StructureKind.Well) return true;
    }
    return false;
  }

  private drink(hero: Entity, char: CharData): void {
    if (this.tick < char.drinkAt) return;
    if (!this.nearWater(this.world.get(hero, Position)!)) { this.notify(hero, 'No water within reach'); return; }
    char.drinkAt = this.tick + TICK_RATE;
    char.vitals.hydration = Math.min(100, char.vitals.hydration + 30);
  }

  private dropFromInventory(hero: Entity, inv: Inventory, uid: number): void {
    const k = inv.items.findIndex((i) => i.uid === uid);
    if (k < 0) return;
    const it = inv.items[k], def = ITEMS[it.def];
    if (def.grid && it.c === Cont.Equip && inv.items.some((o) => o.c === (def.slot === Slot.Belt ? Cont.BeltGrid : Cont.PackGrid))) {
      this.notify(hero, 'Empty it first');
      return;
    }
    inv.items.splice(k, 1);
    const p = this.world.get(hero, Position)!;
    this.dropPile(it.def, it.qty, it.dur, p.x, p.y);
    this.invDirty.add(this.world.get(hero, Char)!.player);
  }

  private useItem(hero: Entity, inv: Inventory, char: CharData, uid: number): void {
    const it = inv.items.find((i) => i.uid === uid);
    if (!it) return;
    const def = ITEMS[it.def], v = char.vitals;
    if (def.food) {
      v.satiety = Math.min(100, v.satiety + def.food.satiety);
      v.hydration = Math.min(100, v.hydration + def.food.hydration);
      removeItem(inv, it.def, 1);
    } else if (it.def === Item.WaterPot) {
      v.hydration = Math.min(100, v.hydration + 40);
      if (--it.dur <= 0) { it.def = Item.ClayPot; it.dur = 0; }
    } else if (it.def === Item.ClayPot) {
      if (!this.nearWater(this.world.get(hero, Position)!)) { this.notify(hero, 'Stand beside water to fill it'); return; }
      it.def = Item.WaterPot; it.dur = 3;
    } else if (def.slot !== undefined) {
      // Toggle: wear it, or take it off into the first free space.
      const spot = it.c === Cont.Equip ? findSpace(inv, it.def) : { c: Cont.Equip, x: def.slot, y: 0, rot: 0 };
      const err = spot ? moveItem(inv, uid, spot.c, spot.x, spot.y, spot.rot) : 'No room to take it off';
      if (err) this.notify(hero, err);
    } else return;
    this.invDirty.add(char.player);
  }

  // --- carving (knapping and clay forming) ------------------------------------

  private craftStart(hero: Entity, inv: Inventory, char: CharData, id: PatternId): void {
    const p = PATTERNS[id];
    if (!p) return;
    if (countItem(inv, p.input) < p.inputQty) { this.notify(hero, `Need ${p.inputQty}x ${ITEMS[p.input].name}`); return; }
    if (p.tool && !bestTool(inv, p.tool)) { this.notify(hero, 'Need a stone to strike with'); return; }
    this.world.remove(hero, Job);
    this.world.remove(hero, Path);
    const full = p.mode === 'carve';
    char.craft = {
      pattern: id, cells: new Array<number>(PATTERN_SIZE).fill(full ? FULL_PATTERN : 0),
      mistakes: full ? 1 + Math.floor(levelOf(char.skills[Skill.Knapping]) / 2) : 0,
    };
    this.craftDirty.add(char.player);
  }

  private craftHit(hero: Entity, inv: Inventory, char: CharData, x: number, y: number): void {
    const s = char.craft;
    if (!s || x < 0 || y < 0 || x >= PATTERN_SIZE || y >= PATTERN_SIZE) return;
    const p = PATTERNS[s.pattern];
    const has = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < PATTERN_SIZE && cy < PATTERN_SIZE && (s.cells[cy] >> cx & 1) === 1;
    const wanted = (p.rows[y] >> x & 1) === 1;
    this.craftDirty.add(char.player);
    if (p.mode === 'form') s.cells[y] ^= 1 << x;
    else {
      if (!has(x, y)) return;
      // Flakes only come off an exposed edge, never out of the middle of the stone.
      if (has(x - 1, y) && has(x + 1, y) && has(x, y - 1) && has(x, y + 1)) { this.notify(hero, 'Strike from an exposed edge'); return; }
      if (wanted) {
        if (--s.mistakes < 0) {
          removeItem(inv, p.input, 1);
          char.craft = null;
          this.invDirty.add(char.player);
          this.addXp(hero, Skill.Knapping, 2);
          this.notify(hero, 'The flint shatters');
        } else this.notify(hero, 'A glancing blow - careful');
        return;
      }
      s.cells[y] &= ~(1 << x);
    }
    if (!s.cells.every((row, i) => row === p.rows[i])) return;
    char.craft = null;
    if (removeItem(inv, p.input, p.inputQty) < p.inputQty) { this.notify(hero, 'Materials are gone'); this.invDirty.add(char.player); return; }
    this.give(hero, p.output, 1);
    this.addXp(hero, Skill.Knapping, p.xp);
    this.notify(hero, `Made: ${ITEMS[p.output].name}`);
  }

  // --- materials, piles and recipes -------------------------------------------

  /** Put items on the ground at the nearest tile that is free or already holds the same thing. */
  dropPile(item: Item, qty: number, dur: number, x: number, y: number): void {
    const stackable = ITEMS[item].stack > 1;
    for (let r = 0; r <= 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const tx = Math.floor(x) + dx, ty = Math.floor(y) + dy, idx = tileIndex(tx, ty);
      if (this.blockedAt(tx, ty) || this.occupant.has(idx)) continue;
      const there = this.piles.get(idx);
      const pile = there !== undefined ? this.world.get(there, Pile) : undefined;
      if (pile) {
        if (!stackable || pile.item !== item || pile.qty + qty > 250) continue;
        pile.qty += qty;
        this.bump(there!);
        return;
      }
      const e = this.spawn(EntityKind.Pile, wrapX(tx) + 0.5, wrapY(ty) + 0.5);
      this.world.add(e, Pile, { item, qty, dur });
      this.piles.set(idx, e);
      return;
    }
  }

  private pilesNear(x: number, y: number, item: Item): Entity[] {
    const out: Entity[] = [];
    this.grid.forEachNear(x, y, SITE_RADIUS, (e) => {
      const p = this.world.get(e, Pile);
      if (!p || p.item !== item) return;
      const pos = this.world.get(e, Position)!;
      if (wrapDist(x, y, pos.x, pos.y) <= SITE_RADIUS) out.push(e);
    });
    return out;
  }

  /** Units of an item on hand: carried, plus lying within reach of the work site. */
  private available(inv: Inventory, item: Item, x: number, y: number): number {
    let n = countItem(inv, item);
    for (const e of this.pilesNear(x, y, item)) n += this.world.get(e, Pile)!.qty;
    return n;
  }

  private consume(u: Entity, inv: Inventory, item: Item, qty: number, x: number, y: number): void {
    // Use what is lying on site first, so carried stock is spent last.
    for (const e of this.pilesNear(x, y, item)) {
      if (qty <= 0) break;
      const p = this.world.get(e, Pile)!;
      const n = Math.min(qty, p.qty);
      p.qty -= n; qty -= n;
      if (p.qty <= 0) this.removePile(e); else this.bump(e);
    }
    if (qty > 0 && removeItem(inv, item, qty) > 0) {
      const c = this.world.get(u, Char);
      if (c) this.invDirty.add(c.player);
    }
  }

  private removePile(e: Entity): void {
    const pos = this.world.get(e, Position)!;
    this.piles.delete(tileIndex(pos.x, pos.y));
    this.world.remove(e, Pile);
    this.world.destroy(e);
  }

  /** Hand items to a unit, spilling what does not fit onto the ground. Returns true if anything spilled. */
  give(u: Entity, item: Item, qty: number, dur?: number): boolean {
    const inv = this.world.get(u, Inv)!;
    const left = addItem(inv, item, qty, dur);
    const c = this.world.get(u, Char);
    if (c) this.invDirty.add(c.player);
    if (left <= 0) return false;
    const p = this.world.get(u, Position)!;
    this.dropPile(item, left, dur ?? ITEMS[item].tool?.dur ?? 0, p.x, p.y);
    this.notify(u, 'No room - left on the ground');
    return true;
  }

  private wearTool(u: Entity, inv: Inventory, uid: number, amount = 1): void {
    const it = inv.items.find((i) => i.uid === uid);
    if (!it || ITEMS[it.def].tool!.dur === 0) return;
    it.dur -= amount;
    if (it.dur <= 0) {
      inv.items.splice(inv.items.indexOf(it), 1);
      this.notify(u, `${ITEMS[it.def].name} broke`);
    }
    const c = this.world.get(u, Char);
    if (c) this.invDirty.add(c.player);
  }

  /** Why a recipe cannot be worked right now, or null if everything is to hand. */
  private recipeProblem(inv: Inventory, r: Recipe, x: number, y: number): string | null {
    if (r.tool && !bestTool(inv, r.tool)) return `Need a ${r.tool === 'hammer' ? 'hammerstone' : r.tool}`;
    for (const c of r.inputs) if (this.available(inv, c.item, x, y) < c.qty) return `Need ${c.qty}x ${ITEMS[c.item].name}`;
    return null;
  }

  private startRecipe(hero: Entity, index: number, station: Entity): void {
    const r = RECIPES[index];
    if (!r) return;
    const pos = this.world.get(hero, Position)!;
    let at = pos;
    if (r.station !== null) {
      const st = this.world.get(station, Structure);
      if (!st || !st.built || st.kind !== r.station) { this.notify(hero, `Needs a ${STRUCTURES[r.station].name.toLowerCase()}`); return; }
      at = this.world.get(station, Position)!;
    }
    const problem = this.recipeProblem(this.world.get(hero, Inv)!, r, at.x, at.y);
    if (problem) { this.notify(hero, problem); return; }
    this.setJob(hero, JobKind.Craft, r.station === null ? 0 : station, { recipe: index });
  }

  private placeBlueprint(hero: Entity, player: number, kind: StructureKind, tx: number, ty: number): void {
    const def = STRUCTURES[kind];
    if (!def) return;
    tx = wrapX(Math.floor(tx)); ty = wrapY(Math.floor(ty));
    const pos = this.world.get(hero, Position)!, inv = this.world.get(hero, Inv)!;
    const idx = tileIndex(tx, ty);
    if (wrapDist(pos.x, pos.y, tx + 0.5, ty + 0.5) > 10) { this.notify(hero, 'Too far away'); return; }
    if (this.blockedAt(tx, ty) || this.occupant.has(idx) || this.surface.isWater(tx, ty)) { this.notify(hero, 'Site obstructed'); return; }
    const tool = def.tool ? bestTool(inv, def.tool) : undefined;
    if (def.tool && !tool) { this.notify(hero, `Need a ${def.tool}`); return; }
    const lacking = def.cost.find((c) => this.available(inv, c.item, tx + 0.5, ty + 0.5) < c.qty);
    if (lacking) { this.notify(hero, `Need ${lacking.qty}x ${ITEMS[lacking.item].name}`); return; }
    for (const c of def.cost) this.consume(hero, inv, c.item, c.qty, tx + 0.5, ty + 0.5);
    if (tool) this.wearTool(hero, inv, tool.uid, 2);
    const e = this.spawn(EntityKind.Structure, tx + 0.5, ty + 0.5);
    this.world.add(e, Structure, { kind, owner: player, progress: 0, built: false, crop: CropStage.Empty, cropTimer: 0, seed: Item.Berries, watered: false });
    this.occupant.set(idx, e);
    if (!this.world.has(hero, Job)) this.setJob(hero, JobKind.Build, e);
  }

  private giveOrder(hero: Entity, npc: Entity, order: Order): void {
    const f = this.world.get(npc, Follower);
    if (!f || f.leader !== hero || !(order in Order)) return;
    const pos = this.world.get(hero, Position)!;
    f.order = order; f.ax = pos.x; f.ay = pos.y; f.hauling = false;
    this.world.remove(npc, Job);
    this.stop(npc, this.world.get(npc, Unit)!);
  }

  // --- hero input -------------------------------------------------------------

  private runHeroInput(dt: number): void {
    for (const u of this.world.query(Char)) {
      const c = this.world.get(u, Char)!, unit = this.world.get(u, Unit)!, pos = this.world.get(u, Position)!;
      // Normally one input per tick; take two when the queue has built up after a network hiccup.
      for (let n = c.inputs.length > 2 ? 2 : 1; n > 0 && c.inputs.length > 0; n--) {
        const inp = c.inputs.shift()!;
        c.ack = inp.seq;
        if (inp.dx === 0 && inp.dy === 0) continue;
        if (this.world.has(u, Path) || this.world.has(u, Job) || c.craft) {
          this.world.remove(u, Path);
          this.clearWork(u);
          this.bump(u);
        }
        moveStep(pos, inp.dx, inp.dy, this.speedOf(u, pos) * dt, (tx, ty) => this.blockedAt(tx, ty));
        unit.facing = Math.atan2(inp.dy, inp.dx);
        this.world.get(u, Net)!.moveTick = this.tick;
        this.grid.update(u, pos.x, pos.y);
        c.moved = true;
        if (unit.state !== UnitState.Moving) { unit.state = UnitState.Moving; this.bump(u); }
      }
      if (!c.moved && unit.state === UnitState.Moving && !this.world.has(u, Path)) { unit.state = UnitState.Idle; this.bump(u); }
    }
  }

  // --- followers --------------------------------------------------------------

  private runFollowers(): void {
    for (const u of this.world.query(Follower)) {
      if ((this.tick + u) % 10 !== 0) continue;
      const f = this.world.get(u, Follower)!, pos = this.world.get(u, Position)!, unit = this.world.get(u, Unit)!;
      const leaderPos = this.world.get(f.leader, Position);
      if (!leaderPos) continue;
      if (f.order === Order.Follow) {
        const d = wrapDist(pos.x, pos.y, leaderPos.x, leaderPos.y);
        if (d > 3 && d < MAX_PATH_RANGE) {
          // Stop a pace and a half short so followers gather round rather than stand on their leader.
          const k = 1.5 / d;
          this.setPath(u, leaderPos.x - wrapDX(leaderPos.x - pos.x) * k, leaderPos.y - wrapDY(leaderPos.y - pos.y) * k);
        }
        continue;
      }
      if (f.order === Order.Stay || this.world.has(u, Job)) continue;
      const inv = this.world.get(u, Inv)!;
      if (f.hauling) {
        if (wrapDist(pos.x, pos.y, f.ax, f.ay) > 1.8) {
          if (!this.world.has(u, Path) && !this.setPath(u, f.ax, f.ay)) f.hauling = false;
        } else {
          for (const it of inv.items) this.dropPile(it.def, it.qty, it.dur, f.ax, f.ay);
          inv.items.length = 0;
          f.hauling = false;
        }
        continue;
      }
      const owner = unit.owner;
      const want = (e: Entity): JobKind | null => {
        const node = this.world.get(e, Node), st = this.world.get(e, Structure);
        if (node) {
          const k = node.kind;
          if (f.order === Order.Wood) return k === NodeKind.Tree ? JobKind.Harvest : null;
          if (f.order === Order.Stone) return k === NodeKind.Stone || k === NodeKind.Ore || k === NodeKind.Clay ? JobKind.Harvest : null;
          if (f.order === Order.Forage) return k === NodeKind.Bush || k === NodeKind.Reeds ? JobKind.Harvest : null;
        } else if (st && st.owner === owner) {
          if (f.order === Order.Build && !st.built) return JobKind.Build;
          if (f.order === Order.Forage && st.built && st.kind === StructureKind.GardenPlot
            && (st.crop === CropStage.Ripe || (st.crop === CropStage.Empty && countItem(inv, Item.Berries) > 0))) return JobKind.Tend;
        }
        return null;
      };
      const target = this.nearest(f.ax, f.ay, 14, (e) => want(e) !== null, pos.x, pos.y);
      if (target !== undefined) {
        const kind = want(target)!;
        this.world.add(u, Job, { kind, target, timer: 0, harvest: this.world.get(target, Node)?.kind ?? null, recipe: 0 });
      } else if (inv.items.length > 0) f.hauling = true;
      else if (wrapDist(pos.x, pos.y, f.ax, f.ay) > 3 && !this.world.has(u, Path)) this.setPath(u, f.ax, f.ay);
    }
  }

  // --- jobs -------------------------------------------------------------------

  private runJobs(dt: number): void {
    for (const u of this.world.query(Job, Unit)) {
      if (this.world.has(u, Path)) continue;
      const job = this.world.get(u, Job)!, unit = this.world.get(u, Unit)!, pos = this.world.get(u, Position)!;
      if (job.kind === JobKind.Craft && job.target === 0) { this.workRecipe(u, unit, job, pos, dt); continue; }
      const tpos = this.world.get(job.target, Position);
      const node = this.world.get(job.target, Node), st = this.world.get(job.target, Structure);
      const valid = tpos && this.world.isAlive(job.target) && (
        job.kind === JobKind.Harvest ? !!node
          : job.kind === JobKind.Build ? !!st && !st.built
            : job.kind === JobKind.Pickup ? this.world.has(job.target, Pile)
              : job.kind === JobKind.Recruit ? this.world.get(job.target, Unit)?.owner === 0 && !this.world.has(job.target, Wolf)
                : job.kind === JobKind.Attack ? this.world.has(job.target, Wolf)
                  : !!st && st.built);
      if (!tpos || !valid) { this.retarget(u, unit, pos, job); continue; }

      const tx = Math.floor(tpos.x), ty = Math.floor(tpos.y);
      const reach = Math.max(Math.abs(wrapDX(tx - Math.floor(pos.x))), Math.abs(wrapDY(ty - Math.floor(pos.y))));
      // Workers stand beside solid things, but may stand on a pile, a plot or a floor being laid.
      const standOn = job.kind === JobKind.Pickup || job.kind === JobKind.Tend || job.kind === JobKind.Recruit || job.kind === JobKind.Attack
        || (job.kind === JobKind.Build && !STRUCTURES[st!.kind].blocks);
      if (reach > 1 || (reach === 0 && !standOn)) {
        if (!this.approach(u, pos, tx, ty, standOn)) { this.notify(u, 'Cannot reach that'); this.endJob(u, unit); }
        continue;
      }
      const facing = reach === 0 ? unit.facing : Math.atan2(wrapDY(tpos.y - pos.y), wrapDX(tpos.x - pos.x));
      const state = job.kind === JobKind.Harvest || job.kind === JobKind.Tend ? UnitState.Harvesting
        : job.kind === JobKind.Build ? UnitState.Building : job.kind === JobKind.Craft ? UnitState.Crafting
          : job.kind === JobKind.Attack ? UnitState.Fighting : UnitState.Idle;
      if (unit.state !== state || Math.abs(unit.facing - facing) > 0.01) { unit.state = state; unit.facing = facing; this.bump(u); }

      switch (job.kind) {
        case JobKind.Attack: {
          job.timer += dt;
          if (job.timer < 0.9) break;
          job.timer = 0;
          // A weapon in the pack does the work: spear, then axe, then knife, then bare fists.
          const inv = this.world.get(u, Inv)!;
          const weapon = bestTool(inv, 'spear') ?? bestTool(inv, 'axe') ?? bestTool(inv, 'knife');
          const bonus = weapon ? (ITEMS[weapon.def].tool!.type === 'spear' ? 9 : ITEMS[weapon.def].tool!.type === 'axe' ? 5 : 3) : 0;
          const damage = 4 + bonus + 2 * levelOf(this.world.get(u, Char)?.skills[Skill.Combat] ?? 0);
          if (weapon) this.wearTool(u, inv, weapon.uid);
          this.addXp(u, Skill.Combat, 4);
          if (this.villages.hurtWolf(job.target, damage)) { this.notify(u, 'The wolf is dead'); this.endJob(u, unit); }
          break;
        }
        case JobKind.Harvest: this.workHarvest(u, unit, job, pos, dt); break;
        case JobKind.Build: {
          const step = Math.floor(st!.progress / 5);
          st!.progress = Math.min(100, st!.progress + BUILD_RATE * workSpeed(this.world.get(u, Char)?.skills[Skill.Carpentry] ?? 0) * dt);
          unit.work = st!.progress;
          if (st!.progress >= 100 && this.finishStructure(job.target, tx, ty)) {
            this.addXp(u, Skill.Carpentry, 8);
            this.retarget(u, unit, pos, job);
          } else if (Math.floor(st!.progress / 5) !== step) this.bump(job.target);
          break;
        }
        case JobKind.Pickup: {
          const pile = this.world.get(job.target, Pile)!;
          const left = addItem(this.world.get(u, Inv)!, pile.item, pile.qty, pile.dur);
          if (left === 0) this.removePile(job.target);
          else { if (left === pile.qty) this.notify(u, 'No room for that'); pile.qty = left; this.bump(job.target); }
          const c = this.world.get(u, Char);
          if (c) this.invDirty.add(c.player);
          this.endJob(u, unit);
          break;
        }
        case JobKind.Craft: this.workRecipe(u, unit, job, tpos, dt); break;
        case JobKind.Recruit: {
          const inv = this.world.get(u, Inv)!, npc = this.world.get(job.target, Unit)!;
          if (countItem(inv, Item.Berries) < RECRUIT_BERRIES) this.notify(u, `${npc.name} wants ${RECRUIT_BERRIES} berries to join you`);
          else {
            removeItem(inv, Item.Berries, RECRUIT_BERRIES);
            this.invDirty.add(unit.owner);
            npc.owner = unit.owner;
            this.world.add(job.target, Follower, { leader: u, order: Order.Follow, ax: pos.x, ay: pos.y, hauling: false });
            this.bump(job.target);
            this.notify(u, `${npc.name} has joined you`);
          }
          this.endJob(u, unit);
          break;
        }
        case JobKind.Tend: {
          const inv = this.world.get(u, Inv)!;
          if (st!.crop === CropStage.Ripe) {
            st!.crop = CropStage.Empty;
            st!.watered = false;
            this.give(u, st!.seed, 3 + Math.floor(levelOf(this.world.get(u, Char)?.skills[Skill.Farming] ?? 0) / 3));
            this.addXp(u, Skill.Farming, 6);
          } else if (st!.crop === CropStage.Empty) {
            // Grain if there is any to hand, berries otherwise; the plot yields what was sown.
            const seed = countItem(inv, Item.Grain) > 0 ? Item.Grain : Item.Berries;
            if (removeItem(inv, seed, 1) === 0) this.notify(u, 'Need grain or berries to plant');
            else {
              st!.crop = CropStage.Sown; st!.cropTimer = 0; st!.seed = seed;
              this.crops.add(job.target);
              this.addXp(u, Skill.Farming, 3);
              const c = this.world.get(u, Char);
              if (c) this.invDirty.add(c.player);
            }
          } else this.notify(u, 'Not ripe yet');
          this.bump(job.target);
          this.endJob(u, unit);
          break;
        }
        case JobKind.Goto: this.endJob(u, unit); break;
      }
    }
  }

  private workHarvest(u: Entity, unit: UnitData, job: JobData, pos: { x: number; y: number }, dt: number): void {
    const node = this.world.get(job.target, Node)!, def = NODES[node.kind];
    const inv = this.world.get(u, Inv)!, char = this.world.get(u, Char), follower = this.world.get(u, Follower);
    // Followers bring their own crude tools; a player character needs the real thing in their pack.
    const tool = def.tool && char ? bestTool(inv, def.tool) : undefined;
    const tier = tool ? ITEMS[tool.def].tool!.tier : def.tool && !char ? 1 : 0;
    if (tier === 0 && def.bare === 'none') { this.notify(u, `Need a ${def.tool} to work this`); this.endJob(u, unit); return; }
    if (tier === 0 && def.bare === 'limited' && node.amount <= def.handFloor!) { this.notify(u, `Need an ${def.tool} to fell this`); this.endJob(u, unit); return; }
    const rate = (char ? workSpeed(char.skills[def.skill]) : 1) * (tier > 0 ? 1 + 0.5 * tier : def.tool ? 0.6 : 1)
      * (char && char.vitals.status & Status.ScrapedHands ? 0.8 : 1);
    job.timer += dt * rate;
    unit.work = Math.min(100, (job.timer / def.interval) * 100);
    if (job.timer < def.interval) return;
    job.timer = 0; unit.work = 0;
    node.amount--;
    let item = Item.Stick, qty = 1;
    switch (node.kind) {
      case NodeKind.Tree: if (tier > 0 && node.amount % 2 === 0) item = Item.Log; break;
      case NodeKind.Stone: item = this.rng.next() < 0.4 ? Item.Flint : Item.Stone; break;
      case NodeKind.Ore: item = Item.Ore; break;
      case NodeKind.Clay: item = Item.Clay; break;
      case NodeKind.Bush: if (node.amount % 2 === 1) item = Item.Fiber; else { item = Item.Berries; qty = 2; } break;
      case NodeKind.Reeds: item = Item.Fiber; qty = 2; break;
    }
    const spilled = this.give(u, item, qty);
    this.addXp(u, def.skill, 2);
    if (tool) this.wearTool(u, inv, tool.uid);
    if (char && tier === 0 && node.kind === NodeKind.Stone && !equipped(inv, Slot.Hands) && this.rng.next() < 0.08) {
      char.vitals.scraped = 60;
      this.notify(u, 'You scrape your hands on the stone');
    }
    this.bump(job.target);
    if (node.amount <= 0) {
      const tp = this.world.get(job.target, Position)!, idx = tileIndex(tp.x, tp.y);
      this.depleted.add(idx);
      this.nodeAmounts.delete(idx);
      this.occupant.delete(idx);
      this.blocked[idx] = 0;
      this.world.remove(job.target, Node);
      this.world.destroy(job.target);
    }
    if (follower && (spilled || totalWeight(inv) >= 10)) {
      follower.hauling = true;
      this.endJob(u, unit);
    } else if (node.amount <= 0) this.retarget(u, unit, pos, job);
  }

  private workRecipe(u: Entity, unit: UnitData, job: JobData, at: { x: number; y: number }, dt: number): void {
    const r = RECIPES[job.recipe], inv = this.world.get(u, Inv)!;
    const problem = this.recipeProblem(inv, r, at.x, at.y);
    if (problem) { this.notify(u, problem); this.endJob(u, unit); return; }
    if (unit.state !== UnitState.Crafting) { unit.state = UnitState.Crafting; this.bump(u); }
    job.timer += dt * workSpeed(this.world.get(u, Char)?.skills[r.skill] ?? 0);
    unit.work = Math.min(100, (job.timer / r.seconds) * 100);
    if (job.timer < r.seconds) return;
    for (const c of r.inputs) this.consume(u, inv, c.item, c.qty, at.x, at.y);
    const tool = r.tool ? bestTool(inv, r.tool) : undefined;
    if (tool) this.wearTool(u, inv, tool.uid, 2);
    // Better craftsmen make tools that last longer.
    const made = ITEMS[r.output].tool;
    const dur = made && made.dur > 0 ? Math.round(made.dur * (1 + 0.08 * levelOf(this.world.get(u, Char)?.skills[r.skill] ?? 0))) : undefined;
    this.give(u, r.output, r.outputQty, dur);
    this.addXp(u, r.skill, r.xp);
    this.notify(u, `Made: ${ITEMS[r.output].name}`);
    this.endJob(u, unit);
  }

  /** Complete a structure, unless a unit is standing where a solid one would go. */
  private finishStructure(e: Entity, tx: number, ty: number): boolean {
    const s = this.world.get(e, Structure)!;
    if (STRUCTURES[s.kind].blocks) {
      let obstructed = false;
      this.grid.forEachNear(tx + 0.5, ty + 0.5, 1, (o) => {
        const p = this.world.get(o, Position)!;
        if (this.world.has(o, Unit) && Math.floor(p.x) === tx && Math.floor(p.y) === ty) obstructed = true;
      });
      if (obstructed) return false;
      this.blocked[tileIndex(tx, ty)] = 1;
    }
    s.built = true;
    if (s.kind === StructureKind.Campfire) this.fires.add(e);
    this.bump(e);
    return true;
  }

  /** Carry on with the nearest job of the same sort, or go idle when there is none. */
  private retarget(u: Entity, unit: UnitData, pos: { x: number; y: number }, job: JobData): void {
    let next: Entity | undefined;
    if (job.kind === JobKind.Harvest && job.harvest !== null) next = this.nearest(pos.x, pos.y, 8, (e) => this.world.get(e, Node)?.kind === job.harvest);
    else if (job.kind === JobKind.Build) {
      next = this.nearest(pos.x, pos.y, 12, (e) => {
        const s = this.world.get(e, Structure);
        return !!s && !s.built && s.owner === unit.owner;
      });
    }
    if (next === undefined) this.endJob(u, unit);
    else { job.target = next; job.timer = 0; }
  }

  // --- movement ---------------------------------------------------------------

  private runMovement(dt: number): void {
    for (const u of this.world.query(Path, Unit)) {
      const path = this.world.get(u, Path)!, pos = this.world.get(u, Position)!, unit = this.world.get(u, Unit)!;
      let budget = this.speedOf(u, pos) * dt;
      let nx = pos.x, ny = pos.y, reached = false;
      while (budget > 0 && path.idx * 2 < path.pts.length) {
        const dx = wrapDX(path.pts[path.idx * 2] - nx), dy = wrapDY(path.pts[path.idx * 2 + 1] - ny);
        const d = Math.hypot(dx, dy);
        if (d > 1e-6) unit.facing = Math.atan2(dy, dx);
        const step = Math.min(d, budget);
        if (d > 1e-6) { nx += (dx / d) * step; ny += (dy / d) * step; }
        budget -= step;
        if (d <= step + 1e-9) { path.idx++; reached = true; }
      }
      // A wall may have gone up across the route since it was planned.
      if (this.blockedAt(Math.floor(nx), Math.floor(ny)) && tileIndex(nx, ny) !== tileIndex(pos.x, pos.y)) {
        const n = path.pts.length;
        if (!this.setPath(u, path.pts[n - 2], path.pts[n - 1])) this.stop(u, unit);
        continue;
      }
      pos.x = wrapX(nx); pos.y = wrapY(ny);
      this.world.get(u, Net)!.moveTick = this.tick;
      this.grid.update(u, pos.x, pos.y);
      const c = this.world.get(u, Char);
      if (c) c.moved = true;
      if (path.idx * 2 >= path.pts.length) this.stop(u, unit);
      else if (reached) this.bump(u);
    }
  }

  setPath(u: Entity, x: number, y: number): boolean {
    const pos = this.world.get(u, Position)!;
    if (wrapDist(pos.x, pos.y, x, y) > MAX_PATH_RANGE) return false;
    const pts = this.pf.findPath(pos.x, pos.y, wrapX(x), wrapY(y));
    if (!pts || pts.length === 0) return false;
    this.world.add(u, Path, { pts, idx: 0 });
    this.world.get(u, Unit)!.state = UnitState.Moving;
    this.bump(u);
    return true;
  }

  stop(u: Entity, unit: UnitData): void {
    this.world.remove(u, Path);
    unit.state = UnitState.Idle;
    this.bump(u);
  }

  endJob(u: Entity, unit: UnitData): void {
    this.world.remove(u, Job);
    unit.work = 0;
    this.stop(u, unit);
  }

  /** Walk to the closest free tile beside (or, when allowed, on) a target tile. */
  approach(u: Entity, pos: { x: number; y: number }, tx: number, ty: number, allowOn: boolean): boolean {
    const options: [number, number, number][] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0 && !allowOn) continue;
      const x = tx + dx, y = ty + dy;
      if (this.blockedAt(x, y)) continue;
      options.push([wrapDist(pos.x, pos.y, x + 0.5, y + 0.5), x, y]);
    }
    options.sort((a, b) => a[0] - b[0]);
    for (const [, x, y] of options) if (this.setPath(u, x + 0.5, y + 0.5)) return true;
    return false;
  }

  /** Closest accepted entity within `radius` of (x, y), measured from (fromX, fromY) when given. */
  nearest(x: number, y: number, radius: number, accept: (e: Entity) => boolean, fromX = x, fromY = y): Entity | undefined {
    let best: Entity | undefined, bestD = Infinity;
    this.grid.forEachNear(x, y, radius, (e) => {
      const p = this.world.get(e, Position);
      if (!p || wrapDist(x, y, p.x, p.y) > radius || !accept(e)) return;
      const d = wrapDist(fromX, fromY, p.x, p.y);
      if (d < bestD) { bestD = d; best = e; }
    });
    return best;
  }

  // --- crops and vitals -------------------------------------------------------

  private runCrops(dt: number): void {
    for (const e of this.crops) {
      const s = this.world.get(e, Structure);
      if (!s || s.crop === CropStage.Empty || s.crop === CropStage.Ripe) { this.crops.delete(e); continue; }
      s.cropTimer += dt * (s.watered ? 2 : 1);
      const stage = s.cropTimer >= CROP_RIPE ? CropStage.Ripe : s.cropTimer >= CROP_SPROUT ? CropStage.Sprout : CropStage.Sown;
      if (stage !== s.crop) { s.crop = stage; this.bump(e); }
    }
  }

  private runVitals(dt: number): void {
    for (const u of this.world.query(Char)) {
      const c = this.world.get(u, Char)!, unit = this.world.get(u, Unit)!, pos = this.world.get(u, Position)!;
      const inv = this.world.get(u, Inv)!;
      const { tier } = this.load(u);
      let nearFire = false;
      for (const f of this.fires) {
        const fp = this.world.get(f, Position);
        if (fp && wrapDist(pos.x, pos.y, fp.x, fp.y) <= 4) { nearFire = true; break; }
      }
      const moving = c.moved;
      c.moved = false;
      const collapsed = tickVitals(c.vitals, dt, {
        ambient: this.surface.ambientC(pos.x, pos.y), insulation: wornWarmth(inv), shade: !!equipped(inv, Slot.Head), nearFire,
        inWater: this.surface.isWater(pos.x, pos.y), moving, working: unit.state >= UnitState.Harvesting, tier,
      });
      // Carrying real weight is what builds carrying capacity.
      if (moving && tier >= LoadTier.Medium) this.addXp(u, Skill.Conditioning, dt * 0.4 * tier);
      if (Math.round(c.vitals.hp) !== unit.hp) { unit.hp = Math.round(c.vitals.hp); this.bump(u); }
      if (!collapsed) continue;
      const pod = this.pods.get(c.player);
      const home = pod !== undefined ? this.world.get(pod, Position)! : pos;
      const spot = this.pf.nearestFree(Math.floor(home.x), Math.floor(home.y) + 1, 6) ?? [Math.floor(home.x), Math.floor(home.y)];
      this.world.remove(u, Path);
      this.clearWork(u);
      this.placeUnit(u, spot[0] + 0.5, spot[1] + 0.5);
      Object.assign(c.vitals, newVitals(), { hp: 50, satiety: 50, hydration: 50, stamina: 60 });
      unit.state = UnitState.Idle;
      this.bump(u);
      this.notify(u, 'You collapsed and came to at your landing site');
    }
  }
}

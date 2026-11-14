import { ChunkGrid } from '../core-ecs/spatial';
import { hashInts, Rng } from '../core-ecs/rng';
import { World, type Entity } from '../core-ecs/world';
import type { Biome } from '../world-gen/planet';
import { CHUNK_SIZE, generateSector, SECTOR_SIZE, type NodeKind, type SectorTerrain } from '../world-gen/sector';
import {
  BUILD_RATE, EntityKind, HARVEST_INTERVAL, HARVEST_YIELD, Job, Net, Node, NODE_YIELDS, Path, Pod, POD_DEPLOY_TICKS,
  Position, STARTING_STOCK, STARTING_UNITS, Structure, StructureKind, STRUCTURES, TICK_RATE, Unit, UNIT_SPEED, UnitState,
  type Stock,
} from './components';
import { Pathfinder } from './pathfinding';

export type Command =
  | { type: 'move'; player: number; units: Entity[]; x: number; y: number }
  | { type: 'interact'; player: number; units: Entity[]; target: Entity }
  | { type: 'build'; player: number; units: Entity[]; kind: StructureKind; tx: number; ty: number };

/**
 * Authoritative simulation of one planetary sector. Sectors share nothing, so
 * each is an independent island that can be stepped on its own thread or
 * process; the server only routes players and packets between them.
 *
 * System order per tick: commands -> pods -> jobs -> movement.
 */
export class SectorSim {
  readonly world = new World();
  readonly terrain: SectorTerrain;
  /** Terrain obstacles plus nodes, pods and finished blocking structures. */
  readonly blocked: Uint8Array;
  readonly grid = new ChunkGrid(CHUNK_SIZE, SECTOR_SIZE / CHUNK_SIZE);
  readonly stock = new Map<number, Stock>();
  /** Players whose stock changed since the server last flushed it. */
  readonly stockDirty = new Set<number>();
  readonly notices: { player: number; text: string }[] = [];
  readonly pods = new Map<number, Entity>();
  readonly unitsOf = new Map<number, Entity[]>();

  private readonly pf: Pathfinder;
  private readonly rng: Rng;
  private readonly queue: Command[] = [];
  /** Tile index -> the node, pod or structure standing on it. */
  private readonly occupant = new Map<number, Entity>();
  private readonly playerNames = new Map<number, string>();

  constructor(readonly seed: number, readonly sectorId: number, biome: Biome) {
    this.terrain = generateSector(seed, sectorId, biome);
    this.blocked = Uint8Array.from(this.terrain.blocked);
    this.pf = new Pathfinder(SECTOR_SIZE, this.blocked);
    this.rng = new Rng(hashInts(seed, sectorId, 0x10ad));
    this.world.onDestroy = (e) => this.grid.remove(e);
    for (const n of this.terrain.nodes) this.spawnNode(n.kind, n.x, n.y, n.amount);
    this.world.addSystem({ name: 'commands', update: () => this.runCommands() });
    this.world.addSystem({ name: 'pods', update: () => this.runPods() });
    this.world.addSystem({ name: 'jobs', update: (_w, dt) => this.runJobs(dt) });
    this.world.addSystem({ name: 'movement', update: (_w, dt) => this.runMovement(dt) });
  }

  get tick(): number {
    return this.world.tick;
  }

  step(): void {
    this.world.step(1 / TICK_RATE);
  }

  enqueue(cmd: Command): void {
    if (this.queue.length < 4096) this.queue.push(cmd);
  }

  /**
   * Bring a player into the sector. A first visit drops a pod on a clear site
   * near the centre; a returning player is pointed back at their existing pod.
   */
  landPlayer(player: number, name: string): { x: number; y: number; fresh: boolean } {
    this.playerNames.set(player, name);
    const existing = this.pods.get(player);
    if (existing !== undefined) {
      const p = this.world.get(existing, Position)!;
      return { x: p.x, y: p.y, fresh: false };
    }
    const [tx, ty] = this.findLandingSite();
    const e = this.spawn(EntityKind.Pod, tx + 0.5, ty + 0.5);
    this.world.add(e, Pod, { owner: player, spawnTick: this.tick, deployed: false });
    this.setOccupant(tx, ty, e, true);
    this.pods.set(player, e);
    this.unitsOf.set(player, []);
    this.stock.set(player, { ...STARTING_STOCK });
    this.stockDirty.add(player);
    return { x: tx + 0.5, y: ty + 0.5, fresh: true };
  }

  // --- entity construction -------------------------------------------------

  private spawn(kind: EntityKind, x: number, y: number): Entity {
    const e = this.world.create();
    this.world.add(e, Position, { x, y });
    this.world.add(e, Net, { kind, version: 1, moveTick: this.tick });
    this.grid.update(e, x, y);
    return e;
  }

  private spawnNode(kind: NodeKind, x: number, y: number, amount: number): void {
    const e = this.spawn(EntityKind.Node, x, y);
    this.world.add(e, Node, { kind, amount });
    this.setOccupant(Math.floor(x), Math.floor(y), e, true);
  }

  private setOccupant(tx: number, ty: number, e: Entity, blocks: boolean): void {
    const i = tx + ty * SECTOR_SIZE;
    this.occupant.set(i, e);
    if (blocks) this.blocked[i] = 1;
  }

  private clearOccupant(tx: number, ty: number): void {
    const i = tx + ty * SECTOR_SIZE;
    this.occupant.delete(i);
    this.blocked[i] = this.terrain.blocked[i];
  }

  private bump(e: Entity): void {
    this.world.get(e, Net)!.version++;
  }

  private findLandingSite(): [number, number] {
    const c = SECTOR_SIZE / 2;
    for (let attempt = 0; attempt < 600; attempt++) {
      const reach = 5 + attempt * 0.07;
      const tx = Math.round(c + (this.rng.next() * 2 - 1) * reach);
      const ty = Math.round(c + (this.rng.next() * 2 - 1) * reach);
      if (tx < 4 || ty < 4 || tx >= SECTOR_SIZE - 4 || ty >= SECTOR_SIZE - 4) continue;
      let clear = true;
      for (let dy = -2; dy <= 2 && clear; dy++) for (let dx = -2; dx <= 2; dx++) {
        const i = tx + dx + (ty + dy) * SECTOR_SIZE;
        if (this.blocked[i] || this.occupant.has(i)) { clear = false; break; }
      }
      if (clear) return [tx, ty];
    }
    return this.pf.nearestFree(c, c, SECTOR_SIZE) ?? [c, c];
  }

  // --- systems -------------------------------------------------------------

  private runCommands(): void {
    for (const cmd of this.queue) {
      const units = cmd.units.filter((u) => this.world.get(u, Unit)?.owner === cmd.player);
      if (cmd.type === 'move') this.moveUnits(units, cmd.x, cmd.y);
      else if (cmd.type === 'interact') this.assign(units, cmd.target, cmd.player);
      else this.placeBlueprint(cmd.player, units, cmd.kind, cmd.tx, cmd.ty);
    }
    this.queue.length = 0;
  }

  private runPods(): void {
    for (const e of this.world.query(Pod)) {
      const pod = this.world.get(e, Pod)!;
      if (pod.deployed || this.tick < pod.spawnTick + POD_DEPLOY_TICKS) continue;
      pod.deployed = true;
      this.bump(e);
      const pos = this.world.get(e, Position)!;
      const tx = Math.floor(pos.x), ty = Math.floor(pos.y);
      const tag = ((this.playerNames.get(pod.owner) ?? '').replace(/[^a-z]/gi, '').slice(0, 2) || 'CX').toUpperCase();
      const doors = this.freeTiles(tx, ty, STARTING_UNITS, this.claims(new Set()));
      const crew: Entity[] = [];
      doors.forEach(([x, y], i) => {
        const u = this.spawn(EntityKind.Unit, x + 0.5, y + 0.5);
        this.world.add(u, Unit, {
          owner: pod.owner, name: tag + '-' + (i + 1), hp: 100, maxHp: 100, state: UnitState.Idle,
          facing: Math.atan2(y - ty, x - tx),
        });
        crew.push(u);
      });
      this.unitsOf.set(pod.owner, crew);
      // Fan the crew out so the pod does not hide them.
      this.moveUnits(crew, tx + 0.5, ty + 3.5);
    }
  }

  private runJobs(dt: number): void {
    for (const u of this.world.query(Job, Unit)) {
      if (this.world.has(u, Path)) continue;
      const job = this.world.get(u, Job)!;
      const unit = this.world.get(u, Unit)!;
      const pos = this.world.get(u, Position)!;
      const node = this.world.get(job.target, Node);
      const structure = this.world.get(job.target, Structure);
      const tpos = this.world.get(job.target, Position);
      if (!tpos || !this.world.isAlive(job.target) || (!node && (!structure || structure.built))) {
        // Someone else finished it first: move on to similar work nearby rather than standing idle.
        this.retarget(u, unit, pos, job);
        continue;
      }
      const tx = Math.floor(tpos.x), ty = Math.floor(tpos.y);
      const reach = Math.max(Math.abs(Math.floor(pos.x) - tx), Math.abs(Math.floor(pos.y) - ty));
      // Workers stand beside what they work on; walkable floor may be built from on top.
      const standOn = !!structure && !STRUCTURES[structure.kind].blocks;
      if (reach > 1 || (reach === 0 && !standOn)) {
        if (!this.approach(u, pos, tx, ty, standOn)) this.endJob(u, unit);
        continue;
      }
      const facing = Math.atan2(tpos.y - pos.y, tpos.x - pos.x);
      const state = node ? UnitState.Harvesting : UnitState.Building;
      if (unit.state !== state || Math.abs(unit.facing - facing) > 0.01) {
        unit.state = state; unit.facing = facing;
        this.bump(u);
      }
      if (node) {
        job.timer += dt;
        if (job.timer < HARVEST_INTERVAL) continue;
        job.timer = 0;
        const take = Math.min(HARVEST_YIELD, node.amount);
        node.amount -= take;
        this.stock.get(unit.owner)![NODE_YIELDS[node.kind]] += take;
        this.stockDirty.add(unit.owner);
        this.bump(job.target);
        if (node.amount <= 0) {
          this.world.destroy(job.target);
          this.world.remove(job.target, Node);
          this.clearOccupant(tx, ty);
          this.retarget(u, unit, pos, job);
        }
      } else if (structure) {
        const before = Math.floor(structure.progress);
        structure.progress = Math.min(100, structure.progress + BUILD_RATE * dt);
        if (structure.progress >= 100 && this.tryFinish(job.target, structure, tx, ty)) this.retarget(u, unit, pos, job);
        else if (Math.floor(structure.progress) !== before) this.bump(job.target);
      }
    }
  }

  /** Continue with the nearest job of the same type (RimWorld style), or go idle when there is none. */
  private retarget(u: Entity, unit: { owner: number; state: UnitState }, pos: { x: number; y: number }, job: { target: Entity; timer: number; harvest: NodeKind | null }): void {
    const next = job.harvest !== null
      ? this.nearest(pos.x, pos.y, 12, (e) => this.world.get(e, Node)?.kind === job.harvest)
      : this.nearest(pos.x, pos.y, 14, (e) => {
        const s = this.world.get(e, Structure);
        return !!s && !s.built && s.owner === unit.owner;
      });
    if (next === undefined) this.endJob(u, unit);
    else { job.target = next; job.timer = 0; }
  }

  private runMovement(dt: number): void {
    for (const u of this.world.query(Path, Unit)) {
      const path = this.world.get(u, Path)!;
      const pos = this.world.get(u, Position)!;
      const unit = this.world.get(u, Unit)!;
      let budget = UNIT_SPEED * dt;
      let nx = pos.x, ny = pos.y;
      let waypointReached = false;
      while (budget > 0 && path.idx * 2 < path.pts.length) {
        const wx = path.pts[path.idx * 2], wy = path.pts[path.idx * 2 + 1];
        const dx = wx - nx, dy = wy - ny;
        const d = Math.hypot(dx, dy);
        if (d > 1e-6) unit.facing = Math.atan2(dy, dx);
        if (d <= budget) {
          nx = wx; ny = wy; budget -= d; path.idx++;
          waypointReached = true;
        } else {
          nx += (dx / d) * budget; ny += (dy / d) * budget; budget = 0;
        }
      }
      // A wall may have gone up across the route since it was planned.
      const ni = Math.floor(nx) + Math.floor(ny) * SECTOR_SIZE;
      if (this.blocked[ni] && ni !== Math.floor(pos.x) + Math.floor(pos.y) * SECTOR_SIZE) {
        const n = path.pts.length;
        if (!this.setPath(u, path.pts[n - 2], path.pts[n - 1])) this.stop(u, unit);
        continue;
      }
      pos.x = nx; pos.y = ny;
      this.world.get(u, Net)!.moveTick = this.tick;
      this.grid.update(u, nx, ny);
      if (path.idx * 2 >= path.pts.length) this.stop(u, unit);
      else if (waypointReached) this.bump(u);
    }
  }

  // --- orders --------------------------------------------------------------

  private moveUnits(units: Entity[], x: number, y: number): void {
    if (units.length === 0) return;
    const tx = Math.floor(x), ty = Math.floor(y);
    const spots = this.freeTiles(tx, ty, units.length, this.claims(new Set(units)));
    units.forEach((u, i) => {
      const spot = spots[i];
      if (!spot) return;
      this.world.remove(u, Job);
      // The lead unit goes exactly where the player clicked; the rest take neighbouring tiles.
      const exact = i === 0 && spot[0] === tx && spot[1] === ty;
      if (!this.setPath(u, exact ? x : spot[0] + 0.5, exact ? y : spot[1] + 0.5)) this.stop(u, this.world.get(u, Unit)!);
    });
  }

  private assign(units: Entity[], target: Entity, player: number): void {
    const structure = this.world.get(target, Structure);
    const node = this.world.get(target, Node);
    if (!node && !(structure && !structure.built && structure.owner === player)) return;
    for (const u of units) {
      this.world.remove(u, Path);
      this.world.add(u, Job, { target, timer: 0, harvest: node ? node.kind : null });
      this.bump(u);
    }
  }

  private placeBlueprint(player: number, units: Entity[], kind: StructureKind, tx: number, ty: number): void {
    const def = STRUCTURES[kind];
    const stock = this.stock.get(player);
    if (!def || !stock || tx < 0 || ty < 0 || tx >= SECTOR_SIZE || ty >= SECTOR_SIZE) return;
    const i = tx + ty * SECTOR_SIZE;
    if (this.blocked[i] || this.occupant.has(i)) {
      this.notices.push({ player, text: 'Site obstructed' });
      return;
    }
    const lacking = (['wood', 'ore', 'scrap'] as const).find((k) => stock[k] < def.cost[k]);
    if (lacking) {
      this.notices.push({ player, text: 'Not enough ' + lacking + ' for ' + def.name });
      return;
    }
    stock.wood -= def.cost.wood; stock.ore -= def.cost.ore; stock.scrap -= def.cost.scrap;
    this.stockDirty.add(player);
    const e = this.spawn(EntityKind.Structure, tx + 0.5, ty + 0.5);
    this.world.add(e, Structure, { kind, owner: player, progress: 0, built: false });
    this.setOccupant(tx, ty, e, false);
    // Only idle hands are pulled onto a new blueprint; busy workers reach it
    // through the build queue when their current site is finished.
    this.assign(units.filter((u) => !this.world.has(u, Job)), e, player);
  }

  /** Complete a structure, unless a unit is standing where a blocking one would go. */
  private tryFinish(e: Entity, s: { kind: StructureKind; built: boolean }, tx: number, ty: number): boolean {
    if (STRUCTURES[s.kind].blocks) {
      let obstructed = false;
      this.grid.forEachNear(tx + 0.5, ty + 0.5, 1, (o) => {
        const p = this.world.get(o, Position)!;
        if (this.world.has(o, Unit) && Math.floor(p.x) === tx && Math.floor(p.y) === ty) obstructed = true;
      });
      if (obstructed) return false;
      this.blocked[tx + ty * SECTOR_SIZE] = 1;
    }
    s.built = true;
    this.bump(e);
    return true;
  }

  // --- helpers -------------------------------------------------------------

  private setPath(u: Entity, x: number, y: number): boolean {
    const pos = this.world.get(u, Position)!;
    const pts = this.pf.findPath(pos.x, pos.y, x, y);
    if (!pts || pts.length === 0) return false;
    this.world.add(u, Path, { pts, idx: 0 });
    this.world.get(u, Unit)!.state = UnitState.Moving;
    this.bump(u);
    return true;
  }

  private stop(u: Entity, unit: { state: UnitState }): void {
    this.world.remove(u, Path);
    unit.state = UnitState.Idle;
    this.bump(u);
  }

  private endJob(u: Entity, unit: { state: UnitState }): void {
    this.world.remove(u, Job);
    this.stop(u, unit);
  }

  /** Walk to the closest unclaimed tile beside (tx, ty). */
  private approach(u: Entity, pos: { x: number; y: number }, tx: number, ty: number, allowOn: boolean): boolean {
    const claims = this.claims(new Set([u]));
    const options: [number, number, number][] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0 && !allowOn) continue;
      const x = tx + dx, y = ty + dy;
      if (this.pf.isBlocked(x, y) || claims.has(x + y * SECTOR_SIZE)) continue;
      options.push([(x + 0.5 - pos.x) ** 2 + (y + 0.5 - pos.y) ** 2, x, y]);
    }
    options.sort((a, b) => a[0] - b[0]);
    for (const [, x, y] of options) if (this.setPath(u, x + 0.5, y + 0.5)) return true;
    return false;
  }

  /** Tiles other units stand on or are heading for, so orders do not stack units. */
  private claims(exclude: Set<Entity>): Set<number> {
    const out = new Set<number>();
    for (const u of this.world.query(Unit)) {
      if (exclude.has(u)) continue;
      const path = this.world.get(u, Path);
      const p = this.world.get(u, Position)!;
      const n = path?.pts.length ?? 0;
      const x = path ? path.pts[n - 2] : p.x, y = path ? path.pts[n - 1] : p.y;
      out.add(Math.floor(x) + Math.floor(y) * SECTOR_SIZE);
    }
    return out;
  }

  /** Up to `count` walkable, unclaimed tiles in rings around (tx, ty), nearest first. */
  private freeTiles(tx: number, ty: number, count: number, claims: Set<number>): [number, number][] {
    const out: [number, number][] = [];
    for (let r = 0; r <= 14 && out.length < count; r++) {
      const ring: [number, number, number][] = [];
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx, y = ty + dy;
        if (!this.pf.isBlocked(x, y) && !claims.has(x + y * SECTOR_SIZE)) ring.push([dx * dx + dy * dy, x, y]);
      }
      ring.sort((a, b) => a[0] - b[0]);
      for (const [, x, y] of ring) if (out.length < count) out.push([x, y]);
    }
    return out;
  }

  private nearest(x: number, y: number, radius: number, accept: (e: Entity) => boolean): Entity | undefined {
    let best: Entity | undefined, bestD = radius * radius;
    this.grid.forEachNear(x, y, radius, (e) => {
      if (!accept(e)) return;
      const p = this.world.get(e, Position)!;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) { bestD = d; best = e; }
    });
    return best;
  }
}

import { hash01 } from '../core-ecs/rng';
import type { Entity } from '../core-ecs/world';
import { NodeKind, tileIndex, wrapDist, wrapDX, wrapDY, wrapX, wrapY } from '../world-gen/surface';
import {
  Building, Char, CropStage, EntityKind, Inv, Job, JobKind, Node, Path, Position, Road, Structure, TICK_RATE, Unit, UnitState,
  Villager, Wolf, type BuildingData, type PositionData, type UnitData, type VillagerData,
} from './components';
import { addItem, Cont, countItem, moveItem, removeItem, totalWeight } from './inventory';
import { Item, ITEMS, StructureKind } from './items';
import {
  BUILDINGS, BuildingType, buyPrice, GROWTH_PLAN, layoutOf, marketPrice, Prof, PROF_NAMES, sellPrice, STOCK_TARGET, VILLAGE_OWNER,
  VILLAGE_RECIPES, wagePrice,
} from './village';
import type { WorldSim } from './worldSim';

export interface Contract { id: number; item: Item; qty: number; reward: number; taker: number }

export interface Village {
  id: number;
  name: string;
  /** Centre of the market square. */
  cx: number;
  cy: number;
  owner: number;
  /** Communal funds for wages and construction. */
  treasury: number;
  /** The merchant's working capital: pays for goods brought in, takes in sales. */
  till: number;
  /** The stockpile. Every unit in it was grown, gathered, made or bought. */
  stock: Map<Item, number>;
  buildings: Entity[];
  villagers: Entity[];
  plots: Entity[];
  well: [number, number];
  reputation: Map<number, number>;
  contracts: Contract[];
  nextContract: number;
  /** Building under construction, or 0. */
  site: Entity;
  /** Materials already used on the current site. */
  spent: Map<Item, number>;
  grown: number;
  /** Ends of the two building rows and of the main road, east and west, where new buildings go. */
  rowN: number;
  rowS: number;
  roadE: number;
  westN: number;
  westS: number;
  roadW: number;
  /** Where newcomers arrive from. */
  gate: [number, number];
  patrol: [number, number][];
  ledger: string[];
  lastHour: number;
}

/** What a client is shown when it opens the market or the town hall. */
export interface VillageInfo {
  building: number;
  type: BuildingType;
  name: string;
  treasury: number;
  population: number;
  reputation: number;
  coins: number;
  /** Whether the merchant is at the stalls. */
  open: boolean;
  /** Building under construction, or 255. */
  site: number;
  siteProgress: number;
  stock: { item: Item; qty: number; buy: number; sell: number }[];
  /** state: 0 open, 1 accepted by you, 2 taken by someone else. */
  contracts: { id: number; item: Item; qty: number; reward: number; state: number }[];
  ledger: string[];
}

const NAMES = ['Aldric', 'Berta', 'Conn', 'Dara', 'Edmund', 'Freya', 'Garrick', 'Hilde', 'Ivo', 'Joan', 'Kellan', 'Lora', 'Milo', 'Nessa', 'Osric', 'Petra', 'Quill', 'Rhea', 'Sten', 'Tilda', 'Ulf', 'Vera', 'Wat', 'Ysolde'];
const VILLAGE_NAMES = ['Ashford', 'Brackenmoor', 'Coldwell', 'Dunmere', 'Elmstead', 'Fallowby', 'Greywater', 'Harrowgate'];
const DAY_SECONDS = 600;
/** Goods the job board asks outsiders for. */
const CONTRACT_GOODS = [Item.Log, Item.Stone, Item.Ore, Item.Grain, Item.Berries, Item.Clay, Item.Fiber, Item.Meat];
const RAW_FOOD: [Item, number][] = [[Item.Bread, 45], [Item.Berries, 14], [Item.Grain, 12], [Item.Meat, 30]];

/**
 * Villages: founding, the daily life of their citizens, the economy and growth.
 *
 * Everything here runs on the server. Money is only ever moved between
 * accounts (treasury, till, villagers' purses, players' purses) and goods only
 * between inventories and the stockpile, so both are conserved: a loaf sold at
 * the tavern was baked from grain that a farmer grew and carried in.
 */
export class VillageSystem {
  readonly villages: Village[] = [];
  readonly wolves = new Set<Entity>();

  constructor(private readonly sim: WorldSim) {}

  byId(id: number): Village | undefined {
    return this.villages[id - 1];
  }

  // --- founding ---------------------------------------------------------------

  /**
   * The village a newcomer at (x, y) belongs near: an existing one within reach,
   * or a new one founded 150-250 tiles away on the best ground available, with a
   * trail cut back to the landing site.
   */
  ensureNear(x: number, y: number): Village {
    for (const v of this.villages) if (wrapDist(x, y, v.cx, v.cy) <= 250) return v;
    const a0 = hash01(this.sim.seed, Math.floor(x), Math.floor(y), 91) * Math.PI * 2;
    let best: [number, number, number] | null = null;
    for (const d of [190, 165, 220]) for (let i = 0; i < 12; i++) {
      const a = a0 + (i / 12) * Math.PI * 2;
      const cx = wrapX(Math.round(x + Math.cos(a) * d)), cy = wrapY(Math.round(y + Math.sin(a) * d));
      const score = this.siteScore(cx, cy);
      if (!best || score < best[2]) best = [cx, cy, score];
      if (score === 0) break;
    }
    return this.found(best![0], best![1], x, y);
  }

  /** How unsuitable a site is: 0 is dry, temperate, gentle ground across the whole footprint. */
  private siteScore(cx: number, cy: number): number {
    const s = this.sim.surface;
    let bad = 0;
    for (let y = cy - 14; y <= cy + 24; y += 2) for (let x = cx - 32; x <= cx + 32; x += 2) {
      if (s.landness(x, y) < 0.3) bad += 1;
      const c = s.climate(x, y);
      if (c.temperature < 0.2) bad += 1;
      if (c.elevation > 0.35) bad += 0.3;
    }
    for (const v of this.villages) if (wrapDist(cx, cy, v.cx, v.cy) < 120) bad += 500;
    return bad;
  }

  found(cx: number, cy: number, fromX: number, fromY: number): Village {
    const sim = this.sim, id = this.villages.length + 1;
    const v: Village = {
      id, name: VILLAGE_NAMES[(id - 1) % VILLAGE_NAMES.length], cx, cy, owner: VILLAGE_OWNER + id,
      treasury: 600, till: 800, stock: new Map(), buildings: [], villagers: [], plots: [], well: [cx - 1, cy + 15],
      reputation: new Map(), contracts: [], nextContract: 1, site: 0, spent: new Map(), grown: 0,
      rowN: 0, rowS: 0, roadE: cx + 31, westN: cx - 26, westS: cx - 29, roadW: cx - 31, gate: [cx - 40, cy + 1], patrol: [], ledger: [], lastHour: Math.floor(sim.hour),
    };
    this.villages.push(v);
    for (const [item, qty] of [
      [Item.Grain, 30], [Item.Bread, 16], [Item.Berries, 10], [Item.Log, 10], [Item.Plank, 26], [Item.Stone, 30], [Item.Firewood, 20],
      [Item.Ore, 6], [Item.Ingot, 2], [Item.Nails, 30], [Item.Stick, 10], [Item.Fiber, 12], [Item.Clay, 6], [Item.Cordage, 6],
      [Item.CopperAxe, 1], [Item.CopperPick, 1], [Item.Spear, 1], [Item.Pouch, 1], [Item.Basket, 1],
    ] as [Item, number][]) v.stock.set(item, qty);

    // A clearing: no trees or loose stone inside the settlement.
    for (let y = cy - 14; y <= cy + 24; y++) for (let x = cx - 32; x <= cx + 32; x++) sim.clearNode(x, y);
    // Main street, two tiles wide, with every door opening onto it.
    for (let x = cx - 31; x <= cx + 31; x++) { sim.clearTile(x, cy); sim.clearTile(x, cy + 1); }
    this.addRoad([cx - 31, cy + 1, cx + 31.99, cy + 1], true);

    const place = (type: BuildingType, x: number, north: boolean): Entity => {
      const L = layoutOf(type, !north);
      const oy = north ? cy - 1 - L.h : cy + 3;
      let ox = x;
      for (let shift = 0; shift < 6 && !this.siteFree(ox, oy, L.w, L.h); shift++) ox += 2;
      const e = this.addBuilding(v, type, ox, oy, !north, true);
      if (north) v.rowN = ox + L.w + 2; else v.rowS = ox + L.w + 2;
      return e;
    };
    v.rowN = cx - 24; v.rowS = cx - 27;
    const homes = [place(BuildingType.Cottage, v.rowN, true)];
    const smithy = place(BuildingType.Smithy, v.rowN, true);
    const hall = place(BuildingType.TownHall, v.rowN, true);
    const tavern = place(BuildingType.Tavern, v.rowN, true);
    homes.push(place(BuildingType.Cottage, v.rowN, true));
    homes.push(place(BuildingType.Cottage, v.rowS, false));
    const carpentry = place(BuildingType.Carpentry, v.rowS, false);
    const market = place(BuildingType.Market, v.rowS, false);
    const bakery = place(BuildingType.Bakery, v.rowS, false);
    const granary = place(BuildingType.Granary, v.rowS, false);
    homes.push(place(BuildingType.Cottage, v.rowS, false), place(BuildingType.Cottage, v.rowS, false));

    // Fields behind the south row, each reached by its own lane, with the well between them.
    const fields: Entity[] = [];
    for (const fx of [cx - 15, cx + 5]) {
      const L = layoutOf(BuildingType.Field, true);
      const e = this.addBuilding(v, BuildingType.Field, fx, cy + 13, true, true);
      fields.push(e);
      this.sowField(v, e);
      const gx = fx + L.front[0] + 0.5, gy = cy + 13 + L.front[1] + 0.5;
      const lane = sim.pf.findPath(gx, gy, gx, cy + 2.5);
      if (lane) this.addRoad([gx, gy, ...lane], false);
    }
    sim.clearTile(v.well[0], v.well[1]);
    sim.spawnStructure(StructureKind.Well, v.well[0], v.well[1], v.owner);

    // The trail from the landing site joins whichever end of the street is nearer.
    const west = wrapDX(fromX - cx) < 0;
    const end: [number, number] = [west ? cx - 31.5 : cx + 31.5, cy + 0.5];
    v.gate = [wrapX(end[0] + (west ? -10 : 10)), cy + 0.5];
    this.cutTrail(fromX, fromY, end[0], end[1]);

    const spawn = (prof: Prof, home: Entity, work: Entity, slot = 0) => this.addVillager(v, prof, home, work, slot);
    spawn(Prof.Elder, hall, hall);
    spawn(Prof.Smith, smithy, smithy);
    spawn(Prof.Carpenter, carpentry, carpentry);
    spawn(Prof.Baker, bakery, bakery);
    spawn(Prof.Innkeeper, tavern, tavern);
    spawn(Prof.Merchant, market, market);
    spawn(Prof.Farmer, homes[0], fields[0]); spawn(Prof.Farmer, homes[0], fields[1], 1);
    spawn(Prof.Farmer, homes[1], fields[0], 2); spawn(Prof.Lumberjack, homes[1], carpentry, 1);
    spawn(Prof.Lumberjack, homes[2], carpentry, 2); spawn(Prof.Miner, homes[2], granary, 1);
    spawn(Prof.Builder, homes[3], hall, 1); spawn(Prof.Guard, homes[3], hall, 2);
    spawn(Prof.Guard, homes[4], hall, 3);

    for (const [px, py] of [[cx - 30, cy - 9], [cx + 30, cy - 9], [cx + 30, cy + 22], [cx - 30, cy + 22], [cx, cy + 1]]) {
      const free = sim.pf.nearestFree(wrapX(px), wrapY(py), 8);
      if (free) v.patrol.push([free[0] + 0.5, free[1] + 0.5]);
    }
    this.refreshContracts(v);
    this.note(v, v.name + ' founded');
    this.plan(v);
    return v;
  }

  private siteFree(ox: number, oy: number, w: number, h: number): boolean {
    for (let y = oy - 1; y <= oy + h; y++) for (let x = ox - 1; x <= ox + w; x++) {
      if (this.sim.surface.isWater(x, y)) return false;
      // Trees and stones can be cleared; buildings, plots and landing pods cannot.
      const there = this.sim.occupant.get(tileIndex(x, y));
      if (there !== undefined && !this.sim.world.has(there, Node)) return false;
    }
    return true;
  }

  private addBuilding(v: Village, type: BuildingType, ox: number, oy: number, flip: boolean, built: boolean): Entity {
    const sim = this.sim, L = layoutOf(type, flip);
    ox = wrapX(ox); oy = wrapY(oy);
    const e = sim.spawn(EntityKind.Building, wrapX(ox + L.w / 2), wrapY(oy + L.h / 2));
    sim.world.add(e, Building, { type, flip, village: v.id, progress: built ? 100 : 0, built, ox, oy });
    for (let y = -1; y <= L.h; y++) for (let x = -1; x <= L.w; x++) sim.clearTile(ox + x, oy + y);
    // The whole footprint is reserved at once, so nothing else is planned on top of a building site.
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) sim.occupant.set(tileIndex(ox + x, oy + y), e);
    if (built) for (const [x, y] of L.solid) sim.setBlocked(ox + x, oy + y, true);
    v.buildings.push(e);
    return e;
  }

  /**
   * Lay a road along a polyline. Points are spaced at most eight tiles apart and
   * the road is cut into short pieces, so each piece sits within replication
   * range of anyone standing on it.
   */
  private addRoad(pts: number[], wide: boolean): void {
    const out: number[] = [pts[0], pts[1]];
    for (let i = 2; i < pts.length; i += 2) {
      let lx = out[out.length - 2], ly = out[out.length - 1];
      const n = Math.max(1, Math.ceil(wrapDist(lx, ly, pts[i], pts[i + 1]) / 8));
      const sx = wrapDX(pts[i] - lx) / n, sy = wrapDY(pts[i + 1] - ly) / n;
      for (let k = 1; k <= n; k++) { lx += sx; ly += sy; out.push(wrapX(lx), wrapY(ly)); }
    }
    for (let i = 0; i + 2 < out.length; i += 2 * 5) {
      const part = out.slice(i, i + 12);
      const mid = (part.length >> 2) * 2;
      const e = this.sim.spawn(EntityKind.Road, part[mid], part[mid + 1]);
      this.sim.world.add(e, Road, { wide, pts: part });
    }
  }

  /** Plan a walkable trail in short legs (one long search would be too wide) and lay it as road. */
  private cutTrail(ax: number, ay: number, bx: number, by: number): void {
    const sim = this.sim, pts: number[] = [];
    const dx = wrapDX(bx - ax), dy = wrapDY(by - ay), legs = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 30));
    const start = sim.pf.nearestFree(Math.floor(ax), Math.floor(ay) + 2, 6) ?? [Math.floor(ax), Math.floor(ay)];
    let px = start[0] + 0.5, py = start[1] + 0.5;
    pts.push(px, py);
    for (let i = 1; i <= legs; i++) {
      const gx = i === legs ? bx : ax + (dx * i) / legs, gy = i === legs ? by : ay + (dy * i) / legs;
      const free = sim.pf.nearestFree(Math.floor(wrapX(gx)), Math.floor(wrapY(gy)), 10);
      if (!free) continue;
      const leg = sim.pf.findPath(px, py, free[0] + 0.5, free[1] + 0.5);
      // A leg the search gives up on is bridged with a straight line; it stays a line on the map either way.
      for (const p of leg ?? [free[0] + 0.5, free[1] + 0.5]) pts.push(p);
      px = free[0] + 0.5; py = free[1] + 0.5;
    }
    this.addRoad(pts, false);
  }

  private sowField(v: Village, field: Entity): void {
    const b = this.sim.world.get(field, Building)!;
    for (const ly of [2, 4]) for (const lx of [1, 2, 3, 5, 6, 7]) {
      this.sim.occupant.delete(tileIndex(b.ox + lx, b.oy + ly));
      const plot = this.sim.spawnStructure(StructureKind.GardenPlot, b.ox + lx, b.oy + ly, v.owner);
      v.plots.push(plot);
    }
  }

  private spot(b: BuildingData, local: [number, number]): [number, number] {
    return [wrapX(b.ox + local[0] + 0.5), wrapY(b.oy + local[1] + 0.5)];
  }

  private addVillager(v: Village, prof: Prof, home: Entity, work: Entity, slot = 0, at?: [number, number]): Entity {
    const sim = this.sim;
    const hb = sim.world.get(home, Building)!, wb = sim.world.get(work, Building)!;
    const hl = layoutOf(hb.type, hb.flip), wl = layoutOf(wb.type, wb.flip);
    const bed = this.spot(hb, hl.beds[slot % Math.max(1, hl.beds.length)] ?? hl.work[0] ?? hl.door);
    // Tradespeople stand at a workstation; everyone else musters outside their workplace door.
    const indoor = prof === Prof.Elder || prof === Prof.Smith || prof === Prof.Carpenter || prof === Prof.Baker || prof === Prof.Innkeeper || prof === Prof.Merchant;
    const post = this.spot(wb, indoor ? wl.work[0] : wl.front);
    const [x, y] = at ?? bed;
    const u = sim.spawnUnit(x, y, v.owner, NAMES[sim.rng.int(0, NAMES.length - 1)], false);
    const inv = sim.world.get(u, Inv)!;
    addItem(inv, Item.Basket);
    moveItem(inv, inv.items[0].uid, Cont.Equip, ITEMS[Item.Basket].slot!, 0, 0);
    sim.world.add(u, Villager, {
      village: v.id, prof, home, work, bed, post, coins: 40, satiety: 60 + sim.rng.int(0, 30), rest: 80, warmth: 100,
      task: null, water: false, patrol: slot,
    });
    v.villagers.push(u);
    return u;
  }

  // --- money and goods --------------------------------------------------------

  stockOf(v: Village, item: Item): number {
    return v.stock.get(item) ?? 0;
  }

  private addStock(v: Village, item: Item, qty: number): void {
    v.stock.set(item, this.stockOf(v, item) + qty);
  }

  /** Every coin in a village's economy, wherever it currently sits. */
  coinsIn(v: Village): number {
    let total = v.treasury + v.till;
    for (const u of v.villagers) total += this.sim.world.get(u, Villager)?.coins ?? 0;
    return total;
  }

  private note(v: Village, text: string): void {
    v.ledger.push(text.slice(0, 60));
    if (v.ledger.length > 7) v.ledger.shift();
  }

  /** A sale puts its takings in the till, and a fifth of them go on to the treasury as tax. */
  private takeSale(v: Village, amount: number): void {
    v.till += amount;
    const tax = Math.floor(amount * 0.2);
    v.till -= tax;
    v.treasury += tax;
  }

  // --- the daily round --------------------------------------------------------

  update(dt: number): void {
    const sim = this.sim, tick = sim.tick, w = sim.world;
    for (const v of this.villages) {
      for (let i = v.villagers.length - 1; i >= 0; i--) {
        const u = v.villagers[i];
        const vd = w.get(u, Villager), unit = w.get(u, Unit), pos = w.get(u, Position);
        if (!vd || !unit || !pos) { v.villagers.splice(i, 1); continue; }
        if (unit.hp <= 0) {
          this.note(v, unit.name + ' the ' + PROF_NAMES[vd.prof].toLowerCase() + ' was killed');
          // Their purse goes back to the village rather than vanishing.
          v.treasury += vd.coins;
          v.villagers.splice(i, 1);
          w.destroy(u);
          continue;
        }
        if (tick % TICK_RATE === u % TICK_RATE) this.needs(u, vd, unit, pos);
        if (vd.task) this.runTask(u, vd, unit, pos, dt);
        else if ((tick + u) % 10 === 0) this.think(v, u, vd, unit, pos);
      }
      const hour = Math.floor(sim.hour);
      if (hour !== v.lastHour) {
        v.lastHour = hour;
        this.plan(v);
        if (hour === 6) this.refreshContracts(v);
        if (hour === 18) this.payday(v);
      }
      if (tick % 300 === 0) this.wildlife(v);
    }
    if (tick % 10 === 0) for (const e of this.wolves) this.wolfThink(e);
  }

  private needs(u: Entity, vd: VillagerData, unit: UnitData, pos: PositionData): void {
    const asleep = unit.state === UnitState.Sleeping;
    vd.satiety = Math.max(0, vd.satiety - (100 / DAY_SECONDS) * (asleep ? 0.5 : 1.1));
    const tiring = vd.prof === Prof.Guard ? 0.5 : 1;
    vd.rest = Math.min(100, Math.max(0, vd.rest + (asleep ? 100 / (DAY_SECONDS * 0.3) : (-100 / (DAY_SECONDS * 0.7)) * tiring)));
    const night = this.sim.hour >= 21 || this.sim.hour < 6;
    const sheltered = wrapDist(pos.x, pos.y, vd.bed[0], vd.bed[1]) < 5 || wrapDist(pos.x, pos.y, vd.post[0], vd.post[1]) < 4;
    const cold = this.sim.surface.ambientC(pos.x, pos.y) - (night ? 8 : 0) < 6;
    vd.warmth = Math.min(100, Math.max(0, vd.warmth + (sheltered ? 3 : cold ? -0.6 : 0.5)));
    if (asleep && unit.hp < unit.maxHp) { unit.hp = Math.min(unit.maxHp, unit.hp + 1); this.sim.bump(u); }
  }

  private setTask(vd: VillagerData, at: [number, number], seconds: number, state: UnitState, done: (() => void) | null = null, ref: Entity = 0, reach = 0.8): void {
    vd.task = { x: at[0], y: at[1], reach, seconds, t: 0, tries: 0, state, ref, done };
  }

  private runTask(u: Entity, vd: VillagerData, unit: UnitData, pos: PositionData, dt: number): void {
    const sim = this.sim, t = vd.task!;
    if (sim.world.has(u, Path)) return;
    if (wrapDist(pos.x, pos.y, t.x, t.y) > t.reach) {
      const tx = Math.floor(t.x), ty = Math.floor(t.y);
      const ok = t.tries++ < 3 && (sim.blockedAt(tx, ty) ? sim.approach(u, pos, tx, ty, false) : sim.setPath(u, t.x, t.y));
      if (!ok) vd.task = null;
      return;
    }
    if (unit.state !== t.state) { unit.state = t.state; sim.bump(u); }
    t.t += dt;
    if (t.t < t.seconds) return;
    vd.task = null;
    t.done?.();
  }

  /**
   * Utility-based choice of what to do next. Each need bids for the villager's
   * time; the clock raises and lowers the bids, so the same rule produces a
   * working day, a meal, an evening at the tavern and a night's sleep.
   */
  private think(v: Village, u: Entity, vd: VillagerData, unit: UnitData, pos: PositionData): void {
    const sim = this.sim, hour = sim.hour;
    const guard = vd.prof === Prof.Guard;
    if (guard && this.defend(v, u, vd, unit, pos)) return;
    if (!guard && this.wolfNear(pos.x, pos.y, 9) !== undefined) {
      sim.world.remove(u, Job);
      this.setTask(vd, vd.bed, 3, UnitState.Idle);
      return;
    }
    const night = hour >= 21 || hour < 6;
    const mealtime = (hour >= 12 && hour < 13.5) || (hour >= 18 && hour < 20);
    const bids: [string, number][] = [
      ['sleep', guard ? (vd.rest < 12 ? 0.9 : 0) : night ? 1 : vd.rest < 12 ? 0.9 : 0],
      ['eat', vd.satiety < 30 ? 0.85 : mealtime && vd.satiety < 70 ? 0.6 : 0],
      ['warm', vd.warmth < 30 ? 0.7 : 0],
      ['work', guard || (hour >= 7 && hour < 18) ? 0.5 : 0.05],
      ['leisure', hour >= 18 && hour < 21 ? 0.4 : 0.1],
    ];
    const choice = bids.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    if (choice !== 'work') sim.world.remove(u, Job);
    switch (choice) {
      case 'sleep': this.setTask(vd, vd.bed, 6, UnitState.Sleeping); break;
      case 'warm': this.setTask(vd, vd.bed, 6, UnitState.Idle); break;
      case 'eat': this.eat(v, u, vd); break;
      case 'leisure': this.setTask(vd, this.seat(v, u), 6, UnitState.Idle); break;
      default: this.work(v, u, vd, pos);
    }
  }

  private building(v: Village, type: BuildingType): BuildingData | undefined {
    for (const e of v.buildings) {
      const b = this.sim.world.get(e, Building);
      if (b?.built && b.type === type) return b;
    }
    return undefined;
  }

  /** A seat in the tavern, or a place in the square if there is no tavern. */
  private seat(v: Village, u: Entity): [number, number] {
    const tavern = this.building(v, BuildingType.Tavern);
    if (!tavern) return [v.cx + 0.5, v.cy + 1.5];
    const seats = layoutOf(tavern.type, tavern.flip).seats;
    return this.spot(tavern, seats[(u + Math.floor(this.sim.tick / 2000)) % seats.length]);
  }

  private eat(v: Village, u: Entity, vd: VillagerData): void {
    this.setTask(vd, this.seat(v, u), 4, UnitState.Eating, () => {
      for (const [item, fill] of RAW_FOOD) {
        if (this.stockOf(v, item) <= 0) continue;
        const price = marketPrice(item, this.stockOf(v, item));
        // Nobody starves for want of a coin: the destitute are fed from the common store.
        const paid = Math.min(price, vd.coins);
        if (paid < price && vd.satiety > 12) continue;
        vd.coins -= paid;
        this.takeSale(v, paid);
        this.addStock(v, item, -1);
        vd.satiety = Math.min(100, vd.satiety + fill);
        return;
      }
    });
  }

  private work(v: Village, u: Entity, vd: VillagerData, pos: PositionData): void {
    const sim = this.sim, inv = sim.world.get(u, Inv)!;
    const carrying = totalWeight(inv) - ITEMS[Item.Basket].kg;
    switch (vd.prof) {
      case Prof.Farmer: {
        if (countItem(inv, Item.Grain) >= 9) { this.haul(v, u, vd); return; }
        const taken = new Set(v.villagers.map((o) => sim.world.get(o, Villager)?.task?.ref ?? 0));
        let pick: Entity = 0, rank = 0, bestD = Infinity;
        for (const plot of v.plots) {
          const s = sim.world.get(plot, Structure), p = sim.world.get(plot, Position);
          if (!s || !p || taken.has(plot)) continue;
          const r = s.crop === CropStage.Ripe ? 3 : s.crop === CropStage.Empty ? (this.stockOf(v, Item.Grain) > 0 ? 2 : 0) : s.watered ? 0 : 1;
          const d = wrapDist(pos.x, pos.y, p.x, p.y);
          if (r > rank || (r === rank && r > 0 && d < bestD)) { pick = plot; rank = r; bestD = d; }
        }
        if (!pick) { if (carrying > 0.5) this.haul(v, u, vd); else this.setTask(vd, vd.post, 5, UnitState.Idle); return; }
        const s = sim.world.get(pick, Structure)!, p = sim.world.get(pick, Position)!;
        if (rank === 1 && !vd.water) {
          this.setTask(vd, [v.well[0] + 0.5, v.well[1] + 0.5], 2, UnitState.Harvesting, () => { vd.water = true; }, pick, 1.6);
        } else if (rank === 1) {
          this.setTask(vd, [p.x, p.y], 1.5, UnitState.Harvesting, () => { s.watered = true; vd.water = false; sim.bump(pick); }, pick);
        } else if (rank === 3) {
          this.setTask(vd, [p.x, p.y], 2.5, UnitState.Harvesting, () => {
            if (s.crop !== CropStage.Ripe) return;
            s.crop = CropStage.Empty; s.watered = false;
            sim.bump(pick);
            sim.give(u, Item.Grain, 3);
          }, pick);
        } else {
          // Till the plot and sow it with seed grain drawn from the granary.
          this.setTask(vd, [p.x, p.y], 3, UnitState.Harvesting, () => {
            if (s.crop !== CropStage.Empty || this.stockOf(v, Item.Grain) <= 0) return;
            this.addStock(v, Item.Grain, -1);
            s.crop = CropStage.Sown; s.cropTimer = 0; s.seed = Item.Grain; s.watered = false;
            sim.crops.add(pick);
            sim.bump(pick);
          }, pick);
        }
        return;
      }
      case Prof.Lumberjack: case Prof.Miner: this.gather(v, u, vd, pos, carrying, vd.prof === Prof.Lumberjack); return;
      case Prof.Smith: case Prof.Carpenter: case Prof.Baker: {
        const has = (item: Item, qty: number) => this.stockOf(v, item) >= qty;
        const r = VILLAGE_RECIPES.find((x) => x.prof === vd.prof && this.stockOf(v, x.out) < x.until && x.inputs.every(([i, q]) => has(i, q)));
        if (!r) { this.setTask(vd, vd.post, 5, UnitState.Idle); return; }
        this.setTask(vd, vd.post, r.seconds, UnitState.Crafting, () => {
          if (!r.inputs.every(([i, q]) => has(i, q))) return;
          for (const [i, q] of r.inputs) this.addStock(v, i, -q);
          // The maker is paid a share of what the goods are worth before they go on the shelf.
          const wage = Math.min(v.till, Math.floor(marketPrice(r.out, this.stockOf(v, r.out)) * r.qty * 0.1));
          v.till -= wage; vd.coins += wage;
          this.addStock(v, r.out, r.qty);
        });
        return;
      }
      case Prof.Builder: {
        const b = v.site ? sim.world.get(v.site, Building) : undefined;
        if (!b) { this.gather(v, u, vd, pos, carrying, true); return; }
        if (carrying > 0.5) { this.haul(v, u, vd); return; }
        const site = v.site;
        this.setTask(vd, this.spot(b, layoutOf(b.type, b.flip).front), 4, UnitState.Building, () => this.buildStep(v, site, vd), site, 1.6);
        return;
      }
      case Prof.Guard: {
        const p = v.patrol[vd.patrol++ % Math.max(1, v.patrol.length)] ?? vd.post;
        this.setTask(vd, p, 3, UnitState.Idle);
        return;
      }
      // Elder, merchant and innkeeper keep their posts; being there is the job.
      default: this.setTask(vd, vd.post, 8, vd.prof === Prof.Elder ? UnitState.Crafting : UnitState.Idle);
    }
  }

  /** Fell timber or quarry stone around the village, carrying it in when the load gets heavy. */
  private gather(v: Village, u: Entity, vd: VillagerData, pos: PositionData, carrying: number, timber: boolean): void {
    const sim = this.sim;
    if (carrying >= 14) { sim.world.remove(u, Job); this.haul(v, u, vd); return; }
    // A full stockpile needs no more: they down tools until it is drawn on.
    const glut = (item: Item) => this.stockOf(v, item) >= (STOCK_TARGET[item] ?? 10) * 2.5;
    if (timber ? glut(Item.Log) : glut(Item.Stone) && glut(Item.Ore)) {
      sim.world.remove(u, Job);
      if (carrying > 0.5) this.haul(v, u, vd); else this.setTask(vd, vd.post, 6, UnitState.Idle);
      return;
    }
    if (sim.world.has(u, Job)) return;
    const wanted = (k: NodeKind) => (timber ? k === NodeKind.Tree : k === NodeKind.Stone || k === NodeKind.Ore || k === NodeKind.Clay);
    const target = sim.nearest(v.cx, v.cy, 70, (e) => { const n = sim.world.get(e, Node); return !!n && wanted(n.kind); }, pos.x, pos.y);
    if (target === undefined) { if (carrying > 0.5) this.haul(v, u, vd); else this.setTask(vd, vd.post, 6, UnitState.Idle); return; }
    sim.world.add(u, Job, { kind: JobKind.Harvest, target, timer: 0, harvest: sim.world.get(target, Node)!.kind, recipe: 0 });
  }

  /** Carry everything in the basket to the stockpile and be paid for it from the till. */
  private haul(v: Village, u: Entity, vd: VillagerData): void {
    const granary = this.building(v, BuildingType.Granary);
    const at = granary ? this.spot(granary, layoutOf(granary.type, granary.flip).front) : vd.post;
    this.setTask(vd, at, 2, UnitState.Idle, () => {
      const inv = this.sim.world.get(u, Inv)!;
      for (let i = inv.items.length - 1; i >= 0; i--) {
        const it = inv.items[i];
        if (it.c === Cont.Equip) continue;
        for (let n = 0; n < it.qty; n++) {
          const pay = Math.min(v.till, wagePrice(it.def, this.stockOf(v, it.def)));
          v.till -= pay; vd.coins += pay;
          this.addStock(v, it.def, 1);
        }
        inv.items.splice(i, 1);
      }
    }, 0, 1.6);
  }

  // --- growth -----------------------------------------------------------------

  /** Town hall planning: when the treasury and the stockpile can cover the next building, mark it out. */
  plan(v: Village): void {
    if (v.site) return;
    const type = GROWTH_PLAN[v.grown % GROWTH_PLAN.length], cost = BUILDINGS[type].cost;
    if (v.treasury < cost.coins + 150) return;
    if (!cost.items.every(([item, qty]) => this.stockOf(v, item) >= qty)) return;
    // Build along the street: the planned side first, then the other, off the east end and then the west.
    const pref = v.grown % 2 === 0;
    for (const [north, east] of [[pref, true], [!pref, true], [pref, false], [!pref, false]]) {
      const L = layoutOf(type, !north), oy = north ? v.cy - 1 - L.h : v.cy + 3;
      let ox = east ? (north ? v.rowN : v.rowS) : (north ? v.westN : v.westS) - L.w;
      for (let shift = 0; shift < 8 && !this.siteFree(ox, oy, L.w, L.h); shift++) ox += east ? 2 : -2;
      if (!this.siteFree(ox, oy, L.w, L.h)) continue;
      // Extend the street past the new plot so it has a road to stand on.
      const from = east ? v.roadE : ox - 3, to = east ? ox + L.w + 3 : v.roadW;
      if (from < to && (east ? to > v.roadE : from < v.roadW)) {
        for (let x = from; x <= to; x++) { this.sim.clearTile(x, v.cy); this.sim.clearTile(x, v.cy + 1); }
        this.addRoad([from, v.cy + 1, to + 0.99, v.cy + 1], true);
        if (east) v.roadE = to + 1; else v.roadW = from;
      }
      v.site = this.addBuilding(v, type, ox, oy, !north, false);
      v.spent = new Map();
      if (east) { if (north) v.rowN = ox + L.w + 2; else v.rowS = ox + L.w + 2; }
      else if (north) v.westN = ox - 2; else v.westS = ox - 2;
      v.grown++;
      this.note(v, 'Marked out a new ' + BUILDINGS[type].name.toLowerCase());
      return;
    }
  }

  /** One spell of work on the building site: uses up the materials that stretch needs and pays the builder. */
  private buildStep(v: Village, site: Entity, vd: VillagerData): void {
    const sim = this.sim, b = sim.world.get(site, Building);
    if (!b || b.built) return;
    const cost = BUILDINGS[b.type as BuildingType].cost;
    const next = Math.min(100, b.progress + 3);
    const due = cost.items.map(([item, qty]) => [item, Math.floor((qty * next) / 100) - (v.spent.get(item) ?? 0)] as [Item, number]);
    const short = due.find(([item, qty]) => this.stockOf(v, item) < qty);
    if (short) {
      const msg = 'Building waits on ' + ITEMS[short[0]].name.toLowerCase();
      if (v.ledger[v.ledger.length - 1] !== msg) this.note(v, msg);
      return;
    }
    for (const [item, qty] of due) { this.addStock(v, item, -qty); v.spent.set(item, (v.spent.get(item) ?? 0) + qty); }
    const wage = Math.min(v.treasury, Math.floor((cost.coins * (next - b.progress)) / 100));
    v.treasury -= wage; vd.coins += wage;
    b.progress = next;
    sim.bump(site);
    if (next < 100) return;
    b.built = true;
    for (const [x, y] of layoutOf(b.type, b.flip).solid) sim.setBlocked(b.ox + x, b.oy + y, true);
    v.site = 0;
    this.note(v, 'Finished the ' + BUILDINGS[b.type as BuildingType].name.toLowerCase());
    if (b.type === BuildingType.Field) this.sowField(v, site);
    // A new roof draws new people down the trail.
    const settlers = b.type === BuildingType.Cottage ? 2 : b.type === BuildingType.Watchtower ? 1 : 0;
    for (let i = 0; i < settlers; i++) {
      const prof = b.type === BuildingType.Watchtower ? Prof.Guard : this.neededProf(v);
      const work = v.buildings.find((e) => { const o = sim.world.get(e, Building)!; return o.built && o.type === (prof === Prof.Farmer ? BuildingType.Field : BuildingType.TownHall); }) ?? site;
      const home = b.type === BuildingType.Cottage ? site : v.buildings.find((e) => sim.world.get(e, Building)!.type === BuildingType.Cottage) ?? site;
      const gate = sim.pf.nearestFree(Math.floor(v.gate[0]), Math.floor(v.gate[1]), 10) ?? [v.cx, v.cy];
      const u = this.addVillager(v, prof, home, work, i, [gate[0] + 0.5, gate[1] + 0.5]);
      this.note(v, sim.world.get(u, Unit)!.name + ' settled as a ' + PROF_NAMES[prof].toLowerCase());
    }
  }

  /** The trade a newcomer takes up: whatever the stockpile is shortest of. */
  private neededProf(v: Village): Prof {
    const lack = (item: Item) => this.stockOf(v, item) / (STOCK_TARGET[item] ?? 10);
    const options: [Prof, number][] = [[Prof.Farmer, lack(Item.Grain)], [Prof.Lumberjack, lack(Item.Log)], [Prof.Miner, lack(Item.Stone)]];
    return options.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
  }

  /** Evening settling-up: fixed wages, a tithe on fat purses, and rebalancing between till and treasury. */
  private payday(v: Village): void {
    for (const u of v.villagers) {
      const vd = this.sim.world.get(u, Villager)!;
      if (vd.prof === Prof.Merchant || vd.prof === Prof.Innkeeper) { const p = Math.min(v.till, 25); v.till -= p; vd.coins += p; }
      else if (vd.prof === Prof.Elder || vd.prof === Prof.Guard || vd.prof === Prof.Builder) { const p = Math.min(v.treasury, 25); v.treasury -= p; vd.coins += p; }
      const tithe = Math.floor(Math.max(0, vd.coins - 60) * 0.3);
      vd.coins -= tithe; v.treasury += tithe;
    }
    if (v.till < 200 && v.treasury > 400) { v.treasury -= 150; v.till += 150; }
    else if (v.till > 900) { const dues = Math.floor((v.till - 900) / 2); v.till -= dues; v.treasury += dues; }
  }

  private refreshContracts(v: Village): void {
    v.contracts = v.contracts.filter((c) => c.taker !== 0);
    const wants = CONTRACT_GOODS.map((item) => [item, (STOCK_TARGET[item] ?? 8) - this.stockOf(v, item)] as [Item, number])
      .filter(([item, need]) => need >= 4 && !v.contracts.some((c) => c.item === item)).sort((a, b) => b[1] - a[1]);
    for (const [item, need] of wants) {
      if (v.contracts.length >= 3) break;
      const qty = Math.min(12, need);
      v.contracts.push({ id: v.nextContract++ & 255, item, qty, reward: Math.round(marketPrice(item, this.stockOf(v, item)) * qty * 1.3), taker: 0 });
    }
  }

  // --- wildlife and the watch ---------------------------------------------------

  wolfNear(x: number, y: number, radius: number): Entity | undefined {
    let best: Entity | undefined, bestD = radius;
    for (const e of this.wolves) {
      const p = this.sim.world.get(e, Position);
      if (!p) continue;
      const d = wrapDist(x, y, p.x, p.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  spawnWolf(x: number, y: number, village = 0): Entity {
    const u = this.sim.spawnUnit(wrapX(x), wrapY(y), 0, 'Wolf', false);
    const unit = this.sim.world.get(u, Unit)!;
    unit.hp = unit.maxHp = 40;
    this.sim.world.add(u, Wolf, { village, cool: 0 });
    this.wolves.add(u);
    return u;
  }

  /** Wolves come out of the wild at night, a pair at most per village. */
  private wildlife(v: Village): void {
    const sim = this.sim, night = sim.hour >= 22 || sim.hour < 4;
    let mine = 0;
    for (const e of this.wolves) if (sim.world.get(e, Wolf)?.village === v.id) mine++;
    if (!night || mine >= 2 || sim.rng.next() > 0.14) return;
    const a = sim.rng.next() * Math.PI * 2;
    const at = sim.pf.nearestFree(Math.floor(wrapX(v.cx + Math.cos(a) * 46)), Math.floor(wrapY(v.cy + 5 + Math.sin(a) * 34)), 8);
    if (at && !sim.surface.isWater(at[0], at[1])) this.spawnWolf(at[0] + 0.5, at[1] + 0.5, v.id);
  }

  /** Apply damage to a wolf; returns true if that killed it. */
  hurtWolf(e: Entity, damage: number): boolean {
    const sim = this.sim, unit = sim.world.get(e, Unit), pos = sim.world.get(e, Position);
    if (!unit || !pos || !this.wolves.has(e)) return false;
    unit.hp -= damage;
    sim.bump(e);
    if (unit.hp > 0) return false;
    this.wolves.delete(e);
    sim.dropPile(Item.Meat, 2, 0, pos.x, pos.y);
    sim.world.destroy(e);
    return true;
  }

  private wolfThink(e: Entity): void {
    const sim = this.sim, w = sim.world;
    const pos = w.get(e, Position), wolf = w.get(e, Wolf);
    if (!pos || !wolf) { this.wolves.delete(e); return; }
    // Daylight sends them back to the wild.
    if (wolf.village && sim.hour >= 6 && sim.hour < 21) { this.wolves.delete(e); w.destroy(e); return; }
    // Wolves keep to the open: anyone under a roof is safe from them.
    const prey = sim.nearest(pos.x, pos.y, 13, (o) => {
      const u = w.get(o, Unit), p = w.get(o, Position);
      if (!u || !p || u.owner === 0 || u.hp <= 0) return false;
      const under = sim.occupant.get(tileIndex(p.x, p.y));
      return under === undefined || !w.get(under, Building)?.built;
    });
    if (prey === undefined) {
      const v = this.byId(wolf.village);
      if (v && !w.has(e, Path) && wrapDist(pos.x, pos.y, v.cx, v.cy) > 12) sim.setPath(e, v.cx + sim.rng.int(-8, 8), v.cy + sim.rng.int(-4, 12));
      return;
    }
    const pp = w.get(prey, Position)!;
    if (wrapDist(pos.x, pos.y, pp.x, pp.y) > 1.6) { sim.setPath(e, pp.x, pp.y); return; }
    if (wolf.cool++ % 2 !== 0) return;
    const unit = w.get(e, Unit)!;
    unit.facing = Math.atan2(wrapDY(pp.y - pos.y), wrapDX(pp.x - pos.x));
    if (unit.state !== UnitState.Fighting) { unit.state = UnitState.Fighting; sim.bump(e); }
    const char = w.get(prey, Char);
    if (char) { char.vitals.hp = Math.max(0, char.vitals.hp - 6); sim.notices.push({ player: char.player, text: 'A wolf bites you' }); }
    else { w.get(prey, Unit)!.hp -= 5; sim.bump(prey); }
  }

  /** Guards drop everything for a wolf near the village. Returns true while there is one to deal with. */
  private defend(v: Village, u: Entity, vd: VillagerData, unit: UnitData, pos: PositionData): boolean {
    const sim = this.sim;
    const wolf = this.wolfNear(v.cx, v.cy + 5, 48);
    if (wolf === undefined) return false;
    const wp = sim.world.get(wolf, Position)!;
    vd.task = null;
    if (wrapDist(pos.x, pos.y, wp.x, wp.y) > 1.7) { sim.setPath(u, wp.x, wp.y); return true; }
    unit.facing = Math.atan2(wrapDY(wp.y - pos.y), wrapDX(wp.x - pos.x));
    if (unit.state !== UnitState.Fighting) { unit.state = UnitState.Fighting; sim.bump(u); }
    if (this.hurtWolf(wolf, 9)) { this.note(v, unit.name + ' killed a wolf'); unit.state = UnitState.Idle; sim.bump(u); }
    return true;
  }

  // --- players ----------------------------------------------------------------

  /** The village a building belongs to, if the hero is close enough to deal with it. */
  private within(hero: Entity, building: Entity): { v: Village; b: BuildingData } | null {
    const b = this.sim.world.get(building, Building), bp = this.sim.world.get(building, Position), hp = this.sim.world.get(hero, Position);
    const v = b ? this.byId(b.village) : undefined;
    if (!b || !bp || !hp || !v || !b.built || wrapDist(hp.x, hp.y, bp.x, bp.y) > 8) return null;
    return { v, b };
  }

  private merchantOnDuty(v: Village): boolean {
    return v.villagers.some((u) => {
      const vd = this.sim.world.get(u, Villager), p = this.sim.world.get(u, Position), unit = this.sim.world.get(u, Unit);
      return !!vd && !!p && vd.prof === Prof.Merchant && unit!.state !== UnitState.Sleeping && wrapDist(p.x, p.y, vd.post[0], vd.post[1]) < 3;
    });
  }

  /** Buy from or sell to the market, one unit at a time so each unit moves the price. Returns a refusal, or null. */
  trade(hero: Entity, building: Entity, item: Item, qty: number, sell: boolean): string | null {
    const sim = this.sim, here = this.within(hero, building);
    if (!here || here.b.type !== BuildingType.Market) return 'Go to the market square to trade';
    const { v } = here;
    if (!this.merchantOnDuty(v)) return 'The stalls are unattended';
    if (!ITEMS[item]) return 'No such goods';
    const char = sim.world.get(hero, Char)!, inv = sim.world.get(hero, Inv)!;
    let problem: string | null = null;
    for (let n = 0; n < Math.min(qty, 50); n++) {
      const stock = this.stockOf(v, item);
      if (sell) {
        const price = buyPrice(item, stock);
        const loose = inv.items.filter((i) => i.def === item && i.c !== Cont.Equip).reduce((s, i) => s + i.qty, 0);
        if (loose <= 0) { problem = 'You have none to sell'; break; }
        if (v.till < price) { problem = 'The merchant is out of coin'; break; }
        const it = inv.items.find((i) => i.def === item && i.c !== Cont.Equip)!;
        if (--it.qty <= 0) inv.items.splice(inv.items.indexOf(it), 1);
        v.till -= price; char.coins += price;
        this.addStock(v, item, 1);
      } else {
        const price = sellPrice(item, stock, v.reputation.get(char.player) ?? 0);
        if (stock <= 0) { problem = 'Sold out'; break; }
        if (char.coins < price) { problem = 'Not enough coin'; break; }
        if (addItem(inv, item, 1) > 0) { problem = 'No room in your pack'; break; }
        char.coins -= price;
        this.takeSale(v, price);
        this.addStock(v, item, -1);
      }
    }
    sim.invDirty.add(char.player);
    return problem;
  }

  /** Take a job from the board, or hand in the goods for one already taken. */
  contract(hero: Entity, building: Entity, id: number, deliver: boolean): string | null {
    const sim = this.sim, here = this.within(hero, building);
    if (!here || here.b.type !== BuildingType.TownHall) return 'The job board is at the town hall';
    const { v } = here, char = sim.world.get(hero, Char)!, inv = sim.world.get(hero, Inv)!;
    const c = v.contracts.find((x) => x.id === id);
    if (!c) return 'That job is gone';
    if (!deliver) {
      if (c.taker && c.taker !== char.player) return 'Someone else took that job';
      c.taker = char.player;
      return null;
    }
    if (c.taker !== char.player) return 'Accept the job first';
    if (countItem(inv, c.item) < c.qty) return 'Bring ' + c.qty + ' ' + ITEMS[c.item].name.toLowerCase();
    removeItem(inv, c.item, c.qty);
    this.addStock(v, c.item, c.qty);
    const paid = Math.min(v.treasury, c.reward);
    v.treasury -= paid; char.coins += paid;
    v.reputation.set(char.player, (v.reputation.get(char.player) ?? 0) + 5);
    v.contracts.splice(v.contracts.indexOf(c), 1);
    this.note(v, (sim.world.get(hero, Unit)?.name ?? 'A settler') + ' delivered ' + c.qty + ' ' + ITEMS[c.item].name.toLowerCase());
    sim.invDirty.add(char.player);
    return null;
  }

  info(player: number, building: Entity): VillageInfo | null {
    const sim = this.sim, b = sim.world.get(building, Building), v = b ? this.byId(b.village) : undefined;
    const hero = sim.heroes.get(player);
    if (!b || !v || hero === undefined) return null;
    const rep = v.reputation.get(player) ?? 0;
    const site = v.site ? sim.world.get(v.site, Building) : undefined;
    const stock = [...v.stock].filter(([, qty]) => qty > 0).sort((a, b2) => a[0] - b2[0])
      .map(([item, qty]) => ({ item, qty, buy: buyPrice(item, qty), sell: sellPrice(item, qty, rep) }));
    // Also quote a buying price for whatever the player is carrying that the village has none of.
    for (const it of sim.world.get(hero, Inv)!.items) {
      if (it.c !== Cont.Equip && !stock.some((s) => s.item === it.def)) stock.push({ item: it.def, qty: 0, buy: buyPrice(it.def, 0), sell: sellPrice(it.def, 0, rep) });
    }
    return {
      building, type: b.type, name: v.name, treasury: v.treasury, population: v.villagers.length, reputation: rep,
      coins: sim.world.get(hero, Char)!.coins, open: this.merchantOnDuty(v), site: site ? site.type : 255, siteProgress: site?.progress ?? 0,
      stock: stock.slice(0, 60),
      contracts: v.contracts.map((c) => ({ id: c.id, item: c.item, qty: c.qty, reward: c.reward, state: c.taker === 0 ? 0 : c.taker === player ? 1 : 2 })),
      ledger: v.ledger.slice(-6),
    };
  }
}


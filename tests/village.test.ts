import { describe, expect, it } from 'vitest';
import {
  addItem, BASE_PRICE, Building, BUILDINGS, BuildingType, buyPrice, Char, countItem, CropStage, describeEntity, EntityKind, Inv, Item, Job,
  layoutOf, marketPrice, Pile, POD_DEPLOY_TICKS, Position, Prof, Road, sellPrice, Skill, STOCK_TARGET, Structure, Unit, UnitState,
  Villager, WorldSim, type Village,
} from '../game-sim';
import { C2S, decodeClient, decodeServer, encodeClient, encodeServer, S2C } from '../network';
import { Biome, SECTOR_COUNT, sectorInfo, wrapDist } from '../world-gen';

const SEED = 20451;
const HOUR = 500;

function forestSector(): number {
  for (let id = 0; id < SECTOR_COUNT; id++) if (sectorInfo(SEED, id).biome === Biome.Forest) return id;
  throw new Error('no forest sector');
}

/** A world with one landed hero and the village founded for them. */
function world() {
  const sim = new WorldSim(SEED);
  sim.online.add(1);
  const site = sim.landPlayer(1, 'Yuu', forestSector());
  for (let i = 0; i <= POD_DEPLOY_TICKS + 2; i++) sim.step();
  const hero = sim.heroes.get(1)!;
  const v = sim.villages.villages[0];
  return { sim, site, hero, v, inv: sim.world.get(hero, Inv)!, char: sim.world.get(hero, Char)! };
}

function run(sim: WorldSim, ticks: number, until?: () => boolean): void {
  for (let i = 0; i < ticks && !until?.(); i++) sim.step();
}

const buildingsOf = (sim: WorldSim, v: Village, type: BuildingType) =>
  v.buildings.filter((e) => sim.world.get(e, Building)!.type === type);
const villagersOf = (sim: WorldSim, v: Village, prof: Prof) =>
  v.villagers.filter((u) => sim.world.get(u, Villager)!.prof === prof);

/** Stand the hero on the doorstep of a building. */
function goTo(sim: WorldSim, hero: number, building: number): void {
  const b = sim.world.get(building, Building)!, front = layoutOf(b.type, b.flip).front;
  sim.placeUnit(hero, b.ox + front[0] + 0.5, b.oy + front[1] + 0.5);
}

describe('building floor plans', () => {
  it('give every building a door, clear standing room and solid walls', () => {
    for (const type of Object.values(BuildingType).filter((t): t is BuildingType => typeof t === 'number')) {
      for (const flip of [false, true]) {
        const L = layoutOf(type, flip);
        const solid = new Set(L.solid.map(([x, y]) => x + y * 100));
        expect(solid.has(L.door[0] + L.door[1] * 100)).toBe(false);
        for (const [x, y] of [...L.work, ...L.beds, ...L.seats]) expect(solid.has(x + y * 100)).toBe(false);
        // The doorstep is outside the footprint, on the side the door faces.
        expect(L.front[1]).toBe(flip ? L.door[1] - 1 : L.door[1] + 1);
        expect(L.pieces.length).toBeGreaterThan(4);
      }
      const a = layoutOf(type, false), b = layoutOf(type, true);
      expect(b.solid.map(([x, y]) => [x, a.h - 1 - y]).sort()).toEqual([...a.solid].sort());
    }
    expect(layoutOf(BuildingType.Cottage, false).beds).toHaveLength(2);
    expect(layoutOf(BuildingType.Smithy, false).work.length).toBeGreaterThan(0);
  });
});

describe('starter village', () => {
  it('is founded within walking distance of the landing site, complete and joined by a trail', () => {
    const { sim, site, v } = world();
    expect(sim.villages.villages).toHaveLength(1);
    const d = wrapDist(site.x, site.y, v.cx, v.cy);
    expect(d).toBeGreaterThanOrEqual(150);
    expect(d).toBeLessThanOrEqual(250);

    for (const type of [BuildingType.TownHall, BuildingType.Smithy, BuildingType.Carpentry, BuildingType.Bakery, BuildingType.Granary, BuildingType.Tavern, BuildingType.Market]) {
      expect(buildingsOf(sim, v, type)).toHaveLength(1);
    }
    expect(buildingsOf(sim, v, BuildingType.Cottage).filter((e) => sim.world.get(e, Building)!.built)).toHaveLength(5);
    expect(buildingsOf(sim, v, BuildingType.Field)).toHaveLength(2);
    expect(v.plots).toHaveLength(24);
    expect(v.villagers).toHaveLength(15);
    for (const prof of [Prof.Elder, Prof.Farmer, Prof.Lumberjack, Prof.Miner, Prof.Smith, Prof.Carpenter, Prof.Baker, Prof.Innkeeper, Prof.Merchant, Prof.Builder, Prof.Guard]) {
      expect(villagersOf(sim, v, prof).length).toBeGreaterThan(0);
    }

    // Walls are solid, doorways and doorsteps are not, and no two buildings overlap.
    const claimed = new Set<number>();
    for (const e of v.buildings) {
      const b = sim.world.get(e, Building)!, L = layoutOf(b.type, b.flip);
      if (b.built) for (const [x, y] of L.solid) expect(sim.blockedAt(b.ox + x, b.oy + y)).toBe(true);
      expect(sim.blockedAt(b.ox + L.door[0], b.oy + L.door[1])).toBe(false);
      expect(sim.blockedAt(b.ox + L.front[0], b.oy + L.front[1])).toBe(false);
      for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
        const key = (b.ox + x) + (b.oy + y) * 4096;
        expect(claimed.has(key)).toBe(false);
        claimed.add(key);
      }
    }

    // The trail: one end by the pod, the other at the street, with no gaps along the way.
    const roads = sim.world.query(Road).map((e) => sim.world.get(e, Road)!);
    const points: [number, number][] = [];
    for (const r of roads) for (let i = 0; i < r.pts.length; i += 2) {
      points.push([r.pts[i], r.pts[i + 1]]);
      if (i > 0) expect(wrapDist(r.pts[i - 2], r.pts[i - 1], r.pts[i], r.pts[i + 1])).toBeLessThanOrEqual(8.01);
    }
    const nearest = (x: number, y: number) => Math.min(...points.map(([px, py]) => wrapDist(x, y, px, py)));
    expect(nearest(site.x, site.y)).toBeLessThan(6);
    expect(nearest(v.cx, v.cy)).toBeLessThan(3);
    // Every stretch of road is anchored close enough to its own points to be replicated with them.
    for (const e of sim.world.query(Road)) {
      const p = sim.world.get(e, Position)!, r = sim.world.get(e, Road)!;
      for (let i = 0; i < r.pts.length; i += 2) expect(wrapDist(p.x, p.y, r.pts[i], r.pts[i + 1])).toBeLessThan(30);
    }
  });

  it('is shared by settlers who land nearby', () => {
    const { sim, v } = world();
    sim.landPlayer(2, 'Bravo', forestSector());
    expect(sim.villages.villages).toHaveLength(1);
    expect(sim.villages.ensureNear(v.cx + 100, v.cy)).toBe(v);
  });
});

describe('village economy', () => {
  it('prices goods by supply and demand', () => {
    const target = STOCK_TARGET[Item.Grain]!, base = BASE_PRICE[Item.Grain]!;
    expect(marketPrice(Item.Grain, target)).toBe(base);
    expect(marketPrice(Item.Grain, 0)).toBe(base * 2);
    expect(marketPrice(Item.Grain, target * 3)).toBeLessThan(base);
    expect(marketPrice(Item.Grain, 10_000)).toBe(Math.max(1, Math.round(base * 0.4)));
    // Scarcity raises what the bakery's customers pay, glut lowers what a seller is offered.
    expect(sellPrice(Item.Bread, 2)).toBeGreaterThan(sellPrice(Item.Bread, 30));
    expect(buyPrice(Item.Log, 40)).toBeLessThan(buyPrice(Item.Log, 4));
    // Buying a unit and selling it straight back never pays, even with the best reputation.
    for (const item of [Item.Log, Item.Bread, Item.CopperAxe, Item.Basket]) {
      for (let stock = 1; stock < 60; stock++) expect(buyPrice(item, stock - 1)).toBeLessThan(sellPrice(item, stock, 50));
    }
    expect(sellPrice(Item.Plank, 10, 50)).toBeLessThanOrEqual(sellPrice(Item.Plank, 10, 0));
  });

  it('lets a player flood the market, moving the price and the coin', () => {
    const { sim, hero, v, inv, char } = world();
    const market = buildingsOf(sim, v, BuildingType.Market)[0];
    // Too far away: refused.
    expect(sim.villages.trade(hero, market, Item.Stick, 1, true)).toBe('Go to the market square to trade');
    goTo(sim, hero, market);
    for (let i = 0; i < 12; i++) inv.items.push({ uid: 500 + i, def: Item.Stick, qty: 4, dur: 0, c: 0, x: 0, y: 0, rot: 0 });
    const total = () => sim.villages.coinsIn(v) + char.coins;
    const before = total(), stock0 = sim.villages.stockOf(v, Item.Stick);
    const quoted: number[] = [];
    for (let i = 0; i < 40; i++) {
      quoted.push(buyPrice(Item.Stick, sim.villages.stockOf(v, Item.Stick)));
      const coins = char.coins;
      expect(sim.villages.trade(hero, market, Item.Stick, 1, true)).toBeNull();
      expect(char.coins - coins).toBe(quoted[i]);
    }
    expect(sim.villages.stockOf(v, Item.Stick)).toBe(stock0 + 40);
    expect(countItem(inv, Item.Stick)).toBe(8);
    for (let i = 1; i < quoted.length; i++) expect(quoted[i]).toBeLessThanOrEqual(quoted[i - 1]);
    expect(quoted[quoted.length - 1]).toBeLessThan(quoted[0]);
    expect(total()).toBe(before);

    // Buying works the other way, and a fifth of the takings is taxed into the treasury.
    const treasury = v.treasury, price = sellPrice(Item.Bread, sim.villages.stockOf(v, Item.Bread));
    expect(sim.villages.trade(hero, market, Item.Bread, 1, false)).toBeNull();
    expect(countItem(inv, Item.Bread)).toBe(1);
    expect(v.treasury - treasury).toBe(Math.floor(price * 0.2));
    expect(total()).toBe(before);
    expect(sim.villages.trade(hero, market, Item.CopperPick, 1, false)).toBe('Not enough coin');
    expect(sim.villages.trade(hero, market, Item.Meat, 1, false)).toBe('Sold out');

    // The same thing through the command queue, as a client would do it.
    sim.enqueue({ type: 'trade', player: 1, building: market, item: Item.Stick, qty: 2, sell: true });
    sim.step();
    expect(countItem(inv, Item.Stick)).toBe(6);
    const info = sim.villages.info(1, market)!;
    expect(info.open).toBe(true);
    expect(info.coins).toBe(char.coins);
    expect(info.stock.find((s) => s.item === Item.Stick)!.qty).toBe(stock0 + 42);
  });

  it('closes the stalls at night', () => {
    const { sim, hero, v } = world();
    const market = buildingsOf(sim, v, BuildingType.Market)[0];
    run(sim, 17 * HOUR, () => sim.hour >= 23.5);
    goTo(sim, hero, market);
    addItem(sim.world.get(hero, Inv)!, Item.Stick, 1);
    expect(sim.villages.trade(hero, market, Item.Stick, 1, true)).toBe('The stalls are unattended');
  });

  it('posts jobs for what the stockpile lacks and pays on delivery', () => {
    const { sim, hero, v, inv, char } = world();
    const hall = buildingsOf(sim, v, BuildingType.TownHall)[0];
    expect(v.contracts.length).toBeGreaterThan(0);
    const c = v.contracts[0];
    const short = (STOCK_TARGET[c.item] ?? 8) - sim.villages.stockOf(v, c.item);
    expect(short).toBeGreaterThanOrEqual(4);
    goTo(sim, hero, hall);
    expect(sim.villages.contract(hero, hall, c.id, true)).toBe('Accept the job first');
    expect(sim.villages.contract(hero, hall, c.id, false)).toBeNull();
    expect(sim.villages.info(1, hall)!.contracts.find((x) => x.id === c.id)!.state).toBe(1);
    expect(sim.villages.contract(hero, hall, c.id, true)).toContain('Bring');
    for (let i = 0; i < c.qty; i++) inv.items.push({ uid: 700 + i, def: c.item, qty: 1, dur: 0, c: 0, x: 0, y: 0, rot: 0 });
    const stock = sim.villages.stockOf(v, c.item), treasury = v.treasury;
    expect(sim.villages.contract(hero, hall, c.id, true)).toBeNull();
    expect(char.coins).toBe(c.reward);
    expect(treasury - v.treasury).toBe(c.reward);
    expect(sim.villages.stockOf(v, c.item)).toBe(stock + c.qty);
    expect(countItem(inv, c.item)).toBe(0);
    expect(v.reputation.get(1)).toBe(5);
    expect(v.contracts.includes(c)).toBe(false);
  });
});

describe('villagers', () => {
  it('work their trades through the day and conserve the coin they pass around', () => {
    const { sim, v } = world();
    const coins = () => sim.villages.coinsIn(v);
    const start = coins();
    expect(start).toBe(600 + 800 + 15 * 40);
    const bread0 = sim.villages.stockOf(v, Item.Bread);
    // The town hall marks out its first new building straight away.
    expect(v.site).not.toBe(0);
    const site = v.site;
    expect(sim.world.get(site, Building)).toMatchObject({ type: BuildingType.Cottage, built: false, progress: 0 });

    const lumberjack = villagersOf(sim, v, Prof.Lumberjack)[0];
    let felled = false, baked = false, forged = false, paid = false;
    run(sim, 4 * HOUR, () => {
      felled ||= countItem(sim.world.get(lumberjack, Inv)!, Item.Log) > 0;
      paid ||= sim.world.get(lumberjack, Villager)!.coins > 40;
      baked ||= sim.villages.stockOf(v, Item.Bread) > bread0;
      forged ||= villagersOf(sim, v, Prof.Smith).some((u) => sim.world.get(u, Unit)!.state === UnitState.Crafting);
      return false;
    });
    // Lumberjacks walk out, fell trees and are paid from the till for what they carry in.
    expect(felled).toBe(true);
    expect(paid).toBe(true);
    expect(baked).toBe(true);
    expect(forged).toBe(true);
    // Farmers have tilled and sown the fields from the granary's seed grain, and watered them.
    const plots = v.plots.map((e) => sim.world.get(e, Structure)!);
    expect(plots.filter((p) => p.crop !== CropStage.Empty).length).toBeGreaterThan(12);
    expect(plots.some((p) => p.watered)).toBe(true);
    expect(plots.every((p) => p.crop === CropStage.Empty || p.seed === Item.Grain)).toBe(true);
    // The builder has been at the site, using up stockpiled materials as the walls go up.
    expect(sim.world.get(site, Building)!.progress).toBeGreaterThan(0);
    expect(sim.villages.stockOf(v, Item.Plank)).toBeLessThan(26 + 20);
    expect(coins()).toBe(start);

    // By the end of the working day the cottage stands, its walls are solid, and settlers have come.
    run(sim, 8 * HOUR, () => v.site === 0);
    const b = sim.world.get(site, Building)!;
    expect(b.built).toBe(true);
    const wall = layoutOf(b.type, b.flip).solid[0];
    expect(sim.blockedAt(b.ox + wall[0], b.oy + wall[1])).toBe(true);
    expect(v.villagers).toHaveLength(17);
    expect(v.ledger.some((l) => l.includes('settled as'))).toBe(true);
    expect(coins()).toBe(start + 2 * 40);
    // Grain was harvested and carried to the granary.
    run(sim, 3 * HOUR);
    expect(plots.some((p) => p.crop === CropStage.Ripe) || sim.villages.stockOf(v, Item.Grain) > 6).toBe(true);
  }, 30_000);

  it('keep a daily routine: home to bed at night, back to work in the morning', () => {
    const { sim, v } = world();
    run(sim, 17 * HOUR, () => sim.hour >= 23.9);
    const civilians = v.villagers.filter((u) => sim.world.get(u, Villager)!.prof !== Prof.Guard);
    const asleep = civilians.filter((u) => {
      const vd = sim.world.get(u, Villager)!, p = sim.world.get(u, Position)!;
      return sim.world.get(u, Unit)!.state === UnitState.Sleeping && wrapDist(p.x, p.y, vd.bed[0], vd.bed[1]) < 1.5;
    });
    expect(asleep.length).toBeGreaterThanOrEqual(civilians.length - 1);
    for (const u of civilians) expect(sim.world.has(u, Job)).toBe(false);
    // Nobody went hungry: they ate at the tavern and paid for it.
    for (const u of v.villagers) expect(sim.world.get(u, Villager)!.satiety).toBeGreaterThan(15);
    expect(sim.villages.stockOf(v, Item.Bread)).toBeLessThan(16 + 60);

    run(sim, 10 * HOUR, () => sim.hour >= 9 && sim.hour < 10);
    const smith = villagersOf(sim, v, Prof.Smith)[0], vd = sim.world.get(smith, Villager)!, p = sim.world.get(smith, Position)!;
    expect(sim.world.get(smith, Unit)!.state).not.toBe(UnitState.Sleeping);
    expect(wrapDist(p.x, p.y, vd.post[0], vd.post[1])).toBeLessThan(6);
    expect(sim.world.get(smith, Villager)!.rest).toBeGreaterThan(50);
  }, 30_000);

  it('are defended by the guards, and wolves can be fought by players', () => {
    const { sim, hero, v, inv, char } = world();
    const wolf = sim.villages.spawnWolf(v.cx + 6, v.cy + 1);
    expect(describeEntity(sim.world, wolf).unit!.prof).toBe(200);
    run(sim, 1200, () => !sim.world.isAlive(wolf));
    expect(sim.world.isAlive(wolf)).toBe(false);
    expect(v.ledger.some((l) => l.includes('killed a wolf'))).toBe(true);
    expect(sim.world.query(Pile).some((e) => sim.world.get(e, Pile)!.item === Item.Meat)).toBe(true);

    // Far from any guard, the player has to deal with one alone.
    const p = sim.world.get(hero, Position)!;
    addItem(inv, Item.Spear);
    const second = sim.villages.spawnWolf(p.x + 3, p.y);
    sim.enqueue({ type: 'interact', player: 1, target: second });
    run(sim, 600, () => !sim.world.isAlive(second));
    expect(sim.world.isAlive(second)).toBe(false);
    expect(char.skills[Skill.Combat]).toBeGreaterThan(0);
    expect(inv.items.find((i) => i.def === Item.Spear)!.dur).toBeLessThan(80);
  });
});

describe('village protocol', () => {
  it('round-trips roads, buildings, trade orders and the village sheet', () => {
    const snap = {
      op: S2C.Snapshot as const, tick: 9,
      full: [
        { id: 20, kind: EntityKind.Road, x: 10.5, y: 20.5, road: { wide: true, pts: [1.5, 2.5, 9.5, 2.5, 1000.25, 500.5] } },
        { id: 21, kind: EntityKind.Building, x: 30.5, y: 40, building: { type: BuildingType.Tavern, flip: true, built: false, progress: 48, village: 3 } },
      ],
      moves: [], gone: [],
    };
    expect(decodeServer(encodeServer(snap))).toEqual(snap);
    const trade = { op: C2S.Trade as const, building: 70000, item: Item.Bread, qty: 5, sell: false };
    expect(decodeClient(encodeClient(trade))).toEqual(trade);
    const job = { op: C2S.Contract as const, building: 12, id: 3, deliver: true };
    expect(decodeClient(encodeClient(job))).toEqual(job);

    const { sim, v } = world();
    const info = sim.villages.info(1, buildingsOf(sim, v, BuildingType.TownHall)[0])!;
    expect(info.population).toBe(15);
    expect(info.site).toBe(BuildingType.Cottage);
    expect(info.ledger.length).toBeGreaterThan(0);
    expect(decodeServer(encodeServer({ op: S2C.Village, info }))).toEqual({ op: S2C.Village, info });
    expect(BUILDINGS[BuildingType.Market].name).toBe('Market square');
  });
});

describe('floor plan connectivity', () => {
  it('lets a walker reach every bed, seat and workstation from the doorstep', () => {
    for (const type of Object.values(BuildingType).filter((t): t is BuildingType => typeof t === 'number')) {
      const L = layoutOf(type, false);
      const solid = new Set(L.solid.map(([x, y]) => x + ',' + y));
      const open = (x: number, y: number) => x >= 0 && x < L.w && y >= -1 && y <= L.h && (y < 0 || y >= L.h || !solid.has(x + ',' + y)) && (y >= 0 && y < L.h || (x === L.front[0] && y === L.front[1]));
      const seen = new Set<string>([L.front.join(',')]), queue = [L.front];
      while (queue.length) {
        const [x, y] = queue.pop()!;
        // Four-way steps only: stricter than the pathfinder, which also allows open diagonals.
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = (x + dx) + ',' + (y + dy);
          if (!seen.has(k) && open(x + dx, y + dy)) { seen.add(k); queue.push([x + dx, y + dy]); }
        }
      }
      for (const spot of [...L.work, ...L.beds, ...L.seats]) expect(seen.has(spot.join(',')), BuildingType[type] + ' ' + spot).toBe(true);
    }
  });
});

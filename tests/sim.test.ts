import { describe, expect, it } from 'vitest';
import { ChunkGrid, defineComponent, World } from '../core-ecs';
import {
  addItem, canPlace, carryCapacity, Char, Cont, countItem, describeEntity, EntityKind, findSpace, Follower, footprint,
  gridSize, Inv, Item, ITEMS, loadTier, LoadTier, moveItem, moveSpeed, moveStep, Net, newInventory, newVitals, Node, Order,
  Pathfinder, PatternId, PATTERNS, Pile, POD_DEPLOY_TICKS, Position, RECIPES, Slot, Status, Structure, StructureKind,
  tickVitals, totalWeight, Unit, WorldSim, xpForLevel,
} from '../game-sim';
import { C2S, decodeClient, decodeServer, encodeClient, encodeServer, EntityMirror, Replicator, S2C, type ReplicationSource } from '../network';
import {
  bakePlanetMaps, Biome, CHUNK_SIZE, NodeKind, SECTOR_COUNT, sectorCenterDir, sectorFromDir, sectorInfo, sectorOfTile,
  Surface, WORLD_H, WORLD_W, wrapDist, wrapDX, wrapX,
} from '../world-gen';

const SEED = 20451;

describe('core-ecs', () => {
  it('queries by component set and defers destruction to end of step', () => {
    const A = defineComponent<{ v: number }>('A'), B = defineComponent<{ w: number }>('B');
    const w = new World();
    const e1 = w.create(), e2 = w.create();
    w.add(e1, A, { v: 1 }); w.add(e1, B, { w: 2 }); w.add(e2, A, { v: 3 });
    expect(w.query(A, B)).toEqual([e1]);
    w.addSystem({ name: 'kill', update: (world) => world.destroy(e1) });
    w.step(0.05);
    expect(w.isAlive(e1)).toBe(false);
    expect(w.query(A)).toEqual([e2]);
  });

  it('chunk grid queries wrap around a toroidal world', () => {
    const g = new ChunkGrid(16, 8, 4, true);
    g.update(1, 2, 2); g.update(2, 126, 62); g.update(3, 60, 30);
    const seen: number[] = [];
    g.forEachInChunks(0, 0, 1, (e) => seen.push(e));
    expect(seen.sort()).toEqual([1, 2]);
    seen.length = 0;
    g.forEachNear(127, 63, 6, (e) => seen.push(e));
    expect(seen.sort()).toEqual([1, 2]);
    // A radius wider than the world must not report an entity twice.
    seen.length = 0;
    g.forEachInChunks(0, 0, 9, (e) => seen.push(e));
    expect(seen.sort()).toEqual([1, 2, 3]);
  });
});

describe('world coordinates and terrain', () => {
  it('wraps positions and measures distance the short way round', () => {
    expect(wrapX(-1)).toBe(WORLD_W - 1);
    expect(wrapX(WORLD_W + 3.5)).toBe(3.5);
    expect(wrapDX(WORLD_W - 2)).toBe(-2);
    expect(wrapDist(1, 1, WORLD_W - 1, WORLD_H - 1)).toBeCloseTo(Math.hypot(2, 2));
    for (const id of [0, 37, 255, SECTOR_COUNT - 1]) expect(sectorFromDir(...sectorCenterDir(id))).toBe(id);
    expect(sectorOfTile(33, 65)).toBe(1 + 2 * 32);
  });

  it('generates identical chunks from the same seed and joins seamlessly across both world edges', () => {
    expect(bakePlanetMaps(SEED, 32, 16)).toEqual(bakePlanetMaps(SEED, 32, 16));
    const a = new Surface(SEED), b = new Surface(SEED);
    expect(a.chunk(5, 9)).toEqual(b.chunk(5, 9));
    // Chunk coordinates are periodic.
    expect(a.chunk(-1, -1)).toBe(a.chunk(WORLD_W / CHUNK_SIZE - 1, WORLD_H / CHUNK_SIZE - 1));
    // The last column of vertices of the last chunk is the first column of chunk 0, on both axes.
    const lastX = a.chunk(WORLD_W / CHUNK_SIZE - 1, 12), firstX = a.chunk(0, 12);
    for (let j = 0; j <= CHUNK_SIZE; j++) expect(lastX.heights[CHUNK_SIZE + j * (CHUNK_SIZE + 1)]).toBeCloseTo(firstX.heights[j * (CHUNK_SIZE + 1)], 5);
    const lastY = a.chunk(20, WORLD_H / CHUNK_SIZE - 1), firstY = a.chunk(20, 0);
    for (let i = 0; i <= CHUNK_SIZE; i++) expect(lastY.heights[i + CHUNK_SIZE * (CHUNK_SIZE + 1)]).toBeCloseTo(firstY.heights[i], 5);
    expect(a.height(WORLD_W - 0.001, 100)).toBeCloseTo(a.height(0, 100), 2);
  });

  it('has a sensible mix of landable sectors, and an LRU-bounded client cache', () => {
    let landable = 0;
    for (let id = 0; id < SECTOR_COUNT; id++) if (sectorInfo(SEED, id).landable) landable++;
    expect(landable).toBeGreaterThan(SECTOR_COUNT * 0.15);
    const s = new Surface(SEED, 4);
    const first = s.chunk(0, 0);
    for (let i = 1; i < 6; i++) s.chunk(i, 0);
    expect(s.chunk(0, 0)).not.toBe(first);
    expect(s.chunk(0, 0)).toEqual(first);
  });
});

describe('pathfinding and movement', () => {
  it('routes around a wall and refuses sealed goals', () => {
    const n = 16, blocked = new Uint8Array(n * n);
    for (let y = 0; y < 12; y++) blocked[8 + y * n] = 1;
    const pf = new Pathfinder(n, n, (x, y) => blocked[x + y * n] === 1);
    const path = pf.findPath(2.5, 2.5, 13.5, 2.5)!;
    expect(path.slice(-2)).toEqual([13.5, 2.5]);
    expect(Math.max(...path.filter((_, i) => i % 2 === 1))).toBeGreaterThan(12);
    for (let y = 12; y < n; y++) blocked[8 + y * n] = 1;
    expect(pf.findPath(2.5, 2.5, 13.5, 2.5)).toBeNull();
  });

  it('takes the short way across the seam of a wrapping map', () => {
    const pf = new Pathfinder(64, 32, () => false, true);
    const path = pf.findPath(1.5, 1.5, 62.5, 30.5)!;
    expect(path).toEqual([62.5, 30.5]);
    // With a wall along the seam column, the route has to go the long way or through the gap.
    const walled = new Pathfinder(64, 32, (x, y) => x === 63 && y !== 20, true);
    const around = walled.findPath(1.5, 18.5, 61.5, 18.5)!;
    expect(around.slice(-2)).toEqual([61.5, 18.5]);
    expect(around.length).toBeGreaterThan(2);
  });

  it('slides along obstacles and wraps direct movement', () => {
    const p = { x: 0.5, y: 5.5 };
    moveStep(p, -1, 0, 1, () => false);
    expect(p.x).toBe(WORLD_W - 0.5);
    const q = { x: 5.5, y: 5.5 };
    moveStep(q, 1, 1, 1, (tx) => tx === 6);
    expect(q.x).toBe(5.5);
    expect(q.y).toBeGreaterThan(5.5);
  });
});

describe('spatial inventory', () => {
  it('places items by footprint, rejects overlap and out-of-bounds, and honours rotation', () => {
    const inv = newInventory();
    expect(gridSize(inv, Cont.Pockets)).toEqual([4, 3]);
    expect(footprint(Item.Stick, 0)).toEqual([1, 3]);
    expect(footprint(Item.Stick, 1)).toEqual([3, 1]);
    // A 2x4 log only fits the 4x3 pockets lying on its side.
    expect(canPlace(inv, Item.Log, Cont.Pockets, 0, 0, 0)).toBe(false);
    expect(canPlace(inv, Item.Log, Cont.Pockets, 0, 0, 1)).toBe(true);
    expect(addItem(inv, Item.Log)).toBe(0);
    expect(inv.items[0]).toMatchObject({ x: 0, y: 0, rot: 1 });
    expect(canPlace(inv, Item.Flint, Cont.Pockets, 3, 1, 0)).toBe(false);
    expect(canPlace(inv, Item.Flint, Cont.Pockets, 3, 2, 0)).toBe(true);
    expect(canPlace(inv, Item.Stick, Cont.Pockets, 0, 2, 0)).toBe(false);
    expect(canPlace(inv, Item.Stick, Cont.Pockets, 0, 2, 1)).toBe(true);
    expect(canPlace(inv, Item.Stick, Cont.Pockets, 2, 2, 1)).toBe(false);
    // Moving an item may overlap its own old position.
    expect(moveItem(inv, inv.items[0].uid, Cont.Pockets, 0, 1, 1)).toBeNull();
    expect(moveItem(inv, inv.items[0].uid, Cont.Pockets, 1, 1, 1)).toBe('Does not fit there');
    expect(moveItem(inv, 999, Cont.Pockets, 0, 0, 0)).toBe('No such item');
    // A second log has nowhere to go.
    expect(addItem(inv, Item.Log)).toBe(1);
  });

  it('stacks, merges and removes', () => {
    const inv = newInventory();
    expect(addItem(inv, Item.Fiber, 15)).toBe(0);
    expect(inv.items.map((i) => i.qty)).toEqual([12, 3]);
    expect(moveItem(inv, inv.items[1].uid, Cont.Pockets, 3, 2, 0)).toBeNull();
    addItem(inv, Item.Fiber, 4);
    expect(countItem(inv, Item.Fiber)).toBe(19);
    const small = inv.items.find((i) => i.qty === 7)!;
    inv.items.find((i) => i.qty === 12)!.qty = 10;
    expect(moveItem(inv, small.uid, Cont.Pockets, 0, 0, 0)).toBeNull();
    expect(inv.items.map((i) => i.qty).sort()).toEqual([12, 5]);
  });

  it('unlocks bag grids from the paper doll and protects their contents', () => {
    const inv = newInventory();
    addItem(inv, Item.Pouch);
    const pouch = inv.items[0];
    expect(gridSize(inv, Cont.BeltGrid)).toBeNull();
    expect(canPlace(inv, Item.Flint, Cont.BeltGrid, 0, 0, 0)).toBe(false);
    expect(moveItem(inv, pouch.uid, Cont.Equip, Slot.Head, 0, 0)).toBe('Cannot be worn there');
    expect(moveItem(inv, pouch.uid, Cont.Equip, Slot.Belt, 0, 0)).toBeNull();
    expect(gridSize(inv, Cont.BeltGrid)).toEqual([3, 2]);
    expect(moveItem(inv, pouch.uid, Cont.BeltGrid, 0, 0, 0)).toBe('A bag cannot go inside itself');
    addItem(inv, Item.Flint);
    const flint = inv.items.find((i) => i.def === Item.Flint)!;
    expect(moveItem(inv, flint.uid, Cont.BeltGrid, 2, 1, 0)).toBeNull();
    expect(moveItem(inv, pouch.uid, Cont.Pockets, 0, 0, 0)).toBe('Empty it first');
    expect(moveItem(inv, flint.uid, Cont.Pockets, 0, 0, 0)).toBeNull();
    expect(moveItem(inv, pouch.uid, Cont.Pockets, 2, 0, 0)).toBeNull();
    // A full inventory still reports honestly.
    for (let i = 0; i < 30; i++) addItem(inv, Item.Stone, 2);
    expect(findSpace(inv, Item.Flint)).toBeNull();
  });
});

describe('weight and vitals', () => {
  it('sums weight and maps it to load tiers and speed', () => {
    const inv = newInventory();
    addItem(inv, Item.Log); addItem(inv, Item.Stone, 2);
    expect(totalWeight(inv)).toBeCloseTo(ITEMS[Item.Log].kg + 2);
    const cap = carryCapacity(0);
    expect(cap).toBe(24);
    expect(carryCapacity(xpForLevel(4))).toBe(36);
    expect(loadTier(5, cap)).toBe(LoadTier.Light);
    expect(loadTier(11, cap)).toBe(LoadTier.Medium);
    expect(loadTier(20, cap)).toBe(LoadTier.Heavy);
    expect(loadTier(24.1, cap)).toBe(LoadTier.Overloaded);
    const speeds = [0, 1, 2, 3].map((t) => moveSpeed(t, false, false, false));
    expect(speeds[0]).toBeGreaterThan(speeds[1]);
    expect(speeds[2]).toBeGreaterThan(speeds[3]);
    expect(moveSpeed(0, true, false, false)).toBeLessThan(speeds[0]);
  });

  it('drains stamina faster under load, and starvation and cold hurt', () => {
    const env = { ambient: 20, insulation: 0, shade: false, nearFire: false, inWater: false, moving: true, working: false, tier: LoadTier.Light };
    const light = newVitals(), heavy = newVitals();
    for (let i = 0; i < 200; i++) { tickVitals(light, 0.05, env); tickVitals(heavy, 0.05, { ...env, tier: LoadTier.Overloaded }); }
    expect(heavy.stamina).toBeLessThan(light.stamina);
    const hungry = { ...newVitals(), satiety: 0 };
    tickVitals(hungry, 1, { ...env, moving: false });
    expect(hungry.status & Status.Starving).toBeTruthy();
    expect(hungry.hp).toBeLessThan(100);
    const bare = newVitals(), clothed = newVitals();
    for (let i = 0; i < 2400; i++) {
      tickVitals(bare, 0.05, { ...env, moving: false, ambient: -15 });
      tickVitals(clothed, 0.05, { ...env, moving: false, ambient: -15, insulation: 12 });
    }
    expect(bare.temp).toBeLessThan(clothed.temp);
    expect(bare.status & Status.Cold).toBeTruthy();
  });
});

describe('protocol', () => {
  it('round-trips orders, snapshots and character state', () => {
    const input = { op: C2S.Input as const, seq: 70000, dx: -127, dy: 64 };
    expect(decodeClient(encodeClient(input))).toEqual(input);
    const move = { op: C2S.InvMove as const, uid: 300, c: Cont.PackGrid, x: 4, y: 2, rot: 1 };
    expect(decodeClient(encodeClient(move))).toEqual(move);
    const snap = {
      op: S2C.Snapshot as const, tick: 1234,
      full: [
        { id: 9, kind: EntityKind.Unit, x: 1000.5, y: 500.25, unit: { owner: 2, name: 'Yuu', hp: 90, maxHp: 100, state: 1, facing: Math.PI / 2, hero: true, order: Order.Wood, path: [5.5, 6.5, 1020.5, 9.5] } },
        { id: 10, kind: EntityKind.Node, x: 1.5, y: 2.5, node: { kind: NodeKind.Ore, amount: 6 } },
        { id: 11, kind: EntityKind.Structure, x: 3.5, y: 3.5, structure: { kind: StructureKind.GardenPlot, owner: 2, progress: 40, built: true, crop: 3 } },
        { id: 12, kind: EntityKind.Pod, x: 7.5, y: 7.5, pod: { owner: 2, spawnTick: 1200, deployed: true } },
        { id: 13, kind: EntityKind.Pile, x: 8.5, y: 7.5, pile: { item: Item.Log, qty: 3 } },
      ],
      moves: [{ id: 9, x: 5, y: 6.5, facing: Math.PI }],
      gone: [4, 5],
    };
    expect(decodeServer(encodeServer(snap))).toEqual(snap);
    const inv = { op: S2C.Inventory as const, items: [{ uid: 5, def: Item.FlintAxe, qty: 1, dur: 60, c: Cont.Pockets, x: 1, y: 0, rot: 1 }] };
    expect(decodeServer(encodeServer(inv))).toEqual(inv);
    const craft = { op: S2C.Craft as const, session: { pattern: PatternId.Pot, mistakes: 0, cells: [1, 2, 3, 4, 5, 6, 7, 255] } };
    expect(decodeServer(encodeServer(craft))).toEqual(craft);
    expect(() => decodeClient(new Uint8Array([C2S.MoveTo, 1]))).toThrow();
  });

  it('interpolates across the world seam the short way', () => {
    const m = new EntityMirror(20, 2, WORLD_W, WORLD_H);
    const unit = { owner: 1, name: 'a', hp: 1, maxHp: 1, state: 1, facing: 0, hero: true, order: 0, path: [] };
    m.apply({ tick: 100, full: [{ id: 1, kind: EntityKind.Unit, x: WORLD_W - 0.25, y: 5, unit }], moves: [], gone: [] }, 0);
    m.apply({ tick: 102, full: [], moves: [{ id: 1, x: 0.25, y: 5, facing: 0 }], gone: [] }, 100);
    m.update(200, 0.016);
    const e = m.entities.get(1)!;
    expect(e.rx > WORLD_W - 0.3 || e.rx < 0.3).toBe(true);
  });
});

// --- simulation ---------------------------------------------------------------

function forestSector(): number {
  for (let id = 0; id < SECTOR_COUNT; id++) if (sectorInfo(SEED, id).biome === Biome.Forest) return id;
  throw new Error('no forest sector');
}

/** A world with one landed, deployed hero. */
function landed(name = 'Yuu') {
  const sim = new WorldSim(SEED);
  sim.online.add(1);
  sim.landPlayer(1, name, forestSector());
  for (let i = 0; i <= POD_DEPLOY_TICKS + 2; i++) sim.step();
  const hero = sim.heroes.get(1)!;
  return { sim, hero, inv: sim.world.get(hero, Inv)!, char: sim.world.get(hero, Char)!, pos: sim.world.get(hero, Position)! };
}

function run(sim: WorldSim, seconds: number, until?: () => boolean): void {
  for (let i = 0; i < seconds * 20 && !until?.(); i++) sim.step();
}

function nearestNode(sim: WorldSim, pos: { x: number; y: number }, kind: NodeKind): number {
  const nodes = sim.world.query(Node).filter((e) => sim.world.get(e, Node)!.kind === kind);
  const d = (e: number) => { const p = sim.world.get(e, Position)!; return wrapDist(pos.x, pos.y, p.x, p.y); };
  return nodes.sort((a, b) => d(a) - d(b))[0];
}

describe('world simulation', () => {
  it('lands one hero wearing their clothes, with drifters nearby', () => {
    const { sim, hero, inv } = landed();
    expect(sim.landPlayer(1, 'Yuu', 3).fresh).toBe(false);
    const unit = sim.world.get(hero, Unit)!;
    expect(unit).toMatchObject({ hero: true, owner: 1, name: 'Yuu' });
    expect(sim.world.query(Unit).filter((u) => sim.world.get(u, Unit)!.owner === 1)).toHaveLength(1);
    expect(inv.items.filter((i) => i.c === Cont.Equip).map((i) => i.def).sort()).toEqual([Item.Shirt, Item.Trousers].sort());
    expect(countItem(inv, Item.Berries)).toBe(6);
    expect(sim.world.query(Unit).filter((u) => sim.world.get(u, Unit)!.owner === 0).length).toBeGreaterThanOrEqual(2);
    expect(sim.selfState(1)).toMatchObject({ tier: LoadTier.Light });
  });

  it('applies direct movement inputs in order and slows an overloaded hero', () => {
    const { sim, char, pos, inv } = landed();
    const walk = (ticks: number) => {
      const from = { ...pos };
      let seq = char.ack;
      for (let i = 0; i < ticks; i++) { sim.pushInput(1, ++seq, 0, 127); sim.step(); }
      expect(char.ack).toBe(seq);
      return wrapDist(from.x, from.y, pos.x, pos.y);
    };
    const light = walk(10);
    expect(light).toBeGreaterThan(1);
    for (let i = 0; i < 40; i++) inv.items.push({ uid: 900 + i, def: Item.Stone, qty: 2, dur: 0, c: Cont.Pockets, x: 0, y: 0, rot: 0 });
    expect(sim.selfState(1)!.tier).toBe(LoadTier.Overloaded);
    expect(walk(10)).toBeLessThan(light * 0.6);
  });

  it('lets a hero walk off one edge of the world and arrive on the other', () => {
    const { sim, hero, pos } = landed();
    sim.placeUnit(hero, WORLD_W - 0.4, pos.y);
    const y = pos.y;
    let seq = 0, crossed = false;
    for (let i = 0; i < 80 && !crossed; i++) {
      sim.pushInput(1, ++seq, 127, 0);
      sim.step();
      crossed = pos.x < 10;
    }
    // Obstacles may nudge the walk sideways, but it must come out on the far side.
    expect(crossed).toBe(true);
    expect(Math.abs(pos.y - y)).toBeLessThan(6);
    // Click-to-move also plans across the seam.
    sim.placeUnit(hero, 1.5, pos.y);
    sim.enqueue({ type: 'moveTo', player: 1, x: WORLD_W - 3.5, y: pos.y });
    run(sim, 6, () => pos.x > WORLD_W - 6);
    expect(pos.x).toBeGreaterThan(WORLD_W - 6);
  });

  it('streams resource nodes in around the player and puts them away behind them', () => {
    const { sim, hero, pos } = landed();
    const here = nearestNode(sim, pos, NodeKind.Tree);
    expect(here).toBeDefined();
    const before = sim.world.query(Node).length;
    sim.placeUnit(hero, wrapX(pos.x + 400), pos.y);
    run(sim, 12);
    expect(sim.world.isAlive(here)).toBe(false);
    const p = sim.world.get(nearestNode(sim, pos, NodeKind.Tree) ?? nearestNode(sim, pos, NodeKind.Stone), Position)!;
    expect(wrapDist(pos.x, pos.y, p.x, p.y)).toBeLessThan(120);
    expect(sim.world.query(Node).length).toBeLessThan(before * 3);
  });

  it('harvests by hand up to a point, and needs an axe for logs', () => {
    const { sim, inv, pos } = landed();
    const tree = nearestNode(sim, pos, NodeKind.Tree);
    sim.enqueue({ type: 'interact', player: 1, target: tree });
    run(sim, 60, () => sim.notices.some((n) => n.text.includes('axe')));
    expect(countItem(inv, Item.Stick)).toBe(3);
    expect(countItem(inv, Item.Log)).toBe(0);
    expect(sim.world.get(tree, Node)!.amount).toBe(3);
    addItem(inv, Item.FlintAxe);
    const axe = inv.items.find((i) => i.def === Item.FlintAxe)!;
    sim.enqueue({ type: 'interact', player: 1, target: tree });
    run(sim, 60, () => !sim.world.isAlive(tree));
    expect(sim.world.isAlive(tree)).toBe(false);
    // Three more hits: two logs and a stick. Only one log fits the pockets; the other is left on the ground.
    expect(countItem(inv, Item.Log) + sim.world.query(Pile).filter((e) => sim.world.get(e, Pile)!.item === Item.Log).length).toBe(2);
    expect(axe.dur).toBeLessThan(60);
    expect(sim.world.get(sim.heroes.get(1)!, Char)!.skills[1]).toBeGreaterThan(0);
  });

  it('knaps a flint axe head on the server, enforcing edge strikes and mistakes', () => {
    const { sim, inv, char } = landed();
    sim.enqueue({ type: 'craftStart', player: 1, pattern: PatternId.AxeHead });
    sim.step();
    expect(char.craft).toBeNull();
    addItem(inv, Item.Flint, 2); addItem(inv, Item.Stone, 1);
    sim.enqueue({ type: 'craftStart', player: 1, pattern: PatternId.AxeHead });
    sim.step();
    expect(char.craft).not.toBeNull();
    // An interior cell cannot be struck.
    sim.enqueue({ type: 'craftHit', player: 1, x: 3, y: 3 });
    sim.step();
    expect(char.craft!.cells[3]).toBe(255);
    // Chip away everything outside the pattern, always from an exposed edge.
    const rows = PATTERNS[PatternId.AxeHead].rows;
    const has = (x: number, y: number) => x >= 0 && y >= 0 && x < 8 && y < 8 && (char.craft!.cells[y] >> x & 1) === 1;
    for (let guard = 0; guard < 80 && char.craft; guard++) {
      for (let y = 0; y < 8 && char.craft; y++) for (let x = 0; x < 8 && char.craft; x++) {
        if (!has(x, y) || rows[y] >> x & 1) continue;
        if (has(x - 1, y) && has(x + 1, y) && has(x, y - 1) && has(x, y + 1)) continue;
        sim.enqueue({ type: 'craftHit', player: 1, x, y });
        sim.step();
      }
    }
    expect(char.craft).toBeNull();
    expect(countItem(inv, Item.AxeHead)).toBe(1);
    expect(countItem(inv, Item.Flint)).toBe(1);
    // Striking the workpiece itself too often shatters the blank.
    sim.enqueue({ type: 'craftStart', player: 1, pattern: PatternId.KnifeBlade });
    sim.step();
    sim.enqueue({ type: 'craftHit', player: 1, x: 4, y: 0 });
    sim.enqueue({ type: 'craftHit', player: 1, x: 4, y: 0 });
    sim.step();
    expect(char.craft).toBeNull();
    expect(countItem(inv, Item.Flint)).toBe(0);
    expect(countItem(inv, Item.KnifeBlade)).toBe(0);
  });

  it('assembles an axe from parts in steps, and refuses when a part is missing', () => {
    const { sim, inv } = landed();
    const cordage = RECIPES.findIndex((r) => r.output === Item.Cordage), haft = RECIPES.findIndex((r) => r.output === Item.FlintAxe);
    addItem(inv, Item.AxeHead); addItem(inv, Item.Stick); addItem(inv, Item.Fiber, 3);
    sim.enqueue({ type: 'recipe', player: 1, recipe: haft, station: 0 });
    run(sim, 8);
    expect(countItem(inv, Item.FlintAxe)).toBe(0);
    expect(sim.notices.some((n) => n.text.includes('Cordage'))).toBe(true);
    sim.enqueue({ type: 'recipe', player: 1, recipe: cordage, station: 0 });
    run(sim, 1);
    // Timed work: nothing is produced instantly.
    expect(countItem(inv, Item.Cordage)).toBe(0);
    run(sim, 4);
    expect(countItem(inv, Item.Cordage)).toBe(1);
    sim.enqueue({ type: 'recipe', player: 1, recipe: haft, station: 0 });
    run(sim, 7);
    expect(countItem(inv, Item.FlintAxe)).toBe(1);
    expect([Item.AxeHead, Item.Stick, Item.Cordage].map((i) => countItem(inv, i))).toEqual([0, 0, 0]);
  });

  it('requires a built station for station recipes and uses materials lying on site', () => {
    const { sim, hero, inv, pos } = landed();
    const split = RECIPES.findIndex((r) => r.output === Item.Firewood);
    addItem(inv, Item.FlintAxe);
    sim.enqueue({ type: 'recipe', player: 1, recipe: split, station: 0 });
    sim.step();
    expect(sim.notices.some((n) => n.text.includes('chopping block'))).toBe(true);
    // Two logs on the ground: one becomes the block, one is split on it.
    sim.dropPile(Item.Log, 1, 0, pos.x + 1, pos.y);
    sim.dropPile(Item.Log, 1, 0, pos.x - 1, pos.y);
    const tx = Math.floor(pos.x) + 2, ty = Math.floor(pos.y) + 1;
    sim.enqueue({ type: 'build', player: 1, kind: StructureKind.ChoppingBlock, tx, ty });
    run(sim, 20, () => sim.world.query(Structure).some((e) => sim.world.get(e, Structure)!.built));
    const block = sim.world.query(Structure)[0];
    expect(sim.world.get(block, Structure)).toMatchObject({ kind: StructureKind.ChoppingBlock, built: true });
    expect(sim.blockedAt(tx, ty)).toBe(true);
    sim.enqueue({ type: 'recipe', player: 1, recipe: split, station: block });
    run(sim, 12, () => countItem(inv, Item.Firewood) > 0);
    expect(countItem(inv, Item.Firewood)).toBe(4);
    expect(sim.world.query(Pile).filter((e) => sim.world.get(e, Pile)!.item === Item.Log)).toHaveLength(0);
    expect(sim.world.get(hero, Unit)!.state).toBe(0);
  });

  it('validates inventory moves, drops and item use on the server', () => {
    const { sim, inv, char, pos } = landed();
    const berries = inv.items.find((i) => i.def === Item.Berries)!;
    char.vitals.satiety = 50;
    sim.enqueue({ type: 'invUse', player: 1, uid: berries.uid });
    sim.enqueue({ type: 'invMove', player: 1, uid: berries.uid, c: Cont.Pockets, x: 9, y: 9, rot: 0 });
    sim.step();
    expect(char.vitals.satiety).toBeGreaterThan(55);
    expect(berries.qty).toBe(5);
    expect(berries.x).toBeLessThan(4);
    expect(sim.notices.some((n) => n.text === 'Does not fit there')).toBe(true);
    sim.enqueue({ type: 'invDrop', player: 1, uid: berries.uid });
    sim.step();
    expect(countItem(inv, Item.Berries)).toBe(0);
    const pile = sim.world.query(Pile)[0];
    expect(sim.world.get(pile, Pile)).toMatchObject({ item: Item.Berries, qty: 5 });
    sim.enqueue({ type: 'interact', player: 1, target: pile });
    run(sim, 3, () => countItem(inv, Item.Berries) === 5);
    expect(countItem(inv, Item.Berries)).toBe(5);
    expect(wrapDist(pos.x, pos.y, pos.x, pos.y)).toBe(0);
  });

  it('recruits a drifter for food and has them fell timber into a stockpile', () => {
    const { sim, hero, inv, pos } = landed();
    const drifter = sim.world.query(Unit).filter((u) => sim.world.get(u, Unit)!.owner === 0)
      .sort((a, b) => wrapDist(pos.x, pos.y, sim.world.get(a, Position)!.x, sim.world.get(a, Position)!.y) - wrapDist(pos.x, pos.y, sim.world.get(b, Position)!.x, sim.world.get(b, Position)!.y))[0];
    inv.items.find((i) => i.def === Item.Berries)!.qty = 2;
    sim.enqueue({ type: 'interact', player: 1, target: drifter });
    run(sim, 15, () => sim.notices.some((n) => n.text.includes('wants')));
    expect(sim.world.get(drifter, Unit)!.owner).toBe(0);
    addItem(inv, Item.Berries, 4);
    sim.enqueue({ type: 'interact', player: 1, target: drifter });
    run(sim, 15, () => sim.world.get(drifter, Unit)!.owner === 1);
    expect(sim.world.get(drifter, Follower)).toMatchObject({ leader: hero, order: Order.Follow });
    expect(countItem(inv, Item.Berries)).toBe(3);
    // Another player's hero cannot command them.
    sim.enqueue({ type: 'order', player: 2, npc: drifter, order: Order.Stay });
    sim.enqueue({ type: 'order', player: 1, npc: drifter, order: Order.Wood });
    sim.step();
    expect(sim.world.get(drifter, Follower)!.order).toBe(Order.Wood);
    const logsOnGround = () => sim.world.query(Pile).filter((e) => sim.world.get(e, Pile)!.item === Item.Log).reduce((n, e) => n + sim.world.get(e, Pile)!.qty, 0);
    run(sim, 240, () => logsOnGround() > 0);
    expect(logsOnGround()).toBeGreaterThan(0);
  });

  it('replicates only what changed inside the area of interest', () => {
    const { sim, pos } = landed();
    const source: ReplicationSource = {
      grid: sim.grid, get tick() { return sim.tick; },
      version: (e) => sim.world.get(e, Net)!.version, moveTick: (e) => sim.world.get(e, Net)!.moveTick,
      describe: (e) => describeEntity(sim.world, e),
    };
    const repl = new Replicator();
    const cx = sim.grid.chunkX(pos.x), cy = sim.grid.chunkY(pos.y);
    const first = decodeServer(repl.build(source, cx, cy, 1, []));
    if (first.op !== S2C.Snapshot) throw new Error('expected snapshot');
    expect(first.full.length).toBeGreaterThan(0);
    expect(first.full.length).toBeLessThan(sim.world.entityCount);
    sim.step();
    expect(repl.build(source, cx, cy, 1, []).byteLength).toBe(11);
    const moved = decodeServer(repl.build(source, cx + 20, cy, 0, []));
    if (moved.op !== S2C.Snapshot) throw new Error('expected snapshot');
    expect(moved.gone.length).toBe(first.full.length);
  });
});

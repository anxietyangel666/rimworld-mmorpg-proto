import { describe, expect, it } from 'vitest';
import { ChunkGrid, defineComponent, World } from '../core-ecs';
import {
  EntityKind, Node, Pathfinder, POD_DEPLOY_TICKS, Position, SectorSim, STARTING_STOCK, Structure, StructureKind, Unit,
  describeEntity,
} from '../game-sim';
import { C2S, decodeClient, decodeServer, encodeClient, encodeServer, Replicator, S2C, type ReplicationSource } from '../network';
import { Net } from '../game-sim';
import { Biome, bakePlanetMaps, generateSector, NodeKind, SECTOR_COUNT, sectorFromDir, sectorCenterDir, sectorInfo } from '../world-gen';

const SEED = 20451;

describe('core-ecs', () => {
  it('queries by component set and defers destruction to end of step', () => {
    const A = defineComponent<{ v: number }>('A'), B = defineComponent<{ w: number }>('B');
    const w = new World();
    const e1 = w.create(), e2 = w.create();
    w.add(e1, A, { v: 1 }); w.add(e1, B, { w: 2 }); w.add(e2, A, { v: 3 });
    expect(w.query(A)).toEqual([e1, e2]);
    expect(w.query(A, B)).toEqual([e1]);
    w.addSystem({ name: 'kill', update: (world) => world.destroy(e1) });
    w.step(0.05);
    expect(w.isAlive(e1)).toBe(false);
    expect(w.query(A)).toEqual([e2]);
    expect(w.tick).toBe(1);
  });

  it('chunk grid tracks moves between chunks', () => {
    const g = new ChunkGrid(16, 8);
    g.update(1, 5, 5); g.update(2, 100, 100);
    const seen: number[] = [];
    g.forEachInChunks(0, 0, 1, (e) => seen.push(e));
    expect(seen).toEqual([1]);
    g.update(1, 100, 101);
    seen.length = 0;
    g.forEachInChunks(6, 6, 0, (e) => seen.push(e));
    expect(seen.sort()).toEqual([1, 2]);
  });
});

describe('world-gen', () => {
  it('is deterministic and maps directions to sectors and back', () => {
    expect(bakePlanetMaps(SEED, 32, 16)).toEqual(bakePlanetMaps(SEED, 32, 16));
    for (const id of [0, 37, 255, SECTOR_COUNT - 1]) expect(sectorFromDir(...sectorCenterDir(id))).toBe(id);
    const a = generateSector(SEED, 100, Biome.Forest), b = generateSector(SEED, 100, Biome.Forest);
    expect(a.tiles).toEqual(b.tiles);
    expect(a.nodes).toEqual(b.nodes);
    expect(a.nodes.some((n) => n.kind === NodeKind.Tree)).toBe(true);
  });

  it('produces a planet with both ocean and a healthy share of landable sectors', () => {
    let landable = 0;
    for (let id = 0; id < SECTOR_COUNT; id++) if (sectorInfo(SEED, id).landable) landable++;
    expect(landable).toBeGreaterThan(SECTOR_COUNT * 0.15);
    expect(landable).toBeLessThan(SECTOR_COUNT * 0.7);
  });
});

describe('pathfinding', () => {
  it('routes around a wall and refuses sealed goals', () => {
    const n = 16, blocked = new Uint8Array(n * n);
    for (let y = 0; y < 12; y++) blocked[8 + y * n] = 1;
    const pf = new Pathfinder(n, blocked);
    const path = pf.findPath(2.5, 2.5, 13.5, 2.5)!;
    expect(path.slice(-2)).toEqual([13.5, 2.5]);
    // Every leg must be walkable.
    let px = 2.5, py = 2.5;
    for (let i = 0; i < path.length; i += 2) {
      expect(pf.lineClear(px, py, path[i], path[i + 1]) || Math.hypot(path[i] - px, path[i + 1] - py) < 1.5).toBe(true);
      px = path[i]; py = path[i + 1];
    }
    expect(Math.max(...path.filter((_, i) => i % 2 === 1))).toBeGreaterThan(12);
    for (let y = 12; y < n; y++) blocked[8 + y * n] = 1;
    expect(pf.findPath(2.5, 2.5, 13.5, 2.5)).toBeNull();
  });
});

describe('protocol', () => {
  it('round-trips client orders and snapshots', () => {
    const move = { op: C2S.Move as const, units: [3, 70000], x: 12.5, y: 99.25 };
    expect(decodeClient(encodeClient(move))).toEqual(move);
    const snap = {
      op: S2C.Snapshot as const, tick: 1234,
      full: [
        { id: 9, kind: EntityKind.Unit, x: 4.5, y: 6.5, unit: { owner: 2, name: 'YU-1', hp: 90, maxHp: 100, state: 1, facing: Math.PI / 2, path: [5.5, 6.5, 9.5, 9.5] } },
        { id: 10, kind: EntityKind.Node, x: 1.5, y: 2.5, node: { kind: NodeKind.Ore, amount: 30 } },
        { id: 11, kind: EntityKind.Structure, x: 3.5, y: 3.5, structure: { kind: StructureKind.Beacon, owner: 2, progress: 40, built: false } },
        { id: 12, kind: EntityKind.Pod, x: 7.5, y: 7.5, pod: { owner: 2, spawnTick: 1200, deployed: true } },
      ],
      moves: [{ id: 9, x: 5, y: 6.5, facing: Math.PI }],
      gone: [4, 5],
    };
    expect(decodeServer(encodeServer(snap))).toEqual(snap);
    expect(() => decodeClient(new Uint8Array([C2S.Move, 1]))).toThrow();
  });
});

function landableSector(): number {
  for (let id = 0; id < SECTOR_COUNT; id++) if (sectorInfo(SEED, id).biome === Biome.Forest) return id;
  throw new Error('no forest sector');
}

describe('sector simulation', () => {
  it('lands a pod, deploys a crew, harvests and builds', () => {
    const id = landableSector();
    const sim = new SectorSim(SEED, id, sectorInfo(SEED, id).biome);
    const site = sim.landPlayer(1, 'Yuu');
    expect(site.fresh).toBe(true);
    expect(sim.landPlayer(1, 'Yuu').fresh).toBe(false);
    for (let i = 0; i <= POD_DEPLOY_TICKS + 60; i++) sim.step();
    const crew = sim.unitsOf.get(1)!;
    expect(crew).toHaveLength(3);
    expect(sim.world.get(crew[0], Unit)!.name).toBe('YU-1');

    // Harvest the closest tree until wood comes in.
    const pos = sim.world.get(crew[0], Position)!;
    const trees = sim.world.query(Node).filter((e) => sim.world.get(e, Node)!.kind === NodeKind.Tree);
    trees.sort((a, b) => dist(sim, a, pos) - dist(sim, b, pos));
    sim.enqueue({ type: 'interact', player: 1, units: [crew[0]], target: trees[0] });
    for (let i = 0; i < 20 * 40 && sim.stock.get(1)!.wood === STARTING_STOCK.wood; i++) sim.step();
    expect(sim.stock.get(1)!.wood).toBeGreaterThan(STARTING_STOCK.wood);

    // Another player's units cannot be ordered around.
    sim.enqueue({ type: 'move', player: 2, units: [crew[1]], x: 1, y: 1 });
    const before = { ...sim.world.get(crew[1], Position)! };
    for (let i = 0; i < 10; i++) sim.step();
    expect(sim.world.get(crew[1], Position)).toEqual(before);

    // Build a wall next to the second crew member; it must finish and block its tile.
    const p1 = sim.world.get(crew[1], Position)!;
    const tx = Math.floor(p1.x) + 2, ty = Math.floor(p1.y);
    const woodBefore = sim.stock.get(1)!.wood;
    sim.enqueue({ type: 'build', player: 1, units: [crew[1]], kind: StructureKind.Wall, tx, ty });
    for (let i = 0; i < 20 * 20; i++) sim.step();
    const wall = sim.world.query(Structure)[0];
    expect(sim.world.get(wall, Structure)!.built).toBe(true);
    expect(sim.blocked[tx + ty * 128]).toBe(1);
    expect(sim.stock.get(1)!.wood).toBeLessThan(woodBefore + 100);
  });

  it('replicates only what changed inside the area of interest', () => {
    const id = landableSector();
    const sim = new SectorSim(SEED, id, sectorInfo(SEED, id).biome);
    sim.landPlayer(1, 'A');
    const source: ReplicationSource = {
      grid: sim.grid, get tick() { return sim.tick; },
      version: (e) => sim.world.get(e, Net)!.version, moveTick: (e) => sim.world.get(e, Net)!.moveTick,
      describe: (e) => describeEntity(sim.world, e),
    };
    const repl = new Replicator();
    sim.step();
    const first = decodeServer(repl.build(source, 4, 4, 1, []));
    if (first.op !== S2C.Snapshot) throw new Error('expected snapshot');
    expect(first.full.length).toBeGreaterThan(0);
    expect(first.full.length).toBeLessThan(sim.world.entityCount);
    sim.step();
    const quiet = repl.build(source, 4, 4, 1, []);
    expect(quiet.byteLength).toBe(11);
    // Moving the view drops what fell out of range.
    const moved = decodeServer(repl.build(source, 0, 0, 0, []));
    if (moved.op !== S2C.Snapshot) throw new Error('expected snapshot');
    expect(moved.gone.length).toBe(first.full.length);
  });
});

function dist(sim: SectorSim, e: number, p: { x: number; y: number }): number {
  const q = sim.world.get(e, Position)!;
  return Math.hypot(q.x - p.x, q.y - p.y);
}

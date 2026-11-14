import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { EntityKind } from '../game-sim/components';
import type { ItemInst } from '../game-sim/inventory';
import { Item } from '../game-sim/items';
import type { EntityState } from '../game-sim/view';
import type { SelfState } from '../game-sim/worldSim';
import { C2S, decodeServer, encodeClient, S2C, type ClientMsg, type ServerMsg } from '../network/protocol';
import { Biome, SECTOR_COUNT, sectorInfo } from '../world-gen/planet';
import { NodeKind, wrapDist } from '../world-gen/surface';

/**
 * End-to-end multiplayer check against a real server process: two headless
 * clients land in the same sector and must see each other's characters; one
 * walks with direct input, gathers by hand and drops what it gathered; the
 * other watches all of that replicate and picks the goods up.
 *
 * Run with `npm run build && npm run smoke`.
 */

const PORT = 18080;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Bot {
  id = 0;
  seed = 0;
  self: SelfState | null = null;
  items: ItemInst[] = [];
  readonly entities = new Map<number, EntityState>();
  private ws!: WebSocket;
  private seq = 0;

  constructor(readonly name: string) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket('ws://localhost:' + PORT + '/ws');
    this.ws.on('message', (raw: Buffer) => this.onMessage(decodeServer(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))));
    await new Promise<void>((resolve, reject) => { this.ws.once('open', () => resolve()); this.ws.once('error', reject); });
    this.send({ op: C2S.Hello, token: 'smoke-token-' + this.name, name: this.name });
    await until(() => this.id > 0, 'welcome for ' + this.name);
  }

  send(m: ClientMsg): void {
    this.ws.send(encodeClient(m));
  }

  close(): void {
    this.ws.close();
  }

  /** Hold a direction for a number of ticks, the way a browser client streams WASD. */
  async walk(dx: number, dy: number, ticks: number): Promise<void> {
    for (let i = 0; i < ticks; i++) { this.send({ op: C2S.Input, seq: ++this.seq, dx, dy }); await sleep(50); }
    this.send({ op: C2S.Input, seq: ++this.seq, dx: 0, dy: 0 });
  }

  hero(owner: number): EntityState | undefined {
    return [...this.entities.values()].find((e) => e.unit?.hero && e.unit.owner === owner);
  }

  count(item: Item): number {
    return this.items.filter((i) => i.def === item).reduce((n, i) => n + i.qty, 0);
  }

  private onMessage(m: ServerMsg): void {
    if (m.op === S2C.Welcome) { this.id = m.playerId; this.seed = m.seed; }
    else if (m.op === S2C.Self) this.self = m.self;
    else if (m.op === S2C.Inventory) this.items = m.items;
    else if (m.op === S2C.Snapshot) {
      for (const e of m.full) this.entities.set(e.id, e);
      for (const mv of m.moves) { const e = this.entities.get(mv.id); if (e) { e.x = mv.x; e.y = mv.y; } }
      for (const id of m.gone) this.entities.delete(id);
    }
  }
}

async function until(cond: () => boolean, what: string, timeoutMs = 40000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for ' + what);
    await sleep(50);
  }
  console.log('  ok: ' + what + ' (' + (Date.now() - t0) + ' ms)');
}

async function main(): Promise<void> {
  const server = spawn(process.execPath, ['dist/server/main.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit' });
  try {
    await sleep(800);
    const a = new Bot('Alpha'), b = new Bot('Bravo');
    await a.connect();
    await b.connect();
    let sector = -1;
    for (let id = 0; id < SECTOR_COUNT && sector < 0; id++) if (sectorInfo(a.seed, id).biome === Biome.Forest) sector = id;
    a.send({ op: C2S.Land, sector });
    b.send({ op: C2S.Land, sector });

    await until(() => !!a.hero(a.id) && !!b.hero(b.id), 'both characters stepped out of their pods');
    await until(() => !!a.hero(b.id) && !!b.hero(a.id), 'each client sees the other player\'s character');
    await until(() => a.count(Item.Berries) === 6 && a.items.some((i) => i.def === Item.Shirt), 'starting inventory arrived');

    const from = { x: a.self!.x, y: a.self!.y };
    await a.walk(0, 127, 20);
    await until(() => wrapDist(from.x, from.y, a.self!.x, a.self!.y) > 1.5, 'direct input moved Alpha on the server');
    await until(() => wrapDist(from.x, from.y, b.hero(a.id)!.x, b.hero(a.id)!.y) > 1.5, 'Bravo watched Alpha walk');

    const trees = [...a.entities.values()].filter((e) => e.node?.kind === NodeKind.Tree);
    trees.sort((p, q) => wrapDist(p.x, p.y, a.self!.x, a.self!.y) - wrapDist(q.x, q.y, a.self!.x, a.self!.y));
    a.send({ op: C2S.Interact, target: trees[0].id });
    await until(() => a.count(Item.Stick) > 0, 'gathering by hand put sticks in Alpha\'s pockets');

    const sticks = a.items.find((i) => i.def === Item.Stick)!;
    a.send({ op: C2S.MoveTo, x: a.self!.x, y: a.self!.y });
    a.send({ op: C2S.InvDrop, uid: sticks.uid });
    const pileOf = (bot: Bot) => [...bot.entities.values()].find((e) => e.kind === EntityKind.Pile && e.pile!.item === Item.Stick);
    await until(() => a.count(Item.Stick) === 0 && !!pileOf(b), 'Bravo sees the sticks Alpha dropped');
    b.send({ op: C2S.Interact, target: pileOf(b)!.id });
    await until(() => b.count(Item.Stick) > 0 && !pileOf(a), 'Bravo walked over and picked them up');

    // An illegal inventory move must be refused and leave the item where it was.
    const berries = b.items.find((i) => i.def === Item.Berries)!;
    b.send({ op: C2S.InvMove, uid: berries.uid, c: 2, x: 0, y: 0, rot: 0 });
    b.send({ op: C2S.InvUse, uid: berries.uid });
    await until(() => b.count(Item.Berries) === 5, 'eating a berry is applied by the server');
    if (b.items.find((i) => i.def === Item.Berries)!.c !== berries.c) throw new Error('server accepted a move into a pack that is not worn');

    a.close(); b.close();
    console.log('SMOKE PASSED');
  } finally {
    server.kill();
  }
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err.message);
  process.exit(1);
});

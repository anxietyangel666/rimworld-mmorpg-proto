import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { EntityKind, StructureKind } from '../game-sim/components';
import type { EntityState } from '../game-sim/view';
import { C2S, decodeServer, encodeClient, S2C, type ClientMsg, type ServerMsg } from '../network/protocol';
import { Biome, SECTOR_COUNT, sectorInfo } from '../world-gen/planet';
import { NodeKind } from '../world-gen/sector';

/**
 * End-to-end multiplayer check against a real server process: two headless
 * clients land in the same sector, must see each other's crews, then one moves,
 * harvests and builds while the other watches the result replicate.
 *
 * Run with `npm run build && npm run smoke`.
 */

const PORT = 18080;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Bot {
  id = 0;
  seed = 0;
  wood = 0;
  readonly entities = new Map<number, EntityState>();
  private ws!: WebSocket;

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

  units(owner: number): EntityState[] {
    return [...this.entities.values()].filter((e) => e.unit?.owner === owner);
  }

  private onMessage(m: ServerMsg): void {
    if (m.op === S2C.Welcome) { this.id = m.playerId; this.seed = m.seed; }
    else if (m.op === S2C.Stock) this.wood = m.wood;
    else if (m.op === S2C.Snapshot) {
      for (const e of m.full) this.entities.set(e.id, e);
      for (const mv of m.moves) { const e = this.entities.get(mv.id); if (e) { e.x = mv.x; e.y = mv.y; } }
      for (const id of m.gone) this.entities.delete(id);
    }
  }
}

async function until(cond: () => boolean, what: string, timeoutMs = 30000): Promise<void> {
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

    await until(() => a.units(a.id).length === 3 && b.units(b.id).length === 3, 'both crews deployed from their pods');
    await until(() => a.units(b.id).length === 3 && b.units(a.id).length === 3, 'each client sees the other player\'s crew');

    const lead = a.units(a.id)[0];
    const from = { x: lead.x, y: lead.y };
    a.send({ op: C2S.Move, units: [lead.id], x: lead.x + 4, y: lead.y + 1 });
    await until(() => Math.hypot(b.entities.get(lead.id)!.x - from.x, b.entities.get(lead.id)!.y - from.y) > 2.5, 'Bravo watches Alpha\'s unit walk');

    const trees = [...a.entities.values()].filter((e) => e.node?.kind === NodeKind.Tree);
    trees.sort((p, q) => Math.hypot(p.x - lead.x, p.y - lead.y) - Math.hypot(q.x - lead.x, q.y - lead.y));
    const woodBefore = a.wood;
    a.send({ op: C2S.Interact, units: a.units(a.id).map((u) => u.id), target: trees[0].id });
    await until(() => a.wood > woodBefore, 'harvesting raises Alpha\'s timber stock');

    const builder = b.units(b.id)[0];
    const tx = Math.floor(builder.x) + 2, ty = Math.floor(builder.y) + 1;
    b.send({ op: C2S.Build, units: [builder.id], kind: StructureKind.Wall, tx, ty });
    const wallOf = (bot: Bot) => [...bot.entities.values()].find((e) => e.kind === EntityKind.Structure && Math.floor(e.x) === tx && Math.floor(e.y) === ty);
    await until(() => !!wallOf(a), 'Alpha sees Bravo\'s blueprint');
    await until(() => wallOf(a)?.structure?.built === true, 'Alpha sees Bravo\'s wall completed');

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

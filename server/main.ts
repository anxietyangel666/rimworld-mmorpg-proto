import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { TickLoop } from '../core-ecs/tick';
import { AOI_RADIUS, Char, describeEntity, Inv, Net, SNAPSHOT_EVERY, TICK_RATE, WorldSim } from '../game-sim';
import { C2S, decodeClient, encodeServer, Replicator, S2C, type ClientMsg, type ReplicationSource, type ServerMsg } from '../network';
import { SECTOR_COUNT, sectorInfo } from '../world-gen/planet';
import { sectorOfTile } from '../world-gen/surface';

/**
 * Authoritative game server.
 *
 * One HTTP listener serves the built web client and upgrades /ws to the binary
 * game socket. The whole planet is one simulation stepped here at a fixed
 * 20 Hz; clients send inputs and orders and receive area-of-interest snapshots
 * centred on their character.
 *
 * World state lives in memory for the lifetime of the process: characters and
 * colonies persist across disconnects and followers keep working while their
 * leader is away, but nothing survives a server restart.
 */

const PORT = Number(process.env.PORT ?? 8080);
const SEED = Number(process.env.WORLD_SEED ?? 20451) >>> 0;
const CLIENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../client');
/** Per-connection inbound budget; messages beyond it are dropped. */
const MAX_MSGS_PER_SEC = 120;

interface Player {
  id: number;
  token: string;
  name: string;
  /** True while the player is viewing the surface rather than orbit. */
  present: boolean;
  ws: WebSocket | null;
  repl: Replicator;
}

const players = new Map<number, Player>();
const playersByToken = new Map<string, Player>();
const sim = new WorldSim(SEED);
const source: ReplicationSource = {
  grid: sim.grid,
  get tick() { return sim.tick; },
  version: (e) => sim.world.get(e, Net)?.version ?? 0,
  moveTick: (e) => sim.world.get(e, Net)?.moveTick ?? 0,
  describe: (e) => describeEntity(sim.world, e),
};
let nextPlayerId = 1;

function send(p: Player, m: ServerMsg): void {
  if (p.ws?.readyState === WebSocket.OPEN) p.ws.send(encodeServer(m));
}

function homeSector(p: Player): number {
  const c = sim.viewCenter(p.id);
  return c ? sectorOfTile(c.x, c.y) : -1;
}

function sectorStats(): ServerMsg {
  return { op: S2C.SectorStats, sectors: [...sim.sectorCounts()].map(([sector, s]) => ({ sector, ...s })) };
}

function broadcastRoster(): void {
  const msg = encodeServer({ op: S2C.Roster, players: [...players.values()].filter((p) => p.present).slice(0, 200).map((p) => ({ id: p.id, name: p.name })) });
  for (const p of players.values()) if (p.present && p.ws?.readyState === WebSocket.OPEN) p.ws.send(msg);
}

function setPresent(p: Player, present: boolean): void {
  if (p.present === present) return;
  p.present = present;
  if (present) sim.online.add(p.id); else sim.online.delete(p.id);
  broadcastRoster();
}

function handle(p: Player, m: ClientMsg): void {
  const player = p.id;
  switch (m.op) {
    case C2S.Land: {
      // One character per player: asking to land anywhere returns you to them.
      const returning = sim.viewCenter(player) !== null;
      if (!returning && (m.sector >= SECTOR_COUNT || !sectorInfo(SEED, m.sector).landable)) {
        send(p, { op: S2C.Notice, text: 'No stable ground to land on there' });
        return;
      }
      const site = sim.landPlayer(player, p.name, m.sector);
      p.repl.reset();
      setPresent(p, true);
      // Everything the client keeps about its own character is resent on (re)entry.
      sim.invDirty.add(player); sim.skillDirty.add(player); sim.craftDirty.add(player);
      send(p, { op: S2C.Landed, sector: sectorOfTile(site.x, site.y), x: site.x, y: site.y, tick: sim.tick, fresh: site.fresh });
      return;
    }
    case C2S.Leave: setPresent(p, false); return;
    case C2S.Ping: send(p, { op: S2C.Pong, t: m.t }); return;
    case C2S.Hello: return;
  }
  if (!p.present) return;
  switch (m.op) {
    case C2S.Input: sim.pushInput(player, m.seq, m.dx, m.dy); break;
    case C2S.MoveTo: sim.enqueue({ type: 'moveTo', player, x: m.x, y: m.y }); break;
    case C2S.Interact: sim.enqueue({ type: 'interact', player, target: m.target }); break;
    case C2S.Build: sim.enqueue({ type: 'build', player, kind: m.kind, tx: m.tx, ty: m.ty }); break;
    case C2S.InvMove: sim.enqueue({ type: 'invMove', player, uid: m.uid, c: m.c, x: m.x, y: m.y, rot: m.rot }); break;
    case C2S.InvDrop: sim.enqueue({ type: 'invDrop', player, uid: m.uid }); break;
    case C2S.InvUse: sim.enqueue({ type: 'invUse', player, uid: m.uid }); break;
    case C2S.CraftStart: sim.enqueue({ type: 'craftStart', player, pattern: m.pattern }); break;
    case C2S.CraftHit: sim.enqueue({ type: 'craftHit', player, x: m.x, y: m.y }); break;
    case C2S.CraftCancel: sim.enqueue({ type: 'craftCancel', player }); break;
    case C2S.Recipe: sim.enqueue({ type: 'recipe', player, recipe: m.recipe, station: m.station }); break;
    case C2S.Order: sim.enqueue({ type: 'order', player, npc: m.npc, order: m.order }); break;
    case C2S.Drink: sim.enqueue({ type: 'drink', player }); break;
    case C2S.Trade: sim.enqueue({ type: 'trade', player, building: m.building, item: m.item, qty: m.qty, sell: m.sell }); break;
    case C2S.Contract: sim.enqueue({ type: 'contract', player, building: m.building, id: m.id, deliver: m.deliver }); break;
    case C2S.VillageInfo: {
      // A read-only query, answered straight away rather than queued behind the tick.
      const info = sim.villages.info(player, m.building);
      if (info) send(p, { op: S2C.Village, info });
      break;
    }
  }
}

function hello(ws: WebSocket, token: string, rawName: string): Player | null {
  if (token.length < 8) return null;
  const name = rawName.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 16) || 'Colonist';
  let p = playersByToken.get(token);
  if (!p) {
    p = { id: nextPlayerId++, token, name, present: false, ws: null, repl: new Replicator() };
    players.set(p.id, p);
    playersByToken.set(token, p);
  } else if (p.ws && p.ws !== ws) {
    p.ws.close(4000, 'superseded by a newer connection');
  }
  p.ws = ws;
  p.name = name;
  setPresent(p, false);
  send(p, { op: S2C.Welcome, playerId: p.id, seed: SEED, tickRate: TICK_RATE, homeSector: homeSector(p) });
  send(p, sectorStats());
  return p;
}

// --- simulation loop --------------------------------------------------------

function tick(): void {
  sim.step();
  if (sim.tick % SNAPSHOT_EVERY === 0) {
    for (const p of players.values()) {
      if (!p.present || p.ws?.readyState !== WebSocket.OPEN) continue;
      // A stalled socket gets no new snapshots until it drains; state is delta-encoded, so it catches up.
      if (p.ws.bufferedAmount > 1 << 20) continue;
      const centre = sim.viewCenter(p.id);
      if (!centre) continue;
      const hero = sim.heroes.get(p.id);
      p.ws.send(p.repl.build(source, sim.grid.chunkX(centre.x), sim.grid.chunkY(centre.y), AOI_RADIUS, hero !== undefined ? [hero] : []));
      const self = sim.selfState(p.id);
      if (self) send(p, { op: S2C.Self, self });
      if (hero === undefined) continue;
      if (sim.invDirty.delete(p.id)) send(p, { op: S2C.Inventory, items: sim.world.get(hero, Inv)!.items });
      if (sim.skillDirty.delete(p.id)) send(p, { op: S2C.Skills, xp: sim.world.get(hero, Char)!.skills });
      if (sim.craftDirty.delete(p.id)) send(p, { op: S2C.Craft, session: sim.world.get(hero, Char)!.craft });
    }
    for (const n of sim.notices) {
      const p = players.get(n.player);
      if (p) send(p, { op: S2C.Notice, text: n.text });
    }
    sim.notices.length = 0;
  }
  if (sim.tick % TICK_RATE === 0) {
    const stats = encodeServer(sectorStats());
    for (const p of players.values()) if (p.ws?.readyState === WebSocket.OPEN) p.ws.send(stats);
  }
}

const loop = new TickLoop(TICK_RATE, tick);

// --- HTTP + WebSocket front end ---------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
};

const http = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      tick: sim.tick, avgTickMs: Number(loop.avgTickMs.toFixed(3)), entities: sim.world.entityCount,
      players: [...players.values()].filter((p) => p.ws).length,
    }));
    return;
  }
  // Resolve inside the client bundle only; anything else falls back to the app shell.
  let file = normalize(join(CLIENT_DIR, path));
  if (!file.startsWith(CLIENT_DIR) || !existsSync(file) || statSync(file).isDirectory()) file = join(CLIENT_DIR, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('Client bundle missing. Run "npm run build" first.');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
});

// Snapshots near a village carry many records: compress the big ones, leave small packets alone.
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 2048, perMessageDeflate: { threshold: 512 } });


wss.on('connection', (ws) => {
  let player: Player | null = null;
  let budget = MAX_MSGS_PER_SEC, budgetAt = Date.now();

  ws.on('message', (raw: Buffer, isBinary: boolean) => {
    const now = Date.now();
    if (now - budgetAt >= 1000) { budget = MAX_MSGS_PER_SEC; budgetAt = now; }
    if (!isBinary || --budget < 0) return;
    let msg: ClientMsg;
    try {
      msg = decodeClient(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    } catch {
      ws.close(1003, 'malformed packet');
      return;
    }
    if (msg.op === C2S.Hello) {
      player = hello(ws, msg.token, msg.name);
      if (!player) ws.close(1008, 'bad hello');
    } else if (player) handle(player, msg);
  });

  ws.on('close', () => {
    if (!player || player.ws !== ws) return;
    player.ws = null;
    setPresent(player, false);
  });
  ws.on('error', () => ws.close());
});

http.listen(PORT, () => {
  loop.start();
  console.log('[server] world seed ' + SEED + ', ' + TICK_RATE + ' Hz, listening on http://localhost:' + PORT);
});

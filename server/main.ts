import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { TickLoop } from '../core-ecs/tick';
import { AOI_RADIUS, Net, SNAPSHOT_EVERY, TICK_RATE, describeEntity, SectorSim } from '../game-sim';
import { C2S, decodeClient, encodeServer, Replicator, S2C, type ClientMsg, type ReplicationSource, type ServerMsg } from '../network';
import { SECTOR_COUNT, sectorInfo } from '../world-gen/planet';
import { CHUNK_SIZE, SECTOR_SIZE } from '../world-gen/sector';

/**
 * Authoritative game server.
 *
 * One HTTP listener serves the built web client and upgrades /ws to the binary
 * game socket. All gameplay runs here at a fixed 20 Hz; clients only send
 * orders and receive area-of-interest snapshots.
 *
 * World state lives in memory for the lifetime of the process: colonies
 * persist across disconnects and keep working while their owner is away, but
 * not across a server restart.
 */

const PORT = Number(process.env.PORT ?? 8080);
const SEED = Number(process.env.WORLD_SEED ?? 20451) >>> 0;
const CLIENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../client');
const CHUNKS_PER_SIDE = SECTOR_SIZE / CHUNK_SIZE;
/** Per-connection inbound budget; orders beyond it are dropped. */
const MAX_MSGS_PER_SEC = 80;

interface Player {
  id: number;
  token: string;
  name: string;
  /** Sector holding this player's colony, or -1 before the first landing. */
  home: number;
  /** Sector currently being viewed on the surface, or -1 while in orbit. */
  present: number;
  ws: WebSocket | null;
  viewCx: number;
  viewCy: number;
  repl: Replicator;
}

const players = new Map<number, Player>();
const playersByToken = new Map<string, Player>();
const sectors = new Map<number, { sim: SectorSim; source: ReplicationSource }>();
let nextPlayerId = 1;
let serverTick = 0;

function send(p: Player, m: ServerMsg): void {
  if (p.ws?.readyState === WebSocket.OPEN) p.ws.send(encodeServer(m));
}

function getSector(id: number) {
  let s = sectors.get(id);
  if (!s) {
    const sim = new SectorSim(SEED, id, sectorInfo(SEED, id).biome);
    const source: ReplicationSource = {
      grid: sim.grid,
      get tick() { return sim.tick; },
      version: (e) => sim.world.get(e, Net)?.version ?? 0,
      moveTick: (e) => sim.world.get(e, Net)?.moveTick ?? 0,
      describe: (e) => describeEntity(sim.world, e),
    };
    s = { sim, source };
    sectors.set(id, s);
    console.log('[sector] instantiated ' + sectorInfo(SEED, id).name + ' with ' + sim.world.entityCount + ' entities');
  }
  return s;
}

function sectorStats(): ServerMsg {
  const online = new Map<number, number>();
  for (const p of players.values()) if (p.ws && p.present >= 0) online.set(p.present, (online.get(p.present) ?? 0) + 1);
  return {
    op: S2C.SectorStats,
    sectors: [...sectors.entries()].map(([sector, s]) => ({ sector, online: online.get(sector) ?? 0, colonies: s.sim.pods.size })),
  };
}

function sendRoster(sector: number): void {
  const colonists = [...players.values()].filter((p) => p.home === sector);
  const msg: ServerMsg = {
    op: S2C.Roster,
    players: colonists.map((p) => ({ id: p.id, name: p.name, online: !!p.ws && p.present === sector })),
  };
  for (const p of players.values()) if (p.present === sector) send(p, msg);
}

function leaveSurface(p: Player): void {
  const was = p.present;
  p.present = -1;
  if (was >= 0) sendRoster(was);
}

function handle(p: Player, m: ClientMsg): void {
  switch (m.op) {
    case C2S.Land: {
      // One colony per player: landing anywhere else returns you to it.
      const target = p.home >= 0 ? p.home : m.sector;
      if (target >= SECTOR_COUNT || !sectorInfo(SEED, target).landable) {
        send(p, { op: S2C.Notice, text: 'Sector is not landable' });
        return;
      }
      const { sim } = getSector(target);
      const site = sim.landPlayer(p.id, p.name);
      p.home = target;
      p.present = target;
      p.viewCx = Math.floor(site.x / CHUNK_SIZE);
      p.viewCy = Math.floor(site.y / CHUNK_SIZE);
      p.repl.reset();
      send(p, { op: S2C.Landed, sector: target, x: site.x, y: site.y, tick: sim.tick, fresh: site.fresh });
      sendRoster(target);
      return;
    }
    case C2S.Leave: leaveSurface(p); return;
    case C2S.View:
      p.viewCx = Math.min(CHUNKS_PER_SIDE - 1, m.cx);
      p.viewCy = Math.min(CHUNKS_PER_SIDE - 1, m.cy);
      return;
    case C2S.Ping: send(p, { op: S2C.Pong, t: m.t }); return;
    case C2S.Move: case C2S.Interact: case C2S.Build: {
      if (p.present < 0) return;
      const { sim } = getSector(p.present);
      if (m.op === C2S.Move) sim.enqueue({ type: 'move', player: p.id, units: m.units, x: m.x, y: m.y });
      else if (m.op === C2S.Interact) sim.enqueue({ type: 'interact', player: p.id, units: m.units, target: m.target });
      else sim.enqueue({ type: 'build', player: p.id, units: m.units, kind: m.kind, tx: m.tx, ty: m.ty });
      return;
    }
    case C2S.Hello: return;
  }
}

function hello(ws: WebSocket, token: string, rawName: string): Player | null {
  if (token.length < 8) return null;
  const name = rawName.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 16) || 'Colonist';
  let p = playersByToken.get(token);
  if (!p) {
    p = { id: nextPlayerId++, token, name, home: -1, present: -1, ws: null, viewCx: 0, viewCy: 0, repl: new Replicator() };
    players.set(p.id, p);
    playersByToken.set(token, p);
  } else if (p.ws && p.ws !== ws) {
    p.ws.close(4000, 'superseded by a newer connection');
  }
  p.ws = ws;
  p.name = name;
  p.present = -1;
  send(p, { op: S2C.Welcome, playerId: p.id, seed: SEED, tickRate: TICK_RATE, homeSector: p.home });
  send(p, sectorStats());
  return p;
}

// --- simulation loop --------------------------------------------------------

function tick(): void {
  serverTick++;
  for (const { sim } of sectors.values()) sim.step();

  if (serverTick % SNAPSHOT_EVERY === 0) {
    for (const p of players.values()) {
      if (!p.ws || p.present < 0 || p.ws.readyState !== WebSocket.OPEN) continue;
      // A stalled socket gets no new snapshots until it drains; state is delta-encoded, so it catches up.
      if (p.ws.bufferedAmount > 1 << 20) continue;
      const { sim, source } = sectors.get(p.present)!;
      p.ws.send(p.repl.build(source, p.viewCx, p.viewCy, AOI_RADIUS, sim.unitsOf.get(p.id) ?? []));
    }
    for (const { sim } of sectors.values()) {
      for (const id of sim.stockDirty) {
        const p = players.get(id), stock = sim.stock.get(id);
        if (p && stock && p.present === sim.sectorId) send(p, { op: S2C.Stock, ...stock });
      }
      sim.stockDirty.clear();
      for (const n of sim.notices) {
        const p = players.get(n.player);
        if (p) send(p, { op: S2C.Notice, text: n.text });
      }
      sim.notices.length = 0;
    }
  }
  if (serverTick % TICK_RATE === 0) {
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
      tick: serverTick, avgTickMs: Number(loop.avgTickMs.toFixed(3)), sectors: sectors.size,
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

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 2048 });

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
    leaveSurface(player);
  });
  ws.on('error', () => ws.close());
});

http.listen(PORT, () => {
  loop.start();
  console.log('[server] world seed ' + SEED + ', ' + TICK_RATE + ' Hz, listening on http://localhost:' + PORT);
});

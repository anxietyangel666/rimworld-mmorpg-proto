import { EntityKind, type Order } from '../game-sim/components';
import type { CraftSession } from '../game-sim/components';
import type { ItemInst } from '../game-sim/inventory';
import { PATTERN_SIZE, SKILL_COUNT, type StructureKind } from '../game-sim/items';
import type { EntityState } from '../game-sim/view';
import type { SelfState } from '../game-sim/worldSim';
import { ByteReader, ByteWriter } from './bytes';

/**
 * Wire protocol. Each packet is one opcode byte followed by a fixed layout.
 * World positions are 10.6 fixed point in a u16 (the world is 1024 tiles wide),
 * angles are one byte, so a moving unit costs 9 bytes per snapshot.
 */

export enum C2S {
  Hello = 1, Land, Leave, Input, MoveTo, Interact, Build, InvMove, InvDrop, InvUse,
  CraftStart, CraftHit, CraftCancel, Recipe, Order, Drink, Ping,
}
export enum S2C { Welcome = 64, SectorStats, Landed, Snapshot, Self, Inventory, Skills, Craft, Pong, Notice, Roster }

export type ClientMsg =
  | { op: C2S.Hello; token: string; name: string }
  | { op: C2S.Land; sector: number }
  | { op: C2S.Leave }
  /** One simulation tick of direct movement; dx, dy are a direction scaled to -127..127. */
  | { op: C2S.Input; seq: number; dx: number; dy: number }
  | { op: C2S.MoveTo; x: number; y: number }
  | { op: C2S.Interact; target: number }
  | { op: C2S.Build; kind: StructureKind; tx: number; ty: number }
  | { op: C2S.InvMove; uid: number; c: number; x: number; y: number; rot: number }
  | { op: C2S.InvDrop; uid: number }
  | { op: C2S.InvUse; uid: number }
  | { op: C2S.CraftStart; pattern: number }
  | { op: C2S.CraftHit; x: number; y: number }
  | { op: C2S.CraftCancel }
  /** station is the entity id of the structure being worked at, or 0 for handwork. */
  | { op: C2S.Recipe; recipe: number; station: number }
  | { op: C2S.Order; npc: number; order: Order }
  | { op: C2S.Drink }
  | { op: C2S.Ping; t: number };

export interface MoveUpdate { id: number; x: number; y: number; facing: number }

export type ServerMsg =
  | { op: S2C.Welcome; playerId: number; seed: number; tickRate: number; homeSector: number }
  | { op: S2C.SectorStats; sectors: { sector: number; online: number; colonies: number }[] }
  | { op: S2C.Landed; sector: number; x: number; y: number; tick: number; fresh: boolean }
  | { op: S2C.Snapshot; tick: number; full: EntityState[]; moves: MoveUpdate[]; gone: number[] }
  | { op: S2C.Self; self: SelfState }
  | { op: S2C.Inventory; items: ItemInst[] }
  | { op: S2C.Skills; xp: number[] }
  | { op: S2C.Craft; session: CraftSession | null }
  | { op: S2C.Pong; t: number }
  | { op: S2C.Notice; text: string }
  | { op: S2C.Roster; players: { id: number; name: string }[] };

const TAU = Math.PI * 2;
const POS_SCALE = 64;

const qPos = (v: number) => Math.min(65535, Math.max(0, Math.round(v * POS_SCALE)));
const qAngle = (a: number) => Math.round((((a % TAU) + TAU) % TAU) / TAU * 256) & 255;
const dAngle = (b: number) => (b / 256) * TAU;
const q8 = (v: number) => Math.min(255, Math.max(0, Math.round(v)));

export function encodeClient(m: ClientMsg): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter(32).u8(m.op);
  switch (m.op) {
    case C2S.Hello: w.str(m.token).str(m.name); break;
    case C2S.Land: w.u16(m.sector); break;
    case C2S.Input: w.u32(m.seq).i8(m.dx).i8(m.dy); break;
    case C2S.MoveTo: w.u16(qPos(m.x)).u16(qPos(m.y)); break;
    case C2S.Interact: w.u32(m.target); break;
    case C2S.Build: w.u8(m.kind).u16(m.tx).u16(m.ty); break;
    case C2S.InvMove: w.u16(m.uid).u8(m.c).u8(m.x).u8(m.y).u8(m.rot); break;
    case C2S.InvDrop: case C2S.InvUse: w.u16(m.uid); break;
    case C2S.CraftStart: w.u8(m.pattern); break;
    case C2S.CraftHit: w.u8(m.x).u8(m.y); break;
    case C2S.Recipe: w.u8(m.recipe).u32(m.station); break;
    case C2S.Order: w.u32(m.npc).u8(m.order); break;
    case C2S.Ping: w.f64(m.t); break;
    case C2S.Leave: case C2S.CraftCancel: case C2S.Drink: break;
  }
  return w.finish();
}

export function decodeClient(data: Uint8Array): ClientMsg {
  const r = new ByteReader(data);
  const op = r.u8() as C2S;
  switch (op) {
    case C2S.Hello: return { op, token: r.str(), name: r.str() };
    case C2S.Land: return { op, sector: r.u16() };
    case C2S.Input: return { op, seq: r.u32(), dx: r.i8(), dy: r.i8() };
    case C2S.MoveTo: return { op, x: r.u16() / POS_SCALE, y: r.u16() / POS_SCALE };
    case C2S.Interact: return { op, target: r.u32() };
    case C2S.Build: return { op, kind: r.u8(), tx: r.u16(), ty: r.u16() };
    case C2S.InvMove: return { op, uid: r.u16(), c: r.u8(), x: r.u8(), y: r.u8(), rot: r.u8() };
    case C2S.InvDrop: case C2S.InvUse: return { op, uid: r.u16() };
    case C2S.CraftStart: return { op, pattern: r.u8() };
    case C2S.CraftHit: return { op, x: r.u8(), y: r.u8() };
    case C2S.Recipe: return { op, recipe: r.u8(), station: r.u32() };
    case C2S.Order: return { op, npc: r.u32(), order: r.u8() };
    case C2S.Ping: return { op, t: r.f64() };
    case C2S.Leave: case C2S.CraftCancel: case C2S.Drink: return { op };
    default: throw new RangeError('unknown client opcode ' + op);
  }
}

export function writeEntityFull(w: ByteWriter, s: EntityState): void {
  w.u32(s.id).u8(s.kind).u16(qPos(s.x)).u16(qPos(s.y));
  if (s.unit) {
    const u = s.unit;
    const n = Math.min(255, u.path.length >> 1);
    w.u16(u.owner).u8(q8(u.hp)).u8(u.maxHp).u8(u.state).u8(qAngle(u.facing)).u8((u.hero ? 1 : 0) | (u.order << 1)).str(u.name).u8(n);
    for (let i = 0; i < n * 2; i++) w.u16(qPos(u.path[i]));
  } else if (s.node) w.u8(s.node.kind).u8(s.node.amount);
  else if (s.structure) w.u8(s.structure.kind).u16(s.structure.owner).u8(s.structure.progress).u8((s.structure.built ? 1 : 0) | (s.structure.crop << 1));
  else if (s.pod) w.u16(s.pod.owner).u32(s.pod.spawnTick).u8(s.pod.deployed ? 1 : 0);
  else if (s.pile) w.u8(s.pile.item).u8(q8(s.pile.qty));
}

function readEntityFull(r: ByteReader): EntityState {
  const s: EntityState = { id: r.u32(), kind: r.u8(), x: r.u16() / POS_SCALE, y: r.u16() / POS_SCALE };
  switch (s.kind) {
    case EntityKind.Unit: {
      const owner = r.u16(), hp = r.u8(), maxHp = r.u8(), state = r.u8(), facing = dAngle(r.u8()), flags = r.u8(), name = r.str();
      const path: number[] = [];
      for (let i = 0, n = r.u8() * 2; i < n; i++) path.push(r.u16() / POS_SCALE);
      s.unit = { owner, hp, maxHp, state, facing, hero: (flags & 1) === 1, order: flags >> 1, name, path };
      break;
    }
    case EntityKind.Node: s.node = { kind: r.u8(), amount: r.u8() }; break;
    case EntityKind.Structure: {
      const kind = r.u8(), owner = r.u16(), progress = r.u8(), flags = r.u8();
      s.structure = { kind, owner, progress, built: (flags & 1) === 1, crop: flags >> 1 };
      break;
    }
    case EntityKind.Pod: s.pod = { owner: r.u16(), spawnTick: r.u32(), deployed: r.u8() === 1 }; break;
    case EntityKind.Pile: s.pile = { item: r.u8(), qty: r.u8() }; break;
    default: throw new RangeError('unknown entity kind ' + s.kind);
  }
  return s;
}

export function writeEntityMove(w: ByteWriter, m: MoveUpdate): void {
  w.u32(m.id).u16(qPos(m.x)).u16(qPos(m.y)).u8(qAngle(m.facing));
}

export function encodeServer(m: ServerMsg): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter(64).u8(m.op);
  switch (m.op) {
    case S2C.Welcome: w.u16(m.playerId).u32(m.seed).u8(m.tickRate).i16(m.homeSector); break;
    case S2C.SectorStats:
      w.u16(m.sectors.length);
      for (const s of m.sectors) w.u16(s.sector).u8(q8(s.online)).u8(q8(s.colonies));
      break;
    case S2C.Landed: w.u16(m.sector).u16(qPos(m.x)).u16(qPos(m.y)).u32(m.tick).u8(m.fresh ? 1 : 0); break;
    case S2C.Snapshot:
      w.u32(m.tick).u16(m.full.length);
      for (const e of m.full) writeEntityFull(w, e);
      w.u16(m.moves.length);
      for (const mv of m.moves) writeEntityMove(w, mv);
      w.u16(m.gone.length);
      for (const id of m.gone) w.u32(id);
      break;
    case S2C.Self: {
      const s = m.self;
      // Own position is sent at full precision: the client replays predicted inputs on top of it.
      w.u32(s.ack).f32(s.x).f32(s.y).u8(q8(s.hp)).u8(q8(s.satiety)).u8(q8(s.hydration)).u8(q8(s.stamina))
        .u16(Math.round(s.temp * 10)).u16(s.status).u16(Math.round(s.kg * 10)).u16(Math.round(s.capacity * 10))
        .u8(s.tier).u8(q8(s.work)).i8(Math.max(-127, Math.min(127, Math.round(s.ambient))));
      break;
    }
    case S2C.Inventory:
      w.u8(m.items.length);
      for (const i of m.items) w.u16(i.uid).u8(i.def).u8(i.qty).u16(i.dur).u8(i.c).u8(i.x).u8(i.y).u8(i.rot);
      break;
    case S2C.Skills: for (let i = 0; i < SKILL_COUNT; i++) w.u32(Math.floor(m.xp[i] ?? 0)); break;
    case S2C.Craft:
      w.u8(m.session ? 1 : 0);
      if (m.session) {
        w.u8(m.session.pattern).i8(m.session.mistakes);
        for (let i = 0; i < PATTERN_SIZE; i++) w.u8(m.session.cells[i]);
      }
      break;
    case S2C.Pong: w.f64(m.t); break;
    case S2C.Notice: w.str(m.text); break;
    case S2C.Roster:
      w.u8(m.players.length);
      for (const p of m.players) w.u16(p.id).str(p.name);
      break;
  }
  return w.finish();
}

export function decodeServer(data: Uint8Array): ServerMsg {
  const r = new ByteReader(data);
  const op = r.u8() as S2C;
  switch (op) {
    case S2C.Welcome: return { op, playerId: r.u16(), seed: r.u32(), tickRate: r.u8(), homeSector: r.i16() };
    case S2C.SectorStats: {
      const sectors = [];
      for (let i = 0, n = r.u16(); i < n; i++) sectors.push({ sector: r.u16(), online: r.u8(), colonies: r.u8() });
      return { op, sectors };
    }
    case S2C.Landed: return { op, sector: r.u16(), x: r.u16() / POS_SCALE, y: r.u16() / POS_SCALE, tick: r.u32(), fresh: r.u8() === 1 };
    case S2C.Snapshot: {
      const tick = r.u32();
      const full: EntityState[] = [], moves: MoveUpdate[] = [], gone: number[] = [];
      for (let i = 0, n = r.u16(); i < n; i++) full.push(readEntityFull(r));
      for (let i = 0, n = r.u16(); i < n; i++) moves.push({ id: r.u32(), x: r.u16() / POS_SCALE, y: r.u16() / POS_SCALE, facing: dAngle(r.u8()) });
      for (let i = 0, n = r.u16(); i < n; i++) gone.push(r.u32());
      return { op, tick, full, moves, gone };
    }
    case S2C.Self:
      return {
        op, self: {
          ack: r.u32(), x: r.f32(), y: r.f32(), hp: r.u8(), satiety: r.u8(), hydration: r.u8(), stamina: r.u8(),
          temp: r.u16() / 10, status: r.u16(), kg: r.u16() / 10, capacity: r.u16() / 10, tier: r.u8(), work: r.u8(), ambient: r.i8(),
        },
      };
    case S2C.Inventory: {
      const items: ItemInst[] = [];
      for (let i = 0, n = r.u8(); i < n; i++) items.push({ uid: r.u16(), def: r.u8(), qty: r.u8(), dur: r.u16(), c: r.u8(), x: r.u8(), y: r.u8(), rot: r.u8() });
      return { op, items };
    }
    case S2C.Skills: {
      const xp: number[] = [];
      for (let i = 0; i < SKILL_COUNT; i++) xp.push(r.u32());
      return { op, xp };
    }
    case S2C.Craft: {
      if (r.u8() === 0) return { op, session: null };
      const pattern = r.u8(), mistakes = r.i8(), cells: number[] = [];
      for (let i = 0; i < PATTERN_SIZE; i++) cells.push(r.u8());
      return { op, session: { pattern, mistakes, cells } };
    }
    case S2C.Pong: return { op, t: r.f64() };
    case S2C.Notice: return { op, text: r.str() };
    case S2C.Roster: {
      const players = [];
      for (let i = 0, n = r.u8(); i < n; i++) players.push({ id: r.u16(), name: r.str() });
      return { op, players };
    }
    default: throw new RangeError('unknown server opcode ' + op);
  }
}

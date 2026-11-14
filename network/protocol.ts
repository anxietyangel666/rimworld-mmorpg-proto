import { EntityKind, type StructureKind } from '../game-sim/components';
import type { EntityState } from '../game-sim/view';
import { ByteReader, ByteWriter } from './bytes';

/**
 * Wire protocol. Each packet is one opcode byte followed by a fixed layout.
 * Positions are 8.8 fixed point in a u16 (sectors are 128 tiles wide), angles
 * are one byte, so a moving unit costs 9 bytes per snapshot.
 */

export enum C2S { Hello = 1, Land, Leave, View, Move, Interact, Build, Ping }
export enum S2C { Welcome = 64, SectorStats, Landed, Snapshot, Stock, Pong, Notice, Roster }

export type ClientMsg =
  | { op: C2S.Hello; token: string; name: string }
  | { op: C2S.Land; sector: number }
  | { op: C2S.Leave }
  /** Chunk the camera is centred on; drives the area of interest. */
  | { op: C2S.View; cx: number; cy: number }
  | { op: C2S.Move; units: number[]; x: number; y: number }
  | { op: C2S.Interact; units: number[]; target: number }
  | { op: C2S.Build; units: number[]; kind: StructureKind; tx: number; ty: number }
  | { op: C2S.Ping; t: number };

export interface MoveUpdate { id: number; x: number; y: number; facing: number }

export type ServerMsg =
  | { op: S2C.Welcome; playerId: number; seed: number; tickRate: number; homeSector: number }
  | { op: S2C.SectorStats; sectors: { sector: number; online: number; colonies: number }[] }
  | { op: S2C.Landed; sector: number; x: number; y: number; tick: number; fresh: boolean }
  | { op: S2C.Snapshot; tick: number; full: EntityState[]; moves: MoveUpdate[]; gone: number[] }
  | { op: S2C.Stock; wood: number; ore: number; scrap: number }
  | { op: S2C.Pong; t: number }
  | { op: S2C.Notice; text: string }
  | { op: S2C.Roster; players: { id: number; name: string; online: boolean }[] };

const MAX_UNITS_PER_ORDER = 64;
const TAU = Math.PI * 2;

const qPos = (v: number) => Math.min(65535, Math.max(0, Math.round(v * 256)));
const qAngle = (a: number) => Math.round((((a % TAU) + TAU) % TAU) / TAU * 256) & 255;
const dAngle = (b: number) => (b / 256) * TAU;

function writeIds(w: ByteWriter, ids: number[]): void {
  const n = Math.min(ids.length, MAX_UNITS_PER_ORDER);
  w.u8(n);
  for (let i = 0; i < n; i++) w.u32(ids[i]);
}

function readIds(r: ByteReader): number[] {
  const n = Math.min(r.u8(), MAX_UNITS_PER_ORDER);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(r.u32());
  return ids;
}

export function encodeClient(m: ClientMsg): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter(32).u8(m.op);
  switch (m.op) {
    case C2S.Hello: w.str(m.token).str(m.name); break;
    case C2S.Land: w.u16(m.sector); break;
    case C2S.Leave: break;
    case C2S.View: w.u8(m.cx).u8(m.cy); break;
    case C2S.Move: w.u16(qPos(m.x)).u16(qPos(m.y)); writeIds(w, m.units); break;
    case C2S.Interact: w.u32(m.target); writeIds(w, m.units); break;
    case C2S.Build: w.u8(m.kind).u8(m.tx).u8(m.ty); writeIds(w, m.units); break;
    case C2S.Ping: w.f64(m.t); break;
  }
  return w.finish();
}

export function decodeClient(data: Uint8Array): ClientMsg {
  const r = new ByteReader(data);
  const op = r.u8() as C2S;
  switch (op) {
    case C2S.Hello: return { op, token: r.str(), name: r.str() };
    case C2S.Land: return { op, sector: r.u16() };
    case C2S.Leave: return { op };
    case C2S.View: return { op, cx: r.u8(), cy: r.u8() };
    case C2S.Move: { const x = r.u16() / 256, y = r.u16() / 256; return { op, x, y, units: readIds(r) }; }
    case C2S.Interact: { const target = r.u32(); return { op, target, units: readIds(r) }; }
    case C2S.Build: { const kind = r.u8(), tx = r.u8(), ty = r.u8(); return { op, kind, tx, ty, units: readIds(r) }; }
    case C2S.Ping: return { op, t: r.f64() };
    default: throw new RangeError('unknown client opcode ' + op);
  }
}

export function writeEntityFull(w: ByteWriter, s: EntityState): void {
  w.u32(s.id).u8(s.kind).u16(qPos(s.x)).u16(qPos(s.y));
  if (s.unit) {
    const u = s.unit;
    const n = Math.min(255, u.path.length >> 1);
    w.u16(u.owner).u8(u.hp).u8(u.maxHp).u8(u.state).u8(qAngle(u.facing)).str(u.name).u8(n);
    for (let i = 0; i < n * 2; i++) w.u16(qPos(u.path[i]));
  } else if (s.node) {
    w.u8(s.node.kind).u8(s.node.amount);
  } else if (s.structure) {
    w.u8(s.structure.kind).u16(s.structure.owner).u8(s.structure.progress).u8(s.structure.built ? 1 : 0);
  } else if (s.pod) {
    w.u16(s.pod.owner).u32(s.pod.spawnTick).u8(s.pod.deployed ? 1 : 0);
  }
}

function readEntityFull(r: ByteReader): EntityState {
  const s: EntityState = { id: r.u32(), kind: r.u8(), x: r.u16() / 256, y: r.u16() / 256 };
  switch (s.kind) {
    case EntityKind.Unit: {
      const owner = r.u16(), hp = r.u8(), maxHp = r.u8(), state = r.u8(), facing = dAngle(r.u8()), name = r.str();
      const path: number[] = [];
      for (let i = 0, n = r.u8() * 2; i < n; i++) path.push(r.u16() / 256);
      s.unit = { owner, hp, maxHp, state, facing, name, path };
      break;
    }
    case EntityKind.Node: s.node = { kind: r.u8(), amount: r.u8() }; break;
    case EntityKind.Structure: s.structure = { kind: r.u8(), owner: r.u16(), progress: r.u8(), built: r.u8() === 1 }; break;
    case EntityKind.Pod: s.pod = { owner: r.u16(), spawnTick: r.u32(), deployed: r.u8() === 1 }; break;
    default: throw new RangeError('unknown entity kind ' + s.kind);
  }
  return s;
}

export function writeEntityMove(w: ByteWriter, m: MoveUpdate): void {
  w.u32(m.id).u16(qPos(m.x)).u16(qPos(m.y)).u8(qAngle(m.facing));
}

export function encodeServer(m: ServerMsg): Uint8Array {
  const w = new ByteWriter(64).u8(m.op);
  switch (m.op) {
    case S2C.Welcome: w.u16(m.playerId).u32(m.seed).u8(m.tickRate).i16(m.homeSector); break;
    case S2C.SectorStats:
      w.u16(m.sectors.length);
      for (const s of m.sectors) w.u16(s.sector).u8(Math.min(255, s.online)).u8(Math.min(255, s.colonies));
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
    case S2C.Stock: w.u16(m.wood).u16(m.ore).u16(m.scrap); break;
    case S2C.Pong: w.f64(m.t); break;
    case S2C.Notice: w.str(m.text); break;
    case S2C.Roster:
      w.u8(m.players.length);
      for (const p of m.players) w.u16(p.id).str(p.name).u8(p.online ? 1 : 0);
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
    case S2C.Landed: return { op, sector: r.u16(), x: r.u16() / 256, y: r.u16() / 256, tick: r.u32(), fresh: r.u8() === 1 };
    case S2C.Snapshot: {
      const tick = r.u32();
      const full: EntityState[] = [], moves: MoveUpdate[] = [], gone: number[] = [];
      for (let i = 0, n = r.u16(); i < n; i++) full.push(readEntityFull(r));
      for (let i = 0, n = r.u16(); i < n; i++) moves.push({ id: r.u32(), x: r.u16() / 256, y: r.u16() / 256, facing: dAngle(r.u8()) });
      for (let i = 0, n = r.u16(); i < n; i++) gone.push(r.u32());
      return { op, tick, full, moves, gone };
    }
    case S2C.Stock: return { op, wood: r.u16(), ore: r.u16(), scrap: r.u16() };
    case S2C.Pong: return { op, t: r.f64() };
    case S2C.Notice: return { op, text: r.str() };
    case S2C.Roster: {
      const players = [];
      for (let i = 0, n = r.u8(); i < n; i++) players.push({ id: r.u16(), name: r.str(), online: r.u8() === 1 });
      return { op, players };
    }
    default: throw new RangeError('unknown server opcode ' + op);
  }
}

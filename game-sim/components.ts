import { defineComponent, type Entity } from '../core-ecs/world';
import type { NodeKind } from '../world-gen/sector';

/** Simulation constants shared by server and client. */
export const TICK_RATE = 20;
/** One snapshot per this many ticks (10 Hz on the wire). */
export const SNAPSHOT_EVERY = 2;
/** Half-width, in chunks, of the square of chunks a client is sent. */
export const AOI_RADIUS = 3;
export const UNIT_SPEED = 3.4;
/** Ticks between a pod entering the sector and its crew stepping out. */
export const POD_DEPLOY_TICKS = 70;
export const HARVEST_INTERVAL = 2;
export const HARVEST_YIELD = 4;
/** Build progress per second per worker, out of 100. */
export const BUILD_RATE = 28;
export const STARTING_UNITS = 3;

export enum EntityKind { Unit = 1, Node = 2, Structure = 3, Pod = 4 }
export enum UnitState { Idle, Moving, Harvesting, Building }
export enum StructureKind { Wall, Floor, Beacon }

export interface Stock { wood: number; ore: number; scrap: number }

export const STARTING_STOCK: Stock = { wood: 24, ore: 12, scrap: 8 };

export const STRUCTURES: Record<StructureKind, { name: string; cost: Stock; blocks: boolean }> = {
  [StructureKind.Wall]: { name: 'Wall', cost: { wood: 4, ore: 0, scrap: 0 }, blocks: true },
  [StructureKind.Floor]: { name: 'Floor Plate', cost: { wood: 0, ore: 2, scrap: 0 }, blocks: false },
  [StructureKind.Beacon]: { name: 'Beacon', cost: { wood: 0, ore: 6, scrap: 4 }, blocks: true },
};

/** Which stock a node kind feeds. */
export const NODE_YIELDS: Record<NodeKind, keyof Stock> = { 0: 'wood', 1: 'ore', 2: 'scrap' };

export interface PositionData { x: number; y: number }
export interface NetData {
  kind: EntityKind;
  /** Bumped on any replicated change other than position. */
  version: number;
  /** Last tick the position changed. */
  moveTick: number;
}
export interface UnitData { owner: number; name: string; hp: number; maxHp: number; state: UnitState; facing: number }
export interface PathData {
  /** Flat [x0, y0, x1, y1, ...] waypoints. */
  pts: number[];
  /** Index of the waypoint currently being walked to. */
  idx: number;
}
export interface JobData {
  target: Entity;
  timer: number;
  /** Node kind being gathered, or null for construction; lets a worker pick up similar work when its target goes away. */
  harvest: NodeKind | null;
}
export interface NodeData { kind: NodeKind; amount: number }
export interface StructureData { kind: StructureKind; owner: number; progress: number; built: boolean }
export interface PodData { owner: number; spawnTick: number; deployed: boolean }

export const Position = defineComponent<PositionData>('Position');
export const Net = defineComponent<NetData>('Net');
export const Unit = defineComponent<UnitData>('Unit');
export const Path = defineComponent<PathData>('Path');
export const Job = defineComponent<JobData>('Job');
export const Node = defineComponent<NodeData>('Node');
export const Structure = defineComponent<StructureData>('Structure');
export const Pod = defineComponent<PodData>('Pod');

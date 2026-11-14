import { defineComponent, type Entity } from '../core-ecs/world';
import type { NodeKind } from '../world-gen/surface';
import type { Vitals } from './character';
import type { Inventory } from './inventory';
import type { Item, PatternId, StructureKind } from './items';

/** Simulation constants shared by server and client. */
export const TICK_RATE = 20;
/** One snapshot per this many ticks (10 Hz on the wire). */
export const SNAPSHOT_EVERY = 2;
/** Half-width, in chunks, of the square of chunks a client is sent. */
export const AOI_RADIUS = 3;
export const NPC_SPEED = 3.1;
/** Ticks between a pod entering the sky and its passenger stepping out. */
export const POD_DEPLOY_TICKS = 70;
/** Build progress per second at carpentry level 0, out of 100. */
export const BUILD_RATE = 22;
/** Food a drifter asks for before joining. */
export const RECRUIT_BERRIES = 3;
/** Radius around a site or station within which materials lying on the ground count as available. */
export const SITE_RADIUS = 4;
/** Seconds for a planted crop to sprout, then to ripen. */
export const CROP_SPROUT = 40;
export const CROP_RIPE = 90;

export enum EntityKind { Unit = 1, Node = 2, Structure = 3, Pod = 4, Pile = 5 }
export enum UnitState { Idle, Moving, Harvesting, Building, Crafting }
/** Standing orders a recruited follower carries out on their own. */
export enum Order { Follow, Stay, Wood, Stone, Forage, Build }
export const ORDER_NAMES = ['Follow me', 'Stay here', 'Fell timber', 'Quarry stone', 'Forage & farm', 'Build'];
export enum JobKind { Harvest, Build, Pickup, Craft, Recruit, Tend, Goto }
export enum CropStage { Empty, Sown, Sprout, Ripe }

export interface PositionData { x: number; y: number }
export interface NetData {
  kind: EntityKind;
  /** Bumped on any replicated change other than position. */
  version: number;
  /** Last tick the position changed. */
  moveTick: number;
}
export interface UnitData {
  /** Owning player, or 0 for an unaligned drifter. */
  owner: number;
  name: string;
  hp: number;
  maxHp: number;
  state: UnitState;
  facing: number;
  /** True for a player's own character; false for NPCs. */
  hero: boolean;
  /** 0..100 progress of the current timed task. */
  work: number;
}
export interface PathData {
  /** Flat [x0, y0, x1, y1, ...] waypoints. */
  pts: number[];
  idx: number;
}
export interface JobData {
  kind: JobKind;
  target: Entity;
  timer: number;
  /** Harvest: node kind, so the worker can move on to another of the same. */
  harvest: NodeKind | null;
  /** Craft: recipe index. */
  recipe: number;
}
/** Faction membership for an NPC: who they answer to and what they have been told to do. */
export interface FollowerData {
  leader: Entity;
  order: Order;
  /** Where the order was given; work is sought, and goods are stockpiled, around it. */
  ax: number;
  ay: number;
  hauling: boolean;
}
export interface CraftSession { pattern: PatternId; cells: number[]; mistakes: number }
/** Everything that makes a unit a full player character. */
export interface CharData {
  player: number;
  vitals: Vitals;
  skills: number[];
  craft: CraftSession | null;
  inputs: { seq: number; dx: number; dy: number }[];
  /** Sequence number of the last input applied. */
  ack: number;
  moved: boolean;
  drinkAt: number;
}
export interface NodeData { kind: NodeKind; amount: number }
export interface StructureData { kind: StructureKind; owner: number; progress: number; built: boolean; crop: CropStage; cropTimer: number }
export interface PodData { owner: number; spawnTick: number; deployed: boolean; sector: number }
export interface PileData { item: Item; qty: number; dur: number }

export const Position = defineComponent<PositionData>('Position');
export const Net = defineComponent<NetData>('Net');
export const Unit = defineComponent<UnitData>('Unit');
export const Path = defineComponent<PathData>('Path');
export const Job = defineComponent<JobData>('Job');
export const Inv = defineComponent<Inventory>('Inv');
export const Char = defineComponent<CharData>('Char');
export const Follower = defineComponent<FollowerData>('Follower');
export const Node = defineComponent<NodeData>('Node');
export const Structure = defineComponent<StructureData>('Structure');
export const Pod = defineComponent<PodData>('Pod');
export const Pile = defineComponent<PileData>('Pile');

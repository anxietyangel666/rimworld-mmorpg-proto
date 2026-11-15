import type { Entity, World } from '../core-ecs/world';
import type { NodeKind } from '../world-gen/surface';
import {
  Building, EntityKind, Follower, Net, Node, Order, Path, Pile, Pod, Position, Road, Structure, Unit, Villager, Wolf,
  type CropStage, type UnitState,
} from './components';
import type { Item, StructureKind } from './items';
import { WOLF } from './village';

/**
 * Flat, serialisable view of one entity: what the wire carries and what the
 * client mirrors. Exactly one of the kind-specific blocks is present.
 */
export interface EntityState {
  id: number;
  kind: EntityKind;
  x: number;
  y: number;
  unit?: {
    owner: number; name: string; hp: number; maxHp: number; state: UnitState; facing: number; hero: boolean; order: Order;
    /** Villager profession (Prof), WOLF for wildlife, 0 otherwise. */
    prof: number;
    /** Waypoints still ahead of the unit, flat [x, y, ...]. */
    path: number[];
  };
  node?: { kind: NodeKind; amount: number };
  structure?: { kind: StructureKind; owner: number; progress: number; built: boolean; crop: CropStage };
  pod?: { owner: number; spawnTick: number; deployed: boolean };
  pile?: { item: Item; qty: number };
  road?: { wide: boolean; pts: number[] };
  building?: { type: number; flip: boolean; built: boolean; progress: number; village: number };
}

export function describeEntity(world: World, e: Entity): EntityState {
  const pos = world.get(e, Position)!;
  const kind = world.get(e, Net)!.kind;
  const s: EntityState = { id: e, kind, x: pos.x, y: pos.y };
  switch (kind) {
    case EntityKind.Unit: {
      const u = world.get(e, Unit)!;
      const p = world.get(e, Path);
      s.unit = {
        owner: u.owner, name: u.name, hp: Math.max(0, Math.round(u.hp)), maxHp: u.maxHp, state: u.state, facing: u.facing, hero: u.hero,
        order: world.get(e, Follower)?.order ?? Order.Stay, prof: world.has(e, Wolf) ? WOLF : (world.get(e, Villager)?.prof ?? 0),
        path: p ? p.pts.slice(p.idx * 2) : [],
      };
      break;
    }
    case EntityKind.Node: {
      const n = world.get(e, Node);
      s.node = { kind: n?.kind ?? 0, amount: n?.amount ?? 0 };
      break;
    }
    case EntityKind.Structure: {
      const st = world.get(e, Structure)!;
      s.structure = { kind: st.kind, owner: st.owner, progress: Math.floor(st.progress), built: st.built, crop: st.crop };
      break;
    }
    case EntityKind.Pile: {
      const p = world.get(e, Pile);
      s.pile = { item: p?.item ?? 1, qty: p?.qty ?? 0 };
      break;
    }
    case EntityKind.Road: {
      const r = world.get(e, Road)!;
      s.road = { wide: r.wide, pts: r.pts };
      break;
    }
    case EntityKind.Building: {
      const b = world.get(e, Building)!;
      s.building = { type: b.type, flip: b.flip, built: b.built, progress: Math.floor(b.progress), village: b.village };
      break;
    }
    default: {
      const p = world.get(e, Pod)!;
      s.pod = { owner: p.owner, spawnTick: p.spawnTick, deployed: p.deployed };
    }
  }
  return s;
}

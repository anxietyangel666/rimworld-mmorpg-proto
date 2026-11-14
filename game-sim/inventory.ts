import { Item, ITEMS, Slot, type ToolType } from './items';

/**
 * Spatial ("Tetris") inventory. Items occupy a width x height block of cells in
 * a grid and may be rotated a quarter turn. A character has small base pockets
 * plus whatever grids the bags they wear unlock, and one paper-doll slot per
 * body part. Pure functions over plain data: the server uses them as the rules,
 * the client uses the same code to colour a placement before sending it.
 */

/** Where an item sits. For Equip, `x` is the Slot and `y` is unused. */
export enum Cont { Pockets, BeltGrid, PackGrid, Equip }
export const POCKETS: [number, number] = [4, 3];
const GRID_SLOT: Partial<Record<Cont, Slot>> = { [Cont.BeltGrid]: Slot.Belt, [Cont.PackGrid]: Slot.Back };
const GRIDS = [Cont.Pockets, Cont.BeltGrid, Cont.PackGrid];

export interface ItemInst {
  uid: number;
  def: Item;
  qty: number;
  /** Remaining durability or charges; 0 when not applicable. */
  dur: number;
  c: Cont;
  x: number;
  y: number;
  /** 1 when turned a quarter turn. */
  rot: number;
}

export interface Inventory { items: ItemInst[]; nextUid: number }

export const newInventory = (): Inventory => ({ items: [], nextUid: 1 });

export function footprint(def: Item, rot: number): [number, number] {
  const it = ITEMS[def];
  return rot ? [it.h, it.w] : [it.w, it.h];
}

export function equipped(inv: Inventory, slot: Slot): ItemInst | undefined {
  return inv.items.find((i) => i.c === Cont.Equip && i.x === slot);
}

/** Size of a storage grid, or null while the bag that provides it is not worn. */
export function gridSize(inv: Inventory, c: Cont): [number, number] | null {
  if (c === Cont.Pockets) return POCKETS;
  const slot = GRID_SLOT[c];
  if (slot === undefined) return null;
  const bag = equipped(inv, slot);
  return bag ? (ITEMS[bag.def].grid ?? null) : null;
}

/** Whether `def` fits at (x, y) in container `c`, ignoring the item `ignoreUid` (the one being moved). */
export function canPlace(inv: Inventory, def: Item, c: Cont, x: number, y: number, rot: number, ignoreUid = 0): boolean {
  if (c === Cont.Equip) return ITEMS[def].slot === x && !inv.items.some((i) => i.c === Cont.Equip && i.x === x && i.uid !== ignoreUid);
  const size = gridSize(inv, c);
  if (!size) return false;
  const [w, h] = footprint(def, rot);
  if (x < 0 || y < 0 || x + w > size[0] || y + h > size[1]) return false;
  for (const o of inv.items) {
    if (o.c !== c || o.uid === ignoreUid) continue;
    const [ow, oh] = footprint(o.def, o.rot);
    if (x < o.x + ow && o.x < x + w && y < o.y + oh && o.y < y + h) return false;
  }
  return true;
}

/** First free position for `def` scanning pockets, belt, then pack; tries both orientations. */
export function findSpace(inv: Inventory, def: Item, ignoreUid = 0): { c: Cont; x: number; y: number; rot: number } | null {
  for (const c of GRIDS) {
    const size = gridSize(inv, c);
    if (!size) continue;
    for (const rot of ITEMS[def].w === ITEMS[def].h ? [0] : [0, 1]) {
      for (let y = 0; y < size[1]; y++) for (let x = 0; x < size[0]; x++) {
        if (canPlace(inv, def, c, x, y, rot, ignoreUid)) return { c, x, y, rot };
      }
    }
  }
  return null;
}

/** Add units, topping up stacks first. Returns how many did not fit. */
export function addItem(inv: Inventory, def: Item, qty = 1, dur?: number): number {
  const it = ITEMS[def];
  if (it.stack > 1) {
    for (const o of inv.items) {
      if (qty <= 0) break;
      if (o.def !== def || o.c === Cont.Equip || o.qty >= it.stack) continue;
      const n = Math.min(qty, it.stack - o.qty);
      o.qty += n; qty -= n;
    }
  }
  while (qty > 0) {
    const spot = findSpace(inv, def);
    if (!spot) break;
    const n = Math.min(qty, it.stack);
    inv.items.push({ uid: inv.nextUid++, def, qty: n, dur: dur ?? it.tool?.dur ?? 0, ...spot });
    qty -= n;
  }
  return qty;
}

export function countItem(inv: Inventory, def: Item): number {
  let n = 0;
  for (const i of inv.items) if (i.def === def) n += i.qty;
  return n;
}

/** Remove up to `qty` units. Returns how many were removed. */
export function removeItem(inv: Inventory, def: Item, qty: number): number {
  let left = qty;
  for (let k = inv.items.length - 1; k >= 0 && left > 0; k--) {
    const i = inv.items[k];
    if (i.def !== def) continue;
    const n = Math.min(left, i.qty);
    i.qty -= n; left -= n;
    if (i.qty === 0) inv.items.splice(k, 1);
  }
  return qty - left;
}

/**
 * Move an item to a new place, validating everything a client could get wrong
 * or forge. Dropping a stack onto a matching stack merges them. Returns an
 * error message, or null on success.
 */
export function moveItem(inv: Inventory, uid: number, c: Cont, x: number, y: number, rot: number): string | null {
  const item = inv.items.find((i) => i.uid === uid);
  if (!item) return 'No such item';
  const def = ITEMS[item.def];
  rot = rot ? 1 : 0;
  if (item.c === c && item.x === x && item.y === y && item.rot === rot) return null;
  if (def.grid) {
    const own = def.slot === Slot.Belt ? Cont.BeltGrid : Cont.PackGrid;
    if (c === own) return 'A bag cannot go inside itself';
    // Taking a worn bag off would orphan its contents.
    if (item.c === Cont.Equip && inv.items.some((i) => i.c === own)) return 'Empty it first';
  }
  if (c !== Cont.Equip && def.stack > 1) {
    const size = gridSize(inv, c);
    const onto = size && inv.items.find((o) => {
      if (o.uid === uid || o.c !== c || o.def !== item.def) return false;
      const [ow, oh] = footprint(o.def, o.rot);
      return x >= o.x && x < o.x + ow && y >= o.y && y < o.y + oh;
    });
    if (onto) {
      const n = Math.min(item.qty, def.stack - onto.qty);
      if (n <= 0) return 'Stack is full';
      onto.qty += n; item.qty -= n;
      if (item.qty === 0) inv.items.splice(inv.items.indexOf(item), 1);
      return null;
    }
  }
  if (!canPlace(inv, item.def, c, x, y, rot, uid)) return c === Cont.Equip ? 'Cannot be worn there' : 'Does not fit there';
  item.c = c; item.x = x; item.y = c === Cont.Equip ? 0 : y; item.rot = c === Cont.Equip ? 0 : rot;
  return null;
}

export function totalWeight(inv: Inventory): number {
  let kg = 0;
  for (const i of inv.items) kg += ITEMS[i.def].kg * i.qty;
  return kg;
}

/** Best carried tool of a type, by tier. */
export function bestTool(inv: Inventory, type: ToolType): ItemInst | undefined {
  let best: ItemInst | undefined;
  for (const i of inv.items) {
    const t = ITEMS[i.def].tool;
    if (t?.type === type && (!best || t.tier > ITEMS[best.def].tool!.tier)) best = i;
  }
  return best;
}

/** Insulation in degrees C from worn clothing. */
export function wornWarmth(inv: Inventory): number {
  let w = 0;
  for (const i of inv.items) if (i.c === Cont.Equip) w += ITEMS[i.def].warmth ?? 0;
  return w;
}

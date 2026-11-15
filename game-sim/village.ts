import { Item } from './items';

/**
 * Village data shared by the server (rules) and the client (drawing and UI):
 * professions, building floor plans, construction costs and the price model.
 */

export enum Prof { None, Elder, Farmer, Lumberjack, Miner, Smith, Carpenter, Baker, Innkeeper, Merchant, Builder, Guard }
export const PROF_NAMES = ['', 'Elder', 'Farmer', 'Lumberjack', 'Miner', 'Blacksmith', 'Carpenter', 'Baker', 'Innkeeper', 'Merchant', 'Builder', 'Guard'];
/** Value of the `prof` byte for wildlife. */
export const WOLF = 200;
/** Unit owner ids from here up belong to villages, not players. */
export const VILLAGE_OWNER = 60000;

export enum BuildingType { TownHall, Smithy, Carpentry, Bakery, Granary, Tavern, Market, Cottage, Field, Watchtower }

/** One tile of a floor plan. */
export enum Piece {
  Floor, Wall, Window, Door, Post, Fence, Gate,
  Bed, Hearth, Chest, Table, Seat, Forge, Anvil, Rack, Sawbench, Oven, Barrel, Crate, Sacks, Counter, Scale, Desk, Board, Stall,
}

/**
 * Floor plans, drawn with the door on the south wall. Legend:
 *  # wall   W window   D door   . floor   * floor where someone stands to work
 *  b bed  h hearth  c chest  t table  s seat  f forge  a anvil  r tool rack  w sawbench  o oven
 *  B barrel  C crate  S grain sacks  k counter  x scales  L ledger desk  J job board
 *  p post   A market stall   F fence   G gate   (space) open ground
 */
const PLANS: Record<BuildingType, string[]> = {
  [BuildingType.TownHall]: [
    '###W#W###',
    '#L*.#..c#',
    '#...#..c#',
    'W.......W',
    '#J*...t.#',
    '#.....s.#',
    '####D####',
  ],
  [BuildingType.Smithy]: [
    '##W#W##',
    '#f*.a.#',
    '#f...r#',
    'W..*..W',
    '#B..C.#',
    '###D###',
  ],
  [BuildingType.Carpentry]: [
    '#W###W#',
    '#w*..r#',
    '#w...C#',
    'W..*..W',
    '#C....#',
    '###D###',
  ],
  [BuildingType.Bakery]: [
    '##W###',
    '#o*.S#',
    '#o..S#',
    'W....W',
    '#k*.B#',
    '##D###',
  ],
  [BuildingType.Granary]: [
    '#######',
    '#SS.SS#',
    '#SS.SS#',
    '#B.*.C#',
    '#B...C#',
    '###D###',
  ],
  [BuildingType.Tavern]: [
    '#W##W##W#',
    '#kk*#h.B#',
    '#...#..B#',
    '#.t.....#',
    'Wsts.ts.W',
    '#.....s.#',
    '####D####',
  ],
  [BuildingType.Market]: [
    'p.......p',
    '.AA*.AA*.',
    '.........',
    '..C.x.C..',
    '.........',
    '.AA*.AA*.',
    'p.......p',
  ],
  [BuildingType.Cottage]: [
    '######',
    '#bh.c#',
    'W....W',
    '#bt.s#',
    '###D##',
  ],
  [BuildingType.Field]: [
    'FFFFFFFFF',
    'F       F',
    'F       F',
    'F       F',
    'F       F',
    'F       F',
    'FFFFGFFFF',
  ],
  [BuildingType.Watchtower]: [
    '###',
    '#*#',
    '#D#',
  ],
};

const CHARS: Record<string, Piece> = {
  '#': Piece.Wall, W: Piece.Window, D: Piece.Door, p: Piece.Post, F: Piece.Fence, G: Piece.Gate,
  b: Piece.Bed, h: Piece.Hearth, c: Piece.Chest, t: Piece.Table, s: Piece.Seat, f: Piece.Forge, a: Piece.Anvil,
  r: Piece.Rack, w: Piece.Sawbench, o: Piece.Oven, B: Piece.Barrel, C: Piece.Crate, S: Piece.Sacks, k: Piece.Counter,
  x: Piece.Scale, L: Piece.Desk, J: Piece.Board, A: Piece.Stall,
};
/** Pieces that can be walked through or over. */
const WALKABLE = new Set([Piece.Floor, Piece.Door, Piece.Gate, Piece.Seat]);

export interface BuildingDef {
  name: string;
  desc: string;
  roof: 'thatch' | 'shingle' | 'none';
  floor: 'plank' | 'stone' | 'cobble' | 'none';
  wallH: number;
  /** What the village must spend to raise one: coins as wages, plus materials from the stockpile. */
  cost: { coins: number; items: [Item, number][] };
}

const cost = (coins: number, plank: number, stone: number, nails: number) =>
  ({ coins, items: [[Item.Plank, plank], [Item.Stone, stone], [Item.Nails, nails]] as [Item, number][] });

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  [BuildingType.TownHall]: { name: 'Town hall', desc: 'The elder keeps the treasury ledger and the job board here.', roof: 'shingle', floor: 'plank', wallH: 2.2, cost: cost(400, 40, 30, 30) },
  [BuildingType.Smithy]: { name: 'Smithy', desc: 'Forge and anvil: ore becomes ingots, nails and tools.', roof: 'shingle', floor: 'stone', wallH: 2, cost: cost(260, 20, 30, 20) },
  [BuildingType.Carpentry]: { name: 'Carpentry', desc: 'Sawbenches turn logs into planks and firewood.', roof: 'shingle', floor: 'plank', wallH: 2, cost: cost(240, 26, 12, 20) },
  [BuildingType.Bakery]: { name: 'Bakery', desc: 'Grain and firewood go in, bread comes out.', roof: 'thatch', floor: 'stone', wallH: 2, cost: cost(220, 18, 20, 14) },
  [BuildingType.Granary]: { name: 'Granary', desc: 'The village stockpile.', roof: 'thatch', floor: 'plank', wallH: 2.2, cost: cost(200, 20, 14, 16) },
  [BuildingType.Tavern]: { name: 'Tavern', desc: 'Villagers eat and spend their evenings here.', roof: 'shingle', floor: 'plank', wallH: 2.1, cost: cost(320, 34, 20, 26) },
  [BuildingType.Market]: { name: 'Market square', desc: 'Trade with the merchant while the stalls are staffed.', roof: 'none', floor: 'cobble', wallH: 2, cost: cost(180, 16, 24, 10) },
  [BuildingType.Cottage]: { name: 'Cottage', desc: 'A peasant home: two beds, a hearth and a chest.', roof: 'thatch', floor: 'plank', wallH: 1.9, cost: cost(120, 14, 10, 12) },
  [BuildingType.Field]: { name: 'Fenced field', desc: 'Grain plots tended by the farmers.', roof: 'none', floor: 'none', wallH: 0.8, cost: cost(60, 8, 0, 6) },
  [BuildingType.Watchtower]: { name: 'Watchtower', desc: 'A lookout for the guards.', roof: 'shingle', floor: 'stone', wallH: 4, cost: cost(150, 10, 24, 10) },
};

export interface Layout {
  w: number;
  h: number;
  /** In build order: floors, then walls and fences, then fittings. */
  pieces: { p: Piece; x: number; y: number }[];
  /** Tiles nothing can walk through once the building stands. */
  solid: [number, number][];
  door: [number, number];
  /** The tile just outside the door. */
  front: [number, number];
  work: [number, number][];
  /** Where a sleeper stands, one per bed. */
  beds: [number, number][];
  seats: [number, number][];
  /** w*h flags: true for tiles under the roof. */
  inside: boolean[];
}

const layouts = new Map<number, Layout>();

/** Floor plan for a building type; `flip` mirrors it so the door faces north. */
export function layoutOf(type: BuildingType, flip: boolean): Layout {
  const key = type * 2 + (flip ? 1 : 0);
  let L = layouts.get(key);
  if (L) return L;
  const plan = flip ? [...PLANS[type]].reverse() : PLANS[type];
  const h = plan.length, w = plan[0].length;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? ' ' : plan[y][x]);
  const floors: Layout['pieces'] = [], shell: Layout['pieces'] = [], fittings: Layout['pieces'] = [];
  L = { w, h, pieces: [], solid: [], door: [w >> 1, flip ? 0 : h - 1], front: [w >> 1, flip ? -1 : h], work: [], beds: [], seats: [], inside: new Array<boolean>(w * h).fill(false) };
  const hasFloor = BUILDINGS[type].floor !== 'none';
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ch = at(x, y);
    if (ch === ' ') continue;
    const p = CHARS[ch] ?? Piece.Floor;
    L.inside[x + y * w] = hasFloor;
    if (hasFloor && p !== Piece.Wall && p !== Piece.Window) floors.push({ p: Piece.Floor, x, y });
    if (p === Piece.Wall || p === Piece.Window || p === Piece.Door || p === Piece.Post || p === Piece.Fence || p === Piece.Gate) shell.push({ p, x, y });
    else if (p !== Piece.Floor) fittings.push({ p, x, y });
    if (!WALKABLE.has(p)) L.solid.push([x, y]);
    if (p === Piece.Door || p === Piece.Gate) { L.door = [x, y]; L.front = [x, flip ? y - 1 : y + 1]; }
    if (ch === '*') L.work.push([x, y]);
    if (p === Piece.Seat) L.seats.push([x, y]);
    if (p === Piece.Bed) {
      // A sleeper stands on the first open floor tile beside the bed.
      const spot = [[1, 0], [0, 1], [-1, 0], [0, -1]].map(([dx, dy]) => [x + dx, y + dy] as [number, number]).find(([nx, ny]) => '.*'.includes(at(nx, ny)));
      if (spot) L.beds.push(spot);
    }
  }
  L.pieces = [...floors, ...shell, ...fittings];
  layouts.set(key, L);
  return L;
}

// --- prices ---------------------------------------------------------------------

/** Price of one unit, in copper, when the stockpile holds exactly the amount the village wants. */
export const BASE_PRICE: Partial<Record<Item, number>> = {
  [Item.Grain]: 4, [Item.Bread]: 9, [Item.Berries]: 2, [Item.Meat]: 10,
  [Item.Log]: 12, [Item.Plank]: 8, [Item.Firewood]: 4, [Item.Stick]: 2,
  [Item.Stone]: 4, [Item.Flint]: 4, [Item.Ore]: 10, [Item.Ingot]: 40, [Item.Nails]: 3, [Item.Clay]: 4,
  [Item.Fiber]: 2, [Item.Cordage]: 6,
  [Item.FlintAxe]: 24, [Item.FlintKnife]: 16, [Item.FlintShovel]: 24, [Item.StonePick]: 24,
  [Item.CopperAxe]: 80, [Item.CopperPick]: 80, [Item.Spear]: 40,
  [Item.Pouch]: 30, [Item.Basket]: 50, [Item.ClayPot]: 20, [Item.GrassHat]: 14, [Item.HandWraps]: 12,
};
/** How much of each good the village would like to hold. Never below 4, which keeps buy-then-sell unprofitable. */
export const STOCK_TARGET: Partial<Record<Item, number>> = {
  [Item.Grain]: 40, [Item.Bread]: 24, [Item.Berries]: 16, [Item.Meat]: 8,
  [Item.Log]: 16, [Item.Plank]: 40, [Item.Firewood]: 30, [Item.Stick]: 16,
  [Item.Stone]: 40, [Item.Flint]: 8, [Item.Ore]: 16, [Item.Ingot]: 6, [Item.Nails]: 40, [Item.Clay]: 12,
  [Item.Fiber]: 16, [Item.Cordage]: 10,
};
const DEFAULT_PRICE = 8, DEFAULT_TARGET = 4;

/**
 * Supply and demand: a good costs its base price when the stockpile is at its
 * target, doubles as the stockpile empties, and falls away as it overflows.
 */
export function marketPrice(item: Item, stock: number): number {
  const base = BASE_PRICE[item] ?? DEFAULT_PRICE, target = STOCK_TARGET[item] ?? DEFAULT_TARGET;
  const k = Math.min(2.5, Math.max(0.4, Math.pow(2, (target - stock) / target)));
  return Math.max(1, Math.round(base * k));
}

/** What the merchant pays a player for one unit. */
export const buyPrice = (item: Item, stock: number) => Math.max(1, Math.floor(marketPrice(item, stock) * 0.8));

/** What a player pays for one unit; reputation earns up to a tenth off. */
export function sellPrice(item: Item, stock: number, reputation = 0): number {
  const discount = 1 - Math.min(50, Math.max(0, reputation)) / 500;
  return Math.max(buyPrice(item, stock) + 1, Math.ceil(marketPrice(item, stock) * 1.15 * discount));
}

/** What a villager is paid for goods they bring in: a wholesale rate, below what an outsider gets. */
export const wagePrice = (item: Item, stock: number) => Math.max(1, Math.floor(marketPrice(item, stock) * 0.3));

/** Things the village makes for itself, by trade. */
export interface VillageRecipe { prof: Prof; inputs: [Item, number][]; out: Item; qty: number; seconds: number; until: number }
export const VILLAGE_RECIPES: VillageRecipe[] = [
  { prof: Prof.Smith, inputs: [[Item.Ore, 3], [Item.Firewood, 2]], out: Item.Ingot, qty: 1, seconds: 12, until: 4 },
  { prof: Prof.Smith, inputs: [[Item.Ingot, 1]], out: Item.Nails, qty: 12, seconds: 8, until: 40 },
  { prof: Prof.Smith, inputs: [[Item.Ingot, 1], [Item.Plank, 1]], out: Item.CopperAxe, qty: 1, seconds: 10, until: 2 },
  { prof: Prof.Smith, inputs: [[Item.Ingot, 1], [Item.Plank, 1]], out: Item.CopperPick, qty: 1, seconds: 10, until: 2 },
  { prof: Prof.Smith, inputs: [[Item.Ingot, 1], [Item.Stick, 1]], out: Item.Spear, qty: 1, seconds: 8, until: 2 },
  { prof: Prof.Carpenter, inputs: [[Item.Log, 1]], out: Item.Plank, qty: 2, seconds: 6, until: 40 },
  { prof: Prof.Carpenter, inputs: [[Item.Log, 1]], out: Item.Firewood, qty: 4, seconds: 5, until: 30 },
  { prof: Prof.Carpenter, inputs: [[Item.Fiber, 6], [Item.Stick, 2]], out: Item.Basket, qty: 1, seconds: 10, until: 2 },
  { prof: Prof.Baker, inputs: [[Item.Grain, 2], [Item.Firewood, 1]], out: Item.Bread, qty: 3, seconds: 8, until: 30 },
];

/** What the town hall builds next, in order, as funds and materials allow. */
export const GROWTH_PLAN = [BuildingType.Cottage, BuildingType.Watchtower, BuildingType.Cottage, BuildingType.Field, BuildingType.Cottage, BuildingType.Granary];

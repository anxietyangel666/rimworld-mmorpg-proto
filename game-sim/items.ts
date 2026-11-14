import { NodeKind } from '../world-gen/surface';

/**
 * Static game data: items, skills, structures, recipes and carving patterns.
 * Everything here is plain data shared by the server (rules) and the client
 * (display and placement previews).
 */

export enum Item {
  Flint = 1, Stone, Stick, Fiber, Cordage, Clay, Log, Firewood, Plank, Berries, Ore, Ingot,
  AxeHead, KnifeBlade, ShovelHead, FlintAxe, FlintKnife, FlintShovel, StonePick, CopperAxe, CopperPick,
  RawPot, ClayPot, WaterPot, RawCrucible, Crucible,
  Shirt, Trousers, GrassHat, HandWraps, Pouch, Basket,
}

export type ToolType = 'axe' | 'knife' | 'shovel' | 'pick' | 'hammer' | 'crucible';
export enum Slot { Head, Torso, Legs, Hands, Back, Belt }
export const SLOT_NAMES = ['Head', 'Torso', 'Legs', 'Hands', 'Back', 'Belt'];

export interface ItemDef {
  name: string;
  /** Footprint in inventory cells, unrotated. */
  w: number;
  h: number;
  /** Weight of one unit in kg. */
  kg: number;
  /** Units per stack; 1 for unstackable items. */
  stack: number;
  /** Icon shape and colour, drawn by the client. */
  icon: string;
  color: string;
  desc: string;
  /** dur 0 means the tool never wears out. */
  tool?: { type: ToolType; tier: number; dur: number };
  slot?: Slot;
  /** Storage grid unlocked while this is worn. */
  grid?: [number, number];
  /** Degrees C of insulation while worn. */
  warmth?: number;
  food?: { satiety: number; hydration: number };
}

const d = (name: string, w: number, h: number, kg: number, stack: number, icon: string, color: string, desc: string, extra: Partial<ItemDef> = {}): ItemDef =>
  ({ name, w, h, kg, stack, icon, color, desc, ...extra });

export const ITEMS: Record<Item, ItemDef> = {
  [Item.Flint]: d('Flint', 1, 1, 0.3, 4, 'stone', '#3b3f45', 'Knappable nodule. Shape it with a hammerstone.'),
  [Item.Stone]: d('Stone', 1, 1, 1.0, 2, 'stone', '#8a857b', 'Building stone. Also serves as a hammerstone.', { tool: { type: 'hammer', tier: 1, dur: 0 } }),
  [Item.Stick]: d('Stick', 1, 3, 0.5, 4, 'stick', '#7a5a3a', 'A straight branch. Handles, frames, kindling.'),
  [Item.Fiber]: d('Plant fibre', 1, 1, 0.05, 12, 'fiber', '#8f9a56', 'Tough stems. Twist into cordage.'),
  [Item.Cordage]: d('Cordage', 1, 1, 0.1, 6, 'coil', '#b39a62', 'Twisted fibre cord for lashing.'),
  [Item.Clay]: d('Clay', 1, 1, 1.2, 4, 'lump', '#a0624a', 'Wet clay. Form it, then fire it.'),
  [Item.Log]: d('Log', 2, 4, 9, 1, 'log', '#6b4a2e', 'A felled trunk section. Heavy.'),
  [Item.Firewood]: d('Firewood', 1, 2, 1.5, 4, 'log', '#8a6238', 'Split wood for kilns and forges.'),
  [Item.Plank]: d('Plank', 1, 4, 2, 2, 'plank', '#a57c4c', 'Rough-hewn board.'),
  [Item.Berries]: d('Berries', 1, 1, 0.1, 10, 'berry', '#8a2f45', 'Edible. Restores a little satiety and water.', { food: { satiety: 9, hydration: 3 } }),
  [Item.Ore]: d('Copper ore', 1, 1, 1.5, 4, 'stone', '#5f8f7a', 'Green-stained ore. Smelt it in a forge.'),
  [Item.Ingot]: d('Copper ingot', 1, 2, 2, 1, 'ingot', '#b8733a', 'Cast copper, ready to work.'),
  [Item.AxeHead]: d('Flint axe head', 1, 1, 0.3, 1, 'head', '#3b3f45', 'Lash to a stick with cordage.'),
  [Item.KnifeBlade]: d('Flint blade', 1, 1, 0.15, 1, 'blade', '#3b3f45', 'Lash to a stick with cordage.'),
  [Item.ShovelHead]: d('Flint shovel head', 1, 1, 0.4, 1, 'head', '#4a4e55', 'Lash to a stick with cordage.'),
  [Item.FlintAxe]: d('Flint axe', 2, 3, 1.4, 1, 'axe', '#3b3f45', 'Fells trees and splits logs.', { tool: { type: 'axe', tier: 1, dur: 60 } }),
  [Item.FlintKnife]: d('Flint knife', 1, 2, 0.3, 1, 'knife', '#3b3f45', 'Cuts fibre and hide.', { tool: { type: 'knife', tier: 1, dur: 50 } }),
  [Item.FlintShovel]: d('Flint shovel', 1, 4, 1.6, 1, 'shovel', '#4a4e55', 'Digs clay and garden plots.', { tool: { type: 'shovel', tier: 1, dur: 60 } }),
  [Item.StonePick]: d('Stone pick', 2, 3, 2.0, 1, 'pick', '#8a857b', 'Breaks ore out of rock.', { tool: { type: 'pick', tier: 1, dur: 50 } }),
  [Item.CopperAxe]: d('Copper axe', 2, 4, 2.4, 1, 'axe', '#b8733a', 'A proper axe. Fast and durable.', { tool: { type: 'axe', tier: 2, dur: 220 } }),
  [Item.CopperPick]: d('Copper pick', 2, 4, 2.6, 1, 'pick', '#b8733a', 'A proper pick. Fast and durable.', { tool: { type: 'pick', tier: 2, dur: 220 } }),
  [Item.RawPot]: d('Unfired pot', 2, 2, 2.0, 1, 'pot', '#a0624a', 'Fire it in a pit kiln.'),
  [Item.ClayPot]: d('Clay pot', 2, 2, 1.6, 1, 'pot', '#b5764f', 'Empty. Use it beside water to fill it.'),
  [Item.WaterPot]: d('Pot of water', 2, 2, 3.6, 1, 'pot', '#5f7f8f', 'Use to drink.'),
  [Item.RawCrucible]: d('Unfired crucible', 1, 1, 1.0, 1, 'cup', '#a0624a', 'Fire it in a pit kiln.'),
  [Item.Crucible]: d('Crucible', 1, 1, 0.8, 1, 'cup', '#b5764f', 'Holds molten metal at the forge.', { tool: { type: 'crucible', tier: 1, dur: 0 } }),
  [Item.Shirt]: d('Linen shirt', 2, 2, 0.4, 1, 'cloth', '#9a927e', 'Plain shirt.', { slot: Slot.Torso, warmth: 4 }),
  [Item.Trousers]: d('Work trousers', 2, 2, 0.5, 1, 'cloth', '#5f5a50', 'Hard-wearing trousers.', { slot: Slot.Legs, warmth: 4 }),
  [Item.GrassHat]: d('Grass hat', 2, 2, 0.2, 1, 'hat', '#a39a5c', 'Shade in the heat, some warmth in the cold.', { slot: Slot.Head, warmth: 2 }),
  [Item.HandWraps]: d('Hand wraps', 1, 1, 0.1, 1, 'coil', '#9a927e', 'Protects hands when working stone.', { slot: Slot.Hands, warmth: 1 }),
  [Item.Pouch]: d('Belt pouch', 2, 2, 0.3, 1, 'bag', '#7a6a4a', 'Wear on the belt for a 3x2 pouch.', { slot: Slot.Belt, grid: [3, 2] }),
  [Item.Basket]: d('Pack basket', 3, 3, 1.2, 1, 'bag', '#9a8450', 'Wear on the back for a 5x5 pack.', { slot: Slot.Back, grid: [5, 5] }),
};

// --- skills ---------------------------------------------------------------------

export enum Skill { Knapping, Carpentry, Mining, Smithing, Farming, Combat, Conditioning }
export const SKILL_NAMES = ['Knapping & crafting', 'Carpentry', 'Mining', 'Smithing', 'Farming & foraging', 'Combat', 'Conditioning'];
export const SKILL_COUNT = 7;
export const MAX_LEVEL = 10;
export const xpForLevel = (level: number) => 25 * level * level;
export const levelOf = (xp: number) => Math.min(MAX_LEVEL, Math.floor(Math.sqrt(xp / 25)));
/** Work-rate multiplier from skill level. */
export const workSpeed = (xp: number) => 1 + 0.12 * levelOf(xp);

// --- resource nodes -----------------------------------------------------------

export interface NodeDef {
  name: string;
  amount: number;
  /** Seconds per harvest with bare hands at level 0. */
  interval: number;
  skill: Skill;
  tool?: ToolType;
  /** Without the tool: 'slow' still works, 'limited' stops at `handFloor`, 'none' cannot be worked. */
  bare: 'slow' | 'limited' | 'none';
  handFloor?: number;
}

export const NODES: Record<NodeKind, NodeDef> = {
  [NodeKind.Tree]: { name: 'Tree', amount: 6, interval: 3.2, skill: Skill.Carpentry, tool: 'axe', bare: 'limited', handFloor: 3 },
  [NodeKind.Stone]: { name: 'Loose stone', amount: 5, interval: 2.6, skill: Skill.Mining, tool: 'pick', bare: 'slow' },
  [NodeKind.Ore]: { name: 'Copper vein', amount: 6, interval: 3.4, skill: Skill.Mining, tool: 'pick', bare: 'none' },
  [NodeKind.Clay]: { name: 'Clay bank', amount: 6, interval: 2.8, skill: Skill.Mining, tool: 'shovel', bare: 'slow' },
  [NodeKind.Bush]: { name: 'Berry bush', amount: 4, interval: 2.0, skill: Skill.Farming, bare: 'slow' },
  [NodeKind.Reeds]: { name: 'Reeds', amount: 3, interval: 2.0, skill: Skill.Farming, tool: 'knife', bare: 'slow' },
};

// --- structures -----------------------------------------------------------------

export enum StructureKind { Wall, Floor, Campfire, ChoppingBlock, CraftingTable, PitKiln, Forge, GardenPlot }

export interface Cost { item: Item; qty: number }
export interface StructureDef { name: string; cost: Cost[]; blocks: boolean; tool?: ToolType; desc: string }

export const STRUCTURES: Record<StructureKind, StructureDef> = {
  [StructureKind.Campfire]: { name: 'Campfire', cost: [{ item: Item.Stick, qty: 3 }, { item: Item.Stone, qty: 2 }], blocks: true, desc: 'Warmth for anyone within four tiles.' },
  [StructureKind.ChoppingBlock]: { name: 'Chopping block', cost: [{ item: Item.Log, qty: 1 }], blocks: true, desc: 'Split logs into firewood and planks.' },
  [StructureKind.CraftingTable]: { name: 'Work table', cost: [{ item: Item.Plank, qty: 4 }, { item: Item.Stick, qty: 2 }], blocks: true, desc: 'Assemble tools, bags and clothing.' },
  [StructureKind.PitKiln]: { name: 'Pit kiln', cost: [{ item: Item.Stone, qty: 6 }, { item: Item.Clay, qty: 2 }], blocks: true, desc: 'Fire formed clay.' },
  [StructureKind.Forge]: { name: 'Forge', cost: [{ item: Item.Stone, qty: 8 }, { item: Item.Clay, qty: 4 }], blocks: true, desc: 'Smelt ore and cast copper tools.' },
  [StructureKind.Wall]: { name: 'Log wall', cost: [{ item: Item.Log, qty: 1 }], blocks: true, desc: 'A solid wall segment.' },
  [StructureKind.Floor]: { name: 'Stone floor', cost: [{ item: Item.Stone, qty: 2 }], blocks: false, desc: 'Paving.' },
  [StructureKind.GardenPlot]: { name: 'Garden plot', cost: [], blocks: false, tool: 'shovel', desc: 'Plant berries; harvest when ripe.' },
};
export const BUILD_ORDER = [
  StructureKind.Campfire, StructureKind.ChoppingBlock, StructureKind.CraftingTable, StructureKind.PitKiln,
  StructureKind.Forge, StructureKind.Wall, StructureKind.Floor, StructureKind.GardenPlot,
];

// --- carving patterns (knapping and clay forming) ------------------------------

export const PATTERN_SIZE = 8;

export interface Pattern {
  name: string;
  /** carve: start solid and chip waste away from the edges. form: build the shape up cell by cell. */
  mode: 'carve' | 'form';
  input: Item;
  inputQty: number;
  tool?: ToolType;
  output: Item;
  xp: number;
  /** Row bitmasks, bit x set where the finished piece has material. */
  rows: number[];
}

const rows = (...lines: string[]) => lines.map((l) => [...l].reduce((m, ch, x) => m | (ch === '#' ? 1 << x : 0), 0));

export enum PatternId { AxeHead, KnifeBlade, ShovelHead, Pot, Crucible }

export const PATTERNS: Record<PatternId, Pattern> = {
  [PatternId.AxeHead]: {
    name: 'Axe head', mode: 'carve', input: Item.Flint, inputQty: 1, tool: 'hammer', output: Item.AxeHead, xp: 14,
    rows: rows('........', '.####...', '.######.', '.#######', '.#######', '.######.', '.####...', '........'),
  },
  [PatternId.KnifeBlade]: {
    name: 'Knife blade', mode: 'carve', input: Item.Flint, inputQty: 1, tool: 'hammer', output: Item.KnifeBlade, xp: 10,
    rows: rows('....#...', '...##...', '...###..', '..####..', '..####..', '..###...', '..###...', '..##....'),
  },
  [PatternId.ShovelHead]: {
    name: 'Shovel head', mode: 'carve', input: Item.Flint, inputQty: 1, tool: 'hammer', output: Item.ShovelHead, xp: 12,
    rows: rows('..####..', '.######.', '.######.', '.######.', '.######.', '..####..', '...##...', '...##...'),
  },
  [PatternId.Pot]: {
    name: 'Clay pot', mode: 'form', input: Item.Clay, inputQty: 4, output: Item.RawPot, xp: 12,
    rows: rows('........', '#......#', '#......#', '#......#', '#......#', '##....##', '.######.', '..####..'),
  },
  [PatternId.Crucible]: {
    name: 'Crucible', mode: 'form', input: Item.Clay, inputQty: 2, output: Item.RawCrucible, xp: 8,
    rows: rows('........', '........', '.#....#.', '.#....#.', '.#....#.', '.######.', '..####..', '........'),
  },
};

// --- recipes --------------------------------------------------------------------

export interface Recipe {
  name: string;
  /** Structure that must be adjacent, or null for handwork. */
  station: StructureKind | null;
  inputs: Cost[];
  /** A tool that must be carried; it wears but is not consumed. */
  tool?: ToolType;
  output: Item;
  outputQty: number;
  seconds: number;
  skill: Skill;
  xp: number;
}

const r = (name: string, station: StructureKind | null, inputs: [Item, number][], output: Item, outputQty: number, seconds: number, skill: Skill, xp: number, tool?: ToolType): Recipe =>
  ({ name, station, inputs: inputs.map(([item, qty]) => ({ item, qty })), output, outputQty, seconds, skill, xp, tool });

export const RECIPES: Recipe[] = [
  r('Twist cordage', null, [[Item.Fiber, 3]], Item.Cordage, 1, 3, Skill.Knapping, 3),
  r('Haft flint axe', null, [[Item.AxeHead, 1], [Item.Stick, 1], [Item.Cordage, 1]], Item.FlintAxe, 1, 5, Skill.Knapping, 10),
  r('Haft flint knife', null, [[Item.KnifeBlade, 1], [Item.Stick, 1], [Item.Cordage, 1]], Item.FlintKnife, 1, 4, Skill.Knapping, 8),
  r('Haft flint shovel', null, [[Item.ShovelHead, 1], [Item.Stick, 1], [Item.Cordage, 1]], Item.FlintShovel, 1, 5, Skill.Knapping, 10),
  r('Split firewood', StructureKind.ChoppingBlock, [[Item.Log, 1]], Item.Firewood, 4, 5, Skill.Carpentry, 6, 'axe'),
  r('Hew planks', StructureKind.ChoppingBlock, [[Item.Log, 1]], Item.Plank, 2, 7, Skill.Carpentry, 8, 'axe'),
  r('Stone pick', StructureKind.CraftingTable, [[Item.Stone, 2], [Item.Stick, 1], [Item.Cordage, 1]], Item.StonePick, 1, 6, Skill.Knapping, 10),
  r('Belt pouch', StructureKind.CraftingTable, [[Item.Fiber, 4], [Item.Cordage, 1]], Item.Pouch, 1, 6, Skill.Knapping, 8, 'knife'),
  r('Pack basket', StructureKind.CraftingTable, [[Item.Fiber, 8], [Item.Stick, 2]], Item.Basket, 1, 10, Skill.Knapping, 14),
  r('Grass hat', StructureKind.CraftingTable, [[Item.Fiber, 5]], Item.GrassHat, 1, 5, Skill.Knapping, 6),
  r('Hand wraps', StructureKind.CraftingTable, [[Item.Fiber, 2], [Item.Cordage, 1]], Item.HandWraps, 1, 4, Skill.Knapping, 5),
  r('Fire clay pot', StructureKind.PitKiln, [[Item.RawPot, 1], [Item.Firewood, 2]], Item.ClayPot, 1, 14, Skill.Knapping, 10),
  r('Fire crucible', StructureKind.PitKiln, [[Item.RawCrucible, 1], [Item.Firewood, 2]], Item.Crucible, 1, 12, Skill.Knapping, 8),
  r('Smelt copper', StructureKind.Forge, [[Item.Ore, 3], [Item.Firewood, 2]], Item.Ingot, 1, 16, Skill.Smithing, 16, 'crucible'),
  r('Cast copper axe', StructureKind.Forge, [[Item.Ingot, 1], [Item.Stick, 1], [Item.Cordage, 1]], Item.CopperAxe, 1, 10, Skill.Smithing, 20, 'hammer'),
  r('Cast copper pick', StructureKind.Forge, [[Item.Ingot, 1], [Item.Stick, 1], [Item.Cordage, 1]], Item.CopperPick, 1, 10, Skill.Smithing, 20, 'hammer'),
];

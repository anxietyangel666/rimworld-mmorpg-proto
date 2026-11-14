import { countItem } from '../game-sim/inventory';
import { Item, ITEMS, PATTERN_SIZE, PATTERNS, RECIPES, STRUCTURES, type PatternId, type Recipe, type StructureKind } from '../game-sim/items';
import { C2S, type MirrorEntity } from '../network';
import { $, el, type GameState, type Send } from './state';

/**
 * Crafting window. There is no "craft" button that conjures an item: tool
 * heads are chipped out of a flint blank cell by cell, vessels are built up
 * out of clay, parts are lashed together by hand over a few seconds, and
 * anything heavier is worked at a station standing in the world.
 */
export class CraftingUI {
  /** Workstation the window is showing recipes for, or null for handwork only. */
  private station: MirrorEntity | null = null;
  private dirty = true;

  constructor(private readonly state: GameState, private readonly send: Send) {
    $('carve-cancel').addEventListener('click', () => this.send({ op: C2S.CraftCancel }));
  }

  get open(): boolean {
    return !$('craft-window').hidden;
  }

  toggle(open = !this.open, station: MirrorEntity | null = null): void {
    this.station = open ? station : null;
    $('craft-window').hidden = !open;
    if (open) this.render();
  }

  invalidate(): void {
    this.dirty = true;
  }

  refresh(): void {
    if (this.open && this.dirty) this.render();
  }

  private recipeButton(r: Recipe, index: number, stationId: number): HTMLElement {
    const inv = this.state.inventory;
    const b = el('button', 'recipe', el('b', '', r.name), el('br'));
    r.inputs.forEach((c, i) => {
      const have = countItem(inv, c.item);
      b.append(el('span', have >= c.qty ? 'have' : 'need', (i ? ' + ' : '') + c.qty + ' ' + ITEMS[c.item].name));
    });
    b.append(el('small', '', (r.tool ? 'Tool: ' + (r.tool === 'hammer' ? 'hammerstone' : r.tool) + ' · ' : '') + r.seconds + ' s of work · makes ' + r.outputQty + ' ' + ITEMS[r.output].name));
    b.addEventListener('click', () => this.send({ op: C2S.Recipe, recipe: index, station: stationId }));
    return b;
  }

  render(): void {
    this.dirty = false;
    const inv = this.state.inventory;
    const lists = $('craft-lists');
    lists.replaceChildren();
    const kind: StructureKind | null = this.station?.state.structure?.kind ?? null;
    $('craft-title').textContent = kind === null ? 'Handwork' : STRUCTURES[kind].name;

    if (kind !== null) {
      lists.append(el('div', 'label', 'At this ' + STRUCTURES[kind].name.toLowerCase()));
      RECIPES.forEach((r, i) => { if (r.station === kind) lists.append(this.recipeButton(r, i, this.station!.state.id)); });
      lists.append(el('div', 'dim small', 'Materials lying within a few paces of the station count.'));
    } else {
      lists.append(el('div', 'label', 'Knap flint / form clay'));
      for (const [id, p] of Object.entries(PATTERNS)) {
        const have = countItem(inv, p.input);
        const b = el('button', 'recipe', el('b', '', p.name), el('br'),
          el('span', have >= p.inputQty ? 'have' : 'need', p.inputQty + ' ' + ITEMS[p.input].name),
          el('small', '', p.mode === 'carve' ? 'Chip a flint blank to shape with a hammerstone' : 'Build the shape up from clay, then fire it'));
        b.addEventListener('click', () => this.send({ op: C2S.CraftStart, pattern: Number(id) as PatternId }));
        lists.append(b);
      }
      lists.append(el('div', 'label', 'By hand'));
      RECIPES.forEach((r, i) => { if (r.station === null) lists.append(this.recipeButton(r, i, 0)); });
    }
    this.renderCarve();
  }

  /** The carving board for the session in progress, if any. */
  private renderCarve(): void {
    const s = this.state.craft;
    $('carve').hidden = !s;
    if (!s) return;
    const p = PATTERNS[s.pattern as PatternId];
    const material = p.input === Item.Clay ? 'clay' : 'flint';
    $('carve-title').textContent = p.name + (p.mode === 'carve' ? ' · slips left: ' + Math.max(0, s.mistakes) : '');
    $('carve-help').textContent = p.mode === 'carve'
      ? 'Knock off the pale waste, working in from an exposed edge. The outlined cells are the tool: strike them and the blank is ruined.'
      : 'Press clay into every outlined cell and nowhere else. Click a cell again to scrape it off.';
    const grid = $('carve-grid');
    grid.replaceChildren();
    for (let y = 0; y < PATTERN_SIZE; y++) for (let x = 0; x < PATTERN_SIZE; x++) {
      const present = (s.cells[y] >> x & 1) === 1, wanted = (p.rows[y] >> x & 1) === 1;
      const c = el('div', 'cv' + (present ? ' ' + material : '') + (wanted ? ' keep' : '') + (present && !wanted ? ' waste' : ''));
      c.addEventListener('pointerdown', () => this.send({ op: C2S.CraftHit, x, y }));
      grid.append(c);
    }
  }
}

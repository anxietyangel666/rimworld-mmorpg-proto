import { LOAD_NAMES } from '../game-sim/character';
import { canPlace, Cont, equipped, footprint, gridSize, type ItemInst } from '../game-sim/inventory';
import { Item, ITEMS, levelOf, MAX_LEVEL, SKILL_NAMES, Slot, SLOT_NAMES, xpForLevel } from '../game-sim/items';
import { C2S } from '../network';
import { iconUrl } from './icons';
import { $, el, hideTooltip, showTooltip, type GameState, type Send } from './state';

const CELL = 36;
const GRID_NAMES: Partial<Record<Cont, string>> = { [Cont.Pockets]: 'Pockets', [Cont.BeltGrid]: 'Belt pouch', [Cont.PackGrid]: 'Pack' };
/** Paper-doll layout, in cells: roughly where each slot sits on a body. */
const DOLL: Record<Slot, [number, number]> = {
  [Slot.Head]: [1.2, 0], [Slot.Torso]: [1.2, 2.2], [Slot.Legs]: [1.2, 4.4],
  [Slot.Hands]: [-0.0, 2.2], [Slot.Back]: [2.4, 0.4], [Slot.Belt]: [2.4, 3.3],
};

interface Drag {
  item: ItemInst;
  rot: number;
  /** Which cell of the item the pointer holds, so it does not jump on pick-up. */
  gx: number;
  gy: number;
  ghost: HTMLElement;
  target: { c: Cont; x: number; y: number } | null;
  valid: boolean;
}

/**
 * Character sheet: paper doll, spatial inventory grids and skills.
 *
 * Dragging is done with pointer events rather than HTML drag-and-drop so the
 * item in hand can be rotated with R and the landing cells can be coloured as
 * it moves. The colouring uses the same `canPlace` the server runs; the server
 * still validates the move when it arrives.
 */
export class InventoryUI {
  private drag: Drag | null = null;
  private readonly hl = el('div', 'place-hl');
  private dirty = true;

  constructor(private readonly state: GameState, private readonly send: Send) {
    window.addEventListener('pointermove', (ev) => this.onMove(ev));
    window.addEventListener('pointerup', (ev) => this.onUp(ev));
    window.addEventListener('keydown', (ev) => {
      if (!this.drag || ev.key.toLowerCase() !== 'r') return;
      const d = this.drag, def = ITEMS[d.item.def];
      if (def.w === def.h) return;
      d.rot ^= 1;
      [d.gx, d.gy] = [d.gy, d.gx];
      this.styleGhost();
      ev.stopPropagation();
    }, true);
  }

  get open(): boolean {
    return !$('char-window').hidden;
  }

  toggle(open = !this.open): void {
    $('char-window').hidden = !open;
    if (open) this.render();
    else this.cancelDrag();
  }

  /** Mark stale; re-rendered on the next refresh unless an item is in hand. */
  invalidate(): void {
    this.dirty = true;
  }

  refresh(): void {
    if (this.open && this.dirty && !this.drag) this.render();
  }

  private itemEl(it: ItemInst): HTMLElement {
    const def = ITEMS[it.def];
    const [w, h] = footprint(it.def, it.rot);
    const e = el('div', 'item');
    e.style.width = w * CELL + 'px'; e.style.height = h * CELL + 'px';
    e.style.backgroundImage = 'url(' + iconUrl(it.def, it.rot) + ')';
    if (it.qty > 1) e.append(el('span', 'qty', String(it.qty)));
    const max = def.tool?.dur ?? (it.def === Item.WaterPot ? 3 : 0);
    if (max > 0 && it.dur > 0) {
      const bar = el('div', 'dur'), fill = el('i');
      fill.style.width = Math.min(100, (it.dur / max) * 100) + '%';
      bar.append(fill);
      e.append(bar);
    }
    e.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const r = e.getBoundingClientRect();
      this.startDrag(it, Math.floor((ev.clientX - r.left) / CELL), Math.floor((ev.clientY - r.top) / CELL), ev);
      ev.preventDefault();
    });
    e.addEventListener('contextmenu', (ev) => { ev.preventDefault(); this.send({ op: C2S.InvUse, uid: it.uid }); });
    e.addEventListener('dblclick', () => this.send({ op: C2S.InvUse, uid: it.uid }));
    e.addEventListener('pointermove', (ev) => {
      if (this.drag) return;
      const use = def.food ? 'Right-click to eat' : def.slot !== undefined ? 'Right-click to ' + (it.c === Cont.Equip ? 'take off' : 'wear') : it.def === Item.ClayPot || it.def === Item.WaterPot ? 'Right-click to ' + (it.def === Item.ClayPot ? 'fill at water' : 'drink') : '';
      showTooltip(
        def.name + (it.qty > 1 ? ' x' + it.qty : '') + '\n' + def.w + 'x' + def.h + ' cells · ' + (def.kg * it.qty).toFixed(1) + ' kg'
        + (def.tool && def.tool.dur > 0 ? ' · ' + it.dur + ' uses left' : '') + '\n' + def.desc + (use ? '\n' + use : ''),
        ev.clientX, ev.clientY);
    });
    e.addEventListener('pointerleave', hideTooltip);
    return e;
  }

  render(): void {
    this.dirty = false;
    const inv = this.state.inventory;
    // Paper doll.
    const doll = $('doll');
    doll.replaceChildren();
    for (const slot of [Slot.Head, Slot.Torso, Slot.Legs, Slot.Hands, Slot.Back, Slot.Belt]) {
      const s = el('div', 'slot', SLOT_NAMES[slot]);
      s.dataset.slot = String(slot);
      s.style.left = DOLL[slot][0] * CELL + 'px'; s.style.top = DOLL[slot][1] * CELL + 'px';
      const worn = equipped(inv, slot);
      if (worn) s.replaceChildren(this.itemEl({ ...worn, rot: 0 }));
      doll.append(s);
    }
    // Storage grids: pockets always, plus one per bag worn.
    const grids = $('grids');
    grids.replaceChildren();
    for (const c of [Cont.Pockets, Cont.BeltGrid, Cont.PackGrid]) {
      const size = gridSize(inv, c);
      if (!size) continue;
      const grid = el('div', 'grid');
      grid.dataset.cont = String(c);
      grid.style.width = size[0] * CELL + 'px'; grid.style.height = size[1] * CELL + 'px';
      for (const it of inv.items) {
        if (it.c !== c) continue;
        const e = this.itemEl(it);
        e.style.left = it.x * CELL + 'px'; e.style.top = it.y * CELL + 'px';
        e.dataset.uid = String(it.uid);
        grid.append(e);
      }
      grids.append(el('div', 'grid-wrap', el('div', 'label', GRID_NAMES[c]! + ' · ' + size[0] + 'x' + size[1]), grid));
    }
    const self = this.state.self;
    if (self) grids.append(el('div', 'dim small', 'Carrying ' + self.kg.toFixed(1) + ' of ' + self.capacity.toFixed(0) + ' kg · ' + LOAD_NAMES[self.tier] + ' load'));

    $('skills').replaceChildren(...SKILL_NAMES.map((name, i) => {
      const xp = this.state.skills[i] ?? 0, level = levelOf(xp);
      const span = xpForLevel(level + 1) - xpForLevel(level);
      const fill = el('i');
      fill.style.width = (level >= MAX_LEVEL ? 100 : ((xp - xpForLevel(level)) / span) * 100) + '%';
      return el('li', '', el('span', '', name), el('b', '', 'Lv ' + level), el('div', 'bar', fill));
    }));
  }

  // --- dragging ---------------------------------------------------------------

  private startDrag(item: ItemInst, gx: number, gy: number, ev: PointerEvent): void {
    hideTooltip();
    const ghost = el('div', 'item');
    ghost.id = 'drag-ghost';
    document.body.append(ghost);
    const rot = item.c === Cont.Equip ? 0 : item.rot;
    this.drag = { item, rot, gx: item.c === Cont.Equip ? 0 : gx, gy: item.c === Cont.Equip ? 0 : gy, ghost, target: null, valid: false };
    document.querySelector('.item[data-uid="' + item.uid + '"]')?.classList.add('dragging');
    this.styleGhost();
    this.onMove(ev);
  }

  private styleGhost(): void {
    const d = this.drag!;
    const [w, h] = footprint(d.item.def, d.rot);
    d.gx = Math.min(d.gx, w - 1); d.gy = Math.min(d.gy, h - 1);
    d.ghost.style.width = w * CELL + 'px'; d.ghost.style.height = h * CELL + 'px';
    d.ghost.style.backgroundImage = 'url(' + iconUrl(d.item.def, d.rot) + ')';
  }

  private onMove(ev: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    d.ghost.style.left = ev.clientX - (d.gx + 0.5) * CELL + 'px';
    d.ghost.style.top = ev.clientY - (d.gy + 0.5) * CELL + 'px';
    this.hl.remove();
    document.querySelectorAll('.slot.ok, .slot.bad').forEach((s) => s.classList.remove('ok', 'bad'));
    d.target = null;
    const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const grid = under?.closest<HTMLElement>('.grid'), slot = under?.closest<HTMLElement>('.slot');
    const inv = this.state.inventory;
    if (grid) {
      const c = Number(grid.dataset.cont) as Cont;
      const r = grid.getBoundingClientRect();
      const x = Math.floor((ev.clientX - r.left) / CELL) - d.gx, y = Math.floor((ev.clientY - r.top) / CELL) - d.gy;
      const [w, h] = footprint(d.item.def, d.rot);
      // Dropping onto a matching stack merges, which the footprint test alone would reject.
      const px = x + d.gx, py = y + d.gy;
      const merge = ITEMS[d.item.def].stack > 1 && inv.items.some((o) => {
        if (o.uid === d.item.uid || o.c !== c || o.def !== d.item.def || o.qty >= ITEMS[o.def].stack) return false;
        const [ow, oh] = footprint(o.def, o.rot);
        return px >= o.x && px < o.x + ow && py >= o.y && py < o.y + oh;
      });
      d.valid = merge || canPlace(inv, d.item.def, c, x, y, d.rot, d.item.uid);
      d.target = merge ? { c, x: px, y: py } : { c, x, y };
      this.hl.className = 'place-hl' + (d.valid ? '' : ' bad');
      this.hl.style.left = x * CELL + 'px'; this.hl.style.top = y * CELL + 'px';
      this.hl.style.width = w * CELL + 'px'; this.hl.style.height = h * CELL + 'px';
      grid.append(this.hl);
    } else if (slot) {
      const s = Number(slot.dataset.slot);
      d.valid = canPlace(inv, d.item.def, Cont.Equip, s, 0, 0, d.item.uid);
      d.target = { c: Cont.Equip, x: s, y: 0 };
      slot.classList.add(d.valid ? 'ok' : 'bad');
    }
  }

  private onUp(ev: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const outside = !(document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('#char-window');
    if (d.target && d.valid) this.send({ op: C2S.InvMove, uid: d.item.uid, c: d.target.c, x: d.target.x, y: d.target.y, rot: d.rot });
    else if (outside) this.send({ op: C2S.InvDrop, uid: d.item.uid });
    this.cancelDrag();
  }

  private cancelDrag(): void {
    if (!this.drag) return;
    this.drag.ghost.remove();
    this.hl.remove();
    document.querySelectorAll('.slot.ok, .slot.bad').forEach((s) => s.classList.remove('ok', 'bad'));
    this.drag = null;
    this.render();
  }
}

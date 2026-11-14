import { STRUCTURES, StructureKind, type Stock } from '../game-sim/components';
import { C2S, type EntityMirror, type NetClient } from '../network';
import type { IsoScene } from '../renderer-isometric';
import { CHUNK_SIZE } from '../world-gen/sector';

const DRAG_THRESHOLD_PX = 5;
const KEY_PAN_PX_PER_SEC = 900;
const BUILD_ORDER = [StructureKind.Wall, StructureKind.Floor, StructureKind.Beacon];

/**
 * RTS-style input for the surface view: box and click selection, right-click
 * orders, blueprint placement and camera keys. It only ever sends orders —
 * nothing here changes game state locally.
 */
export class SurfaceController {
  buildKind: StructureKind | null = null;
  /** Called when the selection or build mode changes, so the HUD can refresh. */
  onChange: (() => void) | null = null;

  private readonly keys = new Set<string>();
  private drag: { button: number; x0: number; y0: number; x: number; y: number; moved: boolean } | null = null;
  private lastChunk = -1;
  private lastBuildTile = -1;
  private pointer = { x: 0, y: 0 };

  constructor(
    private readonly iso: IsoScene,
    private readonly net: NetClient,
    private readonly mirror: EntityMirror,
    private readonly playerId: number,
    private readonly selBox: HTMLElement,
    private readonly stock: () => Stock,
  ) {}

  private ndc(x: number, y: number): [number, number] {
    return [(x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1];
  }

  private selectedUnits(): number[] {
    return [...this.iso.selection];
  }

  setBuild(kind: StructureKind | null): void {
    this.buildKind = this.buildKind === kind ? null : kind;
    if (this.buildKind === null) this.iso.setGhost(null, 0, 0);
    this.onChange?.();
  }

  /** Select every unit the player owns (used on landing and by the Home key). */
  selectAllOwn(): void {
    this.iso.selection.clear();
    for (const e of this.mirror.entities.values()) if (e.state.unit?.owner === this.playerId) this.iso.selection.add(e.state.id);
    this.onChange?.();
  }

  // --- pointer ---------------------------------------------------------------

  pointerDown(ev: PointerEvent): void {
    this.drag = { button: ev.button, x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY, moved: false };
    if (ev.button === 0 && this.buildKind !== null) this.tryPlace(ev.clientX, ev.clientY);
  }

  pointerMove(ev: PointerEvent): void {
    this.pointer = { x: ev.clientX, y: ev.clientY };
    const d = this.drag;
    if (d) {
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
      d.x = ev.clientX; d.y = ev.clientY;
      if (Math.hypot(d.x - d.x0, d.y - d.y0) > DRAG_THRESHOLD_PX) d.moved = true;
      if (d.button === 1) this.iso.pan(dx, dy);
      else if (d.button === 0 && this.buildKind !== null) this.tryPlace(ev.clientX, ev.clientY);
      else if (d.button === 0 && d.moved) {
        const s = this.selBox.style;
        s.display = 'block';
        s.left = Math.min(d.x0, d.x) + 'px'; s.top = Math.min(d.y0, d.y) + 'px';
        s.width = Math.abs(d.x - d.x0) + 'px'; s.height = Math.abs(d.y - d.y0) + 'px';
      }
    }
    this.refreshCursor();
  }

  pointerUp(ev: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.selBox.style.display = 'none';
    this.lastBuildTile = -1;
    if (!d) return;
    if (d.button === 0 && this.buildKind === null) {
      const picked = d.moved
        ? this.iso.unitsInRect(Math.min(d.x0, d.x), Math.min(d.y0, d.y), Math.max(d.x0, d.x), Math.max(d.y0, d.y))
        : [this.iso.unitAtScreen(ev.clientX, ev.clientY)].filter((id): id is number => id !== null);
      if (!ev.shiftKey) this.iso.selection.clear();
      for (const id of picked) this.iso.selection.add(id);
      this.onChange?.();
    } else if (d.button === 2 && !d.moved) {
      if (this.buildKind !== null) this.setBuild(null);
      else this.order(ev.clientX, ev.clientY);
    }
  }

  wheel(ev: WheelEvent): void {
    this.iso.zoom(ev.deltaY);
  }

  /** Right-click: work the node or blueprint under the cursor, otherwise walk there. */
  private order(px: number, py: number): void {
    const units = this.selectedUnits();
    const g = this.iso.groundAt(...this.ndc(px, py));
    if (!g || units.length === 0) return;
    const target = this.iso.targetAtTile(Math.floor(g.x), Math.floor(g.y));
    if (target) {
      this.net.send({ op: C2S.Interact, units, target: target.state.id });
      this.iso.predictMove([], target.state.x, target.state.y, performance.now());
    } else {
      this.net.send({ op: C2S.Move, units, x: g.x, y: g.y });
      // Only the lead unit goes to the exact point, so only its route is predicted.
      this.iso.predictMove(units.slice(0, 1), g.x, g.y, performance.now());
    }
  }

  private tryPlace(px: number, py: number): void {
    const g = this.iso.groundAt(...this.ndc(px, py));
    if (!g || this.buildKind === null) return;
    const tx = Math.floor(g.x), ty = Math.floor(g.y);
    // Dragging paints a run of blueprints, one order per new tile.
    if (tx + ty * 1000 === this.lastBuildTile || !this.iso.canBuildAt(tx, ty)) return;
    this.lastBuildTile = tx + ty * 1000;
    this.net.send({ op: C2S.Build, units: this.selectedUnits(), kind: this.buildKind, tx, ty });
  }

  private refreshCursor(): void {
    const g = this.iso.groundAt(...this.ndc(this.pointer.x, this.pointer.y));
    if (!g) {
      this.iso.setHover(0, 0, false);
      return;
    }
    const tx = Math.floor(g.x), ty = Math.floor(g.y);
    this.iso.setHover(tx, ty, this.buildKind === null);
    if (this.buildKind !== null) this.iso.setGhost(this.buildKind, tx, ty);
  }

  // --- keyboard --------------------------------------------------------------

  keyDown(ev: KeyboardEvent): void {
    const k = ev.key.toLowerCase();
    this.keys.add(k);
    if (k === 'escape') {
      if (this.buildKind !== null) this.setBuild(null);
      else { this.iso.selection.clear(); this.onChange?.(); }
    } else if (k === 'q') this.iso.rotate(1);
    else if (k === 'e') this.iso.rotate(-1);
    else if (k === 'h') this.home();
    else if (k >= '1' && k <= '3') this.setBuild(BUILD_ORDER[Number(k) - 1]);
  }

  keyUp(ev: KeyboardEvent): void {
    this.keys.delete(ev.key.toLowerCase());
  }

  /** Jump the camera to the player's drop pod and select the whole crew. */
  home(): void {
    for (const e of this.mirror.entities.values()) if (e.state.pod?.owner === this.playerId) this.iso.focus(e.state.x, e.state.y);
    this.selectAllOwn();
  }

  // --- frame -----------------------------------------------------------------

  update(dt: number): void {
    const step = KEY_PAN_PX_PER_SEC * dt;
    const has = (...ks: string[]) => ks.some((k) => this.keys.has(k));
    const dx = (has('a', 'arrowleft') ? 1 : 0) - (has('d', 'arrowright') ? 1 : 0);
    const dy = (has('w', 'arrowup') ? 1 : 0) - (has('s', 'arrowdown') ? 1 : 0);
    if (dx || dy) {
      this.iso.pan(dx * step, dy * step);
      this.refreshCursor();
    }
    // Tell the server which chunk we are looking at; it replicates the surrounding square.
    const cx = Math.floor(this.iso.target.x / CHUNK_SIZE), cy = Math.floor(this.iso.target.z / CHUNK_SIZE);
    if (cx + cy * 256 !== this.lastChunk) {
      this.lastChunk = cx + cy * 256;
      this.net.send({ op: C2S.View, cx, cy });
    }
  }

  /** Blueprint buttons for the HUD, greyed out when unaffordable. */
  buildOptions(): { kind: StructureKind; label: string; cost: string; affordable: boolean; active: boolean }[] {
    const stock = this.stock();
    return BUILD_ORDER.map((kind) => {
      const def = STRUCTURES[kind];
      const parts: string[] = [];
      if (def.cost.wood) parts.push(def.cost.wood + ' timber');
      if (def.cost.ore) parts.push(def.cost.ore + ' ore');
      if (def.cost.scrap) parts.push(def.cost.scrap + ' salvage');
      return {
        kind, label: def.name, cost: parts.join(' + '), active: this.buildKind === kind,
        affordable: stock.wood >= def.cost.wood && stock.ore >= def.cost.ore && stock.scrap >= def.cost.scrap,
      };
    });
  }
}

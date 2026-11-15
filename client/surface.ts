import { Status } from '../game-sim/character';
import { EntityKind, TICK_RATE } from '../game-sim/components';
import { BUILD_ORDER, ITEMS, NODES, STRUCTURES, StructureKind } from '../game-sim/items';
import { moveSpeed, moveStep } from '../game-sim/movement';
import { BUILDINGS, BuildingType, PROF_NAMES, VILLAGE_OWNER, WOLF } from '../game-sim/village';
import type { SelfState } from '../game-sim/worldSim';
import { C2S, type EntityMirror, type MirrorEntity, type NetClient } from '../network';
import type { IsoScene } from '../renderer-isometric';
import { wrapDX, wrapDY, wrapX, wrapY } from '../world-gen/surface';
import { hideTooltip, showTooltip, type GameState } from './state';

const STEP = 1 / TICK_RATE;
/** Keep showing the predicted position this long after input stops, while the interpolated mirror catches up. */
const HOLD_MS = 400;

export interface SurfaceHooks {
  /** Build mode or selection changed. */
  onChange(): void;
  /** The player clicked a finished workstation. */
  onStation(e: MirrorEntity): void;
  /** The player clicked the market or the town hall. */
  onVillage(e: MirrorEntity): void;
  /** A key the HUD owns (windows, drink). Return true if handled. */
  onKey(key: string): boolean;
}

/**
 * Input for the surface view: direct WASD movement with client-side
 * prediction, click-to-move and click-to-interact, and blueprint placement.
 *
 * Prediction: each 50 ms step of held movement is sent to the server with a
 * sequence number and applied locally at once using the same movement code
 * the server runs. When the server reports its position and the last input it
 * applied, the client rewinds to that position and replays the inputs still in
 * flight. The character therefore responds immediately, and is still exactly
 * where the server says once the two agree.
 */
export class SurfaceController {
  buildKind: StructureKind | null = null;

  private readonly keys = new Set<string>();
  private pointer = { x: 0, y: 0, down: false };
  private lastBuildTile = -1;
  private seq = 0;
  private acc = 0;
  private pending: { seq: number; dx: number; dy: number }[] = [];
  private readonly pred = { x: 0, y: 0 };
  private readonly shown = { x: 0, y: 0 };
  private predicting = false;
  private holdUntil = 0;
  private facing = 0;
  private wasMoving = false;

  constructor(
    private readonly iso: IsoScene,
    private readonly net: NetClient,
    private readonly mirror: EntityMirror,
    private readonly state: GameState,
    private readonly hooks: SurfaceHooks,
  ) {}

  private ndc(x: number, y: number): [number, number] {
    return [(x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1];
  }

  setBuild(kind: StructureKind | null): void {
    this.buildKind = this.buildKind === kind ? null : kind;
    if (this.buildKind === null) this.iso.setGhost(null, 0, 0);
    this.hooks.onChange();
  }

  // --- prediction -------------------------------------------------------------

  private speed(): number {
    const s = this.state.self;
    if (!s) return 0;
    return moveSpeed(s.tier, this.iso.surface.isWater(this.pred.x, this.pred.y), (s.status & Status.Exhausted) !== 0, (s.status & Status.Sprain) !== 0);
  }

  private applyInput(dx: number, dy: number): void {
    moveStep(this.pred, dx, dy, this.speed() * STEP, (tx, ty) => this.iso.blockedAt(tx, ty));
  }

  /** Authoritative update: rewind to the server's position and replay inputs it has not applied yet. */
  onSelf(self: SelfState): void {
    if (!this.predicting) return;
    this.pending = this.pending.filter((p) => p.seq > self.ack);
    this.pred.x = self.x; this.pred.y = self.y;
    for (const p of this.pending) this.applyInput(p.dx, p.dy);
  }

  // --- pointer ----------------------------------------------------------------

  pointerDown(ev: PointerEvent): void {
    this.pointer.down = true;
    if (ev.button === 2 && this.buildKind !== null) { this.setBuild(null); return; }
    if (ev.button !== 0 && ev.button !== 2) return;
    if (this.buildKind !== null) { this.tryPlace(ev.clientX, ev.clientY); return; }
    const person = this.iso.unitAtScreen(ev.clientX, ev.clientY);
    if (person?.state.unit) {
      const u = person.state.unit;
      if (!u.hero && u.owner === this.state.playerId) { this.iso.selected = person.state.id; this.hooks.onChange(); }
      else if (!u.hero && u.owner === 0) this.net.send({ op: C2S.Interact, target: person.state.id });
      return;
    }
    if (this.iso.selected !== -1) { this.iso.selected = -1; this.hooks.onChange(); }
    const g = this.iso.groundAt(...this.ndc(ev.clientX, ev.clientY));
    if (!g) return;
    const target = this.iso.entityAtTile(Math.floor(g.x), Math.floor(g.y));
    if (target && target.state.kind !== EntityKind.Pod) {
      this.net.send({ op: C2S.Interact, target: target.state.id });
      this.iso.ping(target.state.x, target.state.y);
      if (target.state.structure?.built && target.state.structure.kind !== StructureKind.GardenPlot) this.hooks.onStation(target);
    } else {
      // Clicking a market or town hall opens its books; the hero still walks there.
      const b = this.iso.buildingAt(Math.floor(g.x), Math.floor(g.y));
      if (b?.state.building?.built && (b.state.building.type === BuildingType.Market || b.state.building.type === BuildingType.TownHall)) this.hooks.onVillage(b);
      this.net.send({ op: C2S.MoveTo, x: g.x, y: g.y });
      // Show the route at once from the shared pathfinder; the server's own route replaces it.
      this.iso.showPredictedRoute(this.iso.planRoute(g.x, g.y), performance.now());
      this.iso.ping(g.x, g.y);
    }
  }

  pointerMove(ev: PointerEvent): void {
    this.pointer.x = ev.clientX; this.pointer.y = ev.clientY;
    if (this.pointer.down && this.buildKind !== null) this.tryPlace(ev.clientX, ev.clientY);
    this.refreshCursor(true);
  }

  pointerUp(): void {
    this.pointer.down = false;
    this.lastBuildTile = -1;
  }

  wheel(ev: WheelEvent): void {
    this.iso.zoom(ev.deltaY);
  }

  private tryPlace(px: number, py: number): void {
    const g = this.iso.groundAt(...this.ndc(px, py));
    if (!g || this.buildKind === null) return;
    const tx = Math.floor(g.x), ty = Math.floor(g.y);
    // Dragging paints a run of blueprints, one order per new tile.
    if (tx + ty * 4096 === this.lastBuildTile || !this.iso.canBuildAt(tx, ty)) return;
    this.lastBuildTile = tx + ty * 4096;
    this.net.send({ op: C2S.Build, kind: this.buildKind, tx, ty });
  }

  /** What is under the cursor, in words. */
  private describe(e: MirrorEntity): string {
    const s = e.state;
    if (s.node) {
      const def = NODES[s.node.kind];
      return def.name + '\n' + (def.tool ? (def.bare === 'none' ? 'Needs a ' : 'Faster with a ') + def.tool : 'Gather by hand') + '\nClick to gather';
    }
    if (s.pile) return s.pile.qty + 'x ' + ITEMS[s.pile.item].name + '\nClick to pick up';
    if (s.structure) {
      const def = STRUCTURES[s.structure.kind];
      if (!s.structure.built) return def.name + ' (unfinished, ' + s.structure.progress + '%)\nClick to work on it';
      if (s.structure.kind === StructureKind.GardenPlot) return def.name + '\n' + ['Empty - click to plant berries', 'Sown', 'Sprouting', 'Ripe - click to harvest'][s.structure.crop];
      return def.name + '\n' + def.desc + (s.structure.kind >= StructureKind.ChoppingBlock ? '\nClick to use' : '');
    }
    if (s.building) {
      const def = BUILDINGS[s.building.type as BuildingType];
      if (!s.building.built) return def.name + ' (being raised, ' + Math.round(s.building.progress) + '%)';
      const books = s.building.type === BuildingType.Market ? '\nClick to trade' : s.building.type === BuildingType.TownHall ? '\nClick for the job board' : '';
      return def.name + '\n' + def.desc + books;
    }
    if (s.unit) {
      if (s.unit.hero) return s.unit.name;
      if (s.unit.prof === WOLF) return 'Wolf\nKeep your distance';
      if (s.unit.owner === VILLAGE_OWNER) return s.unit.name + ', ' + PROF_NAMES[s.unit.prof].toLowerCase();
      if (s.unit.owner === 0) return s.unit.name + ', a drifter\nClick to offer food and recruit';
      return s.unit.name + (s.unit.owner === this.state.playerId ? '\nClick to give orders' : '');
    }
    return 'Landing pod';
  }

  private refreshCursor(tooltip: boolean): void {
    const g = this.iso.groundAt(...this.ndc(this.pointer.x, this.pointer.y));
    if (!g) { this.iso.setHover(0, 0, false); return; }
    const tx = Math.floor(g.x), ty = Math.floor(g.y);
    this.iso.setHover(tx, ty, this.buildKind === null);
    if (this.buildKind !== null) this.iso.setGhost(this.buildKind, tx, ty);
    if (!tooltip) return;
    const over = this.buildKind === null ? (this.iso.unitAtScreen(this.pointer.x, this.pointer.y) ?? this.iso.entityAtTile(tx, ty) ?? this.iso.buildingAt(tx, ty)) : null;
    if (over) showTooltip(this.describe(over), this.pointer.x, this.pointer.y);
    else hideTooltip();
  }

  // --- keyboard ---------------------------------------------------------------

  keyDown(ev: KeyboardEvent): void {
    const k = ev.key.toLowerCase();
    if (ev.repeat) return;
    if (this.hooks.onKey(k)) { ev.preventDefault(); return; }
    this.keys.add(k);
    if (k === 'escape') { if (this.buildKind !== null) this.setBuild(null); }
    else if (k === 'q') this.iso.rotate(1);
    else if (k === 'e') this.iso.rotate(-1);
    else if (k >= '1' && k <= '8') this.setBuild(BUILD_ORDER[Number(k) - 1]);
  }

  keyUp(ev: KeyboardEvent): void {
    this.keys.delete(ev.key.toLowerCase());
  }

  /** Forget held keys, e.g. when a window takes focus. */
  releaseKeys(): void {
    this.keys.clear();
  }

  // --- frame ------------------------------------------------------------------

  update(dt: number, now: number): void {
    const hero = this.mirror.entities.get(this.iso.heroId);
    if (!hero) {
      // Until the character has stepped out of the pod, the camera simply holds on the landing site.
      return;
    }
    const has = (...ks: string[]) => ks.some((k) => this.keys.has(k));
    const sx = (has('d', 'arrowright') ? 1 : 0) - (has('a', 'arrowleft') ? 1 : 0);
    const sy = (has('w', 'arrowup') ? 1 : 0) - (has('s', 'arrowdown') ? 1 : 0);
    const moving = sx !== 0 || sy !== 0;
    // Quantise the direction exactly as it goes on the wire, so client and server step identically.
    let dx = 0, dy = 0;
    if (moving) {
      const [wx, wy] = this.iso.screenToWorldDir(sx, sy);
      const len = Math.hypot(wx, wy);
      dx = Math.round((wx / len) * 127); dy = Math.round((wy / len) * 127);
    }
    if (moving && !this.predicting) {
      // Start predicting from the newest authoritative position rather than the delayed, interpolated one.
      const s = this.state.self;
      this.pred.x = s ? s.x : hero.rx; this.pred.y = s ? s.y : hero.ry;
      this.shown.x = hero.rx; this.shown.y = hero.ry;
      this.predicting = true;
      this.acc = 0;
    }
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      if (!moving && !this.wasMoving) continue;
      // One trailing zero input tells the server the hero has stopped.
      const input = { seq: ++this.seq, dx, dy };
      this.net.send({ op: C2S.Input, ...input });
      this.pending.push(input);
      if (this.pending.length > 40) this.pending.shift();
      this.applyInput(dx, dy);
      this.wasMoving = moving;
      if (moving) { this.facing = Math.atan2(dy, dx); this.holdUntil = now + HOLD_MS; }
    }
    if (this.predicting && !moving && now > this.holdUntil) { this.predicting = false; this.pending.length = 0; }

    if (this.predicting) {
      const k = 1 - Math.exp(-dt * 22);
      this.shown.x = wrapX(this.shown.x + wrapDX(this.pred.x - this.shown.x) * k);
      this.shown.y = wrapY(this.shown.y + wrapDY(this.pred.y - this.shown.y) * k);
      hero.rx = this.shown.x; hero.ry = this.shown.y;
      hero.rfacing = this.facing;
    }
    this.iso.follow(hero.rx, hero.ry, dt);
    if (moving) this.refreshCursor(false);
  }
}

import * as THREE from 'three';
import { LOAD_NAMES, LoadTier, STATUS_NAMES } from '../game-sim/character';
import { Order, ORDER_NAMES, SNAPSHOT_EVERY, UnitState } from '../game-sim/components';
import { BUILD_ORDER, ITEMS, STRUCTURES } from '../game-sim/items';
import { C2S, EntityMirror, NetClient, S2C, type ServerMsg } from '../network';
import { PostFX } from '../renderer-core/postfx';
import { IsoScene } from '../renderer-isometric';
import { OrbitScene } from '../renderer-orbit';
import { BIOME_NAMES, generateSolarSystem, sectorInfo, sectorOfTile, WORLD_H, WORLD_W, type SolarSystem } from '../world-gen';
import { CraftingUI } from './craftingUi';
import { InventoryUI } from './inventoryUi';
import { $, el, hideTooltip, newGameState } from './state';
import { SurfaceController } from './surface';

/**
 * Web client shell: owns the WebGL context, the connection and the top-level
 * flow  boot -> orbit -> descent -> surface (-> orbit).  Rendering lives in
 * the renderer-* modules and game rules on the server; this file wires them
 * to the DOM and keeps the HUD in step with what the server reports.
 */

type Mode = 'boot' | 'orbit' | 'descent' | 'landing' | 'surface' | 'ascent';
type Landed = Extract<ServerMsg, { op: S2C.Landed }>;

const params = new URLSearchParams(location.search);

// --- renderer ----------------------------------------------------------------

const canvas = $<HTMLCanvasElement>('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const post = new PostFX(renderer);
let dpr = 1;

// --- state -------------------------------------------------------------------

let mode: Mode = 'boot';
const state = newGameState();
let homeSector = -1;
let system: SolarSystem | null = null;
let orbit: OrbitScene | null = null;
let iso: IsoScene | null = null;
let surface: SurfaceController | null = null;
let mirror: EntityMirror | null = null;
let currentSector = -1;
let roster: { id: number; name: string }[] = [];
const sectorStats = new Map<number, { online: number; colonies: number }>();
/** Seconds into the current mode, for the cloud transitions. */
let fade = 0;
let pendingLanding: Landed | null = null;

// One identity per tab, so two tabs are two players and a reload resumes the same character.
let token = sessionStorage.getItem('exo-token');
if (!token) {
  token = crypto.randomUUID();
  sessionStorage.setItem('exo-token', token);
}
const net = new NetClient((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
const send = net.send.bind(net);
const inventoryUi = new InventoryUI(state, send);
const craftingUi = new CraftingUI(state, send);

// --- boot --------------------------------------------------------------------

const callsign = $<HTMLInputElement>('callsign');
callsign.value = params.get('name') ?? localStorage.getItem('exo-name') ?? 'Settler-' + Math.floor(100 + Math.random() * 900);

function enter(): void {
  const name = callsign.value.trim() || 'Settler';
  localStorage.setItem('exo-name', name);
  $('boot-status').textContent = 'Hailing the ship...';
  $<HTMLButtonElement>('enter').disabled = true;
  net.onOpen = () => net.send({ op: C2S.Hello, token: token!, name });
  net.onClose = () => {
    if (mode === 'boot') $('boot-status').textContent = 'No answer - trying again...';
    else toast('Connection lost - reconnecting');
  };
  net.onMessage = onMessage;
  net.connect();
}
$('enter').addEventListener('click', enter);
callsign.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') enter(); });
if (params.has('auto')) enter();

// --- network -----------------------------------------------------------------

function onMessage(m: ServerMsg): void {
  switch (m.op) {
    case S2C.Welcome: {
      state.playerId = m.playerId;
      homeSector = m.homeSector;
      if (!orbit) {
        state.seed = m.seed;
        mirror = new EntityMirror(m.tickRate, SNAPSHOT_EVERY, WORLD_W, WORLD_H);
        system = generateSolarSystem(m.seed);
        $('boot-status').textContent = 'Charting the system...';
        // Let the status paint before the planet maps bake (a few hundred ms of CPU).
        setTimeout(() => {
          orbit = new OrbitScene(system!, m.seed);
          setMode('orbit');
          if (homeSector >= 0) orbit.selected = homeSector;
          const land = params.get('land');
          if (land !== null) deploy(Number(land));
        }, 30);
      } else if (mode === 'surface' || mode === 'landing') {
        // Reconnected mid-game: the server kept the character, so just ask to be put back.
        net.send({ op: C2S.Land, sector: currentSector });
      }
      break;
    }
    case S2C.SectorStats:
      sectorStats.clear();
      for (const s of m.sectors) sectorStats.set(s.sector, s);
      orbit?.setSectorStats(sectorStats);
      break;
    case S2C.Landed:
      // Entities start streaming right after this message, before the surface scene exists,
      // so the mirror collects them from here on and the scene adopts them when it is built.
      mirror?.reset();
      if (mode !== 'surface') pendingLanding = m;
      break;
    case S2C.Snapshot:
      if (iso || pendingLanding) mirror?.apply(m, performance.now());
      break;
    case S2C.Self:
      state.self = m.self;
      surface?.onSelf(m.self);
      break;
    case S2C.Inventory:
      state.inventory.items = m.items;
      inventoryUi.invalidate();
      craftingUi.invalidate();
      refreshBuildBar();
      break;
    case S2C.Skills:
      state.skills = m.xp;
      inventoryUi.invalidate();
      break;
    case S2C.Craft:
      state.craft = m.session;
      craftingUi.invalidate();
      if (m.session && !craftingUi.open) craftingUi.toggle(true);
      break;
    case S2C.Roster:
      roster = m.players;
      $('roster').replaceChildren(...roster.slice(0, 8).map((p) => el('li', p.id === state.playerId ? 'me' : '', p.name + (p.id === state.playerId ? ' (you)' : ''))));
      break;
    case S2C.Notice:
      toast(m.text);
      break;
  }
}

// --- flow --------------------------------------------------------------------

function setMode(next: Mode): void {
  mode = next;
  fade = 0;
  $('boot').hidden = next !== 'boot';
  $('orbit-ui').hidden = next !== 'orbit';
  $('entry-ui').hidden = next !== 'descent' && next !== 'landing';
  $('surface-ui').hidden = next !== 'surface';
  $('plates').hidden = next !== 'surface';
  hideTooltip();
  if (next === 'orbit') refreshSectorPanel();
}

function deploy(sector: number): void {
  if (!orbit || mode !== 'orbit') return;
  if (homeSector < 0 && !sectorInfo(state.seed, sector).landable) return;
  currentSector = homeSector >= 0 ? homeSector : sector;
  pendingLanding = null;
  orbit.hovered = -1;
  orbit.beginDescent(currentSector);
  setMode('descent');
}

function beginSurface(m: Landed): void {
  currentSector = homeSector = m.sector;
  iso = new IsoScene({
    seed: state.seed, playerId: state.playerId, plateRoot: $('plates'),
    ownerName: (id) => roster.find((p) => p.id === id)?.name ?? 'settler ' + id,
  });
  iso.resize(window.innerWidth, window.innerHeight, dpr);
  iso.focus(m.x, m.y);
  iso.startIntro();
  mirror!.onSpawn = (e) => iso?.spawn(e);
  mirror!.onChange = (e) => iso?.change(e);
  mirror!.onDespawn = (e) => iso?.despawn(e);
  for (const e of mirror!.entities.values()) iso.spawn(e);
  surface = new SurfaceController(iso, net, mirror!, state, {
    onChange: () => { refreshBuildBar(); refreshFollower(); },
    onStation: (e) => craftingUi.toggle(true, e),
    onKey: hudKey,
  });
  setMode('surface');
  refreshBuildBar();
  refreshFollower();
}

function leaveSurface(): void {
  if (mode !== 'surface') return;
  net.send({ op: C2S.Leave });
  inventoryUi.toggle(false);
  craftingUi.toggle(false);
  setMode('ascent');
}
$('leave').addEventListener('click', leaveSurface);

// --- HUD ---------------------------------------------------------------------

let toastTimer = 0;
function toast(text: string): void {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600);
}

/** Keys that open windows or act on the character, whatever else is going on. */
function hudKey(k: string): boolean {
  if (k === 'tab' || k === 'i' || k === 'c') inventoryUi.toggle();
  else if (k === 'k') craftingUi.toggle();
  else if (k === 'f') net.send({ op: C2S.Drink });
  else if (k === 'escape' && (inventoryUi.open || craftingUi.open)) { inventoryUi.toggle(false); craftingUi.toggle(false); }
  else return false;
  surface?.releaseKeys();
  return true;
}
$('btn-char').addEventListener('click', () => inventoryUi.toggle());
$('btn-craft').addEventListener('click', () => craftingUi.toggle());
$('btn-drink').addEventListener('click', () => net.send({ op: C2S.Drink }));
document.querySelectorAll<HTMLElement>('[data-close]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.close === 'char-window') inventoryUi.toggle(false); else craftingUi.toggle(false);
}));

function refreshSectorPanel(): void {
  if (!orbit || !system) return;
  $('sys-name').textContent = system.starName + ' system';
  let online = 0, colonies = 0;
  for (const s of sectorStats.values()) { online += s.online; colonies += s.colonies; }
  $('sys-sub').textContent = system.planets[system.home].name + ' · ' + colonies + ' landings · ' + online + ' on the surface';

  const id = orbit.hovered >= 0 ? orbit.hovered : orbit.selected;
  const btn = $<HTMLButtonElement>('deploy');
  btn.textContent = homeSector >= 0 ? 'Return to the surface' : 'Deploy / Land';
  if (id < 0) {
    $('sec-name').textContent = '-';
    $('sec-biome').textContent = 'Point at the planet to survey';
    for (const k of ['sec-temp', 'sec-colonies', 'sec-online']) $(k).textContent = '';
    for (const k of ['sec-wood', 'sec-ore', 'sec-forage']) $(k).style.width = '0';
    btn.disabled = homeSector < 0;
    $('sec-note').textContent = homeSector >= 0 ? 'Your settler is in sector ' + sectorInfo(state.seed, homeSector).name : '';
    return;
  }
  const info = sectorInfo(state.seed, id);
  const live = sectorStats.get(id);
  $('sec-name').textContent = 'Sector ' + info.name;
  $('sec-biome').textContent = BIOME_NAMES[info.biome];
  $('sec-temp').textContent = info.temperatureC + ' C';
  $('sec-wood').style.width = info.wood + '%';
  $('sec-ore').style.width = info.ore + '%';
  $('sec-forage').style.width = info.forage + '%';
  $('sec-colonies').textContent = String(live?.colonies ?? 0);
  $('sec-online').textContent = String(live?.online ?? 0);

  const sel = orbit.selected;
  btn.disabled = homeSector < 0 && !(sel >= 0 && sectorInfo(state.seed, sel).landable);
  $('sec-note').textContent =
    homeSector >= 0 ? 'Your settler is in sector ' + sectorInfo(state.seed, homeSector).name
      : !info.landable ? 'No stable ground - cannot land here'
        : sel === id ? 'Drop site marked' : 'Click to mark the drop site';
}

function refreshBuildBar(): void {
  if (!surface) return;
  $('build-bar').replaceChildren(...BUILD_ORDER.map((kind, i) => {
    const def = STRUCTURES[kind];
    const cost = def.cost.map((c) => c.qty + ' ' + ITEMS[c.item].name.toLowerCase()).join(', ') || (def.tool ? 'needs a ' + def.tool : 'free');
    const b = el('button', surface!.buildKind === kind ? 'active' : '', (i + 1) + ' ' + def.name, el('small', '', cost));
    b.title = def.desc;
    b.addEventListener('click', () => surface?.setBuild(kind));
    return b;
  }));
}

function refreshFollower(): void {
  const e = iso && iso.selected >= 0 ? mirror?.entities.get(iso.selected) : undefined;
  $('follower-panel').hidden = !e?.state.unit;
  if (!e?.state.unit) return;
  const u = e.state.unit;
  $('fol-name').textContent = u.name;
  $('fol-orders').replaceChildren(...ORDER_NAMES.map((name, order) => {
    const b = el('button', u.order === order ? 'active' : '', name);
    b.addEventListener('click', () => { net.send({ op: C2S.Order, npc: e.state.id, order: order as Order }); window.setTimeout(refreshFollower, 300); });
    return b;
  }));
}

const WORK_LABELS: Record<UnitState, string> = {
  [UnitState.Idle]: '', [UnitState.Moving]: '', [UnitState.Harvesting]: 'Gathering', [UnitState.Building]: 'Building', [UnitState.Crafting]: 'Working',
};

/** Vitals, location and the work bar; cheap enough to run a few times a second. */
function refreshHud(): void {
  const s = state.self;
  if (!s || !iso) return;
  const bar = (id: string, pct: number, text: string, warn = false) => {
    $('v-' + id).style.width = Math.max(0, Math.min(100, pct)) + '%';
    $('v-' + id).parentElement!.classList.toggle('warn', warn);
    $('t-' + id).textContent = text;
  };
  bar('hp', s.hp, Math.round(s.hp) + '', s.hp < 30);
  bar('sat', s.satiety, Math.round(s.satiety) + '', s.satiety < 20);
  bar('hyd', s.hydration, Math.round(s.hydration) + '', s.hydration < 20);
  bar('sta', s.stamina, Math.round(s.stamina) + '', s.stamina < 15);
  bar('temp', ((s.temp - 32) / 10) * 100, s.temp.toFixed(1) + ' C', s.temp < 35.2 || s.temp > 38.8);
  bar('load', (s.kg / s.capacity) * 100, s.kg.toFixed(1) + '/' + s.capacity.toFixed(0) + ' kg', s.tier >= LoadTier.Heavy);
  const chips = STATUS_NAMES.filter(([flag]) => s.status & flag).map(([, name, desc]) => { const c = el('span', 'chip', name); c.title = desc; return c; });
  if (s.tier > LoadTier.Light) chips.push(el('span', 'chip mild', LOAD_NAMES[s.tier] + ' load'));
  $('status-chips').replaceChildren(...chips);

  const info = sectorInfo(state.seed, sectorOfTile(s.x, s.y));
  $('loc-name').textContent = 'Sector ' + info.name;
  $('loc-sub').textContent = BIOME_NAMES[iso.surface.biome(s.x, s.y)] + ' · ' + s.ambient + ' C · ' + Math.floor(s.x) + ', ' + Math.floor(s.y);

  const hero = mirror?.entities.get(iso.heroId)?.state.unit;
  const label = hero ? WORK_LABELS[hero.state] : '';
  $('workbar').hidden = !label || s.work <= 0;
  $('work-label').textContent = label;
  $('work-fill').style.width = s.work + '%';
  inventoryUi.refresh();
  craftingUi.refresh();
}

// --- input routing -----------------------------------------------------------

let orbitDrag: { button: number; x: number; y: number; moved: boolean } | null = null;
const ndc = (ev: { clientX: number; clientY: number }): [number, number] =>
  [(ev.clientX / window.innerWidth) * 2 - 1, -(ev.clientY / window.innerHeight) * 2 + 1];

canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  if (mode === 'orbit') orbitDrag = { button: ev.button, x: ev.clientX, y: ev.clientY, moved: false };
  else if (mode === 'surface' && !iso?.introActive) surface?.pointerDown(ev);
});
canvas.addEventListener('pointermove', (ev) => {
  if (mode === 'orbit' && orbit) {
    if (orbitDrag) {
      const dx = ev.clientX - orbitDrag.x, dy = ev.clientY - orbitDrag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) orbitDrag.moved = true;
      orbitDrag.x = ev.clientX; orbitDrag.y = ev.clientY;
      if (orbitDrag.button === 0) orbit.rotate(dx, dy);
      else orbit.panBy(dx, dy);
    } else {
      const hit = orbit.pick(...ndc(ev));
      if (hit !== orbit.hovered) { orbit.hovered = hit; refreshSectorPanel(); }
    }
  } else if (mode === 'surface') surface?.pointerMove(ev);
});
canvas.addEventListener('pointerup', (ev) => {
  if (mode === 'orbit' && orbit) {
    if (orbitDrag && !orbitDrag.moved && orbitDrag.button === 0) {
      const hit = orbit.pick(...ndc(ev));
      if (hit >= 0) { orbit.selected = hit; refreshSectorPanel(); }
    }
    orbitDrag = null;
  } else if (mode === 'surface') surface?.pointerUp();
});
canvas.addEventListener('pointerleave', hideTooltip);
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  if (mode === 'orbit') orbit?.zoom(ev.deltaY);
  else if (mode === 'surface') surface?.wheel(ev);
}, { passive: false });
canvas.addEventListener('dblclick', () => { if (mode === 'orbit') orbit?.resetPan(); });
window.addEventListener('contextmenu', (ev) => ev.preventDefault());
window.addEventListener('keydown', (ev) => {
  if (mode === 'surface' && !(ev.target instanceof HTMLInputElement)) surface?.keyDown(ev);
});
window.addEventListener('keyup', (ev) => surface?.keyUp(ev));
window.addEventListener('blur', () => surface?.releaseKeys());
$('deploy').addEventListener('click', () => { if (orbit) deploy(Math.max(0, orbit.selected)); });

function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  // ?res=0.5 renders at half resolution, for weak GPUs and software rasterisers.
  dpr = Math.min(window.devicePixelRatio, 1.5) * Number(params.get('res') ?? 1);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  post.setSize(w, h, dpr);
  if (orbit) { orbit.camera.aspect = w / h; orbit.camera.updateProjectionMatrix(); }
  iso?.resize(w, h, dpr);
}
window.addEventListener('resize', resize);
resize();

// --- main loop ---------------------------------------------------------------

const smooth = (a: number, b: number, v: number) => THREE.MathUtils.smoothstep(v, a, b);
let last = performance.now();
let time = 0;
let netAt = last, netBytes = 0, hudAt = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  time += dt;
  fade += dt;

  if (orbit && (mode === 'orbit' || mode === 'descent' || mode === 'landing')) {
    if (orbit.camera.aspect !== window.innerWidth / window.innerHeight) resize();
    orbit.update(dt);
    post.desaturate = 0; post.vignette = 0.25; post.tint.setRGB(1, 1, 1); post.exposure = 1; post.contrast = 1.04;
    post.cloud = 0; post.heat = 0;
    if (mode === 'orbit') post.cloud = 1 - smooth(0, 0.8, fade);
    if (mode === 'descent') {
      const k = orbit.descentProgress;
      post.cloud = smooth(0.62, 0.97, k);
      post.heat = smooth(0.3, 0.55, k) * (1 - smooth(0.75, 0.95, k)) * 0.9;
      $('entry-alt').textContent = 'ALT ' + Math.max(0.4, 400 * Math.pow(1 - k, 2.4)).toFixed(1) + ' KM';
      if (k >= 1) {
        net.send({ op: C2S.Land, sector: currentSector });
        setMode('landing');
      }
    } else if (mode === 'landing') {
      // Holding inside the cloud deck until the server confirms the drop site.
      post.cloud = 1;
      $('entry-alt').textContent = 'BREAKING THROUGH CLOUD';
      if (pendingLanding) {
        orbit.endDescent();
        beginSurface(pendingLanding);
        pendingLanding = null;
      } else if (fade > 6) {
        toast('Landing request timed out');
        orbit.endDescent();
        setMode('orbit');
      }
    }
    if ((mode as Mode) !== 'surface') post.render(orbit.scene, orbit.camera, time);
  }

  if (iso && mirror && surface && (mode === 'surface' || mode === 'ascent')) {
    mirror.update(now, dt);
    if (mode === 'surface') surface.update(dt, now);
    iso.update(dt, time, now, mirror.serverTick(now));
    const g = iso.grade;
    post.desaturate = g.desaturate; post.vignette = 0.4; post.tint.copy(g.tint); post.exposure = 1.08; post.contrast = 1.1;
    post.heat = 0;
    post.cloud = mode === 'ascent' ? smooth(0, 0.6, fade) : 1 - smooth(0.05, 0.5, iso.introProgress);
    post.render(iso.scene, iso.camera, time);
    if (mode === 'ascent' && fade > 0.7) {
      iso.dispose();
      iso = null;
      surface = null;
      mirror.onSpawn = mirror.onChange = mirror.onDespawn = null;
      mirror.reset();
      $('plates').replaceChildren();
      if (orbit) orbit.selected = homeSector;
      setMode('orbit');
    } else if (now - hudAt > 200) {
      hudAt = now;
      refreshHud();
    }
  }

  if (now - netAt > 1000) {
    const total = net.bytesIn + net.bytesOut;
    $('net').textContent = net.connected
      ? 'RTT ' + net.rttMs.toFixed(0) + ' ms · ' + ((total - netBytes) / 1024).toFixed(1) + ' kB/s' : mode === 'boot' ? '' : 'OFFLINE';
    netBytes = total;
    netAt = now;
    if (mode === 'orbit') refreshSectorPanel();
    if (mode === 'surface') refreshFollower();
  }
}
requestAnimationFrame(frame);

// Handle for automated checks and console poking; not used by the game itself.
Object.assign(window, {
  __game: {
    get mode() { return mode; },
    get iso() { return iso; },
    get orbit() { return orbit; },
    get mirror() { return mirror; },
    get surface() { return surface; },
    state, net,
  },
});

import * as THREE from 'three';
import { SNAPSHOT_EVERY, STARTING_STOCK, UnitState, type Stock } from '../game-sim/components';
import { C2S, EntityMirror, NetClient, S2C, type ServerMsg } from '../network';
import { PostFX } from '../renderer-core/postfx';
import { IsoScene } from '../renderer-isometric';
import { OrbitScene } from '../renderer-orbit';
import { BIOME_NAMES, generateSolarSystem, sectorInfo, type SolarSystem } from '../world-gen';
import { SurfaceController } from './surface';

/**
 * Web client shell: owns the WebGL context, the connection and the top-level
 * flow  boot -> orbit -> descent -> surface (-> orbit).  Rendering lives in
 * the renderer-* modules and game rules on the server; this file only wires
 * them to the DOM.
 */

type Mode = 'boot' | 'orbit' | 'descent' | 'landing' | 'surface' | 'ascent';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

// --- renderer ----------------------------------------------------------------

const canvas = $<HTMLCanvasElement>('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const post = new PostFX(renderer);

// --- state -------------------------------------------------------------------

let mode: Mode = 'boot';
let playerId = 0;
let seed = 0;
let homeSector = -1;
let system: SolarSystem | null = null;
let orbit: OrbitScene | null = null;
let iso: IsoScene | null = null;
let surface: SurfaceController | null = null;
let mirror: EntityMirror | null = null;
let currentSector = -1;
let stock: Stock = { ...STARTING_STOCK };
let roster: { id: number; name: string; online: boolean }[] = [];
const sectorStats = new Map<number, { online: number; colonies: number }>();
/** Seconds into the current fade, for the cloud transitions. */
let fade = 0;
let pendingLanding: Extract<ServerMsg, { op: S2C.Landed }> | null = null;

// One identity per tab, so two tabs are two players and a reload resumes the same colony.
let token = sessionStorage.getItem('exo-token');
if (!token) {
  token = crypto.randomUUID();
  sessionStorage.setItem('exo-token', token);
}
const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
const net = new NetClient(wsUrl);

// --- boot --------------------------------------------------------------------

const callsign = $<HTMLInputElement>('callsign');
callsign.value = params.get('name') ?? localStorage.getItem('exo-name') ?? 'Colonist-' + Math.floor(100 + Math.random() * 900);

function enter(): void {
  const name = callsign.value.trim() || 'Colonist';
  localStorage.setItem('exo-name', name);
  $('boot-status').textContent = 'Linking to command relay…';
  $<HTMLButtonElement>('enter').disabled = true;
  net.onOpen = () => net.send({ op: C2S.Hello, token: token!, name });
  net.onClose = () => {
    if (mode === 'boot') $('boot-status').textContent = 'Relay unreachable — retrying…';
    else toast('Connection lost — reconnecting');
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
      playerId = m.playerId;
      homeSector = m.homeSector;
      if (!orbit) {
        seed = m.seed;
        mirror = new EntityMirror(m.tickRate, SNAPSHOT_EVERY);
        system = generateSolarSystem(seed);
        $('boot-status').textContent = 'Surveying system…';
        // Let the status paint before the planet maps bake (a few hundred ms of CPU).
        setTimeout(() => {
          orbit = new OrbitScene(system!, seed);
          setMode('orbit');
          if (homeSector >= 0) orbit.selected = homeSector;
          const land = params.get('land');
          if (land !== null) deploy(Number(land));
        }, 30);
      } else if (mode === 'surface' || mode === 'landing') {
        // Reconnected mid-game: the server kept the colony, so just ask to be put back.
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
      if (mode === 'surface') break;
      pendingLanding = m;
      break;
    case S2C.Snapshot:
      if (iso || pendingLanding) mirror?.apply(m, performance.now());
      break;
    case S2C.Stock:
      stock = { wood: m.wood, ore: m.ore, scrap: m.scrap };
      refreshSurfaceHud();
      break;
    case S2C.Roster:
      roster = m.players;
      refreshRoster();
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
  if (next === 'orbit') refreshSectorPanel();
}

function deploy(sector: number): void {
  if (!orbit || mode !== 'orbit' || !sectorInfo(seed, sector).landable) return;
  currentSector = homeSector >= 0 ? homeSector : sector;
  pendingLanding = null;
  orbit.hovered = -1;
  orbit.beginDescent(currentSector);
  setMode('descent');
}

function beginSurface(m: Extract<ServerMsg, { op: S2C.Landed }>): void {
  currentSector = homeSector = m.sector;
  const info = sectorInfo(seed, m.sector);
  iso = new IsoScene({
    seed, sectorId: m.sector, biome: info.biome, playerId, plateRoot: $('plates'),
    ownerName: (id) => roster.find((p) => p.id === id)?.name ?? 'Player ' + id,
  });
  iso.resize(window.innerWidth, window.innerHeight);
  iso.focus(m.x, m.y);
  iso.startIntro();
  mirror!.onSpawn = (e) => {
    iso?.spawn(e);
    // The crew steps out a few seconds after touchdown; select them as they appear.
    if (e.state.unit?.owner === playerId && iso && surface) { iso.selection.add(e.state.id); refreshSurfaceHud(); }
  };
  mirror!.onChange = (e) => iso?.change(e);
  mirror!.onDespawn = (e) => iso?.despawn(e);
  for (const e of mirror!.entities.values()) iso.spawn(e);
  surface = new SurfaceController(iso, net, mirror!, playerId, $('selbox'), () => stock);
  surface.onChange = refreshSurfaceHud;
  $('loc-name').textContent = 'Sector ' + info.name;
  $('loc-biome').textContent = BIOME_NAMES[info.biome] + ' · ' + system!.planets[system!.home].name;
  setMode('surface');
  refreshSurfaceHud();
}

function leaveSurface(): void {
  if (mode !== 'surface') return;
  net.send({ op: C2S.Leave });
  setMode('ascent');
}
$('leave').addEventListener('click', leaveSurface);

// --- HUD ---------------------------------------------------------------------

let toastTimer = 0;
function toast(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2200);
}

function refreshSectorPanel(): void {
  if (!orbit || !system) return;
  $('sys-name').textContent = system.starName + ' system';
  let online = 0, colonies = 0;
  for (const s of sectorStats.values()) { online += s.online; colonies += s.colonies; }
  $('sys-sub').textContent = system.planets[system.home].name + ' · ' + colonies + ' colonies · ' + online + ' on surface';

  const id = orbit.hovered >= 0 ? orbit.hovered : orbit.selected;
  const btn = $<HTMLButtonElement>('deploy');
  if (id < 0) {
    $('sec-name').textContent = '—';
    $('sec-biome').textContent = 'Hover the planet to survey';
    for (const k of ['sec-temp', 'sec-colonies', 'sec-online']) $(k).textContent = '';
    for (const k of ['sec-wood', 'sec-ore', 'sec-scrap']) $(k).style.width = '0';
    btn.disabled = true;
    $('sec-note').textContent = '';
    return;
  }
  const info = sectorInfo(seed, id);
  const live = sectorStats.get(id);
  $('sec-name').textContent = info.name;
  $('sec-biome').textContent = BIOME_NAMES[info.biome];
  $('sec-temp').textContent = info.temperatureC + ' °C';
  $('sec-wood').style.width = info.wood + '%';
  $('sec-ore').style.width = info.ore + '%';
  $('sec-scrap').style.width = info.scrap + '%';
  $('sec-colonies').textContent = String(live?.colonies ?? 0);
  $('sec-online').textContent = String(live?.online ?? 0);

  const sel = orbit.selected;
  const selInfo = sel >= 0 ? sectorInfo(seed, sel) : null;
  btn.disabled = !selInfo?.landable;
  btn.textContent = homeSector >= 0 ? 'Return to colony' : 'Deploy / Land';
  $('sec-note').textContent =
    homeSector >= 0 ? 'Your colony is in sector ' + sectorInfo(seed, homeSector).name
      : !info.landable ? 'No stable ground — cannot land here'
        : sel === id ? 'Drop site locked' : 'Click to lock drop site';
}

function refreshRoster(): void {
  $('roster').replaceChildren(...roster.map((p) => {
    const li = document.createElement('li');
    li.className = (p.online ? 'online' : '') + (p.id === playerId ? ' me' : '');
    li.textContent = p.name + (p.id === playerId ? ' (you)' : p.online ? '' : ' — away');
    return li;
  }));
}

const STATE_NAMES: Record<UnitState, string> = {
  [UnitState.Idle]: 'Idle', [UnitState.Moving]: 'Moving', [UnitState.Harvesting]: 'Harvesting', [UnitState.Building]: 'Building',
};

function refreshSurfaceHud(): void {
  if (!iso || !surface || !mirror) return;
  $('st-wood').textContent = String(stock.wood);
  $('st-ore').textContent = String(stock.ore);
  $('st-scrap').textContent = String(stock.scrap);

  const rows: HTMLElement[] = [];
  for (const id of iso.selection) {
    const u = mirror.entities.get(id)?.state.unit;
    if (!u) continue;
    const li = document.createElement('li');
    const name = document.createElement('span'), state = document.createElement('span');
    name.textContent = u.name;
    state.textContent = STATE_NAMES[u.state];
    state.className = 'state';
    li.append(name, state);
    rows.push(li);
  }
  if (rows.length === 0) {
    const li = document.createElement('li');
    li.className = 'dim';
    li.textContent = 'No units selected';
    rows.push(li);
  }
  $('sel-list').replaceChildren(...rows);

  $('build-bar').replaceChildren(...surface.buildOptions().map((o, i) => {
    const b = document.createElement('button');
    b.className = o.active ? 'active' : '';
    b.disabled = !o.affordable;
    b.textContent = '[' + (i + 1) + '] ' + o.label;
    const cost = document.createElement('small');
    cost.textContent = o.cost;
    b.append(cost);
    b.addEventListener('click', () => surface?.setBuild(o.kind));
    return b;
  }));
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
  } else if (mode === 'surface') surface?.pointerUp(ev);
});
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  if (mode === 'orbit') orbit?.zoom(ev.deltaY);
  else if (mode === 'surface') surface?.wheel(ev);
}, { passive: false });
canvas.addEventListener('dblclick', () => { if (mode === 'orbit') orbit?.resetPan(); });
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
window.addEventListener('keydown', (ev) => {
  if (mode === 'surface' && ev.target === document.body) surface?.keyDown(ev);
});
window.addEventListener('keyup', (ev) => surface?.keyUp(ev));
$('deploy').addEventListener('click', () => { if (orbit && orbit.selected >= 0) deploy(orbit.selected); });

function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  // ?res=0.5 renders at half resolution, for weak GPUs and software rasterisers.
  const dpr = Math.min(window.devicePixelRatio, 1.5) * Number(params.get('res') ?? 1);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  post.setSize(w, h, dpr);
  if (orbit) { orbit.camera.aspect = w / h; orbit.camera.updateProjectionMatrix(); }
  iso?.resize(w, h);
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
    post.desaturate = 0.05; post.vignette = 0.3; post.grain = 0.025; post.tint.setRGB(1, 1, 1); post.exposure = 1; post.contrast = 1.04;
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
      $('entry-alt').textContent = 'CLEARING CLOUD DECK';
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
    if (mode === 'surface') surface.update(dt);
    iso.update(dt, time, now, mirror.serverTick(now));
    const pal = iso.palette;
    post.desaturate = pal.desaturate; post.vignette = 0.42; post.grain = 0.055; post.tint.copy(pal.tint); post.exposure = 1.1; post.contrast = 1.22;
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
    } else if (now - hudAt > 250) {
      hudAt = now;
      refreshSurfaceHud();
    }
  }

  if (now - netAt > 1000) {
    const total = net.bytesIn + net.bytesOut;
    $('net').textContent = net.connected
      ? 'RTT ' + net.rttMs.toFixed(0) + ' ms · ' + ((total - netBytes) / 1024).toFixed(1) + ' kB/s' : mode === 'boot' ? '' : 'OFFLINE';
    netBytes = total;
    netAt = now;
    if (mode === 'orbit') refreshSectorPanel();
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
    get stock() { return stock; },
    get playerId() { return playerId; },
    net,
  },
});

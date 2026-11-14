# EXO//COLONY — orbital-to-isometric colony MMO, vertical slice

Start in orbit over a shared procedural planet, survey its sector grid, pick a drop site, dive through the
atmosphere and land in an isometric colony sim where every player in the sector shares one authoritative world:
move units, harvest resources, place blueprints and build.

```
npm run play        # install, build, start  ->  http://localhost:8080
```

Open the URL in two browser tabs (each tab is a separate player), enter a callsign in each and deploy both to
the **same sector**. `PORT` and `WORLD_SEED` are read from the environment.

| Script | What it does |
| --- | --- |
| `npm run play` | Install, build client + server, start the server |
| `npm run dev` | Build and start (no install) |
| `npm test` | Unit tests: ECS, world-gen, pathfinding, protocol, sector simulation, replication |
| `npm run smoke` | Starts a real server and drives two headless clients through land / move / harvest / build |
| `npm run typecheck` | Strict TypeScript over every module |

## How to test

**Orbit and shaders.** Drag to rotate, wheel to zoom (all the way out shows the whole system), right-drag to pan,
double-click to recentre. Look for: the day/night terminator and its warm edge, the blue Fresnel rim, clouds
drifting over the surface with their shadows offset beneath them, ocean sun-glint, and relief shading on
mountain ranges. Hover a sector for biome, climate, resources, colonies and players on the surface; sectors
holding a colony show a ring (amber while someone is down there) and lights on the night side.

**Landing.** Click a landable sector, then **Deploy / Land**. The camera swings over the sector, falls through
the cloud deck with a re-entry glow, and comes out above the generated terrain, easing from top-down into the
isometric angle while the drop pod burns down and the crew steps out.

**Surface.**

- Left-drag: box-select. Left-click: select one unit. `Shift` adds. `H`: jump home and select the crew.
- Right-click ground: move (dotted path and destination box appear immediately). Right-click a tree, ore
  outcrop or salvage pile: harvest it; workers carry on to the next node of that kind.
- `1` / `2` / `3` (or the bar): Wall, Floor Plate, Beacon blueprint. Click or drag to place; selected idle
  units start building and continue through every queued blueprint. `Esc` or right-click leaves build mode.
- `WASD` / arrows / middle-drag: pan. Wheel: zoom. `Q` / `E`: rotate the view a quarter turn.

**Multiplayer.** With two tabs in one sector, each sees the other's pod, crew (amber name plates), paths being
walked, trees disappearing as they are felled and walls going up. Close a tab and its colony keeps working;
reload it and the same player is put back in control.

URL parameters: `?auto` skips the callsign screen, `?name=Ada` sets it, `?land=104` deploys straight to a
sector id, `?res=0.5` halves render resolution for weak GPUs.

## Stack, and why

**TypeScript end to end: a Node.js authoritative server and a WebGL2 browser client, with the engine written
from scratch.** The only runtime dependencies are `ws` (the WebSocket framing) and `three` (used as a thin
WebGL layer: scene graph, buffers, shadow maps). There is no game framework, no ECS library, no networking
library and no physics engine; the ECS, tick loop, spatial grid, binary protocol, area-of-interest
replication, interpolation, pathfinding, world generation and all planetary/atmospheric shaders are in this
repository.

- **One language for simulation on both sides.** The client runs the *same* terrain generator and pathfinder
  as the server. Terrain is therefore never sent over the wire (a sector is derived from seed + id), and the
  client can plan a route locally the instant you click instead of waiting a round trip.
- **Load model.** Sectors share no state, so each `SectorSim` is an island: the server is a router plus N
  independent simulations. Today they tick on one thread; because nothing crosses a sector boundary, moving
  them onto worker threads or separate processes is a deployment change, not a redesign. Per-client cost is
  bounded by chunk-based interest management and delta snapshots (a quiet view costs 11 bytes per snapshot,
  a walking unit 9 bytes).
- **Honest limits.** One Node process will not carry "massive" concurrency on a single core, and a
  Rust/Go/JVM server would have more headroom per sector. That trade was made deliberately for a vertical
  slice: shared deterministic code and zero build friction, with the sim kept free of Node and browser APIs
  (`core-ecs`, `game-sim`, `world-gen` import neither) so a hot sector loop can be ported later without
  touching the protocol or the client.

## Module map

```
core-ecs/            Entities, component stores, ordered systems, fixed tick loop, chunk grid, seeded RNG
world-gen/           Noise, solar system, planet climate + sector grid, per-sector tile/height/resource maps
game-sim/            Components, A* + path smoothing, SectorSim (commands -> pods -> jobs -> movement)
network/             Byte reader/writer, wire protocol, AOI delta replicator, snapshot interpolation, client socket
server/              HTTP static host + /ws endpoint, player sessions, sector instancing, snapshot fan-out
renderer-core/       Shared GLSL noise/cloud functions, HDR post pipeline (tone map, grade, entry overlay)
renderer-orbit/      Star, planets, rings, sky; home-planet terrain/cloud/atmosphere shaders; sector picking; dive
renderer-isometric/  Terrain mesh, instanced props, units/pods/structures, layered haze, tactical overlays
client/              App shell: boot -> orbit -> descent -> surface flow, HUD, RTS input
tests/, scripts/     Unit tests and the two-client end-to-end smoke test
```

### Simulation and netcode

- **Tick.** 20 Hz fixed step against absolute deadlines (no drift), with bounded catch-up. Orders are queued and
  applied at the start of a tick; all randomness is seeded.
- **Protocol.** One opcode byte, then a fixed little-endian layout. Positions are 8.8 fixed point, angles one byte.
  Malformed packets close the socket; inbound messages are rate-limited and every order is checked against unit
  ownership on the server.
- **Area of interest.** A client reports the chunk its camera is over and receives the surrounding 7x7 chunks plus
  its own units wherever they are. The replicator remembers what each client has and sends full records only on
  enter/change, position-only records for movers, and ids on leave.
- **Client smoothing.** Snapshots are stamped with server time and rendered ~150 ms in the past, interpolating
  between the bracketing samples. Move orders are predicted at the *route* level (path and destination marker
  appear instantly from the shared pathfinder); unit motion itself is not predicted and follows the server.
- **Persistence.** World state lives in server memory: colonies survive disconnects and keep working, but a
  server restart resets the world. There is no database yet.

### Rendering

- **Planet.** Climate (elevation, moisture, temperature) is one pure function of seed and direction. The server
  classifies sectors with it; the client bakes it to a 1024x512 map that the shader samples and then refines
  with procedural detail, so orbit visuals and sector biomes cannot disagree. Vertex displacement gives real
  relief; normals come from the elevation gradient plus fine bump. Clouds are a separate shell above the
  surface (so they parallax), and the surface shader samples the same cloud function offset toward the sun
  for their shadows.
- **Sectors** are a 32x16 latitude/longitude grid (512 quads) rather than a hex/geodesic tiling: the same three
  lines of maths run in the shader, the picker and the server. Polar quads are small; they are ice and not
  landable.
- **Surface.** A real 3D scene (heightfield, instanced meshes, shadow-mapped sun) under an orthographic camera at
  a fixed isometric pitch. Haze is three drifting noise sheets at different heights plus dust motes, not a
  ray-marched volume. Final grade: filmic tone map, desaturation, contrast, vignette and grain.

## Known gaps

No combat, hunger or AI factions; units have health bars but nothing damages them. No touch controls. One
colony per player. Sector edges are hard borders — walking between sectors is not implemented. Audio is absent.

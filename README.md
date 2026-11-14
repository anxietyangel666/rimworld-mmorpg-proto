# Exo Colony — orbital-to-isometric survival MMO, vertical slice

Survey a shared procedural planet from orbit, pick a drop site, fall through the atmosphere and step out as one
settler on a continuous world that wraps all the way round. Gather by hand, knap flint into tool heads, lash tools
together, build stations, manage hunger, thirst, temperature and the weight on your back, and talk drifters into
working for you. Every player is on the same authoritative world.

```
npm run play        # install, build, start  ->  http://localhost:8080
```

Open the URL in two browser tabs (each tab is a separate player) and land both in the same sector. `PORT` and
`WORLD_SEED` are read from the environment.

| Script | What it does |
| --- | --- |
| `npm run play` | Install, build client + server, start the server |
| `npm run dev` | Build and start (no install) |
| `npm test` | Unit tests: ECS, world wrapping and seams, pathfinding, inventory grid, weight and vitals, protocol, crafting, followers, replication |
| `npm run smoke` | Starts a real server and drives two headless clients through land / walk / gather / drop / pick up |
| `npm run typecheck` | Strict TypeScript over every module |

## How to play

**Orbit.** Drag to turn the globe, wheel to zoom, right-drag to pan. The planet is drawn as pixel art on a sphere:
hard coastlines, dithered biome and light bands, blocky clouds with matching shadows, a stepped atmospheric rim.
Hover a sector for its survey sheet; click to mark it; **Deploy / Land**.

**Surface.**

- `WASD` / arrows walk (relative to the camera). Click ground to walk there; click a tree, stone, bush, pile or
  blueprint to work on it; click a finished station to use it. `Q` / `E` turn the view, wheel zooms.
- `Tab` (or `I`, `C`) opens the pack: drag items between grids and the paper doll, `R` turns the item in hand,
  right-click eats / drinks / wears, drag out of the window to drop. Green and red outlines show whether it fits.
- `K` opens handwork. `F` drinks when standing by water. `1`-`8` choose a blueprint; click to place; `Esc` cancels.

**A first hour, in order.**

1. Pick sticks off a tree by hand (three, then it needs an axe). Work loose stone for **stone** and **flint**.
   Strip bushes and reeds for **fibre** and **berries**.
2. `K` → *Knife blade* / *Axe head*: chip the pale waste off the flint blank, always from an exposed edge. Strike
   an outlined cell and you use up a slip; run out and the blank shatters.
3. *Twist cordage* (3 fibre), then *Haft flint axe* (head + stick + cordage). Each takes a few seconds of work.
4. With the axe, fell trees for **logs**. A log is 2x4 and 9 kg: it only fits your pockets on its side.
5. Build a **chopping block** (1 log), split logs into planks and firewood, build a **work table**, and make a
   pouch and pack basket — wearing them adds their own storage grids.
6. Dig clay with a shovel, form a pot or crucible cell by cell, fire it in a **pit kiln**; with a pick and a
   **forge**, smelt copper ore and cast better tools.
7. Click a drifter with 3 berries on you to recruit them, then click them to give standing orders: follow, fell
   timber, quarry, forage and farm, build, stay. Gatherers stockpile on the ground where the order was given, and
   materials lying near a blueprint or station are used automatically.

**Circumnavigation.** The world is 1024 x 512 tiles and wraps on both axes. Walk far enough one way and you arrive
back where you started; players either side of the seam see each other normally.

URL parameters: `?auto` skips the name screen, `?name=Ada` sets it, `?land=330` deploys straight to a sector id,
`?res=0.5` halves render resolution for weak GPUs.

## Stack

TypeScript end to end: a Node.js authoritative server and a WebGL2 browser client, with the engine written in this
repository. Runtime dependencies are `ws` (WebSocket framing) and `three` (a thin WebGL layer: scene graph, buffers,
shadow maps). The simulation modules import neither Node nor browser APIs, and the client runs the same terrain
generator, movement step, pathfinder and inventory rules as the server — which is what makes terrain free to
"stream", lets movement be predicted exactly, and lets the inventory colour a placement before the server rules on it.

## Module map

```
core-ecs/            Entities, component stores, ordered systems, fixed tick loop, wrapping chunk grid, seeded RNG
world-gen/           Noise, solar system, planet climate + sector grid, wrapping surface (chunks on demand)
game-sim/            items.ts      item, node, structure, recipe and carving-pattern data
                     inventory.ts  spatial grid inventory, paper doll, stacking, weight
                     character.ts  vitals, status effects, load tiers
                     movement.ts   direct movement step shared by client prediction and server
                     pathfinding.ts A* + smoothing on a wrapping grid
                     worldSim.ts   the world: streaming, heroes, followers, jobs, crafting, crops
network/             Byte codec, wire protocol, AOI delta replicator, wrap-aware interpolation, client socket
server/              HTTP static host + /ws, player sessions, snapshot fan-out
renderer-core/       Shared GLSL (noise, pixel snapping, clouds), HDR post pipeline
renderer-orbit/      Pixel-art planet, clouds, atmosphere, other bodies, sector picking, descent
renderer-isometric/  Chunk-streamed terrain, instanced props, people and structures, haze, tactical overlays
client/              App shell and flow, HUD, input + prediction, inventory UI, crafting UI, icons
tests/, scripts/     Unit tests and the two-client end-to-end smoke test
```

Authority is strict: `client/` and `renderer-*` never change game state. They send inputs and orders; everything a
client could forge (inventory moves, carving strikes, recipes, build sites, orders to followers) is validated in
`game-sim` on the server.

## How the pieces work

- **One wrapping world.** Tile x is longitude and y is latitude of the planet's map, so what you see from orbit is
  what you land on; an orbital sector is a 32x32 tile block. Local detail uses lattice noise that repeats exactly at
  the world size, and the poles are forced to the same ice plateau, so both seams are invisible. The trade-off is
  that the surface is a torus, not a sphere: walking north over the pole brings you out at the south.
- **Streaming.** Terrain is a pure function of (seed, chunk) and is never sent. The server instantiates resource
  nodes around players and owned followers and puts them away when nobody is near, remembering depleted and
  half-worked nodes; structures, piles and people persist. The client builds chunk meshes around the camera and
  drops them behind it. The camera lives in unwrapped coordinates and every entity is drawn at its nearest image.
- **Netcode.** 20 Hz fixed tick, 10 Hz delta snapshots of a 7x7-chunk area of interest that wraps with the world.
  Direct movement is sent as sequence-numbered inputs and predicted locally; each server update rewinds to the
  authoritative position and replays unacknowledged inputs. Other entities are interpolated ~150 ms in the past.
- **Stability.** No film grain or other per-frame noise. Ground detail is quantised to world-space texels and faded
  by screen derivatives before it can alias. The orthographic camera is snapped to whole device pixels and the
  shadow frustum to whole shadow texels at a fixed size per zoom band. Haze is a depth-test-free overlay rather
  than sheets cutting through geometry; cloud shadow is part of the ground shader.

## Known gaps

- Combat is a skill on the sheet but nothing trains it yet: there are no hostile creatures.
- Followers have no needs of their own, carry implied crude tools, and cannot be traded with or equipped.
- Direct movement slides along obstacles but stops dead when walked straight into one; click-to-move paths around.
- World state lives in server memory: it survives disconnects, not a server restart.
- One process ticks the whole world. Area-of-interest and streaming bound per-player cost, but a single Node
  process is not a massive-concurrency server; the sim is kept free of Node APIs so it can be moved.
- No touch controls, no audio.

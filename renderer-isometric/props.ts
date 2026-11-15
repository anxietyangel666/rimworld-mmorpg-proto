import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash01 } from '../core-ecs/rng';
import { NODES } from '../game-sim/items';
import { DecorKind, NodeKind, TreeSpecies, type ChunkData } from '../world-gen/surface';
import { MeshBuilder } from './meshBuilder';

const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

/** Bake a flat colour into a geometry's vertices so several parts can merge into one draw call. */
function paint(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

const at = (g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, rz = 0) => {
  g.rotateX(rx); g.rotateZ(rz); g.translate(x, y, z);
  return g;
};
const blob = (r: number, squash = 1) => new THREE.IcosahedronGeometry(r, 0).scale(1, squash, 1);

const TRUNK = srgb(0.3, 0.24, 0.18), STONE = srgb(0.44, 0.43, 0.4);
const PINE = srgb(0.16, 0.25, 0.17), OAK = srgb(0.22, 0.31, 0.15), BIRCH = srgb(0.4, 0.44, 0.2);

/** Conifer: four stacked tiers of drooping boughs. */
function pine(): THREE.BufferGeometry {
  return mergeGeometries([
    paint(at(new THREE.CylinderGeometry(0.07, 0.12, 0.6, 5), 0, 0.3, 0), TRUNK),
    paint(at(new THREE.ConeGeometry(0.52, 0.7, 7), 0, 0.8, 0), PINE.clone().multiplyScalar(0.75)),
    paint(at(new THREE.ConeGeometry(0.42, 0.65, 7), 0, 1.18, 0), PINE.clone().multiplyScalar(0.88)),
    paint(at(new THREE.ConeGeometry(0.31, 0.6, 7), 0, 1.55, 0), PINE),
    paint(at(new THREE.ConeGeometry(0.19, 0.5, 6), 0, 1.92, 0), PINE.clone().multiplyScalar(1.12)),
  ]);
}

/** Broadleaf: a stout trunk under a wide crown built from overlapping masses, darker below and lighter on top. */
function oak(): THREE.BufferGeometry {
  return mergeGeometries([
    paint(at(new THREE.CylinderGeometry(0.11, 0.16, 0.8, 6), 0, 0.4, 0), TRUNK),
    paint(at(new THREE.CylinderGeometry(0.04, 0.06, 0.5, 4), 0.2, 0.85, 0.05, 0, -0.8), TRUNK),
    paint(at(blob(0.56, 0.72), 0, 1.05, 0), OAK.clone().multiplyScalar(0.72)),
    paint(at(blob(0.44, 0.8), 0.34, 1.3, 0.12), OAK.clone().multiplyScalar(0.9)),
    paint(at(blob(0.42, 0.8), -0.3, 1.36, -0.14), OAK),
    paint(at(blob(0.36, 0.8), 0.02, 1.68, 0.02), OAK.clone().multiplyScalar(1.15)),
  ]);
}

/** Birch: a slim pale trunk with dark scars and a narrow, airy crown in three tiers. */
function birch(): THREE.BufferGeometry {
  const bark = srgb(0.78, 0.76, 0.7), scar = srgb(0.16, 0.15, 0.14);
  return mergeGeometries([
    paint(at(new THREE.CylinderGeometry(0.05, 0.075, 1.25, 5), 0, 0.62, 0), bark),
    paint(at(new THREE.BoxGeometry(0.13, 0.05, 0.13), 0, 0.4, 0), scar),
    paint(at(new THREE.BoxGeometry(0.11, 0.04, 0.11), 0, 0.82, 0), scar),
    paint(at(blob(0.36, 0.75), 0.03, 1.25, 0), BIRCH.clone().multiplyScalar(0.8)),
    paint(at(blob(0.3, 0.8), -0.05, 1.58, 0.04), BIRCH),
    paint(at(blob(0.21, 0.9), 0.02, 1.88, -0.02), BIRCH.clone().multiplyScalar(1.15)),
  ]);
}

/** Arid biomes: a bare, wind-bent trunk with two limbs. */
function snag(): THREE.BufferGeometry {
  const bark = srgb(0.38, 0.32, 0.26);
  return mergeGeometries([
    paint(at(new THREE.CylinderGeometry(0.05, 0.1, 1.1, 5), 0, 0.55, 0), bark),
    paint(at(new THREE.CylinderGeometry(0.025, 0.045, 0.6, 4), 0.2, 0.95, 0, 0, -0.9), bark),
    paint(at(new THREE.CylinderGeometry(0.02, 0.04, 0.5, 4), -0.14, 1.15, 0.05, 0.3, 0.7), bark),
  ]);
}

function stones(): THREE.BufferGeometry {
  return mergeGeometries([
    paint(at(new THREE.DodecahedronGeometry(0.2), 0.05, 0.12, 0), STONE),
    paint(at(new THREE.DodecahedronGeometry(0.14), -0.22, 0.08, 0.12), STONE.clone().multiplyScalar(0.8)),
    paint(at(new THREE.DodecahedronGeometry(0.11), 0.18, 0.06, -0.2), srgb(0.2, 0.21, 0.23)),
  ]);
}

function ore(): THREE.BufferGeometry {
  const rock = srgb(0.3, 0.32, 0.34), vein = srgb(0.3, 0.5, 0.42);
  return mergeGeometries([
    paint(at(new THREE.DodecahedronGeometry(0.34), 0, 0.22, 0), rock),
    paint(at(new THREE.DodecahedronGeometry(0.22), 0.3, 0.14, 0.14), vein),
    paint(at(new THREE.DodecahedronGeometry(0.18), -0.2, 0.12, -0.24), rock),
    paint(at(new THREE.OctahedronGeometry(0.14), -0.05, 0.5, 0.05), vein),
  ]);
}

function clay(): THREE.BufferGeometry {
  return mergeGeometries([
    paint(at(new THREE.SphereGeometry(0.42, 8, 5).scale(1, 0.4, 0.85), 0, 0.08, 0), srgb(0.5, 0.31, 0.24)),
    paint(at(new THREE.SphereGeometry(0.2, 6, 4).scale(1, 0.5, 1), 0.2, 0.2, 0.1), srgb(0.56, 0.36, 0.27)),
  ]);
}

function bush(): THREE.BufferGeometry {
  const leaf = srgb(0.24, 0.31, 0.17), berry = srgb(0.5, 0.14, 0.2);
  const parts = [paint(at(blob(0.3), 0, 0.26, 0), leaf), paint(at(blob(0.22), 0.22, 0.2, 0.12), leaf.clone().multiplyScalar(0.85))];
  for (const [x, y, z] of [[0.1, 0.48, 0.14], [-0.2, 0.36, 0.12], [0.28, 0.34, -0.05], [-0.05, 0.4, -0.24]]) {
    parts.push(paint(at(new THREE.OctahedronGeometry(0.055), x, y, z), berry));
  }
  return mergeGeometries(parts);
}

function reeds(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) {
    const a = i * 2.4, r = 0.08 + (i % 3) * 0.09, h = 0.55 + (i % 4) * 0.14;
    parts.push(paint(at(new THREE.ConeGeometry(0.035, h, 4), Math.cos(a) * r, h / 2, Math.sin(a) * r, Math.sin(a) * 0.12, Math.cos(a) * 0.12), srgb(0.5, 0.5, 0.28)));
  }
  return mergeGeometries(parts);
}

function boulder(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 1);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    // Displace by a hash of the quantised position so shared corners move together.
    const k = 0.78 + hash01(Math.round(p.getX(i) * 50), Math.round(p.getY(i) * 50), Math.round(p.getZ(i) * 50)) * 0.44;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.75, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return paint(g, STONE);
}

// --- undergrowth ----------------------------------------------------------------

function fern(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    parts.push(paint(at(new THREE.ConeGeometry(0.06, 0.34, 3).rotateY(a), Math.cos(a) * 0.1, 0.13, Math.sin(a) * 0.1, Math.sin(a) * 0.75, -Math.cos(a) * 0.75), srgb(0.2, 0.33, 0.16)));
  }
  return mergeGeometries(parts);
}

const DECOR: Record<DecorKind, THREE.BufferGeometry[]> = {
  [DecorKind.Fern]: [fern()],
  [DecorKind.Mushroom]: [srgb(0.55, 0.2, 0.16), srgb(0.5, 0.38, 0.24)].map((cap) => mergeGeometries([
    paint(at(new THREE.CylinderGeometry(0.025, 0.035, 0.12, 5), 0, 0.06, 0), srgb(0.75, 0.72, 0.62)),
    paint(at(new THREE.SphereGeometry(0.075, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.11, 0), cap),
    paint(at(new THREE.CylinderGeometry(0.018, 0.025, 0.08, 5), 0.11, 0.04, 0.05), srgb(0.75, 0.72, 0.62)),
    paint(at(new THREE.SphereGeometry(0.05, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2), 0.11, 0.07, 0.05), cap),
  ])),
  [DecorKind.FallenLog]: [mergeGeometries([
    paint(at(new THREE.CylinderGeometry(0.1, 0.12, 1.0, 6).rotateZ(Math.PI / 2), 0, 0.1, 0), srgb(0.27, 0.21, 0.15)),
    paint(at(new THREE.CylinderGeometry(0.035, 0.05, 0.25, 4), 0.2, 0.22, 0.02, 0, -0.5), srgb(0.27, 0.21, 0.15)),
    paint(at(blob(0.1, 0.45), -0.25, 0.2, 0), srgb(0.28, 0.36, 0.2)),
  ])],
  [DecorKind.Pebbles]: [mergeGeometries([
    paint(at(new THREE.DodecahedronGeometry(0.07), 0, 0.03, 0), STONE),
    paint(at(new THREE.DodecahedronGeometry(0.05), 0.14, 0.02, 0.08), STONE.clone().multiplyScalar(0.75)),
    paint(at(new THREE.DodecahedronGeometry(0.04), -0.1, 0.02, 0.12), srgb(0.22, 0.23, 0.25)),
  ])],
  [DecorKind.Tuft]: [mergeGeometries([0, 1, 2, 3].map((i) =>
    paint(at(new THREE.ConeGeometry(0.03, 0.22 + i * 0.03, 3), Math.cos(i * 1.7) * 0.06, 0.1, Math.sin(i * 1.7) * 0.06, Math.sin(i * 1.7) * 0.3, -Math.cos(i * 1.7) * 0.3), srgb(0.42, 0.44, 0.24))))],
  [DecorKind.Flower]: [srgb(0.85, 0.82, 0.7), srgb(0.8, 0.66, 0.25), srgb(0.52, 0.4, 0.6)].map((petal) => mergeGeometries([
    paint(at(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 3), 0, 0.1, 0), srgb(0.3, 0.4, 0.2)),
    paint(at(new THREE.OctahedronGeometry(0.05), 0, 0.22, 0), petal),
    paint(at(new THREE.CylinderGeometry(0.012, 0.012, 0.14, 3), 0.09, 0.07, 0.05), srgb(0.3, 0.4, 0.2)),
    paint(at(new THREE.OctahedronGeometry(0.04), 0.09, 0.16, 0.05), petal),
  ])),
};

type Skip = (lx: number, ly: number) => boolean;

/** A chunk's undergrowth merged into one mesh. `skip` drops whatever a road or building has replaced. */
export function buildDecor(data: ChunkData, material: THREE.Material, heightAt: (x: number, y: number) => number, skip: Skip): THREE.Mesh | null {
  const mb = new MeshBuilder();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  for (const d of data.decor) {
    if (skip(Math.floor(d.x), Math.floor(d.y))) continue;
    const variants = DECOR[d.kind];
    q.setFromAxisAngle(up, d.rot);
    p.set(d.x, heightAt(d.x, d.y) - 0.01, d.y);
    mb.add(variants[Math.floor(d.rot * 7) % variants.length], m.compose(p, q, s.setScalar(d.scale * 1.25)));
  }
  if (mb.empty) return null;
  const mesh = new THREE.Mesh(mb.build(), material);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

const BOULDER_GEO = boulder();

export function makeBoulders(data: ChunkData, material: THREE.Material, heightAt: (x: number, y: number) => number, skip: Skip): THREE.InstancedMesh | null {
  const list = data.boulders.filter((b) => !skip(Math.floor(b.x), Math.floor(b.y)));
  if (list.length === 0) return null;
  const mesh = new THREE.InstancedMesh(BOULDER_GEO, material, list.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  list.forEach((b, i) => {
    q.setFromEuler(new THREE.Euler(b.rot * 0.2, b.rot, 0));
    s.set(b.scale, b.scale * (0.7 + (b.rot % 1) * 0.5), b.scale);
    p.set(b.x, heightAt(b.x, b.y) + b.scale * 0.12, b.y);
    mesh.setMatrixAt(i, m.compose(p, q, s));
  });
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

// --- resource nodes ---------------------------------------------------------------

/** Mesh slots: the six node kinds, then the other tree species. */
const SLOT_OAK = 6, SLOT_BIRCH = 7, SLOT_SNAG = 8;
const TREE_SLOT: Record<TreeSpecies, number> = { [TreeSpecies.Pine]: NodeKind.Tree, [TreeSpecies.Oak]: SLOT_OAK, [TreeSpecies.Birch]: SLOT_BIRCH, [TreeSpecies.Snag]: SLOT_SNAG };
const MAX_PER_SLOT = 2048;
/** Trees stand well above a person, so there is something to walk behind. */
const TREE_SCALE = 1.5;

interface NodeRec { slot: number; kind: NodeKind; x: number; y: number; h: number; amount: number }

/**
 * Every replicated resource node, drawn as one instanced mesh per look.
 * Instances are re-packed lazily when the set changes; a node visibly shrinks
 * as it is worked. Vegetation uses the swaying, cut-away material; stone does not.
 */
export class PropLayer {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly nodes = new Map<number, NodeRec>();
  private readonly dirty = new Set<number>();

  constructor(plant: THREE.Material, rock: THREE.Material) {
    const slots: [THREE.BufferGeometry, THREE.Material][] = [
      [pine(), plant], [stones(), rock], [ore(), rock], [clay(), rock], [bush(), plant], [reeds(), plant], [oak(), plant], [birch(), plant], [snag(), plant],
    ];
    for (const [geo, material] of slots) {
      const mesh = new THREE.InstancedMesh(geo, material, MAX_PER_SLOT);
      mesh.count = 0;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** x, y are render-space (unwrapped) coordinates; h is the ground height there. */
  set(id: number, kind: NodeKind, x: number, y: number, h: number, amount: number, species: TreeSpecies): void {
    const slot = kind === NodeKind.Tree ? TREE_SLOT[species] : kind;
    const old = this.nodes.get(id);
    if (old && old.slot !== slot) this.dirty.add(old.slot);
    this.nodes.set(id, { slot, kind, x, y, h, amount });
    this.dirty.add(slot);
  }

  delete(id: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    this.nodes.delete(id);
    this.dirty.add(n.slot);
  }

  flush(): void {
    if (this.dirty.size === 0) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const slot of this.dirty) {
      const mesh = this.meshes[slot];
      let i = 0;
      for (const [id, n] of this.nodes) {
        if (n.slot !== slot || i >= MAX_PER_SLOT) continue;
        const size = (0.85 + hash01(id, 7) * 0.4) * (0.55 + 0.45 * Math.min(1, n.amount / NODES[n.kind].amount)) * (n.kind === NodeKind.Tree ? TREE_SCALE : 1);
        q.setFromAxisAngle(up, hash01(id, 3) * Math.PI * 2);
        p.set(n.x, n.h - 0.03, n.y);
        mesh.setMatrixAt(i++, m.compose(p, q, s.setScalar(size)));
      }
      mesh.count = i;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.dirty.clear();
  }
}

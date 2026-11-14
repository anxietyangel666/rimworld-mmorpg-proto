import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash01 } from '../core-ecs/rng';
import { NODES } from '../game-sim/items';
import { NodeKind, type ChunkData } from '../world-gen/surface';

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

const TRUNK = srgb(0.3, 0.24, 0.18), CANOPY = srgb(0.19, 0.27, 0.16), STONE = srgb(0.44, 0.43, 0.4);

function pine(): THREE.BufferGeometry {
  return mergeGeometries([
    paint(at(new THREE.CylinderGeometry(0.07, 0.11, 0.5, 5), 0, 0.25, 0), TRUNK),
    paint(at(new THREE.ConeGeometry(0.46, 0.85, 6), 0, 0.82, 0), CANOPY.clone().multiplyScalar(0.8)),
    paint(at(new THREE.ConeGeometry(0.35, 0.75, 6), 0, 1.27, 0), CANOPY),
    paint(at(new THREE.ConeGeometry(0.22, 0.6, 6), 0, 1.7, 0), CANOPY),
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
  const g = new THREE.SphereGeometry(0.42, 8, 5);
  g.scale(1, 0.4, 0.85);
  return mergeGeometries([paint(at(g, 0, 0.08, 0), srgb(0.5, 0.31, 0.24)), paint(at(new THREE.SphereGeometry(0.2, 6, 4).scale(1, 0.5, 1), 0.2, 0.2, 0.1), srgb(0.56, 0.36, 0.27))]);
}

function bush(): THREE.BufferGeometry {
  const leaf = srgb(0.24, 0.31, 0.17), berry = srgb(0.5, 0.14, 0.2);
  const parts = [
    paint(at(new THREE.IcosahedronGeometry(0.3, 0), 0, 0.26, 0), leaf),
    paint(at(new THREE.IcosahedronGeometry(0.22, 0), 0.22, 0.2, 0.12), leaf.clone().multiplyScalar(0.85)),
  ];
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

/** Mesh slots: the six node kinds, plus a second look for trees in arid country. */
const SNAG = 6;
const MAX_PER_SLOT = 2048;
const BOULDER_GEO = boulder();

export function makeBoulders(data: ChunkData, material: THREE.Material, heightAt: (x: number, y: number) => number): THREE.InstancedMesh | null {
  if (data.boulders.length === 0) return null;
  const mesh = new THREE.InstancedMesh(BOULDER_GEO, material, data.boulders.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  data.boulders.forEach((b, i) => {
    q.setFromEuler(new THREE.Euler(b.rot * 0.2, b.rot, 0));
    s.set(b.scale, b.scale * (0.7 + (b.rot % 1) * 0.5), b.scale);
    p.set(b.x, heightAt(b.x, b.y) + b.scale * 0.12, b.y);
    mesh.setMatrixAt(i, m.compose(p, q, s));
  });
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

interface NodeRec { slot: number; kind: NodeKind; x: number; y: number; h: number; amount: number }

/**
 * Every replicated resource node, drawn as one instanced mesh per kind.
 * Instances are re-packed lazily when the set changes; a node visibly shrinks
 * as it is worked.
 */
export class PropLayer {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly nodes = new Map<number, NodeRec>();
  private readonly dirty = new Set<number>();

  constructor(readonly material: THREE.MeshStandardMaterial) {
    const geos = [pine(), stones(), ore(), clay(), bush(), reeds(), snag()];
    for (const geo of geos) {
      const mesh = new THREE.InstancedMesh(geo, material, MAX_PER_SLOT);
      mesh.count = 0;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** x, y are render-space (unwrapped) coordinates; h is the ground height there. */
  set(id: number, kind: NodeKind, x: number, y: number, h: number, amount: number, arid: boolean): void {
    const slot = kind === NodeKind.Tree && arid ? SNAG : kind;
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
        const size = (0.85 + hash01(id, 7) * 0.4) * (0.55 + 0.45 * Math.min(1, n.amount / NODES[n.kind].amount));
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

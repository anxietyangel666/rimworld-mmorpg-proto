import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash01 } from '../core-ecs/rng';
import { heightAt, NodeKind, type SectorTerrain } from '../world-gen/sector';
import type { Palette } from './palette';

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

function treeGeometry(pal: Palette): THREE.BufferGeometry {
  if (pal.leafy) {
    const dark = pal.canopy.clone().multiplyScalar(0.8);
    return mergeGeometries([
      paint(at(new THREE.CylinderGeometry(0.07, 0.11, 0.5, 5), 0, 0.25, 0), pal.trunk),
      paint(at(new THREE.ConeGeometry(0.46, 0.85, 6), 0, 0.82, 0), dark),
      paint(at(new THREE.ConeGeometry(0.35, 0.75, 6), 0, 1.27, 0), pal.canopy),
      paint(at(new THREE.ConeGeometry(0.22, 0.6, 6), 0, 1.7, 0), pal.canopy),
    ]);
  }
  // Arid biomes: a bare, wind-bent trunk with two limbs.
  return mergeGeometries([
    paint(at(new THREE.CylinderGeometry(0.05, 0.1, 1.1, 5), 0, 0.55, 0), pal.trunk),
    paint(at(new THREE.CylinderGeometry(0.025, 0.045, 0.6, 4), 0.2, 0.95, 0, 0, -0.9), pal.trunk),
    paint(at(new THREE.CylinderGeometry(0.02, 0.04, 0.5, 4), -0.14, 1.15, 0.05, 0.3, 0.7), pal.trunk),
  ]);
}

function oreGeometry(): THREE.BufferGeometry {
  const stone = srgb(0.3, 0.32, 0.36), vein = srgb(0.58, 0.4, 0.22);
  return mergeGeometries([
    paint(at(new THREE.DodecahedronGeometry(0.34), 0, 0.22, 0), stone),
    paint(at(new THREE.DodecahedronGeometry(0.22), 0.3, 0.14, 0.14), vein),
    paint(at(new THREE.DodecahedronGeometry(0.18), -0.2, 0.12, -0.24), stone),
    paint(at(new THREE.OctahedronGeometry(0.14), -0.05, 0.5, 0.05), vein),
  ]);
}

function scrapGeometry(): THREE.BufferGeometry {
  const rust = srgb(0.42, 0.28, 0.2), steel = srgb(0.33, 0.34, 0.35);
  return mergeGeometries([
    paint(at(new THREE.BoxGeometry(0.75, 0.05, 0.5), 0, 0.2, 0, 0.3, 0.25), steel),
    paint(at(new THREE.BoxGeometry(0.32, 0.26, 0.3), -0.18, 0.13, 0.2), rust),
    paint(at(new THREE.CylinderGeometry(0.13, 0.13, 0.5, 8), 0.2, 0.13, -0.18, Math.PI / 2, 0.4), rust),
    paint(at(new THREE.BoxGeometry(0.06, 0.6, 0.06), 0.1, 0.3, 0.15, 0.5, -0.4), steel),
  ]);
}

function boulderGeometry(pal: Palette): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 1);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    // Displace by a hash of the quantised position so shared corners move together.
    const k = 0.78 + hash01(Math.round(p.getX(i) * 50), Math.round(p.getY(i) * 50), Math.round(p.getZ(i) * 50)) * 0.44;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.75, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return paint(g, pal.boulder);
}

const NODE_FULL: Record<NodeKind, number> = { [NodeKind.Tree]: 20, [NodeKind.Ore]: 30, [NodeKind.Scrap]: 15 };
const MAX_PER_KIND = 4096;

/**
 * All resource nodes and boulders, drawn as one instanced mesh per kind.
 * Node instances are rebuilt lazily whenever the replicated set changes; a
 * node visibly shrinks as it is harvested.
 */
export class PropLayer {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<NodeKind, THREE.InstancedMesh>();
  private readonly nodes = new Map<number, { kind: NodeKind; x: number; y: number; amount: number }>();
  private readonly dirty = new Set<NodeKind>();

  constructor(private readonly terrain: SectorTerrain, pal: Palette) {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true });
    const geos: [NodeKind, THREE.BufferGeometry][] = [
      [NodeKind.Tree, treeGeometry(pal)], [NodeKind.Ore, oreGeometry()], [NodeKind.Scrap, scrapGeometry()],
    ];
    for (const [kind, geo] of geos) {
      const mesh = new THREE.InstancedMesh(geo, material, MAX_PER_KIND);
      mesh.count = 0;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.meshes.set(kind, mesh);
      this.group.add(mesh);
    }

    const boulders = new THREE.InstancedMesh(boulderGeometry(pal), material, Math.max(1, terrain.boulders.length));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    terrain.boulders.forEach((b, i) => {
      q.setFromEuler(new THREE.Euler(b.rot * 0.2, b.rot, 0));
      s.set(b.scale, b.scale * (0.7 + (b.rot % 1) * 0.5), b.scale);
      p.set(b.x, heightAt(terrain, b.x, b.y) + b.scale * 0.12, b.y);
      boulders.setMatrixAt(i, m.compose(p, q, s));
    });
    boulders.count = terrain.boulders.length;
    boulders.castShadow = boulders.receiveShadow = true;
    boulders.frustumCulled = false;
    this.group.add(boulders);
  }

  set(id: number, kind: NodeKind, x: number, y: number, amount: number): void {
    this.nodes.set(id, { kind, x, y, amount });
    this.dirty.add(kind);
  }

  delete(id: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    this.nodes.delete(id);
    this.dirty.add(n.kind);
  }

  /** Re-pack instance matrices for any kind whose set changed. */
  flush(): void {
    if (this.dirty.size === 0) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const kind of this.dirty) {
      const mesh = this.meshes.get(kind)!;
      let i = 0;
      for (const [id, n] of this.nodes) {
        if (n.kind !== kind || i >= MAX_PER_KIND) continue;
        const size = (0.8 + hash01(id, 7) * 0.45) * (0.5 + 0.5 * Math.min(1, n.amount / NODE_FULL[kind]));
        q.setFromAxisAngle(up, hash01(id, 3) * Math.PI * 2);
        p.set(n.x, heightAt(this.terrain, n.x, n.y) - 0.03, n.y);
        mesh.setMatrixAt(i++, m.compose(p, q, s.setScalar(size)));
      }
      mesh.count = i;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.dirty.clear();
  }
}

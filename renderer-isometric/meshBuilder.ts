import * as THREE from 'three';

/**
 * Accumulates coloured boxes, quads and transformed prefab geometries into one
 * BufferGeometry, so a whole building, a chunk's undergrowth or a stretch of
 * road is a single draw call. Parts are appended in order, and `mark()` records
 * where each one ends, which lets a building be revealed piece by piece with a
 * draw range.
 */
export class MeshBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly glow: number[] = [];
  private readonly idx: number[] = [];
  /** Index count at each mark(). */
  readonly marks: number[] = [];
  private readonly v = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  private readonly m3 = new THREE.Matrix3();

  get empty(): boolean {
    return this.idx.length === 0;
  }

  mark(): void {
    this.marks.push(this.idx.length);
  }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color, glow: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(c.r, c.g, c.b);
    this.glow.push(glow);
    return this.pos.length / 3 - 1;
  }

  /** Flat quad from four corners given counter-clockwise as seen from its front. */
  quad(a: number[], b: number[], c: number[], d: number[], color: THREE.Color, glow = 0): void {
    const n = this.n.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).cross(this.v.set(d[0] - a[0], d[1] - a[1], d[2] - a[2])).normalize();
    const i = this.vert(a[0], a[1], a[2], n.x, n.y, n.z, color, glow);
    this.vert(b[0], b[1], b[2], n.x, n.y, n.z, color, glow);
    this.vert(c[0], c[1], c[2], n.x, n.y, n.z, color, glow);
    this.vert(d[0], d[1], d[2], n.x, n.y, n.z, color, glow);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  tri(a: number[], b: number[], c: number[], color: THREE.Color): void {
    const n = this.n.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).cross(this.v.set(c[0] - a[0], c[1] - a[1], c[2] - a[2])).normalize();
    const i = this.vert(a[0], a[1], a[2], n.x, n.y, n.z, color, 0);
    this.vert(b[0], b[1], b[2], n.x, n.y, n.z, color, 0);
    this.vert(c[0], c[1], c[2], n.x, n.y, n.z, color, 0);
    this.idx.push(i, i + 1, i + 2);
  }

  /** Axis-aligned box centred on (cx, cz) with its base at y. */
  box(cx: number, y: number, cz: number, sx: number, sy: number, sz: number, color: THREE.Color, glow = 0): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y1 = y + sy, z0 = cz - sz / 2, z1 = cz + sz / 2;
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], color, glow);
    this.quad([x0, y, z1], [x1, y, z1], [x1, y1, z1], [x0, y1, z1], color, glow);
    this.quad([x1, y, z0], [x0, y, z0], [x0, y1, z0], [x1, y1, z0], color, glow);
    this.quad([x1, y, z1], [x1, y, z0], [x1, y1, z0], [x1, y1, z1], color, glow);
    this.quad([x0, y, z0], [x0, y, z1], [x0, y1, z1], [x0, y1, z0], color, glow);
  }

  /** Append a prefab geometry under a transform; `color` overrides its own vertex colours. */
  add(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, color?: THREE.Color): void {
    const p = geo.getAttribute('position'), n = geo.getAttribute('normal'), c = geo.getAttribute('color');
    const base = this.pos.length / 3;
    this.m3.getNormalMatrix(matrix);
    const tint = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      this.v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      this.n.fromBufferAttribute(n, i).applyMatrix3(this.m3).normalize();
      if (color) tint.copy(color); else if (c) tint.fromBufferAttribute(c, i); else tint.setRGB(0.5, 0.5, 0.5);
      this.vert(this.v.x, this.v.y, this.v.z, this.n.x, this.n.y, this.n.z, tint, 0);
    }
    const index = geo.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute('glow', new THREE.Float32BufferAttribute(this.glow, 1));
    geo.setIndex(this.idx);
    return geo;
  }
}

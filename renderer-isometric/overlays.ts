import * as THREE from 'three';
import { heightAt, type SectorTerrain } from '../world-gen/sector';
import { ACCENT } from './palette';

const MAX_PATH_POINTS = 66;

interface PathGfx { line: THREE.Line; box: THREE.LineLoop }

/**
 * World-space tactical overlays: dotted movement paths, wireframe destination
 * boxes, the hovered-tile cursor, build ghosts and order pings. Everything is
 * drawn without depth testing so orders stay readable behind props.
 */
export class TacticalOverlay {
  readonly group = new THREE.Group();
  private readonly paths = new Map<number, PathGfx>();
  private readonly dashed = new THREE.LineDashedMaterial({ color: ACCENT, dashSize: 0.22, gapSize: 0.17, transparent: true, opacity: 0.95, depthTest: false });
  private readonly dashedDim = new THREE.LineDashedMaterial({ color: ACCENT, dashSize: 0.22, gapSize: 0.17, transparent: true, opacity: 0.4, depthTest: false });
  private readonly boxMat = new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.95, depthTest: false });
  private readonly squareGeo: THREE.BufferGeometry;
  private readonly hover: THREE.LineLoop;
  private readonly ghost: THREE.LineSegments;
  private readonly ghostMat = new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true });
  private readonly pings: { mesh: THREE.LineLoop; age: number }[] = [];
  private readonly circleGeo: THREE.BufferGeometry;

  constructor(private readonly terrain: SectorTerrain) {
    const h = 0.42;
    this.squareGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-h, 0, -h), new THREE.Vector3(h, 0, -h), new THREE.Vector3(h, 0, h), new THREE.Vector3(-h, 0, h),
    ]);
    const circle: THREE.Vector3[] = [];
    for (let i = 0; i < 32; i++) circle.push(new THREE.Vector3(Math.cos((i / 32) * Math.PI * 2), 0, Math.sin((i / 32) * Math.PI * 2)));
    this.circleGeo = new THREE.BufferGeometry().setFromPoints(circle);

    this.hover = new THREE.LineLoop(this.squareGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthTest: false }));
    this.hover.scale.setScalar(1.19);
    this.hover.visible = false;
    this.ghost = new THREE.LineSegments(new THREE.BufferGeometry(), this.ghostMat);
    this.ghost.visible = false;
    this.hover.renderOrder = this.ghost.renderOrder = 6;
    this.group.add(this.hover, this.ghost);
  }

  /**
   * Draw (or clear, with pts = null) the route of one unit from its current
   * position. Vertices run destination-first so the dash pattern stays anchored
   * to the ground while the unit end shortens.
   */
  setPath(id: number, x: number, y: number, pts: number[] | null, bright: boolean): void {
    let gfx = this.paths.get(id);
    if (!pts || pts.length < 2) {
      if (gfx) gfx.line.visible = gfx.box.visible = false;
      return;
    }
    if (!gfx) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PATH_POINTS * 3), 3));
      const line = new THREE.Line(geo, this.dashed);
      const box = new THREE.LineLoop(this.squareGeo, this.boxMat);
      line.frustumCulled = false;
      line.renderOrder = box.renderOrder = 6;
      gfx = { line, box };
      this.paths.set(id, gfx);
      this.group.add(line, box);
    }
    const attr = gfx.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const n = Math.min(MAX_PATH_POINTS - 1, pts.length >> 1);
    let o = 0;
    for (let i = n - 1; i >= 0; i--) {
      const px = pts[i * 2], py = pts[i * 2 + 1];
      attr.setXYZ(o++, px, heightAt(this.terrain, px, py) + 0.09, py);
    }
    attr.setXYZ(o++, x, heightAt(this.terrain, x, y) + 0.09, y);
    attr.needsUpdate = true;
    gfx.line.geometry.setDrawRange(0, o);
    gfx.line.computeLineDistances();
    gfx.line.material = bright ? this.dashed : this.dashedDim;
    const dx = pts[n * 2 - 2], dy = pts[n * 2 - 1];
    gfx.box.position.set(dx, heightAt(this.terrain, dx, dy) + 0.09, dy);
    gfx.line.visible = gfx.box.visible = true;
  }

  removePath(id: number): void {
    const gfx = this.paths.get(id);
    if (!gfx) return;
    this.group.remove(gfx.line, gfx.box);
    gfx.line.geometry.dispose();
    this.paths.delete(id);
  }

  setHover(tx: number, ty: number, visible: boolean): void {
    this.hover.visible = visible;
    if (visible) this.hover.position.set(tx + 0.5, heightAt(this.terrain, tx + 0.5, ty + 0.5) + 0.07, ty + 0.5);
  }

  /** Wireframe preview of a structure about to be placed; red when the site is invalid. */
  setGhost(edges: THREE.BufferGeometry | null, tx: number, ty: number, valid: boolean): void {
    this.ghost.visible = !!edges;
    if (!edges) return;
    this.ghost.geometry = edges;
    this.ghost.position.set(tx + 0.5, heightAt(this.terrain, tx + 0.5, ty + 0.5), ty + 0.5);
    this.ghostMat.color.set(valid ? ACCENT : 0xe0493a);
  }

  /** Expanding ring acknowledging an order at a ground point. */
  ping(x: number, y: number, color: number = ACCENT): void {
    const mesh = new THREE.LineLoop(this.circleGeo, new THREE.LineBasicMaterial({ color, transparent: true, depthTest: false }));
    mesh.position.set(x, heightAt(this.terrain, x, y) + 0.1, y);
    mesh.renderOrder = 6;
    this.group.add(mesh);
    this.pings.push({ mesh, age: 0 });
  }

  update(dt: number): void {
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i];
      p.age += dt;
      const k = p.age / 0.45;
      if (k >= 1) {
        this.group.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        this.pings.splice(i, 1);
        continue;
      }
      p.mesh.scale.setScalar(0.15 + k * 0.6);
      (p.mesh.material as THREE.LineBasicMaterial).opacity = 1 - k;
    }
  }
}

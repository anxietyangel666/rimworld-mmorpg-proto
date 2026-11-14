import * as THREE from 'three';
import { ACCENT, WARN } from './palette';

const MAX_PATH_POINTS = 66;

/**
 * World-space tactical overlays: the dotted movement path with its wireframe
 * destination box, the hovered-tile cursor, the build ghost and order pings.
 * Drawn without depth testing so they stay readable behind props.
 *
 * All coordinates passed in are render-space (already unwrapped around the
 * camera); `heightAt` supplies the ground height under them.
 */
export class TacticalOverlay {
  readonly group = new THREE.Group();
  private readonly dashed = new THREE.LineDashedMaterial({ color: ACCENT, dashSize: 0.22, gapSize: 0.17, transparent: true, opacity: 0.95, depthTest: false });
  private readonly line: THREE.Line;
  private readonly box: THREE.LineLoop;
  private readonly hover: THREE.LineLoop;
  private readonly ghost: THREE.LineSegments;
  private readonly ghostMat = new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true });
  private readonly pings: { mesh: THREE.LineLoop; age: number }[] = [];
  private readonly circleGeo: THREE.BufferGeometry;

  constructor(private readonly heightAt: (x: number, y: number) => number) {
    const h = 0.42;
    const square = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-h, 0, -h), new THREE.Vector3(h, 0, -h), new THREE.Vector3(h, 0, h), new THREE.Vector3(-h, 0, h),
    ]);
    const circle: THREE.Vector3[] = [];
    for (let i = 0; i < 32; i++) circle.push(new THREE.Vector3(Math.cos((i / 32) * Math.PI * 2), 0, Math.sin((i / 32) * Math.PI * 2)));
    this.circleGeo = new THREE.BufferGeometry().setFromPoints(circle);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PATH_POINTS * 3), 3));
    this.line = new THREE.Line(geo, this.dashed);
    this.line.frustumCulled = false;
    this.box = new THREE.LineLoop(square, new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.95, depthTest: false }));
    this.hover = new THREE.LineLoop(square, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthTest: false }));
    this.hover.scale.setScalar(1.19);
    this.ghost = new THREE.LineSegments(new THREE.BufferGeometry(), this.ghostMat);
    for (const o of [this.line, this.box, this.hover, this.ghost]) { o.visible = false; o.renderOrder = 6; }
    this.group.add(this.line, this.box, this.hover, this.ghost);
  }

  /**
   * Draw (or clear, with pts = null) a route from (x, y). Vertices run
   * destination-first so the dash pattern stays anchored to the ground while
   * the walker's end shortens.
   */
  setPath(x: number, y: number, pts: number[] | null): void {
    const show = !!pts && pts.length >= 2;
    this.line.visible = this.box.visible = show;
    if (!show) return;
    const attr = this.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const n = Math.min(MAX_PATH_POINTS - 1, pts!.length >> 1);
    let o = 0;
    for (let i = n - 1; i >= 0; i--) attr.setXYZ(o++, pts![i * 2], this.heightAt(pts![i * 2], pts![i * 2 + 1]) + 0.09, pts![i * 2 + 1]);
    attr.setXYZ(o++, x, this.heightAt(x, y) + 0.09, y);
    attr.needsUpdate = true;
    this.line.geometry.setDrawRange(0, o);
    this.line.computeLineDistances();
    const dx = pts![n * 2 - 2], dy = pts![n * 2 - 1];
    this.box.position.set(dx, this.heightAt(dx, dy) + 0.09, dy);
  }

  setHover(x: number, y: number, visible: boolean): void {
    this.hover.visible = visible;
    if (visible) this.hover.position.set(x, this.heightAt(x, y) + 0.07, y);
  }

  /** Wireframe preview of a structure about to be placed; red when the site is invalid. */
  setGhost(edges: THREE.BufferGeometry | null, x: number, y: number, valid: boolean): void {
    this.ghost.visible = !!edges;
    if (!edges) return;
    this.ghost.geometry = edges;
    this.ghost.position.set(x, this.heightAt(x, y), y);
    this.ghostMat.color.set(valid ? ACCENT : WARN);
  }

  /** Expanding ring acknowledging an order at a ground point. */
  ping(x: number, y: number): void {
    const mesh = new THREE.LineLoop(this.circleGeo, new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, depthTest: false }));
    mesh.position.set(x, this.heightAt(x, y) + 0.1, y);
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

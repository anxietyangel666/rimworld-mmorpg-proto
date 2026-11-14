/**
 * Minimal sparse-set style ECS.
 *
 * - Entities are plain integer ids, never reused within a world, so an id can
 *   double as the network id without generation counters.
 * - Each component type owns one Map<Entity, T>. Maps iterate in insertion
 *   order, which keeps every query — and therefore the simulation — deterministic.
 * - Systems run in registration order once per fixed tick.
 */

export type Entity = number;

export interface ComponentType<T> {
  readonly id: number;
  readonly name: string;
  /** Phantom field so T takes part in inference. */
  readonly _t?: T;
}

let nextComponentId = 0;

export function defineComponent<T>(name: string): ComponentType<T> {
  return { id: nextComponentId++, name };
}

export interface System {
  readonly name: string;
  update(world: World, dt: number): void;
}

export class World {
  /** Number of completed simulation ticks. */
  tick = 0;
  /** Called just before an entity's components are dropped. */
  onDestroy: ((e: Entity) => void) | null = null;

  private nextEntity = 1;
  private readonly alive = new Set<Entity>();
  private readonly stores: (Map<Entity, unknown> | undefined)[] = [];
  private readonly doomed: Entity[] = [];
  private readonly systems: System[] = [];

  create(): Entity {
    const e = this.nextEntity++;
    this.alive.add(e);
    return e;
  }

  isAlive(e: Entity): boolean {
    return this.alive.has(e);
  }

  get entityCount(): number {
    return this.alive.size;
  }

  /** Queue an entity for removal at the end of the current step. */
  destroy(e: Entity): void {
    if (this.alive.has(e) && !this.doomed.includes(e)) this.doomed.push(e);
  }

  add<T>(e: Entity, type: ComponentType<T>, value: T): T {
    this.store(type).set(e, value);
    return value;
  }

  get<T>(e: Entity, type: ComponentType<T>): T | undefined {
    return this.stores[type.id]?.get(e) as T | undefined;
  }

  has<T>(e: Entity, type: ComponentType<T>): boolean {
    return this.stores[type.id]?.has(e) ?? false;
  }

  remove<T>(e: Entity, type: ComponentType<T>): void {
    this.stores[type.id]?.delete(e);
  }

  /** Entities holding every listed component, driven by the smallest store. */
  query(...types: ComponentType<unknown>[]): Entity[] {
    let smallest: Map<Entity, unknown> | undefined;
    for (const t of types) {
      const s = this.stores[t.id];
      if (!s) return [];
      if (!smallest || s.size < smallest.size) smallest = s;
    }
    if (!smallest) return [];
    const out: Entity[] = [];
    outer: for (const e of smallest.keys()) {
      for (const t of types) if (!this.stores[t.id]!.has(e)) continue outer;
      out.push(e);
    }
    return out;
  }

  addSystem(system: System): void {
    this.systems.push(system);
  }

  /** Advance one fixed tick: run systems in order, then flush destroyed entities. */
  step(dt: number): void {
    for (const s of this.systems) s.update(this, dt);
    this.flush();
    this.tick++;
  }

  private flush(): void {
    for (const e of this.doomed) {
      this.onDestroy?.(e);
      for (const s of this.stores) s?.delete(e);
      this.alive.delete(e);
    }
    this.doomed.length = 0;
  }

  private store<T>(type: ComponentType<T>): Map<Entity, unknown> {
    return (this.stores[type.id] ??= new Map());
  }
}

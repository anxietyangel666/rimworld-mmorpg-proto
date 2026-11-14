import { levelOf, SKILL_COUNT } from './items';

/** Character condition: vitals, status effects, encumbrance. Pure rules, no ECS or I/O. */

export enum Status {
  Starving = 1, Dehydrated = 2, Exhausted = 4, Cold = 8, Hot = 16, Wet = 32, ScrapedHands = 64, Sprain = 128,
}
export const STATUS_NAMES: [Status, string, string][] = [
  [Status.Starving, 'Starving', 'Losing health. Eat something.'],
  [Status.Dehydrated, 'Dehydrated', 'Losing health. Drink.'],
  [Status.Exhausted, 'Exhausted', 'Moving slowly until stamina recovers.'],
  [Status.Cold, 'Hypothermia', 'Too cold. Find a fire or warmer clothes.'],
  [Status.Hot, 'Heatstroke', 'Too hot. Find water or shade.'],
  [Status.Wet, 'Wet', 'Loses body heat faster.'],
  [Status.ScrapedHands, 'Scraped hands', 'Working slower. Hand wraps prevent this.'],
  [Status.Sprain, 'Sprained ankle', 'Moving slower. Caused by hauling while exhausted.'],
];

export enum LoadTier { Light, Medium, Heavy, Overloaded }
export const LOAD_NAMES = ['Light', 'Medium', 'Heavy', 'Overloaded'];
/** Movement speed and stamina drain multipliers per load tier. */
export const LOAD_SPEED = [1, 0.88, 0.68, 0.4];
export const LOAD_STAMINA = [1, 1.35, 2, 3.2];

/** Maximum comfortable load in kg; grows with the Conditioning attribute. */
export const carryCapacity = (conditioningXp: number) => 24 + 3 * levelOf(conditioningXp);

export function loadTier(kg: number, capacity: number): LoadTier {
  const f = kg / capacity;
  return f > 1 ? LoadTier.Overloaded : f > 0.75 ? LoadTier.Heavy : f > 0.4 ? LoadTier.Medium : LoadTier.Light;
}

export interface Vitals {
  hp: number;
  /** 0 empty .. 100 full. */
  satiety: number;
  hydration: number;
  stamina: number;
  /** Core body temperature in degrees C; 37 is healthy. */
  temp: number;
  status: number;
  /** Seconds left on timed effects. */
  wet: number;
  scraped: number;
  sprain: number;
}

export const newVitals = (): Vitals => ({ hp: 100, satiety: 80, hydration: 80, stamina: 100, temp: 37, status: 0, wet: 0, scraped: 0, sprain: 0 });
export const newSkills = (): number[] => new Array<number>(SKILL_COUNT).fill(0);

export interface VitalsEnv {
  /** Air temperature in degrees C. */
  ambient: number;
  /** Clothing insulation in degrees C. */
  insulation: number;
  shade: boolean;
  nearFire: boolean;
  inWater: boolean;
  moving: boolean;
  working: boolean;
  tier: LoadTier;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const set = (v: Vitals, flag: Status, on: boolean) => { v.status = on ? v.status | flag : v.status & ~flag; };

/** Advance a character's condition by dt seconds. Returns true if they collapsed (hp reached 0). */
export function tickVitals(v: Vitals, dt: number, env: VitalsEnv): boolean {
  const effort = env.working ? 1.5 : env.moving ? 1.25 : 1;
  v.satiety = clamp(v.satiety - (100 / 900) * effort * dt, 0, 100);
  v.hydration = clamp(v.hydration - (100 / 600) * effort * (v.temp > 38 ? 1.6 : 1) * dt, 0, 100);

  if (env.moving) v.stamina -= 1.3 * LOAD_STAMINA[env.tier] * (env.inWater ? 2 : 1) * dt;
  else if (env.working) v.stamina -= 0.5 * dt;
  else v.stamina += (v.satiety > 15 && v.hydration > 15 ? 5 : 1.5) * dt;
  v.stamina = clamp(v.stamina, 0, 100);
  // Hysteresis: once spent, stay exhausted until a quarter has come back.
  if (v.stamina <= 0) set(v, Status.Exhausted, true);
  else if (v.stamina > 25) set(v, Status.Exhausted, false);
  if (env.moving && env.tier === LoadTier.Overloaded && v.status & Status.Exhausted && v.sprain <= 0) v.sprain = 90;

  if (env.inWater) v.wet = 40;
  v.wet = Math.max(0, v.wet - dt);
  v.scraped = Math.max(0, v.scraped - dt);
  v.sprain = Math.max(0, v.sprain - dt);
  set(v, Status.Wet, v.wet > 0);
  set(v, Status.ScrapedHands, v.scraped > 0);
  set(v, Status.Sprain, v.sprain > 0);

  // Felt temperature: clothing only helps against cold, shade only against heat.
  let felt = env.ambient + (env.nearFire ? 16 : 0) - (v.wet > 0 ? 8 : 0);
  if (felt < 18) felt = Math.min(18, felt + env.insulation);
  if (felt > 28 && env.shade) felt -= 4;
  const target = felt < 10 ? 37 - (10 - felt) * 0.16 : felt > 28 ? 37 + (felt - 28) * 0.28 : 37;
  v.temp += clamp(target - v.temp, -0.05 * dt, 0.05 * dt);
  set(v, Status.Cold, v.temp < 35.2);
  set(v, Status.Hot, v.temp > 38.8);
  set(v, Status.Starving, v.satiety <= 0);
  set(v, Status.Dehydrated, v.hydration <= 0);

  let dhp = 0;
  if (v.status & Status.Starving) dhp -= 0.4;
  if (v.status & Status.Dehydrated) dhp -= 0.7;
  if (v.status & (Status.Cold | Status.Hot)) dhp -= 0.5;
  if (dhp === 0 && v.satiety > 40 && v.hydration > 40) dhp = 0.25;
  v.hp = clamp(v.hp + dhp * dt, 0, 100);
  return v.hp <= 0;
}


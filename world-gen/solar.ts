import { Rng } from '../core-ecs/rng';

/** Procedural star system. Distances are scene units, compressed for readability rather than to scale. */

export type PlanetKind = 'terran' | 'rock' | 'gas' | 'ice';

export interface PlanetDesc {
  name: string;
  kind: PlanetKind;
  radius: number;
  orbitRadius: number;
  /** Seconds per revolution. */
  orbitPeriod: number;
  phase: number;
  colorA: [number, number, number];
  colorB: [number, number, number];
  rings: boolean;
}

export interface SolarSystem {
  seed: number;
  starName: string;
  starColor: [number, number, number];
  starRadius: number;
  planets: PlanetDesc[];
  /** Index of the shared, landable world. */
  home: number;
}

const SYLLABLES = ['ka', 'ro', 've', 'lun', 'tor', 'ash', 'mir', 'dra', 'sol', 'nyx', 'bel', 'ix', 'tar', 'on'];

function makeName(rng: Rng): string {
  let s = '';
  for (let i = 0, n = rng.int(2, 3); i < n; i++) s += SYLLABLES[rng.int(0, SYLLABLES.length - 1)];
  return s[0].toUpperCase() + s.slice(1);
}

export function generateSolarSystem(seed: number): SolarSystem {
  const rng = new Rng(seed ^ 0x51a7);
  const starName = makeName(rng);
  const jitter = (v: number, f: number) => v * (1 + (rng.next() - 0.5) * f);
  const planets: PlanetDesc[] = [
    { name: starName + ' I', kind: 'rock', radius: jitter(3.2, 0.3), orbitRadius: 190, orbitPeriod: 900, phase: rng.next() * 6.28,
      colorA: [0.42, 0.33, 0.27], colorB: [0.2, 0.17, 0.15], rings: false },
    { name: starName + ' II', kind: 'terran', radius: 10, orbitRadius: 420, orbitPeriod: 3600, phase: rng.next() * 6.28,
      colorA: [0.3, 0.4, 0.3], colorB: [0.1, 0.2, 0.35], rings: false },
    { name: starName + ' III', kind: 'gas', radius: jitter(30, 0.2), orbitRadius: 980, orbitPeriod: 9000, phase: rng.next() * 6.28,
      colorA: [0.62, 0.5, 0.36], colorB: [0.33, 0.25, 0.2], rings: true },
    { name: starName + ' IV', kind: 'ice', radius: jitter(13, 0.3), orbitRadius: 1500, orbitPeriod: 16000, phase: rng.next() * 6.28,
      colorA: [0.5, 0.62, 0.68], colorB: [0.25, 0.35, 0.45], rings: false },
  ];
  return { seed, starName, starColor: [1.0, 0.93, 0.8], starRadius: 42, planets, home: 1 };
}

/** Position of a planet in the ecliptic plane at time t (seconds). */
export function planetPosition(p: PlanetDesc, t: number): [number, number, number] {
  const a = p.phase + (t / p.orbitPeriod) * Math.PI * 2;
  return [Math.cos(a) * p.orbitRadius, 0, Math.sin(a) * p.orbitRadius];
}

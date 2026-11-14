import type { CraftSession } from '../game-sim/components';
import { newInventory, type Inventory } from '../game-sim/inventory';
import { SKILL_COUNT } from '../game-sim/items';
import type { SelfState } from '../game-sim/worldSim';
import type { ClientMsg } from '../network';

/** Everything the client has been told about the local player's own character. Display only: the server owns it. */
export interface GameState {
  playerId: number;
  seed: number;
  self: SelfState | null;
  inventory: Inventory;
  skills: number[];
  craft: CraftSession | null;
}

export const newGameState = (): GameState => ({
  playerId: 0, seed: 0, self: null, inventory: newInventory(), skills: new Array<number>(SKILL_COUNT).fill(0), craft: null,
});

export type Send = (m: ClientMsg) => void;

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Small DOM builder: el('div', 'class', 'text') or with children. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: (string | Node)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.append(...children);
  return e;
}

const tip = () => $('tooltip');

export function showTooltip(text: string, x: number, y: number): void {
  const t = tip();
  t.textContent = text;
  t.hidden = false;
  t.style.left = Math.min(window.innerWidth - 250, x + 14) + 'px';
  t.style.top = Math.min(window.innerHeight - 90, y + 16) + 'px';
}

export function hideTooltip(): void {
  tip().hidden = true;
}

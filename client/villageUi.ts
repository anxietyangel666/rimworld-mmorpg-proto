import { countItem } from '../game-sim/inventory';
import { ITEMS } from '../game-sim/items';
import { BUILDINGS, BuildingType } from '../game-sim/village';
import type { VillageInfo } from '../game-sim/villageSim';
import { C2S } from '../network';
import { $, el, type GameState, type Send } from './state';

/**
 * Village window: the market's stalls (stock and prices that move with every
 * unit traded) and the town hall's job board and ledger. Everything shown is
 * what the server last reported; every button is a request, not a result.
 */
export class VillageUI {
  private info: VillageInfo | null = null;

  constructor(private readonly state: GameState, private readonly send: Send) {}

  get open(): boolean {
    return !$('village-window').hidden;
  }

  show(info: VillageInfo): void {
    this.info = info;
    $('village-window').hidden = false;
    this.render();
  }

  close(): void {
    $('village-window').hidden = true;
    this.info = null;
  }

  /** Ask the server for fresh figures, after a trade or while the window stays open. */
  requery(): void {
    if (this.open && this.info) this.send({ op: C2S.VillageInfo, building: this.info.building });
  }

  private render(): void {
    const v = this.info;
    if (!v) return;
    const building = v.building, inv = this.state.inventory;
    $('village-title').textContent = v.name + ' · ' + BUILDINGS[v.type].name;
    const standing = v.reputation > 0 ? ' · standing +' + v.reputation : v.reputation < 0 ? ' · standing ' + v.reputation : '';
    $('village-sub').textContent = v.population + ' villagers · treasury ' + v.treasury + 'c · your purse ' + v.coins + 'c' + standing;
    const body = $('village-body');
    body.replaceChildren();

    if (v.site !== 255) {
      body.append(el('div', 'small dim', 'Raising a ' + BUILDINGS[v.site as BuildingType].name.toLowerCase() + ': ' + Math.round(v.siteProgress) + '%'));
    }

    if (v.type === BuildingType.Market) {
      body.append(el('div', 'label', v.open ? 'Stalls' : 'Stalls · the merchant is away'));
      const table = el('div', 'trade-table');
      for (const s of v.stock) {
        const have = countItem(inv, s.item);
        const buy = el('button', '', 'Buy ' + s.sell + 'c');
        buy.disabled = !v.open || s.qty <= 0 || v.coins < s.sell;
        buy.addEventListener('click', () => this.send({ op: C2S.Trade, building, item: s.item, qty: 1, sell: false }));
        const sell = el('button', '', 'Sell ' + s.buy + 'c');
        sell.disabled = !v.open || have <= 0;
        sell.addEventListener('click', () => this.send({ op: C2S.Trade, building, item: s.item, qty: 1, sell: true }));
        const swatch = el('i', 'swatch');
        swatch.style.background = ITEMS[s.item].color;
        table.append(el('div', 'trade-row', swatch, el('span', 'name', ITEMS[s.item].name), el('span', 'dim', 'stock ' + s.qty), el('span', 'dim', 'you ' + have), buy, sell));
      }
      body.append(table);
    }

    if (v.contracts.length > 0) {
      body.append(el('div', 'label', 'Job board'));
      for (const c of v.contracts) {
        const have = countItem(inv, c.item);
        const b = el('button', 'recipe', el('b', '', 'Deliver ' + c.qty + ' ' + ITEMS[c.item].name), el('br'));
        if (c.state === 0) {
          b.append(el('small', '', 'Pays ' + c.reward + 'c · take the job'));
          b.addEventListener('click', () => this.send({ op: C2S.Contract, building, id: c.id, deliver: false }));
        } else if (c.state === 1) {
          b.append(el('span', have >= c.qty ? 'have' : 'need', 'You carry ' + have + ' of ' + c.qty), el('small', '', 'Pays ' + c.reward + 'c · hand it over'));
          b.disabled = have < c.qty;
          b.addEventListener('click', () => this.send({ op: C2S.Contract, building, id: c.id, deliver: true }));
        } else {
          b.append(el('small', '', 'Taken by someone else'));
          b.disabled = true;
        }
        body.append(b);
      }
    }

    if (v.ledger.length > 0) {
      body.append(el('div', 'label', 'Ledger'));
      body.append(el('ul', 'ledger', ...v.ledger.slice(-8).reverse().map((line) => el('li', '', line))));
    }
  }
}

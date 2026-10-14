import type { Deployment } from '../domain/battle';
import { getHero } from '../domain/heroes';
import {
  addBonus,
  bondGain,
  bondKey,
  bondLevel,
  bondLine,
  BOND_LEVELS,
  getSpecialization,
  rollItem,
  RARITY_LABEL,
  SELL_PRICE,
  type Item,
  type Slot,
} from '../domain/progression';
import type { BattleState, Stats } from '../domain/types';
import { addGold, load, save } from './profile';

// The player's long-term hero state: bonds, specializations and equipment (stored in this browser).

export interface Inventory {
  items: Item[];
  equipped: Record<string, Partial<Record<Slot, string>>>;
}

export const loadBonds = () => load<Record<string, number>>('bonds', {});
export const loadSpecs = () => load<Record<string, string>>('specs', {});
export const loadInventory = (): Inventory => load<Inventory>('inventory', { items: [], equipped: {} });
export const saveInventory = (inv: Inventory) => save('inventory', inv);

export function chooseSpec(heroId: string, specId: string) {
  save('specs', { ...loadSpecs(), [heroId]: specId });
}

export function equippedItems(inv: Inventory, heroId: string): Item[] {
  const slots = inv.equipped[heroId] ?? {};
  return Object.values(slots)
    .map((id) => inv.items.find((i) => i.id === id))
    .filter((i): i is Item => !!i);
}

/** Specialization + equipment bonus for one hero. */
export function loadoutBonus(heroId: string, specs = loadSpecs(), inv = loadInventory()): Partial<Stats> {
  let bonus: Partial<Stats> = {};
  const spec = getSpecialization(heroId, specs[heroId]);
  if (spec) bonus = addBonus(bonus, spec.bonus);
  for (const item of equippedItems(inv, heroId)) bonus = addBonus(bonus, item.bonus);
  return bonus;
}

/** Folds the player's specializations, equipment and bonds into their deployments. */
export function applyLoadout<T extends Omit<Deployment, 'pos'>>(team: T[]): T[] {
  const specs = loadSpecs();
  const inv = loadInventory();
  const bonds = loadBonds();
  const ids = team.map((d) => d.heroId);
  return team.map((d) => {
    const partners: Record<string, number> = {};
    for (const other of ids) {
      if (other === d.heroId) continue;
      const level = bondLevel(bonds[bondKey(d.heroId, other)] ?? 0);
      if (level) partners[other] = level;
    }
    return { ...d, bonus: addBonus(d.bonus ?? {}, loadoutBonus(d.heroId, specs, inv)), bonds: partners };
  });
}

/** Bond points for every pair of player heroes that fought together; returns result-screen HTML. */
export function awardBonds(state: BattleState): string {
  const bonds = loadBonds();
  const mine = state.units.filter((u) => u.side === 'player');
  const won = state.winner === 'player';
  const lines: string[] = [];
  for (let i = 0; i < mine.length; i++)
    for (let j = i + 1; j < mine.length; j++) {
      const a = mine[i];
      const b = mine[j];
      const key = bondKey(a.heroId, b.heroId);
      const before = bonds[key] ?? 0;
      bonds[key] = before + bondGain(won, a.alive && b.alive);
      const lb = bondLevel(before);
      const la = bondLevel(bonds[key]);
      if (la > lb) lines.push(`<li><b>Vínculo ${BOND_LEVELS[la].name}:</b> ${bondLine(a.heroId, b.heroId, la)}</li>`);
    }
  save('bonds', bonds);
  return lines.length ? `<div class="mastery-gain"><div class="eyebrow">Vínculos</div><ul>${lines.join('')}</ul></div>` : '';
}

/** Rolls a piece of equipment into the inventory; returns result-screen HTML. */
export function awardItem(luck: number): string {
  const inv = loadInventory();
  const item = rollItem(Math.random, luck);
  inv.items.unshift(item);
  // Keep the bag small: auto-sell the oldest unequipped commons beyond 40 items.
  const equippedIds = new Set(Object.values(inv.equipped).flatMap((s) => Object.values(s)));
  while (inv.items.length > 40) {
    const idx = inv.items.map((x) => !equippedIds.has(x.id)).lastIndexOf(true);
    if (idx < 0) break;
    addGold(SELL_PRICE[inv.items[idx].rarity]);
    inv.items.splice(idx, 1);
  }
  saveInventory(inv);
  return `<div class="gold-gain">🎁 Espólio: <b class="rar-${item.rarity}">${item.name}</b> <span class="muted">(${RARITY_LABEL[item.rarity]} · ${itemStats(item)})</span></div>`;
}

export function itemStats(item: Item): string {
  const L: Record<keyof Stats, string> = { maxHp: 'PV', atk: 'ATQ', def: 'DEF', mov: 'MOV', spd: 'VEL' };
  return (Object.entries(item.bonus) as [keyof Stats, number][]).map(([k, v]) => `${v > 0 ? '+' : ''}${v} ${L[k]}`).join(' · ');
}

export function heroTitle(heroId: string): string {
  const spec = getSpecialization(heroId, loadSpecs()[heroId]);
  return spec ? `${getHero(heroId).name} · ${spec.name}` : getHero(heroId).name;
}

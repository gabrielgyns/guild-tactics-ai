import { getHero } from './heroes';
import { pick, type Rng } from './rng';
import type { HeroClass, Stats } from './types';

// Long-term hero growth (the Fire Emblem / Pokémon / Summoners War layer):
// bonds between heroes, class specializations and equipment.

// ---------------------------------------------------------------- bonds

export const BOND_LEVELS = [
  { name: '—', points: 0 },
  { name: 'C', points: 3 },
  { name: 'B', points: 8 },
  { name: 'A', points: 15 },
];
/** Bonus damage dealt / damage avoided when a bonded ally stands next to you, by bond level. */
export const BOND_ATTACK = [0, 0.05, 0.1, 0.15];
export const BOND_GUARD = [0, 0.05, 0.08, 0.12];

export const bondKey = (a: string, b: string) => [a, b].sort().join('+');

export function bondLevel(points: number): number {
  let level = 0;
  BOND_LEVELS.forEach((l, i) => {
    if (points >= l.points) level = i;
  });
  return level;
}

/** Points a pair earns from one match together. */
export function bondGain(won: boolean, bothSurvived: boolean): number {
  return 1 + (won ? 1 : 0) + (bothSurvived ? 1 : 0);
}

export function bondLine(a: string, b: string, level: number): string {
  const x = getHero(a).name;
  const y = getHero(b).name;
  return [
    '',
    `${x} e ${y} já sabem onde o outro vai estar no campo.`,
    `${x} e ${y} cobrem as costas um do outro sem precisar de falar.`,
    `${x} e ${y} lutam como se fossem um só. A guilda inteira repara.`,
  ][level];
}

// ---------------------------------------------------------------- specializations

export interface Specialization {
  id: string;
  name: string;
  description: string;
  bonus: Partial<Stats>;
}

/** Unlocked at mastery level 3. Sidegrades: every gain has a cost. */
export const SPEC_LEVEL = 3;

export const SPECIALIZATIONS: Record<HeroClass, [Specialization, Specialization]> = {
  warrior: [
    { id: 'paladin', name: 'Paladino', description: '+2 DEF e +4 PV, mas −1 MOV.', bonus: { def: 2, maxHp: 4, mov: -1 } },
    { id: 'berserker', name: 'Berserker', description: '+3 ATQ, mas −2 DEF.', bonus: { atk: 3, def: -2 } },
  ],
  ranger: [
    { id: 'sharpshooter', name: 'Atirador', description: '+2 ATQ, mas −1 MOV.', bonus: { atk: 2, mov: -1 } },
    { id: 'scout', name: 'Batedor', description: '+1 MOV e +2 VEL, mas −1 ATQ.', bonus: { mov: 1, spd: 2, atk: -1 } },
  ],
  mage: [
    { id: 'archmage', name: 'Arquimago', description: '+3 ATQ, mas −3 PV.', bonus: { atk: 3, maxHp: -3 } },
    { id: 'sage', name: 'Sábio', description: '+2 DEF e +4 PV, mas −1 ATQ.', bonus: { def: 2, maxHp: 4, atk: -1 } },
  ],
  support: [
    { id: 'priest', name: 'Sacerdote', description: '+6 PV, mas −1 ATQ.', bonus: { maxHp: 6, atk: -1 } },
    { id: 'tactician', name: 'Estratega', description: '+1 MOV e +2 VEL, mas −3 PV.', bonus: { mov: 1, spd: 2, maxHp: -3 } },
  ],
};

export function specializationsFor(heroId: string) {
  return SPECIALIZATIONS[getHero(heroId).heroClass];
}

export function getSpecialization(heroId: string, specId: string | undefined): Specialization | null {
  return specializationsFor(heroId).find((s) => s.id === specId) ?? null;
}

// ---------------------------------------------------------------- equipment

export type Slot = 'weapon' | 'armor' | 'charm';
export type Rarity = 'common' | 'rare' | 'epic';

export interface Item {
  id: string;
  slot: Slot;
  rarity: Rarity;
  name: string;
  bonus: Partial<Stats>;
}

export const SLOT_LABEL: Record<Slot, string> = { weapon: 'Arma', armor: 'Armadura', charm: 'Amuleto' };
export const RARITY_LABEL: Record<Rarity, string> = { common: 'Comum', rare: 'Raro', epic: 'Épico' };
export const SELL_PRICE: Record<Rarity, number> = { common: 10, rare: 25, epic: 60 };

const NAMES: Record<Slot, string[]> = {
  weapon: ['Lâmina de Ferro', 'Arco de Teixo', 'Bastão Rúnico', 'Machado do Norte', 'Adaga Curva'],
  armor: ['Cota de Malha', 'Gibão Acolchoado', 'Placas de Bronze', 'Manto Reforçado'],
  charm: ['Pena de Grifo', 'Anel do Viajante', 'Amuleto de Âmbar', 'Talismã Lunar'],
};

const STAT_TABLE: Record<Slot, Record<Rarity, Partial<Stats>[]>> = {
  weapon: {
    common: [{ atk: 1 }],
    rare: [{ atk: 2 }],
    epic: [{ atk: 3 }, { atk: 2, spd: 1 }],
  },
  armor: {
    common: [{ def: 1 }, { maxHp: 3 }],
    rare: [{ def: 1, maxHp: 3 }, { def: 2 }],
    epic: [{ def: 2, maxHp: 4 }],
  },
  charm: {
    common: [{ spd: 1 }, { maxHp: 2 }],
    rare: [{ spd: 2 }, { mov: 1 }],
    epic: [{ mov: 1, spd: 1 }, { spd: 2, maxHp: 3 }],
  },
};

/** A random item; `luck` (0–1) shifts the odds towards rare and epic. */
export function rollItem(rng: Rng, luck = 0): Item {
  const slot = pick(rng, ['weapon', 'armor', 'charm'] as Slot[]);
  const r = rng() + luck * 0.35;
  const rarity: Rarity = r > 0.92 ? 'epic' : r > 0.62 ? 'rare' : 'common';
  const prefix = rarity === 'epic' ? ' Lendária' : rarity === 'rare' ? ' Fina' : '';
  const base = pick(rng, NAMES[slot]);
  return {
    id: `it${Math.floor(rng() * 1e9).toString(36)}${Date.now().toString(36)}`,
    slot,
    rarity,
    name: rarity === 'common' ? base : `${base}${prefix}`,
    bonus: { ...pick(rng, STAT_TABLE[slot][rarity]) },
  };
}

export function addBonus(a: Partial<Stats>, b: Partial<Stats>): Partial<Stats> {
  const out: Partial<Stats> = { ...a };
  for (const [k, v] of Object.entries(b) as [keyof Stats, number][]) out[k] = (out[k] ?? 0) + v;
  return out;
}

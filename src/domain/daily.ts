import type { Deployment } from './battle';
import { MAPS, type MapDef } from './board';
import { HEROES } from './heroes';
import { hashString, mulberry32, pick, shuffled } from './rng';
import type { HeroClass } from './types';

// Daily challenge: same map, teams and modifier for everyone on a given date.

export interface DailyModifier {
  id: string;
  name: string;
  description: string;
  player: Partial<Omit<Deployment, 'heroId' | 'pos'>>;
  enemy: Partial<Omit<Deployment, 'heroId' | 'pos'>>;
}

export const DAILY_MODIFIERS: DailyModifier[] = [
  { id: 'charged', name: 'Carga Total', description: 'Todos começam com a energia cheia: supremos logo na primeira ronda.', player: { energy: 100 }, enemy: { energy: 100 } },
  { id: 'glass', name: 'Lâminas de Vidro', description: 'Todos têm −8 PV máximos e +3 ATQ. Combates rápidos e brutais.', player: { bonus: { maxHp: -8, atk: 3 } }, enemy: { bonus: { maxHp: -8, atk: 3 } } },
  { id: 'veterans', name: 'Veteranos', description: 'O adversário tem +3 ATQ e +6 PV. Tu tens a iniciativa.', player: { bonus: { spd: 3 } }, enemy: { bonus: { atk: 3, maxHp: 6 } } },
  { id: 'swift', name: 'Ventos Rápidos', description: '+1 MOV para todos: o tabuleiro encolhe.', player: { bonus: { mov: 1 } }, enemy: { bonus: { mov: 1 } } },
  { id: 'fortified', name: 'Muralhas', description: 'Todos começam com 10 de escudo.', player: { shield: 10 }, enemy: { shield: 10 } },
];

export interface DailyChallenge {
  date: string; // YYYY-MM-DD
  map: MapDef;
  modifier: DailyModifier;
  player: string[];
  enemy: string[];
}

export function todayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const CLASSES: HeroClass[] = ['warrior', 'ranger', 'mage', 'support'];

export function dailyChallenge(date = todayKey()): DailyChallenge {
  const rng = mulberry32(hashString(`daily:${date}`));
  const map = pick(rng, MAPS);
  const modifier = pick(rng, DAILY_MODIFIERS);
  const player: string[] = [];
  const enemy: string[] = [];
  for (const c of CLASSES) {
    const pool = shuffled(rng, HEROES.filter((h) => h.heroClass === c));
    player.push(pool[0].id);
    enemy.push((pool[1] ?? pool[0]).id);
  }
  return { date, map, modifier, player, enemy };
}

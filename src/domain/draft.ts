import { elementMultiplier } from './elements';
import { HEROES, getHero } from './heroes';
import type { Rng } from './rng';
import type { Side } from './types';

// Draft: both sides pick from a shared pool in snake order. A hero can only be picked once.

export const DRAFT_ORDER: Side[] = ['player', 'enemy', 'enemy', 'player', 'player', 'enemy', 'enemy', 'player'];

export interface DraftState {
  turn: number;
  player: string[];
  enemy: string[];
}

export const newDraft = (): DraftState => ({ turn: 0, player: [], enemy: [] });

export function draftSide(d: DraftState): Side | null {
  return DRAFT_ORDER[d.turn] ?? null;
}

export function available(d: DraftState): string[] {
  return HEROES.map((h) => h.id).filter((id) => !d.player.includes(id) && !d.enemy.includes(id));
}

export function draftPick(d: DraftState, heroId: string): DraftState {
  const side = draftSide(d);
  if (!side) throw new Error('Draft is over');
  if (!available(d).includes(heroId)) throw new Error('Hero not available');
  return { turn: d.turn + 1, player: side === 'player' ? [...d.player, heroId] : d.player, enemy: side === 'enemy' ? [...d.enemy, heroId] : d.enemy };
}

/** AI pick: cover missing classes, counter the opponent's elements, avoid being countered. */
export function aiDraftPick(d: DraftState, rng: Rng): string {
  const mine = d.enemy;
  const theirs = d.player;
  let best = '';
  let bestScore = -Infinity;
  for (const id of available(d)) {
    const h = getHero(id);
    let score = rng() * 1.5;
    if (!mine.some((m) => getHero(m).heroClass === h.heroClass)) score += 4;
    for (const t of theirs) {
      const e = getHero(t).element;
      if (elementMultiplier(h.element, e) > 1) score += 1;
      if (elementMultiplier(e, h.element) > 1) score -= 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

import { elementMultiplier } from './elements';
import { HEROES, getHero } from './heroes';
import type { Rng } from './rng';
import type { Side } from './types';

// Draft: each side bans one hero, then both pick from the shared pool in snake order.
// A hero can only be banned or picked once.

export interface DraftStep {
  side: Side;
  action: 'ban' | 'pick';
}

export const DRAFT_ORDER: DraftStep[] = [
  { side: 'player', action: 'ban' },
  { side: 'enemy', action: 'ban' },
  ...(['player', 'enemy', 'enemy', 'player', 'player', 'enemy', 'enemy', 'player'] as Side[]).map((side) => ({ side, action: 'pick' as const })),
];

export interface DraftState {
  turn: number;
  player: string[];
  enemy: string[];
  bans: { side: Side; heroId: string }[];
}

export const newDraft = (): DraftState => ({ turn: 0, player: [], enemy: [], bans: [] });

export function draftStep(d: DraftState): DraftStep | null {
  return DRAFT_ORDER[d.turn] ?? null;
}

export function draftSide(d: DraftState): Side | null {
  return draftStep(d)?.side ?? null;
}

export function available(d: DraftState): string[] {
  const taken = new Set([...d.player, ...d.enemy, ...d.bans.map((b) => b.heroId)]);
  return HEROES.map((h) => h.id).filter((id) => !taken.has(id));
}

export function draftPick(d: DraftState, heroId: string): DraftState {
  const step = draftStep(d);
  if (!step) throw new Error('Draft is over');
  if (!available(d).includes(heroId)) throw new Error('Hero not available');
  if (step.action === 'ban') return { ...d, turn: d.turn + 1, bans: [...d.bans, { side: step.side, heroId }] };
  return {
    ...d,
    turn: d.turn + 1,
    player: step.side === 'player' ? [...d.player, heroId] : d.player,
    enemy: step.side === 'enemy' ? [...d.enemy, heroId] : d.enemy,
  };
}

/** How much `heroId` would help the side whose team is `mine` against `theirs`. */
function value(heroId: string, mine: string[], theirs: string[], rng: Rng): number {
  const h = getHero(heroId);
  let score = rng() * 1.5;
  if (!mine.some((m) => getHero(m).heroClass === h.heroClass)) score += 4;
  for (const t of theirs) {
    const e = getHero(t).element;
    if (elementMultiplier(h.element, e) > 1) score += 1;
    if (elementMultiplier(e, h.element) > 1) score -= 1;
  }
  return score;
}

/**
 * AI choice for the current step. Picks cover missing classes and chase element advantage;
 * bans remove the hero that would be best for the player.
 */
export function aiDraftPick(d: DraftState, rng: Rng): string {
  const ban = draftStep(d)?.action === 'ban';
  let best = '';
  let bestScore = -Infinity;
  for (const id of available(d)) {
    const score = ban ? value(id, d.player, d.enemy, rng) : value(id, d.enemy, d.player, rng);
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

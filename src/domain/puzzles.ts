import { applyCommand, cloneState, createBattle, getUnit, moveUnit, reachableTiles, validTargets, canUseAbility, type Deployment } from './battle';
import type { MapDef } from './board';
import { buildBoard } from './board';
import { getHero, heroAbilities } from './heroes';
import type { BattleState, Command } from './types';

// Tactical puzzles: defeat every enemy before any of them gets to act.
// Enemies are slowed so all player heroes act first.

export interface Puzzle {
  id: string;
  name: string;
  goal: string;
  hint: string;
  map: MapDef;
  player: Deployment[];
  enemy: Deployment[];
}

const SLOW = { spd: -30 };

export const PUZZLES: Puzzle[] = [
  {
    id: 'flank',
    name: 'Cerco',
    goal: 'Derrota a Lyra neste turno.',
    hint: 'Nenhum golpe sozinho chega. A Fúria do Kael é rápida, cada aliado encostado ao alvo dá +15% e a Investida do Brann percorre a distância de uma vez.',
    map: { id: 'p-flank', name: 'Clareira', rows: ['......', '......', '..F...', '......', '......', '......'] },
    player: [
      { heroId: 'kael', pos: { x: 1, y: 5 } },
      { heroId: 'brann', pos: { x: 3, y: 5 } },
    ],
    enemy: [{ heroId: 'lyra', pos: { x: 2, y: 2 }, hp: 24, bonus: { ...SLOW, maxHp: 6 } }],
  },
  {
    id: 'push',
    name: 'Contra a Rocha',
    goal: 'Derrota os dois inimigos neste turno.',
    hint: 'Empurrar alguém contra uma rocha causa 3 de dano extra. A ordem importa.',
    map: { id: 'p-push', name: 'Desfiladeiro', rows: ['..R...', '......', '......', '....R.', '......', '......'] },
    player: [
      { heroId: 'tobin', pos: { x: 2, y: 5 } },
      { heroId: 'seren', pos: { x: 5, y: 5 } },
    ],
    enemy: [
      { heroId: 'orrin', pos: { x: 2, y: 2 }, hp: 13, bonus: SLOW },
      { heroId: 'mira', pos: { x: 4, y: 1 }, hp: 9, bonus: SLOW },
    ],
  },
  {
    id: 'swap',
    name: 'Troca de Lugares',
    goal: 'Derrota a Seren neste turno.',
    hint: 'A Seren está numa ilhota. A Troca Arcana também funciona em inimigos, e a Vex joga primeiro.',
    map: { id: 'p-swap', name: 'Ilhota', rows: ['...W.W', '....W.', '......', '......', '......', '......'] },
    player: [
      { heroId: 'vex', pos: { x: 3, y: 3 }, bonus: { spd: 5 } },
      { heroId: 'kael', pos: { x: 1, y: 5 } },
      { heroId: 'brann', pos: { x: 5, y: 5 } },
    ],
    enemy: [{ heroId: 'seren', pos: { x: 4, y: 0 }, hp: 20, bonus: { ...SLOW, maxHp: 6 } }],
  },
  {
    id: 'ultimate',
    name: 'Hora do Supremo',
    goal: 'Derrota os três inimigos neste turno.',
    hint: 'Uma ação rápida não gasta o turno, e um turno extra vale ouro.',
    map: { id: 'p-ult', name: 'Pátio', rows: ['......', '.R..R.', '......', '......', '.F..F.', '......'] },
    player: [
      { heroId: 'orrin', pos: { x: 2, y: 5 } },
      { heroId: 'seren', pos: { x: 3, y: 5 }, energy: 100 },
    ],
    enemy: [
      { heroId: 'kael', pos: { x: 2, y: 1 }, hp: 22, bonus: SLOW },
      { heroId: 'brann', pos: { x: 3, y: 2 }, hp: 26, bonus: SLOW },
      { heroId: 'lyra', pos: { x: 2, y: 2 }, hp: 30, bonus: { ...SLOW, maxHp: 10 } },
    ],
  },
];

/** Puzzle rule: lost as soon as an enemy would act or the first round ends. */
export function puzzleFailed(s: BattleState): boolean {
  if (s.winner) return s.winner !== 'player';
  return s.round > 1 || (!!s.active && getUnit(s, s.active.unitId).side !== 'player');
}

export function puzzleBattle(p: Puzzle) {
  return createBattle(buildBoard(p.map), p.player, p.enemy);
}

/** Candidate full-turn command lists for the active unit: [quick?] [move?] action-or-end. */
function turnOptions(s: BattleState): Command[][] {
  const out: Command[][] = [];
  const unitId = s.active!.unitId;
  const unit = getUnit(s, unitId);
  const abilities = heroAbilities(getHero(unit.heroId)).filter((a) => a.id !== 'defend');

  const afterMove = (state: BattleState, prefix: Command[]) => {
    for (const a of abilities.filter((x) => !x.quick)) {
      if (!canUseAbility(state, unitId, a.id).ok) continue;
      for (const t of validTargets(state, unitId, a.id)) out.push([...prefix, { type: 'ability', abilityId: a.id, target: t }]);
    }
    out.push([...prefix, { type: 'endTurn' }]);
  };
  const withMoves = (state: BattleState, prefix: Command[]) => {
    afterMove(state, prefix);
    if (state.active!.canMove && !state.active!.moved)
      for (const r of reachableTiles(state, unitId).values()) {
        if (!r.path.length) continue;
        const sim = cloneState(state);
        moveUnit(sim, r.pos, []);
        afterMove(sim, [...prefix, { type: 'move', to: r.pos }]);
      }
  };
  withMoves(s, []);
  for (const q of abilities.filter((x) => x.quick)) {
    if (!canUseAbility(s, unitId, q.id).ok) continue;
    for (const t of validTargets(s, unitId, q.id)) {
      const sim = cloneState(s);
      applyCommand(sim, { type: 'ability', abilityId: q.id, target: t });
      withMoves(sim, [{ type: 'ability', abilityId: q.id, target: t }]);
    }
  }
  return out;
}

/**
 * Exhaustive search for a winning sequence. Returns the command list or null.
 * `limit` caps the number of explored turn options to keep tests fast.
 */
export function solvePuzzle(
  p: Puzzle,
  limit = 2_000_000,
  stopAtFirst = false,
  /** Optional tweak of the starting state (used to prove an idea is required). */
  setup?: (s: BattleState) => void,
): { solution: Command[] | null; explored: number; solutions: number } {
  let explored = 0;
  let solutions = 0;
  let first: Command[] | null = null;
  const rec = (s: BattleState, path: Command[]) => {
    if (explored > limit || (stopAtFirst && first)) return;
    if (s.winner === 'player') {
      solutions++;
      if (!first) first = path;
      return;
    }
    if (puzzleFailed(s) || !s.active) return;
    for (const opt of turnOptions(s)) {
      explored++;
      const sim = cloneState(s);
      try {
        for (const c of opt) applyCommand(sim, c);
      } catch {
        continue;
      }
      rec(sim, [...path, ...opt]);
    }
  };
  const start = puzzleBattle(p).state;
  setup?.(start);
  rec(start, []);
  return { solution: first, explored, solutions };
}

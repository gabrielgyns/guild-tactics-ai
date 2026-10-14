import {
  abilityRange,
  aliveUnits,
  cloneState,
  computeDamage,
  getUnit,
  hasStatus,
  isValidTarget,
  maxHp,
  moveUnit,
  opponent,
  reachableTiles,
  resolveAbility,
} from './battle';
import { manhattan, terrainAt } from './board';
import { basicAttack, getHero, heroAbilities } from './heroes';
import type { Ability, BattleEvent, BattleState, Command, Pos, Side, Unit } from './types';

// Greedy one-turn lookahead: try every (quick ability?) → (move?) → (action?) sequence,
// simulate it on a copy of the state and keep the best-scoring one.

export interface AiOptions {
  /** 0 = deterministic. Adds a little variety between matches. */
  noise: number;
  random: () => number;
}

const STATUS_VALUE: Record<string, (amount: number, remaining: number) => number> = {
  stun: () => -10,
  root: () => -3,
  burn: (a, r) => -a * r,
  mark: () => -4,
  weak: () => -4,
  empower: (a, r) => a * Math.min(r + 1, 2) * 0.8,
  guard: () => 2,
};

function unitValue(s: BattleState, u: Unit): number {
  if (!u.alive) return 0;
  let v = 25 + u.hp + u.shield * 0.6;
  for (const st of u.statuses) v += STATUS_VALUE[st.kind](st.amount, st.remaining);
  // Units that still get to act this round are worth more.
  v += s.queue.slice(1).filter((id) => id === u.id).length * 8;
  return v;
}

/** Board evaluation from `side`'s point of view. */
export function evaluate(s: BattleState, side: Side): number {
  if (s.winner === side) return 10_000;
  if (s.winner && s.winner !== 'draw') return -10_000;
  let score = 0;
  for (const u of s.units) score += u.side === side ? unitValue(s, u) : -1.15 * unitValue(s, u);
  return score;
}

function preferredDistance(u: Unit): number {
  const hero = getHero(u.heroId);
  if (hero.heroClass === 'support') return 2;
  return hero.attack.max > 1 ? Math.max(2, hero.attack.max - 1) : 1;
}

/** Heuristic value of where the unit ends its turn. */
function positionalScore(s: BattleState, u: Unit): number {
  if (!u.alive) return 0;
  const enemies = aliveUnits(s, opponent(u.side));
  if (!enemies.length) return 0;
  let score = 0;

  // Danger: expected basic-attack damage from enemies that can reach us next turn.
  let threat = 0;
  for (const e of enemies) {
    const hero = getHero(e.heroId);
    const reach = hero.stats.mov + abilityRange(s, e, basicAttack(hero)).max;
    if (manhattan(e.pos, u.pos) <= reach && !hasStatus(e, 'stun')) {
      threat += computeDamage(s, e, u, { kind: 'damage', power: 1, magic: hero.attack.magic }).amount;
    }
  }
  const effectiveHp = u.hp + u.shield;
  score -= threat * (effectiveHp < maxHp(u) * 0.5 ? 0.45 : 0.2);
  if (threat >= effectiveHp) score -= 12;

  // Approach / keep distance.
  const nearest = Math.min(...enemies.map((e) => manhattan(e.pos, u.pos)));
  score -= Math.abs(nearest - preferredDistance(u)) * 1.2;

  // Supports stay near the team.
  if (getHero(u.heroId).heroClass === 'support') {
    const allies = aliveUnits(s, u.side).filter((a) => a.id !== u.id);
    if (allies.length) score -= Math.min(...allies.map((a) => manhattan(a.pos, u.pos))) * 0.6;
  }

  const t = terrainAt(s.board, u.pos);
  if (t === 'forest') score += 1.5;
  if (t === 'hill') score += getHero(u.heroId).attack.max > 1 ? 2 : 0.8;
  return score;
}

interface Plan {
  commands: Command[];
  score: number;
}

function targetsFor(s: BattleState, u: Unit, ability: Ability): Pos[] {
  const out: Pos[] = [];
  const r = abilityRange(s, u, ability);
  for (let y = 0; y < s.board.height; y++)
    for (let x = 0; x < s.board.width; x++) {
      const p = { x, y };
      const d = manhattan(u.pos, p);
      if (d < r.min || d > r.max) continue;
      if (isValidTarget(s, u, ability, p)) out.push(p);
    }
  return out;
}

function usable(u: Unit, ability: Ability): boolean {
  return (u.cooldowns[ability.id] ?? 0) === 0;
}

/** Best (move, main action) from the given state. */
function bestMoveAndAct(s: BattleState, unitId: string, side: Side, base: number, opts: AiOptions): Plan {
  const unit = getUnit(s, unitId);
  const abilities = heroAbilities(getHero(unit.heroId)).filter((a) => !a.quick && usable(unit, a));
  const tiles: (Pos | null)[] = [null];
  if (s.active?.canMove && !s.active.moved) {
    for (const r of reachableTiles(s, unitId).values()) if (r.path.length) tiles.push(r.pos);
  }

  let best: Plan = { commands: [{ type: 'endTurn' }], score: -Infinity };
  for (const tile of tiles) {
    const moved = cloneState(s);
    const ev: BattleEvent[] = [];
    if (tile) moveUnit(moved, tile, ev);
    const mover = getUnit(moved, unitId);
    const pre: Command[] = tile ? [{ type: 'move', to: tile }] : [];

    // Option: do nothing after moving.
    const idle = evaluate(moved, side) - base + positionalScore(moved, mover);
    const consider = (commands: Command[], score: number) => {
      const noisy = score + (opts.noise ? (opts.random() - 0.5) * opts.noise : 0);
      if (noisy > best.score) best = { commands, score: noisy };
    };
    consider([...pre, { type: 'endTurn' }], idle - 0.5);

    for (const ability of abilities) {
      for (const target of targetsFor(moved, mover, ability)) {
        const sim = cloneState(moved);
        const caster = getUnit(sim, unitId);
        resolveAbility(sim, caster, ability, target, []);
        let score = evaluate(sim, side) - base + positionalScore(sim, caster);
        // Don't burn a long cooldown for nothing.
        score -= ability.cooldown * 0.4;
        consider([...pre, { type: 'ability', abilityId: ability.id, target }], score);
      }
    }
  }
  return best;
}

export function planTurn(s: BattleState, opts: AiOptions = { noise: 0, random: Math.random }): Command[] {
  if (!s.active) return [];
  const unitId = s.active.unitId;
  const unit = getUnit(s, unitId);
  const side = unit.side;
  const base = evaluate(s, side);

  let best = bestMoveAndAct(s, unitId, side, base, opts);

  // Try each quick ability first, then the best follow-up.
  if (!s.active.usedQuick) {
    const quicks = heroAbilities(getHero(unit.heroId)).filter((a) => a.quick && usable(unit, a));
    for (const q of quicks) {
      for (const target of targetsFor(s, unit, q)) {
        const sim = cloneState(s);
        resolveAbility(sim, getUnit(sim, unitId), q, target, []);
        sim.active!.usedQuick = true;
        if (sim.winner) continue;
        const follow = bestMoveAndAct(sim, unitId, side, base, opts);
        const score = follow.score - q.cooldown * 0.4;
        if (score > best.score) {
          best = { commands: [{ type: 'ability', abilityId: q.id, target }, ...follow.commands], score };
        }
      }
    }
  }
  return best.commands;
}

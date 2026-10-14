import {
  DIRS,
  inBounds,
  isWalkable,
  manhattan,
  moveCost,
  neighbors,
  posKey,
  samePos,
  stepToward,
  terrainAt,
} from './board';
import { findAbility, getHero, heroAbilities } from './heroes';
import type {
  Ability,
  BattleEvent,
  BattleState,
  Board,
  Command,
  DamageTag,
  Effect,
  Pos,
  Side,
  StatusKind,
  Unit,
} from './types';

// ---------------------------------------------------------------- tuning (hypotheses)

export const RULES = {
  maxRounds: 12,
  forestCover: 0.75,
  heightBonus: 1.2,
  flankBonusPerAlly: 0.15,
  guardFactor: 0.5,
  collisionDamage: 3,
  /** Damage multiplier = DEF_SCALE / (DEF_SCALE + def). */
  defScale: 10,
  /** Global pacing knob: raises all damage to keep matches short. */
  damageScale: 1.25,
};

const NEGATIVE: StatusKind[] = ['stun', 'root', 'burn', 'mark', 'weak'];

// ---------------------------------------------------------------- setup

export interface Deployment {
  heroId: string;
  pos: Pos;
}

export function createBattle(board: Board, player: Deployment[], enemy: Deployment[]) {
  const units: Unit[] = [];
  const add = (side: Side, d: Deployment, i: number) => {
    const hero = getHero(d.heroId);
    units.push({
      id: `${side === 'player' ? 'p' : 'e'}${i}-${d.heroId}`,
      heroId: d.heroId,
      side,
      pos: { ...d.pos },
      hp: hero.stats.maxHp,
      shield: 0,
      alive: true,
      statuses: [],
      cooldowns: {},
      combat: { damageDealt: 0, damageTaken: 0, healingDone: 0, kills: 0 },
    });
  };
  player.forEach((d, i) => add('player', d, i));
  enemy.forEach((d, i) => add('enemy', d, i));

  const state: BattleState = { board, units, round: 0, queue: [], active: null, winner: null, turnsTaken: 0 };
  const events: BattleEvent[] = [];
  startNextTurn(state, events);
  return { state, events };
}

/** Cheap deep copy. The board is immutable and shared. */
export function cloneState(s: BattleState): BattleState {
  return {
    board: s.board,
    round: s.round,
    queue: [...s.queue],
    active: s.active ? { ...s.active, preMovePos: { ...s.active.preMovePos } } : null,
    winner: s.winner,
    turnsTaken: s.turnsTaken,
    units: s.units.map((u) => ({
      ...u,
      pos: { ...u.pos },
      statuses: u.statuses.map((st) => ({ ...st })),
      cooldowns: { ...u.cooldowns },
      combat: { ...u.combat },
    })),
  };
}

// ---------------------------------------------------------------- queries

export function getUnit(s: BattleState, id: string): Unit {
  const u = s.units.find((x) => x.id === id);
  if (!u) throw new Error(`Unknown unit ${id}`);
  return u;
}

export function unitAt(s: BattleState, p: Pos): Unit | undefined {
  return s.units.find((u) => u.alive && samePos(u.pos, p));
}

export function activeUnit(s: BattleState): Unit | null {
  return s.active ? getUnit(s, s.active.unitId) : null;
}

export const opponent = (side: Side): Side => (side === 'player' ? 'enemy' : 'player');

export function hasStatus(u: Unit, kind: StatusKind): boolean {
  return u.statuses.some((st) => st.kind === kind);
}

function statusAmount(u: Unit, kind: StatusKind): number {
  return u.statuses.filter((st) => st.kind === kind).reduce((sum, st) => sum + st.amount, 0);
}

export function maxHp(u: Unit): number {
  return getHero(u.heroId).stats.maxHp;
}

export function effectiveAtk(u: Unit): number {
  return getHero(u.heroId).stats.atk + statusAmount(u, 'empower');
}

export function aliveUnits(s: BattleState, side?: Side): Unit[] {
  return s.units.filter((u) => u.alive && (!side || u.side === side));
}

/** Turn order for a fresh round: faster first, player wins ties. */
export function roundOrder(s: BattleState): string[] {
  return aliveUnits(s)
    .slice()
    .sort((a, b) => {
      const sa = getHero(a.heroId).stats.spd;
      const sb = getHero(b.heroId).stats.spd;
      if (sa !== sb) return sb - sa;
      // Speed ties alternate between sides every round so neither always moves first.
      if (a.side !== b.side) return (a.side === 'player') === (s.round % 2 === 1) ? -1 : 1;
      return a.id.localeCompare(b.id);
    })
    .map((u) => u.id);
}

export interface Reach {
  pos: Pos;
  cost: number;
  path: Pos[]; // excludes the start tile
}

/** Tiles the unit can end its move on (Dijkstra; can pass through allies, not enemies). */
export function reachableTiles(s: BattleState, unitId: string): Map<string, Reach> {
  const unit = getUnit(s, unitId);
  const budget = getHero(unit.heroId).stats.mov;
  const best = new Map<string, Reach>();
  const frontier: Reach[] = [{ pos: unit.pos, cost: 0, path: [] }];
  const seen = new Map<string, number>([[posKey(unit.pos), 0]]);
  while (frontier.length) {
    frontier.sort((a, b) => a.cost - b.cost);
    const cur = frontier.shift()!;
    const occupant = unitAt(s, cur.pos);
    if (!occupant || occupant.id === unit.id) best.set(posKey(cur.pos), cur);
    for (const n of neighbors(s.board, cur.pos)) {
      if (!isWalkable(s.board, n)) continue;
      const other = unitAt(s, n);
      if (other && other.side !== unit.side) continue;
      const cost = cur.cost + moveCost(terrainAt(s.board, n));
      if (cost > budget) continue;
      const k = posKey(n);
      if ((seen.get(k) ?? Infinity) <= cost) continue;
      seen.set(k, cost);
      frontier.push({ pos: n, cost, path: [...cur.path, n] });
    }
  }
  return best;
}

export function abilityRange(s: BattleState, caster: Unit, ability: Ability) {
  const onHill = terrainAt(s.board, caster.pos) === 'hill';
  const bonus = onHill && ability.range.max > 1 ? 1 : 0;
  return { min: ability.range.min, max: ability.range.max + bonus };
}

function dashClear(s: BattleState, caster: Unit, target: Pos): boolean {
  const d = stepToward(caster.pos, target);
  const dist = manhattan(caster.pos, target);
  for (let i = 1; i < dist; i++) {
    const p = { x: caster.pos.x + d.x * i, y: caster.pos.y + d.y * i };
    if (!isWalkable(s.board, p) || unitAt(s, p)) return false;
  }
  return true;
}

export function isValidTarget(s: BattleState, caster: Unit, ability: Ability, target: Pos): boolean {
  if (!inBounds(s.board, target)) return false;
  const range = abilityRange(s, caster, ability);
  const dist = manhattan(caster.pos, target);
  if (dist < range.min || dist > range.max) return false;
  if (ability.straight && caster.pos.x !== target.x && caster.pos.y !== target.y) return false;
  const occupant = unitAt(s, target);
  switch (ability.target) {
    case 'enemy':
      if (!occupant || occupant.side === caster.side) return false;
      break;
    case 'ally':
      if (!occupant || occupant.side !== caster.side) return false;
      break;
    case 'self':
      if (!samePos(caster.pos, target)) return false;
      break;
    case 'unit':
      if (!occupant || occupant.id === caster.id) return false;
      break;
    case 'emptyTile':
      if (occupant || !isWalkable(s.board, target)) return false;
      break;
    case 'tile':
      break;
  }
  if (ability.effects.some((e) => e.kind === 'dash') && !dashClear(s, caster, target)) return false;
  return true;
}

export function validTargets(s: BattleState, unitId: string, abilityId: string): Pos[] {
  const caster = getUnit(s, unitId);
  const ability = findAbility(caster.heroId, abilityId);
  const out: Pos[] = [];
  for (let y = 0; y < s.board.height; y++)
    for (let x = 0; x < s.board.width; x++) if (isValidTarget(s, caster, ability, { x, y })) out.push({ x, y });
  return out;
}

/** Every tile inside the ability's range, valid or not (for the range overlay). */
export function rangeTiles(s: BattleState, unitId: string, abilityId: string): Pos[] {
  const caster = getUnit(s, unitId);
  const ability = findAbility(caster.heroId, abilityId);
  const r = abilityRange(s, caster, ability);
  const out: Pos[] = [];
  for (let y = 0; y < s.board.height; y++)
    for (let x = 0; x < s.board.width; x++) {
      const p = { x, y };
      const d = manhattan(caster.pos, p);
      if (d < r.min || d > r.max) continue;
      if (ability.straight && p.x !== caster.pos.x && p.y !== caster.pos.y) continue;
      out.push(p);
    }
  return out;
}

export function areaOf(s: BattleState, caster: Unit, ability: Ability, target: Pos): Pos[] {
  const area = ability.area;
  const tiles: Pos[] = [];
  switch (area.kind) {
    case 'single':
      tiles.push({ ...target });
      break;
    case 'around':
      for (let y = 0; y < s.board.height; y++)
        for (let x = 0; x < s.board.width; x++) if (manhattan(target, { x, y }) <= area.radius) tiles.push({ x, y });
      break;
    case 'adjacent':
      for (const d of DIRS) tiles.push({ x: caster.pos.x + d.x, y: caster.pos.y + d.y });
      break;
    case 'line': {
      const d = stepToward(caster.pos, target);
      for (let i = 1; i <= area.length; i++) tiles.push({ x: caster.pos.x + d.x * i, y: caster.pos.y + d.y * i });
      break;
    }
  }
  return tiles.filter((p) => inBounds(s.board, p));
}

export type UseCheck = { ok: true } | { ok: false; reason: string };

export function canUseAbility(s: BattleState, unitId: string, abilityId: string): UseCheck {
  if (s.winner) return { ok: false, reason: 'A batalha terminou.' };
  if (!s.active || s.active.unitId !== unitId) return { ok: false, reason: 'Não é o turno desta unidade.' };
  const unit = getUnit(s, unitId);
  const ability = findAbility(unit.heroId, abilityId);
  if (s.active.acted) return { ok: false, reason: 'Já agiu neste turno.' };
  const cd = unit.cooldowns[abilityId] ?? 0;
  if (cd > 0) return { ok: false, reason: `Em recarga: ${cd} turno${cd > 1 ? 's' : ''}.` };
  if (ability.quick && s.active.usedQuick) return { ok: false, reason: 'Só uma ação rápida por turno.' };
  if (validTargets(s, unitId, abilityId).length === 0) return { ok: false, reason: 'Sem alvos ao alcance.' };
  return { ok: true };
}

// ---------------------------------------------------------------- damage model

export interface DamageQuote {
  amount: number;
  tags: DamageTag[];
}

export function computeDamage(
  s: BattleState,
  attacker: Unit,
  target: Unit,
  effect: Extract<Effect, { kind: 'damage' }>,
): DamageQuote {
  const tags: DamageTag[] = [];
  const def = getHero(target.heroId).stats.def * (effect.magic ? 0.5 : 1);
  let dmg = effectiveAtk(attacker) * effect.power * RULES.damageScale * (RULES.defScale / (RULES.defScale + def));

  if (effect.executeBelow && target.hp <= maxHp(target) * effect.executeBelow) {
    dmg *= 2;
    tags.push('execute');
  }
  if (terrainAt(s.board, attacker.pos) === 'hill' && terrainAt(s.board, target.pos) !== 'hill') {
    dmg *= RULES.heightBonus;
    tags.push('height');
  }
  if (!effect.ignoreCover && terrainAt(s.board, target.pos) === 'forest') {
    dmg *= RULES.forestCover;
    tags.push('cover');
  }
  const flankers = neighbors(s.board, target.pos)
    .map((p) => unitAt(s, p))
    .filter((u): u is Unit => !!u && u.side === attacker.side && u.id !== attacker.id).length;
  if (flankers > 0) {
    dmg *= 1 + RULES.flankBonusPerAlly * flankers;
    tags.push('flank');
  }
  const mark = statusAmount(target, 'mark');
  if (mark) {
    dmg *= 1 + mark / 100;
    tags.push('mark');
  }
  const weak = statusAmount(attacker, 'weak');
  if (weak) {
    dmg *= 1 - weak / 100;
    tags.push('weak');
  }
  if (hasStatus(target, 'guard')) {
    dmg *= RULES.guardFactor;
    tags.push('guard');
  }
  return { amount: Math.max(1, Math.round(dmg)), tags };
}

// ---------------------------------------------------------------- mutations

function dealDamage(
  s: BattleState,
  target: Unit,
  sourceId: string,
  amount: number,
  tags: DamageTag[],
  events: BattleEvent[],
) {
  if (!target.alive) return;
  const absorbed = Math.min(target.shield, amount);
  target.shield -= absorbed;
  const real = Math.min(target.hp, amount - absorbed);
  target.hp -= amount - absorbed;
  target.combat.damageTaken += real;
  const source = s.units.find((u) => u.id === sourceId);
  if (source && source.side !== target.side) source.combat.damageDealt += real + absorbed;
  events.push({ type: 'damage', unitId: target.id, sourceId, amount, absorbed, tags });
  if (target.hp <= 0) killUnit(s, target, source, events);
}

function killUnit(s: BattleState, target: Unit, source: Unit | undefined, events: BattleEvent[]) {
  target.hp = 0;
  target.alive = false;
  target.statuses = [];
  target.shield = 0;
  if (source && source.side !== target.side) source.combat.kills += 1;
  events.push({ type: 'death', unitId: target.id });
  // Remove from the queue except when it is the active unit (its turn is closed by the caller).
  s.queue = s.queue.filter((id, i) => i === 0 || id !== target.id);
  checkVictory(s, events);
}

function checkVictory(s: BattleState, events: BattleEvent[]) {
  if (s.winner) return;
  const p = aliveUnits(s, 'player').length;
  const e = aliveUnits(s, 'enemy').length;
  if (p && e) return;
  s.winner = p ? 'player' : e ? 'enemy' : 'draw';
  s.active = null;
  events.push({ type: 'victory', winner: s.winner, reason: 'elimination' });
}

function applyStatus(s: BattleState, target: Unit, sourceId: string, kind: StatusKind, duration: number, amount: number, events: BattleEvent[]) {
  const ownTurn = s.active?.unitId === target.id;
  const existing = target.statuses.find((st) => st.kind === kind);
  if (existing) {
    existing.remaining = Math.max(existing.remaining, duration);
    existing.amount = Math.max(existing.amount, amount);
    existing.sourceId = sourceId;
    existing.fresh = existing.fresh || ownTurn;
  } else {
    target.statuses.push({ kind, remaining: duration, amount, sourceId, fresh: ownTurn });
  }
  events.push({ type: 'status', unitId: target.id, status: kind });
}

function reposition(u: Unit, to: Pos, mode: 'push' | 'dash' | 'teleport' | 'swap', events: BattleEvent[]) {
  const from = { ...u.pos };
  u.pos = { ...to };
  events.push({ type: 'reposition', unitId: u.id, from, to: { ...to }, mode });
}

function push(s: BattleState, caster: Unit, target: Unit, distance: number, events: BattleEvent[]) {
  const d = stepToward(caster.pos, target.pos);
  if (d.x === 0 && d.y === 0) return;
  let dest = { ...target.pos };
  let collided = false;
  for (let i = 0; i < distance; i++) {
    const next = { x: dest.x + d.x, y: dest.y + d.y };
    if (!isWalkable(s.board, next) || unitAt(s, next)) {
      collided = true;
      break;
    }
    dest = next;
  }
  if (!samePos(dest, target.pos)) reposition(target, dest, 'push', events);
  if (collided) dealDamage(s, target, caster.id, RULES.collisionDamage, ['collision'], events);
}

function affects(caster: Unit, other: Unit, ability: Ability): boolean {
  if (ability.affects === 'all') return true;
  return ability.affects === 'allies' ? other.side === caster.side : other.side !== caster.side;
}

/**
 * Resolves an ability's effects without touching turn flow.
 * Used by `applyCommand`, by previews and by the AI.
 */
export function resolveAbility(s: BattleState, caster: Unit, ability: Ability, target: Pos, events: BattleEvent[]) {
  const area = areaOf(s, caster, ability, target);
  events.push({ type: 'abilityUsed', unitId: caster.id, abilityId: ability.id, target: { ...target }, area });
  if (ability.cooldown > 0) caster.cooldowns[ability.id] = ability.cooldown;

  // Caster-level effects first.
  for (const effect of ability.effects) {
    if (effect.kind === 'dash') {
      const d = stepToward(caster.pos, target);
      const dest = { x: target.x - d.x, y: target.y - d.y };
      if (!samePos(dest, caster.pos)) reposition(caster, dest, 'dash', events);
    } else if (effect.kind === 'teleport') {
      reposition(caster, target, 'teleport', events);
    } else if (effect.kind === 'swap') {
      const other = unitAt(s, target);
      if (other) {
        const a = { ...caster.pos };
        reposition(caster, other.pos, 'swap', events);
        reposition(other, a, 'swap', events);
      }
    }
  }

  // Snapshot affected units before effects move anyone around.
  const victims = area
    .map((p) => unitAt(s, p))
    .filter((u): u is Unit => !!u && affects(caster, u, ability));
  if (ability.effects.some((e) => e.kind === 'swap' || e.kind === 'teleport')) return;

  for (const v of victims) {
    for (const effect of ability.effects) {
      if (!v.alive || s.winner) break;
      switch (effect.kind) {
        case 'damage': {
          const q = computeDamage(s, caster, v, effect);
          dealDamage(s, v, caster.id, q.amount, q.tags, events);
          break;
        }
        case 'heal': {
          const amount = Math.min(effect.amount, maxHp(v) - v.hp);
          v.hp += amount;
          caster.combat.healingDone += amount;
          events.push({ type: 'heal', unitId: v.id, amount });
          break;
        }
        case 'shield':
          v.shield += effect.amount;
          events.push({ type: 'shield', unitId: v.id, amount: effect.amount });
          break;
        case 'status':
          applyStatus(s, v, caster.id, effect.status, effect.duration, effect.amount ?? 0, events);
          break;
        case 'push':
          push(s, caster, v, effect.distance, events);
          break;
        case 'cleanse':
          v.statuses = v.statuses.filter((st) => !NEGATIVE.includes(st.kind));
          events.push({ type: 'cleanse', unitId: v.id });
          break;
        case 'extraTurn':
          s.queue.splice(1, 0, v.id);
          events.push({ type: 'extraTurn', unitId: v.id });
          break;
        default:
          break;
      }
    }
  }
}

// ---------------------------------------------------------------- turn flow

function startNextTurn(s: BattleState, events: BattleEvent[]) {
  while (!s.winner) {
    if (s.queue.length === 0) {
      if (s.round >= RULES.maxRounds) {
        resolveTimeout(s, events);
        return;
      }
      s.round += 1;
      s.queue = roundOrder(s);
      events.push({ type: 'roundStart', round: s.round });
    }
    const unit = getUnit(s, s.queue[0]);
    if (!unit.alive) {
      s.queue.shift();
      continue;
    }
    events.push({ type: 'turnStart', unitId: unit.id });
    for (const k of Object.keys(unit.cooldowns)) unit.cooldowns[k] = Math.max(0, unit.cooldowns[k] - 1);
    s.active = { unitId: unit.id, preMovePos: { ...unit.pos }, canUndo: false, moved: false, acted: false, usedQuick: false, canMove: true };

    const burn = unit.statuses.find((st) => st.kind === 'burn');
    if (burn) dealDamage(s, unit, burn.sourceId, burn.amount, ['burn'], events);
    if (s.winner) return;
    if (!unit.alive) {
      s.active = null;
      s.queue.shift();
      continue;
    }
    if (hasStatus(unit, 'stun')) {
      events.push({ type: 'skipTurn', unitId: unit.id });
      closeTurn(s, unit, events);
      continue;
    }
    s.active.canMove = !hasStatus(unit, 'root');
    return;
  }
}

function closeTurn(s: BattleState, unit: Unit, events: BattleEvent[]) {
  events.push({ type: 'turnEnd', unitId: unit.id });
  const kept = [];
  for (const st of unit.statuses) {
    if (st.fresh) {
      st.fresh = false;
      kept.push(st);
      continue;
    }
    st.remaining -= 1;
    if (st.remaining > 0) kept.push(st);
    else events.push({ type: 'statusExpired', unitId: unit.id, status: st.kind });
  }
  unit.statuses = kept;
  s.queue.shift();
  s.active = null;
  s.turnsTaken += 1;
}

function resolveTimeout(s: BattleState, events: BattleEvent[]) {
  const pct = (side: Side) =>
    aliveUnits(s, side).reduce((sum, u) => sum + u.hp, 0) /
    s.units.filter((u) => u.side === side).reduce((sum, u) => sum + maxHp(u), 0);
  const p = pct('player');
  const e = pct('enemy');
  s.winner = Math.abs(p - e) < 0.001 ? 'draw' : p > e ? 'player' : 'enemy';
  s.active = null;
  events.push({ type: 'victory', winner: s.winner, reason: 'timeout' });
}

/** Moves the active unit (no turn flow). */
export function moveUnit(s: BattleState, to: Pos, events: BattleEvent[]) {
  const a = s.active;
  if (!a) throw new Error('No active unit');
  if (a.moved || a.acted || !a.canMove) throw new Error('Cannot move now');
  const unit = getUnit(s, a.unitId);
  const reach = reachableTiles(s, unit.id).get(posKey(to));
  if (!reach || samePos(to, unit.pos)) throw new Error('Unreachable tile');
  a.preMovePos = { ...unit.pos };
  unit.pos = { ...to };
  a.moved = true;
  a.canUndo = true;
  events.push({ type: 'move', unitId: unit.id, path: reach.path });
}

/** Applies a player/AI command with full validation and turn flow. */
export function applyCommand(s: BattleState, cmd: Command): BattleEvent[] {
  const events: BattleEvent[] = [];
  if (s.winner) return events;
  const a = s.active;
  if (!a) throw new Error('No active unit');
  const unit = getUnit(s, a.unitId);

  switch (cmd.type) {
    case 'move':
      moveUnit(s, cmd.to, events);
      break;
    case 'undoMove':
      if (!a.canUndo) throw new Error('Nothing to undo');
      unit.pos = { ...a.preMovePos };
      a.moved = false;
      a.canUndo = false;
      events.push({ type: 'undoMove', unitId: unit.id, to: { ...unit.pos } });
      break;
    case 'ability': {
      const check = canUseAbility(s, unit.id, cmd.abilityId);
      if (!check.ok) throw new Error(check.reason);
      const ability = findAbility(unit.heroId, cmd.abilityId);
      if (!isValidTarget(s, unit, ability, cmd.target)) throw new Error('Invalid target');
      resolveAbility(s, unit, ability, cmd.target, events);
      if (s.winner) break;
      a.canUndo = false;
      if (ability.quick) {
        a.usedQuick = true;
      } else {
        a.acted = true;
        closeTurn(s, unit, events);
        startNextTurn(s, events);
      }
      break;
    }
    case 'endTurn':
      closeTurn(s, unit, events);
      startNextTurn(s, events);
      break;
  }
  return events;
}

// ---------------------------------------------------------------- previews

export interface PreviewEntry {
  unitId: string;
  damage: number;
  heal: number;
  shield: number;
  lethal: boolean;
  statuses: StatusKind[];
  moved: boolean;
  tags: DamageTag[];
}

/** Simulates an ability on a copy of the state and summarises the outcome per unit. */
export function previewAbility(s: BattleState, unitId: string, abilityId: string, target: Pos): PreviewEntry[] {
  const sim = cloneState(s);
  const caster = getUnit(sim, unitId);
  const ability = findAbility(caster.heroId, abilityId);
  if (!isValidTarget(sim, caster, ability, target)) return [];
  const events: BattleEvent[] = [];
  resolveAbility(sim, caster, ability, target, events);
  const byUnit = new Map<string, PreviewEntry>();
  const entry = (id: string) => {
    let e = byUnit.get(id);
    if (!e) {
      e = { unitId: id, damage: 0, heal: 0, shield: 0, lethal: false, statuses: [], moved: false, tags: [] };
      byUnit.set(id, e);
    }
    return e;
  };
  for (const ev of events) {
    if (ev.type === 'damage') {
      const e = entry(ev.unitId);
      e.damage += ev.amount;
      e.tags.push(...ev.tags);
    } else if (ev.type === 'heal') entry(ev.unitId).heal += ev.amount;
    else if (ev.type === 'shield') entry(ev.unitId).shield += ev.amount;
    else if (ev.type === 'status') entry(ev.unitId).statuses.push(ev.status);
    else if (ev.type === 'death') entry(ev.unitId).lethal = true;
    else if (ev.type === 'reposition' && ev.unitId !== unitId) entry(ev.unitId).moved = true;
    else if (ev.type === 'extraTurn') entry(ev.unitId);
  }
  return [...byUnit.values()];
}

export { heroAbilities };

// Core vocabulary of the combat domain. Pure data — no rendering, no DOM.

export type Side = 'player' | 'enemy';

export interface Pos {
  x: number;
  y: number;
}

export type Terrain = 'plain' | 'forest' | 'hill' | 'rock' | 'water';

export type HeroClass = 'warrior' | 'ranger' | 'mage' | 'support';

export interface Stats {
  maxHp: number;
  atk: number;
  def: number;
  mov: number;
  spd: number;
}

/** Statuses tick on their owner's turns. See `battle.ts` for the exact timing rules. */
export type StatusKind =
  | 'stun' // skips its next turn
  | 'root' // cannot move on its next turn
  | 'burn' // takes `amount` damage at the start of each turn
  | 'mark' // takes +amount% damage
  | 'weak' // deals -amount% damage
  | 'empower' // +amount ATK
  | 'guard'; // takes -50% damage

export interface StatusInstance {
  kind: StatusKind;
  /** Number of the owner's turn-ends it survives. */
  remaining: number;
  amount: number;
  sourceId: string;
  /** Applied during the owner's own turn: skips that turn's decrement. */
  fresh: boolean;
}

// ---------------------------------------------------------------- abilities

export type TargetRule =
  | 'enemy' // tile must hold an enemy
  | 'ally' // tile must hold an ally (self allowed when range.min is 0)
  | 'self'
  | 'unit' // any unit
  | 'emptyTile' // walkable, unoccupied tile
  | 'tile'; // any tile (area abilities)

export type Area =
  | { kind: 'single' }
  | { kind: 'around'; radius: number } // Manhattan radius around the target, centre included
  | { kind: 'adjacent' } // the 4 tiles around the caster
  | { kind: 'line'; length: number }; // from the caster towards the target

export type Affects = 'enemies' | 'allies' | 'all';

export type Effect =
  | { kind: 'damage'; power: number; magic?: boolean; ignoreCover?: boolean; executeBelow?: number }
  | { kind: 'heal'; amount: number }
  | { kind: 'shield'; amount: number }
  | { kind: 'status'; status: StatusKind; duration: number; amount?: number }
  | { kind: 'push'; distance: number }
  | { kind: 'cleanse' }
  | { kind: 'extraTurn' }
  // caster-level effects, resolved once before per-unit effects
  | { kind: 'dash' }
  | { kind: 'teleport' }
  | { kind: 'swap' };

export interface Ability {
  id: string;
  name: string;
  description: string;
  range: { min: number; max: number };
  target: TargetRule;
  /** Target must share a row or column with the caster. */
  straight?: boolean;
  area: Area;
  affects: Affects;
  cooldown: number;
  /** Quick abilities do not end the turn (one per turn). */
  quick?: boolean;
  effects: Effect[];
}

export interface HeroDef {
  id: string;
  name: string;
  title: string;
  heroClass: HeroClass;
  stats: Stats;
  attack: { min: number; max: number; magic: boolean };
  abilities: [Ability, Ability, Ability];
  lore: string;
  palette: { primary: number; secondary: number; skin: number; hair: number; accent: number };
}

// ---------------------------------------------------------------- runtime state

export interface CombatStats {
  damageDealt: number;
  damageTaken: number;
  healingDone: number;
  kills: number;
}

export interface Unit {
  id: string;
  heroId: string;
  side: Side;
  pos: Pos;
  hp: number;
  shield: number;
  alive: boolean;
  statuses: StatusInstance[];
  cooldowns: Record<string, number>;
  combat: CombatStats;
}

export interface ActiveTurn {
  unitId: string;
  /** Position before this turn's move, used by undo. */
  preMovePos: Pos;
  /** Undo is only possible right after a move. */
  canUndo: boolean;
  moved: boolean;
  acted: boolean;
  usedQuick: boolean;
  canMove: boolean;
}

export interface Board {
  width: number;
  height: number;
  name: string;
  tiles: Terrain[][]; // [y][x]
}

export interface BattleState {
  board: Board;
  units: Unit[];
  round: number;
  /** Units still to act this round; queue[0] is the active unit. */
  queue: string[];
  active: ActiveTurn | null;
  winner: Side | 'draw' | null;
  turnsTaken: number;
}

export type Command =
  | { type: 'move'; to: Pos }
  | { type: 'undoMove' }
  | { type: 'ability'; abilityId: string; target: Pos }
  | { type: 'endTurn' };

export type DamageTag = 'cover' | 'height' | 'flank' | 'mark' | 'guard' | 'weak' | 'execute' | 'collision' | 'burn';

export type BattleEvent =
  | { type: 'roundStart'; round: number }
  | { type: 'turnStart'; unitId: string }
  | { type: 'skipTurn'; unitId: string }
  | { type: 'move'; unitId: string; path: Pos[] }
  | { type: 'undoMove'; unitId: string; to: Pos }
  | { type: 'abilityUsed'; unitId: string; abilityId: string; target: Pos; area: Pos[] }
  | { type: 'damage'; unitId: string; sourceId: string; amount: number; absorbed: number; tags: DamageTag[] }
  | { type: 'heal'; unitId: string; amount: number }
  | { type: 'shield'; unitId: string; amount: number }
  | { type: 'status'; unitId: string; status: StatusKind }
  | { type: 'statusExpired'; unitId: string; status: StatusKind }
  | { type: 'cleanse'; unitId: string }
  | { type: 'reposition'; unitId: string; from: Pos; to: Pos; mode: 'push' | 'dash' | 'teleport' | 'swap' }
  | { type: 'extraTurn'; unitId: string }
  | { type: 'death'; unitId: string }
  | { type: 'turnEnd'; unitId: string }
  | { type: 'victory'; winner: Side | 'draw'; reason: 'elimination' | 'timeout' };

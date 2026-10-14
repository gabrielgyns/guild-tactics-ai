import { describe, expect, it } from 'vitest';
import { planTurn } from '../src/domain/ai';
import {
  applyCommand,
  canUseAbility,
  cloneState,
  computeDamage,
  createBattle,
  getUnit,
  previewAbility,
  reachableTiles,
  RULES,
  sideThreat,
  threatTiles,
  validTargets,
  type Deployment,
} from '../src/domain/battle';
import { MAPS, buildBoard, posKey } from '../src/domain/board';
import { HEROES } from '../src/domain/heroes';
import type { BattleState, Board, Terrain } from '../src/domain/types';

function flatBoard(overrides: Record<string, Terrain> = {}): Board {
  const tiles: Terrain[][] = [];
  for (let y = 0; y < 6; y++) {
    tiles.push([]);
    for (let x = 0; x < 6; x++) tiles[y].push(overrides[`${x},${y}`] ?? 'plain');
  }
  return { width: 6, height: 6, name: 'test', tiles };
}

function battle(player: Deployment[], enemy: Deployment[], board = flatBoard()) {
  return createBattle(board, player, enemy).state;
}

/** Forces a given unit to be the active one (for focused rule tests). */
function activate(s: BattleState, unitId: string) {
  const u = getUnit(s, unitId);
  s.queue = [unitId, ...s.queue.filter((id) => id !== unitId)];
  s.active = { unitId, preMovePos: { ...u.pos }, canUndo: false, moved: false, acted: false, usedQuick: false, canMove: true };
}

describe('turn order', () => {
  it('sorts by speed and the fastest unit starts', () => {
    const s = battle(
      [{ heroId: 'brann', pos: { x: 0, y: 5 } }],
      [{ heroId: 'tobin', pos: { x: 5, y: 0 } }],
    );
    expect(s.round).toBe(1);
    expect(s.active?.unitId).toBe('e0-tobin');
    expect(s.queue).toEqual(['e0-tobin', 'p0-brann']);
  });

  it('ending a turn passes to the next unit and starts a new round when empty', () => {
    const s = battle([{ heroId: 'brann', pos: { x: 0, y: 5 } }], [{ heroId: 'tobin', pos: { x: 5, y: 0 } }]);
    applyCommand(s, { type: 'endTurn' });
    expect(s.active?.unitId).toBe('p0-brann');
    const ev = applyCommand(s, { type: 'endTurn' });
    expect(ev.some((e) => e.type === 'roundStart' && e.round === 2)).toBe(true);
  });
});

describe('movement', () => {
  it('respects movement points and terrain cost', () => {
    const s = battle(
      [{ heroId: 'brann', pos: { x: 0, y: 5 } }],
      [{ heroId: 'kael', pos: { x: 5, y: 0 } }],
      flatBoard({ '0,4': 'forest', '1,5': 'rock' }),
    );
    activate(s, 'p0-brann');
    const reach = reachableTiles(s, 'p0-brann');
    expect(reach.has(posKey({ x: 0, y: 4 }))).toBe(true); // forest costs 2
    expect(reach.has(posKey({ x: 0, y: 3 }))).toBe(true); // 2 + 1
    expect(reach.has(posKey({ x: 0, y: 2 }))).toBe(false); // 4 > 3
    expect(reach.has(posKey({ x: 1, y: 5 }))).toBe(false); // rock
  });

  it('cannot pass through enemies but can pass through allies', () => {
    const s = battle(
      [
        { heroId: 'tobin', pos: { x: 0, y: 5 } },
        { heroId: 'mira', pos: { x: 0, y: 4 } },
      ],
      [{ heroId: 'kael', pos: { x: 1, y: 5 } }],
    );
    activate(s, 'p0-tobin');
    const reach = reachableTiles(s, 'p0-tobin');
    expect(reach.has(posKey({ x: 0, y: 3 }))).toBe(true); // through Mira
    expect(reach.has(posKey({ x: 0, y: 4 }))).toBe(false); // occupied by ally
    expect(reach.has(posKey({ x: 2, y: 5 }))).toBe(true); // around via (1,4)
  });

  it('undo returns the unit to where it was', () => {
    const s = battle([{ heroId: 'tobin', pos: { x: 0, y: 5 } }], [{ heroId: 'brann', pos: { x: 5, y: 0 } }]);
    applyCommand(s, { type: 'move', to: { x: 2, y: 3 } });
    applyCommand(s, { type: 'undoMove' });
    expect(getUnit(s, 'p0-tobin').pos).toEqual({ x: 0, y: 5 });
  });
});

describe('damage model', () => {
  const setup = (board = flatBoard()) =>
    battle(
      [
        { heroId: 'kael', pos: { x: 2, y: 3 } },
        { heroId: 'brann', pos: { x: 3, y: 2 } },
      ],
      [{ heroId: 'lyra', pos: { x: 2, y: 2 } }],
      board,
    );

  it('applies DEF reduction and the flank bonus', () => {
    const s = setup();
    const kael = getUnit(s, 'p0-kael');
    const lyra = getUnit(s, 'e0-lyra');
    const q = computeDamage(s, kael, lyra, { kind: 'damage', power: 1 });
    // 11 ATK × 1.25 pacing × 10/12 DEF = 11.46, flanked ×1.15, fire vs nature ×1.3 = 17.1
    expect(q.amount).toBe(17);
    expect(q.tags).toContain('advantage');
    expect(q.tags).toContain('flank');
  });

  it('forest gives cover and hills give height', () => {
    const s = setup(flatBoard({ '2,2': 'forest', '2,3': 'hill' }));
    const q = computeDamage(s, getUnit(s, 'p0-kael'), getUnit(s, 'e0-lyra'), { kind: 'damage', power: 1 });
    expect(q.tags).toEqual(expect.arrayContaining(['cover', 'height', 'flank']));
  });

  it('shield absorbs damage before HP', () => {
    const s = setup();
    activate(s, 'p0-kael');
    getUnit(s, 'e0-lyra').shield = 5;
    applyCommand(s, { type: 'ability', abilityId: 'attack', target: { x: 2, y: 2 } });
    const lyra = getUnit(s, 'e0-lyra');
    expect(lyra.shield).toBe(0);
    expect(lyra.hp).toBe(20 - (17 - 5));
  });

  it('execute doubles damage on wounded targets', () => {
    const s = setup();
    activate(s, 'p0-kael');
    getUnit(s, 'e0-lyra').hp = 10;
    const [entry] = previewAbility(s, 'p0-kael', 'execute', { x: 2, y: 2 });
    expect(entry.tags).toContain('execute');
    expect(entry.lethal).toBe(true);
  });
});

describe('abilities', () => {
  it('stun makes the target skip its next turn', () => {
    const s = battle([{ heroId: 'brann', pos: { x: 2, y: 3 } }], [{ heroId: 'kael', pos: { x: 2, y: 2 } }]);
    activate(s, 'p0-brann');
    const ev = applyCommand(s, { type: 'ability', abilityId: 'shield_bash', target: { x: 2, y: 2 } });
    expect(ev.some((e) => e.type === 'skipTurn' && e.unitId === 'e0-kael')).toBe(true);
    expect(getUnit(s, 'e0-kael').statuses.length).toBe(0);
  });

  it('push collides with obstacles for extra damage', () => {
    const s = battle(
      [{ heroId: 'tobin', pos: { x: 2, y: 5 } }],
      [{ heroId: 'kael', pos: { x: 2, y: 3 } }],
      flatBoard({ '2,1': 'rock' }),
    );
    activate(s, 'p0-tobin');
    const ev = applyCommand(s, { type: 'ability', abilityId: 'repel', target: { x: 2, y: 3 } });
    expect(getUnit(s, 'e0-kael').pos).toEqual({ x: 2, y: 2 });
    expect(ev.some((e) => e.type === 'damage' && e.tags.includes('collision'))).toBe(true);
  });

  it('charge dashes next to the target and needs a clear line', () => {
    const s = battle(
      [{ heroId: 'brann', pos: { x: 2, y: 5 } }],
      [
        { heroId: 'lyra', pos: { x: 2, y: 2 } },
        { heroId: 'mira', pos: { x: 4, y: 4 } },
      ],
    );
    activate(s, 'p0-brann');
    expect(validTargets(s, 'p0-brann', 'charge')).toEqual([{ x: 2, y: 2 }]);
    applyCommand(s, { type: 'ability', abilityId: 'charge', target: { x: 2, y: 2 } });
    expect(getUnit(s, 'p0-brann').pos).toEqual({ x: 2, y: 3 });
    expect(getUnit(s, 'e0-lyra').pos).toEqual({ x: 2, y: 1 });
  });

  it('quick abilities do not end the turn, but only one per turn', () => {
    const s = battle([{ heroId: 'kael', pos: { x: 2, y: 3 } }], [{ heroId: 'mira', pos: { x: 2, y: 0 } }]);
    activate(s, 'p0-kael');
    applyCommand(s, { type: 'ability', abilityId: 'fury', target: { x: 2, y: 3 } });
    expect(s.active?.unitId).toBe('p0-kael');
    expect(getUnit(s, 'p0-kael').statuses[0].kind).toBe('empower');
    applyCommand(s, { type: 'move', to: { x: 2, y: 1 } });
    applyCommand(s, { type: 'ability', abilityId: 'attack', target: { x: 2, y: 0 } });
    // (11 + 4) × 1.25 × 10/13 = 14.4 → 14 (fire vs light is neutral)
    expect(getUnit(s, 'e0-mira').hp).toBe(8);
  });

  it('cooldowns block reuse until enough turns passed', () => {
    const s = battle([{ heroId: 'lyra', pos: { x: 2, y: 5 } }], [{ heroId: 'brann', pos: { x: 2, y: 2 } }]);
    activate(s, 'p0-lyra');
    applyCommand(s, { type: 'ability', abilityId: 'aimed', target: { x: 2, y: 2 } });
    applyCommand(s, { type: 'endTurn' }); // brann
    expect(s.active?.unitId).toBe('p0-lyra');
    expect(canUseAbility(s, 'p0-lyra', 'aimed').ok).toBe(false);
  });

  it('inspire grants the ally the very next turn', () => {
    const s = battle(
      [
        { heroId: 'orrin', pos: { x: 2, y: 5 } },
        { heroId: 'brann', pos: { x: 3, y: 5 } },
      ],
      [{ heroId: 'kael', pos: { x: 0, y: 0 } }],
    );
    activate(s, 'p0-orrin');
    applyCommand(s, { type: 'ability', abilityId: 'inspire', target: { x: 3, y: 5 } });
    expect(s.active?.unitId).toBe('p1-brann');
  });

  it('a guard from Defend lasts through the enemy turns', () => {
    const s = battle([{ heroId: 'tobin', pos: { x: 2, y: 3 } }], [{ heroId: 'kael', pos: { x: 2, y: 2 } }]);
    activate(s, 'p0-tobin');
    applyCommand(s, { type: 'ability', abilityId: 'defend', target: { x: 2, y: 3 } });
    expect(s.active?.unitId).toBe('e0-kael');
    const [entry] = previewAbility(s, 'e0-kael', 'attack', { x: 2, y: 3 });
    expect(entry.tags).toContain('guard');
  });
});

describe('elements and shrines', () => {
  it('fire beats nature, water resists fire, light and shadow beat each other', () => {
    const s = battle(
      [
        { heroId: 'seren', pos: { x: 0, y: 5 } },
        { heroId: 'mira', pos: { x: 5, y: 5 } },
      ],
      [
        { heroId: 'lyra', pos: { x: 0, y: 0 } },
        { heroId: 'vex', pos: { x: 3, y: 0 } },
        { heroId: 'orrin', pos: { x: 5, y: 0 } },
      ],
    );
    const hit = (a: string, t: string) => computeDamage(s, getUnit(s, a), getUnit(s, t), { kind: 'damage', power: 1 }).tags;
    expect(hit('p0-seren', 'e0-lyra')).toContain('advantage');
    expect(hit('p0-seren', 'e1-vex')).toContain('resisted');
    expect(hit('p1-mira', 'e2-orrin')).toContain('advantage');
    expect(hit('e2-orrin', 'p1-mira')).toContain('advantage');
  });

  it('a shrine heals and charges the unit that starts its turn on it', () => {
    const s = battle(
      [{ heroId: 'tobin', pos: { x: 2, y: 2 }, hp: 10 }],
      [{ heroId: 'brann', pos: { x: 5, y: 0 } }],
      flatBoard({ '2,2': 'shrine' }),
    );
    // Tobin (speed 8) acts first and starts on the shrine.
    expect(getUnit(s, 'p0-tobin').hp).toBe(14);
    expect(getUnit(s, 'p0-tobin').energy).toBe(RULES.energyPerTurn + RULES.shrineEnergy);
  });

  it('deployments can carry bonuses, starting HP and energy', () => {
    const s = battle([{ heroId: 'brann', pos: { x: 0, y: 5 }, bonus: { atk: 3, maxHp: 6 }, hp: 20, energy: 50 }], [{ heroId: 'kael', pos: { x: 5, y: 0 } }]);
    const b = getUnit(s, 'p0-brann');
    expect(b.stats.atk).toBe(11);
    expect(b.stats.maxHp).toBe(40);
    expect(b.hp).toBe(20);
    expect(b.energy).toBeGreaterThanOrEqual(50);
  });
});

describe('energy and ultimates', () => {
  it('energy fills at turn start and from damage, and ultimates need a full bar', () => {
    const s = battle([{ heroId: 'kael', pos: { x: 2, y: 3 } }], [{ heroId: 'lyra', pos: { x: 2, y: 2 } }]);
    activate(s, 'p0-kael');
    expect(canUseAbility(s, 'p0-kael', 'blade_dance').ok).toBe(false);
    const before = getUnit(s, 'e0-lyra').energy;
    applyCommand(s, { type: 'ability', abilityId: 'attack', target: { x: 2, y: 2 } });
    expect(getUnit(s, 'p0-kael').energy).toBeGreaterThan(0);
    // Lyra took damage and then started her turn.
    expect(getUnit(s, 'e0-lyra').energy).toBeGreaterThan(before + RULES.energyPerTurn);
  });

  it('using an ultimate empties the bar; blade dance hits twice', () => {
    const s = battle([{ heroId: 'kael', pos: { x: 2, y: 3 } }], [{ heroId: 'brann', pos: { x: 2, y: 2 } }]);
    activate(s, 'p0-kael');
    getUnit(s, 'p0-kael').energy = RULES.energyMax;
    const ev = applyCommand(s, { type: 'ability', abilityId: 'blade_dance', target: { x: 2, y: 2 } });
    expect(ev.filter((e) => e.type === 'damage').length).toBe(2);
    expect(getUnit(s, 'p0-kael').energy).toBeLessThan(RULES.energyMax);
  });
});

describe('threat zone', () => {
  it('covers move range plus attack range, and nothing for stunned units', () => {
    const s = battle([{ heroId: 'mira', pos: { x: 0, y: 5 } }], [{ heroId: 'kael', pos: { x: 0, y: 0 } }]);
    const tiles = threatTiles(s, 'e0-kael');
    // Kael: 3 move + 1 reach from (0,0) → Manhattan 4 on open ground.
    expect(tiles.some((p) => p.x === 0 && p.y === 4)).toBe(true);
    expect(tiles.some((p) => p.x === 0 && p.y === 5)).toBe(false);
    expect(sideThreat(s, 'player').has('0,4')).toBe(true);
    getUnit(s, 'e0-kael').statuses.push({ kind: 'stun', remaining: 1, amount: 0, sourceId: 'x', fresh: false });
    expect(threatTiles(s, 'e0-kael')).toEqual([]);
  });
});

describe('full matches (AI vs AI)', () => {
  function seeded(seed: number) {
    let t = seed;
    return () => {
      t = (t + 0x6d2b79f5) | 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('always terminate with a winner within the round limit', () => {
    const rand = seeded(42);
    const ids = HEROES.map((h) => h.id);
    for (let m = 0; m < 6; m++) {
      const pick = () => [...ids].sort(() => rand() - 0.5).slice(0, 4);
      const map = MAPS[m % MAPS.length];
      const board = buildBoard(map);
      const spots = (rows: number[]) => {
        const out = [];
        for (const y of rows) for (let x = 0; x < 6; x++) if (board.tiles[y][x] === 'plain') out.push({ x, y });
        return out;
      };
      const pp = spots([5, 4]);
      const ep = spots([0, 1]);
      const s = createBattle(
        board,
        pick().map((heroId, i) => ({ heroId, pos: pp[i] })),
        pick().map((heroId, i) => ({ heroId, pos: ep[i] })),
      ).state;
      let guard = 0;
      while (!s.winner && guard++ < 500) {
        for (const cmd of planTurn(cloneState(s), { noise: 1, random: rand })) {
          if (s.winner) break;
          applyCommand(s, cmd);
        }
      }
      expect(s.winner).not.toBeNull();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { computeDamage, createBattle, getUnit } from '../src/domain/battle';
import { HEROES } from '../src/domain/heroes';
import { addBonus, bondGain, bondLevel, BOND_LEVELS, rollItem, SPECIALIZATIONS, specializationsFor } from '../src/domain/progression';
import { mulberry32 } from '../src/domain/rng';
import type { Board, Terrain } from '../src/domain/types';

const flat = (): Board => ({ width: 6, height: 6, name: 't', tiles: Array.from({ length: 6 }, () => Array<Terrain>(6).fill('plain')) });

describe('bonds', () => {
  it('levels follow the point table and a match together earns 1–3 points', () => {
    expect(bondLevel(0)).toBe(0);
    expect(bondLevel(BOND_LEVELS[1].points)).toBe(1);
    expect(bondLevel(999)).toBe(3);
    expect(bondGain(true, true)).toBe(3);
    expect(bondGain(false, false)).toBe(1);
  });

  it('a bonded ally next to the attacker adds damage; next to the target it protects', () => {
    const make = (bonded: boolean) =>
      createBattle(
        flat(),
        [
          { heroId: 'kael', pos: { x: 2, y: 3 }, bonds: bonded ? { mira: 3 } : undefined },
          { heroId: 'mira', pos: { x: 1, y: 3 }, bonds: bonded ? { kael: 3 } : undefined },
        ],
        [{ heroId: 'orrin', pos: { x: 2, y: 2 } }],
      ).state;
    const hit = (s: ReturnType<typeof make>) => computeDamage(s, getUnit(s, 'p0-kael'), getUnit(s, 'e0-orrin'), { kind: 'damage', power: 1 });
    const plain = hit(make(false));
    const bonded = hit(make(true));
    expect(bonded.tags).toContain('bond');
    expect(bonded.amount).toBeGreaterThan(plain.amount);
    const s = make(true);
    const taken = computeDamage(s, getUnit(s, 'e0-orrin'), getUnit(s, 'p0-kael'), { kind: 'damage', power: 1 });
    expect(taken.tags).toContain('bondGuard');
  });
});

describe('specializations', () => {
  it('every class has two sidegrades with both a gain and a cost', () => {
    for (const pair of Object.values(SPECIALIZATIONS)) {
      expect(pair).toHaveLength(2);
      for (const sp of pair) {
        const values = Object.values(sp.bonus);
        expect(values.some((v) => v > 0)).toBe(true);
        expect(values.some((v) => v < 0)).toBe(true);
      }
    }
    for (const h of HEROES) expect(specializationsFor(h.id)).toHaveLength(2);
  });
});

describe('equipment', () => {
  it('rolls items of every slot and luck raises rarity', () => {
    const rng = mulberry32(1);
    const plain = Array.from({ length: 400 }, () => rollItem(rng, 0));
    const lucky = Array.from({ length: 400 }, () => rollItem(rng, 1));
    expect(new Set(plain.map((i) => i.slot)).size).toBe(3);
    const epic = (xs: typeof plain) => xs.filter((i) => i.rarity === 'epic').length;
    expect(epic(lucky)).toBeGreaterThan(epic(plain));
    for (const i of plain) expect(Object.values(i.bonus).every((v) => v > 0)).toBe(true);
    expect(addBonus({ atk: 1 }, { atk: 2, def: 1 })).toEqual({ atk: 3, def: 1 });
  });
});

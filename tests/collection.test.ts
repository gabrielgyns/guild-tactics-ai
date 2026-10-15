import { describe, expect, it } from 'vitest';
import { HEROES } from '../src/domain/heroes';
import { applyTraits, teamTraits } from '../src/domain/traits';
import { levelFor, levelProgress, LEVEL_XP, skinOf, xpForUnit } from '../src/game/mastery';
import type { Unit } from '../src/domain/types';

describe('roster', () => {
  it('has three heroes per class and every hero is complete', () => {
    expect(HEROES).toHaveLength(16);
    for (const cls of ['warrior', 'ranger', 'mage', 'support']) expect(HEROES.filter((h) => h.heroClass === cls)).toHaveLength(4);
    for (const h of HEROES) {
      expect(h.abilities).toHaveLength(3);
      expect(h.ultimate.ultimate).toBe(true);
      expect(new Set([...h.abilities.map((a) => a.id), h.ultimate.id]).size).toBe(4);
    }
  });
});

describe('guild traits', () => {
  it('a balanced team gets starting energy', () => {
    const t = teamTraits(['brann', 'lyra', 'seren', 'mira']);
    expect(t.find((x) => x.id === 'balanced')!.active).toBe(true);
    const team = applyTraits([
      { heroId: 'brann' },
      { heroId: 'lyra' },
      { heroId: 'seren' },
      { heroId: 'mira' },
    ]);
    expect(team.every((d) => d.energy === 15)).toBe(true);
  });

  it('class pairs, shared elements and light+shadow stack bonuses on the right heroes', () => {
    // brann+dagna: vanguard; brann+lyra+fenna: nature x3; dagna (light) + nothing shadow.
    const team = applyTraits([{ heroId: 'brann' }, { heroId: 'dagna' }, { heroId: 'lyra' }, { heroId: 'fenna' }]);
    const by = (id: string) => team.find((d) => d.heroId === id)!;
    expect(by('brann').bonus!.def).toBe(2);
    expect(by('dagna').bonus!.def).toBe(2);
    expect(by('brann').bonus!.atk).toBe(2); // nature ×3
    expect(by('lyra').bonus!.maxHp).toBe(6);
    expect(by('dagna').bonus!.atk ?? 0).toBe(0);
    const tw = applyTraits([{ heroId: 'dagna' }, { heroId: 'nyx' }, { heroId: 'seren' }, { heroId: 'mira' }]);
    expect(tw.find((d) => d.heroId === 'nyx')!.bonus!.atk).toBe(2);
    expect(tw.find((d) => d.heroId === 'seren')!.bonus!.atk ?? 0).toBe(0);
  });
});

describe('mastery', () => {
  it('levels follow the XP table and only unlocked skins are worn', () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(LEVEL_XP[2])).toBe(3);
    expect(levelFor(99999)).toBe(5);
    expect(levelProgress(LEVEL_XP[1] + 10)).toEqual({ level: 2, into: 10, span: LEVEL_XP[2] - LEVEL_XP[1] });
    expect(skinOf({ xp: { kael: 0 }, skins: { kael: 'legend' } }, 'kael')).toBe('classic');
    expect(skinOf({ xp: { kael: 9999 }, skins: { kael: 'legend' } }, 'kael')).toBe('legend');
  });

  it('XP rewards winning, kills and MVP', () => {
    const u = { combat: { kills: 2, damageDealt: 0, damageTaken: 0, healingDone: 0 } } as Unit;
    expect(xpForUnit(u, true, true)).toBe(20 + 20 + 8 + 10);
    expect(xpForUnit(u, false, false)).toBe(28);
  });
});

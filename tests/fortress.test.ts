import { describe, expect, it } from 'vitest';
import { canUpgrade, collectMine, expeditionPerks, masteryMultiplier, minePending, MINE_CAP_HOURS, MINE_RATE, newFortress, upgrade } from '../src/domain/fortress';
import { offerRewards, recordBattle, startExpedition } from '../src/domain/expedition';
import { mulberry32 } from '../src/domain/rng';
import type { BattleState } from '../src/domain/types';

const H = 3_600_000;

describe('fortress', () => {
  it('buildings cost gold and respect the keep level', () => {
    let f = { ...newFortress(0), gold: 1000 };
    expect(canUpgrade(f, 'mine').ok).toBe(true);
    f = upgrade(f, 'mine', 0);
    expect(f.levels.mine).toBe(1);
    expect(f.gold).toBe(1000 - 60);
    const blocked = canUpgrade(f, 'mine');
    expect(blocked.ok).toBe(false); // needs keep level 2
    f = upgrade(f, 'keep', 0);
    expect(canUpgrade(f, 'mine').ok).toBe(true);
    expect(canUpgrade({ ...f, gold: 0 }, 'mine').ok).toBe(false);
    expect(() => upgrade({ ...f, gold: 0 }, 'mine', 0)).toThrow();
  });

  it('the mine produces gold over real time, up to its storage cap', () => {
    let f = upgrade({ ...newFortress(0), gold: 60 }, 'mine', 0);
    expect(minePending(f, 2 * H)).toBe(2 * MINE_RATE[1]);
    expect(minePending(f, 100 * H)).toBe(MINE_CAP_HOURS * MINE_RATE[1]);
    f = collectMine(f, 3 * H);
    expect(f.gold).toBe(3 * MINE_RATE[1]);
    expect(minePending(f, 3 * H)).toBe(0);
  });

  it('buildings feed PvE perks: barracks XP, infirmary rest, forge relics, map room rewards', () => {
    const f = { ...newFortress(0), levels: { keep: 3, mine: 0, barracks: 2, infirmary: 3, forge: 2, maproom: 1 } };
    expect(masteryMultiplier(f)).toBeCloseTo(1.3);
    const perks = expeditionPerks(f);
    const e = startExpedition(['brann', 'lyra', 'seren', 'mira'], 5, perks);
    expect(e.relics).toHaveLength(2);
    expect(offerRewards(e, mulberry32(1))).toHaveLength(4);
    // Rest heal includes the infirmary bonus.
    const state = {
      winner: 'player',
      units: e.roster.map((h, i) => ({ id: `p${i}`, heroId: h.heroId, side: 'player', alive: true, hp: 1 })),
    } as unknown as BattleState;
    const next = recordBattle(e, state, mulberry32(2));
    const brann = next.roster[0];
    expect(brann.hp).toBe(1 + Math.round((34 + (e.relics.includes('amulet') ? 6 : 0)) * (0.35 + 0.3)));
  });
});

import { describe, expect, it } from 'vitest';
import { applyCommand, cloneState, createBattle } from '../src/domain/battle';
import { planTurn } from '../src/domain/ai';
import { MAPS, buildBoard } from '../src/domain/board';
import { autoDeploy } from '../src/domain/deploy';
import {
  decodeDefense,
  defenseDeployments,
  eloDelta,
  encodeDefense,
  generateDefense,
  seasonKey,
  seasonRivals,
  seasonWar,
  softReset,
  tierOf,
  validateDefense,
  warOutcome,
} from '../src/domain/arena';
import { mulberry32 } from '../src/domain/rng';
import type { Command } from '../src/domain/types';

describe('defense codes', () => {
  it('round-trip through a shareable code, including non-ASCII guild names', () => {
    const d = { ...generateDefense(mulberry32(3), 'Ordem do Carvalho ÇÃ', 0x3f7d4a) };
    const code = encodeDefense(d);
    expect(code.startsWith('GT1-')).toBe(true);
    expect(decodeDefense(code)).toEqual(d);
  });

  it('reject garbage and invalid formations with a readable reason', () => {
    expect(() => decodeDefense('hello')).toThrow(/GT1-/);
    expect(() => decodeDefense('GT1-@@@')).toThrow();
    const d = generateDefense(mulberry32(4), 'X', 1);
    expect(validateDefense({ ...d, slots: d.slots.slice(0, 3) })).toMatch(/4 heróis/);
    expect(validateDefense({ ...d, slots: [d.slots[0], d.slots[0], d.slots[1], d.slots[2]] })).toMatch(/repetidos/);
  });
});

describe('seasons and rating', () => {
  it('seasons are ISO weeks and rivals are the same for everyone in a week', () => {
    expect(seasonKey(new Date(2026, 9, 14))).toBe('2026-W42');
    expect(seasonRivals('2026-W42')).toEqual(seasonRivals('2026-W42'));
    for (const r of seasonRivals('2026-W42')) expect(validateDefense(r.defense)).toBeNull();
  });

  it('Elo rewards upsets more and season resets halve the distance to 1000', () => {
    expect(eloDelta(1000, 1300, true)).toBeGreaterThan(eloDelta(1000, 800, true));
    expect(eloDelta(1000, 1000, false)).toBe(-16);
    expect(softReset(1300)).toBe(1150);
    expect(tierOf(1310).name).toBe('Diamante');
  });

  it('a guild war is won with two fronts', () => {
    const w = seasonWar('2026-W42');
    expect(warOutcome(w)).toBe('ongoing');
    w.fronts[0].result = 'won';
    w.fronts[2].result = 'won';
    expect(warOutcome(w)).toBe('won');
  });
});

describe('replays', () => {
  it('re-running the recorded commands from the same deployments reproduces the battle exactly', () => {
    const def = seasonRivals('2026-W42')[0].defense;
    const map = MAPS.find((m) => m.id === def.mapId)!;
    const board = buildBoard(map);
    const player = autoDeploy(board, ['dagna', 'nyx', 'seren', 'maris'].map((heroId) => ({ heroId })), 'player');
    const enemy = defenseDeployments(def);
    const live = createBattle(board, player, enemy).state;
    const log: Command[] = [];
    const rng = mulberry32(8);
    while (!live.winner) for (const c of planTurn(cloneState(live), { noise: 2, random: rng })) {
      if (live.winner) break;
      applyCommand(live, c);
      log.push(c);
    }
    const replay = createBattle(board, player, enemy).state;
    for (const c of log) applyCommand(replay, c);
    expect(replay.winner).toBe(live.winner);
    expect(replay.units.map((u) => [u.id, u.hp, u.pos])).toEqual(live.units.map((u) => [u.id, u.hp, u.pos]));
  });
});

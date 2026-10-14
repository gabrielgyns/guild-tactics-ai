import { describe, expect, it } from 'vitest';
import { applyCommand, cloneState, createBattle, getUnit } from '../src/domain/battle';
import { MAPS, buildBoard } from '../src/domain/board';
import { dailyChallenge } from '../src/domain/daily';
import { autoDeploy } from '../src/domain/deploy';
import { aiDraftPick, available, draftPick, draftSide, newDraft } from '../src/domain/draft';
import {
  EXPEDITION_STAGES,
  chooseReward,
  enemyTeamForBattle,
  heroMaxHp,
  playerTeamForBattle,
  recordBattle,
  startExpedition,
} from '../src/domain/expedition';
import { PUZZLES, puzzleBattle, puzzleFailed, solvePuzzle } from '../src/domain/puzzles';
import { mulberry32 } from '../src/domain/rng';

const TEAM = ['brann', 'lyra', 'seren', 'mira'];

function battleFor(e: ReturnType<typeof startExpedition>) {
  const board = buildBoard(MAPS.find((m) => m.id === e.stages[e.stage].mapId)!);
  return createBattle(board, autoDeploy(board, playerTeamForBattle(e), 'player'), autoDeploy(board, enemyTeamForBattle(e), 'enemy')).state;
}

describe('expedition', () => {
  it('is reproducible from its seed and scales enemies each stage', () => {
    const a = startExpedition(TEAM, 7);
    const b = startExpedition(TEAM, 7);
    expect(a.stages).toEqual(b.stages);
    expect(a.stages).toHaveLength(EXPEDITION_STAGES);
    expect(a.stages[4].elite).toBe(true);
    expect(a.stages[3].enemies[0].bonus.atk).toBeGreaterThan(a.stages[0].enemies[0].bonus.atk ?? 0);
  });

  it('carries damage over, marks the fallen and offers three rewards after a win', () => {
    const e = startExpedition(TEAM, 1);
    const s = battleFor(e);
    // Fake a win where Mira fell and Brann is hurt.
    for (const u of s.units) if (u.side === 'enemy') u.alive = false;
    getUnit(s, s.units.find((u) => u.heroId === 'mira' && u.side === 'player')!.id).alive = false;
    s.units.find((u) => u.heroId === 'brann' && u.side === 'player')!.hp = 10;
    s.winner = 'player';
    const next = recordBattle(e, s, mulberry32(3));
    expect(next.stage).toBe(1);
    expect(next.roster.find((h) => h.heroId === 'mira')!.fallen).toBe(true);
    const brann = next.roster.find((h) => h.heroId === 'brann')!;
    expect(brann.hp).toBe(10 + Math.round(heroMaxHp(next, brann) * 0.2));
    expect(next.rewards).toHaveLength(3);
    // With someone fallen, revive or recruit should be on offer.
    expect(next.rewards!.some((r) => r.kind === 'revive' || r.kind === 'recruit')).toBe(true);
  });

  it('rewards change the roster: relics apply to everyone, revive brings the fallen back', () => {
    let e = startExpedition(TEAM, 2);
    e.roster[3].fallen = true;
    e.roster[3].hp = 0;
    e.rewards = [
      { id: 'relic:banner', kind: 'relic', relicId: 'banner', title: '', description: '' },
      { id: 'revive', kind: 'revive', title: '', description: '' },
    ];
    const withRelic = chooseReward(e, 'relic:banner');
    expect(playerTeamForBattle(withRelic).every((d) => d.bonus?.atk === 2)).toBe(true);
    const revived = chooseReward(e, 'revive');
    expect(revived.roster[3].fallen).toBe(false);
    expect(revived.roster[3].hp).toBeGreaterThan(0);
    e = revived;
    expect(e.rewards).toBeNull();
  });

  it('losing a battle ends the run', () => {
    const e = startExpedition(TEAM, 4);
    const s = battleFor(e);
    s.winner = 'enemy';
    expect(recordBattle(e, s).status).toBe('lost');
  });
});

describe('daily challenge', () => {
  it('is the same for everyone on a given date and changes between dates', () => {
    const a = dailyChallenge('2026-10-14');
    expect(dailyChallenge('2026-10-14')).toEqual(a);
    const others = ['2026-10-15', '2026-10-16', '2026-10-17'].map((d) => dailyChallenge(d));
    expect(others.some((o) => JSON.stringify(o) !== JSON.stringify({ ...a, date: o.date }))).toBe(true);
    expect(a.player).toHaveLength(4);
    expect(new Set([...a.player, ...a.enemy]).size).toBe(8);
  });
});

describe('draft', () => {
  it('bans first, then follows the snake order and never hands out a hero twice', () => {
    let d = newDraft();
    const rng = mulberry32(9);
    while (draftSide(d)) d = draftPick(d, draftSide(d) === 'player' ? available(d)[0] : aiDraftPick(d, rng));
    expect(d.bans).toHaveLength(2);
    expect(d.player).toHaveLength(4);
    expect(d.enemy).toHaveLength(4);
    const all = [...d.player, ...d.enemy, ...d.bans.map((b) => b.heroId)];
    expect(new Set(all).size).toBe(10);
    expect(() => draftPick(newDraft(), 'nobody')).toThrow();
  });
});

describe('puzzles', () => {
  for (const p of PUZZLES) {
    it(`"${p.name}" has a solution`, () => {
      const r = solvePuzzle(p, 3_000_000, true);
      expect(r.solution).not.toBeNull();
      // Replaying the solution really wins within the first round.
      const s = puzzleBattle(p).state;
      for (const c of r.solution!) applyCommand(s, c);
      expect(s.winner).toBe('player');
    }, 60_000);
  }

  it('passing the turn to an enemy fails the puzzle', () => {
    const s = cloneState(puzzleBattle(PUZZLES[0]).state);
    while (!s.winner && !puzzleFailed(s)) applyCommand(s, { type: 'endTurn' });
    expect(puzzleFailed(s)).toBe(true);
  });
});

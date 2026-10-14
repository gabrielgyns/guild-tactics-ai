import { describe, expect, it } from 'vitest';
import { planTurn } from '../src/domain/ai';
import { applyCommand, cloneState, createBattle, getUnit } from '../src/domain/battle';
import { MAPS, buildBoard } from '../src/domain/board';
import { autoDeploy } from '../src/domain/deploy';
import { EXPEDITION_STAGES, chooseReward, heroMaxHp, enemyTeamForBattle, playerTeamForBattle, recordBattle, startExpedition, type ExpeditionState } from '../src/domain/expedition';
import { mulberry32 } from '../src/domain/rng';
import { applyTraits } from '../src/domain/traits';

/** Plays a whole expedition with the AI on both sides (player AI sharp, enemy AI as in the game). */
function playExpedition(seed: number): { final: ExpeditionState; stagesWon: number; rewardsTaken: string[] } {
  const rng = mulberry32(seed);
  let e = startExpedition(['dagna', 'lyra', 'seren', 'mira'], seed);
  const rewardsTaken: string[] = [];
  while (e.status === 'active') {
    const board = buildBoard(MAPS.find((m) => m.id === e.stages[e.stage].mapId)!);
    const s = createBattle(
      board,
      applyTraits(autoDeploy(board, playerTeamForBattle(e), 'player')),
      applyTraits(autoDeploy(board, enemyTeamForBattle(e), 'enemy')),
    ).state;
    while (!s.winner) {
      const side = getUnit(s, s.active!.unitId).side;
      for (const c of planTurn(cloneState(s), { noise: side === 'player' ? 0 : e.stages[e.stage].aiNoise, random: rng })) {
        if (s.winner) break;
        applyCommand(s, c);
      }
    }
    e = recordBattle(e, s, rng);
    if (e.rewards) {
      // Choose like a sensible player: bring back the fallen, rest when hurt, otherwise take power.
      const hurt = e.roster.some((h) => !h.fallen && h.hp < 0.5 * heroMaxHp(e, h));
      const order = ['revive', 'recruit', ...(hurt ? ['rest'] : []), 'relic', 'train', 'rest'];
      const pick = [...e.rewards].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0];
      rewardsTaken.push(pick.kind);
      e = chooseReward(e, pick.id);
    }
  }
  return { final: e, stagesWon: e.battlesWon, rewardsTaken };
}

describe('expedition end to end', () => {
  it('runs from the first battle to a final verdict, applying rewards between battles', () => {
    const results = [11, 22, 33, 44, 55, 66].map(playExpedition);
    for (const r of results) {
      expect(['won', 'lost']).toContain(r.final.status);
      // Every won battle except the last one offers (and here takes) a reward.
      expect(r.rewardsTaken.length).toBe(Math.min(r.stagesWon, EXPEDITION_STAGES - 1));
    }
    // A sharp player AI should conquer at least one of these runs.
    expect(results.some((r) => r.final.status === "won")).toBe(true);
    console.log(results.map((r) => `${r.final.status} after ${r.stagesWon} wins, rewards: ${r.rewardsTaken.join(',')}`).join('\n'));
  }, 120_000);
});

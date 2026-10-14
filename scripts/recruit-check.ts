// How often a so-so player (AI with medium noise) beats the Recruit opponent, before and after the easing.
import { planTurn } from '../src/domain/ai';
import { applyCommand, cloneState, createBattle, getUnit } from '../src/domain/battle';
import { MAPS, buildBoard } from '../src/domain/board';
import { autoDeploy } from '../src/domain/deploy';
import { HEROES } from '../src/domain/heroes';
import { applyTraits } from '../src/domain/traits';

function run(enemyNoise: number, enemyBonus: Record<string, number> | undefined, playerNoise: number, n = 150) {
  let wins = 0;
  for (let m = 0; m < n; m++) {
    const board = buildBoard(MAPS[m % MAPS.length]);
    const pick = () => ['warrior', 'ranger', 'mage', 'support'].map((c) => { const p = HEROES.filter((h) => h.heroClass === c); return p[Math.floor(Math.random() * p.length)].id; });
    const s = createBattle(
      board,
      applyTraits(autoDeploy(board, pick().map((heroId) => ({ heroId })), 'player')),
      applyTraits(autoDeploy(board, pick().map((heroId) => ({ heroId, bonus: enemyBonus })), 'enemy')),
    ).state;
    while (!s.winner) {
      const side = getUnit(s, s.active!.unitId).side;
      for (const c of planTurn(cloneState(s), { noise: side === 'player' ? playerNoise : enemyNoise, random: Math.random })) {
        if (s.winner) break;
        applyCommand(s, c);
      }
    }
    if (s.winner === 'player') wins++;
  }
  return Math.round((100 * wins) / n);
}
for (const playerNoise of [6, 12]) {
  console.log(`player noise ${playerNoise}: old recruit ${run(9, undefined, playerNoise)}% · new recruit ${run(16, { atk: -2, maxHp: -5 }, playerNoise)}% · veteran ${run(0.8, undefined, playerNoise)}%`);
}

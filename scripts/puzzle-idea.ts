// Checks that each puzzle becomes unsolvable without its key ability.
import { getUnit } from '../src/domain/battle';
import { PUZZLES, solvePuzzle } from '../src/domain/puzzles';
const KEY: Record<string, [string, string][]> = {
  swap: [['p0-vex', 'swap']],
  flank: [['p1-brann', 'charge']],
  ultimate: [['p0-orrin', 'inspire']],
};
for (const p of PUZZLES) {
  const keys = KEY[p.id];
  if (!keys) continue;
  const r = solvePuzzle(p, 3_000_000, true, (s) => {
    for (const [u, a] of keys) getUnit(s, u).cooldowns[a] = 99;
  });
  console.log(p.id, 'without key idea →', r.solution ? 'STILL SOLVABLE: ' + r.solution.map((c) => (c.type === 'ability' ? c.abilityId : c.type)).join(' → ') : 'unsolvable ✓', r.explored);
}

// Proves each puzzle is solvable and reports how many solutions skip the intended idea.
// Run: npx vite-node scripts/solve-puzzles.ts
import { PUZZLES, solvePuzzle } from '../src/domain/puzzles';
for (const p of PUZZLES) {
  const t = performance.now();
  const r = solvePuzzle(p, 3_000_000);
  console.log(p.id.padEnd(10), 'solutions', r.solutions, 'explored', r.explored, `${(performance.now() - t).toFixed(0)}ms`);
  console.log('   ', r.solution ? r.solution.map((c) => (c.type === 'ability' ? c.abilityId : c.type)).join(' → ') : 'NONE');
}

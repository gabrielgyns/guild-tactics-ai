// Balance probe: AI vs AI matches. Run with `npx vite-node scripts/simulate.ts [matches]`.
import { planTurn } from '../src/domain/ai';
import { applyCommand, cloneState, createBattle } from '../src/domain/battle';
import { MAPS, buildBoard } from '../src/domain/board';
import { HEROES } from '../src/domain/heroes';

const N = Number(process.argv[2] ?? 200);
const ids = HEROES.map((h) => h.id);
const wins: Record<string, number> = {};
const plays: Record<string, number> = {};
const rounds: number[] = [];
const turnMs: number[] = [];
const outcome = { player: 0, enemy: 0, draw: 0, timeout: 0 };

for (let m = 0; m < N; m++) {
  const pick = () => [...ids].sort(() => Math.random() - 0.5).slice(0, 4);
  const board = buildBoard(MAPS[m % MAPS.length]);
  const spots = (rows: number[]) => {
    const out = [];
    for (const y of rows) for (let x = 0; x < 6; x++) if (board.tiles[y][x] === 'plain') out.push({ x, y });
    return out.sort(() => Math.random() - 0.5);
  };
  const P = pick(), E = pick();
  const pp = spots([5, 4]), ep = spots([0, 1]);
  const s = createBattle(board, P.map((heroId, i) => ({ heroId, pos: pp[i] })), E.map((heroId, i) => ({ heroId, pos: ep[i] }))).state;
  let timeout = false;
  while (!s.winner) {
    const t = performance.now();
    const cmds = planTurn(cloneState(s), { noise: 1, random: Math.random });
    turnMs.push(performance.now() - t);
    for (const c of cmds) { if (s.winner) break; const ev = applyCommand(s, c); if (ev.some(e => e.type === 'victory' && e.reason === 'timeout')) timeout = true; }
  }
  outcome[s.winner as 'player'] += 1;
  if (timeout) outcome.timeout++;
  rounds.push(s.round);
  for (const h of P) { plays[h] = (plays[h] ?? 0) + 1; if (s.winner === 'player') wins[h] = (wins[h] ?? 0) + 1; }
  for (const h of E) { plays[h] = (plays[h] ?? 0) + 1; if (s.winner === 'enemy') wins[h] = (wins[h] ?? 0) + 1; }
}
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
console.log('outcomes', outcome);
console.log('rounds avg', avg(rounds).toFixed(2), 'min', Math.min(...rounds), 'max', Math.max(...rounds));
console.log('AI ms/turn avg', avg(turnMs).toFixed(1), 'max', Math.max(...turnMs).toFixed(1));
for (const h of ids) console.log(h.padEnd(8), ((100 * (wins[h] ?? 0)) / plays[h]).toFixed(1) + '%', `(${plays[h]})`);

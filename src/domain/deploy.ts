import type { Deployment } from './battle';
import { centreOut, deployRows, isWalkable, posKey } from './board';
import { getHero } from './heroes';
import type { Board, Pos, Side } from './types';

/**
 * Default formation: warriors on the front row, everyone else at the back,
 * filling the centre columns first. Keeps any bonuses already on the deployments.
 */
export function autoDeploy(board: Board, team: Omit<Deployment, 'pos'>[], side: Side): Deployment[] {
  const [a, b] = deployRows(board, side);
  const front = side === 'player' ? Math.min(a, b) : Math.max(a, b);
  const back = side === 'player' ? Math.max(a, b) : Math.min(a, b);
  const taken = new Set<string>();
  const order = centreOut(board.width);
  const spot = (row: number, other: number): Pos => {
    for (const r of [row, other])
      for (const x of order) {
        const p = { x, y: r };
        if (isWalkable(board, p) && !taken.has(posKey(p))) {
          taken.add(posKey(p));
          return p;
        }
      }
    throw new Error('No deploy spot');
  };
  return team.map((d) => {
    const isFront = getHero(d.heroId).heroClass === 'warrior';
    return { ...d, pos: spot(isFront ? front : back, isFront ? back : front) };
  });
}

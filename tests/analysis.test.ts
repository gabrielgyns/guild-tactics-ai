import { describe, expect, it } from 'vitest';
import { analyzeMatch } from '../src/domain/analysis';
import { createBattle, getUnit } from '../src/domain/battle';
import type { BattleEvent, Board, Terrain } from '../src/domain/types';

const flat = (): Board => ({ width: 6, height: 6, name: 't', tiles: Array.from({ length: 6 }, () => Array<Terrain>(6).fill('plain')) });

function setup() {
  return createBattle(
    flat(),
    [
      { heroId: 'lyra', pos: { x: 0, y: 5 } },
      { heroId: 'seren', pos: { x: 1, y: 5 } },
    ],
    [{ heroId: 'vex', pos: { x: 3, y: 0 } }],
  ).state;
}

describe('post-match analysis', () => {
  it('points out an early loss, a wasted ultimate, bad elements and passive turns', () => {
    const s = setup();
    s.winner = 'enemy';
    getUnit(s, 'p0-lyra').alive = false;
    const ev: BattleEvent[] = [{ type: 'roundStart', round: 1 }];
    // Seren (fire) hits Vex (water) three times: resisted.
    for (let i = 0; i < 3; i++) ev.push({ type: 'damage', unitId: 'e0-vex', sourceId: 'p1-seren', amount: 5, absorbed: 0, tags: ['resisted'] });
    // Three passive player turns.
    for (let i = 0; i < 3; i++) ev.push({ type: 'turnStart', unitId: 'p0-lyra' }, { type: 'turnEnd', unitId: 'p0-lyra' });
    ev.push({ type: 'roundStart', round: 2 }, { type: 'death', unitId: 'p0-lyra' });
    const tips = analyzeMatch(s, ev, ['p1-seren']).map((t) => t.text).join('\n');
    expect(tips).toMatch(/Lyra caiu cedo, na ronda 2/);
    expect(tips).toMatch(/Seren teve o supremo pronto/);
    expect(tips).toMatch(/resiste/);
  });

  it('always says something, and at most three things', () => {
    const s = setup();
    s.winner = 'player';
    expect(analyzeMatch(s, [], []).length).toBe(1);
  });
});

describe('exposure insight', () => {
  it('names the hero left within reach of several enemies, ranked first when it then fell', () => {
    const s = createBattle(
      { width: 6, height: 6, name: 't', tiles: Array.from({ length: 6 }, () => Array<Terrain>(6).fill('plain')) },
      [{ heroId: 'lyra', pos: { x: 0, y: 5 } }],
      [{ heroId: 'vex', pos: { x: 3, y: 0 } }],
    ).state;
    s.winner = 'enemy';
    const ev: BattleEvent[] = [{ type: 'roundStart', round: 2 }, { type: 'death', unitId: 'p0-lyra' }];
    const tips = analyzeMatch(s, ev, [], [{ unitId: 'p0-lyra', round: 2, count: 3 }]);
    expect(tips[0].text).toMatch(/Lyra ficou ao alcance de 3 inimigos na ronda 2 e acabou por cair/);
  });
});

import { describe, expect, it } from 'vitest';
import { attacksOn, warOpponent, warScore, type OnlineGuild } from '../src/game/online';

const S = '2026-W42';
const g = (id: string, over: Partial<OnlineGuild> = {}): OnlineGuild => ({
  id, guild: id, color: 0, code: 'GT1-x', rating: 1000, wins: 0, losses: 0, season: S, updatedAt: 0, attacks: [], targets: [], war: null, ...over,
});

describe('online guilds', () => {
  it('pairs active guilds in id order for the weekly war, ignoring inactive ones', () => {
    const all = [g('d'), g('a'), g('c'), g('b'), g('z', { season: '2026-W40' })];
    expect(warOpponent(all, 'a', S)!.id).toBe('b');
    expect(warOpponent(all, 'b', S)!.id).toBe('a');
    expect(warOpponent(all, 'c', S)!.id).toBe('d');
    expect(warOpponent([g('solo')], 'solo', S)).toBeNull();
  });

  it('defenders see who attacked them from the attackers own documents', () => {
    const me = g('me');
    const x = g('x', { guild: 'X', attacks: [{ target: 'me', targetGuild: 'me', won: true, at: 2, season: S }, { target: 'other', targetGuild: 'o', won: false, at: 1, season: S }] });
    const y = g('y', { guild: 'Y', attacks: [{ target: 'me', targetGuild: 'me', won: false, at: 3, season: S }] });
    const hits = attacksOn([me, x, y], 'me', S);
    expect(hits.map((h) => h.by)).toEqual(['Y', 'X']);
  });

  it('war score combines both sides records', () => {
    const me = g('me', { war: { season: S, opponent: 'you', results: ['won', 'lost', 'won'] } });
    const you = g('you', { war: { season: S, opponent: 'me', results: ['won'] } });
    expect(warScore(me, you, S)).toEqual({ mine: 2, theirs: 1, myAttacksLeft: 0, theirAttacksLeft: 2 });
  });
});

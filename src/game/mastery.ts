import { getHero } from '../domain/heroes';
import type { BattleState, Unit } from '../domain/types';
import { load, save } from './profile';

// Hero mastery: XP from matches unlocks cosmetics only — never power.

export type Skin = 'classic' | 'veteran' | 'legend';

export const SKINS: { id: Skin; name: string; level: number }[] = [
  { id: 'classic', name: 'Clássico', level: 1 },
  { id: 'veteran', name: 'Veterano', level: 3 },
  { id: 'legend', name: 'Lendário', level: 5 },
];

/** Total XP needed to reach each level (index 0 = level 1). */
export const LEVEL_XP = [0, 60, 150, 280, 450];

export const LEVEL_REWARD: Record<number, string> = {
  2: 'Insígnia de bronze',
  3: 'Visual Veterano',
  4: 'Insígnia de prata',
  5: 'Visual Lendário e insígnia de ouro',
};

export interface MasteryProfile {
  xp: Record<string, number>;
  skins: Record<string, Skin>;
}

export const loadMastery = (): MasteryProfile => load<MasteryProfile>('mastery', { xp: {}, skins: {} });

export function levelFor(xp: number): number {
  let level = 1;
  for (let i = 0; i < LEVEL_XP.length; i++) if (xp >= LEVEL_XP[i]) level = i + 1;
  return level;
}

export function levelProgress(xp: number): { level: number; into: number; span: number } {
  const level = levelFor(xp);
  if (level >= LEVEL_XP.length) return { level, into: 1, span: 1 };
  return { level, into: xp - LEVEL_XP[level - 1], span: LEVEL_XP[level] - LEVEL_XP[level - 1] };
}

export function skinOf(m: MasteryProfile, heroId: string): Skin {
  const chosen = m.skins[heroId] ?? 'classic';
  const unlocked = SKINS.find((s) => s.id === chosen)!.level <= levelFor(m.xp[heroId] ?? 0);
  return unlocked ? chosen : 'classic';
}

export function chooseSkin(heroId: string, skin: Skin) {
  const m = loadMastery();
  m.skins[heroId] = skin;
  save('mastery', m);
}

export interface MasteryGain {
  heroId: string;
  xp: number;
  before: number;
  after: number;
}

export function xpForUnit(u: Unit, won: boolean, mvp: boolean): number {
  return 20 + (won ? 20 : 0) + u.combat.kills * 4 + (mvp ? 10 : 0);
}

/** Awards XP to every player hero that fought and returns what changed. */
export function awardMastery(state: BattleState): MasteryGain[] {
  const m = loadMastery();
  const mine = state.units.filter((u) => u.side === 'player');
  const score = (u: Unit) => u.combat.damageDealt + u.combat.healingDone * 0.8 + u.combat.kills * 10;
  const mvp = [...mine].sort((a, b) => score(b) - score(a))[0];
  const won = state.winner === 'player';
  const gains = mine.map((u) => {
    const before = m.xp[u.heroId] ?? 0;
    const xp = xpForUnit(u, won, u.id === mvp?.id);
    m.xp[u.heroId] = before + xp;
    return { heroId: u.heroId, xp, before, after: before + xp };
  });
  save('mastery', m);
  return gains;
}

export function masteryHtml(gains: MasteryGain[]): string {
  const rows = gains
    .map((g) => {
      const lb = levelFor(g.before);
      const la = levelFor(g.after);
      const up = la > lb ? ` <span class="lvlup">Nível ${la}! ${LEVEL_REWARD[la] ?? ''}</span>` : '';
      return `<li><b>${getHero(g.heroId).name}</b> +${g.xp} XP · nível ${la}${up}</li>`;
    })
    .join('');
  return `<div class="mastery-gain"><div class="eyebrow">Maestria</div><ul>${rows}</ul></div>`;
}

export const BADGE: Record<number, string> = { 1: '', 2: '🥉', 3: '🥉', 4: '🥈', 5: '🥇' };

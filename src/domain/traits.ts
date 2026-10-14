import type { Deployment } from './battle';
import { ELEMENT_LABEL } from './elements';
import { getHero } from './heroes';
import type { Element, HeroClass, Stats } from './types';

// Guild traits: team-composition synergies (class counts, shared elements, light + shadow).
// They are computed from the hero list alone, so both sides get them and the UI can preview them.

export interface TraitEffect {
  heroIds: string[];
  bonus?: Partial<Stats>;
  energy?: number;
}

export interface Trait {
  id: string;
  name: string;
  description: string;
  active: boolean;
  /** "2/2", "1/2"… progress shown in the team picker. */
  progress: string;
  effect: TraitEffect | null;
}

const CLASS_TRAITS: { cls: HeroClass; id: string; name: string; description: string; effect: Omit<TraitEffect, 'heroIds'> }[] = [
  { cls: 'warrior', id: 'vanguard', name: 'Linha da Frente', description: '2+ guerreiros: os guerreiros ganham +2 DEF.', effect: { bonus: { def: 2 } } },
  { cls: 'ranger', id: 'volley', name: 'Saraivada', description: '2+ arqueiros: os arqueiros ganham +2 ATQ.', effect: { bonus: { atk: 2 } } },
  { cls: 'mage', id: 'circle', name: 'Círculo Arcano', description: '2+ magos: os magos começam com 30 de energia.', effect: { energy: 30 } },
  { cls: 'support', id: 'choir', name: 'Coro', description: '2+ suportes: toda a equipa ganha +4 PV.', effect: { bonus: { maxHp: 4 } } },
];

export function teamTraits(heroIds: string[]): Trait[] {
  const heroes = heroIds.map(getHero);
  const traits: Trait[] = [];

  const classes = new Set(heroes.map((h) => h.heroClass));
  traits.push({
    id: 'balanced',
    name: 'Guilda Equilibrada',
    description: 'Uma de cada classe: toda a equipa começa com 15 de energia.',
    active: classes.size === 4,
    progress: `${classes.size}/4`,
    effect: classes.size === 4 ? { heroIds, energy: 15 } : null,
  });

  for (const t of CLASS_TRAITS) {
    const members = heroes.filter((h) => h.heroClass === t.cls).map((h) => h.id);
    const active = members.length >= 2;
    const targets = t.id === 'choir' ? heroIds : members;
    traits.push({ id: t.id, name: t.name, description: t.description, active, progress: `${members.length}/2`, effect: active ? { heroIds: targets, ...t.effect } : null });
  }

  const byElement = new Map<Element, string[]>();
  for (const h of heroes) byElement.set(h.element, [...(byElement.get(h.element) ?? []), h.id]);
  for (const [el, members] of byElement) {
    if (members.length < 2) continue;
    const strong = members.length >= 3;
    traits.push({
      id: `attune-${el}`,
      name: `Sintonia: ${ELEMENT_LABEL[el]}`,
      description: `2+ heróis de ${ELEMENT_LABEL[el]}: esses heróis ganham +1 ATQ e +3 PV (3+: +2 ATQ e +6 PV).`,
      active: true,
      progress: `${members.length}`,
      effect: { heroIds: members, bonus: strong ? { atk: 2, maxHp: 6 } : { atk: 1, maxHp: 3 } },
    });
  }

  const light = heroes.filter((h) => h.element === 'light').map((h) => h.id);
  const shadow = heroes.filter((h) => h.element === 'shadow').map((h) => h.id);
  const twilight = light.length > 0 && shadow.length > 0;
  traits.push({
    id: 'twilight',
    name: 'Crepúsculo',
    description: 'Luz e Sombra na mesma equipa: esses heróis ganham +2 ATQ.',
    active: twilight,
    progress: `${Math.min(1, light.length) + Math.min(1, shadow.length)}/2`,
    effect: twilight ? { heroIds: [...light, ...shadow], bonus: { atk: 2 } } : null,
  });
  return traits;
}

/** Returns copies of the deployments with every active trait folded into their bonuses and energy. */
export function applyTraits<T extends Omit<Deployment, 'pos'> & { pos?: Deployment['pos'] }>(
  team: T[],
): (T & { bonus: Partial<Stats>; energy: number })[] {
  const traits = teamTraits(team.map((d) => d.heroId)).filter((t) => t.effect);
  return team.map((d) => {
    const bonus: Partial<Stats> = { ...(d.bonus ?? {}) };
    let energy = d.energy ?? 0;
    for (const t of traits) {
      if (!t.effect!.heroIds.includes(d.heroId)) continue;
      for (const [k, v] of Object.entries(t.effect!.bonus ?? {}) as [keyof Stats, number][]) bonus[k] = (bonus[k] ?? 0) + v;
      energy += t.effect!.energy ?? 0;
    }
    return { ...d, bonus, energy };
  });
}

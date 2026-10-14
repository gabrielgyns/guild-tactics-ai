import type { Element } from './types';

// Element wheel: fire › nature › water › fire. Light and shadow are strong against each other.
// Hypothesis: big enough to matter when drafting, small enough that positioning still wins.

export const ELEMENT_ADVANTAGE = 1.3;
export const ELEMENT_DISADVANTAGE = 0.8;

const BEATS: Record<Element, Element[]> = {
  fire: ['nature'],
  nature: ['water'],
  water: ['fire'],
  light: ['shadow'],
  shadow: ['light'],
};

export const ELEMENT_LABEL: Record<Element, string> = {
  fire: 'Fogo',
  water: 'Água',
  nature: 'Natureza',
  light: 'Luz',
  shadow: 'Sombra',
};

export const ELEMENT_GLYPH: Record<Element, string> = {
  fire: '🔥',
  water: '💧',
  nature: '🌿',
  light: '☀',
  shadow: '☾',
};

export const ELEMENT_COLOR: Record<Element, string> = {
  fire: '#ff8a4c',
  water: '#5fb8ff',
  nature: '#8fd16a',
  light: '#ffe08a',
  shadow: '#b48cff',
};

export function elementMultiplier(attacker: Element, defender: Element): number {
  if (BEATS[attacker].includes(defender)) return ELEMENT_ADVANTAGE;
  if (BEATS[defender].includes(attacker) && attacker !== defender) return ELEMENT_DISADVANTAGE;
  return 1;
}

/** Short explanation for tooltips: what this element beats and what beats it. */
export function elementMatchup(e: Element): { strong: Element[]; weak: Element[] } {
  const weak = (Object.keys(BEATS) as Element[]).filter((k) => BEATS[k].includes(e));
  return { strong: BEATS[e], weak };
}

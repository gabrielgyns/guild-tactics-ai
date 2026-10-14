import type { Deployment } from './battle';
import { MAPS } from './board';
import { HEROES, getHero } from './heroes';
import { mulberry32, pick, shuffled, type Rng } from './rng';
import type { BattleState, HeroClass, Stats } from './types';

// Expedition: a short roguelite run. Five battles in a row; damage carries over;
// after each win the player picks one of three rewards. Losing a battle ends the run.

export const EXPEDITION_STAGES = 5;
/** Share of max HP every survivor recovers between battles. */
export const REST_HEAL = 0.2;

export interface ExpeditionHero {
  heroId: string;
  hp: number;
  bonus: Partial<Stats>;
  fallen: boolean;
}

export interface StageDef {
  name: string;
  mapId: string;
  elite: boolean;
  enemies: { heroId: string; bonus: Partial<Stats> }[];
}

export type RewardKind = 'relic' | 'train' | 'rest' | 'revive' | 'recruit';

export interface Reward {
  id: string;
  kind: RewardKind;
  title: string;
  description: string;
  heroId?: string;
  relicId?: string;
}

export interface ExpeditionState {
  seed: number;
  stage: number; // index of the next battle
  stages: StageDef[];
  roster: ExpeditionHero[];
  relics: string[];
  status: 'active' | 'won' | 'lost';
  /** Rewards on offer after a win; null when none are pending. */
  rewards: Reward[] | null;
  battlesWon: number;
}

// ---------------------------------------------------------------- relics

export interface RelicDef {
  id: string;
  name: string;
  description: string;
  bonus?: Partial<Stats>;
  startEnergy?: number;
  startShield?: number;
}

export const RELICS: RelicDef[] = [
  { id: 'banner', name: 'Estandarte da Guilda', description: '+2 ATQ para toda a equipa.', bonus: { atk: 2 } },
  { id: 'mail', name: 'Cota Reforçada', description: '+1 DEF para toda a equipa.', bonus: { def: 1 } },
  { id: 'boots', name: 'Botas de Viagem', description: '+1 MOV para toda a equipa.', bonus: { mov: 1 } },
  { id: 'amulet', name: 'Amuleto Vital', description: '+6 PV máximos para toda a equipa.', bonus: { maxHp: 6 } },
  { id: 'quill', name: 'Pena Veloz', description: '+2 VEL para toda a equipa.', bonus: { spd: 2 } },
  { id: 'crystal', name: 'Cristal de Mana', description: 'Cada combate começa com 40 de energia.', startEnergy: 40 },
  { id: 'aegis', name: 'Égide', description: 'Cada combate começa com 6 de escudo.', startShield: 6 },
];

export const getRelic = (id: string) => RELICS.find((r) => r.id === id)!;

// ---------------------------------------------------------------- setup

const STAGE_NAMES = ['Estrada do Moinho', 'Bosque Sombrio', 'Ruínas Antigas', 'Passo da Montanha', 'Fortaleza do Campeão'];
const CLASSES: HeroClass[] = ['warrior', 'ranger', 'mage', 'support'];

function addStats(a: Partial<Stats>, b: Partial<Stats>): Partial<Stats> {
  const out: Partial<Stats> = { ...a };
  for (const k of Object.keys(b) as (keyof Stats)[]) out[k] = (out[k] ?? 0) + (b[k] ?? 0);
  return out;
}

function makeStage(rng: Rng, index: number, avoid: string[]): StageDef {
  const elite = index === EXPEDITION_STAGES - 1;
  // Enemies get stronger every stage; the final one is an elite squad.
  const scale: Partial<Stats> = {
    atk: index,
    maxHp: index * 3 + (elite ? 8 : 0),
    def: Math.floor(index / 2),
  };
  const enemies = CLASSES.map((c) => {
    const pool = shuffled(rng, HEROES.filter((h) => h.heroClass === c));
    return (pool.find((h) => !avoid.includes(h.id)) ?? pool[0]).id;
  }).map((heroId) => ({ heroId, bonus: scale }));
  return { name: STAGE_NAMES[index], mapId: pick(rng, MAPS).id, elite, enemies };
}

export function startExpedition(team: string[], seed = Math.floor(Math.random() * 2 ** 31)): ExpeditionState {
  const rng = mulberry32(seed);
  const stages = Array.from({ length: EXPEDITION_STAGES }, (_, i) => makeStage(rng, i, team));
  return {
    seed,
    stage: 0,
    stages,
    roster: team.map((heroId) => ({ heroId, hp: getHero(heroId).stats.maxHp, bonus: {}, fallen: false })),
    relics: [],
    status: 'active',
    rewards: null,
    battlesWon: 0,
  };
}

// ---------------------------------------------------------------- derived stats

export function heroMaxHp(e: ExpeditionState, h: ExpeditionHero): number {
  return getHero(h.heroId).stats.maxHp + (totalBonus(e, h).maxHp ?? 0);
}

export function totalBonus(e: ExpeditionState, h: ExpeditionHero): Partial<Stats> {
  let b = { ...h.bonus };
  for (const id of e.relics) {
    const r = getRelic(id);
    if (r.bonus) b = addStats(b, r.bonus);
  }
  return b;
}

/** Player deployments for the next battle (positions are filled in by autoDeploy). */
export function playerTeamForBattle(e: ExpeditionState): Omit<Deployment, 'pos'>[] {
  const energy = e.relics.reduce((sum, id) => sum + (getRelic(id).startEnergy ?? 0), 0);
  const shield = e.relics.reduce((sum, id) => sum + (getRelic(id).startShield ?? 0), 0);
  return e.roster
    .filter((h) => !h.fallen)
    .map((h) => ({ heroId: h.heroId, hp: h.hp, bonus: totalBonus(e, h), energy, shield }));
}

export function enemyTeamForBattle(e: ExpeditionState): Omit<Deployment, 'pos'>[] {
  return e.stages[e.stage].enemies.map((x) => ({ heroId: x.heroId, bonus: x.bonus }));
}

// ---------------------------------------------------------------- after a battle

/** Applies a battle result. Units are matched to roster heroes by heroId. */
export function recordBattle(e: ExpeditionState, result: BattleState, rng: Rng = Math.random): ExpeditionState {
  const next: ExpeditionState = structuredClone(e);
  if (result.winner !== 'player') {
    next.status = 'lost';
    return next;
  }
  for (const h of next.roster) {
    if (h.fallen) continue;
    const u = result.units.find((x) => x.side === 'player' && x.heroId === h.heroId);
    if (!u) continue;
    const max = heroMaxHp(next, h);
    if (!u.alive) {
      h.fallen = true;
      h.hp = 0;
    } else h.hp = Math.min(max, u.hp + Math.round(max * REST_HEAL));
  }
  next.battlesWon += 1;
  next.stage += 1;
  if (next.stage >= EXPEDITION_STAGES) {
    next.status = 'won';
    return next;
  }
  next.rewards = offerRewards(next, rng);
  return next;
}

export function offerRewards(e: ExpeditionState, rng: Rng): Reward[] {
  const options: Reward[] = [];
  const fallen = e.roster.filter((h) => h.fallen);
  const alive = e.roster.filter((h) => !h.fallen);

  const relics = shuffled(rng, RELICS.filter((r) => !e.relics.includes(r.id)));
  if (relics[0]) options.push({ id: `relic:${relics[0].id}`, kind: 'relic', relicId: relics[0].id, title: relics[0].name, description: relics[0].description });

  const trainee = pick(rng, alive);
  if (trainee) {
    const name = getHero(trainee.heroId).name;
    options.push({ id: `train:${trainee.heroId}`, kind: 'train', heroId: trainee.heroId, title: `Treinar ${name}`, description: `${name} ganha +2 ATQ e +5 PV máximos (e cura esses 5).` });
  }

  if (fallen.length) {
    options.push({ id: 'revive', kind: 'revive', title: 'Ritual de Regresso', description: `Os heróis caídos (${fallen.map((h) => getHero(h.heroId).name).join(', ')}) voltam com metade da vida.` });
    const candidates = HEROES.filter((h) => !e.roster.some((r) => r.heroId === h.id));
    const recruit = pick(rng, candidates);
    if (recruit)
      options.push({ id: `recruit:${recruit.id}`, kind: 'recruit', heroId: recruit.id, title: `Recrutar ${recruit.name}`, description: `${recruit.name} (${recruit.title}) junta-se com a vida cheia e substitui um herói caído.` });
  }

  const hurt = alive.some((h) => h.hp < heroMaxHp(e, h));
  if (hurt || options.length < 3)
    options.push({ id: 'rest', kind: 'rest', title: 'Acampamento', description: 'Todos os heróis de pé recuperam 60% da vida que lhes falta.' });

  if (options.length < 3 && relics[1])
    options.push({ id: `relic:${relics[1].id}`, kind: 'relic', relicId: relics[1].id, title: relics[1].name, description: relics[1].description });

  return options.slice(0, 3);
}

export function chooseReward(e: ExpeditionState, rewardId: string): ExpeditionState {
  const next: ExpeditionState = structuredClone(e);
  const reward = next.rewards?.find((r) => r.id === rewardId);
  if (!reward) throw new Error(`Unknown reward ${rewardId}`);
  switch (reward.kind) {
    case 'relic':
      next.relics.push(reward.relicId!);
      // HP bonuses also raise current HP so the relic is felt immediately.
      if (getRelic(reward.relicId!).bonus?.maxHp)
        for (const h of next.roster) if (!h.fallen) h.hp += getRelic(reward.relicId!).bonus!.maxHp!;
      break;
    case 'train': {
      const h = next.roster.find((x) => x.heroId === reward.heroId)!;
      h.bonus = addStats(h.bonus, { atk: 2, maxHp: 5 });
      h.hp += 5;
      break;
    }
    case 'rest':
      for (const h of next.roster) if (!h.fallen) h.hp += Math.round((heroMaxHp(next, h) - h.hp) * 0.6);
      break;
    case 'revive':
      for (const h of next.roster)
        if (h.fallen) {
          h.fallen = false;
          h.hp = Math.round(heroMaxHp(next, h) / 2);
        }
      break;
    case 'recruit': {
      const idx = next.roster.findIndex((h) => h.fallen);
      const hero = getHero(reward.heroId!);
      next.roster[idx] = { heroId: hero.id, hp: 0, bonus: {}, fallen: false };
      next.roster[idx].hp = heroMaxHp(next, next.roster[idx]);
      break;
    }
  }
  for (const h of next.roster) if (!h.fallen) h.hp = Math.min(h.hp, heroMaxHp(next, h));
  next.rewards = null;
  return next;
}

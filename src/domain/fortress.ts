// The guild fortress: gold, buildings and real-time production (the Clash of Clans layer).
// Buildings only boost PvE modes and progression speed; they never change arena/PvP numbers.
// All functions take `now` (ms) so they are deterministic and testable.

export type BuildingId = 'keep' | 'mine' | 'barracks' | 'infirmary' | 'forge' | 'maproom';

export interface BuildingDef {
  id: BuildingId;
  name: string;
  maxLevel: number;
  /** Gold to go from level L-1 to L (index L). */
  costs: number[];
  effect: (level: number) => string;
}

const HOUR = 3_600_000;
export const MINE_RATE = [0, 30, 60, 100]; // gold per hour by mine level
export const MINE_CAP_HOURS = 8;
export const BARRACKS_XP = [0, 0.15, 0.3, 0.5]; // extra mastery XP
export const INFIRMARY_HEAL = [0, 0.1, 0.2, 0.3]; // extra expedition rest heal
export const FORGE_RELICS = [0, 1, 2];

export const BUILDINGS: BuildingDef[] = [
  {
    id: 'keep',
    name: 'Torre de Menagem',
    maxLevel: 3,
    costs: [0, 0, 250, 600],
    effect: (l) => `Os outros edifícios podem subir até ao nível ${l}.`,
  },
  {
    id: 'mine',
    name: 'Mina de Ouro',
    maxLevel: 3,
    costs: [0, 60, 200, 450],
    effect: (l) => (l ? `Produz ${MINE_RATE[l]} de ouro por hora (guarda até ${MINE_RATE[l] * MINE_CAP_HOURS}).` : 'Por construir: produz ouro mesmo quando não estás a jogar.'),
  },
  {
    id: 'barracks',
    name: 'Quartel',
    maxLevel: 3,
    costs: [0, 120, 300, 600],
    effect: (l) => (l ? `+${Math.round(BARRACKS_XP[l] * 100)}% de XP de maestria.` : 'Por construir: os heróis ganham mais XP.'),
  },
  {
    id: 'infirmary',
    name: 'Enfermaria',
    maxLevel: 3,
    costs: [0, 100, 260, 520],
    effect: (l) => (l ? `Na Expedição, o descanso entre combates cura mais ${Math.round(INFIRMARY_HEAL[l] * 100)}% da vida.` : 'Por construir: melhora o descanso na Expedição.'),
  },
  {
    id: 'forge',
    name: 'Forja',
    maxLevel: 2,
    costs: [0, 220, 550],
    effect: (l) => (l ? `Cada Expedição começa com ${FORGE_RELICS[l]} relíquia${l > 1 ? 's' : ''} aleatória${l > 1 ? 's' : ''}.` : 'Por construir: começa Expedições já com relíquias.'),
  },
  {
    id: 'maproom',
    name: 'Sala dos Mapas',
    maxLevel: 1,
    costs: [0, 300],
    effect: (l) => (l ? 'Na Expedição, cada vitória oferece 4 recompensas em vez de 3.' : 'Por construir: mais escolhas de recompensa na Expedição.'),
  },
];

export const getBuilding = (id: BuildingId) => BUILDINGS.find((b) => b.id === id)!;

export interface FortressState {
  gold: number;
  levels: Record<BuildingId, number>;
  /** When the mine was last emptied. */
  lastCollect: number;
}

export function newFortress(now: number): FortressState {
  return { gold: 100, levels: { keep: 1, mine: 0, barracks: 0, infirmary: 0, forge: 0, maproom: 0 }, lastCollect: now };
}

/** Gold waiting in the mine. */
export function minePending(f: FortressState, now: number): number {
  const rate = MINE_RATE[f.levels.mine];
  if (!rate) return 0;
  const hours = Math.max(0, now - f.lastCollect) / HOUR;
  return Math.floor(Math.min(hours, MINE_CAP_HOURS) * rate);
}

export function collectMine(f: FortressState, now: number): FortressState {
  return { ...f, gold: f.gold + minePending(f, now), lastCollect: now };
}

export type UpgradeCheck = { ok: true; cost: number } | { ok: false; reason: string; cost?: number };

export function canUpgrade(f: FortressState, id: BuildingId): UpgradeCheck {
  const def = getBuilding(id);
  const next = f.levels[id] + 1;
  if (next > def.maxLevel) return { ok: false, reason: 'Nível máximo.' };
  if (id !== 'keep' && next > f.levels.keep) return { ok: false, reason: `Precisa da Torre de Menagem no nível ${next}.`, cost: def.costs[next] };
  const cost = def.costs[next];
  if (f.gold < cost) return { ok: false, reason: `Faltam ${cost - f.gold} de ouro.`, cost };
  return { ok: true, cost };
}

export function upgrade(f: FortressState, id: BuildingId, now: number): FortressState {
  const check = canUpgrade(f, id);
  if (!check.ok) throw new Error(check.reason);
  // Building the mine starts its clock; upgrading it first banks what it produced.
  const base = id === 'mine' ? collectMine(f, now) : f;
  return { ...base, gold: base.gold - check.cost, levels: { ...base.levels, [id]: base.levels[id] + 1 } };
}

export function earn(f: FortressState, gold: number): FortressState {
  return { ...f, gold: f.gold + Math.max(0, Math.round(gold)) };
}

/** PvE perks the fortress grants to an expedition. */
export function expeditionPerks(f: FortressState) {
  return {
    restHealBonus: INFIRMARY_HEAL[f.levels.infirmary],
    startRelics: FORGE_RELICS[f.levels.forge],
    rewardCount: f.levels.maproom ? 4 : 3,
  };
}

export const masteryMultiplier = (f: FortressState) => 1 + BARRACKS_XP[f.levels.barracks];

/** Gold rewards (hypotheses). */
export const GOLD = {
  matchWin: 40,
  matchLoss: 15,
  expeditionStage: 30,
  expeditionWin: 150,
  dailyFirstWin: 60,
  puzzleFirstSolve: 50,
  arenaWin: 50,
  arenaLoss: 15,
};

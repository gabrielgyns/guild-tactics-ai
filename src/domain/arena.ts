import type { Deployment } from './battle';
import { MAPS, buildBoard, isWalkable } from './board';
import { HEROES, getHero } from './heroes';
import { hashString, mulberry32, pick, shuffled, type Rng } from './rng';
import type { HeroClass } from './types';

// Asynchronous PvP: a guild saves a defense (4 heroes + formation + map). Anyone holding the
// defense — a rival guild of the season or a friend's shared code — can attack it while the AI
// plays the defenders. Seasons are ISO weeks; rating is Elo.

export interface DefenseSlot {
  heroId: string;
  x: number;
  /** 0 = back row, 1 = front row (seen from the defender). */
  row: 0 | 1;
}

export interface Defense {
  guild: string;
  color: number;
  mapId: string;
  slots: DefenseSlot[];
}

// ---------------------------------------------------------------- validation & codes

export function validateDefense(d: Defense): string | null {
  if (!d || typeof d.guild !== 'string' || !d.guild.trim()) return 'Falta o nome da guilda.';
  if (d.guild.length > 24) return 'Nome da guilda demasiado longo.';
  const map = MAPS.find((m) => m.id === d.mapId);
  if (!map) return 'Mapa desconhecido.';
  if (!Array.isArray(d.slots) || d.slots.length !== 4) return 'Uma defesa tem exatamente 4 heróis.';
  const board = buildBoard(map);
  const ids = new Set<string>();
  const cells = new Set<string>();
  for (const s of d.slots) {
    if (!HEROES.some((h) => h.id === s.heroId)) return `Herói desconhecido: ${s.heroId}.`;
    if (ids.has(s.heroId)) return 'Heróis repetidos.';
    ids.add(s.heroId);
    if (!Number.isInteger(s.x) || s.x < 0 || s.x > 5 || (s.row !== 0 && s.row !== 1)) return 'Posição inválida.';
    if (!isWalkable(board, defenseCell(s))) return 'Um herói está numa casa intransponível.';
    const k = `${s.x},${s.row}`;
    if (cells.has(k)) return 'Dois heróis na mesma casa.';
    cells.add(k);
  }
  return null;
}

/** Board cell of a defense slot when the defense sits on the enemy side (rows 0–1). */
export const defenseCell = (s: DefenseSlot) => ({ x: s.x, y: s.row === 0 ? 0 : 1 });

const PREFIX = 'GT1-';

function toBase64Url(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeDefense(d: Defense): string {
  const compact = [d.guild, d.color, d.mapId, d.slots.map((s) => [s.heroId, s.x, s.row])];
  return PREFIX + toBase64Url(JSON.stringify(compact));
}

export function decodeDefense(code: string): Defense {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error('Isto não parece um código de defesa (começa por GT1-).');
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(trimmed.slice(PREFIX.length)));
  } catch {
    throw new Error('Código danificado: confirma que o copiaste completo.');
  }
  if (!Array.isArray(raw) || raw.length !== 4 || !Array.isArray(raw[3])) throw new Error('Código com formato inválido.');
  const [guild, color, mapId, slots] = raw as [string, number, string, [string, number, number][]];
  const d: Defense = {
    guild: String(guild).slice(0, 24),
    color: Number(color) >>> 0,
    mapId: String(mapId),
    slots: slots.map(([heroId, x, row]) => ({ heroId: String(heroId), x: Number(x), row: (Number(row) === 1 ? 1 : 0) as 0 | 1 })),
  };
  const err = validateDefense(d);
  if (err) throw new Error(err);
  return d;
}

export function defenseDeployments(d: Defense): Deployment[] {
  return d.slots.map((s) => ({ heroId: s.heroId, pos: defenseCell(s) }));
}

// ---------------------------------------------------------------- generated rivals

const GUILD_NAMES = [
  'Lobos de Ferro', 'Ordem do Carvalho', 'Corvos da Bruma', 'Lâminas do Sul', 'Vigias da Aurora',
  'Irmandade da Forja', 'Filhos da Maré', 'Coroa de Espinhos', 'Lanternas Rubras', 'Guarda do Vale',
  'Serpentes de Jade', 'Martelos da Serra',
];
const GUILD_COLORS = [0xe0524a, 0x3f7d4a, 0x7b4fa0, 0xd9a441, 0x2f8f9d, 0xd2642a, 0x8a95a5, 0xb5562b];
const CLASSES: HeroClass[] = ['warrior', 'ranger', 'mage', 'support'];

/** A sensible AI-made defense: one hero per class, warriors in front. */
export function generateDefense(rng: Rng, guild: string, color: number): Defense {
  const map = pick(rng, MAPS);
  const board = buildBoard(map);
  const heroes = CLASSES.map((c) => pick(rng, HEROES.filter((h) => h.heroClass === c)).id);
  const used = new Set<string>();
  const slots: DefenseSlot[] = heroes.map((heroId) => {
    const front = getHero(heroId).heroClass === 'warrior';
    for (const row of front ? [1, 0] : [0, 1]) {
      for (const x of shuffled(rng, [0, 1, 2, 3, 4, 5])) {
        const s = { heroId, x, row: row as 0 | 1 };
        const k = `${x},${row}`;
        if (!used.has(k) && isWalkable(board, defenseCell(s))) {
          used.add(k);
          return s;
        }
      }
    }
    throw new Error('No room for defense');
  });
  return { guild, color, mapId: map.id, slots };
}

export interface Rival {
  id: string;
  defense: Defense;
  rating: number;
}

/** ISO week key, e.g. 2026-W42. Each week is a season. */
export function seasonKey(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function seasonRivals(season: string, count = 7): Rival[] {
  const rng = mulberry32(hashString(`season:${season}`));
  const names = shuffled(rng, GUILD_NAMES).slice(0, count);
  return names.map((name, i) => ({
    id: `rival-${i}`,
    rating: 880 + Math.round((i / (count - 1)) * 420 + (rng() - 0.5) * 40),
    defense: generateDefense(rng, name, pick(rng, GUILD_COLORS)),
  }));
}

// ---------------------------------------------------------------- rating

export const START_RATING = 1000;
const K = 32;

export function eloDelta(me: number, opponent: number, won: boolean): number {
  const expected = 1 / (1 + 10 ** ((opponent - me) / 400));
  return Math.round(K * ((won ? 1 : 0) - expected));
}

export function tierOf(rating: number): { name: string; reward: number } {
  if (rating >= 1300) return { name: 'Diamante', reward: 400 };
  if (rating >= 1150) return { name: 'Ouro', reward: 250 };
  if (rating >= 1000) return { name: 'Prata', reward: 150 };
  return { name: 'Bronze', reward: 80 };
}

/** New season: half the distance to the starting rating is kept. */
export const softReset = (rating: number) => Math.round(START_RATING + (rating - START_RATING) / 2);

// ---------------------------------------------------------------- guild war

export interface GuildWar {
  season: string;
  opponent: string;
  color: number;
  fronts: { defense: Defense; result: 'pending' | 'won' | 'lost' }[];
}

/** Weekly war: the rival guild fields three defenses; win two to win the war. */
export function seasonWar(season: string): GuildWar {
  const rng = mulberry32(hashString(`war:${season}`));
  const opponent = pick(rng, GUILD_NAMES);
  const color = pick(rng, GUILD_COLORS);
  return { season, opponent, color, fronts: [0, 1, 2].map(() => ({ defense: generateDefense(rng, opponent, color), result: 'pending' })) };
}

export function warOutcome(w: GuildWar): 'won' | 'lost' | 'ongoing' {
  const won = w.fronts.filter((f) => f.result === 'won').length;
  const lost = w.fronts.filter((f) => f.result === 'lost').length;
  if (won >= 2) return 'won';
  if (lost >= 2) return 'lost';
  return 'ongoing';
}

export const WAR_REWARD = 200;

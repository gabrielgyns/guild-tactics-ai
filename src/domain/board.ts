import type { Board, Pos, Terrain } from './types';

// ---------------------------------------------------------------- geometry

export const samePos = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y;
export const manhattan = (a: Pos, b: Pos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const posKey = (p: Pos) => `${p.x},${p.y}`;

export const DIRS: Pos[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

export function inBounds(board: Board, p: Pos): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < board.width && p.y < board.height;
}

export function terrainAt(board: Board, p: Pos): Terrain {
  return board.tiles[p.y][p.x];
}

export function isWalkable(board: Board, p: Pos): boolean {
  if (!inBounds(board, p)) return false;
  const t = terrainAt(board, p);
  return t !== 'rock' && t !== 'water';
}

/** Movement points needed to enter a tile. */
export function moveCost(t: Terrain): number {
  return t === 'forest' || t === 'hill' ? 2 : 1;
}

export function neighbors(board: Board, p: Pos): Pos[] {
  return DIRS.map((d) => ({ x: p.x + d.x, y: p.y + d.y })).filter((n) => inBounds(board, n));
}

export function allTiles(board: Board): Pos[] {
  const out: Pos[] = [];
  for (let y = 0; y < board.height; y++) for (let x = 0; x < board.width; x++) out.push({ x, y });
  return out;
}

/** Unit direction (one axis) from a to b. Zero vector when equal. */
export function stepToward(a: Pos, b: Pos): Pos {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: Math.sign(dx), y: 0 };
  return { x: 0, y: Math.sign(dy) };
}

// ---------------------------------------------------------------- maps

const LEGEND: Record<string, Terrain> = {
  '.': 'plain',
  F: 'forest',
  H: 'hill',
  R: 'rock',
  W: 'water',
  S: 'shrine',
};

export const TERRAIN_LABEL: Record<Terrain, string> = {
  plain: 'Planície',
  forest: 'Floresta',
  hill: 'Colina',
  rock: 'Rocha',
  water: 'Água',
  shrine: 'Santuário',
};

export const TERRAIN_HINT: Record<Terrain, string> = {
  plain: 'Sem efeitos.',
  forest: 'Custa 2 de movimento. Quem está aqui recebe −25% de dano.',
  hill: 'Custa 2 de movimento. Ataques daqui causam +20% e alcance à distância +1.',
  rock: 'Intransponível.',
  water: 'Intransponível.',
  shrine: 'Quem começa o turno aqui recupera 4 de vida e ganha 15 de energia. Vale a pena disputá-lo.',
};

export interface MapDef {
  id: string;
  name: string;
  rows: string[]; // y = 0 is the enemy back row, y = 5 the player back row
}

// All maps are point-symmetric (rotate 180°) so both sides start on equal terms.
// 8×8: room to manoeuvre, two shrines in the middle, deployment on the two back rows of each side.
export const MAPS: MapDef[] = [
  {
    id: 'mill8',
    name: 'Ribeiro do Moinho',
    rows: ['..F...H.', '.R...F..', '...H..R.', 'WW.S.WWW', 'WWW.S.WW', '.R..H...', '..F...R.', '.H...F..'],
  },
  {
    id: 'ruins8',
    name: 'Ruínas da Atalaia',
    rows: ['...R....', '.F..H..F', '..R..F..', 'H...S.R.', '.R.S...H', '..F..R..', 'F..H..F.', '....R...'],
  },
  {
    id: 'ford8',
    name: 'Vau dos Salgueiros',
    rows: ['.F......', '...H..R.', 'WW...F..', '.WW.S..F', 'F..S.WW.', '..F...WW', '.R..H...', '......F.'],
  },
  {
    id: 'grove8',
    name: 'Bosque Cerrado',
    rows: ['F......F', '..F.R...', '.FF..FH.', '......S.', '.S......', '.HF..FF.', '...R.F..', 'F......F'],
  },
];

/** The original 6×6 maps, kept so saved expeditions, defenses and replays still load. */
export const LEGACY_MAPS: MapDef[] = [
  { id: 'mill', name: 'Ribeiro do Moinho (6×6)', rows: ['..F..H', '.R..F.', 'W.SH.W', 'W.HS.W', '.F..R.', 'H..F..'] },
  { id: 'ruins', name: 'Ruínas da Atalaia (6×6)', rows: ['...R..', 'F.H..F', '.RS.F.', '.F.SR.', 'F..H.F', '..R...'] },
  { id: 'ford', name: 'Vau dos Salgueiros (6×6)', rows: ['.F....', '...H.R', 'WW.SF.', '.FS.WW', 'R.H...', '....F.'] },
];

export function findMap(id: string): MapDef | undefined {
  return MAPS.find((m) => m.id === id) ?? LEGACY_MAPS.find((m) => m.id === id);
}

export function buildBoard(map: MapDef): Board {
  const tiles = map.rows.map((row) => row.split('').map((c) => LEGEND[c] ?? 'plain'));
  return { width: tiles[0].length, height: tiles.length, name: map.name, tiles };
}

/** Deployment rows: the two back rows on each side. */
export function deployRows(board: Board, side: 'player' | 'enemy'): number[] {
  return side === 'player' ? [board.height - 2, board.height - 1] : [0, 1];
}

/** Columns ordered from the centre outwards (used to spread a formation). */
export function centreOut(width: number): number[] {
  const mid = (width - 1) / 2;
  return [...Array(width).keys()].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
}

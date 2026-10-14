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
};

export const TERRAIN_LABEL: Record<Terrain, string> = {
  plain: 'Planície',
  forest: 'Floresta',
  hill: 'Colina',
  rock: 'Rocha',
  water: 'Água',
};

export const TERRAIN_HINT: Record<Terrain, string> = {
  plain: 'Sem efeitos.',
  forest: 'Custa 2 de movimento. Quem está aqui recebe −25% de dano.',
  hill: 'Custa 2 de movimento. Ataques daqui causam +20% e alcance à distância +1.',
  rock: 'Intransponível.',
  water: 'Intransponível.',
};

export interface MapDef {
  id: string;
  name: string;
  rows: string[]; // y = 0 is the enemy back row, y = 5 the player back row
}

// All maps are point-symmetric (rotate 180°) so both sides start on equal terms.
export const MAPS: MapDef[] = [
  {
    id: 'mill',
    name: 'Ribeiro do Moinho',
    rows: ['..F..H', '.R..F.', 'W..H.W', 'W.H..W', '.F..R.', 'H..F..'],
  },
  {
    id: 'ruins',
    name: 'Ruínas da Atalaia',
    rows: ['...R..', 'F.H..F', '.R..F.', '.F..R.', 'F..H.F', '..R...'],
  },
  {
    id: 'ford',
    name: 'Vau dos Salgueiros',
    rows: ['.F....', '...H.R', 'WW..F.', '.F..WW', 'R.H...', '....F.'],
  },
];

export function buildBoard(map: MapDef): Board {
  const tiles = map.rows.map((row) => row.split('').map((c) => LEGEND[c] ?? 'plain'));
  return { width: tiles[0].length, height: tiles.length, name: map.name, tiles };
}

export const DEPLOY_ROWS: Record<'player' | 'enemy', number[]> = {
  player: [4, 5],
  enemy: [0, 1],
};

// Per-player progress kept in this browser (localStorage). Every access tolerates storage being unavailable.

const PREFIX = 'guild-tactics.';

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function loadRaw<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function save(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export interface ExpeditionRecord {
  runs: number;
  wins: number;
  bestStage: number;
}

export interface DailyRecord {
  /** date → best result that day */
  results: Record<string, { won: boolean; rounds: number }>;
}

export interface PuzzleRecord {
  solved: string[];
}

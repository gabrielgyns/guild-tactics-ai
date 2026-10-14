// Real asynchronous PvP through the artifact's shared database (the claude.ai `db` capability).
// Every player owns one document, guilds/<their id>, holding their guild, defense code, rating,
// recent attacks and war progress. Everyone can read every guild; each player writes only their own.
// Outside the claude.ai viewer (local dev, a saved file) this whole layer is simply absent.

import { seasonKey } from '../domain/arena';

export interface AttackEntry {
  target: string;
  targetGuild: string;
  won: boolean;
  at: number;
  season: string;
}

export interface WarProgress {
  season: string;
  opponent: string;
  results: ('won' | 'lost')[];
}

export interface OnlineGuild {
  id: string;
  guild: string;
  color: number;
  code: string;
  rating: number;
  wins: number;
  losses: number;
  season: string;
  updatedAt: number;
  /** Most recent attacks this guild made (newest first, max 20). */
  attacks: AttackEntry[];
  /** Ids attacked recently, so defenders can find who hit them. */
  targets: string[];
  war: WarProgress | null;
}

/** The rules this page declares when published (keep in sync with the publish call). */
export const DB_RULES = [
  { path: 'guilds', read: 'view', write: 'owner' },
  { path: 'guilds/{self}', write: 'interact' },
];

interface DocSnap {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
interface DocRef {
  get(): Promise<DocSnap>;
  set(data: Record<string, unknown>): Promise<void>;
}
interface Query {
  where(field: string, op: string, value: unknown): Query;
  get(): Promise<{ docs: DocSnap[] }>;
}
interface DbLike {
  doc(path: string): DocRef;
  collection(path: string): Query;
}
interface UserLike {
  id(): Promise<string | null>;
  can(name: string): Promise<boolean | null>;
}
declare global {
  interface Window {
    claude?: { use(name: string): Promise<unknown> };
  }
}

function normalize(id: string, raw: Record<string, unknown> | undefined): OnlineGuild | null {
  if (!raw || typeof raw.code !== 'string' || typeof raw.guild !== 'string') return null;
  return {
    id,
    guild: String(raw.guild).slice(0, 24),
    color: Number(raw.color) >>> 0,
    code: raw.code,
    rating: Number(raw.rating) || 1000,
    wins: Number(raw.wins) || 0,
    losses: Number(raw.losses) || 0,
    season: String(raw.season ?? ''),
    updatedAt: Number(raw.updatedAt) || 0,
    attacks: Array.isArray(raw.attacks) ? (raw.attacks as AttackEntry[]).slice(0, 20) : [],
    targets: Array.isArray(raw.targets) ? (raw.targets as string[]).slice(0, 20) : [],
    war: raw.war && typeof raw.war === 'object' ? (raw.war as WarProgress) : null,
  };
}

export class Online {
  private constructor(
    private db: DbLike,
    readonly uid: string,
    /** null = the platform did not say; try writing and let a refusal decide. */
    readonly canWrite: boolean | null,
  ) {}

  private static pending: Promise<Online | null> | null = null;

  /** Resolves once per page; null when the page is not running inside the claude.ai viewer. */
  static connect(): Promise<Online | null> {
    if (!Online.pending) {
      Online.pending = (async () => {
        try {
          if (!window.claude?.use) return null;
          const [db, user] = (await Promise.all([window.claude.use('db'), window.claude.use('user')])) as [DbLike | null, UserLike | null];
          if (!db || !user) return null;
          const uid = await user.id();
          if (!uid) return null;
          return new Online(db, uid, await user.can('data.write'));
        } catch {
          return null;
        }
      })();
    }
    return Online.pending;
  }

  async me(): Promise<OnlineGuild | null> {
    const snap = await this.db.doc(`guilds/${this.uid}`).get();
    return snap.exists ? normalize(this.uid, snap.data()) : null;
  }

  /** Writes this player's whole guild document (one write per user action). */
  async save(g: Omit<OnlineGuild, 'id' | 'updatedAt'>): Promise<void> {
    await this.db.doc(`guilds/${this.uid}`).set({ ...g, updatedAt: Date.now() });
  }

  async all(): Promise<OnlineGuild[]> {
    const snap = await this.db.collection('guilds').get();
    return snap.docs.map((d) => normalize(d.id, d.data())).filter((g): g is OnlineGuild => !!g);
  }
}

/** Guilds active this season, paired in id order for the weekly war; null if unpaired. */
export function warOpponent(guilds: OnlineGuild[], uid: string, season = seasonKey()): OnlineGuild | null {
  const active = guilds.filter((g) => g.season === season).sort((a, b) => a.id.localeCompare(b.id));
  const i = active.findIndex((g) => g.id === uid);
  if (i < 0) return null;
  const partner = i % 2 === 0 ? active[i + 1] : active[i - 1];
  return partner ?? null;
}

/** Attacks other guilds made against `uid` this season (newest first). */
export function attacksOn(guilds: OnlineGuild[], uid: string, season = seasonKey()) {
  return guilds
    .filter((g) => g.id !== uid)
    .flatMap((g) => g.attacks.filter((a) => a.target === uid && a.season === season).map((a) => ({ ...a, by: g.guild, byColor: g.color })))
    .sort((a, b) => b.at - a.at);
}

/** War score from both sides' own records: my wins against them vs their wins against me. */
export function warScore(me: OnlineGuild | null, them: OnlineGuild, season = seasonKey()) {
  const mine = me?.war && me.war.season === season && me.war.opponent === them.id ? me.war.results : [];
  const theirs = them.war && them.war.season === season && them.war.opponent === me?.id ? them.war.results : [];
  return {
    mine: mine.filter((r) => r === 'won').length,
    theirs: theirs.filter((r) => r === 'won').length,
    myAttacksLeft: 3 - mine.length,
    theirAttacksLeft: 3 - theirs.length,
  };
}

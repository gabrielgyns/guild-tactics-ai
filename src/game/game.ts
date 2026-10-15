import { planTurn } from '../domain/ai';
import {
  activeUnit,
  applyCommand,
  areaOf,
  canUseAbility,
  cloneState,
  createBattle,
  getUnit,
  isValidTarget,
  previewAbility,
  rangeTiles,
  reachableTiles,
  roundOrder,
  RULES,
  sideThreat,
  threatTiles,
  aliveUnits,
  unitAt,
  validTargets,
  type Deployment,
} from '../domain/battle';
import { autoDeploy } from '../domain/deploy';
import { puzzleFailed } from '../domain/puzzles';
import { analyzeMatch } from '../domain/analysis';
import { deployRows, MAPS, TERRAIN_HINT, TERRAIN_LABEL, buildBoard, isWalkable, posKey, samePos, terrainAt } from '../domain/board';
import { CLASS_GLYPH, CLASS_LABEL, HEROES, findAbility, getHero, heroAbilities } from '../domain/heroes';
import type { Ability, Element, BattleEvent, BattleState, Board, Command, HeroClass, Pos, Side, Unit } from '../domain/types';
import type { MapDef } from '../domain/board';
import { ELEMENT_COLOR, ELEMENT_GLYPH, ELEMENT_LABEL, elementMatchup } from '../domain/elements';
import { STATUS_GLYPH, STATUS_LABEL, BattleView, type HighlightKind } from '../render/view';
import { renderPortrait, renderPortraits } from '../render/models';
import { applyTraits, teamTraits, type Trait } from '../domain/traits';
import { masteryMultiplier, GOLD } from '../domain/fortress';
import { addGold, loadFortress, loadRaw, save } from './profile';
import { applyLoadout, awardBonds, awardItem } from './loadout';
import { awardMastery, BADGE, levelFor, loadMastery, masteryHtml, skinOf, type MasteryProfile, type Skin } from './mastery';
import { audio, type Sfx } from '../ui/audio';
import { TUTORIAL_ENEMY, TUTORIAL_MAP, TUTORIAL_PLAYER, TUTORIAL_STEPS } from './tutorial';

type Difficulty = 'recruit' | 'veteran';

export interface MatchOutcome {
  winner: Side | 'draw' | null;
  surrendered: boolean;
  state: BattleState;
  seconds: number;
}

export interface TutorialStep {
  text: string;
  /** Advances when this returns true after an event (or a UI action such as toggling the threat zone). */
  until?: (ctx: { event?: BattleEvent; state: BattleState; threatOn: boolean }) => boolean;
  /** Advances on a button press instead. */
  button?: string;
}

/** Everything the battle screen needs to run one match, whatever the mode. */
export interface MatchSpec {
  kind: 'quick' | 'tutorial' | 'expedition' | 'daily' | 'puzzle' | 'arena' | 'replay';
  label: string;
  map: MapDef;
  player: Deployment[];
  enemy: Deployment[];
  noise: number;
  deploy: boolean;
  rerollMap?: () => MatchSpec;
  backLabel?: string;
  onBack?: () => void;
  tutorial?: TutorialStep[];
  /** Puzzle rule: the player loses as soon as an enemy would act. */
  winBeforeEnemyActs?: boolean;
  /** Custom result handling; the default result modal is used when absent. */
  onFinish?: (o: MatchOutcome) => void;
  onRematch?: () => void;
  countsForRecord?: boolean;
  /** Deployments already include traits (replays): use them as they are. */
  prepared?: boolean;
  /** Replay mode: these commands are played back instead of taking input. */
  replay?: Command[];
}

/** Everything needed to re-run a finished battle exactly (rules are deterministic). */
export interface Replay {
  id: string;
  title: string;
  date: string;
  mapId: string;
  player: Deployment[];
  enemy: Deployment[];
  commands: Command[];
  winner: Side | 'draw' | null;
}
type Mode = { kind: 'idle' } | { kind: 'target'; abilityId: string };

const DIFFICULTY_NOISE: Record<Difficulty, number> = { recruit: 16, veteran: 0.8 };
/** Recruit opponents are also physically weaker, so a first match is winnable. */
const RECRUIT_EASE = { atk: -2, maxHp: -5 };
const STORAGE_KEY = 'guild-tactics.v1';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

interface Record_ {
  wins: number;
  losses: number;
  streak: number;
}

function loadRecord(): Record_ {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { wins: 0, losses: 0, streak: 0, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { wins: 0, losses: 0, streak: 0 };
}

function saveRecord(r: Record_) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
  } catch {
    /* storage unavailable */
  }
}

const shuffle = <T,>(a: T[]) => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

export interface PickerOptions {
  eyebrow: string;
  title: string;
  intro: string;
  confirmLabel: string;
  showDifficulty: boolean;
  onConfirm: (team: string[]) => void;
}

export class Game {
  private portraits = new Map<string, string>();
  private mastery: MasteryProfile = loadMastery();
  private lastMasteryHtml = '';
  private lastGoldHtml = '';
  private goldThisMatch = 0;
  private commandLog: Command[] = [];
  private matchEvents: BattleEvent[] = [];
  private ultReady = new Set<string>();
  private exposures: { unitId: string; round: number; count: number }[] = [];
  private suggestion: Map<string, HighlightKind> | null = null;
  private team: string[] = [];
  private difficulty: Difficulty = 'recruit';
  private record = loadRecord();

  private selectEl!: HTMLDivElement;
  private pickerOpts!: PickerOptions;
  /** Set by main.ts: shows the main menu. */
  onHub: () => void = () => {};
  private battleEl!: HTMLDivElement;
  private view!: BattleView;
  private el: Record<string, HTMLElement> = {};

  // battle
  private phase: 'deploy' | 'battle' | 'over' = 'deploy';
  private spec!: MatchSpec;
  private map!: MapDef;
  private board!: Board;
  private tutorialStep = 0;
  private playerDeploy: Deployment[] = [];
  private enemyDeploy: Deployment[] = [];
  private deploySelected: number | null = null;
  private state!: BattleState;
  private mode: Mode = { kind: 'idle' };
  private busy = false;
  private hover: Pos | null = null;
  private touchArmed: string | null = null;
  private startedAt = 0;
  private logLines: { text: string; side: Side }[] = [];
  private surrenderArmed = false;
  private showThreat = false;
  /** Auto-battle: the AI plays the player's turns too (toggle with A). */
  private autoBattle = false;

  constructor(private app: HTMLElement) {}

  start() {
    try {
      this.portraits = renderPortraits(HEROES.map((h) => h.id));
    } catch {
      /* portraits are optional */
    }
    this.buildBattleDom();
    this.buildSelect();
    this.selectEl.hidden = true;
    window.addEventListener('keydown', (e) => this.onKey(e));
    const unlock = () => audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  /** Portrait data URL; player-side portraits use the hero's chosen skin. Rendered lazily and cached. */
  portrait(heroId: string, side: Side = 'player', skin?: Skin) {
    const sk = skin ?? (side === 'player' ? skinOf(this.mastery, heroId) : 'classic');
    const key = `${heroId}:${side}:${sk}`;
    let url = this.portraits.get(key);
    if (url === undefined) {
      url = renderPortrait(heroId, side, sk);
      this.portraits.set(key, url);
    }
    return url;
  }

  refreshMastery() {
    this.mastery = loadMastery();
  }

  get masteryProfile() {
    return this.mastery;
  }

  /** Chips describing a team's guild traits; inactive ones show progress. */
  traitsHtml(heroIds: string[], onlyActive = false) {
    const traits = teamTraits(heroIds).filter((t) => t.active || (!onlyActive && t.progress !== '0/2' && !t.id.startsWith('attune')));
    if (!traits.length) return '';
    return `<div class="traits">${traits
      .map((t: Trait) => `<span class="trait${t.active ? ' on' : ''}" title="${esc(t.description)}">${t.active ? '◆' : '◇'} ${esc(t.name)}${t.active ? '' : ` ${t.progress}`}</span>`)
      .join('')}</div>`;
  }

  // =============================================================== team select

  private buildSelect() {
    this.selectEl?.remove();
    const el = document.createElement('div');
    el.className = 'screen';
    this.selectEl = el;
    this.app.appendChild(el);
    this.battleEl.hidden = true;
  }

  /** Opens the team picker for a mode. */
  openPicker(opts: PickerOptions) {
    this.pickerOpts = opts;
    this.phase = 'deploy';
    this.battleEl.hidden = true;
    this.hideOtherScreens();
    this.selectEl.hidden = false;
    this.renderSelect();
    this.selectEl.scrollTop = 0;
  }

  openQuickMatch() {
    this.openPicker({
      eyebrow: 'Partida rápida',
      title: 'Monta a tua equipa',
      intro: 'Escolhe quatro heróis. Equipas com uma classe de cada costumam ser mais estáveis; os elementos decidem quem bate mais forte em quem.',
      confirmLabel: 'Posicionar ›',
      showDifficulty: true,
      onConfirm: () => this.startDeploy(),
    });
  }

  get difficultyNoise() {
    return DIFFICULTY_NOISE[this.difficulty];
  }

  /** Stat handicap for opponents at the current difficulty (used by quick-style modes). */
  get difficultyBonus() {
    return this.difficulty === 'recruit' ? { ...RECRUIT_EASE } : undefined;
  }

  private renderSelect() {
    const r = this.record;
    const classes = new Set(this.team.map((id) => getHero(id).heroClass));
    const slots = [0, 1, 2, 3]
      .map((i) => {
        const id = this.team[i];
        if (!id) return `<div class="slot">Lugar ${i + 1} livre</div>`;
        const h = getHero(id);
        return `<button class="slot filled" data-remove="${id}" title="Remover ${esc(h.name)}">
          <img alt="" src="${this.portrait(id)}" />
          <div><div class="slot-name">${esc(h.name)}</div><div class="slot-sub">${CLASS_GLYPH[h.heroClass]} ${CLASS_LABEL[h.heroClass]}</div></div>
        </button>`;
      })
      .join('');

    const cards = HEROES.map((h) => {
      const idx = this.team.indexOf(h.id);
      const s = h.stats;
      const abil = [...h.abilities, h.ultimate]
        .map(
          (a) =>
            `<div><b>${esc(a.name)}</b>${a.quick ? '<span class="q">rápida</span>' : ''}${a.ultimate ? '<span class="q">supremo</span>' : ''} — ${esc(a.description.replace(/^Supremo: /, ''))}</div>`,
        )
        .join('');
      return `<button class="hero-card" data-hero="${h.id}" aria-pressed="${idx >= 0}">
        ${idx >= 0 ? `<span class="pick-badge">${idx + 1}</span>` : ''}
        <img class="portrait" alt="" src="${this.portrait(h.id)}" />
        <div>
          <span class="chip ${h.heroClass}">${CLASS_GLYPH[h.heroClass]} ${CLASS_LABEL[h.heroClass]}</span>
          ${this.elementChip(h.element)}
          <h3>${esc(h.name)} <span class="lvl" title="Nível de maestria">${BADGE[levelFor(this.mastery.xp[h.id] ?? 0)]} nv ${levelFor(this.mastery.xp[h.id] ?? 0)}</span></h3>
          <div class="htitle">${esc(h.title)} · alcance ${h.attack.min}–${h.attack.max}${h.attack.magic ? ' mágico' : ''}</div>
          <div class="stats num">
            <span>PV<b>${s.maxHp}</b></span><span>ATQ<b>${s.atk}</b></span><span>DEF<b>${s.def}</b></span><span>MOV<b>${s.mov}</b></span><span>VEL<b>${s.spd}</b></span>
          </div>
        </div>
        <div class="abil">${abil}</div>
        <p class="lore">${esc(h.lore)}</p>
      </button>`;
    }).join('');

    const missing = (['warrior', 'ranger', 'mage', 'support'] as HeroClass[]).filter((c) => !classes.has(c));
    const comp =
      this.team.length === 4
        ? missing.length === 0
          ? '<span class="ok">Equipa equilibrada: uma de cada classe.</span>'
          : `Sem ${missing.map((c) => CLASS_LABEL[c].toLowerCase()).join(' nem ')} — pode resultar, mas é arriscado.`
        : `Escolhe ${4 - this.team.length} herói${4 - this.team.length === 1 ? '' : 's'}.`;

    const o = this.pickerOpts;
    this.selectEl.innerHTML = `
      <div class="select-wrap">
        <div class="title-row">
          <div>
            <button class="btn ghost back-btn" id="btn-menu">‹ Salão</button>
            <div class="eyebrow">${esc(o.eyebrow)}</div>
            <h1 class="page-title">${esc(o.title)}</h1>
            <p class="tagline">${esc(o.intro)}</p>
          </div>
          ${
            o.showDifficulty
              ? `<div class="record">
            <div><b class="num">${r.wins}</b> vitórias · <b class="num">${r.losses}</b> derrotas</div>
            ${r.streak > 1 ? `<div>Sequência de ${r.streak} vitórias</div>` : ''}
          </div>`
              : ''
          }
        </div>
        <div class="squad-bar">
          ${slots}
          <div class="squad-actions">
            <button class="btn" id="btn-random">Aleatória</button>
            <button class="btn primary" id="btn-next" ${this.team.length === 4 ? '' : 'disabled'}>${esc(o.confirmLabel)}</button>
          </div>
          <div class="squad-hint">
            <span>${comp}</span>
            ${this.traitsHtml(this.team)}
            ${
              o.showDifficulty
                ? `<span style="margin-left:auto">Adversário:</span>
            <span class="seg" role="group" aria-label="Dificuldade">
              <button id="dif-recruit" aria-pressed="${this.difficulty === 'recruit'}">Recruta</button>
              <button id="dif-veteran" aria-pressed="${this.difficulty === 'veteran'}">Veterano</button>
            </span>`
                : ''
            }
          </div>
        </div>
        <div class="hero-grid">${cards}</div>
        ${this.howToHtml(false)}
      </div>`;

    this.selectEl.querySelectorAll<HTMLButtonElement>('[data-hero]').forEach((b) =>
      b.addEventListener('click', () => this.toggleHero(b.dataset.hero!)),
    );
    this.selectEl.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) =>
      b.addEventListener('click', () => this.toggleHero(b.dataset.remove!)),
    );
    this.selectEl.querySelector('#btn-random')!.addEventListener('click', () => {
      const byClass = (c: HeroClass) => shuffle(HEROES.filter((h) => h.heroClass === c))[0].id;
      this.team = (['warrior', 'ranger', 'mage', 'support'] as HeroClass[]).map(byClass);
      this.renderSelect();
    });
    this.selectEl.querySelector('#btn-next')!.addEventListener('click', () => o.onConfirm([...this.team]));
    this.selectEl.querySelector('#btn-menu')!.addEventListener('click', () => this.onHub());
    this.selectEl.querySelector('#dif-recruit')?.addEventListener('click', () => {
      this.difficulty = 'recruit';
      this.renderSelect();
    });
    this.selectEl.querySelector('#dif-veteran')?.addEventListener('click', () => {
      this.difficulty = 'veteran';
      this.renderSelect();
    });
  }

  private toggleHero(id: string) {
    const scrollY = this.selectEl.scrollTop;
    if (this.team.includes(id)) this.team = this.team.filter((x) => x !== id);
    else if (this.team.length < 4) this.team = [...this.team, id];
    this.renderSelect();
    this.selectEl.scrollTop = scrollY;
  }

  private insightsHtml(o: MatchOutcome): string {
    if (o.surrendered || this.spec.kind === 'tutorial' || this.spec.kind === 'replay') return '';
    const tips = analyzeMatch(o.state, this.matchEvents, [...this.ultReady], this.exposures);
    const title = o.winner === 'player' ? 'O que correu bem e o que afinar' : 'Porque perdi?';
    return `<div class="insights"><div class="eyebrow">${title}</div><ul>${tips.map((t) => `<li>${esc(t.text)}</li>`).join('')}</ul></div>`;
  }

  /** Shows what the AI would do with the active hero (without doing it). */
  private suggest() {
    if (!this.isPlayerTurn()) return;
    const unit = activeUnit(this.state)!;
    const cmds = planTurn(cloneState(this.state), { noise: 0, random: Math.random });
    const hl = new Map<string, HighlightKind>();
    const sim = cloneState(this.state);
    const parts: string[] = [];
    for (const c of cmds) {
      if (c.type === 'move') {
        hl.set(posKey(c.to), 'select');
        parts.push('mover para a casa dourada');
      } else if (c.type === 'ability') {
        const caster = getUnit(sim, unit.id);
        const ability = findAbility(caster.heroId, c.abilityId);
        for (const p of areaOf(sim, caster, ability, c.target)) if (!hl.has(posKey(p))) hl.set(posKey(p), ability.affects === 'allies' ? 'heal' : 'area');
        const target = unitAt(sim, c.target);
        parts.push(`${ability.name}${target && target.id !== caster.id ? ` em ${getHero(target.heroId).name}` : ''}`);
      } else if (c.type === 'endTurn') parts.push('terminar o turno');
      try {
        applyCommand(sim, c);
      } catch {
        break;
      }
      if (sim.active?.unitId !== unit.id) break;
    }
    this.suggestion = hl;
    this.el.hint.innerHTML = `💡 <em>Sugestão:</em> ${esc(parts.join(' → '))}. <span style="color:var(--muted)">A decisão é tua.</span>`;
    audio.play('click');
    this.refreshBoard();
  }

  private saveReplay(s: BattleState) {
    const replays = loadRaw<Replay[]>('replays') ?? [];
    const enemyGuild = this.spec.label;
    replays.unshift({
      id: `${Date.now()}`,
      title: enemyGuild,
      date: new Date().toISOString().slice(0, 16).replace('T', ' '),
      mapId: this.map.id,
      player: this.initialPlayer,
      enemy: this.initialEnemy,
      commands: [...this.commandLog],
      winner: s.winner,
    });
    save('replays', replays.slice(0, 8));
  }

  /** Plays a stored replay on the battle screen. */
  watchReplay(r: Replay, map: MapDef, onDone: () => void) {
    this.launch({
      kind: 'replay',
      label: `Replay · ${r.title}`,
      map,
      player: r.player,
      enemy: r.enemy,
      noise: 0,
      deploy: false,
      prepared: true,
      replay: r.commands,
      onFinish: () => {
        const won = r.winner === 'player';
        this.banner(won ? 'Vitória' : r.winner === 'draw' ? 'Empate' : 'Derrota', 'Fim do replay', won ? 'player' : 'enemy');
        setTimeout(onDone, 1600);
      },
    });
  }

  /** Rolls an equipment drop into the inventory and lists it on the result screen. */
  awardLoot(luck = 0) {
    this.lastGoldHtml += awardItem(luck);
  }

  /** Adds gold to the fortress treasury and lists it on the result screen. */
  awardGold(amount: number, reason: string) {
    if (amount <= 0) return;
    const f = addGold(amount);
    this.goldThisMatch += amount;
    const loot = this.lastGoldHtml.split('<div class="gold-gain">🎁').slice(1).map((x) => '<div class="gold-gain">🎁' + x).join('');
    this.lastGoldHtml = `<div class="gold-gain">🪙 +${this.goldThisMatch} de ouro <span class="muted">(${esc(reason)}) · tesouro: ${f.gold}</span></div>${loot}`;
  }

  recordSummary() {
    return { ...this.record };
  }

  elementChip(e: Element) {
    const m = elementMatchup(e);
    const tip = `Forte contra ${m.strong.map((x) => ELEMENT_LABEL[x]).join(', ')} · fraco contra ${m.weak.map((x) => ELEMENT_LABEL[x]).join(', ')}`;
    return `<span class="chip el" style="color:${ELEMENT_COLOR[e]}" title="${tip}">${ELEMENT_GLYPH[e]} ${ELEMENT_LABEL[e]}</span>`;
  }

  private howToHtml(open: boolean) {
    return `<details class="howto" ${open ? 'open' : ''}>
      <summary>Como jogar</summary>
      <div class="howto-body">
        <div><h4>O turno</h4><p>Cada herói joga quando chega a sua vez (ordem no topo, por velocidade). No teu turno podes <b>mover</b> e depois fazer <b>uma ação</b>: atacar, usar uma habilidade ou defender. A ação termina o turno. Ações <em>rápidas</em> não terminam.</p></div>
        <div><h4>Vencer</h4><p>Derrota os quatro heróis inimigos. Ao fim de 12 rondas vence quem tiver mais vida (em %).</p></div>
        <div><h4>Terreno</h4><ul><li><b>Floresta</b>: −25% de dano recebido, custa 2 de movimento.</li><li><b>Colina</b>: +20% de dano e +1 de alcance à distância, custa 2.</li><li><b>Rocha</b> e <b>água</b>: intransponíveis.</li></ul></div>
        <div><h4>Elementos</h4><p>🔥 Fogo vence 🌿 Natureza, que vence 💧 Água, que vence Fogo. ☀ Luz e ☾ Sombra vencem-se uma à outra. Vantagem: +30% de dano; desvantagem: −20%. A cor ao lado da barra de vida mostra o elemento.</p></div>
        <div><h4>Santuários</h4><p>As casas de pedra com cristais roxos curam 4 e dão 15 de energia a quem lá começa o turno. Disputa-os.</p></div>
        <div><h4>Energia e supremo</h4><p>Cada herói ganha energia no início do turno e ao causar ou sofrer dano. Com a barra dourada cheia, desbloqueia o seu <b>golpe supremo</b>, que gasta a barra toda.</p></div>
        <div><h4>Zona de ameaça</h4><p>Carrega em <kbd>T</kbd> (ou no botão ⚠) para ver as casas que os inimigos conseguem atingir no próximo turno. Passar o rato sobre um inimigo mostra só o alcance dele. Casas de movimento a roxo estão em perigo.</p></div>
        <div><h4>Sinergias</h4><ul><li><b>Cerco</b>: +15% de dano por cada aliado teu encostado ao alvo.</li><li>Recargas (número sobre o botão) obrigam a gerir habilidades.</li><li>Passa o rato sobre um alvo para ver o dano exato antes de agir.</li></ul></div>
        <div><h4>Controlos</h4><p><kbd>1</kbd>–<kbd>6</kbd> ações · <kbd>T</kbd> zona de ameaça · <kbd>Espaço</kbd> terminar turno · <kbd>Esc</kbd> cancelar / desfazer movimento · <kbd>Q</kbd> <kbd>E</kbd> rodar câmara. No telemóvel: toca uma vez para pré-visualizar e outra para confirmar.</p></div>
      </div>
    </details>`;
  }

  // =============================================================== battle DOM

  private buildBattleDom() {
    const el = document.createElement('div');
    el.className = 'battle';
    el.innerHTML = `
      <div class="stage"></div>
      <div class="tag-layer"></div>
      <div class="hud">
        <div class="hud-top">
          <div class="round-box"><div class="r num" data-ref="round"></div><div class="m" data-ref="mapname"></div></div>
          <div class="order" data-ref="order"></div>
          <div class="top-btns">
            <button class="icon-btn auto" data-ref="auto" title="Combate automático (A)" aria-label="Combate automático" aria-pressed="false">AUTO</button>
            <button class="icon-btn" data-ref="threat" title="Zona de ameaça inimiga (T)" aria-label="Mostrar zona de ameaça inimiga" aria-pressed="false">⚠</button>
            <button class="icon-btn" data-ref="rotl" title="Rodar câmara (Q)" aria-label="Rodar câmara para a esquerda">⟲</button>
            <button class="icon-btn" data-ref="rotr" title="Rodar câmara (E)" aria-label="Rodar câmara para a direita">⟳</button>
            <button class="icon-btn" data-ref="zoomin" title="Aproximar (roda do rato)" aria-label="Aproximar">+</button>
            <button class="icon-btn" data-ref="zoomout" title="Afastar (roda do rato)" aria-label="Afastar">−</button>
            <button class="icon-btn" data-ref="speed" title="Velocidade das animações">1×</button>
            <button class="icon-btn" data-ref="mute" title="Som" aria-label="Ligar ou desligar o som">${audio.muted ? '🔇' : '🔊'}</button>
            <button class="icon-btn" data-ref="help" title="Como jogar" aria-label="Como jogar">?</button>
            <button class="icon-btn" data-ref="quit" title="Desistir" aria-label="Desistir">✕</button>
          </div>
        </div>
        <div class="hud-mid">
          <div data-ref="activecard"></div>
          <div class="right-col"><div class="log" data-ref="log"></div><div data-ref="inspect"></div></div>
        </div>
        <div class="hud-bottom" data-ref="bottom">
          <div class="hint" data-ref="hint"></div>
          <div class="actions" data-ref="actions"></div>
        </div>
      </div>
      <div class="tooltip" data-ref="tooltip" hidden></div>`;
    this.app.appendChild(el);
    this.battleEl = el;
    el.querySelectorAll<HTMLElement>('[data-ref]').forEach((n) => (this.el[n.dataset.ref!] = n));

    this.view = new BattleView(el.querySelector('.stage')!, el.querySelector('.tag-layer')!);
    this.view.skinOf = (heroId, side) => (side === 'player' ? skinOf(this.mastery, heroId) : 'classic');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) this.view.speed = 2.5;
    this.view.onHover = (p) => this.onHover(p);
    this.view.onClick = (p, type) => this.onClick(p, type);
    this.view.onRightClick = () => this.cancel();

    this.el.threat.addEventListener('click', () => this.toggleThreat());
    this.el.auto.addEventListener('click', () => this.toggleAuto());
    this.el.rotl.addEventListener('click', () => this.view.rotate(-1));
    this.el.rotr.addEventListener('click', () => this.view.rotate(1));
    this.el.speed.addEventListener('click', () => {
      this.view.speed = this.view.speed >= 2 ? 1 : 2;
      this.el.speed.textContent = `${this.view.speed}×`;
    });
    this.el.help.addEventListener('click', () => this.showHelp());
    this.el.zoomin.addEventListener('click', () => this.view.zoomBy(1.25));
    this.el.zoomout.addEventListener('click', () => this.view.zoomBy(0.8));
    this.el.mute.addEventListener('click', () => {
      this.el.mute.textContent = audio.toggle() ? '🔇' : '🔊';
    });
    this.el.quit.addEventListener('click', () => this.quit());
  }

  // =============================================================== deployment

  /** Builds a quick-match spec: random map, one enemy hero per class. */
  private quickMatchSpec(map?: MapDef, enemyTeam?: string[]): MatchSpec {
    const m = map ?? MAPS[Math.floor(Math.random() * MAPS.length)];
    const board = buildBoard(m);
    // One hero per class, preferring heroes the player did not pick so names stay unambiguous.
    const pickClass = (c: HeroClass) => {
      const pool = shuffle(HEROES.filter((h) => h.heroClass === c));
      return (pool.find((h) => !this.team.includes(h.id)) ?? pool[0]).id;
    };
    const enemies = enemyTeam ?? shuffle((['warrior', 'ranger', 'mage', 'support'] as HeroClass[]).map(pickClass));
    const spec: MatchSpec = {
      kind: 'quick',
      label: `Partida rápida · ${this.difficulty === 'recruit' ? 'Recruta' : 'Veterano'}`,
      map: m,
      player: autoDeploy(board, this.team.map((heroId) => ({ heroId })), 'player'),
      enemy: autoDeploy(board, enemies.map((heroId) => ({ heroId, bonus: this.difficulty === 'recruit' ? RECRUIT_EASE : undefined })), 'enemy'),
      noise: DIFFICULTY_NOISE[this.difficulty],
      deploy: true,
      backLabel: '‹ Equipa',
      onBack: () => this.backToSelect(),
      onRematch: () => this.launch(this.quickMatchSpec()),
      countsForRecord: true,
    };
    spec.rerollMap = () => {
      const others = MAPS.filter((x) => x.id !== m.id);
      return this.quickMatchSpec(others[Math.floor(Math.random() * others.length)], enemies);
    };
    return spec;
  }

  private startDeploy() {
    this.launch(this.quickMatchSpec());
  }

  startTutorial() {
    this.launch({
      kind: 'tutorial',
      label: 'Treino',
      map: TUTORIAL_MAP,
      player: TUTORIAL_PLAYER,
      enemy: TUTORIAL_ENEMY,
      noise: 12,
      deploy: false,
      tutorial: TUTORIAL_STEPS,
      onFinish: (o) => {
        try {
          if (o.winner === 'player') localStorage.setItem('guild-tactics.tutorial', 'done');
        } catch {
          /* storage unavailable */
        }
        this.showResult(o, {
          title: o.winner === 'player' ? 'Treino concluído' : 'Quase!',
          sub: o.winner === 'player' ? 'Já sabes o essencial. Monta a tua equipa de quatro.' : 'Tenta outra vez: usa o santuário e cerca os inimigos.',
          primary: o.winner === 'player' ? { label: 'Partida rápida', fn: () => this.openQuickMatch() } : { label: 'Repetir treino', fn: () => this.startTutorial() },
          secondary: o.winner === 'player' ? { label: 'Salão da Guilda', fn: () => this.onHub() } : { label: 'Sair', fn: () => this.onHub() },
        });
      },
    });
  }

  /** Entry point for every mode. */
  launch(spec: MatchSpec) {
    this.spec = spec;
    this.map = spec.map;
    this.board = buildBoard(spec.map);
    // Guild traits apply to both sides, except in scripted modes where numbers are hand-tuned.
    const traits = spec.kind !== 'tutorial' && spec.kind !== 'puzzle' && !spec.prepared;
    const prep = (team: Deployment[]) => (traits ? applyTraits(team) : team).map((d) => ({ ...d, pos: { ...d.pos } }));
    // The player's own heroes bring their specialization, equipment and bonds (not in fixed-team modes).
    const loadout = traits && spec.kind !== 'daily';
    this.playerDeploy = prep(loadout ? applyLoadout(spec.player) : spec.player);
    this.enemyDeploy = prep(spec.enemy);
    this.lastMasteryHtml = '';
    this.lastGoldHtml = '';
    this.goldThisMatch = 0;
    this.tutorialStep = 0;
    this.deploySelected = null;
    this.battleEl.querySelectorAll('.modal-back, .tutorial').forEach((n) => n.remove());
    this.phase = 'deploy';
    this.logLines = [];
    this.el.log.innerHTML = '';
    this.mode = { kind: 'idle' };

    this.hideOtherScreens();
    this.battleEl.hidden = false;
    this.view.loadBoard(this.board);
    this.view.setActive(null);
    if (spec.deploy) this.refreshDeploy();
    else void this.startBattle();
  }

  /** Hides every non-battle screen (select, hub, mode screens). */
  hideOtherScreens() {
    this.app.querySelectorAll<HTMLElement>(':scope > .screen').forEach((n) => (n.hidden = true));
  }

  private deployState(): BattleState {
    return createBattle(this.board, this.playerDeploy, this.enemyDeploy).state;
  }

  private refreshDeploy() {
    const s = this.deployState();
    this.view.syncUnits(s);
    this.view.setActive(null);
    const hl = new Map<string, HighlightKind>();
    for (const y of deployRows(this.board, 'player'))
      for (let x = 0; x < this.board.width; x++) if (isWalkable(this.board, { x, y })) hl.set(posKey({ x, y }), 'deploy');
    if (this.deploySelected !== null) hl.set(posKey(this.playerDeploy[this.deploySelected].pos), 'select');
    this.view.setHighlights(hl);
    this.view.showPreview([]);

    this.el.round.textContent = 'Preparação';
    this.el.mapname.textContent = this.map.name;
    this.el.order.innerHTML = '';
    this.el.activecard.innerHTML = '';
    this.el.inspect.innerHTML = '';
    this.el.actions.hidden = false;
    this.el.hint.innerHTML =
      this.deploySelected === null
        ? 'Clica num dos teus heróis e depois numa casa azul para o reposicionar.'
        : `A mover <em>${esc(getHero(this.playerDeploy[this.deploySelected].heroId).name)}</em>: escolhe uma casa azul.`;
    const foes = this.enemyDeploy.map((d) => d.heroId).map((id) => `<img alt="${esc(getHero(id).name)}" title="${esc(getHero(id).name)}" src="${this.portrait(id, 'enemy')}" />`).join('');
    this.el.actions.innerHTML = `
      <div class="deploy-panel">
        <div>
          <div class="eyebrow">${esc(this.spec.label)} · ${esc(this.map.name)}</div>
          <h2>Posiciona a tua equipa</h2>
        </div>
        <p>Guerreiros à frente aguentam o embate; arqueiros e magos rendem mais atrás, de preferência numa colina. Inimigos visíveis do outro lado.</p>
        ${this.spec.kind !== 'tutorial' && this.spec.kind !== 'puzzle' ? `<div class="deploy-traits"><span>Os teus traços</span>${this.traitsHtml(this.playerDeploy.map((d) => d.heroId), true) || '<span class="muted">nenhum</span>'}<span>Adversário</span>${this.traitsHtml(this.enemyDeploy.map((d) => d.heroId), true) || '<span class="muted">nenhum</span>'}</div>` : ''}
        <div class="deploy-row">
          <div class="foes"><span>Adversários</span>${foes}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${this.spec.onBack ? `<button class="btn ghost" id="dep-back">${esc(this.spec.backLabel ?? '‹ Voltar')}</button>` : ''}
            ${this.spec.rerollMap ? '<button class="btn" id="dep-map">Outro mapa</button>' : ''}
            <button class="btn primary" id="dep-go">Combater</button>
          </div>
        </div>
      </div>`;
    this.el.actions.querySelector('#dep-back')?.addEventListener('click', () => this.spec.onBack?.());
    this.el.actions.querySelector('#dep-map')?.addEventListener('click', () => this.launch(this.spec.rerollMap!()));
    this.el.actions.querySelector('#dep-go')!.addEventListener('click', () => this.startBattle());
  }

  private deployClick(p: Pos) {
    const idx = this.playerDeploy.findIndex((d) => samePos(d.pos, p));
    const inZone = deployRows(this.board, 'player').includes(p.y) && isWalkable(this.board, p);
    if (this.deploySelected === null) {
      if (idx >= 0) this.deploySelected = idx;
    } else if (idx === this.deploySelected) {
      this.deploySelected = null;
    } else if (inZone) {
      const moving = this.playerDeploy[this.deploySelected];
      if (idx >= 0) this.playerDeploy[idx].pos = { ...moving.pos };
      moving.pos = { ...p };
      this.deploySelected = null;
    } else if (idx >= 0) {
      this.deploySelected = idx;
    }
    this.refreshDeploy();
  }

  hideBattle() {
    this.phase = 'deploy';
    this.battleEl.hidden = true;
  }

  private backToSelect() {
    this.phase = 'deploy';
    this.battleEl.hidden = true;
    this.hideOtherScreens();
    this.selectEl.hidden = false;
    this.renderSelect();
  }

  // =============================================================== battle flow

  private initialPlayer: Deployment[] = [];
  private initialEnemy: Deployment[] = [];

  private async startBattle() {
    this.initialPlayer = this.playerDeploy.map((d) => ({ ...d, pos: { ...d.pos } }));
    this.initialEnemy = this.enemyDeploy.map((d) => ({ ...d, pos: { ...d.pos } }));
    const { state, events } = createBattle(this.board, this.playerDeploy, this.enemyDeploy);
    this.state = state;
    this.phase = 'battle';
    this.startedAt = Date.now();
    this.mode = { kind: 'idle' };
    this.surrenderArmed = false;
    this.view.syncUnits(state);
    this.el.actions.innerHTML = '';
    this.logLines = [];
    this.el.log.innerHTML = '';
    this.commandLog = [];
    this.matchEvents = [];
    this.ultReady = new Set();
    this.exposures = [];
    this.suggestion = null;
    this.renderTutorial();
    this.busy = true;
    await this.play(events);
    this.busy = false;
    await this.advance();
  }

  private async play(events: BattleEvent[]) {
    for (const ev of events) {
      this.matchEvents.push(ev);
      this.onEventHud(ev);
      const sfx = this.sfxFor(ev);
      if (sfx) audio.play(sfx);
      this.tutorialCheck(ev);
      await this.view.animate(ev, this.state);
    }
    this.view.syncUnits(this.state);
    for (const u of this.state.units) if (u.side === 'player' && u.alive && u.energy >= RULES.energyMax) this.ultReady.add(u.id);
    this.renderHud();
  }

  /** Runs AI turns until it is the player's turn or the battle ends. */
  private async runReplay() {
    const cmds = this.spec.replay!;
    this.busy = true;
    this.renderHud();
    for (const cmd of cmds) {
      if (this.phase !== 'battle' || this.state.winner) break;
      await this.view.wait(cmd.type === 'move' ? 120 : 260);
      await this.applyAndPlay(cmd);
    }
    this.busy = false;
    if (this.phase !== 'battle') return;
    this.phase = 'over';
    this.view.setActive(null);
    this.spec.onFinish?.({ winner: this.state.winner, surrendered: false, state: this.state, seconds: 0 });
  }

  private async advance() {
    if (this.spec.replay) return this.runReplay();
    if (this.spec.winBeforeEnemyActs && puzzleFailed(this.state)) this.state.winner = 'enemy';
    // Enemy turns always run on the AI; player turns too when auto-battle is on.
    while (this.phase === 'battle' && !this.state.winner) {
      const side = activeUnit(this.state)?.side;
      if (side === 'enemy' && this.spec.winBeforeEnemyActs) break;
      if (side === 'enemy') await this.runAiTurn();
      else if (side === 'player' && this.autoBattle && this.spec.kind !== 'tutorial' && this.spec.kind !== 'puzzle') await this.runAiTurn(0);
      else break;
    }
    if (this.state.winner) return this.finish();
    if (this.phase !== 'battle') return;
    this.mode = { kind: 'idle' };
    this.touchArmed = null;
    this.renderHud();
    this.refreshBoard();
  }

  private async runAiTurn(noise = this.spec.noise) {
    this.busy = true;
    this.renderHud();
    this.refreshBoard();
    await this.view.wait(320);
    const unitId = this.state.active!.unitId;
    const commands = planTurn(cloneState(this.state), { noise, random: Math.random });
    for (const cmd of commands) {
      if (this.phase !== 'battle' || this.state.winner || this.state.active?.unitId !== unitId) break;
      if (cmd.type === 'ability') {
        const caster = getUnit(this.state, unitId);
        const ability = findAbility(caster.heroId, cmd.abilityId);
        const hl = new Map<string, HighlightKind>();
        for (const p of areaOf(this.state, caster, ability, cmd.target)) hl.set(posKey(p), ability.affects === 'allies' ? 'heal' : 'attack');
        this.view.setHighlights(hl);
        this.el.hint.innerHTML = `${esc(getHero(caster.heroId).name)} usa <em>${esc(ability.name)}</em>`;
        await this.view.wait(480);
      }
      await this.applyAndPlay(cmd);
      this.view.setHighlights(new Map());
    }
    this.busy = false;
  }

  private async applyAndPlay(cmd: Command) {
    this.suggestion = null;
    let events: BattleEvent[];
    try {
      events = applyCommand(this.state, cmd);
      this.commandLog.push(cmd);
    } catch (err) {
      this.toast((err as Error).message);
      return;
    }
    await this.play(events);
  }

  /** After a player hero ends its turn: how many enemies can reach it next turn? */
  private recordExposure(unitId: string) {
    const u = getUnit(this.state, unitId);
    if (!u.alive || u.side !== 'player') return;
    const key = posKey(u.pos);
    const count = aliveUnits(this.state, 'enemy').filter((e) => threatTiles(this.state, e.id).some((p) => posKey(p) === key)).length;
    const fragile = getHero(u.heroId).heroClass !== 'warrior';
    if (count >= (fragile ? 2 : 3)) this.exposures.push({ unitId, round: this.state.round, count });
  }

  private async exec(cmd: Command) {
    if (this.busy) return;
    const actor = this.state.active?.unitId;
    this.busy = true;
    this.view.setHighlights(new Map());
    this.view.showPreview([]);
    this.view.setCursor(null);
    await this.applyAndPlay(cmd);
    if (actor && this.state.active?.unitId !== actor) this.recordExposure(actor);
    this.busy = false;
    this.mode = { kind: 'idle' };
    await this.advance();
  }

  private isPlayerTurn() {
    return this.phase === 'battle' && !this.busy && !this.state.winner && activeUnit(this.state)?.side === 'player';
  }

  // =============================================================== input

  private onKey(e: KeyboardEvent) {
    if (this.battleEl.hidden) return;
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if (k === 'q') this.view.rotate(-1);
    else if (k === 'e') this.view.rotate(1);
    else if (k === 'escape') this.cancel();
    else if (k === 't') this.toggleThreat();
    else if (k === 'a') this.toggleAuto();
    else if (this.phase === 'battle' && this.isPlayerTurn()) {
      const n = Number(e.key);
      if (n >= 1 && n <= 6) {
        const unit = activeUnit(this.state)!;
        const ability = heroAbilities(getHero(unit.heroId))[n - 1];
        if (ability) this.selectAbility(ability.id);
      } else if (k === ' ' || k === 'enter') {
        e.preventDefault();
        this.exec({ type: 'endTurn' });
      } else if (k === 'z' || k === 'backspace') this.undo();
      else if (k === 's') this.suggest();
    }
  }

  private toggleAuto() {
    if (this.spec?.kind === 'tutorial' || this.spec?.kind === 'puzzle') return this.toast('Sem combate automático no treino e nos puzzles.');
    this.autoBattle = !this.autoBattle;
    this.el.auto.setAttribute('aria-pressed', String(this.autoBattle));
    // If it is our turn and nothing is animating, hand it to the AI right away.
    if (this.autoBattle && this.isPlayerTurn()) {
      this.mode = { kind: 'idle' };
      void this.advance();
    }
  }

  private toggleThreat() {
    this.showThreat = !this.showThreat;
    this.el.threat.setAttribute('aria-pressed', String(this.showThreat));
    this.refreshBoard();
    this.tutorialCheck();
  }

  private cancel() {
    if (this.phase === 'deploy') {
      this.deploySelected = null;
      this.refreshDeploy();
      return;
    }
    if (!this.isPlayerTurn()) return;
    if (this.mode.kind === 'target') {
      this.mode = { kind: 'idle' };
      this.touchArmed = null;
      this.renderHud();
      this.refreshBoard();
    } else this.undo();
  }

  private undo() {
    if (this.isPlayerTurn() && this.state.active?.canUndo) {
      const events = applyCommand(this.state, { type: 'undoMove' });
      this.commandLog.push({ type: 'undoMove' });
      for (const ev of events) void this.view.animate(ev, this.state);
      this.renderHud();
      this.refreshBoard();
    }
  }

  private selectAbility(abilityId: string) {
    if (!this.isPlayerTurn()) return;
    const unit = activeUnit(this.state)!;
    if (!canUseAbility(this.state, unit.id, abilityId).ok) return;
    if (this.mode.kind === 'target' && this.mode.abilityId === abilityId) {
      // Second press confirms when there is exactly one possible target (self abilities).
      const targets = validTargets(this.state, unit.id, abilityId);
      if (targets.length === 1) return this.useAbility(abilityId, targets[0]);
      this.mode = { kind: 'idle' };
    } else {
      this.mode = { kind: 'target', abilityId };
      const ability = findAbility(unit.heroId, abilityId);
      if (ability.target === 'self') this.hover = { ...unit.pos };
    }
    this.touchArmed = null;
    this.renderHud();
    this.refreshBoard();
  }

  private async useAbility(abilityId: string, target: Pos) {
    const unit = activeUnit(this.state)!;
    const ability = findAbility(unit.heroId, abilityId);
    if (ability.quick) {
      // Quick abilities keep the turn going: play them without handing over to the AI.
      this.busy = true;
      this.view.setHighlights(new Map());
      this.view.showPreview([]);
      await this.applyAndPlay({ type: 'ability', abilityId, target });
      this.busy = false;
      this.mode = { kind: 'idle' };
      if (this.state.winner) return this.finish();
      this.renderHud();
      this.refreshBoard();
      return;
    }
    await this.exec({ type: 'ability', abilityId, target });
  }

  private onHover(p: Pos | null) {
    this.hover = p;
    if (this.phase === 'deploy') {
      this.view.setCursor(p);
      this.renderInspect(p);
      return;
    }
    if (this.phase !== 'battle') return;
    this.renderInspect(p);
    this.refreshBoard();
  }

  private onClick(p: Pos, pointerType: string) {
    if (this.phase === 'deploy') return this.deployClick(p);
    if (!this.isPlayerTurn()) {
      this.renderInspect(p);
      return;
    }
    const touch = pointerType === 'touch' || pointerType === 'pen';
    const unit = activeUnit(this.state)!;
    const key = posKey(p);

    // Touch has no hover: the first tap previews, the second confirms.
    const needsArm = (tag: string) => {
      if (!touch || this.touchArmed === tag) return false;
      this.touchArmed = tag;
      this.hover = p;
      this.renderInspect(p);
      this.refreshBoard();
      return true;
    };

    if (this.mode.kind === 'target') {
      const ability = findAbility(unit.heroId, this.mode.abilityId);
      if (isValidTarget(this.state, unit, ability, p)) {
        if (needsArm(`${ability.id}@${key}`)) return;
        void this.useAbility(ability.id, p);
      } else {
        this.mode = { kind: 'idle' };
        this.touchArmed = null;
        this.renderHud();
        this.refreshBoard();
      }
      return;
    }

    const a = this.state.active!;
    if (a.canMove && !a.moved && !samePos(p, unit.pos) && reachableTiles(this.state, unit.id).has(key)) {
      if (needsArm(`move@${key}`)) return;
      void this.exec({ type: 'move', to: p }).then(() => undefined);
      return;
    }
    const target = unitAt(this.state, p);
    const attack = heroAbilities(getHero(unit.heroId))[0];
    if (target && target.side !== unit.side && canUseAbility(this.state, unit.id, 'attack').ok && isValidTarget(this.state, unit, attack, p)) {
      if (needsArm(`attack@${key}`)) return;
      void this.useAbility('attack', p);
      return;
    }
    this.hover = p;
    this.renderInspect(p);
  }

  // =============================================================== board overlays

  private refreshBoard() {
    if (this.phase !== 'battle') return;
    const hl = new Map<string, HighlightKind>();
    const s = this.state;
    const unit = activeUnit(s);
    let preview: ReturnType<typeof previewAbility> = [];

    if (unit && unit.side === 'player' && !this.busy) {
      const a = s.active!;
      if (this.mode.kind === 'idle') {
        // Danger first; everything else paints over it.
        const danger = this.showThreat ? sideThreat(s, unit.side) : new Set<string>();
        const hovered = this.hover ? unitAt(s, this.hover) : undefined;
        if (hovered && hovered.side !== unit.side) for (const p of threatTiles(s, hovered.id)) danger.add(posKey(p));
        for (const k of danger) hl.set(k, 'threat');
        if (a.canMove && !a.moved) {
          const reach = reachableTiles(s, unit.id);
          for (const r of reach.values()) {
            if (samePos(r.pos, unit.pos)) continue;
            const k = posKey(r.pos);
            hl.set(k, danger.has(k) ? 'moveDanger' : 'move');
          }
          const hoverReach = this.hover ? reach.get(posKey(this.hover)) : undefined;
          if (hoverReach) for (const p of hoverReach.path.slice(0, -1)) hl.set(posKey(p), 'path');
        }
        if (canUseAbility(s, unit.id, 'attack').ok) {
          for (const p of validTargets(s, unit.id, 'attack')) hl.set(posKey(p), 'attack');
          if (this.hover && hl.get(posKey(this.hover)) === 'attack') preview = previewAbility(s, unit.id, 'attack', this.hover);
        }
        hl.set(posKey(unit.pos), 'select');
      } else {
        const ability = findAbility(unit.heroId, this.mode.abilityId);
        const friendly = ability.affects === 'allies';
        for (const p of rangeTiles(s, unit.id, ability.id)) hl.set(posKey(p), 'range');
        for (const p of validTargets(s, unit.id, ability.id)) hl.set(posKey(p), friendly ? 'heal' : 'attack');
        if (this.hover && isValidTarget(s, unit, ability, this.hover)) {
          for (const p of areaOf(s, unit, ability, this.hover)) hl.set(posKey(p), 'area');
          preview = previewAbility(s, unit.id, ability.id, this.hover);
        }
      }
    }
    if (this.suggestion && this.mode.kind === 'idle' && !this.busy) for (const [k, v] of this.suggestion) hl.set(k, v);
    this.view.setHighlights(hl);
    this.view.showPreview(preview);
    this.view.setCursor(this.hover && !this.busy ? this.hover : null, this.mode.kind === 'target' ? 0xffd166 : 0xffffff);
  }

  // =============================================================== HUD

  private onEventHud(ev: BattleEvent) {
    const s = this.state;
    const name = (id: string) => getHero(getUnit(s, id).heroId).name;
    const sideOf = (id: string) => getUnit(s, id).side;
    switch (ev.type) {
      case 'roundStart':
        this.banner(`Ronda ${ev.round}`, ev.round === 1 ? 'Combate!' : '', '');
        this.el.round.textContent = `Ronda ${ev.round}`;
        break;
      case 'turnStart':
        this.renderOrder(ev.unitId);
        break;
      case 'abilityUsed': {
        const u = getUnit(s, ev.unitId);
        const ability = findAbility(u.heroId, ev.abilityId);
        if (ability.ultimate) this.banner(ability.name, `Supremo de ${name(ev.unitId)}`, u.side);
        if (ability.id === 'defend') this.log(`${name(ev.unitId)} defende-se`, u.side);
        else this.log(`${name(ev.unitId)} · ${ability.name}`, u.side);
        break;
      }
      case 'damage':
        if (ev.tags.includes('burn')) this.log(`${name(ev.unitId)} arde −${ev.amount}`, sideOf(ev.sourceId));
        else this.appendLog(` · ${name(ev.unitId)} −${ev.amount}`);
        break;
      case 'heal':
        this.appendLog(` · ${name(ev.unitId)} +${ev.amount}`);
        break;
      case 'death':
        this.log(`${name(ev.unitId)} caiu em combate`, sideOf(ev.unitId) === 'player' ? 'enemy' : 'player');
        break;
      case 'skipTurn':
        this.log(`${name(ev.unitId)} está atordoado`, sideOf(ev.unitId));
        break;
      default:
        break;
    }
  }

  private log(text: string, side: Side) {
    this.logLines.push({ text, side });
    this.logLines = this.logLines.slice(-6);
    this.renderLog();
  }

  private appendLog(text: string) {
    const last = this.logLines[this.logLines.length - 1];
    if (last) last.text += text;
    this.renderLog();
  }

  private renderLog() {
    this.el.log.innerHTML = this.logLines.map((l) => `<div class="${l.side === 'player' ? 'p' : 'e'}">${esc(l.text)}</div>`).join('');
  }

  private banner(text: string, small: string, cls: string) {
    const b = document.createElement('div');
    b.className = `banner ${cls}`;
    b.innerHTML = `${small ? `<small>${esc(small)}</small>` : ''}${esc(text)}`;
    this.battleEl.appendChild(b);
    setTimeout(() => b.remove(), 1300);
  }

  private toast(msg: string) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    this.battleEl.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  private renderHud() {
    if (this.phase !== 'battle') return;
    const s = this.state;
    this.el.round.textContent = `Ronda ${s.round}`;
    this.el.mapname.textContent = this.map.name;
    this.renderOrder(s.active?.unitId ?? null);
    const unit = activeUnit(s);
    this.el.activecard.innerHTML = unit ? this.unitCard(unit) : '';
    this.renderActions();
    this.renderHint();
  }

  private renderOrder(currentId: string | null) {
    const s = this.state;
    if (!s) return;
    const chip = (id: string, cls: string) => {
      const u = getUnit(s, id);
      if (!u.alive) return '';
      const h = getHero(u.heroId);
      return `<div class="order-chip ${u.side} ${cls}" title="${esc(h.name)} · VEL ${u.stats.spd}"><img alt="${esc(h.name)}" src="${this.portrait(u.heroId, u.side)}" /></div>`;
    };
    const now = s.queue.map((id, i) => chip(id, i === 0 && id === currentId ? 'current' : '')).join('');
    const next = cloneState(s);
    next.round += 1;
    const upcoming = roundOrder(next)
      .map((id) => chip(id, 'next-round'))
      .join('');
    this.el.order.innerHTML = `${now}<div class="order-sep">Ronda ${s.round + 1}</div>${upcoming}`;
  }

  private unitCard(u: Unit) {
    const h = getHero(u.heroId);
    const pct = (n: number) => `${Math.max(0, Math.min(100, (n / u.stats.maxHp) * 100))}%`;
    const color = u.side === 'player' ? 'var(--ally)' : 'var(--foe)';
    const statuses = u.statuses
      .map((st) => {
        const good = st.kind === 'empower' || st.kind === 'guard';
        const extra = st.kind === 'burn' ? ` ${st.amount}/turno` : st.kind === 'empower' ? ` +${st.amount}` : '';
        return `<span class="chip ${good ? 'good' : 'bad'}">${STATUS_GLYPH[st.kind]} ${STATUS_LABEL[st.kind]}${extra}</span>`;
      })
      .join('');
    const terrain = terrainAt(this.state?.board ?? this.board, u.pos);
    return `<div class="card ${u.side === 'player' ? 'ally-card' : 'foe-card'}">
      <div class="card-head">
        <img alt="" src="${this.portrait(u.heroId, u.side)}" />
        <div><div class="n">${esc(h.name)}</div><div class="t">${CLASS_GLYPH[h.heroClass]} ${CLASS_LABEL[h.heroClass]} · <span style="color:${ELEMENT_COLOR[u.element]}">${ELEMENT_LABEL[u.element]}</span></div></div>
      </div>
      <div class="bar-label"><span>Vida${u.shield ? ` · escudo ${u.shield}` : ''}</span><b class="num">${u.hp} / ${u.stats.maxHp}</b></div>
      <div class="bigbar"><i style="width:${pct(u.hp)};background:${color}"></i><i class="sh" style="width:${pct(u.shield)}"></i></div>
      <div class="enline"><span>Energia</span><div class="bigbar"><i style="width:${u.energy}%;background:var(--brass)"></i></div><b class="num" style="color:${u.energy >= RULES.energyMax ? 'var(--brass)' : 'var(--parchment)'}">${u.energy}</b></div>
      <div class="stats num"><span>ATQ<b>${u.stats.atk}</b></span><span>DEF<b>${u.stats.def}</b></span><span>MOV<b>${u.stats.mov}</b></span><span>VEL<b>${u.stats.spd}</b></span><span>ALC<b>${h.attack.min}–${h.attack.max}</b></span></div>
      ${statuses ? `<div class="statuses">${statuses}</div>` : ''}
      ${terrain !== 'plain' ? `<div class="t" style="color:var(--muted)">Em ${TERRAIN_LABEL[terrain].toLowerCase()}</div>` : ''}
    </div>`;
  }

  private renderInspect(p: Pos | null) {
    if (!p) {
      this.el.inspect.innerHTML = '';
      return;
    }
    const s = this.phase === 'deploy' ? this.deployState() : this.state;
    const u = unitAt(s, p);
    const active = s.active?.unitId;
    if (u && (this.phase === 'deploy' || u.id !== active)) {
      this.el.inspect.innerHTML = this.unitCard(u);
      return;
    }
    const t = terrainAt(s.board, p);
    if (t === 'plain' || u) {
      this.el.inspect.innerHTML = '';
      return;
    }
    this.el.inspect.innerHTML = `<div class="card terrain-card"><div class="n">${TERRAIN_LABEL[t]}</div><p>${TERRAIN_HINT[t]}</p></div>`;
  }

  private renderActions() {
    const s = this.state;
    const unit = activeUnit(s);
    const box = this.el.actions;
    if (!unit || unit.side !== 'player' || this.busy) {
      box.innerHTML = '';
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const abilities = heroAbilities(getHero(unit.heroId));
    const buttons = abilities
      .map((a, i) => {
        const check = canUseAbility(s, unit.id, a.id);
        const cd = unit.cooldowns[a.id] ?? 0;
        const pressed = this.mode.kind === 'target' && this.mode.abilityId === a.id;
        const meta = a.ultimate
          ? `<span class="qk">supremo · ${unit.energy}%</span>`
          : a.quick
            ? '<span class="qk">rápida</span>'
            : a.cooldown
              ? `recarga ${a.cooldown}`
              : a.id === 'attack'
                ? `alc. ${a.range.min}–${a.range.max}`
                : 'sem recarga';
        const ultCls = a.ultimate ? ` ult${unit.energy >= RULES.energyMax ? ' ready' : ''}` : '';
        return `<button class="act${ultCls}" data-ab="${a.id}" data-i="${i}" aria-pressed="${pressed}" ${check.ok ? '' : 'disabled'}>
          ${a.ultimate ? `<span class="energy" style="width:${unit.energy}%"></span>` : ''}
          <span class="k">${i + 1}</span><span class="an">${esc(a.name)}</span><span class="meta">${meta}</span>
          ${cd > 0 ? `<span class="cd num">${cd}</span>` : ''}
        </button>`;
      })
      .join('');
    const a = s.active!;
    box.innerHTML = `${buttons}<div class="divider"></div>
      <button class="act sys" data-sys="hint" title="O que a IA faria (S)"><span class="an">💡 Sugestão</span></button>
      <button class="act sys" data-sys="undo" ${a.canUndo ? '' : 'disabled'}><span class="an">↶ Desfazer</span></button>
      <button class="act sys end" data-sys="end"><span class="an">Terminar ␣</span></button>`;

    box.querySelectorAll<HTMLButtonElement>('[data-ab]').forEach((b) => {
      const ability = abilities[Number(b.dataset.i)];
      b.addEventListener('click', () => this.selectAbility(ability.id));
      const show = () => this.showTooltip(b, ability, unit);
      b.addEventListener('pointerenter', show);
      b.addEventListener('focus', show);
      b.addEventListener('pointerleave', () => (this.el.tooltip.hidden = true));
      b.addEventListener('blur', () => (this.el.tooltip.hidden = true));
    });
    // Disabled buttons don't fire pointer events in every browser: explain via the wrapper.
    box.querySelector('[data-sys="undo"]')!.addEventListener('click', () => this.undo());
    box.querySelector('[data-sys="hint"]')!.addEventListener('click', () => this.suggest());
    box.querySelector('[data-sys="end"]')!.addEventListener('click', () => this.exec({ type: 'endTurn' }));
  }

  private showTooltip(btn: HTMLElement, ability: Ability, unit: Unit) {
    const t = this.el.tooltip;
    const check = canUseAbility(this.state, unit.id, ability.id);
    const range = ability.target === 'self' ? 'Em si próprio' : `Alcance ${ability.range.min}–${ability.range.max}${ability.straight ? ' em linha reta' : ''}`;
    t.innerHTML = `<h5>${esc(ability.name)}${ability.quick ? ' <span class="chip" style="color:var(--brass)">rápida</span>' : ''}</h5>
      <div>${esc(ability.description)}</div>
      <div class="tmeta">${range} · ${ability.cooldown ? `recarga ${ability.cooldown} turnos` : 'sem recarga'}</div>
      ${check.ok ? '' : `<div class="why">${esc(check.reason)}</div>`}`;
    t.hidden = false;
    const r = btn.getBoundingClientRect();
    const host = this.battleEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(host.width - 268, r.left - host.left + r.width / 2 - 130));
    t.style.left = `${left}px`;
    t.style.top = `${r.top - host.top - t.offsetHeight - 8}px`;
  }

  private renderHint() {
    const s = this.state;
    const unit = activeUnit(s);
    const h = this.el.hint;
    if (!unit) {
      h.innerHTML = '';
      return;
    }
    const name = esc(getHero(unit.heroId).name);
    if (unit.side === 'enemy') {
      h.innerHTML = `Vez do adversário: <em>${name}</em>`;
      return;
    }
    if (this.busy) {
      h.innerHTML = '';
      return;
    }
    const a = s.active!;
    if (this.mode.kind === 'target') {
      const ability = findAbility(unit.heroId, this.mode.abilityId);
      const confirm = ability.target === 'self' ? 'Clica no herói ou carrega outra vez no botão para confirmar.' : 'Clica num alvo destacado.';
      h.innerHTML = `<em>${esc(ability.name)}</em> — ${esc(ability.description)} ${confirm} <span style="color:var(--muted)">Esc cancela.</span>`;
      return;
    }
    if (!a.canMove && !a.moved) {
      h.innerHTML = `<em>${name}</em> está preso e não se pode mover. Escolhe uma ação.`;
    } else if (!a.moved) {
      h.innerHTML = `Vez de <em>${name}</em>. Clica numa casa azul para mover ou num inimigo a vermelho para atacar. <span style="color:var(--muted)">T mostra o perigo.</span>`;
    } else {
      h.innerHTML = `<em>${name}</em> moveu-se. Escolhe uma ação${a.canUndo ? ' ou <span style="color:var(--muted)">Esc para desfazer</span>' : ''}.`;
    }
  }

  // =============================================================== end of match

  private quit() {
    if (this.spec?.kind === 'replay') {
      this.phase = 'over';
      return this.onHub();
    }
    if (this.phase === 'deploy') return this.spec.onBack ? this.spec.onBack() : this.backToSelect();
    if (this.phase !== 'battle') return;
    if (!this.surrenderArmed) {
      this.surrenderArmed = true;
      this.el.quit.textContent = 'Sair?';
      this.el.quit.style.width = '64px';
      this.toast('Clica outra vez para desistir desta partida.');
      setTimeout(() => {
        this.surrenderArmed = false;
        this.el.quit.textContent = '✕';
        this.el.quit.style.width = '';
      }, 3000);
      return;
    }
    this.surrenderArmed = false;
    this.el.quit.textContent = '✕';
    this.el.quit.style.width = '';
    this.state.winner = 'enemy';
    if (this.spec.kind === 'tutorial') {
      this.phase = 'over';
      this.battleEl.querySelector('.tutorial')?.remove();
      return this.onHub();
    }
    void this.finish(true);
  }

  private async finish(surrendered = false) {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.busy = false;
    this.view.setHighlights(new Map());
    this.view.showPreview([]);
    this.view.setCursor(null);
    this.view.setActive(null);
    this.el.actions.innerHTML = '';
    this.el.actions.hidden = true;
    this.el.hint.innerHTML = '';
    this.battleEl.querySelector('.tutorial')?.remove();
    const s = this.state;
    const won = s.winner === 'player';
    const draw = s.winner === 'draw';
    if (this.spec.countsForRecord) {
      if (won) {
        this.record.wins += 1;
        this.record.streak += 1;
      } else if (!draw) {
        this.record.losses += 1;
        this.record.streak = 0;
      }
      saveRecord(this.record);
    }
    audio.play(won ? 'victory' : 'defeat');
    if (won && !surrendered && this.spec.kind !== 'tutorial' && this.spec.kind !== 'puzzle') {
      const p = loadRaw<{ wins: number }>('progress') ?? { wins: 0 };
      save('progress', { ...p, wins: p.wins + 1 });
    }
    if (!surrendered && this.spec.kind !== 'tutorial' && this.spec.kind !== 'puzzle') {
      this.lastMasteryHtml = masteryHtml(awardMastery(s, masteryMultiplier(loadFortress()))) + awardBonds(s);
      this.refreshMastery();
    }
    if (!surrendered && this.spec.kind === 'quick') {
      this.awardGold(won ? GOLD.matchWin : GOLD.matchLoss, won ? 'vitória' : 'participação');
      if (won && Math.random() < 0.5) this.awardLoot(0);
    }
    if (!surrendered) {
      this.banner(won ? 'Vitória' : draw ? 'Empate' : 'Derrota', '', won ? 'player' : 'enemy');
      await this.view.wait(1100);
    }
    const outcome: MatchOutcome = { winner: s.winner, surrendered, state: s, seconds: Math.round((Date.now() - this.startedAt) / 1000) };
    if (this.spec.kind !== 'tutorial' && this.spec.kind !== 'puzzle' && !surrendered) this.saveReplay(s);
    if (this.spec.onFinish) this.spec.onFinish(outcome);
    else
      this.showResult(outcome, {
        primary: { label: 'Outra partida', fn: () => this.spec.onRematch?.() },
        secondary: { label: 'Mudar equipa', fn: () => this.backToSelect() },
      });
  }

  /** Result modal shared by every mode; modes supply their own buttons and extra content. */
  showResult(
    o: MatchOutcome,
    opts: {
      title?: string;
      sub?: string;
      extraHtml?: string;
      primary: { label: string; fn: () => void };
      secondary?: { label: string; fn: () => void };
    },
  ) {
    const s = o.state;
    const won = o.winner === 'player';
    const draw = o.winner === 'draw';
    const secs = o.seconds;
    const mine = s.units.filter((u) => u.side === 'player');
    const score = (u: Unit) => u.combat.damageDealt + u.combat.healingDone * 0.8 + u.combat.kills * 10;
    const mvp = [...mine].sort((a, b) => score(b) - score(a))[0];
    const timeout = s.round >= RULES.maxRounds && s.units.some((u) => u.side === 'enemy' && u.alive) && s.units.some((u) => u.side === 'player' && u.alive);
    const rows = mine
      .map(
        (u) => `<tr class="${u.alive ? '' : 'dead'}">
        <td><div class="who"><img alt="" src="${this.portrait(u.heroId)}" /><div>${esc(getHero(u.heroId).name)}${u.id === mvp.id ? ' <span class="mvp">MVP</span>' : ''}</div></div></td>
        <td>${u.combat.damageDealt}</td><td>${u.combat.healingDone}</td><td>${u.combat.damageTaken}</td><td>${u.combat.kills}</td>
      </tr>`,
      )
      .join('');
    const enemiesLeft = s.units.filter((u) => u.side === 'enemy' && u.alive).length;
    const alliesLeft = mine.filter((u) => u.alive).length;
    const sub =
      opts.sub ??
      (o.surrendered
        ? 'Desististe da partida.'
        : timeout
          ? `Limite de ${RULES.maxRounds} rondas atingido: decidido pela vida restante.`
          : won
            ? `${alliesLeft} de ${mine.length} heróis de pé.`
            : `Ficaram ${enemiesLeft} inimigo${enemiesLeft === 1 ? '' : 's'} de pé.`);

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Resultado">
      <div>
        <div class="eyebrow">${esc(this.spec.label)} · ${esc(this.map.name)}</div>
        <h2 class="result-title ${won ? 'win' : 'loss'}">${esc(opts.title ?? (won ? 'Vitória' : draw ? 'Empate' : 'Derrota'))}</h2>
        <p class="result-sub">${esc(sub)}</p>
      </div>
      <div class="kpis">
        <div class="kpi"><b class="num">${s.round}</b><span>rondas</span></div>
        <div class="kpi"><b class="num">${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}</b><span>duração</span></div>
        <div class="kpi"><b class="num">${this.record.wins}–${this.record.losses}</b><span>registo (partidas rápidas)</span></div>
      </div>
      ${opts.extraHtml ?? ''}
      ${this.insightsHtml(o)}
      ${this.lastGoldHtml}
      ${this.lastMasteryHtml}
      <div class="table-wrap"><table class="stats-table">
        <thead><tr><th>Herói</th><th>Dano</th><th>Cura</th><th>Sofrido</th><th>Abates</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="modal-actions">
        ${opts.secondary ? `<button class="btn ghost" id="res-second">${esc(opts.secondary.label)}</button>` : ''}
        <button class="btn primary" id="res-first">${esc(opts.primary.label)}</button>
      </div>
    </div>`;
    this.battleEl.appendChild(back);
    back.querySelector<HTMLButtonElement>('#res-first')!.focus();
    back.querySelector('#res-first')!.addEventListener('click', () => {
      back.remove();
      opts.primary.fn();
    });
    back.querySelector('#res-second')?.addEventListener('click', () => {
      back.remove();
      opts.secondary!.fn();
    });
  }

  // =============================================================== tutorial

  private renderTutorial() {
    this.battleEl.querySelector('.tutorial')?.remove();
    const steps = this.spec.tutorial;
    if (!steps || this.tutorialStep >= steps.length) return;
    const step = steps[this.tutorialStep];
    const el = document.createElement('div');
    el.className = 'tutorial';
    const eyebrow = this.spec.kind === 'puzzle' ? 'Objetivo' : `Treino · passo ${this.tutorialStep + 1} de ${steps.length}`;
    el.innerHTML = `<div class="eyebrow">${eyebrow}</div>
      <p>${step.text}</p>
      ${step.button ? `<button class="btn primary" id="tut-next">${esc(step.button)}</button>` : ''}`;
    this.battleEl.appendChild(el);
    el.querySelector('#tut-next')?.addEventListener('click', () => this.advanceTutorial());
  }

  private advanceTutorial() {
    this.tutorialStep += 1;
    audio.play('click');
    this.renderTutorial();
  }

  private tutorialCheck(event?: BattleEvent) {
    const steps = this.spec?.tutorial;
    if (!steps || this.phase !== 'battle' || this.tutorialStep >= steps.length) return;
    const step = steps[this.tutorialStep];
    if (step.until?.({ event, state: this.state, threatOn: this.showThreat })) this.advanceTutorial();
  }

  private sfxFor(ev: BattleEvent): Sfx | null {
    switch (ev.type) {
      case 'move':
        return 'step';
      case 'damage':
        return ev.amount >= 12 ? 'bigHit' : 'hit';
      case 'heal':
        return ev.amount > 0 ? 'heal' : null;
      case 'shrine':
        return 'heal';
      case 'shield':
        return 'shield';
      case 'status':
        return ev.status === 'empower' || ev.status === 'guard' ? 'shield' : 'status';
      case 'death':
        return 'death';
      case 'abilityUsed': {
        const u = getUnit(this.state, ev.unitId);
        return findAbility(u.heroId, ev.abilityId).ultimate ? 'ult' : null;
      }
      case 'turnStart':
        return getUnit(this.state, ev.unitId).side === 'player' ? 'turn' : null;
      default:
        return null;
    }
  }

  private showHelp() {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Como jogar">${this.howToHtml(true)}
      <div class="modal-actions"><button class="btn primary" id="help-close">Voltar ao combate</button></div></div>`;
    this.battleEl.appendChild(back);
    const close = () => back.remove();
    back.querySelector('#help-close')!.addEventListener('click', close);
    back.addEventListener('click', (e) => {
      if (e.target === back) close();
    });
  }
}

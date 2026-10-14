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
  unitAt,
  validTargets,
  type Deployment,
} from '../domain/battle';
import { DEPLOY_ROWS, MAPS, TERRAIN_HINT, TERRAIN_LABEL, buildBoard, isWalkable, posKey, samePos, terrainAt } from '../domain/board';
import { CLASS_GLYPH, CLASS_LABEL, HEROES, findAbility, getHero, heroAbilities } from '../domain/heroes';
import type { Ability, BattleEvent, BattleState, Board, Command, HeroClass, Pos, Side, Unit } from '../domain/types';
import type { MapDef } from '../domain/board';
import { STATUS_GLYPH, STATUS_LABEL, BattleView, type HighlightKind } from '../render/view';
import { renderPortraits } from '../render/models';

type Difficulty = 'recruit' | 'veteran';
type Mode = { kind: 'idle' } | { kind: 'target'; abilityId: string };

const DIFFICULTY_NOISE: Record<Difficulty, number> = { recruit: 9, veteran: 0.8 };
const STORAGE_KEY = 'guild-tactics.v1';

const TIPS = [
  'Cada aliado adjacente ao alvo dá +15% de dano: cerca os inimigos.',
  'A floresta reduz o dano recebido em 25%. Tiro Certeiro ignora essa cobertura.',
  'Atacar de uma colina dá +20% de dano e +1 de alcance aos ataques à distância.',
  'Ações rápidas (Fúria, Salto, Bênção) não terminam o turno: usa-as antes de mover ou atacar.',
  'Empurrar contra rochas, água ou outra unidade causa 3 de dano de colisão.',
  'A ordem de turnos está no topo. Atordoar quem ainda não jogou nesta ronda vale ouro.',
  'Inspirar dá um turno extra a um aliado: combina com Execução ou Meteoro.',
  'Troca Arcana também funciona em inimigos: puxa um alvo frágil para o meio da tua equipa.',
];

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

export class Game {
  private portraits = new Map<string, string>();
  private team: string[] = [];
  private difficulty: Difficulty = 'recruit';
  private record = loadRecord();

  private selectEl!: HTMLDivElement;
  private battleEl!: HTMLDivElement;
  private view!: BattleView;
  private el: Record<string, HTMLElement> = {};

  // battle
  private phase: 'deploy' | 'battle' | 'over' = 'deploy';
  private map!: MapDef;
  private board!: Board;
  private enemyTeam: string[] = [];
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

  constructor(private app: HTMLElement) {}

  start() {
    try {
      this.portraits = renderPortraits(HEROES.map((h) => h.id));
    } catch {
      /* portraits are optional */
    }
    this.buildBattleDom();
    this.buildSelect();
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  private portrait(heroId: string, side: Side = 'player') {
    return this.portraits.get(`${heroId}:${side}`) ?? '';
  }

  // =============================================================== team select

  private buildSelect() {
    this.selectEl?.remove();
    const el = document.createElement('div');
    el.className = 'screen';
    this.selectEl = el;
    this.app.appendChild(el);
    this.battleEl.hidden = true;
    this.renderSelect();
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
      const abil = h.abilities
        .map((a) => `<div><b>${esc(a.name)}</b>${a.quick ? '<span class="q">rápida</span>' : ''} — ${esc(a.description)}</div>`)
        .join('');
      return `<button class="hero-card" data-hero="${h.id}" aria-pressed="${idx >= 0}">
        ${idx >= 0 ? `<span class="pick-badge">${idx + 1}</span>` : ''}
        <img class="portrait" alt="" src="${this.portrait(h.id)}" />
        <div>
          <span class="chip ${h.heroClass}">${CLASS_GLYPH[h.heroClass]} ${CLASS_LABEL[h.heroClass]}</span>
          <h3>${esc(h.name)}</h3>
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

    this.selectEl.innerHTML = `
      <div class="select-wrap">
        <div class="title-row">
          <div>
            <div class="eyebrow">Combate tático por turnos · 4 contra 4</div>
            <h1 class="logo">Guild <span>Tactics</span></h1>
            <p class="tagline">Forma uma equipa de quatro heróis, posiciona-a num tabuleiro 6×6 e vence pelo posicionamento, não pela sorte: todo o dano é previsível.</p>
          </div>
          <div class="record">
            <div><b class="num">${r.wins}</b> vitórias · <b class="num">${r.losses}</b> derrotas</div>
            ${r.streak > 1 ? `<div>Sequência de ${r.streak} vitórias</div>` : ''}
          </div>
        </div>
        <div class="squad-bar">
          ${slots}
          <div class="squad-actions">
            <button class="btn" id="btn-random">Aleatória</button>
            <button class="btn primary" id="btn-next" ${this.team.length === 4 ? '' : 'disabled'}>Posicionar ›</button>
          </div>
          <div class="squad-hint">
            <span>${comp}</span>
            <span style="margin-left:auto">Adversário:</span>
            <span class="seg" role="group" aria-label="Dificuldade">
              <button id="dif-recruit" aria-pressed="${this.difficulty === 'recruit'}">Recruta</button>
              <button id="dif-veteran" aria-pressed="${this.difficulty === 'veteran'}">Veterano</button>
            </span>
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
    this.selectEl.querySelector('#btn-next')!.addEventListener('click', () => this.startDeploy());
    this.selectEl.querySelector('#dif-recruit')!.addEventListener('click', () => {
      this.difficulty = 'recruit';
      this.renderSelect();
    });
    this.selectEl.querySelector('#dif-veteran')!.addEventListener('click', () => {
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

  private howToHtml(open: boolean) {
    return `<details class="howto" ${open ? 'open' : ''}>
      <summary>Como jogar</summary>
      <div class="howto-body">
        <div><h4>O turno</h4><p>Cada herói joga quando chega a sua vez (ordem no topo, por velocidade). No teu turno podes <b>mover</b> e depois fazer <b>uma ação</b>: atacar, usar uma habilidade ou defender. A ação termina o turno. Ações <em>rápidas</em> não terminam.</p></div>
        <div><h4>Vencer</h4><p>Derrota os quatro heróis inimigos. Ao fim de 12 rondas vence quem tiver mais vida (em %).</p></div>
        <div><h4>Terreno</h4><ul><li><b>Floresta</b>: −25% de dano recebido, custa 2 de movimento.</li><li><b>Colina</b>: +20% de dano e +1 de alcance à distância, custa 2.</li><li><b>Rocha</b> e <b>água</b>: intransponíveis.</li></ul></div>
        <div><h4>Sinergias</h4><ul><li><b>Cerco</b>: +15% de dano por cada aliado teu encostado ao alvo.</li><li>Recargas (número sobre o botão) obrigam a gerir habilidades.</li><li>Passa o rato sobre um alvo para ver o dano exato antes de agir.</li></ul></div>
        <div><h4>Controlos</h4><p><kbd>1</kbd>–<kbd>5</kbd> ações · <kbd>Espaço</kbd> terminar turno · <kbd>Esc</kbd> cancelar / desfazer movimento · <kbd>Q</kbd> <kbd>E</kbd> rodar câmara. No telemóvel: toca uma vez para pré-visualizar e outra para confirmar.</p></div>
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
            <button class="icon-btn" data-ref="rotl" title="Rodar câmara (Q)" aria-label="Rodar câmara para a esquerda">⟲</button>
            <button class="icon-btn" data-ref="rotr" title="Rodar câmara (E)" aria-label="Rodar câmara para a direita">⟳</button>
            <button class="icon-btn" data-ref="speed" title="Velocidade das animações">1×</button>
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
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) this.view.speed = 2.5;
    this.view.onHover = (p) => this.onHover(p);
    this.view.onClick = (p, type) => this.onClick(p, type);
    this.view.onRightClick = () => this.cancel();

    this.el.rotl.addEventListener('click', () => this.view.rotate(-1));
    this.el.rotr.addEventListener('click', () => this.view.rotate(1));
    this.el.speed.addEventListener('click', () => {
      this.view.speed = this.view.speed >= 2 ? 1 : 2;
      this.el.speed.textContent = `${this.view.speed}×`;
    });
    this.el.help.addEventListener('click', () => this.showHelp());
    this.el.quit.addEventListener('click', () => this.quit());
  }

  // =============================================================== deployment

  private startDeploy(keepMap = false) {
    if (!keepMap) this.map = MAPS[Math.floor(Math.random() * MAPS.length)];
    this.board = buildBoard(this.map);
    // One hero per class, preferring heroes the player did not pick so names stay unambiguous.
    const pickClass = (c: HeroClass) => {
      const pool = shuffle(HEROES.filter((h) => h.heroClass === c));
      return (pool.find((h) => !this.team.includes(h.id)) ?? pool[0]).id;
    };
    if (!keepMap) this.enemyTeam = shuffle((['warrior', 'ranger', 'mage', 'support'] as HeroClass[]).map(pickClass));
    this.playerDeploy = this.autoDeploy(this.team, 'player');
    this.enemyDeploy = this.autoDeploy(this.enemyTeam, 'enemy');
    this.deploySelected = null;
    this.phase = 'deploy';
    this.logLines = [];
    this.el.log.innerHTML = '';
    this.mode = { kind: 'idle' };

    this.selectEl.hidden = true;
    this.battleEl.hidden = false;
    this.view.loadBoard(this.board);
    this.view.setActive(null);
    this.refreshDeploy();
  }

  /** Front-liners forward, everyone else in the back row, spread across the width. */
  private autoDeploy(team: string[], side: Side): Deployment[] {
    const [a, b] = DEPLOY_ROWS[side];
    const front = side === 'player' ? Math.min(a, b) : Math.max(a, b);
    const back = side === 'player' ? Math.max(a, b) : Math.min(a, b);
    const taken = new Set<string>();
    const order = [2, 3, 1, 4, 0, 5];
    const spot = (row: number, other: number): Pos => {
      for (const r of [row, other])
        for (const x of order) {
          const p = { x, y: r };
          if (isWalkable(this.board, p) && !taken.has(posKey(p))) {
            taken.add(posKey(p));
            return p;
          }
        }
      throw new Error('No deploy spot');
    };
    return team.map((heroId) => {
      const isFront = getHero(heroId).heroClass === 'warrior';
      return { heroId, pos: spot(isFront ? front : back, isFront ? back : front) };
    });
  }

  private deployState(): BattleState {
    return createBattle(this.board, this.playerDeploy, this.enemyDeploy).state;
  }

  private refreshDeploy() {
    const s = this.deployState();
    this.view.syncUnits(s);
    this.view.setActive(null);
    const hl = new Map<string, HighlightKind>();
    for (const y of DEPLOY_ROWS.player)
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
    const foes = this.enemyTeam.map((id) => `<img alt="${esc(getHero(id).name)}" title="${esc(getHero(id).name)}" src="${this.portrait(id, 'enemy')}" />`).join('');
    this.el.actions.innerHTML = `
      <div class="deploy-panel">
        <div>
          <div class="eyebrow">${esc(this.map.name)}</div>
          <h2>Posiciona a tua equipa</h2>
        </div>
        <p>Guerreiros à frente aguentam o embate; arqueiros e magos rendem mais atrás, de preferência numa colina. Inimigos visíveis do outro lado.</p>
        <div class="deploy-row">
          <div class="foes"><span>Adversários</span>${foes}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn ghost" id="dep-back">‹ Equipa</button>
            <button class="btn" id="dep-map">Outro mapa</button>
            <button class="btn primary" id="dep-go">Combater</button>
          </div>
        </div>
      </div>`;
    this.el.actions.querySelector('#dep-back')!.addEventListener('click', () => this.backToSelect());
    this.el.actions.querySelector('#dep-map')!.addEventListener('click', () => {
      const others = MAPS.filter((m) => m.id !== this.map.id);
      this.map = others[Math.floor(Math.random() * others.length)];
      this.startDeploy(true);
    });
    this.el.actions.querySelector('#dep-go')!.addEventListener('click', () => this.startBattle());
  }

  private deployClick(p: Pos) {
    const idx = this.playerDeploy.findIndex((d) => samePos(d.pos, p));
    const inZone = DEPLOY_ROWS.player.includes(p.y) && isWalkable(this.board, p);
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

  private backToSelect() {
    this.phase = 'deploy';
    this.battleEl.hidden = true;
    this.selectEl.hidden = false;
    this.renderSelect();
  }

  // =============================================================== battle flow

  private async startBattle() {
    const { state, events } = createBattle(this.board, this.playerDeploy, this.enemyDeploy);
    this.state = state;
    this.phase = 'battle';
    this.startedAt = Date.now();
    this.mode = { kind: 'idle' };
    this.surrenderArmed = false;
    this.view.syncUnits(state);
    this.el.actions.innerHTML = '';
    this.busy = true;
    await this.play(events);
    this.busy = false;
    await this.advance();
  }

  private async play(events: BattleEvent[]) {
    for (const ev of events) {
      this.onEventHud(ev);
      await this.view.animate(ev, this.state);
    }
    this.view.syncUnits(this.state);
    this.renderHud();
  }

  /** Runs AI turns until it is the player's turn or the battle ends. */
  private async advance() {
    while (this.phase === 'battle' && !this.state.winner && activeUnit(this.state)?.side === 'enemy') {
      await this.runAiTurn();
    }
    if (this.state.winner) return this.finish();
    if (this.phase !== 'battle') return;
    this.mode = { kind: 'idle' };
    this.touchArmed = null;
    this.renderHud();
    this.refreshBoard();
  }

  private async runAiTurn() {
    this.busy = true;
    this.renderHud();
    this.refreshBoard();
    await this.view.wait(320);
    const unitId = this.state.active!.unitId;
    const commands = planTurn(cloneState(this.state), { noise: DIFFICULTY_NOISE[this.difficulty], random: Math.random });
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
    let events: BattleEvent[];
    try {
      events = applyCommand(this.state, cmd);
    } catch (err) {
      this.toast((err as Error).message);
      return;
    }
    await this.play(events);
  }

  private async exec(cmd: Command) {
    if (this.busy) return;
    this.busy = true;
    this.view.setHighlights(new Map());
    this.view.showPreview([]);
    this.view.setCursor(null);
    await this.applyAndPlay(cmd);
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
    else if (this.phase === 'battle' && this.isPlayerTurn()) {
      const n = Number(e.key);
      if (n >= 1 && n <= 5) {
        const unit = activeUnit(this.state)!;
        const ability = heroAbilities(getHero(unit.heroId))[n - 1];
        if (ability) this.selectAbility(ability.id);
      } else if (k === ' ' || k === 'enter') {
        e.preventDefault();
        this.exec({ type: 'endTurn' });
      } else if (k === 'z' || k === 'backspace') this.undo();
    }
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
        if (a.canMove && !a.moved) {
          for (const r of reachableTiles(s, unit.id).values()) if (!samePos(r.pos, unit.pos)) hl.set(posKey(r.pos), 'move');
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
      return `<div class="order-chip ${u.side} ${cls}" title="${esc(h.name)} · VEL ${h.stats.spd}"><img alt="${esc(h.name)}" src="${this.portrait(u.heroId, u.side)}" /></div>`;
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
    const pct = (n: number) => `${Math.max(0, Math.min(100, (n / h.stats.maxHp) * 100))}%`;
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
        <div><div class="n">${esc(h.name)}</div><div class="t">${CLASS_GLYPH[h.heroClass]} ${CLASS_LABEL[h.heroClass]} · ${esc(h.title)}</div></div>
      </div>
      <div class="bar-label"><span>Vida${u.shield ? ` · escudo ${u.shield}` : ''}</span><b class="num">${u.hp} / ${h.stats.maxHp}</b></div>
      <div class="bigbar"><i style="width:${pct(u.hp)};background:${color}"></i><i class="sh" style="width:${pct(u.shield)}"></i></div>
      <div class="stats num"><span>ATQ<b>${h.stats.atk}</b></span><span>DEF<b>${h.stats.def}</b></span><span>MOV<b>${h.stats.mov}</b></span><span>VEL<b>${h.stats.spd}</b></span><span>ALC<b>${h.attack.min}–${h.attack.max}</b></span></div>
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
        const meta = a.quick ? '<span class="qk">rápida</span>' : a.cooldown ? `recarga ${a.cooldown}` : a.id === 'attack' ? `alc. ${a.range.min}–${a.range.max}` : 'sem recarga';
        return `<button class="act" data-ab="${a.id}" data-i="${i}" aria-pressed="${pressed}" ${check.ok ? '' : 'disabled'}>
          <span class="k">${i + 1}</span><span class="an">${esc(a.name)}</span><span class="meta">${meta}</span>
          ${cd > 0 ? `<span class="cd num">${cd}</span>` : ''}
        </button>`;
      })
      .join('');
    const a = s.active!;
    box.innerHTML = `${buttons}<div class="divider"></div>
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
      h.innerHTML = `Vez de <em>${name}</em>. Clica numa casa azul para mover ou num inimigo a vermelho para atacar.`;
    } else {
      h.innerHTML = `<em>${name}</em> moveu-se. Escolhe uma ação${a.canUndo ? ' ou <span style="color:var(--muted)">Esc para desfazer</span>' : ''}.`;
    }
  }

  // =============================================================== end of match

  private quit() {
    if (this.phase === 'deploy') return this.backToSelect();
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
    const s = this.state;
    const won = s.winner === 'player';
    const draw = s.winner === 'draw';
    if (won) {
      this.record.wins += 1;
      this.record.streak += 1;
    } else if (!draw) {
      this.record.losses += 1;
      this.record.streak = 0;
    }
    saveRecord(this.record);
    if (!surrendered) {
      this.banner(won ? 'Vitória' : draw ? 'Empate' : 'Derrota', '', won ? 'player' : 'enemy');
      await this.view.wait(1100);
    }
    this.showResult(won, draw, surrendered);
  }

  private showResult(won: boolean, draw: boolean, surrendered: boolean) {
    const s = this.state;
    const secs = Math.round((Date.now() - this.startedAt) / 1000);
    const mine = s.units.filter((u) => u.side === 'player');
    const score = (u: Unit) => u.combat.damageDealt + u.combat.healingDone * 0.8 + u.combat.kills * 10;
    const mvp = [...mine].sort((a, b) => score(b) - score(a))[0];
    const timeout = s.round >= 12 && s.units.some((u) => u.side === 'enemy' && u.alive) && s.units.some((u) => u.side === 'player' && u.alive);
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
    const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
    const sub = surrendered
      ? 'Desististe da partida.'
      : timeout
        ? `Limite de 12 rondas atingido: decidido pela vida restante.`
        : won
          ? `${alliesLeft} de 4 heróis de pé.`
          : `Ficaram ${enemiesLeft} inimigo${enemiesLeft === 1 ? '' : 's'} de pé.`;

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Resultado">
      <div>
        <div class="eyebrow">${esc(this.map.name)} · ${this.difficulty === 'recruit' ? 'Recruta' : 'Veterano'}</div>
        <h2 class="result-title ${won ? 'win' : 'loss'}">${won ? 'Vitória' : draw ? 'Empate' : 'Derrota'}</h2>
        <p class="result-sub">${sub}</p>
      </div>
      <div class="kpis">
        <div class="kpi"><b class="num">${s.round}</b><span>rondas</span></div>
        <div class="kpi"><b class="num">${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}</b><span>duração</span></div>
        <div class="kpi"><b class="num">${this.record.wins}–${this.record.losses}</b><span>registo total</span></div>
      </div>
      <div class="table-wrap"><table class="stats-table">
        <thead><tr><th>Herói</th><th>Dano</th><th>Cura</th><th>Sofrido</th><th>Abates</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="feedback"><b>Dica:</b> ${esc(tip)}</div>
      <div class="modal-actions">
        <button class="btn ghost" id="res-team">Mudar equipa</button>
        <button class="btn primary" id="res-again">Outra partida</button>
      </div>
    </div>`;
    this.battleEl.appendChild(back);
    back.querySelector<HTMLButtonElement>('#res-again')!.focus();
    back.querySelector('#res-again')!.addEventListener('click', () => {
      back.remove();
      this.startDeploy();
    });
    back.querySelector('#res-team')!.addEventListener('click', () => {
      back.remove();
      this.backToSelect();
    });
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

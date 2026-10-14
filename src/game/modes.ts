import type { Deployment } from '../domain/battle';
import { buildBoard, MAPS } from '../domain/board';
import { dailyChallenge } from '../domain/daily';
import { autoDeploy } from '../domain/deploy';
import { aiDraftPick, available, draftPick, draftSide, newDraft, type DraftState } from '../domain/draft';
import {
  chooseReward,
  EXPEDITION_STAGES,
  enemyTeamForBattle,
  getRelic,
  heroMaxHp,
  playerTeamForBattle,
  recordBattle,
  startExpedition,
  totalBonus,
  type ExpeditionState,
} from '../domain/expedition';
import { CLASS_GLYPH, CLASS_LABEL, getHero } from '../domain/heroes';
import { PUZZLES, type Puzzle } from '../domain/puzzles';
import type { Stats } from '../domain/types';
import { audio } from '../ui/audio';
import type { Game, MatchOutcome } from './game';
import { load, loadRaw, save, type DailyRecord, type ExpeditionRecord, type PuzzleRecord } from './profile';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const STAT_LABEL: Record<keyof Stats, string> = { maxHp: 'PV', atk: 'ATQ', def: 'DEF', mov: 'MOV', spd: 'VEL' };
const bonusText = (b: Partial<Stats>) =>
  (Object.keys(b) as (keyof Stats)[])
    .filter((k) => b[k])
    .map((k) => `${b[k]! > 0 ? '+' : ''}${b[k]} ${STAT_LABEL[k]}`)
    .join(' · ');

/** Mode screens that sit around the battle screen: hub, expedition, daily, draft and puzzles. */
export class Modes {
  private el: HTMLDivElement;
  private draft: DraftState = newDraft();
  private abandonArmed = false;

  constructor(
    private app: HTMLElement,
    private game: Game,
    /** Extra hub cards (e.g. the collection), rendered after the mode cards. */
    private extraCards: () => string = () => '',
    private onExtraCard: (id: string) => void = () => {},
  ) {
    this.el = document.createElement('div');
    this.el.className = 'screen';
    this.app.appendChild(this.el);
  }

  private show(html: string) {
    this.game.hideBattle();
    this.game.hideOtherScreens();
    this.el.hidden = false;
    this.el.innerHTML = html;
    this.el.scrollTop = 0;
  }

  private on(sel: string, fn: () => void) {
    this.el.querySelectorAll<HTMLElement>(sel).forEach((n) => n.addEventListener('click', fn));
  }

  private faces(ids: string[], side: 'player' | 'enemy' = 'player') {
    return ids.map((id) => `<img class="face ${side}" alt="${esc(getHero(id).name)}" title="${esc(getHero(id).name)}" src="${this.game.portrait(id, side)}" />`).join('');
  }

  // =============================================================== hub

  showHub() {
    const tutorialDone = loadRaw<string>('tutorial') === 'done' || (() => {
      try {
        return localStorage.getItem('guild-tactics.tutorial') === 'done';
      } catch {
        return false;
      }
    })();
    const exp = loadRaw<ExpeditionState>('expedition');
    const expRec = load<ExpeditionRecord>('expedition-record', { runs: 0, wins: 0, bestStage: 0 });
    const daily = dailyChallenge();
    const dailyRec = load<DailyRecord>('daily', { results: {} });
    const today = dailyRec.results[daily.date];
    const puzzles = load<PuzzleRecord>('puzzles', { solved: [] });
    const r = this.game.recordSummary();

    const card = (id: string, eyebrow: string, title: string, body: string, status: string, cta: string, accent = false) => `
      <article class="mode-card${accent ? ' accent' : ''}">
        <div class="eyebrow">${eyebrow}</div>
        <h2>${title}</h2>
        <p>${body}</p>
        <div class="mode-foot"><span class="mode-status">${status}</span><button class="btn${accent ? ' primary' : ''}" data-mode="${id}">${cta}</button></div>
      </article>`;

    this.show(`
      <div class="select-wrap">
        <div class="title-row">
          <div>
            <div class="eyebrow">Salão da Guilda</div>
            <h1 class="logo">Guild <span>Tactics</span></h1>
            <p class="tagline">Combate tático por turnos em voxel. Forma equipas, explora elementos e sinergias, e vence pelo posicionamento: todo o dano é previsível.</p>
          </div>
          <div class="record">
            <div><b class="num">${r.wins}</b> vitórias · <b class="num">${r.losses}</b> derrotas</div>
            <div>Expedições conquistadas: <b class="num">${expRec.wins}</b></div>
          </div>
        </div>
        <div class="hub-grid">
          ${card(
            'expedition',
            'Modo principal · roguelite',
            'Expedição',
            `${EXPEDITION_STAGES} combates seguidos. A vida não recupera toda entre lutas; depois de cada vitória escolhes uma recompensa: relíquias, treino, recrutas.`,
            exp && exp.status === 'active' ? `Em curso: etapa ${exp.stage + 1} de ${EXPEDITION_STAGES}` : expRec.runs ? `Melhor: etapa ${expRec.bestStage} de ${EXPEDITION_STAGES}` : 'Ainda sem expedições',
            exp && exp.status === 'active' ? 'Continuar' : 'Partir',
            true,
          )}
          ${card(
            'daily',
            `Desafio diário · ${daily.date}`,
            daily.modifier.name,
            `${esc(daily.modifier.description)} Equipas fixas, as mesmas para todos hoje.`,
            today ? (today.won ? `Vencido em ${today.rounds} rondas` : 'Tentado, ainda por vencer') : 'Por jogar hoje',
            today?.won ? 'Melhorar' : 'Jogar',
          )}
          ${card('quick', 'Combate livre', 'Partida rápida', 'Escolhe quatro heróis e enfrenta uma equipa aleatória num dos mapas.', `${r.wins}–${r.losses}`, 'Jogar')}
          ${card('draft', 'Combate livre', 'Draft', 'Tu e o adversário escolhem heróis à vez de um conjunto comum. Cada escolha tira opções ao outro.', 'Ordem: 1-2-2-2-1', 'Começar')}
          ${card('puzzles', 'Treino tático', 'Puzzles', 'Situações fixas para resolver num só turno. Ensinam cerco, empurrões, trocas e supremos.', `${puzzles.solved.length} de ${PUZZLES.length} resolvidos`, 'Abrir')}
          ${card('tutorial', tutorialDone ? 'Treino' : 'Começa aqui', 'Campo de Treino', 'Um combate guiado de 2 contra 2 que ensina mover, atacar, elementos, zona de ameaça e supremos.', tutorialDone ? 'Concluído' : '2 minutos', tutorialDone ? 'Repetir' : 'Começar', !tutorialDone)}
          ${this.extraCards()}
        </div>
      </div>`);

    this.on('[data-mode="expedition"]', () => this.openExpedition());
    this.on('[data-mode="daily"]', () => this.showDaily());
    this.on('[data-mode="quick"]', () => this.game.openQuickMatch());
    this.on('[data-mode="draft"]', () => this.openDraft());
    this.on('[data-mode="puzzles"]', () => this.showPuzzles());
    this.on('[data-mode="tutorial"]', () => this.game.startTutorial());
    this.el.querySelectorAll<HTMLElement>('[data-extra]').forEach((n) => n.addEventListener('click', () => this.onExtraCard(n.dataset.extra!)));
  }

  // =============================================================== expedition

  private openExpedition() {
    const exp = loadRaw<ExpeditionState>('expedition');
    if (exp && exp.status === 'active') return this.showExpedition(exp);
    this.game.openPicker({
      eyebrow: 'Expedição',
      title: 'Escolhe quem parte',
      intro: `Quatro heróis para ${EXPEDITION_STAGES} combates seguidos. Quem cai fica fora até ser recuperado com uma recompensa. Os inimigos ficam mais fortes a cada etapa.`,
      confirmLabel: 'Partir ›',
      showDifficulty: false,
      onConfirm: (team) => {
        const fresh = startExpedition(team);
        save('expedition', fresh);
        const rec = load<ExpeditionRecord>('expedition-record', { runs: 0, wins: 0, bestStage: 0 });
        save('expedition-record', { ...rec, runs: rec.runs + 1 });
        this.showExpedition(fresh);
      },
    });
  }

  private showExpedition(e: ExpeditionState) {
    this.abandonArmed = false;
    const nodes = e.stages
      .map((st, i) => {
        const state = i < e.stage ? 'done' : i === e.stage && e.status === 'active' ? 'current' : 'locked';
        return `<li class="exp-node ${state}${st.elite ? ' elite' : ''}">
          <span class="exp-dot">${i < e.stage ? '✓' : i + 1}</span>
          <span class="exp-name">${esc(st.name)}${st.elite ? ' <span class="chip">elite</span>' : ''}</span>
          ${state === 'current' ? `<span class="exp-foes">${this.faces(st.enemies.map((x) => x.heroId), 'enemy')}</span><span class="exp-map">${esc(MAPS.find((m) => m.id === st.mapId)!.name)} · inimigos ${bonusText(st.enemies[0].bonus) || 'normais'}</span>` : ''}
        </li>`;
      })
      .join('');
    const roster = e.roster
      .map((h) => {
        const hero = getHero(h.heroId);
        const max = heroMaxHp(e, h);
        const pct = h.fallen ? 0 : Math.round((h.hp / max) * 100);
        const bonus = bonusText(totalBonus(e, h));
        return `<div class="roster-card${h.fallen ? ' fallen' : ''}">
          <img alt="" src="${this.game.portrait(h.heroId)}" />
          <div class="rc-body">
            <div class="rc-name">${esc(hero.name)} <span class="chip ${hero.heroClass}">${CLASS_GLYPH[hero.heroClass]} ${CLASS_LABEL[hero.heroClass]}</span></div>
            <div class="bigbar"><i style="width:${pct}%;background:var(--ally)"></i></div>
            <div class="rc-meta num">${h.fallen ? 'Caído' : `${h.hp} / ${max} PV`}${bonus ? ` · ${bonus}` : ''}</div>
          </div>
        </div>`;
      })
      .join('');
    const relics = e.relics.length
      ? e.relics.map((id) => `<li><b>${esc(getRelic(id).name)}</b> — ${esc(getRelic(id).description)}</li>`).join('')
      : '<li class="muted">Nenhuma ainda. Ganha-as depois de cada vitória.</li>';

    let main = '';
    if (e.status === 'won' || e.status === 'lost') {
      main = `<div class="exp-end ${e.status}">
        <h2>${e.status === 'won' ? 'Expedição conquistada!' : 'A expedição terminou'}</h2>
        <p>${e.status === 'won' ? `Venceste os ${EXPEDITION_STAGES} combates.` : `Chegaste à etapa ${e.stage + 1} de ${EXPEDITION_STAGES} com ${e.battlesWon} vitória${e.battlesWon === 1 ? '' : 's'}.`}</p>
        <button class="btn primary" id="exp-new">Nova expedição</button>
      </div>`;
    } else if (e.rewards) {
      main = `<div class="rewards">
        <h2>Escolhe uma recompensa</h2>
        <div class="reward-grid">${e.rewards
          .map(
            (r) => `<button class="reward-card" data-reward="${esc(r.id)}">
            <span class="eyebrow">${{ relic: 'Relíquia', train: 'Treino', rest: 'Descanso', revive: 'Ritual', recruit: 'Recruta' }[r.kind]}</span>
            ${r.heroId ? `<img alt="" src="${this.game.portrait(r.heroId)}" />` : ''}
            <b>${esc(r.title)}</b><span>${esc(r.description)}</span></button>`,
          )
          .join('')}</div>
      </div>`;
    } else {
      main = `<div class="exp-actions"><button class="btn primary" id="exp-fight">Combater: ${esc(e.stages[e.stage].name)} ›</button></div>`;
    }

    this.show(`
      <div class="select-wrap">
        <div class="title-row">
          <div>
            <button class="btn ghost back-btn" id="exp-back">‹ Salão</button>
            <div class="eyebrow">Expedição</div>
            <h1 class="page-title">Etapa ${Math.min(e.stage + 1, EXPEDITION_STAGES)} de ${EXPEDITION_STAGES}</h1>
          </div>
          ${e.status === 'active' ? '<button class="btn ghost" id="exp-abandon">Abandonar</button>' : ''}
        </div>
        <div class="exp-layout">
          <ol class="exp-path">${nodes}</ol>
          <div class="exp-side">
            ${main}
            <section><h3 class="eyebrow">Equipa</h3><div class="roster">${roster}</div></section>
            <section><h3 class="eyebrow">Relíquias</h3><ul class="relics">${relics}</ul></section>
          </div>
        </div>
      </div>`);

    this.on('#exp-back', () => this.showHub());
    this.on('#exp-fight', () => this.fightStage(e));
    this.on('#exp-new', () => {
      save('expedition', null);
      this.openExpedition();
    });
    this.on('#exp-abandon', () => {
      const btn = this.el.querySelector<HTMLButtonElement>('#exp-abandon')!;
      if (!this.abandonArmed) {
        this.abandonArmed = true;
        btn.textContent = 'Confirmar abandono';
        return;
      }
      const lost: ExpeditionState = { ...e, status: 'lost' };
      this.finishRun(lost);
      this.showExpedition(lost);
    });
    this.el.querySelectorAll<HTMLElement>('[data-reward]').forEach((n) =>
      n.addEventListener('click', () => {
        audio.play('click');
        const next = chooseReward(e, n.dataset.reward!);
        save('expedition', next);
        this.showExpedition(next);
      }),
    );
  }

  private finishRun(e: ExpeditionState) {
    save('expedition', e);
    const rec = load<ExpeditionRecord>('expedition-record', { runs: 0, wins: 0, bestStage: 0 });
    save('expedition-record', {
      ...rec,
      wins: rec.wins + (e.status === 'won' ? 1 : 0),
      bestStage: Math.max(rec.bestStage, e.status === 'won' ? EXPEDITION_STAGES : e.stage + 1),
    });
  }

  private fightStage(e: ExpeditionState) {
    const stage = e.stages[e.stage];
    const map = MAPS.find((m) => m.id === stage.mapId)!;
    const board = buildBoard(map);
    this.game.launch({
      kind: 'expedition',
      label: `Expedição · etapa ${e.stage + 1}/${EXPEDITION_STAGES}${stage.elite ? ' · elite' : ''}`,
      map,
      player: autoDeploy(board, playerTeamForBattle(e), 'player'),
      enemy: autoDeploy(board, enemyTeamForBattle(e), 'enemy'),
      noise: 3,
      deploy: true,
      backLabel: '‹ Expedição',
      onBack: () => this.showExpedition(e),
      onFinish: (o) => this.afterStage(e, o),
    });
  }

  private afterStage(e: ExpeditionState, o: MatchOutcome) {
    const next = recordBattle(e, o.state);
    if (next.status !== 'active') this.finishRun(next);
    else save('expedition', next);
    const won = o.winner === 'player';
    this.game.showResult(o, {
      title: next.status === 'won' ? 'Expedição conquistada!' : won ? `Etapa ${e.stage + 1} vencida` : 'Expedição perdida',
      sub: won ? (next.status === 'won' ? 'A guilda regressa em glória.' : 'Os sobreviventes recuperam 20% da vida. Escolhe uma recompensa.') : 'Os heróis recuam. Tenta uma nova expedição.',
      primary: { label: next.status === 'active' ? 'Escolher recompensa' : 'Ver resumo', fn: () => this.showExpedition(next) },
    });
  }

  // =============================================================== daily

  private showDaily() {
    const d = dailyChallenge();
    const rec = load<DailyRecord>('daily', { results: {} });
    const today = rec.results[d.date];
    this.show(`
      <div class="select-wrap narrow">
        <div>
          <button class="btn ghost back-btn" id="d-back">‹ Salão</button>
          <div class="eyebrow">Desafio diário · ${d.date}</div>
          <h1 class="page-title">${esc(d.modifier.name)}</h1>
          <p class="tagline">${esc(d.modifier.description)}</p>
        </div>
        <div class="daily-teams">
          <div><h3 class="eyebrow">A tua equipa</h3><div class="faces">${this.faces(d.player)}</div></div>
          <div><h3 class="eyebrow">Adversário (veterano)</h3><div class="faces">${this.faces(d.enemy, 'enemy')}</div></div>
          <div><h3 class="eyebrow">Mapa</h3><p>${esc(d.map.name)}</p></div>
        </div>
        <p class="muted">Hoje: ${today ? (today.won ? `melhor vitória em <b>${today.rounds}</b> rondas. Consegues em menos?` : 'ainda sem vitória.') : 'ainda não jogaste.'} Amanhã há um desafio novo.</p>
        <div><button class="btn primary" id="d-go">Jogar desafio ›</button></div>
      </div>`);
    this.on('#d-back', () => this.showHub());
    this.on('#d-go', () => this.launchDaily());
  }

  private launchDaily() {
    const d = dailyChallenge();
    const board = buildBoard(d.map);
    const withMod = (ids: string[], mod: Partial<Omit<Deployment, 'heroId' | 'pos'>>) => ids.map((heroId) => ({ heroId, ...mod }));
    this.game.launch({
      kind: 'daily',
      label: `Desafio diário · ${d.modifier.name}`,
      map: d.map,
      player: autoDeploy(board, withMod(d.player, d.modifier.player), 'player'),
      enemy: autoDeploy(board, withMod(d.enemy, d.modifier.enemy), 'enemy'),
      noise: 0.8,
      deploy: true,
      backLabel: '‹ Desafio',
      onBack: () => this.showDaily(),
      onFinish: (o) => {
        const rec = load<DailyRecord>('daily', { results: {} });
        const prev = rec.results[d.date];
        const won = o.winner === 'player';
        if (!prev || (won && (!prev.won || o.state.round < prev.rounds))) rec.results[d.date] = { won, rounds: o.state.round };
        save('daily', rec);
        this.game.showResult(o, {
          sub: won ? `Vitória em ${o.state.round} rondas.${prev?.won ? ` Melhor anterior: ${prev.rounds}.` : ''}` : undefined,
          primary: { label: 'Voltar ao Salão', fn: () => this.showHub() },
          secondary: { label: 'Tentar de novo', fn: () => this.launchDaily() },
        });
      },
    });
  }

  // =============================================================== draft

  private openDraft() {
    this.draft = newDraft();
    this.renderDraft();
  }

  private renderDraft() {
    const d = this.draft;
    const side = draftSide(d);
    const slots = (ids: string[], who: 'player' | 'enemy') =>
      [0, 1, 2, 3]
        .map((i) => (ids[i] ? `<div class="draft-slot filled ${who}"><img alt="" src="${this.game.portrait(ids[i], who)}" /><span>${esc(getHero(ids[i]).name)}</span></div>` : `<div class="draft-slot"></div>`))
        .join('');
    const pool = available(d)
      .map((id) => {
        const h = getHero(id);
        return `<button class="draft-hero" data-pick="${id}" ${side === 'player' ? '' : 'disabled'}>
          <img alt="" src="${this.game.portrait(id)}" />
          <b>${esc(h.name)}</b>
          <span class="chip ${h.heroClass}">${CLASS_GLYPH[h.heroClass]} ${CLASS_LABEL[h.heroClass]}</span>
          ${this.game.elementChip(h.element)}
        </button>`;
      })
      .join('');
    const status = side === 'player' ? 'A tua vez: escolhe um herói.' : side === 'enemy' ? 'O adversário está a escolher…' : 'Equipas completas.';
    this.show(`
      <div class="select-wrap">
        <div>
          <button class="btn ghost back-btn" id="dr-back">‹ Salão</button>
          <div class="eyebrow">Draft · escolha ${Math.min(d.turn + 1, 8)} de 8</div>
          <h1 class="page-title">${status}</h1>
        </div>
        <div class="draft-teams">
          <div><h3 class="eyebrow">Tu</h3><div class="draft-row">${slots(d.player, 'player')}</div></div>
          <div><h3 class="eyebrow">Adversário</h3><div class="draft-row">${slots(d.enemy, 'enemy')}</div></div>
        </div>
        ${side ? `<div class="draft-pool">${pool}</div>` : `<div><button class="btn primary" id="dr-go">Posicionar ›</button> <button class="btn ghost" id="dr-again">Recomeçar draft</button></div>`}
      </div>`);
    this.on('#dr-back', () => this.showHub());
    this.on('#dr-again', () => this.openDraft());
    this.on('#dr-go', () => this.launchDraft());
    this.el.querySelectorAll<HTMLElement>('[data-pick]').forEach((n) =>
      n.addEventListener('click', () => {
        if (draftSide(this.draft) !== 'player') return;
        audio.play('click');
        this.draft = draftPick(this.draft, n.dataset.pick!);
        this.renderDraft();
        this.runDraftAi();
      }),
    );
  }

  private runDraftAi() {
    if (draftSide(this.draft) !== 'enemy') return;
    setTimeout(() => {
      if (draftSide(this.draft) !== 'enemy') return;
      this.draft = draftPick(this.draft, aiDraftPick(this.draft, Math.random));
      this.renderDraft();
      this.runDraftAi();
    }, 650);
  }

  private launchDraft() {
    const map = MAPS[Math.floor(Math.random() * MAPS.length)];
    const board = buildBoard(map);
    const d = this.draft;
    this.game.launch({
      kind: 'quick',
      label: 'Draft',
      map,
      player: autoDeploy(board, d.player.map((heroId) => ({ heroId })), 'player'),
      enemy: autoDeploy(board, d.enemy.map((heroId) => ({ heroId })), 'enemy'),
      noise: this.game.difficultyNoise,
      deploy: true,
      backLabel: '‹ Draft',
      onBack: () => this.renderDraft(),
      onRematch: () => this.openDraft(),
      countsForRecord: true,
      onFinish: (o) =>
        this.game.showResult(o, {
          primary: { label: 'Novo draft', fn: () => this.openDraft() },
          secondary: { label: 'Salão', fn: () => this.showHub() },
        }),
    });
  }

  // =============================================================== puzzles

  private showPuzzles() {
    const rec = load<PuzzleRecord>('puzzles', { solved: [] });
    const cards = PUZZLES.map((p, i) => {
      const solved = rec.solved.includes(p.id);
      return `<article class="mode-card${solved ? ' solved' : ''}">
        <div class="eyebrow">Puzzle ${i + 1}${solved ? ' · resolvido ✓' : ''}</div>
        <h2>${esc(p.name)}</h2>
        <p>${esc(p.goal)}</p>
        <div class="faces">${this.faces(p.player.map((x) => x.heroId))}<span class="vs">vs</span>${this.faces(p.enemy.map((x) => x.heroId), 'enemy')}</div>
        <div class="mode-foot"><span class="mode-status"></span><button class="btn${solved ? '' : ' primary'}" data-puzzle="${p.id}">${solved ? 'Repetir' : 'Resolver'}</button></div>
      </article>`;
    }).join('');
    this.show(`
      <div class="select-wrap">
        <div>
          <button class="btn ghost back-btn" id="pz-back">‹ Salão</button>
          <div class="eyebrow">Puzzles táticos</div>
          <h1 class="page-title">Vence numa só ronda</h1>
          <p class="tagline">Os teus heróis jogam todos antes dos inimigos. Se algum inimigo chegar a agir, perdes. Cada puzzle tem solução: o dano é sempre previsível.</p>
        </div>
        <div class="hub-grid">${cards}</div>
      </div>`);
    this.on('#pz-back', () => this.showHub());
    this.el.querySelectorAll<HTMLElement>('[data-puzzle]').forEach((n) =>
      n.addEventListener('click', () => this.launchPuzzle(PUZZLES.find((p) => p.id === n.dataset.puzzle)!)),
    );
  }

  private launchPuzzle(p: Puzzle) {
    const idx = PUZZLES.indexOf(p);
    this.game.launch({
      kind: 'puzzle',
      label: `Puzzle ${idx + 1} · ${p.name}`,
      map: p.map,
      player: p.player,
      enemy: p.enemy,
      noise: 0,
      deploy: false,
      winBeforeEnemyActs: true,
      tutorial: [{ text: `<b>${esc(p.goal)}</b> ${esc(p.hint)}` }],
      onFinish: (o) => {
        const won = o.winner === 'player';
        if (won) {
          const rec = load<PuzzleRecord>('puzzles', { solved: [] });
          if (!rec.solved.includes(p.id)) save('puzzles', { solved: [...rec.solved, p.id] });
        }
        const nextPuzzle = PUZZLES[idx + 1];
        this.game.showResult(o, {
          title: won ? 'Resolvido!' : 'Ainda não',
          sub: won ? 'Encontraste a sequência certa.' : `Dica: ${p.hint}`,
          primary: won
            ? nextPuzzle
              ? { label: 'Próximo puzzle', fn: () => this.launchPuzzle(nextPuzzle) }
              : { label: 'Puzzles', fn: () => this.showPuzzles() }
            : { label: 'Tentar de novo', fn: () => this.launchPuzzle(p) },
          secondary: { label: 'Puzzles', fn: () => this.showPuzzles() },
        });
      },
    });
  }
}

import type { Deployment } from '../domain/battle';
import { buildBoard, MAPS } from '../domain/board';
import { dailyChallenge } from '../domain/daily';
import { autoDeploy } from '../domain/deploy';
import { aiDraftPick, available, DRAFT_ORDER, draftPick, draftSide, draftStep, newDraft, type DraftState } from '../domain/draft';
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
import { CLASS_GLYPH, CLASS_LABEL, HEROES, getHero, heroAbilities } from '../domain/heroes';
import {
  decodeDefense,
  defenseCell,
  defenseDeployments,
  eloDelta,
  encodeDefense,
  generateDefense,
  seasonKey,
  seasonRivals,
  seasonWar,
  softReset,
  START_RATING,
  tierOf,
  validateDefense,
  warOutcome,
  WAR_REWARD,
  type Defense,
  type DefenseSlot,
  type GuildWar,
} from '../domain/arena';
import { isWalkable } from '../domain/board';
import { mulberry32 } from '../domain/rng';
import { renderGuildHall } from '../render/models';
import { teamTraits } from '../domain/traits';
import { chooseSpec, itemStats, loadBonds, loadInventory, loadSpecs, saveInventory } from './loadout';
import {
  bondKey,
  bondLevel,
  BOND_LEVELS,
  RARITY_LABEL,
  SELL_PRICE,
  SLOT_LABEL,
  SPEC_LEVEL,
  specializationsFor,
  type Slot,
} from '../domain/progression';
import { addGold } from './profile';
import { BADGE, chooseSkin, LEVEL_REWARD, LEVEL_XP, levelFor, levelProgress, SKINS, skinOf } from './mastery';
import { PUZZLES, type Puzzle } from '../domain/puzzles';
import type { Stats } from '../domain/types';
import { audio } from '../ui/audio';
import type { Game, MatchOutcome, Replay } from './game';
import {
  BUILDINGS,
  canUpgrade,
  expeditionPerks,
  GOLD,
  MINE_CAP_HOURS,
  MINE_RATE,
  minePending,
  upgrade,
  type BuildingId,
} from '../domain/fortress';
import { collectGold, loadFortress, saveFortress, load, loadRaw, save, type DailyRecord, type ExpeditionRecord, type PuzzleRecord } from './profile';

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
  private hallKey = '';
  private equipPicker: { heroId: string; slot: Slot } | null = null;
  private hallUrl = '';

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
    const m = this.game.masteryProfile;
    const totalXp = Object.values(m.xp).reduce((a, b) => a + b, 0);
    const maxed = HEROES.filter((h) => levelFor(m.xp[h.id] ?? 0) >= 5).length;
    // The keep shows the four heroes with the most mastery (or a default squad).
    const favourites = [...HEROES].sort((a, b) => (m.xp[b.id] ?? 0) - (m.xp[a.id] ?? 0)).slice(0, 4).map((h) => h.id);
    const fort = loadFortress();
    const hallKey = favourites.map((id) => `${id}:${skinOf(m, id)}`).join(',') + JSON.stringify(fort.levels) + this.bannerColor();
    if (hallKey !== this.hallKey) {
      this.hallKey = hallKey;
      this.hallUrl = renderGuildHall(favourites, (id) => skinOf(m, id), { levels: fort.levels, banner: this.bannerColor() });
    }
    const pending = minePending(fort, Date.now());

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
          <div class="hall">
            ${this.hallUrl ? `<img class="hall-img" alt="A fortaleza da guilda com os teus heróis favoritos à porta" src="${this.hallUrl}" />` : ''}
            <div class="record">
              <div><b class="num">${r.wins}</b> vitórias · <b class="num">${r.losses}</b> derrotas</div>
              <div>Expedições conquistadas: <b class="num">${expRec.wins}</b></div>
            </div>
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
          ${card('draft', 'Combate livre', 'Draft', 'Cada lado bloqueia um herói; depois escolhem à vez de um conjunto comum. Cada escolha tira opções ao outro.', '1 bloqueio · ordem 1-2-2-2-1', 'Começar')}
          ${card('puzzles', 'Treino tático', 'Puzzles', 'Situações fixas para resolver num só turno. Ensinam cerco, empurrões, trocas e supremos.', `${puzzles.solved.length} de ${PUZZLES.length} resolvidos`, 'Abrir')}
          ${card('tutorial', tutorialDone ? 'Treino' : 'Começa aqui', 'Campo de Treino', 'Um combate guiado de 2 contra 2 que ensina mover, atacar, elementos, zona de ameaça e supremos.', tutorialDone ? 'Concluído' : '2 minutos', tutorialDone ? 'Repetir' : 'Começar', !tutorialDone)}
          ${card(
            'fortress',
            'A tua base',
            'Fortaleza',
            'Gasta ouro em edifícios: uma mina que produz mesmo quando não jogas, quartel, enfermaria, forja e sala dos mapas. Ganhas ouro em todos os modos.',
            `🪙 ${fort.gold}${pending ? ` · ${pending} à espera na mina` : ''}`,
            pending ? 'Recolher' : 'Abrir',
            pending > 0,
          )}
          ${card(
            'arena',
            `PvP assíncrono · temporada ${seasonKey()}`,
            'Arena das Guildas',
            'Ataca as defesas de guildas rivais e de amigos (a IA joga a formação deles), sobe na liga semanal e luta na guerra de guilda.',
            `${tierOf(this.arena().rating).name} · ${this.arena().rating} pontos`,
            'Entrar',
          )}
          ${card('collection', 'A tua guilda', 'Coleção', `${HEROES.length} heróis, traços de guilda e maestria. Cada partida dá XP aos heróis que lutaram; os níveis desbloqueiam insígnias e visuais.`, `${totalXp} XP · ${maxed} herói${maxed === 1 ? '' : 's'} no nível máximo`, 'Abrir')}
          ${this.extraCards()}
        </div>
      </div>`);

    this.on('[data-mode="expedition"]', () => this.openExpedition());
    this.on('[data-mode="daily"]', () => this.showDaily());
    this.on('[data-mode="quick"]', () => this.game.openQuickMatch());
    this.on('[data-mode="draft"]', () => this.openDraft());
    this.on('[data-mode="puzzles"]', () => this.showPuzzles());
    this.on('[data-mode="tutorial"]', () => this.game.startTutorial());
    this.on('[data-mode="collection"]', () => this.showCollection());
    this.on('[data-mode="arena"]', () => this.showArena());
    this.on('[data-mode="fortress"]', () => {
      if (minePending(loadFortress(), Date.now()) > 0) collectGold();
      this.showFortress();
    });
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
        const fresh = startExpedition(team, undefined, expeditionPerks(loadFortress()));
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
      noise: stage.aiNoise ?? 3,
      deploy: true,
      backLabel: '‹ Expedição',
      onBack: () => this.showExpedition(e),
      onFinish: (o) => this.afterStage(e, o),
    });
  }

  private afterStage(e: ExpeditionState, o: MatchOutcome) {
    const next = recordBattle(e, o.state);
    if (o.winner === 'player') {
      this.game.awardGold(GOLD.expeditionStage + (next.status === 'won' ? GOLD.expeditionWin : 0), next.status === 'won' ? 'expedição conquistada' : 'etapa vencida');
      this.game.awardLoot(next.status === 'won' ? 1 : e.stage * 0.15);
    }
    if (next.status !== 'active') this.finishRun(next);
    else save('expedition', next);
    const won = o.winner === 'player';
    this.game.showResult(o, {
      title: next.status === 'won' ? 'Expedição conquistada!' : won ? `Etapa ${e.stage + 1} vencida` : 'Expedição perdida',
      sub: won ? (next.status === 'won' ? 'A guilda regressa em glória.' : 'Os sobreviventes recuperam 35% da vida. Escolhe uma recompensa.') : 'Os heróis recuam. Tenta uma nova expedição.',
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
        if (won && !prev?.won) {
          this.game.awardGold(GOLD.dailyFirstWin, 'primeira vitória do dia');
          this.game.awardLoot(0.6);
        }
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
    const step = draftStep(d);
    const banning = step?.action === 'ban';
    const slots = (ids: string[], who: 'player' | 'enemy') =>
      [0, 1, 2, 3]
        .map((i) => (ids[i] ? `<div class="draft-slot filled ${who}"><img alt="" src="${this.game.portrait(ids[i], who)}" /><span>${esc(getHero(ids[i]).name)}</span></div>` : `<div class="draft-slot"></div>`))
        .join('');
    const pool = available(d)
      .map((id) => {
        const h = getHero(id);
        return `<button class="draft-hero${banning ? ' banning' : ''}" data-pick="${id}" ${side === 'player' ? '' : 'disabled'}>
          <img alt="" src="${this.game.portrait(id)}" />
          <b>${esc(h.name)}</b>
          <span class="chip ${h.heroClass}">${CLASS_GLYPH[h.heroClass]} ${CLASS_LABEL[h.heroClass]}</span>
          ${this.game.elementChip(h.element)}
        </button>`;
      })
      .join('');
    const status = !step
      ? 'Equipas completas.'
      : side === 'player'
        ? banning
          ? 'Bloqueia um herói: nenhum lado o poderá usar.'
          : 'A tua vez: escolhe um herói.'
        : banning
          ? 'O adversário está a bloquear…'
          : 'O adversário está a escolher…';
    const bans = d.bans.length
      ? `<div class="draft-bans"><span class="eyebrow">Bloqueados</span>${d.bans
          .map((b) => `<span class="ban ${b.side}"><img alt="" src="${this.game.portrait(b.heroId, 'enemy', 'classic')}" />${esc(getHero(b.heroId).name)}</span>`)
          .join('')}</div>`
      : '';
    this.show(`
      <div class="select-wrap">
        <div>
          <button class="btn ghost back-btn" id="dr-back">‹ Salão</button>
          <div class="eyebrow">Draft · passo ${Math.min(d.turn + 1, DRAFT_ORDER.length)} de ${DRAFT_ORDER.length}${step ? ` · ${banning ? 'bloqueio' : 'escolha'}` : ''}</div>
          <h1 class="page-title">${status}</h1>
        </div>
        <div class="draft-teams">
          <div><h3 class="eyebrow">Tu</h3><div class="draft-row">${slots(d.player, 'player')}</div></div>
          <div><h3 class="eyebrow">Adversário</h3><div class="draft-row">${slots(d.enemy, 'enemy')}</div></div>
        </div>
        ${bans}
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
      onFinish: (o) => {
        // Draft runs as a quick match, so the battle screen already paid out gold.
        this.game.showResult(o, {
          primary: { label: 'Novo draft', fn: () => this.openDraft() },
          secondary: { label: 'Salão', fn: () => this.showHub() },
        });
      },
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
          if (!rec.solved.includes(p.id)) {
            save('puzzles', { solved: [...rec.solved, p.id] });
            this.game.awardGold(GOLD.puzzleFirstSolve, 'puzzle resolvido pela primeira vez');
          }
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

  // =============================================================== collection

  private showCollection(focus?: string) {
    const m = this.game.masteryProfile;
    const specs = loadSpecs();
    const inv = loadInventory();
    const bonds = loadBonds();
    const ownerOf = (itemId: string) => Object.entries(inv.equipped).find(([, s]) => Object.values(s).includes(itemId))?.[0];
    const cards = HEROES.map((h) => {
      const xp = m.xp[h.id] ?? 0;
      const prog = levelProgress(xp);
      const current = skinOf(m, h.id);
      const skins = SKINS.map((sk) => {
        const unlocked = sk.level <= prog.level;
        return `<button class="skin${current === sk.id ? ' on' : ''}" data-hero="${h.id}" data-skin="${sk.id}" ${unlocked ? '' : 'disabled'} title="${unlocked ? sk.name : `Desbloqueia no nível ${sk.level}`}">
          <img alt="" src="${unlocked ? this.game.portrait(h.id, 'player', sk.id) : ''}" />
          <span>${unlocked ? sk.name : `nv ${sk.level}`}</span></button>`;
      }).join('');
      const abilities = heroAbilities(h)
        .filter((a) => a.id !== 'attack' && a.id !== 'defend')
        .map((a) => `<li><b>${esc(a.name)}</b>${a.ultimate ? ' <span class="q">supremo</span>' : a.quick ? ' <span class="q">rápida</span>' : ''} — ${esc(a.description.replace(/^Supremo: /, ''))}</li>`)
        .join('');
      const next = prog.level < LEVEL_XP.length ? `${prog.into}/${prog.span} XP para o nível ${prog.level + 1}: ${LEVEL_REWARD[prog.level + 1]}` : 'Nível máximo';
      const specOptions = specializationsFor(h.id)
        .map(
          (sp) => `<button class="spec${specs[h.id] === sp.id ? ' on' : ''}" data-spec="${sp.id}" data-hero="${h.id}" ${prog.level >= SPEC_LEVEL ? '' : 'disabled'}>
            <b>${esc(sp.name)}</b><span>${esc(sp.description)}</span></button>`,
        )
        .join('');
      const eq = (inv.equipped[h.id] ?? {}) as Partial<Record<Slot, string>>;
      const slots = (['weapon', 'armor', 'charm'] as Slot[])
        .map((slot) => {
          const item = inv.items.find((i) => i.id === eq[slot]);
          const open = this.equipPicker?.heroId === h.id && this.equipPicker.slot === slot;
          const choices = open
            ? inv.items
                .filter((i) => i.slot === slot && (!ownerOf(i.id) || ownerOf(i.id) === h.id))
                .map((i) => `<button class="pick-item" data-equip="${i.id}" data-hero="${h.id}" data-slot="${slot}"><b class="rar-${i.rarity}">${esc(i.name)}</b> <span class="muted">${itemStats(i)}</span></button>`)
                .join('') || '<span class="muted">Sem itens deste tipo. Ganha espólio na Expedição, Arena e desafio diário.</span>'
            : '';
          return `<div class="eq-slot">
            <button class="eq-btn" data-slotpick="${slot}" data-hero="${h.id}"><span class="eyebrow">${SLOT_LABEL[slot]}</span>${item ? `<b class="rar-${item.rarity}">${esc(item.name)}</b><span class="muted">${itemStats(item)}</span>` : '<span class="muted">vazio</span>'}</button>
            ${open ? `<div class="eq-choices">${choices}${item ? `<button class="pick-item" data-unequip="${slot}" data-hero="${h.id}">Tirar</button>` : ''}</div>` : ''}
          </div>`;
        })
        .join('');
      const bondRows = HEROES.filter((o) => o.id !== h.id)
        .map((o) => ({ o, pts: bonds[bondKey(h.id, o.id)] ?? 0 }))
        .filter((x) => x.pts > 0)
        .sort((a, b) => b.pts - a.pts)
        .slice(0, 4)
        .map(({ o, pts }) => {
          const lv = bondLevel(pts);
          const next = BOND_LEVELS[lv + 1];
          return `<li><b>${esc(o.name)}</b> ${lv ? `vínculo ${BOND_LEVELS[lv].name}` : 'sem vínculo'} <span class="muted">${pts}${next ? `/${next.points}` : ''} pts</span></li>`;
        })
        .join('');
      return `<article class="coll-card" id="coll-${h.id}">
        <div class="coll-head">
          <img alt="" src="${this.game.portrait(h.id)}" />
          <div>
            <div class="coll-name">${esc(h.name)} <span class="lvl">${BADGE[prog.level]} nv ${prog.level}</span></div>
            <div class="coll-sub">${esc(h.title)} · <span class="chip ${h.heroClass}">${CLASS_GLYPH[h.heroClass]} ${CLASS_LABEL[h.heroClass]}</span> ${this.game.elementChip(h.element)}</div>
            <div class="bigbar xp"><i style="width:${Math.round((prog.into / prog.span) * 100)}%;background:var(--brass)"></i></div>
            <div class="coll-next">${next}</div>
          </div>
        </div>
        <div class="stats num"><span>PV<b>${h.stats.maxHp}</b></span><span>ATQ<b>${h.stats.atk}</b></span><span>DEF<b>${h.stats.def}</b></span><span>MOV<b>${h.stats.mov}</b></span><span>VEL<b>${h.stats.spd}</b></span></div>
        <ul class="coll-abil">${abilities}</ul>
        <div><div class="eyebrow">Especialização ${prog.level >= SPEC_LEVEL ? '' : `· desbloqueia no nível ${SPEC_LEVEL}`}</div><div class="specs">${specOptions}</div></div>
        <div><div class="eyebrow">Equipamento</div><div class="eq">${slots}</div></div>
        <div><div class="eyebrow">Vínculos</div><ul class="bonds">${bondRows || '<li class="muted">Luta ao lado de outros heróis: cada partida juntos aproxima-os (C → B → A).</li>'}</ul></div>
        <div class="skins">${skins}</div>
      </article>`;
    }).join('');
    const traitRef = teamTraits(['brann', 'dagna', 'lyra', 'nyx', 'seren', 'fenna', 'mira', 'orrin'])
      .filter((t) => !t.id.startsWith('attune'))
      .map((t) => `<li><b>${esc(t.name)}</b> — ${esc(t.description)}</li>`)
      .join('');
    this.show(`
      <div class="select-wrap">
        <div>
          <button class="btn ghost back-btn" id="co-back">‹ Salão</button>
          <div class="eyebrow">A tua guilda</div>
          <h1 class="page-title">Coleção</h1>
          <p class="tagline">Cada partida dá XP aos heróis que lutaram. A maestria desbloqueia visuais, insígnias e, no nível ${SPEC_LEVEL}, uma especialização (troca vantagens por custos). Equipamento e vínculos dão bónus moderados em todos os modos menos no desafio diário, treino e puzzles.</p>
        </div>
        <details class="howto"><summary>Traços de guilda</summary><ul class="trait-ref">${traitRef}<li><b>Sintonia</b> — 2+ heróis do mesmo elemento: +1 ATQ e +3 PV (3+: +2 ATQ e +6 PV).</li></ul></details>
        <details class="howto"><summary>Inventário (${inv.items.length})</summary>
          <ul class="inventory">${
            inv.items
              .map((i) => {
                const owner = ownerOf(i.id);
                return `<li><span class="chip">${SLOT_LABEL[i.slot]}</span> <b class="rar-${i.rarity}">${esc(i.name)}</b> <span class="muted">${RARITY_LABEL[i.rarity]} · ${itemStats(i)}${owner ? ` · com ${esc(getHero(owner).name)}` : ''}</span>
                ${owner ? '' : `<button class="btn ghost" data-sell="${i.id}">Vender por ${SELL_PRICE[i.rarity]}</button>`}</li>`;
              })
              .join('') || '<li class="muted">Vazio. O espólio aparece no fim das vitórias.</li>'
          }</ul>
        </details>
        <div class="coll-grid">${cards}</div>
      </div>`);
    this.on('#co-back', () => this.showHub());
    this.el.querySelectorAll<HTMLButtonElement>('[data-skin]').forEach((b) =>
      b.addEventListener('click', () => {
        chooseSkin(b.dataset.hero!, b.dataset.skin as (typeof SKINS)[number]['id']);
        this.game.refreshMastery();
        audio.play('click');
        this.showCollection(b.dataset.hero);
      }),
    );
    const redraw = (heroId?: string) => {
      this.game.refreshMastery();
      this.showCollection(heroId);
    };
    this.el.querySelectorAll<HTMLElement>('[data-spec]').forEach((b) =>
      b.addEventListener('click', () => {
        chooseSpec(b.dataset.hero!, b.dataset.spec!);
        audio.play('shield');
        redraw(b.dataset.hero);
      }),
    );
    this.el.querySelectorAll<HTMLElement>('[data-slotpick]').forEach((b) =>
      b.addEventListener('click', () => {
        const key = { heroId: b.dataset.hero!, slot: b.dataset.slotpick as Slot };
        const same = this.equipPicker?.heroId === key.heroId && this.equipPicker.slot === key.slot;
        this.equipPicker = same ? null : key;
        redraw(key.heroId);
      }),
    );
    this.el.querySelectorAll<HTMLElement>('[data-equip]').forEach((b) =>
      b.addEventListener('click', () => {
        const cur = loadInventory();
        cur.equipped[b.dataset.hero!] = { ...(cur.equipped[b.dataset.hero!] ?? {}), [b.dataset.slot!]: b.dataset.equip! };
        saveInventory(cur);
        this.equipPicker = null;
        audio.play('click');
        redraw(b.dataset.hero);
      }),
    );
    this.el.querySelectorAll<HTMLElement>('[data-unequip]').forEach((b) =>
      b.addEventListener('click', () => {
        const cur = loadInventory();
        const slots = { ...(cur.equipped[b.dataset.hero!] ?? {}) };
        delete slots[b.dataset.unequip as Slot];
        cur.equipped[b.dataset.hero!] = slots;
        saveInventory(cur);
        this.equipPicker = null;
        redraw(b.dataset.hero);
      }),
    );
    this.el.querySelectorAll<HTMLElement>('[data-sell]').forEach((b) =>
      b.addEventListener('click', () => {
        const cur = loadInventory();
        const item = cur.items.find((i) => i.id === b.dataset.sell);
        if (!item) return;
        cur.items = cur.items.filter((i) => i.id !== item.id);
        saveInventory(cur);
        addGold(SELL_PRICE[item.rarity]);
        audio.play('heal');
        redraw();
      }),
    );
    if (focus) this.el.querySelector(`#coll-${focus}`)?.scrollIntoView({ block: 'center' });
  }

  // =============================================================== fortress

  /** Guild banner colour (set in the arena's guild screen). */
  bannerColor(): number {
    return loadRaw<{ color: number }>('guild')?.color ?? 0x4aa3ff;
  }

  private showFortress() {
    const now = Date.now();
    const f = loadFortress(now);
    const pending = minePending(f, now);
    const m = this.game.masteryProfile;
    const favourites = [...HEROES].sort((a, b) => (m.xp[b.id] ?? 0) - (m.xp[a.id] ?? 0)).slice(0, 4).map((h) => h.id);
    const img = renderGuildHall(favourites, (id) => skinOf(m, id), { levels: f.levels, banner: this.bannerColor(), width: 840, height: 420 });
    const cards = BUILDINGS.map((b) => {
      const level = f.levels[b.id];
      const check = canUpgrade(f, b.id);
      const maxed = level >= b.maxLevel;
      const cost = maxed ? 0 : b.costs[level + 1];
      return `<article class="bld${level ? '' : ' unbuilt'}">
        <div class="bld-head"><h3>${esc(b.name)}</h3><span class="lvl">${level ? `nv ${level}/${b.maxLevel}` : 'por construir'}</span></div>
        <p>${esc(b.effect(level))}</p>
        ${maxed ? '<p class="muted">Nível máximo.</p>' : `<p class="bld-next">Próximo nível: ${esc(b.effect(level + 1))}</p>`}
        ${
          maxed
            ? ''
            : `<div class="bld-foot"><span class="num">🪙 ${cost}</span><button class="btn${check.ok ? ' primary' : ''}" data-build="${b.id}" ${check.ok ? '' : 'disabled'}>${level ? 'Melhorar' : 'Construir'}</button></div>
          ${check.ok ? '' : `<p class="why">${esc(check.reason)}</p>`}`
        }
      </article>`;
    }).join('');
    const mineLevel = f.levels.mine;
    this.show(`
      <div class="select-wrap">
        <div class="title-row">
          <div>
            <button class="btn ghost back-btn" id="fo-back">‹ Salão</button>
            <div class="eyebrow">A tua base</div>
            <h1 class="page-title">Fortaleza</h1>
            <p class="tagline">Ganhas ouro em todos os modos: ${GOLD.matchWin} por vitória (${GOLD.matchLoss} por derrota), ${GOLD.expeditionStage} por etapa da Expedição e ${GOLD.expeditionWin} por conquistá-la, ${GOLD.dailyFirstWin} pela primeira vitória do desafio diário, ${GOLD.puzzleFirstSolve} por puzzle novo. Os edifícios só ajudam no modo PvE e na progressão, nunca na Arena.</p>
          </div>
          <div class="treasury">
            <div class="gold num">🪙 ${f.gold}</div>
            ${
              mineLevel
                ? `<div class="muted">Mina: ${MINE_RATE[mineLevel]}/hora · ${pending} à espera (máx. ${MINE_RATE[mineLevel] * MINE_CAP_HOURS})</div>
                   <button class="btn${pending ? ' primary' : ''}" id="fo-collect" ${pending ? '' : 'disabled'}>Recolher ${pending}</button>`
                : '<div class="muted">Constrói a Mina de Ouro para ganhar ouro mesmo quando não jogas.</div>'
            }
          </div>
        </div>
        ${img ? `<img class="fort-img" alt="A tua fortaleza com os edifícios construídos" src="${img}" />` : ''}
        <div class="bld-grid">${cards}</div>
      </div>`);
    this.on('#fo-back', () => this.showHub());
    this.on('#fo-collect', () => {
      collectGold();
      audio.play('heal');
      this.showFortress();
    });
    this.el.querySelectorAll<HTMLElement>('[data-build]').forEach((n) =>
      n.addEventListener('click', () => {
        const id = n.dataset.build as BuildingId;
        try {
          saveFortress(upgrade(loadFortress(), id, Date.now()));
          audio.play('ult');
        } catch {
          /* button state already explains why */
        }
        this.showFortress();
        this.el.querySelector(`[data-build="${id}"]`)?.scrollIntoView({ block: 'center' });
      }),
    );
  }

  // =============================================================== arena (async PvP & guilds)

  private guild(): { name: string; color: number } {
    return loadRaw<{ name: string; color: number }>('guild') ?? { name: 'Guilda sem Nome', color: 0x4aa3ff };
  }

  /** Arena profile for the current season; a new season pays the old tier and soft-resets rating. */
  private arena(): ArenaProfile {
    const season = seasonKey();
    const a = loadRaw<ArenaProfile>('arena') ?? { season, rating: START_RATING, wins: 0, losses: 0, friends: [], defense: null, seasonReward: null };
    if (a.season !== season) {
      const tier = tierOf(a.rating);
      const updated: ArenaProfile = { ...a, season, rating: softReset(a.rating), wins: 0, losses: 0, seasonReward: { season: a.season, tier: tier.name, gold: tier.reward } };
      save('arena', updated);
      return updated;
    }
    return a;
  }

  private myDefense(): Defense {
    const a = this.arena();
    const g = this.guild();
    const d = a.defense ?? generateDefense(mulberry32(7), g.name, g.color);
    return { ...d, guild: g.name, color: g.color };
  }

  private war(): GuildWar {
    const season = seasonKey();
    const w = loadRaw<GuildWar>('war');
    return w && w.season === season ? w : seasonWar(season);
  }

  private showArena(message = '') {
    const a = this.arena();
    const g = this.guild();
    const def = this.myDefense();
    const rivals = seasonRivals(a.season);
    const tier = tierOf(a.rating);
    const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
    const swatches = [0x4aa3ff, 0xe0524a, 0x3f7d4a, 0xd9a441, 0x7b4fa0, 0x2f8f9d, 0xd2642a, 0xe8e4da]
      .map((c) => `<button class="swatch${c === g.color ? ' on' : ''}" data-color="${c}" style="background:${hex(c)}" aria-label="Cor ${hex(c)}"></button>`)
      .join('');
    const ladder = [
      ...rivals.map((r) => ({ name: r.defense.guild, color: r.defense.color, rating: r.rating, id: r.id, me: false })),
      { name: g.name, color: g.color, rating: a.rating, id: 'me', me: true },
    ]
      .sort((x, y) => y.rating - x.rating)
      .map((row, i) => {
        const rival = rivals.find((r) => r.id === row.id);
        const gain = rival ? eloDelta(a.rating, rival.rating, true) : 0;
        return `<tr class="${row.me ? 'me' : ''}">
          <td class="num">${i + 1}</td>
          <td><span class="banner-dot" style="background:${hex(row.color)}"></span>${esc(row.name)}</td>
          <td class="num">${row.rating}</td>
          <td>${rival ? `<span class="faces small">${this.faces(rival.defense.slots.map((x) => x.heroId), 'enemy')}</span>` : '<span class="muted">tu</span>'}</td>
          <td>${rival ? `<button class="btn" data-attack="${rival.id}">Atacar <span class="muted">+${gain}</span></button>` : ''}</td>
        </tr>`;
      })
      .join('');
    const war = this.war();
    const outcome = warOutcome(war);
    const fronts = war.fronts
      .map(
        (f, i) => `<div class="front ${f.result}">
        <div class="eyebrow">Frente ${i + 1}</div>
        <div class="faces small">${this.faces(f.defense.slots.map((x) => x.heroId), 'enemy')}</div>
        <div>${f.result === 'pending' ? (outcome === 'ongoing' ? `<button class="btn" data-front="${i}">Atacar</button>` : '<span class="muted">—</span>') : f.result === 'won' ? '✓ conquistada' : '✗ perdida'}</div>
      </div>`,
      )
      .join('');
    const friends = a.friends.length
      ? a.friends
          .map(
            (f, i) => `<li><span class="banner-dot" style="background:${hex(f.color)}"></span><b>${esc(f.guild)}</b> <span class="faces small">${this.faces(f.slots.map((x) => x.heroId), 'enemy')}</span>
            <button class="btn" data-friend="${i}">Desafiar</button> <button class="btn ghost" data-unfriend="${i}">Remover</button></li>`,
          )
          .join('')
      : '<li class="muted">Ainda sem amigos. Cola abaixo o código de defesa que um amigo te enviar.</li>';
    const replays = (loadRaw<Replay[]>('replays') ?? [])
      .map((r, i) => `<li><span class="${r.winner === 'player' ? 'win' : 'loss'}">${r.winner === 'player' ? 'Vitória' : r.winner === 'draw' ? 'Empate' : 'Derrota'}</span> · ${esc(r.title)} <span class="muted">${esc(r.date)}</span> <button class="btn ghost" data-replay="${i}">Ver replay</button></li>`)
      .join('');
    const code = encodeDefense(def);
    this.show(`
      <div class="select-wrap">
        <div class="title-row">
          <div>
            <button class="btn ghost back-btn" id="ar-back">‹ Salão</button>
            <div class="eyebrow">Temporada ${esc(a.season)} · termina ao fim do domingo</div>
            <h1 class="page-title">Arena das Guildas</h1>
            <p class="tagline">Cada ataque é contra a defesa de outra guilda, jogada pela IA. Vitórias dão pontos de liga (Elo) e ${GOLD.arenaWin} de ouro. No fim da semana recebes ouro conforme o escalão e os pontos aproximam-se de ${START_RATING}.</p>
          </div>
          <div class="treasury">
            <div class="gold num">${a.rating}</div>
            <div class="muted">${tier.name} · ${a.wins}V ${a.losses}D esta semana</div>
          </div>
        </div>
        ${message ? `<div class="feedback">${message}</div>` : ''}
        ${a.seasonReward ? `<div class="feedback"><b>Temporada ${esc(a.seasonReward.season)} terminada:</b> escalão ${esc(a.seasonReward.tier)}. <button class="btn primary" id="ar-claim">Receber ${a.seasonReward.gold} de ouro</button></div>` : ''}
        <div class="arena-grid">
          <section class="panel">
            <h2>A tua guilda</h2>
            <label class="field">Nome <input id="ar-name" maxlength="24" value="${esc(g.name)}" /></label>
            <div class="field">Estandarte <div class="swatches">${swatches}</div></div>
            <h3 class="eyebrow">Defesa</h3>
            <p class="muted">Quem te atacar enfrenta esta formação em ${esc(MAPS.find((m) => m.id === def.mapId)!.name)}.</p>
            <div class="faces">${this.faces(def.slots.map((x) => x.heroId))}</div>
            <div class="row-btns"><button class="btn" id="ar-edit">Editar defesa</button> <button class="btn" id="ar-copy">Copiar código</button></div>
            <textarea id="ar-code" readonly rows="2" aria-label="Código da tua defesa">${code}</textarea>
          </section>
          <section class="panel">
            <h2>Guerra de guilda</h2>
            <p class="muted">Esta semana contra <b style="color:${hex(war.color)}">${esc(war.opponent)}</b>. Conquista 2 das 3 frentes para ganhar ${WAR_REWARD} de ouro.</p>
            <div class="fronts">${fronts}</div>
            ${outcome === 'won' ? '<p class="win">Guerra ganha! O ouro já está no tesouro.</p>' : outcome === 'lost' ? '<p class="loss">Guerra perdida. Nova guerra na próxima semana.</p>' : ''}
          </section>
        </div>
        <section class="panel">
          <h2>Liga da semana</h2>
          <div class="table-wrap"><table class="stats-table ladder"><thead><tr><th>#</th><th>Guilda</th><th>Pontos</th><th>Defesa</th><th></th></tr></thead><tbody>${ladder}</tbody></table></div>
        </section>
        <div class="arena-grid">
          <section class="panel">
            <h2>Amigos</h2>
            <ul class="friends">${friends}</ul>
            <label class="field">Código de defesa de um amigo <textarea id="ar-import" rows="2" placeholder="GT1-…"></textarea></label>
            <button class="btn" id="ar-add">Adicionar amigo</button>
          </section>
          <section class="panel">
            <h2>Replays</h2>
            <ul class="replays">${replays || '<li class="muted">As tuas últimas partidas aparecem aqui para rever jogada a jogada.</li>'}</ul>
          </section>
        </div>
      </div>`);

    this.on('#ar-back', () => this.showHub());
    this.el.querySelector<HTMLInputElement>('#ar-name')!.addEventListener('change', (e) => {
      const name = (e.target as HTMLInputElement).value.trim().slice(0, 24) || 'Guilda sem Nome';
      save('guild', { ...g, name });
      this.showArena('Nome da guilda guardado.');
    });
    this.el.querySelectorAll<HTMLElement>('[data-color]').forEach((n) =>
      n.addEventListener('click', () => {
        save('guild', { ...g, color: Number(n.dataset.color) });
        this.showArena();
      }),
    );
    this.on('#ar-edit', () => this.editDefense(def));
    this.on('#ar-copy', () => {
      const ta = this.el.querySelector<HTMLTextAreaElement>('#ar-code')!;
      navigator.clipboard?.writeText(code).then(
        () => this.showArena('Código copiado. Envia-o a um amigo: ele cola-o na Arena dele para te desafiar.'),
        () => {
          ta.select();
        },
      ) ?? ta.select();
    });
    this.on('#ar-claim', () => {
      const cur = this.arena();
      if (cur.seasonReward) this.game.awardGold(cur.seasonReward.gold, 'fim de temporada');
      save('arena', { ...cur, seasonReward: null });
      this.showArena('Recompensa de temporada recebida.');
    });
    this.on('#ar-add', () => {
      const raw = this.el.querySelector<HTMLTextAreaElement>('#ar-import')!.value;
      try {
        const d = decodeDefense(raw);
        const cur = this.arena();
        save('arena', { ...cur, friends: [d, ...cur.friends.filter((f) => encodeDefense(f) !== encodeDefense(d))].slice(0, 10) });
        this.showArena(`Guilda ${esc(d.guild)} adicionada aos amigos.`);
      } catch (err) {
        this.showArena(`Não foi possível ler o código: ${esc((err as Error).message)}`);
      }
    });
    this.el.querySelectorAll<HTMLElement>('[data-attack]').forEach((n) =>
      n.addEventListener('click', () => {
        const rival = rivals.find((r) => r.id === n.dataset.attack)!;
        this.attack(rival.defense, 'ladder', rival.rating);
      }),
    );
    this.el.querySelectorAll<HTMLElement>('[data-front]').forEach((n) => n.addEventListener('click', () => this.attack(war.fronts[Number(n.dataset.front)].defense, 'war', 0, Number(n.dataset.front))));
    this.el.querySelectorAll<HTMLElement>('[data-friend]').forEach((n) => n.addEventListener('click', () => this.attack(a.friends[Number(n.dataset.friend)], 'friend', 0)));
    this.el.querySelectorAll<HTMLElement>('[data-unfriend]').forEach((n) =>
      n.addEventListener('click', () => {
        const cur = this.arena();
        save('arena', { ...cur, friends: cur.friends.filter((_, i) => i !== Number(n.dataset.unfriend)) });
        this.showArena();
      }),
    );
    this.el.querySelectorAll<HTMLElement>('[data-replay]').forEach((n) =>
      n.addEventListener('click', () => {
        const r = (loadRaw<Replay[]>('replays') ?? [])[Number(n.dataset.replay)];
        if (r) this.game.watchReplay(r, MAPS.find((m) => m.id === r.mapId)!, () => this.showArena());
      }),
    );
  }

  /** Attack flow: pick a team, deploy, fight the defense with the AI playing defenders. */
  private attack(defense: Defense, kind: 'ladder' | 'war' | 'friend', rivalRating: number, front = 0) {
    this.game.openPicker({
      eyebrow: kind === 'war' ? `Guerra de guilda · frente ${front + 1}` : kind === 'friend' ? 'Amistoso' : 'Liga da semana',
      title: `Atacar ${defense.guild}`,
      intro: `Defesa: ${defense.slots.map((x) => getHero(x.heroId).name).join(', ')} em ${MAPS.find((m) => m.id === defense.mapId)!.name}. Escolhe quatro heróis para os vencer.`,
      confirmLabel: 'Posicionar ›',
      showDifficulty: false,
      onConfirm: (team) => {
        const map = MAPS.find((m) => m.id === defense.mapId)!;
        const board = buildBoard(map);
        this.game.launch({
          kind: 'arena',
          label: `${kind === 'war' ? 'Guerra' : kind === 'friend' ? 'Amistoso' : 'Liga'} · ${defense.guild}`,
          map,
          player: autoDeploy(board, team.map((heroId) => ({ heroId })), 'player'),
          enemy: defenseDeployments(defense),
          noise: 1,
          deploy: true,
          backLabel: '‹ Arena',
          onBack: () => this.showArena(),
          onFinish: (o) => this.afterAttack(o, kind, rivalRating, front),
        });
      },
    });
  }

  private afterAttack(o: MatchOutcome, kind: 'ladder' | 'war' | 'friend', rivalRating: number, front: number) {
    const won = o.winner === 'player';
    let sub = '';
    if (!o.surrendered) this.game.awardGold(won ? GOLD.arenaWin : GOLD.arenaLoss, won ? 'vitória na Arena' : 'participação');
    if (won) this.game.awardLoot(0.3);
    if (kind === 'ladder') {
      const a = this.arena();
      const delta = eloDelta(a.rating, rivalRating, won);
      save('arena', { ...a, rating: a.rating + delta, wins: a.wins + (won ? 1 : 0), losses: a.losses + (won ? 0 : 1) });
      sub = `${delta >= 0 ? '+' : ''}${delta} pontos de liga (agora ${a.rating + delta}).`;
    } else if (kind === 'war') {
      const w = this.war();
      w.fronts[front].result = won ? 'won' : 'lost';
      save('war', w);
      const out = warOutcome(w);
      if (out === 'won') this.game.awardGold(WAR_REWARD, 'guerra de guilda ganha');
      sub = out === 'won' ? 'Guerra de guilda ganha!' : out === 'lost' ? 'Guerra de guilda perdida.' : `Frente ${front + 1} ${won ? 'conquistada' : 'perdida'}.`;
    } else sub = won ? 'Venceste a defesa do teu amigo.' : 'A defesa do teu amigo aguentou.';
    this.game.showResult(o, {
      sub,
      primary: { label: 'Voltar à Arena', fn: () => this.showArena() },
    });
  }

  private editDefense(start: Defense) {
    let d: Defense = structuredClone(start);
    let selected: number | null = null;
    const render = (msg = '') => {
      const map = MAPS.find((m) => m.id === d.mapId)!;
      const board = buildBoard(map);
      const cell = (x: number, row: 0 | 1) => {
        const slot: DefenseSlot = { heroId: '', x, row };
        const walk = isWalkable(board, defenseCell(slot));
        const idx = d.slots.findIndex((s) => s.x === x && s.row === row);
        const who = idx >= 0 ? d.slots[idx] : null;
        return `<button class="def-cell${walk ? '' : ' blocked'}${idx === selected && idx >= 0 ? ' sel' : ''}" data-cell="${x},${row}" ${walk ? '' : 'disabled'}>
          ${who ? `<img alt="${esc(getHero(who.heroId).name)}" src="${this.game.portrait(who.heroId)}" />` : walk ? '' : '▩'}</button>`;
      };
      const rows = ([1, 0] as const).map((row) => `<div class="def-row"><span class="muted">${row === 1 ? 'Frente' : 'Trás'}</span>${[0, 1, 2, 3, 4, 5].map((x) => cell(x, row)).join('')}</div>`).join('');
      const pool = HEROES.map(
        (h) => `<button class="draft-hero small${d.slots.some((s) => s.heroId === h.id) ? ' in' : ''}" data-dhero="${h.id}"><img alt="" src="${this.game.portrait(h.id)}" /><b>${esc(h.name)}</b></button>`,
      ).join('');
      this.show(`
        <div class="select-wrap narrow">
          <div>
            <button class="btn ghost back-btn" id="de-back">‹ Arena</button>
            <div class="eyebrow">A tua defesa</div>
            <h1 class="page-title">Editar defesa</h1>
            <p class="tagline">Escolhe o mapa e a formação. Clica num herói no tabuleiro e depois noutra casa para o mover; clica num herói da lista para trocar o herói selecionado (ou o primeiro lugar livre).</p>
          </div>
          ${msg ? `<div class="feedback">${msg}</div>` : ''}
          <div class="seg" role="group" aria-label="Mapa">${MAPS.map((m) => `<button data-map="${m.id}" aria-pressed="${m.id === d.mapId}">${esc(m.name)}</button>`).join('')}</div>
          <div class="def-board">${rows}<div class="muted def-note">↓ do outro lado chegam os atacantes</div></div>
          ${this.game.traitsHtml(d.slots.map((s) => s.heroId), true)}
          <div class="draft-pool">${pool}</div>
          <div><button class="btn primary" id="de-save">Guardar defesa</button></div>
        </div>`);
      this.on('#de-back', () => this.showArena());
      this.el.querySelectorAll<HTMLElement>('[data-map]').forEach((n) =>
        n.addEventListener('click', () => {
          const g = this.guild();
          // Re-seat the same heroes on the new map's free cells.
          const fresh = generateDefense(mulberry32(1), g.name, g.color);
          const target = MAPS.find((m) => m.id === n.dataset.map)!;
          const b = buildBoard(target);
          const used = new Set<string>();
          const slots = d.slots.map((s) => {
            for (const row of [s.row, s.row === 1 ? 0 : 1] as (0 | 1)[])
              for (const x of [s.x, 2, 3, 1, 4, 0, 5]) {
                const k = `${x},${row}`;
                if (!used.has(k) && isWalkable(b, defenseCell({ heroId: s.heroId, x, row }))) {
                  used.add(k);
                  return { heroId: s.heroId, x, row };
                }
              }
            return s;
          });
          d = { ...fresh, guild: d.guild, color: d.color, mapId: target.id, slots };
          render();
        }),
      );
      this.el.querySelectorAll<HTMLElement>('[data-cell]').forEach((n) =>
        n.addEventListener('click', () => {
          const [x, row] = n.dataset.cell!.split(',').map(Number) as [number, 0 | 1];
          const idx = d.slots.findIndex((s) => s.x === x && s.row === row);
          if (selected === null) selected = idx >= 0 ? idx : null;
          else {
            const moving = d.slots[selected];
            if (idx >= 0) d.slots[idx] = { ...d.slots[idx], x: moving.x, row: moving.row };
            d.slots[selected] = { ...moving, x, row };
            selected = null;
          }
          render();
        }),
      );
      this.el.querySelectorAll<HTMLElement>('[data-dhero]').forEach((n) =>
        n.addEventListener('click', () => {
          const heroId = n.dataset.dhero!;
          if (d.slots.some((s) => s.heroId === heroId)) return render('Esse herói já está na defesa.');
          const i = selected ?? 0;
          d.slots[i] = { ...d.slots[i], heroId };
          selected = null;
          render();
        }),
      );
      this.on('#de-save', () => {
        const g = this.guild();
        const final = { ...d, guild: g.name, color: g.color };
        const err = validateDefense(final);
        if (err) return render(esc(err));
        save('arena', { ...this.arena(), defense: final });
        this.showArena('Defesa guardada. Copia o código para os teus amigos a enfrentarem.');
      });
    };
    render();
  }
}

interface ArenaProfile {
  season: string;
  rating: number;
  wins: number;
  losses: number;
  friends: Defense[];
  defense: Defense | null;
  seasonReward: { season: string; tier: string; gold: number } | null;
}

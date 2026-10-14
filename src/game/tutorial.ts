import type { Deployment } from '../domain/battle';
import type { MapDef } from '../domain/board';
import type { BattleEvent, BattleState } from '../domain/types';
import type { TutorialStep } from './game';

// A small scripted 2-vs-2 that teaches one idea per step, advancing on what the player actually does.

export const TUTORIAL_MAP: MapDef = {
  id: 'training',
  name: 'Campo de Treino',
  rows: ['..F...', '.R...F', '..S...', '..H...', 'F...R.', '......'],
};

export const TUTORIAL_PLAYER: Deployment[] = [
  { heroId: 'kael', pos: { x: 2, y: 4 } },
  { heroId: 'mira', pos: { x: 1, y: 5 } },
];

// Weakened, slower sparring partners so the player always moves first.
export const TUTORIAL_ENEMY: Deployment[] = [
  { heroId: 'lyra', pos: { x: 2, y: 1 }, hp: 14, bonus: { spd: -5, atk: -3 } },
  { heroId: 'brann', pos: { x: 4, y: 0 }, hp: 18, bonus: { spd: -1, atk: -3 } },
];

const sideOf = (s: BattleState, id: string) => s.units.find((u) => u.id === id)?.side;
const byPlayer = (ev: BattleEvent | undefined, s: BattleState, type: BattleEvent['type']) =>
  !!ev && ev.type === type && 'unitId' in ev && sideOf(s, ev.unitId) === 'player';

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    text: 'Bem-vindo ao Campo de Treino. Vais comandar o <b>Kael</b> e a <b>Mira</b>. A ordem dos turnos está no topo: o retrato com moldura dourada é quem joga agora.',
    button: 'Começar',
  },
  {
    text: 'Clica numa <b>casa azul</b> para mover o Kael. A casa de pedra com cristais à frente é um <b>santuário</b>: quem lá começa o turno recupera vida e energia.',
    until: ({ event, state }) => byPlayer(event, state, 'move'),
  },
  {
    text: 'Agora ataca: passa o rato sobre a <b>Lyra</b> para ver o dano exato e clica nela. Se estiver longe, carrega em <b>Terminar</b> e tenta no próximo turno.',
    until: ({ event, state }) => !!event && event.type === 'damage' && sideOf(state, event.sourceId) === 'player',
  },
  {
    text: 'Viste a etiqueta <b>Vantagem</b>? O Kael é 🔥 Fogo e a Lyra é 🌿 Natureza: Fogo vence Natureza (+30% de dano). O quadradinho colorido ao lado da vida mostra o elemento.',
    button: 'Percebi',
  },
  {
    text: 'Carrega em <b>T</b> (ou no botão ⚠ em cima) para ver onde os inimigos conseguem atacar no próximo turno.',
    until: ({ threatOn }) => threatOn,
  },
  {
    text: 'Quando for a vez da Mira, usa uma <b>habilidade</b> da barra de baixo (teclas 2–4): <b>Cura</b> no Kael, ou <b>Bênção</b>, que é rápida e não gasta o turno.',
    until: ({ event, state }) =>
      byPlayer(event, state, 'abilityUsed') && event?.type === 'abilityUsed' && !['attack', 'defend'].includes(event.abilityId),
  },
  {
    text: 'A barra dourada debaixo da vida é a <b>energia</b>. Quando enche, o botão do <b>supremo</b> (tecla 5) brilha. Um santuário acelera a energia.',
    button: 'Vamos a isso',
  },
  {
    text: 'Derrota os dois inimigos. Dica: cada aliado encostado ao alvo dá +15% de dano (cerco).',
    until: ({ state }) => state.winner === 'player',
  },
];

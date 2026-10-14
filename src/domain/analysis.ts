import { findAbility, getHero } from './heroes';
import type { BattleEvent, BattleState, Unit } from './types';

// Post-match coaching: a few concrete, plain-language observations about what decided the match.
// Pure: takes the final state and the full event history.

export interface Insight {
  /** Higher = more important; the screen shows the top three. */
  weight: number;
  text: string;
}

const name = (s: BattleState, id: string) => getHero(s.units.find((u) => u.id === id)!.heroId).name;

/**
 * @param ultReady ids of player units whose energy bar was full at some point
 */
export function analyzeMatch(s: BattleState, events: BattleEvent[], ultReady: string[] = []): Insight[] {
  const out: Insight[] = [];
  const unit = (id: string): Unit | undefined => s.units.find((u) => u.id === id);
  const isPlayer = (id: string) => unit(id)?.side === 'player';
  const won = s.winner === 'player';

  // Walk the log once, tracking the round and each player's turn.
  let round = 0;
  let turnUnit: string | null = null;
  let actedThisTurn = false;
  let passiveTurns = 0;
  const firstDeath: { id: string; round: number }[] = [];
  const ultsUsed = new Set<string>();
  let flankHits = 0;
  let playerHits = 0;
  let resisted = 0;
  let advantage = 0;
  let enemyResisted = 0;
  let shrineMine = 0;
  let shrineTheirs = 0;

  for (const ev of events) {
    switch (ev.type) {
      case 'roundStart':
        round = ev.round;
        break;
      case 'turnStart':
        turnUnit = ev.unitId;
        actedThisTurn = false;
        break;
      case 'abilityUsed':
        if (ev.unitId === turnUnit) actedThisTurn = true;
        if (isPlayer(ev.unitId) && findAbility(unit(ev.unitId)!.heroId, ev.abilityId).ultimate) ultsUsed.add(ev.unitId);
        break;
      case 'turnEnd':
        if (turnUnit && isPlayer(turnUnit) && !actedThisTurn) passiveTurns++;
        turnUnit = null;
        break;
      case 'skipTurn':
        actedThisTurn = true; // stunned turns are not the player's choice
        break;
      case 'damage':
        if (ev.tags.includes('burn') || ev.tags.includes('collision')) break;
        if (isPlayer(ev.sourceId)) {
          playerHits++;
          if (ev.tags.includes('flank')) flankHits++;
          if (ev.tags.includes('resisted')) resisted++;
          if (ev.tags.includes('advantage')) advantage++;
        } else if (ev.tags.includes('resisted')) enemyResisted++;
        break;
      case 'death':
        firstDeath.push({ id: ev.unitId, round });
        break;
      case 'shrine':
        if (isPlayer(ev.unitId)) shrineMine++;
        else shrineTheirs++;
        break;
    }
  }

  // First hero lost, and why that usually happens for its class.
  const firstMine = firstDeath.find((d) => isPlayer(d.id));
  if (firstMine && firstMine.round <= 3) {
    const cls = getHero(unit(firstMine.id)!.heroId).heroClass;
    const why =
      cls === 'warrior'
        ? 'Um guerreiro sozinho à frente é cercado; avança com um aliado ao lado ou usa Defender.'
        : 'Heróis frágeis devem ficar fora da zona vermelha (tecla T) até os guerreiros segurarem a linha.';
    out.push({ weight: won ? 4 : 9, text: `${name(s, firstMine.id)} caiu cedo, na ronda ${firstMine.round}. ${why}` });
  }

  // Ultimates left unused.
  const wasted = ultReady.filter((id) => !ultsUsed.has(id) && isPlayer(id));
  if (wasted.length)
    out.push({
      weight: 7,
      text: `${wasted.map((id) => name(s, id)).join(' e ')} ${wasted.length > 1 ? 'tiveram' : 'teve'} o supremo pronto e não o ${wasted.length > 1 ? 'usaram' : 'usou'}. Quando o botão brilha, costuma ser a melhor jogada.`,
    });

  // Element matchups.
  if (resisted >= 3 && resisted > advantage)
    out.push({ weight: 6, text: `${resisted} dos teus ataques foram contra um elemento que te resiste (−20%). Vê o quadradinho de cor ao lado da vida e escolhe alvos com vantagem.` });
  else if (advantage >= 3) out.push({ weight: 2, text: `Aproveitaste bem os elementos: ${advantage} ataques com vantagem (+30%).` });

  // Flanking.
  if (playerHits >= 6 && flankHits / playerHits < 0.15)
    out.push({ weight: 5, text: 'Quase nunca cercaste: cada aliado encostado ao alvo dá +15% de dano. Ataca o mesmo inimigo com dois heróis lado a lado.' });

  // Passive turns.
  if (passiveTurns >= 3) out.push({ weight: 5, text: `Terminaste ${passiveTurns} turnos sem agir. Se ninguém está ao alcance, Defender (−50% de dano) é melhor do que nada.` });

  // Shrines.
  if (shrineTheirs >= shrineMine + 2) out.push({ weight: 4, text: 'O adversário usou mais os santuários (cura e energia). Disputar a casa de cristais compensa.' });

  if (enemyResisted >= 3) out.push({ weight: 1, text: 'O adversário bateu várias vezes contra elementos que lhe resistem: a tua composição estava bem escolhida.' });

  if (!out.length)
    out.push({ weight: 1, text: won ? 'Vitória limpa: boa gestão de posição e de habilidades.' : 'Partida equilibrada. Experimenta o botão Sugestão (tecla S) para ver o que a IA faria no teu lugar.' });

  return out.sort((a, b) => b.weight - a.weight).slice(0, 3);
}

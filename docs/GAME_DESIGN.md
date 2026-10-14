# Guild Tactics — documento de design do vertical slice

> Todos os nomes, números e regras aqui são **hipóteses a validar** em testes, não decisões finais.

## 1. Objetivo (de trás para a frente)

O fim desta fase é responder a uma pergunta: **o combate é divertido o suficiente para alguém pedir outra partida?**

Para lá chegar, o slice precisa de:

1. Uma partida completa de 4 contra 4 que se joga em 5–8 minutos.
2. Decisões em que o posicionamento pesa mais do que a sorte (sem aleatoriedade no dano).
3. Informação clara: o jogador vê o dano exato antes de agir.
4. Um adversário controlado pelo jogo que castigue erros, sem ser opressivo.
5. Feedback no fim (duração, MVP, estatísticas) e acesso imediato a outra partida.

Fora do slice: coleção, progressão, contas, PvP, loja.

## 2. Core loop

```
Escolher 4 heróis ─► Posicionar no mapa ─► Combate por turnos ─► Resultado + dica
        ▲                                                               │
        └──────────────── "Outra partida" / "Mudar equipa" ◄────────────┘
```

## 3. Modelo de domínio

O código separa o **domínio** (regras puras em TypeScript, sem DOM nem 3D) da **apresentação**.

| Conceito | Ficheiro | Notas |
| --- | --- | --- |
| `HeroDef` | `src/domain/heroes.ts` | Dados estáticos: classe, atributos, ataque básico, 3 habilidades. |
| `Ability` / `Effect` | `src/domain/types.ts` | Uma habilidade é alcance + regra de alvo + área + lista de efeitos. |
| `Board` / `Terrain` | `src/domain/board.ts` | Tabuleiro 6×6, mapas simétricos (rotação de 180°). |
| `Unit` | `src/domain/types.ts` | Estado de combate de um herói: vida, escudo, estados, recargas. |
| `BattleState` | `src/domain/battle.ts` | Unidades, ronda, fila de turnos, turno ativo, vencedor. |
| `Command` → `BattleEvent[]` | `src/domain/battle.ts` | Cada comando valida-se e devolve eventos; a vista anima os eventos. |
| IA | `src/domain/ai.ts` | Simula todas as sequências (ação rápida → movimento → ação) e escolhe a melhor. |

Analogia: o domínio é o **livro de regras e o tabuleiro de cortiça**; a camada 3D é o **narrador** que lê o diário de eventos e o encena. O narrador nunca muda as regras, só as conta.

## 4. Regras

### Turnos
- Cada ronda, todas as unidades vivas jogam uma vez, por ordem de **Velocidade** (empates alternam entre lados por ronda).
- No seu turno, uma unidade pode **mover** (até MOV pontos) e depois fazer **uma ação**. A ação termina o turno.
- **Ações rápidas** (Fúria, Salto, Bênção) não terminam o turno; só uma por turno.
- O movimento pode ser desfeito antes de agir.
- Limite de **12 rondas**: vence quem tiver maior % de vida total.

### Dano (determinístico)
```
dano = ATQ × poder × 1,25 × 10 / (10 + DEF)        (mágico usa DEF / 2)
× 2      execução (alvo ≤ 50% da vida)
× 1,2    atacante em colina e alvo fora
× 0,75   alvo em floresta (exceto "ignora cobertura")
× (1 + 0,15 × aliados do atacante encostados ao alvo)   — cerco
× 1,3    alvo marcado
× 0,7    atacante enfraquecido
× 1,3 / 0,8  vantagem / desvantagem elemental
× 0,5    alvo em guarda
mínimo 1, arredondado
```
O escudo absorve antes da vida. Colisões de empurrão causam 3 de dano fixo.

### Elementos
Fogo vence Natureza, Natureza vence Água, Água vence Fogo; Luz e Sombra vencem-se mutuamente.
Vantagem: **×1,3** de dano; desvantagem: **×0,8**. O elemento é do herói (todas as suas habilidades o usam).

| Elemento | Heróis |
| --- | --- |
| 🔥 Fogo | Kael, Seren |
| 💧 Água | Tobin, Vex |
| 🌿 Natureza | Brann, Lyra |
| ☀ Luz | Mira |
| ☾ Sombra | Orrin |

### Terreno
| Terreno | Movimento | Efeito |
| --- | --- | --- |
| Planície | 1 | — |
| Floresta | 2 | −25% de dano recebido |
| Colina | 2 | +20% de dano e +1 de alcance à distância |
| Santuário | 1 | Quem começa o turno aqui recupera 4 de vida e ganha 15 de energia |
| Rocha / Água | — | Intransponível |

### Energia e golpe supremo
- Cada herói ganha **20 de energia** no início do turno e **1,5 por ponto de dano** causado ou sofrido (máx. 100).
- Com a barra cheia pode usar o seu **supremo**, que gasta a barra toda. Na simulação, cada herói chega a um supremo em ~50% das partidas; com jogadores humanos (que os procuram ativamente) deve ser mais.

| Herói | Supremo |
| --- | --- |
| Brann | Fortaleza — 14 de escudo e guarda para si e aliados adjacentes |
| Kael | Dança das Lâminas — dois golpes de 110%, o segundo com execução |
| Lyra | Flecha Perfurante — 150% numa linha de 5 casas, ignora cobertura |
| Tobin | Campo de Armadilhas — 70% numa cruz, prende e marca |
| Seren | Inferno — 130% mágico numa cruz e queimadura |
| Vex | Inverno Eterno — 60% mágico e atordoa todos os inimigos a até 2 casas |
| Mira | Graça Divina — todos os aliados recuperam 12 e são purificados |
| Orrin | Hino dos Heróis — todos os aliados ganham +4 ATQ (2 turnos) e 6 de escudo |

### Zona de ameaça
`T` (ou o botão ⚠) mostra as casas que os inimigos atingem no próximo turno com o ataque básico (movimento + alcance). Passar o rato sobre um inimigo mostra só a zona dele; casas de movimento em perigo ficam roxas.

### Estados
Duram um número de turnos **do próprio afetado**; aplicados no próprio turno, não contam esse turno.
Atordoado (perde o turno), Preso (não move), A arder (dano no início do turno), Marcado (+30% de dano recebido),
Enfraquecido (−30% de dano causado), Fortalecido (+ATQ), Em guarda (−50% de dano recebido).

## 5. Heróis

| Herói | Classe | PV | ATQ | DEF | MOV | VEL | Alcance | Habilidades |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Brann | Guerreiro (tanque) | 34 | 8 | 6 | 3 | 3 | 1 | Golpe de Escudo, Muralha, Investida |
| Kael | Guerreiro (duelista) | 30 | 11 | 4 | 3 | 6 | 1 | Rodopio, Execução, Fúria* |
| Lyra | Arqueiro (atiradora) | 20 | 9 | 2 | 3 | 7 | 2–3 | Tiro Certeiro, Flecha Marcadora, Chuva de Flechas |
| Tobin | Arqueiro (caçador) | 22 | 8 | 3 | 4 | 8 | 2–3 | Rede, Tiro Repulsor, Salto* |
| Seren | Mago (fogo) | 18 | 11 | 1 | 3 | 5 | 1–3 m | Bola de Fogo, Brasas, Meteoro |
| Vex | Mago (gelo/controlo) | 20 | 9 | 2 | 3 | 5 | 1–3 m | Prisão de Gelo, Lança de Gelo, Troca Arcana |
| Mira | Suporte (cura) | 22 | 6 | 3 | 3 | 6 | 1–2 m | Cura, Bênção*, Aurora |
| Orrin | Suporte (tático) | 24 | 7 | 3 | 3 | 7 | 1–2 | Grito de Guerra, Inspirar, Canção Lânguida |

`*` ação rápida · `m` ataque mágico. Todos têm também **Atacar** e **Defender**.

## 6. Modos de jogo

O **Salão da Guilda** (menu principal) dá acesso a todos os modos. Todos usam o mesmo ecrã de combate através de uma `MatchSpec` (mapa, equipas, dificuldade, regras especiais e o que fazer no fim).

| Modo | Regras | Código |
| --- | --- | --- |
| **Expedição** | 5 combates seguidos com inimigos cada vez mais fortes (+1 ATQ e +3 PV por etapa; a 5.ª é elite). A vida passa de combate para combate (+20% de descanso). Depois de cada vitória escolhes 1 de 3 recompensas: relíquia (bónus para a equipa), treino (+2 ATQ, +5 PV a um herói), acampamento, ritual (reviver caídos) ou recruta (substitui um caído). Perder um combate termina a expedição. A expedição em curso fica guardada no browser. | `src/domain/expedition.ts` |
| **Desafio diário** | Mapa, equipas e modificador gerados a partir da data: iguais para todos no mesmo dia. Guarda a melhor vitória (menos rondas). | `src/domain/daily.ts` |
| **Partida rápida** | Escolhe 4 heróis contra uma equipa aleatória (uma de cada classe). | — |
| **Draft** | Escolhas alternadas 1-2-2-2-1 de um conjunto comum; a IA cobre classes em falta e procura vantagem elemental. | `src/domain/draft.ts` |
| **Puzzles** | Situações fixas para vencer numa só ronda. Um solucionador exaustivo (`solvePuzzle`) prova que cada um tem solução e que a ideia-chave é necessária (`scripts/puzzle-idea.ts`). | `src/domain/puzzles.ts` |
| **Treino** | Combate guiado de 2 contra 2 em 8 passos. | `src/game/tutorial.ts` |

## 7. Primeira leitura de equilíbrio

Simulação IA contra IA (`npx vite-node scripts/simulate.ts 400`), equipas aleatórias:

- Duração média: **~7 rondas** (≈ 5–8 min com um humano a jogar metade dos turnos).
- Taxa de vitória por herói entre ~42% (Kael) e ~62% (Seren). Kael é provavelmente subvalorizado pela IA; Seren pode estar forte demais.
- O lado que joga primeiro em empates de velocidade tem vantagem; os empates alternam por ronda para atenuar.

A IA não é um bom substituto de jogadores: estes números servem para detetar extremos, não para afinar.

## 8. O que observar nos testes (30–50 jogadores)

- Pedem outra partida sem ser convidados? Trocam de composição?
- Duração real das partidas (o ecrã final mostra-a).
- Momentos de confusão: não perceber de onde veio o dano, estados, ordem de turnos.
- Táticas dominantes (ex.: Seren + Inspirar, ou tanque com Muralha a bloquear corredores).
- Regresso após 1 dia e após 1 semana.

## 9. Visão completa e roadmap

A visão de longo prazo junta quatro referências, cada uma a contribuir com uma camada (sem copiar nomes, mecânicas proprietárias ou visuais):

| Referência | Camada que inspira | Onde encaixa no Guild Tactics |
| --- | --- | --- |
| Fire Emblem: Three Houses | Combate tático, vínculos entre personagens, progressão de classes | **O núcleo** — o combate deste slice; vínculos dão bónus a pares de heróis que lutam juntos |
| Pokémon | Coleção, afinidades elementais, evolução | Heróis com elemento e evolução de classe (ex.: Arqueiro → Atirador / Caçador) |
| Summoners War | Gacha de monstros, runas/equipamento, arena com defesas | Equipamento com atributos; arena assíncrona onde se ataca a defesa de outro jogador |
| Clash of Clans | Base, recursos ao longo do tempo, raides, clãs | Fortaleza da guilda que produz recursos e treina heróis; guildas e guerras de guilda |

Ordem proposta (de trás para a frente: cada camada só entra se a anterior prender os jogadores):

1. **Clareza e profundidade do combate** — zona de ameaça ✅, energia e supremos ✅, elementos ✅, santuários (objetivo de mapa) ✅, tutorial guiado ✅, som e zoom ✅.
2. **Rejogabilidade** — modo Expedição ✅, desafio diário ✅, draft ✅, puzzles táticos ✅, Salão da Guilda (menu) ✅.
3. **Coleção e progressão** — elementos, níveis e evolução de classe, vínculos, equipamento, mais heróis.
4. **Fortaleza da guilda** — base com edifícios que dão recursos e melhorias.
5. **PvP assíncrono e guildas** — defesas, ranking por temporada, guerras de guilda. As regras já são puras e determinísticas, por isso uma partida pode ser reproduzida a partir da lista de comandos.

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
| 💧 Água | Tobin, Vex, Maris |
| 🌿 Natureza | Brann, Lyra, Fenna |
| ☀ Luz | Mira, Dagna |
| ☾ Sombra | Orrin, Nyx |

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
| Seren | Mago (fogo) | 18 | 10 | 1 | 3 | 5 | 1–3 m | Bola de Fogo, Brasas, Meteoro |
| Vex | Mago (gelo/controlo) | 20 | 9 | 2 | 3 | 5 | 1–3 m | Prisão de Gelo, Lança de Gelo, Troca Arcana |
| Mira | Suporte (cura) | 22 | 6 | 3 | 3 | 6 | 1–2 m | Cura, Bênção*, Aurora |
| Orrin | Suporte (tático) | 24 | 7 | 3 | 3 | 7 | 1–2 | Grito de Guerra, Inspirar, Canção Lânguida |

| Dagna | Guerreiro (protetora) | 32 | 9 | 5 | 3 | 4 | 1 | Terramoto, Juramento*, Juízo |
| Nyx | Arqueiro (assassina) | 19 | 10 | 2 | 4 | 9 | 1–3 | Passo Sombrio*, Lâmina Envenenada, Golpe nas Costas |
| Fenna | Mago (druida) | 21 | 9 | 2 | 3 | 5 | 1–3 m | Silvado, Rebento, Chicote de Vinha |
| Maris | Suporte (maré) | 23 | 7 | 3 | 3 | 6 | 1–2 m | Ressaca, Onda Purificadora, Bolha* |

`*` ação rápida · `m` ataque mágico. Todos têm também **Atacar**, **Defender** e um **supremo**.

### Traços de guilda (sinergias de equipa)
Calculados a partir da composição; valem para os dois lados (exceto treino e puzzles).

| Traço | Condição | Efeito |
| --- | --- | --- |
| Guilda Equilibrada | uma de cada classe | toda a equipa começa com 15 de energia |
| Linha da Frente | 2+ guerreiros | guerreiros +2 DEF |
| Saraivada | 2+ arqueiros | arqueiros +2 ATQ |
| Círculo Arcano | 2+ magos | magos começam com 30 de energia |
| Coro | 2+ suportes | toda a equipa +4 PV |
| Sintonia (elemento) | 2+ do mesmo elemento | esses heróis +1 ATQ e +3 PV (3+: +2 ATQ e +6 PV) |
| Crepúsculo | Luz e Sombra juntas | esses heróis +2 ATQ |

### Vínculos, especializações e equipamento
- **Vínculos** (à Fire Emblem): cada par de heróis que luta junto ganha 1 ponto (+1 se vencerem, +1 se ambos sobreviverem). Níveis C / B / A aos 3 / 8 / 15 pontos. Em combate, um aliado com vínculo encostado dá +5 / 10 / 15% de dano a quem ataca e −5 / 8 / 12% de dano a quem é atacado (etiquetas *Vínculo* e *Proteção*). Cada nível novo tem uma linha de história.
- **Especialização** (evolução de classe, à Pokémon/Fire Emblem): no nível 3 de maestria cada herói escolhe uma de duas, sempre com ganho e custo — Paladino/Berserker, Atirador/Batedor, Arquimago/Sábio, Sacerdote/Estratega.
- **Equipamento** (à Summoners War): arma, armadura e amuleto, de raridade comum/rara/épica, ganhos como espólio (etapas da Expedição, vitórias na Arena, primeira vitória diária, metade das vitórias rápidas). Vende-se por ouro. O inventário guarda 40 itens.
- Os três aplicam-se aos teus heróis em partida rápida, draft, Expedição e Arena; nunca no desafio diário (equipas fixas), treino ou puzzles. As defesas da Arena usam heróis base.

### Maestria
Cada partida dá XP aos heróis que lutaram: 20 + 20 por vitória + 4 por abate + 10 para o MVP. Níveis aos 60 / 150 / 280 / 450 XP desbloqueiam insígnias (bronze, prata, ouro), visuais (Veterano no nível 3, Lendário no nível 5) e a especialização (nível 3). Tudo se ganha a jogar: nada disto é vendável, alinhado com a monetização pretendida (cosméticos, sem pagar para ganhar).

## 6. Modos de jogo

O **Salão da Guilda** (menu principal) dá acesso a todos os modos. Todos usam o mesmo ecrã de combate através de uma `MatchSpec` (mapa, equipas, dificuldade, regras especiais e o que fazer no fim).

| Modo | Regras | Código |
| --- | --- | --- |
| **Expedição** | 5 combates seguidos: a etapa 1 é um aquecimento (inimigos −3 ATQ), a força sobe 1 ATQ e 3 PV por etapa e a 5.ª é elite; a IA inimiga começa desajeitada e fica afiada. A vida passa de combate para combate (+35% de descanso). Teste ponta a ponta (`tests/expedition-e2e.test.ts`): uma IA que joga bem conquista ~1 em cada 3 expedições. Depois de cada vitória escolhes 1 de 3 recompensas: relíquia (bónus para a equipa), treino (+2 ATQ, +5 PV a um herói), acampamento, ritual (reviver caídos) ou recruta (substitui um caído). Perder um combate termina a expedição. A expedição em curso fica guardada no browser. | `src/domain/expedition.ts` |
| **Desafio diário** | Mapa, equipas e modificador gerados a partir da data: iguais para todos no mesmo dia. Guarda a melhor vitória (menos rondas). | `src/domain/daily.ts` |
| **Partida rápida** | Escolhe 4 heróis contra uma equipa aleatória (uma de cada classe). | — |
| **Draft** | Cada lado bloqueia um herói; depois escolhas alternadas 1-2-2-2-1 de um conjunto comum. A IA cobre classes em falta, procura vantagem elemental e bloqueia o herói que mais ajudaria o jogador. | `src/domain/draft.ts` |
| **Puzzles** | Situações fixas para vencer numa só ronda. Um solucionador exaustivo (`solvePuzzle`) prova que cada um tem solução e que a ideia-chave é necessária (`scripts/puzzle-idea.ts`). | `src/domain/puzzles.ts` |
| **Treino** | Combate guiado de 2 contra 2 em 8 passos. | `src/game/tutorial.ts` |
| **Arena das Guildas** | PvP assíncrono: atacas defesas (4 heróis + formação + mapa) jogadas pela IA. Liga semanal com 7 guildas rivais e pontuação Elo; no fim da semana, ouro por escalão (Bronze/Prata/Ouro/Diamante) e os pontos aproximam-se de 1000. Guerra de guilda semanal: 3 frentes, ganha quem conquistar 2. Amigos: a tua defesa vira um código `GT1-…` que outra pessoa cola na Arena dela para te desafiar. | `src/domain/arena.ts` |

**Guildas reais (online).** Na página publicada do claude.ai, cada jogador com sessão iniciada publica a sua guilda num armazenamento partilhado da página (`guilds/<id do jogador>`: nome, estandarte, código da defesa, pontos, últimos ataques e progresso de guerra). Regras de acesso: todos leem todas as guildas; cada um só escreve a sua. Na Arena aparecem as guildas de outras pessoas para atacar (Elo contra os pontos publicados), a lista de quem atacou a tua defesa esta semana, e uma **guerra semanal entre guildas reais**: as guildas ativas na semana são emparelhadas por id, cada uma ataca a defesa da outra até 3 vezes e ganha quem vencer mais — cada lado regista só os seus próprios resultados e o placar junta os dois documentos. Fora do claude.ai (ficheiro local) esta camada desaparece e ficam os códigos de defesa. Código: `src/game/online.ts`.

Em todos os combates há **AUTO** (tecla A): a IA joga também os teus turnos, ao estilo dos RPG de coleção. Cada partida fica guardada como **replay** (as regras são determinísticas, por isso basta guardar as posições iniciais e a lista de comandos).

### Fortaleza (camada de base)
Ouro ganho em todos os modos (vitória 40, derrota 15, etapa de Expedição 30, Expedição conquistada +150, primeira vitória diária 60, puzzle novo 50, Arena 50/15, guerra de guilda 200, fim de temporada 80–400).

| Edifício | Níveis | Efeito |
| --- | --- | --- |
| Torre de Menagem | 3 | limita o nível dos outros edifícios |
| Mina de Ouro | 3 | 30 / 60 / 100 de ouro por hora, guarda até 8 h — produz mesmo sem jogar |
| Quartel | 3 | +15 / 30 / 50% de XP de maestria |
| Enfermaria | 3 | descanso da Expedição +10 / 20 / 30% |
| Forja | 2 | Expedições começam com 1 / 2 relíquias |
| Sala dos Mapas | 1 | 4 recompensas por vitória na Expedição |

Os edifícios só ajudam PvE e progressão; nunca alteram números da Arena. A maquete voxel da fortaleza mostra cada edifício construído e o estandarte da guilda.

### Primeiras partidas (feedback do primeiro jogador: "só perco", "coisa demais")
- **Desbloqueio progressivo** (ordem combinada com o jogador): no início só o Treino e a Partida rápida → a primeira vitória abre a Expedição → uma Expedição concluída (ganha ou perdida) abre a Fortaleza, a Coleção e o desafio diário → 2 Expedições concluídas (ou uma conquistada) abrem a Arena e o Draft. Os Puzzles abrem ao concluir o Treino. Uma linha "Por desbloquear" diz o que falta, e "Mostrar tudo já" abre tudo para quem quiser.
- **Recruta mais fácil:** adversários com −2 ATQ e −5 PV e uma IA muito mais desajeitada. Um jogador simulado mediano passa de ~55% para ~96% de vitórias (`scripts/recruit-check.ts`); o Veterano não mudou.
- **Sugestão (tecla S):** mostra no tabuleiro o que a IA faria com o herói ativo, sem jogar por ti.
- **Porque perdi?:** no fim de cada partida, até 3 observações concretas tiradas do histórico do combate (herói deixado ao alcance de vários inimigos, herói perdido cedo, supremo por usar, ataques contra elementos que resistem, pouco cerco, turnos sem agir, santuários). Código: `src/domain/analysis.ts`.

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
2. **Rejogabilidade** — modo Expedição ✅, desafio diário ✅, draft com bloqueios ✅, puzzles táticos ✅, Salão da Guilda (menu) ✅.
3. **Coleção e identidade** — 12 heróis ✅, traços de guilda ✅, maestria com insígnias e visuais ✅, ecrã de Coleção ✅, fortaleza voxel no Salão ✅. Vínculos entre heróis ✅, especializações (evolução de classe) ✅, equipamento com espólio e inventário ✅.
4. **Fortaleza da guilda** — ouro, 6 edifícios com níveis, mina em tempo real, maquete voxel ✅.
5. **PvP assíncrono e guildas** — identidade da guilda (nome e estandarte) ✅, defesas partilháveis por código ✅, liga semanal com Elo e recompensas ✅, guerra de guilda ✅, replays ✅, combate automático ✅. Guildas reais online com defesas publicadas, ataques registados e guerra semanal entre guildas reais ✅ (armazenamento partilhado da página no claude.ai).
6. **Onboarding (do primeiro feedback real)** — desbloqueio progressivo dos modos ✅, Recruta mais fácil ✅, botão Sugestão ✅, análise "Porque perdi?" ✅. Por validar: sessões de jogo do utilizador e de mais testadores (o que confunde, o que frustra, se pedem outra partida).

Verificação do servidor online (armazenamento partilhado da página, 2026-10-14): uma guilda de teste escrita pelo dono foi lida por um nível só-leitura e a tentativa de outro jogador (nível Contributor) a alterar foi recusada pelas regras; a guilda de teste foi apagada. Ainda não houve partidas entre duas contas reais — precisa de a página ser partilhada com pelo menos mais uma pessoa.

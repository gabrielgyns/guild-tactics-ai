# Guild Tactics

Jogo tático por turnos em voxel: 4 heróis contra 4, num tabuleiro 6×6 com terreno. Vertical slice jogável no browser.

## Jogar

```bash
npm install
npm run dev        # http://localhost:5173
```

`npm run build` gera um único `dist/index.html` (sem dependências externas além das fontes) que se abre diretamente no browser.

## Controlos

- Clica numa casa azul para mover; num inimigo a vermelho para atacar.
- `1`–`5` escolhem ações, `Espaço` termina o turno, `Esc` cancela ou desfaz o movimento, `Q`/`E` rodam a câmara.
- Passa o rato sobre um alvo para ver o dano exato antes de agir. No telemóvel: um toque pré-visualiza, outro confirma.

## Estrutura

```
src/domain/   regras puras (heróis, tabuleiro, combate, IA) — sem DOM, testável
src/render/   Three.js: modelos voxel, tabuleiro, animações dos eventos de combate
src/game/     controlador: ecrãs, input, HUD, fluxo da partida
tests/        testes das regras (vitest)
scripts/      simulador IA-vs-IA para equilíbrio; empacotamento como página única
docs/         documento de design com as regras e hipóteses
```

## Scripts

| Comando | O quê |
| --- | --- |
| `npm test` | Testes das regras de combate |
| `npm run typecheck` | Verificação de tipos |
| `npx vite-node scripts/simulate.ts 400` | 400 partidas IA-vs-IA: duração e taxa de vitória por herói |
| `npm run artifact` | Gera `artifact/guild-tactics.html` para publicar como página |

Ver [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md) para regras, números e o que medir nos testes.

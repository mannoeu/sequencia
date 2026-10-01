# Sequência — online

Versão multiplayer do protótipo, com as regras rodando no servidor e um cliente HTML único.

## Rodar

```bash
npm install
npm start
# abra http://localhost:3000 em cada navegador (ou em abas diferentes para testar)
```

Para jogar com gente fora da sua rede, exponha a porta 3000 (ngrok, Cloudflare Tunnel, etc.) ou suba em qualquer host Node.

## Como funciona

- Cada pessoa informa um **nome** e uma **sala** (vazio = `mesa`). Quem entra primeiro é o anfitrião.
- A sala precisa de **3 a 8 jogadores**; só o anfitrião vê o botão **Iniciar partida**.
- Baralho da mão: 0–9 × 6 (60 cartas), 5 por jogador. Segredo: cartas douradas 0–9 sem repetição, 4/5/6 posições conforme o número de jogadores.
- Rodada: na ordem a partir do marcador **1º** (gira a cada rodada), cada um escolhe uma carta e anuncia um número (verdade ou blefe). Depois tudo é revelado: repetidos são descartados e compram 1; únicos voltam para a mão e investigam uma posição do Segredo. Se o número da carta investigada saiu na rodada, ela é revelada (+1); senão só quem olhou sabe (o cliente marca essas posições com borda tracejada só para você).
- **Chute**: só antes da primeira carta da rodada, uma vez por rodada, quem clicar primeiro. A conferência é privada: errou, sai com zero pontos; acertou, +1 por carta e +4.
- Fim: todas as cartas reveladas (+4 para quem fechou), ou monte vazio e alguém sem cartas, ou menos de 2 jogadores. Repetidas na mão valem −1 cada; cartas ocultas não valem para ninguém.
- Quem cair da conexão pode voltar entrando com o **mesmo nome** na mesma sala.

## Estrutura

```
server.js          servidor HTTP estático + WebSocket com toda a lógica
public/index.html  cliente (HTML, CSS e JS num arquivo só)
```

Estado é mantido em memória; reiniciar o servidor apaga as salas.

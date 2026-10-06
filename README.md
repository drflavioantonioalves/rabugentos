# Rabugentos — Futebol e Resenha

App para a resenha entre amigos: **uma sala por jogo**, um link, e **todo mundo igual** (sem organizador, sem código, sem cadastro). Placar ao vivo, times separados, votação do craque e do bagre, mural e um cartão da noite em imagem. A sala **some sozinha em 7 dias** (pode ficar até 14).

Identidade visual: escudo do grupo (preto e amarelo `#FADE70`) em `public/logo.png`. Para trocar o escudo, substitua `logo.png`, `favicon.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` e `og.png` (prévia do WhatsApp, 1200x630).

## Como funciona
1. **Criar a sala com 1 toque** (`/`). Nome, times e formato são opcionais ("Personalizar"): o padrão é *Pelada de hoje*, Azul x Laranja, 2 tempos de 30. Formatos: 2x30, 1x60, 1x40, personalizado ou sem relógio.
2. **Mandar o link no grupo.** Quem abre escolhe o **apelido** e o **time** (2 toques) ou "só assisto".
3. **Quem está sem celular** é adicionado por qualquer pessoa (aba *Times* → **+ jogador**). Se ele entrar depois com o mesmo nome, assume o próprio lugar.
4. **Qualquer um da sala** começa, pausa e encerra o jogo, marca gols, move jogadores, sorteia os times e abre a votação. Para não virar bagunça: ações importantes pedem confirmação, há **Desfazer** (gol e fase do jogo) e um **histórico de quem fez o quê**.
5. **Gol de 1 toque:** um botão grande por time. Depois aparece "Quem fez?" só com os jogadores daquele time (opcional) e **Desfazer**. Se dois gols do mesmo time chegam em menos de 1 minuto, o app pergunta **"Será o mesmo gol?"**. O ⋯ abre as opções (gol contra, escolher o jogador antes).
6. **Votação:** craque, bagre, frangueiro, garçom e maior zoeira; candidatos separados por time; **ninguém vota em si mesmo**; resultado revelado quando alguém tocar em "Revelar".
7. **Sair sem querer:** o botão voltar e o logo perguntam "Sair da sala?". Fechar ou atualizar a página também avisa (alguns navegadores de celular limitam isso). A sala continua no ar e aparece em "Minhas salas". Dá para **adicionar à tela inicial** do celular (abre como app, sem barra de endereço).
8. **Cartão da noite:** imagem do jogo para o WhatsApp (gere antes da sala expirar).

## Rodar no computador
```
npm install
npm start
```
Abra http://localhost:3000

## Publicar no Render (grátis)
1. Suba esta pasta para um repositório no GitHub (os arquivos na raiz, com a pasta `public`).
2. No Render: New → Web Service → escolha o repositório (se não aparecer, use **Configure account** para liberar o acesso). Build: `npm install`; Start: `npm start`; Plan: Free.
3. Opcional: variável `CREATE_KEY` (uma senha): só quem souber consegue **criar** salas (entrar e usar continua livre).
4. Recomendado: configure o Upstash (abaixo). Use também o UptimeRobot em `/health` (a cada 5 min).

## Não perder os dados quando o Render reiniciar (recomendado, 5 minutos)
O Render grátis **reinicia sozinho** e apaga a memória e o disco. Para a sala sobreviver, o app grava cada sala no **Upstash Redis** (grátis: 256 MB e 500 mil comandos por mês; um jogo usa cerca de mil).
1. Crie uma conta grátis em **upstash.com** → **Create Database** (Redis) → plano **Free**.
2. Na aba **REST API**, copie `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`.
3. No Render: serviço → **Environment** → adicione as duas variáveis (Key e Value) → **Save**.
4. Confira `https://SEU-SITE.onrender.com/health`: deve mostrar `"protected": true` (e o menu ⋯ da sala mostra "Dados protegidos").

As mudanças são gravadas a cada ~4 s; ao receber o aviso de desligamento do Render o app grava tudo antes de sair; ao iniciar, recupera as salas (mesmo código, times, placar, relógio, votos). Se o Upstash sair do ar, o app continua e tenta de novo. Enquanto houver salas, o app chama o próprio `/health` a cada 10 min para não dormir.

## Limites (de propósito, para ser simples)
- **Sem o Upstash** a sala fica só na memória do servidor: se ele reiniciar, ela some. Quem criou a sala tem uma cópia no celular (atualizada a cada 30 s) e vê o botão **Restaurar a sala**; também há backup em arquivo (menu ⋯).
- Como todos têm os mesmos poderes, quem tem o link pode mexer em tudo (inclusive apagar a sala, que exige digitar APAGAR). O código da sala é difícil de adivinhar e quase tudo tem Desfazer.
- Sem contas, ranking nem histórico entre jogos.

## Testes
`npm test`: (1) percorre criação em 1 toque, times, jogadores sem celular, gols (com pergunta de duplicidade), fases do jogo, votação (sem voto em si mesmo), mural, histórico, backup/restauração e tempo real; (2) simula o Upstash, derruba o servidor no meio do jogo e confere que tudo volta.

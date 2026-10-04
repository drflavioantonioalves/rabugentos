# Rabugentos — Futebol e Resenha

Identidade visual: escudo do grupo (preto e amarelo `#FADE70`) em `public/logo.png`. Para trocar o escudo, substitua `logo.png`, `favicon.png`, `apple-touch-icon.png`, `icon-512.png` e `og.png` (imagem de prévia do WhatsApp, 1200x630).

App para a resenha entre amigos depois do jogo (e durante a semana). Cada jogo é uma **sala temporária**: placar ao vivo, votações (craque, bagre, frangueiro, garçom, maior zoeira), mural com reações e um **cartão da noite** em imagem. A sala **some sozinha em 7 dias** (o organizador pode ampliar até 14). Sem cadastro, sem histórico.

## Como funciona
- `/` criar sala (nome, data, campo, times, formato: 2x30, 1x60, 1x40, personalizado ou sem relógio) ou entrar com o código.
- `/s/CODIGO` a sala. Todos veem em tempo real (Socket.IO).
- **Organizador:** quem cria a sala recebe o *link do organizador* (guarde!). Controla relógio, jogadores, votação, mural e marcadores.
- **Marcadores** (goleiros, espectador oficial): entram pelo *link de marcador* ou digitando o código e podem marcar gols. Opcional: "qualquer um pode marcar".
- **Gol de 1 toque (modo quadra):** quem anota (marcador ou organizador) vê dois botões grandes no rodapé, um por time. Um toque registra o gol; logo aparece "Quem fez?" com os nomes (opcional) e o botão **Desfazer**. A tela do celular fica ligada. O ⋯ abre as opções detalhadas (gol contra, escolher jogador antes).
- **Gol duplicado:** se dois gols do mesmo time chegam em menos de 1 minuto, o app pergunta "Será o mesmo gol?" antes de registrar.
- **VAR:** qualquer pessoa contesta um gol; o organizador valida ou anula.
- **Cartão da noite:** imagem do jogo para o WhatsApp (gere antes da sala expirar).

## Rodar no computador
```
npm install
npm start
```
Abra http://localhost:3000

## Publicar no Render (grátis) — serviço separado
1. Suba esta pasta para um repositório novo no GitHub (ex.: `rabugentos`).
2. No Render: New → Blueprint (usa o `render.yaml`) ou New → Web Service (Build: `npm install`, Start: `npm start`, Plan: Free).
3. Opcional: crie a variável `CREATE_KEY` (uma senha). Se existir, só quem souber a senha consegue **criar** salas (entrar e usar continua livre).
4. Use o UptimeRobot em `/health` a cada 5 min para o serviço não dormir.

## Não perder os dados quando o Render reiniciar (recomendado, 5 minutos)
O Render grátis **reinicia sozinho** (atualizações, manutenção, depois de dormir) e apaga a memória e o disco. Para a sala sobreviver, o app grava cada sala no **Upstash Redis** (grátis: 256 MB e 500 mil comandos por mês; um jogo usa cerca de mil).

1. Crie uma conta grátis em **upstash.com** e clique em **Create Database** (Redis). Nome: `rabugentos`. Escolha a região mais próxima e o plano **Free**.
2. Na página do banco, aba **REST API**, copie **UPSTASH_REDIS_REST_URL** e **UPSTASH_REDIS_REST_TOKEN** (o token normal, não o "read only").
3. No Render, abra o serviço → **Environment** → adicione as duas variáveis com esses valores → **Save** (o serviço reinicia sozinho).
4. Confira: abra `https://SEU-SITE.onrender.com/health`. Deve mostrar `"protected": true`. No painel do organizador (⚙️ → Sala e backup) aparece "💾 Dados protegidos".

Como funciona: as mudanças são gravadas a cada ~4 segundos; ao receber o aviso de desligamento do Render, o app grava tudo antes de sair; ao iniciar, recupera as salas (mesmo código, placar, relógio, chaves e votos). Se o Upstash sair do ar, o app continua funcionando e tenta gravar de novo (o `/health` e o painel avisam).

**Para o serviço não dormir:** enquanto houver salas, o app chama o próprio `/health` a cada 10 min. Para acordar depois de um período sem nenhuma sala, use também o UptimeRobot em `/health` (a cada 5 min).

## Limites (de propósito, para ser simples)
- **Sem o Upstash**, as salas ficam só na memória do servidor: se o Render reiniciar, a sala some. O celular do organizador guarda uma cópia sozinho (a cada 30 s) e mostra o botão **Restaurar a sala**; também há backup em arquivo.
- **Com o Upstash**, um reinício custa no máximo os últimos ~4 segundos de mudanças, e só se o servidor cair de forma abrupta (sem avisar).
- Não há contas, ranking nem histórico entre jogos. A sala some em 7 dias (até 14 se ampliada).
- Filtro de palavrões é opcional por sala (padrão: desligado, é resenha entre amigos).

## Teste automático
`npm test` — (1) percorre criação de sala, relógio, gols (com confirmação de duplicidade), VAR, votação, mural, backup/restauração e tempo real; (2) simula o Upstash, derruba o servidor no meio do jogo e confere que tudo volta.

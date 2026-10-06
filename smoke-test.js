'use strict';
// Teste do Rabugentos (sala aberta: qualquer pessoa administra a partida).
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const os = require('os');
const path = require('path');

const PORT = 4999;
const BASE = `http://localhost:${PORT}`;
let failed = 0, n = 0;
function check(name, cond, extra) {
  n++;
  console.log((cond ? 'OK   ' : 'FALHA') + ' - ' + name + (cond ? '' : ' ' + (extra || '')));
  if (!cond) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipn = 1;
async function call(method, url, body, headers) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.' + (ipn++ % 250) }, headers || {}), body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (e) {}
  return { status: r.status, json };
}

(async () => {
  const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_FILE: path.join(os.tmpdir(), 'rab-test-' + Date.now() + '.json') }, stdio: 'inherit' });
  try {
    for (let i = 0; i < 30; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch (e) {} await sleep(200); }
    check('/health responde', (await call('GET', '/health')).json.ok === true);
    check('página inicial carrega', (await fetch(BASE + '/')).status === 200);
    check('config pública', (await call('GET', '/api/config')).json.needsCreateKey === false);

    // ---- criar sala em 1 toque (nada obrigatório)
    let r = await call('POST', '/api/rooms', {});
    const code = r.json.code;
    check('sala criada SEM preencher nada', r.json.ok && /^[A-Z2-9]{5}$/.test(code));
    check('resposta não tem chave de organizador nem códigos', Object.keys(r.json).sort().join() === 'code,ok');
    r = await call('GET', `/api/rooms/${code}`);
    const room0 = r.json.room;
    check('padrões: "Pelada de hoje", Azul x Laranja, 2 tempos de 30', room0.title === 'Pelada de hoje' && room0.teams.a === 'Azul' && room0.teams.b === 'Laranja' && room0.format.halves === 2 && room0.format.minutes === 30);
    check('sala inexistente -> 404', (await call('GET', '/api/rooms/ZZZZZ')).status === 404);
    check('formato inválido -> 400', (await call('POST', '/api/rooms', { preset: 'xyz' })).status === 400);
    check('página da sala carrega', (await fetch(BASE + '/s/' + code)).status === 200);

    const act = (cid, body) => call('POST', `/api/rooms/${code}/do`, Object.assign({ clientId: cid, nickname: cid.toUpperCase() }, body));
    check('ação sem apelido -> 400', (await call('POST', `/api/rooms/${code}/do`, { clientId: 'x1', action: 'start' })).status === 400);
    check('...e a ação recusada NÃO alterou a sala (o jogo continua "antes do jogo")', (await call('GET', `/api/rooms/${code}`)).json.room.status === 'pre');
    check('ação desconhecida -> 400', (await act('beto', { action: 'hackear' })).status === 400);

    // ---- entrar na sala e escolher o time (cada um com o próprio celular)
    r = await act('beto', { action: 'join', team: 'a' });
    check('Beto entra no Azul', r.json.ok && r.json.me.team === 'a' && r.json.me.name === 'BETO');
    r = await act('zeca', { action: 'join', team: 'b' });
    check('Zeca entra no Laranja', r.json.ok && r.json.me.team === 'b');
    r = await act('outro', { action: 'join', team: 'a', nickname: 'beto' });
    check('apelido repetido (outro celular) -> 400', r.status === 400);
    r = await call('POST', `/api/rooms/${code}/me`, { clientId: 'beto' });
    check('cada celular sabe quem é (meu jogador)', r.json.me.name === 'BETO' && r.json.me.team === 'a');
    r = await call('POST', `/api/rooms/${code}/me`, { clientId: 'desconhecido' });
    check('quem só assiste não tem jogador', r.json.me === null);
    await act('lia', { action: 'join', team: 'a' });
    r = await act('lia', { action: 'join', team: null });
    check('"Só assisto" tira a pessoa dos times', r.json.ok && r.json.me === null);
    r = await call('GET', `/api/rooms/${code}`);
    check('lista de jogadores: Beto (Azul) e Zeca (Laranja)', r.json.room.players.map((p) => p.name + p.team).join() === 'BETOa,ZECAb');

    // ---- jogador SEM celular (adicionado por outra pessoa)
    r = await act('beto', { action: 'player_add', name: 'Seu Zé', team: 'b' });
    check('adicionar jogador sem celular', r.json.ok);
    check('nome repetido ao adicionar -> 400', (await act('beto', { action: 'player_add', name: 'seu zé', team: 'a' })).status === 400);
    r = await call('GET', `/api/rooms/${code}`);
    const zeId = r.json.room.players.find((p) => p.name === 'Seu Zé').id;
    check('jogador sem celular é marcado como "sem celular"', r.json.room.players.find((p) => p.id === zeId).phone === false);
    r = await act('ze', { action: 'join', team: 'b', nickname: 'seu zé' });
    check('se o Seu Zé depois entrar com celular, assume o mesmo lugar (sem duplicar)', r.json.ok && r.json.me.id === zeId);
    r = await call('GET', `/api/rooms/${code}`);
    check('...e não duplicou', r.json.room.players.filter((p) => p.name.toLowerCase() === 'seu zé').length === 1 && r.json.room.players.find((p) => p.id === zeId).phone === true);
    r = await act('beto', { action: 'player_add', name: 'Carlão', team: 'a' });
    r = await act('beto', { action: 'player_add', name: 'Lucas', team: 'a' });
    r = await call('GET', `/api/rooms/${code}`);
    const carlaoId = r.json.room.players.find((p) => p.name === 'Carlão').id;
    const lucasId = r.json.room.players.find((p) => p.name === 'Lucas').id;
    r = await act('zeca', { action: 'player_move', playerId: lucasId, team: 'b' });
    r = await act('zeca', { action: 'player_rename', playerId: lucasId, name: 'Lucão' });
    r = await call('GET', `/api/rooms/${code}`);
    check('qualquer um move e renomeia jogadores', r.json.room.players.find((p) => p.id === lucasId).team === 'b' && r.json.room.players.find((p) => p.id === lucasId).name === 'Lucão');
    check('renomear para nome existente -> 400', (await act('zeca', { action: 'player_rename', playerId: lucasId, name: 'beto' })).status === 400);
    r = await act('zeca', { action: 'player_remove', playerId: lucasId });
    r = await call('GET', `/api/rooms/${code}`);
    check('remover jogador', !r.json.room.players.some((p) => p.id === lucasId));
    r = await act('beto', { action: 'shuffle' });
    r = await call('GET', `/api/rooms/${code}`);
    const cntA = r.json.room.players.filter((p) => p.team === 'a').length, cntB = r.json.room.players.filter((p) => p.team === 'b').length;
    check('sortear times deixa equilibrado (diferença <= 1)', Math.abs(cntA - cntB) <= 1 && cntA + cntB === 4, `${cntA} x ${cntB}`);
    // volta aos times conhecidos para o resto do teste
    const betoId = (await call('POST', `/api/rooms/${code}/me`, { clientId: 'beto' })).json.me.id;
    const zecaId = (await call('POST', `/api/rooms/${code}/me`, { clientId: 'zeca' })).json.me.id;
    await act('beto', { action: 'player_move', playerId: betoId, team: 'a' }); await act('beto', { action: 'player_move', playerId: carlaoId, team: 'a' });
    await act('beto', { action: 'player_move', playerId: zecaId, team: 'b' }); await act('beto', { action: 'player_move', playerId: zeId, team: 'b' });
    check('com 1 jogador só, sortear -> 400 (testado em outra sala)', (await (async () => { const x = (await call('POST', '/api/rooms', {})).json.code; return call('POST', `/api/rooms/${x}/do`, { clientId: 'a', nickname: 'A', action: 'shuffle' }); })()).status === 400);

    // ---- relógio e fases: QUALQUER UM controla
    r = await act('lia', { action: 'pause' });
    check('pausar antes de começar -> 400', r.status === 400, r.status + ' ' + JSON.stringify(r.json));
    r = await act('lia', { action: 'start' });
    r = await call('GET', `/api/rooms/${code}`);
    check('quem só assiste (Lia) começa o jogo: 1º tempo correndo', r.json.room.status === 'h1' && r.json.room.clock.running, JSON.stringify([r.json.room.status, r.json.room.clock]));
    check('começar de novo -> 400', (await act('beto', { action: 'start' })).status === 400);
    await act('beto', { action: 'pause' });
    r = await call('GET', `/api/rooms/${code}`);
    check('pausa mostra "Jogo parado"', r.json.room.statusLabel === 'Jogo parado' && !r.json.room.clock.running);
    await act('zeca', { action: 'resume' });

    // ---- gols (1 toque, sem jogador) e "Quem fez?" depois
    r = await act('beto', { action: 'goal', team: 'a' });
    const g1 = r.json.goalId;
    check('gol de 1 toque devolve o id', r.json.ok && Number.isInteger(g1));
    r = await act('zeca', { action: 'goal', team: 'a' });
    check('segundo celular, mesmo time, em < 1 min: o app PERGUNTA se é o mesmo gol', r.json.ok === false && r.json.needConfirm === true && r.json.similar.by === 'BETO');
    r = await call('GET', `/api/rooms/${code}`);
    check('...e não registrou nada enquanto não confirmar', r.json.room.score.a === 1);
    r = await act('zeca', { action: 'goal', team: 'a', confirmNew: true, playerId: carlaoId });
    check('confirmando "é outro gol" (com autor), registra', r.json.ok);
    r = await call('GET', `/api/rooms/${code}`);
    check('placar 2 x 0, com quem anotou cada um', r.json.room.score.a === 2 && r.json.room.goals.map((g) => g.by).join() === 'BETO,ZECA' && r.json.room.goals[1].player === 'Carlão');
    r = await act('beto', { action: 'goal_edit', goalId: g1, playerId: betoId });
    r = await call('GET', `/api/rooms/${code}`);
    check('"Quem fez?" definido depois do gol', r.json.room.goals[0].player === 'BETO');
    r = await act('zeca', { action: 'goal', team: 'b', playerId: zecaId });
    check('gol do outro time não pergunta nada', r.json.ok === true);
    r = await act('lia', { action: 'goal', team: 'b', playerName: 'Visitante Novo', confirmNew: true });
    r = await call('GET', `/api/rooms/${code}`);
    const novo = r.json.room.players.find((p) => p.name === 'Visitante Novo');
    check('autor digitado na hora vira jogador do time do gol', novo && novo.team === 'b');
    r = await act('lia', { action: 'goal', team: 'a', ownGoal: true, playerName: 'Zagueiro Azarado', confirmNew: true });
    r = await call('GET', `/api/rooms/${code}`);
    check('gol contra: o autor é do time ADVERSÁRIO e o gol vale pro time escolhido', r.json.room.players.find((p) => p.name === 'Zagueiro Azarado').team === 'b' && r.json.room.goals.slice(-1)[0].ownGoal === true && r.json.room.score.a === 3);
    const lastGoal = r.json.room.goals.slice(-1)[0].id;
    r = await act('beto', { action: 'goal_undo', goalId: lastGoal });
    check('qualquer um desfaz um gol', r.json.ok);
    r = await call('GET', `/api/rooms/${code}`);
    check('desfazer corrige o placar (2 x 2)', r.json.room.score.a === 2 && r.json.room.score.b === 2, JSON.stringify(r.json.room.score));
    check('gol de jogador inexistente -> 400', (await act('beto', { action: 'goal', team: 'a', playerId: 99999, confirmNew: true })).status === 400);
    check('gol sem escolher time -> 400', (await act('beto', { action: 'goal' })).status === 400);
    check('gol com o jogo rodando guarda o minuto', r.json.room.goals[0].minute === 1);

    // ---- fases
    r = await act('beto', { action: 'break' });
    r = await act('zeca', { action: 'second' });
    r = await call('GET', `/api/rooms/${code}`);
    check('2º tempo recomeça em 30:00', r.json.room.status === 'h2' && r.json.room.clock.seconds >= 1800 && r.json.room.clock.seconds < 1810);
    r = await act('lia', { action: 'finish' });
    r = await call('GET', `/api/rooms/${code}`);
    check('fim de jogo', r.json.room.status === 'finished' && !r.json.room.clock.running);
    check('"Desfazer" disponível logo após encerrar por engano', r.json.room.undoPhase.available && r.json.room.undoPhase.label === 'Encerrar o jogo');
    r = await act('beto', { action: 'undo_phase' });
    r = await call('GET', `/api/rooms/${code}`);
    check('desfazer o encerramento volta ao 2º tempo com relógio correndo', r.json.room.status === 'h2' && r.json.room.clock.running === true);
    await act('beto', { action: 'finish' });

    // ---- votação (candidatos = jogadores dos times)
    const vote = (cid, category, playerId) => act(cid, { action: 'vote', category, playerId });
    check('votar com a votação fechada -> 400', (await vote('beto', 'craque', betoId)).status === 400);
    const emptyRoom = (await call('POST', '/api/rooms', {})).json.code;
    check('abrir votação sem jogadores -> 400', (await call('POST', `/api/rooms/${emptyRoom}/do`, { clientId: 'q', nickname: 'Q', action: 'votes_open' })).status === 400);
    await act('lia', { action: 'votes_open' });
    check('voto em jogador que não existe -> 400', (await vote('beto', 'craque', 424242)).status === 400);
    check('categoria inválida -> 400', (await vote('beto', 'xyz', betoId)).status === 400);
    r = await vote('beto', 'craque', betoId);
    check('NÃO pode votar em si mesmo (400)', r.status === 400 && /você mesmo/.test(r.json.error), JSON.stringify(r.json));
    r = await call('POST', `/api/rooms/${code}/me`, { clientId: 'beto' });
    check('...e o voto em si mesmo não foi guardado', !r.json.myVotes.craque);
    await vote('beto', 'craque', zecaId); await vote('zeca', 'craque', betoId); await vote('lia', 'craque', betoId);
    r = await vote('lia', 'craque', zecaId);
    check('mudar o voto vale (uma vez por pessoa)', r.json.ok && r.json.myVotes.craque === zecaId);
    await vote('beto', 'bagre', carlaoId); await vote('zeca', 'bagre', zeId);
    r = await call('GET', `/api/rooms/${code}`);
    check('antes de revelar: só a contagem, sem resultados', r.json.room.votes.results === null && r.json.room.votes.voters.craque === 3);
    r = await call('POST', `/api/rooms/${code}/me`, { clientId: 'beto' });
    check('cada pessoa recupera os próprios votos', r.json.myVotes.craque === zecaId && r.json.myVotes.bagre === carlaoId);
    r = await act('zeca', { action: 'votes_reveal' });
    r = await call('GET', `/api/rooms/${code}`);
    check('revelar: craque = Zeca e Beto empatados em 2 votos? (Zeca 2 x Beto 1)', r.json.room.votes.results.craque.winners.join() === 'ZECA', JSON.stringify(r.json.room.votes.results.craque));
    check('resultado traz o time de cada jogador (para colorir)', r.json.room.votes.results.craque.list[0].team === 'b');
    check('empate no bagre mostra os dois', r.json.room.votes.results.bagre.winners.sort().join() === 'Carlão,Seu Zé');
    check('votar depois de revelar -> 400', (await vote('beto', 'craque', betoId)).status === 400);
    await act('beto', { action: 'votes_reset' });
    await act('beto', { action: 'votes_open' });
    await vote('beto', 'frangueiro', zeId);
    await act('beto', { action: 'player_remove', playerId: zeId });
    r = await call('GET', `/api/rooms/${code}`);
    check('remover um jogador remove também os votos nele', r.json.room.votes.voters.frangueiro === 0);

    // ---- voto num jogador sem celular que depois "assume" o próprio lugar: o voto em si mesmo cai
    const room3 = (await call('POST', '/api/rooms', {})).json.code;
    const a3 = (cid, body) => call('POST', `/api/rooms/${room3}/do`, Object.assign({ clientId: cid, nickname: cid }, body));
    await a3('p1', { action: 'join', team: 'a' }); await a3('p1', { action: 'player_add', name: 'Tonho', team: 'b' }); await a3('p1', { action: 'votes_open' });
    const tonhoId = (await call('GET', `/api/rooms/${room3}`)).json.room.players.find((p) => p.name === 'Tonho').id;
    r = await a3('tonho', { action: 'vote', category: 'craque', playerId: tonhoId });
    check('antes de ter celular, o "Tonho" (alguém por ele) vota no Tonho: permitido (ainda não é ele)', r.json.ok === true);
    await a3('tonho', { action: 'join', team: 'b', nickname: 'tonho' });
    r = await call('POST', `/api/rooms/${room3}/me`, { clientId: 'tonho' });
    check('ao assumir o lugar do Tonho, o voto em si mesmo é descartado', r.json.me && r.json.me.id === tonhoId && !r.json.myVotes.craque, JSON.stringify(r.json));

    // ---- mural
    const cm = (cid, text) => act(cid, { action: 'comment', text });
    check('comentário publicado', (await cm('c1', 'Que jogão!')).json.ok);
    check('comentário seguido muito rápido -> 400', (await cm('c1', 'de novo')).status === 400);
    check('comentário vazio -> 400', (await cm('c2', '   ')).status === 400);
    r = await call('GET', `/api/rooms/${code}`);
    const cid1 = r.json.room.comments[0].id;
    await act('c1', { action: 'react', commentId: cid1, emoji: '😂' }); await act('c2', { action: 'react', commentId: cid1, emoji: '😂' }); await act('c2', { action: 'react', commentId: cid1, emoji: '🔥' });
    r = await call('GET', `/api/rooms/${code}`);
    check('reações contadas por pessoa', r.json.room.comments[0].reactions['😂'].length === 2 && r.json.room.comments[0].reactions['🔥'].length === 1);
    await act('c2', { action: 'react', commentId: cid1, emoji: '😂' });
    r = await call('GET', `/api/rooms/${code}`);
    check('tocar de novo remove a própria reação', r.json.room.comments[0].reactions['😂'].length === 1);
    check('reação inválida -> 400', (await act('c2', { action: 'react', commentId: cid1, emoji: '💣' })).status === 400);
    r = await act('c3', { action: 'comment_delete', commentId: cid1 });
    r = await call('GET', `/api/rooms/${code}`);
    check('qualquer um apaga comentário', r.json.room.comments.length === 0);

    // ---- histórico ("quem fez o quê")
    const logTxt = r.json.room.log.map((l) => l.who + ' ' + l.text).join(' | ');
    check('histórico registra quem começou o jogo', /LIA começou o jogo/.test(logTxt));
    check('histórico registra gols e quem anotou', /BETO marcou gol do Azul/.test(logTxt) && /desfez um gol/.test(logTxt));
    check('histórico registra entradas nos times', /ZECA entrou no Laranja/.test(logTxt));

    // ---- formatos
    r = await call('POST', '/api/rooms', { preset: 'noclock', title: 'Sem relógio' });
    const nc = r.json.code;
    await call('POST', `/api/rooms/${nc}/do`, { clientId: 'x', nickname: 'X', action: 'start' });
    r = await call('GET', `/api/rooms/${nc}`);
    check('sala sem relógio: começa em "live" sem cronômetro', r.json.room.status === 'live' && !r.json.room.clock.running && r.json.room.format.clock === false);
    r = await call('POST', '/api/rooms', { preset: 'custom', halves: 2, minutes: 20 });
    const cu = r.json.code;
    const cact = (b) => call('POST', `/api/rooms/${cu}/do`, Object.assign({ clientId: 'x', nickname: 'X' }, b));
    await cact({ action: 'start' }); await cact({ action: 'break' }); r = await cact({ action: 'second' });
    r = await call('GET', `/api/rooms/${cu}`);
    check('personalizado 2x20: 2º tempo recomeça em 20:00', r.json.room.clock.seconds >= 1200 && r.json.room.clock.seconds < 1210);
    await cact({ action: 'setup', preset: '1x40', title: 'Renomeado', teamA: 'Verdes', teamB: 'Rosas' });
    r = await call('GET', `/api/rooms/${cu}`);
    check('qualquer um muda nome, times e formato', r.json.room.format.minutes === 40 && r.json.room.title === 'Renomeado' && r.json.room.teams.a === 'Verdes');
    check('zerar o jogo exige confirmação', (await cact({ action: 'reset_game' })).status === 400);
    await cact({ action: 'goal', team: 'a' });
    await cact({ action: 'reset_game', confirm: true });
    r = await call('GET', `/api/rooms/${cu}`);
    check('zerar o jogo limpa gols e volta ao início', r.json.room.status === 'pre' && r.json.room.goals.length === 0);

    // ---- duração, backup, restauração e migração de sala antiga
    r = await act('beto', { action: 'extend' });
    r = await call('GET', `/api/rooms/${code}`);
    check('ampliar a sala: ~9 dias', r.json.room.expiresAt - Date.now() > 8.9 * 86400000 && r.json.room.expiresAt - Date.now() < 9.1 * 86400000);
    for (let i = 0; i < 6; i++) await act('beto', { action: 'extend' });
    r = await call('GET', `/api/rooms/${code}`);
    check('duração máxima de 14 dias', r.json.room.expiresAt - Date.now() <= 14 * 86400000 + 1000);
    r = await call('GET', `/api/rooms/${code}/backup`);
    const backup = r.json.room;
    check('backup traz a sala completa (jogadores, gols, votos)', r.json.ok && backup.players.length === 5 && backup.goals.length === 4);
    check('apagar sem a palavra APAGAR -> 400', (await act('beto', { action: 'delete_room', confirm: true })).status === 400);
    r = await act('beto', { action: 'delete_room', confirm: 'APAGAR' });
    check('apagar a sala (digitando APAGAR)', r.json.deleted === true && (await call('GET', `/api/rooms/${code}`)).status === 404);
    r = await call('POST', '/api/rooms/restore', { room: backup });
    check('restaura a sala com o MESMO código', r.json.ok && r.json.code === code);
    r = await call('GET', `/api/rooms/${code}`);
    check('sala restaurada mantém times, gols, placar e histórico', r.json.room.players.length === 5 && r.json.room.score.a === 2 && r.json.room.score.b === 2 && r.json.room.log.length > 5);
    r = await call('POST', `/api/rooms/${code}/me`, { clientId: 'beto' });
    check('cada pessoa continua no seu time depois de restaurar', r.json.me && r.json.me.name === 'BETO');
    check('restaurar sala que já existe -> 409', (await call('POST', '/api/rooms/restore', { room: backup })).status === 409);
    const old = { code: 'AAAA2', adminKey: 'chave-velha-xyz', scorerCode: 'XYZ12', title: 'Jogo antigo', teams: { a: 'A', b: 'B' }, expiresAt: Date.now() + 86400000, format: { halves: 2, minutes: 30, clock: true }, status: 'finished',
      roster: ['Beto'], goals: [{ id: 1, team: 'a', player: 'Beto', byName: 'Org', status: 'ok' }, { id: 2, team: 'b', player: 'X', status: 'annulled' }] };
    r = await call('POST', '/api/rooms/restore', { room: old });
    check('sala do formato antigo é migrada (gol anulado some, autor vira texto)', r.json.ok);
    r = await call('GET', '/api/rooms/AAAA2');
    check('...com 1 gol, autor "Beto" e sem chaves antigas', r.json.room.goals.length === 1 && r.json.room.goals[0].player === 'Beto' && !JSON.stringify(r.json).includes('chave-velha-xyz'));
    check('backup inválido é recusado', (await call('POST', '/api/rooms/restore', { room: { code: 'x' } })).status === 400);
    const exp = JSON.parse(JSON.stringify(backup)); exp.code = 'BBBB2'; exp.expiresAt = Date.now() - 1000;
    check('backup de sala expirada -> 410', (await call('POST', '/api/rooms/restore', { room: exp })).status === 410);

    // ---- QR e tempo real
    const qr = await fetch(BASE + '/qr/' + code + '.svg');
    check('QR Code da sala', qr.status === 200 && (await qr.text()).includes('<svg'));
    const sock = io(BASE, { auth: { room: code } });
    let last = null, goneSeen = false;
    sock.on('room', (rm) => (last = rm)); sock.on('gone', () => (goneSeen = true));
    await sleep(800);
    check('Socket.IO entrega o estado da sala', last && last.code === code);
    await act('beto', { action: 'goal', team: 'b', confirmNew: true });
    await sleep(300);
    check('gol chega em tempo real para quem está na sala', last.score.b === 3);
    await act('c9', { action: 'comment', text: 'tempo real' });
    await sleep(300);
    check('comentário novo chega em tempo real', last.comments.some((c) => c.text === 'tempo real'));
    check('contagem de pessoas na sala', last.viewers >= 1);
    await act('beto', { action: 'delete_room', confirm: 'APAGAR' });
    await sleep(300);
    check('sala apagada avisa quem está dentro', goneSeen);
    sock.close();
    const s2 = io(BASE, { auth: { room: 'NAOEXISTE' } }); let g2s = false; s2.on('gone', () => (g2s = true)); await sleep(400);
    check('conectar em sala inexistente avisa que sumiu', g2s); s2.close();

    // ---- limite de criação por IP
    let blocked = false;
    for (let i = 0; i < 16; i++) { const x = await fetch(BASE + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '9.9.9.9' }, body: '{}' }); if (x.status === 400) blocked = true; }
    check('limite de salas criadas por IP', blocked);
  } catch (e) {
    console.error('Erro no teste:', e);
    failed++;
  } finally {
    srv.kill();
  }
  console.log(failed ? `\n${failed} de ${n} verificação(ões) FALHARAM` : `\nTodas as ${n} verificações passaram.`);
  process.exit(failed ? 1 : 0);
})();

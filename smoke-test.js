'use strict';
// Teste de fumaça do Rabugentos: sobe o servidor e percorre o fluxo de uma sala.
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

    // ---- criar sala
    check('formato inválido -> 400', (await call('POST', '/api/rooms', { title: 'x', preset: 'xyz' })).status === 400);
    check('personalizado inválido -> 400', (await call('POST', '/api/rooms', { preset: 'custom', halves: 3, minutes: 30 })).status === 400);
    let r = await call('POST', '/api/rooms', { title: 'Pelada de quinta', venue: 'Society do Zé', teamA: 'Azul', teamB: 'Laranja', preset: '2x30' });
    const { code, adminKey, scorerCode } = r.json;
    check('sala criada com código, chave do organizador e código de marcador', r.json.ok && /^[A-Z2-9]{5}$/.test(code) && adminKey.length >= 12 && scorerCode.length === 5);
    const adm = (body) => call('POST', `/api/rooms/${code}/admin`, Object.assign({ adminKey }, body));
    const goal = (body) => call('POST', `/api/rooms/${code}/goal`, body);

    r = await call('GET', `/api/rooms/${code}`);
    check('sala pública não revela chaves', r.json.ok && !JSON.stringify(r.json).includes(adminKey) && !JSON.stringify(r.json).includes(scorerCode));
    check('sala inexistente -> 404', (await call('GET', '/api/rooms/ZZZZZ')).status === 404);
    check('página da sala carrega com o título', (await (await fetch(BASE + '/s/' + code)).text()).includes('Pelada de quinta'));

    // ---- papéis
    r = await call('POST', `/api/rooms/${code}/role`, { adminKey, clientId: 'c1' });
    check('organizador reconhecido (e recebe o código de marcador)', r.json.admin && r.json.scorer && r.json.scorerCode === scorerCode);
    r = await call('POST', `/api/rooms/${code}/role`, { scorerCode: scorerCode.toLowerCase() });
    check('código de marcador reconhecido (sem diferenciar maiúsculas)', !r.json.admin && r.json.scorer);
    r = await call('POST', `/api/rooms/${code}/role`, { adminKey: 'errada', scorerCode: 'XXXXX' });
    check('chaves erradas não dão acesso', !r.json.admin && !r.json.scorer);
    check('ação de organizador sem chave -> 401', (await call('POST', `/api/rooms/${code}/admin`, { action: 'ping', adminKey: 'errada' })).status === 401);

    // ---- gols: permissão
    check('gol sem código de marcador -> 403', (await goal({ clientId: 'v1', nickname: 'Visitante', team: 'a', player: 'Beto' })).status === 403);

    // ---- relógio 2x30
    check('pausar antes de começar -> 400', (await adm({ action: 'pause' })).status === 400);
    r = await adm({ action: 'start' });
    check('começa o jogo (1º tempo, relógio correndo)', r.json.room.status === 'h1' && r.json.room.clock.running);
    r = await adm({ action: 'pause' });
    check('pausa: relógio para e mostra "Jogo parado"', !r.json.room.clock.running && r.json.room.statusLabel === 'Jogo parado');
    r = await adm({ action: 'resume' });
    check('retoma o relógio', r.json.room.clock.running);

    // ---- marcador + confirmação de gol duplicado
    r = await goal({ clientId: 'gk1', nickname: 'Goleiro Beto', scorerCode, team: 'a', player: 'Zé' });
    check('marcador registra gol', r.json.ok);
    r = await goal({ clientId: 'esp1', nickname: 'Espectador', scorerCode, team: 'a', player: 'Zé' });
    check('segundo marcador, mesmo time em < 1 min: o app PERGUNTA se é o mesmo gol', r.json.ok === false && r.json.needConfirm === true && r.json.similar.by === 'Goleiro Beto' && r.json.similar.player === 'Zé');
    r = await call('GET', `/api/rooms/${code}`);
    check('...e não registrou nada enquanto não confirmar', r.json.room.score.a === 1);
    r = await goal({ clientId: 'esp1', nickname: 'Espectador', scorerCode, team: 'a', player: 'Zé', confirmNew: true });
    check('confirmando "é outro gol", registra', r.json.ok);
    r = await call('GET', `/api/rooms/${code}`);
    check('placar 2 x 0 (dois gols distintos, anotados por pessoas diferentes)', r.json.room.score.a === 2 && r.json.room.goals.map((g) => g.by).join() === 'Goleiro Beto,Espectador');
    r = await goal({ clientId: 'esp1', nickname: 'Espectador', scorerCode, team: 'b', player: 'Carlão' });
    check('gol do OUTRO time não pergunta nada', r.json.ok === true);
    check('gol sem escolher time -> 400', (await goal({ clientId: 'gk1', nickname: 'x', scorerCode })).status === 400);
    check('gol sem apelido -> 400', (await goal({ clientId: 'gk1', scorerCode, team: 'a' })).status === 400);
    r = await call('GET', `/api/rooms/${code}`);
    check('jogadores dos gols entram sozinhos na lista', ['Zé', 'Carlão'].every((x) => r.json.room.roster.includes(x)));
    const gid = r.json.room.goals[0].id;
    check('gol marcado com o relógio correndo guarda o minuto', r.json.room.goals[0].minute === 1);

    // ---- desfazer
    r = await call('POST', `/api/rooms/${code}/goal/undo`, { clientId: 'outro', goalId: gid });
    check('quem não anotou não pode desfazer o gol', r.status === 400);
    r = await call('POST', `/api/rooms/${code}/goal/undo`, { clientId: 'gk1', goalId: gid });
    check('quem anotou pode desfazer o próprio gol', r.json.ok);
    r = await call('GET', `/api/rooms/${code}`);
    check('desfazer corrige o placar (1 x 1)', r.json.room.score.a === 1 && r.json.room.score.b === 1);

    // ---- VAR
    const g2 = r.json.room.goals[0].id;
    r = await call('POST', `/api/rooms/${code}/var`, { clientId: 'torcedor1', goalId: g2 });
    check('qualquer um aciona o VAR', r.json.ok);
    r = await call('GET', `/api/rooms/${code}`);
    check('gol fica "em análise" mas ainda conta', r.json.room.goals[0].status === 'contested' && r.json.room.goals[0].varCount === 1 && r.json.room.score.a === 1);
    r = await adm({ action: 'resolve_goal', id: g2, decision: 'annul' });
    check('organizador anula: placar corrige (0 x 1)', r.json.room.score.a === 0 && r.json.room.goals[0].status === 'annulled');
    check('VAR em gol anulado -> 400', (await call('POST', `/api/rooms/${code}/var`, { clientId: 't2', goalId: g2 })).status === 400);
    r = await adm({ action: 'delete_goal', id: g2 });
    r = await adm({ action: 'start' }).catch(() => ({}));

    // ---- gol rápido (1 toque, sem jogador) e "quem fez?" depois
    r = await goal({ clientId: 'quick', nickname: 'Goleiro Beto', scorerCode, team: 'b', confirmNew: true });
    const qid = r.json.goalId;
    check('gol de 1 toque (sem jogador) devolve o id do gol', r.json.ok && Number.isInteger(qid));
    r = await call('POST', `/api/rooms/${code}/goal/edit`, { clientId: 'outro', goalId: qid, player: 'Lucas' });
    check('outra pessoa não pode mudar o autor do gol', r.status === 400);
    r = await call('POST', `/api/rooms/${code}/goal/edit`, { clientId: 'quick', goalId: qid, player: 'Lucas' });
    check('quem anotou define o autor depois ("Quem fez?")', r.json.ok);
    r = await call('GET', `/api/rooms/${code}`);
    check('autor aparece no gol e entra na lista de jogadores', r.json.room.goals.find((g) => g.id === qid).player === 'Lucas' && r.json.room.roster.includes('Lucas'));
    r = await call('POST', `/api/rooms/${code}/goal/edit`, { adminKey, goalId: qid, player: 'Lucas Silva' });
    check('organizador também pode corrigir o autor', r.json.ok);
    r = await call('POST', `/api/rooms/${code}/goal/undo`, { clientId: 'quick', goalId: qid });
    check('"Desfazer" logo após o gol rápido', r.json.ok);

    // ---- gol aberto a todos
    await adm({ action: 'scoring_open', open: true });
    await sleep(100);
    r = await goal({ clientId: 'amigo', nickname: 'Amigo', team: 'b', player: 'Tonho', confirmNew: true });
    check('com "qualquer um pode marcar" ligado, amigo sem código marca gol', r.json.ok);
    await adm({ action: 'scoring_open', open: false });

    // ---- intervalo / 2º tempo / fim
    check('intervalo', (await adm({ action: 'break' })).json.room.status === 'break');
    r = await adm({ action: 'second' });
    check('2º tempo recomeça em 30:00', r.json.room.status === 'h2' && r.json.room.clock.seconds >= 1800 && r.json.room.clock.seconds < 1810);
    r = await adm({ action: 'finish' });
    check('fim de jogo', r.json.room.status === 'finished' && !r.json.room.clock.running);

    // ---- jogadores e votação
    r = await adm({ action: 'roster', text: 'Beto\nZé\nzé\nCarlão\n\nTonho' });
    check('lista de jogadores sem repetidos (Zé/zé)', r.json.room.roster.length === 4);
    const vote = (cid, category, candidate) => call('POST', `/api/rooms/${code}/vote`, { clientId: cid, category, candidate });
    check('votar com a votação fechada -> 400', (await vote('v1', 'craque', 'Beto')).status === 400);
    await adm({ action: 'votes_open', open: true });
    check('voto em jogador que não existe -> 400', (await vote('v1', 'craque', 'Fulano')).status === 400);
    check('categoria inválida -> 400', (await vote('v1', 'xyz', 'Beto')).status === 400);
    await vote('v1', 'craque', 'Beto'); await vote('v2', 'craque', 'Beto'); await vote('v3', 'craque', 'Zé');
    r = await vote('v3', 'craque', 'Beto');
    check('mudar o voto é permitido e conta uma vez só por pessoa', r.json.ok && r.json.myVotes.craque === 'Beto');
    await vote('v1', 'bagre', 'Carlão'); await vote('v2', 'bagre', 'Tonho');
    r = await call('GET', `/api/rooms/${code}`);
    check('antes de revelar: resultados escondidos, só a contagem de votantes', r.json.room.votes.results === null && r.json.room.votes.voters.craque === 3 && !JSON.stringify(r.json).includes('"count"'));
    r = await call('POST', `/api/rooms/${code}/role`, { clientId: 'v1' });
    check('cada pessoa recupera os próprios votos', r.json.myVotes.craque === 'Beto' && r.json.myVotes.bagre === 'Carlão');
    r = await adm({ action: 'votes_reveal' });
    check('revelar fecha a votação e mostra resultados', r.json.room.votes.revealed && !r.json.room.votes.open);
    check('craque = Beto com 3 votos', r.json.room.votes.results.craque.winners.join() === 'Beto' && r.json.room.votes.results.craque.list[0].count === 3);
    check('empate no bagre mostra os dois', r.json.room.votes.results.bagre.winners.sort().join() === 'Carlão,Tonho');
    check('votar depois de revelar -> 400', (await vote('v9', 'craque', 'Zé')).status === 400);

    // ---- mural
    const cm = (cid, text, name = 'Amigo') => call('POST', `/api/rooms/${code}/comment`, { clientId: cid, name, text });
    r = await cm('m1', 'Que jogão!');
    check('comentário publicado', r.json.ok);
    check('comentário seguido muito rápido -> 400', (await cm('m1', 'de novo')).status === 400);
    check('comentário vazio -> 400', (await cm('m2', '   ')).status === 400);
    r = await call('GET', `/api/rooms/${code}`);
    const cid1 = r.json.room.comments[0].id;
    const rx = (cid, emoji) => call('POST', `/api/rooms/${code}/react`, { clientId: cid, commentId: cid1, emoji });
    await rx('m1', '😂'); await rx('m2', '😂'); await rx('m2', '🔥');
    r = await call('GET', `/api/rooms/${code}`);
    check('reações contadas por pessoa', r.json.room.comments[0].reactions['😂'].length === 2 && r.json.room.comments[0].reactions['🔥'].length === 1);
    await rx('m2', '😂');
    r = await call('GET', `/api/rooms/${code}`);
    check('tocar de novo remove a própria reação', r.json.room.comments[0].reactions['😂'].length === 1);
    check('reação inválida -> 400', (await call('POST', `/api/rooms/${code}/react`, { clientId: 'm2', commentId: cid1, emoji: '💣' })).status === 400);
    check('palavrão passa com o filtro desligado (é resenha entre amigos)', (await cm('m3', 'que merda de passe')).json.ok);
    await adm({ action: 'filter', on: true });
    await sleep(1600);
    check('com o filtro ligado, palavrão é barrado', (await cm('m3', 'p0rr4 de juiz')).status === 400);
    await sleep(1600);
    check('palavra normal ("culpa") passa com o filtro', (await cm('m3', 'a culpa é do gramado')).json.ok);
    await adm({ action: 'comments_open', open: false });
    check('mural fechado -> 403', (await cm('m4', 'oi')).status === 403);
    await adm({ action: 'comments_open', open: true });
    r = await adm({ action: 'delete_comment', id: cid1 });
    check('organizador apaga comentário', !r.json.room.comments.some((c) => c.id === cid1));

    // ---- sala sem relógio e formatos
    r = await call('POST', '/api/rooms', { title: 'Sem relógio', preset: 'noclock' });
    const nc = r.json;
    const adm2 = (body) => call('POST', `/api/rooms/${nc.code}/admin`, Object.assign({ adminKey: nc.adminKey }, body));
    r = await adm2({ action: 'start' });
    check('sala sem relógio: começa em "live" sem cronômetro', r.json.room.status === 'live' && !r.json.room.clock.running && r.json.room.format.clock === false);
    r = await call('POST', `/api/rooms/${nc.code}/goal`, { clientId: 'x', nickname: 'Org', adminKey: nc.adminKey, team: 'a', player: 'Fulano' });
    check('organizador marca gol sem precisar do código', r.json.ok);
    r = await call('POST', '/api/rooms', { title: '1x60', preset: '1x60' });
    check('preset 1 tempo de 60', r.json.ok);
    r = await call('POST', '/api/rooms', { title: 'Custom', preset: 'custom', halves: 2, minutes: 20 });
    const cu = r.json;
    r = await call('POST', `/api/rooms/${cu.code}/admin`, { adminKey: cu.adminKey, action: 'start' });
    check('personalizado: 2 tempos de 20', r.json.room.format.minutes === 20 && r.json.room.format.halves === 2);
    r = await call('POST', `/api/rooms/${cu.code}/admin`, { adminKey: cu.adminKey, action: 'break' });
    r = await call('POST', `/api/rooms/${cu.code}/admin`, { adminKey: cu.adminKey, action: 'second' });
    check('2º tempo de jogo de 20 min recomeça em 20:00', r.json.room.clock.seconds >= 1200 && r.json.room.clock.seconds < 1210);
    r = await call('POST', `/api/rooms/${cu.code}/admin`, { adminKey: cu.adminKey, action: 'setup', preset: '1x40', title: 'Renomeado' });
    check('configuração muda formato e nome', r.json.room.format.minutes === 40 && r.json.room.format.halves === 1 && r.json.room.title === 'Renomeado');
    r = await adm2({ action: 'reset_game' });
    check('zerar o jogo exige confirmação', r.status === 400);
    r = await adm2({ action: 'reset_game', confirm: true });
    check('zerar o jogo limpa gols e volta ao início', r.json.room.status === 'pre' && r.json.room.goals.length === 0);

    // ---- expiração, backup e restauração
    r = await adm({ action: 'extend' });
    const exp1 = r.json.room.expiresAt;
    check('sala dura ~7 dias e pode ser ampliada em +2', exp1 - Date.now() > 8.9 * 86400000 && exp1 - Date.now() < 9.1 * 86400000);
    for (let i = 0; i < 6; i++) r = await adm({ action: 'extend' });
    check('duração máxima de 14 dias', r.json.room.expiresAt - Date.now() <= 14 * 86400000 + 1000);
    r = await call('GET', `/api/rooms/${code}/backup`, null, { 'x-admin-key': 'errada' });
    check('backup só com a chave', r.status === 401);
    r = await call('GET', `/api/rooms/${code}/backup`, null, { 'x-admin-key': adminKey });
    const backup = r.json.room;
    check('backup traz a sala completa', r.json.ok && backup.goals.length >= 1 && backup.adminKey === adminKey);
    r = await call('POST', `/api/rooms/restore`, { room: backup });
    check('restaurar sala que ainda existe -> 409', r.status === 409);
    r = await adm({ action: 'delete_room' });
    check('apagar sala exige confirmação', r.status === 400);
    r = await adm({ action: 'delete_room', confirm: true });
    check('organizador apaga a sala', r.json.deleted === true && (await call('GET', `/api/rooms/${code}`)).status === 404);
    r = await call('POST', `/api/rooms/restore`, { room: backup });
    check('restaura a sala com o MESMO código e chaves', r.json.ok && r.json.code === code);
    r = await call('GET', `/api/rooms/${code}`);
    check('sala restaurada mantém gols, votos revelados e comentários', r.json.room.goals.length === backup.goals.length && r.json.room.votes.revealed && r.json.room.votes.results.craque.winners[0] === 'Beto' && r.json.room.comments.length >= 1);
    r = await call('POST', `/api/rooms/${code}/role`, { adminKey });
    check('o organizador continua com a mesma chave após restaurar', r.json.admin);
    check('backup inválido é recusado', (await call('POST', `/api/rooms/restore`, { room: { code: 'AAAAA', adminKey: 'x' } })).status === 400);
    const old = JSON.parse(JSON.stringify(backup)); old.code = 'BBBBB'; old.expiresAt = Date.now() - 1000;
    check('backup de sala expirada -> 410', (await call('POST', `/api/rooms/restore`, { room: old })).status === 410);

    // ---- QR e tempo real
    const qr = await fetch(BASE + '/qr/' + code + '.svg');
    check('QR Code da sala', qr.status === 200 && (await qr.text()).includes('<svg'));
    const sock = io(BASE, { auth: { room: code, role: 'viewer' } });
    let last = null, goneSeen = false;
    sock.on('room', (rm) => (last = rm)); sock.on('gone', () => (goneSeen = true));
    await sleep(800);
    check('Socket.IO entrega o estado da sala', last && last.code === code);
    await call('POST', `/api/rooms/${code}/admin`, { adminKey, action: 'setup', teamA: 'Verdes' });
    await sleep(300);
    check('mudança chega em tempo real para quem está na sala', last.teams.a === 'Verdes');
    await call('POST', `/api/rooms/${code}/comment`, { clientId: 'rt', name: 'RT', text: 'tempo real' });
    await sleep(300);
    check('comentário novo chega em tempo real', last.comments.some((c) => c.text === 'tempo real'));
    check('contagem de pessoas na sala', last.viewers >= 1);
    await call('POST', `/api/rooms/${code}/admin`, { adminKey, action: 'delete_room', confirm: true });
    await sleep(300);
    check('sala apagada avisa quem está dentro', goneSeen);
    sock.close();
    const s2 = io(BASE, { auth: { room: 'NAOEXISTE' } }); let g2s = false; s2.on('gone', () => (g2s = true)); await sleep(400);
    check('conectar em sala inexistente avisa que sumiu', g2s); s2.close();

    // ---- limite de criação por IP
    let blocked = false;
    for (let i = 0; i < 10; i++) { const x = await fetch(BASE + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '9.9.9.9' }, body: JSON.stringify({ title: 't' + i, preset: '2x30' }) }); if (x.status === 400) blocked = true; }
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

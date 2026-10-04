'use strict';
// Testa a persistência: um "Upstash de mentira" (servidor local) recebe as salas;
// derrubamos o servidor do app (como o Render faz ao reiniciar) e subimos outro.
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const MOCK_PORT = 4890, TOKEN = 'tok-secreto';
let failed = 0, n = 0;
function check(name, cond, extra) { n++; console.log((cond ? 'OK   ' : 'FALHA') + ' - ' + name + (cond ? '' : ' ' + (extra || ''))); if (!cond) failed++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mock do Upstash (protocolo REST /pipeline)
const kv = new Map(), sets = new Map(), ttl = new Map();
let down = false, cmdCount = 0, pings = 0, badAuth = 0;
const mock = http.createServer((req, res) => {
  if (req.url === '/health') { pings++; res.end('{"ok":true}'); return; }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (down) { res.statusCode = 503; res.end('down'); return; }
    if (req.headers.authorization !== 'Bearer ' + TOKEN) { badAuth++; res.statusCode = 401; res.end('{"error":"unauthorized"}'); return; }
    const cmds = JSON.parse(body);
    const out = cmds.map((c) => {
      cmdCount++;
      const [op, k, v] = c;
      switch (op) {
        case 'SET': kv.set(k, v); if (c[3] === 'EX') ttl.set(k, Number(c[4])); return { result: 'OK' };
        case 'GET': return { result: kv.has(k) ? kv.get(k) : null };
        case 'DEL': return { result: kv.delete(k) ? 1 : 0 };
        case 'SADD': if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(v); return { result: 1 };
        case 'SREM': if (sets.has(k)) sets.get(k).delete(v); return { result: 1 };
        case 'SMEMBERS': return { result: sets.has(k) ? [...sets.get(k)] : [] };
        default: return { error: 'ERR unknown command' };
      }
    });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(out));
  });
});

function startApp(port, extra) {
  const p = spawn('node', ['server.js'], { env: { ...process.env, PORT: port, DATA_FILE: path.join(os.tmpdir(), 'rab-p-' + port + '-' + Date.now() + '.json'),
    UPSTASH_REDIS_REST_URL: 'http://localhost:' + MOCK_PORT, UPSTASH_REDIS_REST_TOKEN: TOKEN, ...extra }, stdio: 'ignore' });
  p.exited = new Promise((r) => p.on('exit', (code, sig) => r({ code, sig })));
  return p;
}
async function waitUp(port) { for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${port}/health`)).ok) return true; } catch (e) {} await sleep(150); } return false; }
async function call(port, method, url, body) {
  const r = await fetch(`http://localhost:${port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}

(async () => {
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  const procs = [];
  try {
    // ===== 1) jogo em andamento; o servidor é desligado ANTES do salvamento automático (60 s)
    const A = startApp(4881, { FLUSH_MS: '60000' }); procs.push(A);
    check('app inicia com Upstash configurado', await waitUp(4881));
    let h = (await call(4881, 'GET', '/health')).json;
    check('/health informa o armazenamento (sem revelar URL nem senha)', h.storage.mode === 'upstash' && !JSON.stringify(h).includes(TOKEN) && !JSON.stringify(h).includes('localhost:' + MOCK_PORT));
    let r = await call(4881, 'POST', '/api/rooms', { title: 'Final do Rabugentos', teamA: 'Azul', teamB: 'Laranja', preset: '2x30' });
    const { code, adminKey, scorerCode } = r.json;
    const adm = (port, body) => call(port, 'POST', `/api/rooms/${code}/admin`, Object.assign({ adminKey }, body));
    await adm(4881, { action: 'roster', text: 'Beto\nZé' });
    await adm(4881, { action: 'start' });
    await call(4881, 'POST', `/api/rooms/${code}/goal`, { clientId: 'c1', nickname: 'Goleiro', scorerCode, team: 'a', player: 'Zé' });
    await call(4881, 'POST', `/api/rooms/${code}/comment`, { clientId: 'c2', name: 'Maria', text: 'Que jogão!' });
    await call(4881, 'POST', `/api/rooms/${code}/admin`, { adminKey, action: 'votes_open', open: true });
    await call(4881, 'POST', `/api/rooms/${code}/vote`, { clientId: 'v1', category: 'craque', candidate: 'Zé' });
    await sleep(1500);
    const before = (await call(4881, 'GET', `/api/rooms/${code}`)).json.room;
    check('(nada foi gravado ainda: o salvamento automático só ocorre em 60 s)', !kv.has('rab:room:' + code));
    A.kill('SIGTERM'); const ex = await A.exited;
    check('ao receber o aviso de desligamento (SIGTERM) o app sai limpo', ex.code === 0, JSON.stringify(ex));
    check('...e gravou a sala no Upstash antes de sair', kv.has('rab:room:' + code) && sets.get('rab:rooms').has(code));

    // ===== 2) novo servidor (outra "máquina": arquivo local diferente) recupera tudo
    const B = startApp(4882, { FLUSH_MS: '700', SELF_URL: 'http://localhost:' + MOCK_PORT, SELF_PING_MS: '400' }); procs.push(B);
    check('novo servidor inicia', await waitUp(4882));
    r = await call(4882, 'GET', `/api/rooms/${code}`);
    check('a sala voltou com o MESMO código', r.status === 200 && r.json.room.code === code);
    const after = r.json.room;
    check('placar, gol e quem anotou voltaram', after.score.a === 1 && after.goals.length === 1 && after.goals[0].by === 'Goleiro' && after.goals[0].player === 'Zé');
    check('comentário e votação voltaram', after.comments.length === 1 && after.votes.open === true && after.votes.voters.craque === 1);
    check('o relógio continuou correndo (jogo em andamento)', after.clock.running === true && after.clock.seconds >= before.clock.seconds);
    check('jogadores e formato voltaram', after.roster.join() === 'Beto,Zé' && after.format.halves === 2 && after.title === 'Final do Rabugentos');
    r = await call(4882, 'POST', `/api/rooms/${code}/role`, { adminKey, clientId: 'v1' });
    check('o organizador continua com a MESMA chave (sem ficar de fora)', r.json.admin === true);
    check('o voto de cada pessoa continua dela', r.json.myVotes.craque === 'Zé');
    r = await call(4882, 'POST', `/api/rooms/${code}/role`, { scorerCode });
    check('o código de marcador continua valendo', r.json.scorer === true);
    r = await call(4882, 'POST', `/api/rooms/${code}/goal`, { clientId: 'c1', nickname: 'Goleiro', scorerCode, team: 'b', player: 'Beto' });
    check('o jogo segue normalmente depois do reinício (novo gol)', r.json.ok === true);

    // ===== 3) salvamento automático e apagar
    const t0 = Date.now(); let saved = false;
    while (Date.now() - t0 < 6000) { const v = JSON.parse(kv.get('rab:room:' + code) || '{}'); if (v.goals && v.goals.length === 2) { saved = true; break; } await sleep(200); }
    check('mudanças são gravadas sozinhas (sem desligar o servidor)', saved);
    check('o Upstash guarda a sala com prazo de validade (TTL) ~7 dias, para limpar sozinho', ttl.get('rab:room:' + code) > 6 * 86400 && ttl.get('rab:room:' + code) < 9 * 86400, 'ttl=' + ttl.get('rab:room:' + code));
    check('auto-ping: o app chama o próprio /health para não dormir (enquanto há salas)', pings >= 1, 'pings=' + pings);
    h = (await call(4882, 'GET', '/health')).json;
    check('/health: dados protegidos = true', h.storage.protected === true, JSON.stringify(h.storage));
    await adm(4882, { action: 'delete_room', confirm: true });
    const t1 = Date.now(); let gone = false;
    while (Date.now() - t1 < 6000) { if (!kv.has('rab:room:' + code) && !sets.get('rab:rooms').has(code)) { gone = true; break; } await sleep(200); }
    check('apagar a sala também apaga do Upstash', gone);
    B.kill('SIGTERM'); await B.exited;

    // ===== 4) Upstash fora do ar: o app NÃO cai
    down = true;
    const C = startApp(4883, { FLUSH_MS: '500', FLUSH_RETRY_MS: '800' }); procs.push(C);
    check('com o Upstash fora do ar o app inicia mesmo assim', await waitUp(4883));
    r = await call(4883, 'POST', '/api/rooms', { title: 'Sem nuvem', preset: '1x60' });
    check('e continua criando salas (em memória/arquivo)', r.json.ok === true);
    const code2 = r.json.code;
    await sleep(1500);
    h = (await call(4883, 'GET', '/health')).json;
    check('/health avisa que os dados NÃO estão protegidos', h.storage.protected === false && h.storage.error !== '', JSON.stringify(h.storage));
    down = false;
    const t2 = Date.now(); let recovered = false;
    while (Date.now() - t2 < 8000) { if (kv.has('rab:room:' + code2)) { recovered = true; break; } await sleep(250); }
    check('quando o Upstash volta, o app grava o que ficou pendente', recovered);
    h = (await call(4883, 'GET', '/health')).json;
    check('/health volta a dizer protegido', h.storage.protected === true, JSON.stringify(h.storage));
    C.kill('SIGTERM'); await C.exited;

    // ===== 5) senha errada no Upstash: o app avisa e segue funcionando
    const D = spawn('node', ['server.js'], { env: { ...process.env, PORT: 4884, DATA_FILE: path.join(os.tmpdir(), 'rab-p-d-' + Date.now() + '.json'), UPSTASH_REDIS_REST_URL: 'http://localhost:' + MOCK_PORT, UPSTASH_REDIS_REST_TOKEN: 'senha-errada', FLUSH_MS: '400', FLUSH_RETRY_MS: '60000' }, stdio: 'ignore' }); procs.push(D);
    check('com a senha do Upstash errada o app inicia mesmo assim', await waitUp(4884));
    await call(4884, 'POST', '/api/rooms', { title: 'x', preset: '1x60' });
    await sleep(1200);
    h = (await call(4884, 'GET', '/health')).json;
    check('...e avisa que os dados não estão protegidos', h.storage.protected === false && badAuth >= 1, JSON.stringify(h.storage) + ' auth=' + badAuth);
    D.kill('SIGTERM');
  } catch (e) {
    console.error('Erro no teste:', e); failed++;
  } finally {
    procs.forEach((p) => { try { p.kill('SIGKILL'); } catch (e) {} });
    mock.close();
  }
  console.log(failed ? `\n${failed} de ${n} verificação(ões) de persistência FALHARAM` : `\nTodas as ${n} verificações de persistência passaram.`);
  process.exit(failed ? 1 : 0);
})();

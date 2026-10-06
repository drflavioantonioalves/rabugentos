'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const CREATE_KEY = process.env.CREATE_KEY || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'rooms.json');

const DAY = 86400000;
const ROOM_DAYS = 7; // a sala some sozinha depois disso
const MAX_DAYS = 14; // limite ao ampliar
const MAX_ROOMS = 300;
const MAX_PLAYERS = 40;
const DUP_WINDOW_MS = 60000; // janela para perguntar "é o mesmo gol?"

const CATEGORIES = [
  { id: 'craque', emoji: '⭐', label: 'Craque da noite' },
  { id: 'bagre', emoji: '🐟', label: 'Bagre da noite' },
  { id: 'frangueiro', emoji: '🧤', label: 'Frangueiro' },
  { id: 'garcom', emoji: '🎯', label: 'Garçom (assistências)' },
  { id: 'zoeira', emoji: '😂', label: 'Maior zoeira' },
];
const CAT_IDS = CATEGORIES.map((c) => c.id);
const REACTIONS = ['😂', '🔥', '👏', '😤'];
const STATUSES = ['pre', 'h1', 'break', 'h2', 'live', 'finished'];

class BadRequest extends Error {}

// ---------------------------------------------------------------- utilidades
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randCode(n) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHA[b[i] % ALPHA.length];
  return s;
}
function sha(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}
function sameKey(a, b) {
  if (!a || !b) return false;
  return crypto.timingSafeEqual(sha(a), sha(b));
}
function cleanText(v, max, field, required) {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (required && !s) throw new BadRequest('Campo obrigatório: ' + field);
  return s.slice(0, max);
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function needTeam(v) {
  if (v !== 'a' && v !== 'b') throw new BadRequest('Escolha o time.');
  return v;
}

// ---------------------------------------------------------------- salas
const rooms = new Map();

function parseFormat(b) {
  switch (b.preset) {
    case '2x30': return { halves: 2, minutes: 30, clock: true };
    case '1x60': return { halves: 1, minutes: 60, clock: true };
    case '1x40': return { halves: 1, minutes: 40, clock: true };
    case 'noclock': return { halves: 1, minutes: 0, clock: false };
    case 'custom': {
      const halves = Number(b.halves);
      const minutes = Number(b.minutes);
      if (halves !== 1 && halves !== 2) throw new BadRequest('Escolha 1 ou 2 tempos.');
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) throw new BadRequest('Minutos por tempo: de 1 a 120.');
      return { halves, minutes: Math.round(minutes), clock: true };
    }
    default: throw new BadRequest('Formato de jogo inválido.');
  }
}

function freshRoom(code, o) {
  const now = Date.now();
  return {
    code,
    createdAt: now,
    expiresAt: now + ROOM_DAYS * DAY,
    title: o.title,
    venue: o.venue,
    date: o.date,
    teams: o.teams,
    format: o.format,
    status: 'pre', // pre | h1 | break | h2 | live | finished
    clock: { baseSeconds: 0, startedAt: null },
    lastPhase: null,
    players: [],
    nextPlayerId: 1,
    goals: [],
    nextGoalId: 1,
    comments: [],
    nextCommentId: 1,
    votes: { open: false, revealed: false, ballots: {} },
    log: [],
    nextLogId: 1,
    peakViewers: 0,
  };
}

// Aceita salas gravadas por versões anteriores e backups: devolve uma sala segura (ou null).
function normalizeRoom(r) {
  if (!r || typeof r.code !== 'string' || !/^[A-Z2-9]{5}$/.test(r.code)) return null;
  let format;
  try {
    format = parseFormat(r.format && r.format.clock === false ? { preset: 'noclock' } : { preset: 'custom', halves: r.format && r.format.halves, minutes: r.format && r.format.minutes });
  } catch (e) { format = { halves: 2, minutes: 30, clock: true }; }
  const room = freshRoom(r.code, {
    title: cleanText(r.title, 40, 'x', false) || 'Pelada de hoje',
    venue: cleanText(r.venue, 60, 'x', false),
    date: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : todayStr(),
    teams: { a: cleanText(r.teams && r.teams.a, 24, 'x', false) || 'Azul', b: cleanText(r.teams && r.teams.b, 24, 'x', false) || 'Laranja' },
    format,
  });
  room.createdAt = Number(r.createdAt) || room.createdAt;
  room.expiresAt = Math.min(Number(r.expiresAt) || room.expiresAt, Date.now() + MAX_DAYS * DAY);
  room.status = STATUSES.includes(r.status) ? r.status : 'pre';
  room.clock = { baseSeconds: Number(r.clock && r.clock.baseSeconds) || 0, startedAt: r.clock && r.clock.startedAt ? Number(r.clock.startedAt) : null };
  room.peakViewers = Number(r.peakViewers) || 0;

  const names = new Set();
  room.players = (Array.isArray(r.players) ? r.players : []).filter((p) => p && (p.team === 'a' || p.team === 'b') && typeof p.name === 'string').slice(0, MAX_PLAYERS)
    .map((p) => ({ id: Number(p.id) || 0, name: cleanText(p.name, 30, 'x', false), team: p.team, cid: typeof p.cid === 'string' && p.cid ? p.cid.slice(0, 60) : null }))
    .filter((p) => p.name && !names.has(p.name.toLowerCase()) && names.add(p.name.toLowerCase()));
  let maxP = room.players.reduce((m, p) => Math.max(m, p.id), 0);
  room.players.forEach((p) => { if (!p.id) p.id = ++maxP; });
  room.nextPlayerId = Math.max(Number(r.nextPlayerId) || 1, maxP + 1);

  room.goals = (Array.isArray(r.goals) ? r.goals : []).filter((g) => g && (g.team === 'a' || g.team === 'b') && g.status !== 'annulled').slice(0, 300).map((g) => ({
    id: Number(g.id) || 0, team: g.team, playerId: Number.isFinite(Number(g.playerId)) && g.playerId !== null && room.players.some((p) => p.id === Number(g.playerId)) ? Number(g.playerId) : null,
    playerName: cleanText(g.playerName || g.player || '', 40, 'x', false), ownGoal: !!g.ownGoal, byName: cleanText(g.byName, 30, 'x', false) || '?',
    byId: String(g.byId || '').slice(0, 60), ts: Number(g.ts) || Date.now(), minute: g.minute == null ? null : Number(g.minute),
  }));
  let maxG = room.goals.reduce((m, g) => Math.max(m, g.id), 0);
  room.goals.forEach((g) => { if (!g.id) g.id = ++maxG; });
  room.nextGoalId = Math.max(Number(r.nextGoalId) || 1, maxG + 1);

  room.comments = (Array.isArray(r.comments) ? r.comments : []).filter((c) => c && typeof c.text === 'string').slice(-200).map((c) => ({
    id: Number(c.id) || 0, name: cleanText(c.name, 30, 'x', false) || '?', text: cleanText(c.text, 200, 'x', false), ts: Number(c.ts) || Date.now(),
    cid: String(c.cid || '').slice(0, 60), reactions: c.reactions && typeof c.reactions === 'object' ? c.reactions : {},
  }));
  let maxC = room.comments.reduce((m, c) => Math.max(m, c.id), 0);
  room.comments.forEach((c) => { if (!c.id) c.id = ++maxC; });
  room.nextCommentId = Math.max(Number(r.nextCommentId) || 1, maxC + 1);

  if (r.votes && typeof r.votes === 'object') {
    room.votes.open = !!r.votes.open;
    room.votes.revealed = !!r.votes.revealed;
    const bal = r.votes.ballots && typeof r.votes.ballots === 'object' ? r.votes.ballots : {};
    CAT_IDS.forEach((c) => {
      const src = bal[c] && typeof bal[c] === 'object' ? bal[c] : {};
      const out = {};
      Object.keys(src).forEach((cid) => { const id = Number(src[cid]); if (room.players.some((p) => p.id === id)) out[cid] = id; });
      room.votes.ballots[c] = out;
    });
  }
  room.log = (Array.isArray(r.log) ? r.log : []).filter((l) => l && typeof l.text === 'string').slice(-80).map((l) => ({ id: Number(l.id) || 0, ts: Number(l.ts) || Date.now(), who: cleanText(l.who, 30, 'x', false), text: cleanText(l.text, 120, 'x', false) }));
  let maxL = room.log.reduce((m, l) => Math.max(m, l.id), 0);
  room.log.forEach((l) => { if (!l.id) l.id = ++maxL; });
  room.nextLogId = Math.max(Number(r.nextLogId) || 1, maxL + 1);
  return room;
}

function secs(room) {
  const c = room.clock;
  return c.baseSeconds + (c.startedAt ? (Date.now() - c.startedAt) / 1000 : 0);
}
function freeze(room) {
  room.clock.baseSeconds = secs(room);
  room.clock.startedAt = null;
}
function computeScore(room) {
  const s = { a: 0, b: 0 };
  for (const g of room.goals) s[g.team] += 1;
  return s;
}
function statusLabel(room) {
  const paused = (room.status === 'h1' || room.status === 'h2') && room.clock.startedAt === null;
  if (paused) return 'Jogo parado';
  return { pre: 'Antes do jogo', h1: room.format.halves === 2 ? '1º tempo' : 'Em jogo', break: 'Intervalo', h2: '2º tempo', live: 'Em jogo', finished: 'Fim de jogo' }[room.status];
}
function playerById(room, id) { return room.players.find((p) => p.id === Number(id)); }
function goalPlayerName(room, g) { const p = playerById(room, g.playerId); return p ? p.name : g.playerName || ''; }

function results(room) {
  const out = {};
  for (const cat of CAT_IDS) {
    const tally = {};
    Object.values(room.votes.ballots[cat] || {}).forEach((id) => { tally[id] = (tally[id] || 0) + 1; });
    const list = Object.keys(tally).map((id) => { const p = playerById(room, id); return p ? { id: p.id, name: p.name, team: p.team, count: tally[id] } : null; })
      .filter(Boolean).sort((x, y) => y.count - x.count || x.name.localeCompare(y.name));
    out[cat] = { list, winners: list.length ? list.filter((x) => x.count === list[0].count).map((x) => x.name) : [] };
  }
  return out;
}

function publicRoom(room) {
  const voters = {};
  CAT_IDS.forEach((c) => { voters[c] = Object.keys(room.votes.ballots[c] || {}).length; });
  return {
    code: room.code,
    title: room.title,
    venue: room.venue,
    date: room.date,
    teams: room.teams,
    format: room.format,
    status: room.status,
    statusLabel: statusLabel(room),
    clock: { seconds: Math.floor(secs(room)), running: room.clock.startedAt !== null },
    undoPhase: room.lastPhase ? { available: true, label: room.lastPhase.label } : { available: false, label: '' },
    score: computeScore(room),
    players: room.players.map((p) => ({ id: p.id, name: p.name, team: p.team, phone: !!p.cid })),
    goals: room.goals.map((g) => ({ id: g.id, team: g.team, playerId: g.playerId, player: goalPlayerName(room, g), ownGoal: g.ownGoal, by: g.byName, minute: g.minute, ts: g.ts })),
    comments: room.comments.map((c) => ({ id: c.id, name: c.name, text: c.text, ts: c.ts, reactions: c.reactions })),
    votes: { open: room.votes.open, revealed: room.votes.revealed, voters, results: room.votes.revealed ? results(room) : null },
    categories: CATEGORIES,
    log: room.log.slice(-40),
    expiresAt: room.expiresAt,
    viewers: viewersOf(room.code),
    serverTime: Date.now(),
  };
}

// ---------------------------------------------------------------- app
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
const server = http.createServer(app);
const io = new Server(server);

function viewersOf(code) {
  const r = io.sockets.adapter.rooms.get(code);
  return r ? r.size : 0;
}

// ---------------------------------------------------------------- armazenamento
// Sempre guarda em arquivo local (sobrevive a reinício simples do processo) e, se configurado,
// também no Upstash Redis (gratuito): assim a sala sobrevive a reinício/atualização do Render.
const REMOTE_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REMOTE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const FLUSH_MS = Number(process.env.FLUSH_MS) || 4000;
const RETRY_MS = Number(process.env.FLUSH_RETRY_MS) || 15000;
const storage = { mode: REMOTE_URL && REMOTE_TOKEN ? 'upstash' : 'arquivo', lastOk: null, lastError: '' };
const KEY = 'rab:room:';
const INDEX = 'rab:rooms';

async function pipe(cmds) {
  const r = await fetch(REMOTE_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REMOTE_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const bad = j.find((x) => x && x.error);
  if (bad) throw new Error(String(bad.error).slice(0, 120));
  return j.map((x) => x.result);
}
async function remoteLoadAll() {
  const [codes] = await pipe([['SMEMBERS', INDEX]]);
  if (!codes || !codes.length) return [];
  const out = [];
  const stale = [];
  for (let i = 0; i < codes.length; i += 20) {
    const part = codes.slice(i, i + 20);
    const vals = await pipe(part.map((c) => ['GET', KEY + c]));
    vals.forEach((v, k) => {
      if (!v) { stale.push(part[k]); return; }
      try { out.push(JSON.parse(v)); } catch (e) { stale.push(part[k]); }
    });
  }
  if (stale.length) pipe(stale.map((c) => ['SREM', INDEX, c])).catch(() => {});
  return out;
}

const dirty = new Set();
const removed = new Set();
let flushTimer = null;
function scheduleFlush(ms) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushAll().catch(() => {}); }, ms || (storage.mode === 'upstash' ? FLUSH_MS : 600));
}
function markDirty(code) { removed.delete(code); dirty.add(code); scheduleFlush(); }
function markRemoved(code) { dirty.delete(code); removed.add(code); scheduleFlush(); }

async function flushAll() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify([...rooms.values()])); } catch (e) { /* só em memória */ }
  if (storage.mode !== 'upstash') { dirty.clear(); removed.clear(); return; }
  const toSave = [...dirty];
  const toDel = [...removed];
  dirty.clear(); removed.clear();
  try {
    for (let i = 0; i < toSave.length; i += 8) {
      const cmds = [];
      toSave.slice(i, i + 8).forEach((code) => {
        const room = rooms.get(code);
        if (!room) return;
        const ttl = Math.max(3600, Math.ceil((room.expiresAt - Date.now()) / 1000) + 3600);
        cmds.push(['SET', KEY + code, JSON.stringify(room), 'EX', String(ttl)], ['SADD', INDEX, code]);
      });
      if (cmds.length) await pipe(cmds);
    }
    if (toDel.length) await pipe(toDel.flatMap((c) => [['DEL', KEY + c], ['SREM', INDEX, c]]));
    storage.lastOk = Date.now(); storage.lastError = '';
  } catch (e) {
    storage.lastError = String(e.message || e).slice(0, 140);
    console.warn('Falha ao gravar no Upstash (vai tentar de novo):', storage.lastError);
    toSave.forEach((c) => dirty.add(c)); toDel.forEach((c) => removed.add(c));
    scheduleFlush(RETRY_MS);
  }
}

function loadRoomsFromFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    for (const raw of JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))) { const r = normalizeRoom(raw); if (r && r.expiresAt > Date.now()) rooms.set(r.code, r); }
    console.log('Salas recuperadas do arquivo:', rooms.size);
  } catch (e) { console.warn('Não foi possível ler as salas salvas:', e.message); }
}
function emitRoom(room) {
  const v = viewersOf(room.code);
  if (v > room.peakViewers) room.peakViewers = v;
  io.to(room.code).emit('room', publicRoom(room));
  markDirty(room.code);
}

// limites simples por chave (IP ou cliente)
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now);
  hits.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.some((t) => now - t < 3600000)) hits.delete(k);
  for (const [code, r] of rooms) if (r.expiresAt <= now) { rooms.delete(code); io.to(code).emit('gone'); markRemoved(code); }
}, 600000).unref();

function getRoom(req, res) {
  const code = String(req.params.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) { res.status(404).json({ ok: false, gone: true, error: 'Sala não encontrada ou expirada.' }); return null; }
  return room;
}
function fail(res, e) {
  if (e instanceof BadRequest) return res.status(400).json({ ok: false, error: e.message });
  console.error(e);
  return res.status(500).json({ ok: false, error: 'Erro interno.' });
}

app.get('/health', (req, res) => res.json({
  ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()),
  storage: { mode: storage.mode, protected: storage.mode === 'upstash' && !storage.lastError && storage.lastOk !== null, lastOkSecondsAgo: storage.lastOk ? Math.round((Date.now() - storage.lastOk) / 1000) : null, error: storage.lastError ? 'falha ao gravar' : '' },
}));
app.get('/api/config', (req, res) => res.json({ needsCreateKey: !!CREATE_KEY, days: ROOM_DAYS }));

// ---- criar sala (tudo opcional: dá para criar com um toque)
app.post('/api/rooms', (req, res) => {
  try {
    if (limited('create:' + req.ip, 12, 3600000)) throw new BadRequest('Muitas salas criadas por aqui. Tente de novo mais tarde.');
    if (CREATE_KEY && !sameKey(CREATE_KEY, req.body && req.body.createKey)) return res.status(401).json({ ok: false, error: 'Senha de criação incorreta.' });
    if (rooms.size >= MAX_ROOMS) throw new BadRequest('O servidor está cheio de salas no momento. Tente mais tarde.');
    const b = req.body || {};
    const date = cleanText(b.date, 10, 'data', false);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequest('Data inválida.');
    let code;
    do { code = randCode(5); } while (rooms.has(code));
    const room = freshRoom(code, {
      title: cleanText(b.title, 40, 'nome do jogo', false) || 'Pelada de hoje',
      venue: cleanText(b.venue, 60, 'campo', false),
      date: date || todayStr(),
      teams: { a: cleanText(b.teamA, 24, 'time A', false) || 'Azul', b: cleanText(b.teamB, 24, 'time B', false) || 'Laranja' },
      format: parseFormat({ preset: b.preset || '2x30', halves: b.halves, minutes: b.minutes }),
    });
    rooms.set(room.code, room);
    markDirty(room.code);
    res.json({ ok: true, code: room.code });
  } catch (e) { fail(res, e); }
});

// ---- restaurar sala (cópia guardada no celular de quem criou)
app.post('/api/rooms/restore', (req, res) => {
  try {
    if (limited('create:' + req.ip, 12, 3600000)) throw new BadRequest('Muitas tentativas. Tente de novo mais tarde.');
    const raw = req.body && req.body.room;
    const room = normalizeRoom(raw);
    if (!room) throw new BadRequest('Backup inválido.');
    if (rooms.has(room.code)) return res.status(409).json({ ok: false, error: 'Essa sala já existe.' });
    if (!(Number(raw.expiresAt) > Date.now())) return res.status(410).json({ ok: false, error: 'Essa sala já expirou.' });
    if (rooms.size >= MAX_ROOMS) throw new BadRequest('O servidor está cheio de salas no momento.');
    rooms.set(room.code, room);
    markDirty(room.code);
    res.json({ ok: true, code: room.code });
  } catch (e) { fail(res, e); }
});

app.get('/api/rooms/:code', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, room: publicRoom(room) });
});

app.get('/api/rooms/:code/backup', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, room });
});

function myVotes(room, cid) {
  const out = {};
  if (!cid) return out;
  CAT_IDS.forEach((c) => { const v = (room.votes.ballots[c] || {})[cid]; if (v) out[c] = v; });
  return out;
}
// quem sou eu nesta sala (meu jogador e meus votos)
app.post('/api/rooms/:code/me', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const cid = String((req.body && req.body.clientId) || '').slice(0, 60);
  const p = room.players.find((x) => x.cid === cid);
  res.json({ ok: true, me: p ? { id: p.id, name: p.name, team: p.team } : null, myVotes: myVotes(room, cid) });
});

// ---------------------------------------------------------------- ações (qualquer pessoa da sala)
function note(room, who, text) {
  room.log.push({ id: room.nextLogId++, ts: Date.now(), who, text });
  if (room.log.length > 80) room.log.shift();
}
function teamName(room, t) { return room.teams[t]; }
function nameTaken(room, name, exceptId) {
  return room.players.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());
}
function removePlayer(room, id) {
  const i = room.players.findIndex((p) => p.id === id);
  if (i === -1) return;
  room.players.splice(i, 1);
  CAT_IDS.forEach((c) => { const b = room.votes.ballots[c]; if (b) Object.keys(b).forEach((cid) => { if (b[cid] === id) delete b[cid]; }); });
}
// acha (ou cria) o jogador citado num gol
function resolvePlayer(room, b, team, own) {
  if (b.playerId !== undefined && b.playerId !== null && b.playerId !== '') {
    const p = playerById(room, b.playerId);
    if (!p) throw new BadRequest('Jogador não encontrado.');
    return p;
  }
  const name = cleanText(b.playerName, 30, 'jogador', false);
  if (!name) return null;
  const found = room.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (found) return found;
  if (room.players.length >= MAX_PLAYERS) return null;
  const p = { id: room.nextPlayerId++, name, team: own ? (team === 'a' ? 'b' : 'a') : team, cid: null };
  room.players.push(p);
  return p;
}
function phaseChange(room, label, mutate) {
  const before = { status: room.status, clock: { baseSeconds: room.clock.baseSeconds, startedAt: room.clock.startedAt } };
  mutate();
  room.lastPhase = Object.assign(before, { label });
}

function act(room, b, cid) {
  const f = room.format;
  // valida o apelido ANTES de mexer em qualquer coisa (erro não pode deixar a sala pela metade)
  const nickname = ['ping', 'react', 'vote', 'comment_delete'].includes(b.action) ? '' : cleanText(b.nickname, 30, 'seu apelido', true);
  const who = () => nickname;
  switch (b.action) {
    case 'ping': return null;

    // ---- entrar na sala / times
    case 'join': {
      const me = who();
      const team = b.team === 'a' || b.team === 'b' ? b.team : null;
      let p = room.players.find((x) => x.cid === cid);
      if (team === null) {
        if (p) { removePlayer(room, p.id); note(room, me, 'agora só assiste'); }
        return { body: { me: null } };
      }
      if (!p) {
        const same = room.players.find((x) => x.name.toLowerCase() === me.toLowerCase());
        if (same && !same.cid) { p = same; p.cid = cid; }
        else if (same) throw new BadRequest('Já existe um jogador com esse nome. Use outro apelido.');
      }
      if (!p) {
        if (room.players.length >= MAX_PLAYERS) throw new BadRequest('A sala já tem ' + MAX_PLAYERS + ' jogadores.');
        p = { id: room.nextPlayerId++, name: me, team, cid };
        room.players.push(p);
        note(room, me, 'entrou no ' + teamName(room, team));
      } else {
        const moved = p.team !== team;
        if (p.name.toLowerCase() !== me.toLowerCase()) {
          if (nameTaken(room, me, p.id)) throw new BadRequest('Já existe um jogador com esse nome. Use outro apelido.');
          p.name = me;
        }
        p.team = team;
        if (moved) note(room, me, 'foi para o ' + teamName(room, team));
      }
      CAT_IDS.forEach((c) => { const bl = room.votes.ballots[c]; if (bl && bl[cid] === p.id) delete bl[cid]; });
      return { body: { me: { id: p.id, name: p.name, team: p.team } } };
    }
    case 'player_add': {
      const me = who();
      const name = cleanText(b.name, 30, 'nome do jogador', true);
      const team = needTeam(b.team);
      if (room.players.length >= MAX_PLAYERS) throw new BadRequest('A sala já tem ' + MAX_PLAYERS + ' jogadores.');
      if (nameTaken(room, name)) throw new BadRequest('Já existe um jogador com esse nome.');
      room.players.push({ id: room.nextPlayerId++, name, team, cid: null });
      note(room, me, 'adicionou ' + name + ' ao ' + teamName(room, team));
      return null;
    }
    case 'player_move': {
      const me = who();
      const p = playerById(room, b.playerId);
      if (!p) throw new BadRequest('Jogador não encontrado.');
      const team = needTeam(b.team);
      if (p.team !== team) { p.team = team; note(room, me, 'moveu ' + p.name + ' para o ' + teamName(room, team)); }
      return null;
    }
    case 'player_rename': {
      const me = who();
      const p = playerById(room, b.playerId);
      if (!p) throw new BadRequest('Jogador não encontrado.');
      const name = cleanText(b.name, 30, 'nome do jogador', true);
      if (nameTaken(room, name, p.id)) throw new BadRequest('Já existe um jogador com esse nome.');
      note(room, me, 'renomeou ' + p.name + ' para ' + name);
      p.name = name;
      return null;
    }
    case 'player_remove': {
      const me = who();
      const p = playerById(room, b.playerId);
      if (!p) throw new BadRequest('Jogador não encontrado.');
      removePlayer(room, p.id);
      note(room, me, 'tirou ' + p.name + ' da sala');
      return null;
    }
    case 'shuffle': {
      const me = who();
      if (room.players.length < 2) throw new BadRequest('Precisa de pelo menos 2 jogadores para sortear.');
      const list = room.players.slice();
      for (let i = list.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [list[i], list[j]] = [list[j], list[i]]; }
      const first = crypto.randomInt(2) === 0 ? 'a' : 'b';
      list.forEach((p, i) => { p.team = i % 2 === 0 ? first : first === 'a' ? 'b' : 'a'; });
      note(room, me, 'sorteou os times');
      return null;
    }

    // ---- gols (qualquer um)
    case 'goal': {
      const me = who();
      const team = needTeam(b.team);
      const own = b.ownGoal === true;
      if (limited('goal:' + cid, 8, 15000)) throw new BadRequest('Calma! Muitos gols em poucos segundos.');
      const recent = room.goals.filter((g) => g.team === team && Date.now() - g.ts < DUP_WINDOW_MS).pop();
      if (recent && b.confirmNew !== true) {
        return { skip: true, body: { ok: false, needConfirm: true, similar: { team, player: goalPlayerName(room, recent), by: recent.byName, secondsAgo: Math.round((Date.now() - recent.ts) / 1000) } } };
      }
      const p = resolvePlayer(room, b, team, own);
      const running = f.clock && (room.status === 'h1' || room.status === 'h2' || room.status === 'break');
      const goalId = room.nextGoalId++;
      room.goals.push({ id: goalId, team, playerId: p ? p.id : null, playerName: p ? p.name : '', ownGoal: own, byName: me, byId: cid, ts: Date.now(), minute: running ? Math.floor(secs(room) / 60) + 1 : null });
      note(room, me, (own ? 'registrou gol contra a favor do ' : 'marcou gol do ') + teamName(room, team) + (p ? ' (' + p.name + ')' : ''));
      return { body: { goalId } };
    }
    case 'goal_edit': {
      const me = who();
      const g = room.goals.find((x) => x.id === Number(b.goalId));
      if (!g) throw new BadRequest('Gol não encontrado.');
      const p = resolvePlayer(room, b, g.team, g.ownGoal);
      g.playerId = p ? p.id : null;
      g.playerName = p ? p.name : '';
      note(room, me, p ? 'definiu ' + p.name + ' como autor do gol do ' + teamName(room, g.team) : 'tirou o autor de um gol do ' + teamName(room, g.team));
      return null;
    }
    case 'goal_undo': {
      const me = who();
      const i = room.goals.findIndex((x) => x.id === Number(b.goalId));
      if (i === -1) throw new BadRequest('Gol não encontrado.');
      const g = room.goals[i];
      room.goals.splice(i, 1);
      note(room, me, 'desfez um gol do ' + teamName(room, g.team) + (goalPlayerName(room, g) ? ' (' + goalPlayerName(room, g) + ')' : ''));
      return null;
    }

    // ---- relógio e fases (qualquer um)
    case 'start':
      if (room.status !== 'pre') throw new BadRequest('O jogo já começou.');
      phaseChange(room, 'Começar o jogo', () => { room.status = f.clock ? 'h1' : 'live'; room.clock = { baseSeconds: 0, startedAt: f.clock ? Date.now() : null }; });
      note(room, who(), 'começou o jogo');
      return null;
    case 'pause':
      if ((room.status !== 'h1' && room.status !== 'h2') || room.clock.startedAt === null) throw new BadRequest('O relógio não está correndo.');
      freeze(room); note(room, who(), 'parou o relógio');
      return null;
    case 'resume':
      if ((room.status !== 'h1' && room.status !== 'h2') || room.clock.startedAt !== null) throw new BadRequest('O relógio já está correndo.');
      room.clock.startedAt = Date.now(); note(room, who(), 'retomou o relógio');
      return null;
    case 'break':
      if (room.status !== 'h1' || f.halves !== 2) throw new BadRequest('O intervalo só existe no 1º tempo de jogos com 2 tempos.');
      phaseChange(room, 'Intervalo', () => { freeze(room); room.status = 'break'; });
      note(room, who(), 'iniciou o intervalo');
      return null;
    case 'second':
      if (room.status !== 'break') throw new BadRequest('O 2º tempo só começa depois do intervalo.');
      phaseChange(room, 'Começar o 2º tempo', () => { room.status = 'h2'; room.clock = { baseSeconds: f.minutes * 60, startedAt: Date.now() }; });
      note(room, who(), 'começou o 2º tempo');
      return null;
    case 'finish':
      if (room.status === 'pre' || room.status === 'finished') throw new BadRequest('O jogo não está em andamento.');
      phaseChange(room, 'Encerrar o jogo', () => { freeze(room); room.status = 'finished'; });
      note(room, who(), 'encerrou o jogo');
      return null;
    case 'undo_phase': {
      const lp = room.lastPhase;
      if (!lp) throw new BadRequest('Nada para desfazer.');
      room.status = lp.status; room.clock = lp.clock; room.lastPhase = null;
      note(room, who(), 'desfez: ' + lp.label.toLowerCase());
      return null;
    }
    case 'adjust_clock': {
      const m = Number(b.minutes);
      const s = Number(b.seconds || 0);
      if (!Number.isFinite(m) || m < 0 || m > 240 || !Number.isFinite(s) || s < 0 || s > 59) throw new BadRequest('Tempo inválido.');
      if (room.status !== 'h1' && room.status !== 'h2') throw new BadRequest('Só dá para ajustar com o jogo em andamento.');
      room.clock = { baseSeconds: m * 60 + s, startedAt: room.clock.startedAt === null ? null : Date.now() };
      note(room, who(), 'ajustou o relógio');
      return null;
    }
    case 'reset_game':
      if (b.confirm !== true) throw new BadRequest('Confirmação necessária.');
      room.status = 'pre'; room.clock = { baseSeconds: 0, startedAt: null }; room.goals = []; room.lastPhase = null;
      room.votes = { open: false, revealed: false, ballots: {} };
      note(room, who(), 'zerou o jogo');
      return null;

    case 'setup': {
      const me = who();
      if (b.title !== undefined) room.title = cleanText(b.title, 40, 'nome do jogo', true);
      if (b.venue !== undefined) room.venue = cleanText(b.venue, 60, 'campo', false);
      if (b.date !== undefined) {
        const d = cleanText(b.date, 10, 'data', false);
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new BadRequest('Data inválida.');
        room.date = d || room.date;
      }
      if (b.teamA !== undefined) room.teams.a = cleanText(b.teamA, 24, 'time A', true);
      if (b.teamB !== undefined) room.teams.b = cleanText(b.teamB, 24, 'time B', true);
      if (b.preset !== undefined) room.format = parseFormat(b);
      note(room, me, 'mudou a configuração do jogo');
      return null;
    }
    case 'extend':
      room.expiresAt = Math.min(room.expiresAt + 2 * DAY, room.createdAt + MAX_DAYS * DAY);
      note(room, who(), 'ampliou a duração da sala');
      return null;

    // ---- mural
    case 'comment': {
      const me = who();
      if (limited('cm:' + cid, 1, 1500) || limited('cmip', 600, 60000)) throw new BadRequest('Calma! Aguarde um instante para comentar de novo.');
      const text = cleanText(b.text, 200, 'comentário', true);
      room.comments.push({ id: room.nextCommentId++, name: me, text, ts: Date.now(), cid, reactions: {} });
      if (room.comments.length > 200) room.comments.shift();
      return null;
    }
    case 'comment_delete': {
      const i = room.comments.findIndex((c) => c.id === Number(b.commentId));
      if (i === -1) throw new BadRequest('Comentário não encontrado.');
      room.comments.splice(i, 1);
      return null;
    }
    case 'react': {
      if (!REACTIONS.includes(b.emoji)) throw new BadRequest('Reação inválida.');
      if (limited('rx:' + cid, 20, 10000)) throw new BadRequest('Calma!');
      const c = room.comments.find((x) => x.id === Number(b.commentId));
      if (!c) throw new BadRequest('Comentário não encontrado.');
      const arr = c.reactions[b.emoji] || (c.reactions[b.emoji] = []);
      const i = arr.indexOf(cid);
      if (i === -1) arr.push(cid); else arr.splice(i, 1);
      if (!arr.length) delete c.reactions[b.emoji];
      return null;
    }

    // ---- votação
    case 'vote': {
      if (!room.votes.open || room.votes.revealed) throw new BadRequest('A votação não está aberta.');
      if (!CAT_IDS.includes(b.category)) throw new BadRequest('Categoria inválida.');
      const p = playerById(room, b.playerId);
      if (!p) throw new BadRequest('Jogador inválido.');
      if (p.cid && p.cid === cid) throw new BadRequest('Você não pode votar em você mesmo. 😉');
      if (limited('vt:' + cid, 30, 60000)) throw new BadRequest('Calma!');
      (room.votes.ballots[b.category] || (room.votes.ballots[b.category] = {}))[cid] = p.id;
      return { body: { myVotes: myVotes(room, cid) } };
    }
    case 'votes_open':
      if (!room.players.length) throw new BadRequest('Cadastre os jogadores antes de abrir a votação.');
      room.votes.open = true; room.votes.revealed = false; note(room, who(), 'abriu a votação');
      return null;
    case 'votes_close': room.votes.open = false; note(room, who(), 'fechou a votação'); return null;
    case 'votes_reveal': room.votes.revealed = true; room.votes.open = false; note(room, who(), 'revelou o resultado da votação'); return null;
    case 'votes_reset': room.votes = { open: false, revealed: false, ballots: {} }; note(room, who(), 'zerou a votação'); return null;

    default: throw new BadRequest('Ação desconhecida.');
  }
}

app.post('/api/rooms/:code/do', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const b = req.body || {};
  try {
    const cid = cleanText(b.clientId, 60, 'cliente', true);
    if (limited('act:' + cid, 80, 10000)) throw new BadRequest('Calma! Muitas ações seguidas.');
    if (b.action === 'delete_room') {
      if (b.confirm !== 'APAGAR') throw new BadRequest('Para apagar, digite APAGAR.');
      rooms.delete(room.code);
      io.to(room.code).emit('gone');
      markRemoved(room.code);
      return res.json({ ok: true, deleted: true });
    }
    const out = act(room, b, cid);
    if (out && out.skip) return res.json(out.body);
    emitRoom(room);
    res.json(Object.assign({ ok: true }, (out && out.body) || {}));
  } catch (e) { fail(res, e); }
});

// ---- QR Code do link da sala
app.get('/qr/:code.svg', async (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const url = req.protocol + '://' + req.get('host') + '/s/' + code;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#09090b', light: '#ffffff' } });
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('image/svg+xml').send(svg);
  } catch (e) { res.status(500).end(); }
});

// ---- páginas
const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const salaHtml = fs.readFileSync(path.join(__dirname, 'public', 'sala.html'), 'utf8');
function withOrigin(html, req, extra) {
  const origin = req.protocol + '://' + req.get('host');
  return html.replace(/__ORIGIN__/g, origin).replace(/__TITLE__/g, extra && extra.title ? extra.title : 'Rabugentos');
}
app.get('/', (req, res) => res.type('html').send(withOrigin(indexHtml, req)));
app.get('/s/:code', (req, res) => {
  const room = rooms.get(String(req.params.code || '').toUpperCase());
  const title = room ? room.title.replace(/[<>&"']/g, '') + ' · Rabugentos' : 'Rabugentos';
  res.type('html').send(withOrigin(salaHtml, req, { title }));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'Dados grandes demais.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Dados inválidos.' });
  console.error(err);
  res.status(500).json({ ok: false, error: 'Erro interno.' });
});

// ---------------------------------------------------------------- socket.io
io.on('connection', (socket) => {
  const code = String((socket.handshake.auth && socket.handshake.auth.room) || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) { socket.emit('gone'); return; }
  socket.join(code);
  socket.emit('room', publicRoom(room));
  io.to(code).emit('viewers', viewersOf(code));
  socket.on('disconnect', () => io.to(code).emit('viewers', viewersOf(code)));
});

// ---------------------------------------------------------------- desligamento seguro e início
let closing = false;
async function shutdown(why) {
  if (closing) return;
  closing = true;
  console.log('Encerrando (' + why + '): gravando as salas…');
  clearTimeout(flushTimer);
  try { await Promise.race([flushAll(), new Promise((r) => setTimeout(r, 8000))]); } catch (e) { /* segue */ }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { console.error('Erro inesperado:', e); shutdown('erro').then(() => process.exit(1)); });
process.on('unhandledRejection', (e) => console.error('Promessa rejeitada:', e));

async function boot() {
  let loaded = false;
  if (storage.mode === 'upstash') {
    try {
      for (const raw of await remoteLoadAll()) { const r = normalizeRoom(raw); if (r && r.expiresAt > Date.now()) rooms.set(r.code, r); }
      loaded = true; storage.lastOk = Date.now();
      console.log('Salas recuperadas do Upstash:', rooms.size);
    } catch (e) {
      storage.lastError = String(e.message || e).slice(0, 140);
      console.warn('Não consegui ler o Upstash agora (' + storage.lastError + '). Usando o arquivo local.');
    }
  }
  if (!loaded) { loadRoomsFromFile(); if (storage.mode === 'upstash') rooms.forEach((r, c) => dirty.add(c)); if (dirty.size) scheduleFlush(RETRY_MS); }
  server.listen(PORT, () => {
    console.log('Rabugentos rodando na porta ' + PORT + ' · armazenamento: ' + storage.mode);
    if (CREATE_KEY) console.log('Criação de salas protegida por CREATE_KEY.');
  });
  // Mantém o Render acordado enquanto houver salas (o endereço público vem do próprio Render)
  const SELF = (process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (SELF) setInterval(() => { if (rooms.size > 0) fetch(SELF + '/health').catch(() => {}); }, Number(process.env.SELF_PING_MS) || 10 * 60 * 1000).unref();
}
boot();

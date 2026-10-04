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
const MAX_DAYS = 14; // limite ao prorrogar
const MAX_ROOMS = 300;
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

// filtro simples de palavrões (opcional por sala)
function normWord(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's')
    .replace(/@/g, 'a').replace(/\$/g, 's')
    .replace(/[^a-z]+/g, '')
    .replace(/(.)\1+/g, '$1');
}
const BAD_WORDS = new Set(
  ['cu', 'cuzao', 'caralho', 'carai', 'porra', 'poha', 'merda', 'bosta', 'puta', 'putaria', 'fdp', 'filhodaputa', 'viado', 'buceta', 'bct', 'pqp', 'arrombado', 'fodase', 'foder']
    .map(normWord)
);
function hasBadWord(text) {
  return String(text)
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9@$]+/g, ' ').split(' ').filter(Boolean)
    .some((t) => BAD_WORDS.has(normWord(t)));
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
    adminKey: crypto.randomBytes(12).toString('base64url'),
    scorerCode: randCode(5),
    title: o.title,
    venue: o.venue,
    date: o.date,
    teams: o.teams,
    format: o.format,
    status: 'pre', // pre | h1 | break | h2 | live | finished
    clock: { baseSeconds: 0, startedAt: null },
    roster: [],
    goals: [],
    nextGoalId: 1,
    comments: [],
    nextCommentId: 1,
    votes: { open: false, revealed: false, ballots: {} },
    scoringOpen: false,
    commentsOpen: true,
    filter: false,
    peakViewers: 0,
  };
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
  for (const g of room.goals) if (g.status !== 'annulled') s[g.team] += 1;
  return s;
}
function statusLabel(room) {
  const paused = (room.status === 'h1' || room.status === 'h2') && room.clock.startedAt === null;
  if (paused) return 'Jogo parado';
  return { pre: 'Antes do jogo', h1: room.format.halves === 2 ? '1º tempo' : 'Em jogo', break: 'Intervalo', h2: '2º tempo', live: 'Em jogo', finished: 'Fim de jogo' }[room.status];
}

function results(room) {
  const out = {};
  for (const cat of CAT_IDS) {
    const tally = {};
    const ballots = room.votes.ballots[cat] || {};
    Object.values(ballots).forEach((n) => { tally[n] = (tally[n] || 0) + 1; });
    const list = Object.keys(tally).map((name) => ({ name, count: tally[name] })).sort((x, y) => y.count - x.count || x.name.localeCompare(y.name));
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
    score: computeScore(room),
    goals: room.goals.map((g) => ({
      id: g.id, team: g.team, player: g.player, ownGoal: g.ownGoal, by: g.byName, minute: g.minute, ts: g.ts,
      status: g.status, varCount: g.varIds.length, locked: !!g.varLocked,
    })),
    roster: room.roster,
    comments: room.comments.map((c) => ({ id: c.id, name: c.name, text: c.text, ts: c.ts, reactions: c.reactions })),
    commentsOpen: room.commentsOpen,
    scoringOpen: room.scoringOpen,
    filter: room.filter,
    votes: { open: room.votes.open, revealed: room.votes.revealed, voters, results: room.votes.revealed ? results(room) : null },
    categories: CATEGORIES,
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
// também no Upstash Redis (gratuito): assim a sala sobrevive até a reinício/atualização do Render.
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
function saveSoon() { /* compatibilidade */ scheduleFlush(); }

function loadRoomsFromFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    for (const r of JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))) if (r && r.code && r.expiresAt > Date.now()) rooms.set(r.code, r);
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
function needTeam(v) {
  if (v !== 'a' && v !== 'b') throw new BadRequest('Escolha o time.');
  return v;
}
function addToRoster(room, name) {
  if (!name) return;
  if (room.roster.some((n) => n.toLowerCase() === name.toLowerCase())) return;
  if (room.roster.length < 40) room.roster.push(name);
}

app.get('/health', (req, res) => res.json({
  ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()),
  storage: { mode: storage.mode, protected: storage.mode === 'upstash' && !storage.lastError && storage.lastOk !== null, lastOkSecondsAgo: storage.lastOk ? Math.round((Date.now() - storage.lastOk) / 1000) : null, error: storage.lastError ? 'falha ao gravar' : '' },
}));
app.get('/api/config', (req, res) => res.json({ needsCreateKey: !!CREATE_KEY, days: ROOM_DAYS }));

// ---- criar sala
app.post('/api/rooms', (req, res) => {
  try {
    if (limited('create:' + req.ip, 8, 3600000)) throw new BadRequest('Muitas salas criadas por aqui. Tente de novo mais tarde.');
    if (CREATE_KEY && !sameKey(CREATE_KEY, req.body && req.body.createKey)) return res.status(401).json({ ok: false, error: 'Senha de criação incorreta.' });
    if (rooms.size >= MAX_ROOMS) throw new BadRequest('O servidor está cheio de salas no momento. Tente mais tarde.');
    const b = req.body || {};
    const date = cleanText(b.date, 10, 'data', false);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequest('Data inválida.');
    const room = freshRoom(
      (() => { let c; do { c = randCode(5); } while (rooms.has(c)); return c; })(),
      {
        title: cleanText(b.title, 40, 'nome do jogo', false) || 'Jogo da semana',
        venue: cleanText(b.venue, 60, 'campo', false),
        date: date || todayStr(),
        teams: { a: cleanText(b.teamA, 24, 'time A', false) || 'Time A', b: cleanText(b.teamB, 24, 'time B', false) || 'Time B' },
        format: parseFormat({ preset: b.preset || '2x30', halves: b.halves, minutes: b.minutes }),
      }
    );
    rooms.set(room.code, room);
    markDirty(room.code);
    res.json({ ok: true, code: room.code, adminKey: room.adminKey, scorerCode: room.scorerCode });
  } catch (e) { fail(res, e); }
});

// ---- restaurar sala (backup guardado no celular do organizador)
app.post('/api/rooms/restore', (req, res) => {
  try {
    if (limited('create:' + req.ip, 8, 3600000)) throw new BadRequest('Muitas tentativas. Tente de novo mais tarde.');
    const r = req.body && req.body.room;
    if (!r || typeof r.code !== 'string' || !/^[A-Z2-9]{5}$/.test(r.code) || typeof r.adminKey !== 'string' || r.adminKey.length < 10)
      throw new BadRequest('Backup inválido.');
    if (rooms.has(r.code)) return res.status(409).json({ ok: false, error: 'Essa sala já existe.' });
    if (!(r.expiresAt > Date.now())) return res.status(410).json({ ok: false, error: 'Essa sala já expirou.' });
    if (rooms.size >= MAX_ROOMS) throw new BadRequest('O servidor está cheio de salas no momento.');
    const base = freshRoom(r.code, { title: 'Jogo', venue: '', date: todayStr(), teams: { a: 'Time A', b: 'Time B' }, format: { halves: 2, minutes: 30, clock: true } });
    const room = Object.assign(base, {
      adminKey: r.adminKey,
      scorerCode: typeof r.scorerCode === 'string' ? r.scorerCode.slice(0, 8) : base.scorerCode,
      createdAt: Number(r.createdAt) || base.createdAt,
      expiresAt: Math.min(Number(r.expiresAt), Date.now() + MAX_DAYS * DAY),
      title: cleanText(r.title, 40, 'x', false) || 'Jogo',
      venue: cleanText(r.venue, 60, 'x', false),
      date: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : todayStr(),
      teams: { a: cleanText(r.teams && r.teams.a, 24, 'x', false) || 'Time A', b: cleanText(r.teams && r.teams.b, 24, 'x', false) || 'Time B' },
      format: parseFormat(r.format && r.format.clock === false ? { preset: 'noclock' } : { preset: 'custom', halves: r.format && r.format.halves, minutes: r.format && r.format.minutes }),
      status: ['pre', 'h1', 'break', 'h2', 'live', 'finished'].includes(r.status) ? r.status : 'pre',
      clock: { baseSeconds: Number(r.clock && r.clock.baseSeconds) || 0, startedAt: r.clock && r.clock.startedAt ? Number(r.clock.startedAt) : null },
      roster: Array.isArray(r.roster) ? r.roster.filter((n) => typeof n === 'string').slice(0, 40) : [],
      goals: Array.isArray(r.goals) ? r.goals.slice(0, 300) : [],
      nextGoalId: Number(r.nextGoalId) || 1000,
      comments: Array.isArray(r.comments) ? r.comments.slice(-200) : [],
      nextCommentId: Number(r.nextCommentId) || 1000,
      votes: r.votes && typeof r.votes === 'object' ? { open: !!r.votes.open, revealed: !!r.votes.revealed, ballots: r.votes.ballots && typeof r.votes.ballots === 'object' ? r.votes.ballots : {} } : base.votes,
      scoringOpen: !!r.scoringOpen,
      commentsOpen: r.commentsOpen !== false,
      filter: !!r.filter,
    });
    room.goals = room.goals.filter((g) => g && (g.team === 'a' || g.team === 'b')).map((g) => ({
      id: Number(g.id) || room.nextGoalId++, team: g.team, player: cleanText(g.player, 40, 'x', false), ownGoal: !!g.ownGoal,
      byName: cleanText(g.byName, 30, 'x', false), byId: String(g.byId || '').slice(0, 60), ts: Number(g.ts) || Date.now(),
      minute: g.minute == null ? null : Number(g.minute), status: ['ok', 'contested', 'annulled'].includes(g.status) ? g.status : 'ok',
      varIds: Array.isArray(g.varIds) ? g.varIds.slice(0, 50) : [],
    }));
    room.comments = room.comments.filter((c) => c && typeof c.text === 'string').map((c) => ({
      id: Number(c.id) || room.nextCommentId++, name: cleanText(c.name, 30, 'x', false), text: cleanText(c.text, 200, 'x', false), ts: Number(c.ts) || Date.now(), cid: String(c.cid || '').slice(0, 60),
      reactions: c.reactions && typeof c.reactions === 'object' ? c.reactions : {},
    }));
    rooms.set(room.code, room);
    markDirty(room.code);
    res.json({ ok: true, code: room.code });
  } catch (e) { fail(res, e); }
});

// ---- leitura
app.get('/api/rooms/:code', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, room: publicRoom(room) });
});

app.post('/api/rooms/:code/role', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const b = req.body || {};
  if (limited('role:' + req.ip, 120, 60000)) return res.status(429).json({ ok: false, error: 'Muitas tentativas. Aguarde um minuto.' });
  const admin = sameKey(room.adminKey, b.adminKey);
  res.json({ ok: true, admin, scorer: admin || sameKey(room.scorerCode, String(b.scorerCode || '').toUpperCase()), scorerCode: admin ? room.scorerCode : undefined, myVotes: myVotes(room, b.clientId) });
});

function myVotes(room, cid) {
  const out = {};
  if (!cid) return out;
  CAT_IDS.forEach((c) => { const v = (room.votes.ballots[c] || {})[cid]; if (v) out[c] = v; });
  return out;
}

// ---- gols (organizador, marcadores com código, ou qualquer um se a sala estiver "aberta")
app.post('/api/rooms/:code/goal', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  try {
    const b = req.body || {};
    const isAdmin = sameKey(room.adminKey, b.adminKey);
    const allowed = room.scoringOpen || isAdmin || sameKey(room.scorerCode, String(b.scorerCode || '').toUpperCase());
    if (!allowed) return res.status(403).json({ ok: false, error: 'Para marcar gols você precisa do código de marcador.' });
    const cid = cleanText(b.clientId, 60, 'cliente', true);
    if (limited('goal:' + cid, 6, 15000)) throw new BadRequest('Calma! Muitos gols em poucos segundos.');
    const by = cleanText(b.nickname, 30, 'seu apelido', true);
    const team = needTeam(b.team);
    const player = cleanText(b.player, 40, 'jogador', false);
    const own = b.ownGoal === true;

    const recent = room.goals.filter((g) => g.team === team && g.status !== 'annulled' && Date.now() - g.ts < DUP_WINDOW_MS).pop();
    if (recent && b.confirmNew !== true) {
      return res.json({ ok: false, needConfirm: true, similar: { team, player: recent.player, by: recent.byName, secondsAgo: Math.round((Date.now() - recent.ts) / 1000) } });
    }
    const running = room.format.clock && (room.status === 'h1' || room.status === 'h2' || room.status === 'break');
    const goalId = room.nextGoalId++;
    room.goals.push({
      id: goalId, team, player, ownGoal: own, byName: by, byId: cid, ts: Date.now(),
      minute: running ? Math.floor(secs(room) / 60) + 1 : null, status: 'ok', varIds: [],
    });
    if (!own) addToRoster(room, player);
    emitRoom(room);
    res.json({ ok: true, goalId });
  } catch (e) { fail(res, e); }
});

app.post('/api/rooms/:code/goal/edit', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  try {
    const b = req.body || {};
    const g = room.goals.find((x) => x.id === Number(b.goalId));
    if (!g) throw new BadRequest('Gol não encontrado.');
    const isAdmin = sameKey(room.adminKey, b.adminKey);
    if (!isAdmin && g.byId !== String(b.clientId || '')) throw new BadRequest('Só quem anotou o gol (ou o organizador) pode mudar o autor.');
    g.player = cleanText(b.player, 40, 'jogador', false);
    if (g.player && !g.ownGoal) addToRoster(room, g.player);
    emitRoom(room);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

app.post('/api/rooms/:code/goal/undo', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  try {
    const b = req.body || {};
    const i = room.goals.findIndex((g) => g.id === Number(b.goalId));
    if (i === -1) throw new BadRequest('Gol não encontrado.');
    const isAdmin = sameKey(room.adminKey, b.adminKey);
    if (!isAdmin && room.goals[i].byId !== String(b.clientId || '')) throw new BadRequest('Só quem anotou o gol (ou o organizador) pode desfazer.');
    room.goals.splice(i, 1);
    emitRoom(room);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

app.post('/api/rooms/:code/var', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  try {
    const b = req.body || {};
    const g = room.goals.find((x) => x.id === Number(b.goalId));
    if (!g) throw new BadRequest('Gol não encontrado.');
    const cid = cleanText(b.clientId, 60, 'cliente', true);
    if (g.status === 'annulled') throw new BadRequest('Esse gol já foi anulado.');
    if (g.varLocked) throw new BadRequest('O organizador já validou esse gol.');
    if (!g.varIds.includes(cid)) g.varIds.push(cid);
    g.status = 'contested';
    emitRoom(room);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ---- mural
app.post('/api/rooms/:code/comment', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  try {
    const b = req.body || {};
    if (!room.commentsOpen) return res.status(403).json({ ok: false, error: 'O mural está fechado.' });
    const cid = cleanText(b.clientId, 60, 'cliente', true);
    if (limited('cm:' + cid, 1, 1500) || limited('cmip:' + req.ip, 120, 60000)) throw new BadRequest('Calma! Aguarde um instante para comentar de novo.');
    const name = cleanText(b.name, 30, 'seu apelido', true);
    const text = cleanText(b.text, 200, 'comentário', true);
    if (room.filter && (hasBadWord(name) || hasBadWord(text))) throw new BadRequest('Este mural está com filtro de palavrões. Reescreva, rabugento!');
    room.comments.push({ id: room.nextCommentId++, name, text, ts: Date.now(), cid, reactions: {} });
    if (room.comments.length > 200) room.comments.shift();
    emitRoom(room);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

app.post('/api/rooms/:code/react', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  try {
    const b = req.body || {};
    const cid = cleanText(b.clientId, 60, 'cliente', true);
    if (!REACTIONS.includes(b.emoji)) throw new BadRequest('Reação inválida.');
    if (limited('rx:' + cid, 20, 10000)) throw new BadRequest('Calma!');
    const c = room.comments.find((x) => x.id === Number(b.commentId));
    if (!c) throw new BadRequest('Comentário não encontrado.');
    const arr = c.reactions[b.emoji] || (c.reactions[b.emoji] = []);
    const i = arr.indexOf(cid);
    if (i === -1) arr.push(cid); else arr.splice(i, 1);
    if (!arr.length) delete c.reactions[b.emoji];
    emitRoom(room);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ---- votação
app.post('/api/rooms/:code/vote', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  try {
    const b = req.body || {};
    const cid = cleanText(b.clientId, 60, 'cliente', true);
    if (!room.votes.open || room.votes.revealed) throw new BadRequest('A votação não está aberta.');
    if (!CAT_IDS.includes(b.category)) throw new BadRequest('Categoria inválida.');
    if (!room.roster.includes(b.candidate)) throw new BadRequest('Jogador inválido.');
    if (limited('vt:' + cid, 30, 60000)) throw new BadRequest('Calma!');
    (room.votes.ballots[b.category] || (room.votes.ballots[b.category] = {}))[cid] = b.candidate;
    emitRoom(room);
    res.json({ ok: true, myVotes: myVotes(room, cid) });
  } catch (e) { fail(res, e); }
});

// ---- ações do organizador
function adminAction(room, b) {
  const f = room.format;
  switch (b.action) {
    case 'ping': return;

    case 'setup': {
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
      return;
    }

    case 'roster': {
      const seen = new Set();
      const list = [];
      String(b.text || '').split(/\r?\n/).forEach((l) => {
        const n = l.trim().replace(/\s+/g, ' ').slice(0, 30);
        if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); list.push(n); }
      });
      if (list.length > 40) throw new BadRequest('No máximo 40 nomes.');
      room.roster = list;
      return;
    }

    case 'start':
      if (room.status !== 'pre') throw new BadRequest('O jogo já começou.');
      room.status = f.clock ? 'h1' : 'live';
      room.clock = { baseSeconds: 0, startedAt: f.clock ? Date.now() : null };
      return;
    case 'pause':
      if ((room.status !== 'h1' && room.status !== 'h2') || room.clock.startedAt === null) throw new BadRequest('O relógio não está correndo.');
      freeze(room);
      return;
    case 'resume':
      if ((room.status !== 'h1' && room.status !== 'h2') || room.clock.startedAt !== null) throw new BadRequest('O relógio já está correndo.');
      room.clock.startedAt = Date.now();
      return;
    case 'break':
      if (room.status !== 'h1' || f.halves !== 2) throw new BadRequest('O intervalo só existe no 1º tempo de jogos com 2 tempos.');
      freeze(room);
      room.status = 'break';
      return;
    case 'second':
      if (room.status !== 'break') throw new BadRequest('O 2º tempo só começa depois do intervalo.');
      room.status = 'h2';
      room.clock = { baseSeconds: f.minutes * 60, startedAt: Date.now() };
      return;
    case 'finish':
      if (room.status === 'pre' || room.status === 'finished') throw new BadRequest('O jogo não está em andamento.');
      freeze(room);
      room.status = 'finished';
      return;
    case 'adjust_clock': {
      const m = Number(b.minutes);
      const s = Number(b.seconds || 0);
      if (!Number.isFinite(m) || m < 0 || m > 240 || !Number.isFinite(s) || s < 0 || s > 59) throw new BadRequest('Tempo inválido.');
      if (room.status !== 'h1' && room.status !== 'h2') throw new BadRequest('Só dá para ajustar com o jogo em andamento.');
      room.clock = { baseSeconds: m * 60 + s, startedAt: room.clock.startedAt === null ? null : Date.now() };
      return;
    }
    case 'reset_game':
      if (b.confirm !== true) throw new BadRequest('Confirmação necessária.');
      room.status = 'pre';
      room.clock = { baseSeconds: 0, startedAt: null };
      room.goals = [];
      room.votes = { open: false, revealed: false, ballots: {} };
      return;

    case 'scoring_open': room.scoringOpen = b.open === true; return;
    case 'new_scorer_code': room.scorerCode = randCode(5); return;

    case 'votes_open': room.votes.open = b.open === true; if (b.open === true) room.votes.revealed = false; return;
    case 'votes_reveal': room.votes.revealed = true; room.votes.open = false; return;
    case 'votes_reset': room.votes = { open: false, revealed: false, ballots: {} }; return;

    case 'delete_goal': {
      const i = room.goals.findIndex((g) => g.id === Number(b.id));
      if (i === -1) throw new BadRequest('Gol não encontrado.');
      room.goals.splice(i, 1);
      return;
    }
    case 'resolve_goal': {
      const g = room.goals.find((x) => x.id === Number(b.id));
      if (!g) throw new BadRequest('Gol não encontrado.');
      if (b.decision === 'validate') { g.status = 'ok'; g.varLocked = true; g.varIds = []; }
      else if (b.decision === 'annul') { g.status = 'annulled'; }
      else throw new BadRequest('Decisão inválida.');
      return;
    }

    case 'delete_comment': {
      const i = room.comments.findIndex((c) => c.id === Number(b.id));
      if (i === -1) throw new BadRequest('Comentário não encontrado.');
      room.comments.splice(i, 1);
      return;
    }
    case 'comments_open': room.commentsOpen = b.open === true; return;
    case 'filter': room.filter = b.on === true; return;

    case 'extend':
      room.expiresAt = Math.min(room.expiresAt + 2 * DAY, room.createdAt + MAX_DAYS * DAY);
      return;

    default: throw new BadRequest('Ação desconhecida.');
  }
}

app.post('/api/rooms/:code/admin', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const b = req.body || {};
  if (limited('adm:' + req.ip, 200, 60000)) return res.status(429).json({ ok: false, error: 'Muitas ações seguidas.' });
  if (!sameKey(room.adminKey, b.adminKey)) return res.status(401).json({ ok: false, error: 'Chave do organizador incorreta.' });
  try {
    if (b.action === 'delete_room') {
      if (b.confirm !== true) throw new BadRequest('Confirmação necessária.');
      rooms.delete(room.code);
      io.to(room.code).emit('gone');
      markRemoved(room.code);
      return res.json({ ok: true, deleted: true });
    }
    adminAction(room, b);
  } catch (e) { return fail(res, e); }
  emitRoom(room);
  res.json({ ok: true, scorerCode: room.scorerCode, room: publicRoom(room) });
});

app.get('/api/rooms/:code/backup', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  if (!sameKey(room.adminKey, req.get('x-admin-key'))) return res.status(401).json({ ok: false, error: 'Chave do organizador incorreta.' });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, room });
});

// ---- QR Code do link da sala
app.get('/qr/:code.svg', async (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const url = req.protocol + '://' + req.get('host') + '/s/' + code;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#0e1117', light: '#ffffff' } });
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
      for (const r of await remoteLoadAll()) if (r && r.code && r.expiresAt > Date.now()) rooms.set(r.code, r);
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

// Sequência — servidor WebSocket com as regras do jogo (versão protótipo)
// Executar: npm install && npm start   →  http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;
const HAND_SIZE = 5;
const COPIES_PER_NUMBER = 6; // 0–9 × 6 = 60 cartas na mão

// ---------- HTTP estático ----------
// Arquivos estáticos: usa ./public se existir, senão a própria pasta do server.js
const STATIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;

const server = http.createServer((req, res) => {
  const file = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const full = path.join(STATIC_DIR, path.normalize(file));
  if (!full.startsWith(STATIC_DIR) || full === path.join(STATIC_DIR, 'server.js')) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(`não encontrado: ${file} (procurando em ${STATIC_DIR})`); }
    const ext = path.extname(full);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// ---------- util ----------
const rooms = new Map();
let nextId = 1;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function secretSizeFor(n) {
  if (n <= 4) return 4;
  if (n <= 6) return 5;
  return 6;
}

function makeRoom(code) {
  return {
    code,
    players: [],      // {id, name, ws, hand, points, eliminated, online}
    hostId: null,
    phase: 'lobby',   // lobby | anunciar | investigar | fim
    round: 0,
    deck: [],
    discard: [],
    secret: [],       // {value, revealed}
    markerIdx: 0,     // índice em players do primeiro a anunciar
    order: [],        // ids na ordem de anúncio desta rodada
    turnIdx: 0,
    plays: {},        // id -> {card, announced}
    chuteUsed: false,
    lastRound: null,  // resumo da rodada anterior (público)
    investigators: [],
    invIdx: 0,
    playedNumbers: [],
    log: [],
    result: null,
  };
}

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function log(room, text) {
  room.log.push(text);
  if (room.log.length > 60) room.log.shift();
}

function active(room) { return room.players.filter(p => !p.eliminated); }

function publicState(room, me) {
  const current = room.order[room.turnIdx];
  const investigator = room.investigators[room.invIdx];
  return {
    type: 'state',
    me: me.id,
    room: room.code,
    phase: room.phase,
    round: room.round,
    hostId: room.hostId,
    deckCount: room.deck.length,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    secret: room.secret.map(s => (s.revealed ? { revealed: true, value: s.value } : { revealed: false })),
    players: room.players.map(p => ({
      id: p.id, name: p.name, points: p.points, eliminated: p.eliminated, online: p.online,
      cards: p.hand.length,
      announced: room.plays[p.id] ? room.plays[p.id].announced : null,
      played: !!room.plays[p.id],
      isMarker: room.players[room.markerIdx] && room.players[room.markerIdx].id === p.id,
    })),
    hand: me.hand.slice().sort((a, b) => a - b),
    currentPlayer: room.phase === 'anunciar' ? current : null,
    investigator: room.phase === 'investigar' ? investigator : null,
    canChute: room.phase === 'anunciar' && room.turnIdx === 0 && !room.chuteUsed && !me.eliminated && room.order.includes(me.id),
    lastRound: room.lastRound,
    log: room.log.slice(-25),
    result: room.result,
  };
}

function broadcast(room) {
  for (const p of room.players) send(p.ws, publicState(room, p));
}

// ---------- jogo ----------
function startGame(room) {
  const n = room.players.length;
  room.deck = shuffle([].concat(...Array.from({ length: COPIES_PER_NUMBER }, () => Array.from({ length: 10 }, (_, i) => i))));
  room.discard = [];
  const gold = shuffle(Array.from({ length: 10 }, (_, i) => i));
  room.secret = gold.slice(0, secretSizeFor(n)).map(v => ({ value: v, revealed: false }));
  for (const p of room.players) {
    p.hand = room.deck.splice(0, HAND_SIZE);
    p.points = 0;
    p.eliminated = false;
  }
  room.round = 0;
  room.phase = 'lobby'; // sem isso, checkEnd() vê "fim" e aborta a primeira rodada
  room.markerIdx = Math.floor(Math.random() * n);
  room.log = [];
  room.result = null;
  room.lastRound = null;
  log(room, `Partida iniciada com ${n} jogadores. O Segredo tem ${room.secret.length} cartas.`);
  startRound(room);
}

function nextMarker(room) {
  const n = room.players.length;
  for (let k = 1; k <= n; k++) {
    const idx = (room.markerIdx + k) % n;
    if (!room.players[idx].eliminated) return idx;
  }
  return room.markerIdx;
}

function startRound(room) {
  if (checkEnd(room)) return;
  room.round++;
  if (room.round > 1) room.markerIdx = nextMarker(room);
  const n = room.players.length;
  room.order = [];
  for (let k = 0; k < n; k++) {
    const p = room.players[(room.markerIdx + k) % n];
    if (!p.eliminated) room.order.push(p.id);
  }
  room.plays = {};
  room.turnIdx = 0;
  room.chuteUsed = false;
  room.investigators = [];
  room.invIdx = 0;
  room.playedNumbers = [];
  room.phase = 'anunciar';
  log(room, `Rodada ${room.round}. ${room.players[room.markerIdx].name} anuncia primeiro.`);
}

function playCard(room, p, card, announced) {
  if (room.phase !== 'anunciar') return 'Não é hora de jogar.';
  if (room.order[room.turnIdx] !== p.id) return 'Não é a sua vez de anunciar.';
  if (!Number.isInteger(card) || !p.hand.includes(card)) return 'Você não tem essa carta.';
  if (!Number.isInteger(announced) || announced < 0 || announced > 9) return 'Anuncie um número de 0 a 9.';
  p.hand.splice(p.hand.indexOf(card), 1);
  room.plays[p.id] = { card, announced };
  log(room, `${p.name} anuncia: "joguei ${announced}".`);
  room.turnIdx++;
  if (room.turnIdx >= room.order.length) resolveRound(room);
  return null;
}

function resolveRound(room) {
  const counts = {};
  for (const id of room.order) { const v = room.plays[id].card; counts[v] = (counts[v] || 0) + 1; }
  room.playedNumbers = Object.keys(counts).map(Number);
  const summary = [];
  room.investigators = [];
  for (const id of room.order) {
    const p = room.players.find(x => x.id === id);
    const { card, announced } = room.plays[id];
    const repeated = counts[card] > 1;
    if (repeated) {
      room.discard.push(card);
      let drew = false;
      if (room.deck.length === 0 && room.discard.length > 0) { /* sem reembaralho: monte acabou de vez */ }
      if (room.deck.length > 0) { p.hand.push(room.deck.shift()); drew = true; }
      summary.push({ id, name: p.name, card, announced, repeated: true, drew });
    } else {
      p.hand.push(card);
      room.investigators.push(id);
      summary.push({ id, name: p.name, card, announced, repeated: false });
    }
  }
  room.lastRound = { round: room.round, plays: summary, numbers: room.playedNumbers.slice().sort() };
  log(room, `Cartas reveladas: ${room.order.map(id => room.plays[id].card).join(' ')}. Únicos: ${room.investigators.length ? room.investigators.map(id => room.players.find(x => x.id === id).name).join(', ') : 'nenhum'}.`);
  if (room.investigators.length === 0) return startRound(room);
  room.phase = 'investigar';
  room.invIdx = 0;
}

function investigate(room, p, pos) {
  if (room.phase !== 'investigar') return 'Não é hora de investigar.';
  if (room.investigators[room.invIdx] !== p.id) return 'Não é a sua vez de investigar.';
  if (!Number.isInteger(pos) || pos < 0 || pos >= room.secret.length) return 'Posição inválida.';
  const s = room.secret[pos];
  if (s.revealed) return 'Essa posição já está revelada.';
  if (room.playedNumbers.includes(s.value)) {
    s.revealed = true;
    p.points += 1;
    log(room, `${p.name} investiga a posição ${pos + 1}: é ${s.value}, que saiu na rodada. Revelada! (+1)`);
    if (room.secret.every(x => x.revealed)) {
      p.points += 4;
      log(room, `${p.name} revelou a última carta! (+4)`);
      return finish(room, p);
    }
  } else {
    send(p.ws, { type: 'peek', pos, value: s.value });
    log(room, `${p.name} investiga a posição ${pos + 1}. Nada foi revelado.`);
  }
  room.invIdx++;
  if (room.invIdx >= room.investigators.length) startRound(room);
  return null;
}

function chute(room, p, guess) {
  if (room.phase !== 'anunciar' || room.turnIdx !== 0) return 'O chute só pode ser feito no início da rodada.';
  if (room.chuteUsed) return 'Já houve um chute nesta rodada.';
  if (p.eliminated || !room.order.includes(p.id)) return 'Você não está mais na partida.';
  const hidden = room.secret.map((s, i) => ({ s, i })).filter(x => !x.s.revealed);
  if (!Array.isArray(guess) || guess.length !== hidden.length) return `Informe ${hidden.length} números.`;
  room.chuteUsed = true;
  log(room, `${p.name} chuta a sequência: ${guess.join(' ')}. Conferindo em segredo...`);
  for (let k = 0; k < hidden.length; k++) {
    if (hidden[k].s.value !== guess[k]) {
      p.eliminated = true;
      p.points = 0;
      room.discard.push(...p.hand);
      p.hand = [];
      room.order = room.order.filter(id => id !== p.id);
      send(p.ws, { type: 'chuteResult', ok: false });
      log(room, `${p.name} diz "errei" e sai da partida com zero pontos.`);
      if (active(room).length < 2) return finish(room, null);
      return null;
    }
  }
  for (const h of hidden) h.s.revealed = true;
  p.points += hidden.length + 4;
  send(p.ws, { type: 'chuteResult', ok: true });
  log(room, `${p.name} acertou a sequência inteira! (+${hidden.length} e +4)`);
  return finish(room, p);
}

function checkEnd(room) {
  if (room.phase === 'fim') return true;
  if (room.secret.every(s => s.revealed)) return finish(room, null), true;
  if (active(room).length < 2) return finish(room, null), true;
  if (room.deck.length === 0 && active(room).some(p => p.hand.length === 0)) {
    log(room, 'O monte acabou e um jogador ficou sem cartas. Fim de jogo.');
    return finish(room, null), true;
  }
  return false;
}

function finish(room, closer) {
  room.phase = 'fim';
  const scores = room.players.map(p => {
    let penalty = 0;
    if (!p.eliminated) {
      const c = {};
      for (const v of p.hand) c[v] = (c[v] || 0) + 1;
      for (const v in c) if (c[v] >= 2) penalty += c[v];
    }
    return { id: p.id, name: p.name, eliminated: p.eliminated, base: p.points, penalty, total: p.eliminated ? 0 : p.points - penalty, hand: p.hand.slice().sort((a, b) => a - b) };
  }).sort((a, b) => b.total - a.total);
  const top = scores[0] ? scores[0].total : 0;
  room.result = {
    scores,
    winners: scores.filter(s => s.total === top && !s.eliminated).map(s => s.name),
    secret: room.secret.map(s => s.value),
    closer: closer ? closer.name : null,
  };
  log(room, `Fim de jogo. Vencedor: ${room.result.winners.join(', ') || 'ninguém'}.`);
  return null;
}

// ---------- conexões ----------
wss.on('connection', (ws) => {
  let room = null;
  let me = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const name = String(msg.name || '').trim().slice(0, 20);
      const code = String(msg.room || 'mesa').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'mesa';
      if (!name) return send(ws, { type: 'error', text: 'Informe um nome.' });
      if (!rooms.has(code)) rooms.set(code, makeRoom(code));
      room = rooms.get(code);
      const existing = room.players.find(p => p.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        if (existing.online) return send(ws, { type: 'error', text: 'Já existe alguém com esse nome na sala.' });
        existing.ws = ws; existing.online = true; me = existing;
        log(room, `${me.name} voltou.`);
      } else {
        if (room.phase !== 'lobby' && room.phase !== 'fim') return send(ws, { type: 'error', text: 'A partida já começou nessa sala.' });
        if (room.players.length >= MAX_PLAYERS) return send(ws, { type: 'error', text: 'Sala cheia.' });
        me = { id: nextId++, name, ws, hand: [], points: 0, eliminated: false, online: true };
        room.players.push(me);
        if (!room.hostId) room.hostId = me.id;
        log(room, `${me.name} entrou na sala.`);
      }
      return broadcast(room);
    }

    if (!room || !me) return send(ws, { type: 'error', text: 'Entre numa sala primeiro.' });
    let err = null;

    if (msg.type === 'start') {
      if (room.phase === 'lobby' && me.id !== room.hostId) err = 'Só o anfitrião pode iniciar.';
      else if (room.phase !== 'lobby' && room.phase !== 'fim') err = 'A partida já está em andamento.';
      else if (room.players.length < MIN_PLAYERS) err = `Precisa de pelo menos ${MIN_PLAYERS} jogadores.`;
      else startGame(room);
    } else if (msg.type === 'toLobby') {
      if (room.phase === 'fim') {
        room.phase = 'lobby'; room.result = null; room.lastRound = null; room.secret = []; room.round = 0;
        for (const p of room.players) { p.hand = []; p.points = 0; p.eliminated = false; }
        log(room, `${me.name} abriu a sala para uma nova partida.`);
      }
    } else if (msg.type === 'play') {
      err = playCard(room, me, Number(msg.card), Number(msg.announced));
    } else if (msg.type === 'investigate') {
      err = investigate(room, me, Number(msg.pos));
    } else if (msg.type === 'chute') {
      err = chute(room, me, Array.isArray(msg.guess) ? msg.guess.map(Number) : null);
    } else if (msg.type === 'leaveLobby') {
      if (room.phase === 'lobby') {
        room.players = room.players.filter(p => p.id !== me.id);
        if (room.hostId === me.id) room.hostId = room.players[0] ? room.players[0].id : null;
        log(room, `${me.name} saiu.`);
        broadcast(room);
        me = null; room = null;
        return send(ws, { type: 'left' });
      }
    }

    if (err) send(ws, { type: 'error', text: err });
    broadcast(room);
  });

  ws.on('close', () => {
    if (!room || !me) return;
    if (room.phase === 'lobby') {
      room.players = room.players.filter(p => p.id !== me.id);
      if (room.hostId === me.id) room.hostId = room.players[0] ? room.players[0].id : null;
      log(room, `${me.name} saiu.`);
      if (room.players.length === 0) rooms.delete(room.code);
    } else {
      me.online = false;
      log(room, `${me.name} desconectou (pode voltar com o mesmo nome).`);
      if (room.hostId === me.id) {
        const next = room.players.find(p => p.online);
        if (next) { room.hostId = next.id; log(room, `${next.name} agora é o anfitrião.`); }
      }
    }
    broadcast(room);
  });
});

server.listen(PORT, () => console.log(`Sequência rodando em http://localhost:${PORT}`));

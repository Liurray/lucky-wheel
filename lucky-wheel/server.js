const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const DEFAULT_PRIZES = ['大獎', '二獎', '三獎', '小獎', '銘謝惠顧', '再抽一次'];
const SPIN_MS = 5000;

// ---------- 房間資料(會存到 data.json) ----------
let rooms = {};
try {
  rooms = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  Object.values(rooms).forEach((r) => (r.spinning = false));
} catch (e) {
  rooms = {};
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(rooms));
    } catch (e) {
      console.error('save failed', e.message);
    }
  }, 300);
}

function getRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      prizes: [...DEFAULT_PRIZES],
      removeOnWin: false,
      history: [],
      players: [],
      turn: 0,
      spinning: false,
    };
  }
  return rooms[code];
}

// ---------- 連線 ----------
const conns = new Map(); // ws -> { room, name }

function isOnline(code, name) {
  for (const c of conns.values()) if (c.room === code && c.name === name) return true;
  return false;
}

function advance(code) {
  const r = rooms[code];
  const len = r.players.length;
  for (let i = 1; i <= len; i++) {
    const idx = (r.turn + i) % len;
    if (isOnline(code, r.players[idx].name)) {
      r.turn = idx;
      return;
    }
  }
}

function snapshot(code) {
  const r = rooms[code];
  const players = r.players.map((p) => ({ name: p.name, online: isOnline(code, p.name) }));
  const host = players.find((p) => p.online);
  return {
    type: 'state',
    room: code,
    players,
    turn: r.players[r.turn] ? r.players[r.turn].name : null,
    host: host ? host.name : null,
    prizes: r.prizes,
    removeOnWin: r.removeOnWin,
    history: r.history.slice(0, 200),
    spinning: r.spinning,
  };
}

function broadcast(code, msg) {
  const data = JSON.stringify(msg || snapshot(code));
  for (const [ws, c] of conns) {
    if (c.room === code && ws.readyState === 1) ws.send(data);
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ---------- HTTP(只提供首頁) ----------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, buf) => {
      if (err) {
        res.writeHead(500);
        return res.end('server error');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
  } else if (url === '/healthz') {
    res.writeHead(200);
    res.end('ok');
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch (e) {
      return;
    }
    const c = conns.get(ws);

    if (m.type === 'join') {
      const code = String(m.room || '').trim().replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 20);
      const name = String(m.name || '').trim().slice(0, 12);
      if (!code || !name) return send(ws, { type: 'error', message: '請填寫房間代碼與 ID' });
      if (isOnline(code, name)) return send(ws, { type: 'error', message: '這個 ID 已經有人在使用了,換一個吧' });
      const r = getRoom(code);
      if (!r.players.find((p) => p.name === name)) r.players.push({ name });
      conns.set(ws, { room: code, name });
      send(ws, { type: 'joined', name, room: code });
      const cur = r.players[r.turn];
      if (!cur || !isOnline(code, cur.name)) advance(code);
      save();
      return broadcast(code);
    }

    if (!c) return;
    const r = rooms[c.room];
    if (!r) return;

    if (m.type === 'spin') {
      if (r.spinning || !r.prizes.length) return;
      const cur = r.players[r.turn];
      if (!cur || cur.name !== c.name) return;
      r.spinning = true;
      const index = Math.floor(Math.random() * r.prizes.length);
      const offset = (Math.random() - 0.5) * 0.8;
      const prize = r.prizes[index];
      const player = c.name;
      const room = c.room;
      broadcast(room);
      broadcast(room, { type: 'spin', index, offset, player, prize, duration: SPIN_MS });
      setTimeout(() => {
        r.history.unshift({ player, prize, time: Date.now() });
        if (r.history.length > 500) r.history.length = 500;
        if (r.removeOnWin) r.prizes.splice(index, 1);
        r.spinning = false;
        advance(room);
        save();
        broadcast(room);
      }, SPIN_MS + 400);
    }

    if (m.type === 'settings') {
      if (r.spinning) return;
      const host = snapshot(c.room).host;
      if (host !== c.name) return;
      const prizes = (Array.isArray(m.prizes) ? m.prizes : [])
        .map((s) => String(s).trim().slice(0, 30))
        .filter(Boolean)
        .slice(0, 24);
      r.prizes = prizes;
      r.removeOnWin = !!m.removeOnWin;
      save();
      broadcast(c.room);
    }

    if (m.type === 'clearHistory') {
      const host = snapshot(c.room).host;
      if (host !== c.name || r.spinning) return;
      r.history = [];
      save();
      broadcast(c.room);
    }
  });

  ws.on('close', () => {
    const c = conns.get(ws);
    conns.delete(ws);
    if (!c) return;
    const r = rooms[c.room];
    if (!r) return;
    const cur = r.players[r.turn];
    if (cur && cur.name === c.name && !r.spinning) advance(c.room);
    broadcast(c.room);
  });
});

// 心跳:避免連線被代理閒置斷線,並清掉死連線
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log('Lucky wheel running on port ' + PORT));

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const DEFAULT_PRIZES = ['大獎', '二獎', '三獎', '小獎', '銘謝惠顧', '再抽一次'];
const SPIN_AGAIN = '再抽一次'; // 抽中這個獎項的人可以再轉一次
const SPIN_MS = 5000;

// ---------- 房間資料(會存到 data.json) ----------
// 用 Map 存房間:房間代碼就算是 constructor、__proto__ 之類的字也不會出錯
const rooms = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  for (const [code, r] of Object.entries(saved)) {
    if (!r || !Array.isArray(r.players) || !Array.isArray(r.prizes)) continue;
    r.history = Array.isArray(r.history) ? r.history : [];
    r.turn = Number.isInteger(r.turn) ? r.turn : 0;
    r.removeOnWin = !!r.removeOnWin;
    r.spinning = false;
    rooms.set(code, r);
  }
} catch (e) {
  // 沒有 data.json 或格式壞掉 → 從空的開始
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries(rooms)));
    } catch (e) {
      console.error('save failed', e.message);
    }
  }, 300);
}

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      prizes: [...DEFAULT_PRIZES],
      removeOnWin: false,
      history: [],
      players: [],
      turn: 0,
      spinning: false,
    });
  }
  return rooms.get(code);
}

// ---------- 連線 ----------
const conns = new Map(); // ws -> { room, name }

function findConn(code, name) {
  for (const [ws, c] of conns) if (c.room === code && c.name === name) return ws;
  return null;
}
function isOnline(code, name) {
  return findConn(code, name) !== null;
}

function advance(code) {
  const r = rooms.get(code);
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
  const r = rooms.get(code);
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

// maxPayload:單一訊息最大 16KB,避免有人丟超大資料拖垮伺服器
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

// ---------- 各種訊息的處理 ----------
function handleJoin(ws, m) {
  const code = String(m.room || '').trim().replace(/[^\w一-龥-]/g, '').slice(0, 20);
  const name = String(m.name || '').trim().slice(0, 12);
  const token = String(m.token || '').slice(0, 64);
  if (!code || !name) return send(ws, { type: 'error', message: '請填寫房間代碼與 ID' });

  const r = getRoom(code);
  const existing = r.players.find((p) => p.name === name);
  const oldWs = findConn(code, name);

  if (oldWs && oldWs !== ws) {
    // 同一個 ID 已經在線上:只有「同一台裝置/瀏覽器」(token 相同)才能接回,
    // 這種情況通常是手機斷線但伺服器還沒發現 → 把舊連線踢掉,換新的接上
    if (!token || !existing || existing.token !== token) {
      return send(ws, { type: 'error', message: '這個 ID 已經有人在使用了,換一個吧' });
    }
    conns.delete(oldWs); // 先移除,舊連線關閉時就不會被當成「離線」而跳過輪次
    send(oldWs, { type: 'kicked', message: '你已在其他視窗或裝置重新連線' });
    try { oldWs.close(); } catch (e) {}
  }

  if (!existing) r.players.push({ name, token });
  else if (token) existing.token = token;

  // 這條連線如果之前在別的房間,先離開那個房間
  const prev = conns.get(ws);
  conns.set(ws, { room: code, name });
  if (prev && prev.room !== code && rooms.has(prev.room)) {
    const pr = rooms.get(prev.room);
    const pcur = pr.players[pr.turn];
    if (pcur && pcur.name === prev.name && !pr.spinning) advance(prev.room);
    broadcast(prev.room);
  }

  send(ws, { type: 'joined', name, room: code });
  const cur = r.players[r.turn];
  if (!cur || !isOnline(code, cur.name)) advance(code);
  save();
  broadcast(code);
}

function handleSpin(c, r) {
  if (r.spinning || !r.prizes.length) return;
  const cur = r.players[r.turn];
  if (!cur || cur.name !== c.name) return;
  r.spinning = true;
  const index = Math.floor(Math.random() * r.prizes.length);
  const offset = (Math.random() - 0.5) * 0.8;
  const prize = r.prizes[index];
  const player = c.name;
  const room = c.room;
  const again = prize.trim() === SPIN_AGAIN;
  broadcast(room);
  broadcast(room, { type: 'spin', index, offset, player, prize, again, duration: SPIN_MS });
  setTimeout(() => {
    r.history.unshift({ player, prize, time: Date.now() });
    if (r.history.length > 500) r.history.length = 500;
    if (r.removeOnWin) r.prizes.splice(index, 1);
    r.spinning = false;
    // 抽中「再抽一次」而且人還在線上 → 不換人,同一位再轉
    if (!(again && isOnline(room, player))) advance(room);
    save();
    broadcast(room);
  }, SPIN_MS + 400);
}

function handleSettings(c, r, m) {
  if (r.spinning) return;
  if (snapshot(c.room).host !== c.name) return;
  r.prizes = (Array.isArray(m.prizes) ? m.prizes : [])
    .map((s) => String(s).trim().slice(0, 30))
    .filter(Boolean)
    .slice(0, 24);
  r.removeOnWin = !!m.removeOnWin;
  save();
  broadcast(c.room);
}

function handleClearHistory(c, r) {
  if (snapshot(c.room).host !== c.name || r.spinning) return;
  r.history = [];
  save();
  broadcast(c.room);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('error', () => {}); // 連線錯誤不要讓整台伺服器掛掉

  ws.on('message', (raw) => {
    // 任何一則訊息處理出錯,都只影響這一則,不會讓伺服器當掉
    try {
      let m;
      try {
        m = JSON.parse(raw);
      } catch (e) {
        return;
      }
      if (!m || typeof m !== 'object') return;

      if (m.type === 'join') return handleJoin(ws, m);

      const c = conns.get(ws);
      if (!c) return;
      const r = rooms.get(c.room);
      if (!r) return;

      if (m.type === 'spin') handleSpin(c, r);
      else if (m.type === 'settings') handleSettings(c, r, m);
      else if (m.type === 'clearHistory') handleClearHistory(c, r);
    } catch (e) {
      console.error('message handling failed:', e);
    }
  });

  ws.on('close', () => {
    try {
      const c = conns.get(ws);
      conns.delete(ws);
      if (!c) return;
      const r = rooms.get(c.room);
      if (!r) return;
      const cur = r.players[r.turn];
      if (cur && cur.name === c.name && !r.spinning) advance(c.room);
      broadcast(c.room);
    } catch (e) {
      console.error('close handling failed:', e);
    }
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

// 最後一道保險:就算哪裡漏接錯誤,也只記錄下來,不讓整台伺服器停掉
process.on('uncaughtException', (e) => console.error('uncaught:', e));

server.listen(PORT, () => console.log('Lucky wheel running on port ' + PORT));

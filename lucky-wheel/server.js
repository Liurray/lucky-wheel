const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const MAIN = [
  { score: 60, weight: 15 }, { score: 300, weight: 25 }, { score: 980, weight: 25 },
  { score: 1980, weight: 20 }, { score: 3280, weight: 12 }, { score: 6480, weight: 3 }
];
const SPECIAL = [
  { key: 'virtual', label: '解鎖 +1 顆虛寶', weight: 40 },
  { key: '500', label: '獎池 +500 分', weight: 30 },
  { key: '1000', label: '獎池 +1,000 分', weight: 20 },
  { key: '2000', label: '獎池 +2,000 分', weight: 10 }
];
const SPECIAL_CHANCE = 15, INITIAL_ITEMS = 3, MAX_ITEMS = 6, ITEM_COST = 5000, BUDGET = 100000;
const TIERS = [
  { key: '170', min: 0, label: '170 元儲值卡', cost: 170 },
  { key: '490', min: 80000, label: '490 元儲值卡', cost: 490 },
  { key: 'purple', min: 110000, label: '紫色籤子', cost: 690 },
  { key: '990', min: 140000, label: '990 元儲值卡', cost: 990 }
];
const rooms = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  for (const [code, old] of Object.entries(saved)) {
    if (!old || !Array.isArray(old.players)) continue;
    rooms.set(code, {
      players: old.players.map(p => typeof p === 'string' ? { name: p, token: '' } : p),
      draws: old.draws && typeof old.draws === 'object' ? old.draws : {},
      history: Array.isArray(old.history) ? old.history : [], pool: Number(old.pool) || 0,
      virtualItems: Number.isInteger(old.virtualItems) ? old.virtualItems : INITIAL_ITEMS,
      queue: [], processing: false, spinning: false
    });
  }
} catch {}
function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { players: [], draws: {}, history: [], pool: 0, virtualItems: INITIAL_ITEMS, queue: [], processing: false, spinning: false });
  return rooms.get(code);
}
let saveTimer;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries([...rooms].map(([k,r]) => [k,{players:r.players,draws:r.draws,history:r.history,pool:r.pool,virtualItems:r.virtualItems}])))); } catch(e) { console.error('save failed', e.message); } }, 100); }
const conns = new Map();
function online(code, name) { for (const c of conns.values()) if (c.room === code && c.name === name) return true; return false; }
function currentTier(pool) { let t = TIERS[0]; for (const tier of TIERS) if (pool >= tier.min) t = tier; return t; }
function affordableTier(pool, items) { const candidate = currentTier(pool); const cost = tier => 80 * tier.cost + items * ITEM_COST; let idx = TIERS.findIndex(t => t.key === candidate.key); while (idx > 0 && cost(TIERS[idx]) > BUDGET) idx--; return { candidate, final: TIERS[idx], cost: cost(TIERS[idx]), budget: BUDGET, withinBudget: cost(candidate) <= BUDGET }; }
function snapshot(code) {
  const r = rooms.get(code); const players = r.players.map(p => ({ name:p.name, online:online(code,p.name), drawn:!!r.draws[p.name], score:r.draws[p.name]?.mainScore ?? null }));
  const tier = currentTier(r.pool), budget = affordableTier(r.pool, r.virtualItems);
  return { type:'state', room:code, players, pool:r.pool, virtualItems:r.virtualItems, initialVirtualItems:INITIAL_ITEMS, maxVirtualItems:MAX_ITEMS,
    completed:players.filter(p=>p.drawn).length, total:80, tier, affordableTier:budget.final, estimatedCost:budget.cost, withinBudget:budget.withinBudget,
    history:r.history.slice(0,30), spinning:r.spinning, mainWheel:MAIN, specialWheel:SPECIAL, specialChance:SPECIAL_CHANCE };
}
function broadcast(code, msg) { const data=JSON.stringify(msg || snapshot(code)); for(const [ws,c] of conns) if(c.room===code && ws.readyState===1) ws.send(data); }
function send(ws,msg){ if(ws.readyState===1) ws.send(JSON.stringify(msg)); }
const server=http.createServer((req,res)=>{ const url=req.url.split('?')[0]; if(url==='/'||url==='/index.html'){fs.readFile(path.join(__dirname,'public','index.html'),(e,b)=>{if(e){res.writeHead(500);return res.end('server error');}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(b);});} else if(url==='/healthz'){res.writeHead(200);res.end('ok');}else{res.writeHead(404);res.end('not found');}});
const wss=new WebSocketServer({server,maxPayload:16384});
function weightedPick(items) { const total=items.reduce((s,x)=>s+x.weight,0); let n=crypto.randomInt(total); for(let i=0;i<items.length;i++){n-=items[i].weight;if(n<0)return i;}return items.length-1; }
function join(ws,m){const code=String(m.room||'').trim().replace(/[^\w一-龥-]/g,'').slice(0,20);const name=String(m.name||'').trim().slice(0,12);const token=String(m.token||'').slice(0,64);if(!code||!name)return send(ws,{type:'error',message:'請填寫活動代碼與暱稱'});const r=getRoom(code);let p=r.players.find(x=>x.name===name);const prev=conns.get(ws);if(p&&p.token&&token&&p.token!==token&&online(code,name))return send(ws,{type:'error',message:'此暱稱已在線上使用，請使用自己的暱稱'});if(!p){if(r.players.length>=80)return send(ws,{type:'error',message:'本活動已達 80 人上限'});p={name,token};r.players.push(p);}else if(token)p.token=token;conns.set(ws,{room:code,name});send(ws,{type:'joined',name,room:code,drawn:!!r.draws[name],result:r.draws[name]||null});save();broadcast(code);}
function spin(ws,c,r){if(r.draws[c.name])return send(ws,{type:'error',message:'你已經抽過一次，不能重複抽獎'});if(r.queue.some(j=>j.name===c.name)|| (r.activeJob&&r.activeJob.name===c.name))return send(ws,{type:'error',message:'你的抽獎正在處理中，請稍候'});if(r.players.length>80)return send(ws,{type:'error',message:'活動人數已滿'});const job={name:c.name,mainIndex:weightedPick(MAIN),specialTriggered:crypto.randomInt(100)<SPECIAL_CHANCE, specialIndex:null};if(job.specialTriggered)job.specialIndex=weightedPick(SPECIAL);r.queue.push(job);send(ws,{type:'queued',message:'已收到抽獎請求，正在排隊'});processQueue(c.room);}
function processQueue(code){const r=rooms.get(code);if(!r||r.processing||!r.queue.length)return;r.processing=true;r.spinning=true;const job=r.queue.shift();r.activeJob=job;const main=MAIN[job.mainIndex];r.pool+=main.score;const mainEvent={type:'mainSpin',drawId:crypto.randomUUID(),player:job.name,index:job.mainIndex,score:main.score,duration:4200};broadcast(code,mainEvent);broadcast(code);
 setTimeout(()=>{ if(job.specialTriggered){const s=SPECIAL[job.specialIndex];let specialScore=0,virtualBefore=r.virtualItems,converted=false,displayLabel=s.label;if(s.key==='virtual'){if(r.virtualItems<MAX_ITEMS)r.virtualItems++;else{specialScore=500;converted=true;displayLabel='虛寶已達上限，改為獎池 +500 分';}}else specialScore=Number(s.key);r.pool+=specialScore;job.specialScore=specialScore;job.specialLabel=displayLabel;job.converted=converted;const ev={type:'specialSpin',drawId:mainEvent.drawId,player:job.name,index:job.specialIndex,label:s.label,displayLabel,virtualBefore,virtualAfter:r.virtualItems,score:specialScore,converted,duration:4200};broadcast(code,ev);broadcast(code);setTimeout(()=>finish(),4600);}else finish();
 function finish(){const result={player:job.name,mainScore:main.score,specialTriggered:job.specialTriggered,specialResult:job.specialTriggered?(job.specialLabel||SPECIAL[job.specialIndex].label):null,specialScore:job.specialScore||0,pool:r.pool,virtualItems:r.virtualItems,time:Date.now()};r.draws[job.name]=result;r.history.unshift(result);if(r.history.length>500)r.history.length=500;r.spinning=false;r.processing=false;r.activeJob=null;save();broadcast(code,{type:'drawComplete',result});broadcast(code);processQueue(code);}
 },4600);
}
wss.on('connection',ws=>{ws.on('error',()=>{});ws.on('message',raw=>{try{const m=JSON.parse(raw);if(!m||typeof m!=='object')return;if(m.type==='join')return join(ws,m);const c=conns.get(ws);if(!c)return;const r=rooms.get(c.room);if(!r)return;if(m.type==='spin')spin(ws,c,r);else if(m.type==='clearHistory'&&m.admin===true){r.history=[];save();broadcast(c.room);}}catch(e){console.error('message handling failed',e);}});ws.on('close',()=>{conns.delete(ws);});});
setInterval(()=>{for(const ws of wss.clients){if(ws.readyState===1)ws.ping();}},25000);
server.listen(PORT,()=>console.log(`Lucky wheel listening on ${PORT}`));

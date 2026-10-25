const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const APP_VERSION = 'boss-deploy-20261025-v3';
// Set a private invite code in the server environment; never send it to browsers.
const HOST_INVITE_CODE = process.env.HOST_INVITE_CODE || 'L4ACGQE7F';
const SPIN_MS = 6000;
const SPIN_GRACE_MS = 350;
const DATA_FILE = path.join(__dirname, 'data.json');
const MAIN = [
  { score: 60, weight: 15 }, { score: 300, weight: 25 }, { score: 980, weight: 25 },
  { score: 1980, weight: 20 }, { score: 3280, weight: 12 }, { score: 6480, weight: 3 }
];
// 固定六種傷害值，只調整抽中機率。目標平均傷害可依房間人數調整。
// 80 人基準目標為原輪盤平均傷害的 80%；超過 80 人時小幅調低。
const PROBABILITY_FACTOR = Math.min(1, Math.max(0.3, Number(process.env.PROBABILITY_FACTOR) || 0.80));
const ORIGINAL_MEAN = MAIN.reduce((sum, x) => sum + x.score * x.weight / 100, 0);
function mainWheelFor(count) {
  const n = Math.max(1, count);
  const targetMean = ORIGINAL_MEAN * PROBABILITY_FACTOR * Math.pow(80 / Math.max(80, n), 0.12);
  // 指數傾斜：保留所有獎項，將高分機率轉給低分獎項。
  function calculate(lambda) {
    const weights = MAIN.map(x => x.weight * Math.exp(-lambda * x.score / 1000));
    const sum = weights.reduce((a,b)=>a+b,0);
    return MAIN.map((x,i)=>({...x,weight:weights[i]/sum*100}));
  }
  let lo=-20, hi=20;
  for (let i=0;i<80;i++) {
    const mid=(lo+hi)/2;
    const mean=calculate(mid).reduce((a,x)=>a+x.score*x.weight/100,0);
    if(mean>targetMean) lo=mid; else hi=mid;
  }
  return calculate((lo+hi)/2);
}
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
      queue: [], banned: Array.isArray(old.banned)?old.banned:[], processing: false, spinning: false
    });
  }
} catch {}
function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { players: [], draws: {}, history: [], pool: 0, virtualItems: INITIAL_ITEMS, queue: [], banned: [], processing: false, spinning: false });
  return rooms.get(code);
}
let saveTimer;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries([...rooms].map(([k,r]) => [k,{players:r.players,draws:r.draws,history:r.history,pool:r.pool,virtualItems:r.virtualItems,banned:r.banned}])))); } catch(e) { console.error('save failed', e.message); } }, 100); }
const conns = new Map();
const timing = new Map();
function online(code, name) { for (const c of conns.values()) if (c.room === code && c.name === name) return true; return false; }
function thresholds(count) { const n = Math.max(1, count); return { basic: 0, card490: Math.ceil(80000*n/80), purple: Math.ceil(110000*n/80), card990: Math.ceil(140000*n/80) }; }
function currentTier(pool, count) {
  const limits=thresholds(count);
  if (pool>=limits.card990) return TIERS[3];
  if (pool>=limits.purple) return TIERS[2];
  if (pool>=limits.card490) return TIERS[1];
  return TIERS[0];
}
function oldCurrentTierUnused(pool) { let t = TIERS[0]; for (const tier of TIERS) if (pool >= tier.min) t = tier; return t; }
function affordableTier(pool, items, count) { const candidate = currentTier(pool, count); const cost = tier => count * tier.cost + items * ITEM_COST; let idx = TIERS.findIndex(t => t.key === candidate.key); while (idx > 0 && cost(TIERS[idx]) > BUDGET) idx--; return { candidate, final: TIERS[idx], cost: cost(TIERS[idx]), budget: BUDGET, withinBudget: cost(candidate) <= BUDGET }; }
function snapshot(code) {
  const r = rooms.get(code); const players = r.players.map(p => ({ name:p.name, online:online(code,p.name), drawn:!!r.draws[p.name], score:r.draws[p.name]?.mainScore ?? null }));
  const count = players.length; const nextPlayer = players.find(p=>!p.drawn); const tier = currentTier(r.pool, count), budget = affordableTier(r.pool, r.virtualItems, count);
  return { type:'state', room:code, players, pool:r.pool, virtualItems:r.virtualItems, initialVirtualItems:INITIAL_ITEMS, maxVirtualItems:MAX_ITEMS,
    completed:players.filter(p=>p.drawn).length, total:count, currentTurn:nextPlayer?.name||null, turnNumber:nextPlayer?players.indexOf(nextPlayer)+1:null, thresholds:thresholds(count), tier, affordableTier:budget.final, estimatedCost:budget.cost, withinBudget:budget.withinBudget,
    history:r.history.slice(0,30), spinning:r.spinning, mainWheel:mainWheelFor(count), probabilityFactor:PROBABILITY_FACTOR, specialWheel:SPECIAL, specialChance:SPECIAL_CHANCE };
}
function broadcast(code, msg) { const data=JSON.stringify(msg || snapshot(code)); for(const [ws,c] of conns) if(c.room===code && ws.readyState===1) ws.send(data); }
function send(ws,msg){ if(ws.readyState===1) ws.send(JSON.stringify(msg)); }
const server=http.createServer((req,res)=>{
 const url=(req.url||'/').split('?')[0];
 if(url==='/healthz'){res.writeHead(200);return res.end('ok');}
 if(url==='/version'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({version:APP_VERSION,ui:'boss-battle',dynamicProbability:true}));}
 const name={'/':'index.html','/index.html':'index.html','/fortune-character.png':'fortune-character.png'}[url];
 if(!name){res.writeHead(404);return res.end('not found');}
 fs.readFile(path.join(__dirname,'public',name),(e,data)=>{
  if(e){res.writeHead(500);return res.end('server error');}
  res.writeHead(200,{'Content-Type':name.endsWith('.png')?'image/png':'text/html; charset=utf-8','Cache-Control':'no-store, no-cache, must-revalidate','Pragma':'no-cache','X-App-Version':APP_VERSION});res.end(data);
 });
});
const wss=new WebSocketServer({server,maxPayload:16384});
function weightedPick(items) { const total=items.reduce((s,x)=>s+x.weight,0); let n=crypto.randomInt(1000000000)/1000000000*total; for(let i=0;i<items.length;i++){n-=items[i].weight;if(n<0)return i;}return items.length-1; }
function join(ws,m){const code=String(m.room||'').trim().replace(/[^\w一-龥-]/g,'').slice(0,20);const name=String(m.name||'').trim().slice(0,12);const token=String(m.token||'').slice(0,64);if(!code||!name)return send(ws,{type:'error',message:'請填寫活動代碼與暱稱'});const invite=String(m.inviteCode||'').trim();const host=invite.length>0 && invite===HOST_INVITE_CODE;if(invite&&!host)return send(ws,{type:'error',message:'主持人邀請碼不正確'});const r=getRoom(code);let p=r.players.find(x=>x.name===name);const prev=conns.get(ws);if(p&&p.token&&p.token!==token)return send(ws,{type:'error',message:'此 ID 已被登記，請使用原本的瀏覽器進入，或更換 ID'});if(r.banned?.includes(token))return send(ws,{type:'error',message:'你已被主持人移出房間，無法重新登記'});if(!p){p={name,token};r.players.push(p);}else if(token)p.token=token;conns.set(ws,{room:code,name,host});send(ws,{type:'joined',name,room:code,drawn:!!r.draws[name],result:r.draws[name]||null,host});save();broadcast(code);}
function spin(ws,c,r){const next=r.players.find(p=>!r.draws[p.name]);if(!next||next.name!==c.name)return send(ws,{type:'error',message:next?'尚未輪到你，目前輪到 '+next.name:'所有登記玩家皆已抽完'});if(r.spinning||r.processing)return send(ws,{type:'error',message:'上一位玩家正在抽獎，請稍候'});if(r.draws[c.name])return send(ws,{type:'error',message:'你已經抽過一次，不能重複抽獎'});if(r.queue.some(j=>j.name===c.name)|| (r.activeJob&&r.activeJob.name===c.name))return send(ws,{type:'error',message:'你的抽獎正在處理中，請稍候'});const wheel=mainWheelFor(r.players.length);const job={name:c.name,mainWheel:wheel,mainIndex:weightedPick(wheel),specialTriggered:crypto.randomInt(100)<SPECIAL_CHANCE, specialIndex:null};if(job.specialTriggered)job.specialIndex=weightedPick(SPECIAL);r.queue.push(job);send(ws,{type:'queued',message:'輪到你了！正在啟動輪盤'});processQueue(c.room);}
function processQueue(code){const r=rooms.get(code);if(!r||r.processing||!r.queue.length)return;r.processing=true;r.spinning=true;const job=r.queue.shift();r.activeJob=job;const main=job.mainWheel[job.mainIndex];const drawId=crypto.randomUUID();broadcast(code,{type:'mainSpin',drawId,player:job.name,index:job.mainIndex,score:main.score,duration:SPIN_MS});broadcast(code);
 function finish(){if(r.activeJob!==job||job.finished)return;job.finished=true;clearTimeout(job.ackTimeout);r.pool+=main.score+(job.specialScore||0);if(job.unlockItem)r.virtualItems++;clearTimeout(job.revealTimeout);clearTimeout(job.spinTimeout);const result={player:job.name,mainScore:main.score,specialTriggered:job.specialTriggered,specialResult:job.specialTriggered?(job.specialLabel||SPECIAL[job.specialIndex].label):null,specialScore:job.specialScore||0,pool:r.pool,virtualItems:r.virtualItems,time:Date.now()};r.draws[job.name]=result;r.history.unshift(result);if(r.history.length>500)r.history.length=500;r.spinning=false;r.processing=false;r.activeJob=null;save();broadcast(code,{type:'drawComplete',result});broadcast(code);processQueue(code);}
 function readyToAcknowledge(){if(r.activeJob!==job||job.awaitingAck)return;job.awaitingAck=true;const result={player:job.name,mainScore:main.score,specialTriggered:job.specialTriggered,specialResult:job.specialTriggered?(job.specialLabel||SPECIAL[job.specialIndex].label):null,specialScore:job.specialScore||0,pool:r.pool+main.score+(job.specialScore||0),virtualItems:r.virtualItems+(job.unlockItem?1:0)};broadcast(code,{type:'resultReady',result});job.finishAck=finish;job.ackTimeout=setTimeout(finish,45000);}
 job.reveal=()=>{if(r.activeJob!==job||job.revealed||!job.awaitingReveal)return;job.revealed=true;job.awaitingReveal=false;clearTimeout(job.revealTimeout);job.awaitingSpecialSpin=true;broadcast(code,{type:'specialReady',drawId,player:job.name});job.spinTimeout=setTimeout(()=>job.startSpecial?.(),45000);};
 job.startSpecial=()=>{if(r.activeJob!==job||!job.awaitingSpecialSpin||job.specialStarted)return;job.specialStarted=true;job.awaitingSpecialSpin=false;clearTimeout(job.spinTimeout);const s=SPECIAL[job.specialIndex];let specialScore=0,virtualBefore=r.virtualItems,converted=false,displayLabel=s.label;if(s.key==='virtual'){if(r.virtualItems<MAX_ITEMS){ /* reserved until confirmation */ }else{specialScore=500;converted=true;displayLabel='虛寶已達上限，改為獎池 +500 分';}}else specialScore=Number(s.key);job.unlockItem=s.key==='virtual'&&!converted;job.specialScore=specialScore;job.specialLabel=displayLabel;job.converted=converted;broadcast(code,{type:'specialSpin',drawId,player:job.name,index:job.specialIndex,label:s.label,displayLabel,virtualBefore,virtualAfter:r.virtualItems+(job.unlockItem?1:0),score:specialScore,converted,duration:SPIN_MS});broadcast(code);setTimeout(()=>readyToAcknowledge(),SPIN_MS+SPIN_GRACE_MS);};
 setTimeout(()=>{if(job.specialTriggered){job.awaitingReveal=true;broadcast(code,{type:'specialIntro',drawId,player:job.name});job.revealTimeout=setTimeout(job.reveal,45000);}else readyToAcknowledge();},SPIN_MS+SPIN_GRACE_MS);
}
function hostLogin(ws,m,c){
  if(!HOST_INVITE_CODE)return send(ws,{type:'error',message:'主持人邀請碼尚未由伺服器設定（HOST_INVITE_CODE）'});
  const provided=Buffer.from(String(m.code||''));const expected=Buffer.from(HOST_INVITE_CODE);
  if(provided.length!==expected.length||!crypto.timingSafeEqual(provided,expected))return send(ws,{type:'error',message:'主持人邀請碼不正確'});
  c.host=true;send(ws,{type:'hostStatus',host:true});broadcast(c.room);
}
function kickPlayer(ws,m,c,r){
  if(!c.host)return send(ws,{type:'error',message:'只有主持人可以移除玩家'});
  const name=String(m.name||'');if(!r.players.some(p=>p.name===name))return send(ws,{type:'error',message:'玩家不在房間中'});
  if(r.activeJob?.name===name)return send(ws,{type:'error',message:'該玩家正在抽獎，請等待本回合結算後再移除'});
  const target=r.players.find(p=>p.name===name);if(target.token&&!r.banned.includes(target.token))r.banned.push(target.token);r.players=r.players.filter(p=>p.name!==name);
  // Removing an already-drawn player does not undo their settled contribution.
  for(const [client,info] of conns){if(info.room===c.room&&info.name===name){send(client,{type:'kicked',message:'你已被主持人移出房間'});conns.delete(client);client.close(4001,'Removed by host');}}
  save();broadcast(c.room);
}
wss.on('connection',ws=>{ws.on('error',()=>{});ws.on('message',raw=>{try{const m=JSON.parse(raw);if(!m||typeof m!=='object')return;if(m.type==='join')return join(ws,m);const c=conns.get(ws);if(!c)return;const r=rooms.get(c.room);if(!r)return;if(m.type==='hostLogin')hostLogin(ws,m,c);else if(m.type==='kickPlayer')kickPlayer(ws,m,c,r);else if(m.type==='spin')spin(ws,c,r);else if(m.type==='revealSpecial'&&r.activeJob?.name===c.name)r.activeJob.reveal?.();else if(m.type==='startSpecial'&&r.activeJob?.name===c.name)r.activeJob.startSpecial?.();else if(m.type==='ackResult'&&r.activeJob?.name===c.name&&r.activeJob.awaitingAck)r.activeJob&&r.activeJob.finishAck?.();else if(m.type==='clearHistory'&&m.admin===true){r.history=[];save();broadcast(c.room);}}catch(e){console.error('message handling failed',e);}});ws.on('close',()=>{const c=conns.get(ws);conns.delete(ws);if(c)broadcast(c.room);});});
setInterval(()=>{for(const ws of wss.clients){if(ws.readyState===1)ws.ping();}},25000);
server.listen(PORT,()=>console.log(`Lucky wheel listening on ${PORT}`));

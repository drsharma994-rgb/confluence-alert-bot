/**
 * Confluence Alert Bot — Delta Exchange India
 * Scans every 15 minutes, sends Telegram alert on VALID setups
 * Uses only built-in Node.js fetch (v18+) — no external fetch dependency
 */

const DELTA_BASE = 'https://api.india.delta.exchange';
const TG_TOKEN   = process.env.TG_TOKEN;
const TG_CHAT    = process.env.TG_CHAT;

if (!TG_TOKEN || !TG_CHAT) {
  console.error('❌ Missing TG_TOKEN or TG_CHAT env vars');
  process.exit(1);
}

const _fired = {};
const COOLDOWN = 30 * 60 * 1000;

// ── Utils ──────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  return r.json();
}

async function tg(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(8000)
    });
  } catch(e) { console.error('[TG]', e.message); }
}

function sma(arr) { return arr.reduce((a,b)=>a+b,0)/arr.length; }

function ema(arr, p) {
  const k = 2/(p+1); let v = arr[0];
  for (let i=1;i<arr.length;i++) v = arr[i]*k + v*(1-k);
  return v;
}

function rsi(closes, p=14) {
  if (closes.length < p+1) return 50;
  let g=0,l=0;
  for (let i=closes.length-p;i<closes.length;i++) {
    const d=closes[i]-closes[i-1];
    if(d>0) g+=d; else l-=d;
  }
  return 100 - 100/(1+g/(l||1));
}

function atr(candles, p=14) {
  let s=0,c=0;
  for (let i=Math.max(1,candles.length-p);i<candles.length;i++) {
    const h=+candles[i].high,l=+candles[i].low,pc=+candles[i-1].close;
    s+=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)); c++;
  }
  return c?s/c:0;
}

function cusum(closes) {
  if (closes.length<25) return 'neutral';
  const ret=[];
  for(let i=1;i<closes.length;i++) ret.push(Math.log(closes[i]/closes[i-1]));
  const W=20,k=0.5,h=4;
  let sp=0,sm=0,bull=false,bear=false;
  for(let i=W;i<ret.length;i++) {
    const win=ret.slice(i-W,i);
    const mu=sma(win);
    const sig=Math.sqrt(win.reduce((a,b)=>a+(b-mu)**2,0)/W)||1e-9;
    const z=(ret[i]-mu)/sig;
    sp=Math.max(0,sp+z-k); sm=Math.max(0,sm-z-k);
    if(sp>h){bull=true;sp=0;} if(sm>h){bear=true;sm=0;}
  }
  return bear?'bearish':bull?'bullish':'neutral';
}

// ── Score one coin ─────────────────────────────────────────────────────────

async function score(sym) {
  try {
    const d = await fetchJson(`${DELTA_BASE}/v2/history/candles?symbol=${sym}&resolution=1h&limit=100`);
    const candles = (d.result||[]).sort((a,b)=>a.time-b.time);
    if (candles.length < 30) return null;

    const closes = candles.map(c=>+c.close);
    const highs  = candles.map(c=>+c.high);
    const lows   = candles.map(c=>+c.low);
    const price  = closes[closes.length-1];
    const atrVal = atr(candles,14);

    // Families
    const e20=ema(closes,20), e50=ema(closes,50);
    const rsiV=rsi(closes,14);
    const csig=cusum(closes);

    let tBull = (price>e20?1:0)+(price>e50?1:0)+(csig==='bullish'?1:0);
    let tBear = (price<e20?1:0)+(price<e50?1:0)+(csig==='bearish'?1:0);
    const tVote = tBull>tBear?'BULL':tBear>tBull?'BEAR':'NEUTRAL';
    const mVote = rsiV>55?'BULL':rsiV<45?'BEAR':'NEUTRAL';
    const atrPct = atrVal/price*100;
    const vVote = atrPct>2?'BULL':'NEUTRAL';
    const h20=Math.max(...highs.slice(-40,-20)), l20=Math.min(...lows.slice(-40,-20));
    const sVote = price>h20?'BULL':price<l20?'BEAR':'NEUTRAL';

    const fams=[tVote,mVote,vVote,sVote];
    const bull=fams.filter(v=>v==='BULL').length;
    const bear=fams.filter(v=>v==='BEAR').length;
    const agree=Math.max(bull,bear);
    if(agree<3) return null;

    const dir=bull>=bear?'long':'short';
    const swing=dir==='long'?Math.min(...lows.slice(-10)):Math.max(...highs.slice(-10));
    const stopDist=Math.max(Math.abs(price-swing),0.4*atrVal);
    const stop=dir==='long'?price-stopDist:price+stopDist;
    const t1=dir==='long'?price+stopDist*2:price-stopDist*2;
    const rrVal=stopDist>0?(stopDist*2)/stopDist:0;
    if(rrVal<2.0) return null;

    return { sym, price, dir, agree, rr:+rrVal.toFixed(2), t1:+t1.toFixed(6), stop:+stop.toFixed(6), rsi:+rsiV.toFixed(1), cusum:csig };
  } catch(e) {
    return null;
  }
}

// ── Scan ───────────────────────────────────────────────────────────────────

async function scan() {
  console.log(`[${new Date().toISOString()}] Scanning...`);
  try {
    const pd = await fetchJson(`${DELTA_BASE}/v2/products?contract_type=perpetual_futures&state=live`);
    const coins = (pd.result||[])
      .filter(p=>p.quoting_asset?.symbol==='USD'&&!/^(COIN|NVDAX|METAX)/.test(p.symbol))
      .slice(0,80)
      .map(p=>p.symbol);

    console.log(`Scoring ${coins.length} coins...`);
    const results=[];
    for(let i=0;i<coins.length;i+=5){
      const batch=await Promise.all(coins.slice(i,i+5).map(s=>score(s)));
      batch.forEach(r=>{if(r)results.push(r);});
      await new Promise(r=>setTimeout(r,600));
    }

    console.log(`${results.length} VALID setups found`);
    const now=Date.now();
    for(const s of results){
      if(now-(_fired[s.sym]||0)<COOLDOWN) continue;
      _fired[s.sym]=now;
      const dir=s.dir==='long'?'🟢 LONG':'🔴 SHORT';
      const base=s.sym.replace('USD','');
      const cs=s.cusum!=='neutral'?` CUSUM${s.cusum==='bullish'?'▲':'▼'}`:'';
      const msg=`⚡ *${base}* ${dir}\n${s.agree}/4 family${cs}\nPrice: \`${s.price}\`  R:R: *${s.rr}*\nT1: \`${s.t1}\`  Stop: \`${s.stop}\`\nRSI: ${s.rsi}\n_Confluence Auto-Alert_`;
      await tg(msg);
      console.log(`Alert: ${s.sym} ${s.dir} RR${s.rr}`);
    }
  } catch(e) {
    console.error('[scan]',e.message);
  }
}

// ── Start ──────────────────────────────────────────────────────────────────

console.log('✅ Confluence Alert Bot started');
scan(); // run immediately

// Every 15 min via simple setInterval (no cron dependency needed)
setInterval(scan, 15 * 60 * 1000);

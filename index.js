/**
 * Confluence Alert Bot — Delta Exchange India
 * Scans every 15 minutes, sends Telegram alert on VALID setups (3/4 family + R:R ≥ 2)
 */

const fetch = require('node-fetch');
const cron  = require('node-cron');

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT  = process.env.TG_CHAT;
const DELTA_BASE = 'https://api.india.delta.exchange';

// Cooldown: don't re-alert same coin within 30 minutes
const _fired = {}; // { symbol: timestamp }
const COOLDOWN = 30 * 60 * 1000;

// ── Helpers ────────────────────────────────────────────────────────────────

async function tg(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'Markdown' })
    });
  } catch (e) { console.error('[TG]', e.message); }
}

async function fetchJson(url) {
  const r = await fetch(url, { timeout: 10000 });
  return r.json();
}

// EMA
function ema(arr, p) {
  const k = 2 / (p + 1);
  let val = arr[0];
  for (let i = 1; i < arr.length; i++) val = arr[i] * k + val * (1 - k);
  return val;
}

// SMA
function sma(arr) { return arr.reduce((a,b) => a+b, 0) / arr.length; }

// ATR
function atr(candles, p) {
  let sum = 0, cnt = 0;
  for (let i = Math.max(1, candles.length - p); i < candles.length; i++) {
    const h = +candles[i].high, l = +candles[i].low, pc = +candles[i-1].close;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

// RSI
function rsi(closes, p = 14) {
  if (closes.length < p + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = gains / (losses || 1);
  return 100 - 100 / (1 + rs);
}

// CUSUM
function cusumDetect(closes) {
  if (closes.length < 25) return 'neutral';
  const ret = [];
  for (let i = 1; i < closes.length; i++) ret.push(Math.log(closes[i] / closes[i-1]));
  const W = 20, k = 0.5, h = 4.0;
  let sp = 0, sm = 0, bullCP = false, bearCP = false;
  for (let i = W; i < ret.length; i++) {
    const win = ret.slice(i - W, i);
    const mu = sma(win);
    const sigma = Math.sqrt(win.reduce((a,b) => a + (b-mu)**2, 0) / W) || 1e-9;
    const z = (ret[i] - mu) / sigma;
    sp = Math.max(0, sp + z - k);
    sm = Math.max(0, sm - z - k);
    if (sp > h) { bullCP = true; sp = 0; }
    if (sm > h) { bearCP = true; sm = 0; }
  }
  return bearCP ? 'bearish' : bullCP ? 'bullish' : 'neutral';
}

// Squeeze
function squeeze(candles) {
  if (candles.length < 20) return { active: false, firing: false };
  const closes = candles.map(c => +c.close);
  const p = 20;
  const win = closes.slice(-p);
  const mu = sma(win);
  const sd = Math.sqrt(win.reduce((a,b) => a+(b-mu)**2,0)/p);
  const bbU = mu + 2*sd, bbL = mu - 2*sd;
  const atrVal = atr(candles, p);
  const ema20 = ema(closes, p);
  const kcU = ema20 + 1.5*atrVal, kcL = ema20 - 1.5*atrVal;
  return { active: bbU < kcU && bbL > kcL, firing: false };
}

// ── Main scoring ──────────────────────────────────────────────────────────

async function scoreCoin(symbol) {
  try {
    // Fetch 1h candles (last 100)
    const url = `${DELTA_BASE}/v2/history/candles?symbol=${symbol}&resolution=1h&limit=100`;
    const data = await fetchJson(url);
    const candles = (data.result || []).sort((a,b) => a.time - b.time);
    if (candles.length < 30) return null;

    const closes = candles.map(c => +c.close);
    const price  = closes[closes.length - 1];
    const highs  = candles.map(c => +c.high);
    const lows   = candles.map(c => +c.low);

    // Trend family
    const ema20  = ema(closes, 20);
    const ema50  = ema(closes, 50);
    const ema200 = ema(closes, 200);
    const trendBull = (price > ema20 ? 1 : 0) + (price > ema50 ? 1 : 0) + (price > ema200 ? 1 : 0);
    const trendBear = (price < ema20 ? 1 : 0) + (price < ema50 ? 1 : 0) + (price < ema200 ? 1 : 0);

    // CUSUM vote
    const cusumSignal = cusumDetect(closes);
    const trendBullFinal = trendBull + (cusumSignal === 'bullish' ? 1 : 0);
    const trendBearFinal = trendBear + (cusumSignal === 'bearish' ? 1 : 0);
    const trendVote = trendBullFinal > trendBearFinal ? 'BULL' : trendBearFinal > trendBullFinal ? 'BEAR' : 'NEUTRAL';

    // Momentum family (RSI)
    const rsiVal = rsi(closes, 14);
    const momentumVote = rsiVal > 55 ? 'BULL' : rsiVal < 45 ? 'BEAR' : 'NEUTRAL';

    // Volatility family (squeeze)
    const sq = squeeze(candles);
    const atrVal = atr(candles, 14);
    const atrPct = atrVal / price * 100;
    const volVote = atrPct > 2 ? 'BULL' : 'NEUTRAL'; // active vol = favourable

    // Structure family (recent high/low break)
    const recent20H = Math.max(...highs.slice(-20));
    const recent20L = Math.min(...lows.slice(-20));
    const prev20H   = Math.max(...highs.slice(-40, -20));
    const prev20L   = Math.min(...lows.slice(-40, -20));
    const structVote = price > prev20H ? 'BULL' : price < prev20L ? 'BEAR' : 'NEUTRAL';

    // Determine direction
    const families = [trendVote, momentumVote, volVote, structVote];
    const bullCount = families.filter(v => v === 'BULL').length;
    const bearCount = families.filter(v => v === 'BEAR').length;
    const agreement = Math.max(bullCount, bearCount);
    const dir = bullCount >= bearCount ? 'long' : 'short';

    if (agreement < 3) return null;

    // Build plan
    const lastCandle  = candles[candles.length - 1];
    const swing       = dir === 'long'
      ? Math.min(...lows.slice(-10))
      : Math.max(...highs.slice(-10));
    const stopDist    = Math.max(Math.abs(price - swing), 0.4 * atrVal);
    const stop        = dir === 'long' ? price - stopDist : price + stopDist;
    const t1Dist      = stopDist * 2;
    const t1          = dir === 'long' ? price + t1Dist : price - t1Dist;
    const rr          = t1Dist / stopDist;

    if (rr < 2.0) return null;

    return {
      symbol, price, dir, agreement, rr: +rr.toFixed(2),
      t1: +t1.toFixed(6), stop: +stop.toFixed(6),
      rsi: +rsiVal.toFixed(1), cusum: cusumSignal,
      squeeze: sq.active
    };
  } catch (e) {
    console.error(`[score] ${symbol}:`, e.message);
    return null;
  }
}

// ── Scan all coins ────────────────────────────────────────────────────────

async function runScan() {
  console.log(`[${new Date().toISOString()}] Starting scan...`);

  try {
    // Get active perpetuals
    const prodData = await fetchJson(`${DELTA_BASE}/v2/products?contract_type=perpetual_futures&state=live`);
    const products = (prodData.result || [])
      .filter(p => p.quoting_asset?.symbol === 'USD' && !p.symbol.match(/^(COIN|NVDAX|METAX)/))
      .slice(0, 80);

    console.log(`Scanning ${products.length} coins...`);

    const results = [];
    // Process in batches of 5
    for (let i = 0; i < products.length; i += 5) {
      const batch = products.slice(i, i + 5);
      const scored = await Promise.all(batch.map(p => scoreCoin(p.symbol)));
      scored.forEach(r => { if (r) results.push(r); });
      await new Promise(r => setTimeout(r, 500)); // rate limit
    }

    console.log(`Found ${results.length} VALID setups`);

    const now = Date.now();
    for (const setup of results) {
      const lastFired = _fired[setup.symbol] || 0;
      if (now - lastFired < COOLDOWN) continue;

      _fired[setup.symbol] = now;
      const dir = setup.dir === 'long' ? '🟢 LONG' : '🔴 SHORT';
      const base = setup.symbol.replace('USD','').replace('USDT','');
      const sqBadge = setup.squeeze ? ' 🔳SQZ' : '';
      const cusumBadge = setup.cusum !== 'neutral' ? ` CUSUM${setup.cusum === 'bullish' ? '▲' : '▼'}` : '';

      const msg = `⚡ *VALID SETUP — ${base}*\n`
        + `${dir} | ${setup.agreement}/4 family${sqBadge}${cusumBadge}\n`
        + `Price: \`${setup.price}\`\n`
        + `R:R: *${setup.rr}* | RSI: ${setup.rsi}\n`
        + `T1: \`${setup.t1}\` | Stop: \`${setup.stop}\`\n`
        + `_Confluence Terminal Auto-Alert_`;

      await tg(msg);
      console.log(`Alert sent: ${setup.symbol} ${setup.dir} R:R${setup.rr}`);
    }

    if (results.length === 0) {
      console.log('No VALID setups this scan.');
    }
  } catch (e) {
    console.error('[scan error]', e.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────

if (!TG_TOKEN || !TG_CHAT) {
  console.error('❌ Set TG_TOKEN and TG_CHAT environment variables');
  process.exit(1);
}

console.log('✅ Confluence Alert Bot starting...');
console.log(`   Chat ID: ${TG_CHAT}`);
console.log('   Scanning every 15 minutes');

// Run immediately on start
runScan();

// Then every 15 minutes
cron.schedule('*/15 * * * *', runScan);

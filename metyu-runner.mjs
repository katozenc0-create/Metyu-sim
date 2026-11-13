#!/usr/bin/env node
// metyu runner: the simulator's paper-trading agent as a 24/7 portfolio, outside the browser.
//
// Paper only: no exchange keys, no orders. It reads public prices, trades a virtual 10,000 USDT portfolio across
// several symbols, learns each symbol with walk-forward, avoids new entries around high-impact economic releases,
// and writes a weekly report. Everything it keeps is in files next to this one.
//
// The trading engine, strategies, backtest and learner are loaded from simulator.html (same folder), so the page
// and the runner always run the same rules.
//
// Usage:   node metyu-runner.mjs [--symbols BTCUSDT,ETHUSDT,SOLUSDT] [--bar 900] [--lev 3] [--port 8787]
//          node metyu-runner.mjs --report-now      (write a report for the last 7 days from the saved state, then exit)
// Needs:   Node.js 22 or newer (built-in fetch and WebSocket).

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// Where state, logs, trades and reports are kept. On a hosting platform, point this at a persistent volume.
const DATA = process.env.METYU_DATA_DIR || DIR;
if (DATA !== DIR) fs.mkdirSync(DATA, { recursive: true });
// Hosting platforms (Railway, Render…) give the port in PORT and need the page reachable from outside the container.
const HOSTED = !!process.env.PORT;
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const KNOWN = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const CFG = {
  symbols: String(args.symbols || args.symbol || process.env.METYU_SYMBOLS || KNOWN.join(',')).toUpperCase().split(',').map((x) => x.trim()).filter(Boolean),
  capital: 10000,
  bar: +(args.bar || process.env.METYU_BAR || 14400),          // seconds: 60, 300, 900, 3600 or 14400 (4 h, the default)
  lev: +(args.lev || process.env.METYU_LEV || 3),
  riskPerTrade: 0.01,                                           // of the whole portfolio
  maxSameSide: +(args['max-same-side'] || 2),                    // BTC/ETH/SOL move together: cap same-direction bets
  dayLimit: 0.03, ddLimit: 0.15,                                // portfolio level
  calBefore: +(args['calendar-before'] || 30), calAfter: +(args['calendar-after'] || 30),   // minutes
  calCountries: String(args['calendar-countries'] || 'USD').toUpperCase().split(','),
  port: +(args.port ?? process.env.METYU_PORT ?? process.env.PORT ?? 8787),
  host: args.host || process.env.METYU_HOST || (HOSTED ? '0.0.0.0' : '127.0.0.1'),
  learnBars: +(args.history || 5000),
  // Risk multiplier for a model whose evidence is weak (see WF.strongT in simulator.html). 0 = do not trade weak models.
  weakRisk: +(args['weak-risk'] ?? process.env.METYU_WEAK_RISK ?? 0.25),
  banDays: +(args['ban-days'] || 7),                              // a model that failed live is not re-adopted for this long
  // Savings mode: fewer requests and less CPU, for hosting billed by usage. Trading rules are unchanged.
  eco: !!args.tasarruf || process.env.METYU_TASARRUF === '1',
  html: args.html || path.join(DIR, 'simulator.html'),
  state: args.state || path.join(DATA, 'metyu-state.json'),
  logFile: path.join(DATA, 'metyu-log.txt'),
  tradesFile: path.join(DATA, 'metyu-trades.csv'),
  reportsDir: path.join(DATA, 'raporlar'),
};
const TF_OF_BAR = { 60: '1m', 300: '5m', 900: '15m', 3600: '1h', 14400: '4h' };
if (!TF_OF_BAR[CFG.bar]) { console.error('--bar şunlardan biri olmalı: 60, 300, 900, 3600, 14400'); process.exit(1); }
if (!(CFG.weakRisk >= 0 && CFG.weakRisk <= 1)) { console.error('--weak-risk 0 ile 1 arasında olmalı'); process.exit(1); }
if (!(CFG.lev >= 1 && CFG.lev <= 5)) { console.error('--lev 1 ile 5 arasında olmalı'); process.exit(1); }
const bad = CFG.symbols.filter((s) => !KNOWN.includes(s));
if (bad.length || !CFG.symbols.length) { console.error('Desteklenen semboller: ' + KNOWN.join(', ')); process.exit(1); }
if (typeof fetch !== 'function') { console.error('Node.js 22 veya üstü gerekli (fetch yok).'); process.exit(1); }

// Every request gets a time limit: a connection that hangs must never stall learning or a poll forever.
const rawFetch = globalThis.fetch;
globalThis.fetch = (url, opt) => rawFetch(url, Object.assign({ signal: AbortSignal.timeout(20000) }, opt || {}));

// ---------- Load the shared engine from the page ----------
const STRATS = ['sma', 'momentum', 'meanrev', 'macd', 'rsi', 'sr'];
const SNAME = { sma: 'SMA kesişimi', momentum: 'Kırılım', meanrev: 'Ortalamaya dönüş', macd: 'MACD', rsi: 'RSI + trend', sr: 'Destek/direnç', ens: 'Oylama' };
function loadEngine(file) {
  const html = fs.readFileSync(file, 'utf8');
  const eng = html.split('// ENGINE-START')[1], shared = html.split('// SHARED-START')[1];
  if (!eng || !shared) throw new Error(file + ' içinde motor bölümleri bulunamadı (ENGINE/SHARED işaretleri)');
  const code = eng.split('// ENGINE-END')[0] + '\nconst STRATS = ' + JSON.stringify(STRATS) + ';\n' +
    shared.split('// SHARED-END')[0].replace(/^[^\n]*\n/, '') +
    '\nreturn { makeAccount, openPos, closePos, onTick, equity, signalFor, warmFor, describeParams, filterBlocks, filterLabel,' +
    ' fetchCandles, fetchMarketHistory, walkForward, DAY_HALT, num, dayKey, DEPTH_DEFAULT, pmLabel };';
  return new Function(code)();
}
const E = loadEngine(CFG.html);
const short = (sym) => sym.replace(/USDT$/, '');

// ---------- One copy per folder ----------
// Two copies writing the same state file would corrupt each other (e.g. pm2 plus a manual start).
const LOCK = path.join(DIR, 'metyu.lock');
if (!args['report-now'] && !args['telegram-setup']) {
  try {
    const pid = +fs.readFileSync(LOCK, 'utf8');
    let alive = false;
    try { if (pid > 0 && pid !== process.pid) { process.kill(pid, 0); alive = true; } } catch (e) { alive = e.code === 'EPERM'; }
    if (alive) { console.error('metyu bu klasörde zaten çalışıyor (işlem ' + pid + '). Önce onu durdur: pm2 stop metyu ya da o terminalde Ctrl+C.'); process.exit(1); }
  } catch (e) { /* no lock, or a stale one */ }
  fs.writeFileSync(LOCK, String(process.pid));
  process.on('exit', () => { try { if (+fs.readFileSync(LOCK, 'utf8') === process.pid) fs.unlinkSync(LOCK); } catch (e) { /* ignore */ } });
}

// ---------- Output ----------
const ts = (t) => new Date(t || Date.now()).toLocaleString('tr-TR', { hour12: false });
function out(msg) {
  const line = '[' + ts() + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync(CFG.logFile, line + '\n'); } catch (e) { /* disk issue: keep running */ }
}
function tradeCsv(sym, h) {
  try {
    if (!fs.existsSync(CFG.tradesFile)) fs.writeFileSync(CFG.tradesFile, 'acilis;kapanis;sembol;yon;giris;cikis;miktar;kaldirac;maliyet;fonlama;KZ;neden;strateji\n');
    const n = (v, d) => v == null ? '' : v.toFixed(d).replace('.', ',');
    fs.appendFileSync(CFG.tradesFile, [ts(h.tOpen), ts(h.tClose), sym, h.side, n(h.entry, 4), n(h.exit, 4), n(h.qty, 6), h.lev, n(h.costs, 2), n(h.funding, 2), n(h.pnl, 2), h.reason, h.strat || ''].join(';') + '\n');
  } catch (e) { /* ignore */ }
}

// ---------- State ----------
// P: portfolio. C[sym]: one virtual sub-account per symbol (an equal slice of the capital), with its own bars and model.
// Each trade risks riskPerTrade of the whole portfolio; daily and drawdown limits apply to the portfolio as a whole.
const N = CFG.symbols.length;
const BASE_RISK = Math.min(0.05, CFG.riskPerTrade * N);
function subAccount() {
  return E.makeAccount({ balance: CFG.capital / N, risk: BASE_RISK, maxLev: 5, dayLimit: 1, ddLimit: 1 });
}
function newCtx(sym) {
  return { sym, acct: subAccount(), model: null, closes: [], bars: [], barIdx: null, st: { cur: null }, blocked: null, lastSide: null, lastLearnTry: 0 };
}
let P = { start: CFG.capital, peak: CFG.capital, maxDD: 0, day: null, dayStart: CFG.capital, halt: null, eqHist: [], lastReport: 0,
  counters: { calendar: 0, sameSide: 0, filter: 0, gaps: 0, reconnects: 0, spikes: 0, errors: 0 } };
const C = {};
let cal = { events: [], fetchedAt: 0, ok: false };
const STATE_PREV = CFG.state.replace(/\.json$/, '') + '.onceki.json';
// A state file is used only if it parses and its money figures are sane numbers.
function readState(file) {
  if (!fs.existsSync(file)) return { d: null };
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d && d.version === 2) {
      const okNum = (v) => typeof v === 'number' && isFinite(v);
      if (!d.P || !okNum(d.P.start) || !okNum(d.P.peak) || !(d.P.peak > 0) || !d.ctx || typeof d.ctx !== 'object') throw new Error('portföy alanları bozuk');
      for (const k of Object.keys(d.ctx)) {
        const a = d.ctx[k] && d.ctx[k].acct;
        if (!a || !okNum(a.cash) || a.cash < 0 || !okNum(a.start)) throw new Error(k + ' hesabı bozuk');
        if (a.pos && !(okNum(a.pos.qty) && a.pos.qty > 0 && okNum(a.pos.entry) && okNum(a.pos.stop) && okNum(a.pos.margin))) throw new Error(k + ' pozisyonu bozuk');
      }
    }
    return { d };
  } catch (e) { return { d: null, err: e.message }; }
}
(function load() {
  let { d, err } = readState(CFG.state);
  if (err) {
    // Never overwrite an unreadable state silently: keep a copy, then fall back to the last state that loaded cleanly.
    const bad = CFG.state.replace(/\.json$/, '') + '.bozuk-' + Date.now() + '.json';
    try { fs.copyFileSync(CFG.state, bad); } catch (e2) { /* ignore */ }
    const prev = args['report-now'] ? { d: null } : readState(STATE_PREV);
    if (prev.d) { d = prev.d; out('UYARI: kayıt dosyası kullanılamadı (' + err + '). Kopyası ' + path.basename(bad) + ' olarak saklandı; bir önceki sağlam kayıttan devam ediliyor.'); }
    else out('UYARI: kayıt dosyası kullanılamadı (' + err + '). Kopyası ' + path.basename(bad) + ' olarak saklandı; yeni sanal portföyle başlanıyor.');
  } else if (d && d.version === 2 && !args['report-now']) {
    try { fs.copyFileSync(CFG.state, STATE_PREV); } catch (e) { /* ignore */ }
  }
  if (d && d.version !== 2 && d.acct) {
    fs.copyFileSync(CFG.state, CFG.state.replace(/\.json$/, '.v1.json'));
    out('Eski tek sembollü kayıt metyu-state.v1.json olarak saklandı; portföy yeni bir 10.000 USDT sanal hesapla başlıyor');
    d = null;
  }
  if (d && d.version === 2) {
    P = Object.assign(P, d.P); P.counters = Object.assign({ calendar: 0, sameSide: 0, filter: 0, gaps: 0, reconnects: 0, spikes: 0, errors: 0 }, d.P.counters);
    cal = d.cal || cal;
    // A report-only run reads the state as saved and must not change anything in it.
    if (args['report-now'] && TF_OF_BAR[d.barSec]) CFG.bar = d.barSec;
    const same = d.barSec === CFG.bar;
    for (const sym of CFG.symbols) {
      const c = d.ctx && d.ctx[sym];
      if (c && c.acct && typeof c.acct.cash === 'number') {
        C[sym] = Object.assign(newCtx(sym), c, { sym });
        if (!same) { C[sym].closes = []; C[sym].bars = []; C[sym].barIdx = null; C[sym].st = { cur: null }; C[sym].model = null; }
      } else C[sym] = newCtx(sym);
    }
    const dropped = Object.keys(d.ctx || {}).filter((s) => !CFG.symbols.includes(s));
    if (dropped.length) out('Uyarı: kayıtta olup şimdi çalıştırılmayan semboller: ' + dropped.join(', ') + ' (hesapları dosyada kalıyor)');
    out('Önceki portföy yüklendi' + (same ? '' : '; bar süresi değiştiği için barlar ve modeller yeniden kurulacak'));
  } else {
    for (const sym of CFG.symbols) C[sym] = newCtx(sym);
    out('Yeni sanal portföy: ' + E.num(CFG.capital, 0) + ' USDT, ' + CFG.symbols.join(', ') + ' arasında eşit bölündü');
  }
  // Bars saved before a restart may miss the bars that closed while the program was off: re-check them first.
  for (const sym of CFG.symbols) if (C[sym].closes.length) C[sym].stale = true;
  for (const sym of CFG.symbols) { C[sym].evSeen = C[sym].acct.events.length; C[sym].histSeen = (C[sym].acct.history || []).length; C[sym].q = { bid: null, ask: null, t: 0 }; }
})();
function save() {
  const ctx = {};
  for (const sym of CFG.symbols) {
    const c = C[sym];
    ctx[sym] = { acct: Object.assign({}, c.acct, { book: null, events: c.acct.events.slice(-100), history: (c.acct.history || []).slice(-3000) }),
      model: c.model, closes: c.closes, bars: c.bars, barIdx: c.barIdx, st: c.st, blocked: c.blocked, lastSide: c.lastSide, lastLearnTry: c.lastLearnTry, ban: c.ban || null };
  }
  try {
    fs.writeFileSync(CFG.state + '.tmp', JSON.stringify({ version: 2, savedAt: Date.now(), barSec: CFG.bar, P, ctx, cal }));
    fs.renameSync(CFG.state + '.tmp', CFG.state);
  } catch (e) { out('Durum kaydedilemedi: ' + e.message); }
}
function flushEvents(c) {
  const ev = c.acct.events;
  if (c.evSeen > ev.length) c.evSeen = 0;
  for (; c.evSeen < ev.length; c.evSeen++) out('[' + short(c.sym) + '] ' + ev[c.evSeen].msg);
  const h = c.acct.history || [];
  for (; c.histSeen < h.length; c.histSeen++) {
    { const x = h[c.histSeen]; tg(short(c.sym) + ' ' + sideTr(x.side) + ' kapandı (' + x.reason + ') · ' + E.num(x.exit, 2) + ' · K/Z ' + (x.pnl >= 0 ? '+' : '') + money(x.pnl) + ' · portföy ' + money(peq()), x.reason === 'LİKİDASYON'); }
    if (!h[c.histSeen].strat && c.model && c.model.chosen) h[c.histSeen].strat = c.model.chosen.name;
    tradeCsv(c.sym, h[c.histSeen]);
  }
  if (ev.length > 400) { c.acct.events = ev.slice(-100); c.evSeen = c.acct.events.length; }
}
const note = (c, msg) => { c.acct.events.push({ t: Date.now(), msg }); flushEvents(c); };
const peq = () => CFG.symbols.reduce((s, sym) => s + E.equity(C[sym].acct), 0);

// ---------- Portfolio risk ----------
function portfolioCheck() {
  const e = peq(), now = Date.now(), dk = E.dayKey(now);
  if (P.day !== dk) {
    P.day = dk; P.dayStart = e;
    if (P.halt === 'günlük') { P.halt = null; out('Yeni gün: portföyün günlük zarar limiti sıfırlandı'); }
  }
  P.peak = Math.max(P.peak, e); P.maxDD = Math.max(P.maxDD, (P.peak - e) / P.peak);
  if (P.halt === 'düşüş') { closeAllLocked(); return; }
  if ((P.peak - e) / P.peak >= CFG.ddLimit) {
    P.halt = 'düşüş';
    out('DURDURULDU: portföy zirveden %' + E.num(CFG.ddLimit * 100, 0) + ' düştü; açık pozisyonlar kapanıyor, yeni işlem için durumu sıfırla');
    tg('KİLİT: portföy zirvesinden %' + E.num(CFG.ddLimit * 100, 0) + ' düştü. Açık pozisyonlar kapatılıyor ve yeni işlem açılmayacak. Yeniden başlatmak için durum dosyasını sıfırlaman gerekir.', true);
    for (const sym of CFG.symbols) C[sym].acct.halt = 'maksimum düşüş limiti';
    closeAllLocked(); save(); return;
  }
  if (!P.halt && (e - P.dayStart) / P.dayStart <= -CFG.dayLimit) {
    P.halt = 'günlük';
    out('DURDURULDU: portföy bugün %' + E.num(CFG.dayLimit * 100, 0) + ' zararda; yeni pozisyon gece yarısına kadar açılmayacak');
    tg('Günlük zarar limiti: portföy bugün %' + E.num(CFG.dayLimit * 100, 0) + ' zararda. Gece yarısına kadar yeni pozisyon açılmayacak.', true);
  }
  // Hourly equity samples for the report (kept ~90 days).
  const last = P.eqHist[P.eqHist.length - 1];
  if (!last || now - last[0] >= 3600e3) { P.eqHist.push([now, e]); if (P.eqHist.length > 24 * 90) P.eqHist.shift(); }
}
// Under the drawdown lock every open position is closed as soon as its symbol has a fresh price (right after a
// restart there may be none yet; it then closes on the first quote).
function closeAllLocked() {
  for (const sym of CFG.symbols) {
    const c = C[sym];
    if (c.acct.pos && fresh(c)) { E.closePos(c.acct, c.acct.pos.side === 'long' ? c.q.bid : c.q.ask, 'KİLİT ile'); flushEvents(c); save(); }
  }
}
setInterval(() => { try { portfolioCheck(); } catch (e) { P.counters.errors++; out('Portföy kontrol hatası: ' + e.message); } }, CFG.eco ? 5000 : 1000);

// ---------- Live quotes for all symbols over one connection: Binance WS → Hyperliquid WS → Binance HTTP ----------
let feed = null, feedIdx = 0, attempt = 0, attemptStart = 0, everLive = false, lastQuoteAny = 0, feedName = null;
const FEEDS = [
  { name: 'Binance', open: (id) => {
    if (typeof WebSocket !== 'function') throw new Error('WebSocket yok');
    const w = new WebSocket('wss://stream.binance.com:9443/stream?streams=' + CFG.symbols.map((s) => s.toLowerCase() + '@bookTicker').join('/'));
    w.onmessage = (e) => { try { const d = JSON.parse(e.data).data; if (d && d.s && d.b && d.a) gotQuote(d.s, +d.b, +d.a, 'Binance', id); } catch (err) { /* ignore */ } };
    w.onclose = () => { if (id === attempt && lastQuoteAny >= attemptStart) setTimeout(() => connect(0), 2000); };
    return { close: () => { w.onclose = null; try { w.close(); } catch (e) { /* ignore */ } } };
  } },
  { name: 'Hyperliquid', open: (id) => {
    if (typeof WebSocket !== 'function') throw new Error('WebSocket yok');
    const w = new WebSocket('wss://api.hyperliquid.xyz/ws');
    w.onopen = () => CFG.symbols.forEach((s) => w.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin: short(s) } })));
    w.onmessage = (e) => { try { const d = JSON.parse(e.data); if (d.channel === 'l2Book') { const b = d.data.levels[0][0], a = d.data.levels[1][0]; if (b && a) gotQuote(d.data.coin + 'USDT', +b.px, +a.px, 'Hyperliquid', id); } } catch (err) { /* ignore */ } };
    w.onclose = () => { if (id === attempt && lastQuoteAny >= attemptStart) setTimeout(() => connect(0), 2000); };
    return { close: () => { w.onclose = null; try { w.close(); } catch (e) { /* ignore */ } } };
  } },
  { name: 'Binance (HTTP)', open: (id) => {
    const url = 'https://api.binance.com/api/v3/ticker/bookTicker?symbols=' + encodeURIComponent(JSON.stringify(CFG.symbols));
    const run = () => fetch(url).then((r) => r.json()).then((rows) => {
      if (Array.isArray(rows)) rows.forEach((d) => { if (d && d.symbol && d.bidPrice) gotQuote(d.symbol, +d.bidPrice, +d.askPrice, 'Binance (HTTP)', id); });
    }).catch(() => {});
    run(); const h = setInterval(run, CFG.eco ? 3000 : 1000);
    return { close: () => clearInterval(h) };
  } },
  // Last resort: Hyperliquid over plain HTTP (no WebSocket needed, no Binance needed). One request per symbol.
  { name: 'Hyperliquid (HTTP)', open: (id) => {
    const run = () => CFG.symbols.forEach((s) => fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'l2Book', coin: short(s) }) })
      .then((r) => r.json()).then((d) => { const lv = hlLevels(d); if (lv) gotQuote(s, +lv[0][0].px, +lv[1][0].px, 'Hyperliquid (HTTP)', id); }).catch(() => {}));
    run(); const h = setInterval(run, CFG.eco ? 3000 : 1500);
    return { close: () => clearInterval(h) };
  } },
];
// Hyperliquid's l2Book answers { coin, time, levels: [bids, asks] }; some mirrors send the bare [bids, asks].
function hlLevels(d) { const lv = Array.isArray(d) ? d : d && d.levels; return Array.isArray(lv) && lv[0] && lv[0][0] && lv[1] && lv[1][0] ? lv : null; }
function connect(idx) {
  try { if (feed) feed.close(); } catch (e) { /* ignore */ }
  feed = null; feedIdx = idx || 0; attempt++; attemptStart = Date.now();
  if (feedIdx === 0 && everLive) P.counters.reconnects++;
  if (feedIdx >= FEEDS.length) { out('Hiçbir fiyat kaynağına bağlanılamadı; 30 sn sonra yeniden denenecek'); setTimeout(() => connect(0), 30000); return; }
  const id = attempt;
  try { feed = FEEDS[feedIdx].open(id); } catch (e) { feed = null; }
  setTimeout(() => { if (id === attempt && lastQuoteAny < attemptStart) connect(feedIdx + 1); }, 4000);
}
setInterval(() => { if (everLive && Date.now() - lastQuoteAny > 15000 && lastQuoteAny >= attemptStart) connect(0); }, 5000);

// ---------- Quotes → bars → agent (same rules as the page) ----------
const SPIKE = 0.03, SPIKE_CONFIRM = 3, MAX_SKIP = 5, MAX_SPREAD = 0.003, MAX_WARM = 85;
const barMs = () => CFG.bar * 1000;
const fresh = (c) => c.q.bid != null && Date.now() - c.q.t <= 5000;
// A bar may close on a price up to 20 s old (quiet markets send few updates); orders still need a fresh one.
const BAR_PX_MAX_AGE = 20000;
function gotQuote(sym, bid, ask, name, id) {
  const c = C[sym];
  if (!c || id !== attempt) return;
  if (!(bid > 0) || !(ask >= bid) || !isFinite(bid) || !isFinite(ask)) return;
  const mid = (bid + ask) / 2, now = Date.now(), q = c.q;
  // Savings mode: one quote per symbol per second is enough to watch stops (exchanges send hundreds).
  if (CFG.eco && q.bid != null && now - q.t < 1000) return;
  if (q.bid != null && now - q.t < 10000) {
    const ref = (q.bid + q.ask) / 2;
    if (Math.abs(mid / ref - 1) > SPIKE) {
      if (c.suspect && Math.abs(mid / c.suspect.mid - 1) < 0.005) c.suspect.n++; else { c.suspect = { mid, n: 1 }; P.counters.spikes++; }
      if (c.suspect.n < SPIKE_CONFIRM) return;
      note(c, 'Büyük fiyat hareketi doğrulandı');
    }
  }
  c.suspect = null;
  if (feedName !== name) { out('Fiyat kaynağı: ' + name); feedName = name; }
  everLive = true; lastQuoteAny = now;
  rollBars(c, now, q.bid != null && now - q.t <= BAR_PX_MAX_AGE ? (q.bid + q.ask) / 2 : null);
  q.bid = bid; q.ask = ask; q.t = now;
  if (!c.curBar) c.curBar = { o: mid, h: mid, l: mid }; else { c.curBar.h = Math.max(c.curBar.h, mid); c.curBar.l = Math.min(c.curBar.l, mid); }
  if (E.onTick(c.acct, bid, ask)) c.blocked = c.lastSide || c.blocked;
  flushEvents(c);
}
function rollBars(c, now, px) {
  const idx = Math.floor(now / barMs());
  if (c.barIdx == null || idx < c.barIdx) { c.barIdx = idx; return; }
  if (idx === c.barIdx) return;
  const missed = idx - c.barIdx - 1;
  c.barIdx = idx;
  if (missed > MAX_SKIP) {
    P.counters.gaps++; c.closes = []; c.bars = []; c.curBar = null; c.st = { cur: null }; c.blocked = null;
    note(c, 'Veri kesintisi (' + Math.round(missed * CFG.bar / 60) + ' dk): pozisyon korunuyor, geçmiş barlar yeniden yükleniyor');
    seed(c);
    return;
  }
  // A bar closed without us (restart, short outage): the series now has a hole. No decisions on it; reload the
  // bars from the exchange, then decide on this bar's close if that is still recent.
  if (missed > 0 || !(px > 0)) {
    P.counters.skippedBars = (P.counters.skippedBars || 0) + 1 + missed; c.curBar = null;
    c.stale = true; seed(c, idx); return;
  }
  const cb = c.curBar || { o: px, h: px, l: px };
  c.closes.push(px); c.bars.push({ o: cb.o, h: Math.max(cb.h, px), l: Math.min(cb.l, px), c: px }); c.curBar = null;
  if (c.closes.length > 400) { c.closes.shift(); c.bars.shift(); }
  try { agent(c); } catch (e) { P.counters.errors++; out('[' + short(c.sym) + '] Ajan hatası: ' + e.message); }
  barDone(c);
}
setInterval(() => { for (const sym of CFG.symbols) { const c = C[sym]; if (c.q.bid != null && Date.now() - c.q.t <= BAR_PX_MAX_AGE) rollBars(c, Date.now(), (c.q.bid + c.q.ask) / 2); } }, 1000);
const fill = (c, side, closing) => ((side === 'long') !== closing ? c.q.ask : c.q.bid);
function agent(c) {
  if (!fresh(c) || c.stale) return; // no decisions on bars that are not verified complete
  const m = c.model;
  if (!m || !m.chosen) return; // no trusted strategy for this symbol: wait (open positions keep their stops)
  const name = m.chosen.name, prm = m.chosen.prm, a = c.acct;
  if (c.closes.length < E.warmFor(name, prm)) return;
  const wide = (c.q.ask - c.q.bid) / c.q.ask > MAX_SPREAD;
  const sg = E.signalFor(name, c.st, c.closes, c.bars, prm);
  if (c.blocked && sg.side !== c.blocked) c.blocked = null;
  if (a.pos && sg.side !== a.pos.side) E.closePos(a, fill(c, a.pos.side, true), 'Sinyal ile');
  if (a.pos || !sg.side || sg.side === c.blocked) { if (!a.pos) c.vetoLast = null; flushEvents(c); return; }
  // Reasons not to open, in order. Each is logged once per streak.
  let veto = null, kind = null;
  if (P.halt) { veto = 'portföy durduruldu (' + (P.halt === 'günlük' ? 'günlük limit' : 'düşüş limiti') + ')'; kind = 'halt'; }
  else if (P.paused) { veto = 'Telegram\'dan durduruldu (/devam ile açılır)'; kind = 'halt'; }
  else if (calendarBlock()) { veto = 'ekonomi takvimi: ' + calendarBlock(); kind = 'calendar'; }
  else if (CFG.symbols.filter((s) => s !== c.sym && C[s].acct.pos && C[s].acct.pos.side === sg.side).length >= CFG.maxSameSide) {
    veto = 'aynı yönde zaten ' + CFG.maxSameSide + ' pozisyon açık (semboller birlikte hareket eder)'; kind = 'sameSide';
  } else { const f = E.filterBlocks(sg.side, m.chosen.filters, { funding: c.funding, fng: mkt.fng }); if (f) { veto = f; kind = 'filter'; } }
  if (veto) {
    if (kind !== 'halt' && c.vetoLast !== veto) P.counters[kind] = (P.counters[kind] || 0) + 1;
    if (c.vetoLast !== veto) { c.vetoLast = veto; note(c, (sg.side === 'long' ? 'AL' : 'SAT') + ' sinyali uygulanmadı: ' + veto); }
    return;
  }
  // Weak evidence: smaller bet (or none). Models learned before this check carry no measurement and count as weak.
  const scale = m.chosen.strong ? 1 : CFG.weakRisk;
  if (!(scale > 0)) { veto = 'modelin kanıtı zayıf (--weak-risk 0)'; kind = 'weak'; }
  if (veto) {
    if (c.vetoLast !== veto) { P.counters[kind] = (P.counters[kind] || 0) + 1; c.vetoLast = veto; note(c, (sg.side === 'long' ? 'AL' : 'SAT') + ' sinyali uygulanmadı: ' + veto); }
    return;
  }
  c.vetoLast = null;
  if (!a.halt && !wide) {
    try {
      a.risk = BASE_RISK * scale;
      E.openPos(a, sg.side, fill(c, sg.side, false), sg.stop, CFG.lev, m.chosen.pm || null); a.pos.src = 'live'; a.pos.strat = name; c.lastSide = sg.side;
      const atStop = a.pos.qty * Math.abs(a.pos.entry - a.pos.stop) + a.pos.costs + a.pos.qty * a.pos.stop * (a.fee + a.slip);
      tg(short(c.sym) + ' ' + sideTr(sg.side) + ' açıldı · ' + E.num(a.pos.entry, 2) + ' · stop ' + E.num(a.pos.stop, 2) + ' · stopta kayıp ≈ ' + money(atStop) + ' USDT · ' + SNAME[name] + (sg.votes ? ' (' + sg.votes + ' oy)' : '') + (scale < 1 ? ' · zayıf kanıt, risk x' + scale : ''), false);
    } catch (e) { /* refused by risk rules */ }
  }
  flushEvents(c);
}

// ---------- Warm-up from history ----------
// Strategies carry state (e.g. the side of the last breakout). After bars are reloaded or the model changes, that
// state is rebuilt by replaying the model over the loaded bars — the same warmed-up state the learner tested with.
function rebuildState(c) {
  c.st = { cur: null };
  const ch = c.model && c.model.chosen;
  if (!ch) return;
  for (let i = Math.max(2, E.warmFor(ch.name, ch.prm)); i <= c.closes.length; i++) E.signalFor(ch.name, c.st, c.closes.slice(0, i), c.bars.slice(0, i), ch.prm);
}
// actFor: the bar index whose close is still waiting for a decision (set when a bar closed on incomplete data).
function seed(c, actFor) {
  if (actFor != null) c.actFor = actFor;
  if (c.seeding || (!c.stale && c.closes.length >= MAX_WARM)) return;
  c.seeding = true;
  E.fetchCandles(c.sym, TF_OF_BAR[CFG.bar], 400).then((res) => {
    const now = Date.now(); let done = res.candles.filter((k) => k.c > 0 && k.h >= k.l && k.t + barMs() <= now).slice(-400);
    // Use only the unbroken run of candles up to now (an exchange outage leaves a hole in its history too).
    for (let i = done.length - 1; i > 0; i--) if (done[i].t - done[i - 1].t !== barMs()) { done = done.slice(i); break; }
    if (done.length < 10) throw new Error('az mum');
    const idx = Math.floor(now / barMs());
    if (Math.floor(done[done.length - 1].t / barMs()) !== idx - 1) throw new Error('son kapanan mum henüz gelmedi');
    c.closes = done.map((k) => k.c); c.bars = done.map((k) => ({ o: k.o, h: k.h, l: k.l, c: k.c }));
    c.barIdx = idx; c.stale = false;
    rebuildState(c);
    out('[' + short(c.sym) + '] Geçmişten ' + done.length + ' bar yüklendi (' + res.venue + ')');
    // Decide on the just-closed bar only while it is recent (first 3 minutes of the new bar); otherwise wait for the next close.
    if (c.actFor === idx && now - idx * barMs() < Math.min(180e3, barMs() / 4)) { try { agent(c); } catch (e) { P.counters.errors++; out('[' + short(c.sym) + '] Ajan hatası: ' + e.message); } }
    c.actFor = null;
  }).catch((e) => out('[' + short(c.sym) + '] Geçmiş barlar yüklenemedi (' + e.message + '); 1 dk sonra yeniden denenecek'))
    .finally(() => { c.seeding = false; if (c.stale || c.closes.length < MAX_WARM) setTimeout(() => seed(c), 60000); });
}

// ---------- Market data: funding per symbol (charged to each sub-account) and Fear & Greed ----------
const mkt = { fng: null, fundSrc: null, t: 0 };
function pollFunding() {
  fetch('https://fapi.binance.com/fapi/v1/premiumIndex').then((r) => r.json()).then((rows) => {
    if (!Array.isArray(rows)) throw new Error('yanıt');
    const m = {}; rows.forEach((r) => { m[r.symbol] = +r.lastFundingRate; });
    return { m, src: 'Binance vadeli' };
  }).catch(() => fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) })
    .then((r) => r.json()).then((r) => {
      const m = {}; r[0].universe.forEach((u, i) => { m[u.name + 'USDT'] = +r[1][i].funding * 8; });
      return { m, src: 'Hyperliquid' };
    }))
    .then((x) => {
      mkt.fundSrc = x.src; mkt.t = Date.now();
      for (const sym of CFG.symbols) { const f = x.m[sym]; if (isFinite(f) && Math.abs(f) <= 0.02) { /* beyond ±2% per 8 h: bad data, keep the last rate */ C[sym].funding = f; C[sym].acct.fund = f; } }
    }).catch(() => { /* keep the last known rates */ });
}
// Order book every 30 s per symbol: orders fill by walking it. Older than 2 min: back to the slippage floor.
function pollDepth() {
  for (const sym of CFG.symbols) {
    const c = C[sym], top = (rows) => rows.slice(0, 200).map((r) => [+r[0], +r[1]]).filter((r) => r[0] > 0 && r[1] > 0);
    fetch('https://api.binance.com/api/v3/depth?symbol=' + sym + '&limit=500').then((r) => r.json()).then((d) => {
      if (!d || !Array.isArray(d.bids)) throw new Error('yanıt');
      return { bids: top(d.bids), asks: top(d.asks) };
    }).catch(() => fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'l2Book', coin: short(sym) }) })
      .then((r) => r.json()).then((d) => { const lv = hlLevels(d); if (!lv) throw new Error('yanıt'); return { bids: top(lv[0].map((l) => [l.px, l.sz])), asks: top(lv[1].map((l) => [l.px, l.sz])) }; }))
      .then((b) => {
        if (!b.bids.length || !b.asks.length) return;
        const band = (lv, dir) => lv.reduce((u, l) => (dir * (l[0] / lv[0][0] - 1) <= 0.01 ? u + l[0] * l[1] : u), 0);
        c.depthUsd = Math.min(band(b.bids, -1), band(b.asks, 1)); c.bookT = Date.now(); c.acct.book = Object.assign(b, { t: Date.now() });
      }).catch(() => { /* keep the last book until it is too old */ })
      .finally(() => { if (c.bookT && Date.now() - c.bookT > (CFG.eco ? 300000 : 120000)) c.acct.book = null; });
  }
}
function pollFng() {
  fetch('https://api.alternative.me/fng/?limit=1&format=json').then((r) => r.json())
    .then((d) => { const v = +(d && d.data && d.data[0] && d.data[0].value); if (v >= 0 && v <= 100) mkt.fng = v; }).catch(() => {});
}

// ---------- Economic calendar: no new entries around high-impact releases ----------
// Source: ForexFactory's free weekly feed (this week only, no history — so this is a fixed safety rule, not something
// the learner can test). Fetched every 3 h; if it can't be fetched, the last known week is used.
const CAL_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
function pollCalendar() {
  fetch(CAL_URL).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then((rows) => {
    if (!Array.isArray(rows)) throw new Error('beklenmeyen yanıt');
    const ev = rows.map((r) => ({ t: Date.parse(r.date), title: r.title, country: String(r.country || '').toUpperCase(), impact: r.impact }))
      .filter((x) => isFinite(x.t) && x.impact === 'High' && CFG.calCountries.includes(x.country)).sort((a, b) => a.t - b.t);
    const first = !cal.ok;
    cal = { events: ev, fetchedAt: Date.now(), ok: true };
    if (first) out('Ekonomi takvimi yüklendi: bu hafta ' + ev.length + ' yüksek etkili ' + CFG.calCountries.join('/') + ' verisi');
  }).catch((e) => {
    setTimeout(pollCalendar, 5 * 60e3 + Math.random() * 60e3); // e.g. HTTP 429: try again soon, not in 3 hours
    if (cal.ok && Date.now() - cal.fetchedAt < 3.5 * 3600e3) return;
    if (!cal.warned) { out('Ekonomi takvimi alınamadı (' + e.message + '); ' + (cal.events.length ? 'son bilinen takvim kullanılıyor' : 'takvim koruması şimdilik devre dışı')); cal.warned = true; }
  });
}
function calendarBlock() {
  const now = Date.now();
  const e = cal.events.find((x) => now >= x.t - CFG.calBefore * 60e3 && now <= x.t + CFG.calAfter * 60e3);
  return e ? e.title + ' (' + new Date(e.t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) + ')' : null;
}
function nextEvent() { const now = Date.now(); return cal.events.find((x) => x.t + CFG.calAfter * 60e3 >= now) || null; }

// ---------- Learning: per symbol, one at a time; on start, every 6 h, and when live results degrade ----------
// Relearn every 6 hours, or every 6 bars when bars are long (24 h for 4-hour bars).
const RELEARN_EVERY = Math.max(6 * 3600e3, 6 * CFG.bar * 1000), RETRY_AFTER = 3600e3;
let learningNow = null;
const descCore = (ch) => ch ? SNAME[ch.name] + ' (' + E.describeParams(ch.name, ch.prm) + (ch.filters ? ' · ' + E.filterLabel(ch.filters) : '') + (ch.pm ? ' · ' + E.pmLabel(ch.pm) : '') + ')' : 'bekleme (güvenilir strateji yok)';
const desc = (ch) => descCore(ch) + (ch ? evid(ch) : '');
const evid = (ch) => ch.t == null ? ' · kanıt ölçülmedi' : ch.strong ? ' · kanıt güçlü (t ' + E.num(ch.t, 1) + ')' : ' · kanıt zayıf (t ' + E.num(ch.t, 1) + (CFG.weakRisk > 0 ? ', risk x' + CFG.weakRisk : ', işlem yok') + ')';
function learn(c, why) {
  if (learningNow) return;
  learningNow = c.sym;
  const tf = TF_OF_BAR[CFG.bar], tfMs = CFG.bar * 1000, prev = c.model;
  c.lastLearnTry = Date.now();
  out('[' + short(c.sym) + '] Öğrenme başladı (' + why + '): ' + CFG.learnBars + ' mum, ' + tf);
  E.fetchCandles(c.sym, tf, CFG.learnBars).then((res) => {
    const k = res.candles.filter((x) => x.c > 0 && x.h >= x.l);
    if (k.length < 1000) throw new Error('yeterli mum gelmedi (' + k.length + ')');
    return E.fetchMarketHistory(c.sym, k, tfMs).then((mh) => E.walkForward(k, CFG.lev, tfMs, null, { fund: mh.fund, fng: mh.fng, depthUsd: c.depthUsd || E.DEPTH_DEFAULT[c.sym] || 0 }).then((wf) => ({ wf, mh, venue: res.venue })));
  }).then(({ wf, mh, venue }) => {
    // Quarantine: a model that was dropped for failing live is not taken back right away, however good its history looks.
    if (c.ban && c.ban.until <= Date.now()) c.ban = null;
    if (wf.chosen && c.ban && wf.chosen.name === c.ban.name) {
      const sc = (r) => r.oos.ret / Math.max(r.oos.maxDD, 0.02);
      const alt = wf.results.filter((r) => r.ok && r.name !== c.ban.name).sort((x, y) => (y.strong - x.strong) || (sc(y) - sc(x)))[0];
      note(c, SNAME[c.ban.name] + ' canlıda başarısız olduğu için ' + ts(c.ban.until) + ' tarihine kadar karantinada; ' + (alt ? 'sıradaki güvenilir strateji alınıyor' : 'başka güvenilir strateji yok, bekleniyor'));
      wf.chosen = alt ? { name: alt.name, prm: alt.prm, filters: alt.filters, pm: alt.pm, strong: alt.strong, t: alt.oos.t } : null;
    }
    c.model = { tf, lev: CFG.lev, venue, learnedAt: Date.now(), chosen: wf.chosen, span: wf.span,
      results: wf.results.map((r) => ({ name: r.name, ok: r.ok, strong: !!r.strong, t: r.oos.t, prm: r.prm, filters: r.filters, pm: r.pm, ret: r.oos.ret, n: r.oos.n, pf: r.oos.pf, dd: r.oos.maxDD })),
      data: { funding: mh.fundSrc || null, fng: mh.fngSrc || null }, appliedAt: Date.now(), peakEq: E.equity(c.acct),
      history: ((prev && prev.history) || []).concat([{ t: Date.now(), why, chosen: wf.chosen ? desc(wf.chosen) : null }]).slice(-50) };
    rebuildState(c);
    note(c, 'Model: ' + (prev ? desc(prev.chosen) + ' → ' : '') + desc(wf.chosen));
    if (!prev || descCore(prev.chosen) !== descCore(wf.chosen) || !!(prev.chosen && prev.chosen.strong) !== !!(wf.chosen && wf.chosen.strong)) tg(short(c.sym) + ' modeli ' + (prev ? 'değişti (' + why + ')' : 'hazır') + ': ' + desc(wf.chosen), true);
    for (const r of c.model.results) out('[' + short(c.sym) + ']   ' + (r.ok ? '✓ ' : '  ') + SNAME[r.name].padEnd(17) + ' görmediği veride ' + (r.ret * 100).toFixed(1).padStart(6) + '% · ' + String(r.n).padStart(3) + ' işlem · kâr f. ' + (r.pf === Infinity || r.pf == null ? '∞' : r.pf.toFixed(2)) + ' · düşüş ' + (r.dd * 100).toFixed(0) + '% · t ' + (r.t == null ? '–' : r.t.toFixed(1)));
    save();
  }).catch((e) => out('[' + short(c.sym) + '] Öğrenme yapılamadı (' + e.message + '); ' + (c.model ? 'mevcut modelle devam, ' : '') + '1 saat sonra yeniden denenecek'))
    .finally(() => { learningNow = null; });
}
function liveCheck() {
  if (learningNow) return;
  const now = Date.now();
  for (const sym of CFG.symbols) {
    const c = C[sym], m = c.model;
    if (now - (c.lastLearnTry || 0) < RETRY_AFTER) continue;
    let why = !m ? 'ilk öğrenme' : now - m.learnedAt > RELEARN_EVERY ? 'süresi doldu' : m.chosen && m.chosen.t == null ? 'kanıt gücü ölçümü' : null;
    if (!why && m && m.chosen) {
      const e = E.equity(c.acct); m.peakEq = Math.max(m.peakEq || e, e);
      const tr = (c.acct.history || []).filter((h) => h.tClose >= m.appliedAt);
      let gw = 0, gl = 0; tr.forEach((h) => { if (h.pnl > 0) gw += h.pnl; else gl -= h.pnl; });
      if (tr.length >= 8 && (gl > 0 ? gw / gl : 9) < 0.8) why = 'canlıda kâr faktörü düştü';
      else if ((m.peakEq - e) / m.peakEq > 0.06) why = 'canlıda %6 geriledi';
      if (why) c.ban = { name: m.chosen.name, until: now + CFG.banDays * 86400e3 };
    }
    if (why) { learn(c, why); return; }
  }
}

// ---------- Weekly report ----------
const money = (n) => E.num(n, 2);
const pctS = (f, d) => (f < 0 ? '-' : '') + '%' + E.num(Math.abs(f) * 100, d == null ? 2 : d);
const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
function statsOf(trades) {
  const w = trades.filter((h) => h.pnl > 0), l = trades.filter((h) => h.pnl <= 0);
  const gw = w.reduce((s, h) => s + h.pnl, 0), gl = -l.reduce((s, h) => s + h.pnl, 0);
  return { n: trades.length, pnl: gw - gl, win: trades.length ? w.length / trades.length : null, pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : null) };
}
function buildReport(from, to) {
  const all = [];
  for (const sym of CFG.symbols) for (const h of (C[sym].acct.history || [])) if (h.tClose >= from && h.tClose < to) all.push(Object.assign({ sym }, h));
  all.sort((a, b) => a.tClose - b.tClose);
  const eq = P.eqHist.filter((x) => x[0] >= from && x[0] <= to).concat(to >= Date.now() - 60e3 ? [[Date.now(), peq()]] : []);
  const e0 = eq.length ? eq[0][1] : peq(), e1 = eq.length ? eq[eq.length - 1][1] : peq();
  let pk = e0, wdd = 0; eq.forEach((x) => { pk = Math.max(pk, x[1]); wdd = Math.max(wdd, (pk - x[1]) / pk); });
  const S = statsOf(all);
  const pf = (v) => v == null ? '–' : v === Infinity ? '∞' : E.num(v, 2);
  // Equity curve as inline SVG.
  let svg = '';
  if (eq.length > 1) {
    const W = 680, H = 160, lo = Math.min(...eq.map((x) => x[1])), hi = Math.max(...eq.map((x) => x[1])), rg = (hi - lo) || 1;
    const X = (t) => 10 + (t - eq[0][0]) / ((eq[eq.length - 1][0] - eq[0][0]) || 1) * (W - 20), Y = (v) => H - 10 - (v - lo) / rg * (H - 20);
    svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;background:#151c20;border-radius:8px"><polyline fill="none" stroke="' + (e1 >= e0 ? '#3ecf8e' : '#ff6b6b') + '" stroke-width="2" points="' +
      eq.map((x) => X(x[0]).toFixed(1) + ',' + Y(x[1]).toFixed(1)).join(' ') + '"/><text x="12" y="16" fill="#8a9aa1" font-size="11">' + esc(money(hi)) + '</text><text x="12" y="' + (H - 4) + '" fill="#8a9aa1" font-size="11">' + esc(money(lo)) + '</text></svg>';
  }
  // Per symbol: live vs what the model's unseen-data test promised, per trade.
  const symRows = CFG.symbols.map((sym) => {
    const c = C[sym], tr = all.filter((h) => h.sym === sym), st = statsOf(tr), m = c.model;
    const r = m && m.chosen ? m.results.find((x) => x.name === m.chosen.name) : null;
    const expPer = r && r.n ? Math.pow(1 + r.ret, 1 / r.n) - 1 : null;
    const sub = CFG.capital / N, livePer = st.n ? st.pnl / st.n / sub : null;
    return '<tr><td><b>' + esc(short(sym)) + '</b><small>' + esc(m ? desc(m.chosen) : 'model yok') + '</small></td><td>' + st.n + '</td><td class="' + (st.pnl >= 0 ? 'up' : 'down') + '">' + esc((st.pnl >= 0 ? '+' : '') + money(st.pnl)) +
      '<small>kazanma ' + (st.win == null ? '–' : esc(pctS(st.win, 0))) + '</small></td><td>' + (expPer == null ? '–' : esc(pctS(expPer, 2))) + '</td><td>' + (livePer == null ? '–' : esc(pctS(livePer, 2))) + '</td></tr>';
  }).join('');
  const byStrat = {};
  all.forEach((h) => { const k = h.strat || '?'; (byStrat[k] = byStrat[k] || []).push(h); });
  const stratRows = Object.keys(byStrat).map((k) => { const st = statsOf(byStrat[k]); return '<tr><td>' + esc(SNAME[k] || k) + '</td><td>' + st.n + '</td><td class="' + (st.pnl >= 0 ? 'up' : 'down') + '">' + esc((st.pnl >= 0 ? '+' : '') + money(st.pnl)) + '</td><td>' + (st.win == null ? '–' : esc(pctS(st.win, 0))) + '</td><td>' + esc(pf(st.pf)) + '</td></tr>'; }).join('');
  const modelChanges = CFG.symbols.flatMap((sym) => ((C[sym].model && C[sym].model.history) || []).filter((x) => x.t >= from && x.t < to).map((x) => '<li>' + esc(ts(x.t) + ' · ' + short(sym) + ' · ' + x.why + ' → ' + (x.chosen || 'bekleme')) + '</li>')).join('');
  const tradeRows = all.slice(-60).reverse().map((h) => '<tr><td>' + esc(ts(h.tClose)) + '</td><td>' + esc(short(h.sym) + ' ' + h.side) + '<small>' + esc(h.reason) + '</small></td><td>' + esc(E.num(h.entry, 2)) + '<small>→ ' + esc(E.num(h.exit, 2)) + '</small></td><td class="' + (h.pnl >= 0 ? 'up' : 'down') + '">' + esc((h.pnl >= 0 ? '+' : '') + money(h.pnl)) + '</td></tr>').join('');
  const few = S.n < 20;
  return '<!DOCTYPE html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>metyu haftalık rapor</title>' +
    '<style>body{font:14px/1.5 system-ui,sans-serif;margin:16px auto;max-width:760px;padding:0 12px;background:#0e1316;color:#e6edef}h1{font-size:20px}h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#8a9aa1;margin-top:26px}' +
    'table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:6px 4px;border-bottom:1px solid #26343a;text-align:right}td:first-child,th:first-child{text-align:left}th{color:#8a9aa1;font-weight:500}.up{color:#3ecf8e}.down{color:#ff6b6b}' +
    'td small{display:block;color:#8a9aa1;font-size:11.5px}.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.kpi div{background:#151c20;border-radius:8px;padding:10px}.kpi b{display:block;font-size:18px}.note{color:#8a9aa1;font-size:12.5px}.wrap{overflow-x:auto}</style>' +
    '<h1>metyu · haftalık rapor</h1><p class="note">' + esc(ts(from) + ' – ' + ts(to)) + ' · ' + esc(CFG.symbols.map(short).join(', ')) + ' · ' + esc(TF_OF_BAR[CFG.bar]) + ' bar · ' + CFG.lev + 'x · sanal para</p>' +
    '<div class="kpi"><div>Haftalık K/Z<b class="' + (e1 >= e0 ? 'up' : 'down') + '">' + esc((e1 - e0 >= 0 ? '+' : '') + money(e1 - e0)) + '</b>' + esc(pctS((e1 - e0) / e0)) + '</div>' +
    '<div>Portföy<b>' + esc(money(e1)) + '</b>başlangıçtan ' + esc(pctS(e1 / P.start - 1)) + '</div><div>Hafta içi en büyük düşüş<b>' + esc(pctS(wdd)) + '</b>tüm zamanlar ' + esc(pctS(P.maxDD)) + '</div>' +
    '<div>İşlem<b>' + S.n + '</b>kazanma ' + (S.win == null ? '–' : esc(pctS(S.win, 0))) + ' · kâr f. ' + esc(pf(S.pf)) + '</div></div>' +
    (svg ? '<h2>Özkaynak (saatlik)</h2>' + svg : '') +
    '<h2>Sembollere göre · canlı ve beklenen</h2><div class="wrap"><table><tr><th>Sembol · model</th><th>İşlem</th><th>K/Z</th><th>Beklenen / işlem</th><th>Canlı / işlem</th></tr>' + symRows + '</table></div>' +
    '<p class="note">"Beklenen", modelin görmediği geçmiş veride işlem başına ortalama getirisi; "canlı", bu hafta sembolün payına düşen sermayeye göre işlem başına gerçekleşen. ' + (few ? 'Bu hafta işlem sayısı az (' + S.n + '); fark büyük ölçüde şans olabilir, birkaç haftalık toplamına bakmak daha anlamlı.' : 'Canlı sonuç sürekli beklenenin belirgin altındaysa model gerçek piyasada geçmişteki kadar işlemiyor demektir.') + '</p>' +
    (stratRows ? '<h2>Stratejilere göre</h2><div class="wrap"><table><tr><th>Strateji</th><th>İşlem</th><th>K/Z</th><th>Kazanma</th><th>Kâr f.</th></tr>' + stratRows + '</table></div>' : '') +
    '<h2>Model değişiklikleri</h2>' + (modelChanges ? '<ul>' + modelChanges + '</ul>' : '<p class="note">Bu hafta model değişmedi.</p>') +
    '<h2>Koruma ve sağlık (toplam)</h2><p>Takvim nedeniyle uygulanmayan sinyal: ' + (P.counters.calendar || 0) + ' · aynı yön sınırı: ' + (P.counters.sameSide || 0) + ' · piyasa filtresi: ' + (P.counters.filter || 0) + ' · zayıf kanıt: ' + (P.counters.weak || 0) +
    '<br>Veri kesintisi: ' + (P.counters.gaps || 0) + ' · yeniden bağlanma: ' + (P.counters.reconnects || 0) + ' · elenen fiyat sıçraması: ' + (P.counters.spikes || 0) + ' · hata: ' + (P.counters.errors || 0) + (P.halt ? '<br><b class="down">Portföy şu an durdurulmuş: ' + esc(P.halt) + '</b>' : '') + '</p>' +
    '<h2>Son işlemler</h2>' + (tradeRows ? '<div class="wrap"><table><tr><th>Kapanış</th><th>İşlem</th><th>Giriş → çıkış</th><th>K/Z</th></tr>' + tradeRows + '</table></div>' : '<p class="note">Bu hafta kapanan işlem yok.</p>') +
    '<p class="note" style="margin-top:24px">Sanal para simülasyonudur; gerçek işlemde emir defteri derinliği ve kayma sonuçları kötüleştirebilir. Geçmişte işe yarayan ayar gelecekte de işe yarayacak diye bir garanti yok.</p></html>';
}
function writeReport(from, to) {
  fs.mkdirSync(CFG.reportsDir, { recursive: true });
  const d = new Date(to), name = 'metyu-rapor-' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '.html';
  const file = path.join(CFG.reportsDir, name);
  fs.writeFileSync(file, buildReport(from, to));
  return file;
}
// Monday 09:00 local time, for the 7 days before it.
function lastMonday9(now) { const d = new Date(now); d.setHours(9, 0, 0, 0); const back = (d.getDay() + 6) % 7; d.setDate(d.getDate() - back); if (d.getTime() > now) d.setDate(d.getDate() - 7); return d.getTime(); }
function reportCheck() {
  const due = lastMonday9(Date.now());
  if (P.lastReport >= due) return;
  if (!P.lastReport) { P.lastReport = due; return; } // first run: start counting from now, no empty report
  try {
    const f = writeReport(due - 7 * 86400e3, due); P.lastReport = due; out('Haftalık rapor yazıldı: ' + path.relative(DIR, f)); save();
    const wk = CFG.symbols.flatMap((s) => (C[s].acct.history || []).filter((h) => h.tClose >= due - 7 * 86400e3 && h.tClose < due)), st = statsOf(wk);
    tgDoc(path.basename(f), fs.readFileSync(f, 'utf8'), 'Haftalık rapor · ' + st.n + ' işlem · K/Z ' + (st.pnl >= 0 ? '+' : '') + money(st.pnl) + ' · portföy ' + money(peq()));
  }
  catch (e) { out('Rapor yazılamadı: ' + e.message); }
}

// ---------- Telegram: notifications and a few commands ----------
// Set up once with:  node metyu-runner.mjs --telegram-setup <BOT_TOKEN>
// (or set METYU_TG_TOKEN and METYU_TG_CHAT). Commands are accepted only from that one chat.
const TG_FILE = path.join(DATA, 'metyu-telegram.json');
let TG = null;
try { TG = JSON.parse(fs.readFileSync(TG_FILE, 'utf8')); } catch (e) { /* not set up */ }
if (process.env.METYU_TG_TOKEN && process.env.METYU_TG_CHAT) TG = { token: process.env.METYU_TG_TOKEN, chatId: +process.env.METYU_TG_CHAT };
const TG_QUIET = !!args['telegram-quiet']; // only important messages (no per-trade messages)
function tgApi(method, body, form) {
  return fetch('https://api.telegram.org/bot' + TG.token + '/' + method, form ? { method: 'POST', body } :
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
}
const tgQueue = []; let tgBusyUntil = 0, tgWarnAt = 0;
function tg(text, important) {
  if (!TG || (TG_QUIET && !important)) return;
  if (tgQueue.length > 30) tgQueue.splice(0, tgQueue.length - 30); // never let a backlog grow without bound
  tgQueue.push({ text: String(text).slice(0, 3900) });
}
function tgDoc(name, html, caption) { if (TG) tgQueue.push({ doc: { name, html, caption } }); }
// One message per ~1.1 s (Telegram's per-chat pace); waits as told on 429; a failure never touches trading.
setInterval(() => {
  if (!TG || !tgQueue.length || Date.now() < tgBusyUntil) return;
  const m = tgQueue.shift();
  let p;
  if (m.doc) {
    const fd = new FormData();
    fd.append('chat_id', String(TG.chatId)); if (m.doc.caption) fd.append('caption', m.doc.caption.slice(0, 1000));
    fd.append('document', new Blob([m.doc.html], { type: 'text/html' }), m.doc.name);
    p = tgApi('sendDocument', fd, true);
  } else p = tgApi('sendMessage', { chat_id: TG.chatId, text: m.text, disable_web_page_preview: true });
  tgBusyUntil = Date.now() + 1100;
  p.then((r) => {
    if (r && r.ok) return;
    if (r && r.error_code === 429) { tgQueue.unshift(m); tgBusyUntil = Date.now() + ((r.parameters && r.parameters.retry_after) || 5) * 1000; return; }
    throw new Error(r && r.description || 'bilinmeyen yanıt');
  }).catch((e) => { if (Date.now() - tgWarnAt > 600e3) { tgWarnAt = Date.now(); out('Telegram mesajı gönderilemedi (' + e.message + '); program çalışmaya devam ediyor'); } });
}, 300);
const sideTr = (sd) => (sd === 'long' ? 'AL (long)' : 'SAT (short)');
function tgStatusText() {
  const e = peq(), nx = nextEvent();
  return 'metyu · sanal portföy\n' +
    'Özkaynak: ' + money(e) + ' (' + (e - P.start >= 0 ? '+' : '') + money(e - P.start) + ')\n' +
    'Bugün: ' + pctS((e - P.dayStart) / P.dayStart) + ' · maks. düşüş ' + pctS(P.maxDD) + '\n' +
    CFG.symbols.map((s) => { const c = C[s], a = c.acct; return short(s) + ': ' + (a.pos ? sideTr(a.pos.side) + ' · giriş ' + E.num(a.pos.entry, 2) + ' · stop ' + E.num(a.pos.stop, 2) : 'pozisyon yok') + (c.model ? ' · ' + (c.model.chosen ? SNAME[c.model.chosen.name] : 'bekliyor') : ''); }).join('\n') +
    (P.halt ? '\nDURDU: ' + (P.halt === 'günlük' ? 'günlük zarar limiti' : 'düşüş kilidi') : '') + (P.paused ? '\nYeni işlemler Telegram\'dan durduruldu (/devam ile aç)' : '') +
    (calendarBlock() ? '\nTakvim koruması: ' + calendarBlock() : nx ? '\nSıradaki veri: ' + nx.title + ' · ' + ts(nx.t) : '');
}
// Commands from the configured chat only.
let tgOffset = 0;
function tgPoll() {
  if (!TG) return;
  tgApi('getUpdates', { offset: tgOffset, timeout: 0 }).then((r) => {
    if (!r || !r.ok) return;
    for (const u of r.result) {
      tgOffset = u.update_id + 1;
      const msg = u.message; if (!msg || !msg.chat || msg.chat.id !== TG.chatId || typeof msg.text !== 'string') continue;
      const cmd = msg.text.trim().split(/\s|@/)[0].toLowerCase();
      if (cmd === '/durum') tg(tgStatusText(), true);
      else if (cmd === '/rapor') { tgDoc('metyu-rapor-son-7-gun.html', buildReport(Date.now() - 7 * 86400e3, Date.now()), 'Son 7 günün raporu'); }
      else if (cmd === '/dur') { P.paused = true; out('Telegram: yeni işlemler durduruldu'); tg('Tamam: yeni pozisyon açılmayacak. Açık pozisyonlar stoplarıyla yönetilmeye devam ediyor. /devam ile geri aç.', true); save(); }
      else if (cmd === '/devam') { P.paused = false; out('Telegram: yeni işlemlere yeniden izin verildi'); tg('Tamam: ajan yeniden yeni pozisyon açabilir.', true); save(); }
      else tg('Komutlar:\n/durum — portföy ve pozisyonlar\n/rapor — son 7 günün raporu (dosya)\n/dur — yeni işlem açmayı durdur\n/devam — yeniden izin ver', true);
    }
  }).catch(() => { /* try again next time */ });
}
// Watchers for things worth a message.
let tgCalWas = null, tgOutage = false, tgDailyFor = null;
setInterval(() => {
  if (!TG) return;
  const cb = calendarBlock();
  if (cb && cb !== tgCalWas) tg('Ekonomi takvimi: ' + cb + ' — veri çevresinde yeni pozisyon açılmıyor.', false);
  if (!cb && tgCalWas) tg('Takvim koruması bitti; ajan normal çalışıyor.', false);
  tgCalWas = cb;
  if (everLive && !tgOutage && Date.now() - lastQuoteAny > 120000) { tgOutage = true; tg('Uyarı: 2 dakikadır fiyat gelmiyor. Program yeniden bağlanmayı deniyor; bu sırada yeni işlem açılmaz.', true); }
  if (tgOutage && Date.now() - lastQuoteAny < 10000) { tgOutage = false; tg('Fiyat akışı geri geldi (' + (feedName || '?') + ').', true); }
  // Daily summary at 21:00 local.
  const d = new Date(), key = E.dayKey(Date.now());
  if (d.getHours() === 21 && tgDailyFor !== key) {
    tgDailyFor = key;
    const today = CFG.symbols.flatMap((s) => (C[s].acct.history || []).filter((h) => E.dayKey(h.tClose) === key));
    const st = statsOf(today);
    tg('Günlük özet · ' + d.toLocaleDateString('tr-TR') + '\n' + tgStatusText().split('\n').slice(1).join('\n') + '\nBugün kapanan işlem: ' + st.n + (st.n ? ' · K/Z ' + (st.pnl >= 0 ? '+' : '') + money(st.pnl) : ''), true);
  }
}, 5000);
// Interactive set-up: validate the token, wait for /start, save the chat id, send a test message.
if (args['telegram-setup']) {
  const token = args['telegram-setup'];
  if (token === 'true') { console.log('Kullanım: node metyu-runner.mjs --telegram-setup <BOT_TOKEN>'); process.exit(1); }
  TG = { token, chatId: null };
  tgApi('getMe', {}).then(async (me) => {
    if (!me || !me.ok) throw new Error('anahtar geçersiz: ' + (me && me.description || 'yanıt yok'));
    console.log('Bot bulundu: @' + me.result.username + '\nŞimdi Telegram\'da bu bota /start yaz (2 dakika bekliyorum)…');
    const until = Date.now() + 120000;
    while (Date.now() < until) {
      const r = await tgApi('getUpdates', { offset: tgOffset, timeout: 0 });
      for (const u of (r && r.result) || []) {
        tgOffset = u.update_id + 1;
        if (u.message && u.message.chat && u.message.chat.type === 'private') {
          TG.chatId = u.message.chat.id;
          fs.writeFileSync(TG_FILE, JSON.stringify(TG, null, 2), { mode: 0o600 });
          await tgApi('sendMessage', { chat_id: TG.chatId, text: 'metyu bağlandı. Program çalışırken bildirimler buraya gelecek. /durum yazarak deneyebilirsin.' });
          console.log('Tamam: sohbet kaydedildi (' + path.basename(TG_FILE) + '). Bu dosyayı kimseyle paylaşma; bot anahtarını içeriyor.');
          process.exit(0);
        }
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    throw new Error('2 dakika içinde /start gelmedi');
  }).catch((e) => { console.error('Telegram kurulamadı: ' + e.message); process.exit(1); });
}
if (args['report-now']) {
  const f = writeReport(Date.now() - 7 * 86400e3, Date.now());
  console.log('Rapor yazıldı: ' + f);
  process.exit(0);
}

// ---------- Status line per bar, and a read-only status page ----------
let lastStatusBar = null;
function barDone(c) {
  const idx = c.barIdx;
  if (lastStatusBar === idx) return;
  lastStatusBar = idx;
  setTimeout(() => {
    const e = peq();
    out('Durum · portföy ' + money(e) + ' (' + (e - P.start >= 0 ? '+' : '') + money(e - P.start) + ') · ' +
      CFG.symbols.map((s) => short(s) + ' ' + (C[s].acct.pos ? C[s].acct.pos.side : '–')).join(' · ') + (P.halt ? ' · DURDU: ' + P.halt : '') +
      (calendarBlock() ? ' · takvim: ' + calendarBlock() : ''));
    save();
  }, 1500);
}
function snapshot() {
  const e = peq();
  return {
    portfolio: { equity: e, pnl: e - P.start, maxDD: P.maxDD, halt: P.halt, today: (e - P.dayStart) / P.dayStart },
    bar: TF_OF_BAR[CFG.bar], lev: CFG.lev, feed: feedName, eco: CFG.eco,
    calendar: { active: calendarBlock(), next: nextEvent() && { at: new Date(nextEvent().t).toISOString(), title: nextEvent().title }, loaded: cal.ok },
    fng: mkt.fng, counters: P.counters,
    symbols: CFG.symbols.map((s) => { const c = C[s], a = c.acct; return {
      symbol: s, price: c.q.bid != null ? (c.q.bid + c.q.ask) / 2 : null, dataAgeSec: c.q.t ? Math.round((Date.now() - c.q.t) / 1000) : null,
      equity: E.equity(a), trades: a.trades, funding: c.funding ?? null, bars: c.closes.length,
      position: a.pos ? { side: a.pos.side, entry: a.pos.entry, stop: a.pos.stop, lev: a.pos.lev } : null,
      model: c.model ? desc(c.model.chosen) : null, evidence: c.model && c.model.chosen ? (c.model.chosen.t == null ? null : { t: c.model.chosen.t, strong: !!c.model.chosen.strong }) : null,
      barsVerified: !c.stale, quarantine: c.ban && c.ban.until > Date.now() ? { strategy: SNAME[c.ban.name], until: new Date(c.ban.until).toISOString() } : null, lastVeto: c.vetoLast || null }; }),
    recent: CFG.symbols.flatMap((s) => C[s].acct.events.slice(-12).map((x) => ({ t: x.t, msg: '[' + short(s) + '] ' + x.msg }))).sort((a, b) => a.t - b.t).slice(-20)
      .map((x) => ts(x.t) + '  ' + x.msg),
  };
}
// Optional access key for the status page: with METYU_VIEW_KEY set, every route needs it (first visit: /?k=KEY, then a cookie).
// Use it on a hosting platform, where the page has a public address. Without the variable the page stays open as before.
const VIEW_KEY = process.env.METYU_VIEW_KEY || '';
if (HOSTED && !VIEW_KEY) console.log('UYARI: METYU_VIEW_KEY ayarlı değil; durum sayfasını adresi bilen herkes görebilir (salt okunur).');
if (VIEW_KEY && VIEW_KEY.length < 12) { console.error('METYU_VIEW_KEY en az 12 karakter olmalı'); process.exit(1); }
const keyOk = (given) => {
  const a = crypto.createHash('sha256').update(String(given || '')).digest(), b = crypto.createHash('sha256').update(VIEW_KEY).digest();
  return crypto.timingSafeEqual(a, b);
};
function viewAllowed(req, res) {
  if (!VIEW_KEY) return true;
  const cookie = /(?:^|;\s*)mk=([^;]+)/.exec(req.headers.cookie || '');
  if (cookie && keyOk(decodeURIComponent(cookie[1]))) return true;
  if (badKeys >= 20) { res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '600' }); res.end('Çok fazla hatalı deneme; 10 dakika sonra yeniden dene.'); return false; }
  const u = new URL(req.url, 'http://x'), k = u.searchParams.get('k');
  if (k && !keyOk(k)) badKeys++;
  if (k && keyOk(k)) {
    u.searchParams.delete('k');
    res.writeHead(302, { 'Set-Cookie': 'mk=' + encodeURIComponent(k) + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000', Location: u.pathname + u.search });
    res.end(); return false;
  }
  res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Erişim anahtarı gerekli.'); return false;
}
// Sent with every answer: no caching, no framing, no outside resources, no scripts.
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
// Wrong keys: after 20 within 10 minutes every keyless request waits it out (slows guessing to a crawl).
let badKeys = 0; setInterval(() => { badKeys = 0; }, 600e3).unref();
if (CFG.port > 0 && !args['telegram-setup']) {
  http.createServer((req, res) => {
    try {
      for (const h of Object.keys(SEC)) res.setHeader(h, SEC[h]);
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
      if (!viewAllowed(req, res)) return;
      if (req.url.startsWith('/json')) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(snapshot(), null, 2)); return; }
      if (req.url.startsWith('/rapor-simdi')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(buildReport(Date.now() - 7 * 86400e3, Date.now())); return; }
      const m = req.url.match(/^\/raporlar\/(metyu-rapor-[\d-]+\.html)$/);
      if (m) { const f = path.join(CFG.reportsDir, m[1]); if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(f)); return; } }
      const s = snapshot(), p = s.portfolio;
      const reports = fs.existsSync(CFG.reportsDir) ? fs.readdirSync(CFG.reportsDir).filter((f) => /^metyu-rapor-.*\.html$/.test(f)).sort().reverse().slice(0, 8) : [];
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="' + (CFG.eco ? 60 : 10) + '"><title>metyu portföy</title>' +
        '<body style="font:14px/1.5 system-ui;margin:16px auto;max-width:760px;padding:0 12px;background:#0e1316;color:#e6edef"><style>td,th{padding:5px 4px;border-bottom:1px solid #26343a;text-align:right}td:first-child,th:first-child{text-align:left}th{color:#8a9aa1;font-weight:500}a{color:#5cc8ff}</style>' +
        '<h1 style="font-size:20px">metyu · portföy · sanal para</h1>' +
        '<p>Portföy: <b>' + esc(money(p.equity)) + '</b> · K/Z ' + esc((p.pnl >= 0 ? '+' : '') + money(p.pnl)) + ' · bugün ' + esc(pctS(p.today)) + ' · maks. düşüş ' + esc(pctS(p.maxDD)) + (p.halt ? ' · <b style="color:#ff6b6b">DURDU: ' + esc(p.halt) + '</b>' : '') + '</p>' +
        '<p>Ekonomi takvimi: ' + (s.calendar.active ? '<b style="color:#f2b84b">şu an yeni pozisyon yok — ' + esc(s.calendar.active) + '</b>' : s.calendar.next ? 'sıradaki ' + esc(s.calendar.next.title) + ' · ' + esc(ts(Date.parse(s.calendar.next.at))) : (s.calendar.loaded ? 'bu hafta kalan yüksek etkili veri yok' : 'yüklenemedi')) + ' · korku-açgözlülük: ' + (s.fng ?? '–') + ' · kaynak: ' + esc(s.feed || 'bağlanıyor') + '</p>' +
        '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><tr><th>Sembol</th><th>Fiyat</th><th>Alt hesap</th><th>Pozisyon</th><th>Model</th></tr>' +
        s.symbols.map((x) => '<tr><td>' + esc(short(x.symbol)) + '</td><td>' + (x.price ? esc(E.num(x.price, 2)) : '–') + '</td><td>' + esc(money(x.equity)) + '</td><td>' +
          (x.position ? esc(x.position.side + ' · stop ' + E.num(x.position.stop, 2)) : '–') + '</td><td style="text-align:left">' + esc(x.model || 'öğreniyor…') + (x.lastVeto ? '<br><small style="color:#f2b84b">' + esc(x.lastVeto) + '</small>' : '') + '</td></tr>').join('') +
        '</table></div><h2 style="font-size:13px;color:#8a9aa1">SON OLAYLAR</h2><pre style="white-space:pre-wrap;background:#151c20;padding:10px;border-radius:8px;font-size:12px">' + esc(s.recent.slice().reverse().join('\n')) + '</pre>' +
        '<p>Raporlar: <a href="/rapor-simdi">son 7 gün (şimdi)</a>' + reports.map((f) => ' · <a href="/raporlar/' + f + '">' + esc(f.replace('metyu-rapor-', '').replace('.html', '')) + '</a>').join('') + '</p>' +
        '<p style="color:#8a9aa1">Sayfa ' + (CFG.eco ? 60 : 10) + ' sn\'de bir yenilenir. Ham veri: <a href="/json">/json</a></p></body></html>');
    } catch (e) { res.writeHead(500); res.end('hata: ' + e.message); }
  }).on('error', (e) => out('Durum sayfası açılamadı (' + e.message + '); program çalışmaya devam ediyor'))
    .listen(CFG.port, CFG.host, () => out('Durum sayfası: http://' + (CFG.host === '0.0.0.0' ? 'BU-BILGISAYARIN-IP' : CFG.host) + ':' + CFG.port));
}

// ---------- Keep running no matter what ----------
process.on('uncaughtException', (e) => { P.counters.errors++; out('Beklenmeyen hata (çalışmaya devam): ' + (e && e.stack || e)); });
process.on('unhandledRejection', (e) => { P.counters.errors++; out('Beklenmeyen hata (çalışmaya devam): ' + (e && e.message || e)); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { out('Kapanıyor; durum kaydedildi'); save(); process.exit(0); });

if (!args['telegram-setup']) {
if (HOSTED && DATA === DIR) out('UYARI: METYU_DATA_DIR ayarlı değil; barındırma ortamında program yeniden başlarsa hesap durumu sıfırlanır. Kalıcı disk bağlayıp METYU_DATA_DIR ile göster.');
out('metyu runner başladı · ' + CFG.symbols.join(', ') + ' · ' + TF_OF_BAR[CFG.bar] + ' bar · ' + CFG.lev + 'x · işlem başına portföyün %' + E.num(CFG.riskPerTrade * 100, 0) + '\'i · sanal para' + (CFG.eco ? ' · tasarruf modu' : ''));
connect(0); CFG.symbols.forEach((s) => seed(C[s])); pollFunding(); pollFng(); pollCalendar(); pollDepth();
setInterval(pollDepth, CFG.eco ? 120000 : 30000);
setInterval(pollFunding, CFG.eco ? 300000 : 60000); setInterval(pollFng, 30 * 60000); setInterval(pollCalendar, 3 * 3600e3);
setTimeout(liveCheck, 3000); setInterval(liveCheck, 20000);
setInterval(reportCheck, 10 * 60000); setTimeout(reportCheck, 5000);
setInterval(save, CFG.eco ? 120000 : 30000);
if (TG) { setInterval(tgPoll, CFG.eco ? 15000 : 4000); tg('metyu başladı · ' + CFG.symbols.map(short).join(', ') + ' · ' + TF_OF_BAR[CFG.bar] + ' bar · ' + CFG.lev + 'x · sanal para', true); out('Telegram bildirimleri açık'); }
}

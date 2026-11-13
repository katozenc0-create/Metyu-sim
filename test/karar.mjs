// Decision test: offline and repeatable (no network, fixed random seeds). Fails with exit code 1 if a rule is broken.
// Run: node test/karar.mjs [--hizli]   (Node 22+; about 1–2 minutes, --hizli about 30 s)
//
//  1. Risk rules of the engine: loss at the stop, refused orders, daily and drawdown halts.
//  2. The learner on random prices with NO edge: how often it trusts a strategy anyway (false alarms), and how often
//     that false alarm reaches the "strong evidence" level, which sets the full bet size.
//  3. The learner on prices WITH a real trend edge: it must still find and trust it.
//  4. The runner refuses a damaged state file and continues from the last good one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--hizli');
const STRATS = ['sma', 'momentum', 'meanrev', 'macd', 'rsi', 'sr'];
const html = fs.readFileSync(path.join(ROOT, 'simulator.html'), 'utf8');
const E = new Function(html.split('// ENGINE-START')[1].split('// ENGINE-END')[0] + '\nconst STRATS = ' + JSON.stringify(STRATS) + ';\n' +
  html.split('// SHARED-START')[1].split('// SHARED-END')[0].replace(/^[^\n]*\n/, '') +
  '\nreturn { makeAccount, openPos, closePos, onTick, equity, walkForward, tStat, WF };')();

let failed = 0;
function check(name, ok, detail) { console.log((ok ? 'OK    ' : 'HATA  ') + name + (detail ? ' · ' + detail : '')); if (!ok) failed++; }
function throws(fn) { try { fn(); return false; } catch (e) { return true; } }
const pct = (x) => (x * 100).toFixed(2) + '%';

// ---------- 1. Risk rules ----------
console.log('\n# 1. Risk kuralları');
{
  const a = E.makeAccount();
  E.openPos(a, 'long', 100, 98, 3);
  E.onTick(a, 97.99, 98.01);
  const loss = (10000 - E.equity(a)) / 10000;
  check('Stopta kayıp, işlem başına riskin (%1) çevresinde', !a.pos && loss > 0.008 && loss < 0.013, 'kayıp ' + pct(loss));
}
{
  const a = E.makeAccount();
  check('Kaldıraç sınırının üstü reddedilir', throws(() => E.openPos(a, 'long', 100, 98, 6)));
  check('Stop likidasyonun ötesindeyse reddedilir', throws(() => E.openPos(a, 'long', 100, 60, 5)));
  check('Stop yanlış taraftaysa reddedilir', throws(() => E.openPos(a, 'short', 100, 99, 3)));
  E.openPos(a, 'short', 100, 102, 3);
  check('Açık pozisyon varken ikincisi reddedilir', throws(() => E.openPos(a, 'long', 100, 98, 3)));
}
{
  const a = E.makeAccount({ risk: 0.05 });
  E.openPos(a, 'long', 100, 99, 5); E.onTick(a, 98.9, 99);
  check('Günlük zarar limitinden sonra yeni işlem açılmaz', !!a.halt && throws(() => E.openPos(a, 'long', 100, 99, 3)), 'durum: ' + a.halt);
}
{
  const a = E.makeAccount({ risk: 0.05, dayLimit: 1 });
  let px = 100;
  for (let i = 0; i < 6 && !a.halt; i++) { E.openPos(a, 'long', px, px * 0.99, 5); px *= 0.989; E.onTick(a, px, px * 1.0001); }
  check('Zirveden %15 düşüşte hesap kilitlenir', a.halt === 'maksimum düşüş limiti' && throws(() => E.openPos(a, 'long', px, px * 0.99, 3)), 'düşüş ' + pct(a.maxDD));
}
check('t istatistiği doğru hesaplanıyor', Math.abs(E.tStat([1, 2, 3]) - 3.4641) < 1e-3 && E.tStat([5]) === 0 && E.tStat([2, 2, 2]) === 0);

// ---------- Synthetic prices ----------
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// 4-hour candles. trend = 0: a random walk with volatility clusters (nothing to learn). trend > 0: a slow hidden
// trend is added to the returns (something real to learn). Funding and the sentiment index are random too.
function series(seed, n, trend) {
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
  const out = [], fund = [], fng = []; let p = 100, v = 0.012, f = 0.0001, fg = 50, tr = 0, t = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    v = Math.max(0.004, Math.min(0.04, v * Math.exp(0.15 * g()) * 0.98 + 0.012 * 0.02));
    tr = 0.97 * tr + 0.0012 * g();
    const o = p; let h = o, l = o;
    for (let j = 0; j < 8; j++) { p *= Math.exp(trend * tr / 8 + v / Math.sqrt(8) * g()); h = Math.max(h, p); l = Math.min(l, p); }
    out.push({ t, o, h, l, c: p }); t += 14400e3;
    f = f * 0.97 + 0.0001 * 0.03 + 0.00006 * g(); fund.push(f);
    fg = Math.max(5, Math.min(95, fg + 3 * g())); fng.push(fg);
  }
  return { out, fund, fng };
}
const learn = (d) => E.walkForward(d.out, 3, 14400e3, null, { fund: d.fund, fng: d.fng, depthUsd: 6e6 });

// ---------- 2. No edge ----------
console.log('\n# 2. Öğrenilecek bir şey olmayan (rastgele) fiyatlar');
{
  const n = QUICK ? 4 : 12; let any = 0, strong = 0; const ts = [];
  for (let s = 1; s <= n; s++) {
    const wf = await learn(series(s, 5000, 0));
    if (wf.chosen) { any++; ts.push(wf.chosen.t.toFixed(1)); if (wf.chosen.strong) strong++; }
  }
  console.log('      ' + n + ' rastgele seride "güvenilir" bulunan: ' + any + ' (t: ' + (ts.join(', ') || '–') + ') · "güçlü kanıt" sayılan: ' + strong);
  check('Rastgele veride güçlü kanıt yanlış alarmı nadir (en çok 1)', strong <= 1, strong + '/' + n);
}

// ---------- 3. A real edge ----------
console.log('\n# 3. Gerçek bir eğilim içeren fiyatlar');
{
  const n = QUICK ? 2 : 4; let found = 0, strong = 0;
  for (let s = 1; s <= n; s++) {
    const wf = await learn(series(1000 + s, 5000, 1.5));
    if (wf.chosen) found++; if (wf.chosen && wf.chosen.strong) strong++;
  }
  check('Gerçek eğilim bulunuyor ve güveniliyor', found === n, found + '/' + n);
  check('Gerçek eğilim en az yarısında güçlü kanıt düzeyine çıkıyor', strong >= Math.ceil(n / 2), strong + '/' + n);
}

// ---------- 4. Runner and a damaged state file ----------
console.log('\n# 4. Bozuk kayıt dosyası');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metyu-test-'));
  for (const f of ['metyu-runner.mjs', 'simulator.html']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  const acct = () => Object.assign(E.makeAccount({ balance: 10000 / 3 }), { book: null });
  const good = { version: 2, savedAt: Date.now(), barSec: 14400, P: { start: 10000, peak: 10432.1, maxDD: 0.01, day: null, dayStart: 10000, halt: null, eqHist: [], lastReport: 0, counters: {} },
    ctx: { BTCUSDT: { acct: acct() }, ETHUSDT: { acct: acct() }, SOLUSDT: { acct: acct() } }, cal: { events: [], fetchedAt: 0, ok: false } };
  const run = (ms) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['metyu-runner.mjs', '--port', '0'], { cwd: dir, env: Object.assign({}, process.env, { PORT: '', METYU_DATA_DIR: '' }) });
    let text = ''; p.stdout.on('data', (b) => { text += b; }); p.stderr.on('data', (b) => { text += b; });
    setTimeout(() => p.kill('SIGTERM'), ms); p.on('exit', () => resolve(text));
  });
  // a) Tampered numbers in the main file, a good previous copy next to it.
  const bad = JSON.parse(JSON.stringify(good)); bad.ctx.BTCUSDT.acct.cash = -5;
  fs.writeFileSync(path.join(dir, 'metyu-state.json'), JSON.stringify(bad));
  fs.writeFileSync(path.join(dir, 'metyu-state.onceki.json'), JSON.stringify(good));
  let log = await run(2500);
  check('Sayıları bozuk kayıt reddedilir, önceki sağlam kayıttan devam edilir', /önceki sağlam kayıttan devam/.test(log) && fs.readdirSync(dir).some((f) => f.includes('.bozuk-')), (log.split('\n')[0] || '').slice(0, 110));
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'metyu-state.json'), 'utf8'));
  check('Kapanırken sağlam durum kaydedilir (zirve korunmuş)', after.P.peak === 10432.1 && after.ctx.BTCUSDT.acct.cash > 0);
  // b) Unreadable file and no usable copy: a fresh paper portfolio, the broken file kept aside.
  fs.writeFileSync(path.join(dir, 'metyu-state.json'), '{"version":2,"P":');
  fs.writeFileSync(path.join(dir, 'metyu-state.onceki.json'), 'x');
  log = await run(2500);
  check('Kayıt ve yedeği okunamazsa yeni sanal portföy açılır', /yeni sanal portföyle başlanıyor/.test(log) && /Yeni sanal portföy/.test(log));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n' + (failed ? failed + ' kontrol BAŞARISIZ' : 'Tüm kontroller geçti'));
process.exit(failed ? 1 : 0);

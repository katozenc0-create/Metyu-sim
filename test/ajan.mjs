// Agent test: runs the real runner against the fake exchange (test/sahte-borsa.mjs) on 1-minute bars, offline.
// Run: node test/ajan.mjs   (Node 22+; 1–3 minutes). Exit code 1 if a check fails.
//
// Checks the parts of the decision loop that the unit test cannot reach:
//  - saved bars are reloaded and verified before any decision;
//  - a weak-evidence model bets a quarter of what a strong one bets;
//  - a strategy in quarantine is not adopted again by the learner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(HERE, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metyu-ajan-'));
for (const f of ['metyu-runner.mjs', 'simulator.html']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
let failed = 0;
function check(name, ok, detail) { console.log((ok ? 'OK    ' : 'HATA  ') + name + (detail ? ' · ' + detail : '')); if (!ok) failed++; }

const now = Date.now(), sub = 10000 / 3;
const acct = () => ({ start: sub, cash: sub, risk: 0.03, maxLev: 5, fee: 0.0005, slip: 0.0002, mmr: 0.005, fund: 0.0001, dayLimit: 1, ddLimit: 1, pos: null, last: null, halt: null,
  history: [], eqHist: [], dayStart: sub, day: null, events: [], peak: sub, maxDD: 0, trades: 0, closed: [] });
const model = (strong, t) => ({ tf: '1m', lev: 3, venue: 'test', learnedAt: now, appliedAt: now, peakEq: sub, span: null, results: [], data: {}, history: [],
  chosen: { name: 'momentum', prm: { L: 20, mult: 2 }, filters: null, pm: null, strong, t } });
// BTC: weak model. SOL: strong model. ETH: no model yet, with mean reversion (what the fake market rewards) in quarantine.
// The saved bars are deliberately a short, stale stub: the runner must replace them from the exchange.
fs.writeFileSync(path.join(dir, 'metyu-state.json'), JSON.stringify({ version: 2, savedAt: now, barSec: 60,
  P: { start: 10000, peak: 10000, maxDD: 0, day: null, dayStart: 10000, halt: null, eqHist: [], lastReport: now, counters: {} },
  ctx: {
    BTCUSDT: { acct: acct(), model: model(false, 1.5), closes: [1, 2, 3], bars: [], barIdx: 1, lastLearnTry: now },
    SOLUSDT: { acct: acct(), model: model(true, 3.5), closes: [1, 2, 3], bars: [], barIdx: 1, lastLearnTry: now },
    ETHUSDT: { acct: acct(), model: null, closes: [], bars: [], barIdx: null, lastLearnTry: 0, ban: { name: 'meanrev', until: now + 7 * 86400e3 } },
  }, cal: { events: [], fetchedAt: 0, ok: false } }));

const p = spawn(process.execPath, ['--import', pathToFileURL(path.join(HERE, 'sahte-borsa.mjs')).href, 'metyu-runner.mjs', '--bar', '60', '--port', '0', '--max-same-side', '3'],
  { cwd: dir, env: Object.assign({}, process.env, { PORT: '', METYU_DATA_DIR: '', METYU_TG_TOKEN: '', METYU_TASARRUF: '' }) });
let log = ''; p.stdout.on('data', (b) => { log += b; }); p.stderr.on('data', (b) => { log += b; });
const has = (re) => re.test(log);
const done = () => has(/\[BTC\] (AL|SAT) açıldı/) && has(/\[SOL\] (AL|SAT) açıldı/) && has(/\[ETH\] Model: /);
const t0 = Date.now();
while (!done() && Date.now() - t0 < 200e3 && p.exitCode == null) await new Promise((r) => setTimeout(r, 1000));
await new Promise((r) => setTimeout(r, 1500));
p.kill('SIGTERM'); await new Promise((r) => p.on('exit', r));

const st = JSON.parse(fs.readFileSync(path.join(dir, 'metyu-state.json'), 'utf8'));
const riskOf = (sym) => { const x = st.ctx[sym].acct.pos || (st.ctx[sym].acct.history || []).slice(-1)[0]; return x ? (x.qty0 || x.qty) * Math.abs(x.entry - (x.stop0 || x.stop)) / 10000 : null; };
const rb = riskOf('BTCUSDT'), rs = riskOf('SOLUSDT'), pc = (x) => x == null ? 'işlem yok' : '%' + (x * 100).toFixed(2);
check('Kayıtlı eksik barlar borsadan yeniden yüklendi', ['BTCUSDT', 'SOLUSDT', 'ETHUSDT'].every((s) => st.ctx[s].closes.length >= 300), 'bar: ' + ['BTCUSDT', 'SOLUSDT', 'ETHUSDT'].map((s) => st.ctx[s].closes.length).join('/'));
check('Barlar doğrulanmadan işlem açılmadı', log.indexOf('Geçmişten') >= 0 && log.indexOf('Geçmişten') < log.search(/(AL|SAT) açıldı/));
check('Güçlü kanıtlı model tam riskle işlem açtı (portföyün ~%1\'i)', rs != null && rs > 0.007 && rs < 0.0105, pc(rs));
check('Zayıf kanıtlı model çeyrek riskle işlem açtı (~%0,25)', rb != null && rb > 0.0017 && rb < 0.0027, pc(rb));
const eth = st.ctx.ETHUSDT.model;
check('Karantinadaki strateji yeniden seçilmedi', has(/karantinada/) && eth && (!eth.chosen || eth.chosen.name !== 'meanrev') && eth.results.some((r) => r.name === 'meanrev' && r.ok),
  'seçilen: ' + (eth && eth.chosen ? eth.chosen.name : 'yok'));
check('Beklenmeyen hata yok', !has(/Beklenmeyen hata|Ajan hatası|Portföy kontrol hatası/));
if (failed) console.log('\n--- kayıt ---\n' + log.split('\n').filter((l) => !/\]   /.test(l)).slice(-40).join('\n') + '\n--- olaylar ---\n' + JSON.stringify(['BTCUSDT', 'SOLUSDT'].map((s) => st.ctx[s].acct.events.slice(-5))));
fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + (failed ? failed + ' kontrol BAŞARISIZ' : 'Tüm kontroller geçti') + ' (' + Math.round((Date.now() - t0) / 1000) + ' sn)');
process.exit(failed ? 1 : 0);

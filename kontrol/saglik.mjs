// Health check for the continuous paper run. Reads the last saved status (durum.json on the "veri" branch), applies
// the rules below and keeps ONE GitHub issue in step with the result: opened when something is wrong, updated when the
// set of problems changes, closed when everything is fine again. GitHub notifies the repository owner of each step.
// Run by the "kontrol" job every 30 minutes. Offline: node kontrol/saglik.mjs --dosya durum.json  (prints only).
import fs from 'node:fs';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const repo = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN, file = arg('--dosya');
const TITLE = 'metyu sağlık uyarısı';
const api = (path, opt) => fetch('https://api.github.com' + path, Object.assign({ headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(20000) }, opt || {}));

export function check(d, now) {
  const p = [], add = (kod, mesaj) => p.push({ kod, mesaj });
  if (!d || !d.portfolio || !Array.isArray(d.symbols)) { add('K0', 'Durum dosyası okunamadı ya da biçimi bozuk.'); return p; }
  const age = (now - Date.parse(d.savedAt)) / 60000;
  if (!(age < 75)) add('K1', 'Son kayıt ' + (isFinite(age) ? Math.round(age) + ' dakika önce' : 'tarihsiz') + ': program çalışmıyor olabilir (stoplar izlenmiyor).');
  const c = d.counters || {}, pf = d.portfolio;
  if ((c.errors || 0) >= 5) add('K2', 'Hata sayacı ' + c.errors + ': kayıtta "Beklenmeyen hata" satırlarına bak.');
  if (pf.halt) add('K3', 'Portföy durdurulmuş: ' + (pf.halt === 'günlük' ? 'günlük zarar limiti (gece yarısı açılır)' : 'düşüş kilidi (%15); elle sıfırlama gerekir') + '.');
  else if (pf.maxDD >= 0.10) add('K4', 'En büyük düşüş %' + (pf.maxDD * 100).toFixed(1) + ': %15 kilidine yaklaşıyor.');
  if (!(pf.equity > 0) || !isFinite(pf.equity)) add('K5', 'Özkaynak değeri geçersiz: ' + pf.equity + '.');
  const unverified = d.symbols.filter((s) => s.barsVerified === false).map((s) => s.symbol);
  if (unverified.length && age < 75) add('K6', 'Barları doğrulanamayan sembol: ' + unverified.join(', ') + ' (o sembolde karar verilmiyor).');
  const quiet = d.symbols.filter((s) => s.dataAgeSec == null || s.dataAgeSec > 120).map((s) => s.symbol);
  if (quiet.length && age < 75) add('K7', 'Fiyat gelmeyen sembol: ' + quiet.join(', ') + '.');
  const cal = d.calendar || {};
  if (!cal.loaded || (cal.ageMin != null && cal.ageMin > 720)) add('K8', 'Ekonomi takvimi ' + (cal.loaded ? Math.round(cal.ageMin / 60) + ' saattir alınamıyor' : 'hiç yüklenemedi') + ': takvim koruması güncel değil.');
  if ((c.skippedBars || 0) >= 30) add('K9', 'Atlanan bar sayısı ' + c.skippedBars + ': çalışmalar arasındaki boşluklar uzun.');
  return p;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  let d = null;
  try {
    if (file) d = JSON.parse(fs.readFileSync(file, 'utf8'));
    else { const r = await api('/repos/' + repo + '/contents/durum.json?ref=veri', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw+json' } }); if (r.ok) d = await r.json(); }
  } catch (e) { /* reported as K0 */ }
  const probs = check(d, Date.now()), sig = probs.map((x) => x.kod).sort().join(',');
  const text = probs.length ? probs.map((x) => '- **' + x.kod + '** ' + x.mesaj).join('\n') : 'Sorun yok.';
  const head = d && d.portfolio ? 'Özkaynak ' + Math.round(d.portfolio.equity) + ' · son kayıt ' + d.savedAt + '\n\n' : '';
  console.log(head + text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Sağlık kontrolü\n' + head + text + '\n');
  if (file || !token || !repo) process.exit(0);
  const open = (await (await api('/repos/' + repo + '/issues?state=open&per_page=50')).json()).filter((i) => i.title === TITLE && !i.pull_request)[0];
  const body = 'Otomatik sağlık kontrolü (30 dakikada bir) şu sorunları buldu:\n\n' + text + '\n\n' + head + 'Durum sayfası: https://' + repo.split('/')[0].toLowerCase() + '.github.io/' + repo.split('/')[1] + '/durum/\n\nSorunlar giderilince bu kayıt kendiliğinden kapanır.\n<!-- imza:' + sig + ' -->';
  const post = (path, method, o) => api(path, { method, body: JSON.stringify(o) });
  if (probs.length && !open) await post('/repos/' + repo + '/issues', 'POST', { title: TITLE, body });
  else if (probs.length && !open.body.includes('<!-- imza:' + sig + ' -->')) {
    await post('/repos/' + repo + '/issues/' + open.number, 'PATCH', { body });
    await post('/repos/' + repo + '/issues/' + open.number + '/comments', 'POST', { body: 'Durum değişti:\n\n' + text });
  } else if (!probs.length && open) {
    await post('/repos/' + repo + '/issues/' + open.number + '/comments', 'POST', { body: 'Tüm kontroller yeniden geçiyor. ' + head.trim() });
    await post('/repos/' + repo + '/issues/' + open.number, 'PATCH', { state: 'closed' });
  }
}

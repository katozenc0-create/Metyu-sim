// Fake exchange for offline tests (loaded with node --import): prices are a fixed function of time, so candles and
// quotes agree. No WebSocket; Binance-style HTTP endpoints only; everything else answers 503.
// The price pattern is anchored to the moment the process starts, so every run sees the same market.
const T0 = Date.now(), ANCHOR = Date.UTC(2026, 0, 5, 12, 0, 0);
const px = (w, k, t = w - T0 + ANCHOR) => (k === 'B' ? 60000 : k === 'E' ? 3000 : 80) * Math.exp(0.04 * Math.sin(t / 1.1e6 + (k === 'E' ? 1 : 0)) + 0.012 * Math.sin(t / 97e3) + 0.008 * Math.sin(t / 13e3));
const json = (o, status = 200) => Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(o), text: () => Promise.resolve(JSON.stringify(o)) });
globalThis.WebSocket = undefined;
globalThis.fetch = (url, opt) => {
  const u = new URL(url), q = u.searchParams, now = Date.now();
  if (u.pathname.endsWith('/klines')) {
    const k = q.get('symbol')[0], ms = { '1m': 60e3, '4h': 14400e3 }[q.get('interval')], lim = +q.get('limit');
    const end = q.get('endTime') ? +q.get('endTime') : now, last = Math.floor(end / ms) * ms, rows = [];
    for (let t = last - (lim - 1) * ms; t <= last; t += ms) {
      const pts = [0, 0.25, 0.5, 0.75, 0.999].map((f) => px(Math.min(t + f * ms, now), k));
      rows.push([t, String(pts[0]), String(Math.max(...pts)), String(Math.min(...pts)), String(pts[4])]);
    }
    return json(rows);
  }
  if (u.pathname.endsWith('/ticker/bookTicker')) return json(JSON.parse(q.get('symbols')).map((s) => ({ symbol: s, bidPrice: String(px(now, s[0]) * 0.99995), askPrice: String(px(now, s[0]) * 1.00005) })));
  if (u.pathname.endsWith('/depth')) { const p = px(now, q.get('symbol')[0]); return json({ bids: [[p * 0.9999, 50], [p * 0.995, 500]], asks: [[p * 1.0001, 50], [p * 1.005, 500]] }); }
  if (u.pathname.endsWith('/premiumIndex')) return json(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((s) => ({ symbol: s, lastFundingRate: '0.0001' })));
  return json({}, 503);
};

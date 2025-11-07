import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, 'assets');

let fredCache = null;

async function fetchFredLatest() {
  const key = process.env.FRED_API_KEY;
  const seriesId = process.env.FRED_SERIES_ID || 'MORTGAGE30US';
  if (!key) return null;
  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', key);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('sort_order', 'desc');
  url.searchParams.set('limit', '14');
  try {
    const resp = await fetch(url.toString());
    if (!resp.ok) return null;
    const data = await resp.json();
    const obs = Array.isArray(data && data.observations) ? data.observations : [];
    const firstValid = obs.find(o => o && o.value && o.value !== '.');
    if (!firstValid) return null;
    const raw = parseFloat(firstValid.value);
    if (!Number.isFinite(raw)) return null;
    const adjusted = raw + 0.5;
    const rounded = Math.round(adjusted * 10) / 10;
    return { ratePercent: rounded, rawPercent: raw, adjustedAdded: 0.5, observationDate: firstValid.date, source: seriesId };
  } catch {
    return null;
  }
}

async function handleRate(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method !== 'GET') { res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed' })); return; }
  const now = Date.now();
  const TTL = 60 * 60 * 1000;
  if (fredCache && now - fredCache.ts < TTL) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.writeHead(200).end(JSON.stringify(fredCache.payload));
    return;
  }
  const data = await fetchFredLatest();
  const payload = data || { ratePercent: 5.5, rawPercent: null, adjustedAdded: 0.5, observationDate: null, source: 'fallback' };
  fredCache = { ts: now, payload };
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.writeHead(200).end(JSON.stringify(payload));
}

async function parseJsonBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

async function subscribeToButtondown(email, tag, name, deadline) {
  const key = process.env.BUTTONDOWN_API_KEY;
  if (!key) throw new Error('BUTTONDOWN_API_KEY not set');
  const resp = await fetch('https://api.buttondown.email/v1/subscribers', {
    method: 'POST',
    headers: { 'Authorization': `Token ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email_address: email, tags: [tag], metadata: { settlementName: name, subscribedAt: new Date().toISOString(), ...(deadline ? { deadline } : {}) } })
  });
  if (!resp.ok) {
    const text = await resp.text();
    let msg = 'Failed to subscribe';
    try { const e = JSON.parse(text); msg = e.detail || e.code || text; } catch { msg = text; }
    throw new Error(msg);
  }
  return await resp.json();
}

async function updateButtondownSubscriber(email, tag, name, deadline) {
  const key = process.env.BUTTONDOWN_API_KEY;
  if (!key) throw new Error('BUTTONDOWN_API_KEY not set');
  const search = await fetch(`https://api.buttondown.email/v1/subscribers?email=${encodeURIComponent(email)}`, { headers: { 'Authorization': `Token ${key}`, 'Content-Type': 'application/json' } });
  if (!search.ok) throw new Error('Failed to find subscriber');
  const data = await search.json();
  if (!data.results || !data.results.length) throw new Error('Subscriber not found');
  const sub = data.results[0];
  const updatedTags = (sub.tags || []).includes(tag) ? sub.tags : [...(sub.tags || []), tag];
  const meta = sub.metadata || {};
  const settlementKey = `settlement_${tag}`;
  meta[settlementKey] = JSON.stringify({ name, deadline, subscribedAt: new Date().toISOString() });
  const upd = await fetch(`https://api.buttondown.email/v1/subscribers/${sub.id}`, { method: 'PATCH', headers: { 'Authorization': `Token ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: updatedTags, metadata: meta }) });
  if (!upd.ok) throw new Error(await upd.text());
  return await upd.json();
}

async function handleSubscribe(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed' })); return; }
  try {
    const { email, settlementId, settlementName, deadline } = await parseJsonBody(req);
    if (!email || !email.includes('@')) { res.writeHead(400).end(JSON.stringify({ error: 'Invalid email address' })); return; }
    if (!settlementId || !settlementName) { res.writeHead(400).end(JSON.stringify({ error: 'Missing required fields' })); return; }
    try {
      await subscribeToButtondown(email, settlementId, settlementName, deadline || null);
      res.writeHead(200).end(JSON.stringify({ success: true, message: "Successfully subscribed! You'll receive a reminder before the deadline." }));
    } catch (e) {
      if ((e.message || '').includes('already subscribed')) {
        await updateButtondownSubscriber(email, settlementId, settlementName, deadline || null);
        res.writeHead(200).end(JSON.stringify({ success: true, message: 'Settlement added to your subscriptions!' }));
      } else {
        throw e;
      }
    }
  } catch (e) {
    res.writeHead(500).end(JSON.stringify({ error: e.message || 'Failed to subscribe. Please try again.' }));
  }
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET') return false;
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const p = path.join(ASSETS_DIR, 'mortgage-calculator.html');
    if (fs.existsSync(p)) { res.writeHead(200, { 'Content-Type': 'text/html' }); fs.createReadStream(p).pipe(res); return true; }
  }
  if (url.pathname.startsWith('/assets/')) {
    const assetPath = path.join(__dirname, url.pathname.slice(1));
    if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
      const ext = path.extname(assetPath).toLowerCase();
      const type = ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : ext === '.html' ? 'text/html' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(assetPath).pipe(res);
      return true;
    }
  }
  return false;
}

const server = createServer(async (req, res) => {
  if (!req.url) { res.writeHead(400).end('Missing URL'); return; }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/rate') { await handleRate(req, res); return; }
  if (url.pathname === '/api/subscribe') { await handleSubscribe(req, res); return; }
  if (serveStatic(req, res, url)) return;
  res.writeHead(404).end('Not Found');
});

const port = Number(process.env.PORT || 8001);
server.listen(port, () => {
  console.log(`Mortgage server listening on http://localhost:${port}`);
});

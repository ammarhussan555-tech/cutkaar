import { init, count, getSettings } from '../_count.js';
// The app calls this when it starts and every few hours.
// It says whether Cutkaar is free right now, or, when paid mode is on, whether this computer has a working license.
// Each computer is a random ID made by the app; no name, IP address or personal detail is stored.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const out = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
const now = () => new Date().toISOString();

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return out({ error: 'POST only' }, 405);
  if (!env.DB) return out({ mode: 'free', ok: true });                 // database not connected: everything stays free
  let b; try { b = await request.json(); } catch { return out({ error: 'bad request' }, 400); }
  const id = String(b.device || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  if (id.length < 16) return out({ error: 'bad device' }, 400);
  const action = ['check', 'activate', 'release'].includes(b.action) ? b.action : 'check';
  const db = env.DB; await init(db);
  const cf = request.cf || {};
  const t = now();
  await db.prepare(`INSERT INTO devices (id, first_seen, last_seen, country, city, version, opens) VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT (id) DO UPDATE SET last_seen = ?2, country = ?3, city = ?4, version = ?5, opens = opens + ?6`)
    .bind(id, t, (cf.country || '??').slice(0, 2), String(cf.city || '').slice(0, 80) || null, String(b.version || '').slice(0, 20), action === 'check' && b.start ? 1 : 0).run();
  if (action === 'check' && b.start) context.waitUntil(count(env, request, 'open'));

  const S = await getSettings(db);
  const dev = await db.prepare('SELECT * FROM devices WHERE id = ?1').bind(id).first();
  const info = { message: S.message || '', contact: S.contact || '', offlineDays: Math.min(Math.max(parseInt(S.offline_days, 10) || 3, 1), 60) };

  if (action === 'release') {
    await db.prepare('UPDATE devices SET lic = NULL WHERE id = ?1').bind(id).run();
    dev.lic = null;
  }
  if (action === 'activate') {
    const key = String(b.key || '').trim().toUpperCase().replace(/\s+/g, '');
    const L = key && await db.prepare('SELECT * FROM licenses WHERE key = ?1').bind(key).first();
    if (!L) return out({ mode: S.paid === '1' ? 'paid' : 'free', ok: S.paid !== '1', reason: 'invalid', ...info });
    if (L.revoked) return out({ mode: S.paid === '1' ? 'paid' : 'free', ok: S.paid !== '1', reason: 'revoked', ...info });
    if (dev.lic !== key) {
      const used = (await db.prepare('SELECT COUNT(*) AS n FROM devices WHERE lic = ?1 AND id != ?2').bind(key, id).first()).n;
      if (used >= L.max_devices) return out({ mode: S.paid === '1' ? 'paid' : 'free', ok: S.paid !== '1', reason: 'limit', max: L.max_devices, ...info });
      await db.prepare('UPDATE devices SET lic = ?1, kicked = 0 WHERE id = ?2').bind(key, id).run();
      dev.lic = key; dev.kicked = 0;
    }
  }

  // which license (if any) this computer holds, and whether it still works
  let lic = null;
  if (dev.lic) {
    const L = await db.prepare('SELECT * FROM licenses WHERE key = ?1').bind(dev.lic).first();
    const used = L ? (await db.prepare('SELECT COUNT(*) AS n FROM devices WHERE lic = ?1').bind(dev.lic).first()).n : 0;
    lic = L ? { key: L.key.slice(0, 4) + '-••••-' + L.key.slice(-4), revoked: !!L.revoked, used, max: L.max_devices } : { gone: true };
  }
  if (S.paid !== '1') return out({ mode: 'free', ok: true, lic, ...info });
  if (lic && !lic.revoked && !lic.gone) return out({ mode: 'paid', ok: true, reason: 'licensed', lic, ...info });
  if (!dev.kicked && S.grandfather === '1' && S.paid_since && dev.first_seen < S.paid_since) return out({ mode: 'paid', ok: true, reason: 'early', lic, ...info });
  return out({ mode: 'paid', ok: false, reason: lic ? (lic.revoked ? 'revoked' : 'removed') : (dev.kicked ? 'removed' : 'nokey'), lic, ...info });
}

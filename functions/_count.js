// Shared counter: adds one to today's row for (kind, country, city). No IP address is stored.
let ready = false;
async function init(db) {
  if (ready) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS hits (
    day TEXT NOT NULL, kind TEXT NOT NULL, country TEXT NOT NULL, city TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind, country, city))`).run();
  ready = true;
}
export function pkDay(d = new Date()) {           // day in Pakistan time (UTC+5)
  return new Date(d.getTime() + 5 * 3600e3).toISOString().slice(0, 10);
}
const BOT = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|headless|lighthouse/i;
export function shouldCount(request) {
  if (request.method !== 'GET') return false;
  if (BOT.test(request.headers.get('user-agent') || '')) return false;
  const range = request.headers.get('range');       // download managers resume in pieces: count the first piece only
  if (range && !/^bytes=0-/.test(range)) return false;
  return true;
}
export async function count(env, request, kind) {
  const db = env.DB;
  if (!db) return;                                    // database not connected yet: serve the file anyway
  try {
    await init(db);
    const cf = request.cf || {};
    const country = (cf.country || '??').slice(0, 2);
    const city = String(cf.city || '').slice(0, 80) || '(unknown)';
    await db.prepare(`INSERT INTO hits (day, kind, country, city, n) VALUES (?1, ?2, ?3, ?4, 1)
      ON CONFLICT (day, kind, country, city) DO UPDATE SET n = n + 1`)
      .bind(pkDay(), kind, country, city).run();
  } catch (e) { console.log('count failed', e && e.message); }
}
export { init };

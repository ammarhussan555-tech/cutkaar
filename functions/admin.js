import { init, getSettings, setSetting } from './_count.js';
import { guard, esc, BASE_CSS } from './_auth.js';
// Owner control panel: switch Cutkaar between free and paid, make license keys, and sign computers out.

const html = (body, status = 200, extra = {}) => new Response(page(body), {
  status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...extra } });
const back = (q = '') => new Response(null, { status: 303, headers: { Location: '/admin' + q } });
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';           // no 0/O or 1/I, so keys are easy to read out
function newKey() {
  const r = crypto.getRandomValues(new Uint8Array(12));
  const s = [...r].map(x => ALPHA[x % ALPHA.length]).join('');
  return `CK-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
const when = iso => iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '';
const ago = iso => { if (!iso) return ''; const m = (Date.now() - Date.parse(iso)) / 6e4;
  return m < 2 ? 'just now' : m < 60 ? Math.round(m) + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'; };

export async function onRequest({ request, env }) {
  const g = await guard(request, env, html, '/admin'); if (g) return g;
  const db = env.DB; await init(db);
  const url = new URL(request.url);

  if (request.method === 'POST') {
    const f = await request.formData(); const a = f.get('a');
    if (a === 'mode') {
      const on = f.get('paid') === '1';
      await setSetting(db, 'paid', on ? '1' : '0');
      const S = await getSettings(db);
      if (on && !S.paid_since) await setSetting(db, 'paid_since', new Date().toISOString());
      return back('?ok=' + (on ? 'paid' : 'free'));
    }
    if (a === 'settings') {
      await setSetting(db, 'grandfather', f.get('grandfather') ? '1' : '0');
      await setSetting(db, 'message', String(f.get('message') || '').slice(0, 600));
      await setSetting(db, 'contact', String(f.get('contact') || '').slice(0, 200));
      return back('?ok=saved');
    }
    if (a === 'newkey') {
      const max = Math.min(Math.max(parseInt(f.get('max'), 10) || 1, 1), 100);
      const key = newKey();
      await db.prepare('INSERT INTO licenses (key, note, max_devices, created) VALUES (?1, ?2, ?3, ?4)')
        .bind(key, String(f.get('note') || '').slice(0, 120), max, new Date().toISOString()).run();
      return back('?new=' + key);
    }
    const key = String(f.get('key') || ''), id = String(f.get('id') || '');
    if (a === 'revoke') await db.prepare('UPDATE licenses SET revoked = 1 WHERE key = ?1').bind(key).run();
    if (a === 'unrevoke') await db.prepare('UPDATE licenses SET revoked = 0 WHERE key = ?1').bind(key).run();
    if (a === 'setmax') await db.prepare('UPDATE licenses SET max_devices = ?2 WHERE key = ?1').bind(key, Math.min(Math.max(parseInt(f.get('max'), 10) || 1, 1), 100)).run();
    if (a === 'kick') await db.prepare('UPDATE devices SET lic = NULL, kicked = 1 WHERE id = ?1').bind(id).run();
    if (a === 'allow') await db.prepare('UPDATE devices SET kicked = 0 WHERE id = ?1').bind(id).run();
    return back(f.get('ret') ? '?key=' + encodeURIComponent(f.get('ret')) : '');
  }

  const S = await getSettings(db);
  const paid = S.paid === '1';
  const filterKey = url.searchParams.get('key') || '';
  const q = (sql, ...a) => db.prepare(sql).bind(...a).all().then(r => r.results || []);
  const month = new Date(Date.now() - 30 * 864e5).toISOString();
  const [counts, keys, devices] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS all_, SUM(CASE WHEN last_seen >= ?1 THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN lic IS NOT NULL THEN 1 ELSE 0 END) AS licensed FROM devices`).bind(month).first(),
    q(`SELECT l.*, (SELECT COUNT(*) FROM devices d WHERE d.lic = l.key) AS used FROM licenses l ORDER BY created DESC LIMIT 500`),
    filterKey
      ? q(`SELECT * FROM devices WHERE lic = ?1 ORDER BY last_seen DESC`, filterKey)
      : q(`SELECT * FROM devices ORDER BY last_seen DESC LIMIT 200`),
  ]);

  const ok = url.searchParams.get('ok'), made = url.searchParams.get('new');
  const flash = made ? `<div class="flash">New key made: <b class="key">${esc(made)}</b> <button type="button" class="ghost sm" data-copy="${esc(made)}">Copy</button><br><span>Send this key to the buyer. They enter it in Cutkaar → Menu → License.</span></div>`
    : ok === 'paid' ? `<div class="flash">Cutkaar is now <b>PAID</b>. Computers check within a few hours, or right away when Cutkaar opens.</div>`
    : ok === 'free' ? `<div class="flash">Cutkaar is now <b>FREE</b> for everyone.</div>`
    : ok === 'saved' ? `<div class="flash">Saved.</div>` : '';

  const statusCls = (d) => d.kicked ? '<span class="pill bad">Signed out</span>' : d.lic ? '<span class="pill good">Licensed</span>' :
    (paid && S.grandfather === '1' && S.paid_since && d.first_seen < S.paid_since) ? '<span class="pill">Free (early user)</span>' : paid ? '<span class="pill bad">No license</span>' : '<span class="pill">Free</span>';

  const keyRows = keys.map(k => `<tr${k.key === filterKey ? ' class="sel"' : ''}><td class="key">${esc(k.key)} <button type="button" class="ghost sm" data-copy="${esc(k.key)}">Copy</button></td>
    <td>${esc(k.note) || '<span class="muted">—</span>'}</td>
    <td class="n"><a href="?key=${encodeURIComponent(k.key)}">${k.used} of ${k.max_devices}</a></td>
    <td>${k.revoked ? '<span class="pill bad">Off</span>' : '<span class="pill good">On</span>'}</td>
    <td>${when(k.created).slice(0, 10)}</td>
    <td class="act">
      <form method="post"><input type="hidden" name="key" value="${esc(k.key)}"><input type="hidden" name="a" value="setmax">
        <input name="max" type="number" min="1" max="100" value="${k.max_devices}" aria-label="Computers allowed" class="num"><button class="ghost sm">Set</button></form>
      <form method="post" ${k.revoked ? '' : 'data-confirm="Turn off this key? Every computer using it will be locked."'}><input type="hidden" name="key" value="${esc(k.key)}">
        <input type="hidden" name="a" value="${k.revoked ? 'unrevoke' : 'revoke'}"><button class="${k.revoked ? 'ghost' : 'danger'} sm">${k.revoked ? 'Turn on' : 'Turn off'}</button></form></td></tr>`).join('');

  const devRows = devices.map(d => `<tr><td class="mono">${esc(d.id.slice(0, 8))}</td><td>${esc(d.city || '—')}${d.country ? ', ' + esc(d.country) : ''}</td>
    <td>${statusCls(d)}</td><td class="mono">${d.lic ? esc(d.lic) : '—'}</td><td>${esc(d.version || '')}</td>
    <td title="${when(d.first_seen)}">${when(d.first_seen).slice(0, 10)}</td><td title="${when(d.last_seen)}">${ago(d.last_seen)}</td><td class="n">${d.opens}</td>
    <td class="act">${d.kicked
      ? `<form method="post"><input type="hidden" name="id" value="${esc(d.id)}"><input type="hidden" name="a" value="allow"><input type="hidden" name="ret" value="${esc(filterKey)}"><button class="ghost sm">Allow again</button></form>`
      : `<form method="post" data-confirm="Sign this computer out? It loses its license and must enter a key again."><input type="hidden" name="id" value="${esc(d.id)}"><input type="hidden" name="a" value="kick"><input type="hidden" name="ret" value="${esc(filterKey)}"><button class="danger sm">Sign out</button></form>`}</td></tr>`).join('');

  return html(`<header class="top"><div><h1>Cutkaar admin</h1><p>Switch between free and paid, make license keys, and sign computers out.</p></div>
    <nav class="toplinks"><a href="/stats">Stats</a><a href="?logout">Sign out</a></nav></header>
    ${flash}
    <section class="card mode ${paid ? 'on' : ''}">
      <div><h2>Cutkaar is ${paid ? '<b class="paid">PAID</b>' : '<b class="free">FREE</b>'}</h2>
      <p>${paid ? 'Computers need a license key to use Cutkaar.' + (S.grandfather === '1' ? ' People who had Cutkaar before paid mode was first turned on keep using it free.' : '') : 'Everyone can use Cutkaar without a key.'}</p></div>
      <form method="post" data-confirm="${paid ? 'Make Cutkaar free for everyone?' : 'Make Cutkaar paid? Computers without a license will be asked for a key.'}">
        <input type="hidden" name="a" value="mode"><input type="hidden" name="paid" value="${paid ? '0' : '1'}">
        <button class="switch ${paid ? 'on' : ''}" role="switch" aria-checked="${paid}"><i></i><span>${paid ? 'Turn paid OFF' : 'Turn paid ON'}</span></button></form>
    </section>
    <div class="tiles"><div class="tile"><span>Computers ever</span><b>${counts.all_ || 0}</b></div><div class="tile"><span>Used in last 30 days</span><b>${counts.active || 0}</b></div>
      <div class="tile"><span>With a license</span><b>${counts.licensed || 0}</b></div><div class="tile"><span>License keys</span><b>${keys.length}</b></div></div>
    <section class="card"><h2>What buyers see</h2>
      <form method="post" class="grid"><input type="hidden" name="a" value="settings">
        <label>Message in the app when a key is needed<textarea name="message" rows="3" placeholder="Example: Cutkaar Pro costs Rs 1,500 for one computer. Send the payment to JazzCash 03xx-xxxxxxx and WhatsApp the receipt to get your key.">${esc(S.message)}</textarea></label>
        <label>Contact (WhatsApp number, email or website)<input name="contact" value="${esc(S.contact)}" placeholder="WhatsApp 03xx-xxxxxxx"></label>
        <label class="chk"><input type="checkbox" name="grandfather" ${S.grandfather === '1' ? 'checked' : ''}> Keep Cutkaar free for people who already had it before paid mode was first turned on${S.paid_since ? ` (${when(S.paid_since)})` : ''}</label>
        <div><button>Save</button></div></form></section>
    <section class="card"><h2>License keys</h2>
      <form method="post" class="row"><input type="hidden" name="a" value="newkey">
        <input name="note" placeholder="Buyer name or phone (for you)" maxlength="120">
        <label class="inl">Computers <input name="max" type="number" min="1" max="100" value="1" class="num"></label><button>Make new key</button></form>
      <div class="tw"><table><thead><tr><th>Key</th><th>Note</th><th class="n">Computers</th><th>Status</th><th>Made</th><th></th></tr></thead>
      <tbody>${keyRows || '<tr><td colspan="6" class="empty">No keys yet.</td></tr>'}</tbody></table></div></section>
    <section class="card"><h2>${filterKey ? `Computers using ${esc(filterKey)} <span><a href="/admin">show all</a></span>` : 'Computers <span>most recent 200</span>'}</h2>
      <div class="tw"><table><thead><tr><th>ID</th><th>Place</th><th>Status</th><th>Key</th><th>Version</th><th>First seen</th><th>Last seen</th><th class="n">Opens</th><th></th></tr></thead>
      <tbody>${devRows || '<tr><td colspan="9" class="empty">No computers yet. They appear here when Cutkaar 3.9.4 or newer is opened.</td></tr>'}</tbody></table></div>
      <p class="fine">Each computer is a random ID made by Cutkaar; no names or IP addresses are kept. "Sign out" removes its license at once; the app locks the next time it checks (on start and every few hours).</p></section>
    <script>
      document.querySelectorAll('form[data-confirm]').forEach(f=>f.addEventListener('submit',e=>{if(!confirm(f.dataset.confirm))e.preventDefault();}));
      document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',()=>{navigator.clipboard.writeText(b.dataset.copy).then(()=>{b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1500);});}));
    </script>`);
}

function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Cutkaar admin</title><link rel="icon" href="/favicon.svg">
<style>${BASE_CSS}
.muted{color:var(--muted)}.mono,.key{font-family:ui-monospace,Consolas,monospace;font-size:13px}
.flash{background:#0f2a2f;border:1px solid var(--cut);border-radius:12px;padding:12px 16px;margin-top:8px}.flash span{color:var(--muted);font-size:13px}.flash .key{font-size:16px;color:#fff}
.mode{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}.mode h2{font-size:22px;margin:0 0 4px}
.mode .free{color:var(--good)}.mode .paid{color:#ffc65c}.mode.on{border-color:#6b5520}
.switch{display:inline-flex;align-items:center;gap:12px;background:var(--panel-2);color:var(--text);border:1px solid var(--line);padding:10px 16px 10px 10px;font-size:15px}
.switch i{width:48px;height:28px;border-radius:999px;background:#33444b;position:relative;flex:none;transition:background .2s}
.switch i::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;transition:left .2s}
.switch.on i{background:#d9a535}.switch.on i::after{left:23px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:16px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column}.tile span{font-size:13px;color:var(--soft)}.tile b{font-size:28px}
.grid{display:grid;gap:14px}.grid label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--soft)}.grid label.chk{flex-direction:row;align-items:center;gap:10px;font-size:14px;color:var(--text)}
.chk input{width:18px;height:18px}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:14px}.row input[name=note]{flex:1;min-width:200px}.inl{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--soft)}
.num{width:72px;padding:7px 8px}
button.sm{padding:6px 10px;font-size:13px;font-weight:600}
td.act{display:flex;gap:8px;align-items:center}td.act form{display:flex;gap:6px;align-items:center;margin:0}
tr.sel td{background:#0f2a2f}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:var(--panel-2);color:var(--soft)}.pill.good{color:var(--good);background:#13291d}.pill.bad{color:var(--bad);background:#2c1717}
</style></head><body><main>${body}</main></body></html>`;
}

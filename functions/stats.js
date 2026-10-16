import { init, pkDay } from './_count.js';
// Private dashboard: how many people downloaded Cutkaar and opened the app, by day, country and city.
// Open https://cutkaar.pages.dev/stats and enter the STATS_KEY you set in Cloudflare.

const COOKIE = 'ck_stats';
async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (body, status = 200, extra = {}) => new Response(page(body), {
  status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...extra } });

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  if (!env.STATS_KEY) return html(note('Almost ready', 'Add a secret named <b>STATS_KEY</b> in Cloudflare (Workers &amp; Pages → cutkaar → Settings → Variables and Secrets), then redeploy.'));
  const want = await sha(env.STATS_KEY);

  if (request.method === 'POST') {
    const f = await request.formData();
    if (await sha(String(f.get('key') || '')) !== want) return html(login('That key is not right. Try again.'), 401);
    return new Response(null, { status: 303, headers: { Location: '/stats',
      'Set-Cookie': `${COOKIE}=${want}; Path=/stats; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict` } });
  }
  const ck = (request.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  if (!ck || ck.slice(COOKIE.length + 1) !== want) return html(login(''));
  if (url.searchParams.has('logout')) return new Response(null, { status: 303, headers: { Location: '/stats', 'Set-Cookie': `${COOKIE}=; Path=/stats; Max-Age=0` } });
  if (!env.DB) return html(note('Connect the database', 'Bind a D1 database with the variable name <b>DB</b> to this Pages project (Settings → Bindings), then redeploy.'));

  await init(env.DB);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('d') || '30', 10) || 30, 1), 3650);
  const today = pkDay();
  const from = pkDay(new Date(Date.now() - (days - 1) * 864e5));
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).all().then(r => r.results || []);

  const [tot, daily, countries, cities] = await Promise.all([
    q(`SELECT kind,
         SUM(n) AS allTime,
         SUM(CASE WHEN day = ?1 THEN n ELSE 0 END) AS today,
         SUM(CASE WHEN day >= ?2 THEN n ELSE 0 END) AS inRange
       FROM hits GROUP BY kind`, today, from),
    q(`SELECT day, kind, SUM(n) AS n FROM hits WHERE day >= ?1 GROUP BY day, kind`, from),
    q(`SELECT country, SUM(CASE WHEN kind='download' THEN n ELSE 0 END) AS dl, SUM(CASE WHEN kind='open' THEN n ELSE 0 END) AS op
       FROM hits WHERE day >= ?1 GROUP BY country ORDER BY dl DESC, op DESC LIMIT 60`, from),
    q(`SELECT city, country, SUM(CASE WHEN kind='download' THEN n ELSE 0 END) AS dl, SUM(CASE WHEN kind='open' THEN n ELSE 0 END) AS op
       FROM hits WHERE day >= ?1 GROUP BY city, country ORDER BY dl DESC, op DESC LIMIT 100`, from),
  ]);
  const T = k => tot.find(r => r.kind === k) || { allTime: 0, today: 0, inRange: 0 };
  const D = T('download'), O = T('open');

  // one entry per day so empty days show as gaps
  const series = { download: {}, open: {} };
  for (const r of daily) series[r.kind] && (series[r.kind][r.day] = r.n);
  const span = Math.min(days, 120);
  const dayList = [...Array(span)].map((_, i) => pkDay(new Date(Date.now() - (span - 1 - i) * 864e5)));

  let names; try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { names = null; }
  const cname = c => { if (!c || c === '??' || c === 'XX' || c === 'T1') return 'Unknown'; try { return names ? names.of(c) : c; } catch { return c; } };
  const flag = c => /^[A-Z]{2}$/.test(c) && !['XX', 'T1'].includes(c) ? String.fromCodePoint(...[...c].map(x => 127397 + x.charCodeAt(0))) : '🌐';
  const fmt = n => Number(n || 0).toLocaleString('en-US');

  const ranges = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [3650, 'All time']]
    .map(([d, l]) => `<a href="?d=${d}"${d === days ? ' aria-current="page"' : ''}>${l}</a>`).join('');
  const rangeName = days === 1 ? 'today' : days >= 3650 ? 'all time' : `last ${days} days`;

  const tile = (label, v, sub) => `<div class="tile"><span class="tl">${label}</span><b>${fmt(v)}</b><span class="ts">${sub}</span></div>`;
  const chart = (kind, title) => {
    const vals = dayList.map(d => series[kind][d] || 0), max = Math.max(1, ...vals);
    const bars = dayList.map((d, i) => `<div class="bar" data-tip="${d} · ${fmt(vals[i])}"><i style="height:${vals[i] ? Math.max(3, vals[i] / max * 100) : 0}%"></i></div>`).join('');
    return `<section class="card"><h2>${title} per day</h2><div class="chart" role="img" aria-label="${title} per day, ${rangeName}">
      <div class="ymax">${fmt(max)}</div><div class="bars">${bars}</div></div>
      <div class="xax"><span>${dayList[0]}</span><span>${dayList[dayList.length - 1]}</span></div></section>`;
  };
  const maxC = Math.max(1, ...countries.map(r => r.dl));
  const crow = r => `<tr><td>${flag(r.country)} ${esc(cname(r.country))}</td><td class="n">${fmt(r.dl)}</td><td class="n">${fmt(r.op)}</td>
      <td class="share"><i style="width:${r.dl / maxC * 100}%"></i></td></tr>`;
  const cityRow = r => `<tr><td>${esc(r.city)}</td><td>${flag(r.country)} ${esc(cname(r.country))}</td><td class="n">${fmt(r.dl)}</td><td class="n">${fmt(r.op)}</td></tr>`;
  const empty = cols => `<tr><td colspan="${cols}" class="empty">Nothing yet for ${rangeName}. Counting starts from the first download.</td></tr>`;

  return html(`<header class="top"><div><h1>Cutkaar stats</h1><p>Downloads of the installer and app opens (each time Cutkaar checks for updates). Times are Pakistan time.</p></div>
    <a class="out" href="?logout">Sign out</a></header>
    <nav class="rng" aria-label="Time range">${ranges}</nav>
    <div class="tiles">
      ${tile('Downloads', D.inRange, rangeName)}${tile('Downloads today', D.today, today)}${tile('Downloads all time', D.allTime, 'since counting began')}
      ${tile('App opens', O.inRange, rangeName)}${tile('App opens today', O.today, today)}
    </div>
    <div class="two">${chart('download', 'Downloads')}${chart('open', 'App opens')}</div>
    <section class="card"><h2>Countries <span>${rangeName}</span></h2><div class="tw"><table><thead><tr><th>Country</th><th class="n">Downloads</th><th class="n">App opens</th><th class="share">Share of downloads</th></tr></thead>
      <tbody>${countries.length ? countries.map(crow).join('') : empty(4)}</tbody></table></div></section>
    <section class="card"><h2>Cities <span>${rangeName} · top 100</span></h2><div class="tw"><table><thead><tr><th>City</th><th>Country</th><th class="n">Downloads</th><th class="n">App opens</th></tr></thead>
      <tbody>${cities.length ? cities.map(cityRow).join('') : empty(4)}</tbody></table></div>
      <p class="fine">City comes from the visitor's internet connection, so it is approximate (often the nearest big city). No IP addresses are stored.</p></section>
    <div id="tip" role="tooltip" hidden></div>
    <script>
      const tip=document.getElementById('tip');
      document.querySelectorAll('.bar').forEach(b=>{
        b.addEventListener('pointerenter',()=>{tip.textContent=b.dataset.tip;tip.hidden=false;const r=b.getBoundingClientRect();
          tip.style.left=Math.min(innerWidth-tip.offsetWidth-8,Math.max(8,r.left+r.width/2-tip.offsetWidth/2))+'px';tip.style.top=(r.top+scrollY-tip.offsetHeight-8)+'px'});
        b.addEventListener('pointerleave',()=>tip.hidden=true);
      });
    </script>`);
}

function login(err) {
  return `<form class="login card" method="post"><h1>Cutkaar stats</h1><p>Enter your stats key to see downloads.</p>
    <label for="k">Stats key</label><input id="k" name="key" type="password" autocomplete="current-password" required autofocus>
    ${err ? `<p class="err">${err}</p>` : ''}<button>Open stats</button></form>`;
}
function note(t, m) { return `<section class="login card"><h1>${t}</h1><p>${m}</p></section>`; }

function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Cutkaar stats</title><link rel="icon" href="/favicon.svg">
<style>
:root{--ink:#0b1113;--panel:#121a1d;--panel-2:#18222a;--line:#24333a;--text:#e7edef;--muted:#97a6ac;--cut:#2ec8dd;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--ink);color:var(--text);font:400 15px/1.55 "Segoe UI",system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:16px;margin:0 0 14px}h2 span{color:var(--muted);font-weight:400;font-size:13px;margin-left:6px}
p{margin:0;color:var(--muted)}a{color:var(--cut)}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px}.out{font-size:14px;white-space:nowrap}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:16px;min-width:0}
.rng{display:flex;flex-wrap:wrap;gap:6px}.rng a{padding:6px 12px;border:1px solid var(--line);border-radius:999px;color:var(--text);text-decoration:none;font-size:14px}
.rng a[aria-current]{background:var(--cut);border-color:var(--cut);color:#03191d;font-weight:600}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:16px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column}
.tile b{font-size:30px;line-height:1.2;font-variant-numeric:tabular-nums}.tl{font-size:13px;color:var(--soft,#c6d0d3)}.ts{font-size:12px;color:var(--muted)}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:0 16px}
.chart{position:relative;height:160px;border-bottom:1px solid var(--line);padding-top:18px}
.ymax{position:absolute;top:0;left:0;font-size:12px;color:var(--muted)}
.bars{display:flex;align-items:flex-end;gap:2px;height:100%}
.bar{flex:1;height:100%;display:flex;align-items:flex-end;cursor:default;min-width:2px}
.bar i{display:block;width:100%;background:var(--cut);border-radius:3px 3px 0 0}.bar:hover i{background:#63dcec}
.xax{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:6px}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:var(--muted);font-weight:500;font-size:13px;padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:8px 10px;border-bottom:1px solid var(--panel-2);white-space:nowrap}.n{text-align:right;font-variant-numeric:tabular-nums}
.share{width:32%;min-width:120px}td.share i{display:block;height:8px;background:var(--cut);border-radius:0 4px 4px 0;min-width:2px}
.empty{color:var(--muted);text-align:center;padding:24px}.fine{font-size:12px;margin-top:12px}
.login{max-width:420px;margin:12vh auto 0;display:flex;flex-direction:column;gap:10px}
.login label{font-size:13px;color:var(--muted);margin-top:6px}
.login input{background:var(--ink);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;font-size:16px}
.login button{background:var(--cut);color:#03191d;border:0;border-radius:10px;padding:11px;font-weight:700;font-size:15px;cursor:pointer;margin-top:6px}
.err{color:#ff8a8a}
#tip{position:absolute;background:#e7edef;color:#0b1113;font-size:12px;padding:4px 8px;border-radius:6px;pointer-events:none;white-space:nowrap}
</style></head><body><main>${body}</main></body></html>`;
}

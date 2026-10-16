// Owner sign-in shared by /stats and /admin. The password is the STATS_KEY secret set in Cloudflare.
// Changing STATS_KEY signs out every device at once.
const COOKIE = 'ck_owner';
export async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('cutkaar:' + s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Returns a Response to send (login form, error, redirect) or null when the owner is signed in.
export async function guard(request, env, page, here) {
  if (!env.STATS_KEY) return page(note('Almost ready', 'Add a secret named <b>STATS_KEY</b> in Cloudflare (Workers &amp; Pages → cutkaar → Settings → Variables and Secrets), then redeploy.'));
  const want = await sha(env.STATS_KEY);
  const url = new URL(request.url);
  if (url.searchParams.has('logout')) return new Response(null, { status: 303, headers: { Location: here, 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Strict` } });
  const ck = (request.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  const signedIn = ck && ck.slice(COOKIE.length + 1) === want;
  if (!signedIn && request.method === 'POST') {
    const f = await request.formData();
    if (f.get('login') === '1') {
      if (await sha(String(f.get('key') || '')) !== want) return page(login('That password is not right. Try again.'), 401);
      return new Response(null, { status: 303, headers: { Location: here, 'Set-Cookie': `${COOKIE}=${want}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict` } });
    }
  }
  if (!signedIn) return page(login(''));
  if (!env.DB) return page(note('Connect the database', 'Bind a D1 database with the variable name <b>DB</b> to this Pages project (Settings → Bindings), then redeploy.'));
  return null;
}
function login(err) {
  return `<form class="login card" method="post"><h1>Cutkaar owner</h1><p>Enter your owner password (STATS_KEY).</p>
    <input type="hidden" name="login" value="1"><label for="k">Password</label><input id="k" name="key" type="password" autocomplete="current-password" required autofocus>
    ${err ? `<p class="err">${err}</p>` : ''}<button>Sign in</button></form>`;
}
function note(t, m) { return `<section class="login card"><h1>${t}</h1><p>${m}</p></section>`; }

export const BASE_CSS = `
:root{--ink:#0b1113;--panel:#121a1d;--panel-2:#18222a;--line:#24333a;--text:#e7edef;--muted:#97a6ac;--soft:#c6d0d3;--cut:#2ec8dd;--bad:#ff8a8a;--good:#5fd38d;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--ink);color:var(--text);font:400 15px/1.55 "Segoe UI",system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:16px;margin:0 0 14px}h2 span{color:var(--muted);font-weight:400;font-size:13px;margin-left:6px}
p{margin:0;color:var(--muted)}a{color:var(--cut)}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px}.toplinks{display:flex;gap:16px;font-size:14px;white-space:nowrap}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:16px;min-width:0}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:var(--muted);font-weight:500;font-size:13px;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid var(--panel-2);white-space:nowrap}.n{text-align:right;font-variant-numeric:tabular-nums}
.empty{color:var(--muted);text-align:center;padding:24px}.fine{font-size:12px;margin-top:12px}
.login{max-width:420px;margin:12vh auto 0;display:flex;flex-direction:column;gap:10px}
.login label{font-size:13px;color:var(--muted);margin-top:6px}
input,textarea,select{background:var(--ink);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;font:inherit;font-size:15px}
button,.btn{background:var(--cut);color:#03191d;border:0;border-radius:10px;padding:10px 14px;font-weight:700;font-size:14px;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}button.danger{background:transparent;color:var(--bad);border:1px solid #5a2a2a}
.login button{padding:11px;font-size:15px;margin-top:6px}
.err{color:var(--bad)}`;

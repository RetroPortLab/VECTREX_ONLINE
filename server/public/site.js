// Retro Port Lab: nav, footer and helpers shared by every page.
const PATREON = 'https://www.patreon.com/c/RetroPortLab';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = {};
  try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error(j.error || `error ${r.status}`);
  return j;
}
const params = new URLSearchParams(location.search);
const ME = { user: null, ready: null };

(function chrome() {
  if (window.top !== window) document.documentElement.classList.add('embedded');   // inside the Play page's frame: no second nav/footer
  const here = location.pathname;
  const on = (p) => (here === p || (p !== '/' && here.startsWith(p)) ? ' class="on"' : '');
  const nav = document.createElement('nav');
  nav.className = 'site-nav';
  nav.innerHTML = `<a class="brand" href="/">vectrex <span>netlink</span></a>
    <div class="links"><a href="/"${here === '/' ? ' class="on"' : ''}>Games</a><a href="/play"${on('/play')}>Play</a><a href="/watch"${on('/watch')}>Watch</a></div>
    <div class="who"><a class="patreon" href="${PATREON}" target="_blank" rel="noopener">♥ Patreon</a><span id="whoami"></span></div>`;
  document.body.prepend(nav);
  const foot = document.createElement('footer');
  foot.className = 'site-foot';
  foot.innerHTML = `<span>© Retro Port Lab</span><a href="${PATREON}" target="_blank" rel="noopener">Support us on Patreon</a><span class="sp">Vectrex consoles, online.</span>`;
  document.body.append(foot);
  ME.ready = api('/api/me').then((m) => {
    ME.user = m.user;
    ME.persistent = m.persistent;
    document.getElementById('whoami').innerHTML = m.user
      ? `<a href="/pilots/${encodeURIComponent(m.user.username)}">${esc(m.user.callsign)}</a> <a href="/account" style="color:var(--dim)">account</a>`
      : `<a href="/login?next=${encodeURIComponent(here + location.search)}">Sign in</a>`;
  }).catch(() => {});
})();

// a leaderboard table for a game (meta from /api/site), period 'all' or 'week'
async function boardHtml(g, period, limit) {
  const r = await api(`/api/leaderboard?game=${g.id}&period=${period}&limit=${limit || 50}`);
  const cols = g.leaderboard.columns;
  if (!r.rows.length) return '<p class="note">No ranked rounds yet. Sign in, plug in a console and be first.</p>';
  await ME.ready;
  return `<div class="scroll"><table><tr><th>#</th><th>Pilot</th>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>` +
    r.rows.map((row, i) => `<tr class="${ME.user && ME.user.username === row.username ? 'me' : ''}"><td>${i + 1}</td>
      <td><a href="/pilots/${encodeURIComponent(row.username)}">${esc(row.callsign)}</a></td>
      ${cols.map((c, k) => `<td class="${k === 0 ? 'big' : ''}">${row.stats[c.key] || 0}</td>`).join('')}</tr>`).join('') + '</table></div>';
}

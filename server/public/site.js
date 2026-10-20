// Retro Port Lab: nav, footer and helpers shared by every page.
const PATREON = 'https://www.patreon.com/c/RetroPortLab';
const COFFEE = 'https://buymeacoffee.com/retroportlab';
const COFFEE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px"><path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H16.5"/><path d="M8 3v2M12 3v2"/></svg>';
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
    <div class="who"><a class="coffee" href="${COFFEE}" target="_blank" rel="noopener" title="Buy me a coffee">${COFFEE_ICON} Coffee</a><a class="patreon" href="${PATREON}" target="_blank" rel="noopener">♥ Patreon</a><span id="whoami"></span></div>`;
  document.body.prepend(nav);
  // every page: what is live right now (games, rooms, players), with watch / join links
  const strip = document.createElement('div');
  strip.id = 'live-strip'; strip.className = 'live-strip';
  strip.innerHTML = '<span class="lv"><i class="dot"></i>LIVE</span><span class="lt">checking ...</span>';
  nav.after(strip);
  const paintStrip = (site) => {
    const games = site.games || [], rooms = (site.rooms || []).filter((r) => r.consoles > 0);   // a room with only bots is not a live game
    const players = rooms.reduce((n, r) => n + r.consoles, 0);
    const groups = games.map((g) => {
      const rs = rooms.filter((r) => r.game === g.id);
      const n = rs.reduce((a, r) => a + r.consoles, 0);
      const chips = rs.length
        ? rs.map((r) => `<span class="lr"><a href="/watch?room=${encodeURIComponent(r.name)}" title="Watch room ${esc(r.name)}">${esc(r.name)} <b>${r.consoles}</b>${r.bots ? `<small>+${r.bots} bot</small>` : ''}</a><a class="j" href="/play?room=${encodeURIComponent(r.name)}" title="Join room ${esc(r.name)}">join</a></span>`).join('')
        : '<a class="lr quiet" href="/play" title="Start a room">start a room</a>';
      return `<span class="lg"><a class="gn" href="/games/${esc(g.id)}">${esc(g.title)}</a><span class="gc${n ? ' on' : ''}">${n}</span>${chips}</span>`;
    }).join('');
    strip.innerHTML = `<span class="lv"><i class="dot${players ? ' ok' : ''}"></i>LIVE</span><span class="lt"><b>${players}</b> player${players === 1 ? '' : 's'} · <b>${rooms.length}</b> room${rooms.length === 1 ? '' : 's'}</span><span class="lgs">${groups}</span>`;
    document.documentElement.style.setProperty('--strip-h', strip.offsetHeight + 'px');
  };
  const pollStrip = async () => {
    if (document.hidden) return;
    try { paintStrip(await api('/api/site')); } catch { /* server asleep: keep the last picture */ }
  };
  addEventListener('resize', () => document.documentElement.style.setProperty('--strip-h', strip.offsetHeight + 'px'));
  pollStrip(); setInterval(pollStrip, 5000);
  document.addEventListener('visibilitychange', pollStrip);
  const foot = document.createElement('footer');
  foot.className = 'site-foot';
  foot.innerHTML = `<span>© Retro Port Lab</span><a href="${PATREON}" target="_blank" rel="noopener">Support us on Patreon</a><a href="${COFFEE}" target="_blank" rel="noopener">${COFFEE_ICON} Buy me a coffee</a><span class="sp">Vectrex consoles, online.</span>`;
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

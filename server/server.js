// Retro Port Lab — Vectrex online: the site, accounts, leaderboards, and the relay for the games.
//
// Pages:  /  /games/<id>  /pilots/<name>  /login  /account  /play  /watch?room=  /cart-test
// API:    GET  /api/site  /api/me  /api/leaderboard?game=&period=all|week  /api/pilots/<name>
//         POST /api/register  /api/login  /api/logout  /api/account  /api/bots?room=&n=|add=
// Relay:  wss://<host>/ws. A bridge says {t:"hello", role:"bridge", room, name, game}; the game
//         (games/) runs the room. A signed-in browser's cookie makes its console that account;
//         anything else plays as a guest. Dashboards say {t:"hello", role:"monitor", room}.
//
// DATABASE_URL (a Neon connection string) keeps accounts and scores; without it they live in memory.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const games = require('./games');
const { createStore } = require('./store');
const auth = require('./auth');

const PORT = process.env.PORT || 10000;
const MAX_ROOMS = 200;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const PAGES = { '/': 'index.html', '/login': 'login.html', '/register': 'login.html', '/account': 'account.html',
  '/play': 'play.html', '/watch': 'watch.html', '/cart-test': 'serialtest.html' };
const started = Date.now();
const store = createStore();
let dbOk = false;

// ---- rooms -------------------------------------------------------------------------------
/** name -> { name, game, room, events: [], reaper } */
const rooms = new Map();
const monitors = new Set();

// LOCK_ROOM=beta puts every console, dashboard and bot request in that one room, whatever it asks for
const LOCK_ROOM = String(process.env.LOCK_ROOM || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
// Who may add and remove bots. With neither variable set it is open to everyone (as when testing).
//   BOT_ADMINS=name1,name2   site usernames that may, once signed in
//   BOT_KEY=secret           or anyone who sends it (header x-bot-key, or ?key=): for the netbots command
const BOT_ADMINS = String(process.env.BOT_ADMINS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
const BOT_KEY = String(process.env.BOT_KEY || '');
const botsOpen = !BOT_ADMINS.length && !BOT_KEY;
const sha = (x) => require('crypto').createHash('sha256').update(String(x)).digest();
const isBotAdmin = (u) => botsOpen || !!(u && BOT_ADMINS.includes(u.username.toLowerCase()));
function keyOk(req, url) {
  const k = req.headers['x-bot-key'] || url.searchParams.get('key');
  return !!(BOT_KEY && k && require('crypto').timingSafeEqual(sha(k), sha(BOT_KEY)));
}
const cleanRoom = (r) => LOCK_ROOM || String(r || 'test').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'test';

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function event(rec, msg, level = 'info') {
  const e = { t: 'event', room: rec.name, ts: Date.now(), level, msg };
  rec.events.push(e);
  if (rec.events.length > 50) rec.events.shift();
  for (const m of monitors) if (m.watch === rec.name) send(m.ws, e);
}

function openRoom(name, game) {
  let rec = rooms.get(name);
  if (rec && rec.game !== game) {
    if (!rec.room.empty) return { error: `room '${name}' is playing ${rec.game.title}` };
    rec.room.close();
    rooms.delete(name);
    rec = null;
  }
  if (!rec) {
    if (rooms.size >= MAX_ROOMS) return { error: 'the server is full' };
    rec = { name, game, events: [], reaper: null };
    rec.room = game.createRoom(name, {
      send,
      toMonitors: (msg) => { const t = typeof msg === 'string' ? msg : JSON.stringify(msg); for (const m of monitors) if (m.watch === name) send(m.ws, t); },
      log: (msg, level) => event(rec, msg, level),
      store,
    });
    rooms.set(name, rec);
  }
  clearTimeout(rec.reaper);
  return rec;
}

// a room nobody plays in goes after 10 minutes (bots and all)
function emptyLater(rec) {
  clearTimeout(rec.reaper);
  rec.reaper = setTimeout(() => {
    if (rooms.get(rec.name) !== rec || !rec.room.empty) return;
    rec.room.close();
    rooms.delete(rec.name);
  }, 10 * 60 * 1000);
}

function liveRooms() {
  return [...rooms.values()].map((r) => {
    const info = r.room.info();
    const humans = info.players.filter((p) => !p.bot).length;
    return { name: r.name, game: r.game.id, title: r.game.title, pilots: info.players.length, consoles: humans, bots: info.players.length - humans };
  }).filter((r) => r.pilots > 0).sort((a, b) => b.consoles - a.consoles || b.pilots - a.pilots);
}

// ---- HTTP --------------------------------------------------------------------------------
const json = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const secureReq = (req) => req.headers['x-forwarded-proto'] === 'https';

function readBody(req) {
  return new Promise((ok) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 4096) { b = ''; req.destroy(); } });
    req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } });
  });
}

function serveFile(res, file, code = 200) {
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) {
      if (code === 404) { res.writeHead(404); return res.end('not found'); }
      return serveFile(res, 'index.html', 404);
    }
    res.writeHead(code, {
      'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
    });
    res.end(data);
  });
}

const userPub = (u) => u && { username: u.username, callsign: u.callsign, created: u.created };

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  if (p === '/api/site' && m === 'GET') {
    const live = liveRooms();
    let counts = { users: 0, rounds: 0 };
    try { counts = await store.counts(); } catch { /* db asleep */ }
    return json(res, 200, {
      brand: 'Retro Port Lab', lockedRoom: LOCK_ROOM || null, persistent: store.persistent && dbOk, counts, rooms: live,
      games: games.list.map((g) => ({ ...games.meta(g), live: live.filter((r) => r.game === g.id).reduce((n, r) => n + r.consoles, 0),
        rooms: live.filter((r) => r.game === g.id).length })),
    });
  }
  if (p === '/api/me' && m === 'GET') {
    const u = await auth.userFromRequest(store, req);
    return json(res, 200, { user: userPub(u), botAdmin: isBotAdmin(u), persistent: store.persistent && dbOk });
  }
  if (p === '/api/leaderboard' && m === 'GET') {
    const g = games.byId.get(url.searchParams.get('game'));
    if (!g || !g.leaderboard) return json(res, 404, { error: 'no leaderboard for that game' });
    const period = url.searchParams.get('period') === 'week' ? 'week' : 'all';
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50));
    try {
      return json(res, 200, { game: g.id, period, rows: await store.leaderboard(g.id, period, g.leaderboard.order, limit) });
    } catch (e) { return json(res, 503, { error: 'the scores database is not answering' }); }
  }
  if (p.startsWith('/api/pilots/') && m === 'GET') {
    try {
      const pilot = await store.pilot(decodeURIComponent(p.slice(12)));
      if (!pilot) return json(res, 404, { error: 'no such pilot' });
      return json(res, 200, pilot);
    } catch { return json(res, 503, { error: 'the scores database is not answering' }); }
  }
  if (p === '/api/register' && m === 'POST') {
    if (auth.slowDown(ipOf(req), 5)) return json(res, 429, { error: 'too many tries: wait a minute' });
    const b = await readBody(req);
    if (!auth.validUsername(b.username)) return json(res, 400, { error: 'pick a username of 3 to 16 letters, digits, - or _' });
    if (!auth.validPassword(b.password)) return json(res, 400, { error: 'pick a password of at least 8 characters' });
    const base = auth.cleanCallsign(b.callsign || b.username) || 'PILOT';
    let cs = base;
    for (let i = 2; (await store.callsignOwner(cs)) && i < 1000; i++) cs = base.slice(0, 8 - String(i).length) + i;
    const u = await store.createUser(b.username, cs, await auth.hashPassword(b.password));
    if (!u) return json(res, 409, { error: 'that username is taken' });
    const token = await auth.startSession(store, u.id);
    return json(res, 200, { user: userPub(u) }, { 'set-cookie': auth.sessionCookie(token, secureReq(req)) });
  }
  if (p === '/api/login' && m === 'POST') {
    if (auth.slowDown(ipOf(req), 10)) return json(res, 429, { error: 'too many tries: wait a minute' });
    const b = await readBody(req);
    const u = auth.validUsername(b.username) ? await store.userByName(b.username) : null;
    if (!u || !(await auth.verifyPassword(String(b.password || ''), u.pw_hash))) return json(res, 401, { error: 'wrong username or password' });
    const token = await auth.startSession(store, u.id);
    return json(res, 200, { user: userPub(u) }, { 'set-cookie': auth.sessionCookie(token, secureReq(req)) });
  }
  if (p === '/api/logout' && m === 'POST') {
    const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
    if (token) await store.deleteSession(auth.tokenHash(token)).catch(() => {});
    return json(res, 200, { ok: true }, { 'set-cookie': auth.sessionCookie('', secureReq(req), 0) });
  }
  if (p === '/api/account' && m === 'POST') {
    const u = await auth.userFromRequest(store, req);
    if (!u) return json(res, 401, { error: 'log in first' });
    const b = await readBody(req);
    if (b.callsign !== undefined) {
      const cs = auth.cleanCallsign(b.callsign);
      if (!cs) return json(res, 400, { error: 'a callsign is 1 to 8 letters or digits' });
      const owner = await store.callsignOwner(cs);
      if (owner && owner !== u.id) return json(res, 409, { error: `${cs} is someone else's callsign` });
      await store.updateUser(u.id, { callsign: cs });
    }
    if (b.password !== undefined) {
      if (auth.slowDown(ipOf(req), 10)) return json(res, 429, { error: 'too many tries: wait a minute' });
      const full = await store.userByName(u.username);
      if (!(await auth.verifyPassword(String(b.current || ''), full.pw_hash))) return json(res, 401, { error: 'your current password is not right' });
      if (!auth.validPassword(b.password)) return json(res, 400, { error: 'pick a password of at least 8 characters' });
      await store.updateUser(u.id, { pwHash: await auth.hashPassword(b.password) });
      await store.deleteSessionsOf(u.id, auth.tokenHash(auth.parseCookies(req.headers.cookie)[auth.COOKIE]));   // log out everywhere else
    }
    return json(res, 200, { user: userPub(await store.userById(u.id)) });
  }
  if (p === '/api/bots' && m === 'POST') {
    if (!botsOpen) {
      if (url.searchParams.has('key') || req.headers['x-bot-key']) { if (auth.slowDown(ipOf(req) + 'k', 10)) return json(res, 429, { error: 'too many tries: wait a minute' }); }
      if (!keyOk(req, url) && !isBotAdmin(await auth.userFromRequest(store, req))) return json(res, 403, { error: 'only bot admins can change the bots' });
    }
    const name = cleanRoom(url.searchParams.get('room'));
    const asked = games.byId.get(url.searchParams.get('game') || '') || (rooms.get(name) && rooms.get(name).game) || games.byId.get('vecstrike');
    const rec = openRoom(name, asked);
    if (rec.error || !rec.room.bots) return json(res, 409, { error: rec.error || 'that game has no bots' });
    const n = url.searchParams.has('n') ? Number(url.searchParams.get('n')) : null;
    const out = rec.room.bots(n, Number(url.searchParams.get('add')));
    if (rec.room.empty) emptyLater(rec);
    return json(res, 200, { room: name, ...out });
  }
  return json(res, 404, { error: 'no such API' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/healthz') {
    return json(res, 200, { ok: true, db: store.kind, dbOk, rooms: rooms.size, uptime_s: Math.round((Date.now() - started) / 1000) });
  }
  if (p.startsWith('/api/')) {
    return api(req, res, url).catch((e) => { console.error(e); json(res, 500, { error: 'something went wrong' }); });
  }
  if (p === '/' && url.searchParams.has('room')) {         // old dashboard links
    res.writeHead(302, { location: `/watch?room=${encodeURIComponent(url.searchParams.get('room'))}` });
    return res.end();
  }
  if (PAGES[p]) return serveFile(res, PAGES[p]);
  if (/^\/games\/[a-z0-9]+\/?$/.test(p)) return serveFile(res, 'game.html');
  if (/^\/pilots\/[^/]+\/?$/.test(p)) return serveFile(res, 'pilot.html');
  return serveFile(res, p.slice(1));
});

// ---- WebSocket ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws, req) => {
  const ip = ipOf(req);
  const c = { ws, ip, role: null, user: auth.userFromRequest(store, req) };   // a promise until the hello
  let budget = 200, lastRefill = Date.now();          // ~120 msg/s sustained per client
  let queue = Promise.resolve();

  ws.on('message', (raw) => {
    const now = Date.now();
    budget = Math.min(200, budget + (now - lastRefill) * 0.12);
    lastRefill = now;
    if (--budget < 0) return;                         // flooding: drop
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (!c.role && !c.helloing) { c.helloing = true; queue = queue.then(() => hello(c, m)).catch((e) => console.error(e)); return; }
    if (!c.role) { queue = queue.then(() => fromClient(c, m, now)); return; }
    fromClient(c, m, now);
  });

  ws.on('close', () => {
    queue.then(() => {
      if (c.role === 'monitor') monitors.delete(c);
      if (c.role === 'bridge' && c.rec && c.player) {
        c.rec.room.leave(c.player);
        if (c.rec.room.empty) emptyLater(c.rec);
      }
    });
  });
});

async function hello(c, m) {
  if (m.t !== 'hello') { c.helloing = false; return; }
  if (m.role === 'monitor') {
    c.role = 'monitor';
    c.watch = cleanRoom(m.room);
    monitors.add(c);
    sendWatching(c);
    return;
  }
  if (m.role !== 'bridge') { c.helloing = false; return; }
  const game = games.byBridgeName.get(m.game || 'netlink');
  if (!game) { send(c.ws, { t: 'error', msg: `this server doesn't know the game "${m.game}"` }); return c.ws.close(); }
  const user = await c.user;
  let name = m.name;
  if (!user) {                                     // a guest may not wear someone's callsign
    const cs = auth.cleanCallsign(name);
    if (cs && (await store.callsignOwner(cs).catch(() => null))) name = ('G' + cs).slice(0, 8);
  }
  const rec = openRoom(cleanRoom(m.room), game);
  if (rec.error) { send(c.ws, { t: 'error', msg: rec.error }); return c.ws.close(); }
  const p = rec.room.join(c.ws, { name, ip: c.ip, user, cart: m.cart });
  if (p.error) { send(c.ws, { t: 'error', msg: p.error }); if (rec.room.empty) emptyLater(rec); return c.ws.close(); }
  Object.assign(c, { role: 'bridge', rec, player: p });
  if (user) event(rec, `${p.name} is ${user.username}`);
}

function sendWatching(c) {
  const rec = rooms.get(c.watch);
  send(c.ws, { t: 'watching', room: c.watch, events: rec ? rec.events : [] });
  if (rec) for (const msg of rec.room.monitorInit()) send(c.ws, msg);
}

function fromClient(c, m, now) {
  if (c.role === 'monitor') {
    if (m.t === 'watch') { c.watch = cleanRoom(m.room); sendWatching(c); }
    return;
  }
  const p = c.player;
  if (!p) return;
  if (m.t === 'pong') {
    const sent = p.pings.get(m.id);
    if (sent) {
      p.pings.delete(m.id);
      p.rtt = now - sent;
      p.rttHist.push(p.rtt);
      if (p.rttHist.length > 60) p.rttHist.shift();
      send(p.ws, { t: 'rtt', ms: p.rtt });
    }
    return;
  }
  if (m.t === 'bstat') {
    const int = (v, lo, hi) => { v = Math.round(Number(v) || 0); return v < lo ? lo : v > hi ? hi : v; };
    const prev = p.bstat;
    p.bstat = {
      cart: String(m.cart || '').slice(0, 160), fw: String(m.fw || '').slice(0, 40), usb_ms: Number(m.usb_ms) || 0,
      poll_hz: int(m.poll_hz, 0, 10000), game_hz: int(m.game_hz, 0, 1000), sent_hz: int(m.sent_hz, 0, 1000),
    };
    if (prev && prev.cart !== p.bstat.cart) event(c.rec, `${p.name} cart: ${p.bstat.cart}`, p.bstat.cart === 'ok' ? 'info' : 'warn');
    return;
  }
  c.rec.room.message(p, m, now);
}

// ---- once a second: pings, rates, dashboard stats --------------------------------------------
let pingId = 0;
setInterval(() => {
  const now = Date.now();
  for (const rec of rooms.values()) {
    for (const p of rec.room.humans) {
      const id = ++pingId;
      p.pings.set(id, now);
      for (const [k, t] of p.pings) if (now - t > 10000) p.pings.delete(k);
      send(p.ws, { t: 'ping', id });
    }
    rec.room.secondTick();
  }
  const summary = [...rooms.values()].map((rec) => ({ name: rec.name, game: rec.game.id, title: rec.game.title, ...rec.room.info() }));
  const msg = JSON.stringify({ t: 'stats', ts: now, uptime: now - started, rooms: summary });
  for (const m of monitors) send(m.ws, msg);
}, 1000);

// ---- start -----------------------------------------------------------------------------------
async function startDb() {
  try {
    await store.init();
    dbOk = true;
    console.log(store.persistent ? 'scores: Postgres' : 'scores: in memory (set DATABASE_URL to keep them)');
  } catch (e) {
    console.error(`database: ${e.message}; trying again in 15 s`);
    setTimeout(startDb, 15000);
  }
}
startDb();
server.listen(PORT, () => console.log(`Retro Port Lab — Vectrex online on :${PORT}${LOCK_ROOM ? `, everyone locked in room '${LOCK_ROOM}'` : ''}`));

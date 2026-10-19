// vectrex-netlink relay: pairs two Vectrex bridges per room, relays their state to each other,
// measures the link, and feeds a live dashboard. One process, one dependency (ws).
//
//   bridges   : {t:"hello", role:"bridge", room, name, cart}  -> {t:"welcome", slot, peers, room}
//               {t:"state", f, x, y, b, fl, jx, jy}           -> relayed to the other bridge
//               {t:"bstat", ...}  once a second: the bridge's USB side
//               {t:"pong", id}    answers our {t:"ping", id}; we send back {t:"rtt", ms}
//   dashboards: {t:"hello", role:"monitor", room}  then {t:"watch", room} to switch
//               get {t:"state", room, slot, ...}, {t:"stats", rooms:[...]}, {t:"event", ...}

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const MAX_ROOMS = 200;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const started = Date.now();

// ---- HTTP: the dashboard and a health check ---------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime_s: Math.round((Date.now() - started) / 1000) }));
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

// ---- rooms ----------------------------------------------------------------------------
/** room name -> { name, bridges: Map<slot, client>, events: [] } */
const rooms = new Map();
const monitors = new Set();

const cleanRoom = (r) => String(r || 'test').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'test';
const cleanName = (n) => String(n || 'player').replace(/[^\w .-]/g, '').slice(0, 24) || 'player';
const int = (v, lo, hi) => { v = Math.round(Number(v) || 0); return v < lo ? lo : v > hi ? hi : v; };

function room(name) {
  let r = rooms.get(name);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) return null;
    r = { name, bridges: new Map(), events: [] };
    rooms.set(name, r);
  }
  return r;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function event(r, msg, level = 'info') {
  const e = { t: 'event', room: r.name, ts: Date.now(), level, msg };
  r.events.push(e);
  if (r.events.length > 50) r.events.shift();
  for (const m of monitors) if (m.watch === r.name) send(m.ws, e);
}

function peersChanged(r) {
  const peers = r.bridges.size;
  for (const [slot, c] of r.bridges) send(c.ws, { t: 'peers', peers, slot });
}

function playerInfo(c) {
  return {
    slot: c.slot, name: c.name, cart: c.cart, rtt: c.rtt, rttHist: c.rttHist,
    inHz: c.inHz, relayedHz: c.relayedHz, frame: c.last ? c.last.f : null,
    missed: c.missed, total: c.total, since: c.since, bstat: c.bstat, ip: c.ip,
    lastAge: c.lastAt ? Date.now() - c.lastAt : null,
  };
}

// ---- WebSocket -------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws, req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const c = { ws, ip, role: null };
  let budget = 200, lastRefill = Date.now();          // ~120 msg/s sustained per client

  ws.on('message', (raw) => {
    const now = Date.now();
    budget = Math.min(200, budget + (now - lastRefill) * 0.12);
    lastRefill = now;
    if (--budget < 0) return;                         // flooding: drop
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (!c.role) return hello(c, m);
    if (c.role === 'bridge') return fromBridge(c, m, now);
    if (c.role === 'monitor' && m.t === 'watch') {
      c.watch = cleanRoom(m.room);
      const r = rooms.get(c.watch);
      send(ws, { t: 'watching', room: c.watch, events: r ? r.events : [] });
    }
  });

  ws.on('close', () => {
    if (c.role === 'monitor') monitors.delete(c);
    if (c.role === 'bridge' && c.room) {
      const r = c.room;
      if (r.bridges.get(c.slot) === c) r.bridges.delete(c.slot);
      event(r, `P${c.slot} ${c.name} left`, 'warn');
      peersChanged(r);
      if (!r.bridges.size) setTimeout(() => { if (!r.bridges.size) rooms.delete(r.name); }, 10 * 60 * 1000);
    }
  });
});

function hello(c, m) {
  if (m.t !== 'hello') return;
  if (m.role === 'monitor') {
    c.role = 'monitor';
    c.watch = cleanRoom(m.room);
    monitors.add(c);
    const r = rooms.get(c.watch);
    send(c.ws, { t: 'watching', room: c.watch, events: r ? r.events : [] });
    return;
  }
  if (m.role !== 'bridge') return;
  const r = room(cleanRoom(m.room));
  if (!r) { send(c.ws, { t: 'error', msg: 'server full' }); return c.ws.close(); }
  const slot = !r.bridges.has(1) ? 1 : !r.bridges.has(2) ? 2 : 0;
  if (!slot) { send(c.ws, { t: 'error', msg: `room '${r.name}' already has two consoles` }); return c.ws.close(); }
  Object.assign(c, {
    role: 'bridge', room: r, slot, name: cleanName(m.name), cart: m.cart === 'sim' ? 'sim' : 'uvmc2',
    since: Date.now(), last: null, lastAt: 0, total: 0, missed: 0, inCount: 0, inHz: 0,
    relayed: 0, relayedHz: 0, rtt: null, rttHist: [], pings: new Map(), bstat: null,
  });
  r.bridges.set(slot, c);
  send(c.ws, { t: 'welcome', slot, peers: r.bridges.size, room: r.name });
  event(r, `P${slot} ${c.name} joined (${c.cart})`);
  peersChanged(r);
}

function fromBridge(c, m, now) {
  if (m.t === 'state') {
    const s = {
      f: int(m.f, 0, 0xffffffff), x: int(m.x, -127, 127), y: int(m.y, -127, 127),
      b: int(m.b, 0, 255), fl: int(m.fl, 0, 255), jx: int(m.jx, -128, 127), jy: int(m.jy, -128, 127),
    };
    if (c.last && s.f > c.last.f + 1 && s.f - c.last.f < 500) c.missed += s.f - c.last.f - 1;
    c.last = s; c.lastAt = now; c.total++; c.inCount++;
    const out = JSON.stringify({ t: 'state', room: c.room.name, slot: c.slot, ...s });
    for (const [slot, other] of c.room.bridges) {
      if (slot !== c.slot) { send(other.ws, out); c.relayed++; }
    }
    for (const mon of monitors) if (mon.watch === c.room.name) send(mon.ws, out);
  } else if (m.t === 'pong') {
    const sent = c.pings.get(m.id);
    if (sent) {
      c.pings.delete(m.id);
      c.rtt = now - sent;
      c.rttHist.push(c.rtt);
      if (c.rttHist.length > 60) c.rttHist.shift();
      send(c.ws, { t: 'rtt', ms: c.rtt });
    }
  } else if (m.t === 'bstat') {
    const prev = c.bstat;
    c.bstat = {
      cart: String(m.cart || '').slice(0, 160), fw: String(m.fw || '').slice(0, 40),
      usb_ms: Number(m.usb_ms) || 0, poll_hz: int(m.poll_hz, 0, 10000),
      game_hz: int(m.game_hz, 0, 1000), sent_hz: int(m.sent_hz, 0, 1000),
    };
    if (prev && prev.cart !== c.bstat.cart) {
      event(c.room, `P${c.slot} cart: ${c.bstat.cart}`, c.bstat.cart === 'ok' ? 'info' : 'warn');
    }
  }
}

// ---- once a second: pings, rates, dashboard stats --------------------------------------
let pingId = 0;
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    for (const c of r.bridges.values()) {
      const id = ++pingId;
      c.pings.set(id, now);
      for (const [k, t] of c.pings) if (now - t > 10000) c.pings.delete(k);
      send(c.ws, { t: 'ping', id });
      c.inHz = c.inCount; c.inCount = 0;
      c.relayedHz = c.relayed; c.relayed = 0;
    }
  }
  const summary = [...rooms.values()].map((r) => ({
    name: r.name, players: [...r.bridges.values()].sort((a, b) => a.slot - b.slot).map(playerInfo),
  }));
  const msg = JSON.stringify({ t: 'stats', ts: now, uptime: now - started, rooms: summary });
  for (const m of monitors) send(m.ws, msg);
}, 1000);

server.listen(PORT, () => console.log(`vectrex-netlink relay on :${PORT}`));

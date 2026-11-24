// FRAGNET: a first-person deathmatch for the ZX Spectrum Next (the Next draws it with a raycaster).
// Up to four consoles, and bots fill the arena to four pilots, so one console always has someone to
// shoot. Plasma bolts, 100 health, health packs; first to 15 frags, or the most in five minutes.
//
// The arena is a grid of cells (MAP below; the Next has the same map). A position is in cells (a
// float here, 8.8 fixed on the wire: 256 to a cell). An angle is 0..1023 round the circle, 0 = east,
// 256 = south (y runs down the map, so angles go clockwise on the watch view).
//
// Who decides what: a console moves its own pilot (so walking feels instant) and sends where it is,
// which way it faces and a count of the shots it has fired. The server checks every move (no faster
// than running, never into a wall) and sends a correction when one is wrong; it flies the bolts,
// judges every hit and frag, respawns the dead, and drives the bots. Every tick (60 ms) each console
// gets one snapshot of everything.

const MAP = [
  'SSSSSSSSSSSSSSSSSSSSSSSS',
  'SP.......S....S.......PS',
  'S........S....S........S',
  'S..MMM...S....S...MMM..S',
  'S..M.................M.S',
  'S..M...H........H....M.S',
  'S......TT......TT......S',
  'SSS....T........T....SSS',
  'S...........##.........S',
  'S.......#........#.....S',
  'S....P..#...TT...#..P..S',
  'S...........TT.........S',
  'S...........TT.........S',
  'S....P..#...TT...#..P..S',
  'S.......#........#.....S',
  'S...........##.........S',
  'SSS....T........T....SSS',
  'S......TT......TT......S',
  'S..M...H........H....M.S',
  'S..M.................M.S',
  'S..MMM...S....S...MMM..S',
  'S........S....S........S',
  'SP.......S....S.......PS',
  'SSSSSSSSSSSSSSSSSSSSSSSS',
];
const W = MAP[0].length, H = MAP.length;
const TEST = !!process.env.FRAG_TEST;
const solid = (x, y) => { const cx = Math.floor(x), cy = Math.floor(y); return cx < 0 || cy < 0 || cx >= W || cy >= H || !'.PH'.includes(MAP[cy][cx]); };
const SPAWNS = [], ITEMS = [];
MAP.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === 'P') SPAWNS.push([x + 0.5, y + 0.5]); if (ch === 'H') ITEMS.push([x + 0.5, y + 0.5]); }));

const C = {
  TICK_MS: 60, MAX: 6, HUMANS: 4, MIN_PILOTS: 4,
  SPEED: 3.9, R: 0.25, HIT_R: 0.36,
  BOLT_SPEED: 10, BOLT_LIFE: 50, DAMAGE: 20, FIRE_MS: 240, HP: 100,
  RESPAWN_TICKS: 42, ITEM_HP: 30, ITEM_TICKS: 250,
  FRAGS: 15, MATCH_S: 300, CD_TICKS: 50, OVER_TICKS: 160,
  BOT_SPEED: 3.4, BOT_TURN: 40, BOT_REACT: 6, BOT_AIM: 26,
};
const F = { ALIVE: 1, FIRE: 2, HURT: 4, BOT: 8 };
const E = { FRAG: 1, HIT: 2, IMPACT: 3, SPAWN: 4, JOIN: 5, LEAVE: 6, PICKUP: 7, START: 8, END: 9, FIRE: 10 };
const ST = { LOBBY: 0, COUNTDOWN: 1, RUN: 2, OVER: 3 };
const BOT_NAMES = ['VIPER', 'RAZOR', 'GHOST', 'HAVOC', 'NOVA', 'REAPER'];
const TAU = Math.PI * 2;
const IN = { FWD: 1, BACK: 2, LEFT: 4, RIGHT: 8, FIRE: 16 };

const cleanName = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9 ._-]/g, '').trim().slice(0, 8);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const byte = (v) => clamp(Math.round(v), 0, 255);
const fx = (v) => clamp(Math.round(v * 256), 0, 65535);
const adiff = (a, b) => ((a - b + 512) % 1024 + 1024) % 1024 - 512;
const angTo = (dx, dy) => ((Math.round(Math.atan2(dy, dx) * 1024 / TAU) % 1024) + 1024) % 1024;
const dirOf = (a) => [Math.cos(a * TAU / 1024), Math.sin(a * TAU / 1024)];

// a circle of radius r at (x, y) clear of the walls?
function clear(x, y, r) {
  return !(solid(x - r, y - r) || solid(x + r, y - r) || solid(x - r, y + r) || solid(x + r, y + r));
}
// move by (dx, dy), sliding along walls
function slide(p, dx, dy, r) {
  if (clear(p.x + dx, p.y, r)) p.x += dx;
  if (clear(p.x, p.y + dy, r)) p.y += dy;
}
// can (x0, y0) see (x1, y1)? (walls only)
function sight(x0, y0, x1, y1) {
  const d = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(d / 0.2);
  for (let i = 1; i < n; i++) if (solid(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n)) return false;
  return true;
}
// steps from every cell to cell (gx, gy), for the bots' routes
const fieldCache = new Map();
function distField(gx, gy) {
  const key = gy * W + gx;
  if (fieldCache.has(key)) return fieldCache.get(key);
  const f = new Int16Array(W * H).fill(-1), q = [key];
  f[key] = 0;
  while (q.length) {
    const k = q.shift(), x = k % W, y = (k / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, nk = ny * W + nx;
      if (!solid(nx, ny) && f[nk] < 0) { f[nk] = f[k] + 1; q.push(nk); }
    }
  }
  fieldCache.set(key, f);
  return f;
}

class FragRoom {
  constructor(name, hooks) {
    this.name = name;
    this.hooks = hooks;           // { send(ws, str), toMonitors(msg), log(text, level), onMatchEnd(room, result), onLeave(room, p) }
    this.pilots = new Map();      // id -> pilot (humans and bots)
    this.bolts = []; this.boltId = 0;
    this.items = ITEMS.map(([x, y]) => ({ x, y, on: true, t: 0 }));
    this.state = ST.LOBBY;
    this.tick = 0; this.stateTicks = 0; this.clockTicks = 0;
    this.match = 0; this.winner = 0;
    this.events = []; this.evtId = 0;
    this.minPilots = C.MIN_PILOTS;
    this.rosterSeq = 0; this.rosterDirty = true; this.lastRoster = 0;
    this.ranked = false;
    this.timer = setInterval(() => this.step(), C.TICK_MS);
  }

  close() { clearInterval(this.timer); }
  get humans() { return [...this.pilots.values()].filter((p) => !p.bot); }
  get bots() { return [...this.pilots.values()].filter((p) => p.bot); }
  get empty() { return this.humans.length === 0; }
  get size() { return this.pilots.size; }
  inMatch() { return [...this.pilots.values()].filter((p) => p.inMatch); }

  freeId() { for (let i = 1; i <= C.MAX; i++) if (!this.pilots.has(i)) return i; return 0; }

  event(kind, x = 0, y = 0, a = 0, b = 0) {
    this.evtId = (this.evtId % 255) + 1;
    this.events.push([this.evtId, kind, byte(x * 8), byte(y * 8), a & 255, b & 255]);
    if (this.events.length > 8) this.events.shift();
  }

  newPilot(id, name, bot) {
    return {
      id, name, bot, ws: null, ip: '', userId: null,
      inGame: bot, inMatch: false, alive: false, respT: 0,
      x: 1.5, y: 1.5, a: 0, hp: C.HP, input: 0,
      fix: 0, fixAck: 0, lastMoveAt: 0, fireSeq: 0, lastShot: 0, fired: false, hurt: 0,
      frags: 0, deaths: 0, shots: 0, hits: 0,
      goal: null, seen: 0, target: null, strafe: 1, strafeT: 0, stuck: 0,
      since: Date.now(), inCount: 0, inHz: 0, rtt: null, rttHist: [], pings: new Map(), bstat: null, lastMsg: 0, frame: 0, fl: 0,
    };
  }

  // ---- people ---------------------------------------------------------------------------------
  join(ws, name, ip, user = null) {
    if (this.humans.length >= C.HUMANS) return null;
    if (this.pilots.size >= C.MAX && this.bots.length) this.removePilot(this.bots[this.bots.length - 1]);
    const id = this.freeId();
    if (!id) return null;
    const p = this.newPilot(id, (user ? cleanName(user.callsign) : cleanName(name)) || `P${id}`, false);
    p.ws = ws; p.ip = ip; p.userId = user ? user.id : null;
    this.pilots.set(id, p);
    this.event(E.JOIN, 0, 0, id);
    this.rosterDirty = true;
    this.hooks.log(`P${id} ${p.name} joined`);
    return p;
  }

  leave(p) {
    if (this.pilots.get(p.id) !== p) return;
    if (p.inMatch && this.state !== ST.OVER && this.hooks.onLeave) this.hooks.onLeave(this, p);
    this.removePilot(p);
    this.event(E.LEAVE, 0, 0, p.id);
    this.hooks.log(`P${p.id} ${p.name} left`, 'warn');
    this.checkRoster();
  }

  removePilot(p) { this.pilots.delete(p.id); this.rosterDirty = true; }

  addBot() {
    const id = this.freeId();
    if (!id) return null;
    const used = new Set([...this.pilots.values()].map((p) => p.name));
    const p = this.newPilot(id, BOT_NAMES.find((n) => !used.has(n)) || `BOT${id}`, true);
    this.pilots.set(id, p);
    this.event(E.JOIN, 0, 0, id);
    this.rosterDirty = true;
    return p;
  }

  setBots(n) { this.minPilots = clamp(n | 0, 1, C.MAX); this.checkRoster(); }
  addBotManual(d) { this.setBots(this.minPilots + (d > 0 ? 1 : -1)); }

  // the arena holds at least minPilots; a bot gives its seat to a human
  checkRoster() {
    if (this.state === ST.LOBBY) return;
    if (!this.humans.some((p) => p.inMatch)) return;
    const want = clamp(Math.max(this.minPilots, this.humans.length), 1, C.MAX);
    while (this.pilots.size > want && this.bots.length) this.removePilot(this.bots[this.bots.length - 1]);
    while (this.pilots.size < want) {
      const b = this.addBot();
      if (!b) break;
      this.enter(b);
    }
  }

  // ---- what consoles tell us ------------------------------------------------------------------------
  fromBridge(p, m, now) {
    if (m.t !== 'fm') return;
    p.inGame = !!((m.fl | 0) & 8);
    p.frame = m.f | 0;
    p.fl = m.fl | 0;
    p.lastMsg = now;
    p.inCount++;
    p.input = (m.in | 0) & 31;
    if (!p.inGame) { if (p.inMatch) this.dropFromMatch(p); return; }
    if (!p.inMatch || !p.alive || this.state === ST.LOBBY) return;
    p.fixAck = m.fx | 0;
    if (p.fixAck === (p.fix & 255)) {                   // it has seen our last correction: its moves count
      const x = (m.x | 0) / 256, y = (m.y | 0) / 256;
      const dt = Math.min(0.5, Math.max(0.03, (now - (p.lastMoveAt || now)) / 1000));
      const far = Math.hypot(x - p.x, y - p.y) > C.SPEED * dt * 1.6 + 0.25;
      if (this.state === ST.COUNTDOWN || far || !clear(x, y, C.R * 0.8)) { if (Math.hypot(x - p.x, y - p.y) > 0.02) p.fix++; }
      else { p.x = x; p.y = y; }
      p.lastMoveAt = now;
      p.a = (m.a | 0) & 1023;
    }
    const fs = (m.fs | 0) & 255;
    const more = (fs - p.fireSeq + 256) & 255;
    if (more > 0 && more < 16) {
      p.fireSeq = fs;
      if (this.state === ST.RUN && now - p.lastShot >= C.FIRE_MS) { p.lastShot = now; this.shoot(p); }
    }
  }

  dropFromMatch(p) {
    if (p.inMatch && this.hooks.onLeave && this.state !== ST.OVER) this.hooks.onLeave(this, p);
    p.inMatch = false; p.alive = false;
    this.rosterDirty = true;
    this.checkRoster();
  }

  // ---- a match ------------------------------------------------------------------------------------
  setState(s) { this.state = s; this.stateTicks = 0; }

  enter(p) {                       // a pilot joins the match (at the start, or later)
    p.inMatch = true; p.frags = p.deaths = p.shots = p.hits = 0;
    this.spawn(p);
  }

  // the spawn point furthest from anyone alive (one of the best three, at random)
  spawn(p) {
    if (TEST) {                     // (FRAG_TEST=1: a fixed line-up for testing the Next's drawing)
      const spots = [[2.5, 11.5], [5.5, 11.5], [8.5, 12.1], [10.6, 10.9], [7, 11.2], [4.5, 12.6]];
      const k = p.bot ? 1 + (this.bots.indexOf(p) % 5) : 0;
      [p.x, p.y] = spots[k]; p.a = p.bot ? [512, 384, 640, 0, 256][k - 1] : 0;
      p.hp = C.HP; p.alive = true; p.respT = 0; p.hurt = 0; p.fix++;
      this.event(E.SPAWN, p.x, p.y, p.id);
      return;
    }
    const others = this.inMatch().filter((q) => q !== p && q.alive);
    const scored = SPAWNS.map(([x, y]) => [x, y, others.length ? Math.min(...others.map((q) => Math.hypot(q.x - x, q.y - y))) : Math.random() * 10])
      .sort((a, b) => b[2] - a[2]);
    const [x, y] = scored[Math.floor(Math.random() * Math.min(3, scored.length))];
    p.x = x; p.y = y; p.a = angTo(W / 2 - x, H / 2 - y);
    p.hp = C.HP; p.alive = true; p.respT = 0; p.hurt = 0; p.fix++;
    p.goal = null; p.target = null; p.seen = 0;
    this.event(E.SPAWN, x, y, p.id);
  }

  startMatch() {
    const ps = this.humans.filter((p) => p.inGame);
    if (!ps.length) { this.setState(ST.LOBBY); return; }
    this.match++;
    this.clockTicks = Math.round(C.MATCH_S * 1000 / C.TICK_MS);
    this.bolts = [];
    for (const it of this.items) { it.on = true; it.t = 0; }
    for (const p of this.pilots.values()) { p.inMatch = false; p.alive = false; }
    for (const p of ps) this.enter(p);
    for (const b of this.bots) this.enter(b);
    this.setState(ST.COUNTDOWN);       // checkRoster only works inside a match
    this.checkRoster();
    this.ranked = ps.length >= 2;
    this.rosterDirty = true;
    this.hooks.log(`match ${this.match}: ${ps.length} console(s)${this.ranked ? '' : ' (practice: one console)'}`);
  }

  endMatch() {
    const ps = this.inMatch().sort((a, b) => b.frags - a.frags || a.deaths - b.deaths);
    this.winner = ps.length ? ps[0].id : 0;
    this.event(E.END, 0, 0, this.winner, ps.length ? ps[0].frags : 0);
    this.bolts = [];
    const result = { ranked: this.ranked, winner: this.winner, pilots: ps, humans: ps.filter((p) => !p.bot).length };
    this.hooks.log(`match ${this.match} over: ${ps.map((p) => `${p.name} ${p.frags}`).join(', ')}`);
    if (this.hooks.onMatchEnd) this.hooks.onMatchEnd(this, result);
    this.rosterDirty = true;
    this.setState(ST.OVER);
  }

  // ---- shots and hits -------------------------------------------------------------------------------
  shoot(p) {
    const [dx, dy] = dirOf(p.a);
    let x = p.x + dx * 0.3, y = p.y + dy * 0.3;
    if (solid(x, y)) { x = p.x; y = p.y; }
    this.boltId = (this.boltId % 255) + 1;
    this.bolts.push({ id: this.boltId, x, y, a: p.a, dx, dy, owner: p.id, life: C.BOLT_LIFE });
    p.fired = true; p.shots++;
  }

  hurt(v, by) {
    v.hp -= C.DAMAGE; v.hurt = 3;
    if (by) by.hits++;
    if (v.hp > 0) { this.event(E.HIT, v.x, v.y, v.id, by ? by.id : 0); return; }
    v.hp = 0; v.alive = false; v.respT = C.RESPAWN_TICKS; v.deaths++;
    if (by && by !== v) by.frags++;
    this.event(E.FRAG, v.x, v.y, v.id, by ? by.id : 0);
    this.rosterDirty = true;
    if (by && by.frags >= C.FRAGS) this.endMatch();
  }

  stepBolts() {
    const step = C.BOLT_SPEED * C.TICK_MS / 1000 / 4;
    const live = [];
    for (const b of this.bolts) {
      let gone = false;
      for (let s = 0; s < 4 && !gone; s++) {
        b.x += b.dx * step; b.y += b.dy * step;
        if (solid(b.x, b.y)) { this.event(E.IMPACT, b.x - b.dx * step, b.y - b.dy * step, b.owner); gone = true; break; }
        for (const p of this.inMatch()) {
          if (!p.alive || p.id === b.owner) continue;
          if (Math.hypot(p.x - b.x, p.y - b.y) < C.HIT_R) { this.hurt(p, this.pilots.get(b.owner)); gone = true; break; }
        }
        if (this.state !== ST.RUN) { gone = true; break; }
      }
      if (!gone && --b.life > 0) live.push(b);
    }
    this.bolts = this.state === ST.RUN ? live : [];
  }

  stepItems() {
    this.items.forEach((it, i) => {
      if (!it.on) { if (--it.t <= 0) it.on = true; return; }
      for (const p of this.inMatch()) {
        if (p.alive && p.hp < C.HP && Math.hypot(p.x - it.x, p.y - it.y) < 0.5) {
          p.hp = Math.min(C.HP, p.hp + C.ITEM_HP); it.on = false; it.t = C.ITEM_TICKS;
          this.event(E.PICKUP, it.x, it.y, p.id, i);
          break;
        }
      }
    });
  }

  // ---- the bots ---------------------------------------------------------------------------------------
  think(p) {
    const dt = C.TICK_MS / 1000;
    // a target: the nearest enemy I can see
    let tgt = null, td = 1e9;
    for (const q of this.inMatch()) {
      if (q === p || !q.alive) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < 14 && d < td && sight(p.x, p.y, q.x, q.y)) { tgt = q; td = d; }
    }
    if (tgt !== p.target) { p.target = tgt; p.seen = 0; }
    if (tgt) p.seen++;
    // where to go: the enemy (to fighting range), health when hurt, else roam the spawn points
    if (!p.goal || Math.hypot(p.goal[0] - p.x, p.goal[1] - p.y) < 0.6 || (p.stuck > 15)) {
      const hurt = p.hp <= 50 && this.items.some((it) => it.on);
      if (hurt) { const it = this.items.filter((i) => i.on).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0]; p.goal = [it.x, it.y]; }
      else { const s = SPAWNS[Math.floor(Math.random() * SPAWNS.length)]; p.goal = [s[0], s[1]]; }
      p.stuck = 0;
    }
    if (tgt && p.hp > 40) p.goal = [tgt.x, tgt.y];
    // the next cell on the way
    let mx = 0, my = 0;
    const gx = Math.floor(p.goal[0]), gy = Math.floor(p.goal[1]);
    const f = distField(gx, gy), cx = Math.floor(p.x), cy = Math.floor(p.y);
    if (cx === gx && cy === gy) { mx = p.goal[0] - p.x; my = p.goal[1] - p.y; }
    else {
      let best = f[cy * W + cx], bx = cx, by = cy;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const v = f[(cy + dy) * W + cx + dx];
        if (v >= 0 && (best < 0 || v < best)) { best = v; bx = cx + dx; by = cy + dy; }
      }
      mx = bx + 0.5 - p.x; my = by + 0.5 - p.y;
    }
    if (tgt && td < 4) { mx = -mx * 0.3; my = -my * 0.3; }                     // close in: back off a little
    if (tgt) {                                                               // and circle-strafe
      if (--p.strafeT <= 0) { p.strafe = Math.random() < 0.5 ? -1 : 1; p.strafeT = 10 + Math.floor(Math.random() * 25); }
      const [ux, uy] = dirOf(angTo(tgt.x - p.x, tgt.y - p.y));
      mx += -uy * p.strafe * 0.8; my += ux * p.strafe * 0.8;
    }
    const ml = Math.hypot(mx, my);
    if (ml > 0.01) {
      const ox = p.x, oy = p.y;
      slide(p, mx / ml * C.BOT_SPEED * dt, my / ml * C.BOT_SPEED * dt, C.R);
      if (Math.hypot(p.x - ox, p.y - oy) < 0.02) p.stuck++; else p.stuck = 0;
    }
    // face the target (or the way I'm going), and fire when lined up
    const want = tgt ? angTo(tgt.x - p.x, tgt.y - p.y) : ml > 0.01 ? angTo(mx, my) : p.a;
    p.a = (p.a + clamp(adiff(want, p.a), -C.BOT_TURN, C.BOT_TURN) + 1024) % 1024;
    if (tgt && p.seen > C.BOT_REACT && Math.abs(adiff(want, p.a)) < 30 && this.state === ST.RUN) {
      const now = Date.now();
      if (now - p.lastShot >= C.FIRE_MS * 1.6) {
        p.lastShot = now;
        const keep = p.a;
        p.a = (p.a + Math.round((Math.random() - 0.5) * 2 * C.BOT_AIM) + 1024) % 1024;
        this.shoot(p);
        p.a = keep;
      }
    }
  }

  // ---- the clock -----------------------------------------------------------------------------------
  step() {
    const now = Date.now();
    this.tick++;
    this.stateTicks++;
    for (const p of this.pilots.values()) { p.fired = false; if (p.hurt > 0) p.hurt--; }
    if (this.state === ST.LOBBY) {
      if (this.humans.some((p) => p.inGame)) this.startMatch();
    } else if (this.state === ST.COUNTDOWN) {
      this.joinLate();
      if (this.stateTicks >= C.CD_TICKS) { this.event(E.START); this.setState(ST.RUN); }
    } else if (this.state === ST.RUN) {
      this.joinLate();
      for (const p of this.inMatch()) {
        if (!p.alive) { if (--p.respT <= 0) this.spawn(p); continue; }
        if (p.bot && !TEST) this.think(p);
      }
      this.stepBolts();
      this.stepItems();
      if (this.state === ST.RUN && --this.clockTicks <= 0) this.endMatch();
    } else if (this.state === ST.OVER) {
      if (this.stateTicks >= C.OVER_TICKS) this.startMatch();
    }
    if (this.state !== ST.LOBBY && !this.humans.some((p) => p.inGame || p.inMatch)) {       // everyone went back to the title screen
      for (const b of this.bots) this.removePilot(b);
      this.setState(ST.LOBBY);
    }
    this.send(now);
  }

  joinLate() {
    for (const p of this.humans) if (p.inGame && !p.inMatch && this.state !== ST.OVER) { this.enter(p); this.checkRoster(); this.rosterDirty = true; }
  }

  // ---- what we send ------------------------------------------------------------------------------------
  cd() { return this.state === ST.COUNTDOWN ? Math.max(0, C.CD_TICKS - this.stateTicks) : 0; }
  clockSecs() { return this.state === ST.RUN ? Math.max(0, Math.ceil(this.clockTicks * C.TICK_MS / 1000)) : this.state === ST.OVER ? 0 : C.MATCH_S; }
  pilotList() {
    return this.inMatch().filter((p) => p.alive).map((p) => [p.id, fx(p.x), fx(p.y), p.a,
      F.ALIVE | (p.fired ? F.FIRE : 0) | (p.hurt ? F.HURT : 0) | (p.bot ? F.BOT : 0), Math.max(0, p.hp)]);
  }
  body() {
    return {
      seq: this.tick, st: this.state, cd: this.cd(), clock: this.clockSecs(), fl: C.FRAGS,
      items: this.items.reduce((m, it, i) => m | (it.on ? 1 << i : 0), 0), np: this.inMatch().length || this.size,
      pilots: this.pilotList(), bolts: this.bolts.slice(-12).map((b) => [b.id, fx(b.x), fx(b.y), b.a, b.owner]),
      win: this.state === ST.OVER ? this.winner : 0, ev: this.events, tick_ms: C.TICK_MS,
    };
  }

  send(now) {
    const base = { t: 'snap', ...this.body() };
    for (const p of this.humans) {
      if (!p.ws) continue;
      this.hooks.send(p.ws, JSON.stringify({ ...base, you: { id: p.id, alive: p.alive ? 1 : 0, inMatch: p.inMatch ? 1 : 0, hp: Math.max(0, p.hp),
        fix: p.fix & 255, x: fx(p.x), y: fx(p.y), a: p.a, resp: p.respT, frags: p.frags, deaths: p.deaths } }));
    }
    this.hooks.toMonitors({ ...base, t: 'fsn', room: this.name });
    if (this.rosterDirty && now - this.lastRoster > 400) this.sendRoster(now);
  }

  rosterList() {
    return [...this.pilots.values()].sort((a, b) => a.id - b.id)
      .map((p) => [p.id, p.bot ? F.BOT : 0, Math.min(65535, p.frags), Math.min(65535, p.deaths), p.name]);
  }
  sendRoster(now) {
    this.lastRoster = now;
    this.rosterDirty = false;
    this.rosterSeq++;
    const msg = JSON.stringify({ t: 'roster', seq: this.rosterSeq, rk: 0, players: this.rosterList() });
    for (const p of this.humans) if (p.ws) this.hooks.send(p.ws, msg);
    this.hooks.toMonitors({ t: 'sroster', room: this.name, players: this.rosterList() });
  }

  info() {
    return [...this.pilots.values()].sort((a, b) => b.frags - a.frags || a.deaths - b.deaths || a.id - b.id).map((p) => ({
      slot: p.id, name: p.name, bot: p.bot, cart: p.bot ? 'bot' : 'next', score: p.frags, frags: p.frags, deaths: p.deaths, hp: p.hp,
      account: !!p.userId, alive: p.alive, inGame: p.inGame, rtt: p.rtt, rttHist: p.rttHist, inHz: p.inHz, frame: p.frame,
      since: p.since, bstat: p.bstat, lastAge: p.bot ? 0 : (p.lastMsg ? Date.now() - p.lastMsg : null),
    }));
  }
  monitorFull() { return [{ t: 'fmap', room: this.name, map: MAP }, { t: 'fsn', room: this.name, full: true, ...this.body() }]; }
}

module.exports = { FragRoom, C, MAP, F, E, ST };

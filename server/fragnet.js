// FRAGNET: a first-person deathmatch for the ZX Spectrum Next (the Next draws it with a raycaster).
// Up to four consoles, and bots fill the arena to four pilots, so one console always has someone to
// shoot. A plasma rifle to start; a rocket launcher, a scatter gun and a railgun to pick up; health
// packs; portals. Kill streaks are announced. First to 15 frags, or the most in five minutes; the
// room moves to the next map every match.
//
// A map is a grid of cells (MAPS below; the Next has the same maps, by number). A position is in
// cells (a float here, 8.8 fixed on the wire: 256 to a cell). An angle is 0..1023 round the circle,
// 0 = east, 256 = south (y runs down the map, so angles go clockwise on the watch view).
//   S M T #  walls (stone, metal, tech, brick)     .  floor     P  a spawn point
//   H health  R rockets  G scatter gun  L railgun (8 items at most)   a b c d  portals (in pairs)
//
// Who decides what: a console moves its own pilot (so walking feels instant) and sends where it is,
// which way it faces and a count of the shots it has fired. The server checks every move (no faster
// than running, never into a wall) and sends a correction when one is wrong; it flies the shots,
// judges every hit and frag, moves pilots through portals, respawns the dead, and drives the bots.
// Every tick (60 ms) each console gets one snapshot of everything.

const MAPS = [
  { name: 'ARENA', rows: [
    'SSSSSSSSSSSSSSSSSSSSSSSS',
    'SP.......S....S.......PS',
    'S........S....S........S',
    'S..MMM...S.R..S...MMM..S',
    'S..M.................M.S',
    'S..M...H........H....M.S',
    'Sa.....TT......TT......S',
    'SSS....T........T....SSS',
    'S...........##.........S',
    'S.......#........#.....S',
    'S....P..#...TT...#..P..S',
    'S..G........TT........LS',
    'S...........TT.........S',
    'S....P..#...TT...#..P..S',
    'S.......#........#.....S',
    'S...........##.........S',
    'SSS....T........T....SSS',
    'S......TT......TT.....aS',
    'S..M...H........H....M.S',
    'S..M.................M.S',
    'S..MMM...S....S...MMM..S',
    'S........S....S........S',
    'SP.......S....S.......PS',
    'SSSSSSSSSSSSSSSSSSSSSSSS'
  ] },
  { name: 'FOUNDRY', rows: [
    'MMMMMMMMMMMMMMMMMMMMMMMM',
    'MP.....M........M.....PM',
    'M......M........M......M',
    'M..TT..M...R....M..TT..M',
    'M..TT.....TTTT.....TT..M',
    'M.........T..T.........M',
    'MMMM..MMMMT..TMMMM..MMMM',
    'M.......H........H.....M',
    'M..a...................M',
    'M....######..######....M',
    'M....#....#..#....#....M',
    'MP...#.G..#..#..L.#...PM',
    'M....#....#..#....#....M',
    'M....##..###..###..#...M',
    'M......................M',
    'M..b.....H....H......a.M',
    'MMMM..MMMMT..TMMMM..MMMM',
    'M.........T..T.........M',
    'M..TT.....TTTT.....TT..M',
    'M..TT..M........M..TT..M',
    'M......M...R....M......M',
    'M......M........M...b..M',
    'MP.....M........M.....PM',
    'MMMMMMMMMMMMMMMMMMMMMMMM'
  ] },
  { name: 'COURTYARD', rows: [
    '########################',
    '#P.....#.......#P.....T#',
    '#......#.......#......T#',
    '#..H...#...R...#..L....#',
    '#......#.......#.......#',
    '#..............TTTTTTT.#',
    '####..###..#####.......#',
    '#........a.....#.......#',
    '#..........###.#..SSS..#',
    '#P.........#G#....S.S.P#',
    '#..........#.#....S.S..#',
    '#..........#.#....SHS..#',
    '#.................S.S..#',
    '####..####..###...S....#',
    '#.........#....#.......#',
    '#....P....#....#...b...#',
    '#.........#.H..#.......#',
    '#.....R...#....######..#',
    '#..............#.......#',
    '#..b......#....#...a...#',
    '#.........#....#.......#',
    '#P........#.......P....#',
    '#.........#....#.......#',
    '########################'
  ] },
];
const ITEM_KIND = { H: 0, R: 1, G: 2, L: 3 };
function loadMap(def, index) {
  const rows = def.rows, W = rows[0].length, H = rows.length;
  const m = { index, name: def.name, rows, W, H, spawns: [], items: [], portals: {}, fields: new Map() };
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === 'P') m.spawns.push([x + 0.5, y + 0.5]);
    if (ch in ITEM_KIND) m.items.push({ x: x + 0.5, y: y + 0.5, kind: ITEM_KIND[ch] });
    if (ch >= 'a' && ch <= 'd') (m.portals[ch] = m.portals[ch] || []).push([x, y]);
  }));
  m.solid = (x, y) => { const cx = Math.floor(x), cy = Math.floor(y); return cx < 0 || cy < 0 || cx >= W || cy >= H || 'SMT#'.includes(rows[cy][cx]); };
  m.portalAt = (x, y) => { const ch = rows[Math.floor(y)] && rows[Math.floor(y)][Math.floor(x)]; return ch >= 'a' && ch <= 'd' ? ch : null; };
  return m;
}
const LOADED = MAPS.map(loadMap);

const C = {
  TICK_MS: 60, MAX: 6, HUMANS: 4, MIN_PILOTS: 4,
  SPEED: 3.9, R: 0.25, HIT_R: 0.36,
  HP: 100, RESPAWN_TICKS: 42, ITEM_HP: 30, ITEM_TICKS: 250, WEAPON_TICKS: 330, PORTAL_COOL: 20,
  FRAGS: 15, MATCH_S: 300, CD_TICKS: 50, OVER_TICKS: 160,
  BOT_SPEED: 3.4, BOT_TURN: 40, BOT_REACT: 6, BOT_AIM: 26,
};
// the weapons: 0 plasma rifle, 1 rocket launcher, 2 scatter gun, 3 railgun
const WEAPONS = [
  { name: 'PLASMA', fireMs: 240, speed: 10, life: 50, damage: 20, ammo: 0 },
  { name: 'ROCKETS', fireMs: 780, speed: 7, life: 60, damage: 0, splash: 1.7, splashDamage: 95, ammo: 8, max: 16 },
  { name: 'SCATTER', fireMs: 680, speed: 16, life: 8, damage: 13, pellets: 6, spread: 32, ammo: 10, max: 20 },
  { name: 'RAILGUN', fireMs: 1280, damage: 80, ammo: 6, max: 12 },
];
const F = { ALIVE: 1, FIRE: 2, HURT: 4, BOT: 8 };            // bits 4-5: the pilot's weapon
const E = { FRAG: 1, HIT: 2, IMPACT: 3, SPAWN: 4, JOIN: 5, LEAVE: 6, PICKUP: 7, START: 8, END: 9, FIRE: 10,
  EXPLODE: 11, RAIL: 12, STREAK: 13, FIRST: 14, PORTAL: 15 };
const ST = { LOBBY: 0, COUNTDOWN: 1, RUN: 2, OVER: 3 };
const STREAKS = [3, 5, 7, 10];
const BOT_NAMES = ['VIPER', 'RAZOR', 'GHOST', 'HAVOC', 'NOVA', 'REAPER'];
const TAU = Math.PI * 2;
const TEST = !!process.env.FRAG_TEST;

const cleanName = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9 ._-]/g, '').trim().slice(0, 8);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const byte = (v) => clamp(Math.round(v), 0, 255);
const fx = (v) => clamp(Math.round(v * 256), 0, 65535);
const adiff = (a, b) => ((a - b + 512) % 1024 + 1024) % 1024 - 512;
const angTo = (dx, dy) => ((Math.round(Math.atan2(dy, dx) * 1024 / TAU) % 1024) + 1024) % 1024;
const dirOf = (a) => [Math.cos(a * TAU / 1024), Math.sin(a * TAU / 1024)];

class FragRoom {
  constructor(name, hooks) {
    this.name = name;
    this.hooks = hooks;           // { send(ws, str), toMonitors(msg), log(text, level), onMatchEnd(room, result), onLeave(room, p) }
    this.pilots = new Map();      // id -> pilot (humans and bots)
    this.bolts = []; this.boltId = 0;
    this.setMap(0);
    this.state = ST.LOBBY;
    this.tick = 0; this.stateTicks = 0; this.clockTicks = 0;
    this.match = 0; this.winner = 0; this.firstBlood = false;
    this.events = []; this.evtId = 0;
    this.minPilots = C.MIN_PILOTS;
    this.rosterSeq = 0; this.rosterDirty = true; this.lastRoster = 0;
    this.ranked = false;
    this.timer = setInterval(() => this.step(), C.TICK_MS);
  }

  setMap(i) {
    this.map = LOADED[i % LOADED.length];
    this.items = this.map.items.map((it) => ({ ...it, on: true, t: 0 }));
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
      x: 1.5, y: 1.5, a: 0, hp: C.HP, input: 0, weapon: 0, ammo: 0, streak: 0, portalCool: 0,
      fix: 0, fixAck: 0, lastMoveAt: 0, fireSeq: 0, lastShot: 0, fired: false, hurt: 0,
      frags: 0, deaths: 0, shots: 0, hits: 0, best: 0,
      goal: null, seen: 0, target: null, strafe: 1, strafeT: 0, stuck: 0,
      since: Date.now(), inCount: 0, inHz: 0, rtt: null, rttHist: [], pings: new Map(), bstat: null, lastMsg: 0, frame: 0, fl: 0,
    };
  }

  // ---- the map's geometry ------------------------------------------------------------------
  clear(x, y, r) {
    const s = this.map.solid;
    return !(s(x - r, y - r) || s(x + r, y - r) || s(x - r, y + r) || s(x + r, y + r));
  }
  slide(p, dx, dy, r) {
    if (this.clear(p.x + dx, p.y, r)) p.x += dx;
    if (this.clear(p.x, p.y + dy, r)) p.y += dy;
  }
  sight(x0, y0, x1, y1) {
    const d = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(d / 0.2);
    for (let i = 1; i < n; i++) if (this.map.solid(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n)) return false;
    return true;
  }
  distField(gx, gy) {                 // steps from every cell to cell (gx, gy), for the bots' routes
    const m = this.map, key = gy * m.W + gx;
    if (m.fields.has(key)) return m.fields.get(key);
    const f = new Int16Array(m.W * m.H).fill(-1), q = [key];
    f[key] = 0;
    while (q.length) {
      const k = q.shift(), x = k % m.W, y = (k / m.W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, nk = ny * m.W + nx;
        if (!m.solid(nx, ny) && f[nk] < 0) { f[nk] = f[k] + 1; q.push(nk); }
      }
    }
    m.fields.set(key, f);
    return f;
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
      if (this.state === ST.COUNTDOWN || far || !this.clear(x, y, C.R * 0.8)) { if (Math.hypot(x - p.x, y - p.y) > 0.02) p.fix++; }
      else { p.x = x; p.y = y; this.portalCheck(p); }
      p.lastMoveAt = now;
      p.a = (m.a | 0) & 1023;
    }
    const fs = (m.fs | 0) & 255;
    const more = (fs - p.fireSeq + 256) & 255;
    if (more > 0 && more < 16) {
      p.fireSeq = fs;
      const w = WEAPONS[p.weapon];
      if (this.state === ST.RUN && now - p.lastShot >= w.fireMs * 0.85) { p.lastShot = now; this.shoot(p); }
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
    p.inMatch = true; p.frags = p.deaths = p.shots = p.hits = p.streak = p.best = 0;
    this.spawn(p);
  }

  // the spawn point furthest from anyone alive (one of the best three, at random)
  spawn(p) {
    const sp = this.map.spawns;
    if (TEST) {                     // (FRAG_TEST=1: a fixed line-up on the first map, for testing the Next's drawing)
      const spots = [[2.5, 11.5], [5.5, 11.5], [8.5, 12.1], [10.6, 10.9], [7, 11.2], [4.5, 12.6]];
      const k = p.bot ? 1 + (this.bots.indexOf(p) % 5) : 0;
      [p.x, p.y] = spots[k]; p.a = p.bot ? [512, 384, 640, 0, 256][k - 1] : 0;
      if (!p.bot && process.env.FRAG_POS) [p.x, p.y, p.a] = process.env.FRAG_POS.split(',').map(Number);
    } else {
      const others = this.inMatch().filter((q) => q !== p && q.alive);
      const scored = sp.map(([x, y]) => [x, y, others.length ? Math.min(...others.map((q) => Math.hypot(q.x - x, q.y - y))) : Math.random() * 10])
        .sort((a, b) => b[2] - a[2]);
      const [x, y] = scored[Math.floor(Math.random() * Math.min(3, scored.length))];
      p.x = x; p.y = y; p.a = angTo(this.map.W / 2 - x, this.map.H / 2 - y);
    }
    p.hp = C.HP; p.alive = true; p.respT = 0; p.hurt = 0; p.fix++; p.weapon = 0; p.ammo = 0; p.streak = 0; p.portalCool = 0;
    if (TEST && !p.bot && process.env.FRAG_WEAPON) { p.weapon = Number(process.env.FRAG_WEAPON) & 3; p.ammo = 99; }
    p.goal = null; p.target = null; p.seen = 0;
    this.event(E.SPAWN, p.x, p.y, p.id);
  }

  startMatch() {
    const ps = this.humans.filter((p) => p.inGame);
    if (!ps.length) { this.setState(ST.LOBBY); return; }
    this.match++;
    this.setMap(process.env.FRAG_MAP ? Number(process.env.FRAG_MAP) : TEST ? 0 : this.match - 1);
    this.clockTicks = Math.round(C.MATCH_S * 1000 / C.TICK_MS);
    this.bolts = [];
    this.firstBlood = false;
    for (const p of this.pilots.values()) { p.inMatch = false; p.alive = false; }
    for (const p of ps) this.enter(p);
    for (const b of this.bots) this.enter(b);
    this.setState(ST.COUNTDOWN);       // checkRoster only works inside a match
    this.checkRoster();
    this.ranked = ps.length >= 2;
    this.rosterDirty = true;
    this.hooks.toMonitors({ t: 'fmap', room: this.name, map: this.map.rows, name: this.map.name });
    this.hooks.log(`match ${this.match} on ${this.map.name}: ${ps.length} console(s)${this.ranked ? '' : ' (practice: one console)'}`);
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
    const w = WEAPONS[p.weapon];
    p.fired = true; p.shots++;
    if (p.weapon === 3) this.rail(p);
    else {
      const n = w.pellets || 1;
      for (let i = 0; i < n; i++) {
        const a = n > 1 ? (p.a + Math.round((Math.random() - 0.5) * 2 * w.spread) + 1024) % 1024 : p.a;
        const [dx, dy] = dirOf(a);
        let x = p.x + dx * 0.3, y = p.y + dy * 0.3;
        if (this.map.solid(x, y)) { x = p.x; y = p.y; }
        this.boltId = (this.boltId % 255) + 1;
        this.bolts.push({ id: this.boltId, x, y, a, dx, dy, owner: p.id, kind: p.weapon, life: w.life, speed: w.speed });
      }
    }
    if (p.weapon) { if (--p.ammo <= 0) { p.weapon = 0; p.ammo = 0; } }
  }

  // the railgun: straight to the first wall; the first pilot near the line is hit
  rail(p) {
    const [dx, dy] = dirOf(p.a), w = WEAPONS[3];
    let hit = null, len = 0;
    for (let d = 0.2; d < 40; d += 0.05) {
      const x = p.x + dx * d, y = p.y + dy * d;
      if (this.map.solid(x, y)) break;
      len = d;
      if (!hit) for (const q of this.inMatch()) if (q !== p && q.alive && Math.hypot(q.x - x, q.y - y) < C.HIT_R) { hit = q; break; }
    }
    this.event(E.RAIL, p.x, p.y, p.a >> 2, p.id);
    if (hit) this.hurt(hit, p, w.damage);
  }

  explode(x, y, owner) {
    const w = WEAPONS[1];
    this.event(E.EXPLODE, x, y, owner ? owner.id : 0);
    for (const q of this.inMatch()) {
      if (!q.alive) continue;
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < w.splash && this.sight(x, y, q.x, q.y)) {
        let dmg = Math.round(w.splashDamage * (1 - d / w.splash) + 10);
        if (q === owner) dmg = Math.round(dmg * 0.5);
        this.hurt(q, owner, dmg);
      }
    }
  }

  hurt(v, by, dmg) {
    if (!v.alive) return;
    v.hp -= dmg; v.hurt = 3;
    if (by && by !== v) by.hits++;
    if (v.hp > 0) { this.event(E.HIT, v.x, v.y, v.id, by ? by.id : 0); return; }
    v.hp = 0; v.alive = false; v.respT = C.RESPAWN_TICKS; v.deaths++; v.streak = 0;
    if (by && by !== v) {
      by.frags++;
      by.streak++;
      by.best = Math.max(by.best, by.streak);
    }
    this.event(E.FRAG, v.x, v.y, v.id, by ? by.id : 0);
    if (by && by !== v) {
      if (!this.firstBlood) { this.firstBlood = true; this.event(E.FIRST, by.x, by.y, by.id); }
      if (STREAKS.includes(by.streak)) this.event(E.STREAK, by.x, by.y, by.id, by.streak);
    }
    this.rosterDirty = true;
    if (by && by.frags >= C.FRAGS && this.state === ST.RUN) this.endMatch();
  }

  stepBolts() {
    const live = [];
    for (const b of this.bolts) {
      const step = b.speed * C.TICK_MS / 1000 / 4;
      let gone = false;
      for (let s = 0; s < 4 && !gone; s++) {
        b.x += b.dx * step; b.y += b.dy * step;
        const owner = this.pilots.get(b.owner);
        if (this.map.solid(b.x, b.y)) {
          const ex = b.x - b.dx * step, ey = b.y - b.dy * step;
          if (b.kind === 1) this.explode(ex, ey, owner); else this.event(E.IMPACT, ex, ey, b.owner);
          gone = true; break;
        }
        for (const p of this.inMatch()) {
          if (!p.alive || p.id === b.owner) continue;
          if (Math.hypot(p.x - b.x, p.y - b.y) < C.HIT_R) {
            if (b.kind === 1) this.explode(b.x, b.y, owner); else this.hurt(p, owner, WEAPONS[b.kind].damage);
            gone = true; break;
          }
        }
        if (this.state !== ST.RUN) { gone = true; break; }
      }
      if (!gone && --b.life > 0) live.push(b);
      else if (!gone && b.kind === 1) this.explode(b.x, b.y, this.pilots.get(b.owner));
    }
    this.bolts = this.state === ST.RUN ? live : [];
  }

  stepItems() {
    this.items.forEach((it, i) => {
      if (!it.on) { if (--it.t <= 0) it.on = true; return; }
      for (const p of this.inMatch()) {
        if (!p.alive || Math.hypot(p.x - it.x, p.y - it.y) > 0.55) continue;
        if (it.kind === 0) {
          if (p.hp >= C.HP) continue;
          p.hp = Math.min(C.HP, p.hp + C.ITEM_HP); it.t = C.ITEM_TICKS;
        } else {
          const w = WEAPONS[it.kind];
          if (p.weapon === it.kind) { if (p.ammo >= w.max) continue; p.ammo = Math.min(w.max, p.ammo + w.ammo); }
          else { p.weapon = it.kind; p.ammo = w.ammo; }
          it.t = C.WEAPON_TICKS;
        }
        it.on = false;
        this.event(E.PICKUP, it.x, it.y, p.id, i);
        break;
      }
    });
  }

  // a pilot standing in a portal comes out of its twin (facing the same way), once a second at most
  portalCheck(p) {
    if (p.portalCool > 0) return;
    const ch = this.map.portalAt(p.x, p.y);
    if (!ch) return;
    const pair = this.map.portals[ch];
    if (!pair || pair.length < 2) return;
    const [cx, cy] = [Math.floor(p.x), Math.floor(p.y)];
    const out = pair.find(([x, y]) => x !== cx || y !== cy);
    if (!out) return;
    this.event(E.PORTAL, p.x, p.y, p.id, 0);
    p.x = out[0] + 0.5; p.y = out[1] + 0.5;
    const [dx, dy] = dirOf(p.a);                        // a step out, the way it faces, if there's room
    if (this.clear(p.x + dx * 0.6, p.y + dy * 0.6, C.R)) { p.x += dx * 0.6; p.y += dy * 0.6; }
    p.portalCool = C.PORTAL_COOL;
    p.fix++;
    this.event(E.PORTAL, p.x, p.y, p.id, 1);
  }

  // ---- the bots ---------------------------------------------------------------------------------------
  think(p) {
    const dt = C.TICK_MS / 1000;
    let tgt = null, td = 1e9;
    for (const q of this.inMatch()) {
      if (q === p || !q.alive) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < 14 && d < td && this.sight(p.x, p.y, q.x, q.y)) { tgt = q; td = d; }
    }
    if (tgt !== p.target) { p.target = tgt; p.seen = 0; }
    if (tgt) p.seen++;
    // where to go: the enemy (to fighting range), health when hurt, a weapon when it has only the
    // rifle, else roam the spawn points
    if (!p.goal || Math.hypot(p.goal[0] - p.x, p.goal[1] - p.y) < 0.6 || (p.stuck > 15)) {
      const near = (list) => list.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
      const health = this.items.filter((i) => i.on && i.kind === 0), guns = this.items.filter((i) => i.on && i.kind > 0);
      if (p.hp <= 50 && health.length) { const it = near(health); p.goal = [it.x, it.y]; }
      else if (p.weapon === 0 && guns.length && Math.random() < 0.7) { const it = near(guns); p.goal = [it.x, it.y]; }
      else { const s = this.map.spawns[Math.floor(Math.random() * this.map.spawns.length)]; p.goal = [s[0], s[1]]; }
      p.stuck = 0;
    }
    if (tgt && p.hp > 40) p.goal = [tgt.x, tgt.y];
    let mx = 0, my = 0;
    const gx = Math.floor(p.goal[0]), gy = Math.floor(p.goal[1]), W = this.map.W;
    const f = this.distField(gx, gy), cx = Math.floor(p.x), cy = Math.floor(p.y);
    if (cx === gx && cy === gy) { mx = p.goal[0] - p.x; my = p.goal[1] - p.y; }
    else {
      let best = f[cy * W + cx], bx = cx, by = cy;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const v = f[(cy + dy) * W + cx + dx];
        if (v >= 0 && (best < 0 || v < best)) { best = v; bx = cx + dx; by = cy + dy; }
      }
      mx = bx + 0.5 - p.x; my = by + 0.5 - p.y;
    }
    const keep = p.weapon === 1 ? 4 : p.weapon === 2 ? 2 : 4;   // rockets: keep away; scatter: get close
    if (tgt && td < keep) { mx = -mx * 0.3; my = -my * 0.3; }
    if (tgt) {
      if (--p.strafeT <= 0) { p.strafe = Math.random() < 0.5 ? -1 : 1; p.strafeT = 10 + Math.floor(Math.random() * 25); }
      const [ux, uy] = dirOf(angTo(tgt.x - p.x, tgt.y - p.y));
      mx += -uy * p.strafe * 0.8; my += ux * p.strafe * 0.8;
    }
    const ml = Math.hypot(mx, my);
    if (ml > 0.01) {
      const ox = p.x, oy = p.y;
      this.slide(p, mx / ml * C.BOT_SPEED * dt, my / ml * C.BOT_SPEED * dt, C.R);
      if (Math.hypot(p.x - ox, p.y - oy) < 0.02) p.stuck++; else p.stuck = 0;
      this.portalCheck(p);
    }
    const want = tgt ? angTo(tgt.x - p.x, tgt.y - p.y) : ml > 0.01 ? angTo(mx, my) : p.a;
    p.a = (p.a + clamp(adiff(want, p.a), -C.BOT_TURN, C.BOT_TURN) + 1024) % 1024;
    if (tgt && p.seen > C.BOT_REACT && Math.abs(adiff(want, p.a)) < 30 && this.state === ST.RUN) {
      const now = Date.now();
      if (now - p.lastShot >= WEAPONS[p.weapon].fireMs * 1.5) {
        p.lastShot = now;
        const keepA = p.a;
        p.a = (p.a + Math.round((Math.random() - 0.5) * 2 * C.BOT_AIM) + 1024) % 1024;
        this.shoot(p);
        p.a = keepA;
      }
    }
  }

  // ---- the clock -----------------------------------------------------------------------------------
  step() {
    const now = Date.now();
    this.tick++;
    this.stateTicks++;
    for (const p of this.pilots.values()) { p.fired = false; if (p.hurt > 0) p.hurt--; if (p.portalCool > 0) p.portalCool--; }
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
      F.ALIVE | (p.fired ? F.FIRE : 0) | (p.hurt ? F.HURT : 0) | (p.bot ? F.BOT : 0) | (p.weapon << 4), Math.max(0, p.hp)]);
  }
  body() {
    return {
      seq: this.tick, st: this.state, cd: this.cd(), clock: this.clockSecs(), fl: C.FRAGS, map: this.map.index,
      items: this.items.reduce((m, it, i) => m | (it.on ? 1 << i : 0), 0), np: this.inMatch().length || this.size,
      pilots: this.pilotList(), bolts: this.bolts.slice(-14).map((b) => [b.id, fx(b.x), fx(b.y), b.a, b.owner, b.kind]),
      win: this.state === ST.OVER ? this.winner : 0, ev: this.events, tick_ms: C.TICK_MS,
    };
  }

  send(now) {
    const base = { t: 'snap', ...this.body() };
    for (const p of this.humans) {
      if (!p.ws) continue;
      this.hooks.send(p.ws, JSON.stringify({ ...base, you: { id: p.id, alive: p.alive ? 1 : 0, inMatch: p.inMatch ? 1 : 0, hp: Math.max(0, p.hp),
        fix: p.fix & 255, x: fx(p.x), y: fx(p.y), a: p.a, resp: p.respT, frags: p.frags, deaths: p.deaths, weapon: p.weapon, ammo: p.ammo, streak: p.streak } }));
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
      weapon: WEAPONS[p.weapon].name, streak: p.streak,
      account: !!p.userId, alive: p.alive, inGame: p.inGame, rtt: p.rtt, rttHist: p.rttHist, inHz: p.inHz, frame: p.frame,
      since: p.since, bstat: p.bstat, lastAge: p.bot ? 0 : (p.lastMsg ? Date.now() - p.lastMsg : null),
    }));
  }
  monitorFull() { return [{ t: 'fmap', room: this.name, map: this.map.rows, name: this.map.name }, { t: 'fsn', room: this.name, full: true, ...this.body() }]; }
}

module.exports = { FragRoom, C, MAPS, WEAPONS, F, E, ST };

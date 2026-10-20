// LIGHT CYCLES: the rules, run on the server. Up to 16 cycles on a 72 x 72 grid, each leaving a
// wall behind it; hit a wall, an edge or another cycle's head and you derez; the last one
// running wins the round.
//
// The server is the referee: every tick (70 ms) each live cycle moves one cell. A console only
// says "turn left / turn right" (the stick or buttons) and draws what the server sends: every
// cycle's cell and heading, and each wall as its corners (sent once, when it changes).
// Bots fill a room and give a lone console someone to race.

const GRID = 72;
const C = {
  GRID, TICK_MS: 70, MAX: 16, MAX_CORN: 40, CD_TICKS: 43, OVER_TICKS: 72, MARGIN: 5, MAX_QUEUE: 3,
};
// directions: 0 = up (+y), 1 = right (+x), 2 = down, 3 = left
const DX = [0, 1, 0, -1], DY = [1, 0, -1, 0];
const F = { ALIVE: 1, BOT: 8 };
const E = { CRASH: 1, ROUND: 2, GO: 3, WIN: 4, JOIN: 5, LEAVE: 6 };
const ST = { LOBBY: 0, COUNTDOWN: 1, RUN: 2, OVER: 3 };
const BOT_NAMES = ['VOLT', 'ARC', 'FLUX', 'PIXEL', 'RAM', 'BYTE', 'OHM', 'NEON', 'ZED', 'BIT', 'GEM', 'CHIP', 'DYNAMO', 'HERTZ', 'LASER', 'SPARK'];

const cleanName = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9 ._-]/g, '').trim().slice(0, 8);
const idx = (x, y) => y * GRID + x;
const inb = (x, y) => x >= 0 && y >= 0 && x < GRID && y < GRID;
const nextVer = (v) => (v >= 65535 ? 1 : v + 1);

class CycleRoom {
  constructor(name, hooks) {
    this.name = name;
    this.hooks = hooks;                // { send(ws, msg), toMonitors(msg), log(text, level), onRoundEnd(room, result), onLeave(room, p, ranked) }
    this.cycles = new Map();           // id -> cycle (humans, bots and this round's ghosts)
    this.grid = new Uint8Array(GRID * GRID);
    this.state = ST.LOBBY;
    this.tick = 0;                     // snapshot number
    this.stateTicks = 0;               // ticks since the state began
    this.round = 0;
    this.winId = 0;
    this.events = [];
    this.evtId = 0;
    this.manualBots = 0;
    this.vseq = 0;                     // wall versions are unique across the room: a new owner of an id never matches an old one
    this.mon = { tv: new Map() };
    this.rosterSeq = 0;
    this.rosterDirty = true;
    this.lastRoster = 0;
    this.rankedRound = false;
    this.timer = setInterval(() => this.step(), C.TICK_MS);
  }

  close() { clearInterval(this.timer); }
  get humans() { return [...this.cycles.values()].filter((p) => !p.bot && !p.ghost); }
  get bots() { return [...this.cycles.values()].filter((p) => p.bot); }
  get empty() { return this.humans.length === 0; }
  get size() { return [...this.cycles.values()].filter((p) => !p.ghost).length; }

  bump() { this.vseq = nextVer(this.vseq); return this.vseq; }

  freeId() { for (let i = 1; i <= C.MAX; i++) if (!this.cycles.has(i)) return i; return 0; }

  event(kind, x = 0, y = 0, a = 0, b = 0) {
    this.evtId = (this.evtId % 255) + 1;
    this.events.push([this.evtId, kind, x, y, a, b]);
    if (this.events.length > 8) this.events.shift();
  }

  newCycle(id, name, bot) {
    return {
      id, name, bot, ghost: false, ws: null, ip: '', userId: null,
      inGame: bot,                      // a console is in the game once it leaves the title screen
      inRound: false, alive: false, x: 0, y: 0, dir: 0, q: [], corners: [], ver: 0, born: 0, diedTick: 0,
      wins: 0, crashes: 0,              // this room's tally (the roster)
      roundKills: 0, died: false, lasted: 0,   // this round's, for the leaderboards
      since: Date.now(), inCount: 0, inHz: 0, rtt: null, rttHist: [], pings: new Map(), bstat: null, lastMsg: 0,
      tv: new Map(),                    // wall versions this console has been sent
      cmdN: 0, frame: 0, fl: 0,
      look: 0, err: 0,                  // bot
    };
  }

  // ---- people -------------------------------------------------------------------------------
  // user: the signed-in account ({id, callsign}) or null for a guest
  join(ws, name, ip, user = null) {
    let id = this.freeId();
    if (!id && this.bots.length && this.state !== ST.RUN) { this.removeBot(); id = this.freeId(); }
    if (!id) return null;
    const p = this.newCycle(id, (user ? cleanName(user.callsign) : cleanName(name)) || `P${id}`, false);
    p.ws = ws; p.ip = ip; p.userId = user ? user.id : null;
    this.cycles.set(id, p);
    this.event(E.JOIN, 0, 0, id);
    this.rosterDirty = true;
    this.hooks.log(`P${id} ${p.name} joined`);
    return p;
  }

  leave(p) {
    if (this.cycles.get(p.id) !== p) return;
    if (this.hooks.onLeave && p.inRound && this.state !== ST.OVER) this.hooks.onLeave(this, p, this.rankedRound);
    if (p.inRound && this.state !== ST.LOBBY) {       // its wall stays until the round is over: the id is held
      p.ghost = true; p.alive = false; p.ws = null; p.inRound = false;
    } else {
      this.cycles.delete(p.id);
    }
    this.event(E.LEAVE, 0, 0, p.id);
    this.rosterDirty = true;
    this.hooks.log(`P${p.id} ${p.name} left`, 'warn');
  }

  addBot() {
    const id = this.freeId();
    if (!id) return false;
    const used = new Set([...this.cycles.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `BOT${id}`;
    this.cycles.set(id, this.newCycle(id, name, true));
    this.event(E.JOIN, 0, 0, id);
    this.rosterDirty = true;
    return true;
  }

  removeBot() {
    const b = this.bots.filter((x) => !x.inRound || this.state !== ST.RUN).sort((a, c) => c.id - a.id)[0];
    if (!b) return false;
    if (b.inRound && this.state !== ST.LOBBY) { b.ghost = true; b.alive = false; b.inRound = false; } else this.cycles.delete(b.id);
    this.event(E.LEAVE, 0, 0, b.id);
    this.rosterDirty = true;
    return true;
  }

  setBots(n) { this.manualBots = Math.max(0, Math.min(C.MAX, n | 0)); this.fillBots(); }
  addBotManual(d) { this.setBots(Math.max(this.manualBots, this.bots.length) + (d > 0 ? 1 : -1)); }

  // a lone console gets three bots to race; they go when a second console comes (unless set by hand)
  fillBots() {
    const h = this.humans.length;
    const want = Math.max(this.manualBots, h === 1 ? 3 : 0);
    if (this.state === ST.RUN) return;
    while (this.bots.length < want && this.addBot());
    while (this.bots.length > want && this.removeBot());
  }

  // ---- what consoles tell us ---------------------------------------------------------------------
  fromBridge(p, m, now) {
    if (m.t !== 'cy') return;
    p.inGame = !!((m.fl | 0) & 8);
    p.frame = m.f | 0;
    p.fl = m.fl | 0;
    p.lastMsg = now;
    p.inCount++;
    if (Array.isArray(m.c)) for (const c of m.c.slice(0, 8)) {
      if ((c === 1 || c === 2) && p.q.length < C.MAX_QUEUE) p.q.push(c === 1 ? 3 : 1);   // 1 = left (dir - 1), 2 = right
    }
    if (!p.inGame) p.q.length = 0;
  }

  // ---- a round ---------------------------------------------------------------------------------
  participants() { return [...this.cycles.values()].filter((p) => !p.ghost && p.inGame); }

  startRound() {
    for (const [id, p] of this.cycles) if (p.ghost) this.cycles.delete(id);
    this.fillBots();
    const ps = this.participants();
    if (ps.length < 2) { this.setState(ST.LOBBY); return; }
    this.round++;
    this.grid.fill(0);
    this.winId = 0;
    this.rankedRound = ps.filter((p) => !p.bot).length >= 2;
    // evenly spaced round the edge, heading in
    const S = GRID - 1 - 2 * C.MARGIN, per = 4 * S, off = Math.random() * per / ps.length;
    const order = ps.slice().sort(() => Math.random() - 0.5);
    order.forEach((p, i) => {
      const t = Math.floor(off + i * per / ps.length) % per, side = Math.floor(t / S), k = t % S;
      const [x, y, dir] = side === 0 ? [C.MARGIN + k, C.MARGIN, 0] : side === 1 ? [GRID - 1 - C.MARGIN, C.MARGIN + k, 3]
        : side === 2 ? [GRID - 1 - C.MARGIN - k, GRID - 1 - C.MARGIN, 2] : [C.MARGIN, GRID - 1 - C.MARGIN - k, 1];
      Object.assign(p, { x, y, dir, alive: true, inRound: true, q: [], corners: [[x, y]], roundKills: 0, died: false, lasted: 0, born: this.tick });
      p.ver = this.bump();
      this.grid[idx(x, y)] = p.id;
    });
    for (const p of this.cycles.values()) if (!p.inRound) { p.alive = false; p.corners = []; p.ver = this.bump(); }
    this.event(E.ROUND, 0, 0, this.round & 255);
    this.setState(ST.COUNTDOWN);
    this.hooks.log(`round ${this.round}: ${ps.length} cycles${this.rankedRound ? '' : ' (practice: fewer than two consoles)'}`);
  }

  setState(s) { this.state = s; this.stateTicks = 0; }

  derez(p, x, y, killerId) {
    p.alive = false; p.died = true; p.lasted = this.tick - p.born; p.diedTick = this.tick;
    p.crashes++;
    this.rosterDirty = true;
    const k = killerId && killerId !== p.id ? this.cycles.get(killerId) : null;
    if (k) k.roundKills++;
    this.event(E.CRASH, x, y, p.id, k ? k.id : 0);
  }

  endRound(winner) {
    this.winId = winner ? winner.id : 0;
    if (winner) { winner.wins++; winner.lasted = this.tick - winner.born; }
    this.event(E.WIN, 0, 0, this.winId);
    this.rosterDirty = true;
    this.setState(ST.OVER);
    this.hooks.log(winner ? `${winner.name} wins round ${this.round}` : `round ${this.round}: nobody left`);
    if (this.hooks.onRoundEnd) this.hooks.onRoundEnd(this, {
      winner, ranked: this.rankedRound, cycles: [...this.cycles.values()].filter((p) => p.inRound),
    });
  }

  // one tick of the world
  stepWorld() {
    const live = [...this.cycles.values()].filter((p) => p.alive);
    // 1. who turns, where to
    const next = new Map();
    for (const p of live) {
      if (p.bot) this.think(p);
      if (p.q.length) {
        const d = p.q.shift();
        const nd = (p.dir + d) % 4;
        if (nd !== p.dir) { p.dir = nd; p.corners.push([p.x, p.y]); this.trimCorners(p); p.ver = this.bump(); }
      }
      next.set(p, [p.x + DX[p.dir], p.y + DY[p.dir]]);
    }
    // 2. who crashes: into a wall or an edge, into the same cell as another head, or swapping places
    const crashed = new Map();
    const want = new Map();
    for (const [p, [nx, ny]] of next) {
      if (!inb(nx, ny)) { crashed.set(p, [0, p.x, p.y]); continue; }
      const owner = this.grid[idx(nx, ny)];
      if (owner) { crashed.set(p, [owner, p.x, p.y]); continue; }
      const k = idx(nx, ny);
      if (!want.has(k)) want.set(k, []);
      want.get(k).push(p);
    }
    for (const ps of want.values()) if (ps.length > 1) for (const p of ps) crashed.set(p, [0, p.x, p.y]);
    for (const [p, [nx, ny]] of next) {
      for (const [q, [qx, qy]] of next) if (q !== p && nx === q.x && ny === q.y && qx === p.x && qy === p.y) crashed.set(p, [0, p.x, p.y]);
    }
    // 3. move the rest; the dead are credited to whoever owned what they hit
    for (const [p, [owner, x, y]] of crashed) this.derez(p, x, y, owner);
    for (const [p, [nx, ny]] of next) {
      if (crashed.has(p)) continue;
      p.x = nx; p.y = ny;
      this.grid[idx(nx, ny)] = p.id;
    }
  }

  // a wall of more than MAX_CORN corners loses its oldest stretch: the cells go back to the arena
  trimCorners(p) {
    while (p.corners.length > C.MAX_CORN) {
      const [ax, ay] = p.corners[0], [bx, by] = p.corners[1];
      const dx = Math.sign(bx - ax), dy = Math.sign(by - ay);
      for (let x = ax, y = ay; x !== bx || y !== by; x += dx, y += dy) if (this.grid[idx(x, y)] === p.id) this.grid[idx(x, y)] = 0;
      p.corners.shift();
    }
  }

  // ---- the bots: look ahead, turn away from trouble, now and then turn for fun ------------------------
  free(x, y) { return inb(x, y) && this.grid[idx(x, y)] === 0; }
  run(x, y, dir, max = 24) {           // free cells straight ahead
    let n = 0;
    while (n < max && this.free(x + DX[dir] * (n + 1), y + DY[dir] * (n + 1))) n++;
    return n;
  }
  think(p) {
    if (p.q.length) return;
    const ahead = this.run(p.x, p.y, p.dir, 6);
    const l = (p.dir + 3) % 4, r = (p.dir + 1) % 4;
    const danger = ahead < 3 && Math.random() > 0.04;                 // sometimes they notice late
    const bored = ahead >= 6 && Math.random() < 0.03;
    if (!danger && !bored) return;
    const rl = this.run(p.x, p.y, l, 30), rr = this.run(p.x, p.y, r, 30);
    if (danger && rl === 0 && rr === 0) return;
    const pick = rl === rr ? (Math.random() < 0.5 ? 3 : 1) : rl > rr ? 3 : 1;
    if (bored && (rl < 8 || rr < 8)) return;                           // no fun turns into a tight space
    p.q.push(pick);
  }

  // ---- the clock -------------------------------------------------------------------------------------
  step() {
    const now = Date.now();
    this.tick++;
    this.stateTicks++;
    if (this.state === ST.LOBBY) {
      if (this.tick % 14 === 0) this.fillBots();
      if (this.participants().length >= 2) this.startRound();
    } else if (this.state === ST.COUNTDOWN) {
      if (this.stateTicks >= C.CD_TICKS) { this.event(E.GO); this.setState(ST.RUN); }
    } else if (this.state === ST.RUN) {
      this.stepWorld();
      const alive = [...this.cycles.values()].filter((p) => p.alive);
      if (alive.length <= 1) this.endRound(alive[0] || null);
    } else if (this.state === ST.OVER) {
      if (this.stateTicks >= C.OVER_TICKS) this.startRound();
    }
    this.send(now);
  }

  // ---- what we send ---------------------------------------------------------------------------------------
  cycList() {
    return [...this.cycles.values()].filter((p) => !p.ghost && (p.inRound || p.alive)).map((p) => [p.id, p.x, p.y, p.dir, (p.alive ? F.ALIVE : 0) | (p.bot ? F.BOT : 0)]);
  }
  trailsFor(p) {                                                       // the walls this console hasn't been sent
    const out = [];
    for (const c of this.cycles.values()) {
      if (p.tv.get(c.id) === c.ver) continue;
      p.tv.set(c.id, c.ver);
      out.push([c.id, c.ver, c.corners.flat()]);
    }
    return out;
  }
  cd() { return this.state === ST.COUNTDOWN ? Math.max(0, C.CD_TICKS - this.stateTicks) : 0; }

  send(now) {
    const cyc = this.cycList();
    const np = this.size;
    const base = { t: 'snap', seq: this.tick, st: this.state, cd: this.cd(), np, win: this.state === ST.OVER ? this.winId : 0, cyc, ev: this.events, tick_ms: C.TICK_MS };
    for (const p of this.humans) {
      if (!p.ws) continue;
      this.hooks.send(p.ws, JSON.stringify({ ...base, tr: this.trailsFor(p), you: { id: p.id, alive: p.alive ? 1 : 0, inRound: p.inRound ? 1 : 0 } }));
    }
    // dashboards: the same, with the walls that changed since the last tick
    const tr = [];
    for (const c of this.cycles.values()) if (this.mon.tv.get(c.id) !== c.ver) { this.mon.tv.set(c.id, c.ver); tr.push([c.id, c.ver, c.corners.flat()]); }
    this.hooks.toMonitors({ ...base, t: 'cyc', room: this.name, tr, grid: GRID });
    if (this.rosterDirty && now - this.lastRoster > 400) this.sendRoster(now);
  }

  rosterList() {
    return [...this.cycles.values()].filter((p) => !p.ghost).sort((a, b) => a.id - b.id)
      .map((p) => [p.id, p.bot ? F.BOT : 0, p.wins, p.crashes, p.name]);
  }
  sendRoster(now) {
    this.lastRoster = now;
    this.rosterDirty = false;
    this.rosterSeq++;
    const msg = JSON.stringify({ t: 'roster', seq: this.rosterSeq, rk: 0, players: this.rosterList() });
    for (const p of this.humans) if (p.ws) this.hooks.send(p.ws, msg);
    this.hooks.toMonitors({ t: 'sroster', room: this.name, players: this.rosterList() });
  }

  monitorFull() {                                                        // everything, for a dashboard that has just arrived
    return [{ t: 'cyc', room: this.name, full: true, seq: this.tick, st: this.state, cd: this.cd(), np: this.size, win: this.winId,
      cyc: this.cycList(), ev: [], tick_ms: C.TICK_MS, grid: GRID,
      tr: [...this.cycles.values()].map((c) => [c.id, c.ver, c.corners.flat()]) }];
  }

  // for the dashboard's once-a-second stats
  info() {
    return [...this.cycles.values()].filter((p) => !p.ghost).sort((a, b) => b.wins - a.wins || a.crashes - b.crashes || a.id - b.id).map((p) => ({
      slot: p.id, name: p.name, bot: p.bot, cart: p.bot ? 'bot' : 'uvmc2', wins: p.wins, crashes: p.crashes,
      account: !!p.userId, alive: p.alive, inGame: p.inGame, rtt: p.rtt, rttHist: p.rttHist, inHz: p.inHz, frame: p.frame,
      since: p.since, bstat: p.bstat, lastAge: p.bot ? 0 : (p.lastMsg ? Date.now() - p.lastMsg : null),
    }));
  }
}

module.exports = { CycleRoom, C, F, E, ST, GRID, DX, DY, cleanName };

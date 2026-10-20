// CO-OP ASTEROIDS: the rules, run on the server. Up to 8 ships share one 256 x 256 field that wraps
// round at every edge, one pool of lives and one team score. Rocks split when shot, a saucer
// crosses now and then, and a wave is over when the field is clear. Run out of lives and the run
// is over; the next one starts a few seconds later.
//
// The server is the referee: every tick (60 ms) it flies every ship, bullet, rock and saucer and
// settles who hit what. A console only says "which way am I pointing, and am I thrusting or
// firing" (the angle comes from the console, so turning feels instant) and draws what the server
// sends back. A lone console gets a bot wingman.
//
// Coordinates are field units 0..255 (screen = field - 128, y up). An angle is 0..255 round the
// circle, 0 = up and 64 = right (clockwise), the same as the console's sine table.

const W = 256;
const C = {
  W, TICK_MS: 60, MAX: 8, MAX_ROCKS: 24, MAX_BUL: 16, SHIP_BUL: 4, BUL_LIFE: 15, BUL_SPEED: 7,
  ACC: 0.42, VMAX: 5.5, DRAG: 0.991, SHIP_R: 4, CD_RUN: 50, CD_WAVE: 26, OVER_TICKS: 100,
  RESPAWN: 34, INVULN: 42, RADIUS: [5, 10, 20], POINTS: [100, 50, 20], EXTRA_LIFE: 10000, MSG_STALE_MS: 700,
};
const F = { ALIVE: 1, THRUST: 2, SAFE: 4, BOT: 8 };
const E = { ROCK: 1, SHIP: 2, WAVE: 3, OVER: 4, JOIN: 5, LEAVE: 6, UFO: 7, UFO_DIE: 8, LIFE: 9 };
const ST = { LOBBY: 0, COUNTDOWN: 1, RUN: 2, OVER: 3 };
const BOT_NAMES = ['WING', 'ECHO', 'NOVA', 'DELTA', 'ORBIT', 'COMET', 'PULSAR', 'QUARK'];
const TAU = Math.PI * 2;

const cleanName = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9 ._-]/g, '').trim().slice(0, 8);
const wrap = (v) => ((v % W) + W) % W;
const dlt = (a, b) => ((a - b + W / 2) % W + W) % W - W / 2;            // shortest way from b to a round the wrap
const sinA = (a) => Math.sin((a & 255) * TAU / 256);
const cosA = (a) => Math.cos((a & 255) * TAU / 256);
const angTo = (dx, dy) => (Math.round(Math.atan2(dx, dy) * 256 / TAU) % 256 + 256) % 256;
const adiff = (a, b) => ((a - b + 128) % 256 + 256) % 256 - 128;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// distance from point (px,py) to the segment a->b, all on the wrapping field (a is the origin)
function segDist(ax, ay, bx, by, px, py) {
  const sx = dlt(bx, ax), sy = dlt(by, ay), qx = dlt(px, ax), qy = dlt(py, ay);
  const len2 = sx * sx + sy * sy;
  const t = len2 ? clamp((qx * sx + qy * sy) / len2, 0, 1) : 0;
  return Math.hypot(qx - sx * t, qy - sy * t);
}

class RockRoom {
  constructor(name, hooks) {
    this.name = name;
    this.hooks = hooks;               // { send(ws, msg), toMonitors(msg), log(text, level), onRunEnd(room, result), onLeave(room, p, ranked) }
    this.ships = new Map();           // id -> ship (humans and bots)
    this.rocks = [];
    this.bul = [];
    this.ufo = null;
    this.state = ST.LOBBY;
    this.tick = 0;
    this.stateTicks = 0;
    this.wave = 0;
    this.lives = 0;
    this.score = 0;
    this.nextLife = 1;
    this.run = 0;
    this.ufoTimer = 0;
    this.events = [];
    this.evtId = 0;
    this.manualBots = 0;
    this.rosterSeq = 0;
    this.rosterDirty = true;
    this.lastRoster = 0;
    this.ranked = false;
    this.timer = setInterval(() => this.step(), C.TICK_MS);
  }

  close() { clearInterval(this.timer); }
  get humans() { return [...this.ships.values()].filter((p) => !p.bot); }
  get bots() { return [...this.ships.values()].filter((p) => p.bot); }
  get empty() { return this.humans.length === 0; }
  get size() { return this.ships.size; }
  inRun() { return [...this.ships.values()].filter((p) => p.inRun); }

  freeId() { for (let i = 1; i <= C.MAX; i++) if (!this.ships.has(i)) return i; return 0; }

  event(kind, x = 0, y = 0, a = 0, b = 0) {
    this.evtId = (this.evtId % 255) + 1;
    this.events.push([this.evtId, kind, Math.round(wrap(x)) & 255, Math.round(wrap(y)) & 255, a & 255, b & 255]);
    if (this.events.length > 8) this.events.shift();
  }

  newShip(id, name, bot) {
    return {
      id, name, bot, ws: null, ip: '', userId: null,
      inGame: bot, inRun: false, alive: false, respawn: -1,
      x: 128, y: 128, vx: 0, vy: 0, ang: 0, input: 0, thrust: false, cool: 0, invuln: 0,
      shots: 0, hyper: 0, seenMsg: false,
      score: 0, rocksHit: 0, ufosHit: 0, deaths: 0, joined: 0,
      since: Date.now(), inCount: 0, inHz: 0, rtt: null, rttHist: [], pings: new Map(), bstat: null, lastMsg: 0, frame: 0, fl: 0,
      aim: 0,
    };
  }

  // ---- people ---------------------------------------------------------------------------------
  join(ws, name, ip, user = null) {
    let id = this.freeId();
    if (!id && this.bots.length) { this.removeShip(this.bots[this.bots.length - 1]); id = this.freeId(); }
    if (!id) return null;
    const p = this.newShip(id, (user ? cleanName(user.callsign) : cleanName(name)) || `P${id}`, false);
    p.ws = ws; p.ip = ip; p.userId = user ? user.id : null;
    this.ships.set(id, p);
    this.event(E.JOIN, 0, 0, id);
    this.rosterDirty = true;
    this.hooks.log(`P${id} ${p.name} joined`);
    return p;
  }

  leave(p) {
    if (this.ships.get(p.id) !== p) return;
    if (p.inRun && this.state !== ST.OVER && this.hooks.onLeave) this.hooks.onLeave(this, p, this.ranked);
    this.removeShip(p);
    this.event(E.LEAVE, 0, 0, p.id);
    this.hooks.log(`P${p.id} ${p.name} left`, 'warn');
    this.checkRoster();
  }

  removeShip(p) {
    this.ships.delete(p.id);
    this.bul = this.bul.filter((b) => b.owner !== p.id);
    this.rosterDirty = true;
  }

  addBot() {
    const id = this.freeId();
    if (!id) return null;
    const used = new Set([...this.ships.values()].map((p) => p.name));
    const p = this.newShip(id, BOT_NAMES.find((n) => !used.has(n)) || `BOT${id}`, true);
    this.ships.set(id, p);
    this.event(E.JOIN, 0, 0, id);
    this.rosterDirty = true;
    return p;
  }

  setBots(n) { this.manualBots = clamp(n | 0, 0, C.MAX - 1); this.checkRoster(); }
  addBotManual(d) { this.setBots(Math.max(this.manualBots, this.bots.length) + (d > 0 ? 1 : -1)); }

  // a lone console flies with one wingman; a second console sends it home (unless set by hand)
  checkRoster() {
    if (this.state === ST.LOBBY) return;
    const humansIn = this.humans.filter((p) => p.inRun).length;
    if (humansIn === 0) return;
    const want = Math.max(this.manualBots, humansIn === 1 ? 1 : 0);
    while (this.bots.length > want) this.removeShip(this.bots[this.bots.length - 1]);
    while (this.bots.length < want && this.ships.size < C.MAX) {
      const b = this.addBot();
      if (!b) break;
      this.enter(b);
    }
  }

  // ---- what consoles tell us ------------------------------------------------------------------------
  fromBridge(p, m, now) {
    if (m.t !== 'as') return;
    p.inGame = !!((m.fl | 0) & 8);
    p.frame = m.f | 0;
    p.fl = m.fl | 0;
    p.lastMsg = now;
    p.inCount++;
    p.input = (m.in | 0) & 15;
    p.ang = (m.a | 0) & 255;
    const sh = (m.sh | 0) & 255, hy = (m.hy | 0) & 255;
    if (!p.seenMsg) { p.seenMsg = true; p.shots = sh; p.hyper = hy; }       // what the counters held before we started is stale
    p.pendShots = ((p.pendShots || 0) + ((sh - p.shots) & 255)) | 0;
    p.pendHyper = ((p.pendHyper || 0) + ((hy - p.hyper) & 255)) | 0;
    p.shots = sh; p.hyper = hy;
    if (p.pendShots > 2) p.pendShots = 2;
    if (p.pendHyper > 1) p.pendHyper = 1;
    if (!p.inGame && p.inRun) this.dropFromRun(p);
  }

  dropFromRun(p) {
    if (p.inRun && this.hooks.onLeave && this.state !== ST.OVER) this.hooks.onLeave(this, p, this.ranked);
    p.inRun = false; p.alive = false; p.respawn = -1;
    this.bul = this.bul.filter((b) => b.owner !== p.id);
    this.rosterDirty = true;
    this.checkRoster();
  }

  // ---- a run ---------------------------------------------------------------------------------
  setState(s) { this.state = s; this.stateTicks = 0; }

  spawnPos(i, n) {
    const a = (i / Math.max(1, n)) * TAU, r = n > 1 ? 14 : 0;
    return [128 + Math.sin(a) * r, 128 + Math.cos(a) * r];
  }

  enter(p) {                         // a ship joins the run (at the start, or later: free)
    p.inRun = true; p.alive = false; p.respawn = 0; p.score = 0; p.rocksHit = 0; p.ufosHit = 0; p.deaths = 0; p.joined = this.tick;
    p.pendShots = 0; p.pendHyper = 0;
    p.free = true;                   // this respawn costs no life
  }

  startRun() {
    const ps = this.humans.filter((p) => p.inGame);
    if (!ps.length) { this.setState(ST.LOBBY); return; }
    this.run++;
    this.wave = 0;
    this.score = 0;
    this.nextLife = 1;
    this.rocks = []; this.bul = []; this.ufo = null;
    for (const p of this.ships.values()) { p.inRun = false; p.alive = false; }
    for (const p of ps) this.enter(p);
    this.ranked = ps.length >= 2;
    this.lives = clamp(3 + (ps.length - 1) * 2, 3, 20);
    this.state = ST.COUNTDOWN;                // checkRoster only works inside a run
    this.checkRoster();
    const all = this.inRun();
    all.forEach((p, i) => {
      [p.x, p.y] = this.spawnPos(i, all.length);
      p.vx = p.vy = 0; p.alive = true; p.respawn = -1; p.invuln = 20; p.free = false; p.ang = p.bot ? 0 : p.ang;
    });
    this.nextWave(C.CD_RUN);
    this.hooks.log(`run ${this.run}: ${ps.length} console(s)${this.ranked ? '' : ' (practice: one console)'}`);
  }

  nextWave(cd) {
    this.wave++;
    this.spawnRocks();
    this.ufoTimer = Math.round(rand(380, 560));
    this.event(E.WAVE, 0, 0, this.wave);
    this.setState(ST.COUNTDOWN);
    this.cdTicks = cd;
  }

  spawnRocks() {
    const n = Math.min(3 + this.wave, 7), spd = Math.min(0.55 + 0.1 * this.wave, 1.6);
    for (let i = 0; i < n; i++) {
      let x, y;
      do { x = rand(0, W); y = rand(0, W); } while (Math.hypot(dlt(x, 128), dlt(y, 128)) < 64);
      const a = rand(0, TAU), v = spd * rand(0.6, 1.2);
      this.rocks.push({ x, y, vx: Math.sin(a) * v, vy: Math.cos(a) * v, size: 2, shape: i & 3 });
    }
  }

  gameOver() {
    this.event(E.OVER, 0, 0, this.wave);
    const result = { ranked: this.ranked, wave: this.wave, score: this.score, ships: this.inRun() };
    this.hooks.log(`run ${this.run} over: wave ${this.wave}, ${this.score} points`);
    if (this.hooks.onRunEnd) this.hooks.onRunEnd(this, result);
    for (const p of this.ships.values()) { p.inRun = false; p.alive = false; }
    this.rosterDirty = true;
    this.setState(ST.OVER);
  }

  // ---- ships ----------------------------------------------------------------------------------
  killShip(p) {
    if (!p.alive) return;
    p.alive = false; p.deaths++;
    this.event(E.SHIP, p.x, p.y, p.id);
    this.rosterDirty = true;
    if (this.lives > 0) { this.lives--; p.respawn = C.RESPAWN; } else p.respawn = -1;
  }

  safeAt(x, y, r) {
    return !this.rocks.some((k) => Math.hypot(dlt(k.x, x), dlt(k.y, y)) < C.RADIUS[k.size] + r) &&
      !(this.ufo && Math.hypot(dlt(this.ufo.x, x), dlt(this.ufo.y, y)) < 40);
  }

  stepShip(p, allowFire) {
    if (!p.alive) {
      if (p.respawn > 0) p.respawn--;
      if (p.respawn === 0 || (p.respawn < 0 && p.free)) {
        const ok = this.safeAt(128, 128, 34);
        p.waited = (p.waited || 0) + 1;
        if (ok || p.waited > 90 || p.free) {
          const k = this.inRun().filter((q) => q.alive).length;
          [p.x, p.y] = this.spawnPos(k, k + 1);
          p.vx = p.vy = 0; p.alive = true; p.respawn = -1; p.invuln = C.INVULN; p.free = false; p.waited = 0;
          if (!this.safeAt(p.x, p.y, 14)) p.invuln = C.INVULN * 2;
        }
      }
      return;
    }
    if (p.bot) this.think(p);
    if (this.lastNow - p.lastMsg > C.MSG_STALE_MS && !p.bot) p.input = 0;
    p.thrust = !!(p.input & 4);
    if (p.thrust) { p.vx += sinA(p.ang) * C.ACC; p.vy += cosA(p.ang) * C.ACC; }
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > C.VMAX) { p.vx *= C.VMAX / sp; p.vy *= C.VMAX / sp; }
    p.vx *= C.DRAG; p.vy *= C.DRAG;
    p.x = wrap(p.x + p.vx); p.y = wrap(p.y + p.vy);
    if (p.invuln > 0) p.invuln--;
    if (p.cool > 0) p.cool--;
    if (allowFire) {
      const want = (p.input & 8) || p.pendShots > 0;
      if (want && p.cool === 0 && this.bul.filter((b) => b.owner === p.id).length < C.SHIP_BUL && this.bul.length < C.MAX_BUL) {
        const fx = sinA(p.ang), fy = cosA(p.ang);
        this.bul.push({ x: wrap(p.x + fx * 8), y: wrap(p.y + fy * 8), vx: p.vx + fx * C.BUL_SPEED, vy: p.vy + fy * C.BUL_SPEED, life: C.BUL_LIFE, owner: p.id });
        p.cool = 3;
        if (p.pendShots > 0) p.pendShots--;
      } else if (p.pendShots > 0 && p.cool === 0) p.pendShots = 0;
      if (p.pendHyper > 0) {
        p.pendHyper = 0;
        p.x = rand(0, W); p.y = rand(0, W); p.vx = p.vy = 0; p.invuln = 10;
        if (Math.random() < 0.12) this.killShip(p);
      }
    } else { p.pendShots = 0; p.pendHyper = 0; }
  }

  // the wingman: shoots the nearest rock it is lined up on, steps out of the way of anything close
  think(p) {
    let best = null, bd = 1e9;
    const targets = this.rocks.map((k) => ({ x: k.x, y: k.y, vx: k.vx, vy: k.vy, r: C.RADIUS[k.size] }));
    if (this.ufo) targets.push({ x: this.ufo.x, y: this.ufo.y, vx: this.ufo.vx, vy: this.ufo.vy, r: 8 });
    let danger = null, dd = 1e9;
    for (const t of targets) {
      const d = Math.hypot(dlt(t.x, p.x), dlt(t.y, p.y));
      if (d < bd) { bd = d; best = t; }
      if (d - t.r < 30 && d - t.r < dd) { dd = d - t.r; danger = t; }
    }
    p.input = 0;
    let want = p.ang;
    if (danger) {
      const away = angTo(-dlt(danger.x, p.x), -dlt(danger.y, p.y));
      want = away;
      if (Math.abs(adiff(away, p.ang)) < 40) p.input |= 4;
    } else if (best) {
      const t = bd / C.BUL_SPEED;
      want = angTo(dlt(best.x, p.x) + (best.vx - p.vx) * t, dlt(best.y, p.y) + (best.vy - p.vy) * t);
      if (Math.abs(adiff(want, p.ang)) < 10 && bd < 105) p.input |= 8;
      if (bd > 120 && Math.hypot(p.vx, p.vy) < 1 && Math.abs(adiff(want, p.ang)) < 20 && Math.random() < 0.3) p.input |= 4;
    }
    const d = adiff(want, p.ang);
    p.ang = (p.ang + clamp(d, -11, 11) + 256) & 255;
    if (danger && Math.abs(adiff(want, p.ang)) < 40) p.input |= 4;
  }

  // ---- rocks and the saucer -----------------------------------------------------------------------------
  addScore(p, pts) {
    if (p) { p.score += pts; this.rosterDirty = true; }
    this.score += pts;
    while (this.score >= this.nextLife * C.EXTRA_LIFE) {
      this.nextLife++;
      if (this.lives < 99) this.lives++;
      this.event(E.LIFE);
    }
  }

  breakRock(k, shooter) {
    this.rocks.splice(this.rocks.indexOf(k), 1);
    this.event(E.ROCK, k.x, k.y, k.size);
    if (shooter) { shooter.rocksHit++; this.addScore(shooter, C.POINTS[k.size]); } else this.addScore(null, C.POINTS[k.size]);
    if (k.size > 0) {
      const a = rand(0, TAU), sp = Math.hypot(k.vx, k.vy) * 1.15 + 0.5;
      for (const s of [1, -1]) {
        if (this.rocks.length >= C.MAX_ROCKS) break;
        this.rocks.push({ x: k.x, y: k.y, vx: k.vx * 0.6 + Math.sin(a) * sp * 0.6 * s, vy: k.vy * 0.6 + Math.cos(a) * sp * 0.6 * s, size: k.size - 1, shape: (k.shape + (s > 0 ? 1 : 2)) & 3 });
      }
    }
  }

  spawnUfo() {
    const small = this.score > 3000 && Math.random() < 0.55;
    const dir = Math.random() < 0.5 ? 1 : -1;
    this.ufo = { x: dir > 0 ? -4 : W + 4, y: rand(30, 226), vx: dir * (small ? 2 : 1.4), vy: 0, kind: small ? 2 : 1, shoot: 24, turn: 20 };
    this.event(E.UFO, this.ufo.x, this.ufo.y, this.ufo.kind);
  }

  stepUfo() {
    const u = this.ufo;
    if (!u) {
      if (this.rocks.length && --this.ufoTimer <= 0) this.spawnUfo();
      return;
    }
    u.x += u.vx; u.y = wrap(u.y + u.vy);
    if (u.x < -8 || u.x > W + 8) { this.ufo = null; this.ufoTimer = Math.round(rand(350, 600)); return; }
    if (--u.turn <= 0) { u.vy = [-1, 0, 1][Math.floor(Math.random() * 3)] * 0.8; u.turn = Math.round(rand(14, 30)); }
    if (--u.shoot <= 0 && this.bul.length < C.MAX_BUL) {
      u.shoot = u.kind === 2 ? 15 : 22;
      let a = Math.floor(Math.random() * 256);
      const live = this.inRun().filter((p) => p.alive);
      if (u.kind === 2 && live.length) {
        let t = live[0], bd = 1e9;
        for (const p of live) { const d = Math.hypot(dlt(p.x, u.x), dlt(p.y, u.y)); if (d < bd) { bd = d; t = p; } }
        a = (angTo(dlt(t.x, u.x), dlt(t.y, u.y)) + Math.round(rand(-1, 1) * Math.max(3, 18 - this.score / 1500)) + 256) & 255;
      }
      this.bul.push({ x: u.x, y: u.y, vx: sinA(a) * 4.5, vy: cosA(a) * 4.5, life: 24, owner: 0, hostile: true });
    }
  }

  // ---- one tick of the world ------------------------------------------------------------------------
  stepWorld() {
    this.lastNow = Date.now();
    for (const p of this.inRun()) this.stepShip(p, this.state === ST.RUN);
    if (this.state !== ST.RUN) return;
    for (const k of this.rocks) { k.x = wrap(k.x + k.vx); k.y = wrap(k.y + k.vy); }
    this.stepUfo();
    const keep = [];
    for (const b of this.bul) {
      const ox = b.x, oy = b.y;
      b.x = wrap(b.x + b.vx); b.y = wrap(b.y + b.vy);
      if (--b.life <= 0) continue;
      let dead = false;
      if (!b.hostile) {
        for (const k of this.rocks) {
          if (segDist(ox, oy, b.x, b.y, k.x, k.y) < C.RADIUS[k.size] + 1) { this.breakRock(k, this.ships.get(b.owner)); dead = true; break; }
        }
        if (!dead && this.ufo && segDist(ox, oy, b.x, b.y, this.ufo.x, this.ufo.y) < (this.ufo.kind === 2 ? 5 : 8)) {
          const sh = this.ships.get(b.owner);
          this.event(E.UFO_DIE, this.ufo.x, this.ufo.y, this.ufo.kind);
          if (sh) sh.ufosHit++;
          this.addScore(sh, this.ufo.kind === 2 ? 1000 : 200);
          this.ufo = null; this.ufoTimer = Math.round(rand(350, 600)); dead = true;
        }
      } else {
        for (const p of this.inRun()) {
          if (p.alive && p.invuln <= 0 && segDist(ox, oy, b.x, b.y, p.x, p.y) < C.SHIP_R + 1) { this.killShip(p); dead = true; break; }
        }
      }
      if (!dead) keep.push(b);
    }
    this.bul = keep;
    for (const p of this.inRun()) {
      if (!p.alive || p.invuln > 0) continue;
      const hit = this.rocks.find((k) => Math.hypot(dlt(k.x, p.x), dlt(k.y, p.y)) < C.RADIUS[k.size] + C.SHIP_R - 1);
      if (hit) { this.breakRock(hit, null); this.killShip(p); continue; }
      if (this.ufo && Math.hypot(dlt(this.ufo.x, p.x), dlt(this.ufo.y, p.y)) < 10) {
        this.event(E.UFO_DIE, this.ufo.x, this.ufo.y, this.ufo.kind);
        this.addScore(null, 0);
        this.ufo = null; this.ufoTimer = Math.round(rand(350, 600));
        this.killShip(p);
      }
    }
    if (!this.rocks.length && !this.ufo) { this.bul = []; this.nextWave(C.CD_WAVE); return; }
    const flying = this.inRun().some((p) => p.alive || p.respawn > 0 || p.free);
    if (!flying) this.gameOver();
  }

  // ---- the clock -----------------------------------------------------------------------------------
  step() {
    const now = Date.now();
    this.lastNow = now;
    this.tick++;
    this.stateTicks++;
    if (this.state === ST.LOBBY) {
      if (this.humans.some((p) => p.inGame)) this.startRun();
    } else if (this.state === ST.COUNTDOWN) {
      this.joinLate();
      this.stepWorld();
      if (this.stateTicks >= this.cdTicks) { this.event(E.WAVE, 0, 0, this.wave); this.setState(ST.RUN); }
    } else if (this.state === ST.RUN) {
      this.joinLate();
      this.stepWorld();
    } else if (this.state === ST.OVER) {
      if (this.stateTicks >= C.OVER_TICKS) this.startRun();
    }
    if (this.state !== ST.LOBBY && !this.humans.some((p) => p.inGame || p.inRun)) {       // everyone went back to the title screen
      for (const b of this.bots) this.removeShip(b);
      this.rocks = []; this.bul = []; this.ufo = null;
      this.setState(ST.LOBBY);
    }
    this.send(now);
  }

  // a console that pressed start while a run is on flies in at once
  joinLate() {
    for (const p of this.humans) if (p.inGame && !p.inRun && this.state !== ST.OVER) { this.enter(p); this.checkRoster(); this.rosterDirty = true; }
  }

  // ---- what we send ------------------------------------------------------------------------------------
  cd() { return this.state === ST.COUNTDOWN ? Math.max(0, this.cdTicks - this.stateTicks) : 0; }
  shipList() {
    return this.inRun().filter((p) => p.alive).map((p) => [p.id, Math.round(p.x) & 255, Math.round(p.y) & 255, p.ang & 255,
      F.ALIVE | (p.thrust ? F.THRUST : 0) | (p.invuln > 0 ? F.SAFE : 0) | (p.bot ? F.BOT : 0),
      clamp(Math.round(p.vx * 8), -127, 127), clamp(Math.round(p.vy * 8), -127, 127)]);
  }
  body() {
    const q = (v) => clamp(Math.round(v * 8), -127, 127);
    return {
      seq: this.tick, st: this.state, cd: this.cd(), wave: this.wave, lives: Math.min(255, this.lives), score: this.score,
      np: this.inRun().length || this.size, ships: this.shipList(),
      rocks: this.rocks.map((k) => [Math.round(k.x) & 255, Math.round(k.y) & 255, (k.size << 2) | k.shape, q(k.vx), q(k.vy)]),
      bul: this.bul.map((b) => [Math.round(b.x) & 255, Math.round(b.y) & 255, q(b.vx), q(b.vy)]),
      ufo: this.ufo ? [Math.round(this.ufo.x) & 255, Math.round(this.ufo.y) & 255, q(this.ufo.vx), q(this.ufo.vy), this.ufo.kind] : null,
      ev: this.events, tick_ms: C.TICK_MS,
    };
  }

  send(now) {
    const base = { t: 'snap', ...this.body() };
    for (const p of this.humans) {
      if (!p.ws) continue;
      this.hooks.send(p.ws, JSON.stringify({ ...base, you: { id: p.id, alive: p.alive ? 1 : 0, inRun: p.inRun ? 1 : 0 } }));
    }
    this.hooks.toMonitors({ ...base, t: 'ast', room: this.name });
    if (this.rosterDirty && now - this.lastRoster > 400) this.sendRoster(now);
  }

  rosterList() {
    return [...this.ships.values()].sort((a, b) => a.id - b.id)
      .map((p) => [p.id, p.bot ? F.BOT : 0, Math.min(65535, Math.floor(p.score / 10)), Math.min(65535, p.rocksHit), p.name]);
  }
  sendRoster(now) {
    this.lastRoster = now;
    this.rosterDirty = false;
    this.rosterSeq++;
    const msg = JSON.stringify({ t: 'roster', seq: this.rosterSeq, rk: 0, players: this.rosterList() });
    for (const p of this.humans) if (p.ws) this.hooks.send(p.ws, msg);
    this.hooks.toMonitors({ t: 'sroster', room: this.name, players: this.rosterList() });
  }

  monitorFull() { return [{ t: 'ast', room: this.name, full: true, ...this.body() }]; }

  info() {
    return [...this.ships.values()].sort((a, b) => b.score - a.score || a.id - b.id).map((p) => ({
      slot: p.id, name: p.name, bot: p.bot, cart: p.bot ? 'bot' : 'uvmc2', score: p.score, rocks: p.rocksHit, deaths: p.deaths,
      account: !!p.userId, alive: p.alive, inGame: p.inGame, rtt: p.rtt, rttHist: p.rttHist, inHz: p.inHz, frame: p.frame,
      since: p.since, bstat: p.bstat, lastAge: p.bot ? 0 : (p.lastMsg ? Date.now() - p.lastMsg : null),
    }));
  }
}

module.exports = { RockRoom, C, F, E, ST, cleanName };

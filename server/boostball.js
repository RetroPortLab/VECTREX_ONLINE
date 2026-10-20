// VECTOR BALL: rocket-car football, run on the server. Two teams of up to three cars play on a
// 240 x 136 pitch with a goal at each end, one big ball and boost pads. Humans drive; empty seats
// are filled by bots so every match is at least 2 against 2.
//
// The server is the referee: every tick (60 ms, three 20 ms physics steps) it drives every car and
// the ball, settles bumps, kicks, demolitions and goals, and sends one snapshot. A console says
// only what the stick and buttons are doing and which way its car points (the heading comes from
// the console, so steering feels instant); it draws what the server sends back, extrapolating
// between snapshots.
//
// Field coordinates are 0..255 (screen = field - 128, y up). The pitch is x 8..248, y 60..196,
// the goals are in the middle of the two short ends. An angle is 0..255 round the circle, 0 = up
// and 64 = right (clockwise), the same as the console's sine table. Team 0 defends the west goal
// and kicks off facing east; team 1 the other way round.

const C = {
  TICK_MS: 60, SUB: 3, DT: 0.02,
  X0: 8, X1: 248, Y0: 60, Y1: 196, CX: 128, CY: 128, GOAL_HALF: 22,
  CAR_R: 7, BALL_R: 7, POST_R: 3,
  MAX: 6, TEAM_MAX: 3, TEAM_MIN: 2,
  ACC: 120, REV_ACC: 80, VMAX: 95, REV_MAX: 45, BOOST_ACC: 270, BOOST_VMAX: 150, BOOST_USE: 36, BOOST_START: 33, BOOST_MAX: 100,
  DRAG: 0.45, COAST: 1.1, GRIP: 14, GRIP_HB: 2.2,
  BALL_DRAG: 0.42, BALL_VMAX: 230, BALL_E: 0.74, WALL_E: 0.72, KICK: 16, KICK_BOOST: 38, M_BALL: 1, M_CAR: 2.6,
  DEMO_SPEED: 88, DEMO_TICKS: 36,
  MATCH_S: 180, OT_S: 90, CD_START: 54, CD_KICK: 40, GOAL_TICKS: 45, OVER_TICKS: 100, MSG_STALE_MS: 700,
  PAD_R: 10,
};
const PADS = [[40, 80, 100, 160], [216, 80, 100, 160], [40, 176, 100, 160], [216, 176, 100, 160], [128, 66, 30, 66], [128, 190, 30, 66]];   // x, y, boost, respawn ticks
const F = { ALIVE: 1, BOOST: 2, TEAM: 4, BOT: 8 };
const E = { GOAL: 1, KICK: 2, DEMO: 3, PAD: 4, JOIN: 5, LEAVE: 6, WHISTLE: 7, END: 8, SAVE: 9, BIGKICK: 10 };
const ST = { LOBBY: 0, COUNTDOWN: 1, RUN: 2, GOAL: 3, OVER: 4 };
const BOT_NAMES = [['ACE', 'BLITZ', 'COBRA'], ['DRIFT', 'EMBER', 'FLUX']];
const TAU = Math.PI * 2;
const IN = { LEFT: 1, RIGHT: 2, UP: 4, DOWN: 8, BOOST: 16, HBRAKE: 32 };

const cleanName = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9 ._-]/g, '').trim().slice(0, 8);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const sinA = (a) => Math.sin((a & 255) * TAU / 256);
const cosA = (a) => Math.cos((a & 255) * TAU / 256);
const angTo = (dx, dy) => (Math.round(Math.atan2(dx, dy) * 256 / TAU) % 256 + 256) % 256;
const adiff = (a, b) => ((a - b + 128) % 256 + 256) % 256 - 128;
const byte = (v) => clamp(Math.round(v), 0, 255);

class BallRoom {
  constructor(name, hooks) {
    this.name = name;
    this.hooks = hooks;           // { send(ws, str), toMonitors(msg), log(text, level), onMatchEnd(room, result), onLeave(room, p, info) }
    this.cars = new Map();        // id -> car (humans and bots)
    this.ball = { x: C.CX, y: C.CY, vx: 0, vy: 0, goal: false, touches: [] };
    this.pads = PADS.map(([x, y, amt, rt]) => ({ x, y, amt, rt, on: true, t: 0 }));
    this.state = ST.LOBBY;
    this.tick = 0; this.stateTicks = 0; this.cdTicks = 0;
    this.sa = 0; this.sb = 0; this.clockTicks = 0; this.ot = false; this.otTicks = 0;
    this.match = 0; this.winner = 2;
    this.events = []; this.evtId = 0;
    this.minTeam = C.TEAM_MIN;
    this.rosterSeq = 0; this.rosterDirty = true; this.lastRoster = 0;
    this.ranked = false;
    this.timer = setInterval(() => this.step(), C.TICK_MS);
  }

  close() { clearInterval(this.timer); }
  get humans() { return [...this.cars.values()].filter((p) => !p.bot); }
  get bots() { return [...this.cars.values()].filter((p) => p.bot); }
  get empty() { return this.humans.length === 0; }
  get size() { return this.cars.size; }
  inMatch() { return [...this.cars.values()].filter((p) => p.inMatch); }
  team(t) { return [...this.cars.values()].filter((p) => p.team === t); }
  humansOn(t) { return this.team(t).filter((p) => !p.bot); }

  freeId() { for (let i = 1; i <= C.MAX; i++) if (!this.cars.has(i)) return i; return 0; }

  event(kind, x = 0, y = 0, a = 0, b = 0) {
    this.evtId = (this.evtId % 255) + 1;
    this.events.push([this.evtId, kind, byte(x), byte(y), a & 255, b & 255]);
    if (this.events.length > 8) this.events.shift();
  }

  newCar(id, name, bot, team) {
    return {
      id, name, bot, team, ws: null, ip: '', userId: null, league: null,
      inGame: bot, inMatch: false, alive: false, demoT: 0,
      x: C.CX, y: C.CY, vx: 0, vy: 0, ang: team ? 192 : 64, input: 0, boost: C.BOOST_START, boosting: false,
      goals: 0, assists: 0, saves: 0, demos: 0, own: 0, touches: 0, saveCool: 0, stuck: 0, rev: 0, joinedAt: 0,
      since: Date.now(), inCount: 0, inHz: 0, rtt: null, rttHist: [], pings: new Map(), bstat: null, lastMsg: 0, frame: 0, fl: 0,
    };
  }

  // ---- people ---------------------------------------------------------------------------------
  pickTeam() {
    const h = [this.humansOn(0).length, this.humansOn(1).length];
    const cand = [0, 1].filter((t) => h[t] < C.TEAM_MAX);
    if (!cand.length) return -1;
    cand.sort((a, b) => h[a] - h[b] || this.team(a).length - this.team(b).length || a - b);
    return cand[0];
  }

  join(ws, name, ip, user = null) {
    const team = this.pickTeam();
    if (team < 0) return null;
    const bots = this.team(team).filter((p) => p.bot);
    if (this.team(team).length >= C.TEAM_MAX && bots.length) this.removeCar(bots[bots.length - 1]);
    const id = this.freeId();
    if (!id) return null;
    const p = this.newCar(id, (user ? cleanName(user.callsign) : cleanName(name)) || `P${id}`, false, team);
    p.ws = ws; p.ip = ip; p.userId = user ? user.id : null;
    this.cars.set(id, p);
    this.event(E.JOIN, 0, 0, id, team);
    this.rosterDirty = true;
    this.hooks.log(`P${id} ${p.name} joined team ${team ? 'B' : 'A'}`);
    return p;
  }

  leave(p) {
    if (this.cars.get(p.id) !== p) return;
    if (p.inMatch && this.state !== ST.OVER && this.hooks.onLeave) this.hooks.onLeave(this, p, this.leaveInfo(p));
    this.removeCar(p);
    this.event(E.LEAVE, 0, 0, p.id);
    this.hooks.log(`P${p.id} ${p.name} left`, 'warn');
    this.checkRoster();
  }

  leaveInfo(p) {
    const mine = p.team ? this.sb : this.sa, theirs = p.team ? this.sa : this.sb;
    return { team: p.team, mine, theirs, behind: mine <= theirs, rated: this.leagueEligible(), bothSides: this.humansOn(0).length > 0 && this.humansOn(1).length > 0 };
  }

  removeCar(p) {
    this.cars.delete(p.id);
    this.rosterDirty = true;
  }

  addBot(team) {
    const id = this.freeId();
    if (!id) return null;
    const used = new Set([...this.cars.values()].map((p) => p.name));
    const name = BOT_NAMES[team].find((n) => !used.has(n)) || `BOT${id}`;
    const p = this.newCar(id, name, true, team);
    this.cars.set(id, p);
    this.event(E.JOIN, 0, 0, id, team);
    this.rosterDirty = true;
    return p;
  }

  setBots(n) { this.minTeam = clamp(n | 0, 1, C.TEAM_MAX); this.checkRoster(); }
  addBotManual(d) { this.setBots(this.minTeam + (d > 0 ? 1 : -1)); }

  // every team plays at least minTeam strong; a bot gives its seat to a human
  checkRoster() {
    if (this.state === ST.LOBBY) return;
    if (!this.humans.some((p) => p.inMatch)) return;
    for (const t of [0, 1]) {
      const want = clamp(Math.max(this.minTeam, this.humansOn(t).length), 1, C.TEAM_MAX);
      let cars = this.team(t);
      while (cars.length > want && cars.some((p) => p.bot)) { this.removeCar(cars.filter((p) => p.bot).pop()); cars = this.team(t); }
      while (cars.length < want && this.cars.size < C.MAX) {
        const b = this.addBot(t);
        if (!b) break;
        this.enter(b);
        cars = this.team(t);
      }
    }
  }

  // ---- what consoles tell us ------------------------------------------------------------------------
  fromBridge(p, m, now) {
    if (m.t !== 'bb') return;
    p.inGame = !!((m.fl | 0) & 8);
    p.frame = m.f | 0;
    p.fl = m.fl | 0;
    p.lastMsg = now;
    p.inCount++;
    p.input = (m.in | 0) & 63;
    if (this.state === ST.RUN || this.state === ST.GOAL) p.ang = (m.a | 0) & 255;
    if (!p.inGame && p.inMatch) this.dropFromMatch(p);
  }

  dropFromMatch(p) {
    if (p.inMatch && this.hooks.onLeave && this.state !== ST.OVER) this.hooks.onLeave(this, p, this.leaveInfo(p));
    p.inMatch = false; p.alive = false;
    this.rosterDirty = true;
    this.checkRoster();
  }

  // ---- a match ------------------------------------------------------------------------------------
  setState(s) { this.state = s; this.stateTicks = 0; }
  leagueEligible() { return this.humansOn(0).some((p) => p.userId && p.inMatch) && this.humansOn(1).some((p) => p.userId && p.inMatch); }

  // kick-off spots: new random ones every kick-off, the same for both sides (team B is the point-mirror of team A)
  newLayout() {
    const slots = [];
    for (let tries = 0; slots.length < 3 && tries < 60; tries++) {
      const dx = 46 + Math.random() * 54, y = 74 + Math.random() * 108;
      if (slots.every((q) => Math.hypot(q[0] - dx, q[1] - y) >= 30)) slots.push([Math.round(dx), Math.round(y)]);
    }
    while (slots.length < 3) slots.push([60, 90 + slots.length * 36]);
    this.layout = slots;
  }

  spawnSpot(p) {
    if (!this.layout) this.newLayout();
    const mates = this.team(p.team).filter((q) => q.inMatch).sort((a, b) => a.id - b.id);
    const [dx, y] = this.layout[Math.min(2, Math.max(0, mates.indexOf(p)))];
    return p.team ? [C.CX + dx, 2 * C.CY - y] : [C.CX - dx, y];
  }

  enter(p) {                       // a car joins the match (at the start, or later)
    p.inMatch = true; p.goals = p.assists = p.saves = p.demos = p.own = p.touches = 0; p.joinedAt = this.tick;
    this.placeCar(p);
    if (this.state === ST.RUN || this.state === ST.GOAL) { p.alive = false; p.demoT = 14; }
  }

  placeCar(p) {
    [p.x, p.y] = this.spawnSpot(p);
    p.vx = p.vy = 0; p.ang = p.team ? 192 : 64; p.boost = C.BOOST_START; p.boosting = false; p.alive = true; p.demoT = 0; p.rev = 0; p.stuck = 0;
  }

  kickoff() {
    this.newLayout();
    for (const p of this.inMatch()) this.placeCar(p);
    const b = this.ball;
    b.x = C.CX; b.y = C.CY; b.vx = b.vy = 0; b.goal = false; b.touches = [];
    this.cdTicks = C.CD_KICK;
    this.setState(ST.COUNTDOWN);
    this.event(E.WHISTLE);
  }

  startMatch() {
    const ps = this.humans.filter((p) => p.inGame);
    if (!ps.length) { this.setState(ST.LOBBY); return; }
    this.match++;
    this.sa = this.sb = 0; this.ot = false; this.winner = 2;
    this.clockTicks = Math.round(C.MATCH_S * 1000 / C.TICK_MS);
    for (const p of this.cars.values()) { p.inMatch = false; p.alive = false; }
    for (const p of ps) this.enter(p);
    for (const b of this.bots) this.enter(b);
    this.state = ST.COUNTDOWN;       // checkRoster only works inside a match
    this.checkRoster();
    for (const pad of this.pads) { pad.on = true; pad.t = 0; }
    this.ranked = ps.length >= 2;
    this.kickoff();
    this.cdTicks = C.CD_START;
    this.hooks.log(`match ${this.match}: ${ps.length} console(s)${this.ranked ? '' : ' (practice: one console)'}`);
  }

  endMatch() {
    this.winner = this.sa > this.sb ? 0 : this.sb > this.sa ? 1 : 2;
    this.event(E.END, 0, 0, this.winner);
    const cars = this.inMatch();
    const result = {
      ranked: this.ranked, sa: this.sa, sb: this.sb, winner: this.winner, overtime: this.ot, cars,
      humans: cars.filter((p) => !p.bot).length, leagueRated: this.leagueEligible(),
    };
    this.hooks.log(`match ${this.match} over: ${this.sa}-${this.sb}${this.ot ? ' (overtime)' : ''}`);
    if (this.hooks.onMatchEnd) this.hooks.onMatchEnd(this, result);
    this.rosterDirty = true;
    this.setState(ST.OVER);
  }

  // ---- physics -------------------------------------------------------------------------------------------
  stepCar(p, live, dt) {
    if (!p.alive) return;
    const fx = sinA(p.ang), fy = cosA(p.ang);
    let fwd = p.vx * fx + p.vy * fy;
    let lat = p.vx * fy - p.vy * fx;                      // along the car's right-hand side
    const inp = p.input;
    p.boosting = false;
    if (live) {
      if (inp & IN.UP) { if (fwd < C.VMAX) fwd += C.ACC * dt; }
      else if (inp & IN.DOWN) { if (fwd > -C.REV_MAX) fwd -= (fwd > 0 ? C.ACC : C.REV_ACC) * dt; }
      else fwd *= Math.exp(-C.COAST * dt);
      if ((inp & IN.BOOST) && p.boost > 0 && fwd < C.BOOST_VMAX) {
        fwd += C.BOOST_ACC * dt; p.boost = Math.max(0, p.boost - C.BOOST_USE * dt); p.boosting = true;
      }
    } else fwd *= Math.exp(-3 * dt);
    if (fwd > C.VMAX && !p.boosting) fwd -= (fwd - C.VMAX) * Math.min(1, 2.5 * dt);
    fwd *= Math.exp(-C.DRAG * dt * 0.3);
    lat *= Math.exp(-((inp & IN.HBRAKE) ? C.GRIP_HB : C.GRIP) * dt);
    p.vx = fwd * fx + lat * fy; p.vy = fwd * fy - lat * fx;
    p.x += p.vx * dt; p.y += p.vy * dt;
    const r = C.CAR_R;
    if (p.x < C.X0 + r) { p.x = C.X0 + r; if (p.vx < 0) p.vx *= -0.3; }
    if (p.x > C.X1 - r) { p.x = C.X1 - r; if (p.vx > 0) p.vx *= -0.3; }
    if (p.y < C.Y0 + r) { p.y = C.Y0 + r; if (p.vy < 0) p.vy *= -0.3; }
    if (p.y > C.Y1 - r) { p.y = C.Y1 - r; if (p.vy > 0) p.vy *= -0.3; }
  }

  carCar(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = C.CAR_R * 2;
    if (d >= min || d < 1e-6) return;
    const nx = dx / d, ny = dy / d;
    const push = (min - d) / 2;
    a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
    const vr = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (vr >= 0) return;
    // a boosting car ramming an enemy at speed demolishes it
    if (a.team !== b.team) {
      const ca = -(a.vx * nx + a.vy * ny) * -1, cb = b.vx * nx + b.vy * ny;       // closing speed of each along the normal
      if (a.boosting && ca > C.DEMO_SPEED * 0.6 && -vr > C.DEMO_SPEED) return this.demolish(b, a);
      if (b.boosting && -cb > C.DEMO_SPEED * 0.6 && -vr > C.DEMO_SPEED) return this.demolish(a, b);
    }
    const j = -(1 + 0.5) * vr / 2;
    a.vx -= j * nx; a.vy -= j * ny; b.vx += j * nx; b.vy += j * ny;
  }

  demolish(victim, by) {
    victim.alive = false; victim.demoT = C.DEMO_TICKS; victim.vx = victim.vy = 0;
    by.demos++;
    this.event(E.DEMO, victim.x, victim.y, victim.id, by.id);
    this.rosterDirty = true;
  }

  carBall(p) {
    const b = this.ball;
    const dx = b.x - p.x, dy = b.y - p.y, d = Math.hypot(dx, dy), min = C.CAR_R + C.BALL_R;
    if (d >= min || d < 1e-6) return;
    const nx = dx / d, ny = dy / d;
    const before = { vx: b.vx, vy: b.vy };
    b.x = p.x + nx * (min + 0.05); b.y = p.y + ny * (min + 0.05);
    const vr = (b.vx - p.vx) * nx + (b.vy - p.vy) * ny;
    if (vr < 0) {
      const j = -(1 + C.BALL_E) * vr / (1 / C.M_BALL + 1 / C.M_CAR);
      b.vx += j * nx / C.M_BALL; b.vy += j * ny / C.M_BALL;
      p.vx -= j * nx / C.M_CAR * 0.35; p.vy -= j * ny / C.M_CAR * 0.35;
    }
    const kick = C.KICK + (p.boosting ? C.KICK_BOOST : 0);
    b.vx += nx * kick; b.vy += ny * kick;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > C.BALL_VMAX) { b.vx *= C.BALL_VMAX / sp; b.vy *= C.BALL_VMAX / sp; }
    this.touch(p, before);
    if (this.tick - (p.lastKick || -99) >= 5) {                       // a dribble is one sound, not twenty
      p.lastKick = this.tick;
      this.event(p.boosting || sp > 160 ? E.BIGKICK : E.KICK, b.x, b.y, Math.min(255, Math.round(sp)), p.id);
    }
  }

  touch(p, before) {
    const b = this.ball;
    p.touches++;
    const last = b.touches[b.touches.length - 1];
    if (!last || last.id !== p.id) b.touches.push({ id: p.id, team: p.team, tick: this.tick });
    else last.tick = this.tick;
    if (b.touches.length > 4) b.touches.shift();
    // a save: the ball was heading for my goal and would have gone in
    if (p.saveCool <= 0) {
      const gx = p.team ? C.X1 : C.X0, toward = p.team ? before.vx > 25 : before.vx < -25;
      if (toward) {
        const t = (gx - b.x) / before.vx;
        const yc = b.y + before.vy * t;
        if (t > 0 && t < 2.4 && Math.abs(yc - C.CY) < C.GOAL_HALF + 8) { p.saves++; p.saveCool = 40; this.event(E.SAVE, p.x, p.y, p.id); this.rosterDirty = true; }
      }
    }
  }

  stepBall(dt) {
    const b = this.ball;
    if (b.goal) return;
    b.vx *= Math.exp(-C.BALL_DRAG * dt); b.vy *= Math.exp(-C.BALL_DRAG * dt);
    b.x += b.vx * dt; b.y += b.vy * dt;
    const r = C.BALL_R, mouth = Math.abs(b.y - C.CY) < C.GOAL_HALF;
    if (b.y < C.Y0 + r) { b.y = C.Y0 + r; if (b.vy < 0) b.vy *= -C.WALL_E; }
    if (b.y > C.Y1 - r) { b.y = C.Y1 - r; if (b.vy > 0) b.vy *= -C.WALL_E; }
    // the goal posts: small fixed circles at the edge of each mouth
    for (const px of [C.X0, C.X1]) for (const py of [C.CY - C.GOAL_HALF, C.CY + C.GOAL_HALF]) {
      const dx = b.x - px, dy = b.y - py, d = Math.hypot(dx, dy), min = r + C.POST_R;
      if (d < min && d > 1e-6) {
        const nx = dx / d, ny = dy / d;
        b.x = px + nx * min; b.y = py + ny * min;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) { b.vx -= (1 + C.WALL_E) * vn * nx; b.vy -= (1 + C.WALL_E) * vn * ny; }
      }
    }
    if (!mouth) {
      if (b.x < C.X0 + r) { b.x = C.X0 + r; if (b.vx < 0) b.vx *= -C.WALL_E; }
      if (b.x > C.X1 - r) { b.x = C.X1 - r; if (b.vx > 0) b.vx *= -C.WALL_E; }
    } else {
      if (b.x < C.X0 - r * 0.6) this.scored(1);
      else if (b.x > C.X1 + r * 0.6) this.scored(0);
    }
  }

  scored(team) {
    if (this.state !== ST.RUN) return;
    const b = this.ball;
    b.goal = true; b.vx = b.vy = 0;
    if (team) this.sb++; else this.sa++;
    const last = b.touches[b.touches.length - 1];
    let scorer = 0;
    if (last && last.team === team) {
      const p = this.cars.get(last.id);
      if (p) { p.goals++; scorer = p.id; }
      const prev = b.touches.slice(0, -1).reverse().find((t) => t.team === team && t.id !== last.id && this.tick - t.tick < 90);
      if (prev) { const q = this.cars.get(prev.id); if (q) q.assists++; }
    } else if (last) {
      const p = this.cars.get(last.id);
      if (p) p.own++;
    }
    this.event(E.GOAL, b.x, b.y, team, scorer);
    this.rosterDirty = true;
    this.hooks.log(`goal for team ${team ? 'B' : 'A'}: ${this.sa}-${this.sb}`);
    if (this.ot) { this.endMatch(); return; }
    this.setState(ST.GOAL);
  }

  pickPads() {
    for (const pad of this.pads) {
      if (!pad.on) { if (--pad.t <= 0) pad.on = true; continue; }
      for (const p of this.cars.values()) {
        if (!p.alive || p.boost >= C.BOOST_MAX) continue;
        if (Math.hypot(p.x - pad.x, p.y - pad.y) < C.CAR_R + C.PAD_R) {
          p.boost = Math.min(C.BOOST_MAX, p.boost + pad.amt);
          pad.on = false; pad.t = pad.rt;
          this.event(E.PAD, pad.x, pad.y, this.pads.indexOf(pad), p.id);
          break;
        }
      }
    }
  }

  // live: the cars drive; ballLive: the ball is in play (in a goal celebration the cars still drive)
  stepWorld(live, ballLive) {
    this.lastNow = Date.now();
    const cars = this.inMatch();
    for (const p of cars) {
      if (!p.alive && p.demoT > 0 && --p.demoT === 0) { this.placeCar(p); }
      if (p.saveCool > 0) p.saveCool--;
      if (p.alive && p.bot) this.think(p);
      else if (!p.bot && this.lastNow - p.lastMsg > C.MSG_STALE_MS) p.input = 0;
    }
    for (let s = 0; s < C.SUB; s++) {
      for (const p of cars) this.stepCar(p, live, C.DT);
      const alive = cars.filter((p) => p.alive);
      for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) if (alive[i].alive && alive[j].alive) this.carCar(alive[i], alive[j]);
      if (ballLive) {
        for (const p of alive) if (p.alive && !this.ball.goal) this.carBall(p);
        this.stepBall(C.DT);
        if (this.state !== ST.RUN) break;           // a goal ends the tick's physics
      }
    }
    this.pickPads();
  }

  // ---- the bots -------------------------------------------------------------------------------------------
  think(p) {
    const b = this.ball;
    const ogx = p.team ? C.X1 : C.X0, egx = p.team ? C.X0 : C.X1;
    const mates = this.team(p.team).filter((q) => q.alive);
    let striker = mates[0], bd = 1e9;
    for (const q of mates) { const d = Math.hypot(b.x - q.x, b.y - q.y) - (q.bot ? 0 : 6); if (d < bd) { bd = d; striker = q; } }
    let tx, ty, boostOk = false;
    if (striker === p || mates.length === 1 || Math.hypot(b.x - p.x, b.y - p.y) < 55) {
      let ux = egx - b.x, uy = C.CY - b.y;
      const d = Math.hypot(ux, uy) || 1; ux /= d; uy /= d;
      const along = (p.x - b.x) * ux + (p.y - b.y) * uy;          // < 0: I am on my side of the ball
      const px = -uy, py = ux, lat = (p.x - b.x) * px + (p.y - b.y) * py;
      if (along < -4 && Math.abs(lat) < 26) { tx = b.x + b.vx * 0.12 + ux * 10; ty = b.y + b.vy * 0.12 + uy * 10; boostOk = true; }
      else if (along < -10) { tx = b.x - ux * 20; ty = b.y - uy * 20; }                       // behind it but wide: line up
      else { const s = lat >= 0 ? 1 : -1; tx = b.x - ux * 28 + px * s * 36; ty = b.y - uy * 28 + py * s * 36; }   // on its far side: go round
    } else {
      tx = ogx + (b.x - ogx) * 0.4; ty = C.CY + (b.y - C.CY) * 0.55;
      tx = ogx + clamp(tx - ogx, p.team ? -70 : 14, p.team ? -14 : 70);
    }
    tx = clamp(tx, C.X0 + 10, C.X1 - 10); ty = clamp(ty, C.Y0 + 10, C.Y1 - 10);
    const dx = tx - p.x, dy = ty - p.y, dist = Math.hypot(dx, dy);
    const want = angTo(dx, dy), err = adiff(want, p.ang);
    p.ang = (p.ang + clamp(err, -9, 9) + 256) & 255;
    let inp = 0;
    const sp = Math.hypot(p.vx, p.vy);
    if (p.rev > 0) { p.rev--; inp = IN.DOWN | ((p.id & 1) ? IN.LEFT : IN.RIGHT); }
    else {
      if (Math.abs(err) < 70 || dist > 90) inp |= IN.UP;
      if (Math.abs(err) < 12 && dist > 70 && p.boost > 6 && (boostOk || dist > 130)) inp |= IN.BOOST;
      if (Math.abs(err) > 40 && sp > 60) inp |= IN.HBRAKE;
      if ((inp & IN.UP) && sp < 6) { if (++p.stuck > 24) { p.rev = 14; p.stuck = 0; } } else p.stuck = 0;
    }
    p.input = inp;
  }

  // ---- the clock -----------------------------------------------------------------------------------
  step() {
    const now = Date.now();
    this.lastNow = now;
    this.tick++;
    this.stateTicks++;
    if (this.state === ST.LOBBY) {
      if (this.humans.some((p) => p.inGame)) this.startMatch();
    } else if (this.state === ST.COUNTDOWN) {
      this.joinLate();
      this.stepWorld(false, false);
      if (this.stateTicks >= this.cdTicks) { this.event(E.WHISTLE); this.setState(ST.RUN); }
    } else if (this.state === ST.RUN) {
      this.joinLate();
      this.stepWorld(true, true);
      if (this.state === ST.RUN) {
        if (!this.ot) {
          if (--this.clockTicks <= 0) {
            if (this.sa !== this.sb) this.endMatch();
            else { this.ot = true; this.otTicks = Math.round(C.OT_S * 1000 / C.TICK_MS); this.event(E.WHISTLE); }
          }
        } else if (--this.otTicks <= 0) this.endMatch();
      }
    } else if (this.state === ST.GOAL) {
      this.stepWorld(true, false);
      if (this.stateTicks >= C.GOAL_TICKS) this.kickoff();
    } else if (this.state === ST.OVER) {
      if (this.stateTicks >= C.OVER_TICKS) this.startMatch();
    }
    if (this.state !== ST.LOBBY && !this.humans.some((p) => p.inGame || p.inMatch)) {       // everyone went back to the title screen
      for (const b of this.bots) this.removeCar(b);
      this.setState(ST.LOBBY);
    }
    this.send(now);
  }

  joinLate() {
    for (const p of this.humans) if (p.inGame && !p.inMatch && this.state !== ST.OVER) { this.enter(p); this.checkRoster(); this.rosterDirty = true; }
  }

  // ---- what we send ------------------------------------------------------------------------------------
  cd() { return this.state === ST.COUNTDOWN ? Math.max(0, this.cdTicks - this.stateTicks) : 0; }
  clockSecs() { return this.ot ? 0 : Math.max(0, Math.ceil(this.clockTicks * C.TICK_MS / 1000)); }
  carList() {
    const q = (v) => clamp(Math.round(v * C.TICK_MS / 1000 * 8), -127, 127);        // per tick, x8
    return this.inMatch().filter((p) => p.alive).map((p) => [p.id, byte(p.x), byte(p.y), p.ang & 255,
      F.ALIVE | (p.boosting ? F.BOOST : 0) | (p.team ? F.TEAM : 0) | (p.bot ? F.BOT : 0), q(p.vx), q(p.vy), Math.round(p.boost)]);
  }
  padMask() { return this.pads.reduce((m, p, i) => m | (p.on ? 1 << i : 0), 0); }
  body() {
    const q = (v) => clamp(Math.round(v * C.TICK_MS / 1000 * 8), -127, 127);
    const b = this.ball;
    return {
      seq: this.tick, st: this.state, cd: this.cd(), clock: this.clockSecs(), ot: this.ot ? 1 : 0, sa: Math.min(99, this.sa), sb: Math.min(99, this.sb),
      np: this.inMatch().length || this.size, cars: this.carList(), ball: [byte(b.x), byte(b.y), q(b.vx), q(b.vy), b.goal ? 1 : 0],
      pads: this.padMask(), win: this.state === ST.OVER ? this.winner : 3, ev: this.events, tick_ms: C.TICK_MS,
    };
  }

  send(now) {
    const base = { t: 'snap', ...this.body() };
    for (const p of this.humans) {
      if (!p.ws) continue;
      this.hooks.send(p.ws, JSON.stringify({ ...base, you: { id: p.id, team: p.team, alive: p.alive ? 1 : 0, inMatch: p.inMatch ? 1 : 0 } }));
    }
    this.hooks.toMonitors({ ...base, t: 'bsn', room: this.name });
    if (this.rosterDirty && now - this.lastRoster > 400) this.sendRoster(now);
  }

  rosterList() {
    return [...this.cars.values()].sort((a, b) => a.id - b.id)
      .map((p) => [p.id, (p.bot ? F.BOT : 0) | (p.team ? F.TEAM : 0), Math.min(65535, p.goals), Math.min(65535, p.assists), p.name,
        p.league ? p.league.rating : 0, p.league ? p.league.division : '']);
  }
  sendRoster(now) {
    this.lastRoster = now;
    this.rosterDirty = false;
    this.rosterSeq++;
    const msg = JSON.stringify({ t: 'roster', seq: this.rosterSeq, rk: 0, players: this.rosterList() });
    for (const p of this.humans) if (p.ws) this.hooks.send(p.ws, msg);
    this.hooks.toMonitors({ t: 'sroster', room: this.name, players: this.rosterList() });
  }

  monitorFull() { return [{ t: 'bsn', room: this.name, full: true, ...this.body() }]; }

  info() {
    return [...this.cars.values()].sort((a, b) => b.goals - a.goals || a.id - b.id).map((p) => ({
      slot: p.id, name: p.name, bot: p.bot, team: p.team, cart: p.bot ? 'bot' : 'uvmc2', score: p.goals, goals: p.goals, assists: p.assists, saves: p.saves,
      account: !!p.userId, alive: p.alive, inGame: p.inGame, rtt: p.rtt, rttHist: p.rttHist, inHz: p.inHz, frame: p.frame,
      since: p.since, bstat: p.bstat, lastAge: p.bot ? 0 : (p.lastMsg ? Date.now() - p.lastMsg : null),
      rating: p.league ? p.league.rating : null, division: p.league ? p.league.division : null,
    }));
  }
}

module.exports = { BallRoom, C, F, E, ST, IN, PADS, cleanName };

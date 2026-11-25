// SOCCER: top-down five-a-... no: eleven-a-side football for the ZX Spectrum Next (its Wi-Fi links it
// through the Next gateway). The relay plays the whole match: 22 players, the ball, the referee's
// decisions and the 10 CPU players on each side. A console is a thin client: it sends its stick and
// button and draws what the relay says (players near the ball, the ball, the score and clock, events).
//
//   Next -> relay  'sc' {f, fl, in}        in: 1 left, 2 right, 4 up, 8 fire, 128 down
//   relay -> Next  'snap' (see body()), 'roster'
//
// One human a side: the first console plays side A, the second side B; an empty side is the CPU's, and
// a console that joins mid-match takes the CPU's place at once. Two halves of two minutes; the sides swap.

const TAU = Math.PI * 2;

const C = {
  TICK_MS: 40, DT: 0.04, SUB: 3,
  W: 448, H: 704, X0: 32, X1: 416, Y0: 64, Y1: 640, CX: 224, CY: 352,
  GL: 200, GR: 248, GOAL_DEPTH: 14, BAR: 24,
  RUN: 84, DRIB: 76, SLIDE_V: 150, KEEP_V: 96, SLIDE_T: 12, SLIDE_REC: 16,
  HALF_S: 120, LINEUP_T: 150, GOAL_T: 90, HALF_T: 100, FULL_T: 220, RESTART_MIN: 26,
  HUMANS: 2, TEAMS: 8,
};
const TEAM_NAMES = ['ULTIMATE', 'OCEAN', 'CODEMASTERS', 'HEWSON', 'US GOLD', 'GREMLIN', 'IMAGINE', 'DURELL'];
const ST = { LOBBY: 0, LINEUP: 1, RESTART: 2, PLAY: 3, GOAL: 4, HALF: 5, FULL: 6 };
const RS = { NONE: 0, KICKOFF: 1, THROW: 2, CORNER: 3, GOALKICK: 4 };
const ACT = { RUN: 0, KICK: 1, SLIDE: 2, DOWN: 3, DIVE: 4, THROW: 5, CHEER: 6, HEAD: 7 };
const EV = { KICK: 1, SHOT: 2, BOUNCE: 3, POST: 4, GOAL: 5, WHISTLE: 6, TACKLE: 7, THROW: 8, CATCH: 9, CROWD: 10, HALF: 11, FULL: 12, SLIDE: 13, OUT: 14, START: 15 };
const IN = { LEFT: 1, RIGHT: 2, UP: 4, FIRE: 8, DOWN: 128 };
const DX = [0, 1, 1, 1, 0, -1, -1, -1], DY = [-1, -1, 0, 1, 1, 1, 0, -1];
const ROLE = ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW'];
const HOME = [[0, 0.02], [-0.58, 0.17], [-0.2, 0.15], [0.2, 0.15], [0.58, 0.17], [-0.62, 0.42], [-0.21, 0.40], [0.21, 0.40], [0.62, 0.42], [-0.24, 0.66], [0.24, 0.66]];
const SHIFT = { GK: 0, DF: 0.42, MF: 0.58, FW: 0.55 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rnd = (a, b) => a + Math.random() * (b - a);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const dirOf = (dx, dy) => (((Math.round(Math.atan2(dx, -dy) / (TAU / 8)) % 8) + 8) % 8);
const cleanName = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9 ._-]/g, '').trim().slice(0, 8);
const norm = (x, y) => { const d = Math.hypot(x, y) || 1; return [x / d, y / d]; };

class SoccerRoom {
  constructor(name, hooks) {
    this.name = name;
    this.hooks = hooks;            // { send(ws, str), toMonitors(msg), log(text, level), onMatchEnd(room, result), onLeave(room, p) }
    this.seats = [null, null];     // the human in each side
    this.pl = [];
    for (let i = 0; i < 22; i++) this.pl.push(this.newPlayer(i));
    this.ball = { x: C.CX, y: C.CY, z: 0, vx: 0, vy: 0, vz: 0, owner: null, last: null, curve: 0, curveT: 0, spin: null };
    this.state = ST.LOBBY; this.stateT = 0;
    this.tick = 0; this.clock = 0; this.half = 1; this.clockFrac = 0;
    this.score = [0, 0]; this.teams = [0, 1];
    this.flip = false;                              // second half: the sides have swapped ends
    this.rs = null;
    this.events = []; this.evtId = 0;
    this.match = 0; this.ranked = false; this.hadTwo = false;
    this.rosterSeq = 0; this.rosterDirty = true; this.lastRoster = 0;
    this.stats = [{ shots: 0 }, { shots: 0 }];
    this.timer = setInterval(() => this.step(), C.TICK_MS);
  }

  close() { clearInterval(this.timer); }
  get humans() { return this.seats.filter(Boolean); }
  get empty() { return this.humans.length === 0; }
  get size() { return this.humans.length; }

  newPlayer(i) {
    const side = i < 11 ? 0 : 1, idx = i % 11;
    return { id: i, side, idx, role: ROLE[idx], x: C.CX, y: C.CY, vx: 0, vy: 0, dir: side ? 4 : 0, act: 0, actT: 0, anim: 0, animAcc: 0,
      noPick: 0, stun: 0, tkCool: 0, mx: 0, my: 0, human: null, hold: 0, shotCool: 0, think: 0, tx: C.CX, ty: C.CY, goalie: idx === 0, divT: 0 };
  }

  event(kind, a = 0) {
    this.evtId = (this.evtId % 255) + 1;
    this.events.push([this.evtId, kind, a & 255]);
    if (this.events.length > 8) this.events.shift();
  }

  // ---- the seats ------------------------------------------------------------------------------------
  join(ws, name, ip, user = null) {
    const side = this.seats.findIndex((s) => !s);
    if (side < 0) return null;
    const p = { id: side + 1, side, name: (user ? cleanName(user.callsign) : cleanName(name)) || `P${side + 1}`, ws, ip, userId: user ? user.id : null,
      inGame: false, input: 0, prevIn: 0, fireT: 0, charge: 0, ctl: -1, inCount: 0, inHz: 0, frame: 0, fl: 0, lastMsg: 0, since: Date.now(),
      rtt: null, rttHist: [], pings: new Map(), bstat: null, pick: -1, pickIn: 0, goals: 0, joinedAt: this.tick };
    this.seats[side] = p;
    for (const q of this.sidePlayers(side)) q.human = null;
    this.rosterDirty = true;
    if (this.humans.length === 2 && this.state !== ST.LOBBY) this.hadTwo = true;
    this.hooks.log(`${p.name} joined side ${side ? 'B' : 'A'}`);
    return p;
  }

  leave(p) {
    if (this.seats[p.side] !== p) return;
    if (this.hooks.onLeave && this.state !== ST.LOBBY) this.hooks.onLeave(this, p);
    this.seats[p.side] = null;
    this.rosterDirty = true;
    this.hooks.log(`${p.name} left`, 'warn');
  }

  fromBridge(p, m, now) {
    if (m.t !== 'sc') return;
    p.inGame = !!((m.fl | 0) & 8);
    p.frame = m.f | 0; p.fl = m.fl | 0; p.lastMsg = now; p.inCount++;
    p.input = (m.in | 0) & 0x8F;
  }

  sidePlayers(s) { return this.pl.slice(s * 11, s * 11 + 11); }
  // which way a side attacks (y sign): side A up in the first half
  att(side) { return (side === 0) !== this.flip ? -1 : 1; }
  ownY(side) { return this.att(side) < 0 ? C.Y1 : C.Y0; }
  oppY(side) { return this.att(side) < 0 ? C.Y0 : C.Y1; }
  goalSide(yEnd) { return [0, 1].find((s) => this.ownY(s) === yEnd); }          // whose goal is at that end

  // ---- the match ------------------------------------------------------------------------------------
  beginLineup() {
    this.match++;
    this.score = [0, 0]; this.clock = 0; this.clockFrac = 0; this.half = 1; this.flip = false; this.hadTwo = this.humans.length === 2;
    this.stats = [{ shots: 0 }, { shots: 0 }];
    for (const h of this.humans) { h.goals = 0; if (h.pick < 0) h.pick = h.side ? 1 : 0; }
    const a = this.seats[0] ? this.seats[0].pick : Math.floor(Math.random() * C.TEAMS);
    let b = this.seats[1] ? this.seats[1].pick : Math.floor(Math.random() * C.TEAMS);
    if (b === a) b = (b + 1) % C.TEAMS;
    this.teams = [a, b];
    this.setState(ST.LINEUP);
    this.formUp(0);
    this.ball.x = C.CX; this.ball.y = C.CY; this.ball.z = 0; this.ball.vx = this.ball.vy = this.ball.vz = 0; this.ball.owner = null;
    this.event(EV.CROWD, 0);
  }

  setState(s) { this.state = s; this.stateT = 0; }

  // everyone to their formation spots (for the line-up and kick-offs); ball = the centre
  formUp(kickTeam) {
    for (const p of this.pl) {
      const [tx, ty] = this.formationTarget(p, { x: C.CX, y: C.CY }, true);
      p.x = tx; p.y = ty; p.vx = p.vy = 0; p.act = 0; p.actT = 0; p.stun = 0; p.noPick = 0;
      p.dir = this.att(p.side) < 0 ? 0 : 4;
    }
    void kickTeam;
  }

  kickoff(team) {
    this.ball.x = C.CX; this.ball.y = C.CY; this.ball.z = 0; this.ball.vx = this.ball.vy = this.ball.vz = 0; this.ball.owner = null; this.ball.last = null;
    this.formUp(team);
    const fws = this.sidePlayers(team).filter((p) => p.role === 'FW');
    const taker = fws[0];
    taker.x = C.CX; taker.y = C.CY + this.att(team) * -6; taker.y = C.CY - this.att(team) * 7;
    if (fws[1]) { fws[1].x = C.CX + 26; fws[1].y = C.CY - this.att(team) * 4; }
    this.startRestart(RS.KICKOFF, team, [C.CX, C.CY], taker);
  }

  startRestart(kind, team, spot, taker) {
    this.rs = { kind, team, spot, taker, t: 0, wait: kind === RS.KICKOFF ? 40 : rnd(C.RESTART_MIN, C.RESTART_MIN + 22) };
    this.setState(ST.RESTART);
    const b = this.ball;
    b.owner = taker; b.vx = b.vy = b.vz = 0; b.z = kind === RS.THROW ? 16 : 0; b.curveT = 0;
    taker.x = spot[0] - (kind === RS.THROW ? Math.sign(spot[0] - C.CX) * -2 : 0);
    taker.y = spot[1] + (kind === RS.KICKOFF ? this.att(team) * -1 : 0);
    if (kind !== RS.KICKOFF) {
      // the taker stands a step behind the spot, facing the pitch
      const [fx, fy] = this.restartFace(kind, spot, team);
      taker.x = spot[0] - fx * 7; taker.y = spot[1] - fy * 7;
      taker.dir = dirOf(fx, fy);
    }
    taker.vx = taker.vy = 0; taker.act = kind === RS.THROW ? ACT.THROW : 0; taker.actT = 0; taker.stun = 0;
    this.event(EV.WHISTLE, 0);
    if (kind !== RS.KICKOFF) { this.event(EV.OUT, team); }
    for (const h of this.humans) if (h.side === team) h.ctl = taker.id;
    this.rosterDirty = true;
  }

  restartFace(kind, spot, team) {
    if (kind === RS.THROW) return [spot[0] < C.CX ? 1 : -1, 0];
    if (kind === RS.CORNER) return norm(C.CX - spot[0], this.att(team) * -1 * -1 * 0 + (spot[1] < C.CY ? 1 : -1));
    return [0, -this.att(team) * -1 * -1 * 0 + this.att(team)];
  }

  // ---- the tick ---------------------------------------------------------------------------------------
  step() {
    this.tick++;
    this.stateT++;
    for (const h of this.humans) if (h.lastMsg && Date.now() - h.lastMsg > 8000) h.input = 0;
    if (this.state === ST.LOBBY) {
      if (this.humans.some((h) => h.inGame)) this.beginLineup();
    } else if (!this.humans.some((h) => h.inGame)) {
      this.setState(ST.LOBBY);
      this.rs = null;
    } else {
      this.stepHumansIn();
      if (this.state === ST.LINEUP) this.stepLineup();
      else if (this.state === ST.RESTART) { this.stepWorld(); this.stepRestart(); this.tickClock(); }
      else if (this.state === ST.PLAY) { this.stepWorld(); this.tickClock(); }
      else if (this.state === ST.GOAL) {
        this.stepWorld();
        if (this.stateT >= C.GOAL_T) this.afterGoal();
      } else if (this.state === ST.HALF) {
        if (this.stateT >= C.HALF_T) this.secondHalf();
      } else if (this.state === ST.FULL) {
        if (this.stateT >= C.FULL_T) this.beginLineup();
      }
    }
    this.send(Date.now());
  }

  stepHumansIn() {
    for (const h of this.humans) {
      h.rise = (h.input & ~h.prevIn);
      h.fall = (~h.input & h.prevIn);
      h.prevIn = h.input;
    }
  }

  stepLineup() {
    for (const h of this.humans) {
      if (h.rise & IN.LEFT) h.pick = (this.teams[h.side] + C.TEAMS - 1) % C.TEAMS;
      if (h.rise & IN.RIGHT) h.pick = (this.teams[h.side] + 1) % C.TEAMS;
      if (h.rise & (IN.LEFT | IN.RIGHT)) {
        const other = this.teams[1 - h.side];
        if (h.pick === other) h.pick = (h.pick + ((h.rise & IN.LEFT) ? C.TEAMS - 1 : 1)) % C.TEAMS;
        this.teams[h.side] = h.pick;
      }
    }
    // a side with no human: a random team that isn't the other's
    if (this.stateT >= C.LINEUP_T || this.humans.every((h) => h.rise & IN.FIRE)) { this.kickoff(0); }
  }

  tickClock() {
    this.clockFrac += C.DT;
    if (this.clockFrac >= 1) { this.clockFrac -= 1; this.clock++; }
    const limit = this.half * C.HALF_S;
    if (this.clock >= limit) {
      if (this.half === 1) { this.event(EV.HALF, 0); this.setState(ST.HALF); this.ball.owner = null; this.rs = null; }
      else { this.event(EV.FULL, 0); this.setState(ST.FULL); this.ball.owner = null; this.rs = null; this.matchOver(); }
    }
  }

  secondHalf() {
    this.half = 2; this.flip = true;
    this.kickoff(1);
  }

  matchOver() {
    const result = { ranked: this.hadTwo && this.humans.length === 2, sa: this.score[0], sb: this.score[1], winner: this.score[0] === this.score[1] ? 2 : this.score[0] > this.score[1] ? 0 : 1,
      players: this.humans.map((h) => ({ userId: h.userId, name: h.name, side: h.side, goals: h.goals })) };
    if (this.hooks.onMatchEnd) this.hooks.onMatchEnd(this, result);
  }

  afterGoal() {
    const conceded = this.lastScorer === 0 ? 1 : 0;
    this.kickoff(conceded);
  }

  // ---- world ------------------------------------------------------------------------------------------
  stepWorld() {
    const live = this.state === ST.PLAY || this.state === ST.RESTART;
    this.decide();
    for (const p of this.pl) this.movePlayer(p);
    this.separate();
    this.stepBall(live);
    if (live || this.state === ST.GOAL) this.contests();
  }

  teamHas(side) { const o = this.ball.owner; return !!o && o.side === side; }

  // who a human controls
  pickControl(h) {
    const mine = this.sidePlayers(h.side);
    const b = this.ball;
    const cur = h.ctl >= 0 ? this.pl[h.ctl] : null;
    if (this.state === ST.RESTART && this.rs && this.rs.team === h.side) { h.ctl = this.rs.taker.id; return; }
    if (b.owner && b.owner.side === h.side) { h.ctl = b.owner.id; return; }
    if (cur && (cur.act === ACT.SLIDE || cur.stun > 0 || cur.act === ACT.DOWN)) return;
    let best = null, bd = 1e9;
    for (const p of mine) {
      if (p.goalie) continue;
      let d = Math.hypot(b.x + b.vx * 0.25 - p.x, b.y + b.vy * 0.25 - p.y);
      if (cur && p === cur) d -= 18;
      if (d < bd) { bd = d; best = p; }
    }
    if (best) h.ctl = best.id;
  }

  decide() {
    for (const p of this.pl) { p.mx = 0; p.my = 0; p.slideReq = false; if (p.noPick > 0) p.noPick--; if (p.stun > 0) p.stun--; if (p.tkCool > 0) p.tkCool--; if (p.shotCool > 0) p.shotCool--; }
    const ctls = new Set();
    for (const h of this.humans) { this.pickControl(h); const p = this.pl[h.ctl]; if (p) { p.human = h; ctls.add(p); this.humanIntent(h, p); } }
    for (const p of this.pl) if (!ctls.has(p)) p.human = null;
    // the CPU
    const chasers = this.chasers();
    for (const p of this.pl) if (!ctls.has(p)) this.aiIntent(p, chasers);
  }

  humanIntent(h, p) {
    const i = h.input;
    let mx = ((i & IN.RIGHT) ? 1 : 0) - ((i & IN.LEFT) ? 1 : 0), my = ((i & IN.DOWN) ? 1 : 0) - ((i & IN.UP) ? 1 : 0);
    if (mx || my) { const [nx, ny] = norm(mx, my); p.mx = nx; p.my = ny; p.dir = dirOf(mx, my); }
    h.pdir = [DX[p.dir], DY[p.dir]];
    const b = this.ball;
    const mine = (b.owner === p) || (!b.owner && dist(p, b) <= 12 && b.z < 22);
    const restartTaker = this.state === ST.RESTART && this.rs && this.rs.taker === p;
    if (p.stun > 0 || p.act === ACT.SLIDE || p.act === ACT.DOWN) { h.charge = 0; return; }
    if (h.rise & IN.FIRE) {
      if (restartTaker || mine) h.charge = 1;
      else if (this.state === ST.PLAY) { p.slideReq = true; h.charge = 0; }
    }
    if ((i & IN.FIRE) && h.charge > 0) h.charge = Math.min(40, h.charge + 1);
    if ((h.fall & IN.FIRE) && h.charge > 0) {
      const held = h.charge; h.charge = 0;
      if (restartTaker) { if (this.rs.t >= 10) this.takeRestart(p, held, h); }
      else if (mine && this.state === ST.PLAY) this.humanKick(p, held, h);
    }
    if (!(i & IN.FIRE) && h.charge > 0) h.charge = 0;
  }

  humanKick(p, held, h) {
    const dx = DX[p.dir], dy = DY[p.dir];
    const [ndx, ndy] = norm(dx, dy);
    if (p.goalie) return this.punt(p, ndx, ndy, Math.min(1, held / 24));
    if (held <= 7) this.passTo(p, ndx, ndy, h);
    else this.shoot(p, ndx, ndy, clamp((held - 7) / 20, 0.15, 1), h);
  }

  // a pass in the direction (dx, dy): to the best team-mate in a cone, else straight ahead
  passTo(p, dx, dy, h) {
    const t = this.passTarget(p, dx, dy);
    let ax = dx, ay = dy, sp = 150;
    if (t) {
      const d = dist(p, t), lead = 0.35 + d / 700;
      const px = t.x + t.vx * lead, py = t.y + t.vy * lead;
      [ax, ay] = norm(px - p.x, py - p.y);
      sp = clamp(d * 1.5 + 70, 120, 270);
      this.kickBall(p, ax, ay, sp, d > 190 ? 110 : 0, EV.KICK, h);
    } else this.kickBall(p, ax, ay, sp, 0, EV.KICK, h);
  }

  passTarget(p, dx, dy) {
    let best = null, bs = -1e9;
    const opp = this.sidePlayers(1 - p.side);
    for (const t of this.sidePlayers(p.side)) {
      if (t === p || (t.goalie && dist(p, t) > 120)) continue;
      const ex = t.x - p.x, ey = t.y - p.y, d = Math.hypot(ex, ey);
      if (d < 24 || d > 290) continue;
      const cos = (ex * dx + ey * dy) / d;
      if (cos < 0.72) continue;
      let sc = cos * 100 - Math.abs(d - 120) * 0.12;
      let near = 1e9;
      for (const o of opp) near = Math.min(near, Math.hypot(o.x - t.x, o.y - t.y));
      if (near < 30) sc -= 35;
      // a lane blocked by an opponent
      for (const o of opp) {
        const ox = o.x - p.x, oy = o.y - p.y, along = (ox * ex + oy * ey) / (d * d);
        if (along > 0.1 && along < 0.95 && Math.abs(ox * ey - oy * ex) / d < 13) sc -= 40;
      }
      if (sc > bs) { bs = sc; best = t; }
    }
    return best;
  }

  shoot(p, dx, dy, power, h) {
    // a little help: if the goal is roughly where you point, aim into the mouth
    const gy = this.oppY(p.side);
    const toGx = C.CX - p.x, toGy = gy - p.y, gd = Math.hypot(toGx, toGy);
    let ax = dx, ay = dy;
    if (gd < 330 && (toGx * dx + toGy * dy) / gd > 0.9) {
      const k = this.sidePlayers(1 - p.side)[0];
      const side = (k.x > C.CX) ? -1 : 1;
      const tx = C.CX + side * rnd(10, 19) + (h ? 0 : rnd(-8, 8)), ty = gy;
      [ax, ay] = norm(tx - p.x, ty - p.y);
      const aim = (h ? 0.65 : 1) * 1;
      ax = dx + (ax - dx) * aim; ay = dy + (ay - dy) * aim;
      [ax, ay] = norm(ax, ay);
    }
    const sp = 170 + power * 190;
    const vz = power > 0.55 ? (power - 0.45) * 240 : power > 0.3 ? 40 : 0;
    this.stats[p.side].shots++;
    this.kickBall(p, ax, ay, sp, vz, EV.SHOT, h);
  }

  punt(p, dx, dy, power) {
    this.kickBall(p, dx, dy, 190 + power * 100, 160 + power * 90, EV.KICK, p.human);
  }

  kickBall(p, dx, dy, sp, vz, evType, h) {
    const b = this.ball;
    b.owner = null; b.last = p;
    b.x = p.x + dx * 8; b.y = p.y + dy * 8;
    b.vx = dx * sp; b.vy = dy * sp; b.vz = vz;
    b.curve = 0; b.curveT = h ? 16 : 0; b.spin = h || null;
    p.noPick = 9; p.act = ACT.KICK; p.actT = 5;
    this.event(evType, p.side);
  }

  // ---- restarts ---------------------------------------------------------------------------------------
  stepRestart() {
    const r = this.rs;
    if (!r) return;
    r.t++;
    const tk = r.taker;
    this.ball.owner = tk;
    // the taker waits at the spot; the CPU takes it after a while, a human on the button (or after 6 s)
    if (!tk.human) { if (r.t >= r.wait) this.takeRestart(tk, 8 + Math.floor(Math.random() * 12), null); }
    else {
      if (r.kind === RS.THROW || r.kind === RS.CORNER) this.moveCross(r, tk, tk.human);
      if (r.t >= 150) this.takeRestart(tk, 12, tk.human);
    }
  }

  // a human taking a throw-in or a corner steers a cross hair on the pitch; the ball goes where it points
  moveCross(r, tk, h) {
    const att = this.att(tk.side);
    if (!r.cross) {
      r.cross = r.kind === RS.THROW ? [r.spot[0] + (r.spot[0] < C.CX ? 1 : -1) * 90, r.spot[1] + att * 20] : [C.CX, this.oppY(tk.side) - att * 55];
    }
    const i = h.input;
    const mx = ((i & IN.RIGHT) ? 1 : 0) - ((i & IN.LEFT) ? 1 : 0), my = ((i & IN.DOWN) ? 1 : 0) - ((i & IN.UP) ? 1 : 0);
    let [cx, cy] = r.cross;
    cx += mx * 3.2; cy += my * 3.2;
    cx = clamp(cx, C.X0 + 4, C.X1 - 4); cy = clamp(cy, C.Y0 + 4, C.Y1 - 4);
    if (r.kind === RS.THROW) { cx = r.spot[0] < C.CX ? Math.max(cx, r.spot[0] + 12) : Math.min(cx, r.spot[0] - 12); }
    const R = r.kind === RS.THROW ? 190 : 320;
    const d = Math.hypot(cx - tk.x, cy - tk.y);
    if (d > R) { cx = tk.x + (cx - tk.x) * R / d; cy = tk.y + (cy - tk.y) * R / d; }
    r.cross = [cx, cy];
    tk.dir = dirOf(cx - tk.x, cy - tk.y);
  }

  takeRestart(p, held, h) {
    const r = this.rs;
    const kind = r.kind;
    const b = this.ball;
    const power = clamp(held / 24, 0.2, 1);
    let dx, dy, crossD = 0;
    if (h) {
      const i = h.input;
      const mx = ((i & IN.RIGHT) ? 1 : 0) - ((i & IN.LEFT) ? 1 : 0), my = ((i & IN.DOWN) ? 1 : 0) - ((i & IN.UP) ? 1 : 0);
      if (r.cross && (kind === RS.THROW || kind === RS.CORNER)) { crossD = Math.hypot(r.cross[0] - p.x, r.cross[1] - p.y); [dx, dy] = norm(r.cross[0] - p.x, r.cross[1] - p.y); }
      else if (mx || my) [dx, dy] = norm(mx, my);
    }
    const mates = this.sidePlayers(p.side).filter((t) => t !== p);
    const aimAt = (t) => norm(t.x - p.x, t.y - p.y);
    if (kind === RS.KICKOFF) {
      let t = mates.filter((q) => !q.goalie).sort((a, c) => dist(p, a) - dist(p, c))[1];
      if (!t) t = mates[0];
      if (!h || dx === undefined) [dx, dy] = aimAt(t);
      this.rs = null; this.setState(ST.PLAY);
      this.kickBall(p, dx, dy, 120, 0, EV.KICK, null);
      this.event(EV.START, 0);
      return;
    }
    if (kind === RS.THROW) {
      if (h && dx !== undefined) { if (spotInward(r.spot, dx) < 0) dx = -dx; }
      else {
        const t = mates.filter((q) => !q.goalie && dist(p, q) > 30 && dist(p, q) < 170).sort((a, c) => dist(p, a) - dist(p, c))[0] || mates[5];
        [dx, dy] = aimAt(t);
        if (spotInward(r.spot, dx) < 0) dx = -dx;
      }
      const sp = 62 + power * 100;                                   // hold fire for power; the cross hair gives the direction
      this.rs = null; this.setState(ST.PLAY);
      b.owner = null; b.last = p; b.vx = dx * sp; b.vy = dy * sp; b.vz = 110; b.z = 18; b.curveT = 0;
      p.noPick = 25; p.act = ACT.THROW; p.actT = 6;
      this.event(EV.THROW, p.side);
      return;
    }
    if (kind === RS.CORNER) {
      let [tx, ty] = [C.CX + rnd(-30, 30), this.oppY(p.side) - this.att(p.side) * rnd(40, 70)];
      if (h && dx !== undefined) { [dx, dy] = [dx, dy]; } else [dx, dy] = norm(tx - p.x, ty - p.y);
      const d = Math.hypot(tx - p.x, ty - p.y);
      const sp = crossD ? clamp(crossD * 1.25, 150, 260) : h ? 150 + power * 130 : clamp(d * 1.25, 150, 260);
      this.rs = null; this.setState(ST.PLAY);
      this.kickBall(p, dx, dy, sp, 150 + power * 80, EV.KICK, h);
      return;
    }
    // goal kick: the keeper hoofs it up the pitch
    {
      const f = this.att(p.side);
      if (!h || dx === undefined) { const t = mates.filter((q) => !q.goalie && (q.y - p.y) * f > 160).sort(() => Math.random() - 0.5)[0]; [dx, dy] = t ? aimAt(t) : norm(rnd(-0.4, 0.4), f); }
      this.rs = null; this.setState(ST.PLAY);
      this.kickBall(p, dx, dy, 190 + power * 110, 170 + power * 80, EV.KICK, h);
    }
  }

  // ---- movement ---------------------------------------------------------------------------------------
  movePlayer(p) {
    if (p.actT > 0) { p.actT--; if (p.actT === 0 && (p.act === ACT.KICK || p.act === ACT.THROW || p.act === ACT.HEAD)) p.act = ACT.RUN; }
    // celebrations and falls: stand still
    let sp = this.ball.owner === p ? C.DRIB : p.goalie ? C.KEEP_V : C.RUN;
    if (p.act === ACT.SLIDE) {
      const k = p.actT / C.SLIDE_T;
      sp = C.SLIDE_V * (0.35 + 0.65 * k);
      p.vx = p.sdx * sp; p.vy = p.sdy * sp;
      if (p.actT <= 0) { p.act = ACT.RUN; p.stun = C.SLIDE_REC; p.vx = p.vy = 0; }
    } else if (p.act === ACT.DOWN) {
      p.vx *= 0.8; p.vy *= 0.8;
      if (p.actT <= 0) p.act = ACT.RUN;
    } else if (p.act === ACT.DIVE) {
      if (p.actT <= 0) { p.act = ACT.RUN; p.stun = 8; }
    } else if (this.state === ST.GOAL && p.cheer) {
      p.vx *= 0.7; p.vy *= 0.7;
    } else if (p.act === ACT.THROW && this.state === ST.RESTART) {
      p.vx = p.vy = 0;
    } else {
      if (p.slideReq && p.stun === 0 && !(this.ball.owner === p)) {
        p.act = ACT.SLIDE; p.actT = C.SLIDE_T;
        [p.sdx, p.sdy] = (p.mx || p.my) ? [p.mx, p.my] : [DX[p.dir], DY[p.dir]];
        [p.sdx, p.sdy] = norm(p.sdx, p.sdy);
        p.dir = dirOf(p.sdx, p.sdy);
        this.event(EV.SLIDE, p.side);
      } else {
        const f = p.stun > 0 ? 0.35 : 1;
        const tvx = p.mx * sp * f, tvy = p.my * sp * f;
        p.vx += (tvx - p.vx) * 0.5; p.vy += (tvy - p.vy) * 0.5;
        if ((p.mx || p.my) && !p.human) p.dir = dirOf(p.mx, p.my);
      }
    }
    if (this.state === ST.RESTART && this.rs && this.rs.taker === p) { p.vx = p.vy = 0; }
    p.x = clamp(p.x + p.vx * C.DT, C.X0 - 16, C.X1 + 16);
    p.y = clamp(p.y + p.vy * C.DT, C.Y0 - 22, C.Y1 + 22);
    const spd = Math.hypot(p.vx, p.vy);
    if (spd > 12) { p.animAcc += spd * C.DT; if (p.animAcc > 5.5) { p.animAcc = 0; p.anim = (p.anim + 1) & 3; } }
    else p.anim = 0;
  }

  separate() {
    const ps = this.pl;
    for (let i = 0; i < 22; i++) {
      const a = ps[i];
      for (let j = i + 1; j < 22; j++) {
        const b = ps[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        if (Math.abs(dx) > 7 || Math.abs(dy) > 7) continue;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d >= 7) continue;
        const k = (7 - d) * 0.35 / d;
        a.x -= dx * k; a.y -= dy * k; b.x += dx * k; b.y += dy * k;
      }
    }
  }

  // ---- the ball ---------------------------------------------------------------------------------------
  stepBall(live) {
    const b = this.ball;
    if (b.owner) {
      const o = b.owner;
      if (this.state === ST.HALF || this.state === ST.FULL) { b.owner = null; return; }
      const f = o.act === ACT.SLIDE ? 0 : 1;
      const dx = DX[o.dir], dy = DY[o.dir];
      const [nx, ny] = norm(dx, dy);
      const hold = o.goalie ? 5 : (this.state === ST.RESTART && this.rs && this.rs.kind === RS.THROW ? 2 : 8);
      const tx = o.x + nx * hold * f, ty = o.y + ny * hold * f;
      b.x += (tx - b.x) * 0.7; b.y += (ty - b.y) * 0.7;
      b.vx = o.vx; b.vy = o.vy; b.vz = 0;
      b.z = (this.state === ST.RESTART && this.rs && this.rs.kind === RS.THROW) || (o.goalie && o.hold > 0) ? 16 : 0;
      return;
    }
    const dt = C.DT / C.SUB;
    for (let s = 0; s < C.SUB; s++) {
      // swerve: a human steers the kick while it flies
      if (b.curveT > 0 && b.spin && s === 0) {
        b.curveT--;
        const i = b.spin.input;
        const k = ((i & IN.RIGHT) ? 1 : 0) - ((i & IN.LEFT) ? 1 : 0);
        const kv = ((i & IN.DOWN) ? 1 : 0) - ((i & IN.UP) ? 1 : 0);
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > 60 && (k || kv)) {
          // sideways to the flight: the stick component across the ball's heading
          const hx = b.vx / sp, hy = b.vy / sp;
          const across = k * -hy + kv * hx;
          b.vx += -hy * across * 150 * C.DT * 3; b.vy += hx * across * 150 * C.DT * 3;
        }
      }
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.z += b.vz * dt; b.vz -= 520 * dt;
      if (b.z <= 0) {
        b.z = 0;
        if (b.vz < -60) { b.vz = -b.vz * 0.58; this.event(EV.BOUNCE, 0); } else b.vz = 0;
      }
      const fric = b.z > 1 ? 0.2 : 1.6;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 0) { const k = Math.max(0, sp - (sp * fric + (b.z > 1 ? 0 : 12)) * dt) / sp; b.vx *= k; b.vy *= k; }
      this.posts();
      if (this.state === ST.GOAL) this.netClamp();
    }
    if (live && this.state === ST.PLAY) this.boundaries();
  }

  posts() {
    const b = this.ball;
    for (const [px, py] of [[C.GL, C.Y0], [C.GR, C.Y0], [C.GL, C.Y1], [C.GR, C.Y1]]) {
      const dx = b.x - px, dy = b.y - py, d = Math.hypot(dx, dy);
      if (d < 5 && b.z < C.BAR) {
        const nx = dx / (d || 1), ny = dy / (d || 1);
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) { b.vx -= 1.7 * vn * nx; b.vy -= 1.7 * vn * ny; this.event(EV.POST, 0); }
        b.x = px + nx * 5.2; b.y = py + ny * 5.2;
      }
    }
  }

  netClamp() {
    const b = this.ball;
    const top = b.y < C.CY;
    b.x = clamp(b.x, C.GL + 3, C.GR - 3);
    if (top) { if (b.y < C.Y0 - C.GOAL_DEPTH + 3) { b.y = C.Y0 - C.GOAL_DEPTH + 3; b.vy = Math.abs(b.vy) * 0.2; } }
    else if (b.y > C.Y1 + C.GOAL_DEPTH - 3) { b.y = C.Y1 + C.GOAL_DEPTH - 3; b.vy = -Math.abs(b.vy) * 0.2; }
  }

  boundaries() {
    const b = this.ball;
    const last = b.last;
    // a goal
    for (const yEnd of [C.Y0, C.Y1]) {
      const crossed = yEnd === C.Y0 ? b.y < yEnd : b.y > yEnd;
      if (!crossed) continue;
      if (b.x > C.GL + 2 && b.x < C.GR - 2 && b.z < C.BAR) return this.goal(this.goalSide(yEnd) === 0 ? 1 : 0);
      // over the line elsewhere: corner or goal kick
      const def = this.goalSide(yEnd);
      const lastSide = last ? last.side : 1 - def;
      b.vx = b.vy = b.vz = 0; b.z = 0;
      if (lastSide === def) {
        const cx = b.x < C.CX ? C.X0 : C.X1;
        const team = 1 - def;
        const taker = this.nearestOf(team, cx, yEnd, true);
        this.startRestart(RS.CORNER, team, [cx, yEnd], taker);
      } else {
        const gk = this.sidePlayers(def)[0];
        this.startRestart(RS.GOALKICK, def, [C.CX + (b.x < C.CX ? -18 : 18), yEnd + (yEnd === C.Y0 ? 22 : -22)], gk);
      }
      return;
    }
    if (b.x < C.X0 || b.x > C.X1) {
      const lastSide = last ? last.side : 0;
      const team = 1 - lastSide;
      const sx = b.x < C.CX ? C.X0 : C.X1, sy = clamp(b.y, C.Y0 + 14, C.Y1 - 14);
      b.vx = b.vy = b.vz = 0;
      const taker = this.nearestOf(team, sx, sy, true);
      this.startRestart(RS.THROW, team, [sx, sy], taker);
    }
  }

  nearestOf(side, x, y, noKeeper) {
    let best = null, bd = 1e9;
    for (const p of this.sidePlayers(side)) {
      if (noKeeper && p.goalie) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  goal(side) {                       // side scored
    this.score[side]++;
    this.lastScorer = side;
    const scorer = this.ball.last && this.ball.last.side === side ? this.ball.last : this.nearestOf(side, this.ball.x, this.ball.y, true);
    if (this.ball.last && this.ball.last.side !== side) { /* own goal */ }
    else if (this.seats[side] && scorer && scorer.human === this.seats[side]) this.seats[side].goals++;
    for (const p of this.sidePlayers(side)) p.cheer = false;
    if (scorer) { scorer.cheer = true; scorer.act = ACT.CHEER; scorer.actT = 90; }
    this.setState(ST.GOAL);
    this.event(EV.GOAL, side);
    this.event(EV.CROWD, side);
    this.rs = null;
    this.rosterDirty = true;
  }

  // ---- ball and players -------------------------------------------------------------------------------
  contests() {
    const b = this.ball;
    if (this.state === ST.GOAL) return;
    if (b.owner) {
      const o = b.owner;
      // a tackle: an opponent in reach
      if (this.state === ST.PLAY) {
        for (const p of this.sidePlayers(1 - o.side)) {
          if (p.tkCool > 0 || p.stun > 0 || p.act === ACT.DOWN) continue;
          const d = dist(p, o);
          if (p.act === ACT.SLIDE) {
            if (d < 12) { this.winBall(p, o, true); break; }
          } else if (d < 8.5 && !o.goalie) {
            p.tkCool = 12;
            const dribble = Math.hypot(o.vx, o.vy) / C.RUN;
            if (Math.random() < 0.16 + dribble * 0.05 * (p.human ? 1.5 : 1)) { this.winBall(p, o, false); break; }
          } else if (d < 12 && o.goalie) { /* the keeper holds it */ }
        }
      }
      // the keeper with the ball (a catch): let it go after a while
      if (o.goalie && this.state === ST.PLAY) {
        o.hold = (o.hold || 0) + 1;
        if (!o.human && o.hold > 38) this.aiKeeperRelease(o);
        else if (o.human && o.hold > 120) this.aiKeeperRelease(o);
      }
      return;
    }
    // a loose ball: the nearest player in reach takes it (or the ball runs on)
    let best = null, bd = 1e9;
    for (const p of this.pl) {
      if (p.noPick > 0 || p.act === ACT.DOWN) continue;
      const reach = p.goalie ? (p.act === ACT.DIVE ? 21 : 13) : p.act === ACT.SLIDE ? 13 : 9;
      const zmax = p.goalie ? 30 : p.act === ACT.SLIDE ? 6 : 17;
      if (b.z > zmax) continue;
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d < reach && d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    const sp = Math.hypot(b.vx, b.vy);
    const p = best;
    if (p.goalie) {
      if (sp > 230 && Math.random() < 0.3) {             // a parry
        b.vx = -b.vx * 0.3 + rnd(-60, 60); b.vy = -b.vy * 0.35; b.vz = 40; b.last = p; p.noPick = 8; this.event(EV.CATCH, 1);
        return;
      }
      this.catchBall(p);
      return;
    }
    if (p.act === ACT.SLIDE) {                           // a slide at a loose ball: hook it ahead
      const [nx, ny] = norm(p.sdx, p.sdy);
      b.vx = nx * 130; b.vy = ny * 130; b.last = p; p.noPick = 4; this.event(EV.TACKLE, p.side);
      return;
    }
    if (sp > 205 && Math.random() < 0.55) {              // too hot to control: it runs off the foot
      b.vx *= 0.45; b.vy *= 0.45; b.vx += p.vx * 0.3; b.vy += p.vy * 0.3; b.last = p; p.noPick = 5; return;
    }
    b.owner = p; b.last = p; b.vz = 0; b.curveT = 0; p.hold = 0; p.holdT = 0;
  }

  winBall(p, o, slide) {
    const b = this.ball;
    b.owner = null; b.last = p;
    const ang = rnd(-0.6, 0.6);
    const [dx, dy] = slide ? norm(p.sdx, p.sdy) : norm(o.vx || DX[o.dir], o.vy || DY[o.dir]);
    const cs = Math.cos(ang), sn = Math.sin(ang);
    const sp = slide ? 120 : 80 + Math.random() * 40;
    b.vx = (dx * cs - dy * sn) * sp; b.vy = (dx * sn + dy * cs) * sp; b.vz = slide ? 50 : 0;
    o.noPick = slide ? 22 : 14;
    if (slide && Math.random() < 0.55) { o.act = ACT.DOWN; o.actT = 16; o.vx *= 0.3; o.vy *= 0.3; }
    p.noPick = 0;
    this.event(EV.TACKLE, p.side);
  }

  catchBall(k) {
    const b = this.ball;
    b.owner = k; b.last = k; b.vx = b.vy = b.vz = 0; k.hold = 1; k.act = 0;
    this.event(EV.CATCH, 0);
    this.stats[k.side].saves = (this.stats[k.side].saves || 0) + 1;
  }

  aiKeeperRelease(k) {
    const f = this.att(k.side);
    k.hold = 0;
    const mates = this.sidePlayers(k.side).filter((q) => !q.goalie && (q.y - k.y) * f > 90);
    const t = mates.sort(() => Math.random() - 0.5)[0];
    const [dx, dy] = t ? norm(t.x - k.x, t.y - k.y) : norm(rnd(-0.3, 0.3), f);
    this.punt(k, dx, dy, Math.random());
  }

  // ---- the CPU -------------------------------------------------------------------------------------------
  chasers() {
    const b = this.ball;
    const out = [new Set(), new Set()];
    for (const side of [0, 1]) {
      if (this.teamHas(side)) continue;
      const cand = this.sidePlayers(side).filter((p) => !p.goalie && !p.human && p.act !== ACT.DOWN)
        .map((p) => [Math.hypot(b.x + b.vx * 0.2 - p.x, b.y + b.vy * 0.2 - p.y), p]).sort((x, y) => x[0] - y[0]);
      if (cand[0]) out[side].add(cand[0][1]);
      if (this.ball.owner && cand[1] && cand[1][0] < 140) out[side].add(cand[1][1]);
      // a human on this side takes the nearest: the CPU chases with the next as well
      if (this.seats[side] && cand[1] && !b.owner) out[side].add(cand[1][1]);
    }
    return out;
  }

  formationTarget(p, ref, strict) {
    const f = this.att(p.side);
    const own = this.ownY(p.side);
    const [u0, v0] = HOME[p.idx];
    const ballV = clamp((ref.y - own) * f / (C.Y1 - C.Y0), 0, 1);
    let v = v0 + (ballV - 0.5) * SHIFT[p.role];
    if (!strict && this.teamHas(p.side) && (p.role === 'FW' || p.role === 'MF')) v += p.role === 'FW' ? 0.14 : 0.06;
    if (p.goalie) v = 0.02;
    v = clamp(v, 0.02, 0.96);
    if (strict) v = Math.min(v, p.goalie ? 0.02 : 0.47);
    let u = u0 * 0.92 + clamp((ref.x - C.CX) / 190, -1, 1) * (p.goalie ? 0 : 0.28);
    u = clamp(u, -0.95, 0.95);
    return [C.CX + u * 188, own + f * v * (C.Y1 - C.Y0)];
  }

  moveTo(p, tx, ty, sprint) {
    const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
    if (d < 3) return;
    const k = sprint ? 1 : clamp(d / 22, 0.25, 1);
    p.mx = dx / d * k; p.my = dy / d * k;
  }

  aiIntent(p, chasers) {
    const b = this.ball;
    if (p.act === ACT.SLIDE || p.act === ACT.DOWN || (this.state === ST.GOAL && p.cheer)) return;
    if (this.state === ST.HALF || this.state === ST.FULL) return;
    // the taker of a restart stays put (stepRestart takes it)
    if (this.state === ST.RESTART && this.rs && this.rs.taker === p) return;
    if (p.goalie) return this.aiKeeper(p);
    if (this.state === ST.RESTART) return this.aiRestartPos(p);
    if (b.owner === p) return this.aiOwner(p);
    if (this.state === ST.GOAL) { const [tx, ty] = this.formationTarget(p, b, false); return this.moveTo(p, tx, ty, false); }
    if (chasers[p.side].has(p)) {
      let tx = b.x + b.vx * 0.22, ty = b.y + b.vy * 0.22;
      if (b.owner && b.owner.side !== p.side) {
        // close the owner down from the goal side
        const g = this.ownY(p.side);
        const [gx, gy] = norm(C.CX - b.owner.x, g - b.owner.y);
        tx = b.owner.x + gx * 4; ty = b.owner.y + gy * 4;
      }
      this.moveTo(p, tx, ty, true);
      // slide at the owner in reach (the CPU, rarely)
      if (b.owner && b.owner.side !== p.side && p.stun === 0 && dist(p, b.owner) < 20 && Math.random() < 0.02 && !b.owner.goalie) {
        p.slideReq = true; p.mx = (b.owner.x - p.x); p.my = (b.owner.y - p.y); [p.mx, p.my] = norm(p.mx, p.my);
      }
      return;
    }
    const [tx, ty] = this.formationTarget(p, b, false);
    // the ones near the owner's team's attack make runs
    this.moveTo(p, tx + Math.sin((this.tick + p.id * 13) / 40) * 6, ty + Math.cos((this.tick + p.id * 7) / 33) * 5, false);
  }

  aiRestartPos(p) {
    const r = this.rs;
    let [tx, ty] = this.formationTarget(p, { x: r.spot[0], y: r.spot[1] }, r.kind === RS.KICKOFF);
    if (r.kind === RS.CORNER) {
      const f = this.att(r.team), gy = this.oppY(r.team);
      const attacking = p.side === r.team;
      if (p.role !== 'DF' || !attacking) {
        const i = p.idx;
        tx = C.CX + ((i * 37) % 90 - 45); ty = gy - f * (28 + ((i * 53) % 50));
        if (attacking && p.role === 'DF') { tx = C.CX + (i % 2 ? 60 : -60); ty = this.ownY(p.side) + f * 330; }
      }
    }
    if (p.side !== r.team) {                         // keep clear of the ball
      const d = Math.hypot(tx - r.spot[0], ty - r.spot[1]), min = r.kind === RS.KICKOFF ? 48 : 38;
      if (d < min) { const [nx, ny] = norm(tx - r.spot[0] || 1, ty - r.spot[1] || 1); tx = r.spot[0] + nx * min; ty = r.spot[1] + ny * min; }
    }
    if (r.kind === RS.GOALKICK) { /* both sides spread: formation shifted by the ball at the spot */ }
    this.moveTo(p, clamp(tx, C.X0 + 4, C.X1 - 4), clamp(ty, C.Y0 + 4, C.Y1 - 4), false);
  }

  aiOwner(p) {
    const b = this.ball;
    const f = this.att(p.side), gy = this.oppY(p.side);
    p.holdT = (p.holdT || 0) + 1;
    const gdx = C.CX - p.x, gdy = gy - p.y, gd = Math.hypot(gdx, gdy);
    const opp = this.sidePlayers(1 - p.side);
    let near = 1e9, nearO = null;
    for (const o of opp) { const d = dist(p, o); if (d < near) { near = d; nearO = o; } }
    // shoot
    if (gd < 215 && p.shotCool === 0 && p.holdT > 8 && (near < 34 || gd < 150 || Math.random() < 0.02)) {
      if (Math.random() < 0.34) {
        const power = clamp(0.55 + Math.random() * 0.45, 0, 1);
        const [ax, ay] = norm(gdx + rnd(-16, 16), gdy);
        p.shotCool = 40;
        this.shoot(p, ax, ay, power, null);
        return;
      }
    }
    // pass when pressed, or now and then
    if (p.holdT > 10 && (near < 26 || (p.holdT > 36 && Math.random() < 0.06))) {
      const [fx, fy] = norm(gdx * 0.35 + rnd(-0.4, 0.4) * 60, f * 100);
      const t = this.passTarget(p, fx, fy) || this.passTarget(p, -fx * 0.3, f * 0.6 + 0.001);
      if (t && Math.random() < 0.7) { this.passTo(p, fx, fy, null); return; }
      if (near < 18 && (p.y - this.ownY(p.side)) * f < 220) { const [ax, ay] = norm(rnd(-0.5, 0.5), f); this.kickBall(p, ax, ay, 230, 140, EV.KICK, null); return; }
    }
    // dribble toward goal, around the nearest opponent
    let [dx, dy] = norm(gdx, gdy);
    if (nearO && near < 38) {
      const ox = nearO.x - p.x, oy = nearO.y - p.y;
      if (ox * dx + oy * dy > 0) { const side = (ox * dy - oy * dx) > 0 ? -1 : 1; dx += -dy * side * 0.9; dy += dx * side * 0.9; [dx, dy] = norm(dx, dy); }
    }
    // keep inside
    if (p.x < C.X0 + 14 && dx < 0) dx = 0.2; if (p.x > C.X1 - 14 && dx > 0) dx = -0.2;
    p.mx = dx; p.my = dy;
    // lift the ball over the line in the box if no goal
    void b;
  }

  aiKeeper(k) {
    const b = this.ball;
    const goalY = this.ownY(k.side), f = this.att(k.side);       // f: inward is +f
    if (b.owner === k) { k.mx = k.my = 0; return; }
    const toward = (goalY - b.y) * f * -1;                        // > 0 when the ball is up the pitch from my line
    let tx = clamp(C.CX + (b.x - C.CX) * 0.22, C.GL + 8, C.GR - 8);
    let ty = goalY + f * clamp(14 + Math.max(0, 200 - Math.abs(b.y - goalY)) * 0.1, 14, 34);
    // a shot coming: where does it cross my line?
    const vy = b.vy * (goalY < C.CY ? -1 : 1) * -1;               // toward my goal: positive
    void toward; void vy;
    const towardGoal = (goalY - b.y) * b.vy > 0 && Math.abs(b.vy) > 45;
    if (towardGoal && !b.owner) {
      const t = (goalY - b.y) / b.vy;
      const cx = b.x + b.vx * t;
      if (t > 0 && t < 0.9 && cx > C.GL - 14 && cx < C.GR + 14) {
        tx = clamp(cx, C.GL + 2, C.GR - 2); ty = goalY + f * 8;
        const gap = tx - k.x;
        if (k.act !== ACT.DIVE && k.stun === 0 && Math.abs(gap) > 11 && Math.abs(gap) < 38 && t < 0.32) {
          k.act = ACT.DIVE; k.actT = 10; k.vx = Math.sign(gap) * 150; k.vy = 0; k.dir = gap > 0 ? 2 : 6;
          this.event(EV.SLIDE, k.side);
        }
      }
    } else if (!b.owner && dist(k, b) < 80 && Math.abs(b.y - goalY) < 90 && Math.hypot(b.vx, b.vy) < 70 && (b.last ? b.last.side !== k.side : true)) {
      tx = b.x; ty = b.y;                                            // come out and claim a loose ball
    }
    if (k.act === ACT.DIVE) return;
    this.moveTo(k, tx, ty, true);
  }

  // ---- the snapshot ----------------------------------------------------------------------------------
  clockOut() { return Math.min(this.clock, 65535); }

  body() {
    const b = this.ball;
    return {
      seq: this.tick & 255, st: this.state, clock: this.clockOut(), half: this.half, sa: Math.min(99, this.score[0]), sb: Math.min(99, this.score[1]),
      ta: this.teams[0], tb: this.teams[1], flip: this.flip ? 1 : 0,
      rs: this.rs ? this.rs.kind : 0, rst: this.rs ? this.rs.team : 0, rt: this.rs ? Math.min(255, this.rs.t) : 0,
      ball: [Math.round(b.x), Math.round(b.y), Math.round(b.z), Math.round(b.vx * C.DT / 2 * 8), Math.round(b.vy * C.DT / 2 * 8), b.owner ? b.owner.id : 255],
      ev: this.events,
    };
  }

  playerList(ctlId) {
    const b = this.ball;
    const bx = clamp(b.x, 128, C.W - 128), by = clamp(b.y, 96, C.H - 96);
    const out = [];
    for (const p of this.pl) {
      if (p.id !== ctlId && (Math.abs(p.x - bx) > 128 + 30 || Math.abs(p.y - by) > 96 + 30)) continue;
      const st = (p.dir & 7) | ((p.act & 7) << 3) | ((p.anim & 3) << 6);
      const v = (q) => clamp(Math.round(q * C.DT / 2 * 8), -127, 127);
      out.push([p.id, Math.round(p.x), Math.round(p.y), st, v(p.vx), v(p.vy)]);
    }
    return out;
  }

  send(now) {
    const base = { t: 'snap', ...this.body() };
    for (const h of this.humans) {
      if (!h.ws) continue;
      const ctl = h.ctl >= 0 ? h.ctl : 255;
      this.hooks.send(h.ws, JSON.stringify({ ...base, pl: this.playerList(ctl), you: { side: h.side, ctl, pw: h.charge ? Math.min(255, h.charge * 7) : 0, n: this.humans.length, pick: this.teams[h.side], xh: this.crossFor(h), nm: this.humans.filter((q) => q.ctl >= 0).slice(0, 2).map((q) => [q.ctl, q.name]) } }));
    }
    if (this.rosterDirty && now - this.lastRoster > 400) this.sendRoster(now);
  }

  crossFor(h) {
    const r = this.rs;
    if (this.state !== ST.RESTART || !r || !r.cross || r.taker.human !== h) return null;
    return [Math.round(r.cross[0]), Math.round(r.cross[1])];
  }

  rosterList() {
    return this.seats.filter(Boolean).map((p) => [p.id, p.side, Math.min(65535, this.score[p.side]), Math.min(65535, p.goals), p.name]);
  }
  sendRoster(now) {
    this.lastRoster = now;
    this.rosterDirty = false;
    this.rosterSeq++;
    const msg = JSON.stringify({ t: 'roster', seq: this.rosterSeq, rk: 0, players: this.rosterList() });
    for (const p of this.humans) if (p.ws) this.hooks.send(p.ws, msg);
    this.hooks.toMonitors({ t: 'sroster', room: this.name, players: this.rosterList() });
  }

  monitorFull() { return []; }

  info() {
    return this.humans.map((p) => ({
      slot: p.id, name: p.name, bot: false, team: p.side, cart: 'next', score: p.goals, goals: p.goals, account: !!p.userId, inGame: p.inGame,
      rtt: p.rtt, rttHist: p.rttHist, inHz: p.inHz, frame: p.frame, since: p.since, bstat: p.bstat, lastAge: p.lastMsg ? Date.now() - p.lastMsg : null,
    }));
  }
}

function spotInward(spot, dx) { return spot[0] < C.CX ? dx : -dx; }

module.exports = { SoccerRoom, C, ST, RS, EV, ACT, IN, TEAM_NAMES, cleanName };

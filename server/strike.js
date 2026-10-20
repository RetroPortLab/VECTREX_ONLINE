// VEC STRIKE rooms: up to 20 pilots (consoles and bots), scores, rounds, respawns.
//
// Each console flies its own ship and bullets and says where they are 25 times a second
// ({t:"st"}). When its ship is hit, the console decides it, from its own screen, and says so
// ({t:"hit", by, life}): this room believes it, counts the kill and respawns the pilot later.
// Bots live here: they fly by the console's rules and are hit by what this room sees.
// Every 50 ms each bridge gets the whole arena ({t:"snap"}) plus its own pilot's state.
//
// The physics numbers are the console's (vectrex/vecstrike/src/main.c), in units per frame.

const C = {
  ARENA: 118, ROT: 5, THRUST: 22 / 256, VMAX: 640 / 256, BUL_SPEED: 4, BUL_LIFE: 36, FIRE_CD: 7,
  HIT_R2: 49, SHIELD_FRAMES: 100, MAX: 20, ROUND_KILLS: Number(process.env.STRIKE_ROUND_KILLS) || 15, RESPAWN_MS: 2500, ROUND_PAUSE_MS: 6000,
  TICK_MS: 20, SNAP_MS: 50, MON_MS: 100, MY_BUL: 3,
  // bots: slower to turn than a pilot, a shaky aim, a shorter reach, a slower trigger
  BOT_ROT: 3, BOT_AIM_ERR: 26, BOT_AIM_TOL: 4, BOT_RANGE: 85, BOT_FIRE_CD: 30, BOT_KEEP: 100, BOT_TRIGGER: 0.02,
};
const F = { ALIVE: 1, THRUST: 2, SHIELD: 4, INGAME: 8, BOT: 8, FIRE: 16 };
const S = { SPECTATE: 0, ALIVE: 1, DEAD: 2 };
const E = { KILL: 1, SPAWN: 2, JOIN: 3, LEAVE: 4, HYPER: 5, WIN: 6, ROUND: 7 };
const BOT_NAMES = ['VORTEX', 'NOVA', 'PULSAR', 'COMET', 'RAZOR', 'SPECTRE', 'ION', 'BLAZE', 'ORBIT', 'QUASAR',
  'NEBULA', 'ZAPPER', 'HELIX', 'FLUX', 'GHOST', 'VIPER', 'ROGUE', 'TITAN', 'ZENITH', 'ECHO'];

const sinA = (a) => Math.sin(a * Math.PI / 128);
const cosA = (a) => Math.cos(a * Math.PI / 128);
const wrap = (v) => (v > C.ARENA ? v - 2 * C.ARENA : v < -C.ARENA ? v + 2 * C.ARENA : v);
const wd = (d) => wrap(d);
const i8 = (v) => Math.max(-128, Math.min(127, Math.round(v)));
const cleanName = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 8);

class StrikeRoom {
  constructor(name, hooks) {
    this.name = name;
    // hooks: { send(ws, msgOrString), toMonitors(msg), log(msg, level),
    //          onRoundEnd(room, result), onLeave(room, pilot, ranked) }  (the last two: optional)
    this.hooks = hooks;
    this.players = new Map();      // id -> pilot
    this.events = [];
    this.evtId = 0;
    this.snapSeq = 0;
    this.rosterSeq = 0;
    this.rosterDirty = true;
    this.winId = 0;
    this.roundOverAt = 0;
    this.nextSnap = 0;
    this.lastMon = 0;
    this.lastRoster = 0;
    this.timer = setInterval(() => this.tick(), C.TICK_MS);
  }

  close() { clearInterval(this.timer); }
  get humans() { return [...this.players.values()].filter((p) => !p.bot); }
  get bots() { return [...this.players.values()].filter((p) => p.bot); }
  get empty() { return this.humans.length === 0; }

  freeId() { for (let i = 1; i <= C.MAX; i++) if (!this.players.has(i)) return i; return 0; }

  event(type, x = 0, y = 0, a = 0, b = 0) {
    this.evtId = (this.evtId % 255) + 1;
    const e = [this.evtId, type, i8(x), i8(y), a, b];
    this.events.push(e);
    if (this.events.length > 8) this.events.shift();
    this.hooks.toMonitors({ t: 'sev', room: this.name, e });
  }

  newPilot(id, name, bot) {
    return {
      id, name, bot, ws: null, inGame: bot, alive: false, life: 0, x: 0, y: 0, a: 0, vx: 0, vy: 0, fl: 0,
      bullets: [], lastSt: 0, score: 0, deaths: 0, shieldUntil: 0, spawnedAt: 0, respawnAt: Date.now() + (bot ? 800 : 0),
      // links (humans)
      since: Date.now(), inCount: 0, inHz: 0, frame: 0, rtt: null, rttHist: [], pings: new Map(), bstat: null, ip: '',
      // bots
      cd: 0, err: 0, errAt: 0, wander: 0,
      // whose it is, and this round's tally for the leaderboards: pilots and bots shot down, deaths
      userId: null, inRound: false, roundKills: 0, roundBotKills: 0, roundDeaths: 0,
    };
  }

  // ---- people ----------------------------------------------------------------------------
  // user: the signed-in account ({id, callsign}) or null for a guest
  join(ws, name, ip, user = null) {
    let id = this.freeId();
    if (!id && this.bots.length) { this.removeBot(); id = this.freeId(); }
    if (!id) return null;
    const p = this.newPilot(id, (user ? cleanName(user.callsign) : cleanName(name)) || `P${id}`, false);
    p.ws = ws; p.ip = ip; p.userId = user ? user.id : null;
    this.players.set(id, p);
    this.event(E.JOIN, 0, 0, id);
    this.rosterDirty = true;
    this.hooks.log(`P${id} ${p.name} joined`);
    return p;
  }

  leave(p) {
    if (this.players.get(p.id) !== p) return;
    // leaving mid-round: what they shot so far still counts, if the round was a real one
    if (this.hooks.onLeave && p.inRound && !this.roundOverAt) this.hooks.onLeave(this, p, this.ranked());
    this.players.delete(p.id);
    this.event(E.LEAVE, p.x, p.y, p.id);
    this.rosterDirty = true;
    this.hooks.log(`P${p.id} ${p.name} left`, 'warn');
  }

  addBot() {
    const id = this.freeId();
    if (!id) return false;
    const used = new Set([...this.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `BOT${id}`;
    this.players.set(id, this.newPilot(id, name, true));
    this.event(E.JOIN, 0, 0, id);
    this.rosterDirty = true;
    return true;
  }

  removeBot() {
    const b = this.bots.sort((a, c) => c.id - a.id)[0];
    if (!b) return false;
    this.players.delete(b.id);
    this.event(E.LEAVE, b.x, b.y, b.id);
    this.rosterDirty = true;
    return true;
  }

  setBots(n) {
    n = Math.max(0, Math.min(C.MAX, n | 0));
    while (this.bots.length < n && this.addBot());
    while (this.bots.length > n && this.removeBot());
  }

  // ---- what consoles tell us ----------------------------------------------------------------
  fromBridge(p, m, now) {
    if (m.t === 'st') {
      const fl = m.fl | 0;
      p.inGame = !!(fl & F.INGAME);
      p.x = wrap(+m.x || 0); p.y = wrap(+m.y || 0); p.a = (m.a | 0) & 255;
      p.vx = (m.vx | 0) / 16; p.vy = (m.vy | 0) / 16;
      p.fl = fl;
      p.frame = m.f | 0;
      p.bullets = (Array.isArray(m.b) ? m.b : []).slice(0, C.MY_BUL).map((b) => ({ x: +b[0] || 0, y: +b[1] || 0, a: (b[2] | 0) & 255 }));
      p.lastSt = now;
      p.inCount++;
      if (!p.inGame && p.alive) p.alive = false;              // back on the title screen
      if (p.inGame && !p.alive && p.life === 0) p.respawnAt = Math.min(p.respawnAt, now);
      // The console says it is dead in the life we gave it: it is (a lost 'hit' lands here)
      if (p.alive && p.inGame && !(fl & F.ALIVE) && (m.life | 0) === p.life && now - p.spawnedAt > 400) this.kill(p, m.hit | 0, now);
    } else if (m.t === 'hit') {
      // The ship that was hit decides it was hit: always believed, for the life it is in.
      if (p.alive && (m.life | 0) === p.life) this.kill(p, m.by | 0, now);
    }
  }

  // ---- the rules -------------------------------------------------------------------------
  kill(victim, killerId, now) {
    victim.alive = false;
    victim.deaths++;
    victim.respawnAt = now + C.RESPAWN_MS;
    const killer = this.players.get(killerId);
    const shielded = now < victim.shieldUntil - 300;          // no credit for shooting a fresh spawn
    if (!this.roundOverAt) victim.roundDeaths++;
    if (killer && killer !== victim && !this.roundOverAt && !shielded) {
      killer.score++;
      if (victim.bot) killer.roundBotKills++; else killer.roundKills++;
      if (killer.score >= C.ROUND_KILLS) {
        this.winId = killer.id;
        this.roundOverAt = now;
        this.event(E.WIN, 0, 0, killer.id);
        this.hooks.log(`${killer.name} wins the round`);
        if (this.hooks.onRoundEnd) this.hooks.onRoundEnd(this, { winner: killer, ranked: this.ranked(), pilots: this.roundPilots() });
      }
    }
    this.event(E.KILL, victim.x, victim.y, killer ? killer.id : 0, victim.id);
    this.rosterDirty = true;
  }

  spawnPoint() {
    const others = [...this.players.values()].filter((o) => o.alive);
    let best = { x: 0, y: 0, d: -1 };
    for (let k = 0; k < 24; k++) {
      const x = Math.round(Math.random() * 180 - 90), y = Math.round(Math.random() * 180 - 90);
      let d = 1e9;
      for (const o of others) d = Math.min(d, Math.hypot(wd(o.x - x), wd(o.y - y)));
      if (d > best.d) best = { x, y, d };
    }
    return best;
  }

  spawn(p, now) {
    const s = this.spawnPoint();
    p.life = (p.life % 255) + 1;
    p.alive = true;
    p.x = s.x; p.y = s.y; p.a = Math.floor(Math.random() * 256); p.vx = p.vy = 0;
    p.lastSt = now;
    p.bullets = [];
    p.shieldUntil = now + C.SHIELD_FRAMES * C.TICK_MS;
    p.spawnedAt = now;
    if (!p.bot) p.inRound = true;
    this.event(E.SPAWN, p.x, p.y, p.id);
  }

  // the console's bullets, moved on from where it last said they were
  liveBullets(now) {
    const out = [];
    for (const p of this.players.values()) {
      if (p.bot) { for (const b of p.bullets) out.push({ x: b.x, y: b.y, a: b.a, o: p.id, ref: b }); continue; }
      const frames = Math.min(C.BUL_LIFE, (now - p.lastSt) / C.TICK_MS);
      for (const b of p.bullets) {
        out.push({ x: wrap(b.x + sinA(b.a) * C.BUL_SPEED * frames), y: wrap(b.y + cosA(b.a) * C.BUL_SPEED * frames), a: b.a, o: p.id, ref: b });
      }
    }
    return out;
  }

  botStep(b, now, targets) {
    if (!b.alive) return;
    if (now > b.errAt) { b.err = Math.round((Math.random() * 2 - 1) * C.BOT_AIM_ERR); b.errAt = now + 1000 + Math.random() * 1500; }
    let best = null, bd = 1e9;
    for (const t of targets) {
      if (t === b || !t.alive || now < t.shieldUntil) continue;
      const d = Math.hypot(wd(t.x - b.x), wd(t.y - b.y));
      if (d < bd) { bd = d; best = t; }
    }
    let thrust = false;
    if (best) {
      const want = (Math.round(Math.atan2(wd(best.x - b.x), wd(best.y - b.y)) * 128 / Math.PI) + b.err) & 255;
      const diff = ((want - b.a + 384) & 255) - 128;
      if (diff > 2) b.a = (b.a + C.BOT_ROT) & 255; else if (diff < -2) b.a = (b.a - C.BOT_ROT + 256) & 255;
      thrust = bd > C.BOT_KEEP && Math.abs(diff) < 50;         // keep a distance: no point-blank furballs
      if (b.cd > 0) b.cd--;
      if (Math.abs(diff) < C.BOT_AIM_TOL && bd < C.BOT_RANGE && b.cd === 0 && b.bullets.length < C.MY_BUL && Math.random() < C.BOT_TRIGGER) {
        b.bullets.push({ x: wrap(b.x + sinA(b.a) * 8), y: wrap(b.y + cosA(b.a) * 8), a: b.a, t: C.BUL_LIFE });
        b.cd = C.BOT_FIRE_CD;
      }
    } else {
      if (now > b.wander) { b.wander = now + 800 + Math.random() * 1200; b.turn = Math.random() < 0.5 ? -1 : 1; }
      b.a = (b.a + (b.turn || 1) * 2 + 256) & 255;
      thrust = Math.random() < 0.3;
    }
    if (thrust) { b.vx += sinA(b.a) * C.THRUST; b.vy += cosA(b.a) * C.THRUST; }
    b.vx -= b.vx / 32; b.vy -= b.vy / 32;
    const sp = Math.abs(b.vx) + Math.abs(b.vy);
    if (sp > C.VMAX) { b.vx = b.vx * C.VMAX / sp; b.vy = b.vy * C.VMAX / sp; }
    b.x = wrap(b.x + b.vx); b.y = wrap(b.y + b.vy);
    b.fl = F.ALIVE | (thrust ? F.THRUST : 0) | (now < b.shieldUntil ? F.SHIELD : 0) | F.INGAME;
    for (const u of b.bullets) { u.x = wrap(u.x + sinA(u.a) * C.BUL_SPEED); u.y = wrap(u.y + cosA(u.a) * C.BUL_SPEED); u.t--; }
    b.bullets = b.bullets.filter((u) => u.t > 0);
  }

  tick() {
    const now = Date.now();
    const all = [...this.players.values()];
    for (const b of all) if (b.bot) this.botStep(b, now, all);

    // bots are hit by what this room sees
    const bullets = this.liveBullets(now);
    for (const b of all) {
      if (!b.bot || !b.alive || now < b.shieldUntil) continue;
      for (const u of bullets) {
        if (u.o === b.id || u.gone) continue;
        const dx = wd(u.x - b.x), dy = wd(u.y - b.y);
        if (dx * dx + dy * dy < C.HIT_R2) {
          u.gone = true;
          const owner = this.players.get(u.o);
          if (owner && owner.bot) owner.bullets = owner.bullets.filter((x) => x !== u.ref);
          this.kill(b, u.o, now);
          break;
        }
      }
    }
    // respawns and the end of a round
    for (const p of all) if (p.inGame && !p.alive && now >= p.respawnAt) this.spawn(p, now);
    if (this.roundOverAt && now - this.roundOverAt > C.ROUND_PAUSE_MS) {
      for (const p of all) {
        p.score = 0; p.deaths = 0;
        p.roundKills = p.roundBotKills = p.roundDeaths = 0;
        p.inRound = !p.bot && p.inGame && p.alive;
      }
      this.roundOverAt = 0; this.winId = 0;
      this.event(E.ROUND);
      this.rosterDirty = true;
    }
    if (this.rosterDirty && now - this.lastRoster > 250) this.sendRoster(now);
    // snapshots on a fixed 50 ms grid: the 20 ms tick drifts, and "50 ms since the last" would round up to 60
    if (now >= this.nextSnap) {
      this.nextSnap = now - this.nextSnap > 2 * C.SNAP_MS ? now + C.SNAP_MS : this.nextSnap + C.SNAP_MS;
      this.sendSnap(now, bullets);
    }
    if (now - this.lastMon >= C.MON_MS) this.sendMonitors(now, bullets);
  }

  // A round counts for the leaderboards when two or more consoles took part in it.
  roundPilots() { return [...this.players.values()].filter((p) => p.bot || p.inRound); }
  ranked() { return this.humans.filter((p) => p.inRound).length >= 2; }

  shipsNow(now) {
    const out = [];
    for (const p of this.players.values()) {
      if (!p.inGame) continue;
      let x = p.x, y = p.y;
      if (!p.bot && p.alive) {
        const frames = Math.min(25, (now - p.lastSt) / C.TICK_MS);
        x = wrap(x + p.vx * frames); y = wrap(y + p.vy * frames);
      }
      let fl = p.bot ? p.fl : p.fl & (F.THRUST | F.SHIELD);
      fl = (fl & ~(F.ALIVE | F.BOT)) | (p.alive ? F.ALIVE : 0) | (p.bot ? F.BOT : 0);
      if (now < p.shieldUntil) fl |= F.SHIELD;
      out.push([p.id, i8(x), i8(y), p.a, fl, i8(p.vx * 16), i8(p.vy * 16)]);
    }
    return out;
  }

  sendSnap(now, bullets) {
    this.snapSeq++;
    const shared = JSON.stringify({
      t: 'snap', seq: this.snapSeq, ships: this.shipsNow(now),
      bul: bullets.filter((u) => !u.gone).slice(0, 80).map((u) => [i8(u.x), i8(u.y), u.a, u.o]),
      ev: this.events, np: this.players.size, rk: C.ROUND_KILLS, win: this.winId,
    }).slice(0, -1);
    for (const p of this.players.values()) {
      if (p.bot || !p.ws) continue;
      const you = {
        id: p.id, life: p.life, state: !p.inGame || !p.life ? S.SPECTATE : p.alive ? S.ALIVE : S.DEAD,
        sx: i8(p.x), sy: i8(p.y), sa: p.a, rin: p.alive ? 0 : Math.max(0, Math.ceil((p.respawnAt - now) / 100)),
      };
      this.hooks.send(p.ws, `${shared},"you":${JSON.stringify(you)}}`);
    }
  }

  rosterList() {
    return [...this.players.values()].sort((a, b) => a.id - b.id)
      .map((p) => [p.id, p.bot ? F.BOT : 0, p.score, p.deaths, p.name]);
  }

  sendRoster(now) {
    this.lastRoster = now;
    this.rosterDirty = false;
    this.rosterSeq++;
    const msg = JSON.stringify({ t: 'roster', seq: this.rosterSeq, rk: C.ROUND_KILLS, players: this.rosterList() });
    for (const p of this.players.values()) if (!p.bot && p.ws) this.hooks.send(p.ws, msg);
  }

  sendMonitors(now, bullets) {
    this.lastMon = now;
    this.hooks.toMonitors({
      t: 'ssnap', room: this.name, ships: this.shipsNow(now),
      bul: bullets.filter((u) => !u.gone).map((u) => [i8(u.x), i8(u.y), u.a, u.o]),
      win: this.winId, rk: C.ROUND_KILLS,
    });
  }

  // for the dashboard's once-a-second stats
  info() {
    return [...this.players.values()].sort((a, b) => b.score - a.score || a.deaths - b.deaths || a.id - b.id).map((p) => ({
      slot: p.id, name: p.name, bot: p.bot, cart: p.bot ? 'bot' : 'uvmc2', score: p.score, deaths: p.deaths,
      account: !!p.userId,
      alive: p.alive, inGame: p.inGame, rtt: p.rtt, rttHist: p.rttHist, inHz: p.inHz, frame: p.frame,
      since: p.since, bstat: p.bstat, lastAge: p.bot ? 0 : (p.lastSt ? Date.now() - p.lastSt : null),
    }));
  }
}

module.exports = { StrikeRoom, C, F, E, cleanName };

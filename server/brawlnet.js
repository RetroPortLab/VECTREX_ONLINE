// BRAWLNET: a two-player co-op side-scrolling beat-'em-up for the ZX Spectrum Next.
// Three stages (street, docks, foundry), each a run of fights against waves of thugs and ending in
// a boss. Punch combos, jump kicks, a spin special, weapons to pick up, food and cash from barrels.
//
// Who decides what: a console moves its own fighter (so walking and jumping feel instant) and says
// where it is, what it is doing and when it starts an attack. The relay checks the moves, runs every
// enemy and boss, flies knives and shockwaves, judges every hit both ways (hero -> enemy, enemy ->
// hero), drops items, moves the camera and steps through the waves and stages. When a hero is hit
// the relay takes over its position (hurt, knocked down, getting up) until it is back on its feet.
//
// Units: x is a pixel along the stage (0 .. width), y is the depth on the ground (0 .. 55; the feet
// are drawn at screen row 128 + y), z is the height above the ground. The relay ticks at 20 Hz;
// the consoles ease between snapshots.

const TICK_MS = 50;
const C = {
  HUMANS: 2, DEPTH: 55, GRAV: 1.5, HERO_HP: 100, LIVES: 3,
  RESPAWN: 50, INTRO: 70, CLEAR: 110, OVER: 120, VICTORY: 160,
  EXTRA_LIFE: 20000, FOOD_TICKS: 500, MAXE: 8, MAXI: 6, MAXP: 4,
};
const TEST = !!process.env.BRAWL_TEST;

// ---- the tables the Next shares (by number) -----------------------------------------------------
const ET = { GRUNT: 0, KNIFE: 1, BRUISER: 2, VIXEN: 3, BOSS1: 4, BOSS2: 5, BOSS3: 6, BARREL: 7 };
const ES = { IDLE: 0, WALK: 1, ATK: 2, HURT: 3, DOWN: 4, GETUP: 5, DEAD: 6, AIR: 7, SPECIAL: 8, RUN: 9 };
const HA = { IDLE: 0, WALK: 1, JAB1: 2, JAB2: 3, HOOK: 4, JUMP: 5, JKICK: 6, SPECIAL: 7, SWING: 8, HURT: 9, DOWN: 10, GETUP: 11, DEAD: 12, PICK: 13 };
const IT = { APPLE: 0, CHICKEN: 1, CASH: 2, GOLD: 3, KNIFE: 4, PIPE: 5, BAT: 6, ONEUP: 7 };
const EV = { HIT: 1, HEAVY: 2, KO: 3, DIE: 4, PICKUP: 5, BREAK: 6, WBREAK: 7, SPAWN: 8, CLEARED: 9, GO: 10, STAGE: 11, SCLEAR: 12,
  BOSS: 13, BOSSDOWN: 14, OVER: 15, WIN: 16, HURT: 17, HDOWN: 18, THROW: 19, SLAM: 20, ONEUP: 21, SWING: 22, JOIN: 23, LEAVE: 24, SPECIAL: 25 };
const ST = { LOBBY: 0, INTRO: 1, PLAY: 2, CLEAR: 3, OVER: 4, WIN: 5 };
const WP = { NONE: 0, KNIFE: 1, PIPE: 2, BAT: 3 };
const WEAPON = [null,
  { dmg: 10, reach: 32, kd: false, dur: 7 },
  { dmg: 15, reach: 40, kd: false, dur: 9 },
  { dmg: 20, reach: 44, kd: true, dur: 8 }];

// enemy kinds. hp, walk speed (px per tick), attacks: windup/active/recover ticks, reach, damage, knock-down, lunge speed
const TYPES = [
  { name: 'GRUNT', hp: 30, sp: 1.7, score: 100, armor: 0, atks: [
    { w: 5, a: 2, r: 5, reach: 26, dmg: 8, kd: false }, { w: 7, a: 2, r: 6, reach: 28, dmg: 12, kd: true }] },
  { name: 'KNIFE', hp: 24, sp: 2.7, score: 150, armor: 0, drop: IT.KNIFE, atks: [
    { w: 3, a: 2, r: 4, reach: 32, dmg: 10, kd: false, lunge: 3 }, { w: 4, a: 3, r: 5, reach: 34, dmg: 13, kd: true, lunge: 4 }] },
  { name: 'BRUISER', hp: 85, sp: 1.2, score: 300, armor: 2, atks: [
    { w: 9, a: 2, r: 9, reach: 36, dmg: 18, kd: true }, { w: 7, a: 3, r: 8, reach: 30, dmg: 13, kd: false }] },
  { name: 'VIXEN', hp: 36, sp: 2.4, score: 200, armor: 0, atks: [
    { w: 4, a: 2, r: 4, reach: 26, dmg: 7, kd: false }, { w: 6, a: 5, r: 6, reach: 38, dmg: 12, kd: true, lunge: 5, air: true }] },
  { name: 'CRUSHER', boss: true, hp: 240, sp: 1.5, score: 2000, atks: [
    { w: 6, a: 2, r: 6, reach: 42, dmg: 14, kd: true },
    { w: 8, a: 14, r: 10, reach: 34, dmg: 20, kd: true, lunge: 5, run: true },
    { w: 10, a: 2, r: 14, reach: 0, dmg: 16, kd: true, aoe: 72, wave: true }] },
  { name: 'BLADE', boss: true, hp: 270, sp: 2.2, score: 3000, atks: [
    { w: 4, a: 2, r: 5, reach: 36, dmg: 12, kd: false, lunge: 2 },
    { w: 7, a: 1, r: 12, reach: 0, dmg: 0, kd: false, throw: 3 },
    { w: 5, a: 7, r: 9, reach: 34, dmg: 16, kd: true, lunge: 6, run: true }] },
  { name: 'KING', boss: true, hp: 340, sp: 1.7, score: 5000, atks: [
    { w: 5, a: 2, r: 6, reach: 44, dmg: 16, kd: true },
    { w: 6, a: 5, r: 8, reach: 38, dmg: 18, kd: true, lunge: 4 },
    { w: 11, a: 2, r: 14, reach: 0, dmg: 14, kd: true, wave: true, aoe: 50 }] },
  { name: 'BARREL', hp: 14, sp: 0, score: 20, armor: 9, atks: [] },
];

// hero attacks (what the console says it is doing -> what it hits)
const HATK = {
  [HA.JAB1]: { dmg: 6, reach: 30, t1: 2, kd: false },
  [HA.JAB2]: { dmg: 7, reach: 30, t1: 2, kd: false },
  [HA.HOOK]: { dmg: 11, reach: 36, t1: 2, kd: true },
  [HA.JKICK]: { dmg: 12, reach: 34, t1: 4, kd: true, air: true },
  [HA.SPECIAL]: { dmg: 15, reach: 46, t1: 3, kd: true, both: true, cost: 6 },
  [HA.SWING]: { t1: 2, weapon: true },
};
const HERO_DMG = [1.1, 0.9];            // P1 hits harder, P2 is quicker (the console's side of that)

// the stages. waves: the camera stops at `lock`, the listed enemies come in [type, side, delay ticks]; barrels [x, y]
const STAGES = [
  { name: 'MIDNIGHT STREET', width: 1536, barrels: [[170, 38], [470, 14], [760, 40], [1010, 22], [1130, 44]], waves: [
    { lock: 0, e: [[ET.GRUNT, 'R', 0], [ET.GRUNT, 'R', 14]] },
    { lock: 250, e: [[ET.GRUNT, 'L', 0], [ET.GRUNT, 'R', 0], [ET.KNIFE, 'R', 20]] },
    { lock: 560, e: [[ET.KNIFE, 'R', 0], [ET.GRUNT, 'L', 10], [ET.KNIFE, 'L', 24], [ET.GRUNT, 'R', 34]] },
    { lock: 880, e: [[ET.BRUISER, 'R', 0], [ET.GRUNT, 'L', 16], [ET.GRUNT, 'R', 28]] },
    { lock: 1280, boss: ET.BOSS1, e: [[ET.BOSS1, 'R', 0]] }] },
  { name: 'HARBOUR DOCKS', width: 1792, barrels: [[200, 20], [520, 42], [800, 16], [1100, 40], [1360, 24]], waves: [
    { lock: 0, e: [[ET.KNIFE, 'R', 0], [ET.GRUNT, 'R', 12], [ET.GRUNT, 'L', 22]] },
    { lock: 300, e: [[ET.VIXEN, 'R', 0], [ET.VIXEN, 'L', 10], [ET.GRUNT, 'R', 30]] },
    { lock: 640, e: [[ET.BRUISER, 'L', 0], [ET.KNIFE, 'R', 14], [ET.KNIFE, 'R', 30], [ET.GRUNT, 'L', 40]] },
    { lock: 980, e: [[ET.VIXEN, 'R', 0], [ET.KNIFE, 'L', 8], [ET.BRUISER, 'R', 20], [ET.GRUNT, 'L', 36]] },
    { lock: 1536, boss: ET.BOSS2, e: [[ET.BOSS2, 'R', 0]] }] },
  { name: 'IRON FOUNDRY', width: 1792, barrels: [[180, 30], [450, 44], [760, 18], [1090, 36], [1300, 20]], waves: [
    { lock: 0, e: [[ET.GRUNT, 'R', 0], [ET.KNIFE, 'L', 8], [ET.VIXEN, 'R', 20], [ET.GRUNT, 'L', 30]] },
    { lock: 320, e: [[ET.BRUISER, 'R', 0], [ET.BRUISER, 'L', 20], [ET.KNIFE, 'R', 34]] },
    { lock: 660, e: [[ET.VIXEN, 'L', 0], [ET.VIXEN, 'R', 8], [ET.KNIFE, 'L', 18], [ET.KNIFE, 'R', 26], [ET.GRUNT, 'R', 40]] },
    { lock: 1000, e: [[ET.BRUISER, 'R', 0], [ET.VIXEN, 'L', 12], [ET.GRUNT, 'R', 22], [ET.KNIFE, 'L', 34], [ET.BRUISER, 'L', 46]] },
    { lock: 1536, boss: ET.BOSS3, e: [[ET.BOSS3, 'R', 0]] }] },
];

const NAMES = ['JAX', 'NOVA'];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const byte = (v) => clamp(Math.round(v), 0, 255);
const w16 = (v) => clamp(Math.round(v), 0, 65535);
const cleanName = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9 ._-]/g, '').trim().slice(0, 8);
const rnd = (n) => Math.floor(Math.random() * n);

class BrawlRoom {
  constructor(name, hooks) {
    this.name = name;
    this.hooks = hooks;           // { send(ws, str), toMonitors(msg), log(text, level), onGameEnd(room, result), onLeave(room, p) }
    this.pilots = new Map();
    this.state = ST.LOBBY;
    this.tick = 0; this.stateTicks = 0;
    this.events = []; this.evtId = 0;
    this.rosterSeq = 0; this.rosterDirty = true; this.lastRoster = 0;
    this.stageNo = 0; this.cam = 0; this.lim = 0; this.go = 0;
    this.enemies = []; this.items = []; this.projs = []; this.nextId = 1;
    this.ranked = false; this.runs = 0;
    this.timer = setInterval(() => this.step(), TICK_MS);
  }

  close() { clearInterval(this.timer); }
  get humans() { return [...this.pilots.values()]; }
  get empty() { return this.pilots.size === 0; }
  get size() { return this.pilots.size; }
  inGame() { return this.humans.filter((p) => p.inGame && p.inRun); }
  alive() { return this.humans.filter((p) => p.inRun && p.hs !== HA.DEAD && p.lives >= 0 && p.hp > 0); }

  event(kind, x = 0, y = 0, z = 0, a = 0) {
    this.evtId = (this.evtId % 255) + 1;
    this.events.push({ id: this.evtId, tick: this.tick, kind, x: w16(x), y: byte(y), z: byte(z), a: a & 255 });
    if (this.events.length > 14) this.events.shift();
  }

  newPilot(id, name) {
    return {
      id, name, ws: null, ip: '', userId: null,
      inGame: false, inRun: false, hs: 0, ht: 0, alive: false,
      x: 40, y: 28, z: 0, face: 0, act: 0, atkSeq: 0, hp: C.HERO_HP, lives: C.LIVES, score: 0, nextLife: C.EXTRA_LIFE,
      weapon: 0, wdur: 0, inv: 0, fix: 0, fixAck: 0, lastMoveAt: 0, vx: 0, vz: 0, hitCount: 0, hitReset: 0, respT: 0,
      atk: null, input: 0, flash: 0, kills: 0, hits: 0, specialUsed: false,
      since: Date.now(), inCount: 0, inHz: 0, rtt: null, rttHist: [], pings: new Map(), bstat: null, lastMsg: 0, frame: 0, fl: 0,
    };
  }

  // ---- who is in the room ---------------------------------------------------------------------------
  join(ws, name, ip, user) {
    if (this.humans.length >= C.HUMANS) return null;
    const id = [1, 2].find((i) => !this.pilots.has(i));
    const p = this.newPilot(id, (user ? cleanName(user.callsign) : cleanName(name)) || NAMES[id - 1]);
    p.ws = ws; p.ip = ip; p.userId = user ? user.id : null;
    this.pilots.set(id, p);
    this.rosterDirty = true;
    this.event(EV.JOIN, 0, 0, 0, id);
    this.hooks.log(`P${id} ${p.name} joined`);
    return p;
  }

  leave(p) {
    if (this.pilots.get(p.id) !== p) return;
    if (p.inRun && this.hooks.onLeave) this.hooks.onLeave(this, p);
    this.pilots.delete(p.id);
    this.rosterDirty = true;
    this.event(EV.LEAVE, 0, 0, 0, p.id);
    this.hooks.log(`P${p.id} ${p.name} left`, 'warn');
  }

  // ---- what consoles tell us -----------------------------------------------------------------------
  fromBridge(p, m, now) {
    if (m.t !== 'bm') return;
    p.inGame = !!((m.fl | 0) & 8);
    p.frame = m.f | 0;
    p.fl = m.fl | 0;
    p.lastMsg = now;
    p.inCount++;
    p.input = m.in | 0;
    if (!p.inGame) { if (p.inRun) this.dropOut(p); return; }
    if (!p.inRun || this.state !== ST.PLAY || p.hs === HA.DEAD) return;
    p.fixAck = m.fx | 0;
    const x = m.x | 0, y = (m.y | 0) & 255, z = (m.z | 0) & 255;
    if (p.hs !== 0) return;                                   // hurt / down: the relay moves it
    if (p.fixAck !== (p.fix & 255)) return;                   // it hasn't seen our last correction
    const dt = Math.min(0.5, Math.max(0.03, (now - (p.lastMoveAt || now)) / 1000));
    const far = Math.abs(x - p.x) > 200 * dt + 14 || Math.abs(y - p.y) > 120 * dt + 8;
    if (far) { if (Math.abs(x - p.x) > 3) p.fix++; }
    else { p.x = clamp(x, this.cam + 6, this.cam + 250); p.y = clamp(y, 0, C.DEPTH); p.z = clamp(z, 0, 90); }
    p.lastMoveAt = now;
    p.face = (m.fc | 0) & 1;
    const act = (m.ac | 0) & 15;
    p.act = act;
    const seq = (m.as | 0) & 255;
    if (seq !== p.atkSeq) {                                   // a new attack
      p.atkSeq = seq;
      if (HATK[act]) {
        p.atk = { kind: act, start: this.tick, hit: new Set(), weapon: p.weapon, paid: false };
        if (act === HA.SWING) this.event(EV.SWING, p.x, p.y, p.z, p.id);
      }
    }
  }

  dropOut(p) {
    p.inRun = false; p.alive = false;
    this.rosterDirty = true;
    if (!this.humans.some((q) => q.inRun)) this.endRun(false);
  }

  // ---- a run through the stages ---------------------------------------------------------------------
  startRun() {
    const ps = this.humans.filter((p) => p.inGame);
    if (!ps.length) return;
    this.runs++;
    this.ranked = ps.length >= 2;
    this.stageNo = TEST && process.env.BRAWL_STAGE ? Number(process.env.BRAWL_STAGE) % STAGES.length : 0;
    for (const p of this.humans) { p.inRun = false; p.alive = false; }
    for (const p of ps) {
      Object.assign(p, { inRun: true, lives: C.LIVES, score: 0, nextLife: C.EXTRA_LIFE, hp: C.HERO_HP, weapon: 0, wdur: 0, kills: 0, hits: 0 });
    }
    this.hooks.log(`run ${this.runs}: ${ps.map((p) => p.name).join(' + ')}`);
    this.beginStage();
    this.rosterDirty = true;
  }

  beginStage() {
    const S = STAGES[this.stageNo];
    this.stage = S;
    this.cam = 0; this.lim = 0; this.go = 0;
    this.enemies = []; this.items = []; this.projs = [];
    this.waveNo = -1; this.wave = null; this.queue = []; this.fight = false; this.bossId = 0; this.bossDead = false;
    this.barrelsLeft = S.barrels.map(([x, y]) => ({ x, y }));
    for (const b of this.barrelsLeft) this.addEnemy(ET.BARREL, b.x, b.y);
    const ps = this.humans.filter((p) => p.inRun);
    ps.forEach((p, i) => this.spawnHero(p, 30 + i * 22, 22 + i * 14, true));
    this.event(EV.STAGE, 0, 0, 0, this.stageNo);
    this.setState(ST.INTRO);
    if (TEST && process.env.BRAWL_WAVE) { this.waveNo = Number(process.env.BRAWL_WAVE) - 1; }
    this.nextWave();
  }

  spawnHero(p, x, y, fresh) {
    p.x = x; p.y = y; p.z = 0; p.hs = 0; p.ht = 0; p.alive = true; p.face = 0; p.act = 0;
    p.hp = fresh ? Math.max(p.hp, 70) : C.HERO_HP; p.vx = 0; p.vz = 0; p.inv = fresh ? 0 : 50; p.hitCount = 0; p.atk = null;
    if (!fresh) { p.weapon = 0; p.wdur = 0; }
    p.fix++;
  }

  nextWave() {
    this.waveNo++;
    const S = this.stage;
    if (this.waveNo >= S.waves.length) { this.wave = null; this.lim = S.width - 256; return; }
    this.wave = S.waves[this.waveNo];
    this.lim = this.wave.lock;
    this.fight = false;
  }

  endRun(win) {
    const ps = this.humans.filter((p) => p.inRun || p.score);
    const result = { ranked: this.ranked, win, stage: this.stageNo, players: ps };
    if (this.hooks.onGameEnd) this.hooks.onGameEnd(this, result);
    for (const p of this.humans) p.inRun = false;
    this.rosterDirty = true;
    this.setState(ST.LOBBY);
  }

  setState(s) { this.state = s; this.stateTicks = 0; }

  // ---- enemies ----------------------------------------------------------------------------------------
  addEnemy(type, x, y) {
    const T = TYPES[type];
    const two = this.humans.filter((p) => p.inRun).length >= 2;
    const hp = Math.round(T.hp * (two && T.boss ? 1.45 : two ? 1.15 : 1));
    const e = { id: this.nextId++, type, x, y, z: 0, face: 1, st: ES.IDLE, t: 0, hp, maxhp: hp, flash: 0, vx: 0, vy: 0, vz: 0,
      atk: 0, cool: 4 + rnd(12), stun: 0, combo: 0, inv: 0, off: (rnd(2) ? 1 : -1) * (70 + rnd(40)), approach: false, hitSet: null, phase: 0,
      downs: 0, hitStun: 0, enter: 0, lastHitBy: 0, thrown: 0 };
    if (this.enemies.length >= C.MAXE + 8) return null;
    this.enemies.push(e);
    return e;
  }

  spawnFromQueue() {
    const q = this.queue;
    const two = this.humans.filter((p) => p.inRun).length >= 2;
    const cap = this.wave && this.wave.boss !== undefined ? 6 : (two ? 5 : 4);
    const live = () => this.enemies.filter((e) => e.type !== ET.BARREL && e.st !== ES.DEAD).length;
    for (let i = 0; i < q.length; i++) {
      if (q[i].d > 0) q[i].d--;
      if (q[i].d <= 0 && live() < cap) {
        const [type, side] = q[i].s;
        const x = side === 'L' ? this.cam - 24 : this.cam + 280;
        const e = this.addEnemy(type, x, 8 + rnd(40));
        if (e) {
          e.enter = 30; e.face = side === 'L' ? 0 : 1;
          this.event(EV.SPAWN, x, e.y, 0, type);
          if (TYPES[type].boss) { this.bossId = e.id; e.enter = 50; this.event(EV.BOSS, x, e.y, 0, type); }
        }
        q.splice(i, 1); i--;
      }
    }
  }

  heroTarget(e) {
    let best = null, bd = 1e9;
    for (const p of this.alive()) {
      if (p.hs === HA.DEAD) continue;
      const d = Math.abs(p.x - e.x) + 2 * Math.abs(p.y - e.y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  stepEnemy(e) {
    const T = TYPES[e.type];
    e.t++;
    if (e.flash > 0) e.flash--;
    if (e.inv > 0) e.inv--;
    if (e.type === ET.BARREL) { if (e.st === ES.HURT && e.t > 3) { e.st = ES.IDLE; e.t = 0; } return; }
    // physics: knock-back and falling
    if (e.z > 0 || e.vz !== 0) { e.z += e.vz; e.vz -= C.GRAV; if (e.z <= 0) { e.z = 0; e.vz = 0; if (e.st === ES.DEAD || e.st === ES.DOWN) e.vx *= 0.3; } }
    if (e.vx) { e.x += e.vx; e.vx *= (e.z > 0 ? 0.97 : 0.8); if (Math.abs(e.vx) < 0.2) e.vx = 0; }
    e.x = clamp(e.x, -40, this.stage.width + 40);
    e.y = clamp(e.y, 0, C.DEPTH);
    switch (e.st) {
      case ES.DEAD: if (e.t > 24) e.gone = true; return;
      case ES.HURT: if (e.t >= e.hitStun) { e.st = ES.IDLE; e.t = 0; e.combo = 0; } return;
      case ES.DOWN:
        if (e.z === 0 && e.t > 6 + (e.downT || 0) + 8) { e.st = ES.GETUP; e.t = 0; }
        return;
      case ES.GETUP: if (e.t >= 6) { e.st = ES.IDLE; e.t = 0; e.inv = 6; e.cool = 6; } return;
      default: break;
    }
    if (e.cool > 0) e.cool--;
    const tgt = this.heroTarget(e);
    if (!tgt) { e.st = ES.IDLE; return; }
    const dx = tgt.x - e.x, dy = tgt.y - e.y;
    if (e.enter > 0) {                                            // walking in from off screen
      e.enter--;
      e.st = ES.WALK;
      e.x += (dx > 0 ? 1 : -1) * T.sp * 1.3; e.face = dx < 0 ? 1 : 0;
      return;
    }
    if (e.st === ES.ATK || e.st === ES.SPECIAL || e.st === ES.RUN || e.st === ES.AIR) { this.stepAttack(e, T, tgt, dx, dy); return; }
    // choose: attack, approach, or hang back
    e.face = dx < 0 ? 1 : 0;
    const tokens = this.humans.filter((p) => p.inRun).length >= 2 ? 3 : 2;
    const busy = this.enemies.filter((o) => o !== e && !TYPES[o.type].boss && o.type !== ET.BARREL && (o.st === ES.ATK || o.st === ES.AIR || o.approach)).length;
    if (T.boss) e.approach = true;
    else if (e.approach === false && busy < tokens) e.approach = true;
    if (process.env.BRAWL_PASSIVE && TEST) e.approach = false;
    let tx, ty, speed = T.sp;
    if (e.approach) {
      const atk = T.atks[e.atkNext || 0] || T.atks[0];
      const range = T.boss && (e.atkNext === 1 && e.type === ET.BOSS2) ? 140 : atk.reach ? atk.reach - 6 : 40;
      tx = tgt.x - Math.sign(dx || 1) * range * 0.8; ty = tgt.y;
      if (T.boss && e.atkNext === 1 && e.type === ET.BOSS2) { tx = tgt.x - Math.sign(dx || 1) * 130; }
    } else {
      tx = tgt.x - Math.sign(dx || 1) * 0 + e.off; ty = tgt.y + (e.off > 0 ? 8 : -8); speed = T.sp * 0.7;
      if (Math.abs(e.x - tx) < 8) { e.st = ES.IDLE; }
    }
    const ex = tx - e.x, ey = ty - e.y;
    const moving = Math.abs(ex) > 4 || Math.abs(ey) > 3;
    if (moving) {
      e.x += clamp(ex, -speed, speed); e.y += clamp(ey, -speed * 0.7, speed * 0.7);
      e.st = ES.WALK;
    } else e.st = ES.IDLE;
    // attack?
    if (e.cool <= 0 && e.approach && !(TEST && process.env.BRAWL_PASSIVE)) {
      const kind = this.chooseAttack(e, T, dx, dy);
      if (kind >= 0) this.startAttack(e, T, kind);
    }
  }

  chooseAttack(e, T, dx, dy) {
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (ady > 12) return -1;
    if (e.type === ET.BOSS1) {
      if (adx > 130 && Math.random() < 0.15) return 1;
      if (adx < 60 && Math.random() < 0.3) return 2;
      if (adx < 46) return 0;
      return -1;
    }
    if (e.type === ET.BOSS2) {
      if (adx > 110) return 1;
      if (adx > 70 && Math.random() < 0.4) return 2;
      if (adx < 42) return Math.random() < 0.4 ? 2 : 0;
      return -1;
    }
    if (e.type === ET.BOSS3) {
      const p2 = e.hp < e.maxhp / 2;
      if (adx < 70 && Math.random() < (p2 ? 0.45 : 0.25)) return 2;
      if (adx < 48) return Math.random() < 0.5 ? 0 : 1;
      if (adx < 110 && Math.random() < 0.4) return 1;
      return -1;
    }
    const k = (e.type === ET.VIXEN && adx > 40 && adx < 90 && Math.random() < 0.6) ? 1 : (Math.random() < 0.3 ? 1 : 0);
    const atk = T.atks[k];
    if (adx > atk.reach - 4 && !atk.lunge) return -1;
    if (atk.lunge && adx > atk.reach + 40) return -1;
    return k;
  }

  startAttack(e, T, kind) {
    const a = T.atks[kind];
    e.atk = kind; e.t = 0; e.hitSet = new Set(); e.atkNext = (e.atkNext || 0);
    e.st = a.air ? ES.AIR : a.run ? ES.RUN : a.wave ? ES.SPECIAL : ES.ATK;
    if (a.air) e.vz = 0;
  }

  stepAttack(e, T, tgt, dx, dy) {
    const a = T.atks[e.atk];
    const t = e.t;
    const dir = e.face ? -1 : 1;
    const act0 = a.w, act1 = a.w + a.a;
    if (t < act0) {
      if (a.run && t > 2) { e.st = ES.ATK; }
      return;
    }
    if (t === act0) {
      if (a.throw) { for (let i = 0; i < a.throw; i++) this.addProj(0, e.x + dir * 20, e.y + (i - 1) * 7, 26 - (i === 1 ? 4 : 0), dir * 6.5, 40, e.id, 0, i * 3); this.event(EV.THROW, e.x, e.y, 24, e.type); }
      if (a.wave) { this.event(EV.SLAM, e.x, e.y, 0, e.type); }
      if (a.air) e.vz = 6.5;
      if (a.run) e.st = ES.RUN;
      if (e.type >= ET.BOSS1 && !a.throw && !a.wave && !a.run) this.event(EV.SWING, e.x, e.y, 0, e.type);
    }
    if (t >= act0 && t < act1) {
      if (a.lunge) e.x += dir * a.lunge;
      if (a.run) e.st = ES.RUN;
      if (a.air) { e.z += e.vz; e.vz -= 1.2; if (e.z < 0) e.z = 0; }
      // can it hit anyone?
      for (const h of this.alive()) {
        if (h.inv > 0 || h.hs === HA.DOWN || h.hs === HA.GETUP || e.hitSet.has(h.id)) continue;
        const hx = h.x - e.x;
        if (a.wave) {
          if (t === act0 + 0 && Math.abs(hx) < (a.aoe || 60) && Math.abs(h.y - e.y) < 18 && h.z < 14) { e.hitSet.add(h.id); this.hitHero(h, a, e, hx); }
          continue;
        }
        const front = e.face ? -hx : hx;
        if (front > -8 && front < a.reach && Math.abs(h.y - e.y) < 10 && Math.abs(h.z - e.z) < 24) { e.hitSet.add(h.id); this.hitHero(h, a, e, hx); }
      }
      if (t === act0 && a.wave) this.addProj(1, e.x, e.y, 0, 3.8, 26, e.id, e.type, 0), this.addProj(1, e.x, e.y, 0, -3.8, 26, e.id, e.type, 0);
    }
    if (t >= act1 + a.r - (a.run ? 0 : 0)) {
      e.st = ES.IDLE; e.t = 0; e.vz = 0; if (e.z > 0 && !a.air) e.z = 0; if (a.air) e.z = 0;
      e.cool = (T.boss ? 8 : 5 + rnd(8)) + (e.type === ET.BRUISER ? 8 : 0);
      e.approach = T.boss ? true : false;
      e.atkNext = e.type === ET.BOSS1 || e.type === ET.BOSS2 || e.type === ET.BOSS3 ? 0 : 0;
      if (e.type === ET.GRUNT && Math.random() < 0.5) e.off = -e.off;
    }
  }

  addProj(kind, x, y, z, vx, life, owner, a, delay) {
    if (this.projs.length >= C.MAXP + 2) return;
    this.projs.push({ id: this.nextId++, kind, x, y, z, vx, life, owner, a, delay: delay || 0, hit: new Set() });
  }

  stepProjs() {
    for (const p of this.projs) {
      if (p.delay > 0) { p.delay--; continue; }
      p.x += p.vx; p.life--;
      for (const h of this.alive()) {
        if (h.inv > 0 || h.hs === HA.DOWN || h.hs === HA.GETUP || p.hit.has(h.id)) continue;
        const hit = p.kind === 0 ? Math.abs(h.x - p.x) < 10 && Math.abs(h.y - p.y) < 8 && Math.abs(h.z + 14 - p.z) < 20
          : Math.abs(h.x - p.x) < 8 && Math.abs(h.y - p.y) < 20 && h.z < 12;
        if (hit) { p.hit.add(h.id); this.hitHero(h, p.kind === 0 ? { dmg: 8, kd: false } : { dmg: 14, kd: true }, { x: p.x - p.vx * 2 }, h.x - p.x); if (p.kind === 0) p.life = 0; }
      }
    }
    this.projs = this.projs.filter((p) => p.life > 0 && p.x > this.cam - 60 && p.x < this.cam + 320);
  }

  // ---- hits ------------------------------------------------------------------------------------------------
  hitHero(h, a, from, hx) {
    if (TEST && process.env.BRAWL_GOD) return;
    h.hp -= a.dmg;
    h.hitCount++; h.hitReset = 28;
    h.atk = null;
    const dir = hx >= 0 ? 1 : -1;                                // push away from the attacker
    h.flash = 3;
    if (h.hp <= 0) {
      h.hp = 0; h.hs = HA.DEAD; h.ht = 0; h.vx = dir * 3.5; h.vz = 6; h.lives--; h.alive = false;
      this.event(EV.DIE, h.x, h.y, h.z, h.id); h.respT = C.RESPAWN; h.fix++;
      if (this.alive().length === 0 && !this.humans.some((q) => q.inRun && q.lives > 0)) this.gameOver();
    } else if (a.kd || h.hitCount >= 3 || h.z > 0) {
      h.hs = HA.DOWN; h.ht = 0; h.vx = dir * 3.2; h.vz = 5.5; h.hitCount = 0; h.fix++;
      this.event(EV.HDOWN, h.x, h.y, h.z, h.id);
    } else {
      h.hs = HA.HURT; h.ht = 0; h.vx = dir * 1.2; h.fix++;
      this.event(EV.HURT, h.x, h.y, h.z, h.id);
    }
    if (h.hs === HA.DOWN || h.hs === HA.DEAD) h.weapon = h.hs === HA.DEAD ? 0 : h.weapon;
  }

  stepHero(p) {
    if (p.hitReset > 0 && --p.hitReset === 0) p.hitCount = 0;
    if (p.inv > 0) p.inv--;
    if (p.flash > 0) p.flash--;
    if (p.hs === 0) { this.stepHeroAttack(p); this.stepPickups(p); return; }
    p.ht++;
    // relay-driven: knocked about, down, getting up, dead
    if (p.z > 0 || p.vz) { p.z += p.vz; p.vz -= C.GRAV; if (p.z <= 0) { p.z = 0; p.vz = 0; p.vx *= 0.3; } }
    if (p.vx) { p.x = clamp(p.x + p.vx, this.cam + 6, this.cam + 250); p.vx *= p.z > 0 ? 0.97 : 0.8; if (Math.abs(p.vx) < 0.2) p.vx = 0; }
    if (p.hs === HA.HURT) { if (p.ht >= 7) { p.hs = 0; p.fix++; } }
    else if (p.hs === HA.DOWN) { if (p.z === 0 && p.ht > 16) { p.hs = HA.GETUP; p.ht = 0; } }
    else if (p.hs === HA.GETUP) { if (p.ht >= 6) { p.hs = 0; p.inv = 24; p.fix++; } }
    else if (p.hs === HA.DEAD) {
      if (p.lives > 0 && --p.respT <= 0 && this.state === ST.PLAY) this.spawnHero(p, this.cam + 40, 26 + rnd(10), false);
    }
  }

  stepHeroAttack(p) {
    const at = p.atk;
    if (!at) return;
    const A = HATK[at.kind];
    const age = this.tick - at.start;
    if (age > A.t1) { p.atk = null; return; }
    if (A.air && p.z < 3) return;
    if (A.cost && !at.paid) { at.paid = true; if (p.hp > A.cost + 1) { p.hp -= A.cost; p.flash = 2; } this.event(EV.SPECIAL, p.x, p.y, p.z, p.id); }
    let dmg = A.dmg, reach = A.reach, kd = A.kd, both = A.both;
    if (A.weapon) {
      const W = WEAPON[at.weapon];
      if (!W || p.weapon !== at.weapon) return;
      dmg = W.dmg; reach = W.reach; kd = W.kd;
    }
    dmg = Math.round(dmg * HERO_DMG[(p.id - 1) % 2]);
    const dir = p.face ? -1 : 1;
    let any = false;
    for (const e of this.enemies) {
      if (e.st === ES.DEAD || e.gone || at.hit.has(e.id)) continue;
      if (e.inv > 0 || (e.st === ES.DOWN && e.z === 0 && e.type !== ET.BARREL) || (e.st === ES.GETUP && e.t < 3)) continue;
      const dx = e.x - p.x;
      const front = both ? Math.abs(dx) : dx * dir;
      const rr = e.type >= ET.BOSS1 ? reach + 6 : reach;
      if (front > -10 && front < rr && Math.abs(e.y - p.y) < (both ? 18 : 11) && Math.abs(e.z - p.z) < 30) {
        at.hit.add(e.id);
        this.hitEnemy(e, p, dmg, kd, dx >= 0 ? 1 : -1, both ? 1 : 0);
        any = true;
      }
    }
    if (any && A.weapon && --p.wdur <= 0) { this.event(EV.WBREAK, p.x, p.y, p.z, p.weapon); p.weapon = 0; p.wdur = 0; }
  }

  hitEnemy(e, p, dmg, kd, dir, aoe) {
    const T = TYPES[e.type];
    p.hits++;
    e.hp -= dmg;
    e.flash = 3; e.lastHitBy = p.id;
    p.score += dmg * 10;
    if (e.type === ET.BARREL) {
      if (e.hp <= 0) { this.breakBarrel(e); return; }
      e.st = ES.HURT; e.t = 0; this.event(EV.HIT, e.x, e.y, 12, 0); return;
    }
    this.event(kd ? EV.HEAVY : EV.HIT, e.x, e.y, e.z + 20, e.type);
    if (e.hp <= 0) {
      e.hp = 0; e.st = ES.DEAD; e.t = 0; e.vx = dir * 3.5; e.vz = 6; e.atk = 0;
      p.score += T.score; p.kills++;
      this.event(EV.KO, e.x, e.y, e.z, e.type);
      if (T.boss) { this.event(EV.BOSSDOWN, e.x, e.y, 0, e.type); this.bossDead = true; }
      this.dropFrom(e);
      this.checkLife(p);
      return;
    }
    e.combo++;
    const armored = (T.armor || 0) > 0 && e.combo <= T.armor && !kd;
    if (T.boss) {
      // bosses: flinch a little, go down only at thresholds (a third of their health)
      const frac = e.hp / e.maxhp;
      const lvl = frac < 0.34 ? 2 : frac < 0.67 ? 1 : 0;
      if (lvl > e.downs) {
        e.downs = lvl; e.st = ES.DOWN; e.t = 0; e.vx = dir * 3; e.vz = 5.5; e.downT = 10; e.inv = 0;
        this.event(EV.KO, e.x, e.y, e.z, e.type);
        if (e.type === ET.BOSS3 && lvl === 1) this.queue.push({ s: [ET.GRUNT, 'L'], d: 6 }, { s: [ET.KNIFE, 'R'], d: 12 });
      } else if (e.st !== ES.ATK && e.st !== ES.RUN && e.st !== ES.SPECIAL && e.st !== ES.AIR && e.combo >= 2) {
        e.st = ES.HURT; e.t = 0; e.hitStun = 3; e.vx = dir * 0.8; e.combo = 0;
      }
      return;
    }
    if (kd || e.combo >= 3 || e.z > 0) {
      e.st = ES.DOWN; e.t = 0; e.vx = dir * 3.2; e.vz = 5.5; e.combo = 0; e.downT = 0; e.atk = 0; e.approach = false;
      this.event(EV.KO, e.x, e.y, e.z, e.type);
    } else if (!armored) {
      e.st = ES.HURT; e.t = 0; e.hitStun = 7; e.vx = dir * 1.6; e.atk = 0; e.approach = false;
    } else {
      e.vx = dir * 0.6;                                         // armour: it flinches but carries on
    }
  }

  checkLife(p) {
    while (p.score >= p.nextLife) { p.nextLife += C.EXTRA_LIFE; p.lives = Math.min(9, p.lives + 1); this.event(EV.ONEUP, p.x, p.y, p.z, p.id); }
  }

  breakBarrel(e) {
    e.st = ES.DEAD; e.t = 0; e.gone = true;
    this.event(EV.BREAK, e.x, e.y, 10, 0);
    const r = Math.random();
    const kind = r < 0.2 ? IT.APPLE : r < 0.32 ? IT.CHICKEN : r < 0.56 ? IT.CASH : r < 0.64 ? IT.GOLD : r < 0.78 ? IT.KNIFE : r < 0.9 ? IT.PIPE : IT.BAT;
    this.addItem(kind, e.x, e.y);
  }

  dropFrom(e) {
    const T = TYPES[e.type];
    if (T.boss) { this.addItem(IT.CHICKEN, e.x - 20, e.y); this.addItem(IT.GOLD, e.x + 20, e.y); return; }
    const r = Math.random();
    if (T.drop && r < 0.5) this.addItem(T.drop, e.x, e.y);
    else if (r < 0.12) this.addItem(IT.APPLE, e.x, e.y);
    else if (r < 0.28) this.addItem(IT.CASH, e.x, e.y);
  }

  addItem(kind, x, y) {
    if (this.items.length >= C.MAXI) { const old = this.items.findIndex((i) => i.kind >= IT.KNIFE && i.kind <= IT.BAT); this.items.splice(old >= 0 ? old : 0, 1); }
    this.items.push({ id: this.nextId++, kind, x: clamp(x, this.cam + 12, this.cam + 244), y: clamp(y, 2, C.DEPTH), z: 24, vz: 3, age: 0 });
  }

  stepItems() {
    for (const i of this.items) {
      i.age++;
      if (i.z > 0 || i.vz) { i.z += i.vz; i.vz -= 1.2; if (i.z <= 0) { i.z = 0; i.vz = i.vz < -3 ? 2 : 0; } }
    }
    this.items = this.items.filter((i) => !((i.kind <= IT.GOLD || i.kind === IT.ONEUP) && i.age > C.FOOD_TICKS));
  }

  stepPickups(p) {
    for (let k = 0; k < this.items.length; k++) {
      const i = this.items[k];
      if (Math.abs(i.x - p.x) > 14 || Math.abs(i.y - p.y) > 9 || i.z > 6) continue;
      if (i.kind >= IT.KNIFE && i.kind <= IT.BAT) {
        if (p.weapon) continue;
        p.weapon = i.kind - IT.KNIFE + 1; p.wdur = WEAPON[p.weapon].dur;
      } else if (i.kind === IT.APPLE) { if (p.hp >= C.HERO_HP) continue; p.hp = Math.min(C.HERO_HP, p.hp + 15); }
      else if (i.kind === IT.CHICKEN) { if (p.hp >= C.HERO_HP) continue; p.hp = Math.min(C.HERO_HP, p.hp + 40); }
      else if (i.kind === IT.CASH) { p.score += 200; this.checkLife(p); }
      else if (i.kind === IT.GOLD) { p.score += 1000; this.checkLife(p); }
      else if (i.kind === IT.ONEUP) { p.lives = Math.min(9, p.lives + 1); }
      this.event(EV.PICKUP, i.x, i.y, 10, i.kind);
      this.items.splice(k, 1); k--;
    }
  }

  // ---- the camera and the waves --------------------------------------------------------------------------
  stepCamera() {
    const ps = this.alive().filter((p) => p.hs !== HA.DEAD);
    let want = this.cam;
    if (ps.length) want = Math.max(...ps.map((p) => p.x)) - 118;
    const max = Math.min(this.lim, this.stage.width - 256);
    want = clamp(want, this.cam, max);
    this.cam = Math.min(want, this.cam + 3);
    this.cam = clamp(this.cam, 0, this.stage.width - 256);
    for (const p of this.humans) if (p.inRun && p.hs === 0) p.x = clamp(p.x, this.cam + 6, this.cam + 250);
  }

  stepWaves() {
    const W = this.wave;
    const enemiesLeft = this.enemies.filter((e) => e.type !== ET.BARREL && e.st !== ES.DEAD).length;
    if (!W) {                                                    // past the last wave: the stage is won
      if (this.bossDead && enemiesLeft === 0) { this.stageClear(); }
      return;
    }
    if (!this.fight) {
      if (this.cam >= W.lock - 1) {                              // the camera has reached the wave's stop
        this.fight = true; this.go = 0;
        const two = this.humans.filter((p) => p.inRun).length >= 2;
        this.queue = W.e.map((s) => ({ s: [s[0], s[1]], d: s[2] }));
        if (two && !W.boss) { const e0 = W.e[0]; this.queue.push({ s: [e0[0] === ET.BRUISER ? ET.GRUNT : e0[0], e0[1] === 'L' ? 'R' : 'L'], d: 20 }); }
        this.event(EV.STAGE, 0, 0, 0, 100 + this.waveNo);
      }
      return;
    }
    this.spawnFromQueue();
    if (this.queue.length === 0 && enemiesLeft === 0) {
      this.fight = false;
      if (W.boss !== undefined) { this.nextWave(); this.bossDead = true; return; }
      this.event(EV.CLEARED, 0, 0, 0, this.waveNo);
      this.nextWave();
    }
  }

  stageClear() {
    if (this.state !== ST.PLAY) return;
    for (const p of this.alive()) { p.score += Math.round(p.hp) * 10; this.checkLife(p); }
    this.event(EV.SCLEAR, 0, 0, 0, this.stageNo);
    this.setState(ST.CLEAR);
  }

  gameOver() { this.event(EV.OVER); this.setState(ST.OVER); }

  // ---- the clock -----------------------------------------------------------------------------------------------
  step() {
    const now = Date.now();
    this.tick++;
    this.stateTicks++;
    if (this.state === ST.LOBBY) {
      if (this.humans.some((p) => p.inGame)) this.startRun();
    } else if (this.state === ST.INTRO) {
      if (this.stateTicks >= C.INTRO) this.setState(ST.PLAY);
      this.joinLate();
    } else if (this.state === ST.PLAY) {
      this.joinLate();
      for (const p of this.humans) if (p.inRun) this.stepHero(p);
      for (const e of this.enemies) this.stepEnemy(e);
      this.enemies = this.enemies.filter((e) => !e.gone);
      this.stepProjs();
      this.stepItems();
      this.stepWaves();
      this.stepCamera();
      this.go = (!this.fight && this.enemies.filter((e) => e.type !== ET.BARREL).length === 0 && this.lim > this.cam + 8 && this.state === ST.PLAY) ? 1 : 0;
      if (this.go && this.tick % 40 === 0) this.event(EV.GO);
    } else if (this.state === ST.CLEAR) {
      for (const p of this.humans) if (p.inRun) this.stepHero(p);
      if (this.stateTicks >= C.CLEAR) {
        this.stageNo++;
        if (this.stageNo >= STAGES.length) { this.event(EV.WIN); this.setState(ST.WIN); }
        else this.beginStage();
      }
    } else if (this.state === ST.OVER) {
      for (const e of this.enemies) this.stepEnemy(e);
      if (this.stateTicks >= C.OVER) this.endRun(false);
    } else if (this.state === ST.WIN) {
      if (this.stateTicks >= C.VICTORY) this.endRun(true);
    }
    if (this.state !== ST.LOBBY && !this.humans.some((p) => p.inGame || p.inRun)) this.setState(ST.LOBBY);
    if (TEST && process.env.BRAWL_LOG && this.tick % 100 === 0) console.log('[brawl]', this.tick, 'st', this.state, 'cam', Math.round(this.cam), 'lim', this.lim, 'fight', this.fight, 'q', this.queue && this.queue.length, 'wave', this.waveNo, 'heroes', this.humans.map((p) => [Math.round(p.x), p.hp, p.hs].join('/')).join(' '), 'en', this.enemies.map((e) => [e.type, e.st, Math.round(e.x), Math.round(e.y), e.hp].join(':')).join(' '));
    this.send(now);
  }

  joinLate() {
    for (const p of this.humans) {
      if (p.inGame && !p.inRun && this.state !== ST.OVER && this.state !== ST.WIN) {
        Object.assign(p, { inRun: true, lives: C.LIVES, score: 0, nextLife: C.EXTRA_LIFE, hp: C.HERO_HP, weapon: 0, wdur: 0 });
        this.spawnHero(p, this.cam + 40, 30, false);
        this.ranked = false;
        this.rosterDirty = true;
      }
    }
  }

  // ---- what we send -------------------------------------------------------------------------------------------------
  heroRow(p) {
    return [p.id, p.hs ? p.hs : p.act, w16(p.x), byte(p.y), byte(p.z), (p.face ? 1 : 0) | (p.flash ? 2 : 0) | (p.inv > 0 && (this.tick & 2) ? 4 : 0) | (p.weapon << 4),
      byte(p.ht), Math.max(0, byte(p.hp)), p.lives < 0 ? 0 : p.lives];
  }
  enemyRows() {
    return this.enemies.filter((e) => !e.gone && e.x > this.cam - 90 && e.x < this.cam + 350).slice(0, C.MAXE + 2).map((e) => [e.id, (e.type << 4) | e.st, w16(e.x), byte(e.y), byte(e.z),
      (e.face ? 1 : 0) | (e.flash ? 2 : 0) | (e.atk << 4), byte(e.t), e.type >= ET.BOSS1 ? byte(e.hp * 255 / e.maxhp) : e.type === ET.BARREL ? byte(e.hp * 255 / 14) : byte(e.hp * 255 / e.maxhp)]);
  }
  body() {
    const recent = this.events.filter((e) => this.tick - e.tick < 6).slice(-8);
    const boss = this.enemies.find((e) => e.id === this.bossId);
    return {
      seq: this.tick, st: this.state, stage: this.stageNo, cam: w16(this.cam), lim: w16(this.lim), go: this.go, tk: Math.min(255, this.stateTicks),
      wave: Math.max(0, this.waveNo), boss: boss ? byte(boss.hp * 255 / boss.maxhp) : 0, bt: boss ? boss.type : 0, np: this.humans.filter((p) => p.inRun).length,
      en: this.enemyRows(), it: this.items.slice(0, C.MAXI).map((i) => [i.id, i.kind, w16(i.x), byte(i.y), byte(i.z)]),
      pr: this.projs.filter((p) => p.delay <= 0).slice(0, C.MAXP).map((p) => [p.id, p.kind, w16(p.x), byte(p.y), byte(p.z), p.vx < 0 ? 1 : 0]),
      ev: recent.map((e) => [e.id, e.kind, e.x, e.y, e.z, e.a]),
      hs: this.humans.filter((p) => p.inRun).map((p) => this.heroRow(p)),
      width: this.stage ? this.stage.width : 0, sname: this.stage ? this.stage.name : '',
    };
  }

  send(now) {
    const base = { t: 'snap', ...this.body() };
    for (const p of this.humans) {
      if (!p.ws) continue;
      const others = base.hs.filter((r) => r[0] !== p.id);
      this.hooks.send(p.ws, JSON.stringify({ ...base, hs: others, you: { id: p.id, run: p.inRun ? 1 : 0, hs: p.hs, ht: byte(p.ht), hp: Math.max(0, byte(p.hp)), lives: Math.max(0, p.lives), fix: p.fix & 255,
        x: w16(p.x), y: byte(p.y), z: byte(p.z), face: p.face, score: Math.min(16777215, p.score), weapon: p.weapon, wdur: p.wdur, inv: p.inv > 0 ? 1 : 0, vx: Math.round(p.vx * 8) & 255 } }));
    }
    this.hooks.toMonitors({ ...base, t: 'wsn', room: this.name });
    if (this.rosterDirty && now - this.lastRoster > 400) this.sendRoster(now);
  }

  rosterList() {
    return [...this.pilots.values()].sort((a, b) => a.id - b.id).map((p) => [p.id, 0, Math.min(65535, p.score), Math.max(0, p.lives), p.name]);
  }
  sendRoster(now) {
    this.lastRoster = now;
    this.rosterDirty = false;
    this.rosterSeq = (this.rosterSeq + 1) & 255;
    const msg = JSON.stringify({ t: 'roster', seq: this.rosterSeq, rk: 0, players: this.rosterList() });
    for (const p of this.humans) if (p.ws) this.hooks.send(p.ws, msg);
    this.hooks.toMonitors({ t: 'sroster', room: this.name, players: this.rosterList() });
  }

  info() {
    return [...this.pilots.values()].sort((a, b) => b.score - a.score).map((p) => ({
      slot: p.id, name: p.name, bot: false, cart: 'next', score: p.score, lives: p.lives, hp: p.hp, kills: p.kills, weapon: ['none', 'knife', 'pipe', 'bat'][p.weapon],
      account: !!p.userId, alive: p.alive, inGame: p.inGame, rtt: p.rtt, rttHist: p.rttHist, inHz: p.inHz, frame: p.frame,
      since: p.since, bstat: p.bstat, lastAge: p.lastMsg ? Date.now() - p.lastMsg : null,
    }));
  }
  monitorFull() { return [{ t: 'wsn', room: this.name, full: true, ...this.body() }]; }
}

module.exports = { BrawlRoom, C, ST, ET, ES, HA, IT, EV, STAGES, TYPES, TICK_MS };

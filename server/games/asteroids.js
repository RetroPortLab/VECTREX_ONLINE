// CO-OP ASTEROIDS: up to 8 consoles shooting the same rocks. The rules are rocks.js; this is its
// page on the site and what goes on the leaderboards.
//
// A run counts when two or more consoles took part. Each signed-in pilot gets: score (the points
// they shot), rocks, saucers, deaths, runs, and the best wave and best team score they reached.
// Leaving mid-run saves what you had.

const { RockRoom, C } = require('../rocks');

const game = {
  id: 'asteroids',
  title: 'CO-OP ASTEROIDS',
  tagline: 'Shoot the rocks together. One pool of lives, one team score, and a wave never ends until the field is clear.',
  players: 'up to 8',
  bridgeNames: ['rocks'],
  cart: { tag: 'VAST', build: 'netrocks', folder: 'vectrex/asteroids' },
  download: { file: 'NetLink-Asteroids.um2.zip', name: 'NetLink-Asteroids.um2' },
  dashboardType: 'rocks',
  about: [
    'Everyone flies in the same wrapped-round field. Shoot a rock and it splits; clear the field and the next wave comes faster. Saucers cross now and then and shoot back. Your shots never hurt your friends, but a rock or a saucer shot will.',
    'The whole crew shares one pool of lives (more consoles, more lives) and gains one at every 10,000 points. When the lives run out the run is over and the next one starts on its own. A lone console flies with a bot wingman.',
  ],
  controls: [['Stick left / right', 'rotate'], ['Button 1', 'fire (hold to keep firing)'], ['Button 2', 'thrust'], ['Button 3', 'hyperspace (a small chance it kills you)'],
    ['Button 4 (hold)', 'scoreboard'], ['Buttons 3 + 4 (hold 1 s)', 'quit to the title screen']],
  leaderboard: {
    order: ['score', 'rocks'],
    columns: [{ key: 'score', label: 'Score' }, { key: 'rocks', label: 'Rocks' }, { key: 'ufos', label: 'Saucers' }, { key: 'deaths', label: 'Deaths' },
      { key: 'runs', label: 'Runs' }, { key: 'best_wave', label: 'Best wave' }, { key: 'best_team', label: 'Best team score' }],
    note: 'Runs with two or more consoles count. Score is the points you shot yourself.',
  },
  profile: [{ key: 'score', label: 'Score' }, { key: 'rocks', label: 'Rocks' }, { key: 'ufos', label: 'Saucers' }, { key: 'deaths', label: 'Deaths' },
    { key: 'runs', label: 'Runs' }, { key: 'best_wave', label: 'Best wave' }, { key: 'best_team', label: 'Best team score' }],

  createRoom(name, ctx) { return new AsteroidsRoom(name, ctx); },
};

class AsteroidsRoom {
  constructor(name, ctx) {
    this.name = name;
    this.ctx = ctx;
    this.type = 'rocks';
    this.rr = new RockRoom(name, {
      send: ctx.send, toMonitors: ctx.toMonitors, log: ctx.log,
      onRunEnd: (r, result) => this.runEnded(result),
      onLeave: (r, p, ranked) => this.leftMidRun(p, ranked, r),
    });
  }

  close() { this.rr.close(); }
  get empty() { return this.rr.empty; }
  get humans() { return this.rr.humans; }
  get size() { return this.rr.size; }

  join(ws, { name, ip, user }) {
    const p = this.rr.join(ws, name, ip, user);
    if (!p) return { error: `room '${this.name}' is full (8 ships)` };
    this.ctx.send(ws, { t: 'welcome', game: 'rocks', id: p.id, slot: p.id, peers: this.rr.size, room: this.name, account: user ? user.username : null });
    return p;
  }
  leave(p) { this.rr.leave(p); }
  message(p, m, now) { if (m.t === 'as') this.rr.fromBridge(p, m, now); }
  secondTick() { for (const p of this.rr.humans) { p.inHz = p.inCount; p.inCount = 0; } }
  info() { return { type: 'rocks', players: this.rr.info(), state: this.rr.state, wave: this.rr.wave, lives: this.rr.lives, score: this.rr.score, run: this.rr.run }; }
  monitorInit() { return [{ t: 'sroster', room: this.name, players: this.rr.rosterList() }, ...this.rr.monitorFull()]; }
  bots(n, add) {
    if (n !== null && n !== undefined) this.rr.setBots(n); else this.rr.addBotManual(add);
    return { bots: this.rr.bots.length, pilots: this.rr.size };
  }

  // ---- the leaderboards -----------------------------------------------------------------------------
  async save(p, wave, team) {
    if (!p.userId) return;
    await this.ctx.store.addStats(game.id, p.userId,
      { score: p.score, rocks: p.rocksHit, ufos: p.ufosHit, deaths: p.deaths, runs: 1 }, { best_wave: wave, best_team: team });
  }

  async runEnded({ ranked, wave, score, ships }) {
    if (!ranked) return;
    for (const p of ships) {
      if (p.bot) continue;
      try { await this.save(p, wave, score); } catch (e) { this.ctx.log(`could not save ${p.name}'s run: ${e.message}`, 'warn'); }
    }
  }

  async leftMidRun(p, ranked, r) {
    if (!ranked || p.bot) return;
    try { await this.save(p, r.wave, r.score); } catch (e) { this.ctx.log(`could not save ${p.name}'s run: ${e.message}`, 'warn'); }
  }
}

module.exports = game;

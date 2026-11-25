// BRAWLNET: a two-player co-op beat-'em-up for the ZX Spectrum Next (its Wi-Fi links it through the
// Next gateway, like FRAGNET). The rules are brawlnet.js; this is its page on the site and what goes
// on the leaderboards.
//
// A run counts for the leaderboards when two consoles played it together: score, enemies beaten,
// the furthest stage reached, and runs won (all three bosses down).

const { BrawlRoom, C, STAGES } = require('../brawlnet');

const game = {
  id: 'brawlnet',
  title: 'BRAWLNET',
  tagline: 'Two-player street brawler on the ZX Spectrum Next: three stages, bosses, weapons and barrels to smash.',
  players: '1-2 (co-op)',
  bridgeNames: ['bm'],
  platform: 'ZX Spectrum Next',
  cart: null,
  download: null,
  dashboardType: 'brawlnet',
  about: [
    'Fight your way through the Midnight Street, the Harbour Docks and the Iron Foundry. Waves of thugs close in from both sides: grunts, knife men, bruisers who shrug off light punches, and acrobats who leap at you. Each stage ends in a boss.',
    'Chain a three-hit punch combo, jump-kick, or spend a little health on the spinning special that clears everyone around you. Smash barrels for apples, chicken, cash and weapons: a knife, a lead pipe or a baseball bat.',
    'Two players share the screen and the lives: three each, and an extra life every 20,000 points. Bring a friend, or fight alone: the relay runs every enemy, so the Next only has to draw it.',
  ],
  controls: [['Q / A / O / P (or pad)', 'move up / down / left / right'], ['Space or M', 'punch (press again for the combo); swings a weapon'],
    ['Z (or pad C)', 'jump; punch in the air for a jump kick'], ['Z + Space together', 'spin special (costs a little health)'], ['Hold X', 'quit to the title screen']],
  leaderboard: {
    order: ['wins', 'best_score'],
    columns: [{ key: 'wins', label: 'Runs won' }, { key: 'runs', label: 'Runs' }, { key: 'kills', label: 'Enemies beaten' }, { key: 'best_score', label: 'Best score' }, { key: 'best_stage', label: 'Furthest stage' }],
    note: 'Runs with two consoles count.',
  },
  profile: [{ key: 'wins', label: 'Runs won' }, { key: 'runs', label: 'Runs' }, { key: 'kills', label: 'Enemies beaten' }, { key: 'best_score', label: 'Best score' }],

  createRoom(name, ctx) { return new BrawlNetGame(name, ctx); },
};

class BrawlNetGame {
  constructor(name, ctx) {
    this.name = name;
    this.ctx = ctx;
    this.type = 'brawlnet';
    this.br = new BrawlRoom(name, {
      send: ctx.send, toMonitors: ctx.toMonitors, log: ctx.log,
      onGameEnd: (r, result) => this.runEnded(result),
      onLeave: (r, p) => this.leftMid(p),
    });
  }

  close() { this.br.close(); }
  get empty() { return this.br.empty; }
  get humans() { return this.br.humans; }
  get size() { return this.br.size; }

  join(ws, { name, ip, user }) {
    const p = this.br.join(ws, name, ip, user);
    if (!p) return { error: `room '${this.name}' is full (${C.HUMANS} consoles)` };
    this.ctx.send(ws, { t: 'welcome', game: 'bm', id: p.id, slot: p.id, peers: this.br.size, room: this.name, account: user ? user.username : null });
    return p;
  }
  leave(p) { this.br.leave(p); }
  message(p, m, now) { if (m.t === 'bm') this.br.fromBridge(p, m, now); }
  secondTick() { for (const p of this.br.humans) { p.inHz = p.inCount; p.inCount = 0; } }
  info() { return { type: 'brawlnet', players: this.br.info(), state: this.br.state, stage: this.br.stageNo, stages: STAGES.length }; }
  monitorInit() { return [{ t: 'sroster', room: this.name, players: this.br.rosterList() }, ...this.br.monitorFull()]; }
  bots() { return { bots: 0, pilots: this.br.size }; }

  // ---- the leaderboards ------------------------------------------------------------------------------
  async runEnded(result) {
    if (!result.ranked) return;
    const store = this.ctx.store;
    try {
      for (const p of result.players) {
        if (!p.userId) continue;
        await store.addStats(game.id, p.userId, { wins: result.win ? 1 : 0, runs: 1, kills: p.kills }, { best_score: p.score, best_stage: result.stage + 1 });
      }
      if (result.players.some((p) => p.userId)) {
        await store.addRound({ game: game.id, room: this.name, ranked: false, winnerId: null,
          players: result.players.map((p) => ({ userId: p.userId || null, name: p.name, bot: false, kills: p.kills, deaths: 0, won: !!result.win })) });
      }
    } catch (e) {
      this.ctx.log(`could not save the run: ${e.message}`, 'warn');
    }
  }

  async leftMid(p) {
    if (!this.br.ranked || !p.userId) return;
    try {
      await this.ctx.store.addStats(game.id, p.userId, { runs: 1, kills: p.kills }, { best_score: p.score });
    } catch (e) {
      this.ctx.log(`could not save ${p.name}'s run: ${e.message}`, 'warn');
    }
  }
}

module.exports = game;

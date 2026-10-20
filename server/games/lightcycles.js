// LIGHT CYCLES: up to 16 consoles racing walls on one grid. The rules are cycles.js; this is its
// page on the site and what goes on the leaderboards.
//
// A round counts when two or more consoles took part. Each signed-in pilot gets: wins, derezzes
// (cycles that ran into your wall: bots count), rounds, crashes and longest (the most seconds
// they stayed alive in a round). Leaving mid-round counts the round as a crash.

const { CycleRoom, C } = require('../cycles');

const game = {
  id: 'lightcycles',
  title: 'LIGHT CYCLES',
  tagline: 'Race a wall of light round the grid. Make the others hit it. Last one running wins.',
  players: 'up to 16',
  bridgeNames: ['cycles'],
  cart: { tag: 'VCYC', build: 'netcycles', folder: 'vectrex/lightcycles' },
  dashboardType: 'cycles',
  about: [
    'Every cycle moves at the same speed and leaves a wall behind it. Hit a wall, the edge or another cycle and you derez. The last cycle running wins the round, and the next one starts right away.',
    'The server referees every move, so what you see is what happened. Bots fill the room when there are few pilots, so a lone console always has someone to race.',
  ],
  controls: [['Stick left / right, or button 1 / 4', 'turn left / right'], ['Button 2 (hold)', 'scoreboard'], ['Buttons 1 + 2 (hold 1 s)', 'quit to the title screen']],
  leaderboard: {
    order: ['wins', 'derezzes'],
    columns: [{ key: 'wins', label: 'Wins' }, { key: 'derezzes', label: 'Derezzes' }, { key: 'crashes', label: 'Crashes' },
      { key: 'rounds', label: 'Rounds' }, { key: 'longest', label: 'Longest (s)' }],
    note: 'Rounds with two or more consoles count. A derez is a cycle that ran into your wall.',
  },
  profile: [{ key: 'wins', label: 'Wins' }, { key: 'derezzes', label: 'Derezzes' }, { key: 'crashes', label: 'Crashes' },
    { key: 'rounds', label: 'Rounds' }, { key: 'longest', label: 'Longest (s)' }],

  createRoom(name, ctx) { return new LightCyclesRoom(name, ctx); },
};

class LightCyclesRoom {
  constructor(name, ctx) {
    this.name = name;
    this.ctx = ctx;
    this.type = 'cycles';
    this.cy = new CycleRoom(name, {
      send: ctx.send, toMonitors: ctx.toMonitors, log: ctx.log,
      onRoundEnd: (r, result) => this.roundEnded(result),
      onLeave: (r, p, ranked) => this.leftMidRound(p, ranked),
    });
  }

  close() { this.cy.close(); }
  get empty() { return this.cy.empty; }
  get humans() { return this.cy.humans; }
  get size() { return this.cy.size; }

  join(ws, { name, ip, user }) {
    const p = this.cy.join(ws, name, ip, user);
    if (!p) return { error: `room '${this.name}' is full (16 cycles)` };
    this.ctx.send(ws, { t: 'welcome', game: 'cycles', id: p.id, slot: p.id, peers: this.cy.size, room: this.name, account: user ? user.username : null });
    return p;
  }
  leave(p) { this.cy.leave(p); }
  message(p, m, now) { if (m.t === 'cy') this.cy.fromBridge(p, m, now); }
  secondTick() { for (const p of this.cy.humans) { p.inHz = p.inCount; p.inCount = 0; } }
  info() { return { type: 'cycles', players: this.cy.info(), state: this.cy.state, win: this.cy.winId, round: this.cy.round }; }
  monitorInit() { return [{ t: 'sroster', room: this.name, players: this.cy.rosterList() }, ...this.cy.monitorFull()]; }
  bots(n, add) {
    if (n !== null && n !== undefined) this.cy.setBots(n); else this.cy.addBotManual(add);
    return { bots: this.cy.bots.length, pilots: this.cy.size };
  }

  // ---- the leaderboards ------------------------------------------------------------------------
  async roundEnded({ winner, ranked, cycles }) {
    const store = this.ctx.store;
    const secs = (p) => Math.round(p.lasted * C.TICK_MS / 1000);
    const players = cycles.map((p) => ({
      userId: p.userId || null, name: p.name, bot: !!p.bot, kills: p.roundKills, botKills: 0, deaths: p.died ? 1 : 0, won: p === winner,
    }));
    try {
      if (ranked) {
        for (const p of cycles) {
          if (!p.userId) continue;
          await store.addStats(game.id, p.userId, { wins: p === winner ? 1 : 0, derezzes: p.roundKills, crashes: p.died ? 1 : 0, rounds: 1 }, { longest: secs(p) });
        }
      }
      if (players.some((p) => p.userId)) {
        await store.addRound({ game: game.id, room: this.name, ranked, winnerId: winner ? winner.userId || null : null, players });
      }
    } catch (e) {
      this.ctx.log(`could not save the round: ${e.message}`, 'warn');
    }
  }

  async leftMidRound(p, ranked) {
    if (!ranked || !p.userId) return;
    try {
      await this.ctx.store.addStats(game.id, p.userId, { derezzes: p.roundKills, crashes: 1, rounds: 1 },
        { longest: Math.round((this.cy.tick - p.born) * C.TICK_MS / 1000) });
    } catch (e) {
      this.ctx.log(`could not save ${p.name}'s round: ${e.message}`, 'warn');
    }
  }
}

module.exports = game;

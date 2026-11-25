// SOCCER (ZX Spectrum Next): eleven-a-side football seen from above. The rules and the CPU players are
// soccer.js; this is its page on the site and what goes on the leaderboards.
//
// A match counts for the leaderboards when two consoles played it against each other.

const { SoccerRoom, C } = require('../soccer');

const game = {
  id: 'soccer',
  title: 'SOCCER',
  tagline: 'Top-down eleven-a-side football on the ZX Spectrum Next: pass, shoot, swerve, tackle. Play the CPU or a friend.',
  players: '1-2 (one a side)',
  bridgeNames: ['sc'],
  platform: 'ZX Spectrum Next',
  cart: null,
  download: null,
  dashboardType: 'soccer',
  about: [
    'Two teams of eleven, a scrolling pitch and one button. Tap fire to pass to the team-mate you are pointing at, hold it to charge a shot, and steer the ball in flight with the stick. Without the ball, fire is a sliding tackle.',
    'Throw-ins, corners and goal kicks are all there, and the match lasts two halves of two minutes; the sides swap at half time. Pick your team on the line-up screen with left and right.',
    'Play alone against the CPU, or have a friend join the same room: the second console takes over the CPU side the moment it connects.',
  ],
  controls: [['Q / A / O / P (or pad)', 'run up / down / left / right'], ['Space (tap)', 'pass to the player you face'], ['Space (hold, release)', 'shoot: the longer you hold, the harder and higher'],
    ['Stick during a kick', 'swerve the ball'], ['Space without the ball', 'sliding tackle'], ['Left / Right on the line-up', 'choose your team'], ['Hold X', 'quit to the title screen']],
  leaderboard: {
    order: ['wins', 'goals'],
    columns: [{ key: 'wins', label: 'Wins' }, { key: 'matches', label: 'Matches' }, { key: 'goals', label: 'Goals' }, { key: 'best_goals', label: 'Best match (goals)' }],
    note: 'Matches between two consoles count.',
  },
  profile: [{ key: 'wins', label: 'Wins' }, { key: 'matches', label: 'Matches' }, { key: 'goals', label: 'Goals' }],

  createRoom(name, ctx) { return new SoccerGame(name, ctx); },

  // match making, from the console's hello: mode 0 quick match, 1 host (room code, options), 2 join by code
  matchmaking(rooms, m, code) {
    const mine = (r) => r && r.game === game;
    if (m.mode === 2) {
      const r = rooms.get(code);
      if (!mine(r) || r.room.size === 0) return { error: 'NO SUCH ROOM: CHECK THE CODE' };
      return { room: code };
    }
    if (m.mode === 1) {
      const r = rooms.get(code);
      if (mine(r) && r.room.size > 0) return { error: 'ROOM IN USE: PICK ANOTHER CODE' };
      return { room: code, setup: { halfMin: m.half, cpu: m.cpu !== 0, priv: true } };
    }
    // quick: a public room with one console waiting, else the first free one
    for (let i = 1; i <= 20; i++) {
      const name = i === 1 ? 'pitch' : `pitch${i}`, r = rooms.get(name);
      if (mine(r) && !r.room.br.opts.priv && r.room.size === 1) return { room: name };
    }
    for (let i = 1; i <= 20; i++) {
      const name = i === 1 ? 'pitch' : `pitch${i}`, r = rooms.get(name);
      if (!r || (mine(r) && r.room.size === 0)) return { room: name, setup: { halfMin: 2, cpu: true, priv: false } };
    }
    return { error: 'ALL ROOMS ARE FULL' };
  },
};

class SoccerGame {
  constructor(name, ctx) {
    this.name = name;
    this.ctx = ctx;
    this.type = 'soccer';
    this.br = new SoccerRoom(name, {
      send: ctx.send, toMonitors: ctx.toMonitors, log: ctx.log,
      onMatchEnd: (r, result) => this.matchEnded(result),
    });
  }

  close() { this.br.close(); }
  get empty() { return this.br.empty; }
  get humans() { return this.br.humans; }
  get size() { return this.br.size; }
  setup(o) { this.br.configure(o); }

  join(ws, { name, ip, user }) {
    const p = this.br.join(ws, name, ip, user);
    if (!p) return { error: `room '${this.name}' is full (${C.HUMANS} consoles)` };
    this.ctx.send(ws, { t: 'welcome', game: 'sc', id: p.id, slot: p.id, peers: this.br.size, room: this.name, account: user ? user.username : null });
    return p;
  }
  leave(p) { this.br.leave(p); }
  message(p, m, now) { if (m.t === 'sc') this.br.fromBridge(p, m, now); }
  secondTick() { for (const p of this.br.humans) { p.inHz = p.inCount; p.inCount = 0; } }
  info() { return { type: 'soccer', players: this.br.info(), state: this.br.state, sa: this.br.score[0], sb: this.br.score[1], half: this.br.half }; }
  monitorInit() { return [{ t: 'sroster', room: this.name, players: this.br.rosterList() }]; }
  bots() { return { bots: 0, pilots: this.br.size }; }

  async matchEnded(result) {
    if (!result.ranked) return;
    const store = this.ctx.store;
    try {
      for (const p of result.players) {
        if (!p.userId) continue;
        const won = result.winner === p.side;
        await store.addStats(game.id, p.userId, { wins: won ? 1 : 0, matches: 1, goals: p.goals }, { best_goals: p.goals });
      }
      if (result.players.some((p) => p.userId)) {
        await store.addRound({ game: game.id, room: this.name, ranked: false, winnerId: null,
          players: result.players.map((p) => ({ userId: p.userId || null, name: p.name, bot: false, kills: p.goals, deaths: 0, won: result.winner === p.side })) });
      }
    } catch (e) {
      this.ctx.log(`could not save the match: ${e.message}`, 'warn');
    }
  }
}

module.exports = game;

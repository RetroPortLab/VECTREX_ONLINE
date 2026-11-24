// FRAGNET: a first-person deathmatch for the ZX Spectrum Next (its Wi-Fi links it through the Next
// gateway, like the Next versions of the Vectrex games). Up to four consoles; bots fill the arena to
// four pilots. The rules are fragnet.js; this is its page on the site and what goes on the
// leaderboards.
//
// A match counts for the leaderboards when two or more consoles took part: frags, deaths, wins
// (the most frags when the match ends) and shots on target.

const { FragRoom, C } = require('../fragnet');

const game = {
  id: 'fragnet',
  title: 'FRAGNET',
  tagline: 'First-person deathmatch on the ZX Spectrum Next: plasma bolts, a stone arena under the stars.',
  players: 'up to 4 (bots fill the arena)',
  bridgeNames: ['dm'],
  platform: 'ZX Spectrum Next',
  cart: null,
  download: null,
  dashboardType: 'fragnet',
  about: [
    'A textured first-person arena drawn by the Next itself, with a starry sky that turns with you. Run, strafe and fire plasma bolts; five hits and a pilot is fragged, then back in two and a half seconds later at the spawn point furthest from trouble.',
    `First to ${C.FRAGS} frags wins, or whoever has the most when the ${C.MATCH_S / 60} minutes are up. Health packs in the corners of the courtyard give back ${C.ITEM_HP}.`,
    'Bots fill empty places so one Next always has a fight. The Next connects over its Wi-Fi to the Next gateway, which joins it to this server.',
  ],
  controls: [['O / P (or mouse)', 'turn'], ['Q / A', 'run forward / back'], ['Z / X', 'strafe'], ['Space, M or mouse button', 'fire'],
    ['Hold S', 'scoreboard'], ['Hold BREAK 1 s', 'quit to the title screen']],
  leaderboard: {
    order: ['wins', 'frags'],
    columns: [{ key: 'wins', label: 'Wins' }, { key: 'matches', label: 'Matches' }, { key: 'frags', label: 'Frags' }, { key: 'deaths', label: 'Deaths' },
      { key: 'hits', label: 'Hits' }, { key: 'best_frags', label: 'Best match (frags)' }],
    note: 'Matches with two or more consoles count.',
  },
  profile: [{ key: 'wins', label: 'Wins' }, { key: 'matches', label: 'Matches' }, { key: 'frags', label: 'Frags' }, { key: 'deaths', label: 'Deaths' }, { key: 'hits', label: 'Hits' }],

  createRoom(name, ctx) { return new FragNetGame(name, ctx); },
};

class FragNetGame {
  constructor(name, ctx) {
    this.name = name;
    this.ctx = ctx;
    this.type = 'fragnet';
    this.fr = new FragRoom(name, {
      send: ctx.send, toMonitors: ctx.toMonitors, log: ctx.log,
      onMatchEnd: (r, result) => this.matchEnded(result),
      onLeave: (r, p) => this.leftMid(p),
    });
  }

  close() { this.fr.close(); }
  get empty() { return this.fr.empty; }
  get humans() { return this.fr.humans; }
  get size() { return this.fr.size; }

  join(ws, { name, ip, user }) {
    const p = this.fr.join(ws, name, ip, user);
    if (!p) return { error: `room '${this.name}' is full (${C.HUMANS} consoles)` };
    this.ctx.send(ws, { t: 'welcome', game: 'dm', id: p.id, slot: p.id, peers: this.fr.size, room: this.name, account: user ? user.username : null });
    return p;
  }
  leave(p) { this.fr.leave(p); }
  message(p, m, now) { if (m.t === 'fm') this.fr.fromBridge(p, m, now); }
  secondTick() { for (const p of this.fr.humans) { p.inHz = p.inCount; p.inCount = 0; } }
  info() { return { type: 'fragnet', players: this.fr.info(), state: this.fr.state, match: this.fr.match, fl: C.FRAGS, win: this.fr.state === 3 ? this.fr.winner : 0 }; }
  monitorInit() { return [{ t: 'sroster', room: this.name, players: this.fr.rosterList() }, ...this.fr.monitorFull()]; }
  bots(n, add) {
    if (n !== null && n !== undefined) this.fr.setBots(n); else this.fr.addBotManual(add);
    return { bots: this.fr.bots.length, pilots: this.fr.size };
  }

  // ---- the leaderboards ------------------------------------------------------------------------------
  async matchEnded(result) {
    const store = this.ctx.store;
    const { ranked, winner, pilots } = result;
    if (!ranked) return;
    try {
      for (const p of pilots) {
        if (p.bot || !p.userId) continue;
        await store.addStats(game.id, p.userId, { wins: p.id === winner ? 1 : 0, matches: 1, frags: p.frags, deaths: p.deaths, hits: p.hits }, { best_frags: p.frags });
      }
      if (pilots.some((p) => !p.bot && p.userId)) {
        await store.addRound({ game: game.id, room: this.name, ranked: false, winnerId: null,
          players: pilots.map((p) => ({ userId: p.userId || null, name: p.name, bot: !!p.bot, kills: p.frags, deaths: p.deaths, won: p.id === winner })) });
      }
    } catch (e) {
      this.ctx.log(`could not save the match: ${e.message}`, 'warn');
    }
  }

  async leftMid(p) {
    if (!this.fr.ranked || p.bot || !p.userId) return;
    try {
      await this.ctx.store.addStats(game.id, p.userId, { matches: 1, frags: p.frags, deaths: p.deaths, hits: p.hits }, { best_frags: p.frags });
    } catch (e) {
      this.ctx.log(`could not save ${p.name}'s match: ${e.message}`, 'warn');
    }
  }
}

module.exports = game;

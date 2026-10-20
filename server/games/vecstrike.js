// VEC STRIKE: up to 20 consoles in one arena. The game itself is strike.js; this is its page on
// the site and what goes on the leaderboards.
//
// A round counts when two or more consoles took part. Then each signed-in pilot gets: kills
// (pilots shot down: bots don't count), deaths, bot_kills (on the profile only), rounds, wins and
// best_round (most pilots shot down in one round). Leaving mid-round keeps the kills and deaths so far.

const { StrikeRoom, C } = require('../strike');

const game = {
  id: 'vecstrike',
  title: 'VEC STRIKE',
  tagline: 'Up to 20 Vectrex consoles in one arena. First to 15 kills wins the round.',
  players: 'up to 20',
  bridgeNames: ['strike'],               // what the bridge says in its hello
  cart: { tag: 'VSTK', build: 'netstrike', folder: 'vectrex/vecstrike' },
  download: { file: 'Netlink-vecstrike.um2.zip', name: 'Netlink-vecstrike.um2' },
  dashboardType: 'strike',
  about: [
    'Asteroids-style dogfighting for up to 20 Vectrex consoles at once, in one wrap-around arena. Every console flies its own ship at a full 50 frames a second; everyone else arrives over the internet twenty times a second.',
    'Hits are judged by the ship that gets hit, on what its own screen shows: no lag excuses. Bots fill the room when there are few pilots, and fly by the same rules.',
  ],
  controls: [['Stick left / right', 'turn'], ['Stick up, or button 3', 'thrust'], ['Button 4', 'fire'],
    ['Button 2', 'warp'], ['Button 1 (hold)', 'scoreboard'], ['Buttons 1 + 2 (hold 1 s)', 'quit to the title screen']],
  leaderboard: {
    order: ['wins', 'kills'],
    columns: [{ key: 'wins', label: 'Wins' }, { key: 'kills', label: 'Kills' }, { key: 'deaths', label: 'Deaths' },
      { key: 'rounds', label: 'Rounds' }, { key: 'best_round', label: 'Best round' }],
    note: 'Rounds with two or more consoles count. Kills are pilots shot down; bots don\'t count.',
  },
  profile: [{ key: 'wins', label: 'Wins' }, { key: 'kills', label: 'Kills' }, { key: 'deaths', label: 'Deaths' },
    { key: 'rounds', label: 'Rounds' }, { key: 'best_round', label: 'Best round' }, { key: 'bot_kills', label: 'Bots shot down' }],

  createRoom(name, ctx) { return new VecStrikeRoom(name, ctx); },
};

class VecStrikeRoom {
  constructor(name, ctx) {
    this.name = name;
    this.ctx = ctx;           // { send, toMonitors, log, store }
    this.type = 'strike';
    this.strike = new StrikeRoom(name, {
      send: ctx.send, toMonitors: ctx.toMonitors, log: ctx.log,
      onRoundEnd: (r, result) => this.roundEnded(result),
      onLeave: (r, p, ranked) => this.leftMidRound(p, ranked),
    });
  }

  close() { this.strike.close(); }
  get empty() { return this.strike.empty; }
  get humans() { return this.strike.humans; }
  get size() { return this.strike.players.size; }

  join(ws, { name, ip, user }) {
    const p = this.strike.join(ws, name, ip, user);
    if (!p) return { error: `room '${this.name}' is full (20 pilots)` };
    this.ctx.send(ws, { t: 'welcome', game: 'strike', id: p.id, slot: p.id, peers: this.strike.players.size, room: this.name,
      account: user ? user.username : null });
    return p;
  }
  leave(p) { this.strike.leave(p); }
  message(p, m, now) { if (m.t === 'st' || m.t === 'hit') this.strike.fromBridge(p, m, now); }
  secondTick() { for (const p of this.strike.humans) { p.inHz = p.inCount; p.inCount = 0; } }
  info() { return { type: 'strike', players: this.strike.info(), win: this.strike.winId, rk: C.ROUND_KILLS }; }
  monitorInit() { return [{ t: 'sroster', room: this.name, players: this.strike.rosterList() }]; }
  bots(n, add) {
    if (n !== null && n !== undefined) this.strike.setBots(n); else if (add > 0) this.strike.addBot(); else this.strike.removeBot();
    return { bots: this.strike.bots.length, pilots: this.strike.players.size };
  }

  // ---- the leaderboards ------------------------------------------------------------------
  async roundEnded({ winner, ranked, pilots }) {
    const store = this.ctx.store;
    const players = pilots.map((p) => ({
      userId: p.userId || null, name: p.name, bot: !!p.bot, kills: p.roundKills, botKills: p.roundBotKills,
      deaths: p.roundDeaths, won: p === winner,
    }));
    try {
      if (ranked) {
        for (const p of pilots) {
          if (!p.userId) continue;
          await store.addStats(game.id, p.userId,
            { kills: p.roundKills, deaths: p.roundDeaths, bot_kills: p.roundBotKills, rounds: 1, wins: p === winner ? 1 : 0 },
            { best_round: p.roundKills });
        }
      }
      if (players.some((p) => p.userId)) {
        await store.addRound({ game: game.id, room: this.name, ranked, winnerId: winner.userId || null, players });
      }
      this.ctx.log(ranked ? 'round recorded on the leaderboards' : 'practice round: fewer than two consoles, not ranked');
    } catch (e) {
      this.ctx.log(`could not save the round: ${e.message}`, 'warn');
    }
  }

  async leftMidRound(p, ranked) {
    if (!ranked || !p.userId) return;
    try {
      await this.ctx.store.addStats(game.id, p.userId, { kills: p.roundKills, deaths: p.roundDeaths, bot_kills: p.roundBotKills });
    } catch (e) {
      this.ctx.log(`could not save ${p.name}'s kills: ${e.message}`, 'warn');
    }
  }
}

module.exports = game;

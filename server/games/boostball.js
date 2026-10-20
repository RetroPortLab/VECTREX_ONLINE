// VECTOR BALL: rocket-car football, 1 to 3 consoles a side (bots fill the empty seats). The rules are
// boostball.js; this is its page on the site, what goes on the leaderboards, and the league.
//
// A match counts for the stat leaderboards when two or more consoles took part. It is also rated for
// the league when each side has a signed-in pilot (see league.js); co-op against the bots only
// feeds the stats. Leaving a rated match you are not winning counts as a loss.

const { BallRoom, C } = require('../boostball');
const league = require('../league');

const game = {
  id: 'boostball',
  title: 'VECTOR BALL',
  tagline: 'Rocket-car football on a vector pitch. Boost, bump, demolish and score, in a league with seasons.',
  players: 'up to 6 (3 a side)',
  bridgeNames: ['ball'],
  cart: { tag: 'VBBL', build: 'netboost', folder: 'vectrex/boostball' },
  download: { file: 'NetLink-BoostBall.um2.zip', name: 'NetLink-BoostBall.um2' },
  dashboardType: 'ball',
  leagues: true,
  about: [
    'Two teams, one ball, a goal at each end. Your car is always driving: steer, boost, and smash the ball towards the other goal. Big boost pads sit near the corners, small ones in the middle. Hit an enemy car at speed while boosting and it is demolished for a couple of seconds.',
    'Matches last three minutes; a draw goes to a sudden-death overtime. Empty seats are filled by bots, so even one console can play a 2 against 2.',
    'Every match with a signed-in pilot on each side moves your league rating. Ratings are per season (a calendar month): after five placement matches you get a division, from Bronze to Champion, and a place in the season table.',
  ],
  controls: [['Stick left / right', 'steer'], ['Stick up, or button 3', 'accelerate (stick down: brake and reverse)'], ['Button 1', 'boost (uses the meter)'], ['Button 2', 'handbrake (slide)'],
    ['Button 4 (hold)', 'scoreboard'], ['Buttons 3 + 4 (hold 1 s)', 'quit to the title screen']],
  leaderboard: {
    order: ['wins', 'goals'],
    columns: [{ key: 'wins', label: 'Wins' }, { key: 'matches', label: 'Matches' }, { key: 'goals', label: 'Goals' }, { key: 'assists', label: 'Assists' },
      { key: 'saves', label: 'Saves' }, { key: 'demos', label: 'Demos' }, { key: 'best_goals', label: 'Best match (goals)' }],
    note: 'Matches with two or more consoles count. The league table, above, uses ratings.',
  },
  profile: [{ key: 'wins', label: 'Wins' }, { key: 'matches', label: 'Matches' }, { key: 'goals', label: 'Goals' }, { key: 'assists', label: 'Assists' },
    { key: 'saves', label: 'Saves' }, { key: 'demos', label: 'Demos' }],

  createRoom(name, ctx) { return new BoostBallGame(name, ctx); },
};

class BoostBallGame {
  constructor(name, ctx) {
    this.name = name;
    this.ctx = ctx;
    this.type = 'ball';
    this.br = new BallRoom(name, {
      send: ctx.send, toMonitors: ctx.toMonitors, log: ctx.log,
      onMatchEnd: (r, result) => this.matchEnded(result),
      onLeave: (r, p, info) => this.leftMid(p, info),
    });
  }

  close() { this.br.close(); }
  get empty() { return this.br.empty; }
  get humans() { return this.br.humans; }
  get size() { return this.br.size; }

  join(ws, { name, ip, user }) {
    const p = this.br.join(ws, name, ip, user);
    if (!p) return { error: `room '${this.name}' is full (6 cars)` };
    this.ctx.send(ws, { t: 'welcome', game: 'ball', id: p.id, slot: p.id, team: p.team, peers: this.br.size, room: this.name, account: user ? user.username : null });
    if (user) {
      league.load(this.ctx.store, game.id, user.id).then((s) => {
        p.league = league.pub(s);
        this.br.rosterDirty = true;
        this.ctx.send(ws, { t: 'league', ...p.league, season: league.seasonId() });
      }).catch(() => {});
    }
    return p;
  }
  leave(p) { this.br.leave(p); }
  message(p, m, now) { if (m.t === 'bb') this.br.fromBridge(p, m, now); }
  secondTick() { for (const p of this.br.humans) { p.inHz = p.inCount; p.inCount = 0; } }
  info() { return { type: 'ball', players: this.br.info(), state: this.br.state, sa: this.br.sa, sb: this.br.sb, match: this.br.match }; }
  monitorInit() { return [{ t: 'sroster', room: this.name, players: this.br.rosterList() }, ...this.br.monitorFull()]; }
  bots(n, add) {
    if (n !== null && n !== undefined) this.br.setBots(n); else this.br.addBotManual(add);
    return { bots: this.br.bots.length, pilots: this.br.size };
  }

  // ---- the leaderboards and the league ------------------------------------------------------------
  async matchEnded(result) {
    const store = this.ctx.store;
    const { ranked, sa, sb, winner, cars } = result;
    try {
      if (ranked) {
        for (const p of cars) {
          if (p.bot || !p.userId) continue;
          const won = winner === p.team, draw = winner === 2;
          await store.addStats(game.id, p.userId, { wins: won ? 1 : 0, matches: 1, goals: p.goals, assists: p.assists, saves: p.saves, demos: p.demos, own: p.own }, { best_goals: p.goals });
          void draw;
        }
      }
      const humans = cars.filter((p) => !p.bot && p.userId);
      if (ranked && humans.length) {
        await store.addRound({ game: game.id, room: this.name, ranked: result.leagueRated, winnerId: null,
          players: cars.map((p) => ({ userId: p.userId || null, name: p.name, bot: !!p.bot, kills: p.goals, deaths: p.own, won: winner === p.team })) });
      }
      if (result.leagueRated) {
        const side = (t) => ({ humans: cars.filter((p) => !p.bot && p.team === t).map((p) => ({ userId: p.userId, name: p.name })), goals: t ? sb : sa });
        const changes = await league.applyMatch(store, game.id, [side(0), side(1)]);
        for (const ch of changes) {
          const p = cars.find((c) => c.userId === ch.userId);
          if (!p) continue;
          p.league = { rating: ch.after, matches: ch.matches, division: ch.division, placed: ch.placed };
          this.ctx.log(`${p.name}: league ${ch.delta >= 0 ? '+' : ''}${ch.delta} → ${ch.after} (${ch.division})`);
          if (p.ws) this.ctx.send(p.ws, { t: 'league', ...ch, season: league.seasonId() });
        }
        this.br.rosterDirty = true;
      }
    } catch (e) {
      this.ctx.log(`could not save the match: ${e.message}`, 'warn');
    }
  }

  async leftMid(p, info) {
    if (!this.br.ranked || p.bot || !p.userId) return;
    try {
      await this.ctx.store.addStats(game.id, p.userId, { matches: 1, goals: p.goals, assists: p.assists, saves: p.saves, demos: p.demos, own: p.own }, { best_goals: p.goals });
      if (info.rated && info.behind) await league.forfeit(this.ctx.store, game.id, p.userId, p.name);
    } catch (e) {
      this.ctx.log(`could not save ${p.name}'s match: ${e.message}`, 'warn');
    }
  }
}

module.exports = game;

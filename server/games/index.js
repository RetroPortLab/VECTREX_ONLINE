// The games the site knows. To add one, write games/<id>.js like vecstrike.js or linktest.js and
// list it here (GAMES.md in the repo walks through the console, bridge and server sides).

const list = [require('./vecstrike'), require('./lightcycles'), require('./asteroids'), require('./boostball')];

const byId = new Map(list.map((g) => [g.id, g]));
const byBridgeName = new Map();
for (const g of list) { byBridgeName.set(g.id, g); for (const n of g.bridgeNames || []) byBridgeName.set(n, g); }

const fs = require('fs');
const path = require('path');
const haveZip = (g) => g.download && fs.existsSync(path.join(__dirname, '..', 'public', 'downloads', g.download.file));

// what a site page needs to know about a game (no functions)
const meta = (g) => ({
  id: g.id, title: g.title, tagline: g.tagline, players: g.players, cart: g.cart, about: g.about, download: haveZip(g) ? g.download : null,
  controls: g.controls, leaderboard: g.leaderboard, profile: g.profile, leagues: !!g.leagues,
});

module.exports = { list, byId, byBridgeName, meta };

// The games the site knows. To add one, write games/<id>.js like vecstrike.js or linktest.js and
// list it here (GAMES.md in the repo walks through the console, bridge and server sides).

//const list = [require('./vecstrike'), require('./linktest')];
const list = require('./vecstrike');
const byId = new Map(list.map((g) => [g.id, g]));
const byBridgeName = new Map();
for (const g of list) { byBridgeName.set(g.id, g); for (const n of g.bridgeNames || []) byBridgeName.set(n, g); }

// what a site page needs to know about a game (no functions)
const meta = (g) => ({
  id: g.id, title: g.title, tagline: g.tagline, players: g.players, cart: g.cart, about: g.about,
  controls: g.controls, leaderboard: g.leaderboard, profile: g.profile,
});

module.exports = { list, byId, byBridgeName, meta };

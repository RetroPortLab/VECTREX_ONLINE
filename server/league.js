// Leagues: a skill rating per account and game, divisions, and monthly seasons.
//
// The rating lives in the same stats table as everything else, under a season period like
// 'L2026-10' (keys: rating, matches, wins, losses, draws, peak), so nothing in the schema changes.
// A match is rated when it had at least one signed-in human on each side. Bots, guests and
// one-sided matches (co-op against bots) never move a rating.
//
//   rating   Elo-style. A side's rating is the average of its human players'. The expected score is
//            1 / (1 + 10^((other - own) / 400)); the change is K * margin * (result - expected).
//   K        40 for the first PLACEMENT matches of a season, then 24.
//   margin   1 + 0.1 per goal of difference, up to 5 goals (draws have none).
//   season   a calendar month (UTC). A player's first match of a new season starts them from
//            halfway between 1000 and their previous season's final rating (a soft reset).
//   division Bronze / Silver / Gold / Platinum / Diamond / Champion from the rating, shown only once
//            PLACEMENT matches have been played (before that: Unranked).

const START = 1000;
const PLACEMENT = 5;
const SOFT_RESET = 0.5;
const FLOOR = 100;
const DIVISIONS = [['Bronze', 0], ['Silver', 900], ['Gold', 1050], ['Platinum', 1200], ['Diamond', 1350], ['Champion', 1500]];

const seasonId = (d = new Date()) => `L${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
function prevSeason(id) {
  let [y, m] = id.slice(1).split('-').map(Number);
  if (--m < 1) { m = 12; y--; }
  return `L${y}-${String(m).padStart(2, '0')}`;
}
function recentSeasons(n = 6, d = new Date()) {
  const out = [];
  let id = seasonId(d);
  for (let i = 0; i < n; i++) { out.push(id); id = prevSeason(id); }
  return out;
}

function divisionOf(rating, matches) {
  if (matches < PLACEMENT) return 'Unranked';
  let name = DIVISIONS[0][0];
  for (const [n, min] of DIVISIONS) if (rating >= min) name = n;
  return name;
}

const expected = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));

// this season's record for a player, started from last season's if they have none yet
async function load(store, game, userId, season = seasonId()) {
  const s = await store.getStats(game, userId, season);
  if (s.rating !== undefined) return { rating: s.rating, matches: s.matches || 0, wins: s.wins || 0, losses: s.losses || 0, draws: s.draws || 0, peak: s.peak || s.rating };
  const prev = await store.getStats(game, userId, prevSeason(season));
  const start = Math.round(prev.rating !== undefined ? START + (prev.rating - START) * SOFT_RESET : START);
  return { rating: start, matches: 0, wins: 0, losses: 0, draws: 0, peak: start };
}

const pub = (s) => ({ rating: s.rating, matches: s.matches, division: divisionOf(s.rating, s.matches), placed: s.matches >= PLACEMENT });

// sides: [{ humans: [{ userId, name }], goals }, { ... }] -> [{ userId, name, before, after, delta, division }]
// (nothing is rated unless both sides have a signed-in human)
async function applyMatch(store, game, sides, now = new Date()) {
  const [a, b] = sides;
  const ha = a.humans.filter((p) => p.userId), hb = b.humans.filter((p) => p.userId);
  if (!ha.length || !hb.length) return [];
  const season = seasonId(now);
  const rec = new Map();
  for (const p of [...ha, ...hb]) rec.set(p.userId, await load(store, game, p.userId, season));
  const avg = (hs) => hs.reduce((n, p) => n + rec.get(p.userId).rating, 0) / hs.length;
  const ra = avg(ha), rb = avg(hb);
  const diff = a.goals - b.goals;
  const margin = diff === 0 ? 1 : 1 + 0.1 * Math.min(Math.abs(diff), 5);
  const out = [];
  for (const [hs, own, other, res] of [[ha, ra, rb, diff > 0 ? 1 : diff < 0 ? 0 : 0.5], [hb, rb, ra, diff < 0 ? 1 : diff > 0 ? 0 : 0.5]]) {
    const e = expected(own, other);
    for (const p of hs) {
      const s = rec.get(p.userId);
      const k = s.matches < PLACEMENT ? 40 : 24;
      let delta = Math.round(k * margin * (res - e));
      if (res === 1 && delta < 1) delta = 1;
      if (res === 0 && delta > -1) delta = -1;
      const before = s.rating;
      s.rating = Math.max(FLOOR, s.rating + delta);
      s.matches++;
      if (res === 1) s.wins++; else if (res === 0) s.losses++; else s.draws++;
      s.peak = Math.max(s.peak, s.rating);
      await store.setStats(game, p.userId, season, { rating: s.rating, matches: s.matches, wins: s.wins, losses: s.losses, draws: s.draws, peak: s.peak });
      out.push({ userId: p.userId, name: p.name, before, after: s.rating, delta: s.rating - before, ...pub(s) });
    }
  }
  return out;
}

// leaving a rated match you were not winning: it counts as a loss (half the usual weight)
async function forfeit(store, game, userId, name, now = new Date()) {
  const season = seasonId(now);
  const s = await load(store, game, userId, season);
  const k = s.matches < PLACEMENT ? 40 : 24;
  const delta = -Math.max(1, Math.round(k * 0.5 * 0.5));
  const before = s.rating;
  s.rating = Math.max(FLOOR, s.rating + delta);
  s.matches++; s.losses++;
  await store.setStats(game, userId, season, { rating: s.rating, matches: s.matches, wins: s.wins, losses: s.losses, draws: s.draws, peak: s.peak });
  return { userId, name, before, after: s.rating, delta: s.rating - before, ...pub(s) };
}

// the table for a season: placed players only, best rating first
async function table(store, game, season, limit = 50) {
  const rows = await store.leaderboard(game, season, ['rating', 'wins'], 300);
  return rows.filter((r) => (r.stats.matches || 0) >= PLACEMENT).slice(0, limit).map((r) => ({
    username: r.username, callsign: r.callsign, rating: r.stats.rating, matches: r.stats.matches || 0,
    wins: r.stats.wins || 0, losses: r.stats.losses || 0, draws: r.stats.draws || 0, peak: r.stats.peak || r.stats.rating,
    division: divisionOf(r.stats.rating, r.stats.matches || 0),
  }));
}

module.exports = { START, PLACEMENT, DIVISIONS, seasonId, prevSeason, recentSeasons, divisionOf, expected, load, pub, applyMatch, forfeit, table };

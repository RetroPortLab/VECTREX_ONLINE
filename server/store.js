// Where accounts, sessions, stats and round history live.
//
// With DATABASE_URL set (a Neon connection string), everything is in Postgres and survives
// deploys and restarts. Without it, a memory store keeps the site working for local testing,
// and the site says that scores are not being saved.
//
// Stats are rows of (game, user, period, key) -> value: each game decides its keys (kills, wins,
// best_round...) and how its leaderboard is ordered, so a new game needs no schema change.
// period is 'all' or an ISO week like 'w2026-43'.

const crypto = require('crypto');

function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `w${year}-${String(week).padStart(2, '0')}`;
}
const KEY_RE = /^[a-z_]{1,32}$/;

// ---- Postgres --------------------------------------------------------------------------
class PgStore {
  constructor(url) {
    const postgres = require('postgres');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    // Neon's string carries libpq options (sslmode, channel_binding) that this driver would pass to
    // the server as unknown settings, which it refuses: the ssl option below does that job.
    url = url.replace(/([?&])(sslmode|channel_binding)=[^&]*/g, '$1').replace(/[?&]+$/, '').replace('?&', '?');
    this.sql = postgres(url, {
      ssl: local ? false : 'require', max: 5, idle_timeout: 20, connect_timeout: 15,
      onnotice: () => {},
    });
    this.persistent = true;
    this.kind = 'postgres';
  }

  async init() {
    const sql = this.sql;
    await sql`create table if not exists users (
      id serial primary key, username text not null, callsign text not null,
      pw_hash text not null, created timestamptz not null default now())`;
    await sql`create unique index if not exists users_username on users (lower(username))`;
    await sql`create table if not exists sessions (
      token_hash text primary key, user_id int not null references users(id) on delete cascade,
      expires timestamptz not null)`;
    await sql`create table if not exists stats (
      game text not null, user_id int not null references users(id) on delete cascade,
      period text not null, key text not null, value bigint not null default 0,
      primary key (game, period, key, user_id))`;
    await sql`create index if not exists stats_user on stats (user_id)`;
    await sql`create table if not exists rounds (
      id serial primary key, game text not null, room text not null, ended timestamptz not null default now(),
      ranked boolean not null, winner_id int references users(id) on delete set null, players jsonb not null)`;
    await sql`create table if not exists round_players (
      round_id int not null references rounds(id) on delete cascade,
      user_id int not null references users(id) on delete cascade, primary key (round_id, user_id))`;
    await sql`delete from sessions where expires < now()`;
  }

  async createUser(username, callsign, pwHash) {
    try {
      const [u] = await this.sql`insert into users (username, callsign, pw_hash) values (${username}, ${callsign}, ${pwHash})
        returning id, username, callsign, created`;
      return u;
    } catch (e) {
      if (e.code === '23505') return null;                     // the name is taken
      throw e;
    }
  }
  async userByName(name) {
    const [u] = await this.sql`select id, username, callsign, pw_hash, created from users where lower(username) = lower(${name})`;
    return u || null;
  }
  async userById(id) {
    const [u] = await this.sql`select id, username, callsign, created from users where id = ${id}`;
    return u || null;
  }
  async updateUser(id, { callsign, pwHash }) {
    if (callsign) await this.sql`update users set callsign = ${callsign} where id = ${id}`;
    if (pwHash) await this.sql`update users set pw_hash = ${pwHash} where id = ${id}`;
  }
  async callsignOwner(callsign) {
    const [u] = await this.sql`select id from users where callsign = ${callsign} limit 1`;
    return u ? u.id : null;
  }

  async createSession(tokenHash, userId, expires) {
    await this.sql`insert into sessions (token_hash, user_id, expires) values (${tokenHash}, ${userId}, ${expires})`;
  }
  async sessionUser(tokenHash) {
    const [u] = await this.sql`select u.id, u.username, u.callsign, u.created from sessions s join users u on u.id = s.user_id
      where s.token_hash = ${tokenHash} and s.expires > now()`;
    return u || null;
  }
  async deleteSession(tokenHash) { await this.sql`delete from sessions where token_hash = ${tokenHash}`; }
  async deleteSessionsOf(userId, keep) { await this.sql`delete from sessions where user_id = ${userId} and token_hash <> ${keep || ''}`; }

  // sums add to what is there; maxes keep the larger
  async addStats(game, userId, sums = {}, maxes = {}) {
    const periods = ['all', isoWeek()];
    const rows = [];
    for (const period of periods) {
      for (const [key, v] of Object.entries(sums)) if (KEY_RE.test(key) && v) rows.push({ game, user_id: userId, period, key, value: Math.round(v), max: false });
      for (const [key, v] of Object.entries(maxes)) if (KEY_RE.test(key)) rows.push({ game, user_id: userId, period, key, value: Math.round(v), max: true });
    }
    for (const r of rows) {
      if (r.max) {
        await this.sql`insert into stats (game, user_id, period, key, value) values (${r.game}, ${r.user_id}, ${r.period}, ${r.key}, ${r.value})
          on conflict (game, period, key, user_id) do update set value = greatest(stats.value, excluded.value)`;
      } else {
        await this.sql`insert into stats (game, user_id, period, key, value) values (${r.game}, ${r.user_id}, ${r.period}, ${r.key}, ${r.value})
          on conflict (game, period, key, user_id) do update set value = stats.value + excluded.value`;
      }
    }
  }

  async leaderboard(game, period, order, limit = 50) {
    const p = period === 'week' ? isoWeek() : 'all';
    const keys = order.filter((k) => KEY_RE.test(k));
    const orderBy = keys.map((k) => `coalesce(max(value) filter (where key = '${k}'), 0) desc`).join(', ') || 'u.id';
    const rows = await this.sql.unsafe(
      `select u.username, u.callsign, jsonb_object_agg(s.key, s.value) as stats
         from stats s join users u on u.id = s.user_id
        where s.game = $1 and s.period = $2
        group by u.id order by ${orderBy}, u.username limit $3`, [game, p, limit]);
    return rows.map((r) => ({ username: r.username, callsign: r.callsign, stats: numify(r.stats) }));
  }

  async pilot(name) {
    const u = await this.userByName(name);
    if (!u) return null;
    const week = isoWeek();
    const rows = await this.sql`select game, period, key, value from stats where user_id = ${u.id} and period in ('all', ${week})`;
    const games = {};
    for (const r of rows) {
      const g = games[r.game] || (games[r.game] = { all: {}, week: {} });
      g[r.period === 'all' ? 'all' : 'week'][r.key] = Number(r.value);
    }
    const rounds = await this.sql`select r.id, r.game, r.room, r.ended, r.ranked, r.winner_id, r.players
      from round_players rp join rounds r on r.id = rp.round_id where rp.user_id = ${u.id} order by r.ended desc limit 15`;
    return { user: { id: u.id, username: u.username, callsign: u.callsign, created: u.created }, games, rounds };
  }

  async addRound({ game, room, ranked, winnerId, players }) {
    const [r] = await this.sql`insert into rounds (game, room, ranked, winner_id, players)
      values (${game}, ${room}, ${ranked}, ${winnerId || null}, ${this.sql.json(players)}) returning id`;
    const ids = [...new Set(players.filter((p) => p.userId).map((p) => p.userId))];
    for (const id of ids) await this.sql`insert into round_players (round_id, user_id) values (${r.id}, ${id}) on conflict do nothing`;
    return r.id;
  }

  async counts() {
    const [c] = await this.sql`select (select count(*) from users)::int as users, (select count(*) from rounds where ranked)::int as rounds`;
    return c;
  }
}

function numify(o) { const out = {}; for (const [k, v] of Object.entries(o || {})) out[k] = Number(v); return out; }

// ---- memory (local testing; nothing survives a restart) ------------------------------------
class MemStore {
  constructor() {
    this.users = []; this.sessions = new Map(); this.stats = new Map(); this.rounds = [];
    this.persistent = false; this.kind = 'memory';
  }
  async init() {}
  pub(u) { return u && { id: u.id, username: u.username, callsign: u.callsign, created: u.created }; }
  async createUser(username, callsign, pwHash) {
    if (this.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return null;
    const u = { id: this.users.length + 1, username, callsign, pw_hash: pwHash, created: new Date() };
    this.users.push(u);
    return this.pub(u);
  }
  async userByName(name) { return this.users.find((u) => u.username.toLowerCase() === String(name).toLowerCase()) || null; }
  async userById(id) { return this.pub(this.users.find((u) => u.id === id)) || null; }
  async updateUser(id, { callsign, pwHash }) {
    const u = this.users.find((x) => x.id === id);
    if (!u) return;
    if (callsign) u.callsign = callsign;
    if (pwHash) u.pw_hash = pwHash;
  }
  async callsignOwner(c) { const u = this.users.find((x) => x.callsign === c); return u ? u.id : null; }
  async createSession(h, userId, expires) { this.sessions.set(h, { userId, expires }); }
  async sessionUser(h) {
    const s = this.sessions.get(h);
    if (!s || s.expires < new Date()) return null;
    return this.userById(s.userId);
  }
  async deleteSession(h) { this.sessions.delete(h); }
  async deleteSessionsOf(userId, keep) { for (const [h, s] of this.sessions) if (s.userId === userId && h !== keep) this.sessions.delete(h); }
  async addStats(game, userId, sums = {}, maxes = {}) {
    for (const period of ['all', isoWeek()]) {
      const k = `${game}|${period}|${userId}`;
      const s = this.stats.get(k) || {};
      for (const [key, v] of Object.entries(sums)) if (KEY_RE.test(key) && v) s[key] = (s[key] || 0) + Math.round(v);
      for (const [key, v] of Object.entries(maxes)) if (KEY_RE.test(key)) s[key] = Math.max(s[key] ?? -Infinity, Math.round(v));
      this.stats.set(k, s);
    }
  }
  async leaderboard(game, period, order, limit = 50) {
    const p = period === 'week' ? isoWeek() : 'all';
    const rows = [];
    for (const [k, s] of this.stats) {
      const [g, per, uid] = k.split('|');
      if (g !== game || per !== p) continue;
      const u = this.users.find((x) => x.id === Number(uid));
      rows.push({ username: u.username, callsign: u.callsign, stats: { ...s } });
    }
    rows.sort((a, b) => { for (const k of order) { const d = (b.stats[k] || 0) - (a.stats[k] || 0); if (d) return d; } return a.username.localeCompare(b.username); });
    return rows.slice(0, limit);
  }
  async pilot(name) {
    const u = await this.userByName(name);
    if (!u) return null;
    const games = {};
    for (const [k, s] of this.stats) {
      const [g, per, uid] = k.split('|');
      if (Number(uid) !== u.id) continue;
      const e = games[g] || (games[g] = { all: {}, week: {} });
      if (per === 'all') e.all = { ...s }; else if (per === isoWeek()) e.week = { ...s };
    }
    const rounds = this.rounds.filter((r) => r.players.some((p) => p.userId === u.id)).slice(-15).reverse();
    return { user: this.pub(u), games, rounds };
  }
  async addRound(r) { const id = this.rounds.length + 1; this.rounds.push({ id, ended: new Date(), ...r, winner_id: r.winnerId || null }); return id; }
  async counts() { return { users: this.users.length, rounds: this.rounds.filter((r) => r.ranked).length }; }
}

function createStore(env = process.env) {
  if (env.DATABASE_URL) return new PgStore(env.DATABASE_URL);
  return new MemStore();
}

const randomToken = () => crypto.randomBytes(32).toString('base64url');
module.exports = { createStore, isoWeek, randomToken, PgStore, MemStore };

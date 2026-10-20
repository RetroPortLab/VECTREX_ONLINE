// The link test: two consoles, each one's position relayed to the other. No scores.

const int = (v, lo, hi) => { v = Math.round(Number(v) || 0); return v < lo ? lo : v > hi ? hi : v; };
const cleanName = (n) => String(n || 'player').replace(/[^\w .-]/g, '').slice(0, 24) || 'player';

const game = {
  id: 'linktest',
  title: 'Link Test',
  tagline: 'Two consoles, one screen each: see the other ship move. The first thing to try.',
  players: '2',
  bridgeNames: ['netlink'],
  cart: { tag: 'VNET', build: 'netball', folder: 'vectrex/netlink_test' },
  dashboardType: 'netlink',
  about: [
    'The simplest thing two Vectrex consoles can do over the internet: each one\'s joystick moves its own ship, and the other console\'s ship appears as a diamond.',
    'The watch page measures everything on the way: the round trip to the relay, frames per second each way, the USB link on each side.',
  ],
  controls: [['Stick', 'move your ship'], ['Button 1 (hold)', 'a ring the other side sees']],
  leaderboard: null,
  profile: [],
  createRoom(name, ctx) { return new LinkTestRoom(name, ctx); },
};

class LinkTestRoom {
  constructor(name, ctx) {
    this.name = name;
    this.ctx = ctx;
    this.type = 'netlink';
    this.bridges = new Map();             // slot 1 or 2 -> console
  }
  close() {}
  get empty() { return this.bridges.size === 0; }
  get humans() { return [...this.bridges.values()]; }
  get size() { return this.bridges.size; }

  peersChanged() {
    const peers = this.bridges.size;
    for (const [slot, c] of this.bridges) this.ctx.send(c.ws, { t: 'peers', peers, slot });
  }

  join(ws, { name, ip, user, cart }) {
    const slot = !this.bridges.has(1) ? 1 : !this.bridges.has(2) ? 2 : 0;
    if (!slot) return { error: `room '${this.name}' already has two consoles` };
    const c = {
      ws, ip, slot, id: slot, name: user ? user.callsign : cleanName(name), cart: cart === 'sim' ? 'sim' : 'uvmc2',
      since: Date.now(), last: null, lastAt: 0, total: 0, missed: 0, inCount: 0, inHz: 0,
      relayed: 0, relayedHz: 0, rtt: null, rttHist: [], pings: new Map(), bstat: null,
    };
    this.bridges.set(slot, c);
    this.ctx.send(ws, { t: 'welcome', slot, peers: this.bridges.size, room: this.name });
    this.ctx.log(`P${slot} ${c.name} joined (${c.cart})`);
    this.peersChanged();
    return c;
  }

  leave(c) {
    if (this.bridges.get(c.slot) === c) this.bridges.delete(c.slot);
    this.ctx.log(`P${c.slot} ${c.name} left`, 'warn');
    this.peersChanged();
  }

  message(c, m, now) {
    if (m.t !== 'state') return;
    const s = {
      f: int(m.f, 0, 0xffffffff), x: int(m.x, -127, 127), y: int(m.y, -127, 127),
      b: int(m.b, 0, 255), fl: int(m.fl, 0, 255), jx: int(m.jx, -128, 127), jy: int(m.jy, -128, 127),
    };
    if (c.last && s.f > c.last.f + 1 && s.f - c.last.f < 500) c.missed += s.f - c.last.f - 1;
    c.last = s; c.lastAt = now; c.total++; c.inCount++;
    const out = JSON.stringify({ t: 'state', room: this.name, slot: c.slot, ...s });
    for (const [slot, other] of this.bridges) if (slot !== c.slot) { this.ctx.send(other.ws, out); c.relayed++; }
    this.ctx.toMonitors(out);
  }

  secondTick() { for (const c of this.bridges.values()) { c.inHz = c.inCount; c.inCount = 0; c.relayedHz = c.relayed; c.relayed = 0; } }

  info() {
    return {
      type: 'netlink',
      players: [...this.bridges.values()].sort((a, b) => a.slot - b.slot).map((c) => ({
        slot: c.slot, name: c.name, cart: c.cart, rtt: c.rtt, rttHist: c.rttHist, inHz: c.inHz, relayedHz: c.relayedHz,
        frame: c.last ? c.last.f : null, missed: c.missed, total: c.total, since: c.since, bstat: c.bstat,
        lastAge: c.lastAt ? Date.now() - c.lastAt : null,
      })),
    };
  }
  monitorInit() { return []; }
}

module.exports = game;

// The browser bridge: a Vectrex cartridge on USB (Web Serial) <-> the relay (WebSocket).
// A port of bridge/bridge.py, cart.py, strikebox.py and netbox.py; keep them in step.
//
//   const b = new WebBridge({ port, room, name, log, onStatus });
//   await b.start();   // opens the cart, finds the game, joins the room, runs until b.stop()
//
// The cart is read with the SDK's USB monitor protocol (text lines: v, r <addr> <n>, w <addr> <hex>).
// One loop owns the port: it writes what the relay sent (one pipelined batch), reads the game's
// mailbox, and hands new game states to the network side. Only the newest of anything is written,
// so a slow USB moment never builds a queue.
(function (root) {
  'use strict';
  const VID = 0x2E8A, PID = 0x10DB;
  const SRAM0 = 0x20000000, SRAM1 = 0x20082000;
  const MAGIC_STRIKE = 0x4B545356, MAGIC_NET = 0x54454E56;       // "VSTK", "VNET"
  const ST_EVERY = 40;                                           // VEC STRIKE: the ship to the relay 25 times a second

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const toI = (v) => Math.trunc(Number(v) || 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // a hop through a message channel: unlike a timer, Chrome doesn't slow it down in a background tab
  const hop = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
  const hex = (u8) => { let s = ''; for (const b of u8) s += (b < 16 ? '0' : '') + b.toString(16); return s; };
  const unhex = (h) => { const n = h.length >> 1, b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; };

  // ---- little-endian packing ------------------------------------------------------------
  class Pack {
    constructor(n) { this.b = new Uint8Array(n); this.v = new DataView(this.b.buffer); this.o = 0; }
    u8(x) { this.v.setUint8(this.o++, toI(x) & 255); return this; }
    i8(x) { this.v.setInt8(this.o++, clamp(toI(x), -128, 127)); return this; }
    u16(x) { this.v.setUint16(this.o, toI(x) & 0xFFFF, true); this.o += 2; return this; }
    i16(x) { this.v.setInt16(this.o, clamp(toI(x), -32768, 32767), true); this.o += 2; return this; }
    u32(x) { this.v.setUint32(this.o, toI(x) >>> 0, true); this.o += 4; return this; }
    skip(n) { this.o += n; return this; }
    bytes(u8) { this.b.set(u8, this.o); this.o += u8.length; return this; }
    done() { return this.b.subarray(0, this.o); }
  }
  const dv = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // ---- VEC STRIKE's mailbox (vectrex/vecstrike/src/vstk_box.h) --------------------------------
  const SB = {
    SIZE: 1264, OFF_LOCAL: 8, LOCAL_END: 40, OFF_LINK: 40, OFF_ROSTER: 48, OFF_ROSTER_ENTRIES: 56, OFF_COMMIT: 336,
    OFF_SNAP: 344, SNAP_SIZE: 460, SNAP_BUL: 156, SNAP_EVT: 412, MAX_SHIPS: 20, MAX_BUL: 64, MAX_EVT: 8, MY_BUL: 3,
    VL_NONE: 0, VL_RELAY: 1, VL_ROOM: 2,
  };
  const headerOk = (raw, magic, size) => {
    if (raw.length < 8) return false;
    const v = dv(raw);
    return v.getUint32(0, true) === magic && v.getUint16(4, true) === 1 && v.getUint16(6, true) === size;
  };
  function decodeStrikeLocal(raw) {
    const v = dv(raw), o = SB.OFF_LOCAL;
    const s = {
      seq: v.getUint32(o, true), f: v.getUint32(o + 4, true), x: v.getInt8(o + 8), y: v.getInt8(o + 9), a: v.getUint8(o + 10),
      fl: v.getUint8(o + 11), vx: v.getInt8(o + 12), vy: v.getInt8(o + 13), life: v.getUint8(o + 14), hit: v.getUint8(o + 15),
      shots: v.getUint8(o + 16), hull: v.getUint8(o + 18), b: [],
    };
    const nbul = Math.min(v.getUint8(o + 17), SB.MY_BUL);
    for (let i = 0; i < nbul; i++) { const p = o + 20 + i * 4; s.b.push([v.getInt8(p), v.getInt8(p + 1), v.getUint8(p + 2)]); }
    return s;
  }
  function decodeNetLocal(raw) {
    const v = dv(raw), o = 8;
    return { seq: v.getUint32(o, true), f: v.getUint32(o + 4, true), x: v.getInt16(o + 8, true), y: v.getInt16(o + 10, true),
      b: v.getUint8(o + 12), fl: v.getUint8(o + 13), jx: v.getInt8(o + 14), jy: v.getInt8(o + 15) };
  }
  const encodeLink = (rtt, peers, state, seq) => new Pack(8).u16(clamp(toI(rtt), 0, 65535)).u8(clamp(peers, 0, 255)).u8(state).u32(seq).done();
  function encodeRemote(seq, s) {
    return new Pack(16).u32(seq).u32(s.f || 0).i16(s.x).i16(s.y).u8(s.b || 0).u8(s.fl || 0).i8(s.jx).i8(s.jy).done();
  }
  function name8(s) {
    const out = new Uint8Array(8).fill(32);
    const t = String(s || '').toUpperCase();
    for (let i = 0; i < 8 && i < t.length; i++) { const c = t.charCodeAt(i); out[i] = c < 128 ? c : 63; }
    return out;
  }
  function rosterWrites(rseq, roundKills, players) {
    const list = players.slice(0, SB.MAX_SHIPS);
    const out = [];
    if (list.length) {
      const p = new Pack(14 * list.length);
      for (const e of list) p.u8(e[0]).u8(e[1]).u16(e[2]).u16(e[3]).bytes(name8(e[4]));
      out.push([SB.OFF_ROSTER_ENTRIES, p.done()]);
    }
    out.push([SB.OFF_ROSTER, new Pack(8).u32(rseq).u8(list.length).u8(roundKills).skip(2).done()]);
    return out;
  }
  function snapshotWrites(buf, commitSeq, snap, me) {
    const base = SB.OFF_SNAP + buf * SB.SNAP_SIZE;
    const ships = (snap.ships || []).filter((s) => s[0] !== me).slice(0, SB.MAX_SHIPS);
    const buls = (snap.bul || []).filter((b) => b[3] !== me).slice(0, SB.MAX_BUL);
    const evs = (snap.ev || []).slice(-SB.MAX_EVT);
    const [sx, sy, sa] = snap.spawn || [0, 0, 0];
    const head = new Pack(16 + 7 * ships.length)
      .u32(snap.seq || 0).u8(me).u8(snap.my_life || 0).u8(snap.my_state || 0).u8(ships.length)
      .i8(sx).i8(sy).u8(sa).u8(buls.length).u8(snap.round_kills || 0).u8(Math.min(255, snap.respawn_in || 0)).u8(snap.np || 0).u8(snap.win || 0);
    for (const s of ships) head.u8(s[0]).i8(s[1]).i8(s[2]).u8(s[3]).u8(s[4]).i8(s[5]).i8(s[6]);
    const out = [[base, head.done()]];
    if (buls.length) {
      const p = new Pack(4 * buls.length);
      for (const b of buls) p.i8(b[0]).i8(b[1]).u8(b[2]).u8(b[3]);
      out.push([base + SB.SNAP_BUL, p.done()]);
    }
    const ev = new Pack(6 * SB.MAX_EVT);
    for (const e of evs) ev.u8(e[0]).u8(e[1]).i8(e[2]).i8(e[3]).u8(e[4]).u8(e[5]);
    ev.o = 6 * SB.MAX_EVT;
    out.push([base + SB.SNAP_EVT, ev.done()]);
    out.push([SB.OFF_COMMIT, new Pack(8).u32(commitSeq).u8(buf).skip(3).done()]);
    return out;
  }
  function chunks(writes, limit = 64) {
    const out = [];
    for (const [off, data] of writes) for (let i = 0; i < data.length; i += limit) out.push([off + i, data.subarray(i, i + limit)]);
    return out;
  }

  // ---- the cart --------------------------------------------------------------------------
  class CartError extends Error {}

  class Cart {
    constructor(port, log) {
      this.port = port; this.log = log;
      this.waiters = []; this.stale = []; this.buf = ''; this.gameLine = '';
      this.announced = null; this.game = null; this.addr = null; this.version = '';
      this.usbMs = 0; this.gone = false; this.stopped = false;
      this.enc = new TextEncoder(); this.dec = new TextDecoder('latin1');
    }

    async open() {
      const port = this.port;
      try { await port.open({ baudRate: 115200 }); }
      catch (e) { throw new CartError(`${e.name}: ${e.message} (if VectrexBridge or the IDE's debugger has the port, close it)`); }
      try { await port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch { /* not every port has modem lines */ }
      this.writer = port.writable.getWriter();
      this.reader = port.readable.getReader();
      this.readLoop();
      let v = '';
      for (let i = 0; i < 4 && !v.startsWith('UVMC2-'); i++) {
        try { v = await this.ask('v', 2500); } catch (e) { if (i === 3) { await this.close(); throw new CartError(`${e.message}: the cart's monitor did not answer. Chrome lists two ports for the cart: this may be the second (gdb's).`); } }
      }
      if (v.startsWith('UVMC2-BRIDGE')) { await this.close(); throw new CartError('the cartridge is in its menu (the SD bridge), not running a game'); }
      if (!v.startsWith('UVMC2-MON')) { await this.close(); throw new CartError(`unexpected answer "${v.slice(0, 30)}" from the cart`); }
      this.version = v;
      this.log(`cart: ${v}`);
    }

    async close() {
      this.gone = true;
      const { reader, writer, port } = this;
      this.reader = this.writer = null;
      this.flush(new CartError('closed'));
      try { await reader?.cancel(); } catch { /* already gone */ }
      try { reader?.releaseLock(); } catch { /* ditto */ }
      try { writer?.releaseLock(); } catch { /* ditto */ }
      try { await port.close(); } catch { /* ditto */ }
    }

    flush(err) { const w = this.waiters; this.waiters = []; for (const x of w) x.reject(err); }

    async readLoop() {
      const reader = this.reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          this.buf += this.dec.decode(value);
          let i;
          while ((i = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, i).trim();
            this.buf = this.buf.slice(i + 1);
            if (!line) continue;
            if (line.startsWith('!T ')) { this.gameText(line.slice(3)); continue; }
            if (line.startsWith('!S ')) { if (!this.stopped) this.log(`cart: the game is stopped by the debugger (${line.slice(3)})`); this.stopped = true; continue; }
            const w = this.waiters.shift();
            if (w) w.resolve(line); else this.stale.push(line);
          }
        }
      } catch { /* the port closed under us */ }
      this.gone = true;
      this.flush(new CartError('the cartridge went off USB'));
    }

    gameText(h) {
      for (let i = 0; i + 1 < h.length; i += 2) {
        const c = String.fromCharCode(parseInt(h.substr(i, 2), 16));
        if (c !== '\n') { this.gameLine += c; continue; }
        const m = /(?:VNET|VSTK) ([0-9a-fA-F]{8})/.exec(this.gameLine);
        if (m) this.announced = parseInt(m[1], 16);
        else if (this.gameLine.trim()) this.log(`game: ${this.gameLine.trim()}`);
        this.gameLine = '';
      }
    }

    // one answer, in order: the monitor answers lines in the order it got them
    answer(ms) {
      return new Promise((resolve, reject) => {
        const w = { resolve: (l) => { clearTimeout(t); resolve(l); }, reject: (e) => { clearTimeout(t); reject(e); } };
        const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new CartError('no answer from the cart')); }, ms);
        this.waiters.push(w);
      });
    }
    send(text) {
      if (this.gone || !this.writer) throw new CartError('not connected');
      return this.writer.write(this.enc.encode(text));
    }
    async ask(cmd, ms = 1500) {
      if (this.gone) throw new CartError('not connected');
      this.stale.length = 0;
      const p = this.answer(ms);
      try { await this.send(cmd + '\n'); } catch (e) { p.catch(() => {}); throw new CartError(e.message); }
      return p;
    }
    async read(addr, n) {
      const t0 = performance.now();
      const h = await this.ask(`r ${addr.toString(16)} ${n}`);
      this.usbMs = this.usbMs * 0.9 + (performance.now() - t0) * 0.1;
      if (h.startsWith('ERR')) throw new CartError(`read ${addr.toString(16)}: ${h}`);
      if (h.length !== n * 2) throw new CartError(`read ${addr.toString(16)}: ${h.length / 2} bytes, wanted ${n}`);
      return unhex(h);
    }
    // [[addr, bytes]] (each up to 64 bytes): one batch, answered in order
    async writeMany(writes) {
      if (!writes.length) return;
      if (this.gone) throw new CartError('not connected');
      this.stale.length = 0;
      const ms = 1000 + 10 * writes.length;
      const ps = writes.map(() => this.answer(ms));
      ps.forEach((p) => p.catch(() => {}));
      try { await this.send(writes.map(([a, d]) => `w ${a.toString(16)} ${hex(d)}\n`).join('')); } catch (e) { throw new CartError(e.message); }
      const answers = await Promise.all(ps);
      const bad = answers.find((a) => a.startsWith('ERR'));
      if (bad) throw new CartError(`write: ${bad}`);
    }
    writeBox(writes) { return this.writeMany(chunks(writes).map(([off, d]) => [this.addr + off, d])); }

    // ---- finding the mailbox ----
    async check(addr) {
      try {
        const h = await this.read(addr, 8);
        const m = dv(h).getUint32(0, true);
        if (m === MAGIC_STRIKE && headerOk(h, m, SB.SIZE)) return 'strike';
        if (m === MAGIC_NET && headerOk(h, m, 48)) return 'netlink';
      } catch (e) { if (this.gone) throw e; }
      return null;
    }
    async locate() {
      let how = null;
      this.log('cart: waiting for the game to announce its mailbox ...');
      const end = performance.now() + 2000;
      while (this.announced === null && performance.now() < end && !this.gone) await sleep(50);
      if (this.announced !== null) { this.addr = this.announced; how = "the game's announcement"; }
      let game = this.addr !== null ? await this.check(this.addr) : null;
      if (!game) {
        if (this.addr !== null) this.log(`cart: no mailbox at ${this.addr.toString(16)}; scanning RAM`);
        [this.addr, game] = await this.scan();
        how = 'found by scanning RAM';
      }
      this.game = game;
      this.log(`cart: ${game === 'strike' ? 'VEC STRIKE' : 'link test'} mailbox at ${this.addr.toString(16)} (${how})`);
    }
    async scan() {
      // One read at a time, like the monitor's own tools do (the cart's answers can overrun if
      // many are in flight), and each candidate is checked the moment it turns up.
      const t0 = performance.now();
      let n = 0;
      this.onScan && this.onScan(0);
      for (let base = SRAM0; base < SRAM1; base += 256) {
        let chunk;
        try { chunk = await this.read(base, 256); } catch (e) { if (this.gone) throw e; continue; }
        const v = dv(chunk);
        for (let i = 0; i + 4 <= 256; i += 4) {
          const m = v.getUint32(i, true);
          if (m !== MAGIC_STRIKE && m !== MAGIC_NET) continue;
          n++;
          const a = base + i;
          const game = await this.check(a);
          if (!game) continue;
          const s1 = dv(await this.read(a + 8, 4)).getUint32(0, true);       // l_seq: offset 8 in both games
          await sleep(100);
          const s2 = dv(await this.read(a + 8, 4)).getUint32(0, true);
          if (s1 !== s2) {
            this.log(`cart: scanned ${((a - SRAM0) >> 10)} KB in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
            return [a, game];
          }
        }
        if (((base - SRAM0) >> 8) % 32 === 0) { this.onScan && this.onScan((base - SRAM0) / (SRAM1 - SRAM0)); await hop(); }
      }
      this.log(`cart: scanned ${(SRAM1 - SRAM0) >> 10} KB in ${((performance.now() - t0) / 1000).toFixed(1)} s, ${n} candidate(s)`);
      throw new CartError('no live mailbox in RAM: is VEC STRIKE (or the link test) the game running on the cart?');
    }

    // ---- what the bridge uses ----
    async readLocal() {
      if (this.game === 'strike') {
        const raw = await this.read(this.addr, SB.LOCAL_END);
        if (!headerOk(raw, MAGIC_STRIKE, SB.SIZE)) throw new CartError('the mailbox is gone (the game restarted or another one is running)');
        const s = decodeStrikeLocal(raw);
        if (s.seq & 1) return null;
        this.stopped = false;
        return s;
      }
      const raw = await this.read(this.addr, 24);
      if (!headerOk(raw, MAGIC_NET, 48)) throw new CartError('the mailbox is gone (the game restarted or another one is running)');
      const s = decodeNetLocal(raw);
      if (s.seq & 1) return null;
      this.stopped = false;
      return s;
    }
  }

  // ---- the bridge ------------------------------------------------------------------------
  class WebBridge {
    constructor({ port, room, name, wsUrl, log, onStatus, onScan }) {
      this.port = port; this.room = room; this.name = name;
      this.wsUrl = wsUrl || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      this.log = log || (() => {});
      this.onStatus = onStatus || (() => {});
      this.onScan = onScan;
      this.stopped = false;
      this.status = { cart: 'starting', fw: '', game: null, addr: null, usb_ms: 0, poll_hz: 0, game_hz: 0, sent_hz: 0, rx_hz: 0,
        net: 'starting', slot: 0, peers: 0, rtt: null, pilots: 0, score: null, account: null, room: null, roster: [], rk: 15, local: null };
      this.pending = { remote: null, snap: null, roster: null };
      this.link = [0, 0, 0]; this.linkDirty = true;
      this.ws = null; this.myId = 0; this.remoteSeq = 0; this.backoff = 1;
      this.cnt = { polls: 0, frames: 0, sent: 0, rx: 0 };
      this.latest = null; this.lastSt = 0; this.hitLife = null;
    }

    set(patch) { Object.assign(this.status, patch); this.emit(); }
    emit() { const now = performance.now(); if (now - (this._emitAt || 0) > 100) { this._emitAt = now; this.onStatus(this.status); } }
    setLink(rtt, peers, slot) {
      [rtt, peers, slot].forEach((v, i) => { if (v !== undefined && v !== null && this.link[i] !== v) { this.link[i] = v; this.linkDirty = true; } });
    }

    async start() {
      this.running = (async () => {
        let cart = null;
        while (!this.stopped) {
          // 1. the cart
          if (!cart) {
            this.set({ cart: 'connecting' });
            cart = new Cart(this.port, this.log);
            cart.onScan = this.onScan;
            try {
              await cart.open();
              await cart.locate();
            } catch (e) {
              this.set({ cart: `error: ${e.message}` });
              this.log(`cart: ${e.message}`);
              await cart.close().catch(() => {});
              cart = null;
              await sleep(3000);
              continue;
            }
            this.set({ cart: 'ok', fw: cart.version, game: cart.game, addr: cart.addr });
            this.connectNet(cart.game);
            this.linkSeq = 0; this.cur = 0; this.commit = 0; this.lastSeq = null; this.lastLink = 0;
            this.linkDirty = true;
          }
          // 2. one trip round the loop
          try {
            await this.step(cart);
          } catch (e) {
            if (this.stopped) break;
            this.set({ cart: `error: ${e.message}` });
            this.log(`cart: ${e.message}`);
            await cart.close().catch(() => {});
            cart = null;
            this.closeNet();
            await sleep(1000);
            continue;
          }
          await hop();
          if (cart.simulated) await sleep(10);
        }
        if (cart) await cart.close().catch(() => {});
        this.closeNet();
        this.set({ net: 'stopped', cart: 'stopped' });
        this.log('bridge stopped');
      })();
      return this.running;
    }

    stop() { this.stopped = true; this.closeNet(); return this.running; }

    async step(cart) {
      const t0 = performance.now();
      const p = this.pending, game = cart.game;
      const remote = p.remote, snap = p.snap, roster = p.roster;
      p.remote = p.snap = p.roster = null;
      const link = (this.linkDirty || t0 - this.lastLink > 1000) ? this.link.slice() : null;
      this.linkDirty = false;
      if (game === 'strike') {
        const writes = [];
        if (link) { this.linkSeq++; writes.push([SB.OFF_LINK, encodeLink(link[0], link[1], link[2], this.linkSeq)]); this.lastLink = t0; }
        if (roster) writes.push(...rosterWrites(...roster));
        if (snap) {
          const buf = 1 - this.cur;                          // the one the game is not reading, then the commit
          this.commit++;
          writes.push(...snapshotWrites(buf, this.commit, snap[0], snap[1]));
          this.cur = buf;
        }
        if (writes.length) await cart.writeBox(writes);
      } else {
        if (remote) await cart.writeMany([[cart.addr + 24, encodeRemote(remote[0], remote[1])]]);
        if (link) { this.linkSeq++; await cart.writeMany([[cart.addr + 40, encodeLink(link[0], link[1], link[2], this.linkSeq)]]); this.lastLink = t0; }
      }
      const s = await cart.readLocal();
      this.cnt.polls++;
      this.status.usb_ms = cart.usbMs;
      if (s && s.seq !== this.lastSeq) {
        this.lastSeq = s.seq;
        this.cnt.frames++;
        this.status.local = s;
        this.onLocal(s, game);
      }
      this.tick();
    }

    // ---- the network side ----
    connectNet(game) {
      if (this.stopped) return;
      this.set({ net: 'connecting' });
      if (game === 'strike') this.setLink(undefined, undefined, SB.VL_RELAY);
      this.log(`net: connecting to ${this.wsUrl}`);
      const room = this.room || (game === 'strike' ? 'arena' : 'test');
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws; this.game = game;
      ws.onopen = () => {
        this.backoff = 1;
        this.set({ net: 'connected', room });
        ws.send(JSON.stringify({ t: 'hello', role: 'bridge', room, name: this.name, cart: 'uvmc2', game }));
      };
      ws.onmessage = (ev) => { try { this.onMessage(JSON.parse(ev.data), game); } catch (e) { this.log(`net: ${e.message}`); } };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.set({ net: 'disconnected', peers: 0, slot: 0, rtt: null, pilots: 0 });
        this.setLink(undefined, 0, 0);
        if (this.stopped) return;
        this.log(`net: reconnecting in ${this.backoff} s`);
        const b = this.backoff; this.backoff = Math.min(this.backoff * 2, 30);
        setTimeout(() => { if (!this.stopped && !this.ws && this.status.cart === 'ok') this.connectNet(game); }, b * 1000);
      };
      ws.onerror = () => {};
    }
    closeNet() { const ws = this.ws; this.ws = null; if (ws) { try { ws.close(); } catch { /* gone */ } } }
    wsend(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }

    onLocal(s, game) {                                       // a new game state from the cart
      this.latest = s;
      const now = performance.now();
      if (game === 'strike') {
        if (s.hit && s.life !== this.hitLife) {              // a hit goes out the moment the game records it
          this.hitLife = s.life;
          this.wsend({ t: 'hit', by: s.hit, life: s.life });
          this.log(`game: hit by P${s.hit}`);
        }
        if (now - this.lastSt >= ST_EVERY) {
          this.lastSt = now;
          this.wsend({ t: 'st', f: s.f, x: s.x, y: s.y, a: s.a, vx: s.vx, vy: s.vy, fl: s.fl, life: s.life, hit: s.hit, b: s.b });
          this.cnt.sent++;
        }
      } else {
        const { seq, ...rest } = s;
        this.wsend({ t: 'state', ...rest });
        this.cnt.sent++;
      }
    }

    onMessage(m, game) {
      const strike = game === 'strike';
      switch (m.t) {
        case 'ping': this.wsend({ t: 'pong', id: m.id }); break;
        case 'rtt': this.status.rtt = toI(m.ms); this.setLink(this.status.rtt); break;
        case 'error': this.log(`net: server says: ${m.msg}`); this.set({ net: `error: ${m.msg}` }); break;
        case 'snap': {
          if (!strike) break;
          this.cnt.rx++;
          const y = m.you || {};
          const snap = { seq: m.seq || 0, ships: m.ships || [], bul: m.bul || [], ev: m.ev || [], np: m.np || 0, round_kills: m.rk || 15,
            win: m.win || 0, my_life: y.life || 0, my_state: y.state || 0, spawn: [y.sx || 0, y.sy || 0, y.sa || 0], respawn_in: y.rin || 0 };
          this.pending.snap = [snap, this.myId];
          this.status.pilots = this.status.peers = snap.np;
          this.setLink(undefined, Math.min(255, snap.np));
          break;
        }
        case 'roster': {
          if (!strike) break;
          const players = m.players || [];
          this.pending.roster = [m.seq || 0, m.rk || 15, players];
          const mine = players.find((p) => p[0] === this.myId);
          this.status.roster = players; this.status.rk = m.rk || 15;
          if (mine) this.status.score = [mine[2], mine[3]];
          break;
        }
        case 'welcome':
          if (strike) {
            this.myId = toI(m.id);
            this.status.slot = this.myId; this.status.peers = toI(m.peers); this.status.account = m.account || null;
            this.setLink(undefined, toI(m.peers), SB.VL_ROOM);
            this.log(`net: in VEC STRIKE room '${m.room}' as P${this.myId} (${m.peers} pilot(s) here)${m.account ? ` as ${m.account}` : ' as a guest'}`);
          } else {
            this.status.slot = toI(m.slot); this.status.peers = toI(m.peers);
            this.setLink(undefined, toI(m.peers), toI(m.slot));
            this.log(`net: joined room '${m.room}' as P${m.slot} (${m.peers} console(s) in)`);
          }
          this.emit();
          break;
        case 'peers':
          if (!strike) { this.status.peers = toI(m.peers); this.status.slot = toI(m.slot); this.setLink(undefined, toI(m.peers), toI(m.slot)); }
          break;
        case 'state':
          if (!strike) { this.remoteSeq++; this.cnt.rx++; this.pending.remote = [this.remoteSeq, m]; this.status.remote = m; }
          break;
        default: break;
      }
    }

    tick() {                                                  // once a second: rates and the stats the dashboard shows
      const now = performance.now();
      if (!this._statAt) this._statAt = now;
      if (now - this._statAt < 1000) { this.emit(); return; }
      const dt = (now - this._statAt) / 1000, c = this.cnt;
      Object.assign(this.status, { poll_hz: Math.round(c.polls / dt), game_hz: Math.round(c.frames / dt), sent_hz: Math.round(c.sent / dt), rx_hz: Math.round(c.rx / dt) });
      this.wsend({ t: 'bstat', cart: this.status.cart, fw: this.status.fw, usb_ms: Math.round(this.status.usb_ms * 100) / 100,
        poll_hz: this.status.poll_hz, game_hz: this.status.game_hz, sent_hz: this.status.sent_hz });
      Object.assign(c, { polls: 0, frames: 0, sent: 0, rx: 0 });
      this._statAt = now;
      this._emitAt = 0;
      this.emit();
    }
  }

  root.WebBridge = WebBridge;
  root.WebBridgeParts = { Cart, CartError, VID, PID, SB, rosterWrites, snapshotWrites, encodeLink, encodeRemote, chunks, decodeStrikeLocal, decodeNetLocal, name8 };
})(typeof window !== 'undefined' ? window : globalThis);

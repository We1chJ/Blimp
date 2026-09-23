const { WebSocket } = require('ws');

const { safeEqual, rateLimiter } = require('./security');

const TURN_MS = 90000;

// The old guard was a timestamp on the socket, which cost an attacker nothing
// to reset - reconnect and the cooldown is gone. Throttle the address instead,
// so opening a hundred sockets buys a hundred attempts from one bucket rather
// than a hundred buckets.
const adminLoginLimit = rateLimiter({ burst: 5, perMinute: 5 });

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

class FlightQueue {
  constructor(onChange) {
    this.waiting = [];        // [{ id, ws, username }], FIFO
    this.current = null;      // { id, ws, username, turnEndsAt, pausedRemainingMs? }
    this.overrideWs = null;   // admin ws currently flying, or null
    this.onChange = onChange || (() => {});
    this.nextId = 1;
  }

  _hasEntry(ws) {
    return (this.current && this.current.ws === ws) || this.waiting.some(e => e.ws === ws);
  }

  // Ends the current turn (if any) and promotes the next waiting entry.
  // Never auto-starts a turn while the admin is holding control.
  _advance() {
    this.current = null;
    if (this.overrideWs) return;
    const next = this.waiting.shift();
    if (next) {
      this.current = { id: next.id, ws: next.ws, username: next.username, turnEndsAt: Date.now() + TURN_MS };
    }
  }

  join(ws, username) {
    const name = String(username || '').trim().slice(0, 24);
    if (!name || this._hasEntry(ws)) return;
    this.waiting.push({ id: String(this.nextId++), ws, username: name });
    if (!this.current && !this.overrideWs) this._advance();
    this.onChange();
  }

  leave(ws) {
    if (this.current && this.current.ws === ws) {
      this._advance();
      this.onChange();
      return;
    }
    const i = this.waiting.findIndex(e => e.ws === ws);
    if (i !== -1) {
      this.waiting.splice(i, 1);
      this.onChange();
    }
  }

  // A queue spot only exists while the socket is live: a closing socket
  // (tab closed, refreshed, dropped) forfeits it immediately - no grace period.
  handleDisconnect(ws) {
    if (this.overrideWs === ws) this.adminReleaseControl(ws);
    this.leave(ws);
  }

  adminLogin(ws, password) {
    if (!adminLoginLimit(ws.ip || '')) return false;
    const expected = process.env.ADMIN_PASSWORD;
    // safeEqual, not ===, so a wrong guess takes the same time whatever
    // prefix it shares with the real password
    const ok = Boolean(expected) && typeof password === 'string' && safeEqual(password, expected);
    if (ok) ws.isAdmin = true;
    return ok;
  }

  adminRemove(ws, id) {
    if (!ws.isAdmin) return;
    if (this.current && this.current.id === id) {
      const removedWs = this.current.ws;
      this._advance();
      send(removedWs, { type: 'removedByAdmin' });
      this.onChange();
      return;
    }
    const i = this.waiting.findIndex(e => e.id === id);
    if (i !== -1) {
      const [removed] = this.waiting.splice(i, 1);
      send(removed.ws, { type: 'removedByAdmin' });
      this.onChange();
    }
  }

  adminTakeControl(ws) {
    if (!ws.isAdmin || this.overrideWs) return;
    this.overrideWs = ws;
    if (this.current) this.current.pausedRemainingMs = this.current.turnEndsAt - Date.now();
    this.onChange();
  }

  adminReleaseControl(ws) {
    if (this.overrideWs !== ws) return;
    this.overrideWs = null;
    if (this.current && this.current.pausedRemainingMs != null) {
      this.current.turnEndsAt = Date.now() + this.current.pausedRemainingMs;
      delete this.current.pausedRemainingMs;
    } else if (!this.current && this.waiting.length) {
      this._advance();
    }
    this.onChange();
  }

  // Gate for raw motor/stop commands: only the active pilot (or the admin
  // while overriding) may drive the blimp, regardless of what any client UI shows.
  isAuthorized(ws) {
    if (this.overrideWs) return ws === this.overrideWs;
    return !!this.current && this.current.ws === ws;
  }

  tick() {
    if (this.overrideWs) return;
    if (this.current && this.current.pausedRemainingMs == null && Date.now() >= this.current.turnEndsAt) {
      this._advance();
      this.onChange();
    }
  }

  // Per-connection view: the shared queue state plus this socket's own status.
  snapshotFor(ws) {
    const now = Date.now();
    const currentMsLeft = this.current
      ? (this.current.pausedRemainingMs != null ? this.current.pausedRemainingMs : Math.max(0, this.current.turnEndsAt - now))
      : 0;

    const queue = {
      type: 'queue',
      current: this.current
        ? { id: this.current.id, username: this.current.username, msLeft: currentMsLeft, paused: this.current.pausedRemainingMs != null }
        : null,
      waiting: this.waiting.map((e, i) => ({ id: e.id, username: e.username, msLeft: currentMsLeft + i * TURN_MS })),
      adminFlying: !!this.overrideWs,
      turnMs: TURN_MS
    };

    let state = 'idle';
    let position = null;
    if (this.current && this.current.ws === ws) {
      state = 'flying';
    } else {
      const i = this.waiting.findIndex(e => e.ws === ws);
      if (i !== -1) { state = 'waiting'; position = i; }
    }

    const you = {
      type: 'you',
      state,
      canControl: this.isAuthorized(ws),
      isAdmin: !!ws.isAdmin,
      msLeft: state === 'waiting' ? currentMsLeft + position * TURN_MS : currentMsLeft,
      position: state === 'waiting' ? position + 1 : null
    };

    return { queue, you };
  }
}

module.exports = { FlightQueue, TURN_MS };

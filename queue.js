const TICK_MS      = 50;     // drain rate: 20 commands/sec
const KEEPALIVE_MS = 800;    // must stay under the firmware's 2000ms failsafe
const MAX_QUEUE    = 400;
const MAX_BUFFER   = 4096;   // device socket backpressure threshold

class CommandQueue {
  constructor(onDepthChange) {
    this.queue = [];
    this.device = null;
    this.lastSent = 0;
    this.onDepthChange = onDepthChange || (() => {});
    this.timer = setInterval(() => this.drain(), TICK_MS);
  }

  attach(ws) {
    // A reconnecting board can leave its previous socket half-open. Drop it,
    // so only one device socket is ever live.
    if (this.device && this.device !== ws) {
      try { this.device.terminate(); } catch (e) { /* already gone */ }
    }
    this.device = ws;
    this.lastSent = 0;
    this.queue.length = 0;
    this.onDepthChange(0);
  }

  // Pass the socket that closed. A stale socket closing after the board has
  // already reconnected must NOT detach the live one: that left the server
  // reporting the device online while silently dropping every command.
  detach(ws) {
    if (ws && this.device !== ws) return;
    this.device = null;
    this.queue.length = 0;
    this.onDepthChange(0);
  }

  hasDevice() {
    return !!this.device && this.device.readyState === 1;
  }

  push(cmd) {
    if (!this.device) return false;          // no device: drop, never bank stale commands
    if (this.queue.length >= MAX_QUEUE) return false;
    this.queue.push(cmd);
    this.onDepthChange(this.queue.length);
    return true;
  }

  urgent(cmd) {
    this.queue.length = 0;
    this.queue.push(cmd);
    this.onDepthChange(1);
  }

  drain() {
    const ws = this.device;
    if (!ws || ws.readyState !== 1) return;
    if (ws.bufferedAmount > MAX_BUFFER) return;

    const now = Date.now();

    if (this.queue.length) {
      ws.send(this.queue.shift());
      this.lastSent = now;
      this.onDepthChange(this.queue.length);
      return;
    }

    if (now - this.lastSent > KEEPALIVE_MS) {
      ws.send('ping');
      this.lastSent = now;
    }
  }
}

module.exports = { CommandQueue, TICK_MS };

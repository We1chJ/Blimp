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
    this.device = ws;
    this.lastSent = 0;
  }

  detach() {
    this.device = null;
    this.queue.length = 0;
    this.onDepthChange(0);
  }

  push(cmd) {
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

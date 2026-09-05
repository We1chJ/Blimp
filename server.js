const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { CommandQueue, TICK_MS } = require('./queue');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

const deviceWss = new WebSocketServer({ noServer: true });
const uiWss     = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = req.url.split('?')[0];
  const wss = url === '/device' ? deviceWss : url === '/ui' ? uiWss : null;
  if (!wss) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

function broadcastUi(obj) {
  const msg = JSON.stringify(obj);
  uiWss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

const cq = new CommandQueue(depth => {
  broadcastUi({ type: 'depth', depth, tickMs: TICK_MS });
});

function statusPayload() {
  return {
    type: 'status',
    deviceOnline: cq.hasDevice(),
    users: uiWss.clients.size
  };
}

// ---------- device ----------
deviceWss.on('connection', ws => {
  console.log('device connected');
  cq.attach(ws);
  broadcastUi(statusPayload());

  ws.on('message', raw => {
    broadcastUi({ type: 'state', data: raw.toString() });
  });

  ws.on('close', () => {
    console.log('device disconnected');
    cq.detach(ws);
    broadcastUi(statusPayload());
  });
});

// ---------- browsers ----------
const RATE = 15, BURST = 20;

function allow(ws) {
  const now = Date.now();
  ws.tokens = Math.min(BURST, (ws.tokens ?? BURST) + (now - (ws.last ?? now)) * RATE / 1000);
  ws.last = now;
  if (ws.tokens < 1) return false;
  ws.tokens -= 1;
  return true;
}

uiWss.on('connection', ws => {
  ws.send(JSON.stringify(statusPayload()));
  broadcastUi(statusPayload());

  ws.on('message', raw => {
    if (!allow(ws)) return;

    const cmd = raw.toString().trim().toLowerCase();

    if (cmd === 's' || cmd === 'stop') {
      cq.urgent('s');
      return;
    }

    // Combined form: "m <l> <r> <u>" - one message, all three applied at once.
    const mm = cmd.match(/^m\s+(-?\d{1,3})\s+(-?\d{1,3})\s+(-?\d{1,3})$/);
    if (mm) {
      const v = mm.slice(1, 4).map(x => Math.max(-100, Math.min(100, parseInt(x, 10))));
      cq.push(`m ${v[0]} ${v[1]} ${v[2]}`);
      return;
    }

    const m = cmd.match(/^([lru])\s*(-?\d{1,3})$/);
    if (m) {
      const value = Math.max(-100, Math.min(100, parseInt(m[2], 10)));
      cq.push(`${m[1]} ${value}`);
    }
  });

  ws.on('close', () => broadcastUi(statusPayload()));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('listening on ' + PORT));

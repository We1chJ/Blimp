const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { CommandQueue, TICK_MS } = require('./queue');
const { FlightQueue } = require('./flightQueue');
const Stripe = require('stripe');

const app = express();

// Donations. Both keys have to be present or the button stays hidden, so the
// blimp still runs for anyone who clones this without a Stripe account.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const DONATION_MIN = 100;      // $1
const DONATION_MAX = 50000;    // $500

app.use(express.json({ limit: '4kb' }));
// express skips dot-prefixed paths by default, which would 404 anything under
// /.well-known - ACME challenges, and the Apple Pay association file if Stripe
// ever falls back to asking us to host it.
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'allow' }));

app.get('/api/donate/config', (req, res) => {
  res.json({
    enabled: Boolean(stripe && PUBLISHABLE_KEY),
    publishableKey: PUBLISHABLE_KEY,
    min: DONATION_MIN,
    max: DONATION_MAX,
  });
});

// The amount is whatever the page asked for - it is the donor's own money, so
// the only thing worth enforcing is that it is a sane number of cents.
app.post('/api/donate/intent', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Donations are not set up yet.' });

  const amount = Math.round(Number(req.body && req.body.amount));
  if (!Number.isFinite(amount) || amount < DONATION_MIN || amount > DONATION_MAX) {
    return res.status(400).json({ error: 'Pick an amount between $1 and $500.' });
  }

  // the wallet supplies this; Stripe mails the receipt to it
  const email = typeof req.body.email === 'string' && req.body.email.includes('@')
    ? req.body.email.slice(0, 254)
    : undefined;

  try {
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      description: 'Donation to flyolin.lol',
      receipt_email: email,
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error('stripe: ' + err.message);
    res.status(502).json({ error: 'Could not reach Stripe. Try again in a moment.' });
  }
});

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

function broadcastQueue() {
  uiWss.clients.forEach(ws => {
    if (ws.readyState !== 1) return;
    const { queue, you } = fq.snapshotFor(ws);
    ws.send(JSON.stringify(queue));
    ws.send(JSON.stringify(you));
  });
}

const fq = new FlightQueue(broadcastQueue);
setInterval(() => fq.tick(), 250);
setInterval(broadcastQueue, 1000);

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
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
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

// A dead board (power loss, brownout) never sends a TCP FIN, so 'close'
// above would otherwise never fire. Ping it and kill the socket if it
// stops answering, so the UI's "online" status can't go stale.
const HEARTBEAT_MS = 1000;
setInterval(() => {
  deviceWss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

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

  const { queue, you } = fq.snapshotFor(ws);
  ws.send(JSON.stringify(queue));
  ws.send(JSON.stringify(you));

  ws.on('message', raw => {
    const text = raw.toString();

    let msg = null;
    try { msg = JSON.parse(text); } catch (e) { /* not JSON: a raw motor/stop command */ }

    if (msg && typeof msg.type === 'string') {
      switch (msg.type) {
        case 'join':
          fq.join(ws, msg.username);
          return;
        case 'leave':
          fq.leave(ws);
          return;
        case 'adminLogin': {
          const ok = fq.adminLogin(ws, msg.password);
          ws.send(JSON.stringify({ type: 'adminAuth', ok }));
          if (ok) broadcastQueue();
          return;
        }
        case 'adminRemove':
          fq.adminRemove(ws, msg.id);
          return;
        case 'adminTakeControl':
          fq.adminTakeControl(ws);
          return;
        case 'adminRelease':
          fq.adminReleaseControl(ws);
          return;
        default:
          return;
      }
    }

    // Legacy raw commands drive the motors directly: only the active pilot
    // (or the admin while overriding) may reach this, no matter what any
    // client's UI shows.
    if (!fq.isAuthorized(ws)) return;
    if (!allow(ws)) return;

    const cmd = text.trim().toLowerCase();

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

  ws.on('close', () => {
    fq.handleDisconnect(ws);
    broadcastUi(statusPayload());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('listening on ' + PORT));

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { CommandQueue, TICK_MS } = require('./queue');
const { FlightQueue } = require('./flightQueue');
const { clientIp, rateLimiter, safeEqual, sameOrigin } = require('./security');
const Stripe = require('stripe');

const app = express();

// Render (and Cloudflare in front of it) terminate TLS and forward the real
// client address in X-Forwarded-For. Without this every request looks like it
// came from the proxy, which would collapse all rate limiting into one bucket.
app.set('trust proxy', 1);

// Donations. Both keys have to be present or the button stays hidden, so the
// blimp still runs for anyone who clones this without a Stripe account.
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-08-27.basil' })
  : null;
const PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const DONATION_MIN = 100;      // $1
const DONATION_MAX = 50000;    // $500

// Creating a PaymentIntent costs nothing but is not free of consequence: an
// open endpoint lets anyone fill the Stripe dashboard with abandoned intents.
const donateLimit = rateLimiter({ burst: 5, perMinute: 5 });

// The page is one inline <script> and one inline <style>, so script-src and
// style-src need 'unsafe-inline' - a nonce or hash would disable it. That is
// tolerable here because nothing renders untrusted input as HTML (every sink
// is textContent), and the directives that actually matter against this app's
// risks still bite: frame-ancestors stops the donate flow being clickjacked,
// and connect/script/frame-src confine network reach to Stripe.
// The *.js.stripe.com wildcards are not optional decoration: Stripe.js starts
// its frames on sibling origins to load them in parallel, so omitting them
// makes the wallet buttons appear slowly or not at all. Link's domains are
// absent because Link is turned off in the element's paymentMethods.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://js.stripe.com https://*.js.stripe.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.stripe.com",
  "media-src 'self'",
  "connect-src 'self' ws: wss: https://api.stripe.com",
  "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(express.json({ limit: '4kb' }));
// express skips dot-prefixed paths by default, which would 404 anything under
// /.well-known - ACME challenges, and the Apple Pay association file if Stripe
// ever falls back to asking us to host it.
const CACHEABLE = /\.(mp4|jpg|jpeg|png|webp|svg|ico|woff2?)$/i;

app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'allow',
  extensions: ['html'],   // so /admin serves admin.html
  setHeaders(res, filePath) {
    // The page carries all the markup, CSS and JS, so it IS the deploy: it has
    // to revalidate every time or a cached copy keeps running old code against
    // a new API. The media beside it is immutable in practice.
    res.setHeader('Cache-Control', CACHEABLE.test(filePath)
      ? 'public, max-age=604800'
      : 'no-cache');
  },
}));

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
  if (!donateLimit(clientIp(req))) {
    return res.status(429).json({ error: 'Too many attempts. Wait a moment.' });
  }

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

// Without a shared secret, anything that can reach /device IS the device: it
// would be handed every motor command, could feed the UI arbitrary state, and
// - because CommandQueue.attach drops the previous socket so only one board is
// ever live - could knock the real blimp off the air just by connecting. The
// repository is public and the hostname is in the firmware, so the endpoint is
// not obscure. Fail closed: with no token configured, nothing may attach.
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || '';
if (!DEVICE_TOKEN) {
  console.warn('DEVICE_TOKEN is not set - /device will refuse every connection.');
}

function refuse(socket, status) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return refuse(socket, '400 Bad Request');
  }

  if (url.pathname === '/device') {
    const token = url.searchParams.get('token') || '';
    if (!DEVICE_TOKEN || !safeEqual(token, DEVICE_TOKEN)) {
      console.warn('device upgrade refused from ' + clientIp(req));
      return refuse(socket, '401 Unauthorized');
    }
    return deviceWss.handleUpgrade(req, socket, head, ws => deviceWss.emit('connection', ws, req));
  }

  if (url.pathname === '/ui') {
    if (!sameOrigin(req)) return refuse(socket, '403 Forbidden');
    return uiWss.handleUpgrade(req, socket, head, ws => uiWss.emit('connection', ws, req));
  }

  refuse(socket, '404 Not Found');
});

function broadcastUi(obj) {
  const msg = JSON.stringify(obj);
  uiWss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

const cq = new CommandQueue(depth => {
  broadcastUi({ type: 'depth', depth, tickMs: TICK_MS });
});

function broadcastQueue() {
  uiWss.clients.forEach(ws => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const { queue, you } = fq.snapshotFor(ws);
    ws.send(JSON.stringify(queue));
    ws.send(JSON.stringify(you));
  });
}

// Whenever control changes hands (turn timed out, pilot left or was removed,
// admin took over or let go), stop the motors. Otherwise the last command
// the old pilot sent keeps running: the keepalive pings stop the firmware's
// failsafe from ever tripping.
let lastController = null;
const fq = new FlightQueue(() => {
  const now = fq.controller();
  if (now !== lastController) {
    lastController = now;
    cq.urgent('s');
  }
  broadcastQueue();
});
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
const MAX_STATE_CHARS = 200;

deviceWss.on('connection', (ws, req) => {
  console.log('device connected');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  cq.attach(ws);
  broadcastUi(statusPayload());

  ws.on('message', raw => {
    // one short status line; the UI prints it verbatim
    broadcastUi({ type: 'state', data: raw.toString().slice(0, MAX_STATE_CHARS) });
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

uiWss.on('connection', (ws, req) => {
  ws.ip = clientIp(req);
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

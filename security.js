// Shared guards for the HTTP routes and the WebSocket upgrade.

const crypto = require('crypto');

// Compares two secrets without leaking their contents through timing. Hashing
// first gives both sides a fixed 32 bytes, which timingSafeEqual requires -
// comparing the raw strings would throw on a length mismatch and, in doing so,
// reveal the expected length.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Behind Render, and behind Cloudflare in front of it, the socket address is
// the proxy's. Cloudflare's own header is preferred where present because it
// cannot be spoofed by the client; X-Forwarded-For can be, so a determined
// attacker can still spread themselves across buckets. That is acceptable for
// throttling abuse but is not an authentication signal.
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

// Token bucket keyed by caller, with the idle keys swept periodically so a
// stream of one-shot callers cannot grow the map without bound.
function rateLimiter({ burst, perMinute, sweepMs = 600000 }) {
  const buckets = new Map();
  const ratePerMs = perMinute / 60000;

  const sweep = setInterval(() => {
    const cutoff = Date.now() - sweepMs;
    for (const [key, b] of buckets) if (b.last < cutoff) buckets.delete(key);
  }, sweepMs);
  sweep.unref();

  return function take(key) {
    const now = Date.now();
    const b = buckets.get(key) || { tokens: burst, last: now };
    b.tokens = Math.min(burst, b.tokens + (now - b.last) * ratePerMs);
    b.last = now;
    buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

// A browser always sends Origin on a WebSocket handshake, and it is the one
// header it cannot forge. Requiring it to match the host the page was served
// from stops a third-party site opening a socket and driving the blimp through
// a visitor's connection. Native clients (the board) send no Origin at all.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

module.exports = { safeEqual, clientIp, rateLimiter, sameOrigin };

// Socket and stick handling, shared by the flyer's page and the admin page.
//
// Both pages fly the blimp the same way, so this is the one copy of that code.
// A page supplies the markup (#padDrive, #padLift, #knobDrive, #knobLift, and
// optionally #dot / #statusText / #depth / #state), may define two hooks, and
// calls blimpStart() once its own handlers exist:
//
//   window.onBlimpMessage(msg)   - every frame from the server
//   window.blimpKeysBlocked()    - true while an overlay should swallow WASD
//
// and reads `latestQueue` / `latestYou`, or sends with send() / sendJson().

let latestQueue = { current: null, waiting: [], adminFlying: false, turnMs: 90000 };
let latestYou = { state: 'idle', canControl: false, isAdmin: false };

let ws;
let lastMsg = null;          // last "m l r u" transmitted
let deviceWasOnline = false;

function $(id) { return document.getElementById(id); }

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ui');

  ws.onopen = () => { if ($('statusText')) $('statusText').textContent = 'Connected'; };

  ws.onclose = () => {
    lastMsg = null;                       // board zeroes on drop, so resend
    if ($('dot')) $('dot').classList.remove('on');
    if ($('statusText')) $('statusText').textContent = 'Disconnected — reconnecting…';
    setTimeout(connect, 2000);
  };

  ws.onmessage = e => {
    const m = JSON.parse(e.data);

    if (m.type === 'status') {
      if ($('dot')) $('dot').classList.toggle('on', m.deviceOnline);
      if ($('statusText')) {
        $('statusText').textContent = (m.deviceOnline ? 'Blimp online' : 'Blimp offline')
          + ' · ' + m.users + (m.users === 1 ? ' person here' : ' people here');
      }

      // The board zeroes its speeds whenever it drops, but our socket stayed
      // up, so we still think the last command is in force and would send
      // nothing. Re-assert whatever the sticks currently say.
      if (m.deviceOnline && !deviceWasOnline) {
        lastMsg = null;
        dirty = true;
        flush();      // now, not on the next tick: background tabs throttle timers
      }
      deviceWasOnline = m.deviceOnline;
    }

    if (m.type === 'depth' && $('depth')) {
      const secs = (m.depth * m.tickMs / 1000).toFixed(1);
      $('depth').textContent = m.depth
        ? 'Command queue: ' + m.depth + ' (~' + secs + 's behind)'
        : 'Command queue: idle';
    }

    if (m.type === 'state' && $('state')) {
      $('state').textContent = 'Device state: ' + m.data;
    }

    if (m.type === 'queue') latestQueue = m;
    if (m.type === 'you') latestYou = m;

    if (typeof onBlimpMessage === 'function') onBlimpMessage(m);
  };
}

function send(text) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(text);
}
function sendJson(obj) { send(JSON.stringify(obj)); }

// ---------------- control state ----------------
// Every input funnels into these, all normalised to -1..1.
const drivePtr = { x: 0, y: 0 };     // pointer on the joystick
const driveKey = { x: 0, y: 0 };     // WASD
let liftPtr = 0, liftKey = 0;

let keyDrive = false, keyLift = false;   // is the keyboard steering right now?
let dirty = false;                       // sticks moved since the last send

function driveVec() { return keyDrive ? driveKey : drivePtr; }
function liftVal()  { return keyLift ? liftKey  : liftPtr;  }

// How much of the protocol's range full stick deflection asks for. The blimp
// flies indoors and drifts for a long time after a nudge, so the sticks are
// deliberately gentle: 1.0 here would be the old behaviour. Applied after the
// arcade mix so turning authority scales with everything else.
const STICK_POWER = 0.6;
// The lift slider gets its own: at the drive sticks' setting it couldn't
// climb fast enough, so it has the full range.
const LIFT_POWER = 1.0;

// Arcade mix: forward/back on Y, turn on X, scaled down if it would clip.
function motors() {
  const v = driveVec();
  const t = v.y * 100;
  const s = v.x * 100;
  let l = t + s, r = t - s;
  const peak = Math.max(Math.abs(l), Math.abs(r));
  if (peak > 100) { l = l * 100 / peak; r = r * 100 / peak; }
  return [
    Math.round(l * STICK_POWER),
    Math.round(r * STICK_POWER),
    Math.round(liftVal() * 100 * LIFT_POWER),
  ];
}

function paint() {
  const v = driveVec();
  const R = $('padDrive').clientWidth / 2 - 23;
  $('knobDrive').style.transform = 'translate(' + (v.x * R) + 'px,' + (-v.y * R) + 'px)';
  const H = $('padLift').clientHeight / 2 - 23;
  $('knobLift').style.transform = 'translate(0,' + (-liftVal() * H) + 'px)';
}

// Throttled transmit: the sticks move continuously, the link need not.
function flush() {
  if (!dirty) return;                    // idle: do not stomp on a manual send
  if (!latestYou.canControl) { dirty = false; return; }
  const msg = 'm ' + motors().join(' ');
  if (msg !== lastMsg) { lastMsg = msg; send(msg); }
  dirty = false;                         // stick state is on the wire; go quiet
}

function touched()  { dirty = true; paint(); }
function released() { dirty = true; paint(); flush(); }   // stop goes out at once

// ---------------- pointer handling ----------------
function bindPad(pad, onMove, onEnd) {
  let id = null;

  pad.addEventListener('pointerdown', e => {
    id = e.pointerId;
    pad.setPointerCapture(id);
    onMove(e);
    touched();
  });

  pad.addEventListener('pointermove', e => {
    if (e.pointerId !== id) return;
    onMove(e);
    touched();
  });

  const finish = e => {
    if (e.pointerId !== id) return;
    id = null;
    onEnd();
    released();
  };
  pad.addEventListener('pointerup', finish);
  pad.addEventListener('pointercancel', finish);
}

// ---------------- keyboard ----------------
const held = Object.create(null);

const DRIVE_KEYS = { w: [0, 1], s: [0, -1], a: [-1, 0], d: [1, 0] };
const LIFT_KEYS  = { arrowup: 1, arrowdown: -1 };

function recomputeKeys() {
  let x = 0, y = 0;
  for (const k in DRIVE_KEYS) {
    if (held[k]) { x += DRIVE_KEYS[k][0]; y += DRIVE_KEYS[k][1]; }
  }
  const d = Math.hypot(x, y);
  if (d > 1) { x /= d; y /= d; }          // diagonals stay inside the circle
  driveKey.x = x; driveKey.y = y;
  keyDrive = (x !== 0 || y !== 0);

  let u = 0;
  for (const k in LIFT_KEYS) if (held[k]) u += LIFT_KEYS[k];
  liftKey = Math.max(-1, Math.min(1, u));
  keyLift = (liftKey !== 0);
}

function keysBlocked(e) {
  if (typeof blimpKeysBlocked === 'function' && blimpKeysBlocked()) return true;
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
}

// Call once the page's own handlers are defined.
function blimpStart() {
  bindPad($('padDrive'), e => {
    const b = $('padDrive').getBoundingClientRect();
    let x = (e.clientX - b.left - b.width / 2) / (b.width / 2);
    let y = -(e.clientY - b.top - b.height / 2) / (b.height / 2);
    const d = Math.hypot(x, y);
    if (d > 1) { x /= d; y /= d; }          // clamp into the circle
    drivePtr.x = x; drivePtr.y = y;
    keyDrive = false;
  }, () => { drivePtr.x = 0; drivePtr.y = 0; });

  bindPad($('padLift'), e => {
    const b = $('padLift').getBoundingClientRect();
    const y = -(e.clientY - b.top - b.height / 2) / (b.height / 2);
    liftPtr = Math.max(-1, Math.min(1, y));
    keyLift = false;
  }, () => { liftPtr = 0; });

  addEventListener('keydown', e => {
    if (keysBlocked(e)) return;
    const k = e.key.toLowerCase();
    if (!(k in DRIVE_KEYS) && !(k in LIFT_KEYS)) return;
    e.preventDefault();
    if (held[k]) return;                    // ignore auto-repeat
    held[k] = true;
    recomputeKeys();
    touched();
  });

  // deliberately unguarded: releasing a key must always land, or it latches on
  addEventListener('keyup', e => {
    const k = e.key.toLowerCase();
    if (!(k in DRIVE_KEYS) && !(k in LIFT_KEYS)) return;
    e.preventDefault();
    held[k] = false;
    recomputeKeys();
    released();
  });

  // Losing focus mid-press would otherwise latch a key on forever.
  addEventListener('blur', () => {
    for (const k in held) held[k] = false;
    recomputeKeys();
    released();
  });

  setInterval(flush, 100);                 // 10/s, well under the server's limit
  paint();
  connect();
}

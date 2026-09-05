// XIAO ESP32C3 + 2x DRV8833 - blimp motor control
//
// Three motors:
//   left  + right  -> differential pair, forward/reverse and yaw
//   lift           -> bottom motor, altitude
//
// Commands (from the WebSocket server or the Serial Monitor at 115200,
// line ending = Newline):
//   l 75      -> left motor to 75%
//   r -30     -> right motor reverse at 30%
//   u 50      -> lift motor to 50%
//   40        -> both drive motors to 40% (lift unchanged)
//   s         -> stop everything
//   ?         -> print current speeds
//
// Six PWM pins, which is exactly the six LEDC channels the C3 has.
// All six are claimed during setup(), so nothing else can use PWM after boot.

#include <WiFi.h>
#include <WebSocketsClient.h>

// ---------- config ----------
const char* WIFI_SSID = "OLIN_VISITOR";
const char* WIFI_PASS = "";              // open network

const char* WS_HOST   = "blimp-wue5.onrender.com";  // no https://, no path
const int   WS_PORT   = 443;
const char* WS_PATH   = "/device";
const bool  WS_SECURE = true;

const unsigned long FAILSAFE_MS = 2000;   // stop if the link goes quiet
// ----------------------------

// DRV8833 #1 drives the differential pair. Pins carried over from the
// original two-motor bench sketch, so existing wiring still works.
const int LIN1 = D8, LIN2 = D7;   // left   (DRV8833 #1, channel A)
const int RIN1 = D1, RIN2 = D0;   // right  (DRV8833 #1, channel B)

// DRV8833 #2, channel A only. Channel B is unused - leave BIN1/BIN2 open.
const int UIN1 = D10, UIN2 = D9;  // lift   (DRV8833 #2, channel A)

int speedL = 0, speedR = 0, speedU = 0;   // -100 .. 100

WebSocketsClient webSocket;
unsigned long lastCommandMs = 0;
bool linkUp = false;

void setMotor(int in1, int in2, int percent) {
  percent = constrain(percent, -100, 100);
  int pwm = map(abs(percent), 0, 100, 0, 255);

  if (percent >= 0) {          // forward
    analogWrite(in1, pwm);
    analogWrite(in2, 0);
  } else {                     // reverse
    analogWrite(in1, 0);
    analogWrite(in2, pwm);
  }
}

void applySpeeds() {
  setMotor(LIN1, LIN2, speedL);
  setMotor(RIN1, RIN2, speedR);
  setMotor(UIN1, UIN2, speedU);

  Serial.printf("L=%d%%  R=%d%%  U=%d%%\n", speedL, speedR, speedU);

  if (linkUp) {
    char buf[64];
    snprintf(buf, sizeof(buf), "{\"l\":%d,\"r\":%d,\"u\":%d}", speedL, speedR, speedU);
    webSocket.sendTXT(buf);
  }
}

void stopAll() {
  speedL = speedR = speedU = 0;
  setMotor(LIN1, LIN2, 0);
  setMotor(RIN1, RIN2, 0);
  setMotor(UIN1, UIN2, 0);
}

void handleCommand(String cmd) {
  cmd.trim();
  cmd.toLowerCase();
  if (cmd.length() == 0) return;

  lastCommandMs = millis();

  if (cmd == "ping") return;              // keepalive only

  if (cmd == "s" || cmd == "stop") {
    speedL = speedR = speedU = 0;
    applySpeeds();
    return;
  }

  if (cmd == "?") {
    applySpeeds();
    return;
  }

  char which = cmd.charAt(0);
  if (which == 'l' || which == 'r' || which == 'u') {
    int value = constrain(cmd.substring(1).toInt(), -100, 100);   // "l 75" and "l75"
    if      (which == 'l') speedL = value;
    else if (which == 'r') speedR = value;
    else                   speedU = value;
    applySpeeds();
    return;
  }

  // Plain number: drive both differential motors, leave altitude alone.
  if (isDigit(which) || which == '-' || which == '+') {
    int value = constrain(cmd.toInt(), -100, 100);
    speedL = value;
    speedR = value;
    applySpeeds();
    return;
  }

  Serial.println("Unknown. Use: l 75 | r -30 | u 50 | 40 | s | ?");
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      linkUp = true;
      lastCommandMs = millis();
      Serial.println("[ws] connected");
      break;

    case WStype_DISCONNECTED:
      linkUp = false;
      Serial.println("[ws] disconnected");
      stopAll();
      break;

    case WStype_TEXT:
      handleCommand(String((char*)payload).substring(0, length));
      break;

    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);

  int pins[] = { LIN1, LIN2, RIN1, RIN2, UIN1, UIN2 };
  for (int i = 0; i < 6; i++) pinMode(pins[i], OUTPUT);
  stopAll();                       // claims all six LEDC channels up front

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.printf("\nIP: %s\n", WiFi.localIP().toString().c_str());

  if (WS_SECURE) webSocket.beginSSL(WS_HOST, WS_PORT, WS_PATH);
  else           webSocket.begin(WS_HOST, WS_PORT, WS_PATH);

  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(3000);
  webSocket.enableHeartbeat(10000, 3000, 2);

  Serial.println("Blimp ready. Type: l 75 | r -30 | u 50 | 40 | s | ?");
}

void loop() {
  webSocket.loop();

  if (Serial.available()) {
    handleCommand(Serial.readStringUntil('\n'));
  }

  if ((speedL || speedR || speedU) && millis() - lastCommandMs > FAILSAFE_MS) {
    Serial.println("Failsafe: link quiet, stopping.");
    stopAll();
  }
}

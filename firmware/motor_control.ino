// XIAO ESP32C3 + 2x DRV8833
// Three motors, commands from a cloud WebSocket server or the Serial Monitor

#include <WiFi.h>
#include <WebSocketsClient.h>

// ---------- config ----------
const char* WIFI_SSID = "your-ssid";
const char* WIFI_PASS = "your-password";

const char* WS_HOST   = "yourthing.onrender.com";   // no https://, no path
const int   WS_PORT   = 443;
const char* WS_PATH   = "/device";
const bool  WS_SECURE = true;

const unsigned long FAILSAFE_MS = 2000;   // stop if the link goes quiet
// ----------------------------

const int AIN1 = D0, AIN2 = D1;   // motor A  (DRV8833 #1, channel A)
const int BIN1 = D2, BIN2 = D3;   // motor B  (DRV8833 #1, channel B)
const int CIN1 = D4, CIN2 = D5;   // motor C  (DRV8833 #2, channel A)

int speedA = 0, speedB = 0, speedC = 0;   // -100 .. 100

WebSocketsClient webSocket;
unsigned long lastCommandMs = 0;
bool linkUp = false;

void setMotor(int in1, int in2, int percent) {
  percent = constrain(percent, -100, 100);
  int pwm = map(abs(percent), 0, 100, 0, 255);

  if (percent >= 0) {
    analogWrite(in1, pwm);
    analogWrite(in2, 0);
  } else {
    analogWrite(in1, 0);
    analogWrite(in2, pwm);
  }
}

void applySpeeds() {
  setMotor(AIN1, AIN2, speedA);
  setMotor(BIN1, BIN2, speedB);
  setMotor(CIN1, CIN2, speedC);

  Serial.printf("A=%d%% B=%d%% C=%d%%\n", speedA, speedB, speedC);

  if (linkUp) {
    char buf[64];
    snprintf(buf, sizeof(buf), "{\"a\":%d,\"b\":%d,\"c\":%d}", speedA, speedB, speedC);
    webSocket.sendTXT(buf);
  }
}

void stopAll() {
  speedA = speedB = speedC = 0;
  setMotor(AIN1, AIN2, 0);
  setMotor(BIN1, BIN2, 0);
  setMotor(CIN1, CIN2, 0);
}

void handleCommand(String cmd) {
  cmd.trim();
  cmd.toLowerCase();
  if (cmd.length() == 0) return;

  lastCommandMs = millis();

  if (cmd == "ping") return;              // keepalive only

  if (cmd == "s" || cmd == "stop") {
    speedA = speedB = speedC = 0;
    applySpeeds();
    return;
  }

  if (cmd == "?") {
    applySpeeds();
    return;
  }

  char which = cmd.charAt(0);
  if (which == 'a' || which == 'b' || which == 'c') {
    int value = constrain(cmd.substring(1).toInt(), -100, 100);
    if      (which == 'a') speedA = value;
    else if (which == 'b') speedB = value;
    else                   speedC = value;
    applySpeeds();
    return;
  }

  if (isDigit(which) || which == '-' || which == '+') {
    int value = constrain(cmd.toInt(), -100, 100);
    speedA = speedB = speedC = value;
    applySpeeds();
    return;
  }

  Serial.println("Unknown. Use: a 75 | b -30 | c 50 | 40 | s | ?");
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

  int pins[] = { AIN1, AIN2, BIN1, BIN2, CIN1, CIN2 };
  for (int i = 0; i < 6; i++) pinMode(pins[i], OUTPUT);
  stopAll();

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

  Serial.println("Ready.");
}

void loop() {
  webSocket.loop();

  if (Serial.available()) {
    handleCommand(Serial.readStringUntil('\n'));
  }

  if ((speedA || speedB || speedC) && millis() - lastCommandMs > FAILSAFE_MS) {
    Serial.println("Failsafe: link quiet, stopping.");
    stopAll();
  }
}

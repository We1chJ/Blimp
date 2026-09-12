// XIAO ESP32C3 - direct pin control test
//
// Drive any single GPIO (D0-D10) high or low over Serial (USB-C), no PWM,
// no WiFi, no motor logic. Use this to check wiring, enable/sleep lines,
// etc. in isolation.
//
// Commands (115200 baud, line ending = Newline):
//   d5 1     -> set D5 HIGH
//   d5 0     -> set D5 LOW
//   d5 ?     -> print D5's current state
//   ?        -> print every pin's current state

const int PIN_COUNT = 11;
const int pins[PIN_COUNT] = { D0, D1, D2, D3, D4, D5, D6, D7, D8, D9, D10 };
int state[PIN_COUNT] = { 0 };

void printAll() {
  for (int i = 0; i < PIN_COUNT; i++) {
    Serial.printf("D%d=%d  ", i, state[i]);
  }
  Serial.println();
}

void handleCommand(String cmd) {
  cmd.trim();
  cmd.toLowerCase();
  if (cmd.length() == 0) return;

  if (cmd == "?") {
    printAll();
    return;
  }

  int sp = cmd.indexOf(' ');
  if (cmd.charAt(0) != 'd' || sp < 0) {
    Serial.println("Unknown. Use: d5 1 | d5 0 | d5 ? | ?");
    return;
  }

  int n = cmd.substring(1, sp).toInt();
  if (n < 0 || n >= PIN_COUNT) {
    Serial.println("No such pin. Valid: D0..D10");
    return;
  }

  String arg = cmd.substring(sp + 1);
  arg.trim();

  if (arg == "?") {
    Serial.printf("D%d=%d\n", n, state[n]);
  } else if (arg == "1") {
    state[n] = 1;
    digitalWrite(pins[n], HIGH);
    Serial.printf("D%d=1\n", n);
  } else if (arg == "0") {
    state[n] = 0;
    digitalWrite(pins[n], LOW);
    Serial.printf("D%d=0\n", n);
  } else {
    Serial.println("Unknown. Use: d5 1 | d5 0 | d5 ? | ?");
  }
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < PIN_COUNT; i++) {
    pinMode(pins[i], OUTPUT);
    digitalWrite(pins[i], LOW);
  }
  delay(500);
  Serial.println("Pin control ready. Type: d5 1 | d5 0 | d5 ? | ?");
}

void loop() {
  if (Serial.available()) {
    handleCommand(Serial.readStringUntil('\n'));
  }
}

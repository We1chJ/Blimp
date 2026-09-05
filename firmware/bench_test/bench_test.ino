// XIAO ESP32C3 + 2x DRV8833 - bench test, no WiFi
//
// Three motors driven straight from the Serial Monitor. Same pins and same
// commands as motor_control.ino, minus the network. Use this to check wiring
// and motor direction without the server or WiFi in the picture.
//
// Commands (115200 baud, line ending = Newline):
//   l 75      -> left motor to 75%
//   r -30     -> right motor reverse at 30%
//   u 50      -> lift motor to 50%
//   40        -> both drive motors to 40% (lift unchanged)
//   s         -> stop everything
//   ?         -> print current speeds

// Command 100% drives the motors at this fraction of full power.
// Lower it to tame an over-powered blimp without touching the UI,
// the protocol, or anything else. 100 = full power.
const int SPEED_SCALE = 30;   // percent

const int LIN1 = D8, LIN2 = D7;   // left   (DRV8833 #1, channel A)
const int RIN1 = D1, RIN2 = D0;   // right  (DRV8833 #1, channel B)
const int UIN1 = D10, UIN2 = D9;   // lift   (DRV8833 #2, channel A)

int speedL = 0, speedR = 0, speedU = 0;   // -100 .. 100

void setMotor(int in1, int in2, int percent) {
  percent = constrain(percent, -100, 100);
  int pwm = map(abs(percent), 0, 100, 0, 255) * SPEED_SCALE / 100;

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
}

void handleCommand(String cmd) {
  cmd.trim();
  cmd.toLowerCase();
  if (cmd.length() == 0) return;

  if (cmd == "s" || cmd == "stop") {
    speedL = speedR = speedU = 0;
    applySpeeds();
    return;
  }

  if (cmd == "?") {
    applySpeeds();
    return;
  }

  // Combined: "m <left> <right> <lift>" sets all three in one message, so a
  // coordinated move lands atomically instead of arriving 50ms apart.
  if (cmd.charAt(0) == 'm') {
    int a, b, c;
    if (sscanf(cmd.c_str() + 1, "%d %d %d", &a, &b, &c) == 3) {
      speedL = constrain(a, -100, 100);
      speedR = constrain(b, -100, 100);
      speedU = constrain(c, -100, 100);
      applySpeeds();
    } else {
      Serial.println("Bad m command. Use: m 60 -60 20");
    }
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

  Serial.println("Unknown. Use: l 75 | r -30 | u 50 | m 60 -60 20 | 40 | s | ?");
}

void setup() {
  Serial.begin(115200);

  int pins[] = { LIN1, LIN2, RIN1, RIN2, UIN1, UIN2 };
  for (int i = 0; i < 6; i++) {
    pinMode(pins[i], OUTPUT);
    analogWrite(pins[i], 0);
  }

  delay(500);
  Serial.println("Three-motor bench test ready (no WiFi).");
  Serial.println("Type: l 75 | r -30 | u 50 | m 60 -60 20 | 40 | s | ?");
}

void loop() {
  if (Serial.available()) {
    handleCommand(Serial.readStringUntil('\n'));
  }
}

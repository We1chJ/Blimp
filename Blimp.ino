// XIAO ESP32C3 + DRV8833
// Two motors, speed set from the Serial Monitor
//
// Commands (115200 baud, line ending = Newline):
//   50        -> both motors to 50%
//   a 75      -> motor A to 75%
//   b 30      -> motor B to 30%
//   a -40     -> motor A reverse at 40%
//   s         -> stop both
//   ?         -> print current speeds

const int AIN1 = D0;   // Motor A
const int AIN2 = D1;
const int BIN1 = D2;   // Motor B
const int BIN2 = D3;

int speedA = 0;        // -100 .. 100
int speedB = 0;

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
  setMotor(AIN1, AIN2, speedA);
  setMotor(BIN1, BIN2, speedB);
  Serial.printf("A = %d%%   B = %d%%\n", speedA, speedB);
}

void handleCommand(String cmd) {
  cmd.trim();
  cmd.toLowerCase();
  if (cmd.length() == 0) return;

  if (cmd == "s" || cmd == "stop") {
    speedA = 0;
    speedB = 0;
    applySpeeds();
    return;
  }

  if (cmd == "?") {
    Serial.printf("A = %d%%   B = %d%%\n", speedA, speedB);
    return;
  }

  char which = cmd.charAt(0);
  if (which == 'a' || which == 'b') {
    int value = cmd.substring(1).toInt();   // works with "a 50" and "a50"
    if (which == 'a') speedA = constrain(value, -100, 100);
    else              speedB = constrain(value, -100, 100);
    applySpeeds();
    return;
  }

  // Plain number: set both motors
  if (isDigit(which) || which == '-' || which == '+') {
    int value = constrain(cmd.toInt(), -100, 100);
    speedA = value;
    speedB = value;
    applySpeeds();
    return;
  }

  Serial.println("Unknown command. Use: 50 | a 75 | b -30 | s | ?");
}

void setup() {
  Serial.begin(115200);

  pinMode(AIN1, OUTPUT);
  pinMode(AIN2, OUTPUT);
  pinMode(BIN1, OUTPUT);
  pinMode(BIN2, OUTPUT);

  analogWrite(AIN1, 0);
  analogWrite(AIN2, 0);
  analogWrite(BIN1, 0);
  analogWrite(BIN2, 0);

  delay(500);
  Serial.println("Two-motor control ready.");
  Serial.println("Type a percentage (0-100), or: a 75 | b 30 | a -40 | s | ?");
}

void loop() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    handleCommand(line);
  }
}
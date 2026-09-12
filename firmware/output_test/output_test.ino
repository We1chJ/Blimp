// XIAO ESP32C3 - drive each DRV8833 pair forward at full PWM, no WiFi
//
// Same three motor pairs as motor_control.ino. D10 (enable/sleep) is left
// alone - not touched here. Each pair: IN1 at 100% PWM / IN2 off for 1s,
// then both off for 1s, repeat.

const int LIN1 = D1, LIN2 = D2;   // left   (DRV8833 #1, channel A)
const int RIN1 = D3, RIN2 = D4;   // right  (DRV8833 #1, channel B)
const int UIN1 = D5, UIN2 = D6;   // lift   (DRV8833 #2, channel A)

void setup() {
  Serial.begin(115200);
  int pins[] = { LIN1, LIN2, RIN1, RIN2, UIN1, UIN2 };
  for (int i = 0; i < 6; i++) pinMode(pins[i], OUTPUT);

  pinMode(D10, OUTPUT);
  digitalWrite(D10, HIGH);
}

void loop() {
  analogWrite(LIN1, 255); analogWrite(LIN2, 0);
  analogWrite(RIN1, 255); analogWrite(RIN2, 0);
  analogWrite(UIN1, 255); analogWrite(UIN2, 0);
  Serial.println("ON");
  delay(1000);

  analogWrite(LIN1, 0); analogWrite(LIN2, 0);
  analogWrite(RIN1, 0); analogWrite(RIN2, 0);
  analogWrite(UIN1, 0); analogWrite(UIN2, 0);
  Serial.println("OFF");
  delay(1000);
}

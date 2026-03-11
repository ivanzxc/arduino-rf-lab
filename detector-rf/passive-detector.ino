const int PIN_RF = A0;

int suavizado = 0;

void setup() {
  Serial.begin(115200);
}

void loop() {
  int raw = analogRead(PIN_RF);
  suavizado = (suavizado * 8 + raw * 2) / 10;

  Serial.print("raw=");
  Serial.print(raw);
  Serial.print(" smooth=");
  Serial.println(suavizado);

  delay(20);
}
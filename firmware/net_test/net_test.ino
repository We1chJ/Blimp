// XIAO ESP32C3 - network reachability test. No motors, no WebSocket.
//
// WiFi is connecting but the WebSocket is not. This tells you which it is:
//   captive portal  -> the network intercepts traffic until you sign in
//   TLS problem     -> internet is clear but the secure handshake fails

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

const char* WIFI_SSID = "OLIN-VISITOR";
const char* WIFI_PASS = "";
const char* WS_HOST   = "blimp-wue5.onrender.com";

void startWifi() {
  if (strlen(WIFI_PASS) == 0) WiFi.begin(WIFI_SSID);
  else                        WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println("\n=== network reachability test ===");

  WiFi.mode(WIFI_STA);
  startWifi();
  Serial.print("WiFi");
  while (WiFi.status() != WL_CONNECTED) { delay(300); Serial.print("."); }
  Serial.printf("\nIP %s   gateway %s   RSSI %d dBm\n\n",
                WiFi.localIP().toString().c_str(),
                WiFi.gatewayIP().toString().c_str(), WiFi.RSSI());

  // ---- test 1: the standard captive-portal probe ----
  // A clear connection returns 204 with an empty body. A portal returns
  // 200 with a login page, or redirects you to one.
  Serial.println("[1] captive portal probe (expect HTTP 204, no body)");
  {
    HTTPClient http;
    http.setConnectTimeout(8000);
    http.begin("http://connectivitycheck.gstatic.com/generate_204");
    int code = http.GET();
    Serial.printf("    HTTP %d, %d bytes\n", code, http.getSize());
    if (code == 204) {
      Serial.println("    -> internet is CLEAR, no portal");
    } else if (code > 0) {
      Serial.println("    -> CAPTIVE PORTAL. The network is intercepting.");
      String body = http.getString();
      Serial.printf("    first bytes: %s\n", body.substring(0, 120).c_str());
    } else {
      Serial.printf("    -> request failed (%s)\n", http.errorToString(code).c_str());
    }
    http.end();
  }

  // ---- test 2: plain TCP to Render on 443 ----
  Serial.println("\n[2] raw TCP to the server on port 443");
  {
    WiFiClient plain;
    plain.setTimeout(8000);
    Serial.printf("    %s\n", plain.connect(WS_HOST, 443)
      ? "-> TCP reached the server" : "-> TCP BLOCKED, cannot even open the socket");
    plain.stop();
  }

  // ---- test 3: full TLS to Render ----
  Serial.println("\n[3] TLS handshake with the server");
  {
    WiFiClientSecure tls;
    tls.setInsecure();                 // same trust model beginSSL() uses
    tls.setTimeout(12000);
    if (tls.connect(WS_HOST, 443)) {
      Serial.println("    -> TLS OK. The WebSocket should work.");
      tls.printf("GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", WS_HOST);
      unsigned long t = millis();
      while (!tls.available() && millis() - t < 8000) delay(10);
      Serial.printf("    server said: %s\n", tls.readStringUntil('\n').c_str());
    } else {
      Serial.println("    -> TLS FAILED. Portal or filtering is breaking the handshake.");
    }
    tls.stop();
  }

  Serial.println("\n=== done ===");
  Serial.println("1 clear + 3 OK  -> network fine, problem is in the sketch");
  Serial.println("1 portal        -> sign in via a browser, or use a hotspot");
  Serial.println("2 blocked       -> outbound 443 is firewalled");
}

void loop() {}

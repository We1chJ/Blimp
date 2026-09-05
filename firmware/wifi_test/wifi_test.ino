// XIAO ESP32C3 - WiFi diagnostic. No motors, no WebSocket.
//
// Scans for networks, reports what it can actually see, then tries to join
// OLIN-VISITOR and prints the real reason if it fails.

#include <WiFi.h>

const char* WIFI_SSID = "OLIN-VISITOR";
const char* WIFI_PASS = "";        // open network

const char* authName(int t) {
  switch (t) {
    case WIFI_AUTH_OPEN:            return "OPEN";
    case WIFI_AUTH_WEP:             return "WEP";
    case WIFI_AUTH_WPA_PSK:         return "WPA";
    case WIFI_AUTH_WPA2_PSK:        return "WPA2";
    case WIFI_AUTH_WPA_WPA2_PSK:    return "WPA/WPA2";
    case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2-ENTERPRISE";
    case WIFI_AUTH_WPA3_PSK:        return "WPA3";
    case WIFI_AUTH_WPA2_WPA3_PSK:   return "WPA2/WPA3";
    default:                        return "?";
  }
}

const char* statusName(int s) {
  switch (s) {
    case WL_IDLE_STATUS:     return "IDLE";
    case WL_NO_SSID_AVAIL:   return "NO_SSID_AVAIL  <- SSID not seen on 2.4GHz";
    case WL_SCAN_COMPLETED:  return "SCAN_COMPLETED";
    case WL_CONNECTED:       return "CONNECTED";
    case WL_CONNECT_FAILED:  return "CONNECT_FAILED <- auth rejected";
    case WL_CONNECTION_LOST: return "CONNECTION_LOST";
    case WL_DISCONNECTED:    return "DISCONNECTED";
    default:                 return "UNKNOWN";
  }
}

void setup() {
  Serial.begin(115200);
  delay(1500);

  Serial.println("\n=== XIAO ESP32C3 WiFi diagnostic ===");
  Serial.printf("MAC: %s\n", WiFi.macAddress().c_str());
  Serial.println("NOTE: the C3 is 2.4GHz only. 5GHz networks are invisible to it.\n");

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(200);

  Serial.println("Scanning...");
  int n = WiFi.scanNetworks();
  Serial.printf("%d networks visible\n\n", n);

  bool found = false;
  for (int i = 0; i < n; i++) {
    bool isTarget = (WiFi.SSID(i) == WIFI_SSID);
    if (isTarget) found = true;
    Serial.printf("%s %-32s  %4d dBm  ch%-3d  %s\n",
                  isTarget ? "->" : "  ",
                  WiFi.SSID(i).c_str(), WiFi.RSSI(i),
                  WiFi.channel(i), authName(WiFi.encryptionType(i)));
  }

  Serial.println();
  if (!found) {
    Serial.printf("'%s' NOT FOUND in the scan.\n", WIFI_SSID);
    Serial.println("Causes, most likely first:");
    Serial.println("  1. External antenna not plugged into the U.FL connector");
    Serial.println("  2. The network is 5GHz-only");
    Serial.println("  3. SSID spelled differently than expected");
    Serial.println("If the list above is empty or all signals are very weak,");
    Serial.println("it is almost certainly the antenna.");
    return;
  }

  Serial.printf("'%s' found. Attempting to join for 20s...\n", WIFI_SSID);

  if (strlen(WIFI_PASS) == 0) WiFi.begin(WIFI_SSID);        // open network
  else                        WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start = millis();
  int last = -1;
  while (millis() - start < 20000) {
    int s = WiFi.status();
    if (s != last) {
      Serial.printf("  [%5lums] status %d = %s\n", millis() - start, s, statusName(s));
      last = s;
    }
    if (s == WL_CONNECTED) {
      Serial.printf("\nCONNECTED. IP %s   RSSI %d dBm   gateway %s\n",
                    WiFi.localIP().toString().c_str(), WiFi.RSSI(),
                    WiFi.gatewayIP().toString().c_str());
      Serial.println("WiFi is fine. If motor_control.ino still hangs at");
      Serial.println("'[ws] disconnected', that is the captive portal, not WiFi.");
      return;
    }
    delay(100);
  }

  Serial.printf("\nTIMEOUT. Final status %d = %s\n", WiFi.status(), statusName(WiFi.status()));
  Serial.println("Association failed even though the SSID is visible:");
  Serial.println("  - weak signal (RSSI worse than about -80 dBm)");
  Serial.println("  - the network requires MAC registration");
  Serial.println("  - it is actually WPA2-Enterprise, not open");
}

void loop() {}

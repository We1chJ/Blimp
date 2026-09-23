// Copy to secrets.h and fill in. secrets.h is gitignored so the board's
// credentials never reach the repository.
#pragma once

#define WIFI_SSID_VALUE "OLIN-VISITOR"
#define WIFI_PASS_VALUE ""              // empty for an open network

// Must match DEVICE_TOKEN in the server's environment. Without it the server
// refuses the /device upgrade, so the blimp will connect and get 401.
#define DEVICE_TOKEN_VALUE "change-me"

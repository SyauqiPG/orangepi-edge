#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>

// ========================
// User Configuration
// ========================
const char *WIFI_SSID = "YOUR_WIFI_SSID";
const char *WIFI_PASS = "YOUR_WIFI_PASSWORD";

const char *SERVER_HOST = "YOUR_SERVER_HOST_OR_IP";
const uint16_t SERVER_PORT = 4000;
const char *SERVER_PATH = "/api/v1/device/upload";

// Set true if your endpoint is HTTPS.
const bool USE_HTTPS = false;
// Only used when USE_HTTPS = true.
const bool ALLOW_INSECURE_TLS = true;

const char *DEVICE_KEY = "change-me";
const char *DEVICE_ID = "esp32cam-01";

const unsigned long UPLOAD_INTERVAL_MS = 15000;
const unsigned long MAX_BACKOFF_MS = 120000;
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 20000;
const unsigned long RESPONSE_TIMEOUT_MS = 15000;

// ========================
// AI Thinker ESP32-CAM Pins
// ========================
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

unsigned long nextUploadAtMs = 0;
uint8_t failureStreak = 0;

bool timeReached(unsigned long targetMs) {
  return (long)(millis() - targetMs) >= 0;
}

bool connectWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  Serial.print("WiFi connecting to ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - started > WIFI_CONNECT_TIMEOUT_MS) {
      Serial.println("WiFi connect timeout");
      return false;
    }
    delay(300);
    Serial.print(".");
  }

  Serial.println();
  Serial.print("WiFi connected. IP: ");
  Serial.println(WiFi.localIP());
  return true;
}

void syncClock() {
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  unsigned long started = millis();
  time_t now = time(nullptr);

  while (now < 24 * 3600) {
    if (millis() - started > 15000) {
      Serial.println("NTP sync timeout, using fallback timestamp");
      return;
    }
    delay(300);
    now = time(nullptr);
  }

  Serial.println("NTP sync OK");
}

void buildIso8601(char *out, size_t outSize) {
  time_t now = time(nullptr);
  if (now < 24 * 3600) {
    snprintf(out, outSize, "1970-01-01T00:00:00Z");
    return;
  }

  struct tm tmUtc;
  gmtime_r(&now, &tmUtc);
  strftime(out, outSize, "%Y-%m-%dT%H:%M:%SZ", &tmUtc);
}

bool initCamera() {
  camera_config_t cfg;
  cfg.ledc_channel = LEDC_CHANNEL_0;
  cfg.ledc_timer = LEDC_TIMER_0;
  cfg.pin_d0 = Y2_GPIO_NUM;
  cfg.pin_d1 = Y3_GPIO_NUM;
  cfg.pin_d2 = Y4_GPIO_NUM;
  cfg.pin_d3 = Y5_GPIO_NUM;
  cfg.pin_d4 = Y6_GPIO_NUM;
  cfg.pin_d5 = Y7_GPIO_NUM;
  cfg.pin_d6 = Y8_GPIO_NUM;
  cfg.pin_d7 = Y9_GPIO_NUM;
  cfg.pin_xclk = XCLK_GPIO_NUM;
  cfg.pin_pclk = PCLK_GPIO_NUM;
  cfg.pin_vsync = VSYNC_GPIO_NUM;
  cfg.pin_href = HREF_GPIO_NUM;
  cfg.pin_sccb_sda = SIOD_GPIO_NUM;
  cfg.pin_sccb_scl = SIOC_GPIO_NUM;
  cfg.pin_pwdn = PWDN_GPIO_NUM;
  cfg.pin_reset = RESET_GPIO_NUM;
  cfg.xclk_freq_hz = 20000000;
  cfg.pixel_format = PIXFORMAT_JPEG;
  cfg.frame_size = psramFound() ? FRAMESIZE_VGA : FRAMESIZE_QVGA;
  cfg.jpeg_quality = psramFound() ? 12 : 15;
  cfg.fb_count = psramFound() ? 2 : 1;

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return false;
  }

  return true;
}

int parseStatusCode(const String &statusLine) {
  int firstSpace = statusLine.indexOf(' ');
  if (firstSpace < 0) {
    return 0;
  }

  int secondSpace = statusLine.indexOf(' ', firstSpace + 1);
  String code = secondSpace > firstSpace
                  ? statusLine.substring(firstSpace + 1, secondSpace)
                  : statusLine.substring(firstSpace + 1);
  return code.toInt();
}

template <typename TClient>
int sendMultipart(TClient &client, camera_fb_t *fb) {
  char capturedAt[32];
  buildIso8601(capturedAt, sizeof(capturedAt));

  String boundary = "----esp32cam";
  boundary += String((uint32_t)esp_random(), HEX);

  String partDevice =
    "--" + boundary + "\r\n"
    "Content-Disposition: form-data; name=\"device_id\"\r\n\r\n" +
    String(DEVICE_ID) + "\r\n";

  String partCaptured =
    "--" + boundary + "\r\n"
    "Content-Disposition: form-data; name=\"captured_at\"\r\n\r\n" +
    String(capturedAt) + "\r\n";

  String partImageHeader =
    "--" + boundary + "\r\n"
    "Content-Disposition: form-data; name=\"image\"; filename=\"frame.jpg\"\r\n"
    "Content-Type: image/jpeg\r\n\r\n";

  String tail = "\r\n--" + boundary + "--\r\n";

  size_t contentLength =
    partDevice.length() + partCaptured.length() + partImageHeader.length() + fb->len + tail.length();

  client.setTimeout(RESPONSE_TIMEOUT_MS);

  client.print("POST ");
  client.print(SERVER_PATH);
  client.println(" HTTP/1.1");
  client.print("Host: ");
  client.print(SERVER_HOST);
  client.print(":");
  client.println(SERVER_PORT);
  client.println("Connection: close");
  client.print("x-device-key: ");
  client.println(DEVICE_KEY);
  client.print("x-device-id: ");
  client.println(DEVICE_ID);
  client.print("Content-Type: multipart/form-data; boundary=");
  client.println(boundary);
  client.print("Content-Length: ");
  client.println(contentLength);
  client.println();

  client.print(partDevice);
  client.print(partCaptured);
  client.print(partImageHeader);

  size_t written = client.write(fb->buf, fb->len);
  if (written != fb->len) {
    Serial.println("Write image payload failed");
    return 0;
  }

  client.print(tail);

  unsigned long started = millis();
  while (!client.available()) {
    if (millis() - started > RESPONSE_TIMEOUT_MS) {
      Serial.println("Response timeout");
      return 0;
    }

    if (!client.connected()) {
      break;
    }
    delay(10);
  }

  if (!client.available()) {
    return 0;
  }

  String statusLine = client.readStringUntil('\n');
  statusLine.trim();
  int statusCode = parseStatusCode(statusLine);
  Serial.print("HTTP status: ");
  Serial.println(statusCode);
  return statusCode;
}

int uploadFrameOnce() {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Camera capture failed");
    return 0;
  }

  int statusCode = 0;

  if (USE_HTTPS) {
    WiFiClientSecure client;
    if (ALLOW_INSECURE_TLS) {
      client.setInsecure();
    }

    if (!client.connect(SERVER_HOST, SERVER_PORT)) {
      Serial.println("TLS connect failed");
      esp_camera_fb_return(fb);
      return 0;
    }

    statusCode = sendMultipart(client, fb);
    client.stop();
  } else {
    WiFiClient client;
    if (!client.connect(SERVER_HOST, SERVER_PORT)) {
      Serial.println("TCP connect failed");
      esp_camera_fb_return(fb);
      return 0;
    }

    statusCode = sendMultipart(client, fb);
    client.stop();
  }

  esp_camera_fb_return(fb);
  return statusCode;
}

unsigned long computeNextDelayMs() {
  unsigned long delayMs = UPLOAD_INTERVAL_MS;
  for (uint8_t i = 0; i < failureStreak; i++) {
    if (delayMs >= MAX_BACKOFF_MS / 2) {
      delayMs = MAX_BACKOFF_MS;
      break;
    }
    delayMs *= 2;
  }
  return delayMs;
}

void scheduleNextAttempt() {
  nextUploadAtMs = millis() + computeNextDelayMs();
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("Booting ESP32-CAM uploader");

  if (!initCamera()) {
    while (true) {
      delay(1000);
    }
  }

  connectWifi();
  syncClock();
  nextUploadAtMs = millis() + 3000;
}

void loop() {
  if (!timeReached(nextUploadAtMs)) {
    delay(50);
    return;
  }

  if (!connectWifi()) {
    if (failureStreak < 6) {
      failureStreak += 1;
    }
    scheduleNextAttempt();
    return;
  }

  int statusCode = uploadFrameOnce();
  bool ok = statusCode >= 200 && statusCode < 300;

  if (ok) {
    failureStreak = 0;
    Serial.println("UPLOAD_OK");
  } else {
    if (failureStreak < 6) {
      failureStreak += 1;
    }
    Serial.println("UPLOAD_FAIL");
  }

  scheduleNextAttempt();
}
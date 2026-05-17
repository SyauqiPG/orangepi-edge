# Orange Pi Edge Runtime

This service is the production starting point for Orange Pi Zero 3 (4GB) with ESP32-CAM capture, MobileNetV4 inference, and GPIO-relay watering control.

## Goals

- Keep API contract parity with `mock-API` for HMI compatibility.
- Pull still images from ESP32-CAM `/capture` and keep upload fallback support.
- Support real model inference via ONNX Runtime with `mobilenetv4-model.onnx`.
- Run automatic image capture, retention cleanup, and daily watering policy on the Orange Pi.

## Current Status

- API parity endpoints are implemented:
  - `GET /api/v1/health`
  - `GET /api/v1/snapshot`
  - `PUT /api/v1/mode`
  - `PUT /api/v1/status`
  - `POST /api/v1/watering/manual`
  - `GET /api/v1/logs?limit=100`
  - `DELETE /api/v1/logs`
  - `POST /api/v1/control/tick`
- New edge ingestion endpoint is available:
  - `POST /api/v1/camera/snap` (backend pulls `${ESP32_CAM_BASE_URL}/capture`)
  - `POST /api/v1/device/upload` (multipart form field `image`)
- Watering production endpoints are available:
  - `GET /api/v1/watering/schedule`
  - `PUT /api/v1/watering/schedule` with `{ "auto_watering_time": "HH:MM" }`
  - `GET /api/v1/inference/history?limit=100`
  - `GET /api/v1/watering/history?limit=100`
- ONNX runtime inference path is implemented:
  - Provider: `MODEL_PROVIDER=onnx`
  - Model file: `./models/mobilenetv4-model.onnx`
  - Class mapping: index `0` -> `rain_unlikely` (no rain), index `1` -> `rain_likely` (rain)

## Quick Start

1. Install dependencies.

```bash
npm install
```

2. Create `.env` from `env.example` and set values.

3. Start service.

```bash
npm run dev
```

Service default URL: `http://localhost:4000`

## Environment Variables

See `env.example`.

Important:

- `DEVICE_UPLOAD_KEY` secures ESP32-CAM upload route via `x-device-key` header.
- `ESP32_CAM_BASE_URL` points to the ESP32-CAM capture server, for example `http://192.168.1.100`.
- `PUMP_DRY_RUN=true` keeps watering commands in dry-run mode. Set it to `false` and provide `PUMP_ON_COMMAND` / `PUMP_OFF_COMMAND` for the GPIO relay.
- `MODEL_PROVIDER=onnx` uses direct ONNX Runtime inference.
- If ONNX loading or execution fails and `ONNX_FALLBACK_TO_MOCK=true`, service falls back to simulated inference.

## ONNX Model Setup

1. Place your model file at `models/mobilenetv4-model.onnx`.
2. Ensure `.env` contains:

```env
MODEL_PROVIDER=onnx
ONNX_MODEL_PATH=./models/mobilenetv4-model.onnx
ONNX_INDEX_NO_RAIN=0
ONNX_INDEX_RAIN=1
```

3. Start the service and check startup logs for model load confirmation.

## ESP32-CAM Pull Capture

Flash `src/esp32cam/esp32cam.ino` to the AI Thinker ESP32-CAM. Arduino CLI requires the `.ino` filename to match its folder name, so the sketch directory is `src/esp32cam`.

- `GET /status`
- `GET /capture`
- `GET /stream`

### Flash With Arduino CLI

Install Arduino CLI, then install the ESP32 board package:

```bash
arduino-cli config init
arduino-cli config add board_manager.additional_urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32
```

Edit Wi-Fi credentials in `src/esp32cam/esp32cam.ino`:

```cpp
const char *WIFI_SSID = "YOUR_WIFI_SSID";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
```

Find the serial port:

```bash
arduino-cli board list
```

Put the ESP32-CAM into flash mode:

1. Connect `IO0` to `GND`.
2. Press `RST`.
3. Keep `IO0` connected while uploading.

Compile and upload. Replace `COM5` with your port, for example `/dev/ttyUSB0` on Linux:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32cam src/esp32cam
arduino-cli upload -p COM5 --fqbn esp32:esp32:esp32cam src/esp32cam
```

If upload gets stuck at `Connecting...`, press `RST` once while the upload command is still running. If high-speed upload is unreliable, retry with a slower upload speed:

```bash
arduino-cli upload -p COM5 --fqbn esp32:esp32:esp32cam --upload-property upload.speed=115200 src/esp32cam
```

After upload completes:

1. Disconnect `IO0` from `GND`.
2. Press `RST`.
3. Open the serial monitor:

```bash
arduino-cli monitor -p COM5 -c baudrate=115200

or

arduino-cli monitor -p COM9 -c baudrate=115200 --config dtr=off --config rts=off
```

Copy the printed URL, for example `http://192.168.1.100`.

Set the printed camera URL in `.env`:

```env
ESP32_CAM_BASE_URL=http://192.168.1.100
```

Then trigger one backend capture and analysis:

```bash
curl -X POST http://localhost:4000/api/v1/camera/snap
```

The scheduler also pulls from `/capture` every 10 minutes during local hours 08:00-16:00.

## Upload Fallback (HTTP multipart)

- Endpoint: `POST /api/v1/device/upload`
- Headers:
  - `x-device-key: <DEVICE_UPLOAD_KEY>`
  - optional `x-device-id: esp32cam-01`
- Form data:
  - `image`: binary image file
  - optional `captured_at`: ISO timestamp
  - optional `device_id`: overrides header ID

Example with curl:

```bash
curl -X POST http://localhost:4000/api/v1/device/upload \
  -H "x-device-key: change-me" \
  -H "x-device-id: esp32cam-01" \
  -F "image=@./sample.jpg" \
  -F "captured_at=2026-04-18T09:20:00.000Z"
```

## Class Mapping

- Index `0` (no rain) maps to API label `rain_unlikely`.
- Index `1` (rain) maps to API label `rain_likely`.

The API response schema remains unchanged to match `mock-API` compatibility.

## Docker

```bash
docker compose up -d --build
```

## Notes

- Uploaded images are served from `/uploads/<filename>`.
- Uploaded images and inference rows older than `IMAGE_RETENTION_DAYS` are removed automatically.
- Automatic watering runs once daily at `auto_watering_time` and skips when any `rain_likely` inference exists since local midnight.
- SQLite tables maintain mock parity for `system_state`, `inference_snapshots`, and `watering_logs`.
- Additional table `image_uploads` tracks ESP32-CAM uploads.

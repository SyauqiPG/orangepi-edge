# Orange Pi Edge Runtime

This service is the production starting point for Orange Pi Zero 3 (4GB) with ESP32-CAM image upload and MobileNetV4 inference.

## Goals

- Keep API contract parity with `mock-API` for HMI compatibility.
- Add edge-only upload endpoint for ESP32-CAM frames.
- Support real model inference via ONNX Runtime with `mobilenetv4-model.onnx`.

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
  - `POST /api/v1/device/upload` (multipart form field `image`)
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

## Upload From ESP32-CAM (HTTP multipart)

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
- SQLite tables maintain mock parity for `system_state`, `inference_snapshots`, and `watering_logs`.
- Additional table `image_uploads` tracks ESP32-CAM uploads.

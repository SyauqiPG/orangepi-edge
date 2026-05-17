Absolutely. The intended wiring is:

`ESP32-CAM` serves images on Wi-Fi → `Orange Pi backend` pulls `/capture` → backend saves + analyzes + exposes API → `Frontend` talks only to Orange Pi backend.

## 1. Put ESP32-CAM And Orange Pi On Same Network

Make sure both devices are on the same Wi-Fi/LAN.

On the Orange Pi, you should eventually be able to reach the ESP32-CAM like:

```bash
curl http://ESP32_IP/status
curl -o test.jpg http://ESP32_IP/capture
```

Example:

```bash
curl http://192.168.1.100/status
curl -o test.jpg http://192.168.1.100/capture
```

If this works, the Orange Pi can see the camera.

## 2. Flash The ESP32-CAM Firmware

Use the firmware in:

```text
orangepi-edge/src/esp32cam.ino
```

Edit these lines before flashing:

```cpp
const char *WIFI_SSID = "YOUR_WIFI_SSID";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
```

Flash it with Arduino IDE or PlatformIO.

After boot, open Serial Monitor at `115200`. You should see something like:

```text
Camera ready at http://192.168.1.100
```

That IP is your `ESP32_CAM_BASE_URL`.

The ESP32-CAM exposes:

```text
GET /status
GET /capture
GET /stream
```

## 3. Configure Orange Pi Backend

On the Orange Pi, in the `orangepi-edge` repo:

```bash
cd /path/to/orangepi-edge
cp env.example .env
nano .env
```

Set at least these:

```env
PORT=4000
ESP32_CAM_BASE_URL=http://192.168.1.100
APP_TIMEZONE=Asia/Jakarta

MODEL_PROVIDER=onnx
ONNX_MODEL_PATH=./models/mobilenetv4-model.onnx

PUMP_DRY_RUN=true
```

Keep this during testing:

```env
PUMP_DRY_RUN=true
```

Only set it to `false` after relay wiring is confirmed.

For real relay commands later:

```env
PUMP_DRY_RUN=false
PUMP_ON_COMMAND=your_gpio_on_command
PUMP_OFF_COMMAND=your_gpio_off_command
WATERING_DURATION_MS=5000
```

## 4. Start Backend On Orange Pi

Install and run:

```bash
npm install
npm run dev
```

Or production:

```bash
npm start
```

Check backend health:

```bash
curl http://ORANGE_PI_IP:4000/api/v1/health
```

From your laptop/browser, use the Orange Pi IP, for example:

```bash
curl http://192.168.1.50:4000/api/v1/health
```

## 5. Test Manual Camera Snap Through Backend

This is the important integration test:

```bash
curl -X POST http://ORANGE_PI_IP:4000/api/v1/camera/snap
```

Expected: JSON response with:

```json
{
  "ok": true,
  "image_path": "/uploads/...",
  "snapshot": {
    "prediction_label": "...",
    "prediction_confidence": ...
  }
}
```

Then open the image in browser:

```text
http://ORANGE_PI_IP:4000/uploads/filename.jpg
```

If this works, Orange Pi is successfully pulling from ESP32-CAM and making the image discoverable.

## 6. Point Frontend To Orange Pi Backend

In the HMI repo:

```bash
cd C:\ARF\my-repos\ta-coqi\TA_HMI_TA
```

Create/edit `.env.local`:

```env
NEXT_PUBLIC_MOCK_API_BASE_URL=http://ORANGE_PI_IP:4000
```

Example:

```env
NEXT_PUBLIC_MOCK_API_BASE_URL=http://192.168.1.50:4000
```

Then run:

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

The frontend should now show data from the Orange Pi backend.

## 7. Useful Frontend-Visible Endpoints

The frontend reads these from Orange Pi:

```text
GET  /api/v1/snapshot
POST /api/v1/camera/snap
GET  /api/v1/watering/schedule
PUT  /api/v1/watering/schedule
POST /api/v1/watering/manual
GET  /api/v1/inference/history
GET  /api/v1/watering/history
```

So the frontend does **not** need to know the ESP32-CAM IP. Only the Orange Pi needs `ESP32_CAM_BASE_URL`.

## 8. Network Checklist

If frontend cannot see images/data:

1. Confirm backend is reachable from your browser:

```text
http://ORANGE_PI_IP:4000/api/v1/health
```

2. Confirm Orange Pi can reach camera:

```bash
curl http://ESP32_IP/status
curl -o test.jpg http://ESP32_IP/capture
```

3. Confirm backend can snap:

```bash
curl -X POST http://ORANGE_PI_IP:4000/api/v1/camera/snap
```

4. Confirm frontend env uses Orange Pi IP, not `localhost`, unless frontend runs on the Orange Pi itself.
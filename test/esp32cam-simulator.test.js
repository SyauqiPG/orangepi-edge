"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const sharp = require("sharp")
const { createServer } = require("../src/server")

const {
  createEsp32CamSimulator,
  formatTimestamp,
} = require("../src/esp32cam/simulator")

test("formats simulator timestamps in the requested timezone and layout", () => {
  const date = new Date("2026-06-20T17:23:45.067Z")
  assert.equal(formatTimestamp(date, "Asia/Jakarta"), "21/06/2026 - 00:23:45.067")
})

test("simulator provides ESP32-CAM status, capture, stream, and OPTIONS parity", async (t) => {
  const simulator = createEsp32CamSimulator({ port: 0, timeZone: "Asia/Jakarta" })
  const server = await simulator.start()
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  t.after(() => simulator.close())

  const statusResponse = await fetch(`${baseUrl}/status`)
  assert.equal(statusResponse.status, 200)
  assert.equal(statusResponse.headers.get("access-control-allow-origin"), "*")
  assert.deepEqual(await statusResponse.json(), {
    ok: true,
    ip: "127.0.0.1",
    ssid: "ESP32-CAM Simulator",
    wifi: "-42 dBm",
    framesize: "VGA",
    quality: 10,
  })

  const captureResponse = await fetch(`${baseUrl}/capture`)
  const capture = Buffer.from(await captureResponse.arrayBuffer())
  const metadata = await sharp(capture).metadata()
  assert.equal(captureResponse.headers.get("content-type"), "image/jpeg")
  assert.equal(metadata.format, "jpeg")
  assert.equal(metadata.width, 640)
  assert.equal(metadata.height, 480)

  const optionsResponse = await fetch(`${baseUrl}/anything`, { method: "OPTIONS" })
  assert.equal(optionsResponse.status, 200)
  assert.equal(optionsResponse.headers.get("access-control-allow-methods"), "GET, OPTIONS")

  const streamController = new AbortController()
  const streamResponse = await fetch(`${baseUrl}/stream`, { signal: streamController.signal })
  const reader = streamResponse.body.getReader()
  const firstChunk = await reader.read()
  streamController.abort()
  assert.match(streamResponse.headers.get("content-type"), /multipart\/x-mixed-replace;boundary=frame/)
  assert.match(Buffer.from(firstChunk.value).toString("latin1"), /Content-Type: image\/jpeg/)
})

test("enabled simulator is used by the edge camera capture endpoint", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orangepi-edge-camera-simulator-"))
  const runtime = createServer({
    PORT: 0,
    DB_PATH: path.join(tempRoot, "test.db"),
    IMAGE_UPLOAD_DIR: path.join(tempRoot, "uploads"),
    SNAPSHOT_IMAGE_BASE_PATH: "/uploads",
    MODEL_PROVIDER: "onnx",
    ESP32_CAM_SIMULATOR: true,
    ESP32_CAM_SIMULATOR_PORT: 0,
  })
  const edgeServer = await runtime.startServer()
  const edgeAddress = edgeServer.address()

  t.after(async () => {
    await new Promise((resolve) => edgeServer.close(resolve))
    await runtime.closeDatabase()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  assert.match(runtime.config.ESP32_CAM_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/)
  const response = await fetch(`http://127.0.0.1:${edgeAddress.port}/api/v1/camera/snap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
  const result = await response.json()

  assert.equal(response.status, 201)
  assert.equal(result.ok, true)
  const savedImage = path.join(tempRoot, result.image_path.replace(/^\/uploads\//, "uploads/"))
  const metadata = await sharp(savedImage).metadata()
  assert.equal(metadata.format, "jpeg")
  assert.equal(metadata.width, 640)
  assert.equal(metadata.height, 480)
})

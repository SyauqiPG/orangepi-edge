"use strict"

const assert = require("node:assert/strict")
const fs = require("fs")
const http = require("http")
const os = require("os")
const path = require("path")
const test = require("node:test")
const request = require("supertest")
const sqlite3 = require("sqlite3").verbose()

const {
  createServer,
  isWithinDaylightWindow,
} = require("../src/server")

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9])

function createRuntime(configOverrides = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orangepi-edge-hw-test-"))
  const runtime = createServer({
    DB_PATH: path.join(tempRoot, "orangepi-edge-test.db"),
    IMAGE_UPLOAD_DIR: path.join(tempRoot, "uploads"),
    SNAPSHOT_IMAGE_BASE_PATH: "/uploads",
    DEVICE_UPLOAD_KEY: "test-device-key",
    CORS_ORIGIN: "*",
    MODEL_PROVIDER: "mock",
    PUMP_DRY_RUN: true,
    APP_TIMEZONE: "Asia/Jakarta",
    ...configOverrides,
  })

  return {
    runtime,
    tempRoot,
  }
}

async function cleanup(runtime, tempRoot, server = null) {
  if (server) {
    await new Promise((resolve) => server.close(resolve))
  }
  await runtime.closeDatabase()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

function startCameraServer(handler) {
  let captures = 0
  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith("/capture")) {
      captures += 1
      handler(req, res)
      return
    }

    res.writeHead(404).end()
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        getCaptures: () => captures,
      })
    })
  })
}

function sqliteRun(dbPath, sql, params = []) {
  const db = new sqlite3.Database(dbPath)
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      db.close()
      if (error) {
        reject(error)
        return
      }

      resolve(this)
    })
  })
}

test("POST /api/v1/camera/snap pulls image from ESP32-CAM and analyzes it", async (t) => {
  const camera = await startCameraServer((req, res) => {
    res.writeHead(200, { "content-type": "image/jpeg" })
    res.end(JPEG_BYTES)
  })
  const { runtime, tempRoot } = createRuntime({ ESP32_CAM_BASE_URL: camera.baseUrl })
  t.after(async () => {
    await cleanup(runtime, tempRoot, camera.server)
  })

  await runtime.ensureInitialized()
  const response = await request(runtime.app).post("/api/v1/camera/snap").expect(201)

  assert.equal(response.body.ok, true)
  assert.equal(camera.getCaptures(), 1)
  assert.equal(typeof response.body.image_path, "string")
  assert.equal(typeof response.body.snapshot.prediction_confidence, "number")
  assert.equal(fs.existsSync(path.join(tempRoot, response.body.image_path.replace("/uploads/", "uploads/"))), true)
})

test("POST /api/v1/camera/snap reports camera failures", async (t) => {
  const camera = await startCameraServer((req, res) => {
    res.writeHead(503, { "content-type": "text/plain" })
    res.end("camera unavailable")
  })
  const { runtime, tempRoot } = createRuntime({ ESP32_CAM_BASE_URL: camera.baseUrl })
  t.after(async () => {
    await cleanup(runtime, tempRoot, camera.server)
  })

  await runtime.ensureInitialized()
  const response = await request(runtime.app).post("/api/v1/camera/snap").expect(502)

  assert.match(response.body.detail, /HTTP 503/)
})

test("manual watering dry-run cancels the next automatic watering when under 6 hours", async (t) => {
  const { runtime, tempRoot } = createRuntime()
  t.after(async () => {
    await cleanup(runtime, tempRoot)
  })

  await runtime.ensureInitialized()
  const soon = new Date(Date.now() + 30 * 60 * 1000)
  const soonLocal = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(soon)

  await request(runtime.app).put("/api/v1/watering/schedule").send({ auto_watering_time: soonLocal }).expect(200)
  await request(runtime.app).put("/api/v1/mode").send({ mode: "manual" }).expect(200)
  const response = await request(runtime.app).post("/api/v1/watering/manual").expect(200)

  assert.equal(response.body.cancelled_next_auto_watering, true)
  assert.equal(typeof response.body.skipped_auto_watering_at, "string")

  const history = await request(runtime.app).get("/api/v1/watering/history").expect(200)
  assert.equal(history.body.history[0].activity, "watered")
  assert.equal(history.body.history[0].description, "manual_override")
})

test("automatic watering skips when rain was detected today", async (t) => {
  const { runtime, tempRoot } = createRuntime()
  t.after(async () => {
    await cleanup(runtime, tempRoot)
  })

  await runtime.ensureInitialized()
  const now = new Date()
  const scheduleTime = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now)

  await request(runtime.app).put("/api/v1/watering/schedule").send({ auto_watering_time: scheduleTime }).expect(200)
  await sqliteRun(
    runtime.config.DB_PATH,
    `
    INSERT INTO inference_snapshots (
      status,
      mode,
      image_path,
      prediction_label,
      prediction_confidence,
      description_text,
      updated_at
    ) VALUES ('online', 'auto', '/uploads/rain.jpg', 'rain_likely', 0.91, 'rain detected', ?)
    `,
    [now.toISOString()]
  )

  await runtime.runAutomaticWateringIfDue(now)
  const history = await request(runtime.app).get("/api/v1/watering/history").expect(200)

  assert.equal(history.body.history[0].activity, "not_watered")
  assert.equal(history.body.history[0].description, "automatic")
  assert.match(history.body.history[0].note, /rain was detected/i)
})

test("scheduled auto snap only runs inside daylight hours", async (t) => {
  const camera = await startCameraServer((req, res) => {
    res.writeHead(200, { "content-type": "image/jpeg" })
    res.end(JPEG_BYTES)
  })
  const { runtime, tempRoot } = createRuntime({
    ESP32_CAM_BASE_URL: camera.baseUrl,
    AUTO_SNAP_INTERVAL_MS: 1,
  })
  t.after(async () => {
    await cleanup(runtime, tempRoot, camera.server)
  })

  await runtime.ensureInitialized()
  await runtime.runScheduledTasks(new Date("2026-05-17T10:00:00.000Z"))
  assert.equal(camera.getCaptures(), 0)
  assert.equal(isWithinDaylightWindow(new Date("2026-05-17T01:00:00.000Z"), runtime.config), true)

  await runtime.runScheduledTasks(new Date("2026-05-17T01:00:00.000Z"))
  assert.equal(camera.getCaptures(), 1)
})

test("retention cleanup removes uploads and inference rows older than 7 days", async (t) => {
  const { runtime, tempRoot } = createRuntime({ IMAGE_RETENTION_DAYS: 7 })
  t.after(async () => {
    await cleanup(runtime, tempRoot)
  })

  await runtime.ensureInitialized()
  const oldFile = path.join(tempRoot, "uploads", "old.jpg")
  fs.writeFileSync(oldFile, JPEG_BYTES)
  await sqliteRun(
    runtime.config.DB_PATH,
    "INSERT INTO image_uploads (device_id, image_path, captured_at, uploaded_at) VALUES ('test', '/uploads/old.jpg', ?, ?)",
    ["2026-05-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z"]
  )
  await sqliteRun(
    runtime.config.DB_PATH,
    `
    INSERT INTO inference_snapshots (
      status,
      mode,
      image_path,
      prediction_label,
      prediction_confidence,
      description_text,
      updated_at
    ) VALUES ('online', 'auto', '/uploads/old.jpg', 'rain_unlikely', 0.77, 'old', '2026-05-01T00:00:00.000Z')
    `
  )

  await runtime.cleanupOldImagesAndRows(new Date("2026-05-17T00:00:00.000Z"))
  const inference = await request(runtime.app).get("/api/v1/inference/history?limit=100").expect(200)

  assert.equal(fs.existsSync(oldFile), false)
  assert.equal(inference.body.history.some((row) => row.image_url === "/uploads/old.jpg"), false)
})

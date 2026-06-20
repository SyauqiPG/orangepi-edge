"use strict"

const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const test = require("node:test")
const request = require("supertest")

const { createServer } = require("../src/server")
const { createFrame } = require("../src/esp32cam/simulator")

function createRuntime() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orangepi-edge-test-"))

  const runtime = createServer({
    DB_PATH: path.join(tempRoot, "orangepi-edge-test.db"),
    IMAGE_UPLOAD_DIR: path.join(tempRoot, "uploads"),
    SNAPSHOT_IMAGE_BASE_PATH: "/uploads",
    DEVICE_UPLOAD_KEY: "test-device-key",
    CORS_ORIGIN: "*",
    MODEL_PROVIDER: "onnx",
  })

  return {
    runtime,
    tempRoot,
  }
}

async function cleanup(runtime, tempRoot) {
  await runtime.closeDatabase()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

test("GET /api/v1/health returns parity fields", async (t) => {
  const { runtime, tempRoot } = createRuntime()
  t.after(async () => {
    await cleanup(runtime, tempRoot)
  })

  await runtime.ensureInitialized()

  const response = await request(runtime.app).get("/api/v1/health").expect(200)

  assert.equal(response.body.ok, true)
  assert.equal(typeof response.body.status, "string")
  assert.equal(typeof response.body.mode, "string")
  assert.equal(typeof response.body.db_path, "string")
  assert.equal(typeof response.body.auto_water_cooldown_ms, "number")
})

test("GET /api/v1/snapshot requires a real camera image", async (t) => {
  const { runtime, tempRoot } = createRuntime()
  t.after(async () => {
    await cleanup(runtime, tempRoot)
  })

  await runtime.ensureInitialized()

  const response = await request(runtime.app).get("/api/v1/snapshot").expect(404)
  assert.equal(response.body.error, "No inference available")
})

test("PUT /api/v1/mode rejects invalid mode", async (t) => {
  const { runtime, tempRoot } = createRuntime()
  t.after(async () => {
    await cleanup(runtime, tempRoot)
  })

  await runtime.ensureInitialized()

  const response = await request(runtime.app)
    .put("/api/v1/mode")
    .send({ mode: "invalid-mode" })
    .expect(400)

  assert.equal(response.body.error, "Invalid mode")
  assert.deepEqual(response.body.accepted, ["auto", "manual"])
})

test("POST /api/v1/watering/manual returns 409 when mode is auto", async (t) => {
  const { runtime, tempRoot } = createRuntime()
  t.after(async () => {
    await cleanup(runtime, tempRoot)
  })

  await runtime.ensureInitialized()

  const response = await request(runtime.app).post("/api/v1/watering/manual").expect(409)

  assert.equal(response.body.error, "Manual watering locked")
})

test("GET /api/v1/logs returns logs array", async (t) => {
  const { runtime, tempRoot } = createRuntime()
  t.after(async () => {
    await cleanup(runtime, tempRoot)
  })

  await runtime.ensureInitialized()

  const response = await request(runtime.app).get("/api/v1/logs?limit=5").expect(200)

  assert.equal(Array.isArray(response.body.logs), true)
})

test("POST /api/v1/device/upload enforces x-device-key", async (t) => {
  const { runtime, tempRoot } = createRuntime()
  t.after(async () => {
    await cleanup(runtime, tempRoot)
  })

  await runtime.ensureInitialized()

  await request(runtime.app).post("/api/v1/device/upload").expect(401)
})

test("POST /api/v1/device/upload stores image and returns snapshot", async (t) => {
  const { runtime, tempRoot } = createRuntime()
  t.after(async () => {
    await cleanup(runtime, tempRoot)
  })

  await runtime.ensureInitialized()

  const response = await request(runtime.app)
    .post("/api/v1/device/upload")
    .set("x-device-key", "test-device-key")
    .set("x-device-id", "esp32cam-01")
    .field("captured_at", "2026-04-18T10:00:00.000Z")
    .attach("image", await createFrame(new Date("2026-04-18T10:00:00.000Z")), "frame.jpg")
    .expect(201)

  assert.equal(response.body.ok, true)
  assert.equal(typeof response.body.image_path, "string")
  assert.equal(typeof response.body.snapshot, "object")
})

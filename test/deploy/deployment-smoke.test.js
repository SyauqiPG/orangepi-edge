"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = process.env.SMOKE_TEST_URL || "http://localhost:4000"
const API = (path) => `${BASE_URL}${path}`

// ---------------------------------------------------------------------------
// Suite-level skip guard: check if service is reachable
// ---------------------------------------------------------------------------

test("deployment-smoke", { concurrency: false }, async (t) => {
  // Pre-check: is the service up?
  let serviceReachable = false
  try {
    const probe = await fetch(API("/api/v1/health"), { signal: AbortSignal.timeout(5000) })
    serviceReachable = probe.ok
  } catch {
    serviceReachable = false
  }

  if (!serviceReachable) {
    t.skip(`Service not reachable at ${BASE_URL}`)
    return
  }

  // -----------------------------------------------------------------------
  // Health endpoint
  // -----------------------------------------------------------------------
  await t.test("GET /api/v1/health returns 200 with parity fields", async () => {
    const response = await fetch(API("/api/v1/health"))
    assert.equal(response.status, 200)

    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(typeof body.status, "string")
    assert.equal(typeof body.mode, "string")
    assert.equal(typeof body.db_path, "string")
    assert.equal(typeof body.auto_water_cooldown_ms, "number")
    assert.ok(["online", "offline"].includes(body.status))
    assert.ok(["auto", "manual"].includes(body.mode))
  })

  // -----------------------------------------------------------------------
  // Snapshot endpoint
  // -----------------------------------------------------------------------
  await t.test("GET /api/v1/snapshot returns 200 with parity schema", async () => {
    const response = await fetch(API("/api/v1/snapshot"))
    assert.equal(response.status, 200)

    const body = await response.json()
    const keys = Object.keys(body).sort()
    assert.deepEqual(keys, [
      "description_text",
      "image_path",
      "mode",
      "prediction_confidence",
      "prediction_label",
      "status",
      "updated_at",
    ])

    assert.ok(["rain_likely", "rain_unlikely"].includes(body.prediction_label))
    assert.ok(typeof body.prediction_confidence === "number")
    assert.ok(body.prediction_confidence >= 0.5 && body.prediction_confidence <= 1.0)
    assert.ok(["online", "offline"].includes(body.status))
    assert.ok(["auto", "manual"].includes(body.mode))
  })

  // -----------------------------------------------------------------------
  // Mode endpoint — set auto
  // -----------------------------------------------------------------------
  await t.test("PUT /api/v1/mode accepts auto", async () => {
    const response = await fetch(API("/api/v1/mode"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "auto" }),
    })
    assert.equal(response.status, 200)

    const body = await response.json()
    assert.equal(body.mode, "auto")
  })

  // -----------------------------------------------------------------------
  // Mode endpoint — set manual
  // -----------------------------------------------------------------------
  await t.test("PUT /api/v1/mode accepts manual", async () => {
    const response = await fetch(API("/api/v1/mode"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "manual" }),
    })
    assert.equal(response.status, 200)

    const body = await response.json()
    assert.equal(body.mode, "manual")
  })

  // -----------------------------------------------------------------------
  // Mode endpoint — reject invalid
  // -----------------------------------------------------------------------
  await t.test("PUT /api/v1/mode rejects invalid mode", async () => {
    const response = await fetch(API("/api/v1/mode"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "invalid-mode" }),
    })
    assert.equal(response.status, 400)

    const body = await response.json()
    assert.equal(body.error, "Invalid mode")
    assert.deepEqual(body.accepted, ["auto", "manual"])
  })

  // -----------------------------------------------------------------------
  // Status endpoint
  // -----------------------------------------------------------------------
  await t.test("PUT /api/v1/status accepts online", async () => {
    const response = await fetch(API("/api/v1/status"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "online" }),
    })
    assert.equal(response.status, 200)

    const body = await response.json()
    assert.equal(body.status, "online")
  })

  // -----------------------------------------------------------------------
  // Logs endpoint
  // -----------------------------------------------------------------------
  await t.test("GET /api/v1/logs returns logs array", async () => {
    const response = await fetch(API("/api/v1/logs?limit=5"))
    assert.equal(response.status, 200)

    const body = await response.json()
    assert.ok(Array.isArray(body.logs))
  })

  // -----------------------------------------------------------------------
  // Control tick endpoint
  // -----------------------------------------------------------------------
  await t.test("POST /api/v1/control/tick returns snapshot", async () => {
    const response = await fetch(API("/api/v1/control/tick"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
    assert.equal(response.status, 200)

    const body = await response.json()
    const keys = Object.keys(body).sort()
    assert.deepEqual(keys, [
      "description_text",
      "image_path",
      "mode",
      "prediction_confidence",
      "prediction_label",
      "status",
      "updated_at",
    ])
  })

  // -----------------------------------------------------------------------
  // Restore mode to auto for good measure
  // -----------------------------------------------------------------------
  await t.test("restore mode to auto", async () => {
    const response = await fetch(API("/api/v1/mode"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "auto" }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).mode, "auto")
  })
})

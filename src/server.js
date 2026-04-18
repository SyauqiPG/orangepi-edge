"use strict"

const { exec } = require("child_process")
const cors = require("cors")
const express = require("express")
const fs = require("fs")
const multer = require("multer")
const path = require("path")
const sqlite3 = require("sqlite3").verbose()

const { loadConfig } = require("./config")
const { createOnnxInferenceEngine } = require("./inference/onnx")

function ensureDirectory(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true })
}

function parseCorsOrigin(corsOrigin) {
  if (corsOrigin === "*") {
    return true
  }

  return corsOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
}

function nowIso() {
  return new Date().toISOString()
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function toLogDescription(mode) {
  return mode === "manual" ? "Manually" : "Automatically"
}

function buildDescription(label, confidence) {
  const confidencePct = Math.round(confidence * 100)

  if (label === "rain_likely") {
    return `MobileNetV4 detects dense cloud clustering and high moisture gradients (${confidencePct}%). Auto watering remains conservative.`
  }

  return `MobileNetV4 detects brighter cloud spacing and lower rain probability (${confidencePct}%). Watering can proceed with normal policy.`
}

function normalizePredictionLabel(rawLabel) {
  if (rawLabel === "rain_likely" || rawLabel === "rain_unlikely") {
    return rawLabel
  }

  const lowered = String(rawLabel || "")
    .toLowerCase()
    .trim()

  if (lowered.includes("likely")) {
    return "rain_likely"
  }

  return "rain_unlikely"
}

function normalizeConfidence(rawConfidence) {
  const confidence = Number(rawConfidence)
  if (!Number.isFinite(confidence)) {
    return null
  }

  return Number(clamp(confidence, 0, 1).toFixed(3))
}

function safeImageExtension(originalName, mimeType) {
  const extension = path.extname(originalName || "").toLowerCase()
  const allowed = new Set([".jpg", ".jpeg", ".png", ".webp"])

  if (allowed.has(extension)) {
    return extension
  }

  if (mimeType === "image/png") {
    return ".png"
  }

  if (mimeType === "image/webp") {
    return ".webp"
  }

  return ".jpg"
}

function toAbsoluteImagePath(config, imagePath) {
  if (!imagePath) {
    return ""
  }

  if (path.isAbsolute(imagePath)) {
    return imagePath
  }

  const normalizedBase = config.SNAPSHOT_IMAGE_BASE_PATH.endsWith("/")
    ? config.SNAPSHOT_IMAGE_BASE_PATH.slice(0, -1)
    : config.SNAPSHOT_IMAGE_BASE_PATH

  if (imagePath.startsWith(`${normalizedBase}/`)) {
    const relativePart = imagePath.slice(normalizedBase.length + 1)
    return path.join(config.IMAGE_UPLOAD_DIR, relativePart)
  }

  return path.resolve(config.ROOT_DIR, imagePath)
}

function simulateInference(referenceTime = Date.now(), imagePath = "/sky-monitor.svg") {
  const signal = (Math.sin(referenceTime / 60_000) + 1) / 2
  const rainLikely = signal > 0.53

  const confidence = rainLikely
    ? clamp(0.6 + signal * 0.36, 0.5, 0.97)
    : clamp(0.58 + (1 - signal) * 0.32, 0.5, 0.97)

  const predictionLabel = rainLikely ? "rain_likely" : "rain_unlikely"

  return {
    imagePath,
    predictionLabel,
    predictionConfidence: Number(confidence.toFixed(3)),
    descriptionText: buildDescription(predictionLabel, confidence),
  }
}

async function runCommandInference(config, imagePath) {
  if (!config.MODEL_COMMAND) {
    throw new Error("MODEL_COMMAND is empty")
  }

  const absoluteImagePath = toAbsoluteImagePath(config, imagePath)
  const escapedImagePath = absoluteImagePath.replace(/"/g, '\\"')
  const command = `${config.MODEL_COMMAND} "${escapedImagePath}"`

  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd: config.ROOT_DIR,
        timeout: config.MODEL_COMMAND_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`MODEL_COMMAND failed: ${(stderr || error.message).trim()}`))
          return
        }

        const stdoutText = String(stdout || "").trim()
        if (!stdoutText) {
          reject(new Error("MODEL_COMMAND returned empty stdout"))
          return
        }

        const lines = stdoutText.split(/\r?\n/).filter(Boolean)
        const jsonLine = lines[lines.length - 1]

        let parsed
        try {
          parsed = JSON.parse(jsonLine)
        } catch (parseError) {
          reject(
            new Error(
              `MODEL_COMMAND stdout must end with JSON. Parse error: ${
                parseError instanceof Error ? parseError.message : "Unknown parse error"
              }`
            )
          )
          return
        }

        const predictionLabel = normalizePredictionLabel(parsed.prediction_label || parsed.label)
        const predictionConfidence = normalizeConfidence(
          parsed.prediction_confidence ?? parsed.confidence
        )

        if (predictionConfidence === null) {
          reject(new Error("MODEL_COMMAND JSON must include numeric confidence or prediction_confidence"))
          return
        }

        const descriptionText =
          typeof parsed.description_text === "string" && parsed.description_text.trim()
            ? parsed.description_text
            : buildDescription(predictionLabel, predictionConfidence)

        resolve({
          imagePath: parsed.image_path || imagePath || "/sky-monitor.svg",
          predictionLabel,
          predictionConfidence,
          descriptionText,
        })
      }
    )
  })
}

async function runInference(config, referenceTime, imagePath, onnxEngine) {
  if (config.MODEL_PROVIDER === "onnx") {
    try {
      if (!onnxEngine) {
        throw new Error("ONNX engine is unavailable")
      }

      const prediction = await onnxEngine.infer(toAbsoluteImagePath(config, imagePath))
      return {
        imagePath,
        predictionLabel: prediction.predictionLabel,
        predictionConfidence: prediction.predictionConfidence,
        descriptionText: buildDescription(prediction.predictionLabel, prediction.predictionConfidence),
      }
    } catch (error) {
      if (!config.ONNX_FALLBACK_TO_MOCK) {
        throw error
      }

      console.warn("[orangepi-edge] ONNX inference failed, falling back to simulated inference:", error.message)
    }
  }

  if (config.MODEL_PROVIDER === "command" && config.MODEL_COMMAND) {
    try {
      return await runCommandInference(config, imagePath)
    } catch (error) {
      console.warn("[orangepi-edge] Falling back to simulated inference:", error.message)
    }
  }

  return simulateInference(referenceTime, imagePath)
}

function createServer(configOverrides = {}) {
  const config = { ...loadConfig(), ...configOverrides }
  const onnxEngine = createOnnxInferenceEngine(config)

  ensureDirectory(path.dirname(config.DB_PATH))
  ensureDirectory(config.IMAGE_UPLOAD_DIR)

  const db = new sqlite3.Database(config.DB_PATH)
  let initializationPromise = null

  const app = express()
  app.use(cors({ origin: parseCorsOrigin(config.CORS_ORIGIN) }))
  app.use(express.json())
  app.use(config.SNAPSHOT_IMAGE_BASE_PATH, express.static(config.IMAGE_UPLOAD_DIR))

  app.use(async (req, res, next) => {
    try {
      await ensureInitialized()
      next()
    } catch (error) {
      next(error)
    }
  })

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        cb(null, config.IMAGE_UPLOAD_DIR)
      },
      filename: (req, file, cb) => {
        const extension = safeImageExtension(file.originalname, file.mimetype)
        const randomSuffix = Math.random().toString(36).slice(2, 10)
        cb(null, `${Date.now()}-${randomSuffix}${extension}`)
      },
    }),
    limits: {
      fileSize: config.MAX_UPLOAD_BYTES,
    },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype || !file.mimetype.startsWith("image/")) {
        const validationError = new Error("Only image uploads are allowed")
        validationError.statusCode = 400
        cb(validationError)
        return
      }

      cb(null, true)
    },
  })

  function run(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(error) {
        if (error) {
          reject(error)
          return
        }

        resolve({
          lastID: this.lastID,
          changes: this.changes,
        })
      })
    })
  }

  function get(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (error, row) => {
        if (error) {
          reject(error)
          return
        }

        resolve(row || null)
      })
    })
  }

  function all(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (error, rows) => {
        if (error) {
          reject(error)
          return
        }

        resolve(rows || [])
      })
    })
  }

  async function initializeDatabase() {
    await run(`
      CREATE TABLE IF NOT EXISTS system_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL CHECK (status IN ('online', 'offline')),
        mode TEXT NOT NULL CHECK (mode IN ('auto', 'manual')),
        image_path TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_manual_watering_at TEXT,
        last_auto_watering_at TEXT
      )
    `)

    await run(`
      CREATE TABLE IF NOT EXISTS inference_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL CHECK (status IN ('online', 'offline')),
        mode TEXT NOT NULL CHECK (mode IN ('auto', 'manual')),
        image_path TEXT NOT NULL,
        prediction_label TEXT NOT NULL CHECK (prediction_label IN ('rain_likely', 'rain_unlikely')),
        prediction_confidence REAL NOT NULL,
        description_text TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)

    await run(`
      CREATE TABLE IF NOT EXISTS watering_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date_time TEXT NOT NULL,
        activity TEXT NOT NULL DEFAULT 'Plant Watered',
        description TEXT NOT NULL CHECK (description IN ('Automatically', 'Manually')),
        mode TEXT NOT NULL CHECK (mode IN ('auto', 'manual')),
        prediction_label TEXT,
        prediction_confidence REAL,
        note TEXT
      )
    `)

    await run(`
      CREATE TABLE IF NOT EXISTS image_uploads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        image_path TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        uploaded_at TEXT NOT NULL
      )
    `)

    const state = await get("SELECT * FROM system_state WHERE id = 1")
    if (!state) {
      const timestamp = nowIso()
      await run(
        `
        INSERT INTO system_state (id, status, mode, image_path, updated_at, last_manual_watering_at, last_auto_watering_at)
        VALUES (1, 'online', 'auto', ?, ?, NULL, NULL)
        `,
        ["/sky-monitor.svg", timestamp]
      )
    }

    const latestSnapshot = await get("SELECT * FROM inference_snapshots ORDER BY id DESC LIMIT 1")
    if (!latestSnapshot) {
      await createAndPersistSnapshot()
    }
  }

  async function ensureInitialized() {
    if (!initializationPromise) {
      initializationPromise = initializeDatabase().catch((error) => {
        initializationPromise = null
        throw error
      })
    }

    await initializationPromise
  }

  async function getState() {
    const state = await get("SELECT * FROM system_state WHERE id = 1")
    if (!state) {
      throw new Error("Missing system_state row")
    }

    return state
  }

  async function updateState(partialState) {
    const current = await getState()
    const next = {
      ...current,
      ...partialState,
      updated_at: nowIso(),
    }

    await run(
      `
      UPDATE system_state
      SET status = ?, mode = ?, image_path = ?, updated_at = ?, last_manual_watering_at = ?, last_auto_watering_at = ?
      WHERE id = 1
      `,
      [
        next.status,
        next.mode,
        next.image_path,
        next.updated_at,
        next.last_manual_watering_at || null,
        next.last_auto_watering_at || null,
      ]
    )

    return getState()
  }

  async function getLatestUploadedImagePath() {
    const latestUpload = await get("SELECT image_path FROM image_uploads ORDER BY id DESC LIMIT 1")
    return latestUpload ? latestUpload.image_path : null
  }

  async function createAndPersistSnapshot(referenceTime = Date.now(), preferredImagePath = null) {
    const state = await getState()
    const latestUploadedImagePath = await getLatestUploadedImagePath()
    const selectedImagePath =
      preferredImagePath || latestUploadedImagePath || state.image_path || "/sky-monitor.svg"

    const inference = await runInference(config, referenceTime, selectedImagePath, onnxEngine)
    const updatedAt = new Date(referenceTime).toISOString()

    await run(
      `
      INSERT INTO inference_snapshots (
        status,
        mode,
        image_path,
        prediction_label,
        prediction_confidence,
        description_text,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        state.status,
        state.mode,
        inference.imagePath,
        inference.predictionLabel,
        inference.predictionConfidence,
        inference.descriptionText,
        updatedAt,
      ]
    )

    await updateState({ image_path: inference.imagePath })

    return getLatestSnapshot()
  }

  async function getLatestSnapshot() {
    return get("SELECT * FROM inference_snapshots ORDER BY id DESC LIMIT 1")
  }

  function snapshotToResponse(snapshot, state) {
    return {
      status: state.status,
      mode: state.mode,
      image_path: snapshot.image_path,
      prediction_label: snapshot.prediction_label,
      prediction_confidence: snapshot.prediction_confidence,
      description_text: snapshot.description_text,
      updated_at: snapshot.updated_at,
    }
  }

  function logToResponse(log) {
    return {
      id: String(log.id),
      date_time: log.date_time,
      activity: log.activity,
      description: log.description,
      mode: log.mode,
      prediction_label: log.prediction_label,
      prediction_confidence: log.prediction_confidence,
      note: log.note,
    }
  }

  async function createWateringLog({
    description,
    mode,
    predictionLabel,
    predictionConfidence,
    note,
  }) {
    const timestamp = nowIso()

    const result = await run(
      `
      INSERT INTO watering_logs (
        date_time,
        activity,
        description,
        mode,
        prediction_label,
        prediction_confidence,
        note
      ) VALUES (?, 'Plant Watered', ?, ?, ?, ?, ?)
      `,
      [
        timestamp,
        description,
        mode,
        predictionLabel || null,
        typeof predictionConfidence === "number" ? predictionConfidence : null,
        note || null,
      ]
    )

    return get("SELECT * FROM watering_logs WHERE id = ?", [result.lastID])
  }

  async function maybeAutoWater(snapshot, state) {
    if (state.status !== "online" || state.mode !== "auto") {
      return null
    }

    if (snapshot.prediction_label !== "rain_unlikely") {
      return null
    }

    if (snapshot.prediction_confidence < 0.7) {
      return null
    }

    const now = Date.now()
    const lastAuto = state.last_auto_watering_at ? Date.parse(state.last_auto_watering_at) : 0

    if (now - lastAuto < config.AUTO_WATER_COOLDOWN_MS) {
      return null
    }

    const entry = await createWateringLog({
      description: "Automatically",
      mode: "auto",
      predictionLabel: snapshot.prediction_label,
      predictionConfidence: snapshot.prediction_confidence,
      note: "Auto policy triggered by rain_unlikely with high confidence.",
    })

    await updateState({ last_auto_watering_at: nowIso() })
    return entry
  }

  async function refreshSnapshotIfNeeded(forceNew = false, preferredImagePath = null) {
    const state = await getState()
    let snapshot = await getLatestSnapshot()

    const shouldCreate =
      forceNew ||
      !snapshot ||
      Date.now() - Date.parse(snapshot.updated_at) >= config.INFERENCE_INTERVAL_MS

    if (shouldCreate) {
      snapshot = await createAndPersistSnapshot(Date.now(), preferredImagePath)
    }

    await maybeAutoWater(snapshot, state)

    const freshState = await getState()
    return snapshotToResponse(snapshot, freshState)
  }

  function requireDeviceKey(req, res, next) {
    if (!config.DEVICE_UPLOAD_KEY) {
      next()
      return
    }

    const provided = req.get("x-device-key")
    if (provided !== config.DEVICE_UPLOAD_KEY) {
      res.status(401).json({
        error: "Unauthorized device",
        detail: "Missing or invalid x-device-key header.",
      })
      return
    }

    next()
  }

  app.get("/", (req, res) => {
    res.json({
      service: "orangepi-edge",
      message: "Orange Pi edge runtime is running",
      docs: {
        health: "/api/v1/health",
        snapshot: "/api/v1/snapshot",
        mode: "/api/v1/mode",
        status: "/api/v1/status",
        manualWatering: "/api/v1/watering/manual",
        logs: "/api/v1/logs",
        tick: "/api/v1/control/tick",
        deviceUpload: "/api/v1/device/upload",
      },
    })
  })

  app.get("/api/v1/health", async (req, res, next) => {
    try {
      const state = await getState()
      res.json({
        ok: true,
        status: state.status,
        mode: state.mode,
        db_path: config.DB_PATH,
        inference_interval_ms: config.INFERENCE_INTERVAL_MS,
        auto_water_cooldown_ms: config.AUTO_WATER_COOLDOWN_MS,
      })
    } catch (error) {
      next(error)
    }
  })

  app.get("/api/v1/snapshot", async (req, res, next) => {
    try {
      const snapshot = await refreshSnapshotIfNeeded(false)
      res.json(snapshot)
    } catch (error) {
      next(error)
    }
  })

  app.post("/api/v1/control/tick", async (req, res, next) => {
    try {
      const snapshot = await refreshSnapshotIfNeeded(true)
      res.json({ ok: true, snapshot })
    } catch (error) {
      next(error)
    }
  })

  app.get("/api/v1/mode", async (req, res, next) => {
    try {
      const state = await getState()
      res.json({ mode: state.mode })
    } catch (error) {
      next(error)
    }
  })

  app.put("/api/v1/mode", async (req, res, next) => {
    try {
      const mode = req.body ? req.body.mode : null
      if (mode !== "auto" && mode !== "manual") {
        res.status(400).json({
          error: "Invalid mode",
          accepted: ["auto", "manual"],
        })
        return
      }

      await updateState({ mode })
      const snapshot = await refreshSnapshotIfNeeded(true)
      res.json({ ok: true, mode, snapshot })
    } catch (error) {
      next(error)
    }
  })

  app.get("/api/v1/status", async (req, res, next) => {
    try {
      const state = await getState()
      res.json({ status: state.status })
    } catch (error) {
      next(error)
    }
  })

  app.put("/api/v1/status", async (req, res, next) => {
    try {
      const status = req.body ? req.body.status : null
      if (status !== "online" && status !== "offline") {
        res.status(400).json({
          error: "Invalid status",
          accepted: ["online", "offline"],
        })
        return
      }

      await updateState({ status })
      const snapshot = await refreshSnapshotIfNeeded(true)
      res.json({ ok: true, status, snapshot })
    } catch (error) {
      next(error)
    }
  })

  app.post("/api/v1/watering/manual", async (req, res, next) => {
    try {
      const state = await getState()
      if (state.status !== "online") {
        res.status(503).json({
          error: "System offline",
          detail: "Manual watering is unavailable while system status is offline.",
        })
        return
      }

      if (state.mode !== "manual") {
        res.status(409).json({
          error: "Manual watering locked",
          detail: "Switch mode to manual before triggering TURN ON.",
        })
        return
      }

      const snapshot = await refreshSnapshotIfNeeded(false)
      const entry = await createWateringLog({
        description: toLogDescription("manual"),
        mode: "manual",
        predictionLabel: snapshot.prediction_label,
        predictionConfidence: snapshot.prediction_confidence,
        note: "Manual TURN ON command from HMI.",
      })

      await updateState({ last_manual_watering_at: nowIso() })

      res.json({
        ok: true,
        entry: logToResponse(entry),
        snapshot,
      })
    } catch (error) {
      next(error)
    }
  })

  app.get("/api/v1/logs", async (req, res, next) => {
    try {
      const limitRaw = Number((req.query && req.query.limit) || 100)
      const limit = Number.isFinite(limitRaw) ? clamp(Math.trunc(limitRaw), 1, 500) : 100

      const rows = await all(
        `
        SELECT id, date_time, activity, description, mode, prediction_label, prediction_confidence, note
        FROM watering_logs
        ORDER BY id DESC
        LIMIT ?
        `,
        [limit]
      )

      res.json({ logs: rows.map(logToResponse) })
    } catch (error) {
      next(error)
    }
  })

  app.delete("/api/v1/logs", async (req, res, next) => {
    try {
      await run("DELETE FROM watering_logs")
      res.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })

  app.post(
    "/api/v1/device/upload",
    requireDeviceKey,
    upload.single("image"),
    async (req, res, next) => {
      try {
        if (!req.file) {
          res.status(400).json({
            error: "Missing image",
            detail: "Send multipart/form-data with field name 'image'.",
          })
          return
        }

        const imagePath = path.posix.join(
          config.SNAPSHOT_IMAGE_BASE_PATH.replace(/\\/g, "/"),
          req.file.filename
        )

        const uploadedAt = nowIso()
        const capturedAtRaw = req.body ? req.body.captured_at : null
        const capturedAt =
          capturedAtRaw && !Number.isNaN(Date.parse(capturedAtRaw))
            ? new Date(capturedAtRaw).toISOString()
            : uploadedAt

        const rawDeviceId = req.body && req.body.device_id ? req.body.device_id : req.get("x-device-id")
        const deviceId = String(rawDeviceId || "esp32-cam").slice(0, 64)

        await run(
          `
          INSERT INTO image_uploads (device_id, image_path, captured_at, uploaded_at)
          VALUES (?, ?, ?, ?)
          `,
          [deviceId, imagePath, capturedAt, uploadedAt]
        )

        const snapshot = await refreshSnapshotIfNeeded(true, imagePath)

        res.status(201).json({
          ok: true,
          image_path: imagePath,
          snapshot,
        })
      } catch (error) {
        next(error)
      }
    }
  )

  app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: "Image too large",
          detail: `Maximum upload size is ${config.MAX_UPLOAD_BYTES} bytes.`,
        })
        return
      }

      res.status(400).json({
        error: "Invalid upload",
        detail: error.message,
      })
      return
    }

    if (error && error.statusCode && Number.isInteger(error.statusCode)) {
      res.status(error.statusCode).json({
        error: error.message || "Request failed",
        detail: error.detail || "Upload validation failed",
      })
      return
    }

    next(error)
  })

  app.use((error, req, res, next) => {
    console.error(error)
    res.status(500).json({
      error: "Internal server error",
      detail: error && error.message ? error.message : "Unexpected backend failure",
    })
  })

  async function startServer() {
    await ensureInitialized()

    if (config.MODEL_PROVIDER === "onnx") {
      try {
        await onnxEngine.warmup()
      } catch (error) {
        if (!config.ONNX_FALLBACK_TO_MOCK) {
          throw error
        }

        console.warn("[orangepi-edge] ONNX warmup failed, service will use simulated fallback:", error.message)
      }
    }

    return new Promise((resolve) => {
      const server = app.listen(config.PORT, () => {
        console.log(`[orangepi-edge] Running on http://localhost:${config.PORT}`)
        console.log(`[orangepi-edge] SQLite database: ${config.DB_PATH}`)
        console.log(`[orangepi-edge] Upload directory: ${config.IMAGE_UPLOAD_DIR}`)
        resolve(server)
      })
    })
  }

  async function closeDatabase() {
    return new Promise((resolve, reject) => {
      db.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  return {
    app,
    config,
    ensureInitialized,
    startServer,
    closeDatabase,
  }
}

module.exports = {
  createServer,
}

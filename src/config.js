"use strict"

const fs = require("fs")
const path = require("path")

function loadDotEnv(rootDir) {
  const envPath = path.join(rootDir, ".env")
  if (!fs.existsSync(envPath)) {
    return
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }

    const separatorIndex = trimmed.indexOf("=")
    if (separatorIndex === -1) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    let value = trimmed.slice(separatorIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function parseNumber(rawValue, fallback) {
  const parsed = Number(rawValue)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseBoolean(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return fallback
  }

  return ["1", "true", "yes", "on"].includes(String(rawValue).toLowerCase())
}

function resolveFromRoot(rootDir, rawValue, fallbackRelative) {
  const value = rawValue || fallbackRelative
  if (path.isAbsolute(value)) {
    return value
  }
  return path.resolve(rootDir, value)
}

function loadConfig() {
  const ROOT_DIR = path.resolve(__dirname, "..")
  loadDotEnv(ROOT_DIR)

  const DATA_DIR = resolveFromRoot(ROOT_DIR, process.env.DATA_DIR, "data")
  const onnxProviders = (process.env.ONNX_EXECUTION_PROVIDERS || "cpu")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean)

  const ESP32_CAM_SIMULATOR = parseBoolean(process.env.ESP32_CAM_SIMULATOR, false)
  const ESP32_CAM_SIMULATOR_PORT = parseNumber(process.env.ESP32_CAM_SIMULATOR_PORT, 8081)

  return {
    ROOT_DIR,
    PORT: parseNumber(process.env.PORT, 4000),
    DB_PATH: resolveFromRoot(ROOT_DIR, process.env.DB_PATH, path.join("data", "orangepi-edge.db")),
    DATA_DIR,
    IMAGE_UPLOAD_DIR: resolveFromRoot(
      ROOT_DIR,
      process.env.IMAGE_UPLOAD_DIR,
      path.join("data", "uploads")
    ),
    SNAPSHOT_IMAGE_BASE_PATH: process.env.SNAPSHOT_IMAGE_BASE_PATH || "/uploads",
    AUTO_WATER_COOLDOWN_MS: parseNumber(process.env.AUTO_WATER_COOLDOWN_MS, 120_000),
    CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
    DEVICE_UPLOAD_KEY: process.env.DEVICE_UPLOAD_KEY || "",
    MAX_UPLOAD_BYTES: parseNumber(process.env.MAX_UPLOAD_BYTES, 2 * 1024 * 1024),
    ESP32_CAM_BASE_URL: (
      ESP32_CAM_SIMULATOR
        ? `http://127.0.0.1:${ESP32_CAM_SIMULATOR_PORT}`
        : process.env.ESP32_CAM_BASE_URL || ""
    ).replace(/\/+$/, ""),
    ESP32_CAM_SIMULATOR,
    ESP32_CAM_SIMULATOR_PORT,
    ESP32_CAM_TIMEOUT_MS: parseNumber(process.env.ESP32_CAM_TIMEOUT_MS, 15_000),
    IMAGE_RETENTION_DAYS: parseNumber(process.env.IMAGE_RETENTION_DAYS, 7),
    APP_TIMEZONE: process.env.APP_TIMEZONE || "Asia/Jakarta",
    AUTO_SNAP_INTERVAL_MS: parseNumber(process.env.AUTO_SNAP_INTERVAL_MS, 600_000),
    DAYLIGHT_START_HOUR: parseNumber(process.env.DAYLIGHT_START_HOUR, 8),
    DAYLIGHT_END_HOUR: parseNumber(process.env.DAYLIGHT_END_HOUR, 16),
    WATERING_DURATION_MS: parseNumber(process.env.WATERING_DURATION_MS, 5_000),
    PUMP_DRY_RUN: parseBoolean(process.env.PUMP_DRY_RUN, true),
    PUMP_ON_COMMAND: process.env.PUMP_ON_COMMAND || "",
    PUMP_OFF_COMMAND: process.env.PUMP_OFF_COMMAND || "",
    MODEL_PROVIDER: process.env.MODEL_PROVIDER || "onnx",
    MODEL_COMMAND: process.env.MODEL_COMMAND || "",
    MODEL_COMMAND_TIMEOUT_MS: parseNumber(process.env.MODEL_COMMAND_TIMEOUT_MS, 12_000),
    ONNX_MODEL_PATH: resolveFromRoot(
      ROOT_DIR,
      process.env.ONNX_MODEL_PATH,
      path.join("models", "mobilenetv4-model.onnx")
    ),
    ONNX_INPUT_WIDTH: parseNumber(process.env.ONNX_INPUT_WIDTH, 224),
    ONNX_INPUT_HEIGHT: parseNumber(process.env.ONNX_INPUT_HEIGHT, 224),
    ONNX_INPUT_MEAN: parseNumber(process.env.ONNX_INPUT_MEAN, 127.5),
    ONNX_INPUT_STD: parseNumber(process.env.ONNX_INPUT_STD, 127.5),
    ONNX_INDEX_NO_RAIN: parseNumber(process.env.ONNX_INDEX_NO_RAIN, 0),
    ONNX_INDEX_RAIN: parseNumber(process.env.ONNX_INDEX_RAIN, 1),
    ONNX_EXECUTION_PROVIDERS: onnxProviders,
  }
}

module.exports = {
  loadConfig,
}

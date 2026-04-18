"use strict"

const path = require("path")

function parseNumber(rawValue, fallback) {
  const parsed = Number(rawValue)
  return Number.isFinite(parsed) ? parsed : fallback
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
  const DATA_DIR = resolveFromRoot(ROOT_DIR, process.env.DATA_DIR, "data")
  const onnxProviders = (process.env.ONNX_EXECUTION_PROVIDERS || "cpu")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean)

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
    INFERENCE_INTERVAL_MS: parseNumber(process.env.INFERENCE_INTERVAL_MS, 25_000),
    AUTO_WATER_COOLDOWN_MS: parseNumber(process.env.AUTO_WATER_COOLDOWN_MS, 120_000),
    CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
    DEVICE_UPLOAD_KEY: process.env.DEVICE_UPLOAD_KEY || "",
    MAX_UPLOAD_BYTES: parseNumber(process.env.MAX_UPLOAD_BYTES, 2 * 1024 * 1024),
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
    ONNX_FALLBACK_TO_MOCK: String(process.env.ONNX_FALLBACK_TO_MOCK || "true").toLowerCase() !== "false",
  }
}

module.exports = {
  loadConfig,
}

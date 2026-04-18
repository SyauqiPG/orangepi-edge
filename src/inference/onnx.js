"use strict"

const fs = require("fs")

const ort = require("onnxruntime-node")
const sharp = require("sharp")

function softmax2(a, b) {
  const pivot = Math.max(a, b)
  const ea = Math.exp(a - pivot)
  const eb = Math.exp(b - pivot)
  const sum = ea + eb
  return {
    p0: ea / sum,
    p1: eb / sum,
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function roundConfidence(value) {
  return Number(clamp(value, 0, 1).toFixed(3))
}

function resolveProviderNames(providers) {
  return providers
    .map((provider) => provider.toLowerCase())
    .map((provider) => {
      if (provider === "cpu") {
        return "cpu"
      }

      if (provider === "xnnpack") {
        return "xnnpack"
      }

      return provider
    })
}

function pickIndexedScores(rawScores, indexNoRain, indexRain) {
  if (!Array.isArray(rawScores) || rawScores.length === 0) {
    throw new Error("ONNX output scores are empty")
  }

  if (indexNoRain < 0 || indexNoRain >= rawScores.length) {
    throw new Error(`ONNX_INDEX_NO_RAIN=${indexNoRain} is out of bounds for output length ${rawScores.length}`)
  }

  if (indexRain < 0 || indexRain >= rawScores.length) {
    throw new Error(`ONNX_INDEX_RAIN=${indexRain} is out of bounds for output length ${rawScores.length}`)
  }

  return {
    noRainScore: Number(rawScores[indexNoRain]),
    rainScore: Number(rawScores[indexRain]),
  }
}

function mapScoresToPrediction(rawScores, indexNoRain, indexRain) {
  const { noRainScore, rainScore } = pickIndexedScores(rawScores, indexNoRain, indexRain)
  const { p0, p1 } = softmax2(noRainScore, rainScore)

  if (p1 >= p0) {
    return {
      predictionLabel: "rain_likely",
      predictionConfidence: roundConfidence(p1),
    }
  }

  return {
    predictionLabel: "rain_unlikely",
    predictionConfidence: roundConfidence(p0),
  }
}

async function preprocessImage(imagePath, width, height, mean, std) {
  const { data, info } = await sharp(imagePath)
    .resize(width, height, {
      fit: "fill",
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const channels = 3
  const tensor = new Float32Array(1 * channels * info.width * info.height)
  const pixelCount = info.width * info.height

  for (let i = 0; i < pixelCount; i += 1) {
    const sourceOffset = i * channels
    const r = data[sourceOffset]
    const g = data[sourceOffset + 1]
    const b = data[sourceOffset + 2]

    tensor[i] = (r - mean) / std
    tensor[pixelCount + i] = (g - mean) / std
    tensor[pixelCount * 2 + i] = (b - mean) / std
  }

  return {
    tensor,
    shape: [1, 3, info.height, info.width],
  }
}

function createOnnxInferenceEngine(config) {
  let sessionPromise = null
  let resolvedInputName = null
  let resolvedOutputName = null

  async function ensureSession() {
    if (sessionPromise) {
      return sessionPromise
    }

    sessionPromise = (async () => {
      if (!fs.existsSync(config.ONNX_MODEL_PATH)) {
        throw new Error(`ONNX model file not found at ${config.ONNX_MODEL_PATH}`)
      }

      const requestedProviders = resolveProviderNames(config.ONNX_EXECUTION_PROVIDERS)
      let options = {
        executionProviders: requestedProviders,
        graphOptimizationLevel: "all",
      }

      let session
      try {
        session = await ort.InferenceSession.create(config.ONNX_MODEL_PATH, options)
      } catch (error) {
        if (!requestedProviders.includes("cpu")) {
          options = {
            executionProviders: ["cpu"],
            graphOptimizationLevel: "all",
          }
          session = await ort.InferenceSession.create(config.ONNX_MODEL_PATH, options)
        } else {
          throw error
        }
      }

      if (!Array.isArray(session.inputNames) || session.inputNames.length === 0) {
        throw new Error("ONNX model has no input names")
      }

      if (!Array.isArray(session.outputNames) || session.outputNames.length === 0) {
        throw new Error("ONNX model has no output names")
      }

      resolvedInputName = session.inputNames[0]
      resolvedOutputName = session.outputNames[0]

      console.log(
        `[onnx] Loaded model: ${config.ONNX_MODEL_PATH}, input=${resolvedInputName}, output=${resolvedOutputName}, providers=${options.executionProviders.join(",")}`
      )

      return session
    })().catch((error) => {
      sessionPromise = null
      throw error
    })

    return sessionPromise
  }

  async function infer(imagePath) {
    const session = await ensureSession()
    const processed = await preprocessImage(
      imagePath,
      config.ONNX_INPUT_WIDTH,
      config.ONNX_INPUT_HEIGHT,
      config.ONNX_INPUT_MEAN,
      config.ONNX_INPUT_STD
    )

    const inputTensor = new ort.Tensor("float32", processed.tensor, processed.shape)
    const feeds = {
      [resolvedInputName || session.inputNames[0]]: inputTensor,
    }

    const outputMap = await session.run(feeds)
    const outputName = resolvedOutputName || session.outputNames[0]
    const output = outputMap[outputName]

    if (!output || !output.data) {
      throw new Error("ONNX output tensor is missing")
    }

    const raw = Array.from(output.data)
    return mapScoresToPrediction(raw, config.ONNX_INDEX_NO_RAIN, config.ONNX_INDEX_RAIN)
  }

  async function warmup() {
    await ensureSession()
  }

  return {
    infer,
    warmup,
  }
}

module.exports = {
  createOnnxInferenceEngine,
  mapScoresToPrediction,
}

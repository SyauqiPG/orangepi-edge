"use strict"

const assert = require("node:assert/strict")
const fs = require("fs")
const path = require("path")
const test = require("node:test")

const { loadConfig } = require("../../src/config")
const { createOnnxInferenceEngine } = require("../../src/inference/onnx")

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT_DIR = path.resolve(__dirname, "..", "..")
const MODEL_PATH = path.join(ROOT_DIR, "models", "mobilenetv4-model.onnx")

// Resolve dataset relative to the workspace root (HMI+mock-api)
const WORKSPACE_ROOT = path.resolve(ROOT_DIR, "..")
const DATASET_DIR = process.env.DATASET_DIR || path.join(WORKSPACE_ROOT, "mobilenet_test", "100_dataset")
const NO_RAIN_DIR = path.join(DATASET_DIR, "no-rain")
const RAIN_DIR = path.join(DATASET_DIR, "overlayed_images")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectImages(dir) {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f))
}

function buildTestConfig() {
  return loadConfig({
    ONNX_MODEL_PATH: MODEL_PATH,
    ONNX_EXECUTION_PROVIDERS: "cpu",
    ONNX_INPUT_WIDTH: 224,
    ONNX_INPUT_HEIGHT: 224,
    ONNX_INPUT_MEAN: 127.5,
    ONNX_INPUT_STD: 127.5,
    ONNX_INDEX_NO_RAIN: 0,
    ONNX_INDEX_RAIN: 1,
  })
}

// ---------------------------------------------------------------------------
// Suite-level skip guard
// ---------------------------------------------------------------------------

const modelExists = fs.existsSync(MODEL_PATH)
const noRainImages = collectImages(NO_RAIN_DIR)
const rainImages = collectImages(RAIN_DIR)
const hasDataset = noRainImages.length > 0 && rainImages.length > 0

const suiteOptions = {}
if (!modelExists) {
  suiteOptions.skip = `ONNX model not found at ${MODEL_PATH}`
} else if (!hasDataset) {
  suiteOptions.skip = `Dataset not found at ${DATASET_DIR} (no-rain: ${noRainImages.length}, rain: ${rainImages.length})`
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("inference-validation", suiteOptions, async (t) => {
  const config = buildTestConfig()
  const engine = createOnnxInferenceEngine(config)

  // Warm up the engine once (loads model, creates session)
  await engine.warmup()

  // -----------------------------------------------------------------------
  // Sub-test: Determinism
  // -----------------------------------------------------------------------
  await t.test("determinism — same image produces same result", async () => {
    const firstImage = noRainImages[0] || rainImages[0]
    const results = []
    for (let i = 0; i < 3; i++) {
      results.push(await engine.infer(firstImage))
    }
    for (let i = 1; i < results.length; i++) {
      assert.equal(results[i].predictionLabel, results[0].predictionLabel)
      assert.equal(results[i].predictionConfidence, results[0].predictionConfidence)
    }
  })

  // -----------------------------------------------------------------------
  // Sub-test: Softmax confidence bounds
  // -----------------------------------------------------------------------
  await t.test("confidence is always in [0.5, 1.0] for binary softmax", async () => {
    const sample = [...noRainImages.slice(0, 5), ...rainImages.slice(0, 5)]
    for (const imagePath of sample) {
      const result = await engine.infer(imagePath)
      assert.ok(
        result.predictionConfidence >= 0.5 && result.predictionConfidence <= 1.0,
        `Confidence ${result.predictionConfidence} out of [0.5, 1.0] for ${path.basename(imagePath)}`
      )
    }
  })

  // -----------------------------------------------------------------------
  // Sub-test: No-rain images → rain_unlikely
  // -----------------------------------------------------------------------
  await t.test("no-rain images predict rain_unlikely", async () => {
    const results = []
    for (const imagePath of noRainImages) {
      const result = await engine.infer(imagePath)
      results.push({
        file: path.basename(imagePath),
        label: result.predictionLabel,
        confidence: result.predictionConfidence,
      })
    }

    const correct = results.filter((r) => r.label === "rain_unlikely").length
    const total = results.length
    const accuracy = total > 0 ? correct / total : 0

    console.log(
      `\n[no-rain] ${correct}/${total} correct (accuracy: ${(accuracy * 100).toFixed(1)}%)`
    )
    console.table(results.map((r) => ({ file: r.file, label: r.label, confidence: r.confidence })))

    assert.ok(
      accuracy >= 0.5,
      `No-rain accuracy ${(accuracy * 100).toFixed(1)}% is below 50% threshold`
    )
  })

  // -----------------------------------------------------------------------
  // Sub-test: Rain images → rain_likely
  // -----------------------------------------------------------------------
  await t.test("rain images predict rain_likely", async () => {
    const results = []
    for (const imagePath of rainImages) {
      const result = await engine.infer(imagePath)
      results.push({
        file: path.basename(imagePath),
        label: result.predictionLabel,
        confidence: result.predictionConfidence,
      })
    }

    const correct = results.filter((r) => r.label === "rain_likely").length
    const total = results.length
    const accuracy = total > 0 ? correct / total : 0

    console.log(
      `\n[rain] ${correct}/${total} correct (accuracy: ${(accuracy * 100).toFixed(1)}%)`
    )
    console.table(results.map((r) => ({ file: r.file, label: r.label, confidence: r.confidence })))

    assert.ok(
      accuracy >= 0.5,
      `Rain accuracy ${(accuracy * 100).toFixed(1)}% is below 50% threshold`
    )
  })

  // -----------------------------------------------------------------------
  // Sub-test: Overall accuracy & confusion matrix
  // -----------------------------------------------------------------------
  await t.test("overall accuracy and confusion matrix", async () => {
    const confusion = {
      TP: 0, // rain_likely predicted as rain_likely
      FN: 0, // rain_likely predicted as rain_unlikely
      FP: 0, // rain_unlikely predicted as rain_likely
      TN: 0, // rain_unlikely predicted as rain_unlikely
    }

    for (const imagePath of rainImages) {
      const result = await engine.infer(imagePath)
      if (result.predictionLabel === "rain_likely") confusion.TP++
      else confusion.FN++
    }

    for (const imagePath of noRainImages) {
      const result = await engine.infer(imagePath)
      if (result.predictionLabel === "rain_unlikely") confusion.TN++
      else confusion.FP++
    }

    const total = confusion.TP + confusion.TN + confusion.FP + confusion.FN
    const accuracy = total > 0 ? (confusion.TP + confusion.TN) / total : 0
    const precision = confusion.TP + confusion.FP > 0 ? confusion.TP / (confusion.TP + confusion.FP) : 0
    const recall = confusion.TP + confusion.FN > 0 ? confusion.TP / (confusion.TP + confusion.FN) : 0
    const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0

    console.log(`
=== Confusion Matrix ===
                 Predicted
               rain  no-rain
Actual rain    ${String(confusion.TP).padStart(4)}  ${String(confusion.FN).padStart(4)}
Actual no-rain ${String(confusion.FP).padStart(4)}  ${String(confusion.TN).padStart(4)}

Accuracy:  ${(accuracy * 100).toFixed(1)}%
Precision: ${(precision * 100).toFixed(1)}%
Recall:    ${(recall * 100).toFixed(1)}%
F1 Score:  ${(f1 * 100).toFixed(1)}%
`)

    assert.ok(accuracy >= 0.5, `Overall accuracy ${(accuracy * 100).toFixed(1)}% is below 50%`)
  })

  // -----------------------------------------------------------------------
  // Sub-test: Error paths
  // -----------------------------------------------------------------------
  await t.test("throws on missing model file", async () => {
    const badConfig = buildTestConfig()
    badConfig.ONNX_MODEL_PATH = path.join(ROOT_DIR, "models", "nonexistent.onnx")
    const badEngine = createOnnxInferenceEngine(badConfig)
    await assert.rejects(
      () => badEngine.warmup(),
      /model file not found/
    )
  })

  await t.test("throws on invalid image path", async () => {
    await assert.rejects(
      () => engine.infer(path.join(ROOT_DIR, "nonexistent.jpg")),
      /input file/i
    )
  })

  await t.test("throws on corrupted image", async () => {
    const tmpFile = path.join(ROOT_DIR, "test", "deploy", "__corrupt_test.jpg")
    fs.writeFileSync(tmpFile, Buffer.from("not-a-real-image-data"))
    try {
      await assert.rejects(
        () => engine.infer(tmpFile),
        /input file|sharp|preprocess/i
      )
    } finally {
      try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    }
  })
})

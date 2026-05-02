"use strict"

const assert = require("node:assert/strict")
const fs = require("fs")
const path = require("path")
const { performance } = require("node:perf_hooks")
const test = require("node:test")

const { loadConfig } = require("../../src/config")
const { createOnnxInferenceEngine } = require("../../src/inference/onnx")

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT_DIR = path.resolve(__dirname, "..", "..")
const MODEL_PATH = path.join(ROOT_DIR, "models", "mobilenetv4-model.onnx")
const WORKSPACE_ROOT = path.resolve(ROOT_DIR, "..")
const DATASET_DIR = process.env.DATASET_DIR || path.join(WORKSPACE_ROOT, "mobilenet_test", "100_dataset")
const NO_RAIN_DIR = path.join(DATASET_DIR, "no-rain")
const RAIN_DIR = path.join(DATASET_DIR, "overlayed_images")
const RESULTS_FILE = path.join(__dirname, "benchmark-results.json")

const WARM_RUNS_PER_IMAGE = 5
const BENCHMARK_IMAGE_COUNT = 10 // per class

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
    ONNX_FALLBACK_TO_MOCK: false,
    ONNX_INPUT_WIDTH: 224,
    ONNX_INPUT_HEIGHT: 224,
    ONNX_INPUT_MEAN: 127.5,
    ONNX_INPUT_STD: 127.5,
    ONNX_INDEX_NO_RAIN: 0,
    ONNX_INDEX_RAIN: 1,
  })
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const index = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))]
}

function formatMs(ms) {
  return `${ms.toFixed(2)} ms`
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

// ---------------------------------------------------------------------------
// Suite-level skip guard
// ---------------------------------------------------------------------------

const modelExists = fs.existsSync(MODEL_PATH)
const noRainImages = collectImages(NO_RAIN_DIR).slice(0, BENCHMARK_IMAGE_COUNT)
const rainImages = collectImages(RAIN_DIR).slice(0, BENCHMARK_IMAGE_COUNT)
const benchmarkImages = [...noRainImages, ...rainImages]
const hasDataset = benchmarkImages.length > 0

const suiteOptions = {}
if (!modelExists) {
  suiteOptions.skip = `ONNX model not found at ${MODEL_PATH}`
} else if (!hasDataset) {
  suiteOptions.skip = `No benchmark images found in ${DATASET_DIR}`
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("inference-benchmark", suiteOptions, async (t) => {
  const config = buildTestConfig()
  const engine = createOnnxInferenceEngine(config)

  // -----------------------------------------------------------------------
  // Cold-start benchmark
  // -----------------------------------------------------------------------
  await t.test("cold-start timing", async () => {
    // Measure model load + first inference
    const coldStartStart = performance.now()
    await engine.warmup()
    const loadEnd = performance.now()
    const loadTime = loadEnd - coldStartStart

    const firstImage = benchmarkImages[0]
    const inferStart = performance.now()
    await engine.infer(firstImage)
    const inferEnd = performance.now()
    const firstInferTime = inferEnd - inferStart

    const totalColdStart = loadTime + firstInferTime

    console.log(`
=== Cold-Start Benchmark ===
Model load time:       ${formatMs(loadTime)}
First inference time:  ${formatMs(firstInferTime)}
Total cold-start time: ${formatMs(totalColdStart)}
`)

    assert.ok(totalColdStart > 0, "Cold-start time should be positive")
  })

  // -----------------------------------------------------------------------
  // Warm inference benchmark
  // -----------------------------------------------------------------------
  await t.test("warm inference latency and throughput", async () => {
    const latencies = []
    const results = []

    for (const imagePath of benchmarkImages) {
      for (let run = 0; run < WARM_RUNS_PER_IMAGE; run++) {
        const start = performance.now()
        const result = await engine.infer(imagePath)
        const elapsed = performance.now() - start
        latencies.push(elapsed)
        results.push({
          file: path.basename(imagePath),
          run: run + 1,
          label: result.predictionLabel,
          confidence: result.predictionConfidence,
          latencyMs: Number(elapsed.toFixed(2)),
        })
      }
    }

    const sorted = [...latencies].sort((a, b) => a - b)
    const total = latencies.length
    const sum = latencies.reduce((a, b) => a + b, 0)
    const mean = sum / total
    const p50 = percentile(sorted, 50)
    const p95 = percentile(sorted, 95)
    const p99 = percentile(sorted, 99)
    const min = sorted[0]
    const max = sorted[sorted.length - 1]
    const throughput = total / (sum / 1000) // inferences per second

    console.log(`
=== Warm Inference Benchmark (${total} inferences, ${benchmarkImages.length} images × ${WARM_RUNS_PER_IMAGE} runs) ===
Mean latency:  ${formatMs(mean)}
P50 latency:   ${formatMs(p50)}
P95 latency:   ${formatMs(p95)}
P99 latency:   ${formatMs(p99)}
Min latency:   ${formatMs(min)}
Max latency:   ${formatMs(max)}
Throughput:    ${throughput.toFixed(1)} inferences/sec
`)

    // Print per-image summary
    const perImage = {}
    for (const r of results) {
      if (!perImage[r.file]) perImage[r.file] = []
      perImage[r.file].push(r.latencyMs)
    }
    console.log("Per-image mean latency:")
    for (const [file, times] of Object.entries(perImage)) {
      const avg = times.reduce((a, b) => a + b, 0) / times.length
      console.log(`  ${file}: ${formatMs(avg)}`)
    }

    assert.ok(mean > 0, "Mean latency should be positive")
    assert.ok(throughput > 0, "Throughput should be positive")
  })

  // -----------------------------------------------------------------------
  // Memory benchmark
  // -----------------------------------------------------------------------
  await t.test("memory usage delta", async () => {
    const before = process.memoryUsage()

    // Force a few more inferences to ensure stable memory
    for (let i = 0; i < 10; i++) {
      const img = benchmarkImages[i % benchmarkImages.length]
      await engine.infer(img)
    }

    const after = process.memoryUsage()

    const deltaRss = after.rss - before.rss
    const deltaHeap = after.heapUsed - before.heapUsed
    const deltaExternal = after.external - before.external

    console.log(`
=== Memory Benchmark ===
              Before        After         Delta
RSS:          ${formatMb(before.rss).padStart(10)}  ${formatMb(after.rss).padStart(10)}  ${formatMb(deltaRss).padStart(10)}
Heap Used:    ${formatMb(before.heapUsed).padStart(10)}  ${formatMb(after.heapUsed).padStart(10)}  ${formatMb(deltaHeap).padStart(10)}
External:     ${formatMb(before.external).padStart(10)}  ${formatMb(after.external).padStart(10)}  ${formatMb(deltaExternal).padStart(10)}
`)
  })

  // -----------------------------------------------------------------------
  // Concurrency stress test
  // -----------------------------------------------------------------------
  await t.test("concurrent inference (3 parallel)", async () => {
    const images = benchmarkImages.slice(0, 3)
    const start = performance.now()
    const results = await Promise.all(images.map((img) => engine.infer(img)))
    const elapsed = performance.now() - start

    console.log(`
=== Concurrency Stress Test ===
3 concurrent inferences completed in ${formatMs(elapsed)}
Results: ${results.map((r) => `${r.predictionLabel} (${r.predictionConfidence})`).join(", ")}
`)

    assert.equal(results.length, 3)
    for (const r of results) {
      assert.ok(["rain_likely", "rain_unlikely"].includes(r.predictionLabel))
      assert.ok(r.predictionConfidence >= 0.5 && r.predictionConfidence <= 1.0)
    }
  })

  // -----------------------------------------------------------------------
  // Write results to JSON
  // -----------------------------------------------------------------------
  await t.test("write benchmark results to file", async () => {
    // Re-run a quick benchmark to capture final numbers
    const latencies = []
    for (const imagePath of benchmarkImages) {
      for (let run = 0; run < WARM_RUNS_PER_IMAGE; run++) {
        const start = performance.now()
        await engine.infer(imagePath)
        latencies.push(performance.now() - start)
      }
    }

    const sorted = [...latencies].sort((a, b) => a - b)
    const total = latencies.length
    const sum = latencies.reduce((a, b) => a + b, 0)
    const mean = sum / total

    const mem = process.memoryUsage()

    const results = {
      timestamp: new Date().toISOString(),
      platform: {
        arch: process.arch,
        platform: process.platform,
        nodeVersion: process.version,
        cpus: require("os").cpus().length,
        model: require("os").cpus()[0]?.model || "unknown",
        totalMemoryMb: Math.round(require("os").totalmem() / 1024 / 1024),
      },
      config: {
        modelPath: MODEL_PATH,
        datasetDir: DATASET_DIR,
        imageCount: benchmarkImages.length,
        runsPerImage: WARM_RUNS_PER_IMAGE,
        totalInferences: total,
        inputSize: `${config.ONNX_INPUT_WIDTH}x${config.ONNX_INPUT_HEIGHT}`,
        executionProviders: config.ONNX_EXECUTION_PROVIDERS,
      },
      latency: {
        meanMs: Number(mean.toFixed(2)),
        p50Ms: Number(percentile(sorted, 50).toFixed(2)),
        p95Ms: Number(percentile(sorted, 95).toFixed(2)),
        p99Ms: Number(percentile(sorted, 99).toFixed(2)),
        minMs: Number(sorted[0].toFixed(2)),
        maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
        throughputPerSec: Number((total / (sum / 1000)).toFixed(1)),
      },
      memory: {
        rssMb: Number((mem.rss / 1024 / 1024).toFixed(2)),
        heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
        externalMb: Number((mem.external / 1024 / 1024).toFixed(2)),
      },
    }

    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2))
    console.log(`\nBenchmark results written to ${RESULTS_FILE}`)
  })
})
"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const { mapScoresToPrediction } = require("../src/inference/onnx")

test("maps class index 1 to rain_likely", () => {
  const result = mapScoresToPrediction([0.2, 2.1], 0, 1)

  assert.equal(result.predictionLabel, "rain_likely")
  assert.equal(typeof result.predictionConfidence, "number")
  assert.equal(result.predictionConfidence > 0.5, true)
})

test("maps class index 0 to rain_unlikely", () => {
  const result = mapScoresToPrediction([3.4, 0.6], 0, 1)

  assert.equal(result.predictionLabel, "rain_unlikely")
  assert.equal(typeof result.predictionConfidence, "number")
  assert.equal(result.predictionConfidence > 0.5, true)
})

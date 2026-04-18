"use strict"

const { createServer } = require("./server")

async function main() {
  const runtime = createServer()
  await runtime.startServer()
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Failed to start orangepi-edge", error)
    process.exit(1)
  })
}

module.exports = {
  main,
}

"use strict"

const http = require("http")
const sharp = require("sharp")

const WIDTH = 640
const HEIGHT = 480
const STREAM_BOUNDARY = "frame"
const STREAM_INTERVAL_MS = 80

function getTimeParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const parts = {}

  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value
    }
  }

  return parts
}

function formatTimestamp(date = new Date(), timeZone = "Asia/Jakarta") {
  const parts = getTimeParts(date, timeZone)
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0")
  return `${parts.day}/${parts.month}/${parts.year} - ${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}`
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

async function createFrame(date = new Date(), timeZone = "Asia/Jakarta") {
  const timestamp = escapeXml(formatTimestamp(date, timeZone))
  const svg = `
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"
      xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#15263a"/>
          <stop offset="100%" stop-color="#406a77"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#background)"/>
      <rect x="74" y="204" width="492" height="72" rx="12" fill="#000" fill-opacity="0.62"/>
      <text x="320" y="249" text-anchor="middle"
        font-family="DejaVu Sans, Arial, sans-serif" font-size="28" font-weight="600"
        fill="#fff">${timestamp}</text>
    </svg>
  `

  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer()
}

function addCameraHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  res.setHeader("Cache-Control", "no-store")
}

function sendNotFound(res) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
  res.end("Not found")
}

function createEsp32CamSimulator({ port = 8081, timeZone = "Asia/Jakarta" } = {}) {
  const activeStreams = new Set()
  let server = null

  async function handleRequest(req, res) {
    const url = new URL(req.url || "/", "http://esp32cam.local")

    if (req.method === "OPTIONS") {
      addCameraHeaders(res)
      res.writeHead(200)
      res.end()
      return
    }

    if (req.method !== "GET") {
      sendNotFound(res)
      return
    }

    if (url.pathname === "/status") {
      addCameraHeaders(res)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        ok: true,
        ip: "127.0.0.1",
        ssid: "ESP32-CAM Simulator",
        wifi: "-42 dBm",
        framesize: "VGA",
        quality: 10,
      }))
      return
    }

    if (url.pathname === "/capture") {
      const frame = await createFrame(new Date(), timeZone)
      addCameraHeaders(res)
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "content-disposition": "inline; filename=esp32cam-capture.jpg",
        "content-length": frame.length,
      })
      res.end(frame)
      return
    }

    if (url.pathname === "/stream") {
      addCameraHeaders(res)
      res.writeHead(200, {
        "content-type": `multipart/x-mixed-replace;boundary=${STREAM_BOUNDARY}`,
      })
      activeStreams.add(res)

      let stopped = false
      const stop = () => {
        stopped = true
        activeStreams.delete(res)
      }
      req.once("close", stop)
      res.once("close", stop)

      while (!stopped && !res.destroyed) {
        const frame = await createFrame(new Date(), timeZone)
        const header =
          `\r\n--${STREAM_BOUNDARY}\r\n` +
          `Content-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
        res.write(header)
        res.write(frame)
        await new Promise((resolve) => setTimeout(resolve, STREAM_INTERVAL_MS))
      }
      return
    }

    sendNotFound(res)
  }

  async function start() {
    if (server) {
      return server
    }

    server = http.createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        console.error("[esp32cam-simulator] Request failed:", error)
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
        }
        res.end("Camera simulator failure")
      })
    })

    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject)
        resolve()
      })
    })

    const address = server.address()
    console.log(`[esp32cam-simulator] Running on http://127.0.0.1:${address.port}`)
    return server
  }

  async function close() {
    for (const response of activeStreams) {
      response.destroy()
    }
    activeStreams.clear()

    if (!server) {
      return
    }

    const currentServer = server
    server = null
    const closed = new Promise((resolve, reject) => {
      currentServer.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    currentServer.closeAllConnections()
    await closed
  }

  return {
    start,
    close,
  }
}

module.exports = {
  createEsp32CamSimulator,
  createFrame,
  formatTimestamp,
}

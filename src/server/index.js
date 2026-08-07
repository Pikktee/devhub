import http from 'node:http'
import { join } from 'node:path'
import { repoRoot } from '../paths.js'
import { serveStatic } from '../http/files.js'
import { routes } from './api.js'
import { timestamp } from '../util/fmt.js'

const UI_DIR = join(repoRoot, 'ui')

/**
 * Der Hub zeigt Regeln, Skills und Sitzungsspeicher an — das bleibt auf dieser
 * Maschine. Deshalb nur 127.0.0.1, und ein Host-Kopf, der auch dorthin zeigt
 * (sonst könnte eine fremde Seite per DNS-Rebinding hier anklopfen).
 */
function hostAllowed(req) {
  const host = (req.headers.host ?? '').split(':')[0].toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost')
}

function originAllowed(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const host = new URL(origin).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error('Anfrage zu groß'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('Ungültiges JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

export function createHub() {
  return http.createServer(async (req, res) => {
    if (!hostAllowed(req) || !originAllowed(req)) {
      return sendJson(res, 403, { error: 'Nur über localhost erreichbar' })
    }

    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname

    if (path.startsWith('/api/')) {
      const route = routes.find((r) => r.method === req.method && r.pattern.test(path))
      if (!route) return sendJson(res, 404, { error: `Keine Route für ${req.method} ${path}` })
      try {
        const params = path.match(route.pattern).slice(1).map(decodeURIComponent)
        const body = req.method === 'POST' ? await readBody(req) : {}
        const result = await route.handler(req, params, url.searchParams, body)
        return sendJson(res, 200, result)
      } catch (err) {
        console.error(`${timestamp()} devhub  ${req.method} ${path}: ${err.message}`)
        return sendJson(res, err.status ?? 500, { error: err.message })
      }
    }

    return serveStatic(req, res, UI_DIR, { spa: true })
  })
}

export function startHub({ port }) {
  const server = createHub()
  return new Promise((resolvePromise, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} ist belegt — läuft der Hub schon? "dev service status" zeigt es.`))
        return
      }
      reject(err)
    })
    server.listen(port, '127.0.0.1', () => {
      console.log(`${timestamp()} devhub  Übersicht auf http://localhost:${port}`)
      resolvePromise(server)
    })
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => {
        console.log(`${timestamp()} devhub  beendet sich — die Dev-Server laufen weiter`)
        server.close(() => process.exit(0))
      })
    }
  })
}

#!/usr/bin/env node
/**
 * Auslieferung eines statischen Ordners — der Ersatz für die verstreuten
 * `python3 -m http.server`-Einträge in den alten launch.json.
 */
import http from 'node:http'
import { serveStatic } from '../src/http/files.js'
import { timestamp } from '../src/util/fmt.js'

const [dir, portArg] = process.argv.slice(2)
const port = Number(portArg)

if (!dir || !Number.isInteger(port)) {
  console.error('Aufruf: static-serve.js <ordner> <port>')
  process.exit(2)
}

const server = http.createServer((req, res) => serveStatic(req, res, dir, { spa: false }))

server.on('error', (err) => {
  console.error(`${timestamp()} devhub  Auslieferung fehlgeschlagen: ${err.message}`)
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`${timestamp()} devhub  liefert ${dir} auf ${port} aus`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}

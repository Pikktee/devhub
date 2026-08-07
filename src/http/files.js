import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg'
}

export const contentType = (file) => TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'

/** Ein Pfad darf niemals aus dem ausgelieferten Ordner herausführen. */
export function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0])
  const target = resolve(join(root, normalize(decoded).replace(/^(\.\.[/\\])+/, '')))
  const rootResolved = resolve(root)
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) return null
  return target
}

export function serveFile(res, file, { cache = false } = {}) {
  let info
  try {
    info = statSync(file)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Nicht gefunden')
    return false
  }
  if (info.isDirectory()) return serveFile(res, join(file, 'index.html'), { cache })
  res.writeHead(200, {
    'content-type': contentType(file),
    'content-length': info.size,
    'cache-control': cache ? 'public, max-age=300' : 'no-store'
  })
  createReadStream(file).pipe(res)
  return true
}

export function serveStatic(req, res, root, { cache = false, spa = false } = {}) {
  const file = safeJoin(root, req.url ?? '/')
  if (!file) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Verboten')
    return
  }
  try {
    const info = statSync(file)
    if (info.isDirectory()) return void serveFile(res, join(file, 'index.html'), { cache })
    return void serveFile(res, file, { cache })
  } catch {
    if (spa) return void serveFile(res, join(root, 'index.html'), { cache })
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Nicht gefunden')
  }
}

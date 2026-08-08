import { closeSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { hubLogFile, logDir } from './paths.js'
import { logLine, openLog } from './runners/process.js'

/**
 * Kurzer, dauerhafter Verlauf für Adopt/Sync/Forget — lesbar im Hub-Log
 * und über die API. Kein Ersatz für Git; nur lokale Nachvollziehbarkeit.
 */
export function recordEvent({ type, project = '', summary, lines = [] }) {
  mkdirSync(logDir, { recursive: true })
  const stamp = new Date().toISOString()
  const fd = openLog(hubLogFile)
  try {
    logLine(fd, `${type}${project ? ` ${project}` : ''} — ${summary}`)
    for (const line of lines) logLine(fd, `  ${line}`)
  } finally {
    closeSync(fd)
  }
  return { at: stamp, type, project, summary }
}

export function readHubLogTail(maxLines = 120) {
  if (!existsSync(hubLogFile)) return { file: hubLogFile, lines: [] }
  const raw = readFileSync(hubLogFile, 'utf8')
  const lines = raw.split('\n').filter((l) => l.length)
  return { file: hubLogFile, lines: lines.slice(-Math.max(1, maxLines)) }
}

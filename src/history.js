import { closeSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hubLogFile, logDir } from './paths.js'
import { logLine, openLog } from './runners/process.js'

/**
 * Kurzer, dauerhafter Verlauf für Adopt/Sync/Forget - lesbar im Hub-Log
 * und über die API. Kein Ersatz für Git; nur lokale Nachvollziehbarkeit.
 */
export function recordEvent({ type, project = '', summary, lines = [] }) {
  mkdirSync(logDir, { recursive: true })
  const stamp = new Date().toISOString()
  const fd = openLog(hubLogFile)
  try {
    logLine(fd, `${type}${project ? ` ${project}` : ''} - ${summary}`)
    for (const line of lines) logLine(fd, `  ${line}`)
  } finally {
    closeSync(fd)
  }
  return { at: stamp, type, project, summary }
}

/**
 * Liest den Hub-Log vom Ende. Identische aufeinanderfolgende Zeilen (z. B.
 * launchd-Port-Spam) zählen als eine Gruppe - sonst verdecken sie den echten
 * Verlauf, wenn nur die letzten N Rohzeilen geliefert würden.
 */
export function readHubLogTail(maxGroups = 120) {
  if (!existsSync(hubLogFile)) {
    return { file: hubLogFile, lines: [], repeats: [], bytes: 0, totalLines: 0 }
  }
  const raw = readFileSync(hubLogFile, 'utf8')
  const all = raw.split('\n').filter((l) => l.length)
  const limit = Math.max(1, Number(maxGroups) || 120)
  const groups = []
  let i = all.length - 1
  while (i >= 0 && groups.length < limit) {
    const line = all[i]
    let count = 1
    while (i - count >= 0 && all[i - count] === line) count++
    groups.push({ line, count })
    i -= count
  }
  groups.reverse()
  return {
    file: hubLogFile,
    lines: groups.map((g) => g.line),
    repeats: groups.map((g) => g.count),
    bytes: Buffer.byteLength(raw),
    totalLines: all.length
  }
}

/** Leert die Hub-Logdatei und schreibt einen kurzen Hinweis. */
export function clearHubLog() {
  mkdirSync(logDir, { recursive: true })
  writeFileSync(hubLogFile, '')
  recordEvent({ type: 'settings', project: 'hub', summary: 'Verlauf geleert' })
  return { file: hubLogFile, cleared: true }
}

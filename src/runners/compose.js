import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { childEnv } from '../env.js'
import { logLine, openLog } from './process.js'

const run = promisify(execFile)

/**
 * Compose koppelt sich selbst ab — es gibt keine PID, die man behalten könnte.
 * Zustand kommt darum aus `docker compose ps`, nicht aus einer Datei.
 */
function args(file, rest) {
  return file ? ['compose', '-f', file, ...rest] : ['compose', ...rest]
}

export async function composeUp({ cwd, file, port, logFile, env = {} }) {
  const fd = openLog(logFile)
  logLine(fd, `docker compose up -d · PORT=${port}`)
  try {
    const { stdout, stderr } = await run('docker', args(file, ['up', '-d']), {
      cwd,
      env: childEnv({ ...env, PORT: String(port) }),
      timeout: 180000
    })
    if (stdout) logLine(fd, stdout.trim())
    if (stderr) logLine(fd, stderr.trim())
    return { ok: true }
  } catch (err) {
    logLine(fd, `Fehler: ${err.stderr?.trim() || err.message}`)
    throw new Error(`docker compose up fehlgeschlagen: ${err.stderr?.trim() || err.message}`)
  }
}

export async function composeDown({ cwd, file, logFile }) {
  const fd = openLog(logFile)
  logLine(fd, 'docker compose down')
  try {
    await run('docker', args(file, ['down']), { cwd, env: childEnv(), timeout: 120000 })
    return true
  } catch (err) {
    logLine(fd, `Fehler: ${err.stderr?.trim() || err.message}`)
    return false
  }
}

export async function composeServices({ cwd, file }) {
  try {
    const { stdout } = await run('docker', args(file, ['ps', '--format', 'json']), {
      cwd,
      env: childEnv(),
      timeout: 20000
    })
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

export async function dockerAvailable() {
  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 8000 })
    return true
  } catch {
    return false
  }
}

import { spawn } from 'node:child_process'
import { mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { timestamp } from '../util/fmt.js'
import { childEnv, substituteAll } from '../env.js'

export function logLine(fd, text) {
  writeSync(fd, `${timestamp()} devhub  ${text}\n`)
}

export function openLog(file) {
  mkdirSync(dirname(file), { recursive: true })
  return openSync(file, 'a')
}

/**
 * Abgekoppelt starten heißt: eigene Prozessgruppe (`detached`), kein offener
 * Kanal zum Elternprozess (`unref`), Ausgabe in eine Datei. Nur so überlebt der
 * Server das Beenden der Shell, der IDE oder des Agenten, der ihn angestoßen hat.
 */
export function startProcess({ spec, cwd, port, vars, logFile }) {
  const fd = openLog(logFile)
  const cmd = substituteAll(spec.cmd, vars)
  if (!cmd.length) throw new Error(`Prozess "${spec.name}" hat kein Kommando`)
  const env = childEnv(substituteAll(spec.env, vars))

  logLine(fd, `Port ${port} frei — starte ${cmd.join(' ')}`)
  logLine(fd, `cwd ${cwd} · abgekoppelt`)

  const child = spawn(cmd[0], cmd.slice(1), {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', fd, fd]
  })

  if (!child.pid) throw new Error(`Prozess "${spec.name}" konnte nicht gestartet werden`)
  child.unref()
  logLine(fd, `PID ${child.pid} · Gruppe ${child.pid}`)

  return { pid: child.pid, pgid: child.pid, logFile, fd, cmd }
}

/**
 * Gestoppt wird die Gruppe, nicht der Prozess: bei `npm run dev` → `node vite`
 * überlebt das Kind sonst den Elternprozess und hält den Port besetzt.
 */
export async function stopGroup(pgid, { graceMs = 5000 } = {}) {
  if (!pgid) return false
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch (err) {
    if (err.code === 'ESRCH') return false
    if (err.code !== 'EPERM') throw err
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    try {
      process.kill(-pgid, 0)
    } catch {
      return true
    }
  }
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    /* schon weg */
  }
  return true
}

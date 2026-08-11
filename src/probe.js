import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

function probeHost(port, host, timeout) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (result) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** Belegt heißt: jemand nimmt eine TCP-Verbindung an. Eine PID-Datei zu einem
 *  toten Prozess ist die häufigste Lüge in solchen Werkzeugen.
 *  Vite (und andere) lauschen auf macOS oft nur auf ::1 - 127.0.0.1 allein
 *  würde sie als „frei“ und „nicht bereit“ missverstehen. */
export async function probePort(port, { hosts = ['127.0.0.1', '::1'], timeout = 400 } = {}) {
  const list = Array.isArray(hosts) ? hosts : [hosts]
  const results = await Promise.all(list.map((host) => probeHost(port, host, timeout)))
  return results.some(Boolean)
}

async function lsof(args) {
  try {
    const { stdout } = await run('lsof', args, { timeout: 5000 })
    return stdout
  } catch (err) {
    // lsof beendet sich mit 1, wenn nichts passt - das ist kein Fehler.
    return err.stdout ?? ''
  }
}

function parseLsof(stdout) {
  const rows = []
  for (const line of stdout.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 8) continue
    // Die Adresse steht vor dem abschließenden "(LISTEN)", nicht am Zeilenende.
    const port = Number(line.match(/:(\d+)\s+\(LISTEN\)\s*$/)?.[1] ?? line.match(/:(\d+)\s*$/)?.[1])
    rows.push({ command: parts[0], pid: Number(parts[1]), port: Number.isFinite(port) ? port : undefined })
  }
  return rows
}

export async function listenerOn(port) {
  const rows = parseLsof(await lsof(['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']))
  return rows[0] ?? null
}

/**
 * `lsof -g` liefert auf macOS nichts Verlässliches - die Mitglieder der Gruppe
 * kommen darum aus `ps`, und erst danach wird nach offenen Ports gefragt.
 */
export async function groupMembers(pgid) {
  try {
    const { stdout } = await run('ps', ['-Ao', 'pid=,pgid=,rss='], { timeout: 5000 })
    return stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, group]) => Number.isFinite(pid) && group === Number(pgid))
      .map(([pid, , rss]) => ({ pid, rss: rss * 1024 }))
  } catch {
    return []
  }
}

/** Nach dem Start: lauscht die Prozessgruppe wirklich auf der zugewiesenen
 *  Nummer - oder ist Next.js still ausgewichen? */
export async function listeningPortsOfGroup(pgid) {
  const members = await groupMembers(pgid)
  if (!members.length) return []
  const rows = parseLsof(await lsof(['-nP', '-a', '-p', members.map((m) => m.pid).join(','), '-iTCP', '-sTCP:LISTEN']))
  return [...new Set(rows.map((r) => r.port).filter(Boolean))]
}

export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

export async function memoryOfGroup(pgid) {
  const members = await groupMembers(pgid)
  return members.reduce((sum, member) => sum + member.rss, 0)
}

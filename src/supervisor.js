import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { logDir, repoRoot, stateDir } from './paths.js'
import * as registryStore from './registry.js'
import * as stateStore from './state.js'
import { describeProject, projectNameForPath, resolveProject } from './discovery.js'
import { hostFor, portFor, urlFor, urlForRole, worktreePortFor } from './ports.js'
import { listWorktrees } from './git.js'
import { copyWorktreeData, missingPreparation } from './worktree.js'
import { bindHostFor, networkHostFor } from './net.js'
import { isAlive, listenerOn, listeningPortsOfGroup, memoryOfGroup, ownsGroup, probePort, startTimeOf } from './probe.js'
import { logLine, openLog, startProcess, stopGroup } from './runners/process.js'
import { composeDown, composeServices, composeUp, dockerAvailable } from './runners/compose.js'

/** Ein `/` im Namen führte aus dem Log-Ordner hinaus - er wird zum Teil des Dateinamens. */
const fileSafe = (part) => String(part).replaceAll('/', '%2F')
export const logFileFor = (project, profile, proc) => join(logDir, `${fileSafe(project)}-${fileSafe(profile)}-${fileSafe(proc)}.log`)

function requireInstance(registry, name, profile) {
  const project = describeProject(registry, name)
  if (!project) throw new Error(`Projekt "${name}" ist unbekannt`)
  if (!project.adopted) {
    throw new Error(`"${name}" ist nicht aufgenommen - "devhub adopt ${name}" vergibt einen Slot`)
  }
  const slot = profile === 'default' ? project.slot : project.profileSlots[profile]
  if (slot === undefined) {
    throw new Error(`Profil "${profile}" von ${name} hat keinen Slot - "devhub adopt ${name} --profil ${profile}"`)
  }
  const specs = project.profiles[profile]
  if (!specs?.length) {
    const known = Object.keys(project.profiles).join(', ') || 'keine'
    throw new Error(`${name} hat kein Profil "${profile}" (vorhanden: ${known})`)
  }
  return { project, slot, specs }
}

function varsFor({ project, profile, spec, port, registry, slot }) {
  const suffix = registry.settings.domainSuffix
  const label = project.hostLabel || project.displayName || project.name
  const bank = project.worktree ? worktreePortFor : portFor
  const frontendPort = bank(slot, 'frontend')
  const backendPort = bank(slot, 'backend')
  return {
    port,
    frontendPort,
    backendPort,
    portFrontend: frontendPort,
    portBackend: backendPort,
    projekt: project.name,
    project: project.name,
    profil: profile,
    profile,
    host: hostFor(label, profile, suffix),
    bindHost: bindHostFor(registry.settings),
    url: urlForRole(spec.role, label, profile, port, suffix),
    frontendUrl: urlFor(label, profile, frontendPort, suffix),
    // Im Netzmodus läuft die Seite in einem fremden Browser - dort wäre
    // 127.0.0.1 das Gerät des Betrachters, nicht dieser Rechner.
    backendUrl: `http://${networkHostFor(registry.settings) ?? '127.0.0.1'}:${backendPort}`,
    rolle: spec.role,
    role: spec.role,
    pfad: project.path,
    path: project.path
  }
}

async function waitReady({ port, pid, timeoutMs, onTick }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probePort(port)) return { ready: true }
    if (pid && !isAlive(pid)) return { ready: false, reason: 'beendet' }
    onTick?.()
    await new Promise((r) => setTimeout(r, 300))
  }
  return { ready: false, reason: 'zeitüberschreitung' }
}

/**
 * Der Netzmodus behauptet nichts, er misst: lauscht der Port auch auf der
 * Adresse im LAN? Ein Server, der nur auf Loopback hört, ist vom Handy aus
 * nicht erreichbar - das soll im Log stehen, nicht erst im Browser auffallen.
 */
async function noteNetwork(proc, host, fd) {
  if (!host || !proc.port) return
  proc.networkUrl = `http://${host}:${proc.port}`
  proc.networkListening = await probePort(proc.port, { hosts: [host] })
  logLine(
    fd,
    proc.networkListening
      ? `im Netz erreichbar unter ${proc.networkUrl}`
      : `nur lokal erreichbar - lauscht nicht auf ${host} (Startkommando ohne Host-Bindung?)`
  )
}

export function tailLog(file, lines = 12) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-lines)
  } catch {
    return []
  }
}

/** Backend vor Frontend starten - Login braucht die API, sobald die UI offen ist. */
function startOrder(specs) {
  const rank = (role) => (role === 'backend' ? 0 : role === 'frontend' ? 1 : 2)
  return [...specs].sort((a, b) => rank(a.role) - rank(b.role))
}

/** Worktrees laufen immer nur lokal, auch wenn die Netz-Freigabe an ist. */
function settingsFor(project, registry) {
  if (!project.worktree) return registry
  return { ...registry, settings: { ...registry.settings, networkAccess: false } }
}

/**
 * Pro Instanz darf nur ein Start oder Stopp gleichzeitig laufen: CLI und Mod
 * (über den Hub) messen sonst beide „Port frei“ und starten zweimal.
 */
function instanceLock(name, profile, fn) {
  const file = join(stateDir, 'locks', `${encodeURIComponent(name)}~${encodeURIComponent(profile)}.lock`)
  // Ein Start wartet bis zum Bereitschafts-Timeout - die Sperre darf so lange nicht als verwaist gelten.
  return registryStore.withLock(fn, { file, timeoutMs: 15 * 60000, staleMs: 15 * 60000 })
}

export function up(name, options = {}) {
  return instanceLock(name, options.profile ?? 'default', () => upUnlocked(name, options))
}

export function down(name, options = {}) {
  return instanceLock(name, options.profile ?? 'default', () => downUnlocked(name, options))
}

async function upUnlocked(name, { profile = 'default', registry = registryStore.load(), data = false } = {}) {
  const { project, slot, specs } = requireInstance(registry, name, profile)
  registry = settingsFor(project, registry)

  let copiedData = null
  if (project.worktree) {
    if (specs.some((s) => s.runner === 'compose')) {
      throw new Error('Compose-Projekte lassen sich als Worktree noch nicht starten - feste Ports in der Compose-Datei kollidierten mit dem Hauptprojekt')
    }
    const steps = missingPreparation(project, specs)
    if (steps.length) {
      const shared = steps.some((step) => step.includes(' ln -s '))
      throw new Error(
        [
          'Der Worktree ist noch nicht vorbereitet. devhub richtet ihn nicht selbst ein - einmal ausführen:',
          ...steps.map((step) => `  ${step}`),
          `danach im Worktree erneut: devhub up .${data ? ' --daten' : ''}`,
          ...(shared
            ? ['Die .env wird so mit dem Hauptprojekt geteilt. Werte, die abweichen müssen (Datenbank, eigene Adresse), gehören in devhub.json unter worktree.env.']
            : [])
        ].join('\n')
      )
    }
    if (data) {
      // Eine laufende Instanz hält die Datenbank offen - vorher stoppen.
      await downUnlocked(name, { profile, registry })
      copiedData = await copyWorktreeData(project)
    }
  } else if (data) {
    throw new Error('--daten gilt nur für Worktrees')
  }

  const recorded = stateStore.get(name, profile)
  const warnings = []
  const started = []
  const kept = []

  const ownedPid = (procName) => recorded?.processes?.find((p) => p.name === procName)

  for (const spec of startOrder(specs)) {
    const previous = ownedPid(spec.name)
    const busy = await probePort(spec.port)

    if (busy) {
      if (previous && (previous.runner === 'compose' || isAlive(previous.pid))) {
        kept.push({ ...spec, ...previous })
        continue
      }
      const listener = await listenerOn(spec.port)
      throw new Error(
        `Port ${spec.port} (${name}/${spec.name}) ist belegt von ${listener?.command ?? 'unbekannt'}` +
          `${listener?.pid ? ` (PID ${listener.pid})` : ''} - der Hub startet nichts auf einer fremden Nummer`
      )
    }

    const cwd = resolve(project.path, spec.cwd ?? '.')
    if (!existsSync(cwd)) throw new Error(`Arbeitsverzeichnis ${cwd} existiert nicht`)
    const logFile = logFileFor(name, profile, spec.name)
    const vars = varsFor({ project, profile, spec, port: spec.port, registry, slot })

    if (spec.runner === 'compose') {
      if (!(await dockerAvailable())) throw new Error('Docker antwortet nicht - Docker Desktop starten')
      await composeUp({ cwd, file: spec.composeFile, port: spec.port, logFile, env: spec.env })
      started.push({ name: spec.name, role: spec.role, port: spec.port, runner: 'compose', cwd, logFile, url: spec.url })
      continue
    }

    const effective =
      spec.runner === 'static'
        ? {
            ...spec,
            cmd: [process.execPath, join(repoRoot, 'bin', 'static-serve.js'), resolve(project.path, spec.dir ?? '.'), '{port}']
          }
        : spec

    const proc = startProcess({ spec: effective, cwd, port: spec.port, vars, logFile })
    started.push({
      name: spec.name,
      role: spec.role,
      port: spec.port,
      runner: spec.runner,
      pid: proc.pid,
      pgid: proc.pgid,
      started: await startTimeOf(proc.pid),
      cwd,
      logFile,
      url: spec.url,
      cmd: proc.cmd
    })
  }

  const networkHost = networkHostFor(registry.settings)
  for (const proc of started) {
    const timeoutMs = registry.settings.readyTimeoutMs ?? 60000
    const result = await waitReady({ port: proc.port, pid: proc.pid, timeoutMs })
    const fd = openLog(proc.logFile)

    if (result.ready) {
      logLine(fd, `✓ lauscht auf ${proc.port} - wie zugewiesen`)
      logLine(fd, `erreichbar unter ${proc.url}`)
      proc.ready = true
      await noteNetwork(proc, networkHost, fd)
      continue
    }

    proc.ready = false
    // Next.js kann das Ausweichen nicht abschalten. Wenn die Gruppe auf einer
    // anderen Nummer lauscht, ist genau das passiert - und ein zweiter Server
    // wäre die Folge, die dieses Werkzeug verhindern soll.
    const listening = proc.pgid ? await listeningPortsOfGroup(proc.pgid) : []
    if (listening.includes(proc.port)) {
      // Probe hat den Port verfehlt (z. B. nur ::1), der Prozess lauscht aber richtig.
      logLine(fd, `✓ lauscht auf ${proc.port} - wie zugewiesen`)
      logLine(fd, `erreichbar unter ${proc.url}`)
      proc.ready = true
      await noteNetwork(proc, networkHost, fd)
      continue
    }
    const drifted = listening.filter((p) => p !== proc.port)
    if (drifted.length) {
      logLine(fd, `! auf ${drifted.join(', ')} ausgewichen statt ${proc.port} - gestoppt`)
      await stopGroup(proc.pgid)
      warnings.push(
        `${name}/${proc.name} ist auf ${drifted.join(', ')} ausgewichen statt ${proc.port} - Startkommando in devhub.json fixieren`
      )
    } else {
      logLine(fd, `! nicht bereit (${result.reason}) - siehe Log`)
      warnings.push(
        `${name}/${proc.name} wurde nicht bereit (${result.reason}). Letzte Zeilen:\n  ${tailLog(proc.logFile, 6).join('\n  ')}`
      )
      if (proc.pgid) await stopGroup(proc.pgid)
    }
  }

  const processes = [...kept, ...started.filter((p) => p.ready !== false)]
  if (processes.length) {
    stateStore.put(name, profile, {
      project: name,
      profile,
      slot,
      path: project.path,
      startedAt: recorded?.startedAt && kept.length ? recorded.startedAt : new Date().toISOString(),
      processes
    })
  } else {
    stateStore.drop(name, profile)
  }

  return {
    ok: warnings.length === 0,
    changed: started.length > 0,
    project: name,
    profile,
    processes,
    kept: kept.map((p) => p.name),
    data: copiedData,
    warnings
  }
}

async function downUnlocked(name, { profile = 'default', registry = registryStore.load() } = {}) {
  const recorded = stateStore.get(name, profile)
  const project = describeProject(registry, name)
  const stopped = []
  const remaining = []

  for (const proc of recorded?.processes ?? []) {
    if (proc.runner === 'compose') {
      await composeDown({ cwd: proc.cwd, file: proc.composeFile, logFile: proc.logFile })
      stopped.push(proc.name)
      continue
    }
    if (!(await ownsGroup(proc))) {
      // Vermerkt, aber nicht mehr unsere Gruppe (Neustart, PID neu vergeben): nur austragen.
      if (isAlive(proc.pgid ?? proc.pid)) remaining.push(`${proc.name}: Gruppe ${proc.pgid ?? proc.pid} gehört nicht mehr zu devhub - nicht beendet`)
      continue
    }
    await stopGroup(proc.pgid ?? proc.pid)
    stopped.push(proc.name)
  }

  // Nachsehen statt glauben: hält noch etwas den Port?
  for (const proc of recorded?.processes ?? []) {
    if (await probePort(proc.port)) {
      const listener = await listenerOn(proc.port)
      remaining.push(`${proc.port} ist weiterhin belegt von ${listener?.command ?? 'unbekannt'} (PID ${listener?.pid ?? '?'})`)
    }
  }

  stateStore.drop(name, profile)
  return { ok: remaining.length === 0, project: name, profile, stopped, warnings: remaining, known: Boolean(recorded), path: project?.path }
}

export function restart(name, options = {}) {
  return instanceLock(name, options.profile ?? 'default', async () => {
    await downUnlocked(name, options)
    return upUnlocked(name, options)
  })
}

function hostOf(url) {
  try {
    return url ? new URL(url).hostname : null
  } catch {
    return null
  }
}

export async function instanceStatus(project, profile, recorded, { withMemory = false } = {}) {
  const specs = project.profiles[profile] ?? []
  const processes = []
  for (const spec of specs) {
    const rec = recorded?.processes?.find((p) => p.name === spec.name)
    const listening = spec.port ? await probePort(spec.port) : false
    const alive = rec?.pid ? isAlive(rec.pid) : rec?.runner === 'compose' ? listening : false
    const networkHost = hostOf(spec.networkUrl)
    processes.push({
      name: spec.name,
      role: spec.role,
      runner: spec.runner,
      port: spec.port,
      url: spec.url,
      networkUrl: spec.networkUrl,
      networkListening: listening && networkHost ? await probePort(spec.port, { hosts: [networkHost] }) : false,
      paths: spec.paths,
      pid: rec?.pid,
      pgid: rec?.pgid,
      logFile: rec?.logFile ?? (project.name ? logFileFor(project.name, profile, spec.name) : undefined),
      listening,
      alive,
      memory: withMemory && rec?.pgid && alive ? await memoryOfGroup(rec.pgid) : 0,
      foreign: listening && !rec
    })
  }
  const listeningCount = processes.filter((p) => p.listening).length
  const state =
    listeningCount === 0 ? 'gestoppt' : listeningCount === processes.length ? 'läuft' : 'teilweise'
  return {
    project: project.name,
    profile,
    state,
    startedAt: recorded?.startedAt,
    processes
  }
}

export async function statusOf(registry, name, { withMemory = false } = {}) {
  const project = describeProject(registry, name)
  if (!project) return null
  const profiles = []
  for (const profile of Object.keys(project.profiles)) {
    profiles.push(await instanceStatus(project, profile, stateStore.get(name, profile), { withMemory }))
  }
  return { project, profiles }
}

export async function composeDetail(project, spec) {
  return composeServices({ cwd: resolve(project.path, spec.cwd ?? '.'), file: spec.composeFile })
}

async function slotBusy(slot) {
  return (await probePort(worktreePortFor(slot, 'frontend'))) || (await probePort(worktreePortFor(slot, 'backend')))
}

/**
 * Nimmt einen Worktree auf (oder findet seine bestehende Aufnahme) und liefert
 * den Instanznamen `projekt@label`. `info` kommt aus `worktreeInfo()`.
 */
export async function registerWorktree(info) {
  return registryStore.withLock(async () => {
    const registry = registryStore.load()
    // Eine selbst gebaute .git-Datei, die aufs echte Repo zeigt, ist kein Worktree:
    // git kennt ihn nicht, und das Aufräumen würde ihn sofort wieder stoppen.
    if (!listWorktrees(info.mainPath).some((w) => w.path === info.root && !w.missing)) {
      throw new Error(`${info.root} ist in "git worktree list" von ${info.mainPath} nicht eingetragen`)
    }
    const project = projectNameForPath(registry, info.mainPath)
    if (!project) {
      throw new Error(`Das Hauptprojekt ${info.mainPath} liegt in keinem Wurzelverzeichnis von devhub`)
    }
    const { name, created } = await registryStore.allocateWorktree(
      registry,
      { project, path: info.root, branch: info.branch, folder: info.folder },
      { isBusy: slotBusy }
    )
    if (created) registryStore.save(registry, { worktrees: true })
    return name
  })
}

/** Ein nicht eingehängtes Volume ist kein gelöschter Worktree. */
function onMissingVolume(path) {
  const match = path.match(/^\/Volumes\/[^/]+/)
  return Boolean(match) && !existsSync(match[0])
}

function staleWorktrees(registry) {
  return Object.entries(registry.worktrees ?? {})
    .filter(([, entry]) => {
      const mainPath = registry.projects[entry.project]?.path ?? resolveProject(registry, entry.project)?.path
      if (!mainPath || !existsSync(mainPath)) return false
      if (onMissingVolume(entry.path)) return false
      if (!existsSync(entry.path)) return true
      return !listWorktrees(mainPath).some((w) => w.path === entry.path && !w.missing)
    })
    .map(([name]) => name)
}

/**
 * Verschwundene Worktrees abräumen: Prozessgruppe stoppen, Platz freigeben.
 * Läuft bei status, up und in der Übersicht statt in einer Schleife; ohne
 * Fund wird weder gesperrt noch geschrieben.
 */
export async function pruneWorktrees({ registry = registryStore.load() } = {}) {
  if (!staleWorktrees(registry).length) return []
  // Unter der Sperre nur austragen; das Stoppen dauert und braucht sie nicht.
  const stale = await registryStore.withLock(async () => {
    const fresh = registryStore.load()
    const found = staleWorktrees(fresh)
    for (const name of found) registryStore.removeWorktree(fresh, name)
    if (found.length) registryStore.save(fresh, { worktrees: true })
    return found
  })
  for (const name of stale) await down(name, { registry })
  return stale
}

export async function downAll({ registry = registryStore.load() } = {}) {
  const results = []
  for (const instance of stateStore.all()) {
    results.push(await down(instance.project, { profile: instance.profile, registry }))
  }
  return results
}

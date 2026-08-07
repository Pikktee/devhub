import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { logDir, repoRoot } from './paths.js'
import * as registryStore from './registry.js'
import * as stateStore from './state.js'
import { describeProject } from './discovery.js'
import { hostFor, portFor, urlFor } from './ports.js'
import { isAlive, listenerOn, listeningPortsOfGroup, memoryOfGroup, probePort } from './probe.js'
import { logLine, openLog, startProcess, stopGroup } from './runners/process.js'
import { composeDown, composeServices, composeUp, dockerAvailable } from './runners/compose.js'

export const logFileFor = (project, profile, proc) => join(logDir, `${project}-${profile}-${proc}.log`)

function requireInstance(registry, name, profile) {
  const project = describeProject(registry, name)
  if (!project) throw new Error(`Projekt "${name}" ist unbekannt`)
  if (!project.adopted) {
    throw new Error(`"${name}" ist nicht aufgenommen — "dev adopt ${name}" vergibt einen Slot`)
  }
  const slot = profile === 'default' ? project.slot : project.profileSlots[profile]
  if (slot === undefined) {
    throw new Error(`Profil "${profile}" von ${name} hat keinen Slot — "dev adopt ${name} --profil ${profile}"`)
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
  const frontendPort = portFor(slot, 'frontend')
  const backendPort = portFor(slot, 'backend')
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
    url: urlFor(label, profile, port, suffix),
    frontendUrl: urlFor(label, profile, frontendPort, suffix),
    backendUrl: `http://127.0.0.1:${backendPort}`,
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

export function tailLog(file, lines = 12) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-lines)
  } catch {
    return []
  }
}

/** Backend vor Frontend starten — Login braucht die API, sobald die UI offen ist. */
function startOrder(specs) {
  const rank = (role) => (role === 'backend' ? 0 : role === 'frontend' ? 1 : 2)
  return [...specs].sort((a, b) => rank(a.role) - rank(b.role))
}

export async function up(name, { profile = 'default', registry = registryStore.load() } = {}) {
  const { project, slot, specs } = requireInstance(registry, name, profile)
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
          `${listener?.pid ? ` (PID ${listener.pid})` : ''} — der Hub startet nichts auf einer fremden Nummer`
      )
    }

    const cwd = resolve(project.path, spec.cwd ?? '.')
    if (!existsSync(cwd)) throw new Error(`Arbeitsverzeichnis ${cwd} existiert nicht`)
    const logFile = logFileFor(name, profile, spec.name)
    const vars = varsFor({ project, profile, spec, port: spec.port, registry, slot })

    if (spec.runner === 'compose') {
      if (!(await dockerAvailable())) throw new Error('Docker antwortet nicht — Docker Desktop starten')
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
      cwd,
      logFile,
      url: spec.url,
      cmd: proc.cmd
    })
  }

  for (const proc of started) {
    const timeoutMs = registry.settings.readyTimeoutMs ?? 60000
    const result = await waitReady({ port: proc.port, pid: proc.pid, timeoutMs })
    const fd = openLog(proc.logFile)

    if (result.ready) {
      logLine(fd, `✓ lauscht auf ${proc.port} — wie zugewiesen`)
      logLine(fd, `erreichbar unter ${proc.url}`)
      proc.ready = true
      continue
    }

    proc.ready = false
    // Next.js kann das Ausweichen nicht abschalten. Wenn die Gruppe auf einer
    // anderen Nummer lauscht, ist genau das passiert — und ein zweiter Server
    // wäre die Folge, die dieses Werkzeug verhindern soll.
    const listening = proc.pgid ? await listeningPortsOfGroup(proc.pgid) : []
    if (listening.includes(proc.port)) {
      // Probe hat den Port verfehlt (z. B. nur ::1), der Prozess lauscht aber richtig.
      logLine(fd, `✓ lauscht auf ${proc.port} — wie zugewiesen`)
      logLine(fd, `erreichbar unter ${proc.url}`)
      proc.ready = true
      continue
    }
    const drifted = listening.filter((p) => p !== proc.port)
    if (drifted.length) {
      logLine(fd, `! auf ${drifted.join(', ')} ausgewichen statt ${proc.port} — gestoppt`)
      await stopGroup(proc.pgid)
      warnings.push(
        `${name}/${proc.name} ist auf ${drifted.join(', ')} ausgewichen statt ${proc.port} — Startkommando in dev.json fixieren`
      )
    } else {
      logLine(fd, `! nicht bereit (${result.reason}) — siehe Log`)
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
    warnings
  }
}

export async function down(name, { profile = 'default', registry = registryStore.load() } = {}) {
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

export async function restart(name, options = {}) {
  await down(name, options)
  return up(name, options)
}

export async function instanceStatus(project, profile, recorded, { withMemory = false } = {}) {
  const specs = project.profiles[profile] ?? []
  const processes = []
  for (const spec of specs) {
    const rec = recorded?.processes?.find((p) => p.name === spec.name)
    const listening = spec.port ? await probePort(spec.port) : false
    const alive = rec?.pid ? isAlive(rec.pid) : rec?.runner === 'compose' ? listening : false
    processes.push({
      name: spec.name,
      role: spec.role,
      runner: spec.runner,
      port: spec.port,
      url: spec.url,
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

export async function downAll({ registry = registryStore.load() } = {}) {
  const results = []
  for (const instance of stateStore.all()) {
    results.push(await down(instance.project, { profile: instance.profile, registry }))
  }
  return results
}

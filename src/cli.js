import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as registryStore from './registry.js'
import * as stateStore from './state.js'
import { describeProject, listProjects, scanRoots } from './discovery.js'
import { down, downAll, logFileFor, restart, statusOf, tailLog, up } from './supervisor.js'
import { listenerOn, probePort } from './probe.js'
import { agentContext, readAgentFile } from './agents.js'
import { inspectLink, linkRuleFiles } from './adapters/link.js'
import { syncAll, syncGlobal, unsyncProject } from './sync.js'
import { cleanProjectArtifacts } from './clean.js'
import { installService, serviceStatus, uninstallService } from './service.js'
import { startHub } from './server/index.js'
import { color, dateTime, duration, table } from './util/fmt.js'
import { portFor } from './ports.js'

const ALIASES = {
  profil: 'profile',
  alle: 'all',
  projekt: 'project',
  prozess: 'process',
  slot: 'slot',
  'profil-slot': 'profileSlot',
  folgen: 'follow',
  zeilen: 'lines',
  probelauf: 'dryRun',
  'trocken': 'dryRun',
  'dry-run': 'dryRun',
  global: 'global',
  'ohne-global': 'noGlobal',
  hook: 'hook',
  port: 'port',
  datei: 'file',
  richtung: 'direction',
  finder: 'finder',
  ordner: 'finder',
  'dateien-behalten': 'keepFiles',
  'keep-files': 'keepFiles',
  'deps-loeschen': 'cleanDeps',
  'clean-deps': 'cleanDeps',
  titel: 'displayName',
  title: 'displayName',
  anzeigename: 'displayName',
  aus: 'off',
  f: 'follow',
  n: 'lines',
  p: 'profile'
}

const BOOLEAN_FLAGS = new Set(['all', 'follow', 'dryRun', 'global', 'noGlobal', 'hook', 'json', 'help', 'finder', 'on', 'off', 'keepFiles', 'cleanDeps'])

export function parseArgs(argv) {
  const positionals = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('-')) {
      positionals.push(token)
      continue
    }
    const raw = token.replace(/^--?/, '')
    const [key, inlineValue] = raw.split('=')
    const name = ALIASES[key] ?? key
    if (inlineValue !== undefined) {
      flags[name] = inlineValue
      continue
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('-')) {
      flags[name] = true
      continue
    }
    flags[name] = next
    i++
  }
  return { positionals, flags }
}

const dot = (state) =>
  state === 'läuft' ? color.green('●') : state === 'teilweise' ? color.yellow('●') : color.dim('○')

function fail(message) {
  console.error(color.red('Fehler: ') + message)
  process.exitCode = 1
}

function resolveName(registry, given) {
  if (given) return given
  const here = basename(process.cwd())
  if (registry.projects[here] || scanRoots(registry.settings.roots).some((p) => p.name === here)) return here
  return null
}

// ---------------------------------------------------------------- status

async function cmdStatus(positionals, flags) {
  const registry = registryStore.load()
  const only = positionals[0]
  const names = only ? [only] : Object.keys(registry.projects)

  if (!names.length) {
    console.log('Noch kein Projekt aufgenommen. "dev list" zeigt die Kandidaten, "dev adopt <projekt>" vergibt einen Slot.')
    return
  }

  const rows = []
  let running = 0
  for (const name of names.sort((a, b) => a.localeCompare(b, 'de'))) {
    const status = await statusOf(registry, name, { withMemory: Boolean(flags.all) })
    if (!status) {
      rows.push([color.dim('○'), name, color.dim('—'), color.red('nicht gefunden'), '', ''])
      continue
    }
    for (const profile of status.profiles) {
      if (profile.state === 'läuft') running++
      const ports = profile.processes.map((p) => p.port ?? '—').join(' · ')
      const address = profile.processes[0]?.url ?? '—'
      const since = profile.startedAt ? duration(Date.now() - new Date(profile.startedAt)) : '—'
      rows.push([
        dot(profile.state),
        name,
        profile.profile === 'default' ? color.dim('default') : profile.profile,
        profile.state,
        profile.state === 'gestoppt' ? color.dim(address) : color.blue(address),
        ports,
        profile.state === 'gestoppt' ? color.dim('—') : since
      ])
    }
  }

  console.log(table(rows, { head: ['', 'PROJEKT', 'PROFIL', 'ZUSTAND', 'ADRESSE', 'PORTS', 'SEIT'] }))
  if (!only) console.log(color.dim(`\n${names.length} aufgenommen · ${running} laufen`))
}

// ---------------------------------------------------------------- up/down

async function cmdUp(positionals, flags) {
  const registry = registryStore.load()
  const name = resolveName(registry, positionals[0])
  if (!name) return fail('Kein Projekt angegeben und das aktuelle Verzeichnis ist keins.')
  const profile = flags.profile ?? 'default'

  const result = await up(name, { profile, registry })
  if (!result.changed && result.processes.length) {
    console.log(`${color.dim('○')} ${name}/${profile} läuft bereits — nichts zu tun`)
  }
  for (const proc of result.processes) {
    if (proc.ready === false) continue
    console.log(`${color.green('●')} ${name}/${proc.name} → ${color.blue(proc.url)}`)
  }
  for (const warning of result.warnings) console.warn(color.yellow('! ') + warning)
  if (result.warnings.length) process.exitCode = 1
}

async function cmdDown(positionals, flags) {
  const registry = registryStore.load()
  if (flags.all) {
    const results = await downAll({ registry })
    if (!results.length) return console.log('Es läuft nichts.')
    for (const result of results) console.log(`${color.dim('○')} ${result.project}/${result.profile} gestoppt`)
    return
  }
  const name = resolveName(registry, positionals[0])
  if (!name) return fail('Kein Projekt angegeben. "dev down --alle" stoppt alles.')
  const result = await down(name, { profile: flags.profile ?? 'default', registry })
  if (!result.known) return console.log(`${name}/${flags.profile ?? 'default'} war nicht als laufend vermerkt.`)
  console.log(`${color.dim('○')} ${name}/${result.profile} gestoppt (${result.stopped.join(', ') || 'nichts'})`)
  for (const warning of result.warnings) console.warn(color.yellow('! ') + warning)
}

async function cmdRestart(positionals, flags) {
  const registry = registryStore.load()
  const name = resolveName(registry, positionals[0])
  if (!name) return fail('Kein Projekt angegeben.')
  const result = await restart(name, { profile: flags.profile ?? 'default', registry })
  for (const proc of result.processes) console.log(`${color.green('●')} ${name}/${proc.name} → ${color.blue(proc.url)}`)
  for (const warning of result.warnings) console.warn(color.yellow('! ') + warning)
}

// ---------------------------------------------------------------- logs

async function cmdLogs(positionals, flags) {
  const registry = registryStore.load()
  const name = resolveName(registry, positionals[0])
  if (!name) return fail('Kein Projekt angegeben.')
  const profile = flags.profile ?? 'default'
  const project = describeProject(registry, name)
  const specs = project?.profiles[profile] ?? []
  const procName = flags.process ?? specs[0]?.name
  if (!procName) return fail(`Kein Prozess in ${name}/${profile} bekannt.`)

  const file = logFileFor(name, profile, procName)
  if (!existsSync(file)) return fail(`Kein Log unter ${file}`)

  if (flags.follow) {
    const tail = spawn('tail', ['-n', String(flags.lines ?? 40), '-f', file], { stdio: 'inherit' })
    await new Promise((r) => tail.on('exit', r))
    return
  }
  console.log(tailLog(file, Number(flags.lines ?? 40)).join('\n'))
}

// ---------------------------------------------------------------- ports/list

async function cmdPorts() {
  const registry = registryStore.load()
  const rows = []
  for (const [name, entry] of Object.entries(registry.projects).sort((a, b) => a[0].localeCompare(b[0], 'de'))) {
    const slots = [['default', entry.slot], ...Object.entries(entry.profileSlots ?? {})]
    for (const [profile, slot] of slots) {
      const frontend = portFor(slot, 'frontend')
      const backend = portFor(slot, 'backend')
      const busyFront = await probePort(frontend)
      const busyBack = await probePort(backend)
      rows.push([
        name,
        profile === 'default' ? color.dim('default') : profile,
        String(slot),
        busyFront ? color.green(String(frontend)) : String(frontend),
        busyBack ? color.green(String(backend)) : color.dim(String(backend))
      ])
    }
  }
  console.log(table(rows, { head: ['PROJEKT', 'PROFIL', 'SLOT', 'FRONTEND', 'BACKEND'] }))
  console.log(color.dim('\nGrün = belegt. Frontend 51NN, Backend 87NN — die Nummer verrät den Slot.'))
}

async function cmdList() {
  const registry = registryStore.load()
  const projects = listProjects(registry)
  const rows = projects.map((project) => [
    project.favorite ? color.yellow('★') : project.adopted ? color.green('✓') : color.dim('·'),
    project.displayName === project.name ? project.name : `${project.displayName} ${color.dim(`(${project.name})`)}`,
    project.stack?.framework ?? project.stack?.kind ?? '—',
    project.adopted ? String(project.slot) : color.dim('—'),
    project.source,
    project.problems.length ? color.yellow(project.problems[0]) : ''
  ])
  console.log(table(rows, { head: ['', 'PROJEKT', 'ART', 'SLOT', 'QUELLE', 'HINWEIS'] }))
  const open = projects.filter((p) => !p.adopted).length
  const favorites = projects.filter((p) => p.favorite).length
  console.log(
    color.dim(
      `\n${projects.length - open} aufgenommen · ${open} ohne Slot · ${favorites} Favorit${favorites === 1 ? '' : 'en'} ("dev adopt <projekt>")`
    )
  )
}

// ---------------------------------------------------------------- adopt

async function cmdAdopt(positionals, flags) {
  const registry = registryStore.load()
  const given = positionals[0]
  if (!given) return fail('Aufruf: dev adopt <projekt> [--slot N] [--profil smoke]')

  const asPath = resolve(given)
  const name = existsSync(asPath) && given.includes('/') ? basename(asPath) : given
  const path = existsSync(asPath) && given.includes('/') ? asPath : scanRoots(registry.settings.roots).find((p) => p.name === name)?.path

  if (!path) return fail(`${name} liegt in keinem bekannten Wurzelverzeichnis (${registry.settings.roots.join(', ')})`)

  if (flags.profile && registry.projects[name]) {
    const slot = registryStore.setProfileSlot(registry, name, flags.profile, flags.slot ? Number(flags.slot) : undefined)
    registryStore.save(registry)
    console.log(`${color.green('✓')} ${name}/${flags.profile} bekommt Slot ${slot} → ${portFor(slot, 'frontend')} / ${portFor(slot, 'backend')}`)
    return
  }

  const entry = registryStore.addProject(registry, {
    name,
    path,
    slot: flags.slot ? Number(flags.slot) : undefined,
    displayName: flags.displayName
  })
  if (flags.profile) registryStore.setProfileSlot(registry, name, flags.profile)
  if (!entry.displayName) {
    const suggested = describeProject(registry, name)?.suggestedDisplayName
    if (suggested && suggested !== name) registryStore.setDisplayName(registry, name, suggested)
  }
  registryStore.save(registry)

  const project = describeProject(registry, name)
  const label = project.displayName === name ? name : `${project.displayName} (${name})`
  console.log(`${color.green('✓')} ${label} aufgenommen · Slot ${entry.slot} · ${path}`)
  for (const [profile, specs] of Object.entries(project.profiles)) {
    for (const spec of specs) {
      if (spec.url) console.log(`  ${profile}/${spec.name} → ${color.blue(spec.url)}`)
    }
  }
  console.log(color.dim(`  Quelle: ${project.source}`))
  for (const problem of project.problems) console.warn(color.yellow('  ! ') + problem)
  console.log(color.dim(`\n"dev sync --projekt ${name}" schreibt den Vertrag in die Agent-Dateien.`))
}

async function cmdForget(positionals, flags) {
  const registry = registryStore.load()
  const name = positionals[0]
  if (!name) return fail('Aufruf: dev forget <projekt>')
  if (!registry.projects[name]) return fail(`${name} war nicht aufgenommen`)
  const slot = registry.projects[name].slot
  const projectPath = registry.projects[name].path
  if (!flags.keepFiles) {
    const files = unsyncProject(registry, name)
    for (const change of files.changes.filter((c) => c.changed)) {
      console.log(`  ${color.dim('−')} ${change.file.replace(files.path, '.')}${change.action ? color.dim(` · ${change.action}`) : ''}`)
    }
  }
  if (flags.cleanDeps) {
    const clean = cleanProjectArtifacts(projectPath)
    for (const item of clean.removed) {
      console.log(`  ${color.dim('−')} ${item.path.replace(projectPath, '.')}`)
    }
    if (!clean.removed.length) console.log(`  ${color.dim('·')} keine node_modules/.next o. Ä. gefunden`)
  }
  registryStore.removeProject(registry, name)
  registryStore.save(registry)
  console.log(`${color.dim('○')} ${name} entfernt — Slot ${slot} bleibt gesperrt, damit alte Adressen nichts Fremdes öffnen.`)
}

async function cmdFavorite(positionals, flags) {
  const registry = registryStore.load()
  const name = resolveName(registry, positionals[0])
  if (!name) return fail('Aufruf: dev favorite <projekt>')
  const project = describeProject(registry, name)
  if (!project) return fail(`${name} ist unbekannt`)
  const on = flags.off ? false : flags.on ? true : !project.favorite
  registryStore.setFavorite(registry, name, on)
  registryStore.save(registry)
  console.log(on ? `${color.yellow('★')} ${name} ist Favorit` : `${color.dim('☆')} ${name} kein Favorit mehr`)
}

async function cmdUnfavorite(positionals) {
  return cmdFavorite(positionals, { off: true })
}

// ---------------------------------------------------------------- sync

async function cmdSync(positionals, flags) {
  const registry = registryStore.load()
  const dryRun = Boolean(flags.dryRun)
  const results = syncAll(registry, { dryRun, only: flags.project ?? positionals[0] })

  for (const result of results) {
    const changed = result.changes.filter((c) => c.changed)
    if (!changed.length) {
      console.log(`${color.dim('○')} ${result.project} — nichts zu ändern`)
      continue
    }
    console.log(`${color.green('✓')} ${result.project}`)
    for (const change of changed) {
      const rel = change.file.replace(result.path, '.')
      console.log(`  ${change.adapter.padEnd(8)} ${rel}${change.backup ? color.dim(' (Sicherung angelegt)') : ''}`)
      if (change.action) console.log(color.dim(`           ${change.action}${change.detail ? ` — ${change.detail}` : ''}`))
    }
  }

  if (flags.global) {
    const changes = syncGlobal({ dryRun, withHook: Boolean(flags.hook) })
    console.log(`\n${color.green('✓')} global`)
    for (const change of changes.filter((c) => c.changed)) console.log(`  ${change.adapter.padEnd(8)} ${change.file}`)
  }

  if (dryRun) console.log(color.dim('\nProbelauf — es wurde nichts geschrieben.'))
}

// ---------------------------------------------------------------- agents

async function cmdAgents(positionals, flags) {
  const registry = registryStore.load()
  const name = resolveName(registry, positionals[0])
  if (!name) return fail('Kein Projekt angegeben.')
  const project = describeProject(registry, name)
  if (!project) return fail(`${name} ist unbekannt`)

  const includeGlobal = !flags.noGlobal && registry.settings.showGlobalAgentContext

  if (flags.file) {
    const result = readAgentFile(project.path, resolve(flags.file), { includeGlobal })
    if (result.directory) {
      console.log(result.children.map((c) => (c.directory ? `${c.name}/` : c.name)).join('\n'))
      return
    }
    console.log(result.content)
    if (result.truncated) console.log(color.dim('\n… gekürzt'))
    return
  }

  const context = agentContext(project.path, { includeGlobal })
  const render = (title, entries) => {
    if (!entries.length) return
    console.log(`\n${color.bold(title)}`)
    console.log(
      table(
        entries.map((entry) => [
          entry.agent,
          entry.label + (entry.directory ? '/' : ''),
          entry.directory ? `${entry.entries} Einträge` : `${Math.max(1, Math.round(entry.size / 1024))} kB`,
          entry.kind,
          color.dim(dateTime(entry.modified))
        ])
      )
    )
  }

  console.log(`${color.bold(name)} ${color.dim(project.path)}`)
  render('Im Projekt', context.repo)
  render('Global', context.global)

  console.log(`\n${color.bold('AGENTS.md / CLAUDE.md')}`)
  console.log(`  ${LINK_MARKER[context.link.state]} ${context.link.message}`)
  if (context.link.safe) console.log(color.dim(`    verknüpfen: dev link ${name}`))

  if (context.gaps.length) {
    console.log(`\n${color.bold('Lücken')}`)
    for (const gap of context.gaps) console.log(`  ${color.yellow('·')} ${gap.path} — ${gap.hint}`)
  }
  console.log(color.dim(`\nInhalt ansehen: dev agents ${name} --datei <pfad>`))
}

// ---------------------------------------------------------------- link

const LINK_MARKER = {
  verknüpft: color.green('✓'),
  'nur-eine': color.yellow('·'),
  gleich: color.yellow('·'),
  verschieden: color.red('✗'),
  kaputt: color.red('✗'),
  keine: color.dim('—')
}

async function cmdLink(positionals, flags) {
  const registry = registryStore.load()
  const dryRun = Boolean(flags.dryRun)
  const einzeln = positionals[0] ?? (flags.all ? null : resolveName(registry, null))

  if (!einzeln && !flags.all) {
    const rows = listProjects(registry)
      .map((project) => ({ project, zustand: inspectLink(project.path) }))
      .filter(({ zustand }) => zustand.state !== 'keine')
      .map(({ project, zustand }) => [
        LINK_MARKER[zustand.state],
        project.name,
        zustand.state === 'verknüpft' ? zustand.direction : zustand.state,
        color.dim(zustand.message)
      ])
    console.log(table(rows, { head: ['', 'PROJEKT', 'ZUSTAND', ''] }))
    const offen = rows.filter((r) => r[0] === color.yellow('·')).length
    console.log(
      color.dim(
        `\n${offen} Projekt${offen === 1 ? '' : 'e'} könnten verknüpft werden: "dev link <projekt>" oder "dev link --alle".` +
          '\nNur anzeigen — es wurde nichts geändert.'
      )
    )
    return
  }

  const namen = einzeln ? [einzeln] : listProjects(registry).map((p) => p.name)
  for (const name of namen) {
    const project = describeProject(registry, name)
    if (!project) {
      fail(`${name} ist unbekannt`)
      continue
    }
    const vorher = inspectLink(project.path)
    if (!vorher.safe) {
      if (einzeln || vorher.state === 'verschieden' || vorher.state === 'kaputt') {
        console.log(`${LINK_MARKER[vorher.state]} ${name} — ${vorher.message}`)
      }
      continue
    }
    const ergebnis = linkRuleFiles(project.path, { direction: flags.direction, dryRun })
    console.log(
      ergebnis.changed
        ? `${color.green('✓')} ${name} — ${ergebnis.message}`
        : `${color.yellow('·')} ${name} — ${ergebnis.message}`
    )
  }
  if (dryRun) console.log(color.dim('\nProbelauf — es wurde nichts geändert.'))
}

// ---------------------------------------------------------------- doctor

async function cmdDoctor() {
  const registry = registryStore.load()
  const findings = []

  const seen = new Map()
  for (const [name, entry] of Object.entries(registry.projects)) {
    for (const [profile, slot] of [['default', entry.slot], ...Object.entries(entry.profileSlots ?? {})]) {
      const previous = seen.get(slot)
      if (previous) findings.push(['Fehler', `Slot ${slot} doppelt: ${previous} und ${name}/${profile}`])
      seen.set(slot, `${name}/${profile}`)
    }
  }

  for (const project of listProjects(registry)) {
    for (const problem of project.problems) findings.push(['Hinweis', `${project.name}: ${problem}`])
    const link = inspectLink(project.path)
    if (link.state === 'verschieden' || link.state === 'kaputt') {
      findings.push(['Warnung', `${project.name}: AGENTS.md/CLAUDE.md — ${link.message}`])
    }
  }

  for (const instance of stateStore.all()) {
    for (const proc of instance.processes ?? []) {
      const busy = await probePort(proc.port)
      if (!busy) findings.push(['Hinweis', `${instance.project}/${proc.name}: als laufend vermerkt, aber ${proc.port} antwortet nicht`])
    }
  }

  for (const [name, entry] of Object.entries(registry.projects)) {
    for (const [profile, slot] of [['default', entry.slot], ...Object.entries(entry.profileSlots ?? {})]) {
      for (const role of ['frontend', 'backend']) {
        const port = portFor(slot, role)
        if (!(await probePort(port))) continue
        const recorded = stateStore.get(name, profile)?.processes?.some((p) => p.port === port)
        if (recorded) continue
        const listener = await listenerOn(port)
        findings.push(['Warnung', `${port} (${name}/${profile}/${role}) ist von ${listener?.command ?? '?'} (PID ${listener?.pid ?? '?'}) belegt, nicht vom Hub`])
      }
    }
  }

  const service = serviceStatus()
  findings.push([service.loaded ? 'Gut' : 'Hinweis', `launchd: ${service.summary}`])

  const hubBusy = await probePort(registry.settings.hubPort)
  findings.push([hubBusy ? 'Gut' : 'Hinweis', `Hub auf ${registry.settings.hubPort}: ${hubBusy ? 'erreichbar' : 'antwortet nicht'}`])

  const marker = { Fehler: color.red('✗'), Warnung: color.yellow('!'), Hinweis: color.dim('·'), Gut: color.green('✓') }
  console.log(table(findings.map(([kind, text]) => [marker[kind], text])))
}

// ---------------------------------------------------------------- service/serve

async function cmdServe(_positionals, flags) {
  const registry = registryStore.load()
  const port = Number(flags.port ?? registry.settings.hubPort)
  await startHub({ port })
}

async function cmdService(positionals) {
  const action = positionals[0] ?? 'status'
  if (action === 'install') {
    const result = await installService()
    console.log(`${color.green('✓')} ${result.message}`)
    return
  }
  if (action === 'uninstall') {
    const result = await uninstallService()
    console.log(`${color.dim('○')} ${result.message}`)
    return
  }
  const status = serviceStatus()
  console.log(status.summary)
  if (status.plist) console.log(color.dim(status.plist))
}

function revealInFinder(project) {
  spawn('open', [project.path], { detached: true, stdio: 'ignore' }).unref()
  console.log(`${color.blue(project.path)} im Finder`)
}

async function cmdReveal(positionals) {
  const registry = registryStore.load()
  const name = resolveName(registry, positionals[0])
  if (!name) return fail('Projekt angeben (oder im Projektordner stehen)')
  const project = describeProject(registry, name)
  if (!project) return fail(`Unbekanntes Projekt ${name}`)
  revealInFinder(project)
}

async function cmdOpen(positionals, flags) {
  const registry = registryStore.load()
  const name = resolveName(registry, positionals[0])
  if (flags.finder) {
    if (!name) return fail('Projekt angeben (oder im Projektordner stehen)')
    const project = describeProject(registry, name)
    if (!project) return fail(`Unbekanntes Projekt ${name}`)
    revealInFinder(project)
    return
  }
  if (!name) {
    spawn('open', [`http://localhost:${registry.settings.hubPort}`], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  const project = describeProject(registry, name)
  const url = project?.profiles[flags.profile ?? 'default']?.[0]?.url
  if (!url) return fail(`Keine Adresse für ${name}`)
  spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  console.log(`${color.blue(url)} geöffnet`)
}

// ---------------------------------------------------------------- help

const HELP = `devhub — die Dev-Server gehören dem Hub, nicht der Sitzung

  dev status [projekt]              was läuft, auf welcher Nummer
  dev up <projekt> [--profil p]     abgekoppelt starten (idempotent)
  dev down <projekt> | --alle       Prozessgruppe stoppen
  dev restart <projekt>             stoppen und starten
  dev logs <projekt> [-f] [-n 40]   Ausgabe des Servers
  dev ports                         Slot- und Portvergabe
  dev list                          alle erkannten Projekte
  dev adopt <projekt> [--slot N]    Slot vergeben (auch --profil smoke, --titel Name)
  dev forget <projekt>              aus der Registry nehmen (Slot bleibt gesperrt; Agent-Blöcke werden entfernt, --dateien-behalten lässt sie, --deps-loeschen räumt node_modules/.next auf)
  dev favorite <projekt>            Favorit setzen/umschalten (--aus zum Entfernen)
  dev unfavorite <projekt>          Favorit entfernen
  dev sync [--projekt x] [--global] Agent-Dateien schreiben (--probelauf zeigt nur)
  dev agents [projekt]              Regeln, Skills und Memory des Projekts
  dev link [projekt] [--alle]       AGENTS.md und CLAUDE.md verknüpfen (ohne Argument: Bericht)
  dev doctor                        Kollisionen und Ungereimtheiten
  dev serve [--port 4000]           Hub im Vordergrund
  dev service install|uninstall     launchd-Dienst
  dev open [projekt]                im Browser öffnen (--finder / --ordner: Ordner im Finder)
  dev reveal <projekt>              Projektordner im Finder zeigen

Ports: Frontend 51NN, Backend 87NN, NN = Slot. Adressen: <projekt>.localhost:<port>.
`

const COMMANDS = {
  status: cmdStatus,
  up: cmdUp,
  start: cmdUp,
  down: cmdDown,
  stop: cmdDown,
  restart: cmdRestart,
  logs: cmdLogs,
  log: cmdLogs,
  ports: cmdPorts,
  list: cmdList,
  adopt: cmdAdopt,
  forget: cmdForget,
  favorite: cmdFavorite,
  unfavorite: cmdUnfavorite,
  sync: cmdSync,
  agents: cmdAgents,
  link: cmdLink,
  doctor: cmdDoctor,
  serve: cmdServe,
  service: cmdService,
  open: cmdOpen,
  reveal: cmdReveal
}

export async function main(argv) {
  const { positionals, flags } = parseArgs(argv)
  const [command, ...rest] = positionals

  if (!command || command === 'help' || flags.help) {
    console.log(HELP)
    return
  }
  const handler = COMMANDS[command]
  if (!handler) {
    console.error(`Unbekanntes Kommando "${command}".\n`)
    console.log(HELP)
    process.exitCode = 2
    return
  }
  try {
    await handler(rest, flags)
  } catch (err) {
    fail(err.message)
    if (process.env.DEVHUB_DEBUG) console.error(err)
  }
}

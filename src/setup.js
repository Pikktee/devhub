import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import readline from 'node:readline'
import { cursorHome, registryFile, repoRoot } from './paths.js'
import * as registryStore from './registry.js'
import { installService } from './service.js'
import { syncGlobal } from './sync.js'
import { scanRoots } from './discovery.js'
import { readJson } from './util/json.js'
import { probePort } from './probe.js'

const SUGGESTED_NAMES = ['Developer', 'Projects', 'Code', 'dev']

export const SKILL_SOURCE = join(repoRoot, 'skill', 'cursor', 'SKILL.md')
export const skillInstallPath = (base = cursorHome) => join(base, 'skills', 'devhub', 'SKILL.md')

export function expandPath(input, home = homedir()) {
  const trimmed = String(input ?? '').trim()
  if (!trimmed) return trimmed
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2))
  return resolve(trimmed)
}

export function parseWurzelFlag(value, home = homedir()) {
  if (value === undefined || value === null || value === true) return []
  return String(value)
    .split(',')
    .map((part) => expandPath(part, home))
    .filter(Boolean)
}

export function assertEnvironment({ platform = process.platform, nodeVersion = process.versions.node } = {}) {
  if (platform !== 'darwin') {
    throw new Error('devhub setup setzt derzeit macOS (launchd) voraus')
  }
  const major = Number(String(nodeVersion).split('.')[0])
  if (!Number.isFinite(major) || major < 20) {
    throw new Error(`Node.js ≥ 20 nötig (gefunden: ${nodeVersion})`)
  }
}

export function suggestedRoots(home = homedir()) {
  return SUGGESTED_NAMES.map((name) => join(home, name)).filter((path) => existsSync(path))
}

export function defaultRootPath(home = homedir()) {
  return join(home, 'Dev')
}

/** Liest, ob die Registry bereits explizite Wurzeln speichert (nicht nur Default-Merge). */
export function explicitRootsFromRegistry(file = registryFile) {
  const raw = readJson(file, { settings: {} })
  const roots = raw.settings?.roots
  if (!Array.isArray(roots) || roots.length === 0) return null
  return roots.map((r) => expandPath(r))
}

/**
 * Fragt nach, wenn der Standardordner fehlt.
 * `ask` ist injizierbar für Tests: async (prompt) => string
 */
export async function chooseDefaultRoot({
  defaultRoot,
  suggestions = [],
  ask,
  isTTY = Boolean(process.stdin.isTTY)
} = {}) {
  if (existsSync(defaultRoot)) return defaultRoot
  if (!isTTY) {
    throw new Error(
      `Standardordner ${defaultRoot} fehlt. Bitte anlegen oder: devhub setup --wurzel <pfad>`
    )
  }
  if (typeof ask !== 'function') {
    throw new Error('Interaktive Abfrage nötig, aber keine ask-Funktion übergeben')
  }

  const found = suggestions.filter((p) => existsSync(p) && p !== defaultRoot)
  let hint = ''
  if (found.length) {
    hint = `\nGefunden: ${found.join(', ')}\nMit p einen davon (oder einen anderen Pfad) übernehmen.\n`
  }

  const answer = (
    await ask(
      `Standard-Projektordner ${defaultRoot} gibt es noch nicht.\n\n` +
        `  [Enter]  ${defaultRoot} anlegen und verwenden\n` +
        `  [p]      anderen Pfad wählen\n` +
        `  [q]      abbrechen\n` +
        hint +
        `\n> `
    )
  )
    .trim()
    .toLowerCase()

  if (answer === '') return defaultRoot
  if (answer === 'q' || answer === 'quit') throw new Error('Setup abgebrochen')
  if (answer === 'p' || answer.startsWith('p ')) {
    let pathAns = answer.startsWith('p ') ? answer.slice(2).trim() : ''
    if (!pathAns) pathAns = (await ask('Pfad: ')).trim()
    if (!pathAns) throw new Error('Kein Pfad angegeben — Setup abgebrochen')
    return expandPath(pathAns)
  }
  if (answer.startsWith('/') || answer.startsWith('~')) return expandPath(answer)
  throw new Error('Ungültige Eingabe — Setup abgebrochen')
}

export async function resolveRoots({
  wurzel,
  home = homedir(),
  ask,
  isTTY = Boolean(process.stdin.isTTY),
  registryPath = registryFile
} = {}) {
  const fromFlag = parseWurzelFlag(wurzel, home)
  if (fromFlag.length) return fromFlag

  const explicit = explicitRootsFromRegistry(registryPath)
  if (explicit) return explicit

  const fallback = defaultRootPath(home)
  const chosen = await chooseDefaultRoot({
    defaultRoot: fallback,
    suggestions: suggestedRoots(home),
    ask,
    isTTY
  })
  return [chosen]
}

export function ensureRoots(roots) {
  const created = []
  for (const root of roots) {
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true })
      created.push(root)
    }
  }
  return created
}

export function writeRootsToRegistry(roots) {
  const registry = registryStore.load()
  registry.settings.roots = [...roots]
  registryStore.save(registry)
  return registry
}

export function installCursorSkill({ source = SKILL_SOURCE, target = skillInstallPath() } = {}) {
  if (!existsSync(source)) {
    throw new Error(`Skill-Vorlage fehlt: ${source}`)
  }
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  return target
}

export function createAsk(stdin = process.stdin, stdout = process.stdout) {
  return (prompt) =>
    new Promise((resolveAnswer) => {
      const rl = readline.createInterface({ input: stdin, output: stdout })
      rl.question(prompt, (answer) => {
        rl.close()
        resolveAnswer(answer)
      })
    })
}

/**
 * @param {{
 *   wurzel?: string,
 *   skipExternal?: boolean,
 *   ask?: (prompt: string) => Promise<string>,
 *   isTTY?: boolean,
 *   home?: string,
 *   skillTarget?: string,
 * }} [opts]
 */
export async function runSetup(opts = {}) {
  const {
    wurzel,
    skipExternal = false,
    ask = createAsk(),
    isTTY = Boolean(process.stdin.isTTY),
    home = homedir(),
    skillTarget = skillInstallPath()
  } = opts

  const steps = []
  const push = (step, ok, detail) => {
    steps.push({ step, ok, detail })
    return steps.at(-1)
  }

  assertEnvironment()
  push('Umgebung', true, `macOS, Node ${process.versions.node}`)

  const roots = await resolveRoots({ wurzel, home, ask, isTTY })
  const created = ensureRoots(roots)
  writeRootsToRegistry(roots)
  push(
    'Projektwurzel',
    true,
    created.length
      ? `${roots.join(', ')} (neu angelegt: ${created.join(', ')})`
      : roots.join(', ')
  )

  if (!skipExternal) {
    try {
      execFileSync('npm', ['link'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      push('npm link', true, 'devhub und dev im PATH')
    } catch (err) {
      const detail = err.stderr?.toString?.()?.trim() || err.message
      push('npm link', false, detail)
      throw new Error(`npm link fehlgeschlagen: ${detail}`)
    }

    const service = await installService()
    push('launchd', service.ok !== false, service.message)

    const globalChanges = syncGlobal({ dryRun: false, withHook: false })
    const geschrieben = globalChanges.filter((c) => c.changed).length
    push('Agent-Regeln', true, `sync --global (${geschrieben} Dateien geändert)`)
  } else {
    push('npm link', true, 'übersprungen (Test)')
    push('launchd', true, 'übersprungen (Test)')
    push('Agent-Regeln', true, 'übersprungen (Test)')
  }

  const skillPath = installCursorSkill({ target: skillTarget })
  push('Cursor-Skill', true, skillPath)

  const registry = registryStore.load()
  const candidates = scanRoots(registry.settings.roots)
  const open = candidates.filter((p) => !registry.projects[p.name]).length
  const hubPort = registry.settings.hubPort
  const hubUp = skipExternal ? false : await probePort(hubPort)
  push(
    'Nächste Schritte',
    true,
    hubUp
      ? `Hub auf http://devhub.localhost:${hubPort} · ${open} Projekt${open === 1 ? '' : 'e'} ohne Slot — devhub list / adopt`
      : `${open} Projekt${open === 1 ? '' : 'e'} ohne Slot — devhub list, dann adopt; Hub: http://devhub.localhost:${hubPort}`
  )

  return { steps, roots, hubPort, openCandidates: open }
}

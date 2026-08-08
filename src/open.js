import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import {
  claudeHome,
  codexHome,
  configDir,
  cursorHome,
  hubLogFile,
  logDir,
  stateDir
} from './paths.js'
import { listProjects } from './discovery.js'

function underRoot(target, root) {
  if (!root) return false
  const base = resolve(root)
  return target === base || target.startsWith(`${base}${sep}`)
}

/** Nur Pfade, die der Hub ohnehin kennt — kein freier Dateizugriff. */
export function assertOpenablePath(registry, requested) {
  if (!requested || typeof requested !== 'string') {
    throw Object.assign(new Error('Pfad fehlt'), { status: 400 })
  }
  const target = resolve(requested)
  if (!existsSync(target)) {
    throw Object.assign(new Error(`Datei nicht gefunden: ${target}`), { status: 404 })
  }

  const roots = [
    configDir,
    stateDir,
    logDir,
    hubLogFile,
    claudeHome,
    cursorHome,
    codexHome,
    ...(registry.settings?.roots ?? []),
    ...listProjects(registry).map((p) => p.path)
  ]

  if (roots.some((root) => underRoot(target, root))) return target
  throw Object.assign(new Error('Dieser Pfad darf über den Hub nicht geöffnet werden'), { status: 403 })
}

/**
 * macOS: Editor-Kommando oder Finder (`open -R` zeigt die Datei im Ordner).
 */
export function openLocalPath(target, { finder = false, editor = 'cursor' } = {}) {
  if (finder) {
    spawn('open', ['-R', target], { detached: true, stdio: 'ignore' }).unref()
    return { opened: target, finder: true }
  }
  spawn(editor, [target], { detached: true, stdio: 'ignore' }).unref()
  return { opened: target, editor }
}

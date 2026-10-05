import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJson } from '../util/json.js'
import { DEV_SERVER_STARTS } from '../../claude-mod/hooks/dev-server-patterns.js'

/**
 * Gemessen: `preview_start` hängt sich nicht an einen fremden Server, es bricht
 * ab. Ein Eintrag *ohne* Kommando dagegen wird als reines Attach behandelt und
 * taucht in `preview_list` gar nicht als Prozess auf - Claude Code kann ihn also
 * weder starten noch stoppen. Genau das wollen wir.
 */
export function launchJsonFor(instances) {
  return {
    version: '0.0.1',
    _hinweis: 'Von devhub erzeugt. Nur Attach-Einträge - nicht von Hand ändern, "devhub sync" überschreibt.',
    configurations: instances.flatMap(({ profile, entries }) =>
      entries.map((entry) => ({
        name: profile === 'default' ? entry.name : `${entry.name}-${profile}`,
        url: entry.url,
        port: entry.port
      }))
    )
  }
}

function hasCommands(file) {
  const existing = readJson(file, null)
  return Boolean(existing?.configurations?.some((c) => c.runtimeExecutable || c.command || c.autoPort))
}

export function writeLaunchJson(projectPath, instances, { dryRun = false } = {}) {
  const file = join(projectPath, '.claude', 'launch.json')
  const payload = launchJsonFor(instances)
  const next = `${JSON.stringify(payload, null, 2)}\n`
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const anzahl = payload.configurations.length
  if (existing === next) {
    return {
      file,
      changed: false,
      action: 'unverändert',
      detail: `${anzahl} Attach-Einträge bereits aktuell`
    }
  }

  const backup = existsSync(file) && hasCommands(file) ? `${file}.vor-devhub` : null
  if (!dryRun) {
    mkdirSync(join(projectPath, '.claude'), { recursive: true })
    if (backup && !existsSync(backup)) copyFileSync(file, backup)
    writeFileSync(file, next, 'utf8')
  }
  return {
    file,
    changed: true,
    backup,
    created: !existing,
    action: !existing ? 'Datei angelegt' : 'Datei überschrieben',
    detail: backup
      ? `${anzahl} Attach-Einträge · Sicherung nach ${backup}`
      : `${anzahl} Attach-Einträge (nur url/port, kein Startkommando)`
  }
}

export function removeLaunchJson(projectPath, { dryRun = false } = {}) {
  const file = join(projectPath, '.claude', 'launch.json')
  if (!existsSync(file)) {
    return { file, changed: false, action: 'fehlte', detail: 'Datei existiert nicht' }
  }
  const existing = readJson(file, null)
  const vonHub = Boolean(existing?._hinweis?.includes('devhub'))
  if (!vonHub && hasCommands(file)) {
    return {
      file,
      changed: false,
      action: 'übersprungen',
      detail: 'Enthält eigene Startkommandos - nicht angefasst'
    }
  }
  if (!dryRun) unlinkSync(file)
  return {
    file,
    changed: true,
    deleted: true,
    action: 'Datei gelöscht',
    detail: vonHub ? 'Von devhub erzeugte Attach-Datei entfernt' : 'launch.json entfernt'
  }
}

/** Bash-Globs aus denselben Mustern, die der Claude-Code-Mod prüft. */
function caseGlobs() {
  return DEV_SERVER_STARTS.map((pattern) => `*"${pattern}"*`).join('|')
}

export function hookScript(devBin) {
  return `#!/usr/bin/env bash
# Von devhub erzeugt. Fängt Dev-Server-Starts ab, bevor ein zweiter Prozess entsteht.
set -euo pipefail
eingabe=$(cat)
kommando=$(printf '%s' "$eingabe" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null || true)

case "$kommando" in
  ${caseGlobs()})
    printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Dev-Server gehören devhub. Nutze ${devBin} up <projekt> bzw. ${devBin} status."}}'
    exit 0
    ;;
esac
exit 0
`
}

export const HOOK_SCRIPT_NAME = 'devhub-kein-dev-server.sh'
export const PLUGIN_DIRS_KEY = 'CLAUDE_CODE_PLUGIN_DIRS'

/**
 * Claude Code liest CLAUDE_CODE_PLUGIN_DIRS als Pfadliste mit ":" - fremde
 * Einträge darin gehören anderen Werkzeugen und bleiben stehen.
 */
function pluginDirs(settings) {
  return String(settings.env?.[PLUGIN_DIRS_KEY] ?? '')
    .split(':')
    .filter(Boolean)
}

export function hasPluginDir(settings, dir) {
  return pluginDirs(settings).includes(dir)
}

/** Gibt eine neue Settings-Struktur zurück; `changed` sagt, ob sich etwas tat. */
export function withPluginDir(settings, dir) {
  if (hasPluginDir(settings, dir)) return { settings, changed: false }
  const env = { ...(settings.env ?? {}), [PLUGIN_DIRS_KEY]: [...pluginDirs(settings), dir].join(':') }
  return { settings: { ...settings, env }, changed: true }
}

export function withoutPluginDir(settings, dir) {
  if (!hasPluginDir(settings, dir)) return { settings, changed: false }
  const rest = pluginDirs(settings).filter((d) => d !== dir)
  const env = { ...settings.env }
  if (rest.length) env[PLUGIN_DIRS_KEY] = rest.join(':')
  else delete env[PLUGIN_DIRS_KEY]
  const next = { ...settings, env }
  if (!Object.keys(env).length) delete next.env
  return { settings: next, changed: true }
}

const isDevhubHook = (entry) => entry.hooks?.some((inner) => inner.command?.includes(HOOK_SCRIPT_NAME))

export function hasDevhubHook(settings) {
  return Boolean(settings.hooks?.PreToolUse?.some(isDevhubHook))
}

/**
 * Entfernt den Bash-Hook aus den Settings. Mod und Hook würden sonst beide
 * sperren - mit zwei verschiedenen Begründungen für denselben Befehl.
 */
export function withoutDevhubHook(settings) {
  if (!hasDevhubHook(settings)) return { settings, changed: false }
  const PreToolUse = settings.hooks.PreToolUse.filter((entry) => !isDevhubHook(entry))
  const hooks = { ...settings.hooks, PreToolUse }
  if (!PreToolUse.length) delete hooks.PreToolUse
  const next = { ...settings, hooks }
  if (!Object.keys(hooks).length) delete next.hooks
  return { settings: next, changed: true }
}

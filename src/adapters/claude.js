import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJson } from '../util/json.js'

/**
 * Gemessen: `preview_start` hängt sich nicht an einen fremden Server, es bricht
 * ab. Ein Eintrag *ohne* Kommando dagegen wird als reines Attach behandelt und
 * taucht in `preview_list` gar nicht als Prozess auf — Claude Code kann ihn also
 * weder starten noch stoppen. Genau das wollen wir.
 */
export function launchJsonFor(instances) {
  return {
    version: '0.0.1',
    _hinweis: 'Von devhub erzeugt. Nur Attach-Einträge — nicht von Hand ändern, "dev sync" überschreibt.',
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
      detail: 'Enthält eigene Startkommandos — nicht angefasst'
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

export const HOOK_MATCHERS = ['npm run dev', 'pnpm dev', 'yarn dev', 'vite', 'next dev', 'uvicorn', 'http.server', 'docker compose up']

export function hookScript(devBin) {
  return `#!/usr/bin/env bash
# Von devhub erzeugt. Fängt Dev-Server-Starts ab, bevor ein zweiter Prozess entsteht.
set -euo pipefail
eingabe=$(cat)
kommando=$(printf '%s' "$eingabe" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null || true)

case "$kommando" in
  *"npm run dev"*|*"pnpm dev"*|*"yarn dev"*|*"npx vite"*|*"next dev"*|*"uvicorn "*|*"http.server"*|*"docker compose up"*)
    printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Dev-Server gehören devhub. Nutze ${devBin} up <projekt> bzw. ${devBin} status."}}'
    exit 0
    ;;
esac
exit 0
`
}

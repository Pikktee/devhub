import { chmodSync, closeSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeHome, codexHome, cursorHome, hubLogFile } from './paths.js'
import { describeProject } from './discovery.js'
import { removeLaunchJson, writeLaunchJson, hookScript } from './adapters/claude.js'
import { removeCursorRule, writeCursorRule } from './adapters/cursor.js'
import { ensureGitignore, localContractText, removeBlock, writeBlock } from './adapters/contract.js'
import { logLine, openLog } from './runners/process.js'
import { readJson, writeJson } from './util/json.js'

export function instancesOf(project) {
  return Object.entries(project.profiles)
    .map(([profile, specs]) => ({
      profile,
      entries: specs
        .filter((spec) => spec.port)
        .map((spec) => ({ name: spec.name, port: spec.port, url: spec.url, role: spec.role }))
    }))
    .filter((instance) => instance.entries.length)
}

function adressenKurz(instances) {
  return instances
    .flatMap(({ profile, entries }) =>
      entries.map((e) => `${profile}/${e.name} → ${e.url ?? e.port ?? '—'}`)
    )
    .join(', ')
}

function hubLog(lines) {
  const fd = openLog(hubLogFile)
  try {
    for (const line of lines) logLine(fd, line)
  } finally {
    closeSync(fd)
  }
}

function protokolliere(aktion, project, path, changes, extra = []) {
  const lines = [`${aktion} ${project}`, ...extra]
  for (const c of changes) {
    const rel = c.file.startsWith(path) ? `.${c.file.slice(path.length)}` : c.file
    const status = !c.changed ? 'gleich' : c.deleted ? 'gelöscht' : c.created ? 'neu' : 'geändert'
    lines.push(`  ${status.padEnd(10)} ${rel}`)
    if (c.action) lines.push(`             ${c.action}${c.detail ? ` — ${c.detail}` : ''}`)
    if (c.backup) lines.push(`             Sicherung: ${c.backup}`)
  }
  hubLog(lines)
  return lines
}

export function syncProject(registry, name, { dryRun = false } = {}) {
  const project = describeProject(registry, name)
  if (!project) throw new Error(`Projekt "${name}" ist unbekannt`)
  if (!project.adopted) throw new Error(`"${name}" ist nicht aufgenommen`)

  const instances = instancesOf(project)
  const lokal = localContractText({ project: name, hubPort: registry.settings.hubPort, instances })
  const changes = []

  // Nur lokal und gitignoriert — kein AGENTS.md im Repo (globale Regeln reichen).
  changes.push({
    adapter: 'cursor',
    ...writeCursorRule(join(project.path, '.cursor'), lokal, {
      dryRun,
      description: 'Lokale Dev-Server-Adressen (devhub, nicht committen)'
    })
  })
  changes.push({ adapter: 'claude', ...writeLaunchJson(project.path, instances, { dryRun }) })
  changes.push({ adapter: 'gitignore', ...ensureGitignore(project.path, { dryRun }) })

  const altRegel = join(project.path, '.cursor', 'rules', 'devhub.mdc')
  if (existsSync(altRegel)) {
    if (!dryRun) unlinkSync(altRegel)
    changes.push({
      adapter: 'cursor',
      file: altRegel,
      changed: true,
      deleted: true,
      action: 'Datei gelöscht',
      detail: 'Alte Regel mit Ports (oft im Repo) entfernt — ersetzt durch devhub.local.mdc'
    })
  }

  const log = dryRun
    ? []
    : protokolliere('sync', name, project.path, changes, [
        `  Slot ${project.slot} · ${adressenKurz(instances) || 'keine Ports'}`,
        '  nur lokal: Cursor-Regel + launch.json + gitignore'
      ])

  return { project: name, path: project.path, slot: project.slot, instances, changes, log }
}

/** Macht den Sync rückgängig: lokale Hub-Dateien und ggf. alten AGENTS.md-Block entfernen. */
export function unsyncProject(registry, name, { dryRun = false } = {}) {
  const project = describeProject(registry, name)
  if (!project) throw new Error(`Projekt "${name}" ist unbekannt`)

  const changes = []
  changes.push({ adapter: 'claude', ...removeLaunchJson(project.path, { dryRun }) })
  // Frühere Syncs schrieben einen Block in AGENTS.md — beim Forget aufräumen.
  changes.push({ adapter: 'neutral', ...removeBlock(join(project.path, 'AGENTS.md'), { dryRun }) })
  changes.push({ adapter: 'cursor', ...removeCursorRule(join(project.path, '.cursor'), { dryRun }) })

  const log = dryRun ? [] : protokolliere('unsync', name, project.path, changes)
  return { project: name, path: project.path, changes, log }
}

export function syncAll(registry, { dryRun = false, only } = {}) {
  const names = only ? [only] : Object.keys(registry.projects)
  return names.map((name) => syncProject(registry, name, { dryRun }))
}

const GLOBAL_BLOCK = `## Dev-Server gehören devhub

Auf diesem Rechner gehören **alle** Dev-Server dem lokalen Dienst \`devhub\`.
Coding-Agenten starten **keine** eigenen Instanzen.

### Verboten
\`npm run dev\`, \`pnpm dev\`, \`yarn dev\`, \`bun dev\`, \`vite\`, \`next dev\`,
\`uvicorn\`, \`python -m http.server\`, \`docker compose up\`, \`npx serve\` —
auch nicht „kurz zum Testen“.

### Stattdessen (CLI \`devhub\`)
1. \`devhub status\` — läuft etwas, welche URL/Ports?
2. \`devhub up <ordner>\` — startet abgekoppelt (Ordnername unter ~/Dev, z. B. \`journey\`, nicht der Anzeigename).
3. \`devhub down <ordner>\` — stoppt die **ganze** Prozessgruppe (Frontend+API).
4. \`devhub logs <ordner>\` — Log lesen bei Fehlern.
5. Übersicht: http://devhub.localhost:4000

### Adressen
Die URL kommt aus dem **Anzeigenamen** (\`http://maptale.localhost:5120\`),
der CLI-Schlüssel bleibt der **Ordner** (\`devhub up journey\`). Bei \`devhub status\`
steht beides. **Backend-URLs nie aus Anzeige-Host + Port zusammenbasteln** —
die stehen bei \`devhub status <ordner>\` unter Prozesse (meist \`http://127.0.0.1:…\`).
Wer selbst startet, erzeugt leicht einen zweiten Server auf einer anderen
Nummer — der Unterschied fällt erst auf, wenn Login/Daten fehlen.

### Mehrere Prozesse
Ein \`devhub up\` startet alle Rollen des Profils (z. B. web+api). Nicht nur das
Frontend von Hand nachziehen.`

export function syncGlobal({ dryRun = false, withHook = false } = {}) {
  const changes = []
  changes.push({ adapter: 'claude', ...writeBlock(join(claudeHome, 'CLAUDE.md'), GLOBAL_BLOCK, { dryRun }) })
  changes.push({
    adapter: 'cursor',
    ...writeCursorRule(cursorHome, GLOBAL_BLOCK, {
      dryRun,
      description: 'Dev-Server werden von devhub verwaltet',
      fileName: 'devhub.mdc'
    })
  })
  changes.push({ adapter: 'codex', ...writeBlock(join(codexHome, 'AGENTS.md'), GLOBAL_BLOCK, { dryRun }) })

  if (withHook) changes.push(installClaudeHook({ dryRun }))

  if (!dryRun) {
    hubLog([
      'sync global',
      ...changes.map((c) => {
        const status = c.changed ? 'geschrieben' : 'gleich'
        return `  ${status.padEnd(11)} ${c.file}${c.action ? ` — ${c.action}` : ''}`
      })
    ])
  }
  return changes
}

/**
 * Der Hook wirkt unabhängig davon, was das Modell gerade denkt — deshalb ist er
 * die Rückfallebene, wenn eine Regel im Kontext nicht reicht. Standardmäßig aus,
 * weil er auch legitime Aufrufe abfängt.
 */
export function installClaudeHook({ dryRun = false } = {}) {
  const script = join(claudeHome, 'hooks', 'devhub-kein-dev-server.sh')
  const settingsFile = join(claudeHome, 'settings.json')

  if (!dryRun) {
    mkdirSync(join(claudeHome, 'hooks'), { recursive: true })
    writeFileSync(script, hookScript('devhub'), 'utf8')
    chmodSync(script, 0o755)

    const settings = readJson(settingsFile, {})
    settings.hooks ??= {}
    settings.hooks.PreToolUse ??= []
    const already = settings.hooks.PreToolUse.some((h) =>
      h.hooks?.some((inner) => inner.command?.includes('devhub-kein-dev-server'))
    )
    if (!already) {
      settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: script }] })
      writeJson(settingsFile, settings)
    }
  }
  return { adapter: 'claude', file: script, changed: true, action: 'Hook installiert', detail: settingsFile }
}

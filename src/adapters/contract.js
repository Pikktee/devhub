import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const START = '<!-- devhub:anfang -->'
export const END = '<!-- devhub:ende -->'

export const GITIGNORE_START = '# >>> devhub'
export const GITIGNORE_END = '# <<< devhub'

/**
 * Darf ins Repo: keine Ports, keine Annahme dass der Hub überall läuft.
 * Maschinenbezogene Adressen stehen nur in lokalen, gitignorierten Dateien.
 */
export function portableContractText({ project }) {
  return `## Dev-Server und devhub

Falls auf diesem Rechner das CLI \`devhub\` verfügbar ist, gehören die
Dev-Server diesem Dienst. **Nicht** mit \`npm run dev\`, \`pnpm dev\`, \`vite\`,
\`next dev\`, \`uvicorn\`, \`python -m http.server\`, \`docker compose up\` oder
\`npx serve\` starten - sonst läuft leicht ein zweiter Server auf einer anderen
Nummer.

Vor dem Öffnen der App: \`devhub status ${project}\`. Starten nur mit
\`devhub up ${project}\` (Ordnername), stoppen mit \`devhub down ${project}\`, Log mit
\`devhub logs ${project}\`. Ein Aufruf startet alle Rollen (Frontend und API, falls
vorhanden). Kurzform \`dev\` ist Alias.

Ohne \`devhub\` / ohne Hub: Server wie im Projekt üblich starten.`
}

/** Nur lokal (gitignoriert): feste Ports und URLs dieses Rechners. */
export function localContractText({ project, hubPort, instances }) {
  const rows = instances
    .map(({ profile, entries }) => {
      const addresses = entries.map((e) => `${e.name}: ${e.url}`).join(', ')
      return `| \`${profile}\` | ${addresses || '-'} |`
    })
    .join('\n')

  return `## Dev-Server gehören dem lokalen Hub (diese Maschine)

Diese Datei ist lokal und sollte nicht committed werden. Ports gelten nur hier.

| Profil | Adresse |
| --- | --- |
${rows || '| - | - |'}

- \`devhub status ${project}\` · \`devhub up ${project}\` · \`devhub down ${project}\` · \`devhub logs ${project}\`
- Übersicht: http://devhub.localhost:${hubPort}
- CLI-Schlüssel ist der **Ordner** \`${project}\`; die URL folgt dem Anzeigenamen.

**Nicht** selbst \`npm run dev\` / \`vite\` / \`next dev\` / \`uvicorn\` / \`npx serve\` o. Ä. starten.`
}

/** @deprecated Alias - früher enthielt der AGENTS.md-Block Ports. */
export function contractText(opts) {
  return localContractText(opts)
}

export function applyBlock(existing, block) {
  const wrapped = `${START}\n${block}\n${END}`
  if (existing.includes(START) && existing.includes(END)) {
    const before = existing.slice(0, existing.indexOf(START))
    const after = existing.slice(existing.indexOf(END) + END.length)
    return `${before}${wrapped}${after}`
  }
  const separator = existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n` : ''
  return `${separator}${wrapped}\n`
}

export function writeBlock(file, block, { dryRun = false } = {}) {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const next = applyBlock(existing, block)
  if (next === existing) {
    return {
      file,
      changed: false,
      action: 'unverändert',
      detail: 'devhub-Block war schon aktuell'
    }
  }
  const created = !existing
  const ersetzt = Boolean(existing && existing.includes(START) && existing.includes(END))
  if (!dryRun) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, next, 'utf8')
  }
  return {
    file,
    changed: true,
    created,
    action: created ? 'Datei angelegt' : ersetzt ? 'devhub-Block ersetzt' : 'devhub-Block angehängt',
    detail: created
      ? 'Neue Datei mit Vertrag zwischen den Ankern'
      : ersetzt
        ? 'Inhalt zwischen <!-- devhub:anfang --> und <!-- devhub:ende --> ausgetauscht'
        : 'Vertrag ans Ende der bestehenden Datei gehängt'
  }
}

/** Entfernt nur den Hub-Block; Rest der Datei bleibt. Leere Reste werden gelöscht. */
export function removeBlock(file, { dryRun = false } = {}) {
  if (!existsSync(file)) {
    return { file, changed: false, action: 'fehlte', detail: 'Datei existiert nicht' }
  }
  const existing = readFileSync(file, 'utf8')
  if (!existing.includes(START) || !existing.includes(END)) {
    return { file, changed: false, action: 'unverändert', detail: 'Kein devhub-Block vorhanden' }
  }
  const before = existing.slice(0, existing.indexOf(START))
  const after = existing.slice(existing.indexOf(END) + END.length)
  const next = `${before.replace(/\s*$/, '')}${after.replace(/^\n/, '')}`.trim()
  if (!dryRun) {
    if (!next) {
      unlinkSync(file)
      return { file, changed: true, deleted: true, action: 'Datei gelöscht', detail: 'Nur Hub-Inhalt - Datei entfernt' }
    }
    writeFileSync(file, `${next}\n`, 'utf8')
  }
  return {
    file,
    changed: true,
    deleted: !next,
    action: !next ? 'Datei gelöscht' : 'devhub-Block entfernt',
    detail: !next ? 'Datei enthielt nur Hub-Inhalt' : 'Anker und Vertrag entfernt, Rest belassen'
  }
}

const GITIGNORE_BLOCK = `${GITIGNORE_START}
.claude/launch.json
.claude/launch.json.vor-devhub
.cursor/rules/devhub.local.mdc
${GITIGNORE_END}`

/** Trägt die lokalen Hub-Dateien in .gitignore ein - zwischen festen Markern. */
export function ensureGitignore(projectPath, { dryRun = false } = {}) {
  const file = join(projectPath, '.gitignore')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  let next
  if (existing.includes(GITIGNORE_START) && existing.includes(GITIGNORE_END)) {
    const before = existing.slice(0, existing.indexOf(GITIGNORE_START))
    const after = existing.slice(existing.indexOf(GITIGNORE_END) + GITIGNORE_END.length)
    next = `${before}${GITIGNORE_BLOCK}${after.replace(/^\n/, '\n')}`
  } else {
    const sep = existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n` : ''
    next = `${sep}${GITIGNORE_BLOCK}\n`
  }
  if (next === existing) {
    return { file, changed: false, action: 'unverändert', detail: '.gitignore enthielt Hub-Einträge schon' }
  }
  if (!dryRun) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, next, 'utf8')
  }
  return {
    file,
    changed: true,
    created: !existing,
    action: existing.includes(GITIGNORE_START) ? 'gitignore aktualisiert' : 'gitignore ergänzt',
    detail: 'Lokale Hub-Dateien von Git ausgenommen'
  }
}

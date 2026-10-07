/**
 * Reine Funktionen über den Antworten der Hub-API: welches Projekt gehört zur
 * Sitzung, wie heißt sein Zustand, welche Texte sieht Mensch und Modell.
 * Kein `$` hier, damit die Tests sie ohne Engine prüfen können.
 */
import type { DevhubProcess, DevhubState, DevhubView } from '../types'

export type ApiProcess = {
  name: string
  role?: string | null
  port?: number | null
  url?: string | null
  listening?: boolean
  foreign?: boolean
}

export type ApiProfile = {
  profile: string
  state: string
  processes: ApiProcess[]
}

export type ApiProject = {
  name: string
  displayName?: string
  path: string
  adopted: boolean
  profiles: ApiProfile[]
  /** Gesetzt bei Worktree-Instanzen: das Projekt, zu dem sie gehören. */
  worktree?: { of: string; label: string } | null
  /** Am Hauptprojekt: die Ordner seiner Git-Worktrees. */
  worktrees?: string[]
}

export type Overview = {
  hub: { port: number }
  conflicts: unknown[]
  projects: ApiProject[]
}

const insideOf = (cwd: string) => (root: string) => cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)

/**
 * Der Ordner, der den cwd am engsten umschließt; verschachtelte Projekte
 * gewinnen. Ein gestarteter Worktree ist ein eigener Eintrag mit eigenem Pfad
 * und gewinnt damit gegen sein Hauptprojekt.
 */
export function projectForCwd(overview: Overview, cwd: string): ApiProject | undefined {
  const inside = insideOf(cwd)
  return overview.projects
    .filter((p) => p.path && inside(p.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

/**
 * Liegt der cwd in einem Worktree, den devhub noch nicht kennt? Dann gehört die
 * Sitzung nicht zum Hauptprojekt - dessen Adressen zeigten den falschen Code.
 * Auch Worktrees außerhalb des Projektordners (/Volumes/…) werden so gefunden.
 */
export function pendingWorktree(overview: Overview, cwd: string): { project: ApiProject; path: string } | undefined {
  const inside = insideOf(cwd)
  const started = new Set(overview.projects.filter((p) => p.worktree).map((p) => p.path))
  for (const project of overview.projects) {
    const path = (project.worktrees ?? []).find((w) => inside(w) && !started.has(w))
    if (path) return { project, path }
  }
  return undefined
}

/**
 * Das Profil, über das die Sitzung spricht: ein laufendes vor `default`. Sonst
 * zeigte die Statuszeile „aus“, während das smoke-Profil gerade läuft.
 */
export function chosenProfile(project: ApiProject): ApiProfile | undefined {
  const active = project.profiles.find((p) => p.state === 'läuft' || p.state === 'teilweise')
  return active ?? project.profiles.find((p) => p.profile === 'default') ?? project.profiles[0]
}

function stateOf(raw: string | undefined): DevhubState {
  if (raw === 'läuft') return 'läuft'
  if (raw === 'teilweise') return 'teilweise'
  return 'aus'
}

export function viewOf(overview: Overview, cwd: string): DevhubView | null {
  const pending = pendingWorktree(overview, cwd)
  if (pending) {
    return {
      name: '.',
      displayName: `${pending.project.displayName ?? pending.project.name} · Worktree`,
      adopted: true,
      profile: 'default',
      state: 'aus',
      processes: [],
      ports: [],
      ownConflicts: 0,
      hubConflicts: overview.conflicts.length,
      worktreePending: true,
      worktreePath: pending.path
    }
  }
  const project = projectForCwd(overview, cwd)
  if (!project) return null
  const profile = chosenProfile(project)
  const processes: DevhubProcess[] = (profile?.processes ?? []).map((p) => ({
    name: p.name,
    role: p.role ?? null,
    port: p.port ?? null,
    url: p.url ?? null,
    listening: Boolean(p.listening),
    foreign: Boolean(p.foreign)
  }))
  return {
    name: project.name,
    displayName: project.displayName ?? project.name,
    adopted: project.adopted,
    profile: profile?.profile ?? 'default',
    state: project.adopted ? stateOf(profile?.state) : 'aus',
    processes,
    ports: project.profiles.flatMap((pr) => pr.processes.map((p) => p.port)).filter((p): p is number => typeof p === 'number'),
    ownConflicts: processes.filter((p) => p.foreign).length,
    hubConflicts: overview.conflicts.length
  }
}

export function frontendOf(view: DevhubView): DevhubProcess | undefined {
  return view.processes.find((p) => p.role === 'frontend' && p.url) ?? view.processes.find((p) => p.url)
}

/** Alles mit Adresse außer dem Frontend: API, Worker mit HTTP, … */
export function backendsOf(view: DevhubView): DevhubProcess[] {
  const front = frontendOf(view)
  return view.processes.filter((p) => p.url && p !== front)
}

function upCommand(view: DevhubView) {
  if (view.worktreePending) return 'devhub up .'
  return view.profile === 'default' ? `devhub up ${view.name}` : `devhub up ${view.name} --profil ${view.profile}`
}

function conflictHint(view: DevhubView): string | undefined {
  const own = view.processes.filter((p) => p.foreign)
  if (own.length) return `⚠ Port ${own.map((p) => p.port).join(', ')} fremd belegt`
  if (view.hubConflicts) return `⚠ ${view.hubConflicts} Konflikt${view.hubConflicts === 1 ? '' : 'e'} im Hub`
  return undefined
}

const GLYPH: Record<DevhubState, string> = { läuft: '●', teilweise: '◐', aus: '○' }

/**
 * Nur aufgenommene Projekte bekommen eine Statuszeile: ein Repo ohne Server
 * (devhub selbst, AI Setup) trüge sonst dauerhaft „nicht aufgenommen“ mit.
 */
export function statusText(view: DevhubView): string | undefined {
  if (!view.adopted) return undefined
  const parts = [`${GLYPH[view.state]} ${view.state}`, view.displayName]
  const front = frontendOf(view)
  if (view.state !== 'aus' && front?.listening && front.url) parts.push(front.url)
  if (view.state === 'aus') parts.push(upCommand(view))
  const hint = conflictHint(view)
  if (hint) parts.push(hint)
  return `devhub ${parts.join(' · ')}`
}

/**
 * Der Kontextblock für das Modell. Bewusst ohne Laufzustand: der Text soll sich
 * nur ändern, wenn sich Adressen ändern, sonst verliert jede Anfrage den
 * Prompt-Cache ab hier.
 */
export function composeText(view: DevhubView): string | undefined {
  const lines = view.processes.filter((p) => p.url).map((p) => `- ${p.name}${p.role ? ` (${p.role})` : ''}: ${p.url}`)
  if (!lines.length) return undefined
  return [
    '# devhub: Adressen dieses Projekts',
    '',
    `Diese Sitzung arbeitet im Projekt \`${view.name}\` (Anzeigename ${view.displayName}), Profil \`${view.profile}\`. Seine Dev-Server gehören dem lokalen Dienst devhub und haben feste Adressen:`,
    '',
    ...lines,
    '',
    'Nur diese Adressen benutzen, keine aus Host und Port zusammensetzen und keine anderen Ports raten.',
    `Starten und stoppen ausschließlich mit \`${upCommand(view)}\` bzw. \`devhub down ${view.name}\`, nie selbst einen Dev-Server starten (auch nicht kurz zum Testen).`,
    `Ob gerade etwas läuft, sagt \`devhub status ${view.name}\`; Fehlerzeilen aus den Server-Logs liefert das Tool mcp__devhub__logs.`
  ].join('\n')
}

function addresses(view: DevhubView) {
  return view.processes
    .filter((p) => p.url)
    .map((p) => `${p.name} ${p.url}${p.listening ? '' : ' (aus)'}`)
    .join(', ')
}

/** Antwort an das Modell, wenn es einen Dev-Server selbst starten wollte. */
export function denyText(pattern: string, view: DevhubView | null): string {
  const head = `Dev-Server gehören devhub - "${pattern.trim()}" wird nicht selbst gestartet.`
  if (!view) {
    return `${head} Dieses Verzeichnis gehört zu keinem Projekt im Hub. \`devhub status\` zeigt alle Projekte, \`devhub up <ordner>\` startet eines.`
  }
  if (!view.adopted) {
    return `${head} Das Projekt ${view.name} ist im Hub noch nicht aufgenommen: erst \`devhub adopt ${view.name}\`, dann \`devhub up ${view.name}\`.`
  }
  const where = addresses(view)
  if (view.state === 'läuft') {
    return `${head} ${view.displayName} läuft bereits (${where}). Nichts starten, diese Adressen benutzen. Neu starten: \`devhub restart ${view.name}\`.`
  }
  if (view.state === 'teilweise') {
    const off = view.processes.filter((p) => !p.listening).map((p) => p.name)
    return `${head} ${view.displayName} läuft nur teilweise (${where}; aus: ${off.join(', ')}). Stattdessen: \`devhub restart ${view.name}\`, bei Fehlern \`devhub logs ${view.name}\`.`
  }
  return `${head} ${view.displayName} ist gerade aus. Stattdessen: \`${upCommand(view)}\` startet alle Prozesse des Profils (${view.processes.map((p) => p.name).join(', ') || 'keine'}) abgekoppelt; danach \`devhub status ${view.name}\`.`
}

const LOCAL_PORT = /(?:\blocalhost|\b127\.0\.0\.1|\b0\.0\.0\.0|\[::1\]|\b[a-z0-9-]+\.localhost):(\d{2,5})\b/gi

export function localPorts(command: string): number[] {
  return [...new Set([...command.matchAll(LOCAL_PORT)].map((m) => Number(m[1])))]
}

/**
 * Hinweis für Ports, die nicht zum Projekt der Sitzung gehören. Kein Verbot:
 * ein Blick auf einen anderen Server ist legitim, aber meist ein Zeichen, dass
 * das Modell eine Adresse geraten hat.
 */
export function portWarning(command: string, view: DevhubView, overview: Overview, hubPort: number): string | undefined {
  const own = new Set(view.ports)
  const strangers = localPorts(command).filter((port) => port !== hubPort && !own.has(port))
  if (!strangers.length) return undefined
  const notes = strangers.map((port) => {
    const owner = overview.projects.find((p) => p.profiles.some((pr) => pr.processes.some((proc) => proc.port === port)))
    return owner
      ? `Port ${port} gehört zum Projekt ${owner.name} (${owner.displayName ?? owner.name})`
      : `Port ${port} gehört keinem Projekt im Hub - womöglich ein selbst gestarteter Server oder eine geratene Adresse`
  })
  const where = addresses(view)
  return `devhub: ${notes.join('; ')}. Diese Sitzung gehört zu ${view.name}${where ? `, dessen Adressen: ${where}` : ''}.`
}

/** Zeilen, die nach Fehler aussehen: Klartext oder pino-JSON ab Level 50. */
const ERROR_LINE = /\b(error|fehler|exception|traceback|failed|fatal|panic|unhandled|ECONNREFUSED|EADDRINUSE)\b|ERR!|"level":\s*(5\d|6\d)\b/i

export function errorLines(lines: readonly string[]): string[] {
  return lines.filter((line) => ERROR_LINE.test(line))
}

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
  /** Am Hauptprojekt: Worktrees, die devhub noch nicht gestartet hat, mit Kurznamen. */
  pendingWorktrees?: { path: string; label?: string }[]
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
    const label =
      pending.project.pendingWorktrees?.find((w) => w.path === pending.path)?.label ?? pending.path.split('/').filter(Boolean).pop()
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
      worktreePath: pending.path,
      worktreeLabel: label
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
    hubConflicts: overview.conflicts.length,
    worktreeLabel: project.worktree?.label,
    mainUrl: project.worktree ? mainFrontUrl(overview, project.worktree.of) : undefined
  }
}

/**
 * Die laufende Adresse des Hauptprojekts, nur zum Vergleich im Band eines
 * Worktrees: wer sie sieht, merkt, dass es eine andere ist als die eigene.
 */
function mainFrontUrl(overview: Overview, mainName: string): string | undefined {
  const main = overview.projects.find((p) => p.name === mainName)
  const procs = (main && chosenProfile(main)?.processes) ?? []
  const front = procs.find((p) => p.role === 'frontend' && p.url) ?? procs.find((p) => p.url)
  return front?.listening && !front.foreign && front.url ? front.url : undefined
}

/**
 * Worktree-Namen tragen oft eine angehängte Kennung (`dsgvo-export-c2d26d`).
 * Im Band zählt der lesbare Teil; die volle Adresse liegt hinter dem Knopf.
 */
export function shortLabel(label: string): string {
  return label.replace(/-[0-9a-f]{6}$/, '') || label
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
 * Kurz gehalten, weil das Band darüber Adresse und Knöpfe trägt; die Zeile
 * bleibt für Oberflächen ohne Band und für ein eingeklapptes Band.
 */
export function statusText(view: DevhubView): string | undefined {
  if (!view.adopted) return undefined
  const parts = [`devhub ${GLYPH[view.state]} ${view.state}`]
  const hint = conflictHint(view)
  if (hint) parts.push(hint)
  return parts.join(' · ')
}

export type BandLink = { href: string; text: string }

/**
 * Ein Prozess neben dem Frontend, im Band nur als Name und Zustand. `fremd`:
 * der Port antwortet, aber nicht der Prozess, den devhub gestartet hat.
 */
export type BandService = { name: string; state: 'läuft' | 'aus' | 'fremd'; href?: string }

/** Was das Band über dem Prompt zeigt; `null` heißt: kein Band. */
export type Band = {
  tone: 'ok' | 'partial' | 'off' | 'warn'
  glyph: string
  /** Die Adresse der Instanz, auf die die Sitzung zeigt - das Wichtigste im Band. */
  link?: BandLink
  /** Statt eines Links, wenn es keine Adresse gibt, der man trauen kann. */
  text?: string
  services: BandService[]
  action?: 'up' | 'restart'
  /** Zweitziel im Hub: das Log des ausgefallenen Prozesses oder die Projektseite. */
  hub?: BandLink
  /** Kurzname des Worktrees, wenn die Sitzung in einem liegt - steht vorne im Band. */
  worktree?: string
  /** Host des laufenden Hauptprojekts, nur zum Vergleich und bewusst ohne Link. */
  main?: string
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const serviceState = (p: DevhubProcess): BandService['state'] => (p.foreign ? 'fremd' : p.listening ? 'läuft' : 'aus')

/**
 * Das Band bleibt ruhig, solange alles läuft (Adresse plus Häkchen), und
 * bietet einen Knopf erst an, wenn etwas zu tun ist.
 */
export function bandOf(view: DevhubView | null, hubPort: number): Band | null {
  if (!view?.adopted) return null
  const worktree = view.worktreeLabel ? shortLabel(view.worktreeLabel) : view.worktreePending ? '' : undefined
  // Ein Worktree ohne eigenen Server bekommt bewusst keinen Hinweis aufs
  // Hauptprojekt: genau dorthin soll niemand zum Testen ausweichen.
  if (view.worktreePending) {
    return { tone: 'off', glyph: '○', text: 'hat keinen Server', services: [], action: 'up', worktree }
  }
  if (view.state === 'aus' && !view.ownConflicts) {
    const text = worktree === undefined ? `${view.displayName} ist aus` : 'Server ist aus'
    return { tone: 'off', glyph: '○', text, services: [], action: 'up', worktree }
  }

  const hubBase = `http://devhub.localhost:${hubPort}/projekt/${encodeURIComponent(view.name)}`
  const front = frontendOf(view)
  const services = backendsOf(view).map((p) => ({
    name: p.name,
    state: serviceState(p),
    href: p.listening && !p.foreign && p.url ? p.url : undefined
  }))

  // Ein Server, den devhub nicht gestartet hat, zeigt womöglich anderen Code
  // (einen Worktree, einen von Hand gestarteten Stand): kein Link darauf und
  // kein Neustart, der am belegten Port nur scheitern würde.
  if (view.ownConflicts) {
    const what =
      front?.foreign && front.url
        ? hostOf(front.url)
        : `Port ${view.processes.filter((p) => p.foreign).map((p) => p.port).join(', ')}`
    return { tone: 'warn', glyph: '⚠', text: `${what} läuft ohne devhub`, services, hub: { href: hubBase, text: 'im Hub' }, worktree }
  }

  const down = view.processes.find((p) => !p.listening)
  // Im Worktree ist der Host lang und dem des Hauptprojekts zum Verwechseln
  // ähnlich; dort trägt das Band vorne den Namen, der Knopf nur „Seite öffnen“.
  const link =
    front?.listening && front.url
      ? { href: front.url, text: worktree === undefined ? hostOf(front.url) : 'Seite öffnen' }
      : undefined
  const partial = view.state === 'teilweise' || Boolean(down)
  const query = new URLSearchParams({
    ...(view.profile === 'default' ? {} : { profil: view.profile }),
    ...(down ? { prozess: down.name } : {})
  })
  return {
    tone: partial ? 'partial' : 'ok',
    glyph: partial ? '◐' : '●',
    link,
    text: link ? undefined : `${front?.name ?? view.displayName} aus`,
    services,
    action: partial ? 'restart' : undefined,
    hub: down ? { href: `${hubBase}/log?${query}`, text: 'Logs' } : undefined,
    worktree,
    main: worktree !== undefined && view.mainUrl ? hostOf(view.mainUrl) : undefined
  }
}

/**
 * Der Kontextblock für das Modell. Bewusst ohne Laufzustand: der Text soll sich
 * nur ändern, wenn sich Adressen ändern, sonst verliert jede Anfrage den
 * Prompt-Cache ab hier.
 */
export function composeText(view: DevhubView): string | undefined {
  if (view.worktreePending) {
    return [
      '# devhub: Git-Worktree ohne eigenen Server',
      '',
      `Diese Sitzung arbeitet in einem Git-Worktree von ${view.displayName.replace(/ · Worktree$/, '')}. Er bekommt eigene Adressen, sobald er mit \`devhub up .\` (im Worktree ausgeführt) gestartet ist; danach gelten \`devhub status .\`, \`devhub logs .\` und \`devhub down .\`.`,
      'Nicht das Hauptprojekt per Ordnername starten - es zeigt den Code des Hauptprojekts, nicht den dieses Worktrees. Nennt `devhub up .` fehlende Schritte (`.env`-Link, `npm ci`), diese ausführen und erneut starten.'
    ].join('\n')
  }
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
  if (view.worktreePending) {
    return `${head} Diese Sitzung liegt in einem Git-Worktree, der noch keinen eigenen Server hat. Stattdessen im Worktree \`devhub up .\` - er bekommt eigene Ports und eine eigene Adresse; nennt der Befehl fehlende Schritte, diese ausführen und wiederholen.`
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

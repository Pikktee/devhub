import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readJson } from './util/json.js'
import { portFor, slugifyLabel, urlFor } from './ports.js'
import { repoRoot } from './paths.js'
import { githubInfoFor } from './git.js'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__'])
const SUBDIR_CANDIDATES = ['web', 'app', 'frontend', 'client', 'site', 'landing', 'ui']
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']

/** Vite und Verwandte akzeptieren `--strictPort`; Next kennt es nicht und weicht
 *  immer aus — dort muss der Hub nach dem Start selbst nachsehen. */
const STRICT_PORT_FRAMEWORKS = new Set(['vite', 'astro', 'nuxt', 'svelte-kit'])

export function packageManagerFor(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun'
  return 'npm'
}

function frameworkFor(pkg) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }
  if (deps.next) return 'next'
  if (deps.nuxt) return 'nuxt'
  if (deps.astro) return 'astro'
  if (deps['@sveltejs/kit']) return 'svelte-kit'
  if (deps.remotion || deps['@remotion/cli']) return 'remotion'
  if (deps.vite) return 'vite'
  if (deps['react-scripts']) return 'cra'
  return pkg ? 'node' : null
}

function composeFileIn(dir) {
  return COMPOSE_FILES.map((f) => join(dir, f)).find((f) => existsSync(f))
}

function hasPythonMarkers(dir) {
  if (existsSync(join(dir, 'requirements.txt')) || existsSync(join(dir, 'pyproject.toml'))) return true
  try {
    return readdirSync(dir).some((f) => f.endsWith('.py'))
  } catch {
    return false
  }
}

/** Wo liegt das Startskript? Etliche Projekte haben es in `web/` oder `landing/`
 *  — die bestehenden launch.json belegen das mit ihren `--prefix`-Aufrufen. */
function findNodeDir(dir) {
  const rootPkg = readJson(join(dir, 'package.json'), null)
  if (rootPkg?.scripts?.dev || rootPkg?.scripts?.start) return { dir, pkg: rootPkg, rel: '.' }
  for (const sub of SUBDIR_CANDIDATES) {
    const pkg = readJson(join(dir, sub, 'package.json'), null)
    if (pkg?.scripts?.dev || pkg?.scripts?.start) return { dir: join(dir, sub), pkg, rel: sub }
  }
  return rootPkg ? { dir, pkg: rootPkg, rel: '.' } : null
}

export function detectStack(dir) {
  const node = findNodeDir(dir)
  const compose = composeFileIn(dir)
  const python = hasPythonMarkers(dir)
  const staticIndex = existsSync(join(dir, 'index.html'))

  if (node?.pkg) {
    const framework = frameworkFor(node.pkg)
    return {
      kind: 'node',
      framework,
      packageManager: packageManagerFor(node.dir),
      workdir: node.rel,
      script: node.pkg.scripts?.dev ? 'dev' : node.pkg.scripts?.start ? 'start' : null,
      alsoCompose: Boolean(compose)
    }
  }
  if (compose) return { kind: 'compose', framework: 'compose', composeFile: basename(compose) }
  if (python) return { kind: 'python', framework: 'python' }
  if (staticIndex) return { kind: 'static', framework: 'static' }
  return { kind: 'unknown', framework: null }
}

function normalizeSpec(raw, index) {
  const role = raw.role ?? raw.rolle ?? (index === 0 ? 'frontend' : 'backend')
  return {
    name: raw.name ?? (role === 'frontend' ? 'web' : 'api'),
    runner: raw.runner ?? 'process',
    role,
    cwd: raw.cwd ?? '.',
    env: raw.env ?? {},
    cmd: raw.cmd ?? [],
    dir: raw.dir,
    composeFile: raw.composeFile ?? raw.compose,
    service: raw.service,
    healthPath: raw.healthPath ?? '/',
    readyTimeoutMs: raw.readyTimeoutMs
  }
}

/** Der Plan schreibt `profile`/`rolle`, englische Schlüssel sind ebenso erlaubt —
 *  eine Datei, die schon existiert, soll nicht an einer Vokabel scheitern. */
export function readDevJson(dir) {
  const file = join(dir, 'dev.json')
  if (!existsSync(file)) return null
  const raw = readJson(file)
  const profilesRaw = raw.profiles ?? raw.profile
  if (!profilesRaw || typeof profilesRaw !== 'object') {
    throw new Error(`${file}: erwartet ein Objekt "profiles" (oder "profile")`)
  }
  const profiles = {}
  for (const [profile, specs] of Object.entries(profilesRaw)) {
    if (!Array.isArray(specs)) throw new Error(`${file}: Profil "${profile}" muss eine Liste sein`)
    profiles[profile] = specs.map(normalizeSpec)
  }
  return { profiles, defaults: raw.env ?? {}, file }
}

/**
 * Script-Args an den Paketmanager. npm/yarn brauchen `--` als Trenner; pnpm
 * reicht alles nach dem Script-Namen durch — ein zusätzliches `--` landet im
 * Kindprozess. Next sieht dann `dev -- --port` und nimmt `--port` als Verzeichnis.
 */
function packageRunCmd(packageManager, script, args) {
  if (packageManager === 'pnpm') {
    return [packageManager, 'run', script, ...args]
  }
  return [packageManager, 'run', script, '--', ...args]
}

/**
 * `npx serve public -l 3000` — Vercel-serve kennt kein `--port`; an `npm run`
 * angehängt crasht es. Stattdessen liefert der Hub den Ordner selbst aus.
 */
function servePublicDir(scriptBody) {
  if (!scriptBody || typeof scriptBody !== 'string') return null
  if (!/(?:^|[\s/])serve(?:@|\s|$)/.test(scriptBody)) return null
  const tokens = scriptBody.trim().split(/\s+/).filter(Boolean)
  const idx = tokens.findIndex((t) => t === 'serve' || t.startsWith('serve@'))
  if (idx < 0) return null
  const next = tokens[idx + 1]
  if (next && !next.startsWith('-')) return next
  return '.'
}

/** Node-API unter server/ (Maptale) oder uv-start neben web/ (Schnappster). */
function inferApiSpec(dir) {
  const serverPkg = readJson(join(dir, 'server', 'package.json'), null)
  if (serverPkg?.scripts?.dev || serverPkg?.scripts?.start) {
    const script = serverPkg.scripts.dev ? 'dev' : 'start'
    const pm = packageManagerFor(join(dir, 'server'))
    return normalizeSpec({
      name: 'api',
      role: 'backend',
      cwd: 'server',
      env: { PORT: '{port}' },
      cmd: [pm, 'run', script]
    })
  }

  // Python-API am Root, Frontend in web/ — `uv run start --prod` startet nur die API.
  if (
    existsSync(join(dir, 'pyproject.toml')) &&
    existsSync(join(dir, 'web', 'package.json')) &&
    (existsSync(join(dir, 'uv.lock')) || existsSync(join(dir, '.venv')))
  ) {
    return normalizeSpec({
      name: 'api',
      role: 'backend',
      cwd: '.',
      cmd: ['uv', 'run', 'start', '--prod', '--skip-tests', '--port', '{port}']
    })
  }

  return null
}

function inferProfiles(dir, stack) {
  if (stack.kind === 'node' && stack.script) {
    const node = findNodeDir(dir)
    const scriptBody = node?.pkg?.scripts?.[stack.script]
    const serveDir = servePublicDir(scriptBody)
    if (serveDir) {
      const rel =
        stack.workdir && stack.workdir !== '.' ? join(stack.workdir, serveDir) : serveDir
      return {
        default: [
          normalizeSpec({
            name: 'web',
            role: 'frontend',
            runner: 'static',
            dir: rel
          })
        ]
      }
    }

    const api = inferApiSpec(dir)
    const strict = STRICT_PORT_FRAMEWORKS.has(stack.framework)
    const portArgs = ['--port', '{port}']
    if (strict) portArgs.push('--strictPort')
    const cmd = packageRunCmd(stack.packageManager, stack.script, portArgs)

    // Frontend kennt die API-Adresse oft fest (8787/8000) — auf den Slot umbiegen.
    const frontendEnv = { PORT: '{port}' }
    if (api) {
      frontendEnv.MAPTALE_API = 'http://127.0.0.1:{backendPort}'
      frontendEnv.NEXT_PUBLIC_API_URL = 'http://127.0.0.1:{backendPort}'
    }

    const web = normalizeSpec({
      name: 'web',
      role: 'frontend',
      cwd: stack.workdir,
      env: frontendEnv,
      cmd
    })

    // Anzeige: Frontend zuerst (Übersicht/Adresse). Startreihenfolge steuert der Supervisor.
    return { default: api ? [web, api] : [web] }
  }
  if (stack.kind === 'compose') {
    return {
      default: [
        normalizeSpec({ name: 'stack', runner: 'compose', role: 'frontend', composeFile: stack.composeFile })
      ]
    }
  }
  if (stack.kind === 'static') {
    return { default: [normalizeSpec({ name: 'web', runner: 'static', role: 'frontend', dir: '.' })] }
  }
  return null
}

/**
 * „Kein Startkommando gefunden" stimmt formal, hilft aber niemandem: die
 * meisten dieser Ordner sollen gar keinen Server haben. Drei Fälle, drei Sätze.
 */
function diagnose(dir, stack) {
  if (stack.kind === 'python') {
    return 'Python-Projekt ohne dev.json — Startkommando ist nicht ableitbar'
  }

  let unterprojekte = []
  try {
    unterprojekte = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
      .filter((entry) => detectStack(join(dir, entry.name)).kind !== 'unknown')
      .map((entry) => entry.name)
  } catch {
    /* nicht lesbar — dann eben ohne */
  }

  if (unterprojekte.length >= 2) {
    return `Sammelordner mit ${unterprojekte.length} Unterprojekten — einzeln aufnehmen, z. B. "dev adopt ${basename(dir)}/${unterprojekte[0]}"`
  }
  if (unterprojekte.length === 1) {
    return `Startbares liegt in ${unterprojekte[0]}/ — "dev adopt ${basename(dir)}/${unterprojekte[0]}"`
  }
  return 'Kein Server erkennbar — falls doch einer laufen soll, dev.json anlegen'
}

export function scanRoots(roots) {
  const found = []
  for (const root of roots) {
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const path = join(root, entry.name)
      if (path === repoRoot) continue // der Hub verwaltet sich nicht selbst
      found.push({ name: entry.name, path })
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, 'de'))
}

function firstMarkdownHeading(file) {
  if (!existsSync(file)) return null
  try {
    const match = readFileSync(file, 'utf8').match(/^#\s+(.+?)\s*$/m)
    const title = match?.[1]?.trim()
    return title || null
  } catch {
    return null
  }
}

/** Scoped npm-IDs und Scaffold-Reste sind keine Produktnamen. */
function humanPackageName(name) {
  if (!name || typeof name !== 'string') return null
  const trimmed = name.trim()
  if (!trimmed || trimmed.startsWith('@') || trimmed.includes('/')) return null
  if (isScaffoldPackageName(trimmed)) return null
  return trimmed
}

/** Typische Create-*-App / Vite-Platzhalter — oft unverändert im Repo. */
function isScaffoldPackageName(name) {
  if (!name || typeof name !== 'string') return true
  const lower = name.trim().toLowerCase()
  if (!lower) return true
  const banned = new Set([
    'react-example',
    'react-app',
    'my-app',
    'my-react-app',
    'vite-project',
    'vite-react',
    'vite-react-typescript',
    'vite-react-ts',
    'vite-app',
    'next-app',
    'create-next-app',
    'untitled',
    'project',
    'app',
    'website',
    'frontend',
    'backend',
    'client',
    'server',
    'web',
    'example',
    'template',
    'demo',
    'sample',
    'test'
  ])
  if (banned.has(lower)) return true
  if (/^(create|example|sample|demo|test)-/.test(lower)) return true
  if (/-(example|template|starter|demo)$/.test(lower)) return true
  return false
}

function titleFromDevJson(dir) {
  const raw = readJson(join(dir, 'dev.json'), null)
  if (!raw || typeof raw !== 'object') return null
  for (const key of ['displayName', 'title']) {
    if (typeof raw[key] === 'string' && raw[key].trim()) return raw[key].trim()
  }
  // Top-Level-`name` nur, wenn es vom Ordner abweicht — sonst ist es oft nur der Slug.
  if (typeof raw.name === 'string' && raw.name.trim() && raw.name.trim() !== basename(dir)) {
    return raw.name.trim()
  }
  return null
}

/** Dateinamen und Meta-Titel sind keine Produktnamen (häufig `# CLAUDE.md`). */
function isMetaTitle(title, { fileBase, dirBase } = {}) {
  if (!title || typeof title !== 'string') return true
  const t = title.trim()
  if (!t) return true
  const lower = t.toLowerCase()
  const banned = new Set([
    'claude.md',
    'agents.md',
    'readme.md',
    'readme',
    'claude',
    'agents',
    'changelog',
    'license',
    'contributing'
  ])
  if (banned.has(lower)) return true
  if (isScaffoldPackageName(t)) return true
  if (fileBase && lower === fileBase.toLowerCase()) return true
  if (dirBase && lower === `${dirBase.toLowerCase()}.md`) return true
  return false
}

/** „KI-Duell – Proxy …“ → „KI-Duell“; Untertitel nach Gedankenstrich weglassen. */
function primaryHeading(title) {
  const parts = title.split(/\s+[–—-]\s+/)
  if (parts.length < 2) return title
  const head = parts[0].trim()
  if (head.length >= 2 && head.length <= 48) return head
  return title
}

function titleFromReadme(dir) {
  const file = join(dir, 'README.md')
  const heading = firstMarkdownHeading(file)
  if (!heading || isMetaTitle(heading, { fileBase: 'README.md', dirBase: basename(dir) })) return null
  return primaryHeading(heading)
}

/**
 * Ableitung ohne Erfindung: nur Quellen, die das Projekt selbst benennt.
 * Expliziter Registry-Eintrag hat Vorrang (siehe describeProject).
 * CLAUDE.md/AGENTS.md bewusst nicht — deren H1 ist oft nur der Dateiname.
 * README vor package.json: npm-Namen sind oft Scaffold-Reste („react-example“).
 */
export function suggestDisplayName(dir) {
  const fromDev = titleFromDevJson(dir)
  if (fromDev && !isMetaTitle(fromDev, { dirBase: basename(dir) })) return fromDev

  const fromReadme = titleFromReadme(dir)
  if (fromReadme) return fromReadme

  const node = findNodeDir(dir)
  const pkgName = humanPackageName(node?.pkg?.name)
  if (pkgName) return pkgName

  return null
}

export function resolveProject(registry, name) {
  const entry = registry.projects[name]
  if (entry) return { name, path: entry.path, slot: entry.slot, profileSlots: entry.profileSlots ?? {}, adopted: true }
  const hit = scanRoots(registry.settings.roots).find((p) => p.name === name)
  if (!hit) return null
  return { name, path: hit.path, slot: undefined, profileSlots: {}, adopted: false }
}

/**
 * Host-Label aus Anzeigename; bei Kollision mit einem anderen Projekt der Ordner.
 * CLI-Identität bleibt der Ordnername — nur die Adresse folgt dem Titel.
 */
export function hostLabelFor(registry, name, displayName) {
  const preferred = slugifyLabel(displayName) || slugifyLabel(name)
  if (!preferred) return slugifyLabel(name) || 'projekt'

  const titelVon = (other) => {
    const stored = registry.projects?.[other]?.displayName ?? registry.displayNames?.[other]
    if (typeof stored === 'string' && stored.trim() && !isMetaTitle(stored.trim(), { dirBase: other })) {
      return stored.trim()
    }
    return other
  }

  const namen = new Set([
    ...Object.keys(registry.projects ?? {}),
    ...Object.keys(registry.displayNames ?? {})
  ])
  for (const other of namen) {
    if (other === name) continue
    const otherSlug = slugifyLabel(titelVon(other)) || slugifyLabel(other)
    if (otherSlug === preferred) return slugifyLabel(name) || preferred
  }
  return preferred
}

/**
 * Vollständige Sicht auf ein Projekt: woher die Profile stammen, welche Ports
 * daraus folgen und was fehlt, um es starten zu können.
 */
export function describeProject(registry, name) {
  const base = resolveProject(registry, name)
  if (!base) return null

  const storedRaw = registry.projects[name]?.displayName ?? registry.displayNames?.[name]
  const storedName =
    typeof storedRaw === 'string' && storedRaw.trim() && !isMetaTitle(storedRaw.trim(), { dirBase: name })
      ? storedRaw.trim()
      : null
  const suggested = existsSync(base.path) ? suggestDisplayName(base.path) : null
  const displayName = storedName || suggested || name
  const hostLabel = hostLabelFor(registry, name, displayName)
  const favorite = (registry.favorites ?? []).includes(name) || Boolean(registry.projects[name]?.favorite)

  if (!existsSync(base.path)) {
    return {
      ...base,
      displayName,
      hostLabel,
      favorite,
      suggestedDisplayName: suggested,
      stack: { kind: 'missing' },
      profiles: {},
      source: 'fehlt',
      problems: [`Ordner ${base.path} existiert nicht`],
      github: null
    }
  }

  const stack = detectStack(base.path)
  const github = githubInfoFor(base.path)
  const problems = []
  let profiles = {}
  let source = 'unbekannt'

  try {
    const devJson = readDevJson(base.path)
    if (devJson) {
      profiles = devJson.profiles
      source = 'dev.json'
    }
  } catch (err) {
    problems.push(err.message)
  }

  if (source === 'unbekannt') {
    const inferred = inferProfiles(base.path, stack)
    if (inferred) {
      profiles = inferred
      source = 'abgeleitet'
    } else {
      problems.push(diagnose(base.path, stack))
    }
  }

  const suffix = registry.settings.domainSuffix
  const resolved = {}
  for (const [profile, specs] of Object.entries(profiles)) {
    const slot = profile === 'default' ? base.slot : base.profileSlots[profile]
    const seen = new Set()
    resolved[profile] = specs.map((spec) => {
      if (seen.has(spec.role)) {
        problems.push(
          `Profil "${profile}": Rolle "${spec.role}" doppelt — jede Rolle hat genau einen Port, ein zweiter Prozess braucht ein eigenes Profil`
        )
      }
      seen.add(spec.role)
      const port = slot === undefined ? undefined : portFor(slot, spec.role)
      return {
        ...spec,
        port,
        url: port === undefined ? undefined : urlFor(hostLabel, profile, port, suffix)
      }
    })
  }

  return {
    ...base,
    displayName,
    hostLabel,
    favorite,
    suggestedDisplayName: suggested,
    stack,
    profiles: resolved,
    source,
    problems,
    github
  }
}

export function listProjects(registry) {
  const names = new Set(Object.keys(registry.projects))
  for (const found of scanRoots(registry.settings.roots)) names.add(found.name)
  return [...names]
    .sort((a, b) => a.localeCompare(b, 'de'))
    .map((name) => describeProject(registry, name))
    .filter(Boolean)
}

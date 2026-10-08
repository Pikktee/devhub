import { execFile } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { packageManagerFor, safeRelative } from './discovery.js'
import { realPath } from './git.js'

const run = promisify(execFile)

const ENV_FILES = ['.env', '.env.local']
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']

/** Hinweise werden von Agenten wörtlich ausgeführt - Pfade mit Leerzeichen oder `$(…)` dürfen nichts anrichten. */
export function shellQuote(value) {
  const text = String(value)
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`
}

const INSTALL = {
  npm: 'npm ci',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --frozen-lockfile',
  bun: 'bun install --frozen-lockfile'
}

/**
 * Was einem frischen Worktree zum Start fehlt. devhub richtet es nicht selbst
 * ein - es schreibt nicht in fremde Projekte -, nennt aber die fertigen Befehle.
 * Sonst scheiterte der Start erst nach dem Bereitschafts-Timeout im Log.
 */
export function missingPreparation(project, specs) {
  const wt = project.path
  const main = project.worktree?.mainPath
  if (!main) return []
  const dirs = [...new Set(['.', ...specs.filter((s) => s.runner === 'process').map((s) => s.cwd ?? '.')])]
  const steps = []

  for (const dir of dirs) {
    const here = resolve(wt, dir)
    for (const file of ENV_FILES) {
      if (!existsSync(join(main, dir, file)) || existsSync(join(here, file))) continue
      const target = relative(here, join(main, dir, file))
      steps.push(`cd ${shellQuote(here)} && ln -s ${shellQuote(target)} ${file}`)
    }
  }

  for (const dir of dirs) {
    const here = resolve(wt, dir)
    if (!existsSync(join(here, 'package.json')) || existsSync(join(here, 'node_modules'))) continue
    if (existsSync(join(here, '.pnp.cjs'))) continue // Yarn Plug'n'Play kommt ohne node_modules aus
    if (!LOCKFILES.some((f) => existsSync(join(here, f)))) continue
    steps.push(`cd ${shellQuote(here)} && ${INSTALL[packageManagerFor(here)]}`)
  }

  const python = existsSync(join(wt, 'pyproject.toml')) || existsSync(join(wt, 'requirements.txt'))
  if (python && existsSync(join(main, '.venv')) && !existsSync(join(wt, '.venv'))) {
    const install = existsSync(join(wt, 'uv.lock'))
      ? 'uv sync'
      : existsSync(join(wt, 'requirements.txt'))
        ? 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt'
        : 'python3 -m venv .venv && .venv/bin/pip install -e .'
    steps.push(`cd ${shellQuote(wt)} && ${install}`)
  }
  return steps
}

function isSqlite(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    return head.toString('latin1') === 'SQLite format 3\0'
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Node bringt SQLite ab Version 22 selbst mit; davor das System-sqlite3 - mit
 * festem Pfad, weil im PATH gern ein uraltes aus dem Android-SDK zuerst steht.
 */
async function vacuumInto(src, dst) {
  const statement = `VACUUM INTO '${dst.replaceAll("'", "''")}'`
  let sqlite = null
  try {
    sqlite = await import('node:sqlite')
  } catch {
    /* zu altes Node */
  }
  if (sqlite) {
    // Nur lesend reicht nicht immer: eine WAL-Datenbank ohne -shm (Hauptinstanz
    // gestoppt) braucht Schreibrecht für die Index-Datei. VACUUM INTO ändert die
    // Quelle trotzdem nicht.
    for (const readOnly of [true, false]) {
      let db
      try {
        // Schreibend öffnen legte eine fehlende Quelle leer an - nur, wenn es sie gibt.
        if (!readOnly && !existsSync(src)) throw new Error(`${src} fehlt`)
        db = new sqlite.DatabaseSync(src, { readOnly })
        db.exec(statement)
        return
      } catch (err) {
        if (!readOnly) throw err
        rmSync(dst, { force: true })
      } finally {
        db?.close()
      }
    }
  }
  const binary = existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3'
  await run(binary, ['-readonly', src, statement])
}

/** APFS-Klon, wo möglich: 225 MB Fotos kosten dann weder Zeit noch Platz. */
async function cloneOrCopy(src, dst, { directory }) {
  const flags = directory ? ['-R'] : []
  try {
    await run('cp', ['-c', ...flags, src, dst])
  } catch {
    await run('cp', [...flags, src, dst])
  }
}

/**
 * Kopiert die in `worktree.daten` genannten Pfade aus dem Hauptprojekt in den
 * Worktree. Die einzige Stelle, an der devhub in ein Projekt schreibt: eine
 * konsistente Kopie einer laufenden SQLite-Datenbank (offene WAL) ist
 * fehleranfällig und gehört nicht in jeden Agenten. `VACUUM INTO` liefert sie
 * auch, während die Hauptinstanz schreibt.
 */
export async function copyWorktreeData(project) {
  const wt = project.path
  const main = project.worktree?.mainPath
  if (!main) throw new Error(`${project.name} ist kein Worktree`)
  if (resolve(wt) === resolve(main)) throw new Error('Worktree und Hauptprojekt sind derselbe Ordner')
  const entries = project.worktreeConfig?.daten ?? []
  if (!entries.length) {
    throw new Error(
      `Keine Daten festgelegt - in ${join(main, 'devhub.json')} unter "worktree": { "daten": [...] } die Pfade eintragen`
    )
  }

  const wtReal = realPath(wt)
  const inside = (path, root) => path.startsWith(root + sep)

  const copied = []
  const skipped = []
  for (const raw of entries) {
    const rel = safeRelative(raw)
    if (!rel) throw new Error(`"${raw}" ist kein Pfad innerhalb des Projekts`)
    // .git ist im Worktree eine Datei mit dem Verweis aufs Haupt-Repo - nie ersetzen.
    if (rel.split(sep)[0] === '.git') throw new Error(`"${raw}" liegt in .git`)
    const src = join(main, rel)
    const dst = join(wt, rel)
    if (!existsSync(src)) {
      skipped.push(`${rel} (fehlt im Hauptprojekt)`)
      continue
    }
    // Der Text des Pfads reicht nicht: ist ein Zwischenordner im Worktree ein
    // Symlink ins Hauptprojekt (Daten teilen), löschte das Ersetzen dessen Daten.
    let ancestor = dirname(dst)
    while (!existsSync(ancestor)) ancestor = dirname(ancestor)
    const ancestorReal = realPath(ancestor)
    if (ancestorReal !== wtReal && !inside(ancestorReal, wtReal)) {
      throw new Error(`"${raw}" zeigt im Worktree auf ${ancestorReal} - das ist nicht der Worktree, nichts kopiert`)
    }
    mkdirSync(dirname(dst), { recursive: true })
    const target = join(realPath(dirname(dst)), rel.split(sep).pop())
    if (!inside(target, wtReal) || realPath(target) === realPath(src)) {
      throw new Error(`"${raw}" zeigt im Worktree auf ${realPath(target)} - das ist nicht der Worktree, nichts kopiert`)
    }
    const directory = statSync(src).isDirectory()
    // Unmittelbar vor dem Löschen noch einmal: ein Checkout im Worktree kann den
    // Ordner seit der ersten Prüfung gegen einen Symlink getauscht haben.
    if (realPath(dirname(target)) !== dirname(target) || !inside(target, wtReal)) {
      throw new Error(`"${raw}": der Ordner hat sich während der Kopie geändert - nichts ersetzt`)
    }

    if (!directory && isSqlite(src)) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${target}${suffix}`, { force: true })
      try {
        await vacuumInto(src, target)
      } catch (err) {
        throw new Error(`${rel}: Kopie fehlgeschlagen - ${String(err.stderr || err.message).trim()}`)
      }
      copied.push(`${rel} (Datenbank)`)
      continue
    }

    rmSync(target, { recursive: true, force: true })
    await cloneOrCopy(src, target, { directory })
    copied.push(directory ? `${rel}/` : rel)
  }
  return { copied, skipped }
}

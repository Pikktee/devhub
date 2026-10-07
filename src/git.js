import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Liest die Git-Config ohne `git` aufzurufen - die Übersicht hat dutzende
 * Ordner, und ein Spawn pro Projekt wäre spürbar und fragil.
 */
export function gitDirOf(root) {
  const marker = join(root, '.git')
  if (!existsSync(marker)) return null
  try {
    if (statSync(marker).isDirectory()) return marker
    const text = readFileSync(marker, 'utf8')
    const match = text.match(/^gitdir:\s*(.+)\s*$/m)
    if (!match) return null
    const target = match[1].trim()
    return isAbsolute(target) ? target : resolve(root, target)
  } catch {
    return null
  }
}

export function findGitRoot(dir, { maxDepth = 6 } = {}) {
  let cur = resolve(dir)
  for (let i = 0; i <= maxDepth; i++) {
    if (gitDirOf(cur)) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
  return null
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return null
  }
}

/** `ref: refs/heads/feat/x` → `feat/x`; eine nackte Commit-Nummer ist detached. */
export function branchFromHead(headText) {
  const match = String(headText ?? '').match(/^ref:\s*refs\/heads\/(.+)$/)
  return match ? match[1].trim() : null
}

/** Pfade vergleichbar machen: /tmp und /private/tmp sind unter macOS derselbe Ort,
 *  und `native` liefert die echte Groß-/Kleinschreibung (Git notiert ~/dev statt ~/Dev). */
export function realPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Wo gehört ein Verzeichnis hin? Liest die Git-Metadaten direkt: ein Worktree
 * hat eine Datei `.git`, die auf `<haupt>/.git/worktrees/<n>` zeigt, und dort
 * verrät `commondir` das Haupt-Repo. Bare Repos und Submodule sind kein Worktree.
 */
export function worktreeInfo(dir) {
  const root = findGitRoot(dir, { maxDepth: 12 })
  if (!root) return null
  const gitDir = gitDirOf(root)
  if (!gitDir) return null
  if (statSync(join(root, '.git')).isDirectory()) {
    return { root: realPath(root), isWorktree: false, mainPath: realPath(root), branch: branchFromHead(readText(join(gitDir, 'HEAD'))) }
  }
  const common = readText(join(gitDir, 'commondir'))
  if (!common) return null
  const commonDir = resolve(gitDir, common)
  if (basename(commonDir) !== '.git') return null
  return {
    root: realPath(root),
    isWorktree: true,
    mainPath: realPath(dirname(commonDir)),
    branch: branchFromHead(readText(join(gitDir, 'HEAD'))),
    folder: basename(root)
  }
}

/**
 * Alle verknüpften Worktrees eines Haupt-Repos, ohne `git worktree list`: die
 * Übersicht fragt das für jedes Projekt ab, ein Spawn pro Projekt wäre spürbar.
 * `missing` heißt: Git kennt ihn noch, der Ordner ist aber weg (prunable).
 */
export function listWorktrees(mainPath) {
  const base = join(mainPath, '.git', 'worktrees')
  let entries = []
  try {
    entries = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    const meta = join(base, entry.name)
    const gitFile = readText(join(meta, 'gitdir'))
    if (!gitFile) continue
    // Seit Git 2.48 darf gitdir relativ sein (worktree.useRelativePaths).
    const path = dirname(resolve(meta, gitFile))
    found.push({
      path: existsSync(path) ? realPath(path) : path,
      branch: branchFromHead(readText(join(meta, 'HEAD'))),
      folder: basename(path),
      locked: existsSync(join(meta, 'locked')),
      missing: !existsSync(resolve(meta, gitFile))
    })
  }
  return found
}

export function remoteUrlFromConfig(configText, preferred = 'origin') {
  const blocks = [...configText.matchAll(/\[remote "([^"]+)"\]([^\[]*)/g)]
  if (!blocks.length) return null
  const preferredBlock = blocks.find((m) => m[1] === preferred) ?? blocks[0]
  const url = preferredBlock[2].match(/^\s*url\s*=\s*(.+)\s*$/m)?.[1]?.trim()
  return url || null
}

/** Nur GitHub - andere Remotes bleiben bewusst ohne Link in der Übersicht. */
export function githubBrowseUrl(remoteUrl) {
  if (!remoteUrl) return null
  const raw = remoteUrl.trim().replace(/\.git$/i, '')

  let match = raw.match(/^git@github\.com:([^/]+\/[^/?#]+)$/i)
  if (match) return `https://github.com/${match[1]}`

  match = raw.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/?#]+)$/i)
  if (match) return `https://github.com/${match[1]}`

  match = raw.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/?#]+)/i)
  if (match) return `https://github.com/${match[1]}`

  return null
}

export function githubInfoFor(dir) {
  const root = findGitRoot(dir)
  if (!root) return null
  const gitDir = gitDirOf(root)
  if (!gitDir) return null
  const configFile = join(gitDir, 'config')
  if (!existsSync(configFile)) return null
  try {
    const remote = remoteUrlFromConfig(readFileSync(configFile, 'utf8'))
    const url = githubBrowseUrl(remote)
    if (!url) return null
    return {
      url,
      root,
      label: url.replace(/^https:\/\/github\.com\//, '')
    }
  } catch {
    return null
  }
}

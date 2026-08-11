import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

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

import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { home } from './paths.js'

/**
 * Unter launchd erbt ein Job ein minimales PATH ohne Homebrew und ohne den
 * Node, mit dem der Hub selbst läuft. Ein `npm run dev` scheitert dann mit
 * "command not found" - und zwar erst im Log, wo es niemand sieht.
 */
export function childPath(basePath = process.env.PATH ?? '') {
  const candidates = [
    dirname(process.execPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.local', 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
  const seen = new Set()
  const parts = []
  for (const part of [...basePath.split(delimiter), ...candidates]) {
    if (!part || seen.has(part)) continue
    if (!existsSync(part)) continue
    seen.add(part)
    parts.push(part)
  }
  return parts.join(delimiter)
}

export function substitute(value, vars) {
  return String(value).replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match))
}

export function substituteAll(input, vars) {
  if (Array.isArray(input)) return input.map((item) => substitute(item, vars))
  const out = {}
  for (const [key, value] of Object.entries(input ?? {})) out[key] = substitute(value, vars)
  return out
}

export function childEnv(extra = {}) {
  return {
    ...process.env,
    PATH: childPath(),
    FORCE_COLOR: '0',
    BROWSER: 'none',
    ...extra
  }
}

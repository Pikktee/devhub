import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** Regenerierbare Artefakte — Quellcode und Lockfiles bleiben. */
export const ARTIFACT_NAMES = [
  'node_modules',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache'
]

const PACKAGE_SUBDIRS = ['web', 'app', 'frontend', 'client', 'site', 'landing', 'ui']

function assertInside(root, target) {
  const base = resolve(root)
  const abs = resolve(target)
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`Aufräumen verweigert: ${target} liegt außerhalb des Projekts`)
  }
}

function packageRoots(projectPath) {
  const roots = new Set([resolve(projectPath)])
  for (const sub of PACKAGE_SUBDIRS) {
    const dir = join(projectPath, sub)
    if (existsSync(join(dir, 'package.json'))) roots.add(resolve(dir))
  }
  return [...roots]
}

function artifactCandidates(projectPath) {
  const out = []
  const seen = new Set()
  for (const root of packageRoots(projectPath)) {
    for (const name of ARTIFACT_NAMES) {
      const path = join(root, name)
      if (!existsSync(path) || seen.has(path)) continue
      seen.add(path)
      out.push({ path, name, root })
    }
  }
  return out
}

function sizeOf(path) {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink() || st.isFile()) return st.size
    if (!st.isDirectory()) return 0
    let total = 0
    for (const name of readdirSync(path)) total += sizeOf(join(path, name))
    return total
  } catch {
    return 0
  }
}

export function listProjectArtifacts(projectPath) {
  const items = artifactCandidates(projectPath).map((item) => ({
    path: item.path,
    name: item.name,
    bytes: sizeOf(item.path)
  }))
  return {
    items,
    bytes: items.reduce((sum, item) => sum + item.bytes, 0)
  }
}

export function cleanProjectArtifacts(projectPath, { dryRun = false } = {}) {
  const candidates = artifactCandidates(projectPath)
  const removed = []
  for (const item of candidates) {
    assertInside(projectPath, item.path)
    if (!dryRun) rmSync(item.path, { recursive: true, force: true })
    removed.push({ path: item.path, name: item.name })
  }
  return { removed }
}

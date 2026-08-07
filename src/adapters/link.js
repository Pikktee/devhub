import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { basename, join } from 'node:path'

export const NEUTRAL = 'AGENTS.md'
export const CLAUDE = 'CLAUDE.md'

const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

function inspectFile(dir, name) {
  const path = join(dir, name)
  let info
  try {
    info = lstatSync(path)
  } catch {
    return { name, path, exists: false }
  }
  if (info.isSymbolicLink()) {
    const target = readlinkSync(path)
    return { name, path, exists: true, symlink: true, target, dangling: !existsSync(path) }
  }
  return { name, path, exists: true, symlink: false, size: info.size }
}

/**
 * Vier Zustände, vier verschiedene richtige Antworten. Zusammengelegt würde man
 * genau den Fall verlieren, in dem Zusammenlegen Inhalt vernichtet.
 */
export function inspectLink(projectDir) {
  const agents = inspectFile(projectDir, NEUTRAL)
  const claude = inspectFile(projectDir, CLAUDE)
  const base = { agents, claude }

  if (!agents.exists && !claude.exists) {
    return { ...base, state: 'keine', safe: false, message: 'Weder AGENTS.md noch CLAUDE.md vorhanden' }
  }

  if (agents.symlink || claude.symlink) {
    const link = agents.symlink ? agents : claude
    const real = agents.symlink ? claude : agents
    if (link.dangling) {
      return {
        ...base,
        state: 'kaputt',
        safe: false,
        message: `${link.name} zeigt auf ${link.target}, das es nicht gibt`
      }
    }
    return {
      ...base,
      state: 'verknüpft',
      safe: false,
      direction: `${link.name} → ${real.name}`,
      message: `bereits verknüpft: ${link.name} → ${link.target}`
    }
  }

  if (agents.exists !== claude.exists) {
    const vorhanden = agents.exists ? agents : claude
    const fehlend = agents.exists ? claude : agents
    return {
      ...base,
      state: 'nur-eine',
      safe: true,
      plan: { real: vorhanden.name, link: fehlend.name },
      message: `nur ${vorhanden.name} — ${fehlend.name} kann darauf zeigen`
    }
  }

  // Beide sind echte Dateien. Nur wenn sie Byte für Byte gleich sind, kann
  // eine davon gefahrlos durch einen Verweis ersetzt werden.
  if (hash(agents.path) === hash(claude.path)) {
    return {
      ...base,
      state: 'gleich',
      safe: true,
      plan: { real: NEUTRAL, link: CLAUDE },
      message: 'zwei identische Kopien — eine kann ein Verweis werden'
    }
  }

  return {
    ...base,
    state: 'verschieden',
    safe: false,
    message: `zwei verschiedene Dateien (${agents.size} und ${claude.size} Bytes) — Zusammenlegen würde Inhalt verwerfen`
  }
}

/**
 * Der Verweis ist relativ, damit er einen Umzug oder einen Klon des Repos
 * überlebt. Ein absoluter Pfad zeigt nach dem Klonen auf einen fremden Rechner.
 */
export function linkRuleFiles(projectDir, { direction, dryRun = false } = {}) {
  const zustand = inspectLink(projectDir)
  if (!zustand.safe) return { ...zustand, changed: false }

  const plan =
    direction === 'claude'
      ? { real: CLAUDE, link: NEUTRAL }
      : direction === 'agents'
        ? { real: NEUTRAL, link: CLAUDE }
        : zustand.plan

  // Bei "nur-eine" bestimmt die vorhandene Datei die Richtung — eine gewünschte
  // Richtung darf nicht dazu führen, dass die einzige Quelle gelöscht wird.
  if (zustand.state === 'nur-eine' && plan.real !== zustand.plan.real) {
    const vorhanden = zustand.plan.real
    return {
      ...zustand,
      changed: false,
      message: `nur ${vorhanden} vorhanden — die Richtung kann erst nach dem Umbenennen gewählt werden`
    }
  }

  const realPath = join(projectDir, plan.real)
  const linkPath = join(projectDir, plan.link)

  if (!dryRun) {
    if (existsSync(linkPath)) {
      const beiseite = `${linkPath}.vor-devhub`
      if (existsSync(beiseite)) rmSync(beiseite)
      renameSync(linkPath, beiseite)
      try {
        symlinkSync(basename(realPath), linkPath)
        rmSync(beiseite)
      } catch (err) {
        renameSync(beiseite, linkPath)
        throw err
      }
    } else {
      symlinkSync(basename(realPath), linkPath)
    }
  }

  return {
    ...zustand,
    changed: true,
    plan,
    message: `${plan.link} → ${plan.real}`
  }
}

import { homedir } from 'node:os'
import { join } from 'node:path'
import { registryFile } from './paths.js'
import { readJson, writeJson } from './util/json.js'
import { SLOT_MAX, SLOT_MIN, assertSlot } from './ports.js'

export const DEFAULT_SETTINGS = {
  roots: [join(homedir(), 'Dev')],
  hubPort: 4000,
  domainSuffix: 'localhost',
  editor: 'cursor',
  showGlobalAgentContext: true,
  readyTimeoutMs: 60000
}

/** `~/…` → Home, damit die UI und CLI dieselben Pfade meinen. */
export function expandPath(value) {
  const s = String(value ?? '').trim()
  if (!s) return ''
  if (s === '~') return homedir()
  if (s.startsWith('~/')) return join(homedir(), s.slice(2))
  return s
}

export function publicSettings(settings = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...settings }
  return {
    roots: [...(merged.roots ?? DEFAULT_SETTINGS.roots)],
    hubPort: merged.hubPort,
    domainSuffix: merged.domainSuffix,
    editor: merged.editor ?? DEFAULT_SETTINGS.editor,
    showGlobalAgentContext: Boolean(merged.showGlobalAgentContext),
    readyTimeoutMs: merged.readyTimeoutMs ?? DEFAULT_SETTINGS.readyTimeoutMs,
    registryFile
  }
}

/**
 * Wendet einen Settings-Patch an (ohne zu speichern).
 * Unbekannte Schlüssel werden ignoriert — die Registry bleibt vorwärtskompatibel.
 */
export function applySettingsPatch(registry, patch = {}) {
  if (!patch || typeof patch !== 'object') {
    throw Object.assign(new Error('Ungültiger Settings-Körper'), { status: 400 })
  }
  const next = { ...registry.settings }
  const warnings = []
  const vorherPort = next.hubPort

  if (patch.roots !== undefined) {
    if (!Array.isArray(patch.roots)) {
      throw Object.assign(new Error('roots muss eine Liste sein'), { status: 400 })
    }
    const roots = []
    const gesehen = new Set()
    for (const roh of patch.roots) {
      const pfad = expandPath(roh)
      if (!pfad) continue
      if (gesehen.has(pfad)) continue
      gesehen.add(pfad)
      roots.push(pfad)
    }
    if (!roots.length) {
      throw Object.assign(new Error('Mindestens ein Wurzelverzeichnis angeben'), { status: 400 })
    }
    next.roots = roots
  }

  if (patch.hubPort !== undefined) {
    const port = Number(patch.hubPort)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw Object.assign(new Error('Hub-Port muss zwischen 1024 und 65535 liegen'), { status: 400 })
    }
    next.hubPort = port
  }

  if (patch.domainSuffix !== undefined) {
    const suffix = String(patch.domainSuffix).trim().toLowerCase()
    if (!/^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/.test(suffix)) {
      throw Object.assign(new Error('Domain-Suffix ist ungültig (z. B. localhost)'), { status: 400 })
    }
    next.domainSuffix = suffix
  }

  if (patch.editor !== undefined) {
    const editor = String(patch.editor).trim()
    if (!editor || /[\0\n\r]/.test(editor)) {
      throw Object.assign(new Error('Editor-Kommando fehlt oder ist ungültig'), { status: 400 })
    }
    next.editor = editor
  }

  if (patch.showGlobalAgentContext !== undefined) {
    next.showGlobalAgentContext = Boolean(patch.showGlobalAgentContext)
  }

  if (patch.readyTimeoutMs !== undefined) {
    const ms = Number(patch.readyTimeoutMs)
    if (!Number.isFinite(ms) || ms < 5000 || ms > 600_000) {
      throw Object.assign(new Error('Bereitschafts-Timeout: 5–600 Sekunden'), { status: 400 })
    }
    next.readyTimeoutMs = Math.round(ms)
  }

  if (next.hubPort !== vorherPort) {
    warnings.push('Hub-Port geändert — danach `devhub service install`, damit launchd den neuen Port lädt.')
  }

  registry.settings = next
  return { settings: publicSettings(next), warnings }
}

const EMPTY = { version: 1, settings: {}, projects: {}, displayNames: {}, retiredSlots: [] }

function stripLegacyFavorite(entry) {
  if (!entry || typeof entry !== 'object') return entry
  const { favorite: _legacy, ...rest } = entry
  return rest
}

export function load() {
  const raw = readJson(registryFile, EMPTY)
  const projects = {}
  for (const [name, entry] of Object.entries(raw.projects ?? {})) {
    projects[name] = stripLegacyFavorite(entry)
  }
  return {
    version: raw.version ?? 1,
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    projects,
    // Anzeigenamen leben getrennt von der Slot-Vergabe, damit man einen Titel
    // setzen kann, bevor das Projekt aufgenommen ist.
    displayNames: raw.displayNames && typeof raw.displayNames === 'object' ? raw.displayNames : {},
    retiredSlots: raw.retiredSlots ?? []
  }
}

export function save(registry) {
  const projects = {}
  for (const [name, entry] of Object.entries(registry.projects ?? {})) {
    projects[name] = stripLegacyFavorite(entry)
  }
  writeJson(registryFile, {
    version: 1,
    settings: registry.settings,
    projects,
    displayNames: registry.displayNames ?? {},
    retiredSlots: registry.retiredSlots
  })
  return registry
}

export function usedSlots(registry) {
  const used = new Set(registry.retiredSlots)
  for (const entry of Object.values(registry.projects)) {
    used.add(entry.slot)
    for (const slot of Object.values(entry.profileSlots ?? {})) used.add(slot)
  }
  return used
}

/** Slots werden nie wiederverwendet: eine alte Adresse im Verlauf des Browsers
 *  soll nicht plötzlich ein fremdes Projekt öffnen. */
export function nextFreeSlot(registry) {
  const used = usedSlots(registry)
  for (let slot = SLOT_MIN; slot <= SLOT_MAX; slot++) {
    if (!used.has(slot)) return slot
  }
  throw new Error('Keine freien Slots mehr — alle Nummern von 10 bis 99 sind vergeben')
}

export function addProject(registry, { name, path, slot, displayName }) {
  if (registry.projects[name]) throw new Error(`${name} ist bereits aufgenommen (Slot ${registry.projects[name].slot})`)
  const chosen = slot === undefined ? nextFreeSlot(registry) : assertSlot(slot)
  if (slot !== undefined && usedSlots(registry).has(chosen)) {
    throw new Error(`Slot ${chosen} ist schon vergeben`)
  }
  const entry = { slot: chosen, path, profileSlots: {}, addedAt: new Date().toISOString() }
  const title = (displayName ?? registry.displayNames?.[name])?.trim()
  if (title) {
    entry.displayName = title
    if (registry.displayNames?.[name]) delete registry.displayNames[name]
  }
  registry.projects[name] = entry
  return entry
}

export function displayNameOf(registry, name) {
  return registry.projects[name]?.displayName ?? registry.displayNames?.[name] ?? undefined
}

export function setDisplayName(registry, name, displayName) {
  const title = typeof displayName === 'string' ? displayName.trim() : ''
  if (registry.projects[name]) {
    if (title) registry.projects[name].displayName = title
    else delete registry.projects[name].displayName
    if (registry.displayNames?.[name]) delete registry.displayNames[name]
  } else {
    registry.displayNames ??= {}
    if (title) registry.displayNames[name] = title
    else delete registry.displayNames[name]
  }
  return title || undefined
}

export function setProfileSlot(registry, name, profile, slot) {
  const entry = registry.projects[name]
  if (!entry) throw new Error(`${name} ist nicht aufgenommen`)
  if (profile === 'default') throw new Error('Das Profil "default" benutzt den Projekt-Slot')
  entry.profileSlots ??= {}
  if (entry.profileSlots[profile]) return entry.profileSlots[profile]
  const chosen = slot === undefined ? nextFreeSlot(registry) : assertSlot(slot)
  if (slot !== undefined && usedSlots(registry).has(chosen)) throw new Error(`Slot ${chosen} ist schon vergeben`)
  entry.profileSlots[profile] = chosen
  return chosen
}

export function slotFor(registry, name, profile = 'default') {
  const entry = registry.projects[name]
  if (!entry) return undefined
  if (profile === 'default') return entry.slot
  return entry.profileSlots?.[profile]
}

export function removeProject(registry, name) {
  const entry = registry.projects[name]
  if (!entry) return false
  const retired = new Set(registry.retiredSlots)
  retired.add(entry.slot)
  for (const slot of Object.values(entry.profileSlots ?? {})) retired.add(slot)
  registry.retiredSlots = [...retired].sort((a, b) => a - b)
  if (entry.displayName) {
    registry.displayNames ??= {}
    registry.displayNames[name] = entry.displayName
  }
  delete registry.projects[name]
  return true
}

export { SLOT_MIN, SLOT_MAX }

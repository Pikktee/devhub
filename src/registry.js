import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { registryFile } from './paths.js'
import { readJson, writeJson } from './util/json.js'
import { SLOT_MAX, SLOT_MIN, WORKTREE_SLOT_MAX, WORKTREE_SLOT_MIN, assertSlot, slugifyLabel } from './ports.js'

export const DEFAULT_SETTINGS = {
  roots: [join(homedir(), 'Dev')],
  hubPort: 4000,
  domainSuffix: 'localhost',
  networkAccess: false,
  networkHost: '',
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
    networkAccess: Boolean(merged.networkAccess),
    networkHost: merged.networkHost ?? '',
    editor: merged.editor ?? DEFAULT_SETTINGS.editor,
    showGlobalAgentContext: Boolean(merged.showGlobalAgentContext),
    readyTimeoutMs: merged.readyTimeoutMs ?? DEFAULT_SETTINGS.readyTimeoutMs,
    registryFile
  }
}

/**
 * Wendet einen Settings-Patch an (ohne zu speichern).
 * Unbekannte Schlüssel werden ignoriert - die Registry bleibt vorwärtskompatibel.
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

  if (patch.networkAccess !== undefined) {
    next.networkAccess = Boolean(patch.networkAccess)
  }

  if (patch.networkHost !== undefined) {
    const host = String(patch.networkHost).trim().toLowerCase()
    if (host && !/^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/.test(host)) {
      throw Object.assign(new Error('Netzwerk-Host ist ungültig (Name oder IP, z. B. 192.168.178.20)'), { status: 400 })
    }
    next.networkHost = host
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
    warnings.push('Hub-Port geändert - danach `devhub service install`, damit launchd den neuen Port lädt.')
  }

  registry.settings = next
  return { settings: publicSettings(next), warnings }
}

const EMPTY = { version: 1, settings: {}, projects: {}, displayNames: {}, retiredSlots: [], worktrees: {} }

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
    retiredSlots: raw.retiredSlots ?? [],
    worktrees: raw.worktrees && typeof raw.worktrees === 'object' ? raw.worktrees : {}
  }
}

/**
 * Worktree-Aufnahmen schreibt nur, wer sie unter Sperre geändert hat
 * (`{ worktrees: true }`). Alle anderen übernehmen den Stand von der Platte -
 * sonst löschte „Slot entfernen“ mit seinem Sekunden alten Ladestand einen
 * Worktree, den ein Agent gerade aufgenommen hat. Unbekannte Schlüssel bleiben
 * erhalten, damit eine ältere devhub-Version nichts Neueres wegschreibt.
 */
export function save(registry, { worktrees = false } = {}) {
  const projects = {}
  for (const [name, entry] of Object.entries(registry.projects ?? {})) {
    projects[name] = stripLegacyFavorite(entry)
  }
  const onDisk = readJson(registryFile, EMPTY)
  writeJson(registryFile, {
    ...onDisk,
    version: 1,
    settings: registry.settings,
    projects,
    displayNames: registry.displayNames ?? {},
    retiredSlots: registry.retiredSlots,
    worktrees: worktrees ? (registry.worktrees ?? {}) : (onDisk.worktrees ?? {})
  })
  if (!worktrees) registry.worktrees = onDisk.worktrees ?? {}
  return registry
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Mehrere Agenten rufen `devhub up .` gleichzeitig auf. Ohne Sperre lesen beide
 * dieselbe Registry, nehmen denselben freien Platz und der Letzte gewinnt.
 * Die Sperre ist eine Datei, die exklusiv angelegt wird; sie gilt als verwaist,
 * wenn ihr Prozess nicht mehr lebt oder sie älter als `staleMs` ist.
 */
/** Verwaist ist eine Sperre, deren Prozess nicht mehr lebt - oder die sehr alt ist. */
function lockAbandoned(lock, staleMs) {
  const holder = Number(readFileSync(lock, 'utf8').split('-')[0])
  if (holder) {
    try {
      process.kill(holder, 0)
    } catch (err) {
      if (err.code === 'ESRCH') return true
    }
  }
  return Date.now() - statSync(lock).mtimeMs > staleMs
}

export async function withLock(fn, { timeoutMs = 10000, staleMs = 30000, file = `${registryFile}.lock` } = {}) {
  const lock = file
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`
  mkdirSync(dirname(lock), { recursive: true })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(lock, 'wx')
      writeSync(fd, token)
      closeSync(fd)
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      try {
        if (lockAbandoned(lock, staleMs)) {
          // Umbenennen statt löschen: von zwei Wartenden gewinnt genau einer, der
          // andere entfernt sonst die eben frisch angelegte Sperre des ersten.
          renameSync(lock, `${lock}.verwaist-${token}`)
          unlinkSync(`${lock}.verwaist-${token}`)
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) throw new Error(`Registry ist gesperrt (${lock}) - läuft gerade ein anderes devhub?`)
      await sleep(50)
    }
  }
  try {
    return await fn()
  } finally {
    // Nur die eigene Sperre entfernen: galt sie als verwaist, hält sie jetzt ein anderer.
    try {
      if (readFileSync(lock, 'utf8') === token) unlinkSync(lock)
    } catch {
      /* schon weg */
    }
  }
}

/**
 * Präfix der Worktree-Adresse aus dem Branch: nur das letzte Segment
 * (`feat/einladungen` → `einladungen`), ohne das `worktree-`, das Claude Code
 * voranstellt. Detached HEAD fällt auf den Ordnernamen zurück.
 */
export function worktreeLabel({ branch, folder } = {}) {
  const fromBranch = branch ? branch.split('/').pop().replace(/^worktree-/, '') : ''
  for (const candidate of [fromBranch, folder, 'worktree']) {
    const slug = slugifyLabel(candidate).slice(0, 63).replace(/-+$/, '')
    if (slug) return slug
  }
  return 'worktree'
}

export function worktreeByPath(registry, path) {
  return Object.entries(registry.worktrees ?? {}).find(([, entry]) => entry.path === path)?.[0] ?? null
}

/**
 * Vergibt Namen und Platz für einen Worktree (unter Sperre aufrufen). Die
 * Adresse bleibt, solange es den Worktree gibt - auch wenn darin später der
 * Branch wechselt, sonst wanderte die URL unter laufenden Sitzungen.
 * `isBusy(slot)` lässt Plätze aus, deren Ports ein fremder Prozess hält.
 */
export async function allocateWorktree(registry, { project, path, branch, folder }, { isBusy = async () => false } = {}) {
  registry.worktrees ??= {}
  const existing = worktreeByPath(registry, path)
  if (existing) return { name: existing, entry: registry.worktrees[existing], created: false }

  const base = worktreeLabel({ branch, folder })
  let label = base
  for (let n = 2; registry.worktrees[`${project}@${label}`]; n++) label = `${base}-${n}`

  const taken = new Set(Object.values(registry.worktrees).map((entry) => entry.slot))
  let slot
  for (let candidate = WORKTREE_SLOT_MIN; candidate <= WORKTREE_SLOT_MAX; candidate++) {
    if (taken.has(candidate)) continue
    if (await isBusy(candidate)) continue
    slot = candidate
    break
  }
  if (slot === undefined) {
    const names = Object.keys(registry.worktrees).sort((a, b) => a.localeCompare(b, 'de'))
    throw new Error(
      `Alle ${WORKTREE_SLOT_MAX - WORKTREE_SLOT_MIN + 1} Worktree-Plätze sind belegt (${names.join(', ')}). ` +
        `"devhub forget <name>" gibt einen frei; welche laufen, zeigt "devhub ports".`
    )
  }

  const name = `${project}@${label}`
  const entry = { project, path, label, branch: branch ?? null, slot, addedAt: new Date().toISOString() }
  registry.worktrees[name] = entry
  return { name, entry, created: true }
}

export function removeWorktree(registry, name) {
  if (!registry.worktrees?.[name]) return false
  delete registry.worktrees[name]
  return true
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
  throw new Error('Keine freien Slots mehr - alle Nummern von 10 bis 99 sind vergeben')
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

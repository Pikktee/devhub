/**
 * Der Slot ist zweistellig und bestimmt beide Ports. Es gibt genau zwei Bänke,
 * damit eine Portnummer rückwärts lesbar bleibt: 5190 ist Slot 90, Frontend.
 */
export const PORT_BANKS = { frontend: 5100, backend: 8700 }

export const SLOT_MIN = 10
export const SLOT_MAX = 99

export const ROLES = Object.keys(PORT_BANKS)

/**
 * Worktrees bekommen eigene Bänke, deren Plätze wiederverwendet werden: Worktrees
 * sind kurzlebig und würden die 90 Projekt-Slots sonst in wenigen Wochen
 * aufbrauchen. 5210 ist Worktree-Platz 10, Frontend.
 */
export const WORKTREE_BANKS = { frontend: 5200, backend: 8800 }
export const WORKTREE_SLOT_MIN = 10
export const WORKTREE_SLOT_MAX = 29

export function assertSlot(slot) {
  if (!Number.isInteger(slot) || slot < SLOT_MIN || slot > SLOT_MAX) {
    throw new Error(`Slot ${slot} liegt außerhalb von ${SLOT_MIN}–${SLOT_MAX}`)
  }
  return slot
}

export function portFor(slot, role = 'frontend') {
  assertSlot(slot)
  const bank = PORT_BANKS[role]
  if (!bank) throw new Error(`Unbekannte Rolle "${role}" - erlaubt sind ${ROLES.join(', ')}`)
  return bank + slot
}

export function worktreePortFor(slot, role = 'frontend') {
  if (!Number.isInteger(slot) || slot < WORKTREE_SLOT_MIN || slot > WORKTREE_SLOT_MAX) {
    throw new Error(`Worktree-Platz ${slot} liegt außerhalb von ${WORKTREE_SLOT_MIN}–${WORKTREE_SLOT_MAX}`)
  }
  const bank = WORKTREE_BANKS[role]
  if (!bank) throw new Error(`Unbekannte Rolle "${role}" - erlaubt sind ${ROLES.join(', ')}`)
  return bank + slot
}

export function describePort(port) {
  for (const [role, bank] of Object.entries(PORT_BANKS)) {
    const slot = port - bank
    if (slot >= SLOT_MIN && slot <= SLOT_MAX) return { role, slot }
  }
  for (const [role, bank] of Object.entries(WORKTREE_BANKS)) {
    const slot = port - bank
    if (slot >= WORKTREE_SLOT_MIN && slot <= WORKTREE_SLOT_MAX) return { role, slot, worktree: true }
  }
  return null
}

/** Anzeigename → Host-Label: „Maptale“ / „Quality Touch“ → maptale / quality-touch. */
export function slugifyLabel(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Host aus dem Anzeigenamen (nicht dem Ordner): maptale.localhost,
 * maptale-smoke.localhost - trennt Cookie-Jars zwischen Profilen.
 * Ein Punkt im Label bleibt eine Ebene: Worktrees heißen
 * `optionen-runde-2.maptale.localhost`.
 */
export function hostFor(label, profile = 'default', suffix = 'localhost') {
  const base =
    String(label ?? '')
      .split('.')
      .map(slugifyLabel)
      .filter(Boolean)
      .join('.') || 'projekt'
  const host = profile === 'default' ? base : `${base}-${slugifyLabel(profile) || 'profil'}`
  return `${host}.${suffix}`
}

export function urlFor(label, profile, port, suffix = 'localhost') {
  return `http://${hostFor(label, profile, suffix)}:${port}`
}

/**
 * Backend-URLs bewusst als 127.0.0.1 - `localhost` kann auf ::1 zeigen, viele
 * APIs lauschen nur auf IPv4. Frontend behält den Anzeige-Host.
 */
export function urlForRole(role, label, profile, port, suffix = 'localhost') {
  if (role === 'backend') return `http://127.0.0.1:${port}`
  return urlFor(label, profile, port, suffix)
}

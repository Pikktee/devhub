import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Alle Interfaces statt nur Loopback - erst damit ist ein Port aus dem LAN erreichbar. */
export const BIND_ALL = '0.0.0.0'
export const BIND_LOCAL = '127.0.0.1'

/**
 * Die Adresse im LAN wird gemessen, nicht gespeichert: DHCP vergibt sie neu, und
 * eine veraltete Nummer in der Registry wäre genau die Sorte Lüge, die dieses
 * Werkzeug vermeiden soll. `en*` zuerst - VPN-Tunnel (utun) und AirDrop (awdl)
 * haben ebenfalls eine IPv4, führen aber aus dem Heimnetz heraus.
 */
export function lanAddress() {
  const candidates = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue // Link-local: kein Router dazwischen
      candidates.push({ name, address: entry.address })
    }
  }
  const rank = (name) => (/^en\d+$/.test(name) ? 0 : /^(utun|awdl|llw|bridge|ipsec|ppp)/.test(name) ? 2 : 1)
  candidates.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
  return candidates[0]?.address ?? null
}

/**
 * Bonjour-Name dieses Rechners. `os.hostname()` liefert den Namen aus dem
 * DHCP-Lease (…fritz.box) - der ist im Netz oft nicht auflösbar.
 */
export async function bonjourHost() {
  try {
    const { stdout } = await run('scutil', ['--get', 'LocalHostName'], { timeout: 2000 })
    const name = stdout.trim().toLowerCase()
    return name ? `${name}.local` : null
  } catch {
    return null
  }
}

/** Host für Netz-URLs: der eingetragene Name, sonst die gemessene Adresse. */
export function networkHostFor(settings = {}) {
  if (!settings.networkAccess) return null
  const configured = String(settings.networkHost ?? '').trim().toLowerCase()
  return configured || lanAddress()
}

export function networkUrlFor(settings, port) {
  const host = networkHostFor(settings)
  if (!host || port === undefined) return undefined
  return `http://${host}:${port}`
}

/** Bind-Adresse fürs Startkommando: im Netzmodus alle Interfaces, sonst wie gehabt. */
export function bindHostFor(settings = {}) {
  return settings.networkAccess ? BIND_ALL : BIND_LOCAL
}

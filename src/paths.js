import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = homedir()

/**
 * Eine zweite Instanz (Entwicklung an der Oberfläche) darf die PID-Dateien der
 * echten Server nicht anfassen - sonst hält man beim Testen fremde Prozesse für
 * die eigenen. Die Registry bleibt geteilt, damit die Portvergabe eine einzige
 * Wahrheit behält.
 */
export const instance = process.env.DEVHUB_INSTANCE || 'default'

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export const configDir = process.env.DEVHUB_CONFIG_DIR || join(home, '.config', 'devhub')

export const stateDir =
  process.env.DEVHUB_STATE_DIR ||
  (instance === 'default'
    ? join(home, '.local', 'state', 'devhub')
    : join(home, '.local', 'state', 'devhub', `instanz-${instance}`))

export const logDir = join(stateDir, 'logs')
export const registryFile = join(configDir, 'registry.json')
export const stateFile = join(stateDir, 'state.json')
export const hubLogFile = join(logDir, 'devhub.log')

export const claudeHome = join(home, '.claude')
export const cursorHome = join(home, '.cursor')
export const codexHome = join(home, '.codex')
export const launchAgentsDir = join(home, 'Library', 'LaunchAgents')
export const launchdLabel = instance === 'default' ? 'dev.local.devhub' : `dev.local.devhub.${instance}`

export { home }

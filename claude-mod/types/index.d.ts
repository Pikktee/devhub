/** Ein Prozess des Projekts, wie der Mod ihn braucht. */
export type DevhubProcess = {
  name: string
  role: string | null
  port: number | null
  url: string | null
  listening: boolean
  foreign: boolean
}

/** Zustand in den Worten der Statuszeile. */
export type DevhubState = 'läuft' | 'teilweise' | 'aus'

/** Das Projekt der Sitzung, verdichtet aus /api/overview. */
export type DevhubView = {
  name: string
  displayName: string
  adopted: boolean
  profile: string
  state: DevhubState
  processes: DevhubProcess[]
  /** Ports aller Profile; was hier fehlt, gehört nicht zum Projekt. */
  ports: number[]
  /** Konflikte dieses Projekts (fremd belegte Ports). */
  ownConflicts: number
  /** Konflikte im ganzen Hub. */
  hubConflicts: number
  /** Die Sitzung liegt in einem Worktree, den devhub noch nicht gestartet hat. */
  worktreePending?: boolean
  worktreePath?: string
}

declare module 'claude-code' {
  interface PluginState {
    devhub: { view: DevhubView | null }
  }
}

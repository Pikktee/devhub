/**
 * Befehle, die einen Dev-Server starten würden. Eine Quelle für zwei Abnehmer:
 * den Bash-Hook (src/adapters/claude.js baut daraus sein `case`) und den
 * Claude-Code-Mod. Deshalb reines ESM ohne Abhängigkeiten - Node und die
 * Mod-Umgebung lesen es beide.
 *
 * Teilzeichenketten statt regulärer Ausdrücke, weil sie sich verlustfrei in
 * Bash-Globs (`*"npm run dev"*`) übersetzen lassen.
 */
export const DEV_SERVER_STARTS = [
  'npm run dev',
  'pnpm dev',
  'pnpm run dev',
  'yarn dev',
  'bun dev',
  'bun run dev',
  'npx vite',
  'next dev',
  'uvicorn ',
  'http.server',
  'npx serve',
  'docker compose up'
]

/** Das erste Muster, das im Befehl vorkommt, sonst undefined. */
export function matchDevServerStart(command) {
  return DEV_SERVER_STARTS.find((pattern) => command.includes(pattern))
}

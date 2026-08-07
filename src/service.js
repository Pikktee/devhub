import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hubLogFile, instance, launchAgentsDir, launchdLabel, logDir, repoRoot } from './paths.js'
import { childPath } from './env.js'
import * as registryStore from './registry.js'

export const plistFile = join(launchAgentsDir, `${launchdLabel}.plist`)
const domain = `gui/${process.getuid()}`

const escape = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function plistContent({ port }) {
  const args = [process.execPath, join(repoRoot, 'bin', 'dev.js'), 'serve', '--port', String(port)]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchdLabel}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${escape(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>WorkingDirectory</key><string>${escape(repoRoot)}</string>
  <key>StandardOutPath</key><string>${escape(hubLogFile)}</string>
  <key>StandardErrorPath</key><string>${escape(hubLogFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escape(childPath())}</string>
    <key>DEVHUB_INSTANCE</key><string>${escape(instance)}</string>
  </dict>
</dict>
</plist>
`
}

function launchctl(args, { ignoreErrors = true } = {}) {
  try {
    return { ok: true, output: execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (err) {
    if (!ignoreErrors) throw err
    return { ok: false, output: err.stderr ?? err.message }
  }
}

export async function installService() {
  const registry = registryStore.load()
  const port = registry.settings.hubPort
  mkdirSync(launchAgentsDir, { recursive: true })
  mkdirSync(logDir, { recursive: true })
  writeFileSync(plistFile, plistContent({ port }), 'utf8')

  launchctl(['bootout', `${domain}/${launchdLabel}`])
  const boot = launchctl(['bootstrap', domain, plistFile], { ignoreErrors: false })
  launchctl(['enable', `${domain}/${launchdLabel}`])
  launchctl(['kickstart', '-k', `${domain}/${launchdLabel}`])

  return {
    ok: boot.ok,
    message: `launchd-Dienst ${launchdLabel} geladen — Hub auf Port ${port}, startet nach Anmeldung von selbst`,
    plist: plistFile
  }
}

export async function uninstallService() {
  launchctl(['bootout', `${domain}/${launchdLabel}`])
  if (existsSync(plistFile)) rmSync(plistFile)
  return { ok: true, message: `launchd-Dienst ${launchdLabel} entfernt` }
}

export function serviceStatus() {
  if (!existsSync(plistFile)) {
    return { installed: false, loaded: false, summary: 'nicht eingerichtet ("devhub service install")' }
  }
  const printed = launchctl(['print', `${domain}/${launchdLabel}`])
  if (!printed.ok) return { installed: true, loaded: false, summary: 'plist vorhanden, aber nicht geladen', plist: plistFile }
  const pid = printed.output.match(/pid = (\d+)/)?.[1]
  const state = printed.output.match(/state = (\w+)/)?.[1]
  return {
    installed: true,
    loaded: true,
    pid: pid ? Number(pid) : undefined,
    summary: `geladen (${state ?? 'unbekannt'}${pid ? `, PID ${pid}` : ''})`,
    plist: plistFile
  }
}

export function hubLog(lines = 40) {
  try {
    return readFileSync(hubLogFile, 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.DEVHUB_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'devhub-config-'))
process.env.DEVHUB_STATE_DIR = mkdtempSync(join(tmpdir(), 'devhub-state-'))

const {
  hasDevhubHook,
  hasPluginDir,
  hookScript,
  withPluginDir,
  withoutDevhubHook,
  withoutPluginDir
} = await import('../src/adapters/claude.js')
const { DEV_SERVER_STARTS, matchDevServerStart } = await import('../claude-mod/hooks/dev-server-patterns.js')

const MOD = '/repo/devhub/claude-mod'

test('trägt den Mod ein und lässt fremde Plugin-Ordner stehen', () => {
  const vorher = { env: { CLAUDE_CODE_PLUGIN_DIRS: '/anderes/plugin', FOO: '1' }, model: 'opus' }
  const { settings, changed } = withPluginDir(vorher, MOD)
  assert.equal(changed, true)
  assert.equal(settings.env.CLAUDE_CODE_PLUGIN_DIRS, `/anderes/plugin:${MOD}`)
  assert.equal(settings.env.FOO, '1')
  assert.equal(settings.model, 'opus')
  assert.equal(vorher.env.CLAUDE_CODE_PLUGIN_DIRS, '/anderes/plugin', 'die Eingabe bleibt unverändert')

  assert.equal(withPluginDir(settings, MOD).changed, false, 'zweimal eintragen ändert nichts')
})

test('legt env an, wenn es fehlt, und räumt es beim Austragen wieder weg', () => {
  const { settings } = withPluginDir({}, MOD)
  assert.deepEqual(settings, { env: { CLAUDE_CODE_PLUGIN_DIRS: MOD } })
  assert.equal(hasPluginDir(settings, MOD), true)

  const leer = withoutPluginDir(settings, MOD)
  assert.equal(leer.changed, true)
  assert.deepEqual(leer.settings, {})
})

test('austragen behält die übrigen Ordner', () => {
  const { settings } = withoutPluginDir({ env: { CLAUDE_CODE_PLUGIN_DIRS: `/a:${MOD}:/b` } }, MOD)
  assert.equal(settings.env.CLAUDE_CODE_PLUGIN_DIRS, '/a:/b')
})

test('entfernt nur den devhub-Hook aus PreToolUse', () => {
  const fremd = { matcher: 'Edit', hooks: [{ type: 'command', command: '/x/format.sh' }] }
  const devhub = { matcher: 'Bash', hooks: [{ type: 'command', command: '/h/.claude/hooks/devhub-kein-dev-server.sh' }] }
  const vorher = { hooks: { PreToolUse: [fremd, devhub], Stop: [] } }
  assert.equal(hasDevhubHook(vorher), true)

  const { settings, changed } = withoutDevhubHook(vorher)
  assert.equal(changed, true)
  assert.deepEqual(settings.hooks.PreToolUse, [fremd])
  assert.deepEqual(settings.hooks.Stop, [])
  assert.equal(withoutDevhubHook(settings).changed, false)
})

test('ohne übrige Hooks verschwindet der hooks-Block', () => {
  const devhub = { matcher: 'Bash', hooks: [{ type: 'command', command: '/h/devhub-kein-dev-server.sh' }] }
  assert.deepEqual(withoutDevhubHook({ hooks: { PreToolUse: [devhub] } }).settings, {})
})

test('Hook und Mod prüfen dieselben Muster', () => {
  const skript = hookScript('devhub')
  for (const muster of DEV_SERVER_STARTS) assert.ok(skript.includes(`*"${muster}"*`), muster)
  assert.equal(matchDevServerStart('cd web && npm run dev -- --port 3000'), 'npm run dev')
  assert.equal(matchDevServerStart('devhub up journey'), undefined)
})

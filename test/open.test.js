import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmp = mkdtempSync(join(tmpdir(), 'devhub-open-'))
const configDir = join(tmp, 'config')
const stateDir = join(tmp, 'state')
const root = join(tmp, 'Dev')
const project = join(root, 'demo')
mkdirSync(configDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })
mkdirSync(project, { recursive: true })
writeFileSync(join(project, 'AGENTS.md'), '# demo\n')
writeFileSync(
  join(configDir, 'registry.json'),
  JSON.stringify({
    version: 1,
    settings: { roots: [root] },
    projects: { demo: { slot: 10, path: project, profileSlots: {}, addedAt: '2026-01-01T00:00:00.000Z' } },
    displayNames: {},
    retiredSlots: []
  })
)

process.env.DEVHUB_CONFIG_DIR = configDir
process.env.DEVHUB_STATE_DIR = stateDir

const { assertOpenablePath } = await import('../src/open.js')
const registryStore = await import('../src/registry.js')

describe('assertOpenablePath', () => {
  const registry = registryStore.load()

  it('erlaubt Projektdateien', () => {
    const datei = join(project, 'AGENTS.md')
    assert.equal(assertOpenablePath(registry, datei), datei)
  })

  it('erlaubt Hub-Zustand', () => {
    const log = join(stateDir, 'logs')
    mkdirSync(log, { recursive: true })
    const datei = join(log, 'demo.log')
    writeFileSync(datei, 'hi\n')
    assert.equal(assertOpenablePath(registry, datei), datei)
  })

  it('lehnt fremde Pfade ab', () => {
    assert.throws(() => assertOpenablePath(registry, '/etc/passwd'), /nicht geöffnet/)
  })

  it('braucht einen Pfad', () => {
    assert.throws(() => assertOpenablePath(registry, ''), /fehlt/)
  })

  after(() => {
    rmSync(tmp, { recursive: true, force: true })
  })
})

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.DEVHUB_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'devhub-setup-config-'))
process.env.DEVHUB_STATE_DIR = mkdtempSync(join(tmpdir(), 'devhub-setup-state-'))

const {
  assertEnvironment,
  chooseDefaultRoot,
  expandPath,
  installCursorSkill,
  parseWurzelFlag,
  resolveRoots,
  runSetup,
  SKILL_SOURCE,
  writeRootsToRegistry
} = await import('../src/setup.js')
const registryStore = await import('../src/registry.js')
const { parseArgs } = await import('../src/cli.js')
const { registryFile } = await import('../src/paths.js')

test('Umgebung: nur macOS und Node ≥ 20', () => {
  assert.doesNotThrow(() => assertEnvironment({ platform: 'darwin', nodeVersion: '20.11.0' }))
  assert.throws(() => assertEnvironment({ platform: 'linux', nodeVersion: '20.0.0' }), /macOS/)
  assert.throws(() => assertEnvironment({ platform: 'darwin', nodeVersion: '18.19.0' }), /Node/)
})

test('Wurzel-Flag: Tilde und Komma', () => {
  const home = '/Users/test'
  assert.deepEqual(parseWurzelFlag('~/Code', home), [join(home, 'Code')])
  assert.deepEqual(parseWurzelFlag('~/Code, ~/Work', home), [join(home, 'Code'), join(home, 'Work')])
  assert.equal(expandPath('~', home), home)
})

test('CLI versteht --wurzel / --root / -w', () => {
  assert.equal(parseArgs(['setup', '--wurzel', '~/Code']).flags.wurzel, '~/Code')
  assert.equal(parseArgs(['setup', '--root', '~/Dev']).flags.wurzel, '~/Dev')
  assert.equal(parseArgs(['setup', '-w', '~/x']).flags.wurzel, '~/x')
})

test('fehlendes ~/Dev ohne TTY bricht mit Hinweis ab', async () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'devhub-missing-')), 'gibt-es-nicht')
  await assert.rejects(
    () => chooseDefaultRoot({ defaultRoot: missing, isTTY: false }),
    /--wurzel/
  )
})

test('fehlendes ~/Dev mit Dialog: Enter legt Pfad fest', async () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'devhub-ask-')), 'Dev')
  const chosen = await chooseDefaultRoot({
    defaultRoot: missing,
    isTTY: true,
    ask: async () => ''
  })
  assert.equal(chosen, missing)
})

test('fehlendes ~/Dev mit Dialog: p wählt anderen Pfad', async () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'devhub-ask2-')), 'Dev')
  const other = join(mkdtempSync(join(tmpdir(), 'devhub-other-')), 'Code')
  const answers = ['p', other]
  const chosen = await chooseDefaultRoot({
    defaultRoot: missing,
    isTTY: true,
    ask: async () => answers.shift()
  })
  assert.equal(chosen, other)
})

test('existierendes Default ohne Dialog', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devhub-exists-'))
  const chosen = await chooseDefaultRoot({
    defaultRoot: root,
    isTTY: false,
    ask: async () => {
      throw new Error('sollte nicht fragen')
    }
  })
  assert.equal(chosen, root)
})

test('resolveRoots: Flag schlägt Registry und Default', async () => {
  const home = mkdtempSync(join(tmpdir(), 'devhub-home-'))
  const flagRoot = join(home, 'ViaFlag')
  const roots = await resolveRoots({
    wurzel: flagRoot,
    home,
    isTTY: false
  })
  assert.deepEqual(roots, [flagRoot])
})

test('resolveRoots: explizite Registry-Wurzeln', async () => {
  const home = mkdtempSync(join(tmpdir(), 'devhub-reghome-'))
  const root = join(home, 'FromRegistry')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    registryFile,
    JSON.stringify({ version: 1, settings: { roots: [root] }, projects: {}, retiredSlots: [] }, null, 2)
  )
  const roots = await resolveRoots({ home, isTTY: false })
  assert.deepEqual(roots, [root])
})

test('Skill-Kopie und Setup ohne externe Schritte', async () => {
  const home = mkdtempSync(join(tmpdir(), 'devhub-setuphome-'))
  const root = join(home, 'Dev')
  mkdirSync(root, { recursive: true })
  writeFileSync(registryFile, JSON.stringify({ version: 1, settings: {}, projects: {}, retiredSlots: [] }, null, 2))

  const skillTarget = join(mkdtempSync(join(tmpdir(), 'devhub-skill-')), 'SKILL.md')
  assert.ok(existsSync(SKILL_SOURCE))

  const result = await runSetup({
    wurzel: root,
    skipExternal: true,
    home,
    isTTY: false,
    skillTarget
  })

  assert.deepEqual(result.roots, [root])
  assert.ok(existsSync(skillTarget))
  assert.match(readFileSync(skillTarget, 'utf8'), /devhub status/)
  const registry = registryStore.load()
  assert.deepEqual(registry.settings.roots, [root])
  assert.ok(result.steps.every((s) => s.ok))
})

test('writeRootsToRegistry speichert Wurzeln', () => {
  const root = mkdtempSync(join(tmpdir(), 'devhub-writeroot-'))
  writeRootsToRegistry([root])
  assert.deepEqual(registryStore.load().settings.roots, [root])
})

test('installCursorSkill legt Ziel an', () => {
  const target = join(mkdtempSync(join(tmpdir(), 'devhub-skill2-')), 'skills', 'devhub', 'SKILL.md')
  installCursorSkill({ target })
  assert.ok(existsSync(target))
})

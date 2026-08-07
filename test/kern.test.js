import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.DEVHUB_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'devhub-config-'))
process.env.DEVHUB_STATE_DIR = mkdtempSync(join(tmpdir(), 'devhub-state-'))

const ports = await import('../src/ports.js')
const registryStore = await import('../src/registry.js')
const { suggestDisplayName, describeProject } = await import('../src/discovery.js')
const { applyBlock, ensureGitignore, localContractText, portableContractText, removeBlock, START, END, GITIGNORE_START } =
  await import('../src/adapters/contract.js')
const { launchJsonFor } = await import('../src/adapters/claude.js')
const { parseArgs } = await import('../src/cli.js')
const { githubBrowseUrl, githubInfoFor, remoteUrlFromConfig } = await import('../src/git.js')

test('Slot bestimmt beide Ports', () => {
  assert.equal(ports.portFor(90, 'frontend'), 5190)
  assert.equal(ports.portFor(90, 'backend'), 8790)
  assert.equal(ports.portFor(91, 'backend'), 8791, 'Journeys smoke-API behält ihre vertraute Nummer')
  assert.deepEqual(ports.describePort(5114), { role: 'frontend', slot: 14 })
  assert.throws(() => ports.portFor(9, 'frontend'), /außerhalb/)
})

test('Adressen folgen dem Anzeigenamen, nicht dem Ordner', () => {
  assert.equal(ports.hostFor('Maptale', 'default'), 'maptale.localhost')
  assert.equal(ports.hostFor('Maptale', 'smoke'), 'maptale-smoke.localhost')
  assert.equal(ports.hostFor('Quality Touch', 'default'), 'quality-touch.localhost')
  assert.equal(ports.hostFor('Patina', 'default'), 'patina.localhost')
  assert.equal(ports.slugifyLabel('Sperrmüll-Termine FFM'), 'sperrmull-termine-ffm')
  assert.equal(ports.urlFor('Maptale', 'default', 5120), 'http://maptale.localhost:5120')
})

test('Slots werden vergeben und nie wiederverwendet', () => {
  const registry = { settings: {}, projects: {}, retiredSlots: [] }
  const a = registryStore.addProject(registry, { name: 'eins', path: '/tmp/eins' })
  const b = registryStore.addProject(registry, { name: 'zwei', path: '/tmp/zwei' })
  assert.notEqual(a.slot, b.slot)

  registryStore.setProfileSlot(registry, 'eins', 'smoke')
  assert.ok(registryStore.slotFor(registry, 'eins', 'smoke') > 0)

  registryStore.removeProject(registry, 'eins')
  const c = registryStore.addProject(registry, { name: 'drei', path: '/tmp/drei' })
  assert.ok(!registry.retiredSlots.includes(c.slot))
  assert.ok(registry.retiredSlots.includes(a.slot), 'der alte Slot bleibt gesperrt')
})

test('fester Slot kann nicht doppelt vergeben werden', () => {
  const registry = { settings: {}, projects: {}, retiredSlots: [] }
  registryStore.addProject(registry, { name: 'journey', path: '/tmp/journey', slot: 90 })
  assert.throws(() => registryStore.addProject(registry, { name: 'anderes', path: '/tmp/x', slot: 90 }), /vergeben/)
})

test('Vertragsblock ist idempotent und lässt Fremdtext stehen', () => {
  const eigen = '# Mein Projekt\n\nEigener Text.\n'
  const eins = applyBlock(eigen, 'REGEL A')
  const zwei = applyBlock(eins, 'REGEL A')
  assert.equal(eins, zwei)
  assert.ok(eins.startsWith('# Mein Projekt'))
  assert.ok(eins.includes(START) && eins.includes(END))

  const ersetzt = applyBlock(eins, 'REGEL B')
  assert.ok(ersetzt.includes('REGEL B'))
  assert.ok(!ersetzt.includes('REGEL A'))
  assert.ok(ersetzt.startsWith('# Mein Projekt'))
})

test('Vertragsblock lässt sich wieder entfernen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devhub-unsync-'))
  const datei = join(dir, 'AGENTS.md')
  writeFileSync(datei, applyBlock('# Hallo\n', 'REGEL'))
  const entfernt = removeBlock(datei)
  assert.equal(entfernt.changed, true)
  assert.equal(entfernt.action, 'devhub-Block entfernt')
  assert.equal(readFileSync(datei, 'utf8').trim(), '# Hallo')

  writeFileSync(datei, applyBlock('', 'NUR HUB'))
  const geloescht = removeBlock(datei)
  assert.equal(geloescht.deleted, true)
  assert.equal(existsSync(datei), false)
})

test('AGENTS.md-Hinweis ist portabel, Ports nur lokal', () => {
  const portable = portableContractText({ project: 'demo' })
  assert.match(portable, /Ohne `dev`/)
  assert.doesNotMatch(portable, /\.localhost:\d+/)
  assert.doesNotMatch(portable, /\| Profil \| Adresse \|/)

  const lokal = localContractText({
    project: 'demo',
    hubPort: 4000,
    instances: [{ profile: 'default', entries: [{ name: 'web', url: 'http://demo.localhost:5110' }] }]
  })
  assert.match(lokal, /demo\.localhost:5110/)
  assert.match(lokal, /nicht committed/)

  const dir = mkdtempSync(join(tmpdir(), 'devhub-gi-'))
  const gi = ensureGitignore(dir)
  assert.equal(gi.changed, true)
  const text = readFileSync(join(dir, '.gitignore'), 'utf8')
  assert.ok(text.includes(GITIGNORE_START))
  assert.ok(text.includes('.claude/launch.json'))
  assert.ok(text.includes('devhub.local.mdc'))
  assert.equal(ensureGitignore(dir).changed, false)
})

test('launch.json enthält ausschließlich Attach-Einträge', () => {
  const json = launchJsonFor([
    { profile: 'default', entries: [{ name: 'web', port: 5190, url: 'http://journey.localhost:5190' }] },
    { profile: 'smoke', entries: [{ name: 'web', port: 5191, url: 'http://journey-smoke.localhost:5191' }] }
  ])
  assert.equal(json.configurations.length, 2)
  assert.equal(json.configurations[1].name, 'web-smoke')
  for (const config of json.configurations) {
    assert.ok(!('runtimeExecutable' in config), 'kein Kommando — sonst startet Claude Code selbst')
    assert.ok(!('autoPort' in config), 'autoPort erzeugt genau den zweiten Server, den wir verhindern')
    assert.ok(config.url && config.port)
  }
})

test('Favoriten und Anzeigenamen überleben ohne Slot', () => {
  const registry = { settings: {}, projects: {}, favorites: [], displayNames: {}, retiredSlots: [] }
  assert.equal(registryStore.toggleFavorite(registry, 'journey'), true)
  assert.deepEqual(registry.favorites, ['journey'])
  assert.equal(registryStore.setDisplayName(registry, 'journey', 'Maptale'), 'Maptale')
  assert.equal(registry.displayNames.journey, 'Maptale')

  registryStore.addProject(registry, { name: 'journey', path: '/tmp/journey', slot: 90 })
  assert.equal(registry.projects.journey.displayName, 'Maptale')
  assert.equal(registry.displayNames.journey, undefined)
  assert.equal(registryStore.isFavorite(registry, 'journey'), true)
  assert.equal(registryStore.toggleFavorite(registry, 'journey'), false)
  assert.equal(registry.projects.journey.favorite, undefined)
})

test('Anzeigename wird aus Projektquellen abgeleitet, nicht erfunden', () => {
  const root = mkdtempSync(join(tmpdir(), 'devhub-name-'))
  const withTitle = join(root, 'journey')
  mkdirSync(withTitle)
  writeFileSync(
    join(withTitle, 'dev.json'),
    JSON.stringify({ title: 'Maptale', profiles: { default: [{ name: 'web', role: 'frontend', cmd: ['echo'] }] } })
  )
  writeFileSync(join(withTitle, 'package.json'), JSON.stringify({ name: '@acme/journey' }))
  assert.equal(suggestDisplayName(withTitle), 'Maptale')

  const withReadme = join(root, 'anders')
  mkdirSync(withReadme)
  writeFileSync(join(withReadme, 'README.md'), '# Produktname\n\nText.\n')
  writeFileSync(join(withReadme, 'package.json'), JSON.stringify({ name: '@acme/anders' }))
  assert.equal(suggestDisplayName(withReadme), 'Produktname')

  const scopedOnly = join(root, 'scoped')
  mkdirSync(scopedOnly)
  writeFileSync(join(scopedOnly, 'package.json'), JSON.stringify({ name: '@acme/scoped' }))
  assert.equal(suggestDisplayName(scopedOnly), null)

  // H1 in CLAUDE.md ist oft nur der Dateiname — kein Produktname.
  const claudeMeta = join(root, 'pitfall-remake')
  mkdirSync(claudeMeta)
  writeFileSync(join(claudeMeta, 'CLAUDE.md'), '# CLAUDE.md\n\nRegeln.\n')
  writeFileSync(join(claudeMeta, 'AGENTS.md'), '# AGENTS.md\n\nRegeln.\n')
  assert.equal(suggestDisplayName(claudeMeta), null)

  const readmeBeatsClaude = join(root, 'spiel')
  mkdirSync(readmeBeatsClaude)
  writeFileSync(join(readmeBeatsClaude, 'CLAUDE.md'), '# CLAUDE.md\n')
  writeFileSync(join(readmeBeatsClaude, 'README.md'), '# Pitfall Remake\n')
  assert.equal(suggestDisplayName(readmeBeatsClaude), 'Pitfall Remake')

  // Vite-/CRA-Scaffold in package.json darf README nicht verdecken.
  const scaffold = join(root, 'ki-duell')
  mkdirSync(scaffold)
  mkdirSync(join(scaffold, 'frontend'))
  writeFileSync(
    join(scaffold, 'frontend', 'package.json'),
    JSON.stringify({ name: 'react-example', scripts: { dev: 'vite' } })
  )
  writeFileSync(join(scaffold, 'README.md'), '# KI-Duell – Proxy (Firebase Functions)\n\nText.\n')
  assert.equal(suggestDisplayName(scaffold), 'KI-Duell')

  // Host folgt dem Anzeigenamen; Ordner bleibt CLI-Schlüssel.
  const named = describeProject(
    {
      settings: { roots: [root], domainSuffix: 'localhost' },
      projects: { journey: { path: withTitle, slot: 20, displayName: 'Maptale', profileSlots: {} } },
      favorites: [],
      displayNames: {},
      retiredSlots: []
    },
    'journey'
  )
  assert.equal(named.hostLabel, 'maptale')
  assert.equal(named.profiles.default[0].url, 'http://maptale.localhost:5120')

  // Gespeicherter Meta-Titel aus älterer Ableitung zählt nicht als Anzeigename.
  const registry = {
    settings: { roots: [root] },
    projects: {
      'pitfall-remake': { path: claudeMeta, slot: 20, displayName: 'CLAUDE.md' }
    },
    favorites: [],
    displayNames: {},
    retiredSlots: []
  }
  const view = describeProject(registry, 'pitfall-remake')
  assert.equal(view.displayName, 'pitfall-remake')
})

test('Kommandozeile versteht deutsche und kurze Schalter', () => {
  assert.deepEqual(parseArgs(['up', 'journey', '--profil', 'smoke']), {
    positionals: ['up', 'journey'],
    flags: { profile: 'smoke' }
  })
  assert.deepEqual(parseArgs(['logs', 'journey', '-f', '-n', '20']), {
    positionals: ['logs', 'journey'],
    flags: { follow: true, lines: '20' }
  })
  assert.deepEqual(parseArgs(['down', '--alle']), { positionals: ['down'], flags: { all: true } })
  assert.deepEqual(parseArgs(['sync', '--probelauf']), { positionals: ['sync'], flags: { dryRun: true } })
  assert.deepEqual(parseArgs(['open', 'devhub', '--finder']), {
    positionals: ['open', 'devhub'],
    flags: { finder: true }
  })
  assert.deepEqual(parseArgs(['open', 'devhub', '--ordner']), {
    positionals: ['open', 'devhub'],
    flags: { finder: true }
  })
})

test('GitHub-Remotes werden aus der Config gelesen', () => {
  assert.equal(githubBrowseUrl('git@github.com:acme/app.git'), 'https://github.com/acme/app')
  assert.equal(githubBrowseUrl('https://github.com/acme/app.git'), 'https://github.com/acme/app')
  assert.equal(githubBrowseUrl('ssh://git@github.com/acme/app.git'), 'https://github.com/acme/app')
  assert.equal(githubBrowseUrl('git@gitlab.com:acme/app.git'), null)

  const config = `[core]
	repositoryformatversion = 0
[remote "origin"]
	url = git@github.com:henrik/devhub.git
	fetch = +refs/heads/*:refs/remotes/origin/*
`
  assert.equal(remoteUrlFromConfig(config), 'git@github.com:henrik/devhub.git')

  const dir = mkdtempSync(join(tmpdir(), 'devhub-git-'))
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, '.git', 'config'), config)
  assert.deepEqual(githubInfoFor(dir), {
    url: 'https://github.com/henrik/devhub',
    root: dir,
    label: 'henrik/devhub'
  })
  mkdirSync(join(dir, 'src'))
  assert.equal(githubInfoFor(join(dir, 'src')).url, 'https://github.com/henrik/devhub')
})

test('Artefakte auflisten und löschen bleibt im Projekt', async () => {
  const { listProjectArtifacts, cleanProjectArtifacts } = await import('../src/clean.js')
  const dir = mkdtempSync(join(tmpdir(), 'devhub-clean-'))
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1')
  mkdirSync(join(dir, '.next', 'cache'), { recursive: true })
  writeFileSync(join(dir, '.next', 'cache', 'x'), 'cache')
  writeFileSync(join(dir, 'package.json'), '{"name":"demo"}')
  writeFileSync(join(dir, 'src.js'), 'ok')

  const listed = listProjectArtifacts(dir)
  assert.equal(listed.items.length, 2)
  assert.ok(listed.bytes > 0)

  const cleaned = cleanProjectArtifacts(dir)
  assert.equal(cleaned.removed.length, 2)
  assert.equal(existsSync(join(dir, 'node_modules')), false)
  assert.equal(existsSync(join(dir, '.next')), false)
  assert.equal(existsSync(join(dir, 'src.js')), true)
  assert.equal(existsSync(join(dir, 'package.json')), true)
})

test('pnpm-Startkommando ohne doppeltes -- (Next würde --port sonst als Verzeichnis lesen)', () => {
  const root = mkdtempSync(join(tmpdir(), 'devhub-pnpm-'))
  const dir = join(root, 'site')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'site',
      scripts: { dev: 'next dev' },
      dependencies: { next: '15.0.0' }
    })
  )
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')

  const registry = {
    settings: { roots: [root] },
    projects: { site: { path: dir, slot: 14, profileSlots: {} } },
    favorites: [],
    displayNames: {},
    retiredSlots: []
  }
  const view = describeProject(registry, 'site')
  assert.equal(view.stack.packageManager, 'pnpm')
  assert.deepEqual(view.profiles.default[0].cmd, ['pnpm', 'run', 'dev', '--port', '{port}'])

  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'site',
    scripts: { dev: 'vite' },
    dependencies: { vite: '6.0.0' }
  }))
  // ohne pnpm-lock → npm; dort bleibt der Trenner
  unlinkSync(join(dir, 'pnpm-lock.yaml'))
  const npmView = describeProject(registry, 'site')
  assert.equal(npmView.stack.packageManager, 'npm')
  assert.deepEqual(npmView.profiles.default[0].cmd, [
    'npm',
    'run',
    'dev',
    '--',
    '--port',
    '{port}',
    '--strictPort'
  ])
})

test('--deps-loeschen wird als cleanDeps erkannt', () => {
  assert.equal(parseArgs(['forget', 'demo', '--deps-loeschen']).flags.cleanDeps, true)
  assert.equal(parseArgs(['forget', 'demo', '--clean-deps']).flags.cleanDeps, true)
})

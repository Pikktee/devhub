import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

process.env.DEVHUB_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'devhub-config-'))
process.env.DEVHUB_STATE_DIR = mkdtempSync(join(tmpdir(), 'devhub-state-'))

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const ports = await import('../src/ports.js')
const registryStore = await import('../src/registry.js')
const { describeProject, projectNameForPath, readDevJson } = await import('../src/discovery.js')
const { listWorktrees, worktreeInfo } = await import('../src/git.js')
const { copyWorktreeData, missingPreparation, shellQuote } = await import('../src/worktree.js')
const supervisor = await import('../src/supervisor.js')
const { probePort } = await import('../src/probe.js')

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    stdio: 'pipe'
  })

/** Eine Wurzel mit Projekt `haupt` (Git-Repo, Inhalt aus `vorlage`) und einem Worktree. */
function repoMitWorktree({ vorlage, branch = 'worktree-optionen-runde-2', ordner = 'optionen-runde-2' } = {}) {
  const wurzel = realpathSync(mkdtempSync(join(tmpdir(), 'devhub-wurzel-')))
  const haupt = join(wurzel, 'haupt')
  mkdirSync(haupt)
  if (vorlage) cpSync(vorlage, haupt, { recursive: true })
  else writeFileSync(join(haupt, 'package.json'), JSON.stringify({ name: 'haupt', scripts: { dev: 'vite' }, devDependencies: { vite: '*' } }))
  git(haupt, 'init', '-q')
  git(haupt, 'add', '.')
  git(haupt, 'commit', '-q', '-m', 'start')
  const wt = join(haupt, '.claude', 'worktrees', ordner)
  git(haupt, 'worktree', 'add', '-q', '-b', branch, wt)
  return { wurzel, haupt, wt }
}

function registryMit(wurzel, patch = {}) {
  const registry = registryStore.load()
  registry.settings.roots = [wurzel]
  Object.assign(registry.settings, patch)
  return registry
}

test('Worktrees haben eigene Bänke, die describePort kennt', () => {
  assert.equal(ports.worktreePortFor(10, 'frontend'), 5210)
  assert.equal(ports.worktreePortFor(29, 'backend'), 8829)
  assert.throws(() => ports.worktreePortFor(30, 'frontend'), /außerhalb/)
  assert.deepEqual(ports.describePort(5212), { role: 'frontend', slot: 12, worktree: true })
  assert.deepEqual(ports.describePort(8728), { role: 'backend', slot: 28 }, 'Projekt-Bank bleibt unverändert')
  assert.equal(ports.hostFor('optionen-runde-2.maptale', 'default'), 'optionen-runde-2.maptale.localhost')
  assert.equal(ports.hostFor('Maptale', 'smoke'), 'maptale-smoke.localhost')
})

test('Adresse kommt aus dem Branch, ohne Präfixe', () => {
  assert.equal(registryStore.worktreeLabel({ branch: 'worktree-optionen-runde-2', folder: 'x' }), 'optionen-runde-2')
  assert.equal(registryStore.worktreeLabel({ branch: 'feat/einladungen-weitergeben' }), 'einladungen-weitergeben')
  assert.equal(registryStore.worktreeLabel({ branch: 'claude/sicherheit-etappe-2' }), 'sicherheit-etappe-2')
  assert.equal(registryStore.worktreeLabel({ branch: null, folder: 'kind-shannon-8918c8' }), 'kind-shannon-8918c8', 'detached: Ordner')
  assert.equal(registryStore.worktreeLabel({ branch: 'Ümlaut_Test' }), 'umlaut-test')
  assert.equal(registryStore.worktreeLabel({ branch: 'x'.repeat(80) }).length, 63, 'ein DNS-Label hat höchstens 63 Zeichen')
})

test('Plätze: gleicher Pfad behält seinen, Namen kollidieren nicht, frei wird wiederverwendet', async () => {
  const registry = { worktrees: {} }
  const a = await registryStore.allocateWorktree(registry, { project: 'journey', path: '/a', branch: 'feat/x' })
  const b = await registryStore.allocateWorktree(registry, { project: 'journey', path: '/b', branch: 'fix/x' })
  const a2 = await registryStore.allocateWorktree(registry, { project: 'journey', path: '/a', branch: 'anderer-branch' })
  assert.equal(a.name, 'journey@x')
  assert.equal(b.name, 'journey@x-2', 'gleicher Name bekommt ein Suffix')
  assert.equal(a2.name, 'journey@x', 'Branch-Wechsel ändert die Adresse nicht')
  assert.equal(a2.created, false)
  assert.notEqual(a.entry.slot, b.entry.slot)

  registryStore.removeWorktree(registry, 'journey@x')
  const c = await registryStore.allocateWorktree(registry, { project: 'journey', path: '/c', branch: 'neu' })
  assert.equal(c.entry.slot, a.entry.slot, 'ein freier Platz wird wiederverwendet')

  const busy = await registryStore.allocateWorktree(
    { worktrees: {} },
    { project: 'p', path: '/d', branch: 'd' },
    { isBusy: async (slot) => slot === ports.WORKTREE_SLOT_MIN }
  )
  assert.equal(busy.entry.slot, ports.WORKTREE_SLOT_MIN + 1, 'fremd belegte Plätze werden übersprungen')

  const voll = { worktrees: {} }
  for (let i = ports.WORKTREE_SLOT_MIN; i <= ports.WORKTREE_SLOT_MAX; i++) {
    await registryStore.allocateWorktree(voll, { project: 'p', path: `/w${i}`, branch: `b${i}` })
  }
  await assert.rejects(() => registryStore.allocateWorktree(voll, { project: 'p', path: '/zuviel', branch: 'z' }), /Plätze sind belegt/)
})

test('parallele Aufnahmen bekommen verschiedene Plätze', async () => {
  registryStore.save({ ...registryStore.load(), worktrees: {} }, { worktrees: true })
  const aufnehmen = (path) =>
    registryStore.withLock(async () => {
      const registry = registryStore.load()
      await new Promise((r) => setTimeout(r, 20))
      const { entry } = await registryStore.allocateWorktree(registry, { project: 'p', path, branch: path.slice(1) })
      registryStore.save(registry, { worktrees: true })
      return entry.slot
    })
  const slots = await Promise.all(['/eins', '/zwei', '/drei'].map(aufnehmen))
  assert.equal(new Set(slots).size, 3)
  assert.equal(Object.keys(registryStore.load().worktrees).length, 3, 'keine Aufnahme ging verloren')
  registryStore.save({ ...registryStore.load(), worktrees: {} }, { worktrees: true })
})

test('Git-Metadaten: Worktree, Hauptprojekt und Branch ohne git-Aufruf', () => {
  const { haupt, wt } = repoMitWorktree()
  mkdirSync(join(wt, 'src'))
  const info = worktreeInfo(join(wt, 'src'))
  assert.equal(info.isWorktree, true)
  assert.equal(info.root, wt)
  assert.equal(info.mainPath, haupt)
  assert.equal(info.branch, 'worktree-optionen-runde-2')
  assert.equal(worktreeInfo(haupt).isWorktree, false)

  const liste = listWorktrees(haupt)
  assert.equal(liste.length, 1)
  assert.equal(liste[0].path, wt)
  assert.equal(liste[0].missing, false)

  git(haupt, 'worktree', 'add', '-q', '--detach', join(haupt, '.claude', 'worktrees', 'kind-shannon'))
  const detached = worktreeInfo(join(haupt, '.claude', 'worktrees', 'kind-shannon'))
  assert.equal(detached.branch, null)
  assert.equal(detached.folder, 'kind-shannon')
})

test('devhub.json: Profile pro Name zusammenführen, Datei ohne profiles ist gültig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devhub-json-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '*' } }))
  writeFileSync(
    join(dir, 'devhub.json'),
    JSON.stringify({
      displayName: 'Probe',
      worktree: { daten: ['daten/app.db'], env: { APP_URL: '{frontendUrl}' }, extra: 1 },
      worktre: {},
      profiles: { smoke: [{ name: 'web', cmd: ['node', 'smoke.js'] }] }
    })
  )
  const gelesen = readDevJson(dir)
  assert.deepEqual(gelesen.worktree, { daten: ['daten/app.db'], env: { APP_URL: '{frontendUrl}' } })
  assert.ok(gelesen.warnings.some((w) => w.includes('"worktre"')), 'Tippfehler fällt auf')
  assert.ok(gelesen.warnings.some((w) => w.includes('"worktree.extra"')))

  const wurzel = dirname(dir)
  const name = dir.split('/').pop()
  const projekt = describeProject(registryMit(wurzel), name)
  assert.deepEqual(Object.keys(projekt.profiles).sort(), ['default', 'smoke'], 'smoke verdrängt das abgeleitete default nicht')
  assert.deepEqual(projekt.sources, { default: 'abgeleitet', smoke: 'devhub.json' })
  assert.equal(projekt.source, 'abgeleitet + devhub.json')
  assert.ok(projekt.problems.some((p) => p.includes('"worktre"')))

  writeFileSync(join(dir, 'devhub.json'), JSON.stringify({ displayName: 'Nur Titel' }))
  const nurTitel = describeProject(registryMit(wurzel), name)
  assert.equal(nurTitel.source, 'abgeleitet')
  assert.deepEqual(nurTitel.problems, [], 'eine Datei ohne profiles ist kein Fehler mehr')
})

test('Worktree-Instanz: eigene Ports und Adresse, nur lokal, env aus devhub.json des Hauptprojekts', async () => {
  const { wurzel, haupt, wt } = repoMitWorktree()
  writeFileSync(join(haupt, 'devhub.json'), JSON.stringify({ worktree: { env: { APP_URL: '{frontendUrl}' } } }))
  const registry = registryMit(wurzel, { networkAccess: true, networkHost: '192.168.0.9' })
  registryStore.save(registry)
  assert.equal(projectNameForPath(registry, haupt), 'haupt')

  const name = await supervisor.registerWorktree(worktreeInfo(wt))
  assert.equal(name, 'haupt@optionen-runde-2')
  const projekt = describeProject(registryStore.load(), name)
  const web = projekt.profiles.default[0]
  assert.equal(web.port, ports.worktreePortFor(projekt.slot, 'frontend'))
  assert.equal(web.url, `http://optionen-runde-2.haupt.localhost:${web.port}`)
  assert.equal(web.networkUrl, undefined, 'Worktrees nie im Netz')
  assert.ok(!web.cmd.includes('0.0.0.0'), 'Startkommando ohne Host-Bindung an alle Interfaces')
  assert.equal(web.env.APP_URL, '{frontendUrl}')
  assert.equal(projekt.worktree.of, 'haupt')
  assert.equal(projekt.worktree.mainPath, haupt)

  assert.equal(await supervisor.registerWorktree(worktreeInfo(wt)), name, 'zweites up findet die Aufnahme wieder')
  const haupteintrag = describeProject(registryStore.load(), 'haupt')
  assert.deepEqual(haupteintrag.worktrees, [wt], 'das Hauptprojekt kennt seine Worktrees')
})

test('Vorbereitung: fehlende .env und node_modules werden als Befehle genannt', () => {
  const { haupt, wt } = repoMitWorktree()
  writeFileSync(join(haupt, '.env'), 'GEHEIM=1')
  mkdirSync(join(wt, 'server'))
  writeFileSync(join(wt, 'package-lock.json'), '{}')
  writeFileSync(join(wt, 'server', 'package.json'), '{}')
  writeFileSync(join(wt, 'server', 'pnpm-lock.yaml'), '')
  const projekt = { path: wt, worktree: { mainPath: haupt } }
  const specs = [
    { runner: 'process', cwd: '.' },
    { runner: 'process', cwd: 'server' }
  ]
  const schritte = missingPreparation(projekt, specs)
  assert.ok(schritte.includes(`cd ${wt} && ln -s ../../../.env .env`), schritte.join('\n'))
  assert.ok(schritte.includes(`cd ${wt} && npm ci`))
  assert.ok(schritte.includes(`cd ${join(wt, 'server')} && pnpm install --frozen-lockfile`))

  symlinkSync('../../../.env', join(wt, '.env'))
  mkdirSync(join(wt, 'node_modules'))
  mkdirSync(join(wt, 'server', 'node_modules'))
  assert.deepEqual(missingPreparation(projekt, specs), [])
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'GEHEIM=1', 'der vorgeschlagene Link zeigt auf die richtige Datei')
})

test('--daten: SQLite konsistent, Ordner geklont, nichts außerhalb des Worktrees', async () => {
  const { haupt, wt } = repoMitWorktree()
  mkdirSync(join(haupt, 'daten', 'fotos'), { recursive: true })
  writeFileSync(join(haupt, 'daten', 'fotos', 'a.jpg'), 'bild')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(haupt, 'daten', 'app.db'))
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (x); INSERT INTO t VALUES ('aus der WAL')")
  // Offen lassen: die Zeile steht nur in der WAL, wie bei einer laufenden Hauptinstanz.

  mkdirSync(join(wt, 'daten', 'fotos'), { recursive: true })
  writeFileSync(join(wt, 'daten', 'fotos', 'alt.jpg'), 'alt')
  const projekt = {
    name: 'haupt@x',
    path: wt,
    worktree: { mainPath: haupt },
    worktreeConfig: { daten: ['daten/app.db', 'daten/fotos', 'daten/fehlt'] }
  }
  const ergebnis = await copyWorktreeData(projekt)
  db.close()
  assert.deepEqual(ergebnis.copied, ['daten/app.db (Datenbank)', 'daten/fotos/'])
  assert.deepEqual(ergebnis.skipped, ['daten/fehlt (fehlt im Hauptprojekt)'])

  const kopie = new DatabaseSync(join(wt, 'daten', 'app.db'), { readOnly: true })
  assert.equal(kopie.prepare('SELECT x FROM t').get().x, 'aus der WAL')
  kopie.close()
  assert.ok(existsSync(join(wt, 'daten', 'fotos', 'a.jpg')))
  assert.ok(!existsSync(join(wt, 'daten', 'fotos', 'alt.jpg')), 'zurücksetzen heißt: alter Stand ist weg')

  await assert.rejects(() => copyWorktreeData({ ...projekt, worktreeConfig: { daten: ['../ausbruch'] } }), /innerhalb/)
  await assert.rejects(() => copyWorktreeData({ ...projekt, worktreeConfig: { daten: ['/etc/hosts'] } }), /innerhalb/)
  await assert.rejects(() => copyWorktreeData({ ...projekt, worktreeConfig: { daten: [] } }), /Keine Daten festgelegt/)
})

test('Aufräumen: gelöschte Worktrees fliegen raus, ein fehlendes Volume nicht', async () => {
  const { wurzel, haupt, wt } = repoMitWorktree()
  const registry = registryMit(wurzel)
  registry.worktrees = {
    'haupt@lebt': { project: 'haupt', path: wt, label: 'lebt', slot: 10 },
    'haupt@weg': { project: 'haupt', path: join(haupt, '.claude', 'worktrees', 'weg'), label: 'weg', slot: 11 },
    'haupt@volume': { project: 'haupt', path: '/Volumes/GibtEsNicht-devhub/wt', label: 'volume', slot: 12 }
  }
  registryStore.save(registry, { worktrees: true })
  const entfernt = await supervisor.pruneWorktrees()
  assert.deepEqual(entfernt, ['haupt@weg'])
  assert.deepEqual(Object.keys(registryStore.load().worktrees).sort(), ['haupt@lebt', 'haupt@volume'])

  git(haupt, 'worktree', 'remove', wt)
  assert.deepEqual(await supervisor.pruneWorktrees(), ['haupt@lebt'], 'git worktree remove gibt den Platz frei')
  registryStore.save({ ...registryStore.load(), worktrees: {} }, { worktrees: true })
})

test('ein Worktree startet unter eigener Nummer neben dem Hauptprojekt', async (t) => {
  const { wurzel, wt } = repoMitWorktree({ vorlage: join(fixtures, 'brav'), branch: 'feat/lauf', ordner: 'lauf' })
  const registry = registryMit(wurzel, { readyTimeoutMs: 20000 })
  registryStore.save(registry)
  const name = await supervisor.registerWorktree(worktreeInfo(wt))
  const projekt = describeProject(registryStore.load(), name)
  const port = projekt.profiles.default[0].port
  t.after(async () => {
    await supervisor.down(name, { registry: registryStore.load() })
  })

  const ergebnis = await supervisor.up(name, { registry: registryStore.load() })
  assert.ok(ergebnis.ok, ergebnis.warnings.join(' '))
  assert.ok(port >= 5210 && port <= 5229)
  assert.ok(await probePort(port), 'lauscht auf dem Worktree-Port')
  assert.equal(ergebnis.processes[0].url, `http://lauf.brav.localhost:${port}`, 'Adresse aus dem Anzeigenamen des Hauptprojekts')

  const status = await supervisor.statusOf(registryStore.load(), name)
  assert.equal(status.profiles[0].state, 'läuft')

  await supervisor.down(name, { registry: registryStore.load() })
  assert.equal(await probePort(port), false)
})

test('--daten: ein Symlink ins Hauptprojekt oder .git wird nie überschrieben', async () => {
  const { haupt, wt } = repoMitWorktree()
  mkdirSync(join(haupt, 'server', 'daten', 'tours'), { recursive: true })
  writeFileSync(join(haupt, 'server', 'daten', 'tours', 'echt.jpg'), 'echt')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(haupt, 'server', 'daten', 'app.db'))
  db.exec("CREATE TABLE t (x); INSERT INTO t VALUES ('echt')")
  db.close()
  // Daten geteilt per Symlink - naheliegend, aber dann darf --daten nichts ersetzen.
  mkdirSync(join(wt, 'server'))
  symlinkSync(join(haupt, 'server', 'daten'), join(wt, 'server', 'daten'))

  const projekt = { name: 'haupt@x', path: wt, worktree: { mainPath: haupt } }
  for (const daten of [['server/daten/app.db'], ['server/daten/tours']]) {
    await assert.rejects(() => copyWorktreeData({ ...projekt, worktreeConfig: { daten } }), /nicht der Worktree/, daten[0])
  }
  // Auch ein Ordner, den es im Worktree noch nicht gibt, wird nicht durch den Link hindurch angelegt.
  mkdirSync(join(haupt, 'server', 'daten', 'neu', 'unter'), { recursive: true })
  writeFileSync(join(haupt, 'server', 'daten', 'neu', 'unter', 'x.txt'), 'x')
  await assert.rejects(
    () => copyWorktreeData({ ...projekt, worktreeConfig: { daten: ['server/daten/neu/unter/x.txt'] } }),
    /nicht der Worktree/
  )
  const { skipped } = await copyWorktreeData({ ...projekt, worktreeConfig: { daten: ['server/daten/gibtsnicht'] } })
  assert.deepEqual(skipped, ['server/daten/gibtsnicht (fehlt im Hauptprojekt)'])
  await assert.rejects(() => copyWorktreeData({ ...projekt, worktreeConfig: { daten: ['.git'] } }), /\.git/)
  const geprueft = new DatabaseSync(join(haupt, 'server', 'daten', 'app.db'), { readOnly: true })
  assert.equal(geprueft.prepare('SELECT x FROM t').get().x, 'echt', 'die Datenbank des Hauptprojekts ist unversehrt')
  geprueft.close()
  assert.ok(existsSync(join(haupt, 'server', 'daten', 'tours', 'echt.jpg')))
  assert.equal(readFileSync(join(haupt, 'server', 'daten', 'neu', 'unter', 'x.txt'), 'utf8'), 'x', 'nichts im Hauptprojekt ersetzt')
})

test('relative gitdir-Pfade (worktree.useRelativePaths) gelten nicht als verschwunden', () => {
  const { haupt, wt } = repoMitWorktree()
  const meta = join(haupt, '.git', 'worktrees', 'optionen-runde-2')
  writeFileSync(join(meta, 'gitdir'), '../../../.claude/worktrees/optionen-runde-2/.git\n')
  const [eintrag] = listWorktrees(haupt)
  assert.equal(eintrag.path, wt)
  assert.equal(eintrag.missing, false)
})

test('Speichern ohne Worktree-Recht lässt fremde Aufnahmen und unbekannte Schlüssel stehen', async () => {
  registryStore.save({ ...registryStore.load(), worktrees: {} }, { worktrees: true })
  const alt = registryStore.load() // Ladestand vor der Aufnahme, wie ein langsames „Slot entfernen“
  await registryStore.withLock(async () => {
    const registry = registryStore.load()
    await registryStore.allocateWorktree(registry, { project: 'p', path: '/neu', branch: 'neu' })
    registryStore.save(registry, { worktrees: true })
  })
  const { registryFile } = await import('../src/paths.js')
  writeFileSync(registryFile, JSON.stringify({ ...JSON.parse(readFileSync(registryFile, 'utf8')), zukunft: 42 }))
  alt.settings.editor = 'zed'
  registryStore.save(alt)
  const roh = JSON.parse(readFileSync(registryFile, 'utf8'))
  assert.deepEqual(Object.keys(roh.worktrees), ['p@neu'], 'die Aufnahme überlebt einen veralteten Ladestand')
  assert.equal(roh.zukunft, 42, 'unbekannte Schlüssel bleiben')
  assert.equal(roh.settings.editor, 'zed')
  registryStore.save({ ...registryStore.load(), worktrees: {} }, { worktrees: true })
})

test('Hinweisbefehle sind für die Shell gequotet', () => {
  assert.equal(shellQuote('/Users/x/Dev/journey'), '/Users/x/Dev/journey')
  assert.equal(shellQuote('/Volumes/Daten 2/wt'), "'/Volumes/Daten 2/wt'")
  assert.equal(shellQuote("/tmp/$(rm -rf ~)'x"), "'/tmp/$(rm -rf ~)'\\''x'")
})

test('eine gebastelte .git-Datei macht keinen Worktree', async () => {
  const { wurzel, haupt } = repoMitWorktree()
  registryStore.save(registryMit(wurzel))
  const falsch = join(wurzel, 'falsch')
  mkdirSync(join(falsch, 'meta'), { recursive: true })
  writeFileSync(join(falsch, 'meta', 'commondir'), join(haupt, '.git'))
  writeFileSync(join(falsch, 'meta', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(falsch, '.git'), `gitdir: ${join(falsch, 'meta')}\n`)
  const info = worktreeInfo(falsch)
  assert.equal(info.isWorktree, true, 'die Metadaten allein sähen echt aus')
  await assert.rejects(() => supervisor.registerWorktree(info), /nicht eingetragen/)
})

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

process.env.DEVHUB_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'devhub-config-'))
process.env.DEVHUB_STATE_DIR = mkdtempSync(join(tmpdir(), 'devhub-state-'))

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const registryStore = await import('../src/registry.js')
const supervisor = await import('../src/supervisor.js')
const { probePort } = await import('../src/probe.js')
const { portFor } = await import('../src/ports.js')
const { describeProject } = await import('../src/discovery.js')

/** Ein Slot, dessen beide Ports (und die Ausweichnummer) gerade frei sind —
 *  sonst scheitert der Test an einem fremden Server statt am Code. */
async function freierSlot(registry) {
  for (let slot = 99; slot >= 10; slot--) {
    if (registryStore.usedSlots(registry).has(slot)) continue
    const kandidaten = [portFor(slot, 'frontend'), portFor(slot, 'backend'), portFor(slot, 'frontend') + 7]
    const belegt = await Promise.all(kandidaten.map((p) => probePort(p)))
    if (!belegt.some(Boolean)) return slot
  }
  throw new Error('kein freier Slot für den Test')
}

test('startet abgekoppelt, ist idempotent und stoppt die ganze Gruppe', async (t) => {
  const registry = registryStore.load()
  registry.settings.roots = [fixtures]
  registry.settings.readyTimeoutMs = 20000
  const slot = await freierSlot(registry)
  registryStore.addProject(registry, { name: 'brav', path: join(fixtures, 'brav'), slot })
  registryStore.save(registry)

  const projekt = describeProject(registryStore.load(), 'brav')
  assert.equal(projekt.source, 'abgeleitet', 'ohne devhub.json aus package.json abgeleitet')
  assert.equal(projekt.profiles.default[0].port, portFor(slot, 'frontend'))

  t.after(async () => {
    await supervisor.down('brav', { registry: registryStore.load() })
  })

  const erste = await supervisor.up('brav', { registry: registryStore.load() })
  assert.ok(erste.ok, erste.warnings.join(' '))
  assert.equal(erste.processes.length, 1)
  assert.ok(await probePort(portFor(slot, 'frontend')), 'lauscht auf der zugewiesenen Nummer')

  const zweite = await supervisor.up('brav', { registry: registryStore.load() })
  assert.equal(zweite.changed, false, 'zweites up ist ein No-op')
  assert.deepEqual(zweite.kept, ['web'])

  const status = await supervisor.statusOf(registryStore.load(), 'brav')
  assert.equal(status.profiles[0].state, 'läuft')

  const beendet = await supervisor.down('brav', { registry: registryStore.load() })
  assert.ok(beendet.ok, beendet.warnings.join(' '))
  assert.equal(await probePort(portFor(slot, 'frontend')), false, 'der Port ist wirklich frei — kein überlebendes Kind')
})

test('erkennt, wenn ein Server auf eine andere Nummer ausweicht', async (t) => {
  const registry = registryStore.load()
  registry.settings.roots = [fixtures]
  registry.settings.readyTimeoutMs = 5000
  const slot = await freierSlot(registry)
  registryStore.addProject(registry, { name: 'ausweicher', path: join(fixtures, 'ausweicher'), slot })
  registryStore.save(registry)

  const projekt = describeProject(registryStore.load(), 'ausweicher')
  assert.equal(projekt.source, 'devhub.json', 'die deutschen Schlüssel aus dem Plan werden gelesen')

  t.after(async () => {
    await supervisor.down('ausweicher', { registry: registryStore.load() })
  })

  const ergebnis = await supervisor.up('ausweicher', { registry: registryStore.load() })
  assert.equal(ergebnis.ok, false)
  assert.match(ergebnis.warnings.join(' '), /ausgewichen/)
  assert.equal(ergebnis.processes.length, 0, 'ein ausgewichener Server wird nicht als laufend geführt')
  assert.equal(await probePort(portFor(slot, 'frontend') + 7), false, 'der ausgewichene Prozess wurde gestoppt')
})

test('startet nichts auf einer fremd belegten Nummer', async (t) => {
  const registry = registryStore.load()
  registry.settings.roots = [fixtures]
  const slot = await freierSlot(registry)
  registryStore.addProject(registry, { name: 'brav-zweit', path: join(fixtures, 'brav'), slot })
  registryStore.save(registry)

  const http = await import('node:http')
  const fremd = http.createServer((_req, res) => res.end('fremd'))
  await new Promise((r) => fremd.listen(portFor(slot, 'frontend'), '127.0.0.1', r))
  t.after(() => new Promise((r) => fremd.close(r)))

  await assert.rejects(() => supervisor.up('brav-zweit', { registry: registryStore.load() }), /belegt/)
})

test('Port-Probe erkennt auch reine IPv6-Listener (::1)', async (t) => {
  const http = await import('node:http')
  const net = await import('node:net')
  const server = http.createServer((_req, res) => res.end('v6'))
  const port = await new Promise((resolve, reject) => {
    server.listen(0, '::1', () => resolve(server.address().port))
    server.on('error', reject)
  })
  t.after(() => new Promise((r) => server.close(r)))

  assert.equal(await probePort(port, { hosts: ['127.0.0.1'] }), false, 'IPv4 allein sieht ::1 nicht')
  assert.equal(await probePort(port), true, 'Standard-Probe findet ::1')
  // Sanity: Adresse wirklich nur v6
  assert.equal(server.address().address, '::1')
  void net
})

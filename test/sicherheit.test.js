import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.DEVHUB_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'devhub-config-'))
process.env.DEVHUB_STATE_DIR = mkdtempSync(join(tmpdir(), 'devhub-state-'))

const { createHub } = await import('../src/server/index.js')
const { ownsGroup, startTimeOf } = await import('../src/probe.js')
const supervisor = await import('../src/supervisor.js')
const stateStore = await import('../src/state.js')
const { readAgentFile } = await import('../src/agents.js')

async function hub(t) {
  const server = createHub()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  return server.address().port
}

test('nur die eigene Oberfläche darf aus dem Browser schreiben', async (t) => {
  const port = await hub(t)
  const post = (origin, type = 'application/json') =>
    fetch(`http://127.0.0.1:${port}/api/open`, {
      method: 'POST',
      headers: { 'content-type': type, ...(origin ? { origin } : {}) },
      body: JSON.stringify({ url: 'file:///etc/hosts' })
    })

  assert.equal((await post('http://maptale.localhost:5123')).status, 403, 'ein Dev-Server auf *.localhost')
  assert.equal((await post(`http://localhost:${port + 1}`)).status, 403, 'localhost mit anderem Port')
  assert.equal((await post(`http://evil.example:${port}`)).status, 403)
  assert.equal((await post(`http://devhub.localhost:${port}`, 'text/plain')).status, 415, 'Formular ohne JSON')
  const eigen = await post(`http://devhub.localhost:${port}`)
  assert.equal(eigen.status, 400, 'die eigene Oberfläche kommt durch - aber file:// wird nicht geöffnet')
  assert.match((await eigen.json()).error, /http/)
})

test('Logs: nur Prozesse, die das Projekt hat', async (t) => {
  const port = await hub(t)
  const res = await fetch(`http://127.0.0.1:${port}/api/projects/x/logs?process=${encodeURIComponent('/../../../../tmp/x')}`)
  assert.equal(res.status, 404)
})

test('eine fremde Gruppe auf derselben PID wird nicht beendet', async (t) => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  t.after(() => process.kill(-child.pid, 'SIGKILL'))
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(await startTimeOf(child.pid))
  // So sähe ein Eintrag aus, dessen Gruppe nach einem Neustart neu vergeben wurde.
  const fremd = { name: 'web', pid: child.pid, pgid: child.pid, port: 5299, started: 'Mon Jan  1 00:00:00 2024' }
  assert.equal(await ownsGroup(fremd), false)
  assert.equal(await ownsGroup({ ...fremd, started: undefined }), false, 'ohne Startzeit zählt nur der Port')
  assert.equal(await ownsGroup({ ...fremd, started: await startTimeOf(child.pid) }), true)

  stateStore.put('fremd', 'default', { project: 'fremd', profile: 'default', processes: [{ ...fremd, runner: 'process' }] })
  const ergebnis = await supervisor.down('fremd', { registry: { settings: { roots: [] }, projects: {}, worktrees: {} } })
  assert.deepEqual(ergebnis.stopped, [])
  assert.match(ergebnis.warnings.join(' '), /gehört nicht mehr zu devhub/)
  process.kill(child.pid, 0) // lebt noch, sonst wirft das
})

test('Agent-Dateien folgen keinem Symlink aus dem Projekt hinaus', () => {
  const projekt = realpathSync(mkdtempSync(join(tmpdir(), 'devhub-agent-')))
  const geheim = realpathSync(mkdtempSync(join(tmpdir(), 'devhub-geheim-')))
  writeFileSync(join(geheim, 'id_rsa'), 'GEHEIM')
  mkdirSync(join(projekt, '.claude'))
  symlinkSync(geheim, join(projekt, '.claude', 'skills'))
  writeFileSync(join(projekt, 'CLAUDE.md'), '# Regeln')
  assert.equal(readAgentFile(projekt, join(projekt, 'CLAUDE.md'), { includeGlobal: false }).content, '# Regeln')
  assert.throws(() => readAgentFile(projekt, join(projekt, '.claude', 'skills', 'id_rsa'), { includeGlobal: false }), /Agent-Kontext/)
})

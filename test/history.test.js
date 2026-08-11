import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.DEVHUB_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'devhub-config-'))
process.env.DEVHUB_STATE_DIR = mkdtempSync(join(tmpdir(), 'devhub-state-'))

const { clearHubLog, readHubLogTail, recordEvent } = await import('../src/history.js')
const { hubLogFile, logDir } = await import('../src/paths.js')

function schreibeLog(inhalt) {
  mkdirSync(logDir, { recursive: true })
  writeFileSync(hubLogFile, inhalt)
}

test('readHubLogTail verdichtet identischen Spam und behält ältere Ereignisse', () => {
  const spam = 'Fehler: Port 4000 ist belegt - läuft der Hub schon?\n'
  const sinnvoll = [
    '11:00:00 devhub  Übersicht auf http://devhub.localhost:4000',
    '11:01:00 devhub  sync demo - 2 Dateien geändert',
    '11:02:00 devhub  settings hub - Einstellungen gespeichert'
  ]
  schreibeLog(`${sinnvoll.join('\n')}\n${spam.repeat(500)}`)

  const daten = readHubLogTail(10)
  assert.equal(daten.totalLines, 503)
  assert.ok(daten.bytes > 0)
  assert.equal(daten.lines.length, 4)
  assert.equal(daten.repeats[3], 500)
  assert.match(daten.lines[3], /^Fehler:/)
  assert.match(daten.lines[1], /sync demo/)
})

test('clearHubLog leert die Datei und schreibt einen Hinweis', () => {
  schreibeLog('alt\n'.repeat(20))
  const ergebnis = clearHubLog()
  assert.equal(ergebnis.cleared, true)
  const text = readFileSync(hubLogFile, 'utf8')
  assert.match(text, /Verlauf geleert/)
  assert.ok(!text.includes('alt\n'))
})

test('recordEvent hängt lesbare Zeilen an', () => {
  schreibeLog('')
  recordEvent({ type: 'adopt', project: 'demo', summary: 'Slot 3', lines: ['web → :5103'] })
  const daten = readHubLogTail(20)
  assert.equal(daten.lines.length, 2)
  assert.match(daten.lines[0], /adopt demo - Slot 3/)
  assert.match(daten.lines[1], /web → :5103/)
})

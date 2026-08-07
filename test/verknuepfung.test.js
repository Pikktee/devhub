import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.DEVHUB_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'devhub-config-'))
process.env.DEVHUB_STATE_DIR = mkdtempSync(join(tmpdir(), 'devhub-state-'))

const { inspectLink, linkRuleFiles } = await import('../src/adapters/link.js')
const { writeBlock } = await import('../src/adapters/contract.js')

function projekt(dateien) {
  const dir = mkdtempSync(join(tmpdir(), 'devhub-projekt-'))
  mkdirSync(dir, { recursive: true })
  for (const [name, inhalt] of Object.entries(dateien)) {
    if (inhalt.startsWith('->')) symlinkSync(inhalt.slice(2), join(dir, name))
    else writeFileSync(join(dir, name), inhalt, 'utf8')
  }
  return dir
}

test('erkennt eine bestehende Verknüpfung in beide Richtungen', () => {
  const nachClaude = projekt({ 'CLAUDE.md': 'Regeln', 'AGENTS.md': '->CLAUDE.md' })
  assert.equal(inspectLink(nachClaude).state, 'verknüpft')
  assert.equal(inspectLink(nachClaude).direction, 'AGENTS.md → CLAUDE.md')

  const nachAgents = projekt({ 'AGENTS.md': 'Regeln', 'CLAUDE.md': '->AGENTS.md' })
  assert.equal(inspectLink(nachAgents).direction, 'CLAUDE.md → AGENTS.md')
  assert.equal(linkRuleFiles(nachAgents).changed, false, 'was verknüpft ist, wird nicht angefasst')
})

test('legt den Verweis an, wenn nur eine Datei existiert', () => {
  const dir = projekt({ 'CLAUDE.md': 'Nur Claude' })
  const ergebnis = linkRuleFiles(dir)
  assert.equal(ergebnis.changed, true)
  assert.equal(readlinkSync(join(dir, 'AGENTS.md')), 'CLAUDE.md', 'relativ, damit ein Klon des Repos ihn behält')
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), 'Nur Claude')
})

test('die einzige vorhandene Datei wird nie zum Verweis gemacht', () => {
  const dir = projekt({ 'CLAUDE.md': 'Nur Claude' })
  const ergebnis = linkRuleFiles(dir, { direction: 'agents' })
  assert.equal(ergebnis.changed, false, 'sonst zeigt der Verweis auf nichts')
  assert.equal(lstatSync(join(dir, 'CLAUDE.md')).isSymbolicLink(), false)
})

test('legt zwei identische Kopien zusammen', () => {
  const inhalt = '# Regeln\n\nGleicher Inhalt.\n'
  const dir = projekt({ 'AGENTS.md': inhalt, 'CLAUDE.md': inhalt })
  assert.equal(inspectLink(dir).state, 'gleich')

  const ergebnis = linkRuleFiles(dir)
  assert.equal(ergebnis.changed, true)
  assert.equal(readlinkSync(join(dir, 'CLAUDE.md')), 'AGENTS.md', 'die neutrale Datei bleibt die echte')
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), inhalt)
})

test('verweigert das Zusammenlegen zweier verschiedener Dateien', () => {
  const dir = projekt({ 'AGENTS.md': 'kurz', 'CLAUDE.md': 'etwas ganz anderes' })
  const zustand = inspectLink(dir)
  assert.equal(zustand.state, 'verschieden')
  assert.equal(zustand.safe, false)

  const ergebnis = linkRuleFiles(dir)
  assert.equal(ergebnis.changed, false)
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), 'kurz', 'kein Byte verloren')
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'etwas ganz anderes')
})

test('meldet einen Verweis, der ins Leere zeigt', () => {
  const dir = projekt({ 'AGENTS.md': '->CLAUDE.md' })
  assert.equal(inspectLink(dir).state, 'kaputt')
})

test('dev sync schreibt durch den Verweis hindurch, ohne ihn zu zerstören', () => {
  const dir = projekt({ 'CLAUDE.md': '# Projekt\n\nEigener Text.\n', 'AGENTS.md': '->CLAUDE.md' })
  writeBlock(join(dir, 'AGENTS.md'), 'DEVHUB-VERTRAG')

  assert.equal(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink(), true, 'der Verweis überlebt das Schreiben')
  const echt = readFileSync(join(dir, 'CLAUDE.md'), 'utf8')
  assert.ok(echt.includes('DEVHUB-VERTRAG'), 'der Text landet in der echten Datei')
  assert.ok(echt.startsWith('# Projekt'), 'der vorhandene Inhalt bleibt stehen')
})

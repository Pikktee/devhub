import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Cursor kennt kein `preview_start` — es braucht darum keine Attach-Datei,
 * sondern nur die Regel. `alwaysApply` sorgt dafür, dass sie ohne Nachfrage im
 * Kontext liegt.
 */
export function ruleText(block, { description }) {
  return `---
description: ${description}
alwaysApply: true
---

${block}
`
}

export function writeCursorRule(baseDir, block, { dryRun = false, description = 'Lokale Dev-Server (devhub)' } = {}) {
  const file = join(baseDir, 'rules', 'devhub.local.mdc')
  const next = ruleText(block, { description })
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (existing === next) {
    return {
      file,
      changed: false,
      action: 'unverändert',
      detail: 'Lokale Cursor-Regel war schon aktuell'
    }
  }
  if (!dryRun) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, next, 'utf8')
  }
  return {
    file,
    changed: true,
    created: !existing,
    action: !existing ? 'Datei angelegt' : 'Datei überschrieben',
    detail: 'Lokale alwaysApply-Regel mit Ports (gitignoriert)'
  }
}

export function removeCursorRule(baseDir, { dryRun = false } = {}) {
  const files = [
    join(baseDir, 'rules', 'devhub.local.mdc'),
    join(baseDir, 'rules', 'devhub.mdc') // früher, oft eingecheckt
  ]
  const results = []
  for (const file of files) {
    if (!existsSync(file)) {
      results.push({ file, changed: false, action: 'fehlte', detail: 'Datei existiert nicht' })
      continue
    }
    if (!dryRun) unlinkSync(file)
    results.push({
      file,
      changed: true,
      deleted: true,
      action: 'Datei gelöscht',
      detail: file.endsWith('devhub.local.mdc')
        ? 'Lokale Cursor-Regel entfernt'
        : 'Alte Cursor-Regel devhub.mdc entfernt'
    })
  }
  const geändert = results.find((r) => r.changed) ?? results[0]
  return geändert
}

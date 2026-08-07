import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback)
    if (err instanceof SyntaxError) {
      throw new Error(`${file} ist kein gültiges JSON: ${err.message}`)
    }
    if (fallback !== undefined) return structuredClone(fallback)
    throw err
  }
}

/** Erst danebenschreiben, dann umbenennen — ein abgebrochener Schreibvorgang
 *  darf die Registry nicht halbfertig zurücklassen. */
export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

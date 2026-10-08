import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { stateFile } from './paths.js'
import { readJson, writeJson } from './util/json.js'

/**
 * Hub und CLI schreiben dieselbe Datei. Lesen-Ändern-Schreiben ohne Sperre
 * verliert den Eintrag des anderen - und eine laufende Gruppe gälte als fremd.
 * Die Sperre ist kurz und synchron; eine verwaiste gilt nach 10 s als abgelaufen.
 */
function locked(fn) {
  const lock = `${stateFile}.lock`
  mkdirSync(dirname(lock), { recursive: true })
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'))
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10000) unlinkSync(lock)
      } catch {
        /* inzwischen frei */
      }
      if (Date.now() > deadline) throw new Error(`Zustandsdatei gesperrt (${lock})`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    return fn()
  } finally {
    try {
      unlinkSync(lock)
    } catch {
      /* schon weg */
    }
  }
}

const EMPTY = { version: 1, instances: {} }

export const keyOf = (project, profile = 'default') => `${project}:${profile}`

export function load() {
  const raw = readJson(stateFile, EMPTY)
  return { version: raw.version ?? 1, instances: raw.instances ?? {} }
}

export function save(state) {
  writeJson(stateFile, state)
  return state
}

export function put(project, profile, data) {
  return locked(() => {
    const state = load()
    state.instances[keyOf(project, profile)] = data
    save(state)
    return data
  })
}

export function get(project, profile = 'default') {
  return load().instances[keyOf(project, profile)] ?? null
}

export function drop(project, profile = 'default') {
  locked(() => {
    const state = load()
    delete state.instances[keyOf(project, profile)]
    save(state)
  })
}

export function all() {
  return Object.entries(load().instances).map(([key, value]) => ({ key, ...value }))
}

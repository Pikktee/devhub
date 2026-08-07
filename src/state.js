import { stateFile } from './paths.js'
import { readJson, writeJson } from './util/json.js'

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
  const state = load()
  state.instances[keyOf(project, profile)] = data
  save(state)
  return data
}

export function get(project, profile = 'default') {
  return load().instances[keyOf(project, profile)] ?? null
}

export function drop(project, profile = 'default') {
  const state = load()
  delete state.instances[keyOf(project, profile)]
  save(state)
}

export function all() {
  return Object.entries(load().instances).map(([key, value]) => ({ key, ...value }))
}

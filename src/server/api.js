import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import * as registryStore from '../registry.js'
import * as stateStore from '../state.js'
import { describeProject, listProjects, scanRoots } from '../discovery.js'
import { down, downAll, instanceStatus, logFileFor, restart, tailLog, up } from '../supervisor.js'
import { agentContext, readAgentFile } from '../agents.js'
import { linkRuleFiles } from '../adapters/link.js'
import { syncAll, syncGlobal, syncProject, unsyncProject } from '../sync.js'
import { cleanProjectArtifacts, listProjectArtifacts } from '../clean.js'
import { serviceStatus } from '../service.js'
import { instance } from '../paths.js'
import { recordEvent, readHubLogTail } from '../history.js'
import { assertOpenablePath, openLocalPath } from '../open.js'

async function projectPayload(registry, project, { withMemory = false } = {}) {
  const profiles = []
  if (project.adopted) {
    for (const profile of Object.keys(project.profiles)) {
      profiles.push(await instanceStatus(project, profile, stateStore.get(project.name, profile), { withMemory }))
    }
  } else {
    for (const [profile, specs] of Object.entries(project.profiles)) {
      profiles.push({
        project: project.name,
        profile,
        state: 'ohne Port',
        processes: specs.map((spec) => ({ name: spec.name, role: spec.role, runner: spec.runner }))
      })
    }
  }
  return {
    name: project.name,
    displayName: project.displayName ?? project.name,
    title: project.displayName ?? project.name,
    hostLabel: project.hostLabel ?? null,
    suggestedDisplayName: project.suggestedDisplayName ?? null,
    path: project.path,
    slot: project.slot,
    profileSlots: project.profileSlots,
    adopted: project.adopted,
    stack: project.stack,
    source: project.source,
    problems: project.problems,
    github: project.github ?? null,
    profiles
  }
}

export async function overview({ withMemory = false } = {}) {
  const registry = registryStore.load()
  const projects = await Promise.all(
    listProjects(registry).map((project) => projectPayload(registry, project, { withMemory }))
  )

  const running = projects.flatMap((p) => p.profiles).filter((p) => p.state === 'läuft').length
  const partial = projects.flatMap((p) => p.profiles).filter((p) => p.state === 'teilweise').length
  const conflicts = projects
    .flatMap((p) => p.profiles.flatMap((profile) => profile.processes.map((proc) => ({ ...proc, project: p.name, profile: profile.profile }))))
    .filter((proc) => proc.foreign)
  const memory = projects
    .flatMap((p) => p.profiles.flatMap((profile) => profile.processes))
    .reduce((sum, proc) => sum + (proc.memory ?? 0), 0)

  return {
    hub: {
      port: registry.settings.hubPort,
      instance,
      domainSuffix: registry.settings.domainSuffix,
      editor: registry.settings.editor ?? 'cursor',
      service: serviceStatus(),
      roots: registry.settings.roots
    },
    summary: {
      total: projects.length,
      adopted: projects.filter((p) => p.adopted).length,
      running,
      partial,
      memory,
      conflicts: conflicts.length
    },
    conflicts,
    projects
  }
}

export const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/overview$/,
    handler: async (_req, _params, query) => overview({ withMemory: query.get('memory') === '1' })
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/([^/]+)$/,
    handler: async (_req, [name]) => {
      const registry = registryStore.load()
      const project = describeProject(registry, name)
      if (!project) throw Object.assign(new Error(`${name} ist unbekannt`), { status: 404 })
      return projectPayload(registry, project, { withMemory: true })
    }
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/([^/]+)\/up$/,
    handler: async (_req, [name], _query, body) => up(name, { profile: body.profile ?? 'default' })
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/([^/]+)\/down$/,
    handler: async (_req, [name], _query, body) => down(name, { profile: body.profile ?? 'default' })
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/([^/]+)\/restart$/,
    handler: async (_req, [name], _query, body) => restart(name, { profile: body.profile ?? 'default' })
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/([^/]+)\/adopt$/,
    handler: async (_req, [name], _query, body) => {
      const registry = registryStore.load()
      const found = scanRoots(registry.settings.roots).find((p) => p.name === name)
      if (!found) throw Object.assign(new Error(`${name} liegt in keinem Wurzelverzeichnis`), { status: 404 })
      if (body.profile) {
        const slot = registryStore.setProfileSlot(registry, name, body.profile, body.slot)
        registryStore.save(registry)
        return { name, profile: body.profile, slot }
      }
      const entry = registryStore.addProject(registry, {
        name,
        path: found.path,
        slot: body.slot,
        displayName: body.displayName ?? body.title
      })
      if (!entry.displayName) {
        const suggested = describeProject(registry, name)?.suggestedDisplayName
        if (suggested && suggested !== name) registryStore.setDisplayName(registry, name, suggested)
      }
      registryStore.save(registry)
      return { name, slot: entry.slot, displayName: registryStore.displayNameOf(registry, name) ?? name }
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/([^/]+)\/artifacts$/,
    handler: async (_req, [name]) => {
      const registry = registryStore.load()
      const project = describeProject(registry, name)
      if (!project) throw Object.assign(new Error(`${name} ist unbekannt`), { status: 404 })
      const artifacts = listProjectArtifacts(project.path)
      return { project: name, path: project.path, ...artifacts }
    }
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/([^/]+)\/forget$/,
    handler: async (_req, [name], _query, body) => {
      const registry = registryStore.load()
      const entry = registry.projects[name]
      if (!entry) {
        throw Object.assign(new Error(`${name} ist nicht aufgenommen`), { status: 404 })
      }
      const slot = entry.slot
      const projectPath = entry.path
      const unsync = body.unsync === undefined ? true : Boolean(body.unsync)
      const cleanDeps = Boolean(body.cleanDeps ?? body.depsLoeschen)
      const files = unsync ? unsyncProject(registry, name) : { changes: [], log: [] }
      const clean = cleanDeps ? cleanProjectArtifacts(projectPath) : { removed: [] }
      const removed = registryStore.removeProject(registry, name)
      registryStore.save(registry)
      const changed = (files.changes ?? []).filter((c) => c.changed)
      recordEvent({
        type: 'forget',
        project: name,
        summary: `Slot ${slot} entfernt · ${changed.length} Dateiänderung${changed.length === 1 ? '' : 'en'}`,
        lines: [
          `Slot ${slot} bleibt gesperrt`,
          ...changed.map((c) => `${c.action ?? 'geändert'}: ${c.file}`),
          ...(clean.removed ?? []).map((r) => `gelöscht: ${r.name}`)
        ]
      })
      return {
        name,
        removed,
        slot,
        slotHinweis: `Slot ${slot} bleibt gesperrt und wird nicht neu vergeben`,
        unsync: files,
        clean
      }
    }
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/([^/]+)\/display-name$/,
    handler: async (_req, [name], _query, body) => {
      const registry = registryStore.load()
      const project = describeProject(registry, name)
      if (!project) throw Object.assign(new Error(`${name} ist unbekannt`), { status: 404 })
      const displayName = registryStore.setDisplayName(registry, name, body.displayName ?? body.title ?? '')
      registryStore.save(registry)
      const resolved = displayName ?? describeProject(registry, name).displayName
      return { name, displayName: resolved, title: resolved }
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/([^/]+)\/agents$/,
    handler: async (_req, [name], query) => {
      const registry = registryStore.load()
      const project = describeProject(registry, name)
      if (!project) throw Object.assign(new Error(`${name} ist unbekannt`), { status: 404 })
      const includeGlobal = query.get('global') !== '0' && registry.settings.showGlobalAgentContext
      return { name, path: project.path, ...agentContext(project.path, { includeGlobal }) }
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/([^/]+)\/agents\/file$/,
    handler: async (_req, [name], query) => {
      const registry = registryStore.load()
      const project = describeProject(registry, name)
      if (!project) throw Object.assign(new Error(`${name} ist unbekannt`), { status: 404 })
      const file = query.get('path')
      if (!file) throw Object.assign(new Error('Parameter "path" fehlt'), { status: 400 })
      return readAgentFile(project.path, resolve(file), {
        includeGlobal: registry.settings.showGlobalAgentContext
      })
    }
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/([^/]+)\/link$/,
    handler: async (_req, [name], _query, body) => {
      const registry = registryStore.load()
      const project = describeProject(registry, name)
      if (!project) throw Object.assign(new Error(`${name} ist unbekannt`), { status: 404 })
      const result = linkRuleFiles(project.path, { direction: body.direction, dryRun: Boolean(body.dryRun) })
      if (!result.changed) throw Object.assign(new Error(result.message), { status: 409 })
      return result
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/([^/]+)\/logs$/,
    handler: async (_req, [name], query) => {
      const profile = query.get('profile') ?? 'default'
      const registry = registryStore.load()
      const project = describeProject(registry, name)
      const specs = project?.profiles[profile] ?? []
      const proc = query.get('process') ?? specs[0]?.name
      if (!proc) throw Object.assign(new Error('Kein Prozess bekannt'), { status: 404 })
      const file = logFileFor(name, profile, proc)
      return {
        project: name,
        profile,
        process: proc,
        file,
        processes: specs.map((s) => s.name),
        lines: tailLog(file, Number(query.get('lines') ?? 300))
      }
    }
  },
  {
    method: 'POST',
    pattern: /^\/api\/sync$/,
    handler: async (_req, _params, _query, body) => {
      const registry = registryStore.load()
      const results = body.project
        ? [syncProject(registry, body.project, { dryRun: Boolean(body.dryRun) })]
        : syncAll(registry, { dryRun: Boolean(body.dryRun) })
      const global = body.global ? syncGlobal({ dryRun: Boolean(body.dryRun), withHook: Boolean(body.hook) }) : []
      if (!body.dryRun) {
        const changed = [...results.flatMap((r) => r.changes ?? []), ...global].filter((c) => c.changed)
        recordEvent({
          type: 'sync',
          project: body.project ?? (body.global ? 'global' : 'alle'),
          summary: `${changed.length} Datei${changed.length === 1 ? '' : 'en'} geändert`,
          lines: changed.map((c) => `${c.action ?? 'geändert'}: ${c.file}`)
        })
      }
      return { results, global }
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/hub-log$/,
    handler: async (_req, _params, query) => readHubLogTail(Number(query.get('lines') ?? 120))
  },
  {
    method: 'POST',
    pattern: /^\/api\/down-all$/,
    handler: async () => ({ stopped: await downAll() })
  },
  {
    method: 'POST',
    pattern: /^\/api\/open$/,
    handler: async (_req, _params, _query, body) => {
      const registry = registryStore.load()
      if (body.url) {
        spawn('open', [body.url], { detached: true, stdio: 'ignore' }).unref()
        return { opened: body.url }
      }
      if (body.path) {
        const target = assertOpenablePath(registry, body.path)
        return openLocalPath(target, {
          finder: Boolean(body.finder),
          editor: registry.settings.editor ?? 'cursor'
        })
      }
      const project = describeProject(registry, body.project)
      if (!project) throw Object.assign(new Error('Unbekanntes Projekt'), { status: 404 })
      if (body.finder) {
        spawn('open', [project.path], { detached: true, stdio: 'ignore' }).unref()
        return { opened: project.path, finder: true }
      }
      const editor = registry.settings.editor ?? 'cursor'
      spawn(editor, [project.path], { detached: true, stdio: 'ignore' }).unref()
      return { opened: project.path, editor }
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/health$/,
    handler: async () => ({ ok: true, instance, time: new Date().toISOString() })
  },
  {
    method: 'GET',
    pattern: /^\/api\/settings$/,
    handler: async () => {
      const registry = registryStore.load()
      return registryStore.publicSettings(registry.settings)
    }
  },
  {
    method: 'POST',
    pattern: /^\/api\/settings$/,
    handler: async (_req, _params, _query, body) => {
      const registry = registryStore.load()
      const { settings, warnings } = registryStore.applySettingsPatch(registry, body ?? {})
      registryStore.save(registry)
      recordEvent({
        type: 'settings',
        project: 'hub',
        summary: 'Einstellungen gespeichert',
        lines: [
          `Wurzeln: ${settings.roots.join(', ')}`,
          `Hub-Port ${settings.hubPort} · ${settings.domainSuffix}`,
          `Editor ${settings.editor}`,
          `Agent-Kontext global: ${settings.showGlobalAgentContext ? 'an' : 'aus'}`,
          `Timeout ${Math.round(settings.readyTimeoutMs / 1000)}s`,
          ...warnings
        ]
      })
      return { settings, warnings }
    }
  }
]

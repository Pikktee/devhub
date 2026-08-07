import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { claudeHome, codexHome, cursorHome, home } from './paths.js'
import { inspectLink } from './adapters/link.js'

const MAX_PREVIEW_BYTES = 256 * 1024

/**
 * Was hier steht, ist bewusst eine Liste von Fundorten und keine Vereinheit-
 * lichung: der Hub zeigt an, was gilt, und schreibt nichts hinein.
 */
const REPO_ENTRIES = [
  { path: 'AGENTS.md', agent: 'neutral', kind: 'Regeln', note: 'gilt für Cursor, Codex und andere' },
  { path: 'AGENT.md', agent: 'neutral', kind: 'Regeln' },
  { path: '.rules', agent: 'neutral', kind: 'Regeln' },
  { path: '.mcp.json', agent: 'neutral', kind: 'MCP' },
  { path: 'CLAUDE.md', agent: 'claude', kind: 'Regeln' },
  { path: 'CLAUDE.local.md', agent: 'claude', kind: 'Regeln', note: 'nicht eingecheckt' },
  { path: '.claude/CLAUDE.md', agent: 'claude', kind: 'Regeln' },
  { path: '.claude/settings.json', agent: 'claude', kind: 'Einstellungen' },
  { path: '.claude/settings.local.json', agent: 'claude', kind: 'Einstellungen' },
  { path: '.claude/agents', agent: 'claude', kind: 'Subagenten' },
  { path: '.claude/skills', agent: 'claude', kind: 'Skills' },
  { path: '.claude/commands', agent: 'claude', kind: 'Kommandos' },
  { path: '.claude/launch.json', agent: 'claude', kind: 'Adapter', note: 'lokal von devhub, gitignoriert' },
  { path: '.cursor/rules/devhub.local.mdc', agent: 'cursor', kind: 'Regeln', note: 'lokal von devhub, gitignoriert' },
  { path: '.cursor/rules', agent: 'cursor', kind: 'Regeln' },
  { path: '.cursor/skills', agent: 'cursor', kind: 'Skills' },
  { path: '.cursor/commands', agent: 'cursor', kind: 'Kommandos' },
  { path: '.cursor/mcp.json', agent: 'cursor', kind: 'MCP' },
  { path: '.cursorrules', agent: 'cursor', kind: 'Regeln', note: 'altes Format' },
  { path: '.cursorignore', agent: 'cursor', kind: 'Ausschlüsse' },
  { path: '.codex', agent: 'codex', kind: 'Konfiguration' },
  { path: '.github/copilot-instructions.md', agent: 'copilot', kind: 'Regeln' },
  { path: '.windsurfrules', agent: 'windsurf', kind: 'Regeln' }
]

const GLOBAL_ENTRIES = [
  { path: join(claudeHome, 'CLAUDE.md'), agent: 'claude', kind: 'Regeln global' },
  { path: join(claudeHome, 'settings.json'), agent: 'claude', kind: 'Einstellungen global' },
  { path: join(claudeHome, 'skills'), agent: 'claude', kind: 'Skills global' },
  { path: join(claudeHome, 'agents'), agent: 'claude', kind: 'Subagenten global' },
  { path: join(cursorHome, 'rules'), agent: 'cursor', kind: 'Regeln global' },
  { path: join(cursorHome, 'skills'), agent: 'cursor', kind: 'Skills global' },
  { path: join(cursorHome, 'skills-cursor'), agent: 'cursor', kind: 'Skills mitgeliefert' },
  { path: join(cursorHome, 'mcp.json'), agent: 'cursor', kind: 'MCP global' },
  { path: join(codexHome, 'AGENTS.md'), agent: 'codex', kind: 'Regeln global' },
  { path: join(codexHome, 'config.toml'), agent: 'codex', kind: 'Einstellungen global' },
  { path: join(codexHome, 'skills'), agent: 'codex', kind: 'Skills global' },
  { path: join(codexHome, 'rules'), agent: 'codex', kind: 'Regeln global' },
  { path: join(codexHome, 'memories'), agent: 'codex', kind: 'Memory global' }
]

/** Claude legt den Sitzungsspeicher unter einem aus dem Pfad gebauten Namen ab. */
export function claudeProjectDir(projectPath) {
  return join(claudeHome, 'projects', projectPath.replace(/\//g, '-'))
}

export function cursorProjectDir(projectPath) {
  return join(cursorHome, 'projects', projectPath.replace(/^\//, '').replace(/\//g, '-'))
}

function describe(absolute, meta, { root } = {}) {
  let info
  try {
    info = statSync(absolute)
  } catch {
    return null
  }
  const entry = {
    ...meta,
    path: absolute,
    label: root ? relative(root, absolute) : absolute.replace(home, '~'),
    directory: info.isDirectory(),
    size: info.isDirectory() ? 0 : info.size,
    modified: info.mtime.toISOString()
  }
  if (entry.directory) {
    try {
      const children = readdirSync(absolute, { withFileTypes: true }).filter((c) => !c.name.startsWith('.'))
      entry.entries = children.length
      entry.children = children.slice(0, 40).map((c) => ({
        name: c.name,
        directory: c.isDirectory(),
        path: join(absolute, c.name)
      }))
    } catch {
      entry.entries = 0
      entry.children = []
    }
  }
  return entry
}

export function repoContext(projectPath) {
  const found = []
  for (const meta of REPO_ENTRIES) {
    const entry = describe(join(projectPath, meta.path), meta, { root: projectPath })
    if (entry) found.push(entry)
  }
  return found
}

export function globalContext(projectPath) {
  const found = []
  for (const meta of GLOBAL_ENTRIES) {
    const entry = describe(meta.path, meta)
    if (entry) found.push(entry)
  }
  const claudeDir = claudeProjectDir(projectPath)
  const claudeMemory = describe(claudeDir, {
    agent: 'claude',
    kind: 'Sitzungen zu diesem Projekt',
    note: 'Verläufe und Memory dieses Projekts'
  })
  if (claudeMemory) found.push(claudeMemory)
  const cursorDir = describe(cursorProjectDir(projectPath), {
    agent: 'cursor',
    kind: 'Sitzungen zu diesem Projekt'
  })
  if (cursorDir) found.push(cursorDir)
  return found
}

const GAP_CHECKS = [
  { path: 'AGENTS.md', hint: 'Kein agent-neutraler Hinweis — "dev sync" schreibt einen portablen Block' },
  { path: '.cursor/rules/devhub.local.mdc', hint: 'Keine lokale Cursor-Regel — "dev sync" schreibt Ports nur lokal' },
  { path: '.claude/launch.json', hint: 'Keine Attach-Datei — "dev sync" erzeugt sie lokal (gitignore)' },
  { path: 'dev.json', hint: 'Kein dev.json — der Hub leitet den Start aus package.json ab' }
]

export function agentContext(projectPath, { includeGlobal = true } = {}) {
  const repo = repoContext(projectPath)
  const gaps = GAP_CHECKS.filter((check) => !repo.some((e) => e.label === check.path))
    .filter((check) => {
      try {
        statSync(join(projectPath, check.path))
        return false
      } catch {
        return true
      }
    })
    .map((check) => ({ path: check.path, hint: check.hint }))

  return {
    repo,
    global: includeGlobal ? globalContext(projectPath) : [],
    gaps,
    link: inspectLink(projectPath)
  }
}

/** Gelesen wird nur, was vorher auch gefunden wurde — kein freier Dateizugriff
 *  über die HTTP-Schnittstelle. */
export function readAgentFile(projectPath, requested, { includeGlobal = true } = {}) {
  const target = resolve(requested)
  const context = agentContext(projectPath, { includeGlobal })
  const allowedRoots = [...context.repo, ...context.global]
  const permitted = allowedRoots.some((entry) => {
    if (entry.path === target) return true
    return entry.directory && target.startsWith(`${entry.path}/`)
  })
  if (!permitted) throw new Error('Diese Datei gehört nicht zum Agent-Kontext dieses Projekts')

  const info = statSync(target)
  if (info.isDirectory()) {
    return {
      path: target,
      directory: true,
      children: readdirSync(target, { withFileTypes: true }).map((c) => ({
        name: c.name,
        directory: c.isDirectory(),
        path: join(target, c.name)
      }))
    }
  }
  const truncated = info.size > MAX_PREVIEW_BYTES
  const buffer = readFileSync(target)
  return {
    path: target,
    name: basename(target),
    directory: false,
    size: info.size,
    modified: info.mtime.toISOString(),
    truncated,
    content: buffer.subarray(0, MAX_PREVIEW_BYTES).toString('utf8')
  }
}

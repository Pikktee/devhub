import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DevhubView } from '../types'
import { matchDevServerStart } from './dev-server-patterns.js'
import {
  bandOf,
  composeText,
  denyText,
  errorLines,
  frontendOf,
  portWarning,
  statusText,
  viewOf
} from './hub'
import type { Overview } from './hub'

const DEFAULT_HUB_PORT = 4000
const POLL_MS = 5000
const LOG_TOOL = 'mcp__devhub__logs'

const view = atom({ plugin: 'devhub', key: 'view' } as const, null)

type Engine = EngineInterface

/**
 * Was der Hub zuletzt gesagt hat. Modulvariablen genügen, weil der nächste
 * Abgleich sie nach einem Neuladen ohnehin wieder füllt; nur was gezeichnet
 * wird, steht in `$.state`.
 */
let overview: Overview | null = null
let hubPort = DEFAULT_HUB_PORT
let toolRegistered = false
/** Was der Kontextblock zuletzt sagte; nur eine Änderung der Adressen verwirft ihn. */
let lastComposed: string | undefined

async function readHubPort($: Engine): Promise<number> {
  const configDir = (await $.env.get('DEVHUB_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.config/devhub`
  try {
    const registry = JSON.parse(await $.fs.read(`${configDir}/registry.json`))
    const port = Number(registry?.settings?.hubPort)
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_HUB_PORT
  } catch {
    return DEFAULT_HUB_PORT
  }
}

const hubUrl = (path: string) => `http://127.0.0.1:${hubPort}${path}`

async function hubJson<T>($: Engine, path: string, init?: { method: string; body?: unknown }): Promise<T> {
  const res = await $.http.fetch(hubUrl(path), {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body)
  })
  let payload: unknown = null
  try {
    payload = JSON.parse(res.text)
  } catch {
    // Kein JSON: der Status allein muss reichen.
  }
  if (!res.ok) {
    const message = (payload as { error?: string } | null)?.error ?? `HTTP ${res.status}`
    throw new Error(message)
  }
  return payload as T
}

/**
 * Ein Abgleich mit dem Hub. Scheitert er, gilt der Hub als weg und der Mod
 * räumt alles Sichtbare ab - lieber stumm als ein veralteter Zustand.
 */
async function refresh($: Engine): Promise<DevhubView | null> {
  hubPort = await readHubPort($)
  let next: DevhubView | null = null
  try {
    overview = await hubJson<Overview>($, '/api/overview')
    next = viewOf(overview, await $.session.cwd())
  } catch {
    overview = null
  }

  $.ui.status(next ? statusText(next) : undefined)
  const previous = await read($, view)
  if (JSON.stringify(previous) !== JSON.stringify(next)) await update($, view, () => next)
  const composed = next && overview ? composeText(next) : undefined
  if (composed !== lastComposed) {
    lastComposed = composed
    $.ui.invalidate('prompt.context')
  }

  if (overview && !toolRegistered) {
    toolRegistered = true
    await $.tool.register({
      name: 'logs',
      description:
        'Liest die letzten Fehlerzeilen aus den Logs der devhub-Dev-Server des Projekts dieser Sitzung (alle Prozesse des Profils, z. B. web und api). ' +
        'Nutzen, wenn eine Seite nicht lädt, eine API-Anfrage scheitert oder ein Server nicht hochkommt - statt den Server selbst zu starten, um seine Ausgabe zu sehen.',
      inputSchema: {
        type: 'object',
        properties: {
          process: { type: 'string', description: 'Nur dieser Prozess (z. B. "api"); sonst alle.' },
          lines: { type: 'number', description: 'Höchstens so viele Zeilen je Prozess (Standard 40).' },
          all: { type: 'boolean', description: 'Alle letzten Zeilen statt nur Fehlerzeilen.' },
          project: { type: 'string', description: 'Anderes Projekt (Ordnername) statt dem der Sitzung.' }
        }
      }
    })
  }
  return next
}

type Verb = 'up' | 'down' | 'restart'

/**
 * Startet, stoppt oder startet neu - für den Befehl und die Knöpfe im Band
 * derselbe Weg. Ein noch unbekannter Worktree hat keinen Namen im Hub; er wird
 * über seinen Pfad aufgenommen.
 */
async function control(
  $: Engine,
  v: Pick<DevhubView, 'name' | 'profile' | 'worktreePending' | 'worktreePath'>,
  verb: Verb
): Promise<{ name: string; warnings: string[] }> {
  const result: { name?: string; warnings?: unknown[] } =
    v.worktreePending && verb === 'up'
      ? await hubJson<{ name: string; warnings?: unknown[] }>($, '/api/worktrees/up', { method: 'POST', body: { path: v.worktreePath } })
      : await hubJson<{ warnings?: unknown[] }>($, `/api/projects/${encodeURIComponent(v.name)}/${verb}`, {
          method: 'POST',
          body: { profile: v.profile }
        })
  const warnings = (result.warnings ?? []).map((w) => (typeof w === 'string' ? w : JSON.stringify(w)))
  return { name: result.name ?? v.name, warnings }
}

/** Solange ein Knopf im Band arbeitet: sein Verb, damit er nicht doppelt drückt. */
let busy: Verb | null = null

type LogPayload = { process: string; processes: string[]; lines: string[] }

async function logText(
  $: Engine,
  target: { name: string; profile: string },
  opts: { process?: string; lines?: number; all?: boolean }
): Promise<string> {
  const limit = Math.max(1, Math.min(400, Math.round(opts.lines ?? 40)))
  const query = (proc?: string) =>
    `/api/projects/${encodeURIComponent(target.name)}/logs?profile=${encodeURIComponent(target.profile)}&lines=400${
      proc ? `&process=${encodeURIComponent(proc)}` : ''
    }`
  const first = await hubJson<LogPayload>($, query(opts.process))
  const names = opts.process ? [first.process] : first.processes
  const sections: string[] = []
  for (const name of names) {
    const payload = name === first.process ? first : await hubJson<LogPayload>($, query(name))
    const picked = opts.all ? payload.lines : errorLines(payload.lines)
    if (!picked.length) {
      const tail = payload.lines.slice(-5)
      sections.push(
        `## ${name}: keine Fehlerzeilen in den letzten ${payload.lines.length} Zeilen` +
          (tail.length ? `\nLetzte Zeilen:\n${tail.join('\n')}` : '')
      )
      continue
    }
    sections.push(`## ${name}${opts.all ? '' : ': Fehlerzeilen'}\n${picked.slice(-limit).join('\n')}`)
  }
  return `devhub-Logs ${target.name} (Profil ${target.profile})\n\n${sections.join('\n\n')}`
}

function describe(v: DevhubView): string {
  const lines = [
    v.adopted
      ? `${statusText(v)} · ${v.displayName}${v.worktreeLabel ? ` (Worktree ${v.worktreeLabel})` : ''}`
      : `devhub ${v.displayName}: nicht aufgenommen (devhub adopt ${v.name})`
  ]
  for (const p of v.processes) {
    lines.push(`  ${p.listening ? '●' : '○'} ${p.name.padEnd(8)} ${p.role ?? ''} ${p.url ?? (p.port ? `:${p.port}` : '-')}${p.foreign ? '  ⚠ fremd belegt' : ''}`)
  }
  return lines.join('\n')
}

const HUB_DOWN = () => `devhub: kein Hub auf 127.0.0.1:${hubPort} erreichbar. Läuft der Dienst? \`devhub doctor\` sagt mehr.`

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'devhub',
      description: 'Dev-Server dieses Projekts über devhub: up, down, restart, status, logs, open',
      argumentHint: 'up|down|restart|status|logs|open [projekt]'
    })
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const band = bandOf(await read($, view), hubPort)
    if (e.props.hasSurvey || !band) return next(e)
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const color = { ok: 'success', partial: 'warning', warn: 'error', off: 'inactive' }[band.tone]
    // Link öffnet nur im Terminal jede Adresse; Desktop und Editor zeichnen
    // alles außer https: als reinen Text. Dort öffnet ein Knopf genau die
    // Adresse, die der Hub vergeben hat - auf localhost umzuschreiben hieße
    // andere Cookies. Auf dem Handy führt eine localhost-Adresse nirgends hin.
    const opener = (key: string, target: { href: string; text: string }, dim = false) => {
      if (e.surface === 'terminal') {
        return (
          <Text key={key} dimColor={dim}>
            <Link href={target.href} label={target.text} />
          </Text>
        )
      }
      if (e.surface === 'mobile') {
        return (
          <Text key={key} dimColor={dim}>
            {target.text}
          </Text>
        )
      }
      return <Button key={key} label={target.text} plain dimColor={dim} onPress={() => void $.process.run(['open', target.href])} />
    }
    const press = (verb: Verb) => async () => {
      const v = await read($, view)
      if (!v || busy) return
      busy = verb
      $.ui.toast(verb === 'up' ? `devhub: ${v.displayName} startet …` : `devhub: ${v.displayName} startet neu …`)
      try {
        const { warnings } = await control($, v, verb)
        for (const w of warnings) $.ui.toast(`devhub ⚠ ${w}`)
      } catch (err) {
        $.ui.toast(`devhub ${verb}: ${(err as Error).message}`)
      } finally {
        busy = null
        await refresh($)
      }
    }
    const MARK = { läuft: '✓', aus: 'aus', fremd: 'fremd' } as const
    return (
      <Box flexDirection="row" gap={2} alignItems="center">
        {band.worktree !== undefined ? (
          <Text bold wrap="truncate-end">
            Worktree{band.worktree ? ` ${band.worktree}` : ''}
          </Text>
        ) : null}
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color={color}>{band.glyph}</Text>
          {band.link ? (
            opener('open-front', band.link)
          ) : (
            <Text dimColor wrap="truncate-end">
              {band.text}
            </Text>
          )}
        </Box>
        {band.services.map((s) => (
          <Box key={`svc-${s.name}`} flexDirection="row" gap={1} alignItems="center">
            {s.href ? opener(`open-${s.name}`, { href: s.href, text: s.name }, true) : <Text dimColor>{s.name}</Text>}
            <Text color={s.state === 'läuft' ? undefined : s.state === 'fremd' ? 'error' : 'warning'} dimColor={s.state === 'läuft'}>
              {MARK[s.state]}
            </Text>
          </Box>
        ))}
        {band.action ? (
          <Button
            key={`do-${band.action}`}
            label={band.action === 'up' ? 'Starten' : 'Neu starten'}
            variant="primary"
            onPress={press(band.action)}
          />
        ) : null}
        {band.hub ? opener('open-hub', band.hub, true) : null}
        {band.main ? (
          <Text dimColor wrap="truncate-end">
            Hauptprojekt: {band.main}
          </Text>
        ) : null}
      </Box>
    )
  })

  // Gedacht war prompt.compose; dieser Engine-Build kennt das Ereignis nicht.
  // Ein eigener Kontextblock kommt ohne Annahmen über Abschnittsnamen aus.
  on('prompt.context', async ($, e, next) => {
    const composed = await next(e)
    const v = await read($, view)
    const text = v && overview ? composeText(v) : undefined
    lastComposed = text
    if (!text) return composed
    return { ...composed, blocks: [...composed.blocks.filter((b) => b.name !== 'devhub'), { name: 'devhub', text }] }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    const pattern = matchDevServerStart(command)
    if (pattern) {
      // Frisch fragen: die Antwort nennt den Zustand, und der darf nicht fünf Sekunden alt sein.
      const v = await refresh($)
      if (!overview) return next(e)
      return { deny: denyText(pattern, v) }
    }

    const ran = await next(e)
    const v = await read($, view)
    if (ran.deny !== undefined || !v || !overview) return ran
    const warning = portWarning(command, v, overview, hubPort)
    if (!warning) return ran
    return { ...ran, context: [...(ran.context ?? []), warning] }
  })

  on('tool.call', { tool: LOG_TOOL }, async ($, e) => {
    const input = e as unknown as { process?: string; lines?: number; all?: boolean; project?: string }
    const v = await read($, view)
    const target = input.project
      ? { name: input.project, profile: 'default' }
      : v
        ? { name: v.name, profile: v.profile }
        : null
    if (!target) return { result: 'Diese Sitzung gehört zu keinem Projekt im Hub. Mit "project" ein Projekt (Ordnername) angeben.' }
    if (!input.project && v?.worktreePending) return { result: 'Dieser Worktree läuft noch nicht unter devhub - es gibt keine Logs. Starten mit `devhub up .`.' }
    try {
      return { result: await logText($, target, input) }
    } catch (err) {
      return { result: `devhub: Logs von ${target.name} nicht lesbar: ${(err as Error).message}` }
    }
  })

  on('command.run', { command: 'devhub' }, async ($, e) => {
    const [verb = 'status', explicit] = e.args.trim().split(/\s+/).filter(Boolean)
    const v = await refresh($)
    if (!overview) return { text: HUB_DOWN() }
    const name = explicit ?? v?.name
    const profile = explicit ? 'default' : (v?.profile ?? 'default')

    if (verb === 'open' && explicit === 'hub') {
      await $.process.run(['open', `http://devhub.localhost:${hubPort}`])
      return { text: `http://devhub.localhost:${hubPort} geöffnet` }
    }
    if (!name) return { text: 'devhub: dieses Verzeichnis gehört zu keinem Projekt im Hub. `/devhub <befehl> <ordner>` nennt eines.' }

    // Ein noch unbekannter Worktree hat keinen Namen im Hub; aufgenommen wird er über seinen Pfad.
    if (!explicit && v?.worktreePending && verb !== 'status') {
      if (verb !== 'up') return { text: 'devhub: dieser Worktree läuft noch nicht - erst `/devhub up`.' }
      try {
        const result = await control($, v, 'up')
        const after = await refresh($)
        return { text: [`devhub ${result.name} gestartet`, ...result.warnings.map((w) => `  ⚠ ${w}`), after ? describe(after) : ''].filter(Boolean).join('\n') }
      } catch (err) {
        return { text: `devhub up: ${(err as Error).message}` }
      }
    }

    try {
      switch (verb) {
        case 'up':
        case 'down':
        case 'restart': {
          const result = await control($, { name, profile }, verb)
          const after = await refresh($)
          const warnings = result.warnings.map((w) => `  ⚠ ${w}`)
          const word = verb === 'up' ? 'gestartet' : verb === 'down' ? 'gestoppt' : 'neu gestartet'
          return { text: [`devhub ${name} ${word}`, ...warnings, after && after.name === name ? describe(after) : ''].filter(Boolean).join('\n') }
        }
        case 'status': {
          if (explicit && explicit !== v?.name) {
            const other = overview.projects.find((p) => p.name === explicit)
            if (!other) return { text: `devhub: ${explicit} ist unbekannt` }
            return { text: describe(viewOf(overview, other.path)!) }
          }
          return { text: v ? describe(v) : 'devhub: kein Projekt' }
        }
        case 'logs':
          return { text: await logText($, { name, profile }, { all: true, lines: 30 }) }
        case 'open': {
          const target = explicit && explicit !== v?.name ? viewOf(overview, overview.projects.find((p) => p.name === explicit)?.path ?? '') : v
          const url = target ? frontendOf(target)?.url : undefined
          if (!url) return { text: `devhub: keine Adresse für ${name}` }
          await $.process.run(['open', url])
          return { text: `${url} geöffnet${target?.state === 'aus' ? ` (läuft gerade nicht: /devhub up)` : ''}` }
        }
        default:
          return { text: `devhub: unbekannter Befehl "${verb}". Möglich: up, down, restart, status, logs, open [projekt|hub]` }
      }
    } catch (err) {
      return { text: `devhub ${verb} ${name}: ${(err as Error).message}` }
    }
  })
}

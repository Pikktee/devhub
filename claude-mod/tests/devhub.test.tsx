import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

/**
 * Eine nachgestellte Hub-API: dieselben Pfade und Formen wie src/server/api.js,
 * die Antworten aus einem veränderbaren Zustand. `reachable: false` spielt den
 * Fall „kein Hub“: die Verbindung scheitert, wie bei einem geschlossenen Port.
 */
type FakeHub = {
  reachable: boolean
  journeyState: 'läuft' | 'teilweise' | 'gestoppt'
  posts: string[]
  statuses: (string | undefined)[]
  opened: string[][]
}

const ROOT = '/Users/test/Dev'

function overview(hub: FakeHub) {
  const listening = hub.journeyState === 'läuft'
  return {
    hub: { port: 4100 },
    summary: {},
    conflicts: [],
    projects: [
      {
        name: 'journey',
        displayName: 'Maptale',
        path: `${ROOT}/journey`,
        adopted: true,
        profiles: [
          {
            profile: 'default',
            state: hub.journeyState,
            processes: [
              { name: 'web', role: 'frontend', port: 5123, url: 'http://maptale.localhost:5123', listening, foreign: false },
              {
                name: 'api',
                role: 'backend',
                port: 8723,
                url: 'http://127.0.0.1:8723',
                listening: listening || hub.journeyState === 'teilweise',
                foreign: false
              }
            ]
          }
        ]
      },
      {
        name: 'onwriting',
        displayName: 'Patina',
        path: `${ROOT}/onwriting`,
        adopted: true,
        profiles: [
          {
            profile: 'default',
            state: 'gestoppt',
            processes: [{ name: 'web', role: 'frontend', port: 5127, url: 'http://patina.localhost:5127', listening: false }]
          }
        ]
      }
    ]
  }
}

function fakeHub(on: On, { cwd = `${ROOT}/journey/src`, reachable = true } = {}): FakeHub {
  const hub: FakeHub = { reachable, journeyState: 'läuft', posts: [], statuses: [], opened: [] }
  mock.env(on, { HOME: '/Users/test' })
  mock.clock(on)
  on('fs.read', ($, e) => {
    if (e.path === '/Users/test/.config/devhub/registry.json') return { value: JSON.stringify({ settings: { hubPort: 4100 } }) }
    throw new Error('ENOENT')
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__devhub__${e.name}` } }))
  on('ui.status', ($, e) => {
    hub.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    hub.opened.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('http.fetch', ($, e) => {
    if (!hub.reachable) throw new Error('connect ECONNREFUSED 127.0.0.1:4100')
    const url = new URL(e.url)
    expect(url.host).toBe('127.0.0.1:4100')
    const json = (body: unknown, status = 200) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
    if (url.pathname === '/api/overview') return json(overview(hub))
    const action = url.pathname.match(/^\/api\/projects\/([^/]+)\/(up|down|restart)$/)
    if (action && e.init?.method === 'POST') {
      hub.posts.push(`${action[2]} ${action[1]} ${e.init.body}`)
      hub.journeyState = action[2] === 'down' ? 'gestoppt' : 'läuft'
      return json({ ok: true, warnings: [] })
    }
    if (url.pathname === '/api/projects/journey/logs') {
      const proc = url.searchParams.get('process') ?? 'web'
      const lines =
        proc === 'api'
          ? ['{"level":30,"msg":"request completed"}', '{"level":50,"msg":"database locked"}', 'Error: listen EADDRINUSE :::8723']
          : ['VITE ready in 300 ms']
      return json({ project: 'journey', profile: 'default', process: proc, processes: ['web', 'api'], lines })
    }
    return json({ error: 'unbekannt' }, 404)
  })
  return hub
}

const start = ($: Engine) =>
  $.session.start({ cwd: `${ROOT}/journey/src`, surface: 'terminal', isInteractive: true })

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }
} as const

describe('Statuszeile', () => {
  test('nennt Zustand, Anzeigenamen und Frontend-URL', async ($, on) => {
    const hub = fakeHub(on)
    await start($)
    expect(hub.statuses.at(-1)).toBe('devhub ● läuft · Maptale · http://maptale.localhost:5123')
  })

  test('aus: nennt den Startbefehl statt einer URL', async ($, on) => {
    const hub = fakeHub(on)
    hub.journeyState = 'gestoppt'
    await start($)
    expect(hub.statuses.at(-1)).toBe('devhub ○ aus · Maptale · devhub up journey')
  })

  test('ohne Hub bleibt sie leer', async ($, on) => {
    const hub = fakeHub(on, { reachable: false })
    await start($)
    expect(hub.statuses.filter(Boolean)).toHaveLength(0)
  })
})

describe('Band über dem Prompt', () => {
  test('Links zu Frontend und API, solange das Projekt läuft', async ($, on) => {
    const hub = fakeHub(on)
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'devhub', surface, ...BAND })
      const buttons = await ui.findAll({ type: 'Button' })
      expect(buttons.map((b) => b.text)).toEqual(['Frontend', 'API'])
      expect(await ui.find({ type: 'Text', text: 'maptale.localhost:5123' })).toBeDefined()
      await ui.press({ key: 'open-api' })
      await ui.unmount()
    }
    expect(hub.opened).toEqual([['open', 'http://127.0.0.1:8723/'], ['open', 'http://127.0.0.1:8723/']])
  })

  test('verschwindet, wenn das Projekt aus ist', async ($, on) => {
    const hub = fakeHub(on)
    hub.journeyState = 'gestoppt'
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await start($)
    const ui = await $.ui.mount({ plugin: 'devhub', surface: 'terminal', ...BAND })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
    await ui.unmount()
  })
})

describe('Kontextblock', () => {
  test('enthält die echten Adressen des Projekts', async ($, on) => {
    fakeHub(on)
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    await start($)
    const { blocks } = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'heute' }] })
    const block = blocks.find((b) => b.name === 'devhub')
    expect(block?.text).toContain('- web (frontend): http://maptale.localhost:5123')
    expect(block?.text).toContain('- api (backend): http://127.0.0.1:8723')
    expect(block?.text).toContain('devhub up journey')
  })

  test('fehlt ohne Hub', async ($, on) => {
    fakeHub(on, { reachable: false })
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    await start($)
    const { blocks } = await $.prompt.context({ blocks: [] })
    expect(blocks).toHaveLength(0)
  })
})

describe('Bash-Sperre', () => {
  test('sperrt einen Dev-Server-Start mit konkretem Befehl und Zustand', async ($, on) => {
    const hub = fakeHub(on)
    hub.journeyState = 'gestoppt'
    on('tool.call', () => ({ result: { stdout: 'sollte nie laufen' } }))
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'cd web && npm run dev' })
    expect(ran.deny).toContain('devhub up journey')
    expect(ran.deny).toContain('gerade aus')
  })

  test('nennt die laufenden Adressen, wenn schon alles läuft', async ($, on) => {
    fakeHub(on)
    on('tool.call', () => ({ result: { stdout: '' } }))
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'pnpm dev' })
    expect(ran.deny).toContain('läuft bereits')
    expect(ran.deny).toContain('http://maptale.localhost:5123')
  })

  test('ohne Hub keine Sperre', async ($, on) => {
    fakeHub(on, { reachable: false })
    on('tool.call', () => ({ result: { stdout: 'gestartet' } }))
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'npm run dev' })
    expect(ran.deny).toBeUndefined()
  })
})

describe('Port-Warnung', () => {
  test('warnt bei einem Port, der einem anderen Projekt gehört', async ($, on) => {
    fakeHub(on)
    on('tool.call', () => ({ result: { stdout: 'ok' } }))
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'curl -s http://localhost:5127/health' })
    expect(ran.context?.join('\n')).toContain('Port 5127 gehört zum Projekt onwriting (Patina)')
  })

  test('schweigt bei den eigenen Ports und beim Hub', async ($, on) => {
    fakeHub(on)
    on('tool.call', () => ({ result: { stdout: 'ok' } }))
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'curl http://127.0.0.1:8723/api && curl 127.0.0.1:4100/api/overview' })
    expect(ran.context).toBeUndefined()
  })

  test('meldet einen Port, den niemand kennt', async ($, on) => {
    fakeHub(on)
    on('tool.call', () => ({ result: { stdout: 'ok' } }))
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'open http://localhost:5173' })
    expect(ran.context?.join('\n')).toContain('Port 5173 gehört keinem Projekt im Hub')
  })
})

describe('Tool logs', () => {
  test('liefert die Fehlerzeilen aller Prozesse', async ($, on) => {
    fakeHub(on)
    await start($)
    const ran = await $.tool.call({ tool: 'mcp__devhub__logs' } as never)
    const text = String(ran.result)
    expect(text).toContain('## web: keine Fehlerzeilen')
    expect(text).toContain('"level":50')
    expect(text).toContain('EADDRINUSE')
    expect(text).not.toContain('request completed')
  })
})

describe('/devhub', () => {
  test('up startet über die API und meldet den neuen Zustand', async ($, on) => {
    const hub = fakeHub(on)
    hub.journeyState = 'gestoppt'
    await start($)
    const out = await $.command.run({ command: 'devhub', args: 'up' } as never)
    expect(hub.posts).toEqual(['up journey {"profile":"default"}'])
    expect(out.text).toContain('journey gestartet')
    expect(hub.statuses.at(-1)).toContain('● läuft')
  })

  test('down mit anderem Projekt', async ($, on) => {
    const hub = fakeHub(on)
    await start($)
    await $.command.run({ command: 'devhub', args: 'down onwriting' } as never)
    expect(hub.posts).toEqual(['down onwriting {"profile":"default"}'])
  })

  test('status listet die Prozesse', async ($, on) => {
    fakeHub(on)
    await start($)
    const out = await $.command.run({ command: 'devhub', args: 'status' } as never)
    expect(out.text).toContain('web')
    expect(out.text).toContain('http://127.0.0.1:8723')
  })

  test('open öffnet die Frontend-URL', async ($, on) => {
    const hub = fakeHub(on)
    await start($)
    await $.command.run({ command: 'devhub', args: 'open' } as never)
    expect(hub.opened).toEqual([['open', 'http://maptale.localhost:5123']])
  })

  test('ohne Hub ein klarer Hinweis', async ($, on) => {
    fakeHub(on, { reachable: false })
    await start($)
    const out = await $.command.run({ command: 'devhub', args: 'status' } as never)
    expect(out.text).toContain('kein Hub')
  })
})

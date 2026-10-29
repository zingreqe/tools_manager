/**
 * End-to-end test of the settings page transport.
 *
 * Mounts the plugin against a fake Cordis context, serves the registered
 * `/chat-lite/settings` route from a real HTTP server, and drives it with
 * `fetch` exactly like the sidebar page does.
 *
 * Run with: node test/http.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const CORE = ['bash', 'pwsh', 'read', 'write', 'edit', 'web_search', 'web_fetch']

function makeHarness(stateFile) {
  const sections = []
  const restrictions = []
  const routes = []
  // Mutable on purpose: a later test installs another plugin's tool.
  const schemas = [
    ...CORE.map((name) => ({ name, description: `${name} tool`, parameters: {} })),
    { name: 'mcp_widget', description: 'A widget tool contributed by another plugin.', parameters: {} },
    { name: 'run_code', description: 'reserved', parameters: {} },
  ]
  const agent = {
    id: 'session-1',
    ctx: {
      systemPrompt: {
        section(section) {
          sections.push(section)
          return () => sections.splice(sections.indexOf(section), 1)
        },
        suppressRuntimeContext() {
          return () => {}
        },
      },
      tools: {
        restrict(filter) {
          restrictions.push(filter)
          return () => {}
        },
      },
    },
  }
  const services = {
    webServer: { register: (route) => (routes.push(route), () => {}) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    llm: {
      stream: () =>
        (async function* generate() {
          yield { type: 'text-delta', text: '读取文件里的内容，只读操作，不会改动磁盘。' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
    },
  }
  const ctx = {
    logger: { warn: () => {} },
    tools: { schemas: () => schemas },
    agents: { list: () => [agent] },
    systemPrompt: agent.ctx.systemPrompt,
    get: (name) => services[name],
    inject(deps, callback) {
      const scope = { ...ctx }
      for (const name of deps) scope[name] = services[name]
      if (deps.every((name) => services[name] !== undefined)) callback(scope)
      return () => {}
    },
    on: () => () => {},
    effect: (fn) => fn(),
  }
  return { ctx, agent, sections, restrictions, routes, schemas, stateFile }
}

const harness = makeHarness(join(mkdtempSync(join(tmpdir(), 'chat-lite-http-')), 'state.json'))
apply(harness.ctx, { stateFile: harness.stateFile })
assert.equal(harness.routes.length, 2, 'the plugin must register its settings and explain routes')
const handlers = new Map(harness.routes.map((route) => [route.path, route.handler]))

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1')
  const handler = handlers.get(pathname)
  if (handler === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const url = `${origin}/chat-lite/settings`
const explainUrl = `${origin}/chat-lite/explain`

const get = () => fetch(url, { headers: { accept: 'application/json' } })
const post = (body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const row = (state, name) => state.tools.find((tool) => tool.name === name)
const sorted = (list) => [...list].sort()

try {
  // 1. initial state: every discovered tool is listed, chat mode keeps the lean set
  {
    const response = await get()
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.state.mode, 'chat')
    assert.deepEqual(
      payload.state.tools.map((tool) => tool.name),
      [...CORE, 'mcp_widget'],
      'reserved transport tools are omitted, other plugins are listed',
    )
    assert.deepEqual(payload.state.tools.filter((tool) => tool.enabled).map((tool) => tool.name), CORE)
    const widget = row(payload.state, 'mcp_widget')
    assert.equal(widget.core, false, 'a foreign tool is not core')
    assert.equal(widget.enabled, false, 'a foreign tool defaults off in chat mode')
    assert.equal(widget.mounted, true)
    assert.match(widget.description, /another plugin/)
    assert.equal(payload.state.stateFile, harness.stateFile)
    console.log('ok  GET lists every discovered tool, lean defaults')
  }

  // 2. switching to normal mode turns everything on without touching the prompt
  {
    const payload = await (await post({ mode: 'normal' })).json()
    assert.equal(payload.state.mode, 'normal')
    assert.equal(payload.changed, true)
    assert.equal(harness.sections.length, 0, 'normal mode must remove the prompt section')
    assert.deepEqual(sorted(harness.restrictions.at(-1).allow), sorted([...CORE, 'mcp_widget']))
    assert.equal(row(payload.state, 'mcp_widget').enabled, true)
    assert.equal(JSON.parse(readFileSync(harness.stateFile, 'utf8')).mode, 'normal')
    console.log('ok  POST mode=normal enables everything')
  }

  // 3. switching back restores the chat-mode prompt and the lean set
  {
    const payload = await (await post({ mode: 'chat' })).json()
    assert.equal(payload.state.mode, 'chat')
    assert.equal(harness.sections.length, 1)
    assert.equal(harness.sections[0].complete, true)
    assert.deepEqual(harness.restrictions.at(-1).allow, CORE)
    assert.equal(row(payload.state, 'mcp_widget').enabled, false)
    console.log('ok  POST mode=chat')
  }

  // 4. a tool from another plugin can be switched on
  {
    const payload = await (await post({ tools: { mcp_widget: true } })).json()
    assert.equal(payload.changed, true)
    assert.equal(row(payload.state, 'mcp_widget').enabled, true)
    assert.deepEqual(harness.restrictions.at(-1).allow, [...CORE, 'mcp_widget'])
    const text = harness.sections.at(-1).text({})
    assert.match(text, /mcp_widget/, 'the generated tool line names the foreign tool')
    console.log('ok  POST enables a foreign tool')
  }

  // 5. turning core tools off narrows the restriction and the generated prompt
  {
    const payload = await (await post({ tools: { web_search: false, bash: false } })).json()
    assert.equal(payload.changed, true)
    assert.deepEqual(
      sorted(harness.restrictions.at(-1).allow),
      sorted(['pwsh', 'read', 'write', 'edit', 'web_fetch', 'mcp_widget']),
    )
    const text = harness.sections.at(-1).text({})
    assert.doesNotMatch(text, /web_search/)
    assert.doesNotMatch(text, /bash/)
    assert.match(text, /pwsh/)
    assert.equal(row(payload.state, 'web_search').enabled, false)
    console.log('ok  POST tools=off')
  }

  // 6. turning a tool back on is possible even though the restriction hid it
  {
    const payload = await (await post({ tools: { bash: true } })).json()
    assert.equal(row(payload.state, 'bash').enabled, true)
    assert.equal(harness.restrictions.at(-1).allow.includes('bash'), true)
    console.log('ok  POST tools=on again')
  }

  // 7. a tool installed after the plugin started appears on the next GET
  {
    harness.schemas.push({ name: 'late_tool', description: 'Installed later by another bundle.', parameters: {} })
    const payload = await (await get()).json()
    const late = row(payload.state, 'late_tool')
    assert.ok(late, 'a newly installed tool must be listed')
    assert.equal(late.enabled, false, 'chat mode defaults it off')
    assert.equal(late.core, false)
    assert.equal(harness.restrictions.at(-1).allow.includes('late_tool'), false)
    console.log('ok  GET rediscovers newly installed tools')
  }

  // 8. a custom prompt replaces the generated one
  {
    const payload = await (await post({ prompt: '只回答一个数字。' })).json()
    assert.equal(payload.state.prompt, '只回答一个数字。')
    assert.match(harness.sections.at(-1).text({}), /^只回答一个数字。/)
    console.log('ok  POST custom prompt')
  }

  // 9. clearing the prompt falls back to the generated text
  {
    const payload = await (await post({ prompt: '' })).json()
    assert.equal(payload.state.prompt, '')
    assert.match(harness.sections.at(-1).text({}), /桌面助手/)
    console.log('ok  POST prompt reset')
  }

  // 10. writes need a JSON content type
  {
    const response = await post('mode=normal', { 'content-type': 'text/plain' })
    assert.equal(response.status, 415)
    console.log('ok  rejects non-JSON writes')
  }

  // 11. cross-site writes are refused
  {
    const response = await post({ mode: 'normal' }, { origin: 'http://evil.example' })
    assert.equal(response.status, 403)
    const payload = await response.json()
    assert.equal(payload.ok, false)
    console.log('ok  rejects cross-site writes')
  }

  // 12. unsupported methods are refused
  {
    const response = await fetch(url, { method: 'PUT' })
    assert.equal(response.status, 405)
    console.log('ok  rejects PUT')
  }

  // explain route: Chinese text over the wire, method and body validation
  {
    const response = await fetch(explainUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'read', description: 'Read a file from disk.' }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.match(payload.text, /只读/)

    const wrongMethod = await fetch(explainUrl)
    assert.equal(wrongMethod.status, 405, 'only POST is accepted')

    const empty = await fetch(explainUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'read' }),
    })
    assert.equal(empty.status, 400, 'a missing description is rejected')

    const notJson = await fetch(explainUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'read',
    })
    assert.equal(notJson.status, 415, 'only JSON bodies are accepted')
    console.log('ok  explain route returns a Chinese explanation over HTTP')
  }

  console.log('\nall HTTP checks passed')
} finally {
  server.close()
}

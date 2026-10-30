/**
 * Standalone smoke test for the tools_manager host plugin.
 *
 * Drives `apply()` against a fake Cordis context and asserts the behaviours
 * the plugin exists for: mode switching, the prompt section, the tool
 * allowlist, and the web-approval gate (buttons, free text, fail-closed).
 *
 * Run with: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'

const STATE_FILE = join(mkdtempSync(join(tmpdir(), 'tools_manager-')), 'state.json')

const TOOL_SCHEMAS = [
  'bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write',
  'present', 'web_search', 'web_fetch', 'subagent', 'workflow',
].map((name) => ({ name, description: name, parameters: {} }))

function makeHarness({ answer, llmText = '{"decision":"allow"}', llmThrows, schemas = TOOL_SCHEMAS, connection = true } = {}) {
  const sections = []
  const restrictions = []
  const listeners = new Map()
  const teardown = []
  const warnings = []
  const routes = []
  const llmCalls = []

  const agent = { id: 'session-1' }
  const agentCtx = {
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => sections.splice(sections.indexOf(section), 1)
      },
      suppressRuntimeContext() {
        throw new Error('suppressRuntimeContext should not be requested by default')
      },
    },
    tools: {
      restrict(filter) {
        restrictions.push(filter)
        return () => {}
      },
    },
  }
  agent.ctx = agentCtx

  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    ...(connection ? { connection: { fetch: { register: (route) => { routes.push(route); return () => {} } } } } : {}),
    userQuestions: {
      async ask(request) {
        if (answer === undefined) throw new Error('unexpected ask')
        return answer(request)
      },
    },
    llm: {
      stream(options) {
        llmCalls.push(options)
        return (async function* generate() {
          if (llmThrows !== undefined) throw llmThrows
          yield { type: 'text-delta', text: llmText }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }

  const pendingInjects = []
  const scopeFor = (deps) => {
    const scope = { ...ctx }
    for (const name of deps) scope[name] = services[name]
    return scope
  }
  const provide = (name, value) => {
    services[name] = value
    for (const entry of [...pendingInjects]) {
      if (!entry.deps.every((dep) => services[dep] !== undefined)) continue
      pendingInjects.splice(pendingInjects.indexOf(entry), 1)
      entry.callback(scopeFor(entry.deps))
    }
  }

  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    tools: { schemas: () => schemas },
    agents: { list: () => [agent] },
    systemPrompt: agentCtx.systemPrompt,
    get: (name) => services[name],
    inject(deps, callback) {
      if (deps.every((name) => services[name] !== undefined)) callback(scopeFor(deps))
      else pendingInjects.push({ deps, callback })
      return () => {}
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(fn) {
      const dispose = fn()
      teardown.push(dispose)
      return dispose
    },
  }
  return { ctx, agent, sections, restrictions, listeners, teardown, warnings, routes, provide, pendingInjects, llmCalls }
}

/**
 * The Host hands Connection's registry a Fetch handler; drive it the same way
 * the /api bridge does, so the tests never see a raw node request.
 */
async function callRoute(route, { method = 'GET', body, contentType = 'application/json', headers = {} } = {}) {
  const init = { method, headers: { ...headers } }
  if (contentType !== undefined) init.headers['content-type'] = contentType
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const response = await route.fetch(new Request(`http://127.0.0.1:3080${route.path}`, init))
  const text = await response.text()
  return { status: response.status, payload: text === '' ? undefined : JSON.parse(text) }
}

function exec(agent, overrides = {}) {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'web_search',
    arguments: { query: 'dsh 插件' },
    agent,
    signal: new AbortController().signal,
    ...overrides,
  }
}

const next = async () => ({ kind: 'allow' })

// 1. chat mode: prompt section + tool allowlist
{
  const h = makeHarness()
  apply(h.ctx, { stateFile: STATE_FILE })
  assert.equal(h.sections.length, 1, 'one prompt section per agent')
  const [section] = h.sections
  assert.equal(section.name, 'tools_manager:prompt')
  assert.equal(section.complete, true, 'chat mode must own the whole prompt')
  assert.equal(section.interpolate, false, 'user text must not be interpolated')
  const text = section.text({})
  assert.match(text, /桌面助手/)
  assert.match(text, /## 查看本机状态/)
  assert.match(text, /## 网络/)
  assert.match(text, /你现在可用的工具：bash、edit、pwsh、read、web_fetch、web_search、write。$/)
  assert.doesNotMatch(text, /glob|grep|todo_write|present|subagent|workflow/)

  assert.equal(h.restrictions.length, 1, 'one restriction per agent')
  assert.deepEqual(h.restrictions[0].allow, ['bash', 'pwsh', 'read', 'write', 'edit', 'web_search', 'web_fetch'])
  assert.equal(h.warnings.length, 0, `unexpected warnings: ${h.warnings.join(' | ')}`)
  assert.equal(h.routes.length, 2, 'settings + explain routes')
  assert.deepEqual(h.routes.map((route) => route.path), ['/api/tools_manager.settings', '/api/tools_manager.explain'])
  console.log('ok  chat mode prompt + tool allowlist')
}

// 2. normal mode: no prompt section, every discovered tool on by default
{
  const h = makeHarness()
  apply(h.ctx, { stateFile: STATE_FILE, mode: 'normal' })
  assert.equal(h.sections.length, 0, 'normal mode must leave the harness prompt alone')
  assert.equal(h.restrictions.length, 1, 'tool switches still apply in normal mode')
  const all = TOOL_SCHEMAS.map((schema) => schema.name)
  assert.deepEqual([...h.restrictions[0].allow].sort(), [...all].sort())
  console.log('ok  normal mode keeps the original prompt and tools')
}

// 3. disabled prompt section
{
  const h = makeHarness()
  apply(h.ctx, { stateFile: STATE_FILE, prompt: { enabled: false } })
  assert.equal(h.sections.length, 0)
  console.log('ok  prompt.enabled false')
}

// 4. custom prompt text wins over the generated default
{
  const h = makeHarness()
  apply(h.ctx, { stateFile: STATE_FILE, prompt: { text: '只说结论。' } })
  assert.equal(h.sections[0].text({}).startsWith('只说结论。'), true)
  console.log('ok  configured prompt text')
}

// 5. user clicks the allow button
{
  const h = makeHarness({
    answer: (request) => ({ answers: [{ id: request.questions[0].id, selected: ['允许'] }] }),
  })
  apply(h.ctx, { stateFile: STATE_FILE })
  const gate = h.listeners.get('tools/pre-execute')
  let passed = 0
  const result = await gate(exec(h.agent), async () => {
    passed += 1
    return { kind: 'allow' }
  })
  assert.equal(result.kind, 'allow')
  assert.equal(passed, 1, 'an approved call must continue down the waterfall')
  console.log('ok  allow button -> next()')
}

// 6. free text that means yes -> intent model approves
{
  const h = makeHarness({
    answer: (request) => {
      assert.match(request.questions[0].question, /允许执行 web_search 吗？/)
      assert.match(request.questions[0].detail, /dsh 插件/)
      return { answers: [{ id: request.questions[0].id, selected: [], custom: '行，查一下吧' }] }
    },
  })
  apply(h.ctx, { stateFile: STATE_FILE })
  const gate = h.listeners.get('tools/pre-execute')
  let passed = 0
  const result = await gate(exec(h.agent), async () => {
    passed += 1
    return { kind: 'allow' }
  })
  assert.equal(result.kind, 'allow')
  assert.equal(passed, 1)
  console.log('ok  free-text yes -> intent allow')
}

// 7. free text that means no -> denied, and the reason reaches the model
{
  const h = makeHarness({
    answer: (request) => ({ answers: [{ id: request.questions[0].id, selected: [], custom: '先别上网了' }] }),
    llmText: '{"decision":"deny","reason":"用户要求先不要联网"}',
  })
  apply(h.ctx, { stateFile: STATE_FILE })
  const gate = h.listeners.get('tools/pre-execute')
  let passed = 0
  const result = await gate(exec(h.agent), async () => {
    passed += 1
    return { kind: 'allow' }
  })
  assert.equal(result.kind, 'deny')
  assert.equal(passed, 0, 'a denied call must not reach downstream gates')
  assert.match(result.reason, /先别上网了/)
  assert.match(result.reason, /用户要求先不要联网/)
  assert.equal(result.info.code, 'WEB_APPROVAL_DENIED')
  console.log('ok  free-text no -> deny')
}

// 8. skip / dismiss -> denied
{
  const h = makeHarness({ answer: (request) => ({ answers: [{ id: request.questions[0].id, selected: [] }] }) })
  apply(h.ctx, { stateFile: STATE_FILE })
  const gate = h.listeners.get('tools/pre-execute')
  const result = await gate(exec(h.agent), next)
  assert.equal(result.kind, 'deny')
  console.log('ok  dismissed card -> deny')
}

// 9. intent model failure -> fail closed
{
  const h = makeHarness({
    answer: (request) => ({ answers: [{ id: request.questions[0].id, selected: [], custom: '嗯' }] }),
    llmThrows: new Error('provider down'),
  })
  apply(h.ctx, { stateFile: STATE_FILE })
  const gate = h.listeners.get('tools/pre-execute')
  const result = await gate(exec(h.agent), next)
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /意图判定调用失败/)
  console.log('ok  intent failure -> deny')
}

// 10. no answerer available -> fail closed instead of hanging
{
  const h = makeHarness()
  apply(h.ctx, { stateFile: STATE_FILE })
  h.ctx.get = () => undefined
  const gate = h.listeners.get('tools/pre-execute')
  const result = await gate(exec(h.agent), next)
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /没有可用的用户授权通道/)
  console.log('ok  no answerer -> deny')
}

// 11. delegated caller -> deny with an explanatory reason
{
  const h = makeHarness({
    answer: () => {
      const error = new Error('human interaction is unavailable')
      error.code = 'DELEGATED_CALLER'
      throw error
    },
  })
  apply(h.ctx, { stateFile: STATE_FILE })
  const gate = h.listeners.get('tools/pre-execute')
  const result = await gate(exec(h.agent), next)
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /子代理/)
  console.log('ok  delegated caller -> deny')
}

// 12. non-web tools are untouched
{
  const h = makeHarness()
  apply(h.ctx, { stateFile: STATE_FILE })
  const gate = h.listeners.get('tools/pre-execute')
  let seen
  const result = await gate(exec(h.agent, { name: 'bash' }), async () => {
    seen = 'bash'
    return { kind: 'allow' }
  })
  assert.equal(result.kind, 'allow')
  assert.equal(seen, 'bash')
  console.log('ok  non-web tool passes through')
}

// 13. normal mode does not gate web tools
{
  const h = makeHarness()
  apply(h.ctx, { stateFile: STATE_FILE, mode: 'normal' })
  const gate = h.listeners.get('tools/pre-execute')
  let passed = 0
  const result = await gate(exec(h.agent), async () => {
    passed += 1
    return { kind: 'allow' }
  })
  assert.equal(result.kind, 'allow')
  assert.equal(passed, 1)
  console.log('ok  normal mode -> no web approval')
}

// 14. webApproval: false disables the gate
{
  const h = makeHarness()
  apply(h.ctx, { stateFile: STATE_FILE, webApproval: false })
  const gate = h.listeners.get('tools/pre-execute')
  const result = await gate(exec(h.agent), next)
  assert.equal(result.kind, 'allow')
  console.log('ok  webApproval: false disables the gate')
}

// 15. custom copy is rendered from config
{
  const h = makeHarness({
    answer: (request) => {
      assert.equal(request.questions[0].header, '联网？')
      assert.equal(request.questions[0].question, '要查 web_fetch 吗')
      assert.equal(request.questions[0].options[0].label, '同意')
      assert.equal(request.questions[0].options[1].label, '不同意')
      return { answers: [{ id: request.questions[0].id, selected: ['同意'] }] }
    },
  })
  apply(h.ctx, {
    stateFile: STATE_FILE,
    webApproval: { header: '联网？', question: '要查 {tool} 吗', detail: '', allowLabel: '同意', denyLabel: '不同意' },
  })
  const gate = h.listeners.get('tools/pre-execute')
  const result = await gate(exec(h.agent, { name: 'web_fetch' }), next)
  assert.equal(result.kind, 'allow')
  console.log('ok  custom approval copy')
}

// 16. a tool that is not mounted is dropped from the allowlist with one warning
{
  const h = makeHarness({ schemas: [{ name: 'read', description: 'read', parameters: {} }] })
  apply(h.ctx, { stateFile: STATE_FILE })
  assert.deepEqual(h.restrictions[0].allow, ['read'])
  const text = h.sections[0].text({})
  assert.match(text, /你现在可用的工具：read。$/)
  assert.doesNotMatch(text, /## 查看本机状态|## 网络/)
  console.log('ok  partial tool set')
}

// 17. a tool switched off in the state file disappears from prompt and allowlist
{
  const file = join(mkdtempSync(join(tmpdir(), 'tools_manager-')), 'state.json')
  const first = makeHarness()
  apply(first.ctx, { stateFile: file })
  const gate = first.listeners.get('tools/pre-execute')
  assert.ok(gate)
  // emulate the settings route writing the state, then reload the plugin
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, JSON.stringify({ mode: 'chat', tools: { bash: false, web_search: false } }))

  const second = makeHarness({ schemas: ['bash', 'read', 'write', 'edit', 'web_search', 'web_fetch'].map((name) => ({ name, description: name, parameters: {} })) })
  apply(second.ctx, { stateFile: file })
  assert.deepEqual(second.restrictions[0].allow, ['read', 'write', 'edit', 'web_fetch'])
  const text = second.sections[0].text({})
  assert.doesNotMatch(text, /## 查看本机状态/, 'shell section must disappear with every shell off')
  assert.match(text, /## 网络/)
  assert.doesNotMatch(text, /web_search/)
  assert.equal(second.warnings.length, 0)
  console.log('ok  persisted tool switches shape prompt and allowlist')
}

// 18. a session-local tool the registry refuses to restrict is marked, not fatal
{
  const h = makeHarness({
    schemas: [
      { name: 'bash', description: 'bash', parameters: {} },
      { name: 'session_local', description: 'owned by the session', parameters: {} },
    ],
  })
  const calls = []
  h.agent.ctx.tools.restrict = (filter) => {
    calls.push([...filter.allow])
    if (filter.allow.includes('session_local')) {
      throw new Error('tools.restrict() names unknown global tool "session_local"; known global tools: bash')
    }
    return () => {}
  }
  apply(h.ctx, { stateFile: STATE_FILE, tools: { defaultOn: ['bash', 'session_local'] } })
  assert.deepEqual(calls.at(-1), ['bash'], 'the retry drops the session-local tool')
  assert.match(h.warnings.join('\n'), /session_local/)
  console.log('ok  session-local tool is narrowed out, not fatal')
}

// 19. the settings route binds even when the webserver service appears late
{
  const h = makeHarness({ connection: false })
  apply(h.ctx, { stateFile: STATE_FILE })
  assert.equal(h.routes.length, 0, 'no route while Connection is still absent')
  assert.equal(h.pendingInjects.length, 1, 'the route waits for the service instead of being dropped')
  h.provide('connection', { fetch: { register: (route) => { h.routes.push(route); return () => {} } } })
  assert.equal(h.routes.length, 2, 'both routes register as soon as the service appears')
  assert.deepEqual(h.routes.map((route) => route.path), ['/api/tools_manager.settings', '/api/tools_manager.explain'])
  assert.equal(h.pendingInjects.length, 0)
  console.log('ok  settings route survives a late Connection service')
}

// 20. only the pwsh row carries an availability note
{
  const h = makeHarness()
  apply(h.ctx, { stateFile: STATE_FILE })
  const { status, payload } = await callRoute(h.routes[0])
  assert.equal(status, 200)
  const state = payload.state
  const byName = new Map(state.tools.map((tool) => [tool.name, tool]))
  assert.ok(byName.has('pwsh'), 'pwsh stays listed so the page can explain it')
  assert.ok('note' in byName.get('pwsh'), 'the pwsh row carries a note slot')
  assert.ok(!('note' in byName.get('bash')), 'other rows carry no note')
  const note = byName.get('pwsh').note
  if (process.platform !== 'win32' && note !== undefined) {
    assert.match(note, /pwsh/)
  }
  console.log('ok  pwsh row explains itself when it cannot mount')
}

// 21. POST /api/tools_manager.explain returns the model's Chinese explanation and caches it
{
  const h = makeHarness({ llmText: '用来读取文件内容，只读，不会改动磁盘上的任何东西。' })
  apply(h.ctx, { stateFile: STATE_FILE })
  const explain = h.routes.find((route) => route.path === '/api/tools_manager.explain')
  assert.ok(explain !== undefined, 'explain route is registered')
  assert.deepEqual(explain.methods, ['POST'], 'explain only accepts POST')

  const call = async (body, contentType = 'application/json') =>
    callRoute(explain, { method: 'POST', body, contentType })

  const first = await call({ name: 'read', description: 'read' })
  assert.equal(first.status, 200)
  assert.equal(first.payload.ok, true)
  assert.match(first.payload.text, /读取文件/)

  const before = h.llmCalls.length
  const second = await call({ name: 'read', description: 'read' })
  assert.equal(second.payload.text, first.payload.text, 'same text from cache')
  assert.equal(h.llmCalls.length, before, 'cached explanation does not call the model again')

  const changed = await call({ name: 'read', description: 'read a file' })
  assert.equal(h.llmCalls.length, before + 1, 'a changed description is a new cache key')
  assert.match(changed.payload.text, /读取文件/)

  const missing = await call({ name: '', description: 'x' })
  assert.equal(missing.status, 400)
  assert.equal(missing.payload.ok, false)
  console.log('ok  explain route answers in Chinese and caches per description')
}

{
  // A page row must carry the whole description: the client clamps it with CSS,
  // so a host-side cut would make "expand" a no-op.
  const long = [
    'Search for files whose contents match a regular expression.',
    'Walks the workspace, honouring ignore files, and returns matching lines.',
    'Use it when you know the text but not the file.',
  ].join('\n')
  const h = makeHarness({ schemas: [{ name: 'grep', description: long, parameters: {} }] })
  apply(h.ctx, { stateFile: join(mkdtempSync(join(tmpdir(), 'tools_manager-desc-')), 'state.json') })
  const settings = h.routes.find((route) => route.path === '/api/tools_manager.settings')
  const { status, payload } = await callRoute(settings)
  assert.equal(status, 200)
  const row = payload.state.tools.find((tool) => tool.name === 'grep')
  assert.equal(row.description, long, 'the full description travels to the page')
  assert.ok(row.description.split('\n').length === 3, 'line breaks survive')
  console.log('ok  full tool descriptions reach the page so rows can expand')
}

{
  // The bundle was renamed from chat-lite; preferences saved under the old
  // name must survive the upgrade instead of falling back to defaults.
  const dir = mkdtempSync(join(tmpdir(), 'tools_manager-legacy-'))
  writeFileSync(join(dir, 'chat-lite.json'), JSON.stringify({ mode: 'normal', tools: { bash: false } }), 'utf8')
  const stateFile = join(dir, 'tools_manager.json')
  const h = makeHarness()
  apply(h.ctx, { stateFile })
  const settings = h.routes.find((route) => route.path === '/api/tools_manager.settings')
  const { payload } = await callRoute(settings)
  const state = payload.state
  assert.equal(state.mode, 'normal', 'the old file still decides the mode')
  assert.equal(state.tools.find((tool) => tool.name === 'bash').enabled, false, 'old switches carry over')
  const rewritten = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(rewritten.mode, 'normal', 'the old file is copied to the new name')
  console.log('ok  preferences saved under chat-lite.json survive the rename')
}

console.log('\nall checks passed')

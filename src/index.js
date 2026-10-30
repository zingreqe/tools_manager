/**
 * tools_manager — a lean host bundle for "chat + machine status" use.
 *
 * Two modes, switchable from the sidebar page this bundle also ships:
 *  - `chat`   (聊天模式): a short prompt replaces the harness prompt, only the
 *             switched-on tools stay visible, and every web call asks the user
 *             first — a free-text reply is classified for consent.
 *  - `normal` (常规模式): the harness prompt and behaviour are left untouched.
 *
 * The tool list is discovered from the live registry, so tools contributed by
 * any other plugin or MCP connection appear in the page too. A switch is a
 * per-tool override stored in `$DSH_HOME/tools_manager.json`:
 *  - chat mode defaults to the configured `tools.defaultOn` set (lean);
 *  - normal mode defaults to everything on;
 *  - an explicit choice applies in both modes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** Section name registered on every agent scope. */
const PROMPT_SECTION = 'tools_manager:prompt'

/** Question id used for the approval card. */
const QUESTION_ID = 'tools_manager:web-approval'

/**
 * Route the sidebar page reads and writes. It lives under `/api` so the Host's
 * Connection service authenticates it before the handler runs: the browser
 * session cookie (or an API token) must be valid, and the Host/Origin fence
 * applies first. A plain `webServer` exact route would skip both.
 */
const SETTINGS_ROUTE = '/api/tools_manager.settings'

/** Route that asks the model to explain one tool in Chinese. */
const EXPLAIN_ROUTE = '/api/tools_manager.explain'

/** How many tool explanations to keep in memory before evicting the oldest. */
const EXPLAIN_CACHE_LIMIT = 300

/** Built-in tools, in display order; anything else sorts after them. */
const CORE_TOOL_ORDER = ['bash', 'pwsh', 'read', 'write', 'edit', 'web_search', 'web_fetch']

/** Reserved for the PTC transport: it can never be named in a restriction. */
const RESERVED_TOOLS = new Set(['run_code'])

const PROMPT_INTRO = '你是一台 Linux 电脑的桌面助手，负责日常对话和本机状态监控。'

const PROMPT_STYLE = `## 回答方式
- 默认用中文，先给结论，再按需补一两个关键数字或输出片段。
- 保持简短：不要寒暄，不要复述问题，不要罗列无关选项，不要用多余的标题。
- 不确定就直说不知道，绝不编造命令输出或系统状态。`

const PROMPT_MONITOR = (shell) => `## 查看本机状态
- 用 ${shell} 执行只读命令获取真实数据，例如：uptime、free -h、df -h、ps aux --sort=-%cpu | head、ss -ltnp、systemctl --failed、journalctl -n 50。
- 汇报时给出关键数字和时间点，不要粘贴大段原始输出。`

const PROMPT_CHANGES = (tools) => `## 改动系统
- 只有用户明确要求时才修改文件或系统状态，使用 ${tools.join(' / ')}。
- 有副作用或不可逆的操作，先说明后果，等用户确认后再执行。`

const PROMPT_NETWORK = (tools) => `## 网络
- ${tools.join(' / ')} 默认不使用，只有用户明确要求联网时才调用。
- 每次调用都要用户当场批准。用户拒绝后不要重试，改用本地信息回答并说明原因。
- 用了网络结果就给出结论和来源链接，不要整段复制网页。`

const DEFAULT_CONFIG = {
  mode: 'chat',
  stateFile: '',
  prompt: {
    enabled: true,
    text: '',
    suppressRuntimeContext: false,
    toolLine: true,
    order: 10150,
  },
  tools: {
    enabled: true,
    /** Chat-mode default; anything else defaults to off but stays listed. */
    defaultOn: ['bash', 'pwsh', 'read', 'write', 'edit', 'web_search', 'web_fetch'],
  },
  webApproval: {
    enabled: true,
    tools: ['web_search', 'web_fetch'],
    prefixes: ['web_'],
    header: '网络查询授权',
    question: '允许执行 {tool} 吗？',
    detail: '参数：\n{args}',
    allowLabel: '允许',
    denyLabel: '拒绝',
    allowDescription: '执行这一次网络查询',
    denyDescription: '不执行，改用本地信息',
    argsMaxChars: 1200,
  },
  intent: {
    enabled: true,
    provider: '',
    model: '',
    system: '',
    maxTokens: 400,
    timeoutMs: 30000,
  },
  explain: {
    provider: '',
    model: '',
    maxTokens: 300,
    timeoutMs: 20000,
    maxChars: 160,
  },
}

const INTENT_SYSTEM = `你是工具调用授权的意图判定器。用户对一次需要授权的工具调用给出了一句自由文本回复，你判断用户是否同意执行这次调用。

只输出一行 JSON，二选一：
{"decision":"allow"}
{"decision":"deny","reason":"不超过 20 字的理由"}

判定规则：
- 同意、允许、继续、催办、要求执行 → allow
- 拒绝、不同意、停止、取消 → deny
- 附加新条件、改成提问、含糊其辞、与授权无关、语义不明 → deny
- 宁可拒绝，也不要猜测用户同意
- 不要输出 JSON 以外的任何字符`

const EXPLAIN_SYSTEM = `你是工具说明的翻译者。用户看不懂工具自带的英文说明，你把它写成简单的中文。
要求：
- 说清楚这个工具做什么、通常在什么时候被用到、会不会改动电脑上的东西。
- 用日常中文，命令名和文件名可以保留原样，其余不要出现英文术语。
- 不要照着原句翻译，不要用 markdown、列表、引号或标题，只给一到三句话。
- 直接输出解释本身，不要任何开场白。`

/** Localized labels for the tools this plugin was written around. */
const CORE_TOOL_INFO = {
  bash: ['Bash', '执行本机命令，查看系统状态'],
  pwsh: ['PowerShell', 'Windows 上的命令工具'],
  read: ['读取文件', '读取文件内容与目录结构'],
  write: ['写入文件', '创建或整篇覆盖文件'],
  edit: ['编辑文件', '精确替换文件片段'],
  web_search: ['联网搜索', '每次调用都会弹授权卡片'],
  web_fetch: ['抓取网页', '每次调用都会弹授权卡片'],
}

/**
 * Why the built-in `pwsh` tool cannot run here, when it cannot.
 *
 * DSH's pwsh tool drives `ctx.shell`, and a composition holds exactly one shell
 * executor — on this platform that is bash. The tool stays unavailable unless
 * the host itself is Windows, so say so in the page instead of leaving a switch
 * that can never turn on.
 */
const PWSH_NOTE = (() => {
  if (process.platform === 'win32') return undefined
  const dirs = (process.env.PATH ?? '').split(':').filter((dir) => dir !== '')
  const onPath = (binary) => dirs.some((dir) => existsSync(join(dir, binary)))
  if (onPath('pwsh')) return undefined
  return onPath('powershell.exe')
    ? 'WSL 里没有 pwsh，这个工具无法挂载；需要 Windows 数据时可以在 bash 里调用 powershell.exe。'
    : '这台机器没有 pwsh，这个工具无法挂载。'
})()

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name !== '' && !out.includes(name)) out.push(name)
  }
  return out
}

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}

function uniqueTools(names) {
  const out = []
  for (const name of names) if (!out.includes(name)) out.push(name)
  return out
}

/** Core tools first, then everything else alphabetically. */
function orderTools(names) {
  const rank = (name) => {
    const index = CORE_TOOL_ORDER.indexOf(name)
    return index === -1 ? CORE_TOOL_ORDER.length : index
  }
  return [...names].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))
}

function normalizeConfig(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const config = {
    mode: DEFAULT_CONFIG.mode,
    stateFile: DEFAULT_CONFIG.stateFile,
    prompt: { ...DEFAULT_CONFIG.prompt },
    tools: { ...DEFAULT_CONFIG.tools, defaultOn: [...DEFAULT_CONFIG.tools.defaultOn] },
    webApproval: {
      ...DEFAULT_CONFIG.webApproval,
      tools: [...DEFAULT_CONFIG.webApproval.tools],
      prefixes: [...DEFAULT_CONFIG.webApproval.prefixes],
    },
    intent: { ...DEFAULT_CONFIG.intent },
    explain: { ...DEFAULT_CONFIG.explain },
  }

  if (input.mode === 'chat' || input.mode === 'normal') config.mode = input.mode
  if (typeof input.stateFile === 'string') config.stateFile = input.stateFile.trim()

  if (typeof input.prompt === 'string') {
    config.prompt.text = input.prompt
  } else if (isPlainObject(input.prompt)) {
    const prompt = input.prompt
    if (typeof prompt.enabled === 'boolean') config.prompt.enabled = prompt.enabled
    if (typeof prompt.text === 'string') config.prompt.text = prompt.text
    if (typeof prompt.suppressRuntimeContext === 'boolean') config.prompt.suppressRuntimeContext = prompt.suppressRuntimeContext
    if (typeof prompt.toolLine === 'boolean') config.prompt.toolLine = prompt.toolLine
    if (Number.isFinite(prompt.order)) config.prompt.order = prompt.order
  }

  if (isPlainObject(input.tools)) {
    if (typeof input.tools.enabled === 'boolean') config.tools.enabled = input.tools.enabled
    // `allow` is the pre-sidebar name for the same list; keep accepting it.
    const list = stringList(input.tools.defaultOn) ?? stringList(input.tools.allow)
    if (list !== undefined) config.tools.defaultOn = list
    const extra = stringList(input.tools.extra)
    if (extra !== undefined) config.tools.defaultOn = uniqueTools([...config.tools.defaultOn, ...extra])
  } else {
    const list = stringList(input.tools)
    if (list !== undefined) config.tools.defaultOn = list
  }
  config.tools.defaultOn = orderTools(config.tools.defaultOn)

  if (typeof input.webApproval === 'boolean') config.webApproval.enabled = input.webApproval
  else if (isPlainObject(input.webApproval)) {
    const web = input.webApproval
    if (typeof web.enabled === 'boolean') config.webApproval.enabled = web.enabled
    const names = stringList(web.tools)
    if (names !== undefined) config.webApproval.tools = names
    const prefixes = stringList(web.prefixes)
    if (prefixes !== undefined) config.webApproval.prefixes = prefixes
    for (const key of ['header', 'question', 'detail', 'allowLabel', 'denyLabel', 'allowDescription', 'denyDescription']) {
      if (typeof web[key] === 'string') config.webApproval[key] = web[key]
    }
    config.webApproval.argsMaxChars = positiveInteger(web.argsMaxChars, config.webApproval.argsMaxChars)
  }

  if (typeof input.intent === 'boolean') config.intent.enabled = input.intent
  else if (isPlainObject(input.intent)) {
    const intent = input.intent
    if (typeof intent.enabled === 'boolean') config.intent.enabled = intent.enabled
    if (typeof intent.provider === 'string') config.intent.provider = intent.provider.trim()
    if (typeof intent.model === 'string') config.intent.model = intent.model.trim()
    if (typeof intent.system === 'string') config.intent.system = intent.system
    config.intent.maxTokens = positiveInteger(intent.maxTokens, config.intent.maxTokens)
    config.intent.timeoutMs = positiveInteger(intent.timeoutMs, config.intent.timeoutMs)
  }

  if (isPlainObject(input.explain)) {
    const explain = input.explain
    if (typeof explain.provider === 'string') config.explain.provider = explain.provider.trim()
    if (typeof explain.model === 'string') config.explain.model = explain.model.trim()
    config.explain.maxTokens = positiveInteger(explain.maxTokens, config.explain.maxTokens)
    config.explain.timeoutMs = positiveInteger(explain.timeoutMs, config.explain.timeoutMs)
    config.explain.maxChars = positiveInteger(explain.maxChars, config.explain.maxChars)
  }

  return config
}

function clip(text, maxChars) {
  const limit = positiveInteger(maxChars, 0)
  if (limit === 0 || text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（已截断）`
}

function formatArguments(args, maxChars) {
  if (args === undefined) return '（无）'
  let text
  if (typeof args === 'string') text = args
  else {
    try {
      text = JSON.stringify(args, null, 2)
    } catch {
      text = String(args)
    }
  }
  return clip(typeof text === 'string' ? text : String(args), maxChars)
}

function renderTemplate(template, variables) {
  return String(template ?? '').replace(/\{(tool|args)\}/g, (match, key) => {
    const value = variables[key]
    return typeof value === 'string' ? value : match
  })
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error) {
  if (isPlainObject(error) && typeof error.code === 'string') return error.code
  if (error instanceof Error && typeof error.code === 'string') return error.code
  return ''
}

function combineSignals(signals) {
  const usable = signals.filter((signal) => signal instanceof AbortSignal && !signal.aborted)
  if (usable.length === 0) return undefined
  if (usable.length === 1) return usable[0]
  return AbortSignal.any(usable)
}

function parseDecision(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  const raw = text.slice(start, end + 1)
  for (const candidate of [raw, raw.replace(/,\s*([}\]])/g, '$1')]) {
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!isPlainObject(parsed) || typeof parsed.decision !== 'string') continue
    const decision = parsed.decision.trim().toLowerCase()
    if (decision === 'allow') return { decision: 'allow', reason: '' }
    if (decision === 'deny') return { decision: 'deny', reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '' }
  }
  return undefined
}

/** Build the lean prompt around the tools that actually stayed enabled. */
function buildDefaultPrompt(enabled) {
  const parts = [PROMPT_INTRO, PROMPT_STYLE]
  const shell = enabled.includes('bash') ? 'bash' : enabled.includes('pwsh') ? 'pwsh' : undefined
  if (shell !== undefined) parts.push(PROMPT_MONITOR(shell))
  const writers = ['read', 'write', 'edit', 'bash', 'pwsh'].filter((name) => enabled.includes(name))
  if (writers.length > 0) parts.push(PROMPT_CHANGES(writers))
  const web = ['web_search', 'web_fetch'].filter((name) => enabled.includes(name))
  if (web.length > 0) parts.push(PROMPT_NETWORK(web))
  return parts.join('\n\n')
}

/** `tools.restrict()` reports the restrictable names when a name is rejected. */
function restrictableFromError(message) {
  const marker = 'known global tools: '
  const index = message.indexOf(marker)
  if (index < 0) return undefined
  const tail = message.slice(index + marker.length).trim().replace(/\.$/, '')
  if (tail === '' || tail === '(none)') return new Set()
  return new Set(tail.split(',').map((name) => name.trim()).filter((name) => name !== ''))
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
}

function resolveStateFile(config) {
  return config.stateFile !== '' ? config.stateFile : join(dshHome(), 'tools_manager.json')
}

/** Older releases wrote the same switches to `chat-lite.json`; carry them over. */
function legacyStateFile(file) {
  const name = basename(file)
  if (name !== 'tools_manager.json') return null
  return join(dirname(file), 'chat-lite.json')
}

/** Read the persisted switches; an unreadable file means "all defaults". */
function readPersisted(file, logger) {
  let source = file
  if (!existsSync(source)) {
    const legacy = legacyStateFile(file)
    if (legacy === null || !existsSync(legacy)) return {}
    source = legacy
  }
  try {
    const parsed = JSON.parse(readFileSync(source, 'utf8'))
    if (!isPlainObject(parsed)) return {}
    // Rewrite under the current name so the old file is not read again.
    if (source !== file) writePersisted(file, parsed, logger)
    return parsed
  } catch (error) {
    logger?.warn?.(`tools_manager: cannot read ${source}: ${errorMessage(error)}`)
    return {}
  }
}

function writePersisted(file, state, logger) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return true
  } catch (error) {
    logger?.warn?.(`tools_manager: cannot write ${file}: ${errorMessage(error)}`)
    return false
  }
}

/**
 * Persisted state holds only explicit user choices; every default is derived
 * at read time from the mode and `tools.defaultOn`, so a newly installed tool
 * needs no migration.
 */
function normalizeState(raw, config) {
  const tools = {}
  if (isPlainObject(raw.tools)) {
    for (const [name, value] of Object.entries(raw.tools)) {
      if (typeof value === 'boolean') tools[name] = value
    }
  }
  return {
    mode: raw.mode === 'normal' || raw.mode === 'chat' ? raw.mode : config.mode,
    tools,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
  }
}

function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

async function readJsonBody(request, limit = 128 * 1024) {
  const text = await request.text()
  if (text.length > limit) throw new Error('请求体过大')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  if (!isPlainObject(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed
}

export const name = 'dsh-tools-manager'

export const inject = ['tools', 'systemPrompt', 'agents']

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const stateFile = resolveStateFile(config)
  let state = normalizeState(readPersisted(stateFile, ctx.logger), config)
  const defaultOn = new Set(config.tools.defaultOn)

  const webToolNames = new Set(config.webApproval.tools)
  const webPrefixes = config.webApproval.prefixes
  /** Agent object → disposers owned by that agent. Agent objects, not ids: a
   *  resumed session is a new object and must be set up again. */
  const agents = new Map()
  /** Agent object → tools mounted for it, captured before this plugin
   *  restricted anything (a restricted view would hide what we must keep
   *  offering). Tools from every other plugin land here too. */
  const discovered = new Map()
  /** Tools the registry refuses to restrict (session-local ones stay visible). */
  const locked = new Set()
  const warned = new Set()

  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    ctx.logger.warn(message)
  }

  const isWebTool = (toolName) => {
    if (typeof toolName !== 'string') return false
    if (webToolNames.has(toolName)) return true
    return webPrefixes.some((prefix) => prefix !== '' && toolName.startsWith(prefix))
  }

  const recordDiscovery = (agent) => {
    let entries = []
    try {
      entries = ctx.tools
        .schemas(agent)
        .filter((schema) => typeof schema?.name === 'string' && !RESERVED_TOOLS.has(schema.name))
        .map((schema) => ({
          name: schema.name,
          description: typeof schema.description === 'string' ? schema.description : '',
        }))
    } catch (error) {
      warnOnce(`schemas:${String(agent.id)}`, `tools_manager: cannot read tool schemas for ${String(agent.id)}: ${errorMessage(error)}`)
    }
    discovered.set(agent, entries)
  }

  /** Every tool seen on any live agent, plus the configured defaults. */
  const allTools = () => {
    const merged = new Map()
    for (const entries of discovered.values()) {
      for (const entry of entries) if (!merged.has(entry.name)) merged.set(entry.name, entry.description)
    }
    const probed = merged.size > 0
    for (const name of config.tools.defaultOn) if (!merged.has(name)) merged.set(name, '')
    return {
      probed,
      entries: orderTools([...merged.keys()]).map((name) => ({ name, description: merged.get(name) ?? '' })),
    }
  }

  /** Explicit choice wins; otherwise the mode decides the default. */
  const isEnabled = (toolName) => {
    if (Object.hasOwn(state.tools, toolName)) return state.tools[toolName] !== false
    return state.mode === 'normal' ? true : defaultOn.has(toolName)
  }

  /** What the agent keeps: switched on, plus anything the registry cannot hide. */
  const enabledTools = (agent) => {
    const entries = discovered.get(agent) ?? []
    return entries.map((entry) => entry.name).filter((toolName) => locked.has(toolName) || isEnabled(toolName))
  }

  const promptText = (enabled) => {
    if (state.prompt.trim() !== '') return state.prompt
    if (config.prompt.text.trim() !== '') return config.prompt.text
    return buildDefaultPrompt(enabled)
  }

  const installPrompt = (agent, enabled) => {
    if (!config.prompt.enabled) return []
    const names = [...enabled].sort()
    const text = () => {
      const lines = [promptText(enabled)]
      if (config.prompt.toolLine && names.length > 0) lines.push('', `你现在可用的工具：${names.join('、')}。`)
      return lines.join('\n')
    }
    const disposers = [
      agent.ctx.systemPrompt.section({
        name: PROMPT_SECTION,
        order: config.prompt.order,
        text,
        interpolate: false,
        complete: true,
      }),
    ]
    if (config.prompt.suppressRuntimeContext) disposers.push(agent.ctx.systemPrompt.suppressRuntimeContext())
    return disposers
  }

  /** Restrict, narrowing to what the registry actually accepts. */
  const installTools = (agent, enabled) => {
    if (!config.tools.enabled) return []
    let allow = enabled.filter((toolName) => !locked.has(toolName))
    if (allow.length === 0) return []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return [agent.ctx.tools.restrict({ allow })]
      } catch (error) {
        const restrictable = restrictableFromError(errorMessage(error))
        if (restrictable === undefined) {
          warnOnce(`restrict:${attempt}`, `tools_manager: tools.restrict() failed: ${errorMessage(error)}`)
          return []
        }
        const blocked = allow.filter((toolName) => !restrictable.has(toolName))
        if (blocked.length === 0) {
          warnOnce('restrict:failed', `tools_manager: tools.restrict() failed: ${errorMessage(error)}`)
          return []
        }
        for (const toolName of blocked) {
          locked.add(toolName)
          warnOnce(`locked:${toolName}`, `tools_manager: tool "${toolName}" cannot be hidden (session-local); it stays available`)
        }
        allow = allow.filter((toolName) => restrictable.has(toolName))
        if (allow.length === 0) return []
      }
    }
    return []
  }

  const releaseAgent = (agent) => {
    const disposers = agents.get(agent)
    if (disposers === undefined) return
    agents.delete(agent)
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      try {
        disposers[index]()
      } catch (error) {
        ctx.logger.warn(`tools_manager: cleanup failed: ${errorMessage(error)}`)
      }
    }
  }

  const installAgent = (agent) => {
    if (!isPlainObject(agent) || agents.has(agent)) return
    if (!discovered.has(agent)) recordDiscovery(agent)
    const enabled = enabledTools(agent)
    const disposers = []
    if (state.mode === 'chat') disposers.push(...installPrompt(agent, enabled))
    disposers.push(...installTools(agent, enabled))
    agents.set(agent, disposers)
  }

  /**
   * Re-apply every live agent. With `rediscover`, the restriction is lifted,
   * the registry re-read, and the restriction re-installed — synchronously, so
   * no tool call can run in between. That is how a tool installed after this
   * plugin started shows up.
   */
  const reapplyAll = (rediscover) => {
    for (const agent of [...agents.keys()]) {
      releaseAgent(agent)
      if (rediscover) discovered.delete(agent)
      installAgent(agent)
    }
  }

  const readSelection = () => {
    const service = ctx.get('agentDefaultModel')
    if (service === undefined || typeof service.currentSelection !== 'function') return { provider: '', model: '' }
    try {
      const selection = service.currentSelection()
      return {
        provider: typeof selection?.provider === 'string' ? selection.provider : '',
        model: typeof selection?.model === 'string' ? selection.model : '',
      }
    } catch {
      return { provider: '', model: '' }
    }
  }

  const classifyIntent = async (exec, reply) => {
    const llm = ctx.get('llm')
    if (llm === undefined) return { allow: false, reason: '意图判定服务不可用' }
    const fallback = readSelection()
    const provider = config.intent.provider !== '' ? config.intent.provider : fallback.provider
    const model = config.intent.model !== '' ? config.intent.model : fallback.model
    if (provider === '' || model === '') return { allow: false, reason: '没有可用于意图判定的模型' }

    const userText = [`工具：${exec.name}`, `参数：${formatArguments(exec.arguments, 800)}`, `用户回复：${reply}`].join('\n')
    let output = ''
    try {
      const stream = llm.stream({
        provider,
        model,
        system: config.intent.system !== '' ? config.intent.system : INTENT_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
        temperature: 0,
        maxTokens: config.intent.maxTokens,
        signal: combineSignals([exec.signal, AbortSignal.timeout(config.intent.timeoutMs)]),
      })
      for await (const chunk of stream) {
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta') {
          output = clip(output + String(chunk.text ?? ''), 8000)
          continue
        }
        if (chunk.type === 'finish') {
          const kind = chunk.reason?.kind
          if (kind === 'error' || kind === 'aborted') {
            return { allow: false, reason: `意图判定调用失败：${chunk.reason?.failure?.message ?? kind}` }
          }
        }
      }
    } catch (error) {
      return { allow: false, reason: `意图判定调用失败：${errorMessage(error)}` }
    }

    const parsed = parseDecision(output)
    if (parsed === undefined) return { allow: false, reason: '意图判定输出无法解析' }
    if (parsed.decision === 'allow') return { allow: true, reason: '' }
    return { allow: false, reason: parsed.reason !== '' ? parsed.reason : '用户未明确同意' }
  }

  /**
   * One-sentence Chinese explanation of a tool, cached per (name, description)
   * so repeated page views cost nothing. The description is what the registry
   * reports, so a plugin upgrade that rewrites it is a fresh cache key.
   */
  const explained = new Map()

  const explainTool = async (name, description) => {
    const cacheKey = `${name}\u0000${description}`
    const hit = explained.get(cacheKey)
    if (hit !== undefined) return { text: hit }

    const llm = ctx.get('llm')
    if (llm === undefined) return { error: '模型服务不可用' }
    const fallback = readSelection()
    const provider = config.explain.provider !== '' ? config.explain.provider : fallback.provider
    const model = config.explain.model !== '' ? config.explain.model : fallback.model
    if (provider === '' || model === '') return { error: '没有可用于解释的模型' }

    const userText = [`工具名：${name}`, `工具说明：${clip(description, 4000)}`].join('\n')
    let output = ''
    try {
      const stream = llm.stream({
        provider,
        model,
        system: EXPLAIN_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
        temperature: 0.2,
        maxTokens: config.explain.maxTokens,
        signal: AbortSignal.timeout(config.explain.timeoutMs),
      })
      for await (const chunk of stream) {
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta') {
          output = clip(output + String(chunk.text ?? ''), 4000)
          continue
        }
        if (chunk.type === 'finish') {
          const kind = chunk.reason?.kind
          if (kind === 'error' || kind === 'aborted') {
            return { error: `解释调用失败：${chunk.reason?.failure?.message ?? kind}` }
          }
        }
      }
    } catch (error) {
      return { error: `解释调用失败：${errorMessage(error)}` }
    }

    // Models like to answer with a paragraph and a blank line; keep one line.
    const text = output.replace(/\s+/g, ' ').trim()
    if (text === '') return { error: '模型没有返回解释' }
    const shaped = clip(text, config.explain.maxChars)
    explained.set(cacheKey, shaped)
    if (explained.size > EXPLAIN_CACHE_LIMIT) explained.delete(explained.keys().next().value)
    return { text: shaped }
  }

  const askForWebCall = async (exec) => {
    const agent = exec.agent
    if (!isPlainObject(agent)) return { allow: false, reason: '无法确定发起调用的会话，未获得用户授权，未执行。' }
    const questions = ctx.get('userQuestions')
    if (questions === undefined) return { allow: false, reason: '当前环境没有可用的用户授权通道，未执行。' }

    const argsText = formatArguments(exec.arguments, config.webApproval.argsMaxChars)
    const variables = { tool: exec.name, args: argsText }
    const question = renderTemplate(config.webApproval.question, variables) || `允许执行 ${exec.name} 吗？`
    const detail = renderTemplate(config.webApproval.detail, variables).trim()

    let answer
    try {
      answer = await questions.ask({
        agent,
        questions: [
          {
            id: QUESTION_ID,
            header: config.webApproval.header,
            question,
            ...(detail === '' ? {} : { detail }),
            options: [
              { label: config.webApproval.allowLabel, description: config.webApproval.allowDescription },
              { label: config.webApproval.denyLabel, description: config.webApproval.denyDescription },
            ],
          },
        ],
        signal: exec.signal,
      })
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ASK_ABORTED') return { allow: false, cancelled: true, reason: '用户取消了授权请求，未执行。' }
      if (code === 'DELEGATED_CALLER') return { allow: false, reason: '子代理不能发起用户授权，未执行。' }
      if (code === 'CALLER_NOT_LIVE') return { allow: false, reason: '发起调用的会话已结束，未执行。' }
      if (code === 'NO_PROVIDER') return { allow: false, reason: '当前环境没有可用的用户授权通道，未执行。' }
      return { allow: false, reason: `授权请求失败（${errorMessage(error)}），未执行。` }
    }

    const answers = Array.isArray(answer?.answers) ? answer.answers : []
    const picked = answers.find((item) => item?.id === QUESTION_ID) ?? answers[0]
    const custom = typeof picked?.custom === 'string' ? picked.custom.trim() : ''
    const selected = Array.isArray(picked?.selected) ? picked.selected.filter((label) => typeof label === 'string') : []

    if (custom !== '') {
      if (!config.intent.enabled) {
        return { allow: false, reason: `用户回复「${clip(custom, 80)}」，但未开启意图判定，未执行。` }
      }
      const verdict = await classifyIntent(exec, custom)
      if (verdict.allow) return { allow: true, reason: '' }
      return {
        allow: false,
        reason: `用户回复「${clip(custom, 80)}」，判定为未同意（${verdict.reason}），${exec.name} 未执行。`,
      }
    }

    if (selected.includes(config.webApproval.allowLabel)) return { allow: true, reason: '' }
    return { allow: false, reason: `用户没有批准 ${exec.name}，未执行。` }
  }

  ctx.on(
    'tools/pre-execute',
    async (exec, next) => {
      if (state.mode !== 'chat' || !config.webApproval.enabled) return next()
      if (!isWebTool(exec.name)) return next()
      if (exec.signal.aborted) return { kind: 'cancel' }
      const verdict = await askForWebCall(exec)
      if (verdict.cancelled === true || exec.signal.aborted) return { kind: 'cancel' }
      if (verdict.allow) return next()
      return {
        kind: 'deny',
        reason: verdict.reason,
        info: { name: 'WebApprovalDenied', code: 'WEB_APPROVAL_DENIED', reason: verdict.reason },
      }
    },
    { prepend: true },
  )

  // ---- settings page transport ---------------------------------------------

  const discoveredHas = (toolName) => {
    for (const list of discovered.values()) if (list.some((entry) => entry.name === toolName)) return true
    return false
  }

  const describeState = () => {
    const { probed, entries } = allTools()
    const rows = entries.map((entry) => {
      const core = CORE_TOOL_INFO[entry.name]
      // The page clamps the description with CSS so it can expand on click; the
      // whole text has to travel, otherwise expanding cannot reveal anything.
      const description = String(entry.description).trim()
      // Before any session exists nothing has been probed; assume available.
      const mounted = probed ? discoveredHas(entry.name) : true
      return {
        name: entry.name,
        label: core ? core[0] : entry.name,
        description: core ? core[1] : clip(description, 8000) || '由其他插件提供的工具',
        core: core !== undefined,
        // A tool this environment does not mount cannot be on.
        enabled: mounted && (locked.has(entry.name) || isEnabled(entry.name)),
        locked: locked.has(entry.name),
        mounted,
        note: entry.name === 'pwsh' ? PWSH_NOTE : undefined,
      }
    })
    return {
      mode: state.mode,
      prompt: state.prompt,
      tools: rows,
      defaultOn: config.tools.defaultOn,
      stateFile,
    }
  }

  const applyPatch = (patch) => {
    const next = { ...state, tools: { ...state.tools } }
    let changed = false
    if (patch.mode === 'chat' || patch.mode === 'normal') {
      if (next.mode !== patch.mode) {
        next.mode = patch.mode
        changed = true
      }
    }
    if (typeof patch.prompt === 'string') {
      const prompt = patch.prompt.trim() === '' ? '' : patch.prompt
      if (next.prompt !== prompt) {
        next.prompt = prompt
        changed = true
      }
    }
    if (isPlainObject(patch.tools)) {
      const known = new Set(config.tools.defaultOn)
      for (const entries of discovered.values()) for (const entry of entries) known.add(entry.name)
      for (const [toolName, value] of Object.entries(patch.tools)) {
        if (!known.has(toolName) || typeof value !== 'boolean') continue
        if (next.tools[toolName] !== value) {
          next.tools[toolName] = value
          changed = true
        }
      }
    }
    if (!changed) return false
    state = next
    writePersisted(stateFile, state, ctx.logger)
    return true
  }

  async function settingsHandler(request) {
    try {
      if (request.method === 'GET' || request.method === 'HEAD') {
        reapplyAll(true)
        return jsonResponse(200, { ok: true, state: describeState() })
      }
      const type = request.headers.get('content-type')
      if (typeof type !== 'string' || !type.toLowerCase().startsWith('application/json')) {
        return jsonResponse(415, { ok: false, error: '需要 application/json' })
      }
      const body = await readJsonBody(request)
      const changed = applyPatch(body)
      if (changed) reapplyAll(true)
      return jsonResponse(200, { ok: true, changed, state: describeState() })
    } catch (error) {
      return jsonResponse(400, { ok: false, error: errorMessage(error) })
    }
  }

  async function explainHandler(request) {
    try {
      const type = request.headers.get('content-type')
      if (typeof type !== 'string' || !type.toLowerCase().startsWith('application/json')) {
        return jsonResponse(415, { ok: false, error: '需要 application/json' })
      }
      const body = await readJsonBody(request)
      const name = isPlainObject(body) && typeof body.name === 'string' ? body.name.trim() : ''
      const description = isPlainObject(body) && typeof body.description === 'string' ? body.description : ''
      if (name === '' || description.trim() === '') {
        return jsonResponse(400, { ok: false, error: '需要工具名和说明' })
      }
      const outcome = await explainTool(name, description)
      if (typeof outcome.error === 'string') {
        return jsonResponse(502, { ok: false, error: outcome.error })
      }
      return jsonResponse(200, { ok: true, text: outcome.text })
    } catch (error) {
      return jsonResponse(400, { ok: false, error: errorMessage(error) })
    }
  }

  /**
   * Register both routes on Connection's authenticated Fetch registry rather
   * than on the bare web server: Connection applies the Host/Origin fence and
   * requires an authenticated browser session or API token before `fetch` runs.
   */
  const bindRoutes = (connection) => {
    const registered = [
      connection.fetch.register({
        path: SETTINGS_ROUTE,
        methods: ['GET', 'HEAD', 'POST'],
        requestBody: 'buffered',
        fetch: settingsHandler,
      }),
      connection.fetch.register({
        path: EXPLAIN_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: explainHandler,
      }),
    ]
    return () => {
      for (const off of registered) if (typeof off === 'function') off()
    }
  }

  // Connection waits for its own injected services, so on a cold boot it can
  // activate after this plugin does. A one-shot ctx.get() lookup would then
  // leave the page's routes unregistered until the plugin was reloaded by hand —
  // that is the 404 after a restart. ctx.inject re-enters the moment the service
  // exists, so the routes bind whenever Connection shows up.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (scope) => {
      scope.effect(() => bindRoutes(scope.connection), 'tools_manager: routes')
    })
  } else {
    const connection = ctx.get('connection')
    if (connection === undefined) {
      ctx.logger.warn('tools_manager: connection is not available yet; the settings page will not load')
    } else {
      ctx.effect(() => bindRoutes(connection), 'tools_manager: routes')
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    installAgent(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    releaseAgent(agent)
    discovered.delete(agent)
  })

  try {
    for (const agent of ctx.agents.list()) installAgent(agent)
  } catch (error) {
    ctx.logger.warn(`tools_manager: cannot enumerate live agents: ${errorMessage(error)}`)
  }

  ctx.effect(() => () => {
    for (const agent of [...agents.keys()]) releaseAgent(agent)
    discovered.clear()
  }, 'tools_manager: agent registrations')
}

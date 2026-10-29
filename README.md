# tools_manager

> DSH（DeepSeek Harness）插件：把「什么都能干的编码助手」裁成省 token 的**桌面聊天 + 状态监控**助手，并给出一页侧边栏配置。

默认的 DSH 会话每轮都带着二十多个工具的 schema 和长长的行为说明，对「聊天、看看机器状态」这种轻量用法来说是纯浪费。这个插件做了三件事：

1. **换掉系统提示词**：用一段几百字的精简提示词整段替换默认提示词（可在页面里自己写）；
2. **按需保留工具**：只把开关打开的工具的 schema 发给模型，其余不进上下文；提示词里对应的段落也一起消失；
3. **网络查询要授权**：每次 `web_search` / `web_fetch` 前弹一张卡片，用户也可以直接打字回答，由一次极小的模型调用判断意图。

> 仓库名 `tools_manager`；DSH bundle id 仍是 `@local/chat-lite`（已安装的 profile 指向它，改名会断）。

## 功能一览

- 侧边栏一页配置：模式切换、逐项工具开关、提示词编辑、工具说明展开与中文解释。
- 工具清单从运行时注册表枚举，**其他插件 / MCP 带来的工具同样在列表里**，可单独开关。
- 关掉的工具：不出现在工具列表、提示词不留痕、请求里不出现。
- 两种模式共用同一套工具开关，随时可切回原样。
- 网络授权卡片：标题、问题、参数正文、按钮文字都可配，支持 `{tool}` / `{args}`。
- 自由文本意图判定：「行，查一下」放行、「先别上网」拦截、语义不明一律算不同意（fail closed）。
- 权限失败、无审批通道、子代理等边界情况都明确拒绝而不是挂起。

## 侧边栏配置页

安装后在侧边栏出现一行「聊天模式」，点开就是一页配置，改动立即对当前所有会话生效。

### 模式

| 模式 | 行为 |
| --- | --- |
| **聊天模式** | 用精简提示词整段替换 DSH 默认提示词；只保留开关打开的工具；网络查询每次弹授权卡片 |
| **常规模式** | 保留 DSH 原本的提示词和全部原始行为，不弹网络授权；工具默认全开，只有手动关掉的才关 |

两种模式下**工具开关都生效**：关掉的工具不会出现在工具的 schema 列表里，提示词里对应的段落（查看本机状态、改动系统、网络）也会随之消失，不会随请求发给模型。

### 工具开关

工具清单不是写死的，而是**从运行时注册表里枚举**出来的：内置工具、其他插件注册的工具、MCP 连接带来的工具都会出现在列表里：

- `其他插件`：不是内置工具，说明取自工具自己的描述；
- `本机未安装`：配置里点名了但当前环境没有挂载；
- `不可关闭`：会话内置工具，注册表不允许把它从上下文里摘掉。

**关于 PowerShell 工具**：DSH 的 `pwsh` 工具不是简单地起 shell，它要求宿主挂一个 PowerShell 执行器（`ctx.shell` 每个上下文只能有一个）；WSL 里挂的是 bash，所以这个工具在 WSL 里必然显示「本机未安装」。真正能跑的是 Windows 自带的 Windows PowerShell——在 bash 里直接调用即可：

```bash
powershell.exe -NoProfile -Command 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5'
```

### 说明的展开与中文解释

工具自带的说明多半是英文长句，列表里默认只显示两行。

- **点这一行**就把说明展开成全文，再点一次收起；行内的开关和按钮有自己的行为，不会被误触。
- 每行名字右边的**「解释」**按钮会请求一次模型，用中文说明这个工具做什么、什么时候用、会不会动到电脑上的东西；结果直接替换原来的说明，按钮变成**「原文」**，再点一次换回英文，来回切换不再请求模型。
- 解释按「工具名 + 原始说明」缓存在宿主内存里，同一份说明只请求一次；工具升级改了说明，缓存自动失效。

### 默认值随模式走

|  | 聊天模式 | 常规模式 |
| --- | --- | --- |
| 配置里 `tools.defaultOn` 点名的工具 | 开 | 开 |
| 其他所有工具 | 关 | 开 |
| 页面上手动开关过的 | 记住选择 | 同左 |

关闭的工具连 schema 都不发，所以聊天模式下默认只保留 7 个；常规模式默认全开，保持原样。至少要保留一个可关闭的工具。

## 安装

本包是 host-only bundle（`index.js` + 可选的 `client.js`），通过 Plugin Manager 安装：

```text
plugin_manager install_bundle({ target: "<本仓库的绝对路径>" })
```

它会同时完成两件事：把包装进 profile、把 bundle 加进 `dsh.profile.bundles`。不要手工改 profile 的 `package.json` / `cordis.patch.yml`。

**加载新代码需要重启一次 DSH**：Host 半边（`index.js`）和 Client 半边（`client.js`）都只在启动时装载；之后改 `cordis.patch.yml` 也建议重启。

## 状态保存在哪

页面里的选择写在 `$DSH_HOME/chat-lite.json`（默认 `~/.dsh/chat-lite.json`，**已在 `.gitignore` 里**，因为它可能含自定义提示词）：

```json
{
  "mode": "chat",
  "tools": { "bash": true, "web_search": false },
  "prompt": ""
}
```

`tools` 里只存**手动改过**的开关，其余默认值按模式推算，所以新装的工具不需要迁移。删掉这个文件就回到 `cordis.patch.yml` 里的默认值。优先级：页面里的自定义提示词 > `cordis.patch.yml` 的 `prompt.text` > 按已开启工具自动生成。

## 配置（`cordis.patch.yml`）

这里只放默认值，页面里改更顺手。

```yaml
mode: chat              # 默认模式：chat / normal
prompt:
  text: ''              # 留空 = 按已开启工具自动生成
  toolLine: true        # 提示词末尾附一行「你现在可用的工具：…」
  suppressRuntimeContext: false   # true 时连工作目录、沙箱策略等运行时上下文也省掉
tools:
  defaultOn: [bash, pwsh, read, write, edit, web_search, web_fetch]   # 聊天模式默认开启
webApproval:
  enabled: true
  header: 网络查询授权
  question: 允许执行 {tool} 吗？
  detail: |-
    参数：
    {args}
  allowLabel: 允许
  denyLabel: 拒绝
intent:
  enabled: true
  provider: ''          # 留空沿用当前默认模型
  model: ''
  maxTokens: 400
  timeoutMs: 30000
explain:                # 工具说明的中文解释
  provider: ''          # 留空沿用当前默认模型
  model: ''
  maxTokens: 300
  timeoutMs: 20000
  maxChars: 160         # 解释文本上限，超出截断
```

### 网络授权卡片

每次 `web_search` / `web_fetch` 前都会弹一张卡片，标题、问题、参数正文、两个按钮的文字都可以在 `webApproval` 里配，支持 `{tool}` / `{args}` 占位符。用户也可以不点按钮直接打字，插件会用一次很小的模型调用判断是否同意：

- 「行，查一下」→ 放行；
- 「先别上网」「别查了」→ 拦截，模型收到说明原因的工具错误，改用本地信息；
- 附加条件、改成提问、语义不明、与授权无关 → 一律算不同意；
- 判定失败（网络错、超时、输出无法解析）→ 也算不同意，绝不默认放行。

## 行为边界

- 一张授权卡片只对**一次**工具调用有效，不会记住「以后都允许」。
- 子代理（subagent）不能弹人工审批卡片；需要联网时会被拒绝并在结果里说明。
- 没有审批通道（纯命令行、没有 answerer）时，网络工具被拒绝而不是挂起。
- 配置了却没装上的工具会被静默忽略，日志里每种只提示一次。
- 常规模式不弹网络授权，这是刻意的：它就是要「和原来一样」。

## 实现要点

两个容易踩的坑，已在本项目里修掉，记下来免得重犯：

- **配置页 404**：Web 服务器那一行自己要等 `webStartup`，冷启动时可能比本插件晚就绪。如果只在 `apply` 里查一次 `ctx.get('webServer')`，路由就永远不会注册，页面显示 404，直到把插件关掉再打开。现在用 `ctx.inject(['webServer'], …)`，服务一出现就补注册。
- **说明展开不了**：页面的折叠是 CSS 的 `-webkit-line-clamp`，宿主必须把**完整**描述发给页面；早期在宿主侧截到 140 字，展开就成了空操作。

## 开发

```bash
node test/smoke.mjs    # Host：模式切换、提示词段落、工具白名单、授权闸门、解释路由（假 ctx）
node test/http.mjs     # 配置页接口：真起一个 HTTP server，用 fetch 走 GET/POST
node test/client.mjs   # Client：按模块加载器的样子装载 client.js，检查槽位注册
```

`index.js` 没有任何运行时依赖，只用到 `node:fs` / `node:os` / `node:path`，以及 cordis 的 `ctx.tools` / `ctx.systemPrompt` / `ctx.agents` / `ctx.webServer`，可选的 `ctx.userQuestions` / `ctx.llm` / `ctx.agentDefaultModel`。`client.js` 只用 `require('react')`，走 `window.__ModuleLoader__` 注册，无需构建。

## 目录结构

```text
.
├── index.js            # Host：提示词、工具白名单、网络授权、配置页接口
├── client.js           # Client：侧边栏入口 + 配置页（React，无构建）
├── cordis.patch.yml    # 默认配置
├── package.json        # bundle 清单：dsh.bundle.patch / dsh.client
├── icon.svg            # 侧边栏图标
├── locale/             # 界面上的标题与描述（zh / en）
└── test/               # 三个无需框架的 Node 测试
```

## 隐私

本仓库不含任何账号、令牌、个人路径或用户提示词。运行时状态文件与常见凭据文件都在 `.gitignore` 里；提交前请自查 `git diff --cached`。

## 许可

[MIT](LICENSE)。

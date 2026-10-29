# tools_manager

DSH 的插件，给插件页加一页「工具管理」。这一页只干一件事：把当前挂着的工具全列出来，一个开关一个。

关掉的不只是不执行。schema 不发了，提示词里对应的那段也没了，模型根本不知道有这个工具。

## 为什么写它

DSH 默认一轮要带几十个工具的声明，多数时候用不上。我这边日常就是聊天、看看机器状态，每轮都替那堆没碰过的工具付 token，烦。

列表是从运行时注册表读的，不是写死的配置——装了什么就显示什么，别的插件和 MCP 挂上来的工具也在里面，名字和说明照原样。

## 怎么用

侧边栏点「工具管理」。

开关改完立即对当前所有活着的会话生效，不用重开会话。点一行能展开完整说明，行里的开关和按钮不会被误触。「解释」是让模型用中文讲这个工具做什么，按钮随即变成「原文」，来回切不再请求；宿主按「工具名 + 说明」缓存，工具升级改了说明就重新问一次。搜索框对名字和说明都生效，换成中文解释之后也能按中文搜。

`其他插件` 表示它不是内置工具；`本机未安装` 是配置里点了名但环境里没有；`不可关闭` 是会话内建、注册表不让摘的。

默认值跟模式走：聊天模式只开 `tools.defaultOn` 里那几个，常规模式默认全开，手动开过的按你的选择来。

## 顺带的两件事

不关心可以跳过，它们不影响开关。

**模式。** 聊天模式把系统提示词整段换成一段精简的，页面下方能自己写，留空就按当前开着的工具生成。常规模式不动提示词。

**网络授权。** 聊天模式下，`web_search` / `web_fetch` 和任何 `web_` 开头的工具，调用前都会弹一张卡片。点按钮可以，打字也可以——「行，查一下」放行，「先别上网」拦下，中间是一次很小的模型调用，判断你那句话是同意还是拒绝。判不出来、超时、模型报错，一律按拒绝算。一张卡只管一次调用；子代理弹不出卡片，需要联网就直说被拒。

## 关于 pwsh

WSL 里这个工具必然显示「本机未安装」，不是漏配。DSH 的 `pwsh` 工具要先有 PowerShell 执行器，而 `ctx.shell` 一个上下文只能挂一个，WSL 里挂的是 bash。要跑 Windows 那边的东西，在 bash 里直接叫：

```bash
powershell.exe -NoProfile -Command 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5'
```

## 装

```text
plugin_manager install_bundle({ target: "<这个目录的绝对路径>" })
```

bundle 名就是 `tools_manager`。装完重启一次 DSH，`index.js` 和 `client.js` 都只在启动时装载。

## 存在哪

页面里的选择存在 `$DSH_HOME/tools_manager.json`（默认 `~/.dsh/tools_manager.json`），只记手动改过的项：

```json
{
  "mode": "chat",
  "tools": { "bash": true, "web_search": false },
  "prompt": ""
}
```

删掉它就回到 `cordis.patch.yml` 的默认值。那个文件里能改默认模式、默认开哪些工具、卡片上的字、意图判定和解释各自的模型参数，字段旁边都有注释。

## 踩过的坑

冷启动直接点侧边栏会 404，把插件关掉再打开又好了。原因是 Web 服务器那一行自己要等 `webStartup`，可能比本插件晚就绪；只在 `apply` 里查一次 `ctx.get('webServer')`，路由就永远注册不上。现在改成 `ctx.inject(['webServer'], …)`，服务一出现就补注册。

另一个是说明展开后仍然截断。折叠本来是 CSS 的 `-webkit-line-clamp`，但宿主侧早把文本砍到 140 字，页面拿到的就是残句，展开自然是空操作。现在宿主原样发全文。

## 开发

```bash
node test/smoke.mjs    # 假 ctx：模式、提示词段落、工具开关、授权闸门、解释路由
node test/http.mjs     # 真起一个 HTTP server，用 fetch 走 GET/POST
node test/client.mjs   # 按模块加载器的方式装载 client.js，检查槽位注册
```

没有构建步骤。宿主半边只用到 `node:fs` / `node:os` / `node:path` 和 cordis 给的 `ctx.*`，客户端半边只 require 了 react。

## 许可

MIT，见 [LICENSE](LICENSE)。

# dsh-mnn-chat · 未解决的 Bug 与原理（BUG）

> 这份文档是**交接件**。它只写**实测过的**事实、以及**还没定论**的部分。
> 没有推测被写成结论 —— 每条都标了 `【已证实】` / `【未证实】`。
> 功能与用法见 [FUNCTION.md](FUNCTION.md)。
>
> 章节导览：第 1–3 节是「行为与定论」；第 4 节是排查工具/方法的坑；第 5 节是
> 已修坑的紧凑台账（别改回去）；第 6 节是 DSH 的特性；第 7 节是排查索引。

---

## 0. 给接手人的一句话

**已定论并修复的三个大坑**（修复细节不再展开，经验都沉淀在第 5、6 节）：

1. **chat 请求 406**：406 只稳定出现在 `GET /v1/models` + `Accept: text/event-stream` 上，
   chat 端点对 Accept 完全不挑（见第 3 节定论）。插件已改为「chat 请求 JSON 优先 +
   全端点 406 换通配 Accept 自愈重试」。
2. **改配置后面板报「端点返回了非 JSON 内容（HTTP 404）」**：配置热更新会重建插件实例，
   新旧实例短暂共存时把 HTTP 端点互相踩掉（真实 webserver 按**路径**删路由、重复注册
   **直接抛错**）。已用「`ctx.inject` + 模块级归属表 `claimNamed`」修掉，带 4 条回归测试
   （见 6.12）。
3. **极简模式下插件提示词被整体压掉**：极简模式预设的 persona 行带 `complete: true`，
   装配的最后一步会把 sections 换成单元素数组，插件段落**注册成功但被丢弃**（全程无报错）。
   已改为适配器在 wire 上自己补一条尾部 system 消息（`withPersona`），与预设无关，
   真机 A/B 验证过（见 6.13 / 6.14）。

**还没定论的**：手机服务闪断（第 1 节，MNN 固有行为，非插件问题）。

---

## 1. 【已证实】手机服务会闪断

同一台机器、同一分钟内反复探 `192.168.1.23:8080`：

```
20 次高频 TCP 探测（间隔 300ms）：open × 20      ← 全开
30 秒后全网段扫描：0 个地址在监听 8080            ← 全关
再 30 秒后再扫：0 个                            ← 仍全关
然后高 ping：20/20 全开（4-8ms）
```

`tools/probe.mjs` 同一分钟内：一次 `HTTP 200` 拿到模型列表，另一次 `connect ECONNREFUSED`。

**结论**：服务随 MNN Chat App 的前后台状态起停。用户看到的「连不上」有一部分就是这个，
不是插件的错。插件这边已经做了四件事缓解：

- 探测带轻量重试（仅对 `TRANSPORT` 重试，HTTP 语义错误不重试）；
- 目录查询 60 秒缓存、UI 路径 2 秒短超时（绝不把模型选择器拖住）；
- 流空闲看门狗（默认 300 秒没数据就中断，避免挂死）；
- **后台目录刷新 + lastKnown 持久化**（`catalogRefreshMs`，默认 30 秒）：手机短暂离线时，
  选择器仍显示最近一次从手机端拉到的模型列表，恢复后自动跟上。

**但**：「一直连不上」如果持续几分钟以上，就**不是**闪断能解释的 —— 继续往下看。

---

## 2. 【已证实】手机上模型在来回换

同一天内观察到服务端 `/v1/models` 依次报过：

```
ModelScope/MNN/Qwen3.5-2B-MNN      （最早）
ModelScope/MNN/Qwen3.5-0.8B-MNN    （中间，配置里写的就是它）
ModelScope/MNN/Qwen3-0.6B-MNN      （换过）
ModelScope/MNN/Qwen3.5-0.8B-MNN    （又换回来）
```

**结论**：MNN Chat 一次只加载**一个**模型，换模型就换服务端报的 id。
这不直接导致「连不上」，但会让**排查时的对照实验互相矛盾**（一会儿能出字、一会儿不能），
接手人排查前**先确认模型 id**（`/dsh-mnn-chat/probe` 或面板的「立即刷新」）。

插件每 `catalogRefreshMs`（默认 30 秒）自动拉一次
`/v1/models`，列表变化就持久化到 `$DSH_HOME/mnn-chat.panel.json` 的 `lastKnownModels`，
模型选择器会自动出现新 id（排最前），旧的标成「最近提供过」。

---

## 3. 【已证实·定论】406 只在 `/v1/models` 上，与 Accept 头有关；chat 端点不挑 Accept

**结论**（2026-10-02 用 `tools/quick-matrix.mjs` 实测 + 读 MNN 源码双重定论）：

- `GET /v1/models` 收到 `Accept: text/event-stream` 回 **406（空响应体）**，稳定复现；
  用 `application/json` 正常。
- `POST /v1/chat/completions` 对 Accept **完全不挑**：event-stream / json / `*/*` / 无，
  流式与非流式全部 200。
- 插件的对策：探测走 JSON 头；对话请求 Accept 以 `application/json` 开头、事件流低权重
  跟后；**任何端点收到 406 都会换通配 Accept（`ACCEPT_ANY`）自愈重试一次**。
- 历史上抓到过一次「chat 406」，与上面的矩阵矛盾 —— 结合源码（chat 路径根本不读 Accept）
  判定为服务异常时刻的偶发产物；现在有自愈，再遇到也无需人工介入。

### 3.1 源码层面（MNN 开源库，`apps/Android/MnnLlmChat/app/src/main/java/com/alibaba/mnnllm/api/openai/`）

MNN Chat 的 API 服务是 **Ktor 3.1.3 + Netty**（`app/build.gradle` 的 `ktor_version`）：

- **chat 流式**：`ResponseHandler.handleStreamResponseWithFullHistory` 用
  `call.respond(SSEServerContent(call) { … })` —— `SSEServerContent` 是 Ktor 的
  `OutgoingContent` 子类，Ktor 的 ContentNegotiation 对它**直接跳过**
  （`ResponseConverter.kt`：`if (subject is OutgoingContent) return`），Accept 根本不参与。
  流里每 3 秒有一个 `: keep-alive` 心跳注释行，结束前发一个带 usage 的空 delta + `[DONE]`。
- **`/v1/models`**：`MNNModelsService.getAvailableModels` 用 `call.respond(response)` 走
  ContentNegotiation 序列化。Ktor 的 `checkAcceptHeaderCompliance` 默认是 false，
  但 Accept 不含 `application/json` 时**没有匹配的 converter**，不同构建在这里的行为
  不一样 —— 真机上表现为 406 + 空响应体。所以探测必须用 `Accept: application/json`。
- **服务端只用「当前加载的模型」**：`OpenAIChatRequest.model` 字段在 Kotlin 里是
  `val model: String? = null`，服务端完全忽略它，`getLlmSession()` 拿什么模型就答什么。
  所以「配置里写了、手机上没加载」的模型也能出字（答的是当前模型的）—— 别被误导。
- **`/v1/models` 只报当前模型**：`CurrentModelManager.getCurrentModelId()`；一个都没有时
  返回 **HTTP 500** + `{"error":"No current model available"}`（不是空列表）。
- **所有 chat 请求进队列**：`RequestQueueManager` 保证同一时间只有一次生成；
  `GET /v1/queue/status`（无需鉴权）可以看队列。之前的「请求挂住」一部分是这个：
  上一个请求没断干净，下一个就排队。
- **`max_tokens` / `stream_options` 不在请求模型里**：前者被忽略，后者（`include_usage`）
  触发旧版挂死 —— `includeUsage` 保持默认 false。
- **鉴权**：Ktor bearer；`ApiServerConfig.getApiKey` 比对，失败 401（空响应体）。
- **版本指纹**：`GET /` 旧版返回 `Hello, World!`，新版返回 `test_page.html`（DOCTYPE 开头）。
  真机当前返回 HTML → 是较新的构建（2025-10 之后）。

---

## 4. 排查时踩过的坑（避免重复踩）

### 4.1 DSH 的 Web 端点需要**签名 cookie**，curl 一律 401/404

我曾以为「`/dsh-mnn-chat/probe` 对 curl 返回 404」= 插件没注册。**这个推断是错的。**

DSH 的 Web 载波要求一个绑定 authority 的签名 cookie（见
`@deepseek-ai/dsh-client-connection/lib/index.js` 的 `isAuthenticated` / `writeUnauthorized`）：

```
curl http://127.0.0.1:19387/                          -> 401
curl http://127.0.0.1:19387/api/gateway                -> 401
curl http://127.0.0.1:19387/dsh-mnn-chat/models        -> 404
curl http://127.0.0.1:19387/plugins/@deepseek-ai/dsh-client-ui-chat/client.js -> 404   ← 官方包也 404
```

**连官方包的 bundle 路径都是 404** —— 所以 curl 的 404 只说明「我的 curl 没带 cookie」，
不说明插件在不在。要确认插件状态，用 `plugin_manager list_plugins`：

```
{"entryId":"include:mnn-chat","moduleName":"dsh-mnn-chat","enabled":true,"fiberPhase":"active","patchId":"mnn-chat"}
```

`fiberPhase: "active"` 才是「插件跑起来了」。

> ⚠️ **但这条只适用于 curl。** 浏览器页面自带 cookie，**面板拿到 404 是真的「路由不存在」** ——
> 那正是已修复的「端点被互相踩掉」bug 的现象（见 6.12）。别因为这一节就把所有 404 都当噪音。

### 4.2 `Config.listConfigs` 报 `status: "absent"` 也不代表插件没跑

它反映的是**设置页表单**的状态，不是插件生命周期。以 `list_plugins` 的 `fiberPhase` 为准。

### 4.3 `app.asar` **目录**能读，但里面单个文件不行

- ✅ `read` 工具能读 `<DSH 安装目录>\resources\app.asar\dsh\...\SKILL.md`
- ❌ PowerShell 的 `Get-ChildItem` / `node` 打开 `app.asar\dsh\...\client.js` 会报
  `Cannot mix BigInt and other types`（asar 的虚拟文件系统只被 Electron 补丁过）

**读 asar 里的文件用 `tools/asar.mjs`**（它自己解析 asar 头 + 偏移）：

```powershell
node tools\asar.mjs ls "dsh-client-ui-model-selection"
node tools\asar.mjs grep "listModels" "dsh-client-ui-model-selection/lib/client\.js$"
node tools\asar.mjs range "dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js" 100 160
node tools\asar.mjs dump "dsh/node_modules/@deepseek-ai/dsh-package-manifest/lib/index.js"
```

### 4.4 会话日志是多帧 zstd，`zstdDecompressSync` 只能解出第一行

`$DSH_HOME/sessions/**/session.v4.jsonl.zstd` 是**边追加边压**的，每段一帧。
`zstdDecompressSync` 只解第一帧 → 只拿到 `{"type":"session",...}` 那一行（看起来像日志是空的）。
必须**流式解**（见 `tools/scan-session-errors.mjs` 的 `readZstd`）。

### 4.5 `Test-NetConnection` 的成功率**不能**当结论

同一分钟内它给出 `True / False / True`，而 `poke-port.mjs` 高频探测给 `20/20 open`。
单次 TCP 探测受 ARP/防火墙/首次握手影响，**要判断服务在不在，用高频探测**。

### 4.6 【2026-10-02 新增】JS 块注释里写 `*/*` 会**提前终止注释**

在 `/** … */` 里写内容类型字面量 `` `*/*` ``（比如解释 Accept 头），其中的 `*/`
会把注释**就地终止**，后面的反引号立刻变成模板字符串开头，吞掉后续代码 ——
报错出现在**毫不相干的行**（本案：`readErrorDetail` 里的一个模板字符串）。
正确写法：注释里用「通配 Accept」这种文字，或在代码里引用常量 `ACCEPT_ANY`。

### 4.7 【2026-10-02 新增】`sleep()` 里的定时器**不能 unref**

重试退避用的 `sleep()` 一旦 `unref` 定时器，在 node:test 的子进程里（没有其它 ref'd
句柄时）事件循环会被**直接抽干**，所有在途 await 报
`Promise resolution is still pending but the event loop has already resolved`。
规则：**被 await 的定时器保持 ref**（sleep、chatProbe 超时）；只有「点火后不管」的
才 unref（流空闲看门狗、后台刷新 interval、启动首刷延时）。

### 4.8 【2026-10-02 新增】测试必须隔离 `$DSH_HOME`

插件的 apply() 会读写 `$DSH_HOME/mnn-chat.panel.json`（面板覆盖 + lastKnownModels）。
测试不隔离时：后台刷新测试会**写坏用户真实面板文件**（本案真实发生过），
其它测试也会读到真实面板覆盖导致断言随机失败。现在 `test/adapter.test.mjs` 在
文件级把 `DSH_HOME` 指到临时目录，`after()` 里恢复。

---

## 5. 【已证实】已经踩过并修掉的坑（别改回去）

| 坑 | 现象 | 现在的做法 |
|---|---|---|
| **`/v1/models` 收到 `Accept: text/event-stream` → 406** | 模型列表拿不到，选择器空 | 探测用 `Accept: application/json`，chat 用「JSON 开头 + 事件流低权重」（`buildHeaders` 的 `kind` 参数） |
| **任何端点收到 406**（个别构建的协商怪癖） | 请求被拒 | 换通配 Accept（`ACCEPT_ANY`）自愈重试一次（`_probeModels` / `_stream` / `chatProbe` 三处都有） |
| **`stream_options: {include_usage: true}` 让服务端挂死** | 请求发出去一直不返回，最后断开 | `includeUsage` 默认 `false`；`tools/probe.mjs` 也强制关掉 |
| **模型选择器被不可达的手机拖住 10 秒** | 打开选择器卡死 | UI 路径 2 秒超时、60 秒缓存、不重试 |
| **手机换模型后选择器看不到新 id** | 要手改配置 | 后台刷新（`catalogRefreshMs`）+ lastKnown 持久化，选择器自动跟上 |
| **手机离线时选择器丢掉手机端的模型** | 只剩配置兜底 | lastKnown（最近一次从手机端拉到的列表）合并进目录并标注 |
| **流被截断却假装正常结束** | 残缺回复被写进历史 | 没有 `finish_reason` 也没有 `[DONE]` → 报 `TRANSPORT`，不补假 `stop` |
| **空回复当成功** | 服务端 200 但一个字都没有 | 报 `EMPTY_RESPONSE` |
| **已经开始前就被取消，仍发出请求** | 用户点了停止但还是打了手机 | `stream()` 开头检查 `signal.aborted` |
| **`retryPolicy.maxRetries: 0` 被配置校验拒绝** | 想「不重试」配不了 | 用 `nonNegativeInteger` 而不是 `positiveInteger` |
| **提示词段落里的 `{{变量}}` 让每次调用都失败** | 用户随手写一对花括号，之后所有模型调用报错 | `interpolate: false`，按字面处理 |
| **与 DSH 自带的 persona 段落撞名** | 注册直接抛错 | 段落名用唯一的 `provider:mnn-chat`，**不能**叫 `deployment:persona-prefix` |
| **测试断言失败后进程不退出** | `node --test` 跑完卡住 | 假服务端注册到 `openFakes`，测试文件末尾 `closeAllFakes()` 兜底 |
| **`spawnSync` 在测试里和进程内假服务端死锁** | 测试挂死 | 改用异步 `execFile` |
| **块注释里写 `` `*/*` `` 把注释提前终止** | 语法错误出现在不相干的行 | 注释里不写 `*/` 字面量，引用 `ACCEPT_ANY` 常量（见 4.6） |
| **`sleep()` 的定时器 unref 抽干事件循环** | node:test 里在途 await 全部报 pending | 被 await 的定时器保持 ref（见 4.7） |
| **测试读写真实 `$DSH_HOME` 面板文件** | 写坏用户配置 / 断言随机失败 | `test/adapter.test.mjs` 文件级临时 `DSH_HOME`（见 4.8） |
| **改配置重建实例时端点被互相踩掉** | 面板报「非 JSON 内容（HTTP 404）：」、所有端点消失 | `ctx.inject(['webServer'], …)` + 模块级归属表 `claimNamed` + 每条路由独立 effect（见 6.12） |
| **同名提示词段落被新旧实例互相摘掉** | 段落悄悄消失、提示词不生效 | 同一张归属表管段落名（见 6.12） |
| **极简模式下提示词注册成功但被丢弃** | 模型完全不复述你的提示词（且**无任何报错**） | 不依赖装配：`toWireBody` 把提示词作为尾部 system 消息自己挂上（见 6.13） |

---

## 6. 【已证实】DSH 的特性（改这个插件必须知道）

这一节是为了让接手人不用重新踩一遍。全部是读 DSH 自己的实现得到的。

### 6.1 插件**不能** `import` 任何 `@deepseek-ai/*`

DSH 的 profile 模块解析只把「profile 自己声明的依赖」交给插件，内置包对插件**不可解析**，
`import` 会直接 `ERR_MODULE_NOT_FOUND`，插件加载失败。

→ 只能**鸭子类型**对接：`ctx.llm.registerAdapter()` 只要求对象形状对，`LlmAdapter` 基类没有
`instanceof` 检查。`lib/index.js` 只 import Node 内置模块（`node:fs` / `node:os` / `node:path`）。

### 6.2 失败码要挂在 `error.failure` 上，不是 `error.code`

DSH 的 `normalizeLlmFailure` **只在 `error instanceof HarnessError` 时才认 `error.code`**；
跨包拿不到那个类。但它会读错误自身的 **`failure` 数据属性**（own data property）并校验：

```js
{ message, code, status?, providerRetryAfterMs?, requestId?, offloadImages? }
```

→ `fail()` 两个都挂：`failure` 供 DSH 读，`code`/`message` 供人看日志。

### 6.3 每个 `llm` 请求都要带 `user-agent` 归因头

值是 harness 的 `product/version (+url)` 约定，省略等于不归因，不可接受。

### 6.4 `StreamChunk` 的块序列必须完整

```
block-start → （text-delta | reasoning-delta | tool-call-delta）→ block-end
→ usage? → finish（恰好一次，且必须是最后一个 chunk）
```

**DSH 的块索引 = 块出现顺序**，与 OpenAI 的 `tool_calls[].index` **不是一回事**。

### 6.5 模型选择器显示 `name`，派发用 `id`

`dsh-client-ui-model-selection/lib/client.js`：渲染用 `model.name`，发请求用 `model.id`。

→ 「去掉模型 id 前缀」只改 `name` 就行，**协议字段一个字都不用动**。

### 6.6 `PromptSection.text` 可以是函数

每次组装提示词都重新求值 → 面板改提示词能立刻生效、不用重建插件实例。
但必须同时给 `interpolate: false`（见第 5 节的坑）。

`SECTION_ORDERS` 的顺序（`dsh-system-prompt`）：

```
-1000 harness 身份 → 0 persona 前缀 → 500–3100 各工具指引 → 5000 Tools SDK
→ 9000 交付物引用 → 【9100 本插件】 → 9900 结构化输出
→ 10000 harness source → 10100 Web surface → 10200 persona 后缀
```

### 6.7 `link:` 模块被 ESM 图缓存 —— 改代码必须**完整重启 DSH**

改配置只会**重建插件实例**（`apply` 重跑），**不会重新 `import` 文件**。
而 `dsh.client` 声明与浏览器 bundle 图也是**进程启动时扫描并缓存**的
（`dsh-client-modules` 明确写了包元数据「连同 not-a-client-package 的否定结论」都缓存到重启为止）。

→ **禁用再启用插件不够，只有退出重开。** 验证方法：看端点回的 `codeVersion`。

### 6.8 插件设置页入口**不能**挂 `settings.models.provider-card`

那张卡片只在「目录行 + 已解析的设置命名空间」同时存在时才派发，而设置命名空间要求插件导出
带 `toJSON` 的 **Config schema**（`dsh-settings` 的 `schema(entry)` 读 `fiber.runtime.Config`）。

本插件是**无 schema 的纯 JS 插件**（没有 `export const Config`），所以那条路**永远是空的**。
入口挂在**无条件渲染**的 `settings.models.footer` 上。

> 如果接手人想让插件出现在 provider 卡片上，需要先给插件加一个 `Config` schema
> （`export const Config = z.object({...})`），但那就得**重写整个配置解析**（现在是手写的
> `resolveConfig`，不依赖 schemastery）。

### 6.9 DSH 的 Web 载波要求签名 cookie

浏览器访问是带 cookie 的；`curl` 一律 401 / 404。**用 HTTP 探测 DSH 自己的端点来判断插件状态是无效的**，
用 `plugin_manager list_plugins`（看 `fiberPhase`）或 `cordis_inspect_query`。

### 6.10 浏览器半边只能 `require` 平台基线

平台表（`PLATFORM_MODULES`）里 React 是基线。**不能** `require` 任何 `@deepseek-ai/*` 客户端包
（如 `dsh-client-ui-primitives`）—— 它们不在表里，`require` 直接抛。

样式只用 `--dsw-alias-*` 主题令牌，并作为 React 元素渲染在组件里（卸载时一起移除，
不往 `document` 上留东西）。任何一处抛异常会让整个 slot 条目消失（console 报
`slot entry crashed in '<slot>'`）。

### 6.11 配置热更新 vs 代码热更新

| 改什么 | 生效方式 |
|---|---|
| `cordis.patch.yml` 里的 `config` | **热生效**（Loader 重建插件实例，`apply` 重跑） |
| 面板覆盖文件（`mnn-chat.panel.json`） | **立刻生效**，连插件实例都不用重建 |
| `lib/index.js` / `client.js` / `package.json` | **必须完整重启 DSH** |

> ⚠️ 「配置热生效」有个副作用：**每次改配置都会重建插件实例，新旧实例会短暂共存**。
> 任何「注册到某个共享服务上」的东西都要能扛住这件事 —— 见 6.12。

### 6.12 注册到 `webServer` 必须用 `ctx.inject`，而且注销要自己保证归属

`dsh-host-webserver` 的两个语义合起来很危险（读的 asar 源码，`lib/index.js:177` 附近）：

```js
register(route) {
  if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
  table.set(route.path, route)
  return () => { table.delete(route.path) }        // ← 按「路径」删，不校验归属
}
```

- 同一路径重复 `register` → **抛错**；
- 注销的 disposer 是 `table.delete(path)` —— **按路径删，不看那条路由是谁注册的**。

所以「在 `apply()` 里 `ctx.get('webServer')` 然后注册」这个写法，碰上 6.11 的实例重建就会
新旧互相踩：旧路由还在时新实例注册 → 抛 duplicate → `apply()` 中断；或旧实例的清理跑在
新实例注册之后 → 把**新实例**的路由删掉。两种结局都是「插件 fiber 还是 `active`、
面板照常渲染，但宿主里一个端点都没有」（面板对空 body 的 404 做 `JSON.parse('')` →
报「端点返回了非 JSON 内容（HTTP 404）：」，冒号后面是空的）。**官方插件全部用**：

```js
ctx.inject(['webServer'], (webCtx) => {
  webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler }))
})
```

`ctx.inject(['systemPrompt'], …)` 同理 —— 段落名重复注册也是抛错。
光有 `ctx.inject` 不够（它只保证「我这一代卸载时撤掉我的」），本项目另外加了**模块级归属表
`claimNamed(key, register)`**：接管同名 key 时先撤上一个主人、卸载时校验归属再删；
跨插件实例生效（`link:` 模块在一个进程里只有一份）。同一机制也用在系统提示词段落上。
每条路由各自一个 effect，一条失败不影响其它端点。

回归测试在 `test/adapter.test.mjs`（4 条）；关键是 `test/helpers.mjs` 的 `MockWebServer`
**故意照抄真实实现那两个危险语义** —— 不照抄就测不出这类 bug。验证方法：
把 `claimNamed` 换回直接 `register`，重建实例的两条测试会红。

**判据**：只要注册目标是一个「按名字/路径共享、重复注册会抛错」的服务，就要
①`ctx.inject` ②自己的归属表（本项目是 `claimNamed`）③一个注册一个 effect。

### 6.13 【2026-10-02 新增】提示词装配会被**预设**整体替换，插件改不了

`systemPrompt.section()` 只是往装配里**加一段**；装配的最终结果可以被预设覆盖：

- 预设的 persona 行带 `complete: true` → `assemble()` 返回
  `sections: [那一段]`，**其它所有段落（含插件的）被丢弃**，且不报错；
- 该行还可以 `includeRuntimeContext: false` → 连 runtime context 一起关掉；
- 预设是**用户 profile 组合里的行**，插件既改不了也不该改。

内置预设的实际配置可以整份 dump 出来看（asar 内的路径）：

```powershell
cd dsh-mnn-chat\tools
node asar.mjs dump 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/minimal.patch.yml'
node asar.mjs dump 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'
```

**对插件的含义**：想让一段文本**一定**被模型看到，别只依赖 section ——
适配器在 `GenerateOptions.system` 里拿到的是装配成品，**在 wire 上自己补一条
system 消息**才是与预设无关的做法（本插件的 `withPersona`：作为最后一条 system 消息追加，
放最后既不破坏 KV-cache 前缀、又对小模型最有效；与装配结果相同则不重复；为空则不追加）。
回归测试在 `toWireBody` 层（3 条，不需要活服务）。

### 6.14 【2026-10-02 新增】MNN 服务端接受多条 system 消息

真机 A/B 验证过：`[system A, user, system B]` 这种顺序里，模型按 B 的指令回答，
即**尾部 system 压得过前面那条**。所以「追加一条尾部 system」是安全的兜底手段，
不需要把文本硬拼进 `options.system`。

---

## 7. 如果最后发现是插件的问题，改哪里

按可能性排序：

| 症状 | 大概位置 |
|---|---|
| 面板报 404 /「非 JSON 内容」 | 端点注册：`ctx.inject(['webServer'], …)` + `claimNamed()`（见 6.12） |
| 提示词段落不生效 | 段落注册：`ctx.inject(['systemPrompt'], …)` + `claimNamed` |
| **提示词在极简模式下不生效** | **不是段落注册的问题**，是预设 `complete: true`；看 `withPersona`（见 6.13） |
| chat 请求头不对（406） | `lib/index.js` 的 `buildHeaders(config, apiKey, kind)` |
| 请求体里有 MNN 不认的字段 | `toWireBody(config, options)` —— 目前只放 `model/messages/stream/temperature/max_tokens/tools`，外加尾部的插件提示词 |
| 路径不对 | `pathCandidates(style)` / `endpointFor(baseURL, path)` |
| 流解析太严 | `sseData(body, signal)` / `BlockAccumulator` |
| 失败分类不对（该重试的没重试） | `codeForStatus(status)` / `DEFAULT_RETRY_POLICY.retryableCodes` |
| 探测策略太激进/太保守 | `_probeModels(config, timeoutMs)` / `CATALOG_PROBE_TIMEOUT_MS` / `CATALOG_CACHE_TTL_MS` |
| 面板覆盖没生效 | `readRawConfig()` / `overlayPanel(base, state)` / `PANEL_FIELDS` |

**改完一定跑**：

```powershell
node --test test/adapter.test.mjs test/probe.test.mjs test/client.test.mjs
node tools\live-check.mjs <baseURL> --key <密钥>
```

`live-check.mjs` 能在**不重启 DSH** 的前提下验证真机链路 —— 这是这个项目里最省时间的工具。

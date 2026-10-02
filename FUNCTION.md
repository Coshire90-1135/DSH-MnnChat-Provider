# dsh-mnn-chat · 功能说明（FUNCTION）

> 讲**能做什么、怎么用、内部怎么转**。踩过的坑、原理细节、以及**目前还没解决的 bug** 见 [BUG.md](BUG.md)。
> 面向接手的人：读完这两篇 + [README.md](README.md) 就能接着改。

---

## 1. 这个插件解决什么问题

MNN Chat（[alibaba/MNN](https://github.com/alibaba/MNN) 的端侧 App，MnnLlmChat）在手机上加载本地
模型后，能开一个 HTTP 服务，对外是 **OpenAI 兼容**接口：

```
POST {baseURL}/v1/chat/completions     # SSE 流式
GET  {baseURL}/v1/models               # 模型列表
```

本插件把这个服务注册成 **DSH 的一个 LLM provider**（默认路由名 `mnn-chat`），
于是手机上的模型能和官方 deepseek 一样出现在模型选择器里、直接对话。

```
┌────────────────┐   OpenAI 兼容 /v1/chat/completions (SSE)   ┌───────────────────┐
│  DSH (电脑)     │ ─────────────────────────────────────────▶ │ 手机 MNN Chat      │
│  provider:     │ ◀───────────────────────────────────────── │ 端侧模型            │
│  mnn-chat      │        text-delta / tool_calls              │ ModelScope/MNN/…  │
└────────────────┘                                             └───────────────────┘
        ▲
        │ 浏览器同源 fetch（悬浮面板）
        │
   ┌─────────────┐
   │  ● MNN 面板  │  连接设置 / 提示词 / 连通性测试
   └─────────────┘
```

---

## 2. 用户能看到什么

### 2.1 模型选择器里多一个 provider

- provider 显示名 = 配置的 `displayName`（当前 `MNN-chat`），**纯展示**；
- 模型显示名默认带 provider 前缀（`mnn-chat/Qwen3-0.6B-MNN`），协议字段 `id` 一个字不改；
  三档由 `modelLabel` 决定（`prefixed` 默认 / `tail` / `full`），面板上也能切；
- 手机上换了模型**不用改配置**：插件每 `catalogRefreshMs`（默认 30 秒）自动拉一次
  `/v1/models`，此刻在提供什么就自动出现在选择器最前面；拉到的列表还会持久化成
  「最近已知列表」，手机短暂离线时选择器也不会丢；
- 最近提供过但此刻没提供的排后面并标注；配置里写了但从未见过的排最后；
- 面板里可以随时点「立即刷新」强制重探一次（`POST /dsh-mnn-chat/refresh`）。

### 2.2 悬浮设置面板

两个入口（效果一样）：输入框工具行左侧的 **`● MNN`**（带状态点），和
**设置 → 模型** 页底部那一行「MNN Chat（手机端）」。

| 区块 | 能改什么 |
|---|---|
| **连通性测试** | 先探 `/v1/models`，**再真的发一句话跑一次对话往返**，报首字延迟 / 总耗时 / 模型回复 |
| **手机端模型（自动拉取）** | 最近一次从手机端拉到的模型列表 + **立即刷新** + 一键填进兜底编辑框 |
| **连接** | `http`/`https`、地址、端口、**API Key**（写进 DSH 凭据，不回显） |
| **模型** | 选择器显示名（带 provider 前缀 / 末段 / 完整 id）、兜底模型名 |
| **参数** | 上下文窗口、单次输出上限 |
| **系统提示词** | 只对 MNN 这条路由生效的一段话 |

每块独立保存、各自标「面板覆盖 / 跟随配置」。**保存后立刻生效，不用重启 DSH，也不打断正在进行的对话。**

面板的关闭方式：**点面板以外的区域**、`Esc`、再点一次开关按钮。
「点外面关闭」用的是 `document` 的**捕获阶段 `pointerdown`**：捕获早于冒泡，
不会和面板内按钮的点击抢顺序；同时排除了面板自身（`[data-mnn-panel]`）与两个
开关按钮（`[data-mnn-toggle]`）—— 不排除开关的话，它的 `pointerdown` 会先关、
紧接着 `onClick` 又开，表现为「怎么点都关不掉」。

### 2.3 改动存在哪

`$DSH_HOME/mnn-chat.panel.json` —— 一个**覆盖层**，优先级高于 profile 配置：

```json
{
  "baseURL": "http://192.168.1.23:8080",
  "modelLabel": "prefixed",
  "models": ["ModelScope/MNN/Qwen3-0.6B-MNN"],
  "contextWindow": 32768,
  "maxTokens": 2048,
  "systemPrompt": "只用一句话回答。",
  "savedAt": "2026-10-02T03:11:20.114Z",
  "lastKnownModels": ["ModelScope/MNN/Qwen3-0.6B-MNN"],
  "lastKnownAt": "2026-10-02T00:18:27.318Z"
}
```

- **密钥不在这个文件里**（在 `.credentials.yaml` 的 `refs:`）；
- `lastKnownModels` / `lastKnownAt` 是插件后台自动拉取维护的「最近已知模型列表」，
  **不要手改**，面板的「立即刷新」会更新它；
- 点「清除覆盖」或删掉文件 = 回落到 profile 配置（自动拉取的列表会很快重新长出来）；
- 坏掉的字段会被**单独跳过**，同一份文件里其余字段照用。

### 2.4 六个 HTTP 端点

| 地址 | 方法 | 用途 |
|---|---|---|
| `/dsh-mnn-chat/probe` | GET | 解析后的地址、密钥来源、服务端 `/v1/models` 结果 |
| `/dsh-mnn-chat/probe` | POST | `{"chat":true}` → 真跑一次对话往返，回 `ms` / `firstTokenMs` / `reply` / `truncated` |
| `/dsh-mnn-chat/models` | GET | 模型选择器里会出现的清单（含显示名） |
| `/dsh-mnn-chat/refresh` | POST | 强制重探手机端模型目录（绕过缓存），持久化成「最近已知列表」 |
| `/dsh-mnn-chat/state` | GET | 面板读的全部内容（连接、参数、提示词与来源、密钥状态、存档路径、`catalog`） |
| `/dsh-mnn-chat/settings` | POST | 面板唯一的写入口（字段级覆盖，`null` = 清除；`apiKey` / `clearApiKey` 写凭据） |

全部响应带 `codeVersion`（当前 `2026-10-02.4`）—— 用来确认 DSH 里跑的是哪一版代码。

---

## 3. 内部怎么转

### 3.1 两个半边

| 半边 | 文件 | 运行在 | 干什么 |
|---|---|---|---|
| **Host** | `lib/index.js` | Node（DSH 主进程） | 注册 LLM 适配器、注册 5 个 HTTP 端点、管面板覆盖层、注册系统提示词段落、把提示词补成尾部 system 消息 |
| **Client** | `client.js` | 浏览器 | 悬浮面板 UI，只通过**同源 fetch** 调上面那 5 个端点 |

Client 半边不 import 宿主的任何服务 —— 宿主代码改了它不用跟着改。

### 3.2 一次对话的完整链路

```
用户选 MNN 模型发消息
  → DSH llm 服务问适配器 listModels()（模型选择器）/ resolveModel()（校验）
  → prepareCall(route, model)  ← 这里把配置与密钥**快照**下来
  → stream(options)：
      读配置（config ← profile + 面板覆盖）
      拼 OpenAI 请求体（messages / tools / stream:true）
        messages 尾部再挂一条插件提示词（withPersona）← 极简模式也靠这一步
      POST {baseURL}/v1/chat/completions
      解析 SSE → 吐 DSH 的 StreamChunk
```

`stream()` 必须产出**完整块序列**：`block-start` → delta → `block-end`，最后才是
`usage?` + `finish`。只发 delta 不发块边界，assistant 消息会缺块，UI 与工具回灌都会坏。

### 3.3 面板覆盖层怎么做到「立刻生效」

关键在两个设计：

1. **适配器每次操作前重读配置**（`readRawConfig()` → `resolveConfig()`），不缓存配置对象。
   所以改了地址，**下一句话**就打新地址 —— 不用重建插件实例。
2. **系统提示词段落的 `text` 是个函数**（不是字符串），每次组装提示词都重新求值。

```js
systemPrompt.section({
  name: SECTION_NAME,          // 'provider:mnn-chat'，唯一，不能撞 DSH 自带的 persona 段
  order: config.systemPromptOrder,  // 默认 9100
  interpolate: false,          // ← 必须
  text: () => currentPrompt(), // ← 函数：保存即生效
})
```

`interpolate: false` 不是可选项：DSH 默认会对段落做 `{{变量}}` 展开，而**未注册的变量是抛异常**
（不是留原文）—— 用户随手写一对花括号就能让之后每一次模型调用都失败。这段按字面处理。

#### 提示词有**两条**送达路径（缺一不可）

只注册 section 是不够的：装配结果可以被**预设**整体替换。内置「极简模式」的 persona 行带
`complete: true`，`assemble()` 最后一步会把 sections 换成 `[那一段]`，插件段落**注册成功但被丢弃**
—— 全程不报错。所以同一个提示词走两条路：

| 路径 | 生效场景 | 实现 |
|---|---|---|
| ① 提示词段落（section） | 标准/PTC 等未用 `complete` 的预设 —— 参与排序，位置可控 | `ctx.inject(['systemPrompt'], …)` + `claimNamed` |
| ② **尾部 system 消息** | **所有预设，含极简模式** | `toWireBody` → `withPersona(messages, config.systemPrompt)` |

②是适配器层的兜底：`GenerateOptions.system` 是装配成品，我们在 wire 上再追加一条 system 消息。
放最后是因为装配结果（含工具引导）要留在前面保 KV-cache 前缀，而小模型对最后读到的指令最敏感。
文本与装配结果相同时不重复追加。代价是提示词「位置不可控」（永远在最后）——
想精确控制位置就用标准模式，那时①说了算。

> 完整根因、DSH 源码行号与真机 A/B 验证见 [BUG.md 6.13 节](BUG.md)。

### 3.4 模型目录自动拉取（后台刷新器）

「手机上换了模型，DSH 的选择器自动跟上」靠三层机制：

```
apply() 启动 → createCatalogRefresher（间隔 catalogRefreshMs，默认 30 秒，0 = 关）
  每个 tick：
    adapter.refreshCatalog(config, 8s)     ← 绕过缓存强探 /v1/models
    列表变了 → persistLastKnownModels(ids)  ← 写进 $DSH_HOME/mnn-chat.panel.json
                                            （lastKnownModels / lastKnownAt 字段）
    变化时打一条 info 日志；连续 3 次失败才告警一次（手机离线不刷屏）
listModels() 合并三层：
    ① 服务端此刻在提供的（缓存或现场探，2 秒上限）—— 排最前，没有标注
    ② lastKnown 里此刻没提供的 —— 标「手机端最近提供过」
    ③ 配置兜底名单里从未见过的 —— 标「已配置，但手机端此刻没有提供它」
acceptsModel()/resolveModel() 认 ①②③ 全部 —— 手机刚换模型还没刷新，手输 id 也不会被拒
```

面板的「手机端模型（自动拉取）」区块展示同一份数据：缓存里的服务端目录（`catalog.cached`）、
最近已知列表（`catalog.lastKnown`）、「立即刷新」按钮（走 `/refresh`）、
以及把列表一键填进兜底编辑框。配置热更新（改 `catalogRefreshMs`）会重启刷新器。

### 3.5 为什么覆盖层落文件，而不是写回 cordis.patch.yml

1. 改 profile 配置会触发 Loader **重建插件实例**（适配器注册会短暂消失），而改地址/提示词
   不该打断正在进行的对话；
2. 不碰用户手写的 YAML，避免和手改内容互相覆盖；
3. 覆盖层随时能「清除覆盖」回落 —— 写回 YAML 就没有「回落」这个语义了。

### 3.6 密钥为什么单独走凭据服务

- 面板只报「配没配 / 从哪来 / 能不能写」（`ctx.credentials.describe()`），**从不把明文读回浏览器**；
- 写入走 `ctx.credentials.set()`，落到 `.credentials.yaml` 的 `refs:`；
- 配置里没有 `apiKeyEnv` 时，存密钥会**顺手把 `apiKeyEnv` 一起写进覆盖** —— 否则存了也不生效
  （适配器不会带 `Authorization` 头）；
- 凭据被环境变量 / `.env` 遮蔽时 `writable: false`，面板会明说「写不进去，得先清掉那个来源」。

### 3.7 密钥解析顺序

`config.apiKey`（明文，仅本地调试） → 凭据服务里的 `apiKeyEnv` → 同名环境变量 → 都没有就不带
`Authorization` 头。**解析失败必须在模型请求发出之前报出来**（`prepareCall` 里就解析）。

---

## 4. 测试与自检

```powershell
cd dsh-mnn-chat   # 换成你的项目目录
node --test test/adapter.test.mjs test/probe.test.mjs test/client.test.mjs   # 101 个用例，约 6 秒
node tools\live-check.mjs http://192.168.1.23:8080 --key 你的API密钥            # 真机联调，不用重启 DSH
node tools\probe.mjs http://192.168.1.23:8080 --key 你的API密钥                 # 只测网络 + 一次对话
node tools\quick-matrix.mjs http://192.168.1.23:8080 你的API密钥                # 头部矩阵对照实验（带端口预探）
```

| 文件 | 测什么 |
|---|---|
| `test/adapter.test.mjs` | Host 半边：配置归一化、线格式转换、SSE 分块、失败码、目录探测、面板覆盖层、路由/端点生命周期 |
| `test/probe.test.mjs` | `tools/probe.mjs` 这个命令行自检工具本身 |
| `test/client.test.mjs` | **浏览器半边**：用迷你 React + 假 fetch 直接驱动 `client.js` 的三个组件 |

`test/client.test.mjs` 不需要浏览器：它把 `window.__ModuleLoader__`、`require('react')` 和 `fetch`
换成替身，所以「点一下到底发了什么请求」这类问题不用开浏览器就能验。

### 诊断工具（`tools/`）

| 工具 | 用途 |
|---|---|
| `live-check.mjs` | **不启动 DSH**，在本进程里 `apply()` 插件的 Host 半边，用插件自己的端点打真机 |
| `probe.mjs` | 最小自检：探模型列表 + 跑一次流式对话 |
| `accept-matrix.mjs` | 等手机服务起来，一口气跑完 chat 请求的头部/参数组合（旧版，无端口预探） |
| `quick-matrix.mjs` | **优先用这个**：头部矩阵对照实验，每个用例前先探端口，服务掉了立即退出，只留有效数据 |
| `poke-port.mjs` | 高频探一个 host:port，看是「一直不在」还是「时有时无」 |
| `find-mnn-service.mjs` | 扫本地 /24 网段的 8080 —— 定位「手机换 IP 了」 |
| `scan-session-errors.mjs` | 解 `.jsonl.zstd` 会话日志，翻真实报错 |
| `asar.mjs` | 从 DSH 的 `app.asar` 里 `ls` / `grep` / `dump` / `range` 官方实现 |
| `dump-asar.mjs` | 把 asar 里整个包导出到磁盘 |

---

## 5. 当前配置（profile `desktop`）

`profiles/desktop/cordis.patch.yml`：

```yaml
- id: mnn-chat
  name: dsh-mnn-chat
  config:
    baseURL: http://192.168.1.23:8080
    displayName: MNN-chat              # 选择器里的 provider 分组名
    apiKeyEnv: MNN_CHAT_API_KEY      # 密钥在 .credentials.yaml 的 refs:
    models:
      - ModelScope/MNN/Qwen3-0.6B-MNN   # 只是离线兜底
    modelLabel: prefixed             # 显示成 mnn-chat/Qwen3-0.6B-MNN（可省，默认就是它）
    contextWindow: 32768
    maxTokens: 2048
  disabled: false
```

`profiles/desktop/package.json` 的依赖里有 `"dsh-mnn-chat": "link:D:/dsh/proj/dsh-mnn-chat"`，
`dsh.profile.bundles` 里有 `dsh-mnn-chat`。

---

## 6. 配置项全表

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8080` | 手机端地址。`ip:8080`、`…/`、`…/v1` 都识别 |
| `models` | 必填 | **离线兜底**名单；服务端在提供的无需写这里 |
| `provider` | `mnn-chat` | 路由名。挂两台手机就再装一份改名 |
| `displayName` | `MNN Chat` | 选择器里的 provider 名，纯展示 |
| `modelLabel` | `prefixed` | 显示名三档：`prefixed`（`${provider}/${id 末段}`，前缀取**路由名**不是 `displayName`）、`tail`（末段）、`full`（完整 id）。**只影响显示** |
| `apiKeyEnv` | 无 | 凭据名。解析不到会明确报 `MISSING_CREDENTIAL` |
| `apiKey` | 无 | 明文，仅本地调试 |
| `contextWindow` | `32768` | 上报的窗口，**别报大** |
| `maxTokens` | `8192` | 单次回复上限，手机端建议 1024–4096 |
| `timeoutMs` | `120000` | 单次请求总超时 |
| `streamIdleTimeoutMs` | `300000` | 流空闲超时 |
| `includeUsage` | `false` | **保持 false**（见 BUG.md） |
| `pathStyle` | `auto` | `auto` 先 `/v1/…`，404 回退 `/chat/completions` |
| `headers` | 无 | 额外请求头，**别覆盖 `accept`** |
| `extraBody` | 无 | 透传的额外请求体字段 |
| `retryPolicy` | 见下 | `{mode, maxRetries, retryableCodes, initialDelayMs, maxDelayMs, jitterRatio}` |
| `catalogRefreshMs` | `30000` | 模型目录自动拉取间隔；`0` 关闭后台轮询（面板仍可手动刷新） |
| `systemPrompt` | 无 | 本插件插入的系统提示词段落 |
| `systemPromptOrder` | `9100` | 该段落在提示词里的位置 |

面板能覆盖的只有：`baseURL`、`modelLabel`、`models`、`contextWindow`、`maxTokens`、
`systemPrompt`、`apiKeyEnv`。

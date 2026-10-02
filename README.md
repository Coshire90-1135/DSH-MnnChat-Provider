# dsh-mnn-chat

把 **MNN Chat**（[alibaba/MNN](https://github.com/alibaba/MNN) 的端侧 App，MnnLlmChat）跑在手机上
的那个本地模型，接进 **DSH（DeepSeek Harness）** 当 provider 用。

```
┌──────────────┐   OpenAI 兼容 /v1/chat/completions (SSE)   ┌──────────────────┐
│  DSH (电脑)   │ ─────────────────────────────────────────▶ │ 手机 MNN Chat     │
│  provider:   │ ◀───────────────────────────────────────── │  端侧模型          │
│  mnn-chat    │        text-delta / tool_calls              │  ModelScope/MNN/…│
└──────────────┘                                             └──────────────────┘
```

## 三十秒上手

本机（profile `desktop`）已经装好并配好了，直接：

1. 点输入框上方的**模型选择器**。
2. 选 provider **`ModelScope/MNN`**。
3. 选下面那个模型（显示成 `Qwen3-0.6B-MNN`，协议 id 仍是 `ModelScope/MNN/Qwen3-0.6B-MNN`）。
4. 说话即可。

> 前提：手机 App 里 **API 服务**开着，且**手机与电脑在同一局域网**。手机切后台久了
> Android 会挂起这个服务，现象就是「连不上」——把 App 拉回前台即可，插件会自动重试。

## 悬浮设置面板：连接、提示词、连通性测试

两个入口，效果一样：

- 对话页输入框工具行左边的 **`● MNN`** 小按钮（跟权限/计划那一排，带状态点：绿=上次测试正常）；
- **设置 → 模型** 页底部（provider 行与「添加」按钮之后）那一行「MNN Chat（手机端）」。

关掉面板：**点面板以外的任何地方**、按 **Esc**、或再点一次那个开关按钮。
（想快速换模型的话，点选择器时面板会自动让开。）

面板分几块，每块各自保存、各自标出「面板覆盖 / 跟随配置」：

| 区块              | 能改什么                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **连通性测试**       | 先问一次 `/v1/models`（列出手机端此刻在提供的模型、显示名与 id、配置里有没有写），**再真的发一句话跑一次对话往返**，报首字延迟、总耗时、模型回复。点一下就能分清「HTTP 服务在」和「模型能出字」。                                              |
| **手机端模型（自动拉取）** | 显示最近一次从手机端拉到的模型列表，带**立即刷新**按钮（强制重探一次手机端并持久化）；一键「把这份列表填进兜底编辑框」。后台每 `catalogRefreshMs`（默认 30 秒）自动拉取一次，手机上换了模型这里会自动跟上。                                        |
| **连接**          | `http`/`https` 协议开关、服务器地址、端口、**API Key**。地址栏直接粘完整 URL 会自动拆成三格，下面实时显示拼出来的 `/v1/chat/completions`。密钥写进 DSH 凭据（`.credentials.yaml` 的 `refs:`），**不落面板文件、不回显**。 |
| **模型**          | 选择器里的显示名（**带 provider 前缀** / 只显示末段 / 完整 id 三档）、**兜底模型名**（手机没响应时也列出来的名字，一行一个）。                                                                              |
| **参数**          | 上下文窗口、单次输出上限。                                                                                                                                              |
| **系统提示词**       | 多行编辑框，保存即生效——**不用重启、不用重建插件**（这段文字是按次求值的）。                                                                                                                  |

### 改地址 / 端口 / 密钥之后会发生什么

面板写的是**覆盖层**，优先级高于 profile 配置；点「清除覆盖」就回落到配置里的值。
保存后**立刻生效**：适配器每次操作都重新读一遍配置，下一句话就打新地址，不用重启 DSH，
也不会打断正在进行的对话。

| 你想干的事                 | 在面板里怎么做                        |
| --------------------- | ------------------------------ |
| 手机换了 IP / 换了一台手机      | 「连接」→ 改地址（或直接把新 URL 粘进地址栏）→ 保存 |
| 端口从 8080 改成别的         | 「连接」→ 改端口 → 保存                 |
| 手机 App 里重新生成了 API Key | 「连接」→ 粘贴新密钥 → 保存密钥             |
| 不想带密钥了                | 「连接」→ 清除                       |
| 手机上换了模型，想固定列表         | 「模型」→ 兜底模型名 → 保存               |
| 模型太小，想把窗口报小一点         | 「参数」→ 上下文窗口 / 输出上限 → 保存        |

### CORS 和 HTTPS 是怎么回事

- **CORS**：只约束**浏览器**直连手机服务的场景（浏览器会先发预检、再检查响应头）。
  DSH 是从电脑进程里用 Node 的 `fetch` 请求手机的，既不发 `Origin`、也不检查响应头，
  **完全不受 CORS 限制** —— 手机上那个开关开不开，对本插件都没有影响。
  它是给「网页直接调你的手机」准备的，不是给 DSH 准备的。
- **HTTPS URL for clients**：那是手机端给出的「给客户端用的地址」。本插件两种都认：
  地址栏填 `https://…` 就走 HTTPS（面板上有 `http`/`https` 开关，粘完整 URL 也会自动切）。
  注意 Node 会校验证书，自签证书会被拒绝（报 `fetch failed`），得让证书被系统信任。

> 面板只能改**客户端这一侧**的东西。CORS 开关、端口、API Key 的生成、HTTPS 入口，
> 这些是**手机 App 里**的设置，插件改不了它们 —— 它只能按你给的地址去连。
> 如果 MNN Chat 以后提供了「读写自身配置」的 HTTP 接口，告诉我，可以把那些也接进面板。

面板里的东西存在 `$DSH_HOME/mnn-chat.panel.json`（面板底部会显示完整路径）：

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

**密钥不在这个文件里**（它在 `.credentials.yaml`）。删掉这个文件等于全部回落到配置
（自动拉取的模型列表会很快重新长出来）。`lastKnownModels` / `lastKnownAt` 两行是插件
后台自动拉取维护的「最近一次从手机端见到的模型」，**不要手改**。
手改这个文件也认 —— **重新打开一次面板**就生效。坏掉的字段会被单独跳过，
同一份文件里其余字段照用，绝不影响插件加载。

### 诊断端点

浏览器直接打开（端口以 DSH 实际监听为准，本机是 `http://127.0.0.1:19387`）：

| 地址                       | 方法   | 看什么                                                                                                                                                                  |
| ------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/dsh-mnn-chat/probe`    | GET  | 解析后的地址、密钥来源、服务端 `/v1/models` 的结果。连接问题先看这里。                                                                                                                           |
| `/dsh-mnn-chat/probe`    | POST | body `{"chat": true, "model": "可选"}`：**真的跑一次对话往返**，额外回 `chat.ms` / `chat.firstTokenMs` / `chat.reply` / `chat.truncated`。                                            |
| `/dsh-mnn-chat/models`   | GET  | **模型选择器里会出现的清单**（就是 DSH 拿到的目录），含显示名。手机上换了模型看这里就知道该选哪个。                                                                                                               |
| `/dsh-mnn-chat/refresh`  | POST | **强制重探**手机端 `/v1/models`（绕过缓存），把结果持久化成「最近已知列表」并回给面板。手机刚换了模型、想马上在选择器里看到就调它。                                                                                           |
| `/dsh-mnn-chat/state`    | GET  | 面板读的东西：连接、参数、提示词与来源、密钥状态（不回显明文）、面板存档路径、模型目录现状（`catalog`）。                                                                                                            |
| `/dsh-mnn-chat/settings` | POST | 面板写的东西。body 里出现的字段会被覆盖（`null` = 清除覆盖）：`baseURL`、`modelLabel`、`models`、`contextWindow`、`maxTokens`、`systemPrompt`；另有 `apiKey: "..."` 与 `clearApiKey: true`（写 DSH 凭据）。 |

完整地址形如 `http://127.0.0.1:19387/dsh-mnn-chat/probe`。响应都带 `codeVersion`
（当前 `2026-10-02.4`），用来确认 DSH 里跑的是哪一版代码：

```json
{
  "ok": true,
  "codeVersion": "2026-10-02.4",
  "provider": "mnn-chat",
  "displayName": "MNN-chat",
  "baseURL": "http://192.168.1.23:8080",
  "endpoint": "http://192.168.1.23:8080/v1/chat/completions",
  "configuredModels": ["ModelScope/MNN/Qwen3-0.6B-MNN"],
  "modelLabel": "prefixed",
  "labelSample": "mnn-chat/Qwen3-0.6B-MNN",
  "apiKey": "来自 MNN_CHAT_API_KEY",
  "modelsMs": 37,
  "serverModels": [{ "id": "ModelScope/MNN/Qwen3-0.6B-MNN", "label": "mnn-chat/Qwen3-0.6B-MNN", "configured": true }],
  "hint": "HTTP 服务正常。…"
}
```

`ok: false` 时会带 `error` 与 `code`，照着改即可。

## 一、手机端准备

1. 在手机上装 MNN Chat（MnnLlmChat），下载并**加载一个模型**。

2. 打开 App 里的 **API 服务 / 服务** 开关（不同版本叫法略有差异）。
   **把 App 留在前台或最近任务里**，否则服务会被系统挂起。

3. 记下 App 显示的地址，形如 `http://192.168.1.23:8080`。
   
   - 用 `http://<手机IP>:<端口>`，别用 `localhost`——除非做了端口转发：
     
     ```powershell
     adb forward tcp:8080 tcp:8080    # 之后 baseURL 用 http://127.0.0.1:8080 也行
     ```

4. 在电脑上确认能连通（自带自检工具，零依赖）：
   
   ```powershell
   cd D:\dsh\proj\dsh-mnn-chat
   node tools\probe.mjs http://192.168.1.23:8080 --key 你的API密钥
   ```
   
   ```
   解析后的地址：http://192.168.1.23:8080
   GET /v1/models → HTTP 200
   服务端模型：ModelScope/MNN/Qwen3-0.6B-MNN
   
   使用模型：ModelScope/MNN/Qwen3-0.6B-MNN
   POST /v1/chat/completions（stream）……
   
   您好！我是您的专属 AI 助手。……
   [DONE] 共 55 字，finish_reason=stop，总计 1964ms
   ```
   
   可选参数：`--prompt "..."` 换问题，`--model <id>` 跳过自动探测，`--key <密钥>`。
   这一步通了，插件里填同一个 `baseURL` 就一定能通。

> **注意**：MNN Chat 的 API 是**要鉴权的**，不带 `Authorization` 头会回 401。

## 二、装进 DSH

标准 DSH profile 插件包（`dsh.bundle.patch` → `cordis.patch.yml`）。本机已经装好：

- `profiles/desktop/package.json` 里有 `"dsh-mnn-chat": "link:D:/dsh/proj/dsh-mnn-chat"`；
- `bundles` 里有 `dsh-mnn-chat`；
- 配置写在 `profiles/desktop/cordis.patch.yml` 的 `- id: mnn-chat` 段。

别处安装：

```
# CLI
dsh plugin --profile desktop add link:D:/dsh/proj/dsh-mnn-chat

# 或：DSH 设置 → 插件 里安装本目录
```

## 三、当前配置

```yaml
- id: mnn-chat
  name: dsh-mnn-chat
  config:
    baseURL: http://192.168.1.23:8080   # 手机端地址
    displayName: MNN-chat                  # 选择器里的 provider 分组名（纯展示）
    apiKeyEnv: MNN_CHAT_API_KEY            # 密钥在 DSH 凭据里，此处不写明文
    models:                                # 只是离线兜底；服务端在提供的会自动出现
      - ModelScope/MNN/Qwen3-0.6B-MNN
    modelLabel: prefixed                   # 显示成 mnn-chat/Qwen3-0.6B-MNN（可省，默认就是它）
    contextWindow: 32768
    maxTokens: 2048
```

| 字段                    | 默认值                     | 说明                                                                                                                                                                                                                        |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseURL`             | `http://127.0.0.1:8080` | 手机端地址。`http://ip:8080`、`…/`、`…/v1` 三种写法都识别。                                                                                                                                                                               |
| `models`              | 必填（可只写一个）               | **离线兜底**名单。服务端此刻在提供的模型无需写在这里也会自动出现在选择器里；写在这里但服务端没提供的会标注出来。模型名是**协议字段**，必须与服务端报的一致。                                                                                                                                        |
| `provider`            | `mnn-chat`              | 路由名（provider id）。想在 DSH 里挂两台手机就再装一份、改个名。                                                                                                                                                                                  |
| `displayName`         | `MNN Chat`              | 选择器里显示的名字，纯展示。                                                                                                                                                                                                            |
| `apiKeyEnv`           | 无                       | 凭据名。**MNN Chat 要鉴权**，配上它（见下）。解析不到会明确报 `MISSING_CREDENTIAL`。                                                                                                                                                               |
| `apiKey`              | 无                       | 明文 Key，仅本地调试（会留在配置文件里）。                                                                                                                                                                                                   |
| `contextWindow`       | `32768`                 | 上报的上下文窗口。端侧模型通常 4K–32K，**别报大**，否则 DSH 压缩得晚、请求会被服务端截断。                                                                                                                                                                     |
| `maxTokens`           | `8192`                  | 单次回复上限。手机端建议 1024–4096。                                                                                                                                                                                                   |
| `timeoutMs`           | `120000`                | 单次请求总超时。                                                                                                                                                                                                                  |
| `streamIdleTimeoutMs` | `300000`                | 流空闲超时：这么久没有任何数据就中断，避免手机掉线后干等。                                                                                                                                                                                             |
| `includeUsage`        | `false`                 | 是否请求 `stream_options.include_usage`。**保持 `false`**（见下）。                                                                                                                                                                   |
| `pathStyle`           | `auto`                  | `auto` 先用 `/v1/chat/completions`，404 时回退 `/chat/completions`；也可强制 `openai` / `bare`。                                                                                                                                      |
| `headers`             | 无                       | 额外请求头。**别覆盖 `accept`**（见下）。                                                                                                                                                                                               |
| `extraBody`           | 无                       | 透传的额外请求体字段（如 `top_p`）。不覆盖插件已写的字段。                                                                                                                                                                                         |
| `retryPolicy`         | 见下                      | `{ mode, maxRetries, retryableCodes, initialDelayMs, maxDelayMs, jitterRatio }`；默认对 5xx/429/网络错误重试 3 次。                                                                                                                   |
| `catalogRefreshMs`    | `30000`                 | **模型目录自动拉取**的间隔（毫秒）：后台每隔这么久探一次手机端 `/v1/models`，列表变化就更新缓存并持久化成「最近已知列表」，选择器自动跟上手机换模型的动作。`0` = 关闭后台轮询（面板里仍可手动「立即刷新」）。                                                                                                        |
| `systemPrompt`        | 无                       | 本插件往系统提示词里插一段话（见「系统提示词改在哪」的方式 3）。不配就完全不插，也能在悬浮面板里直接改。                                                                                                                                                                     |
| `systemPromptOrder`   | `9100`                  | 那段话在系统提示词里的位置。DSH 的段落顺序见下节。                                                                                                                                                                                               |
| `modelLabel`          | `prefixed`              | 模型在选择器里的显示名，三档：`prefixed` = `${provider}/${id 末段}`（默认，`mnn-chat/Qwen3-0.6B-MNN`，前缀取**路由名**不是 `displayName`）、`tail` = 只留末段（`Qwen3-0.6B-MNN`）、`full` = 完整 id。**只影响显示，不改协议字段**（发给服务端的 `model` 永远是原 id）。尾段撞名时自动带上父段。悬浮面板上也能切。 |

### 系统提示词改在哪

系统提示词**不是这个插件生成的**，而是 `dsh-system-prompt` 在每个模型步骤前拼装出来的。
按「改动成本从低到高」有四种改法：

**方式 1：该会话的人设（最常用）**

改 `profiles/desktop/cordis.patch.yml` 里 `dsh-system-prompt` 那一行的 `personaPrefix` / `personaSuffix`：

```yaml
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    # 最前面（order 0），身份口径
    personaPrefix: 你是一个只在本机工作的编程助手。
    # 最后（order 10200），口径补充，会盖住前面的说法
    personaSuffix: 回答尽量简短，先给结论再给理由。工作目录是 {{cwd}}。
```

可用变量：`{{cwd}}`、`{{model}}`，以及插件注册的其它变量。改完保存即生效。

**方式 2：某个会话预设单独一套人设**

`dsh-persona` 按 preset 作用域覆盖 `deployment:persona-prefix/suffix`，只影响该预设起的会话：

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a terse systems engineer who answers in short commands.
    # complete: true  → 只用这段 prefix 当整个系统提示词，其它段落全部让位
    # includeRuntimeContext: false → 连运行时上下文快照也不给
```

**方式 3：给 MNN 这条路由加一段专属提示词（本插件）**

两种写法，效果完全一样，**面板更省事**：

- 悬浮面板 → 「系统提示词」编辑框 → 保存（立刻生效，落在 `$DSH_HOME/mnn-chat.panel.json`）；
- 或者写进配置：

```yaml
- id: mnn-chat
  name: dsh-mnn-chat
  config:
    # …前面的配置…
    systemPrompt: |
      你现在跑在手机端侧的 MNN 小模型上，能力有限：
      回答尽量短、不要长篇铺陈；一次只做一件事；不确定就说不知道。
    systemPromptOrder: 9100
```

它注册成名为 `provider:mnn-chat` 的独立 section，**不会**去动 DSH 自带的
`deployment:persona-prefix` / `deployment:persona-suffix`（同名重复注册会直接抛错）。
这段文字按**字面**处理、不做 `{{变量}}` 展开——因为未注册的变量在 `dsh-system-prompt` 里是
**抛异常**（不是留原文），用户随手写一对花括号就会让之后每一次模型调用都失败。要用变量请走方式 1。
DSH 的段落顺序：

```
-1000 harness 身份 → 0 persona 前缀 → 500–3100 各工具指引 → 5000 Tools SDK
→ 9000 交付物引用 → 【9100 本插件】 → 9900 结构化输出
→ 10000 harness source → 10100 Web surface → 10200 persona 后缀
```

> ⚠️ **「极简模式」下方式 3 的段落会被预设整体压掉**（这是 DSH 的设计，不是插件的 bug）：
> 极简模式预设的 persona 行带 `complete: true`，装配后**只剩那一段**，其它段落（含本插件的）
> 全部让位，而且**不报错**。所以本插件额外做了一层兜底：把同一段提示词**作为最后一条 system
> 消息直接挂到请求上**（与用哪个预设无关）。也就是说在极简模式下你的提示词**依然生效**，
> 只是位置固定在最后、不再受 `systemPromptOrder` 控制。想精确控制位置就用标准模式。
> 根因、DSH 源码行号、真机 A/B 验证见 [BUG.md 第 5 节](BUG.md)。

**方式 4：工作区指令文件（AGENTS.md）**

`profiles/desktop/cordis.patch.yml` 里把 `agent-instructions` 放开即可（当前是 `disabled: true`）：

```yaml
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  disabled: false
  config:
    maxBytes: 65536
```

它按 `$DSH_HOME/AGENTS.md` → 项目根（以 `.git` 为标记）→ 会话工作目录的顺序，
把每一层的 `AGENTS.md` / `CLAUDE.md`（外加 `AGENTS.local.md` / `CLAUDE.local.md`）
拼成一条 user 角色的 `<system-reminder>` 消息。注意它是**历史消息**而不是 system 段落，
权威性低于系统提示词，且受 `maxBytes` 限制。

> **别指望在这儿改工具说明**：每个工具的介绍文字由拥有该工具的插件自己注册
> （`TOOL_BASH`、`TOOL_READ` … 各有固定 order），没有面向用户的编辑入口。

### 哪个能改，哪个不能

| 东西                     | 能不能改     | 说明                                                                                                                          |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `displayName`          | **随便改**  | 纯展示文字，不参与协议。                                                                                                                |
| 模型在**选择器里显示的名字**       | **随便改**  | 纯显示层，三档：`prefixed`（默认，`mnn-chat/Qwen3-0.6B-MNN`）／`tail`（`Qwen3-0.6B-MNN`）／`full`（`ModelScope/MNN/Qwen3-0.6B-MNN`）。悬浮面板上也能切。 |
| `provider`             | **能改**   | DSH 内部路由名。改了要同步改 `agent-default-model` 的 `provider`；历史会话记录的是旧名字，会找不到适配器。                                                    |
| `models` 里的**模型名（id）** | **不能乱改** | DSH 每次请求把它当 `model` 字段发给服务端，服务端靠它挑模型。显示名能改，这个 id 改不了。                                                                       |

**加模型**：在手机 App 里加载那个模型即可，**什么都不用改**——插件会问服务端
`/v1/models`。想让它在手机掉线时也列出来，再写进 `models` 兜底。

> MNN Chat 一次只加载**一个**模型，所以服务端通常只报一个 ID。「同时多个可选」要在手机上换着加载；
> 配置里可以都写上，但只有服务端当前提供的能真正跑通，其余会标注「手机端此刻没有提供它」。

### 写密钥

密钥存在 DSH 凭据库里 —— `$DSH_HOME/.credentials.yaml` 的 `refs:` 段：

```yaml
refs:
  DEEPSEEK_API_KEY: sk-...
  MNN_CHAT_API_KEY: 你的API密钥      # ← 加这一行
```

该文件是**热监听**的（chokidar），保存即生效，不用重启。

## 四、让它成为默认模型

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: mnn-chat
    model: ModelScope/MNN/Qwen3-0.6B-MNN
```

## 五、出错怎么办

| 现象 / 失败码                 | 原因与处理                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 选择器里看不到 `ModelScope/MNN` | 改了 `lib/index.js` 却没重启 DSH（模块只在进程启动时读一次）；或上次启动时配置写错导致插件拒绝注册——看日志里 `[dsh-mnn-chat]` 那几行。                                                   |
| 输入框旁边没有 `● MNN` 按钮       | 同上：`dsh.client` 声明与浏览器 bundle 也是**进程启动时扫描并缓存**的，加完之后要完整重启一次 DSH。                                                                          |
| 面板显示「调不到宿主端点」            | 页面不是从 DSH 自己的 Web 地址打开的（换了协议或端口）。用 DSH 给的地址打开界面。                                                                                          |
| `TRANSPORT`「连不上 …」       | 手机没开 API 服务、不在同一网络、IP 变了，或 App 被系统挂起。先跑 `tools/probe.mjs`；探测自带重试，偶发抖动会自愈。手机短暂离线时选择器会显示「最近提供过」的模型列表，恢复后自动跟上。                               |
| `/v1/models` 返回 **406**  | 请求头问题：MNN 的 `/v1/models` 不接受 `Accept: text/event-stream`。插件已按用途分开，而且收到 406 会自动换通配 Accept 重试一次；若你自定义的 `headers` 覆盖了 `accept`，删掉。           |
| `AUTH`（401/403）          | 服务端要 Key：把 Key 写进 `.credentials.yaml` 的 `refs:` 并在配置里引用 `apiKeyEnv`。                                                                      |
| `MISSING_CREDENTIAL`     | 配了 `apiKeyEnv` 但凭据库里没有这个名字。补上即可（热生效）。                                                                                                     |
| `UNKNOWN_MODEL`          | 模型名两边都没有：配置的 `models` 没写，服务端的 `/v1/models` 也没报。打开 `/dsh-mnn-chat/models` 看可用 id。                                                          |
| `EMPTY_RESPONSE`         | 服务端正常结束但一个字都没输出：模型可能被卸载或显存不足。                                                                                                             |
| 请求发出去长期没反应、最后断开          | 多半是 `includeUsage: true` 触发了 MNN 的 `stream_options` 缺陷。保持 `false`。                                                                        |
| `STREAM_IDLE_TIMEOUT`    | 手机端长时间不吐字（模型太大/发热降频/掉线）。调大 `streamIdleTimeoutMs` 或换更小的模型。                                                                                 |
| `NOT_FOUND`「… 都不可用」      | 路径不对。试试 `baseURL` 填到 `/v1`，或用 `pathStyle: bare`。                                                                                          |
| 回复被截断 / 上下文相关报错          | `contextWindow` 报大了。改成端侧模型真实窗口。                                                                                                           |
| 模型不调用工具                  | 端侧小模型 function calling 能力有限。工具少一点、描述写清楚，或换更大模型。                                                                                           |
| **极简模式下你的提示词不生效**        | **已修**（`2026-10-02.4`）：极简模式预设的 persona 带 `complete: true`，会压掉所有段落。现在插件把同一段提示词作为最后一条 system 消息直接发给服务端，与预设无关。若仍不生效，说明进程跑的还是旧代码 —— 完整重启 DSH。 |

## 六、开发与自测

```powershell
cd D:\dsh\proj\dsh-mnn-chat
node --test test/adapter.test.mjs test/probe.test.mjs test/client.test.mjs   # 101 个用例，约 6 秒
node tools\live-check.mjs http://192.168.1.23:8080 --key 你的API密钥            # 真机联调（不用重启 DSH）
node tools\probe.mjs http://192.168.1.23:8080 --key 你的API密钥                 # 只测网络与一次对话
node tools\quick-matrix.mjs http://192.168.1.23:8080 你的API密钥                # 头部矩阵对照实验（带端口预探）
node tools\asar.mjs grep "listModels" "dsh-client-modules"                   # 在 App 包里搜官方实现
node tools\asar.mjs range "dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js" 1 40
node tools\dump-asar.mjs --out .asar-dump                                    # 或整包导出到磁盘
```

`tools/live-check.mjs` 值得单独说一句：它**不启动 DSH**，直接在本进程里 `apply()` 插件的 Host
半边，然后用插件**自己的端点**（`/probe`、`POST /probe {chat:true}`、`/state`、`/settings`）
去打真实手机。所以改了 `lib/index.js` 之后，跑它就能在重启 DSH 之前先确认真机是通的，
而且验的是插件真正那条链路（配置归一化 → 覆盖层 → 密钥解析 → SSE 解析）。
它把面板状态写在临时目录里，跑完就删，不碰你真实的 `$DSH_HOME`。

101 个用例覆盖：配置归一化、消息/工具线格式转换、SSE 分片与块收尾顺序、工具调用跨分片累积、
思维链、usage 统计、截断与空回复、HTTP 失败码映射与重试、路径回退、凭据解析、自动取消、
路由注册/卸载、Accept 头分工、406 换通配 Accept 自愈（对话/探测/连通性测试三处）、目录探测超时与缓存、
服务端动态提供的模型、模型显示名（带 provider 前缀 / 末段 / 完整 id / 撞名 / 前缀取路由名而不是 displayName）、
面板覆盖层（地址立刻生效、密钥只进凭据、
非法值被拒、坏字段只跳自己）、`chat: true` 的对话往返测试、系统提示词 section 的注册与卸载、
**提示词在 wire 上的尾部兜底**（极简模式回归：装配被 `complete: true` 压掉时仍送达、空提示词不追加、
重复文本不重复追加）、
**模型目录自动拉取**（后台刷新器 tick 语义、`catalogRefreshMs=0` 关闭、`/refresh` 强探并持久化、
手机换模型后选择器自动跟上、离线时显示最近已知列表、卸载后停止轮询），以及**浏览器半边**——
用迷你 React + 假 fetch 跑通「挂在哪些槽位、点一下发生什么、POST 出去的 body 对不对」，
含**点面板外面 / Esc 关闭**（面板内与开关按钮的 pointerdown 不算「外面」、关闭后摘掉监听器）。

`test/client.test.mjs` 不依赖浏览器：它把 `window.__ModuleLoader__`、`require('react')` 和
`fetch` 换成替身，直接驱动 `client.js` 里那三个 React 组件。所以「面板改提示词到底发了什么请求」
这类问题不用开浏览器就能验。

### 真机上踩到的 MNN 特性（已写进实现，源码定论见 BUG.md 第 3 节）

- **`/v1/models` 不接受 `Accept: text/event-stream`** —— 会回 406（空响应体）。所以探测与对话用两套头。
- **chat 端点对 Accept 完全不挑**（2026-10-02 实测四种组合全部 200）—— 服务端流式走 Ktor 的
  `SSEServerContent`（原始 OutgoingContent），根本不经过内容协商。插件对话请求的 Accept
  以 `application/json` 开头、事件流低权重跟后；任何端点收到 406 都会换通配 Accept 自愈重试一次。
- **服务端只用「当前加载的模型」**：请求体里的 `model` 字段被忽略，`/v1/models` 只报当前模型；
  没有模型时报 500。所以配置里的模型名只是兜底，真正出字的是手机 App 里加载的那个。
- **`stream_options: {include_usage: true}` 会让服务端挂死**（一直不返回，最后断开），
  因此 `includeUsage` 默认关闭。
- **服务随 App 前后台切换而起停**，表现为间歇性 `ECONNREFUSED`；所以探测带重试，
  目录查询带缓存（60 秒）与短超时（2 秒），绝不把模型选择器拖住；
  另有后台目录刷新 + lastKnown 持久化，手机短暂离线时选择器仍显示最近的模型列表。

### 实现上的坑（改代码前先看）

1. **不能 import 任何 `@deepseek-ai/*` 包。** DSH 的 profile 模块解析只把「profile 自己声明的
   依赖」交给插件，内置包对插件不可解析，import 会让插件加载直接失败。宿主半边只用鸭子类型
   对接 `ctx.llm`，只 import Node 内置模块；浏览器半边只能 `require('react')`（平台基线）。
2. **失败码要挂 `error.failure`。** DSH 只在 `error instanceof HarnessError` 时才认 `error.code`；
   跨包拿不到那个类，但它会读错误自身的 `failure` 数据属性。所以报错统一由 `fail()` 构造。
3. **每个请求都要带 `user-agent` 归因头**（`product/version (+url)`），这是 `llm` 服务的硬要求。
4. **只声明 `text` 模态。** DSH 会在 dispatch 前把历史里的图片投影成说明文本，适配器收不到 image block。
5. **块序列必须完整**：`block-start` → delta → `block-end`，最后才是 `usage?` + `finish`。
   DSH 的块索引是「块出现顺序」，与 OpenAI 的 `tool_calls[].index` 不是一回事。
6. **流被截断不能补假 `stop`**：那会让 DSH 把残缺回复当完整回复写进历史。宁可报 `TRANSPORT`。
7. **选择器显示的是 `LlmModelInfo.name`，派发用的是 `.id`。** 所以「去掉 id 前缀」只改 `name`，
   协议字段一个字都不用动（见 `dsh-client-ui-model-selection/lib/client.js`）。
8. **`PromptSection.text` 可以是函数**，每次组装重新求值 —— 面板里改提示词才能立刻生效。
   但必须同时给 `interpolate: false`：默认会做 `{{变量}}` 展开，而**未注册的变量是抛异常**，
   用户随手写一对花括号就能让之后每一次模型调用都失败。
9. **改 `lib/index.js` / `client.js` / `package.json` 后要完整重启 DSH。** `link:` 的模块被 Node 的
   ESM 模块图缓存，改配置只会重建插件实例、不会重新 import 文件；而 `dsh.client` 声明与
   bundle 图也是启动时扫描并缓存的。禁用再启用插件都不够，只有退出重开。
10. **插件的设置页入口不能挂 `settings.models.provider-card`。** 那张卡片只在「目录行 +
    已解析的设置命名空间」同时存在时才派发，而设置命名空间要求插件导出带 `toJSON` 的
    `Config` schema（`dsh-settings` 的 `schema(entry)` 读 `fiber.runtime.Config`）。本插件是
    无 schema 的纯 JS 插件，所以入口挂在无条件渲染的 `settings.models.footer` 上。
11. **别假设 `systemPrompt.section()` 一定送达模型。** 提示词装配的最终结果可以被**预设**
    整体替换：带 `complete: true` 的 persona 行会让 `assemble()` 返回 `sections: [那一段]`，
    其它段落（含插件的）**静默丢弃**。内置「极简模式」就是这样，所以插件必须自己在 wire 上
    补一条 system 消息（`withPersona`）。想在插件里看预设原文：
    `node tools\asar.mjs dump 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/minimal.patch.yml'`。
    细节见 [BUG.md 第 5 节](BUG.md)。

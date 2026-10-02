// ============================================================================
// dsh-mnn-chat —— 把 MNN Chat 的自定义 API 服务接进 DSH
// ----------------------------------------------------------------------------
// 背景：MNN Chat（alibaba/MNN 的 Android/iOS 端 App，MnnLlmChat）在手机上加载
// 本地大模型后，可以开启一个 HTTP 服务，对外暴露 OpenAI 兼容接口：
//
//     POST {baseURL}/v1/chat/completions      # SSE 流式
//     GET  {baseURL}/v1/models                # 模型列表
//
// 本插件把这个服务注册成 DSH 的一个 LLM provider（默认路由名 mnn-chat），
// 于是手机上跑的模型就能像 deepseek-official 一样在 DSH 里被选中对话。
//
// 实现要点（都是踩过的坑，改代码前先读）：
//
//  1. 不 import 任何 @deepseek-ai/* 包。DSH 的 profile 解析器只把「profile
//     自己声明的依赖」和安装目录里的包交给插件，内置包（@deepseek-ai/dsh-llm
//     等）对插件是不可解析的 —— import 会直接 ERR_MODULE_NOT_FOUND，插件加载
//     失败。所以这里只做鸭子类型：ctx.llm.registerAdapter() 只要求对象形状对，
//     LlmAdapter 基类本身没有 instanceof 检查。
//
//  2. 错误码要挂在 error.failure 上。DSH 的 normalizeLlmFailure 只在
//     `error instanceof HarnessError` 时才认 error.code，跨包拿不到那个类；
//     但它会读 error 自身的 `failure` 数据属性（own data property），并校验
//     { message, code, status?, providerRetryAfterMs?, requestId? }。所以
//     fail() 里两个都挂：failure 供 DSH 读取，code/message 供人看日志。
//
//  3. 每个请求都要带 user-agent（llm 服务的归因要求）。值按 harness 的
//     `product/version (+url)` 约定拼；拿不到版本号时用 DSH_CLIENT_VERSION。
//
//  4. 只声明 text 模态。DSH 的 LlmRuntime 会在 dispatch 前，把历史里的图片
//     投影成稳定的说明文本（projectImagesForTextModel），所以适配器永远收不到
//     image block，也就不需要实现图片上传。
//
//  5. stream() 必须产出完整块序列：block-start → 各类 delta → block-end →
//     usage? → finish。只发 delta 不发 block-start/block-end，assistant 消
//     息里会缺块，UI 与后续工具回灌都会出问题。
//
//  6. finish 只能出现一次，而且必须是最后一个 chunk。适配器抛出的异常由
//     LlmRuntime 兜底转成 error finish，所以正常路径下自己发的 finish 之后
//     不能再抛。
//
//  7. 模型选择器显示的是 LlmModelInfo.name，不是 .id（见 dsh-client-ui-model-
//     selection：派发用 model.id，显示用 model.name）。所以「去掉 id 前缀」只
//     需要改 name，协议字段 id 一个字都不用动。
//
//  8. PromptSection.text 可以是函数，每次组装都重新求值 —— 于是面板里改提示词
//     能立刻生效，不需要重建插件实例。必须同时给 interpolate: false：默认会做
//     {{变量}} 展开，而未知变量是**抛异常**（不是留原文），用户随手写一对花括号
//     就会让每次模型调用都失败。
// ============================================================================

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 插件名（Cordis 用它做日志与设置页的标识）。 */
export const name = 'dsh-mnn-chat'

/**
 * 依赖的 Host 服务。llm 是必需的（要注册适配器）；credentials 与 webServer
 * 是可选能力，用 ctx.get() 探测，缺了也不影响对话。
 */
export const inject = ['llm']

// ---------------------------------------------------------------------------
// 常量与默认值
// ---------------------------------------------------------------------------

/** 本文件的内部版本号：诊断端点会回显它，用来确认 DSH 里跑的是哪一版代码。 */
const CODE_VERSION = '2026-10-02.4'

/** 归因头。harness 约定：`product/version (+url)`；省略等于不归因，不可接受。 */
const APP_PRODUCT = 'deepseek-harness'
const APP_URL = 'https://github.com/deepseek-ai/deepseek-harness'
const APP_VERSION = (() => {
  const env = globalThis.process?.env ?? {}
  for (const key of ['DSH_CLIENT_VERSION', 'DSH_VERSION', 'npm_package_version']) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return 'unknown'
})()

/** 默认路由名：以 config.provider 覆盖，用来在同一次组装里挂多条 MNN 服务。 */
const DEFAULT_PROVIDER = 'mnn-chat'

/** MNN Chat 默认服务地址。App 内开启 API 服务后显示的通常是 http://<手机IP>:8080。 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8080'

/**
 * 模型在选择器里的显示名策略：
 *  - 'prefixed'（默认）：`<provider>/<末段>`，`ModelScope/MNN/Qwen3-0.6B-MNN`
 *    显示成 `mnn-chat/Qwen3-0.6B-MNN` —— 手机端上报的 id 前缀五花八门
 *    （`ModelScope/MNN/…`），统一成我们自己的路由名，一眼看得出这条路由是谁在服务。
 *  - 'tail'：只显示末段，`Qwen3-0.6B-MNN`。
 *  - 'full'：原样显示整个 id。
 * id 本身（协议字段、会话记录、请求体）永远不变。
 * 尾段撞名时（A/Qwen 与 B/Qwen 同时存在）自动退化成「父段/尾段」，避免两个
 * 一模一样、根本分不清的选项。
 */
const DEFAULT_MODEL_LABEL = 'prefixed'
/** 合法取值。`tail` 与 `full` 是旧配置写法，留着继续认。 */
const MODEL_LABELS = ['prefixed', 'tail', 'full']

/**
 * `/v1/models` 探测在「模型目录」路径上的超时。
 * 模型选择器会调 listModels()，而手机端可能根本没开服务或正在忙 —— 探测必须
 * 短、可失败、有缓存，否则选择器会被一个不可达的地址拖住（表现为「provider
 * 里看不到 MNN」）。
 */
const CATALOG_PROBE_TIMEOUT_MS = 2000
/** 探测结果缓存时长：选择器一次会话里会反复问，没必要每次都打手机。 */
const CATALOG_CACHE_TTL_MS = 60000

/**
 * Accept 头三件套（2026-10-01 对真机跑完头部矩阵后的定论，见 BUG.md）：
 *  - `/v1/models` 收到 `Accept: text/event-stream` 会回 406（稳定复现），必须用 JSON 版；
 *  - `/v1/chat/completions` 对 Accept 完全不挑（四种组合实测全部 200，SSE 照常流出），
 *    所以对话请求把 `application/json` 放在最前，既照顾真机端各种古怪构建，也是
 *    标准 OpenAI 兼容服务最普遍接受的写法；`text/event-stream` 带低权重跟在后面。
 *  - 收到 406 时自愈：换通配 Accept（ACCEPT_ANY）重试一次（见 _probeModels / _stream / chatProbe）。
 */
const ACCEPT_JSON = 'application/json'
const ACCEPT_STREAM = 'application/json, text/event-stream;q=0.9'
const ACCEPT_ANY = '*/*'

/**
 * 后台刷新模型目录的节奏（毫秒）。插件会按这个间隔探一次手机的 /v1/models，
 * 把「手机此刻在提供的模型 id」拉下来更新缓存并持久化成「最近已知列表」——
 * 手机上换了模型，DSH 的选择器不用等用户打开面板就能跟上。0 表示关闭。
 */
const DEFAULT_CATALOG_REFRESH_MS = 30000
/** 后台/手动刷新一次目录允许的探测耗时。 */
const CATALOG_REFRESH_PROBE_TIMEOUT_MS = 8000
/** lastKnownModels 最多记多少个 id（手机端理论上一次只报一个，64 已经是天文数字）。 */
const LAST_KNOWN_MODELS_LIMIT = 64

const DEFAULT_CONTEXT_WINDOW = 32768
const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_TIMEOUT_MS = 120000
/** 流空闲看门狗：这么久没有任何字节过来就判失败，避免手机端掉线后挂死。 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000
const DEFAULT_MAX_RETRIES = 3
const INITIAL_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 8000

/** 本插件自己产生的稳定失败码（会被 DSH 当作 provider 失败分类的依据）。 */
const CODES = {
  transport: 'TRANSPORT',
  aborted: 'ABORTED',
  auth: 'AUTH',
  rateLimit: 'RATE_LIMIT',
  server: 'SERVER',
  badRequest: 'INVALID_REQUEST',
  notFound: 'NOT_FOUND',
  invalidResponse: 'INVALID_RESPONSE',
  emptyResponse: 'EMPTY_RESPONSE',
  missingCredential: 'MISSING_CREDENTIAL',
  contextOverflow: 'CONTEXT_WINDOW_EXCEEDED',
  unknownModel: 'UNKNOWN_MODEL',
  invalidConfig: 'INVALID_CONFIG',
}

/** 默认重试策略：与 DSH 其它 provider 保持一致的形状。 */
const DEFAULT_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: DEFAULT_MAX_RETRIES,
  retryableCodes: ['TRANSPORT', 'SERVER', 'RATE_LIMIT', 'STREAM_IDLE_TIMEOUT'],
  initialDelayMs: INITIAL_BACKOFF_MS,
  maxDelayMs: MAX_BACKOFF_MS,
  jitterRatio: 0.2,
})

// ---------------------------------------------------------------------------
// 失败构造
// ---------------------------------------------------------------------------

/**
 * 构造一个带 DSH 可识别 failure 快照的错误。
 * @param {string} message 人类可读的失败说明（会显示在会话与日志里）。
 * @param {string} code 稳定失败码。
 * @param {{status?: number, providerRetryAfterMs?: number, requestId?: string, cause?: unknown}} [options]
 * @returns {Error} 可直接 throw 的错误；其 failure 属性是 DSH 的 LlmFailure 形状。
 */
function fail(message, code, options = {}) {
  const error = new Error(message, options.cause === undefined ? undefined : { cause: options.cause })
  error.name = 'MnnChatError'
  error.code = code
  const failure = { message, code }
  if (Number.isInteger(options.status) && options.status >= 100 && options.status <= 599) {
    failure.status = options.status
  }
  if (Number.isFinite(options.providerRetryAfterMs) && options.providerRetryAfterMs > 0) {
    failure.providerRetryAfterMs = options.providerRetryAfterMs
  }
  if (typeof options.requestId === 'string' && options.requestId.length > 0) {
    failure.requestId = options.requestId
  }
  // 必须写成 own data property：DSH 用 getOwnPropertyDescriptor 读，不走原型链。
  Object.defineProperty(error, 'failure', { value: Object.freeze(failure), enumerable: true, writable: false, configurable: true })
  return error
}

/** 把 HTTP 状态码翻成稳定失败码。 */
function codeForStatus(status) {
  if (status === 401 || status === 403) return CODES.auth
  if (status === 404) return CODES.notFound
  if (status === 408 || status === 429) return CODES.rateLimit
  if (status >= 500) return CODES.server
  if (status >= 400) return CODES.badRequest
  return CODES.invalidResponse
}

/** 从 Retry-After 头解析毫秒数（只认秒数形式，HTTP-date 交给上层默认退避）。 */
function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after')
  if (typeof raw !== 'string') return undefined
  const seconds = Number(raw.trim())
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
}

/**
 * 从错误响应体里抠出可读的 detail（OpenAI 风格 {error:{message}} 优先）。
 * 绝不抛异常：解析失败就返回空串。
 */
async function readErrorDetail(response) {
  try {
    const text = (await response.text()).slice(0, 4096)
    if (text.length === 0) return { detail: '', requestId: undefined }
    let requestId
    try {
      const parsed = JSON.parse(text)
      const error = parsed?.error
      const message = typeof error?.message === 'string' ? error.message : typeof parsed?.message === 'string' ? parsed.message : undefined
      const type = typeof error?.type === 'string' ? error.type : typeof error?.code === 'string' ? error.code : undefined
      if (typeof parsed?.id === 'string') requestId = parsed.id
      if (typeof message === 'string') return { detail: type === undefined ? message : `${type}: ${message}`, requestId }
    } catch {
      // 非 JSON：原样当文本用。
    }
    return { detail: text.trim(), requestId }
  } catch {
    return { detail: '', requestId: undefined }
  }
}

// ---------------------------------------------------------------------------
// 配置解析
// ---------------------------------------------------------------------------

/** 把 yaml 里可能写成字符串或数组的字段统一成去空字符串数组。 */
function toStringList(value, label) {
  if (value === undefined || value === null) return []
  const items = Array.isArray(value) ? value : String(value).split(',')
  return items
    .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
    .filter((item) => item.length > 0 && !label.ignored?.includes(item))
}

function positiveNumber(value, label, fallback) {
  if (value === undefined || value === null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw fail(`dsh-mnn-chat: ${label} 必须是正数，收到 ${JSON.stringify(value)}`, CODES.invalidConfig)
  }
  return parsed
}

function positiveInteger(value, label, fallback) {
  const parsed = positiveNumber(value, label, fallback)
  if (!Number.isSafeInteger(parsed)) {
    throw fail(`dsh-mnn-chat: ${label} 必须是正整数，收到 ${JSON.stringify(value)}`, CODES.invalidConfig)
  }
  return parsed
}

/** 允许 0 的整数（重试次数这类「0 表示不重试」的字段必须接受它）。 */
function nonNegativeInteger(value, label, fallback) {
  if (value === undefined || value === null) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw fail(`dsh-mnn-chat: ${label} 必须是不小于 0 的整数，收到 ${JSON.stringify(value)}`, CODES.invalidConfig)
  }
  return parsed
}

/**
 * 归一化 baseURL。
 * 用户可能填 http://ip:8080、http://ip:8080/、http://ip:8080/v1 三种写法，
 * 统一去掉尾斜杠与结尾的 /v1，之后由 endpointFor() 决定最终路径。
 */
function normalizeBaseURL(raw) {
  const value = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : DEFAULT_BASE_URL
  let parsed
  try {
    parsed = new URL(value)
  } catch (error) {
    throw fail(`dsh-mnn-chat: baseURL "${value}" 不是合法 URL（例如 http://192.168.1.23:8080）`, CODES.invalidConfig, { cause: error })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw fail(`dsh-mnn-chat: baseURL 只支持 http/https，收到 ${parsed.protocol}`, CODES.invalidConfig)
  }
  if (parsed.username || parsed.password) {
    throw fail('dsh-mnn-chat: baseURL 不能带用户名/密码，请把密钥写进 apiKeyEnv', CODES.invalidConfig)
  }
  if (parsed.search || parsed.hash) {
    throw fail('dsh-mnn-chat: baseURL 不能带查询串或片段', CODES.invalidConfig)
  }
  let pathname = parsed.pathname.replace(/\/+$/u, '')
  if (pathname.endsWith('/v1')) pathname = pathname.slice(0, -3)
  return `${parsed.origin}${pathname}`
}

/**
 * 解析一份插件 Config（或设置页快照）成适配器运行期配置。
 * 每次操作前调用一次，于是改 cordis.yml 后下一次对话就生效，不用重启。
 * @param {Record<string, unknown>} raw 原始 Config。
 * @returns 归一化后的配置对象。
 */
export function resolveConfig(raw = {}) {
  const provider = typeof raw.provider === 'string' && raw.provider.trim().length > 0 ? raw.provider.trim() : DEFAULT_PROVIDER
  const baseURL = normalizeBaseURL(raw.baseURL)
  const models = toStringList(raw.models, {})
  if (models.length === 0) {
    throw fail('dsh-mnn-chat: 至少要配置一个模型名，例如 models: [Qwen3-4B]', CODES.invalidConfig)
  }
  const apiKeyEnv = typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim().length > 0 ? raw.apiKeyEnv.trim() : undefined
  const retryPolicy = resolveRetryPolicy(raw.retryPolicy)
  return {
    provider,
    baseURL,
    models,
    apiKeyEnv,
    apiKey: typeof raw.apiKey === 'string' && raw.apiKey.trim().length > 0 ? raw.apiKey.trim() : undefined,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim().length > 0 ? raw.displayName.trim() : 'MNN Chat',
    contextWindow: positiveInteger(raw.contextWindow, 'contextWindow', DEFAULT_CONTEXT_WINDOW),
    maxTokens: positiveInteger(raw.maxTokens, 'maxTokens', DEFAULT_MAX_TOKENS),
    timeoutMs: positiveNumber(raw.timeoutMs, 'timeoutMs', DEFAULT_TIMEOUT_MS),
    streamIdleTimeoutMs: positiveNumber(raw.streamIdleTimeoutMs, 'streamIdleTimeoutMs', DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    includeUsage: raw.includeUsage === true,
    sendReasoning: raw.sendReasoning === true,
    extraBody: raw.extraBody !== null && typeof raw.extraBody === 'object' && !Array.isArray(raw.extraBody) ? raw.extraBody : undefined,
    headers: normalizeHeaders(raw.headers),
    pathStyle: raw.pathStyle === 'openai' || raw.pathStyle === 'bare' || raw.pathStyle === 'auto' ? raw.pathStyle : 'auto',
    retryPolicy,
    catalogRefreshMs: nonNegativeInteger(raw.catalogRefreshMs, 'catalogRefreshMs', DEFAULT_CATALOG_REFRESH_MS),
    systemPrompt: typeof raw.systemPrompt === 'string' && raw.systemPrompt.trim().length > 0 ? raw.systemPrompt : undefined,
    systemPromptOrder: finiteNumber(raw.systemPromptOrder, 'systemPromptOrder', DEFAULT_PROMPT_ORDER),
    modelLabel: MODEL_LABELS.includes(raw.modelLabel) ? raw.modelLabel : DEFAULT_MODEL_LABEL,
  }
}

// ---------------------------------------------------------------------------
// 模型显示名
// ---------------------------------------------------------------------------

/** id 的最后一段；没有 `/` 或尾段为空时退回整个 id。 */
function tailOf(id) {
  const cut = id.lastIndexOf('/')
  if (cut === -1 || cut === id.length - 1) return id
  return id.slice(cut + 1)
}

/** id 的最后两段，用来区分尾段撞名的两个模型。 */
function parentAndTailOf(id) {
  const cut = id.lastIndexOf('/')
  if (cut === -1) return id
  const before = id.lastIndexOf('/', cut - 1)
  return id.slice(before + 1)
}

/**
 * 单个模型的显示名（resolveModel / prepareCall 用）。
 *
 * 三档，都**只影响显示**，发给服务端的 `model` 字段永远是原 id：
 *   - `prefixed`（默认）：`<displayName>/<末段>`，如 `MNN-chat/Qwen3-0.6B-MNN`
 *   - `tail`：只留末段，如 `Qwen3-0.6B-MNN`
 *   - `full`：原样 id，如 `ModelScope/MNN/Qwen3-0.6B-MNN`
 *
 * 前缀用的是 `config.provider`（DSH 的路由名，通常就是 `mnn-chat`），
 * **不是** `displayName` —— displayName 是给人看的、可以带空格和中文，
 * 拿它当初缀容易被用户的显示名带偏（比如 displayName 改成「我的手机」）。
 * @param {object} config 已解析配置。
 * @param {string} id 模型 id（协议字段，不改）。
 */
export function modelLabelOf(config, id) {
  if (config.modelLabel === 'full') return id
  if (config.modelLabel === 'tail') return tailOf(id)
  return `${config.provider}/${tailOf(id)}`
}

/**
 * 整份目录的显示名表。
 * 尾段撞名的那几个自动带上父段（`a/x` 与 `b/x` → `a/x` / `b/x`），
 * 免得选择器里出现两个一模一样的名字。
 * @param {object} config 已解析配置。
 * @param {readonly string[]} ids 目录里的全部 id。
 * @returns {Map<string, string>} id → 显示名。
 */
function labelTable(config, ids) {
  const labels = new Map()
  if (config.modelLabel === 'full') {
    for (const id of ids) labels.set(id, id)
    return labels
  }
  const counts = new Map()
  for (const id of ids) {
    const tail = tailOf(id)
    counts.set(tail, (counts.get(tail) ?? 0) + 1)
  }
  for (const id of ids) {
    if (counts.get(tailOf(id)) > 1) {
      labels.set(id, config.modelLabel === 'tail' ? parentAndTailOf(id) : `${config.provider}/${parentAndTailOf(id)}`)
      continue
    }
    labels.set(id, modelLabelOf(config, id))
  }
  return labels
}

/** 允许任意有限数（提示词 section 的 order 就是有限数，不要求为正）。 */
function finiteNumber(value, label, fallback) {
  if (value === undefined || value === null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw fail(`dsh-mnn-chat: ${label} 必须是有限数字，收到 ${JSON.stringify(value)}`, CODES.invalidConfig)
  }
  return parsed
}

/** 只允许可放进 Header 的字符串键值，避免把非字符串塞进 fetch headers。 */
function normalizeHeaders(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entries = Object.entries(raw).filter(([key, value]) => key.length > 0 && (typeof value === 'string' || typeof value === 'number'))
  return entries.length === 0 ? undefined : Object.fromEntries(entries.map(([key, value]) => [key, String(value)]))
}

/** 本插件注册的系统提示词 section 名（唯一，避免与 DSH 自带的 persona section 撞名）。 */
const SECTION_NAME = 'provider:mnn-chat'
/**
 * 默认插入位置。
 * DSH 的 section 顺序（取自 dsh-system-prompt 的 SECTION_ORDERS）：
 *   persona 前缀 0 → 工具指引 1000–3100 → Tools SDK 5000 →
 *   交付物引用 9000 → 【本插件 9100】→ 结构化输出 9900 →
 *   harness source 10000 → Web surface 10100 → persona 后缀 10200。
 * 放在 9100 是为了落在第一方段落之间的空档里：既不动前面可复用的 KV 前缀，
 * 又能被 persona 后缀（全局口径）盖住。想换位置就配 systemPromptOrder。
 */
const DEFAULT_PROMPT_ORDER = 9100

/**
 * 面板写下的覆盖值（提示词、模型显示名）落在这个文件里。
 * 落文件而不是写回 profile 的 cordis.patch.yml，有两个原因：
 *  1. 改配置会触发 Loader 重建本插件实例（适配器注册会短暂消失），而面板里
 *     存个提示词不该影响正在进行的对话；提示词 section 的 text 本来就是按次
 *     求值的函数，改内存值即刻生效。
 *  2. 不碰用户的 YAML，避免和手写配置互相覆盖。
 * 位置：$DSH_HOME/mnn-chat.panel.json（DSH_HOME 缺失时退回 ~/.dsh）。
 */
const PANEL_STATE_FILE = 'mnn-chat.panel.json'
/** 面板 POST body 的上限：地址、提示词都是给人写的，64 KiB 已经绰绰有余。 */
const PANEL_BODY_LIMIT_BYTES = 64 * 1024
/**
 * 面板里第一次保存密钥时用的凭据名。
 * 配置里没写 apiKeyEnv 时，光存密钥是没用的（适配器不会带 Authorization 头），
 * 所以保存密钥的同时把 apiKeyEnv 也写进面板覆盖。
 */
const DEFAULT_API_KEY_ENV = 'MNN_CHAT_API_KEY'

/** 归一化重试策略；缺省用本插件的默认值。maxRetries 允许为 0（一次都不重试）。 */
function resolveRetryPolicy(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_RETRY_POLICY
  const mode = raw.mode === 'always' ? 'always' : 'normal'
  const maxRetries = nonNegativeInteger(raw.maxRetries, 'retryPolicy.maxRetries', DEFAULT_MAX_RETRIES)
  const initialDelayMs = positiveNumber(raw.initialDelayMs, 'retryPolicy.initialDelayMs', INITIAL_BACKOFF_MS)
  const maxDelayMs = positiveNumber(raw.maxDelayMs, 'retryPolicy.maxDelayMs', MAX_BACKOFF_MS)
  const jitterRatio = raw.jitterRatio === undefined ? DEFAULT_RETRY_POLICY.jitterRatio : Math.min(Math.max(Number(raw.jitterRatio) || 0, 0), 1)
  const retryableCodes = toStringList(raw.retryableCodes ?? DEFAULT_RETRY_POLICY.retryableCodes, {})
  if (mode === 'always') return { mode, initialDelayMs, maxDelayMs, jitterRatio }
  return { mode, maxRetries, retryableCodes: retryableCodes.length > 0 ? retryableCodes : DEFAULT_RETRY_POLICY.retryableCodes, initialDelayMs, maxDelayMs, jitterRatio }
}

// ---------------------------------------------------------------------------
// URL / 鉴权
// ---------------------------------------------------------------------------

/** 默认的 OpenAI 兼容路径。 */
const OPENAI_PATH = '/v1/chat/completions'
/** MNN 早期/精简服务的裸路径；404 时会自动回退到它。 */
const BARE_PATH = '/chat/completions'

/** 按 pathStyle 决定主用路径与回退路径。 */
function pathCandidates(style) {
  if (style === 'openai') return [OPENAI_PATH]
  if (style === 'bare') return [BARE_PATH]
  return [OPENAI_PATH, BARE_PATH]
}

/** 拼出完整请求 URL。 */
function endpointFor(baseURL, path) {
  return `${baseURL}${path}`
}

/**
 * 解析这一请求要用的 API Key。
 * 顺序：config.apiKey（明文，仅本地调试用）→ 凭据服务里的 apiKeyEnv → 同名环境变量。
 * 都没有时返回 undefined —— 对本地 MNN 服务是正常情况，不带 Authorization 头即可。
 * @returns {Promise<string|undefined>} 可放进 Authorization 头的值。
 */
async function resolveApiKey(ctx, config, signal) {
  if (config.apiKey !== undefined) return checkHeaderSafe(config.apiKey, 'apiKey')
  if (config.apiKeyEnv === undefined) return undefined
  const credentials = ctx.get?.('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(config.apiKeyEnv)
      const value = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
      if (value.length > 0) return checkHeaderSafe(value, config.apiKeyEnv)
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
      throw fail(`dsh-mnn-chat: 读取凭据 ${config.apiKeyEnv} 失败：${error?.message ?? error}`, CODES.transport, { cause: error })
    }
  }
  const fromEnv = globalThis.process?.env?.[config.apiKeyEnv]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return checkHeaderSafe(fromEnv.trim(), config.apiKeyEnv)
  throw fail(
    `dsh-mnn-chat: 配置了 apiKeyEnv: ${config.apiKeyEnv}，但凭据服务与环境变量里都没有它。` +
      `要么在设置页写入这个凭据，要么删掉 apiKeyEnv（本地 MNN 服务通常不需要 Key）。`,
    CODES.missingCredential,
  )
}

/** HTTP 头只能带可见 ASCII；不合法的 Key 在这里就报错，别等 fetch 抛晦涩异常。 */
function checkHeaderSafe(value, label) {
  if (!/^[\x21-\x7E]+$/u.test(value)) {
    throw fail(`dsh-mnn-chat: ${label} 含 HTTP 头无法承载的字符（只允许可见 ASCII，且不能有空格）`, CODES.missingCredential)
  }
  return value
}

// ---------------------------------------------------------------------------
// 请求体构造：DSH 消息词表 → OpenAI Chat Completions
// ---------------------------------------------------------------------------

/** 取文本块拼接结果（DSH 的 content 是块数组）。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** 工具调用块 → OpenAI 的 tool_calls 条目。 */
function toolCallOf(block) {
  return {
    id: typeof block.id === 'string' && block.id.length > 0 ? block.id : `call_${Math.random().toString(36).slice(2, 10)}`,
    type: 'function',
    function: { name: String(block.name ?? ''), arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}) },
  }
}

/**
 * 把 DSH 的请求消息转成 OpenAI Chat Completions 的 messages。
 * 跳过 tool-removal / tool-addition 这类只在历史里表示工具集变化的块。
 * @param {Record<string, unknown>} options DSH 的 GenerateOptions。
 * @param {string} [persona] 本插件自己的提示词；见 {@link withPersona}。
 * @returns {Array<Record<string, unknown>>} 线格式消息数组。
 */
export function toWireMessages(options, persona) {
  const messages = []
  const system = typeof options.system === 'string' && options.system.trim().length > 0 ? options.system : undefined
  let systemConsumed = false
  for (const message of Array.isArray(options.messages) ? options.messages : []) {
    if (message === null || typeof message !== 'object') continue
    const content = Array.isArray(message.content) ? message.content : []
    if (message.role === 'system' || message.role === 'developer') {
      // 只把第一条系统消息当 system；其余按 OpenAI 习惯降级为 user，避免丢信息。
      const text = textOf(content)
      if (text.length === 0) continue
      if (message.role === 'system' && !systemConsumed) {
        messages.push({ role: 'system', content: text })
        systemConsumed = true
      } else if (message.role === 'developer') {
        messages.push({ role: 'system', content: text })
      } else {
        messages.push({ role: 'user', content: text })
      }
      continue
    }
    if (message.role === 'user') {
      const text = textOf(content)
      if (text.length > 0) messages.push({ role: 'user', content: text })
      continue
    }
    if (message.role === 'assistant') {
      const text = textOf(content)
      const toolCalls = content.filter((block) => block?.type === 'tool-call').map(toolCallOf)
      if (text.length === 0 && toolCalls.length === 0) continue
      const entry = { role: 'assistant', content: text }
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      messages.push(entry)
      continue
    }
    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: typeof message.toolCallId === 'string' && message.toolCallId.length > 0 ? message.toolCallId : 'call_unknown',
        content: textOf(content),
      })
      continue
    }
  }
  // system 单独给的时候放最前面（与 DSH 的 GenerateOptions.system 语义一致）。
  if (system !== undefined) messages.unshift({ role: 'system', content: system })
  return withPersona(messages, persona)
}

/**
 * 把本插件自己的提示词作为**最后一条** system 消息挂上去。
 *
 * 为什么不只靠 `systemPrompt.section(...)`：section 只往 DSH 的提示词装配里
 * 加一段，而装配结果可以被预设整体压掉。内置的「极简模式」预设就是这样
 * （`@deepseek-ai/dsh-web-app/presets/minimal.patch.yml`）：
 *
 *   - id: persona
 *     name: '@deepseek-ai/dsh-persona'
 *     config: { prefix: 'You are a helpful software engineer assistant.', complete: true, includeRuntimeContext: false }
 *
 * `complete: true` 的语义是「装配后，这确切一段成为唯一段落」（见
 * dsh-system-prompt 的 assemble()：`sections: [completeSection]`），
 * 文档也写明了「身份、后缀、工具引导或监听器都无法追加提示词文本」。
 * 于是极简模式下模型看到的系统提示词只有那句英文，用户在插件里写的提示词
 * 一个字都到不了；而标准模式的 persona 没有 complete:true，所以一切正常。
 *
 * 插件没法改预设（预设是 profile 组合里的行，属于用户配置树），
 * 但**这一段可以在装配之外自己补**：适配器拿到的 options.system 就是装配的
 * 成品，我们在 wire 上再挂一条 system 消息即可，与用哪个预设无关。
 *
 * 放最后而不是插到最前面：装配结果（含工具引导）整体保留在最前，便于
 * KV-cache 复用；自己的提示词落在最后，在同一位置压过前面所有系统文本 ——
 * 小模型对「最后读到的指令」最敏感，极简模式下那句固定人设也就压得住。
 * 内容与 options.system 相同时不重复追加（例如用户把同一段文本同时写进
 * 配置和面板时的极端情况）。
 * @param {Array<Record<string, unknown>>} messages 线格式消息数组。
 * @param {string} [persona] 本插件提示词。
 * @returns {Array<Record<string, unknown>>} 同一个数组（就地追加）。
 */
export function withPersona(messages, persona) {
  const text = typeof persona === 'string' ? persona.trim() : ''
  if (text.length === 0) return messages
  if (messages.some((message) => message.role === 'system' && message.content === text)) return messages
  messages.push({ role: 'system', content: text })
  return messages
}

/** 工具 schema → OpenAI tools 数组。 */
function toWireTools(tools) {
  if (!Array.isArray(tools)) return undefined
  const wire = tools
    .filter((tool) => tool !== null && typeof tool === 'object' && typeof tool.name === 'string' && tool.name.length > 0)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters !== null && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
      },
    }))
  return wire.length > 0 ? wire : undefined
}

/**
 * 构造一次请求的 JSON body。
 * 只放服务端一定认识的字段：MNN 的解析器对未知字段的容忍度不如 OpenAI 官方。
 */
export function toWireBody(config, options) {
  const body = {
    model: options.model,
    messages: toWireMessages(options, config.systemPrompt),
    stream: true,
  }
  if (Number.isFinite(options.temperature)) body.temperature = options.temperature
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : config.maxTokens
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = Math.trunc(maxTokens)
  const tools = toWireTools(options.tools)
  if (tools !== undefined) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  // 注意：MNN Chat 的服务端遇到 stream_options 会一直不返回、最后断开连接，
  // 所以只有用户显式打开 includeUsage 时才发（默认关）。
  if (config.includeUsage) body.stream_options = { include_usage: true }
  for (const [key, value] of Object.entries(config.extraBody ?? {})) {
    if (key in body) continue
    body[key] = value
  }
  return body
}

// ---------------------------------------------------------------------------
// SSE 解析
// ---------------------------------------------------------------------------

/**
 * 逐行解析 SSE 的 data 负载。
 * MNN 会按标准 SSE 分帧；这里对 `data:` 后有无空格、CRLF、注释行都做兼容。
 * @param {ReadableStream<Uint8Array>} body fetch 响应体。
 * @param {AbortSignal} signal 取消信号。
 * @yields {string} 每个 data 负载的原始字符串（含 `[DONE]`）。
 */
async function* sseData(body, signal) {
  const decoder = new TextDecoder('utf-8')
  const reader = body.getReader()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw abortError(signal)
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 事件以空行结束；兼容 \n\n 与 \r\n\r\n。
      let boundary = findBoundary(buffer)
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        const payload = eventData(rawEvent)
        if (payload !== undefined) yield payload
        boundary = findBoundary(buffer)
      }
    }
    buffer += decoder.decode()
    const tail = eventData(buffer)
    if (tail !== undefined) yield tail
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 取消失败无关紧要：连接由 abort 或对端关闭回收。
    }
  }
}

/** 找下一个事件边界的下标与长度。 */
function findBoundary(buffer) {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return -1
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

/** 从一段原始事件里取出 data 负载（多行 data 按 SSE 规则用 \n 连接）。 */
function eventData(rawEvent) {
  const lines = rawEvent.split(/\r?\n/u)
  const dataLines = []
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    const value = line.slice(5)
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
  }
  return dataLines.length === 0 ? undefined : dataLines.join('\n')
}

/**
 * 取消时用的错误。
 * 即便原因是宿主传进来的 AbortError，也重新包一层 —— 这样 error.failure 一定
 * 是完整的 LlmFailure，不依赖 DSH 的 normalizeLlmFailure 去猜。
 */
function abortError(signal) {
  const reason = signal?.reason
  if (reason !== undefined && reason?.name === 'MnnChatError') return reason
  return fail('dsh-mnn-chat: 请求已取消', CODES.aborted, reason instanceof Error ? { cause: reason } : {})
}

// ---------------------------------------------------------------------------
// 空闲看门狗
// ---------------------------------------------------------------------------

/**
 * 只要还有数据在流，就不断重置的定时器；超时后 abort，避免手机端假死后挂住。
 * @returns {() => void} 停止看门狗。
 */
function startIdleWatchdog(controller, idleMs, onTimeout) {
  let timer
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(onTimeout, idleMs)
    if (typeof timer?.unref === 'function') timer.unref()
  }
  arm()
  return {
    reset: arm,
    stop: () => clearTimeout(timer),
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    // 这个定时器必须保持 ref：每个调用方都在 await 它（重试退避、目录探测间隔）。
    // 一旦 unref，事件循环里没有其它句柄时 await 链会被直接抽干（node:test 里实测）。
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** 按重试策略退避等待；由 dsh-llm-retry 决定是否重试，这里只负责一次请求内的传输重试。 */
function backoffDelay(policy, attempt) {
  const base = Math.min(policy.initialDelayMs * 2 ** attempt, policy.maxDelayMs)
  const jitter = base * (Number.isFinite(policy.jitterRatio) ? policy.jitterRatio : 0) * (Math.random() * 2 - 1)
  return Math.max(1, Math.round(base + jitter))
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

/** 块类型常量（与 DSH 的 ContentBlockType 对应）。 */
const BLOCK_TEXT = 'text'
const BLOCK_REASONING = 'reasoning'
const BLOCK_TOOL = 'tool-call'

/**
 * 一次流式响应里累积的块状态。
 * 关键点：DSH 的 block 索引是「块出现顺序」，与 OpenAI 的 tool_calls[].index
 * 不是一回事，两者必须分开记，否则并发工具调用会串块。
 */
class BlockAccumulator {
  constructor() {
    /** @type {Array<Record<string, unknown>>} */
    this.blocks = []
    /** OpenAI 的 tool_calls 下标 → 本地的块记录。 */
    this.toolByIndex = new Map()
    this.reasoningBlock = null
    this.textBlock = null
  }

  /** 需要时才开新块，避免空块（空 text 块会污染 assistant 消息）。 */
  openText() {
    if (this.textBlock === null) {
      this.textBlock = { kind: BLOCK_TEXT, index: this.blocks.length, text: '' }
      this.blocks.push(this.textBlock)
    }
    return this.textBlock
  }

  openReasoning() {
    if (this.reasoningBlock === null) {
      this.reasoningBlock = { kind: BLOCK_REASONING, index: this.blocks.length, text: '' }
      this.blocks.push(this.reasoningBlock)
    }
    return this.reasoningBlock
  }

  openTool(openAiIndex, id, toolName) {
    const existing = this.toolByIndex.get(openAiIndex)
    if (existing !== undefined) {
      if (id !== undefined && existing.id === undefined) existing.id = id
      if (toolName !== undefined && (existing.name === undefined || existing.name.length === 0)) existing.name = toolName
      return existing
    }
    const record = { kind: BLOCK_TOOL, index: this.blocks.length, id, name: toolName, arguments: '' }
    this.blocks.push(record)
    this.toolByIndex.set(openAiIndex, record)
    return record
  }

  /** 是否有任何可提交的内容（用于识别「正常结束但什么都没输出」）。 */
  get hasContent() {
    return this.blocks.some((block) => (block.kind === BLOCK_TEXT || block.kind === BLOCK_REASONING ? block.text.length > 0 : true))
  }

  get hasToolCalls() {
    return this.toolByIndex.size > 0
  }
}

/** 生成 usage chunk；缺失或全零时返回 undefined（别发无意义的 0 token 统计）。 */
function usageChunk(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const inputTokens = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : undefined
  const outputTokens = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : undefined
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  const chunk = { type: 'usage', usage: { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 } }
  if (Number.isFinite(usage.total_tokens)) chunk.usage.totalTokens = usage.total_tokens
  else if (inputTokens !== undefined && outputTokens !== undefined) chunk.usage.totalTokens = inputTokens + outputTokens
  if (Number.isFinite(usage.prompt_tokens_details?.cached_tokens)) chunk.usage.cacheReadTokens = usage.prompt_tokens_details.cached_tokens
  if (Number.isFinite(usage.completion_tokens_details?.reasoning_tokens)) chunk.usage.reasoningTokens = usage.completion_tokens_details.reasoning_tokens
  return chunk
}

/**
 * 把 OpenAI 的 finish_reason 翻成 DSH 的 FinishReason。
 * 空回复（既没文本也没工具调用）由调用方在发 finish 之前判掉，这里只做映射。
 */
function finishReasonFor(reason) {
  if (reason === 'tool_calls' || reason === 'function_call') return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  // content_filter 在 DSH 的词表里没有对应项：当成正常结束，内容由服务端决定。
  return { kind: 'stop' }
}

/**
 * 构造适配器实例。
 * 只依赖传入的 ctx（取凭据）与配置快照，不在模块级保存任何全局状态，
 * 这样 HMR 重建插件时不会串配置。
 * @param {object} ctx Cordis 上下文（需要 config / credentials）。
 * @param {() => Record<string, unknown>} [configSource] 覆盖默认的配置来源。
 * @param {{lastKnown?: () => string[]}} [extras] lastKnown: 读「最近已知模型 id」
 *   （插件 apply 层从面板存档里维护并持久化）。手机掉线或刚换模型时，选择器
 *   与模型校验都用得上它。
 */
export function createAdapter(ctx, configSource, extras = {}) {
  const readRawConfig = configSource ?? (() => (typeof ctx.config === 'object' && ctx.config !== null ? ctx.config : {}))
  const readConfig = () => resolveConfig(readRawConfig() ?? {})
  /** 每个适配器实例一份探测缓存，键是 baseURL|apiKey 的摘要。 */
  const catalogCache = new Map()
  const lastKnownIds = extras.lastKnown ?? (() => [])

  return {
    /** 路由显示名：出现在模型选择器里。 */
    providerInfo(route) {
      let config
      try {
        config = readConfig()
      } catch {
        return { id: route, name: route }
      }
      return { id: route, name: route === config.provider ? config.displayName : `${config.displayName}（${route}）` }
    },

    providerRetryPolicy(route) {
      try {
        return readConfig().retryPolicy
      } catch {
        return DEFAULT_RETRY_POLICY
      }
    },

    /** 本地端侧模型没有 DSH 侧的图片计价器；交给 token meter 用中性估算。 */
    imageRequestPricing() {
      return undefined
    },

    /**
     * 目录：GUI 的模型选择器需要它，因此这条路必须**快且可失败**。
     * 组成（按顺序）：
     *   1. 服务端此刻在提供的（能马上用，排最前）；
     *   2. 最近一次从手机端见过的（lastKnown：探测失败/刚换模型时兜底）；
     *   3. 配置里写了但从未见过的（离线兜底名单）。
     * 探测有 2 秒上限与 60 秒缓存，手机没开服务时立刻回落 —— 绝不能把选择器卡住。
     * 后台刷新（catalogRefreshMs）会持续把 1 和 2 保持最新。
     */
    async listModels(route) {
      const config = readConfig()
      assertOwns(config, route)
      let advertised = []
      let probeOk = true
      try {
        advertised = await this.probeCatalog(config, CATALOG_PROBE_TIMEOUT_MS)
      } catch {
        probeOk = false
      }
      const live = new Set(advertised.map((model) => model.id))
      const known = [...new Set(lastKnownIds())].filter((id) => typeof id === 'string' && id.length > 0 && !live.has(id))
      const configured = config.models.filter((id) => !live.has(id) && !known.includes(id))
      // 显示名按整份目录一起算：尾段撞名的模型要带回父段才能区分。
      const ids = [...advertised.map((model) => model.id), ...known, ...configured]
      const labels = labelTable(config, ids)
      const catalog = advertised.map((model) => ({
        provider: route,
        id: model.id,
        name: labels.get(model.id) ?? modelLabelOf(config, model.id),
        inputModalities: ['text'],
      }))
      for (const id of known) {
        catalog.push({
          provider: route,
          id,
          name: labels.get(id) ?? modelLabelOf(config, id),
          description: probeOk
            ? '手机端最近提供过，但此刻没有提供它（可能 App 里换了模型）'
            : '手机端最近提供过（此刻没连上手机，这是最近一次的列表）',
          inputModalities: ['text'],
        })
      }
      for (const id of configured) {
        catalog.push({
          provider: route,
          id,
          name: labels.get(id) ?? modelLabelOf(config, id),
          description: probeOk
            ? '已配置，但手机端此刻没有提供它（App 里可能没加载这个模型）'
            : '已配置；手机端此刻没连上，无法确认是否在提供',
          inputModalities: ['text'],
        })
      }
      return catalog
    },

    /**
     * 带缓存的目录探测：UI 路径用短超时，诊断路径可以放宽。
     * @param {object} config 已解析配置。
     * @param {number} timeoutMs 本次允许的探测耗时。
     * @returns {Promise<Array<{id: string, name: string}>>} 服务端模型列表。
     */
    async probeCatalog(config, timeoutMs) {
      const key = `${config.baseURL}|${config.apiKey ?? ''}|${config.apiKeyEnv ?? ''}`
      const cached = readCache(catalogCache, key)
      if (cached !== undefined) return cached
      const models = await this._probeModels(config, timeoutMs)
      writeCache(catalogCache, key, models)
      return models
    },

    /** 只读缓存的目录（绝不打网络）。给 /state 用：面板打开要快。没有就返回 undefined。 */
    cachedCatalog(config) {
      const key = `${config.baseURL}|${config.apiKey ?? ''}|${config.apiKeyEnv ?? ''}`
      return readCache(catalogCache, key)
    },

    /**
     * 强制刷新一次目录：绕过缓存直接探手机端，成功后写回缓存。
     * 给后台轮询与面板「立即刷新」用；调用方负责把结果持久化成 lastKnown。
     */
    async refreshCatalog(config, timeoutMs) {
      const key = `${config.baseURL}|${config.apiKey ?? ''}|${config.apiKeyEnv ?? ''}`
      const models = await this._probeModels(config, timeoutMs)
      writeCache(catalogCache, key, models)
      return models
    },

    /**
     * 精确模型元数据：DSH 用它决定上下文窗口、输出上限与模态投影。
     *
     * 接受两种模型名：
     *  1. 配置里 `models` 列出的（离线也能用）；
     *  2. 服务端此刻真的在提供的（`/v1/models` 里有的）。
     * 于是手机换了模型（例如 2B → 0.8B）之后，不用回来改配置也能直接选。
     */
    async resolveModel(route, model) {
      const config = readConfig()
      assertOwns(config, route)
      if (!(await this.acceptsModel(config, model))) {
        throw fail(
          `dsh-mnn-chat: 路由 "${route}" 不认识模型 "${model}"：配置的 models 里没有它，` +
            `手机端的 /v1/models 也没在提供它。请在 App 里加载这个模型，或把名字加进插件配置的 models。`,
          CODES.unknownModel,
        )
      }
      return modelInfo(config, route, model)
    },

    /**
     * 这个模型名能不能用：先看配置，再看最近一次手机端见过的列表，
     * 最后看服务端此刻实际提供的列表。
     * 服务端探测失败时认配置与 lastKnown（不能因为手机掉线就把已配置的模型也否掉）。
     * @param {object} config 已解析配置。
     * @param {string} model 待判定的模型名。
     * @returns {Promise<boolean>} 是否可用。
     */
    async acceptsModel(config, model) {
      if (config.models.includes(model)) return true
      if (lastKnownIds().includes(model)) return true
      const advertised = await this.probeCatalog(config, CATALOG_PROBE_TIMEOUT_MS).catch(() => [])
      return advertised.some((entry) => entry.id === model)
    },

    /**
     * 绑定「本次调用使用的配置快照」，避免 prepare 与 dispatch 之间配置被改。
     * 这里就把 API Key 解析好：解析失败要在模型请求发出之前报出来。
     */
    async prepareCall(route, model, signal) {
      const config = readConfig()
      assertOwns(config, route)
      if (!(await this.acceptsModel(config, model))) {
        throw fail(`dsh-mnn-chat: 路由 "${route}" 不认识模型 "${model}"`, CODES.unknownModel)
      }
      const apiKey = await resolveApiKey(ctx, config, signal)
      const snapshot = { ...config, apiKey }
      return {
        model: modelInfo(config, route, model),
        stream: (options) => this._stream(options, snapshot),
      }
    },

    stream(options) {
      return this._stream(options, readConfig())
    },

    /**
     * 探一次服务端 /v1/models。
     * 手机端服务会随 App 前后台切换而起停（现象是 ECONNREFUSED 间歇出现），
     * 所以这里自带一次轻量重试；Accept 必须走 JSON 版，否则 MNN 回 406。
     * 万一某版本构建连 JSON 版都回 406，还会用通配 Accept 自愈重试一次。
     * @param {object} config 已解析配置（apiKey 可缺省，这里会自己解析）。
     * @param {number} [timeoutMs] 覆盖超时；UI 路径传短值。
     */
    async _probeModels(config, timeoutMs) {
      const endpoint = `${config.baseURL}/v1/models`
      const apiKey = config.apiKey ?? (await resolveApiKey(ctx, config, undefined).catch(() => undefined))
      const budget = Number.isFinite(timeoutMs) ? timeoutMs : Math.min(config.timeoutMs, 10000)
      // UI 路径（给了 timeoutMs）必须一次定生死：模型选择器不能被重试拖住。
      // 诊断路径没给超时，允许按重试策略多试几次，容忍手机端 App 切前后台。
      let attempts = Number.isFinite(timeoutMs) ? 1 : Math.max(1, Math.min(config.retryPolicy.maxRetries ?? 1, 3) + 1)
      let usedAltAccept = false
      let lastError
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error('timeout')), budget)
        if (typeof timer?.unref === 'function') timer.unref()
        try {
          let response
          try {
            response = await fetch(endpoint, {
              method: 'GET',
              headers: buildHeaders(config, apiKey, 'json', usedAltAccept ? ACCEPT_ANY : undefined),
              signal: controller.signal,
            })
          } catch (error) {
            throw fail(connectHint(endpoint, error), CODES.transport, { cause: error })
          }
          if (!response.ok) {
            // 406 自愈：换通配 Accept 再试一次（同一循环里只发生一回）。
            if (response.status === 406 && !usedAltAccept) {
              usedAltAccept = true
              attempts += 1
              try {
                await response.arrayBuffer()
              } catch {
                // 丢弃响应体以释放连接；失败不影响重试。
              }
              attempt -= 1
              continue
            }
            throw fail(`${endpoint} 返回 HTTP ${response.status}`, codeForStatus(response.status), { status: response.status })
          }
          return parseModelsPayload(await response.json())
        } catch (error) {
          lastError = error
          // 只在「连不上」时重试：HTTP 语义错误（406/401 之类）重试也不会变。
          if (error?.code !== CODES.transport || attempt === attempts - 1) throw error
          // 重连间隔不挂调用方 signal：取消由下一轮 fetch 处理，这里绝不能挂住。
          await sleep(200 * (attempt + 1)).catch(() => {})
        } finally {
          clearTimeout(timer)
        }
      }
      throw lastError ?? fail(`${endpoint} 探测失败`, CODES.transport)
    },

    /**
     * 真正的一次流式调用。
     * @param {Record<string, unknown>} options DSH 的 GenerateOptions。
     * @param {Record<string, unknown>} config 已解析的配置快照（含 apiKey）。
     */
    async *_stream(options, config) {
      const signal = options?.signal
      // 调用方可能在流开始前就取消了（用户在界面上点了停止）；这时一字节都不该发。
      if (signal?.aborted === true) throw abortError(signal)
      const path = options?.__mnnPath // 由 404 回退逻辑注入的重试路径，正常调用为 undefined
      const altAccept = options?.__mnnAltAccept === true // 由 406 自愈逻辑注入，换通配 Accept 再试
      const endpoint = endpointFor(config.baseURL, path ?? pathCandidates(config.pathStyle)[0])
      const body = toWireBody(config, options)
      const controller = new AbortController()
      if (signal?.aborted === true) controller.abort(signal.reason)
      const onAbort = () => controller.abort(signal?.reason)
      signal?.addEventListener?.('abort', onAbort, { once: true })

      let watchdog
      let response
      try {
        const idleMs = Math.min(config.streamIdleTimeoutMs, config.timeoutMs * 4)
        watchdog = startIdleWatchdog(controller, idleMs, () => {
          controller.abort(fail(`dsh-mnn-chat: ${Math.round(idleMs / 1000)} 秒没有收到任何数据，已中断（手机端可能掉线或模型被卸载）`, 'STREAM_IDLE_TIMEOUT'))
        })
        response = await fetchWithRetry(config, endpoint, body, controller.signal, watchdog, altAccept ? ACCEPT_ANY : undefined)
      } catch (error) {
        watchdog?.stop()
        signal?.removeEventListener?.('abort', onAbort)
        throw toTransportError(error, endpoint, signal)
      }

      // 406：内容协商被拒（个别构建的怪癖）。换通配 Accept 自愈重试一次。
      if (response.status === 406 && !altAccept) {
        const detail = (await readErrorDetail(response)).detail
        watchdog?.stop()
        signal?.removeEventListener?.('abort', onAbort)
        try {
          yield* this._stream({ ...options, __mnnAltAccept: true }, config)
          return
        } catch (error) {
          throw fail(
            `dsh-mnn-chat: 对话请求被拒绝（HTTP 406${detail.length > 0 ? `：${detail}` : ''}），` +
              `换过通配 Accept 重试仍然失败。请确认手机端 MNN Chat 的 API 服务已开启。`,
            codeForStatus(406),
            { status: 406, cause: error },
          )
        }
      }

      // 404/405：可能是路径风格不对，换一条路径再试一次（只重试一次，避免风暴）。
      if ((response.status === 404 || response.status === 405) && path === undefined && config.pathStyle === 'auto') {
        const detail = (await readErrorDetail(response)).detail
        watchdog?.stop()
        signal?.removeEventListener?.('abort', onAbort)
        const fallback = pathCandidates('auto')[1]
        if (fallback !== undefined) {
          try {
            yield* this._stream({ ...options, __mnnPath: fallback }, config)
            return
          } catch (error) {
            throw fail(
              `dsh-mnn-chat: ${endpoint} 与 ${endpointFor(config.baseURL, fallback)} 都不可用（HTTP ${response.status}${detail.length > 0 ? `：${detail}` : ''}）。` +
                `请确认 MNN Chat 的 API 服务已开启，且 baseURL 是 ${config.baseURL} 这样的地址。`,
              codeForStatus(response.status),
              { status: response.status, cause: error },
            )
          }
        }
      }

      if (!response.ok) {
        const { detail, requestId } = await readErrorDetail(response)
        watchdog?.stop()
        signal?.removeEventListener?.('abort', onAbort)
        throw fail(
          `dsh-mnn-chat: MNN Chat 返回 HTTP ${response.status}${detail.length > 0 ? `：${detail}` : ''}`,
          codeForStatus(response.status),
          { status: response.status, providerRetryAfterMs: retryAfterMs(response.headers), requestId },
        )
      }
      if (response.body === null) {
        watchdog?.stop()
        signal?.removeEventListener?.('abort', onAbort)
        throw fail('dsh-mnn-chat: MNN Chat 返回了空响应体，无法解析 SSE 流', CODES.invalidResponse, { status: response.status })
      }

      const accumulator = new BlockAccumulator()
      let finishReason
      let usage
      let sawDone = false
      let sawAnyPayload = false

      try {
        for await (const payload of sseData(response.body, controller.signal)) {
          watchdog?.reset()
          if (payload === '[DONE]') {
            sawDone = true
            break
          }
          if (payload.trim().length === 0) continue
          let chunk
          try {
            chunk = JSON.parse(payload)
          } catch {
            // 有些实现会在流里插入心跳/非 JSON 文本；忽略而不是中断整轮对话。
            continue
          }
          sawAnyPayload = true
          if (chunk?.error !== undefined) {
            const detail = typeof chunk.error?.message === 'string' ? chunk.error.message : JSON.stringify(chunk.error)
            throw fail(`dsh-mnn-chat: 流中返回错误：${detail}`, CODES.server)
          }
          if (usageChunk(chunk?.usage) !== undefined) usage = chunk.usage
          const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined
          if (choice === undefined || choice === null) continue
          const delta = choice.delta ?? choice.message ?? {}
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            yield* emitReasoning(accumulator, delta.reasoning_content)
          }
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            yield* emitText(accumulator, delta.content)
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              yield* emitToolCall(accumulator, call)
            }
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            finishReason = choice.finish_reason
          }
        }
      } catch (error) {
        watchdog?.stop()
        signal?.removeEventListener?.('abort', onAbort)
        if (isAbort(error, controller, signal)) throw fail('dsh-mnn-chat: 请求已取消', CODES.aborted, { cause: error })
        if (error?.name === 'MnnChatError') throw error
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          throw fail('dsh-mnn-chat: 等待 MNN Chat 流式响应时超时', 'STREAM_IDLE_TIMEOUT', { cause: error })
        }
        throw fail(`dsh-mnn-chat: 读取 MNN Chat 流失败：${error?.message ?? error}`, CODES.transport, { cause: error })
      } finally {
        watchdog?.stop()
        signal?.removeEventListener?.('abort', onAbort)
      }

      if (!sawAnyPayload && !sawDone) {
        throw fail('dsh-mnn-chat: MNN Chat 没有返回任何 SSE 数据（连接建立但流为空）', CODES.invalidResponse)
      }
      // 没等到 finish_reason 也没有 [DONE]：流被截断。此时绝不能补一个假的
      // stop —— 那会让 DSH 把一个残缺回复当成完整回复写进会话历史。
      if (finishReason === undefined) {
        throw fail('dsh-mnn-chat: SSE 流在收到结束标记前就断了，回复可能不完整', CODES.transport)
      }

      // 收尾：先关掉所有已开的块，再发 usage，最后一个 finish。
      if (!accumulator.hasContent && !accumulator.hasToolCalls) {
        throw fail('dsh-mnn-chat: MNN Chat 结束了一次空回复（没有文本也没有工具调用）', CODES.emptyResponse)
      }
      yield* closeBlocks(accumulator)
      const usageValue = usageChunk(usage)
      if (usageValue !== undefined) yield usageValue
      yield { type: 'finish', reason: finishReasonFor(finishReason) }
    },
  }
}

// ---------------------------------------------------------------------------
// 面板状态：用户在悬浮面板里改的覆盖值
//
// 覆盖哪些东西：连接地址、模型显示名、兜底模型名、上下文窗口、输出上限、提示词。
// 不覆盖密钥 —— 密钥走 DSH 的凭据服务（credentials.set），面板只报「配没配」，
// 从不把明文读回浏览器。
//
// 为什么覆盖值落文件而不是写回 profile 的 cordis.patch.yml：
//  1. 改配置会触发 Loader 重建本插件实例（注册会短暂消失），而改地址/提示词
//     不该影响正在进行的对话；
//  2. 不碰用户手写的 YAML，避免互相覆盖；
//  3. 面板随时能「清除覆盖」回落到配置。
// ---------------------------------------------------------------------------

/** 面板能覆盖的字段：键 → 校验/归一化函数（返回 undefined 表示清除该覆盖）。 */
const PANEL_FIELDS = Object.freeze({
  baseURL: (value) => {
    if (typeof value !== 'string' || value.trim().length === 0) throw fail('dsh-mnn-chat: 服务器地址不能为空', CODES.badRequest)
    return normalizeBaseURL(value.trim())
  },
  modelLabel: (value) => {
    if (!MODEL_LABELS.includes(value)) throw fail(`dsh-mnn-chat: modelLabel 只能是 ${MODEL_LABELS.map((item) => `"${item}"`).join(' 或 ')}`, CODES.badRequest)
    return value
  },
  models: (value) => {
    const models = toStringList(value, {})
    if (models.length === 0) throw fail('dsh-mnn-chat: 兜底模型名不能是空列表（要清空就传 null）', CODES.badRequest)
    return models
  },
  contextWindow: (value) => positiveInteger(value, 'contextWindow', DEFAULT_CONTEXT_WINDOW),
  maxTokens: (value) => positiveInteger(value, 'maxTokens', DEFAULT_MAX_TOKENS),
  systemPrompt: (value) => {
    if (typeof value !== 'string') throw fail('dsh-mnn-chat: systemPrompt 必须是字符串', CODES.badRequest)
    return value
  },
  apiKeyEnv: (value) => {
    if (typeof value !== 'string' || value.trim().length === 0) throw fail('dsh-mnn-chat: apiKeyEnv 不能是空字符串', CODES.badRequest)
    return value.trim()
  },
})

/** 面板状态文件路径。导出是为了让测试与 README 都能说清它在哪。 */
export function panelStatePath(env = globalThis.process?.env ?? {}) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0 ? env.DSH_HOME.trim() : join(homedir(), '.dsh')
  return join(home, PANEL_STATE_FILE)
}

/** 归一化一个覆盖值；null/undefined 表示「清除这个覆盖」。非法值抛错。 */
export function sanitizeOverride(key, value) {
  if (value === null || value === undefined) return undefined
  const sanitize = PANEL_FIELDS[key]
  if (sanitize === undefined) throw fail(`dsh-mnn-chat: 面板不认识字段 "${key}"`, CODES.badRequest)
  return sanitize(value)
}

/**
 * 读面板状态。任何异常（文件不在、JSON 坏了、字段类型不对）都当成「没有这个
 * 覆盖值」——一个坏文件绝不能让插件加载失败，也不能让一个手改坏的字段把别的
 * 有效覆盖一起废掉。
 * @returns {Record<string, unknown>} 只有合法字段的覆盖对象。
 */
export function readPanelState(env) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(panelStatePath(env), 'utf8'))
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const state = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'savedAt') {
      if (typeof value === 'string') state.savedAt = value
      continue
    }
    if (key === 'lastKnownModels') {
      // 插件自己维护的「最近已知模型 id」（后台刷新写进来），不是面板可写字段。
      if (Array.isArray(value)) {
        const cleaned = [...new Set(value.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))]
        state.lastKnownModels = cleaned.slice(0, LAST_KNOWN_MODELS_LIMIT)
      }
      continue
    }
    if (key === 'lastKnownAt') {
      if (typeof value === 'string') state.lastKnownAt = value
      continue
    }
    try {
      const clean = sanitizeOverride(key, value)
      if (clean !== undefined) state[key] = clean
    } catch {
      // 单个字段坏了就跳过它，其余照用。
    }
  }
  return state
}

/** 原子写面板状态（先写临时文件再 rename），避免留下半截 JSON。 */
export function writePanelState(state, env) {
  const file = panelStatePath(env)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return file
}

/** 把面板覆盖叠到配置上（不覆盖的键不出现，于是 config 里的值照旧生效）。 */
function overlayPanel(base, state) {
  let merged
  for (const key of Object.keys(PANEL_FIELDS)) {
    if (state[key] === undefined) continue
    merged ??= { ...base }
    merged[key] = state[key]
  }
  return merged ?? base
}

/** 某个字段的值来自面板还是配置。 */
function sourceOf(state, key) {
  return state[key] === undefined ? 'config' : 'panel'
}

// ---------------------------------------------------------------------------
// 同名资源的归属表
// ---------------------------------------------------------------------------

/**
 * key → { owner, dispose }。**模块级**（`link:` 模块在一个进程里只有一份），
 * 所以跨插件实例生效。
 *
 * 为什么必须有它 —— dsh-host-webserver 的实现是这样的：
 *
 *     register(route) {
 *       if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
 *       table.set(route.path, route)
 *       return () => { table.delete(route.path) }      // ← 按路径删，不校验归属
 *     }
 *
 * 而**每次改配置都会让 Loader 重建本插件实例**（新旧实例会短暂共存）。于是：
 *   · 旧路由还在时新实例注册 → 抛 duplicate route，apply 中断，后面的端点全被跳过；
 *   · 旧实例的清理跑在新实例注册之后 → `delete(path)` 把**新实例**的路由删掉 ——
 *     插件 fiber 还是 active、客户端面板照常渲染，但宿主里一个端点都没有，
 *     请求落到 fallback 变成「空响应体的 404」（就是面板报
 *     「端点返回了非 JSON 内容（HTTP 404）」的那个）。
 *
 * 这个表把「谁拥有这个路径/段落名」记下来：注册前先撤掉上一个主人（避免 duplicate），
 * 注销时先确认自己还是主人（避免误删别人的）。
 */
const namedOwnership = new Map()

/**
 * 声明一个具名资源的所有权。
 * @param {string} key 唯一键，例如 `web:/dsh-mnn-chat/probe`、`prompt:provider:mnn-chat`。
 * @param {() => void} register 真正注册的函数，返回释放句柄。
 * @returns {() => void} 归属安全的释放句柄。
 */
function claimNamed(key, register) {
  const previous = namedOwnership.get(key)
  if (previous !== undefined) {
    namedOwnership.delete(key)
    try {
      previous.dispose()
    } catch {
      // 上一个主人的资源可能已经跟着旧服务一起没了，忽略。
    }
  }
  const owner = Symbol(key)
  namedOwnership.set(key, { owner, dispose: register() })
  return () => {
    const current = namedOwnership.get(key)
    if (current === undefined || current.owner !== owner) return
    namedOwnership.delete(key)
    current.dispose()
  }
}

/**
 * 报告密钥状态 —— 只报「配没配、从哪来、能不能写」，**从不把明文读回浏览器**。
 * @param {object} ctx 插件上下文。
 * @param {object} config 已解析配置。
 * @returns {Promise<{ref: string|null, configured: boolean, source: string|null, writable: boolean, hint?: string}>}
 */
async function apiKeyStatus(ctx, config) {
  const ref = config.apiKeyEnv
  if (ref === undefined) {
    return {
      ref: null,
      configured: false,
      source: null,
      writable: false,
      hint: '配置里没有 apiKeyEnv，请求不会带 Authorization 头。MNN Chat 的 API 服务是要鉴权的，一般得配一个。',
    }
  }
  const credentials = ctx.get?.('credentials')
  if (credentials === undefined || typeof credentials.describe !== 'function') {
    return {
      ref,
      configured: false,
      source: null,
      writable: false,
      hint: `当前组装里没有 credentials 服务：密钥得自己写进 $DSH_HOME/.credentials.yaml 的 refs: ${ref}: <密钥>。`,
    }
  }
  try {
    const info = await credentials.describe(ref)
    return { ref, configured: info?.configured === true, source: info?.source ?? null, writable: info?.writable === true }
  } catch (error) {
    return { ref, configured: false, source: null, writable: false, hint: `读凭据状态失败：${error?.message ?? error}` }
  }
}

/**
 * 把密钥写进 DSH 的凭据服务（`.credentials.yaml` 的 refs:），**不写面板文件**。
 * @param {object} ctx 插件上下文。
 * @param {object} config 已解析配置。
 * @param {{apiKey?: unknown, clearApiKey?: unknown}} body 面板提交的 body。
 * @returns {Promise<{apiKeyEnv?: string, note: string}>} 需要一并落进覆盖的 apiKeyEnv（若配置里还没有）。
 */
async function writeApiKey(ctx, config, body) {
  const ref = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const credentials = ctx.get?.('credentials')
  if (credentials === undefined || typeof credentials.set !== 'function') {
    throw fail(
      `dsh-mnn-chat: 当前组装里没有 credentials 服务，密钥只能自己写进 $DSH_HOME/.credentials.yaml 的 refs: ${ref}: <密钥>`,
      CODES.badRequest,
    )
  }
  const clearing = body.clearApiKey === true || body.apiKey === null
  if (clearing) {
    await credentials.unset(ref)
    return { note: `已清除凭据 ${ref}` }
  }
  const value = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (value.length === 0) throw fail('dsh-mnn-chat: 密钥不能是空字符串（要清掉请点「清除密钥」）', CODES.badRequest)
  checkHeaderSafe(value, ref)
  await credentials.set(ref, value)
  return {
    // 配置里本来没有 apiKeyEnv 时，光存密钥没用（适配器不会带 Authorization 头），
    // 所以顺手把 ref 也落进覆盖，让这次保存直接生效。
    ...(config.apiKeyEnv === undefined ? { apiKeyEnv: ref } : {}),
    note: `已写入 DSH 凭据 ${ref}（存在 $DSH_HOME/.credentials.yaml，不在面板文件里）`,
  }
}

/**
 * 真实往返测试：拿一个模型发一句最短的话，验证「模型已加载 → 能生成 → SSE 能
 * 回包」整条链路。`/v1/models` 只能证明 HTTP 服务在，证明不了模型出得了字。
 * 走的是和正式对话同一套头；收到 406 时换通配 Accept 自愈重试一次。
 * @param {object} config 已解析配置。
 * @param {string|undefined} apiKey 已解析的密钥。
 * @param {string} model 要测的模型 id（协议字段，原样发）。
 * @param {{timeoutMs?: number, prompt?: string}} [options] 超时与测试语句。
 */
async function chatProbe(config, apiKey, model, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000
  const prompt = typeof options.prompt === 'string' && options.prompt.trim().length > 0 ? options.prompt.trim() : '连通性测试，请只回复两个字：正常'
  const endpoint = endpointFor(config.baseURL, pathCandidates(config.pathStyle)[0])
  const started = Date.now()

  const attempt = async (acceptOverride) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    if (typeof timer?.unref === 'function') timer.unref()
    let firstTokenMs
    let text = ''
    let finishReason
    let sawDone = false
    try {
      let response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: buildHeaders(config, apiKey, 'sse', acceptOverride),
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true, max_tokens: 32 }),
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) throw error
        throw fail(connectHint(endpoint, error), CODES.transport, { cause: error })
      }
      if (!response.ok) {
        const { detail, requestId } = await readErrorDetail(response)
        throw fail(
          `dsh-mnn-chat: 测试对话被拒绝（HTTP ${response.status}${detail.length > 0 ? `：${detail}` : ''}）`,
          codeForStatus(response.status),
          { status: response.status, requestId },
        )
      }
      if (response.body === null) throw fail('dsh-mnn-chat: 测试对话返回了空响应体', CODES.invalidResponse, { status: response.status })
      for await (const payload of sseData(response.body, controller.signal)) {
        if (payload === '[DONE]') {
          sawDone = true
          break
        }
        if (payload.trim().length === 0) continue
        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        const choice = chunk?.choices?.[0]
        const piece = typeof choice?.delta?.content === 'string' ? choice.delta.content : ''
        if (piece.length > 0) {
          if (firstTokenMs === undefined) firstTokenMs = Date.now() - started
          text += piece
        }
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason
      }
      return {
        model,
        ok: text.trim().length > 0,
        reply: text.trim(),
        ms: Date.now() - started,
        firstTokenMs,
        finishReason,
        // 没有 [DONE] 也没有 finish_reason，说明流是被掐断的（手机端常见）。
        truncated: finishReason === undefined && !sawDone,
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw fail(
          `dsh-mnn-chat: 测试对话 ${Math.round(timeoutMs / 1000)} 秒没等到回复（手机端首次加载模型可能很慢，隔一会儿再试一次）`,
          'TEST_TIMEOUT',
          { cause: error },
        )
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    return await attempt(undefined)
  } catch (error) {
    // 406 自愈：个别构建的内容协商可能拒绝默认头，换通配 Accept 再试一次。
    if (error?.failure?.status === 406 || error?.status === 406) {
      const alt = await attempt(ACCEPT_ANY).catch(() => {
        throw error
      })
      return alt
    }
    throw error
  }
}

/** 校验路由归属：别的 provider 名打进来要明确报错，而不是发到错误的地址。 */
function assertOwns(config, route) {
  if (route !== config.provider) {
    throw fail(`dsh-mnn-chat: 本适配器只服务路由 "${config.provider}"，收到 "${route}"`, CODES.invalidConfig)
  }
}

/** 读缓存（过期的当作没有）。 */
function readCache(cache, key) {
  const entry = cache.get(key)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at > CATALOG_CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  return entry.value
}

/** 写缓存；用插入顺序做容量上限，避免长时间运行后无界增长。 */
function writeCache(cache, key, value) {
  cache.delete(key)
  cache.set(key, { at: Date.now(), value })
  while (cache.size > 8) cache.delete(cache.keys().next().value)
}

/**
 * 后台目录刷新器：定时问一次手机端 /v1/models，把「此刻在提供的模型 id」
 * 更新进探测缓存，并在列表变化时通过 persist() 持久化成 lastKnown ——
 * 这就是「自动拉取 MNN Chat 发来的模型 id」的那只手。
 * 拉出来一个独立的工厂而不藏在 apply 里，是为了测试能直接驱动 tick()。
 * @param {object} deps
 * @param {() => object} deps.readConfig 当前的已解析配置。
 * @param {() => object|undefined} deps.getAdapter 当前注册的适配器。
 * @param {() => string[]} deps.getLastKnown 当前持久化的最近已知 id 列表。
 * @param {(ids: string[]) => void} deps.persist 持久化最近已知 id 列表。
 * @param {{info?: (m: string) => void, warn?: (m: string) => void}} [deps.logger] 日志。
 * @returns {{tick: () => Promise<string[]|boolean|undefined>, start: () => void, stop: () => void}}
 *   tick() 返回 undefined（未运行）、false（列表没变或失败）或最新的 id 数组（列表变了）。
 */
export function createCatalogRefresher({ readConfig, getAdapter, getLastKnown, persist, logger = {} }) {
  let inFlight = false
  let failures = 0
  let timer

  const tick = async () => {
    if (inFlight) return undefined
    inFlight = true
    try {
      const config = readConfig()
      if (!config.catalogRefreshMs) return false
      const adapter = getAdapter()
      if (adapter === undefined || typeof adapter.refreshCatalog !== 'function') return false
      const models = await adapter.refreshCatalog(config, CATALOG_REFRESH_PROBE_TIMEOUT_MS)
      failures = 0
      const ids = models.map((model) => model.id)
      const changed = ids.join('\u0000') !== (getLastKnown() ?? []).join('\u0000')
      if (changed) {
        persist(ids)
        logger.info?.(`[dsh-mnn-chat] 手机端此刻提供的模型：${ids.length > 0 ? ids.join(', ') : '（空）'}`)
        return ids
      }
      return true
    } catch (error) {
      failures += 1
      // 只在第 3 次连续失败时说一声，避免手机离线时刷屏。
      if (failures === 3) logger.warn?.(`[dsh-mnn-chat] 后台刷新模型目录连续失败（手机可能离线）：${error?.message ?? error}`)
      return false
    } finally {
      inFlight = false
    }
  }

  const start = () => {
    stop()
    let interval = DEFAULT_CATALOG_REFRESH_MS
    try {
      interval = readConfig().catalogRefreshMs
    } catch {
      // 配置坏了就不启动轮询；registerRoutes 会另出一条更完整的错误日志。
      return
    }
    if (!interval) return
    timer = setInterval(() => {
      void tick()
    }, interval)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  const stop = () => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  return { tick, start, stop }
}

/** 组装模型元数据（DSH 会校验每一个字段的取值）。 */
function modelInfo(config, route, model) {
  return {
    provider: route,
    id: model,
    name: model === route ? config.displayName : modelLabelOf(config, model),
    inputModalities: ['text'],
    context: { contextWindow: config.contextWindow },
    defaultMaxTokens: config.maxTokens,
  }
}

/**
 * 归一化的请求头。
 * 注意 Accept 必须按用途分开：MNN Chat 的 `/v1/models` 收到
 * `Accept: text/event-stream` 会直接回 406（真机稳定复现），所以目录探测走 JSON 版；
 * 对话请求的 Accept 以 `application/json` 开头（真机实测对 chat 端点不挑 Accept，
 * 但 JSON 在前可以避开个别构建在内容协商上的怪癖）。`acceptOverride` 供 406
 * 自愈重试用（换成通配 ACCEPT_ANY 再试一次）。
 * @param {object} config 已解析配置。
 * @param {string|undefined} apiKey 已解析的密钥。
 * @param {'sse'|'json'} kind 这一次请求期望的响应类型。
 * @param {string} [acceptOverride] 覆盖默认 Accept 头（406 自愈时用）。
 */
function buildHeaders(config, apiKey, kind = 'sse', acceptOverride) {
  const headers = {
    'content-type': 'application/json',
    accept: acceptOverride ?? (kind === 'json' ? ACCEPT_JSON : ACCEPT_STREAM),
    'user-agent': `${APP_PRODUCT}/${APP_VERSION} (+${APP_URL})`,
  }
  if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`
  for (const [key, value] of Object.entries(config.headers ?? {})) headers[key.toLowerCase()] = value
  return headers
}

/** 带传输层重试的 fetch：只重试「连不上/5xx/429」这类可恢复失败。 */
async function fetchWithRetry(config, endpoint, body, signal, watchdog, acceptOverride) {
  const policy = config.retryPolicy
  const maxAttempts = policy.mode === 'always' ? Math.max(policy.maxRetries ?? 1, 1) + 1 : (policy.maxRetries ?? 0) + 1
  let attempt = 0
  let lastError
  while (attempt < maxAttempts) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: buildHeaders(config, config.apiKey, 'sse', acceptOverride),
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      })
      watchdog?.reset()
      const retryable = response.status === 429 || response.status === 408 || response.status >= 500
      if (!retryable || attempt === maxAttempts - 1) return response
      lastError = fail(`MNN Chat 返回 HTTP ${response.status}`, codeForStatus(response.status), { status: response.status })
      // 必须把响应体读掉，否则连接不会释放。
      try {
        await response.arrayBuffer()
      } catch {
        // 忽略：重试前的清理失败不影响后续尝试。
      }
      const after = retryAfterMs(response.headers)
      await sleep(after ?? backoffDelay(policy, attempt), signal)
      attempt += 1
    } catch (error) {
      if (isAbort(error, undefined, signal)) throw error
      lastError = error
      if (attempt === maxAttempts - 1) throw error
      await sleep(backoffDelay(policy, attempt), signal)
      attempt += 1
    }
  }
  throw lastError ?? fail('dsh-mnn-chat: 请求失败', CODES.transport)
}

/** 判断一个异常是否就是「调用方取消」。 */
function isAbort(error, controller, signal) {
  if (signal?.aborted === true) return true
  if (controller?.signal?.aborted === true && error?.name === 'AbortError') return true
  return error?.name === 'AbortError' && signal?.aborted === true
}

/** 网络层异常 → 带可读提示的失败（本地服务最常见的失败是手机上没开服务）。 */
function toTransportError(error, endpoint, signal) {
  if (error?.name === 'MnnChatError') return error
  if (signal?.aborted === true) return fail('dsh-mnn-chat: 请求已取消', CODES.aborted, { cause: error })
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return error
  return fail(connectHint(endpoint, error), CODES.transport, { cause: error })
}

/** 「连不上」的统一话术：把最可能的三个原因直接写出来。 */
function connectHint(endpoint, error) {
  const detail = error?.cause?.message ?? error?.message ?? String(error)
  return (
    `dsh-mnn-chat: 连不上 ${endpoint}（${detail}）。请确认：手机与电脑在同一网络、` +
    `MNN Chat 的 API 服务已开启、baseURL 用的是 App 里显示的地址` +
    `（局域网 IP，不是 localhost，除非你做了 adb forward）。`
  )
}

/** 解析 /v1/models 的两种常见形状：{data:[...]} 与 {models:[...]/map}。 */
function parseModelsPayload(payload) {
  const collected = []
  const push = (id, name) => {
    if (typeof id !== 'string' || id.trim().length === 0) return
    const trimmed = id.trim()
    if (collected.some((entry) => entry.id === trimmed)) return
    collected.push({ id: trimmed, name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : trimmed })
  }
  if (Array.isArray(payload?.data)) {
    for (const entry of payload.data) push(entry?.id, entry?.name ?? entry?.display_name)
  }
  if (Array.isArray(payload?.models)) {
    for (const entry of payload.models) push(typeof entry === 'string' ? entry : entry?.id, typeof entry === 'string' ? entry : entry?.name)
  } else if (payload?.models !== null && typeof payload?.models === 'object') {
    for (const [id, entry] of Object.entries(payload.models)) push(id, entry?.name)
  }
  return collected
}

// --- 块发射器 -------------------------------------------------------------

function* emitText(accumulator, text) {
  const block = accumulator.openText()
  const wasEmpty = block.text.length === 0
  block.text += text
  if (wasEmpty) yield { type: 'block-start', index: block.index, blockType: BLOCK_TEXT }
  yield { type: 'text-delta', index: block.index, text }
}

function* emitReasoning(accumulator, text) {
  const block = accumulator.openReasoning()
  const wasEmpty = block.text.length === 0
  block.text += text
  if (wasEmpty) yield { type: 'block-start', index: block.index, blockType: BLOCK_REASONING }
  yield { type: 'reasoning-delta', index: block.index, text }
}

function* emitToolCall(accumulator, call) {
  const openAiIndex = Number.isInteger(call?.index) ? call.index : 0
  const id = typeof call?.id === 'string' && call.id.length > 0 ? call.id : undefined
  const toolName = typeof call?.function?.name === 'string' && call.function.name.length > 0 ? call.function.name : undefined
  const known = accumulator.toolByIndex.get(openAiIndex)
  const block = accumulator.openTool(openAiIndex, id, toolName)
  if (known === undefined) {
    yield { type: 'block-start', index: block.index, blockType: BLOCK_TOOL }
  }
  const argumentsDelta = typeof call?.function?.arguments === 'string' ? call.function.arguments : ''
  if (argumentsDelta.length > 0) block.arguments += argumentsDelta
  yield {
    type: 'tool-call-delta',
    index: block.index,
    id: block.id ?? `call_${openAiIndex}`,
    ...(toolName === undefined ? {} : { name: toolName }),
    argumentsDelta,
  }
}

/** 按块顺序关闭：DSH 需要每个 block-start 都有对应的 block-end 与完整块。 */
function* closeBlocks(accumulator) {
  for (const block of accumulator.blocks) {
    if (block.kind === BLOCK_TEXT) {
      if (block.text.length === 0) continue
      yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
      continue
    }
    if (block.kind === BLOCK_REASONING) {
      if (block.text.length === 0) continue
      yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
      continue
    }
    // 工具调用：arguments 必须是原始 JSON 字符串；服务端给了半截 JSON 也要原样交出去，
    // 由 DSH 的工具层给出解析错误（比这里静默编造参数更安全）。
    yield {
      type: 'block-end',
      index: block.index,
      block: {
        type: 'tool-call',
        id: block.id ?? `call_${block.index}`,
        name: block.name ?? '',
        arguments: block.arguments.length > 0 ? block.arguments : '{}',
      },
    }
  }
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * 注册适配器与配置目录项。
 * 每次配置变化后调用一次：路由集合可能变化（provider 改名、models 增删），
 * 直接把旧路由换掉。
 * @param {object} ctx 插件上下文。
 * @param {{value: unknown}} handle 保存 registerAdapter 句柄的盒子。
 * @param {() => Record<string, unknown>} readRawConfig 当前原始 Config 的读取器。
 * @param {{lastKnown?: () => string[]}} [adapterExtras] 透传给 createAdapter 的附加能力。
 * @param {{value: object|undefined}} [adapterBox] 装当前适配器实例的盒子（后台刷新用）。
 */
function registerRoutes(ctx, handle, readRawConfig, adapterExtras, adapterBox) {
  let config
  try {
    config = resolveConfig(readRawConfig())
  } catch (error) {
    ctx.logger?.error?.(`[dsh-mnn-chat] 配置无效，插件未注册任何路由：${error?.message ?? error}`)
    throw error
  }
  const adapter = createAdapter(ctx, readRawConfig, adapterExtras)
  if (adapterBox !== undefined) adapterBox.value = adapter
  const providers = [config.provider]
  handle.value = ctx.llm.registerAdapter(providers, adapter)
  ctx.logger?.info?.(
    `[dsh-mnn-chat] 已注册 LLM 路由 "${config.provider}"（${config.displayName}）→ ${config.baseURL}，` +
      `模型：${config.models.join(', ')}`,
  )
  return config
}

/**
 * 插件入口。
 * @param {object} ctx Cordis 上下文，必须已注入 llm。
 * @param {Record<string, unknown>} [pluginConfig] 组装器传入的 Config；缺省时退回 ctx.config。
 */
export function apply(ctx, pluginConfig) {
  const handle = { value: undefined }
  /** 当前适配器实例（后台刷新要用它强制重探目录）。 */
  const adapterBox = { value: undefined }
  /** 目录项：让 Models 设置页知道这个 provider 归本插件的命名空间管。 */
  let directory
  let config
  /** 面板覆盖值；读盘失败就是空对象。 */
  let panel = readPanelState()
  /** 提示词 section 是否真的挂上了（面板要如实告诉用户「保存了但没生效」）。 */
  let promptRegistered = false
  // 组装器既可能把 Config 作为第二个参数传进来，也可能挂在 ctx.config 上，两者都认。
  // 再把面板覆盖叠上去：改地址/显示名/窗口大小都该立刻反映到下一次操作，
  // 不用等 Loader 重建插件实例。
  const readRawConfig = () => {
    const source = pluginConfig ?? ctx.config
    const base = typeof source === 'object' && source !== null ? source : {}
    return overlayPanel(base, panel)
  }

  /** 最近一次从手机端见过的模型 id（后台刷新维护，落面板存档文件）。 */
  const lastKnownIds = () => (Array.isArray(panel.lastKnownModels) ? panel.lastKnownModels : [])

  /**
   * 把「最近已知模型 id」写进面板存档。先重读盘（别的入口可能刚写过），
   * 再合并落盘，最后同步内存里的 panel。失败只告警，不影响对话。
   */
  const persistLastKnownModels = (ids) => {
    try {
      const fresh = readPanelState()
      const next = { ...fresh, lastKnownModels: ids, lastKnownAt: new Date().toISOString() }
      if (typeof panel.savedAt === 'string' && next.savedAt === undefined) next.savedAt = panel.savedAt
      writePanelState(next)
      panel = next
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-mnn-chat] 保存最近已知模型列表失败：${error?.message ?? error}`)
    }
  }

  /**
   * 后台目录刷新器：每隔 catalogRefreshMs 问一次手机端此刻在提供什么模型，
   * 变化了就持久化并记一条日志 —— 选择器因此总能跟上手机端换模型的动作。
   */
  const catalogRefresher = createCatalogRefresher({
    readConfig: () => resolveConfig(readRawConfig()),
    getAdapter: () => adapterBox.value,
    getLastKnown: lastKnownIds,
    persist: persistLastKnownModels,
    logger: ctx.logger ?? {},
  })

  /**
   * 当前生效的提示词。面板写过就用面板的（空字符串是「明确清空」），
   * 否则用配置里的 systemPrompt。
   * 注意读的是活着的 panel 而不是 apply 时的 config 快照 —— section 的 text
   * 是个按次求值的函数，这样面板里一保存就立刻生效。
   */
  const currentPrompt = () => {
    if (typeof panel.systemPrompt === 'string') return panel.systemPrompt
    return typeof config?.systemPrompt === 'string' ? config.systemPrompt : ''
  }

  const directoryEntry = () => ({
    provider: config.provider,
    displayName: config.displayName,
    settingsNs: 'mnn-chat',
    // 空路径 = 本 provider 的配置就是 mnn-chat 这个 profile 条目 config 的根。
    // （deepseek 官方行是 settingsNs: 'llm-deepseek' + 空路径，同一个约定。）
    settingsPath: [],
    declared: true,
  })

  const rebuild = () => {
    // 先撤掉旧路由，再按新配置注册；registerAdapter 对同名路由是 all-or-nothing。
    try {
      handle.value?.()
    } catch {
      // 已释放的注册句柄再释放会抛错，忽略即可。
    }
    handle.value = undefined
    config = registerRoutes(ctx, handle, readRawConfig, { lastKnown: lastKnownIds }, adapterBox)
    if (directory !== undefined && config !== undefined) {
      try {
        directory.replace([directoryEntry()])
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-mnn-chat] 更新配置目录失败：${error?.message ?? error}`)
      }
    }
    // 配置可能改了轮询间隔（catalogRefreshMs），重启后台刷新器。
    catalogRefresher.start()
  }

  try {
    rebuild()
  } catch {
    // registerRoutes 已经记录了日志；此处不再向上抛，避免整个 profile 因
    // 一个写错的 baseURL 起不来。
    return
  }

  // 配置目录声明：Models 设置页靠它把 provider 行与本插件关联起来。
  try {
    directory = ctx.llm.registerConfigurableProviders([directoryEntry()])
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-mnn-chat] 未能声明可配置 provider（不影响对话）：${error?.message ?? error}`)
  }

  // 起来之后先刷一次目录：这样不用等第一个 30 秒周期，缓存与 lastKnown 就有底了。
  // 延迟 3 秒：避开启动风暴，也给测试里的请求计数留出干净的窗口。
  const initialRefresh = setTimeout(() => {
    void catalogRefresher.tick()
  }, 3000)
  if (typeof initialRefresh?.unref === 'function') initialRefresh.unref()

  // 配置热更新：改 profile 的 cordis.yml 后 DSH 会重建本插件实例，apply 重新
  // 跑一遍，旧实例的 ctx.effect 释放旧路由 —— 所以这里不需要额外的 watcher。

  // —— 系统提示词 section ——
  //
  // 用 ctx.inject 而不是 ctx.get：这是**可选**能力（缺了不该让插件加载失败），
  // 但注册必须挂在这个依赖自己的作用域里 —— 服务晚一点出现、或者被换掉时，
  // cordis 会按正确顺序「先撤旧的、再跑新的」。用 ctx.get 在 apply 里一次性注册
  // 就吃不到这个顺序保证（见 claimNamed 的注释：这会变成端点/段落悄悄消失）。
  //
  // 无条件注册（哪怕此刻没有提示词）：PromptSection.text 是个函数，每次组装都
  // 重新求值，于是面板里一保存就立刻生效、不用重建插件实例；文本为空时
  // dsh-system-prompt 会把这个 section 过滤掉（sections.filter(text.length > 0)），
  // 不会往提示词里塞空段落。
  //
  // interpolate: false 是必须的：默认会对 {{name}} 做变量展开，而**未注册的
  // 变量是直接抛异常**的（见 dsh-system-prompt 的 interpolate()），用户随手写
  // 一对花括号就会让之后每一次模型调用都失败。这里按字面文本处理。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => {
      try {
        const dispose = claimNamed(
          `prompt:${SECTION_NAME}`,
          () =>
            promptCtx.systemPrompt.section({
              name: SECTION_NAME,
              order: config.systemPromptOrder,
              interpolate: false,
              text: () => currentPrompt(),
            }),
        )
        promptRegistered = true
        ctx.logger?.info?.(
          `[dsh-mnn-chat] 已注册系统提示词 section "${SECTION_NAME}"（order ${config.systemPromptOrder}）` +
            `${currentPrompt().length > 0 ? '' : '，当前内容为空（在面板里写点什么就会生效）'}`,
        )
        return () => {
          promptRegistered = false
          dispose()
        }
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-mnn-chat] 注册系统提示词失败（不影响对话）：${error?.message ?? error}`)
        return undefined
      }
    })
  })

  // —— 诊断端点：浏览器打开 /dsh-mnn-chat/probe 就能看到解析后的配置、
  //    服务端模型列表与真实错误，省得去翻日志。
  //
  // 同样用 ctx.inject：webServer 是可选能力（无 Web 的组装里没有它），而注册
  // 必须挂在它自己的作用域里，才能在「服务被替换」时自动重新注册。
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('[dsh-mnn-chat] webServer 形状不对，诊断端点未注册。')
      return
    }
    /** 每一条路由都自己一个 effect + 归属：一条失败不影响其它端点。 */
    const mount = (path, handler) => {
      try {
        webCtx.effect(() =>
          claimNamed(`web:${path}`, () =>
            webServer.register({
              kind: 'exact',
              path,
              handler,
            }),
          ),
        )
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-mnn-chat] 注册端点 ${path} 失败：${error?.message ?? error}`)
      }
    }

    /** 共用的 JSON 响应helper。 */
    const sendJson = (res, status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(`${JSON.stringify(payload, null, 2)}\n`)
    }

    /** 读请求体并解析成 JSON 对象（有大小上限）。 */
    const readJsonBody = async (req) => {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > PANEL_BODY_LIMIT_BYTES) throw fail('dsh-mnn-chat: 请求体过大', CODES.badRequest)
        chunks.push(chunk)
      }
      if (size === 0) return {}
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw fail('dsh-mnn-chat: 请求体必须是一个 JSON 对象', CODES.badRequest)
      }
      return parsed
    }

    /** 一次探测的公因子：解析配置 + 解析密钥。 */
    const probeContext = async () => {
      const probeConfig = resolveConfig(readRawConfig())
      const adapter = createAdapter(ctx, readRawConfig, { lastKnown: lastKnownIds })
      const apiKey = await resolveApiKey(ctx, probeConfig, undefined).catch(() => undefined)
      return { adapter, probeConfig, apiKey }
    }

    // 连通性测试。GET 只探 /v1/models；POST 再加一次真实对话往返
    // （body: { "chat": true, "model": "<可省略>" }）。
    mount('/dsh-mnn-chat/probe', async (req, res) => {
      const payload = { ok: false, codeVersion: CODE_VERSION }
      try {
        const method = (req.method ?? 'GET').toUpperCase()
        const body = method === 'POST' ? await readJsonBody(req) : {}
        const { adapter, probeConfig, apiKey } = await probeContext()
        payload.provider = probeConfig.provider
        payload.displayName = probeConfig.displayName
        payload.baseURL = probeConfig.baseURL
        payload.endpoint = endpointFor(probeConfig.baseURL, OPENAI_PATH)
        payload.configuredModels = probeConfig.models
        payload.modelLabel = probeConfig.modelLabel
        payload.apiKey = probeConfig.apiKeyEnv === undefined ? '（未配置 apiKeyEnv，不带 Authorization 头）' : `来自 ${probeConfig.apiKeyEnv}`
        payload.contextWindow = probeConfig.contextWindow
        payload.maxTokens = probeConfig.maxTokens
        const modelsStarted = Date.now()
        const models = await adapter._probeModels(probeConfig)
        payload.modelsMs = Date.now() - modelsStarted
        const labels = labelTable(probeConfig, models.map((model) => model.id))
        payload.serverModels = models.map((model) => ({
          id: model.id,
          label: labels.get(model.id) ?? modelLabelOf(probeConfig, model.id),
          configured: probeConfig.models.includes(model.id),
        }))
        payload.ok = true
        payload.hint =
          models.length === 0
            ? '服务端 /v1/models 返回空列表：请确认手机端 App 里已经加载了模型'
            : 'HTTP 服务正常。这只是「模型列表」可达，不代表模型能出字 —— 加 chat: true 再测一次可以验证整条链路。'
        if (body.chat === true) {
          const target = typeof body.model === 'string' && body.model.length > 0 ? body.model : (models[0]?.id ?? probeConfig.models[0])
          payload.chat = await chatProbe(probeConfig, apiKey, target, {
            timeoutMs: positiveNumber(body.timeoutMs, 'timeoutMs', 30000),
            prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
          })
          payload.ok = payload.chat.ok === true
          payload.hint = payload.chat.ok
            ? `连通正常：模型「${labels.get(target) ?? modelLabelOf(probeConfig, target)}」${payload.chat.firstTokenMs ?? payload.chat.ms} 毫秒内开始回字。`
            : `模型接得上但一个字的回复都没拿到（${payload.chat.ms} 毫秒）${payload.chat.truncated ? '，而且流是被掐断的' : ''}。`
        }
      } catch (error) {
        payload.ok = false
        payload.error = error?.message ?? String(error)
        payload.code = error?.code ?? 'UNKNOWN'
      }
      sendJson(res, payload.ok ? 200 : 502, payload)
    })

    // 模型选择器里会出现的清单（就是 DSH 调 listModels() 拿到的东西），
    // 手机上换了模型之后打开这个地址就能看到该选哪个。
    mount('/dsh-mnn-chat/models', async (req, res) => {
      try {
        const adapter = createAdapter(ctx, readRawConfig, { lastKnown: lastKnownIds })
        const modelConfig = resolveConfig(readRawConfig())
        const catalog = await adapter.listModels(modelConfig.provider)
        sendJson(res, 200, {
          ok: true,
          codeVersion: CODE_VERSION,
          provider: modelConfig.provider,
          displayName: modelConfig.displayName,
          modelLabel: modelConfig.modelLabel,
          models: catalog,
          hint: `在模型选择器里选「${modelConfig.displayName}」，再选这里的任意一项（显示名 ${catalog.map((model) => model.name).join(' / ')}）。`,
        })
      } catch (error) {
        sendJson(res, 502, { ok: false, codeVersion: CODE_VERSION, error: error?.message ?? String(error), code: error?.code ?? 'UNKNOWN' })
      }
    })

    // —— 面板用的两个端点 ——
    /** 面板要看的全部状态（GET /state 与 POST /settings 的响应共用一份）。 */
    const panelState = async () => {
      const stateConfig = resolveConfig(readRawConfig())
      const apiKey = await apiKeyStatus(ctx, stateConfig)
      // 缓存里的服务端目录（只读缓存，绝不为了开面板去打手机）。
      let cached
      try {
        cached = adapterBox.value?.cachedCatalog?.(stateConfig)
      } catch {
        cached = undefined
      }
      return {
        ok: true,
        codeVersion: CODE_VERSION,
        provider: stateConfig.provider,
        displayName: stateConfig.displayName,
        baseURL: stateConfig.baseURL,
        endpoint: endpointFor(stateConfig.baseURL, OPENAI_PATH),
        pathStyle: stateConfig.pathStyle,
        contextWindow: stateConfig.contextWindow,
        maxTokens: stateConfig.maxTokens,
        configuredModels: stateConfig.models,
        modelLabel: stateConfig.modelLabel,
        // 按当前策略给一个真实样例（取兜底名单第一项），让面板不用硬编码示例文字。
        labelSample: stateConfig.models.length > 0 ? modelLabelOf(stateConfig, stateConfig.models[0]) : undefined,
        // 模型目录现状：后台轮询的节奏、最近一次从手机端见到的列表、
        // 以及缓存里此刻有的服务端目录（可能过期，刷新按钮可强制重探）。
        catalog: {
          refreshMs: stateConfig.catalogRefreshMs,
          lastKnown: { at: panel.lastKnownAt ?? null, models: lastKnownIds() },
          cached:
            Array.isArray(cached) && cached.length > 0
              ? cached.map((model) => ({
                  id: model.id,
                  label: modelLabelOf(stateConfig, model.id),
                  configured: stateConfig.models.includes(model.id),
                }))
              : null,
        },
        // 每个字段当前的值是面板覆盖的还是 profile 配置给的 —— 面板要如实标出来。
        sources: {
          baseURL: sourceOf(panel, 'baseURL'),
          modelLabel: sourceOf(panel, 'modelLabel'),
          models: sourceOf(panel, 'models'),
          contextWindow: sourceOf(panel, 'contextWindow'),
          maxTokens: sourceOf(panel, 'maxTokens'),
          apiKeyEnv: sourceOf(panel, 'apiKeyEnv'),
          systemPrompt: typeof panel.systemPrompt === 'string' ? 'panel' : stateConfig.systemPrompt !== undefined ? 'config' : 'none',
        },
        apiKey,
        prompt: {
          text: currentPrompt(),
          source: typeof panel.systemPrompt === 'string' ? 'panel' : stateConfig.systemPrompt !== undefined ? 'config' : 'none',
          order: stateConfig.systemPromptOrder,
          section: SECTION_NAME,
          registered: promptRegistered,
          configText: stateConfig.systemPrompt ?? null,
        },
        file: panelStatePath(),
        savedAt: typeof panel.savedAt === 'string' ? panel.savedAt : null,
      }
    }

    // GET /state：面板打开时读的全部内容（连接、参数、提示词、密钥状态、覆盖来源）。
    mount('/dsh-mnn-chat/state', async (req, res) => {
      try {
        // 重新读盘：用户手改了 JSON 文件、或另开了面板，这里都能反映出来。
        panel = readPanelState()
        sendJson(res, 200, await panelState())
      } catch (error) {
        sendJson(res, 502, { ok: false, codeVersion: CODE_VERSION, error: error?.message ?? String(error), code: error?.code ?? 'UNKNOWN' })
      }
    })

    // POST /refresh：强制重探手机端 /v1/models（绕过缓存），把结果持久化成
    // 「最近已知列表」并回给面板。给「手机上刚换了模型，想马上在选择器里看到」用。
    mount('/dsh-mnn-chat/refresh', async (req, res) => {
      try {
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          sendJson(res, 405, { ok: false, codeVersion: CODE_VERSION, error: '只接受 POST' })
          return
        }
        const context = await probeContext()
        // 优先用已注册的适配器：刷新结果要进它的缓存，/state 才能立刻看到。
        const adapter = adapterBox.value ?? context.adapter
        const probeConfig = context.probeConfig
        const started = Date.now()
        const models = await adapter.refreshCatalog(probeConfig, CATALOG_REFRESH_PROBE_TIMEOUT_MS)
        persistLastKnownModels(models.map((model) => model.id))
        const labels = labelTable(probeConfig, models.map((model) => model.id))
        sendJson(res, 200, {
          ...(await panelState()),
          refreshed: {
            ok: true,
            ms: Date.now() - started,
            at: panel.lastKnownAt ?? null,
            models: models.map((model) => ({
              id: model.id,
              label: labels.get(model.id) ?? modelLabelOf(probeConfig, model.id),
              configured: probeConfig.models.includes(model.id),
            })),
          },
        })
      } catch (error) {
        sendJson(res, 502, { ok: false, codeVersion: CODE_VERSION, error: error?.message ?? String(error), code: error?.code ?? 'UNKNOWN' })
      }
    })

    // POST /settings：面板唯一的写入口。
    // body 里出现的每个字段都会被覆盖（传 null 表示清除该覆盖）；另外两个特殊字段：
    // apiKey（写进 DSH 凭据）与 clearApiKey: true。
    // 只写覆盖文件，不碰 profile 的 YAML —— 地址/提示词改完立刻生效，不用重启，
    // 也不会打断正在进行的对话。
    mount('/dsh-mnn-chat/settings', async (req, res) => {
      try {
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          sendJson(res, 405, { ok: false, codeVersion: CODE_VERSION, error: '只接受 POST' })
          return
        }
        const body = await readJsonBody(req)
        const next = { ...panel }
        const changed = []
        for (const [key, value] of Object.entries(body)) {
          if (key === 'apiKey' || key === 'clearApiKey') continue
          const clean = sanitizeOverride(key, value)
          if (clean === undefined) delete next[key]
          else next[key] = clean
          changed.push(key)
        }
        let credential = null
        if (Object.hasOwn(body, 'apiKey') || body.clearApiKey === true) {
          const written = await writeApiKey(ctx, resolveConfig(readRawConfig()), body)
          if (written.apiKeyEnv !== undefined) next.apiKeyEnv = written.apiKeyEnv
          credential = written.note
        }
        next.savedAt = new Date().toISOString()
        const file = writePanelState(next)
        panel = next
        sendJson(res, 200, {
          ...(await panelState()),
          file,
          changed,
          credential,
          note: changed.length === 0 && credential === null ? '没有需要保存的改动' : '已保存，下一次操作就生效',
        })
      } catch (error) {
        sendJson(res, 400, { ok: false, codeVersion: CODE_VERSION, error: error?.message ?? String(error), code: error?.code ?? 'UNKNOWN' })
      }
    })
  })

  // 路由与提示词段落的释放不用在这里做：它们各自挂在 webCtx.effect /
  // promptCtx.effect 上，随依赖一起被 cordis 按正确顺序回收（见 claimNamed 的注释）。
  ctx.effect(() => () => {
    catalogRefresher.stop()
    clearTimeout(initialRefresh)
    try {
      directory?.()
    } catch {
      // 释放失败不影响卸载。
    }
    try {
      handle.value?.()
    } catch {
      // 同上。
    }
  })
}

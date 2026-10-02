// 测试脚手架：一个假的 MNN Chat 服务端 + 一份最小实现的 ctx.llm，
// 用来在没有真机的情况下验证适配器的线格式、SSE 分块与注册语义。
import { createServer } from 'node:http'

/**
 * 所有还开着的假服务端。
 *
 * 为什么需要它：断言失败会让测试函数在 `await fake.close()` 之前就抛出，
 * 于是假服务端连同 socket 一直开着 —— node --test 会等事件循环清空，
 * 表现为「测试全跑完了但进程不退出」。测试文件末尾挂一个 closeAllFakes()
 * 就不会再被这种连带效应困住。
 */
const openFakes = new Set()

/** 关掉所有还没关的假服务端（断言失败漏掉 close 时的兜底）。 */
export async function closeAllFakes() {
  await Promise.all([...openFakes].map((fake) => fake.close().catch(() => {})))
}

/**
 * 起一个假的 OpenAI 兼容服务端。
 * @param {(req: {url: string, body: any, headers: Record<string,string>}) => {status?: number, headers?: Record<string,string>, chunks?: string[], sse?: boolean, json?: unknown}} handler
 *   返回 sse 时按 data: 行逐条写出（字符串原样，其余 JSON 化）。
 * @param {{port?: number}} [options] 指定端口，用于「关掉再在同端口拉起来」这类重试测试。
 * @returns {Promise<{baseURL: string, requests: Array<any>, close: () => Promise<void>}>}
 */
export async function startFakeMnn(handler, options = {}) {
  const requests = []
  const sockets = new Set()
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body
      try {
        body = raw.length === 0 ? undefined : JSON.parse(raw)
      } catch {
        body = raw
      }
      const record = { url: req.url, method: req.method, headers: req.headers, body }
      requests.push(record)
      const respond = (result) => {
        const status = result?.status ?? 200
        if (result?.json !== undefined) {
          res.writeHead(status, { 'content-type': 'application/json', ...(result.headers ?? {}) })
          res.end(JSON.stringify(result.json))
          return
        }
        res.writeHead(status, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          ...(result?.headers ?? {}),
        })
        for (const chunk of result?.chunks ?? []) {
          const text = typeof chunk === 'string' ? chunk : JSON.stringify(chunk)
          res.write(`data: ${text}\n\n`)
        }
        res.end()
      }
      // 允许 handler 返回 Promise，方便测试「跑到一半被取消」这类时序场景。
      try {
        const result = handler(record)
        if (result !== null && typeof result?.then === 'function') result.then(respond, respondWithError)
        else respond(result)
      } catch (error) {
        respondWithError(error)
      }
    })
    function respondWithError(error) {
      if (res.writableEnded) return
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }))
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const address = server.address()
  const fake = {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => {
      if (!openFakes.has(fake)) return Promise.resolve()
      openFakes.delete(fake)
      return new Promise((resolve) => {
        // undici 的 keep-alive 连接会让 server.close() 一直等下去；
        // 直接销毁所有 socket，测试进程才能干净退出。
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        server.close(() => resolve())
      })
    },
  }
  openFakes.add(fake)
  return fake
}

/** 构造一条 OpenAI 风格的分片。 */
export function delta(content, extra = {}) {
  return { id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: content, finish_reason: null }], ...extra }
}

/** 构造结束分片。 */
export function end(reason = 'stop', extra = {}) {
  return { id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }], ...extra }
}

/**
 * 最小实现的 llm 服务：照着内置 LlmRuntime 的校验规则写，
 * 这样适配器返回的元数据合不合规，测试里就能直接暴露。
 */
export class MockLlm {
  constructor() {
    this.adapters = new Map()
    this.directory = new Map()
    this.events = []
  }

  registerAdapter(providers, adapter) {
    const owned = new Set()
    const commit = (routes) => {
      const prepared = routes.map((provider) => {
        if (typeof provider !== 'string' || provider.length === 0) throw new Error('INVALID_ADAPTER: provider 名不能为空')
        if (owned.has(provider) || (this.adapters.has(provider) && !owned.has(provider))) {
          throw new Error(`DUPLICATE_ADAPTER: ${provider}`)
        }
        const info = adapter.providerInfo(provider)
        if (info?.id !== provider || typeof info.name !== 'string' || info.name.length === 0) {
          throw new Error(`INVALID_ADAPTER: providerInfo 必须保留 id 且有非空 name（收到 ${JSON.stringify(info)}）`)
        }
        return { adapter, provider: { id: info.id, name: info.name }, retryPolicy: adapter.providerRetryPolicy(provider) }
      })
      for (const provider of owned) this.adapters.delete(provider)
      owned.clear()
      for (const entry of prepared) {
        this.adapters.set(entry.provider.id, entry)
        owned.add(entry.provider.id)
      }
      this.events.push('adapters-updated')
    }
    commit(providers)
    const handle = () => {
      for (const provider of owned) this.adapters.delete(provider)
      owned.clear()
      this.events.push('adapters-updated')
    }
    handle.replace = (next) => commit(next)
    return handle
  }

  registerConfigurableProviders(entries) {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('INVALID_DIRECTORY: 至少要声明一个 provider')
    const held = []
    const commit = (next) => {
      for (const entry of next) {
        if (typeof entry.provider !== 'string' || entry.provider.length === 0) throw new Error('INVALID_DIRECTORY: provider 不能为空')
        if (typeof entry.displayName !== 'string' || entry.displayName.length === 0) throw new Error('INVALID_DIRECTORY: displayName 不能为空')
        if (typeof entry.settingsNs !== 'string' || entry.settingsNs.length === 0) throw new Error('INVALID_DIRECTORY: settingsNs 不能为空')
        if (!Array.isArray(entry.settingsPath) || entry.settingsPath.some((segment) => typeof segment !== 'string' || segment.length === 0)) {
          throw new Error('INVALID_DIRECTORY: settingsPath 段落不能为空')
        }
      }
      for (const entry of held) this.directory.delete(entry.provider)
      held.length = 0
      for (const entry of next) {
        this.directory.set(entry.provider, entry)
        held.push(entry)
      }
    }
    commit(entries)
    const handle = () => {
      for (const entry of held) this.directory.delete(entry.provider)
      held.length = 0
    }
    handle.replace = (next) => commit(next)
    return handle
  }

  /** 走一遍 DSH 在真实调用里做的元数据校验，越早炸越好。 */
  validateModelInfo(provider, model, info) {
    if (info?.provider !== provider) throw new Error('adapter returned invalid exact model metadata: provider 不匹配')
    if (info?.id !== model) throw new Error('adapter returned invalid exact model metadata: id 不匹配')
    if (typeof info?.name !== 'string' || info.name.length === 0) throw new Error('adapter returned invalid exact model metadata: name 为空')
    if (info.context !== undefined && (!Number.isInteger(info.context.contextWindow) || info.context.contextWindow <= 0)) {
      throw new Error('adapter returned invalid context metadata')
    }
    if (info.defaultMaxTokens !== undefined && (!Number.isSafeInteger(info.defaultMaxTokens) || info.defaultMaxTokens <= 0)) {
      throw new Error('adapter returned invalid default maxTokens')
    }
    if (info.inputModalities !== undefined && info.inputModalities.some((modality) => modality !== 'text' && modality !== 'image')) {
      throw new Error('adapter returned invalid modalities')
    }
    return info
  }

  async listModels(provider) {
    const entry = this.adapters.get(provider)
    if (entry === undefined) throw new Error(`NO_ADAPTER: ${provider}`)
    const models = await entry.adapter.listModels(provider)
    const seen = new Set()
    for (const model of models) {
      if (model.provider !== provider || typeof model.id !== 'string' || model.id.length === 0 || typeof model.name !== 'string' || model.name.length === 0) {
        throw new Error(`INVALID_CATALOG: ${JSON.stringify(model)}`)
      }
      if (seen.has(model.id)) throw new Error(`INVALID_CATALOG: 重复模型 ${model.id}`)
      seen.add(model.id)
    }
    return models
  }

  async resolveModel(provider, model) {
    const entry = this.adapters.get(provider)
    if (entry === undefined) throw new Error(`NO_ADAPTER: ${provider}`)
    return this.validateModelInfo(provider, model, await entry.adapter.resolveModel(provider, model))
  }

  /** 模拟 DSH 的 adapterStream：prepareCall → 收集 chunk。 */
  async stream(options) {
    const entry = this.adapters.get(options.provider)
    if (entry === undefined) {
      return { thrown: { failure: { message: `no adapter registered for provider "${options.provider}"`, code: 'NO_ADAPTER' } } }
    }
    let prepared
    try {
      prepared = await entry.adapter.prepareCall(options.provider, options.model, options.signal)
      this.validateModelInfo(options.provider, options.model, prepared.model)
    } catch (error) {
      return { thrown: error.failure ?? { message: error.message, code: error.code ?? 'UNKNOWN' } }
    }
    const chunks = []
    try {
      for await (const chunk of prepared.stream(options)) chunks.push(chunk)
    } catch (error) {
      return { chunks, thrown: error.failure ?? { message: error.message, code: error.code ?? 'UNKNOWN' } }
    }
    return { chunks, model: prepared.model }
  }
}

/**
 * 最小实现的 webServer 服务 —— **故意照抄真实实现里那两个危险语义**：
 *
 *   register(route) {
 *     if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
 *     table.set(route.path, route)
 *     return () => { table.delete(route.path) }      // ← 按路径删，不看归属
 *   }
 *
 * 照抄它们才可能测出「改配置重建插件实例 → 端点被误删 / 注册抛 duplicate」这类 bug。
 * @see ../../../lib/index.js 的 claimNamed
 */
export class MockWebServer {
  constructor() {
    /** path → { route, handler, owner } */
    this.routes = new Map()
    /** 每次注册都记一笔，方便断言「谁注册过什么」 */
    this.log = []
  }

  register(route) {
    if (this.routes.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    const entry = { route, handler: route.handler, owner: route }
    this.routes.set(route.path, entry)
    this.log.push({ action: 'register', path: route.path })
    // 真实实现就是无脑按路径删 —— 归属安全必须由调用方（claimNamed）保证。
    return () => {
      const current = this.routes.get(route.path)
      this.routes.delete(route.path)
      this.log.push({ action: 'dispose', path: route.path, removedForeign: current !== undefined && current.owner !== route })
    }
  }

  /** 测试里直接调一个端点。 */
  call(path, { method = 'GET', body } = {}) {
    const entry = this.routes.get(path)
    if (entry === undefined) return Promise.resolve({ status: 404, payload: undefined, raw: '' })
    const request = { method }
    if (body !== undefined) {
      const bytes = Buffer.from(JSON.stringify(body))
      request[Symbol.asyncIterator] = async function* () {
        yield bytes
      }
    }
    return new Promise((resolve) => {
      const res = {
        statusCode: 0,
        writeHead(status) {
          this.statusCode = status
        },
        end(text = '') {
          let payload
          try {
            payload = JSON.parse(text)
          } catch {
            payload = undefined
          }
          resolve({ status: this.statusCode, payload, raw: text })
        },
      }
      Promise.resolve(entry.handler(request, res)).catch((error) => {
        resolve({ status: 0, payload: undefined, raw: String(error?.message ?? error) })
      })
    })
  }
}

/**
 * 造一个够用的插件 ctx。
 *
 * `inject` 模拟 cordis 的核心语义：**依赖到齐才跑回调，回调跑在自己的子作用域里**
 * （子作用域的 effect 随依赖/插件一起回收）。`provide()` 用来演「服务比插件晚出现」。
 * @param {{config?: object, credentials?: object, webServer?: object, systemPrompt?: object, logger?: object}} [options]
 */
export function makeCtx({ config = {}, credentials, webServer, systemPrompt, logger } = {}) {
  const logs = []
  const effects = []
  const injects = []
  const provided = new Map([
    ['credentials', credentials],
    ['webServer', webServer],
    ['systemPrompt', systemPrompt],
  ])
  const safeDispose = (dispose) => {
    try {
      dispose()
    } catch {
      // 释放失败不影响其它释放。
    }
  }
  const runInject = (entry) => {
    if (entry.ran) return
    const values = entry.names.map((name) => provided.get(name))
    if (values.some((value) => value === undefined)) return
    entry.ran = true
    const child = {
      get: (name) => provided.get(name),
      effect: (factory) => {
        const dispose = factory()
        entry.childEffects.push(dispose)
        return dispose
      },
    }
    for (const [index, name] of entry.names.entries()) child[name] = values[index]
    entry.callback(child)
  }
  return {
    config,
    llm: new MockLlm(),
    logger: logger ?? {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
    logs,
    effects,
    credentials,
    webServer,
    /** 收到的系统提示词 section（DSH 的 SystemPrompt 服务在测试里的替身）。 */
    promptSections: systemPrompt?.sections ?? [],
    get(name) {
      return provided.get(name)
    },
    effect(factory) {
      effects.push(factory())
    },
    inject(names, callback) {
      const entry = { names: [...names], callback, childEffects: [], ran: false }
      injects.push(entry)
      runInject(entry)
      return () => {
        for (const dispose of entry.childEffects.splice(0)) safeDispose(dispose)
      }
    },
    /** 测试用：某个服务晚一步就绪（例如 webServer 比插件晚出现）。 */
    provide(name, value) {
      provided.set(name, value)
      for (const entry of injects) runInject(entry)
    },
    /** 测试用：模拟插件 fiber 卸载 —— 先收 inject 子作用域，再收顶层 effect。 */
    dispose() {
      for (const entry of injects) {
        if (!entry.ran) continue
        entry.ran = false
        for (const dispose of entry.childEffects.splice(0)) safeDispose(dispose)
      }
      for (const dispose of effects.splice(0)) safeDispose(dispose)
    },
  }
}

/**
 * 最小实现的 systemPrompt 服务：只照着真实实现的校验规则收 section。
 * 真实实现里同名 section 在同一层重复注册会抛错 —— 这里也照做，
 * 免得插件哪天不小心撞了 DSH 自带的 `deployment:persona-prefix`。
 */
export class MockSystemPrompt {
  constructor() {
    this.sections = []
  }

  section(entry) {
    if (typeof entry?.name !== 'string' || entry.name.length === 0) throw new Error('section name 不能为空')
    if (!Number.isFinite(entry?.order)) throw new TypeError(`prompt section "${entry.name}" order must be a finite number`)
    if (this.sections.some((existing) => existing.name === entry.name)) {
      throw new Error(`duplicate prompt section "${entry.name}"`)
    }
    this.sections.push(entry)
    return () => {
      const index = this.sections.indexOf(entry)
      if (index >= 0) this.sections.splice(index, 1)
    }
  }
}

/** 把 chunk 序列压成便于断言的形状。 */
export function summarize(chunks) {
  return chunks.map((chunk) => {
    if (chunk.type === 'text-delta') return `text+${JSON.stringify(chunk.text)}`
    if (chunk.type === 'reasoning-delta') return `reasoning+${JSON.stringify(chunk.text)}`
    if (chunk.type === 'tool-call-delta') return `tool+${chunk.name ?? ''}:${JSON.stringify(chunk.argumentsDelta)}`
    if (chunk.type === 'block-start') return `start:${chunk.blockType}#${chunk.index}`
    if (chunk.type === 'block-end') return `end:${chunk.block.type}#${chunk.index}`
    if (chunk.type === 'usage') return `usage:${chunk.usage.inputTokens}/${chunk.usage.outputTokens}`
    if (chunk.type === 'finish') return `finish:${chunk.reason.kind}`
    return chunk.type
  })
}

/** 取出最终 assistant 内容块（DSH 用 block-end 拼消息）。 */
export function finalBlocks(chunks) {
  return chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
}

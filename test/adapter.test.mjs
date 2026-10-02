import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, createCatalogRefresher, resolveConfig, toWireMessages, toWireBody } from '../lib/index.js'
import { startFakeMnn, delta, end, makeCtx, summarize, finalBlocks, MockSystemPrompt, MockWebServer, closeAllFakes } from './helpers.mjs'

// undici 的 keep-alive 连接会让 node --test 在断言跑完后迟迟不退出；
// 全部跑完就主动收掉连接池，测试进程才能干净结束。
// 另外整个文件把 DSH_HOME 指到临时目录：插件的 apply() 会读写面板存档
// （mnn-chat.panel.json，含 lastKnownModels），绝不能落到用户真实的 $DSH_HOME。
const fileTempHome = mkdtempSync(join(tmpdir(), 'mnn-home-file-'))
const filePreviousHome = process.env.DSH_HOME
process.env.DSH_HOME = fileTempHome

after(async () => {
  if (filePreviousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = filePreviousHome
  rmSync(fileTempHome, { recursive: true, force: true })
  // 断言失败会让某个测试跳过自己的 fake.close()，假服务端留着 socket，
  // node --test 就会卡在「等事件循环清空」上：先兜底收干净。
  await closeAllFakes()
  try {
    const { getGlobalDispatcher } = await import('undici')
    await getGlobalDispatcher().close()
  } catch {
    // 没有 undici 可用时忽略：进程退出由 Node 自己处理。
  }
})

const BASE = { baseURL: 'http://127.0.0.1:1', models: ['Qwen3-4B'] }

test('resolveConfig: baseURL 的三种写法都归一到同一个地址', () => {
  for (const raw of ['http://192.168.1.23:8080', 'http://192.168.1.23:8080/', 'http://192.168.1.23:8080/v1']) {
    const config = resolveConfig({ ...BASE, baseURL: raw })
    assert.equal(config.baseURL, 'http://192.168.1.23:8080')
  }
})

test('resolveConfig: models 支持逗号分隔字符串与数组', () => {
  assert.deepEqual(resolveConfig({ ...BASE, models: 'Qwen3-4B, Qwen2.5-1.5B' }).models, ['Qwen3-4B', 'Qwen2.5-1.5B'])
  assert.deepEqual(resolveConfig({ ...BASE, models: ['a', ' b ', ''] }).models, ['a', 'b'])
})

test('resolveConfig: 缺模型名 / 非法 URL 都会给出可读报错', () => {
  assert.throws(() => resolveConfig({ baseURL: 'http://127.0.0.1:8080' }), /至少要配置一个模型名/u)
  assert.throws(() => resolveConfig({ ...BASE, baseURL: 'not a url' }), /不是合法 URL/u)
  assert.throws(() => resolveConfig({ ...BASE, baseURL: 'ftp://x/y' }), /只支持 http\/https/u)
  assert.throws(() => resolveConfig({ ...BASE, contextWindow: -1 }), /contextWindow 必须是正数/u)
})

test('toWireMessages: DSH 消息词表映射到 OpenAI 线格式', () => {
  const messages = toWireMessages({
    system: '系统提示',
    messages: [
      { role: 'system', content: [{ type: 'text', text: '历史系统消息' }] },
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '想一想' },
          { type: 'text', text: '我来查一下' },
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '文件内容' }] },
      { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x' } }] },
    ],
  })
  assert.deepEqual(messages, [
    { role: 'system', content: '系统提示' },
    { role: 'system', content: '历史系统消息' },
    { role: 'user', content: '你好' },
    {
      role: 'assistant',
      content: '我来查一下',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '文件内容' },
  ])
})

test('toWireBody: 工具与采样参数只在需要时出现', () => {
  const config = resolveConfig(BASE)
  const body = toWireBody(config, {
    provider: 'mnn-chat',
    model: 'Qwen3-4B',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'read', description: '', parameters: { type: 'object' } }],
    temperature: 0.3,
    maxTokens: 128,
  })
  assert.equal(body.stream, true)
  assert.equal(body.model, 'Qwen3-4B')
  assert.equal(body.temperature, 0.3)
  assert.equal(body.max_tokens, 128)
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.tools.length, 1)
  assert.equal(body.stream_options, undefined)
})

test('极简模式回归：装配被 complete 人设压掉时，插件提示词仍须自己挂到 wire 上', () => {
  // 复刻 dsh-web-app/presets/minimal.patch.yml 的 persona 行：
  //   prefix: 'You are a helpful software engineer assistant.'
  //   complete: true
  // complete:true 会让 assemble() 返回的 sections 只剩这一条，插件注册的
  // systemPrompt section 被整体丢弃。所以这里故意不给 options.system 里
  // 任何插件提示词的痕迹 —— 那正是极简模式下的真实输入。
  const config = resolveConfig({ ...BASE, systemPrompt: '你是久霖' })
  const body = toWireBody(config, {
    provider: 'mnn-chat',
    model: 'Qwen3-0.6B-MNN',
    system: 'You are a helpful software engineer assistant.',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你是谁' }] }],
  })
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You are a helpful software engineer assistant.' },
    { role: 'user', content: '你是谁' },
    // 关键：插件提示词作为最后一条 system 消息补上，与预设无关。
    { role: 'system', content: '你是久霖' },
  ])
})

test('toWireBody: 没写提示词时不凭空塞 system 消息', () => {
  const config = resolveConfig(BASE)
  assert.equal(config.systemPrompt, undefined)
  const body = toWireBody(config, {
    provider: 'mnn-chat',
    model: 'Qwen3-4B',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
})

test('toWireBody: 提示词与装配结果相同时不重复追加', () => {
  const config = resolveConfig({ ...BASE, systemPrompt: '你是久霖' })
  const body = toWireBody(config, {
    provider: 'mnn-chat',
    model: 'Qwen3-4B',
    system: '你是久霖',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.deepEqual(body.messages, [
    { role: 'system', content: '你是久霖' },
    { role: 'user', content: 'hi' },
  ])
})

test('apply: 注册路由并把 provider 声明进配置目录', () => {
  const ctx = makeCtx({ config: { ...BASE, displayName: '手机上的 MNN' } })
  apply(ctx)
  const registered = ctx.llm.adapters.get('mnn-chat')
  assert.ok(registered, '路由 mnn-chat 应已注册')
  assert.equal(registered.provider.name, '手机上的 MNN')
  assert.equal(typeof registered.retryPolicy?.mode, 'string')
  const directory = ctx.llm.directory.get('mnn-chat')
  assert.equal(directory.settingsNs, 'mnn-chat')
  // 空路径 = 本 provider 的配置就是 mnn-chat 这个 profile 条目 config 的根
  // （与 deepseek 官方行的约定一致：settingsNs: 'llm-deepseek' + 空路径）。
  assert.deepEqual([...directory.settingsPath], [])
  assert.equal(directory.declared, true)
  assert.ok(ctx.logs.some((entry) => entry.level === 'info' && entry.message.includes('mnn-chat')))
})

test('apply: 配置写错时不注册路由，但也不把整个 profile 拖崩', () => {
  const ctx = makeCtx({ config: { baseURL: 'http://127.0.0.1:8080' } }) // 没写 models
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(ctx.llm.adapters.size, 0)
  assert.ok(ctx.logs.some((entry) => entry.level === 'error'))
})

test('apply: 卸载时释放路由、目录与 HTTP 端点', () => {
  const server = new MockWebServer()
  const ctx = makeCtx({ config: BASE, webServer: server })
  apply(ctx)
  assert.deepEqual(
    [...server.routes.keys()],
    ['/dsh-mnn-chat/probe', '/dsh-mnn-chat/models', '/dsh-mnn-chat/state', '/dsh-mnn-chat/refresh', '/dsh-mnn-chat/settings'],
  )
  // 端点挂在 inject 子作用域里，卸载 = 收子作用域 + 收顶层 effect
  ctx.dispose()
  assert.equal(ctx.llm.adapters.size, 0)
  assert.equal(ctx.llm.directory.size, 0)
  assert.equal(server.routes.size, 0)
  assert.equal(ctx.logs.some((entry) => entry.level === 'warn'), false, '正常卸载不该有告警')
})

test('apply: webServer 比插件晚出现时，端点仍然会挂上（不能只在 apply 那一刻看一次）', () => {
  const server = new MockWebServer()
  // 先不给 webServer —— 模拟「插件先加载、Web 载波还没就绪」
  const ctx = makeCtx({ config: BASE })
  apply(ctx)
  assert.equal(ctx.llm.adapters.size, 1, '适配器不受影响')
  assert.equal(server.routes.size, 0)

  ctx.provide('webServer', server)
  assert.deepEqual(
    [...server.routes.keys()],
    ['/dsh-mnn-chat/probe', '/dsh-mnn-chat/models', '/dsh-mnn-chat/state', '/dsh-mnn-chat/refresh', '/dsh-mnn-chat/settings'],
    '服务一到齐就该补挂端点',
  )
})

test('apply: 无 Web 载波的组装里不注册端点，也不报错', () => {
  const ctx = makeCtx({ config: BASE })
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(ctx.llm.adapters.size, 1)
  assert.equal(ctx.logs.some((entry) => entry.level === 'error'), false)
})

// ---------------------------------------------------------------------------
// 回归：改配置 → Loader 重建插件实例时，端点不能被新旧实例互相踩掉
//
// 真实 webserver 的语义（helpers 里的 MockWebServer 照抄了）：
//   · 同一路径重复 register → 抛 duplicate
//   · 注销是**按路径删**，不看那条路由是谁注册的
// 曾经的写法（在 apply 里 ctx.get('webServer') 后直接 register）会两头坏事，
// 现象是「插件 fiber 还是 active、面板照常渲染，但所有端点 404」，
// 面板于是报「端点返回了非 JSON 内容（HTTP 404）」。
// ---------------------------------------------------------------------------

test('重建实例：新实例接管端点，旧实例的卸载不会把新端点删掉', async () => {
  const server = new MockWebServer()
  const first = makeCtx({ config: BASE, webServer: server })
  apply(first)
  assert.equal(server.routes.size, 5)

  // 新旧实例短暂共存：新实例先 apply（真实 reconcile 里就是这样交错）
  const second = makeCtx({ config: { ...BASE, baseURL: 'http://127.0.0.1:9' }, webServer: server })
  assert.doesNotThrow(() => apply(second), '新实例注册不能因为旧路由还在就抛 duplicate')
  assert.equal(server.routes.size, 5)

  // 旧实例这时才被卸载：它绝不能把新实例的端点删掉
  first.dispose()
  assert.equal(server.routes.size, 5, '旧实例卸载后端点必须还在')

  // 而且留下来的必须是新实例的 handler：配置里换过的地址要体现在响应里
  const state = await server.call('/dsh-mnn-chat/state')
  assert.equal(state.status, 200)
  assert.equal(state.payload.baseURL, 'http://127.0.0.1:9')

  second.dispose()
  assert.equal(server.routes.size, 0)
})

test('重建实例：提示词段落同样不会被旧实例的卸载摘掉', () => {
  const systemPrompt = new MockSystemPrompt()
  const server = new MockWebServer()
  const first = makeCtx({ config: { ...BASE, systemPrompt: '旧实例的提示词' }, webServer: server, systemPrompt })
  apply(first)
  assert.equal(systemPrompt.sections.length, 1)

  const second = makeCtx({ config: { ...BASE, systemPrompt: '新实例的提示词' }, webServer: server, systemPrompt })
  assert.doesNotThrow(() => apply(second), '同名 section 不能让新实例直接抛 duplicate')
  assert.equal(systemPrompt.sections.length, 1)
  assert.equal(systemPrompt.sections[0].text({}), '新实例的提示词')

  first.dispose()
  assert.equal(systemPrompt.sections.length, 1, '旧实例卸载后段落必须还在')
  assert.equal(systemPrompt.sections[0].text({}), '新实例的提示词')

  second.dispose()
  assert.equal(systemPrompt.sections.length, 0)
})

test('重建实例：一个端点注册失败不影响其它端点', () => {
  const server = new MockWebServer()
  // 先占掉 probe —— 但**不通过本模块的归属表**（模拟别人占了这条路）
  server.register({ kind: 'exact', path: '/dsh-mnn-chat/probe', handler: () => {} })
  const ctx = makeCtx({ config: BASE, webServer: server })
  // claimNamed 会先把上一个主人撤掉，所以这里应当成功接管
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(server.routes.size, 5)
  ctx.dispose()
})

test('systemPrompt: 配置了就注册一个独立的 section，不碰 DSH 自带的 persona 段', () => {
  const systemPrompt = new MockSystemPrompt()
  const ctx = makeCtx({ config: { ...BASE, systemPrompt: '回答尽量短。', systemPromptOrder: 9100 }, systemPrompt })
  apply(ctx)

  assert.equal(systemPrompt.sections.length, 1)
  const [section] = systemPrompt.sections
  assert.equal(section.name, 'provider:mnn-chat')
  assert.equal(section.order, 9100)
  // text 是函数：每次组装重新求值，面板里改了立刻生效，不用重建插件实例。
  assert.equal(typeof section.text, 'function')
  assert.equal(section.text({}), '回答尽量短。')
  // 必须关掉变量展开：未知 {{var}} 在 dsh-system-prompt 里是抛异常，
  // 用户随手写一对花括号就会让之后每一次模型调用都失败。
  assert.equal(section.interpolate, false)
  assert.equal(section.complete, undefined)
  // 绝不能撞上 registry 自己注册的这两个名字，否则真实实现会抛 duplicate。
  assert.notEqual(section.name, 'deployment:persona-prefix')
  assert.notEqual(section.name, 'deployment:persona-suffix')
  assert.ok(ctx.logs.some((entry) => entry.level === 'info' && entry.message.includes('provider:mnn-chat')))

  // 卸载要把它一起摘掉（段落挂在 inject 子作用域里）
  ctx.dispose()
  assert.equal(systemPrompt.sections.length, 0)
})

test('systemPrompt: 没配置也注册 section，但文本为空（组装时会把它过滤掉）', () => {
  const systemPrompt = new MockSystemPrompt()
  const ctx = makeCtx({ config: BASE, systemPrompt })
  apply(ctx)
  // 注册着才能「面板里写点什么就生效」，不必等插件重建。
  assert.equal(systemPrompt.sections.length, 1)
  assert.equal(systemPrompt.sections[0].text({}), '')
  // 空文本不会污染提示词：dsh-system-prompt 组装时会 filter(text.length > 0)。
  assert.equal(systemPrompt.sections[0].text({}).length, 0)
})

test('systemPrompt: 默认顺序落在第一方段落之间、persona 后缀之前', () => {
  const systemPrompt = new MockSystemPrompt()
  const ctx = makeCtx({ config: { ...BASE, systemPrompt: 'x' }, systemPrompt })
  apply(ctx)
  const order = systemPrompt.sections[0].order
  assert.ok(order > 0, '要排在 persona 前缀（0）之后')
  assert.ok(order < 9900, '要排在结构化输出（9900）之前')
  assert.ok(order < 10200, '要排在 persona 后缀（10200）之前')
  assert.equal(order, 9100)
})

test('systemPrompt: 组装里没有 systemPrompt 服务时不注册段落，但对话照常', async () => {
  const fake = await startFakeMnn(() => ({ chunks: [delta({ content: 'ok' }), end(), '[DONE]'] }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL, systemPrompt: '不该让插件挂掉' } })
  apply(ctx)
  // 现在用 ctx.inject：依赖没到就静静等着，不告警、不抛错、也不影响适配器。
  assert.equal(ctx.logs.some((entry) => entry.level === 'error'), false)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.equal(result.thrown, undefined)

  // 服务晚一点出现，段落就补上 —— 而不是永远不生效。
  const systemPrompt = new MockSystemPrompt()
  ctx.provide('systemPrompt', systemPrompt)
  assert.equal(systemPrompt.sections.length, 1)
  assert.equal(systemPrompt.sections[0].text({}), '不该让插件挂掉')
  await fake.close()
})

test('systemPrompt: order 不是有限数时配置解析就报错', () => {
  assert.throws(() => resolveConfig({ ...BASE, systemPrompt: 'x', systemPromptOrder: 'abc' }), /systemPromptOrder 必须是有限数字/u)
  assert.equal(resolveConfig({ ...BASE, systemPrompt: '   ' }).systemPrompt, undefined, '全空白等于没配')
})

test('stream: 基本文本流产出完整的块序列', async () => {
  const fake = await startFakeMnn(() => ({
    chunks: [delta({ content: '你好' }), delta({ content: '，世界' }), end('stop'), '[DONE]'],
  }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)

  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  assert.equal(result.thrown, undefined)
  assert.deepEqual(summarize(result.chunks), [
    'start:text#0',
    'text+"你好"',
    'text+"，世界"',
    'end:text#0',
    'finish:stop',
  ])
  assert.deepEqual(finalBlocks(result.chunks), [{ type: 'text', text: '你好，世界' }])

  const request = fake.requests[0]
  assert.equal(request.url, '/v1/chat/completions')
  assert.equal(request.body.stream, true)
  assert.ok(request.headers['user-agent'].startsWith('deepseek-harness/'), '必须带归因头')
  assert.equal(request.headers.authorization, undefined, '本地服务无需 Key 时不应带 Authorization')
  await fake.close()
})

test('stream: 配置了 apiKeyEnv 时按 Bearer 发送', async () => {
  const fake = await startFakeMnn(() => ({ chunks: [delta({ content: 'ok' }), end(), '[DONE]'] }))
  const ctx = makeCtx({
    config: { ...BASE, baseURL: fake.baseURL, apiKeyEnv: 'MNN_CHAT_API_KEY' },
    credentials: { resolve: async (ref) => (ref === 'MNN_CHAT_API_KEY' ? { value: 'sk-test-123' } : undefined) },
  })
  apply(ctx)
  await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.equal(fake.requests[0].headers.authorization, 'Bearer sk-test-123')
  await fake.close()
})

test('stream: 缺少声明的凭据时报 MISSING_CREDENTIAL', async () => {
  const fake = await startFakeMnn(() => ({ chunks: [delta({ content: 'ok' }), end(), '[DONE]'] }))
  const ctx = makeCtx({
    config: { ...BASE, baseURL: fake.baseURL, apiKeyEnv: 'MNN_CHAT_API_KEY' },
    credentials: { resolve: async () => undefined },
  })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.equal(result.thrown.code, 'MISSING_CREDENTIAL')
  await fake.close()
})

test('stream: usage 分片转成 DSH 的 TokenUsage', async () => {
  const fake = await startFakeMnn(() => ({
    chunks: [
      delta({ content: 'hi' }),
      end('stop', { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } } }),
      '[DONE]',
    ],
  }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  const usage = result.chunks.find((chunk) => chunk.type === 'usage')
  assert.deepEqual(usage.usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15, cacheReadTokens: 4 })
  assert.equal(result.chunks.at(-1).type, 'finish')
  await fake.close()
})

test('stream: 工具调用跨分片累积成完整 JSON 参数', async () => {
  const fake = await startFakeMnn(() => ({
    chunks: [
      delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"pa' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
      end('tool_calls'),
      '[DONE]',
    ],
  }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const result = await ctx.llm.stream({
    provider: 'mnn-chat',
    model: 'Qwen3-4B',
    messages: [],
    tools: [{ name: 'read', description: '', parameters: { type: 'object' } }],
  })
  assert.deepEqual(summarize(result.chunks), [
    'start:tool-call#0',
    'tool+read:"{\\"pa"',
    // 后续分片只有 arguments 增量，没有 name —— 与真实 OpenAI 流一致。
    'tool+:"th\\":\\"a.txt\\"}"',
    'end:tool-call#0',
    'finish:tool-calls',
  ])
  assert.deepEqual(finalBlocks(result.chunks), [
    { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"path":"a.txt"}' },
  ])
  assert.equal(fake.requests[0].body.tools.length, 1, '工具定义必须发出去，否则模型不会调用')
  await fake.close()
})

test('stream: 多个工具调用各占一个块，索引不串', async () => {
  const fake = await startFakeMnn(() => ({
    chunks: [
      delta({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'a', arguments: '{}' } }] }),
      delta({ tool_calls: [{ index: 1, id: 'c1', function: { name: 'b', arguments: '{}' } }] }),
      end('tool_calls'),
      '[DONE]',
    ],
  }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.deepEqual(finalBlocks(result.chunks), [
    { type: 'tool-call', id: 'c0', name: 'a', arguments: '{}' },
    { type: 'tool-call', id: 'c1', name: 'b', arguments: '{}' },
  ])
  await fake.close()
})

test('stream: 思维链作为 reasoning 块发出并保留', async () => {
  const fake = await startFakeMnn(() => ({
    chunks: [delta({ reasoning_content: '先想' }), delta({ reasoning_content: '一下' }), delta({ content: '答案' }), end(), '[DONE]'],
  }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.deepEqual(finalBlocks(result.chunks), [
    { type: 'reasoning', text: '先想一下' },
    { type: 'text', text: '答案' },
  ])
  await fake.close()
})

test('stream: 结尾没有 [DONE] 但给了 finish_reason 也算正常结束', async () => {
  const fake = await startFakeMnn(() => ({ chunks: [delta({ content: 'ok' }), end('stop')] }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.equal(result.thrown, undefined)
  assert.equal(result.chunks.at(-1).reason.kind, 'stop')
  await fake.close()
})

test('stream: finish_reason=length 映射成 max-tokens', async () => {
  const fake = await startFakeMnn(() => ({ chunks: [delta({ content: '半截' }), end('length'), '[DONE]'] }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.equal(result.chunks.at(-1).reason.kind, 'max-tokens')
  await fake.close()
})

test('stream: 流被截断（无 finish_reason）时判失败而不是假装成功', async () => {
  const fake = await startFakeMnn(() => ({ chunks: [delta({ content: '被截断' })] }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.equal(result.thrown.code, 'TRANSPORT')
  assert.equal(result.chunks.some((chunk) => chunk.type === 'finish'), false)
  await fake.close()
})

test('stream: 空回复报 EMPTY_RESPONSE', async () => {
  const fake = await startFakeMnn(() => ({ chunks: [end('stop'), '[DONE]'] }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.equal(result.thrown.code, 'EMPTY_RESPONSE')
  await fake.close()
})

test('stream: HTTP 401/404/429/500 各自映射到稳定失败码', async () => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'SERVER'], [400, 'INVALID_REQUEST']]) {
    const fake = await startFakeMnn(() => ({ status, json: { error: { message: `boom ${status}` } } }))
    const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL, retryPolicy: { maxRetries: 0 } } })
    apply(ctx)
    const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
    assert.equal(result.thrown.code, code, `HTTP ${status} → ${code}`)
    assert.match(result.thrown.message, new RegExp(`HTTP ${status}`, 'u'))
    assert.match(result.thrown.message, /boom/u, '应把服务端 detail 带出来')
    await fake.close()
  }
})

test('stream: Retry-After 会带进失败信息', async () => {
  const fake = await startFakeMnn(() => ({ status: 429, headers: { 'retry-after': '7' }, json: { error: { message: '慢点' } } }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL, retryPolicy: { maxRetries: 0 } } })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.equal(result.thrown.providerRetryAfterMs, 7000)
  assert.equal(result.thrown.status, 429)
  await fake.close()
})

test('stream: 404 时自动回退到裸路径 /chat/completions', async () => {
  const fake = await startFakeMnn((req) => {
    if (req.url === '/v1/chat/completions') return { status: 404, json: { error: { message: 'not found' } } }
    return { chunks: [delta({ content: '裸路径可用' }), end(), '[DONE]'] }
  })
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.equal(result.thrown, undefined)
  assert.deepEqual(finalBlocks(result.chunks), [{ type: 'text', text: '裸路径可用' }])
  assert.deepEqual(fake.requests.map((request) => request.url), ['/v1/chat/completions', '/chat/completions'])
  await fake.close()
})

test('stream: 两条路径都 404 时给出可操作的报错', async () => {
  const fake = await startFakeMnn(() => ({ status: 404, json: { error: { message: 'nope' } } }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.equal(result.thrown.code, 'NOT_FOUND')
  assert.match(result.thrown.message, /MNN Chat 的 API 服务已开启/u)
  await fake.close()
})

test('stream: 连不上时提示检查手机与网络', async () => {
  const fake = await startFakeMnn(() => ({ chunks: [end(), '[DONE]'] }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: 'http://127.0.0.1:1', retryPolicy: { maxRetries: 0 } } })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.equal(result.thrown.code, 'TRANSPORT')
  assert.match(result.thrown.message, /同一网络/u)
  await fake.close()
})

test('stream: 流读到一半被取消时归类为 aborted', async () => {
  const fake = await startFakeMnn(async () => {
    // 拖长一点，好让取消落在「正在读流」的时间窗里。
    await new Promise((resolve) => setTimeout(resolve, 60))
    return { chunks: [delta({ content: 'x' }), end(), '[DONE]'] }
  })
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const controller = new AbortController()
  const pending = ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [], signal: controller.signal })
  setTimeout(() => controller.abort(), 15)
  const result = await pending
  assert.equal(result.thrown.code, 'ABORTED')
  await fake.close()
})

test('stream: 开始前就已取消时一字节都不发', async () => {
  const fake = await startFakeMnn(() => ({ chunks: [delta({ content: 'x' }), end(), '[DONE]'] }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const controller = new AbortController()
  controller.abort()
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [], signal: controller.signal })
  assert.equal(result.thrown.code, 'ABORTED')
  assert.equal(fake.requests.length, 0)
  await fake.close()
})

test('stream: 流中带 error 字段时中断并报服务端错误', async () => {
  const fake = await startFakeMnn(() => ({
    chunks: [delta({ content: '开始' }), { error: { message: '模型被卸载了' } }, '[DONE]'],
  }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.equal(result.thrown.code, 'SERVER')
  assert.match(result.thrown.message, /模型被卸载了/u)
  await fake.close()
})

test('stream: 未知模型报 UNKNOWN_MODEL，且不会发对话请求', async () => {
  const fake = await startFakeMnn((req) => {
    if (req.method === 'GET') return { json: { data: [{ id: 'Qwen3-4B' }] } }
    return { chunks: [delta({ content: '不该走到这里' }), end(), '[DONE]'] }
  })
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: '不存在的模型', messages: [] })
  assert.equal(result.thrown.code, 'UNKNOWN_MODEL')
  // 允许一次 /v1/models 探测（模型名可能是服务端新加载的），但绝不能把对话请求发出去。
  assert.deepEqual(
    fake.requests.map((request) => `${request.method} ${request.url}`),
    ['GET /v1/models'],
  )
  await fake.close()
})

test('stream: 别的 provider 名打进来要明确拒绝', async () => {
  const ctx = makeCtx({ config: BASE })
  apply(ctx)
  const adapter = ctx.llm.adapters.get('mnn-chat').adapter
  await assert.rejects(() => adapter.resolveModel('deepseek-official', 'Qwen3-4B'), /只服务路由/u)
})

test('stream: 5xx 会按重试策略重试后成功', async () => {
  let calls = 0
  const fake = await startFakeMnn(() => {
    calls += 1
    if (calls === 1) return { status: 503, json: { error: { message: 'busy' } } }
    return { chunks: [delta({ content: '重试成功' }), end(), '[DONE]'] }
  })
  const ctx = makeCtx({
    config: { ...BASE, baseURL: fake.baseURL, retryPolicy: { maxRetries: 2, initialDelayMs: 5, maxDelayMs: 10, jitterRatio: 0 } },
  })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.equal(result.thrown, undefined)
  assert.deepEqual(finalBlocks(result.chunks), [{ type: 'text', text: '重试成功' }])
  assert.equal(fake.requests.length, 2)
  await fake.close()
})

test('listModels: 服务端在提供的排在前，配置里有但服务端没提供的排在后并标注', async () => {
  const fake = await startFakeMnn((req) => {
    assert.equal(req.url, '/v1/models')
    return { json: { data: [{ id: 'ModelScope/MNN/Qwen3.5-0.8B-MNN' }, { id: 'Qwen3-4B', name: '小模型' }] } }
  })
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL, models: ['Qwen3-4B', '已经下线的模型'] } })
  apply(ctx)
  const models = await ctx.llm.listModels('mnn-chat')
  assert.deepEqual(
    models.map((model) => model.id),
    ['ModelScope/MNN/Qwen3.5-0.8B-MNN', 'Qwen3-4B', '已经下线的模型'],
  )
  assert.equal(models[0].description, undefined, '服务端在提供的模型不该带提示')
  assert.match(models[2].description, /手机端此刻没有提供/u)
  await fake.close()
})

test('resolveModel: 手机换了模型后，服务端正在提供的模型不用改配置也能用', async () => {
  const fake = await startFakeMnn((req) => {
    if (req.method === 'GET') return { json: { data: [{ id: 'ModelScope/MNN/Qwen3.5-0.8B-MNN' }] } }
    return { chunks: [delta({ content: '0.8B 在此' }), end('stop'), '[DONE]'] }
  })
  // 配置里只写了旧的 2B，但手机上现在加载的是 0.8B
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL, models: ['ModelScope/MNN/Qwen3.5-2B-MNN'] } })
  apply(ctx)

  const info = await ctx.llm.resolveModel('mnn-chat', 'ModelScope/MNN/Qwen3.5-0.8B-MNN')
  assert.equal(info.id, 'ModelScope/MNN/Qwen3.5-0.8B-MNN')

  // 流式调用同样要认它
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'ModelScope/MNN/Qwen3.5-0.8B-MNN', messages: [] })
  assert.equal(result.thrown, undefined, JSON.stringify(result.thrown))
  assert.deepEqual(finalBlocks(result.chunks), [{ type: 'text', text: '0.8B 在此' }])

  // 而两边都没有的模型仍然要明确拒绝
  await assert.rejects(() => ctx.llm.resolveModel('mnn-chat', '凭空捏造的模型'), /不认识模型/u)
  await fake.close()
})

test('resolveModel: 手机掉线时仍认配置里的模型（不能被探测失败连累）', async () => {
  const fake = await startFakeMnn(() => ({ json: { data: [] } }))
  const port = Number(new URL(fake.baseURL).port)
  await fake.close()
  const ctx = makeCtx({ config: { ...BASE, baseURL: `http://127.0.0.1:${port}`, models: ['Qwen3-4B'] } })
  apply(ctx)
  const info = await ctx.llm.resolveModel('mnn-chat', 'Qwen3-4B')
  assert.equal(info.id, 'Qwen3-4B')
})

test('listModels: 服务端探测失败时仍返回配置模型', async () => {
  const ctx = makeCtx({ config: { ...BASE, baseURL: 'http://127.0.0.1:1' } })
  apply(ctx)
  const models = await ctx.llm.listModels('mnn-chat')
  assert.deepEqual(models.map((model) => model.id), ['Qwen3-4B'])
})

test('listModels: 服务端没响应时不被拖住（模型选择器不能被手机卡死）', async () => {
  // 一个只接受连接、永不回包的「黑洞」服务端 —— 模拟手机掉线/服务假死。
  const { createServer } = await import('node:http')
  const blackhole = createServer(() => {})
  await new Promise((resolve) => blackhole.listen(0, '127.0.0.1', resolve))
  const { port } = blackhole.address()

  // 故意把请求级 timeoutMs 设得很大：目录探测必须用自己的短超时。
  const ctx = makeCtx({ config: { ...BASE, baseURL: `http://127.0.0.1:${port}`, timeoutMs: 120000 } })
  apply(ctx)
  const started = Date.now()
  const models = await ctx.llm.listModels('mnn-chat')
  const elapsed = Date.now() - started

  assert.deepEqual(models.map((model) => model.id), ['Qwen3-4B'], '黑洞服务端下仍要给出配置模型')
  assert.ok(elapsed < 5000, `目录探测必须在 5 秒内返回，实际 ${elapsed}ms`)
  blackhole.closeAllConnections?.()
  await new Promise((resolve) => blackhole.close(resolve))
})

test('listModels: 探测结果有缓存，连续调用不会反复打手机', async () => {
  let hits = 0
  const fake = await startFakeMnn(() => {
    hits += 1
    return { json: { data: [{ id: 'Qwen3-4B' }] } }
  })
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  await ctx.llm.listModels('mnn-chat')
  await ctx.llm.listModels('mnn-chat')
  await ctx.llm.listModels('mnn-chat')
  assert.equal(hits, 1, '60 秒内应命中缓存')
  await fake.close()
})

test('Accept 头按用途分开：目录探测走 application/json，对话以 JSON 开头兼容流', async () => {
  // 真机实测（2026-10-01，见 BUG.md）：`/v1/models` 收到 `Accept: text/event-stream`
  // 会回 406（稳定复现），而 `/v1/chat/completions` 对 Accept 完全不挑
  // （四种组合全部 200）。这里复刻第一条规则；对话端断言插件发出的新头部策略。
  const fake = await startFakeMnn((req) => {
    const wantsEvents = req.headers.accept === 'text/event-stream'
    if (req.url === '/v1/models') {
      if (wantsEvents) return { status: 406, json: { error: { message: 'Not Acceptable' } } }
      return { json: { data: [{ id: 'ModelScope/MNN/Qwen3.5-2B-MNN' }] } }
    }
    return { chunks: [delta({ content: '好的' }), end('stop'), '[DONE]'] }
  })
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL, models: ['ModelScope/MNN/Qwen3.5-2B-MNN'] } })
  apply(ctx)

  const models = await ctx.llm.listModels('mnn-chat')
  assert.deepEqual(models.map((model) => model.id), ['ModelScope/MNN/Qwen3.5-2B-MNN'])
  assert.equal(fake.requests[0].url, '/v1/models')
  assert.equal(fake.requests[0].headers.accept, 'application/json', '目录探测必须用 JSON accept')

  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'ModelScope/MNN/Qwen3.5-2B-MNN', messages: [] })
  assert.equal(result.thrown, undefined, JSON.stringify(result.thrown))
  assert.deepEqual(finalBlocks(result.chunks), [{ type: 'text', text: '好的' }])
  assert.equal(fake.requests[1].headers.accept, 'application/json, text/event-stream;q=0.9', '对话请求的 Accept 以 JSON 开头、事件流低权重跟后')
  await fake.close()
})

test('对话请求收到 406 时自动换通配 Accept 重试一次', async () => {
  // 模拟个别构建的内容协商怪癖：第一套头回 406，换 `*/*` 就正常。
  const seenAccepts = []
  let chatHits = 0
  const fake = await startFakeMnn((req) => {
    if (req.url === '/v1/models') return { json: { data: [{ id: 'Qwen3-4B' }] } }
    chatHits += 1
    seenAccepts.push(req.headers.accept)
    if (chatHits === 1) return { status: 406, json: { error: { message: 'Not Acceptable' } } }
    return { chunks: [delta({ content: '自愈成功' }), end('stop'), '[DONE]'] }
  })
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL, retryPolicy: { maxRetries: 0 } } })
  apply(ctx)
  const result = await ctx.llm.stream({ provider: 'mnn-chat', model: 'Qwen3-4B', messages: [] })
  assert.equal(result.thrown, undefined, JSON.stringify(result.thrown))
  assert.deepEqual(finalBlocks(result.chunks), [{ type: 'text', text: '自愈成功' }])
  assert.equal(chatHits, 2)
  assert.equal(seenAccepts[0], 'application/json, text/event-stream;q=0.9')
  assert.equal(seenAccepts[1], '*/*', '重试时必须换成通配 Accept')
  await fake.close()
})

test('目录探测收到 406 时自动换通配 Accept 重试一次', async () => {
  let probeHits = 0
  const seenAccepts = []
  const fake = await startFakeMnn((req) => {
    probeHits += 1
    seenAccepts.push(req.headers.accept)
    if (probeHits === 1) return { status: 406, json: { error: { message: 'Not Acceptable' } } }
    return { json: { data: [{ id: 'ModelScope/MNN/Qwen3-0.6B-MNN' }] } }
  })
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL, models: ['ModelScope/MNN/Qwen3-0.6B-MNN'] } })
  apply(ctx)
  const models = await ctx.llm.listModels('mnn-chat')
  assert.deepEqual(models.map((model) => model.id), ['ModelScope/MNN/Qwen3-0.6B-MNN'])
  assert.equal(probeHits, 2)
  assert.equal(seenAccepts[0], 'application/json')
  assert.equal(seenAccepts[1], '*/*', '目录探测重试时必须换成通配 Accept')
  await fake.close()
})

test('连通性测试（chatProbe）收到 406 时也会换通配 Accept 自愈', async () => {
  let chatHits = 0
  const fake = await startFakeMnn((req) => {
    if (req.method === 'GET') return { json: { data: [{ id: 'Qwen3-4B' }] } }
    chatHits += 1
    if (chatHits === 1) return { status: 406, json: { error: { message: 'Not Acceptable' } } }
    return { chunks: [delta({ content: '正常' }), end('stop'), '[DONE]'] }
  })
  const routes = []
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL }, webServer: { register: (value) => (routes.push(value), () => {}) } })
  apply(ctx)
  const route = routes.find((entry) => entry.path === '/dsh-mnn-chat/probe')
  const { status, payload } = await callRoute(route, { method: 'POST', body: { chat: true } })
  assert.equal(status, 200)
  assert.equal(payload.chat?.ok, true)
  assert.equal(payload.chat.reply, '正常')
  assert.equal(chatHits, 2, '406 后必须重试过一次')
  await fake.close()
})

test('listModels: 手机端短暂掉线时探测会重试并恢复', async () => {
  // 先起一个服务拿到端口再关掉：得到一个「暂时连不上」的地址，模拟 App 切后台。
  const first = await startFakeMnn(() => ({ json: { data: [{ id: 'Qwen3-4B' }] } }))
  const port = Number(new URL(first.baseURL).port)
  await first.close()

  // 探测的重试间隔是 200ms 起；在它重试之前把服务「重新开起来」。
  const socketProbe = { server: undefined }
  const revive = setTimeout(async () => {
    socketProbe.server = await startFakeMnn(() => ({ json: { data: [{ id: 'Qwen3-4B' }] } }), { port })
  }, 120)

  const ctx = makeCtx({
    config: { ...BASE, baseURL: `http://127.0.0.1:${port}`, retryPolicy: { maxRetries: 3, initialDelayMs: 200, maxDelayMs: 400, jitterRatio: 0 } },
  })
  apply(ctx)
  try {
    const models = await ctx.llm.listModels('mnn-chat')
    assert.deepEqual(models.map((model) => model.id), ['Qwen3-4B'], '服务恢复后应拿到服务端模型')
  } finally {
    clearTimeout(revive)
    await socketProbe.server?.close?.()
  }
})

test('resolveModel: 返回的元数据通过 DSH 的校验', async () => {
  const ctx = makeCtx({ config: { ...BASE, contextWindow: 8192, maxTokens: 2048 } })
  apply(ctx)
  const info = await ctx.llm.resolveModel('mnn-chat', 'Qwen3-4B')
  assert.deepEqual(info.context, { contextWindow: 8192 })
  assert.equal(info.defaultMaxTokens, 2048)
  assert.deepEqual(info.inputModalities, ['text'])
})

test('probe 端点：连接正常时返回模型列表', async () => {
  const fake = await startFakeMnn(() => ({ json: { data: [{ id: 'Qwen3-4B' }] } }))
  const routes = []
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL }, webServer: { register: (value) => (routes.push(value), () => {}) } })
  apply(ctx)
  const route = routes.find((entry) => entry.path === '/dsh-mnn-chat/probe')

  const response = await new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: undefined,
      body: '',
      writeHead(status, headers) {
        this.statusCode = status
        this.headers = headers
      },
      end(body) {
        this.body = body
        resolve(this)
      },
    }
    route.handler({ method: 'GET' }, res)
  })
  const payload = JSON.parse(response.body)
  assert.equal(response.statusCode, 200)
  assert.equal(payload.ok, true)
  assert.deepEqual(
    payload.serverModels,
    [{ id: 'Qwen3-4B', label: 'mnn-chat/Qwen3-4B', configured: true }],
    'probe 要连「选择器里会显示成什么」一起报出来',
  )
  assert.equal(payload.endpoint, `${fake.baseURL}/v1/chat/completions`)
  await fake.close()
})

test('probe 端点：连不上时返回 502 与失败原因', async () => {
  const routes = []
  const ctx = makeCtx({ config: { ...BASE, baseURL: 'http://127.0.0.1:1' }, webServer: { register: (value) => (routes.push(value), () => {}) } })
  apply(ctx)
  const route = routes.find((entry) => entry.path === '/dsh-mnn-chat/probe')
  const response = await new Promise((resolve) => {
    const res = {
      statusCode: 0,
      body: '',
      writeHead(status) {
        this.statusCode = status
      },
      end(body) {
        this.body = body
        resolve(this)
      },
    }
    route.handler({ method: 'GET' }, res)
  })
  const payload = JSON.parse(response.body)
  assert.equal(response.statusCode, 502)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /连不上|fetch failed|ECONNREFUSED/u)
  assert.equal(typeof payload.codeVersion, 'string')
})

test('/dsh-mnn-chat/models 端点：给出选择器里会出现的清单', async () => {
  const fake = await startFakeMnn((req) => {
    if (req.method === 'GET') return { json: { data: [{ id: 'ModelScope/MNN/Qwen3.5-0.8B-MNN' }] } }
    return { chunks: [delta({ content: 'ok' }), end(), '[DONE]'] }
  })
  const routes = []
  const ctx = makeCtx({
    config: { ...BASE, baseURL: fake.baseURL, models: ['ModelScope/MNN/Qwen3.5-0.8B-MNN', '已下线模型'] },
    webServer: { register: (value) => (routes.push(value), () => {}) },
  })
  apply(ctx)
  const route = routes.find((entry) => entry.path === '/dsh-mnn-chat/models')
  const { status, payload } = await callRoute(route)
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.displayName, 'MNN Chat', '端点要回显实际的 displayName')
  assert.match(payload.hint, /MNN Chat/u)
  assert.deepEqual(payload.models.map((model) => model.id), ['ModelScope/MNN/Qwen3.5-0.8B-MNN', '已下线模型'])
  assert.match(payload.models[1].description, /手机端此刻没有提供/u)
  // 显示名去掉手机端上报的前缀，换成我们自己的路由名；id 一个字不改
  assert.deepEqual(payload.models.map((model) => model.name), ['mnn-chat/Qwen3.5-0.8B-MNN', 'mnn-chat/已下线模型'])
  await fake.close()
})

// ---------------------------------------------------------------------------
// 模型显示名：只改 name，不改 id（选择器显示 name，派发用 id）
// ---------------------------------------------------------------------------

test('模型显示名：默认带 provider 前缀，协议字段 id 原样保留', async () => {
  const fake = await startFakeMnn(() => ({ json: { data: [{ id: 'ModelScope/MNN/Qwen3.5-0.8B-MNN' }] } }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL, models: ['ModelScope/MNN/Qwen3.5-0.8B-MNN'] } })
  apply(ctx)
  const adapter = ctx.llm.adapters.get('mnn-chat').adapter

  const catalog = await adapter.listModels('mnn-chat')
  assert.deepEqual(catalog.map((model) => model.name), ['mnn-chat/Qwen3.5-0.8B-MNN'])
  assert.deepEqual(catalog.map((model) => model.id), ['ModelScope/MNN/Qwen3.5-0.8B-MNN'], 'id 是协议字段，必须一个字不改')

  const info = await adapter.resolveModel('mnn-chat', 'ModelScope/MNN/Qwen3.5-0.8B-MNN')
  assert.equal(info.name, 'mnn-chat/Qwen3.5-0.8B-MNN')
  assert.equal(info.id, 'ModelScope/MNN/Qwen3.5-0.8B-MNN')
  await fake.close()
})

test('模型显示名：前缀取路由名（provider），不取可以随便改的 displayName', async () => {
  const fake = await startFakeMnn(() => ({ json: { data: [{ id: 'ModelScope/MNN/Qwen3-0.6B-MNN' }] } }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL, displayName: '我的手机', models: ['ModelScope/MNN/Qwen3-0.6B-MNN'] } })
  apply(ctx)
  const catalog = await ctx.llm.adapters.get('mnn-chat').adapter.listModels('mnn-chat')
  assert.equal(catalog[0].name, 'mnn-chat/Qwen3-0.6B-MNN', 'displayName 改成中文也不该影响前缀')
  await fake.close()
})

test('模型显示名：modelLabel=tail 时只显示末段（旧行为仍可用）', async () => {
  const fake = await startFakeMnn(() => ({ json: { data: [{ id: 'ModelScope/MNN/Qwen3.5-0.8B-MNN' }] } }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL, models: ['ModelScope/MNN/Qwen3.5-0.8B-MNN'], modelLabel: 'tail' } })
  apply(ctx)
  const catalog = await ctx.llm.adapters.get('mnn-chat').adapter.listModels('mnn-chat')
  assert.equal(catalog[0].name, 'Qwen3.5-0.8B-MNN')
  await fake.close()
})

test('模型显示名：modelLabel=full 时原样显示整个 id', async () => {
  const fake = await startFakeMnn(() => ({ json: { data: [{ id: 'ModelScope/MNN/Qwen3.5-0.8B-MNN' }] } }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL, models: ['ModelScope/MNN/Qwen3.5-0.8B-MNN'], modelLabel: 'full' } })
  apply(ctx)
  const catalog = await ctx.llm.adapters.get('mnn-chat').adapter.listModels('mnn-chat')
  assert.equal(catalog[0].name, 'ModelScope/MNN/Qwen3.5-0.8B-MNN')
  await fake.close()
})

test('模型显示名：尾段撞名时自动带上父段，避免两个选项长得一模一样', async () => {  const fake = await startFakeMnn(() => ({ json: { data: [{ id: 'ModelScope/MNN/Qwen3-4B' }, { id: 'Other/Repo/Qwen3-4B' }] } }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL, models: ['ModelScope/MNN/Qwen3-4B'] } })
  apply(ctx)
  const catalog = await ctx.llm.adapters.get('mnn-chat').adapter.listModels('mnn-chat')
  assert.deepEqual(catalog.map((model) => model.name), ['mnn-chat/MNN/Qwen3-4B', 'mnn-chat/Repo/Qwen3-4B'])
  await fake.close()
})

test('模型显示名：没有斜杠的 id 也带前缀', async () => {
  const fake = await startFakeMnn(() => ({ json: { data: [{ id: 'Qwen3-4B' }] } }))
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL } })
  apply(ctx)
  const catalog = await ctx.llm.adapters.get('mnn-chat').adapter.listModels('mnn-chat')
  assert.equal(catalog[0].name, 'mnn-chat/Qwen3-4B')
  await fake.close()
})

// ---------------------------------------------------------------------------
// 悬浮面板：/state 与 /settings
// ---------------------------------------------------------------------------

/** 每个面板测试用一个独立的 DSH_HOME，互不干扰。 */
function useTempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'mnn-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  return {
    dir,
    restore() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * 调一个 HTTP 端点，拿回 {status, payload}。
 * 带 body 时把 JSON 做成异步可迭代对象，模拟 Node 的 IncomingMessage。
 */
function callRoute(route, { method = 'GET', body } = {}) {
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
      end(text) {
        resolve({ status: this.statusCode, payload: JSON.parse(text) })
      },
    }
    route.handler(request, res)
  })
}

/** 起一个 MNN 替身 + apply 一次，返回按路径取端点的函数。 */
async function panelFixture(config = {}) {
  const fake = await startFakeMnn(() => ({ json: { data: [{ id: 'ModelScope/MNN/Qwen3.5-0.8B-MNN' }] } }))
  const routes = []
  const ctx = makeCtx({
    config: { ...BASE, baseURL: fake.baseURL, models: ['ModelScope/MNN/Qwen3.5-0.8B-MNN'], ...config },
    systemPrompt: new MockSystemPrompt(),
    webServer: { register: (value) => (routes.push(value), () => {}) },
  })
  apply(ctx)
  return { fake, ctx, route: (path) => routes.find((entry) => entry.path === path) }
}

test('面板 /state：报出连接、参数、提示词、密钥状态与来源', async () => {
  const home = useTempHome()
  try {
    const { fake, ctx, route } = await panelFixture({ systemPrompt: '配置里的提示词' })
    const { status, payload } = await callRoute(route('/dsh-mnn-chat/state'))
    assert.equal(status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.provider, 'mnn-chat')
    assert.equal(payload.displayName, 'MNN Chat')
    assert.equal(payload.baseURL, fake.baseURL)
    assert.equal(payload.endpoint, `${fake.baseURL}/v1/chat/completions`)
    assert.equal(payload.modelLabel, 'prefixed')
    assert.equal(payload.labelSample, 'mnn-chat/Qwen3.5-0.8B-MNN')
    assert.equal(payload.contextWindow, 32768)
    assert.equal(payload.maxTokens, 8192)
    assert.equal(payload.prompt.text, '配置里的提示词')
    assert.equal(payload.prompt.source, 'config')
    assert.equal(payload.prompt.section, 'provider:mnn-chat')
    assert.equal(payload.prompt.registered, true)
    assert.equal(payload.prompt.configText, '配置里的提示词')
    assert.equal(payload.file, join(home.dir, 'mnn-chat.panel.json'))
    assert.equal(payload.savedAt, null)
    // 每个字段当前来自哪一层，面板要如实标出来
    assert.deepEqual(payload.sources, {
      baseURL: 'config',
      modelLabel: 'config',
      models: 'config',
      contextWindow: 'config',
      maxTokens: 'config',
      apiKeyEnv: 'config',
      systemPrompt: 'config',
    })
    // 密钥只报状态，绝不回显明文
    assert.deepEqual(payload.apiKey, { ref: null, configured: false, source: null, writable: false, hint: payload.apiKey.hint })
    assert.match(payload.apiKey.hint, /没有 apiKeyEnv/u)
    await fake.close()
    void ctx
  } finally {
    home.restore()
  }
})

test('面板 /settings：保存后立刻生效，不用重启也不用重建插件', async () => {
  const home = useTempHome()
  try {
    const { fake, ctx, route } = await panelFixture()
    const settings = route('/dsh-mnn-chat/settings')

    const saved = await callRoute(settings, { method: 'POST', body: { systemPrompt: '只用一句话回答。' } })
    assert.equal(saved.status, 200)
    assert.equal(saved.payload.ok, true)
    assert.equal(saved.payload.prompt.text, '只用一句话回答。')
    assert.equal(saved.payload.prompt.source, 'panel')
    assert.equal(saved.payload.prompt.registered, true)
    assert.deepEqual(saved.payload.changed, ['systemPrompt'])

    // 同一个插件实例（没有 rebuild），section 的 text 重新求值就该是新内容。
    assert.equal(ctx.promptSections.length, 1)
    assert.equal(ctx.promptSections[0].text({}), '只用一句话回答。')

    const state = await callRoute(route('/dsh-mnn-chat/state'))
    assert.equal(state.payload.prompt.text, '只用一句话回答。')
    assert.equal(state.payload.prompt.source, 'panel')

    // 落盘了，重启后还在
    const onDisk = JSON.parse(readFileSync(join(home.dir, 'mnn-chat.panel.json'), 'utf8'))
    assert.equal(onDisk.systemPrompt, '只用一句话回答。')
    assert.equal(typeof onDisk.savedAt, 'string')

    await fake.close()
  } finally {
    home.restore()
  }
})

test('面板 /settings：null 清除覆盖，回落到配置里的值', async () => {
  const home = useTempHome()
  try {
    const { fake, route } = await panelFixture({ systemPrompt: '配置里的提示词' })
    const settings = route('/dsh-mnn-chat/settings')
    await callRoute(settings, { method: 'POST', body: { systemPrompt: '面板写的' } })
    const cleared = await callRoute(settings, { method: 'POST', body: { systemPrompt: null } })
    assert.equal(cleared.payload.prompt.text, '配置里的提示词')
    assert.equal(cleared.payload.prompt.source, 'config')
    await fake.close()
  } finally {
    home.restore()
  }
})

test('面板 /settings：能改模型显示名，下一次 listModels 就是新显示名', async () => {
  const home = useTempHome()
  try {
    const { fake, ctx, route } = await panelFixture()
    const adapter = ctx.llm.adapters.get('mnn-chat').adapter
    assert.equal((await adapter.listModels('mnn-chat'))[0].name, 'mnn-chat/Qwen3.5-0.8B-MNN')

    const saved = await callRoute(route('/dsh-mnn-chat/settings'), { method: 'POST', body: { modelLabel: 'full' } })
    assert.equal(saved.payload.modelLabel, 'full')
    assert.equal(saved.payload.sources.modelLabel, 'panel')
    assert.equal((await adapter.listModels('mnn-chat'))[0].name, 'ModelScope/MNN/Qwen3.5-0.8B-MNN')
    assert.equal((await adapter.listModels('mnn-chat'))[0].id, 'ModelScope/MNN/Qwen3.5-0.8B-MNN')

    const back = await callRoute(route('/dsh-mnn-chat/settings'), { method: 'POST', body: { modelLabel: null } })
    assert.equal(back.payload.modelLabel, 'prefixed')
    assert.equal(back.payload.sources.modelLabel, 'config')
    await fake.close()
  } finally {
    home.restore()
  }
})

test('面板 /settings：改连接地址后，下一次调用立刻打到新地址（不用重启）', async () => {
  const home = useTempHome()
  try {
    const first = await startFakeMnn(() => ({ json: { data: [{ id: 'First/Model' }] } }))
    const second = await startFakeMnn(() => ({ json: { data: [{ id: 'Second/Model' }] } }))
    const routes = []
    const ctx = makeCtx({
      config: { ...BASE, baseURL: first.baseURL, models: ['First/Model'] },
      systemPrompt: new MockSystemPrompt(),
      webServer: { register: (value) => (routes.push(value), () => {}) },
    })
    apply(ctx)
    const adapter = ctx.llm.adapters.get('mnn-chat').adapter
    assert.deepEqual((await adapter.listModels('mnn-chat')).map((model) => model.id), ['First/Model'])

    // 面板把地址改到第二个服务（模拟手机上 IP 变了 / 换了一台手机）
    const settings = routes.find((entry) => entry.path === '/dsh-mnn-chat/settings')
    const saved = await callRoute(settings, { method: 'POST', body: { baseURL: second.baseURL } })
    assert.equal(saved.status, 200)
    assert.equal(saved.payload.baseURL, second.baseURL)
    assert.equal(saved.payload.sources.baseURL, 'panel')
    assert.equal(saved.payload.endpoint, `${second.baseURL}/v1/chat/completions`)

    // 同一个插件实例、同一个适配器对象：下一次探测就该打新地址。
    // 注意目录里仍会带上配置里那份兜底名单（此刻服务端没提供它），所以只断言排在最前的那个。
    const catalog = await adapter.listModels('mnn-chat')
    assert.equal(catalog[0].id, 'Second/Model', '服务端在提供的新模型要排在最前')
    assert.equal(second.requests.length > 0, true)
    assert.equal(first.requests.length, 1, '改完之后不该再打旧地址')

    // 清除覆盖就回到配置里的地址
    await callRoute(settings, { method: 'POST', body: { baseURL: null } })
    assert.equal((await adapter.listModels('mnn-chat'))[0].id, 'First/Model')
    await first.close()
    await second.close()
  } finally {
    home.restore()
  }
})

test('面板 /settings：模型名 / 上下文窗口 / 输出上限都能改', async () => {
  const home = useTempHome()
  try {
    const fake = await startFakeMnn(() => ({ json: { data: [] } }))
    const routes = []
    const ctx = makeCtx({
      config: { ...BASE, baseURL: fake.baseURL, models: ['Old/Model'] },
      systemPrompt: new MockSystemPrompt(),
      webServer: { register: (value) => (routes.push(value), () => {}) },
    })
    apply(ctx)
    const settings = routes.find((entry) => entry.path === '/dsh-mnn-chat/settings')
    const adapter = ctx.llm.adapters.get('mnn-chat').adapter

    const saved = await callRoute(settings, { method: 'POST', body: { models: ['A/One', 'B/Two'], contextWindow: 8192, maxTokens: 512 } })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.payload.configuredModels, ['A/One', 'B/Two'])
    assert.equal(saved.payload.contextWindow, 8192)
    assert.equal(saved.payload.maxTokens, 512)
    assert.deepEqual(saved.payload.sources, {
      baseURL: 'config',
      modelLabel: 'config',
      models: 'panel',
      contextWindow: 'panel',
      maxTokens: 'panel',
      apiKeyEnv: 'config',
      systemPrompt: 'none',
    })

    // 覆盖后的模型名立刻能被解析（服务端此刻一个模型都没提供）
    const info = await adapter.resolveModel('mnn-chat', 'A/One')
    assert.equal(info.id, 'A/One')
    assert.equal(info.context.contextWindow, 8192)
    assert.equal(info.defaultMaxTokens, 512)
    await fake.close()
  } finally {
    home.restore()
  }
})

test('面板 /settings：密钥写进 DSH 凭据，不落面板文件、不回显', async () => {
  const home = useTempHome()
  try {
    const written = []
    const fake = await startFakeMnn(() => ({ json: { data: [] } }))
    const routes = []
    const ctx = makeCtx({
      config: { ...BASE, baseURL: fake.baseURL, apiKeyEnv: 'MNN_CHAT_API_KEY' },
      systemPrompt: new MockSystemPrompt(),
      credentials: {
        // 照着真实语义：配置状态跟着最后一次写入走（写进去 → 已配置；清掉 → 未配置）。
        describe: async () => {
          const last = written.at(-1)
          const configured = last !== undefined && last.value !== null
          return { configured, source: configured ? 'credentials-file' : undefined, writable: true }
        },
        set: async (ref, value) => written.push({ ref, value }),
        unset: async (ref) => written.push({ ref, value: null }),
        resolve: async () => (written.at(-1)?.value === null ? undefined : { value: written.at(-1)?.value, source: 'credentials-file' }),
      },
      webServer: { register: (value) => (routes.push(value), () => {}) },
    })
    apply(ctx)
    const settings = routes.find((entry) => entry.path === '/dsh-mnn-chat/settings')

    const saved = await callRoute(settings, { method: 'POST', body: { apiKey: 'test-key-123' } })
    assert.equal(saved.status, 200)
    assert.deepEqual(written, [{ ref: 'MNN_CHAT_API_KEY', value: 'test-key-123' }])
    assert.match(saved.payload.credential, /MNN_CHAT_API_KEY/u)
    assert.equal(saved.payload.apiKey.configured, true)
    // 明文绝不进面板文件
    const onDisk = readFileSync(join(home.dir, 'mnn-chat.panel.json'), 'utf8')
    assert.equal(onDisk.includes('test-key-123'), false, '密钥不能落进面板文件')

    const cleared = await callRoute(settings, { method: 'POST', body: { clearApiKey: true } })
    assert.equal(cleared.status, 200)
    assert.deepEqual(written.at(-1), { ref: 'MNN_CHAT_API_KEY', value: null })
    assert.equal(cleared.payload.apiKey.configured, false)

    // 空字符串要被拒绝（否则等于把密钥清成空）
    const empty = await callRoute(settings, { method: 'POST', body: { apiKey: '   ' } })
    assert.equal(empty.status, 400)
    assert.match(empty.payload.error, /不能是空字符串/u)
    await fake.close()
  } finally {
    home.restore()
  }
})

test('面板 /settings：配置里没有 apiKeyEnv 时，存密钥会顺手把 apiKeyEnv 一起写上', async () => {
  const home = useTempHome()
  try {
    const written = []
    const fake = await startFakeMnn(() => ({ json: { data: [] } }))
    const routes = []
    const ctx = makeCtx({
      config: { ...BASE, baseURL: fake.baseURL },
      systemPrompt: new MockSystemPrompt(),
      credentials: { describe: async () => ({ configured: false, writable: true }), set: async (ref, value) => written.push({ ref, value }), unset: async () => {} },
      webServer: { register: (value) => (routes.push(value), () => {}) },
    })
    apply(ctx)
    const saved = await callRoute(routes.find((entry) => entry.path === '/dsh-mnn-chat/settings'), { method: 'POST', body: { apiKey: 'test-key-123' } })
    assert.equal(saved.status, 200)
    assert.deepEqual(written, [{ ref: 'MNN_CHAT_API_KEY', value: 'test-key-123' }])
    assert.equal(saved.payload.apiKey.ref, 'MNN_CHAT_API_KEY')
    assert.equal(saved.payload.sources.apiKeyEnv, 'panel')
    await fake.close()
  } finally {
    home.restore()
  }
})

test('面板 /settings：没有 credentials 服务时给出可操作的报错', async () => {
  const home = useTempHome()
  try {
    const fake = await startFakeMnn(() => ({ json: { data: [] } }))
    const routes = []
    const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL }, systemPrompt: new MockSystemPrompt(), webServer: { register: (value) => (routes.push(value), () => {}) } })
    apply(ctx)
    const bad = await callRoute(routes.find((entry) => entry.path === '/dsh-mnn-chat/settings'), { method: 'POST', body: { apiKey: 'test-key-123' } })
    assert.equal(bad.status, 400)
    assert.match(bad.payload.error, /\.credentials\.yaml/u)
    await fake.close()
  } finally {
    home.restore()
  }
})

test('面板 /settings：非法输入被拒绝，且不落盘', async () => {
  const home = useTempHome()
  try {
    const { fake, route } = await panelFixture()
    const settings = route('/dsh-mnn-chat/settings')

    const bad = await callRoute(settings, { method: 'POST', body: { modelLabel: 'short' } })
    assert.equal(bad.status, 400)
    assert.match(bad.payload.error, /modelLabel/u)

    const badType = await callRoute(settings, { method: 'POST', body: { systemPrompt: 42 } })
    assert.equal(badType.status, 400)
    assert.match(badType.payload.error, /systemPrompt/u)

    const badUrl = await callRoute(settings, { method: 'POST', body: { baseURL: 'ftp://x/y' } })
    assert.equal(badUrl.status, 400)
    assert.match(badUrl.payload.error, /只支持 http\/https/u)

    const badPort = await callRoute(settings, { method: 'POST', body: { baseURL: 'http://x:99999' } })
    assert.equal(badPort.status, 400)

    const unknown = await callRoute(settings, { method: 'POST', body: { nope: 1 } })
    assert.equal(unknown.status, 400)
    assert.match(unknown.payload.error, /不认识字段/u)

    const get = await callRoute(settings)
    assert.equal(get.status, 405)

    assert.equal(existsSync(join(home.dir, 'mnn-chat.panel.json')), false, '被拒绝的写入不该留下文件')
    await fake.close()
  } finally {
    home.restore()
  }
})

test('面板状态：文件坏掉 / 单个字段类型不对时只跳过那一个字段', async () => {
  const home = useTempHome()
  try {
    const file = join(home.dir, 'mnn-chat.panel.json')
    writeFileSync(file, '{ 这不是 JSON', 'utf8')
    const { fake, route } = await panelFixture({ systemPrompt: '配置里的提示词' })
    const { payload } = await callRoute(route('/dsh-mnn-chat/state'))
    assert.equal(payload.ok, true)
    assert.equal(payload.prompt.text, '配置里的提示词')
    assert.equal(payload.prompt.source, 'config')

    // 坏字段被跳过，同一份文件里的好字段照用
    writeFileSync(file, JSON.stringify({ systemPrompt: 123, modelLabel: 'nope', contextWindow: 4096, baseURL: 'http://127.0.0.1:9' }), 'utf8')
    const second = await callRoute(route('/dsh-mnn-chat/state'))
    assert.equal(second.payload.prompt.source, 'config', '坏掉的 systemPrompt 被跳过')
    assert.equal(second.payload.modelLabel, 'prefixed', '坏掉的 modelLabel 被跳过，回落到默认值')
    assert.equal(second.payload.contextWindow, 4096, '好字段照用')
    assert.equal(second.payload.baseURL, 'http://127.0.0.1:9')
    assert.equal(second.payload.sources.contextWindow, 'panel')
    await fake.close()
  } finally {
    home.restore()
  }
})

// ---------------------------------------------------------------------------
// 连通性测试：POST /probe { chat: true } 真的跑一次对话往返
// ---------------------------------------------------------------------------

test('probe 端点：POST chat:true 会真的跑一次对话往返并报模型名与耗时', async () => {
  const fake = await startFakeMnn((req) => {
    if (req.method === 'GET') return { json: { data: [{ id: 'ModelScope/MNN/Qwen3.5-0.8B-MNN' }] } }
    return { chunks: [delta({ content: '正常' }), end(), '[DONE]'] }
  })
  const routes = []
  const ctx = makeCtx({
    config: { ...BASE, baseURL: fake.baseURL, models: ['ModelScope/MNN/Qwen3.5-0.8B-MNN'] },
    webServer: { register: (value) => (routes.push(value), () => {}) },
  })
  apply(ctx)
  const route = routes.find((entry) => entry.path === '/dsh-mnn-chat/probe')

  const { status, payload } = await callRoute(route, { method: 'POST', body: { chat: true } })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.chat.ok, true)
  assert.equal(payload.chat.reply, '正常')
  assert.equal(payload.chat.model, 'ModelScope/MNN/Qwen3.5-0.8B-MNN')
  assert.equal(payload.chat.finishReason, 'stop')
  assert.equal(payload.chat.truncated, false)
  assert.equal(typeof payload.chat.ms, 'number')
  assert.equal(typeof payload.chat.firstTokenMs, 'number')
  // 用的是和正式对话同一条路径与同一套头
  const chatRequest = fake.requests.find((entry) => entry.method === 'POST')
  assert.match(chatRequest.url, /\/v1\/chat\/completions$/u)
  assert.equal(chatRequest.headers.accept, 'application/json, text/event-stream;q=0.9')
  assert.equal(chatRequest.body.model, 'ModelScope/MNN/Qwen3.5-0.8B-MNN')
  assert.equal(chatRequest.body.stream, true)
  await fake.close()
})

test('probe 端点：模型一个字的回复都没有时 ok=false，并说明是流被掐断', async () => {
  const fake = await startFakeMnn((req) => (req.method === 'GET' ? { json: { data: [{ id: 'Qwen3-4B' }] } } : { chunks: [] }))
  const routes = []
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL }, webServer: { register: (value) => (routes.push(value), () => {}) } })
  apply(ctx)
  const route = routes.find((entry) => entry.path === '/dsh-mnn-chat/probe')
  const { status, payload } = await callRoute(route, { method: 'POST', body: { chat: true } })
  assert.equal(status, 502)
  assert.equal(payload.ok, false)
  assert.equal(payload.chat.ok, false)
  assert.equal(payload.chat.reply, '')
  assert.equal(payload.chat.truncated, true)
  assert.match(payload.hint, /一个字的回复都没拿到/u)
  await fake.close()
})

test('probe 端点：连不上时 chat 测试也给出可操作的原因', async () => {
  const routes = []
  const ctx = makeCtx({ config: { ...BASE, baseURL: 'http://127.0.0.1:1' }, webServer: { register: (value) => (routes.push(value), () => {}) } })
  apply(ctx)
  const route = routes.find((entry) => entry.path === '/dsh-mnn-chat/probe')
  const { status, payload } = await callRoute(route, { method: 'POST', body: { chat: true } })
  assert.equal(status, 502)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /连不上|fetch failed|ECONNREFUSED/u)
})

// ---------------------------------------------------------------------------
// 模型目录自动拉取：后台刷新 + lastKnown 持久化 + 选择器合并
// ---------------------------------------------------------------------------

test('后台刷新器：列表变化才落盘，失败与关闭都不打手机', async () => {
  let current = ['ModelScope/MNN/A']
  let hits = 0
  const fake = await startFakeMnn(() => {
    hits += 1
    return { json: { data: current.map((id) => ({ id })) } }
  })
  const persisted = []
  const logs = []
  const adapter = {
    refreshCatalog: async () => {
      hits += 1
      return current.map((id) => ({ id }))
    },
  }
  const refresher = createCatalogRefresher({
    readConfig: () => resolveConfig({ ...BASE, baseURL: fake.baseURL }),
    getAdapter: () => adapter,
    getLastKnown: () => persisted.at(-1)?.ids ?? [],
    persist: (ids) => persisted.push({ ids, at: Date.now() }),
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  })

  // 第一次：拉到列表并落盘
  assert.deepEqual(await refresher.tick(), ['ModelScope/MNN/A'])
  assert.equal(persisted.length, 1)
  // 列表没变：不再落盘
  assert.equal(await refresher.tick(), true)
  assert.equal(persisted.length, 1)
  // 列表变了：落盘并返回新列表
  current = ['ModelScope/MNN/B', 'ModelScope/MNN/A']
  assert.deepEqual(await refresher.tick(), ['ModelScope/MNN/B', 'ModelScope/MNN/A'])
  assert.equal(persisted.length, 2)
  assert.deepEqual(persisted[1].ids, ['ModelScope/MNN/B', 'ModelScope/MNN/A'])
  // 失败：返回 false 并告警（第 3 次连续失败时说一声）
  adapter.refreshCatalog = async () => {
    throw new Error('手机离线')
  }
  await refresher.tick()
  await refresher.tick()
  await refresher.tick()
  assert.equal(persisted.length, 2, '失败时不能动持久化数据')
  assert.equal(logs.filter((m) => m.includes('后台刷新模型目录连续失败')).length, 1, '连续失败只告警一次')
  await fake.close()
})

test('后台刷新器：catalogRefreshMs=0 时完全关闭，不探测', async () => {
  let hits = 0
  const adapter = {
    refreshCatalog: async () => {
      hits += 1
      return [{ id: 'X' }]
    },
  }
  const refresher = createCatalogRefresher({
    readConfig: () => resolveConfig({ ...BASE, catalogRefreshMs: 0 }),
    getAdapter: () => adapter,
    getLastKnown: () => [],
    persist: () => {},
  })
  assert.equal(await refresher.tick(), false)
  assert.equal(hits, 0)
  refresher.start()
  refresher.stop()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(hits, 0, '关闭时不该有任何探测')
})

test('自动拉取：/refresh 强制重探并把结果持久化成最近已知列表', async () => {
  const home = useTempHome()
  try {
    const { fake, ctx, route } = await panelFixture()
    const refreshed = await callRoute(route('/dsh-mnn-chat/refresh'), { method: 'POST', body: '{}' })
    assert.equal(refreshed.status, 200)
    assert.equal(refreshed.payload.ok, true)
    assert.deepEqual(refreshed.payload.refreshed.models.map((model) => model.id), ['ModelScope/MNN/Qwen3.5-0.8B-MNN'])
    assert.equal(typeof refreshed.payload.refreshed.ms, 'number')

    // 落盘了，重启后还能用
    const onDisk = JSON.parse(readFileSync(join(home.dir, 'mnn-chat.panel.json'), 'utf8'))
    assert.deepEqual(onDisk.lastKnownModels, ['ModelScope/MNN/Qwen3.5-0.8B-MNN'])
    assert.equal(typeof onDisk.lastKnownAt, 'string')

    // /state 也报出来
    const state = await callRoute(route('/dsh-mnn-chat/state'))
    assert.deepEqual(state.payload.catalog.lastKnown.models, ['ModelScope/MNN/Qwen3.5-0.8B-MNN'])
    assert.equal(state.payload.catalog.lastKnown.at, onDisk.lastKnownAt)
    assert.equal(state.payload.catalog.refreshMs, 30000)
    assert.deepEqual(
      state.payload.catalog.cached.map((model) => model.id),
      ['ModelScope/MNN/Qwen3.5-0.8B-MNN'],
      '缓存里的服务端目录也要报给面板',
    )

    // GET /refresh 是 405
    const bad = await callRoute(route('/dsh-mnn-chat/refresh'))
    assert.equal(bad.status, 405)
    void ctx
    await fake.close()
  } finally {
    home.restore()
  }
})

test('自动拉取：手机换了模型，选择器自动出现新模型并持久化跟上', async () => {
  const home = useTempHome()
  try {
    let current = ['ModelScope/MNN/Qwen3.5-0.8B-MNN']
    const fake = await startFakeMnn(() => ({ json: { data: current.map((id) => ({ id })) } }))
    const routes = []
    const ctx = makeCtx({
      config: { ...BASE, baseURL: fake.baseURL, models: ['ModelScope/MNN/Qwen3.5-0.8B-MNN'] },
      systemPrompt: new MockSystemPrompt(),
      webServer: { register: (value) => (routes.push(value), () => {}) },
    })
    apply(ctx)
    const refresh = routes.find((entry) => entry.path === '/dsh-mnn-chat/refresh')
    const models = routes.find((entry) => entry.path === '/dsh-mnn-chat/models')

    // 手机上换成了 0.6B：强制刷新后，lastKnown 跟着变，选择器里新模型排最前
    current = ['ModelScope/MNN/Qwen3-0.6B-MNN']
    await callRoute(refresh, { method: 'POST', body: '{}' })
    const list = await callRoute(models)
    assert.deepEqual(
      list.payload.models.map((model) => model.id),
      ['ModelScope/MNN/Qwen3-0.6B-MNN', 'ModelScope/MNN/Qwen3.5-0.8B-MNN'],
      '手机此刻在提供的排最前，旧模型作为「最近提供过」跟在后面',
    )
    assert.match(list.payload.models[1].description, /此刻没有提供/u)
    const onDisk = JSON.parse(readFileSync(join(home.dir, 'mnn-chat.panel.json'), 'utf8'))
    assert.deepEqual(onDisk.lastKnownModels, ['ModelScope/MNN/Qwen3-0.6B-MNN'])

    // 手机掉线（服务关了）：选择器仍然给出最近已知列表 + 配置兜底
    const port = Number(new URL(fake.baseURL).port)
    await fake.close()
    const offline = await callRoute(models)
    assert.deepEqual(
      offline.payload.models.map((model) => model.id),
      ['ModelScope/MNN/Qwen3-0.6B-MNN', 'ModelScope/MNN/Qwen3.5-0.8B-MNN'],
    )
    assert.match(offline.payload.models[0].description, /最近提供过/u)
    assert.match(offline.payload.models[0].description, /没连上/u)

    // resolveModel 也认最近已知的 id（手机刚换模型、还没来得及刷新也能用）
    const adapter = ctx.llm.adapters.get('mnn-chat').adapter
    const info = await adapter.resolveModel('mnn-chat', 'ModelScope/MNN/Qwen3-0.6B-MNN')
    assert.equal(info.id, 'ModelScope/MNN/Qwen3-0.6B-MNN')
    await assert.rejects(() => adapter.resolveModel('mnn-chat', '凭空捏造'), /不认识模型/u)
    void port
  } finally {
    home.restore()
  }
})

test('自动拉取：后台轮询到点自动探测，插件卸载后停止', async () => {
  let hits = 0
  const fake = await startFakeMnn(() => {
    hits += 1
    return { json: { data: [{ id: 'Qwen3-4B' }] } }
  })
  const ctx = makeCtx({ config: { ...BASE, baseURL: fake.baseURL, catalogRefreshMs: 20 } })
  apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 120))
  const hitsWhileRunning = hits
  assert.ok(hitsWhileRunning >= 2, `20ms 间隔跑 120ms 应该至少探了 2 次，实际 ${hitsWhileRunning}`)

  // 卸载插件（DSH 重建/停用时会走这里）后，轮询必须停下来。
  // 注意：dispose 时刻可能有一次探测已经在途，先等它落地再取基准值。
  for (const dispose of ctx.effects) dispose()
  await new Promise((resolve) => setTimeout(resolve, 200))
  const hitsAfterDispose = hits
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(hits, hitsAfterDispose, '卸载后不该再探测')
  await fake.close()
})


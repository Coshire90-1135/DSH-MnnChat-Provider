// ---------------------------------------------------------------------------
// client.js（浏览器半边）的测试。
//
// 页面里的真实运行环境是 window.__ModuleLoader__ + 平台表里的 react，测试里
// 用两份最小替身顶上：
//   · 一个迷你 React（createElement / useState / useEffect），够跑通订阅与重渲染；
//   · 一个假 fetch，按 URL 回放 /state、/probe、/settings —— 这份替身照着
//     Host 半边 /state 的语义写，并记住面板写过的覆盖值，所以「点一下发了什么
//     请求」「界面回显对不对」两件事都能在没有浏览器的情况下验。
// ---------------------------------------------------------------------------
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

// —— 迷你 React：只实现这三个组件用到的那部分 ——
function createMiniReact() {
  let current = null
  let depth = 0

  function makeInstance(type, props) {
    const inst = { type, props, cells: [], effectDeps: [], cleanups: [], index: 0 }
    inst.run = () => {
      inst.index = 0
      const parent = current
      current = inst
      depth += 1
      if (depth > 40) throw new Error('迷你 React：重渲染层数过深（可能有循环 setState）')
      try {
        inst.tree = type(props)
      } finally {
        depth -= 1
        current = parent
      }
      return inst.tree
    }
    inst.tree = inst.run()
    return inst
  }

  const React = {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      if (typeof type === 'function') return makeInstance(type, merged).tree
      return { type, props: merged, children }
    },
    useState(initial) {
      if (current === null) throw new Error('迷你 React：useState 只能在组件渲染期间调用')
      const inst = current
      const index = inst.index
      inst.index += 1
      if (!(index in inst.cells)) inst.cells[index] = typeof initial === 'function' ? initial() : initial
      const set = (value) => {
        const next = typeof value === 'function' ? value(inst.cells[index]) : value
        if (Object.is(next, inst.cells[index])) return
        inst.cells[index] = next
        inst.run()
      }
      return [inst.cells[index], set]
    },
    useEffect(effect, deps) {
      if (current === null) return
      const inst = current
      const index = inst.index
      inst.index += 1
      const previous = inst.effectDeps[index]
      const changed = previous === undefined || deps === undefined || deps.length !== previous.length || deps.some((value, i) => !Object.is(value, previous[i]))
      if (!changed) return
      inst.effectDeps[index] = deps
      if (typeof inst.cleanups[index] === 'function') inst.cleanups[index]()
      inst.cleanups[index] = effect() ?? undefined
    },
  }

  /** 挂一个组件，拿回它的实例（`inst.tree` 永远是最新一次渲染的结果）。 */
  const mount = (type, props = {}) => makeInstance(type, props)
  return { React, mount }
}

/** 深度优先遍历元素树。 */
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
}

/** 收集树里所有满足条件的元素。 */
function findAll(tree, predicate) {
  const found = []
  walk(tree, (node) => {
    if (predicate(node)) found.push(node)
  })
  return found
}

/** 树里所有文本的拼接；跳过 <style> 里的 CSS。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => textOf(child)).join('')
  if (typeof node !== 'object') return ''
  if (node.type === 'style') return ''
  return textOf(node.props?.children)
}

/** 按可见文字找一个 <button>。 */
function buttonByText(tree, label) {
  const button = findAll(tree, (node) => node.type === 'button' && textOf(node).includes(label)).at(0)
  assert.ok(button, `没找到按钮「${label}」，树里有：${findAll(tree, (node) => node.type === 'button').map((node) => textOf(node)).join(' / ')}`)
  return button
}

/** 按 aria-label 找一个输入框。 */
function inputByLabel(tree, label) {
  const input = findAll(tree, (node) => (node.type === 'input' || node.type === 'textarea') && node.props?.['aria-label'] === label).at(0)
  assert.ok(input, `没找到输入框「${label}」`)
  return input
}

/** 按标题找一个区块（面板里每个区块都是 div.mnn-sec）。 */
function sectionOf(tree, title) {
  const section = findAll(tree, (node) => node.props?.className === 'mnn-sec' && textOf(node).includes(title)).at(0)
  assert.ok(section, `没找到区块「${title}」`)
  return section
}

/** 在指定区块里按文字找按钮 —— 面板里好几个区块都有「保存」，必须限定范围。 */
function buttonIn(tree, title, label) {
  return buttonByText(sectionOf(tree, title), label)
}

// —— 加载 client.js：它执行 window.__ModuleLoader__.load(...) ——
// window / document 上的监听器收集起来，测「Esc 关闭」与「点面板外面关闭」。
const harness = createMiniReact()
let definition = null
const listeners = { window: [], document: [] }
const bus = (scope) => ({
  addEventListener: (type, handler) => listeners[scope].push({ type, handler }),
  removeEventListener: (type, handler) => {
    const at = listeners[scope].findIndex((entry) => entry.type === type && entry.handler === handler)
    if (at !== -1) listeners[scope].splice(at, 1)
  },
})
globalThis.window = { __ModuleLoader__: { load: (value) => (definition = value) }, ...bus('window') }
globalThis.document = bus('document')
await import('../client.js')

/**
 * 造一个「点在哪个元素上」的假事件目标。
 * `closest` 用最小替身：只回答面板问的那两个选择器，够验「谁算面板内部」。
 * 真实 DOM 的 closest 会沿着祖先链找，这条链在浏览器里由 React 渲染出来。
 */
function fakeTarget({ inPanel = false, inToggle = false } = {}) {
  return {
    closest: (selector) => {
      if (selector === '[data-mnn-panel]') return inPanel ? {} : null
      if (selector === '[data-mnn-toggle]') return inToggle ? {} : null
      return null
    },
  }
}

/** 触发收集到的监听器（按注册顺序，capture 与否这里不区分）。 */
function fire(scope, type, event = {}) {
  for (const entry of [...listeners[scope]]) {
    if (entry.type === type) entry.handler(event)
  }
}

/** 记录注册情况并把三个组件取出来。 */
function mountPlugin() {
  const injected = []
  const registered = []
  const effects = []
  const ctx = {
    slots: {
      inject: (key, register) => {
        injected.push(key)
        const dispose = register()
        registered.at(-1).dispose = dispose
        return () => dispose?.()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
    get: () => undefined,
    effect: (factory) => {
      effects.push(factory())
      return () => {}
    },
  }
  const require = (name) => {
    if (name === 'react') return harness.React
    throw new Error(`client.js 不该 require「${name}」：平台表里只有 react 是基线`)
  }
  return { plugin: definition.factory(require), ctx, injected, registered, effects }
}

/**
 * 假 fetch + 一份照着 Host 半边语义写的迷你状态。
 * 面板写过的覆盖值会被记住，于是「保存后界面回显」也能验。
 */
function stubHost(calls) {
  const config = {
    provider: 'mnn-chat',
    displayName: 'ModelScope/MNN',
    baseURL: 'http://192.168.1.23:8080',
    contextWindow: 32768,
    maxTokens: 2048,
    models: ['ModelScope/MNN/Qwen3.5-0.8B-MNN'],
    modelLabel: 'prefixed',
    prompt: '配置里的提示词',
  }
  const overrides = {}
  const apiKey = { ref: 'MNN_CHAT_API_KEY', configured: true, source: 'credentials-file', writable: true }
  /** 手机端目录现状（/refresh 会更新 cached）。 */
  const catalog = {
    refreshMs: 30000,
    lastKnown: { at: null, models: [] },
    cached: null,
  }
  const snapshot = () => ({
    ok: true,
    codeVersion: '2026-10-02.1',
    provider: config.provider,
    displayName: config.displayName,
    baseURL: overrides.baseURL ?? config.baseURL,
    endpoint: `${overrides.baseURL ?? config.baseURL}/v1/chat/completions`,
    pathStyle: 'auto',
    contextWindow: overrides.contextWindow ?? config.contextWindow,
    maxTokens: overrides.maxTokens ?? config.maxTokens,
    configuredModels: overrides.models ?? config.models,
    modelLabel: overrides.modelLabel ?? config.modelLabel,
    labelSample: 'mnn-chat/Qwen3.5-0.8B-MNN',
    catalog: {
      refreshMs: catalog.refreshMs,
      lastKnown: { ...catalog.lastKnown },
      cached: catalog.cached === null ? null : catalog.cached.map((model) => ({ ...model })),
    },
    sources: {
      baseURL: overrides.baseURL === undefined ? 'config' : 'panel',
      modelLabel: overrides.modelLabel === undefined ? 'config' : 'panel',
      models: overrides.models === undefined ? 'config' : 'panel',
      contextWindow: overrides.contextWindow === undefined ? 'config' : 'panel',
      maxTokens: overrides.maxTokens === undefined ? 'config' : 'panel',
      apiKeyEnv: 'config',
      systemPrompt: overrides.systemPrompt === undefined ? 'config' : 'panel',
    },
    apiKey: { ...apiKey },
    prompt: {
      text: overrides.systemPrompt === undefined ? config.prompt : overrides.systemPrompt,
      source: overrides.systemPrompt === undefined ? 'config' : 'panel',
      order: 9100,
      section: 'provider:mnn-chat',
      registered: true,
      configText: config.prompt,
    },
    file: 'D:\\dsh\\home\\mnn-chat.panel.json',
    savedAt: null,
  })
  const json = (payload, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(payload) })
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url)
    const body = options.body === undefined ? undefined : JSON.parse(options.body)
    calls.push({ url: path, method: options.method ?? 'GET', body })
    if (path.endsWith('/state')) return json(snapshot())
    if (path.endsWith('/settings')) {
      for (const [key, value] of Object.entries(body)) {
        if (key === 'apiKey') {
          if (value === null) apiKey.configured = false
          else apiKey.configured = true
          continue
        }
        if (key === 'clearApiKey') {
          apiKey.configured = false
          continue
        }
        if (value === null) delete overrides[key]
        else overrides[key] = value
      }
      return json({ ...snapshot(), changed: Object.keys(body), credential: null, note: '已保存，下一次操作就生效' })
    }
    if (path.endsWith('/probe')) {
      if (options.method === 'POST') {
        return json({ ok: true, chat: { model: 'ModelScope/MNN/Qwen3-0.6B-MNN', ok: true, reply: '正常', ms: 812, firstTokenMs: 240, truncated: false } })
      }
      return json({
        ok: true,
        baseURL: 'http://192.168.1.23:8080',
        modelsMs: 37,
        serverModels: [{ id: 'ModelScope/MNN/Qwen3-0.6B-MNN', label: 'Qwen3-0.6B-MNN', configured: false }],
      })
    }
    if (path.endsWith('/refresh')) {
      catalog.lastKnown = { at: '2026-10-02T00:00:00.000Z', models: ['ModelScope/MNN/Qwen3-0.6B-MNN'] }
      catalog.cached = [{ id: 'ModelScope/MNN/Qwen3-0.6B-MNN', label: 'Qwen3-0.6B-MNN', configured: false }]
      return json({ ...snapshot(), refreshed: { ok: true, ms: 66, at: catalog.lastKnown.at, models: catalog.cached } })
    }
    throw new Error(`client.js 打了没预期的地址：${path}`)
  }
  return { calls }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
/** 打开面板并等它读完 /state。 */
async function openPanel(registered) {
  const panelEntry = registered.find((entry) => entry.options.name === 'shell.overlay')
  const toggleEntry = registered.find((entry) => entry.options.name === 'conversation.input.left')
  const toggle = harness.mount(toggleEntry.component)
  const panel = harness.mount(panelEntry.component)
  toggle.tree.props.onClick()
  await flush()
  await flush()
  return { panel, toggle }
}

after(() => {
  delete globalThis.fetch
})

test('client.js：模块 id 等于包名，只 require react，插件只注入 slots', () => {
  assert.equal(definition.id, 'dsh-mnn-chat', '浏览器模块 id 必须等于包名')
  const { plugin } = mountPlugin()
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots'])
})

test('client.js：三个入口挂到约定的槽位与键上', () => {
  const { plugin, ctx, injected, registered } = mountPlugin()
  plugin.apply(ctx)
  assert.deepEqual(injected, ['shell.overlay', 'conversation.input.left', 'settings.models.footer'])
  const bySlot = (name) => registered.find((entry) => entry.options.name === name)
  // 浮层面板：自己占一个 id，别覆盖别人的单元格
  assert.equal(bySlot('shell.overlay').options.id, 'mnn-chat.panel')
  assert.equal(bySlot('conversation.input.left').options.id, 'mnn-chat.toggle')
  assert.equal(bySlot('settings.models.footer').options.id, 'mnn-chat.entry')
  for (const entry of registered) assert.equal(typeof entry.component, 'function')
})

test('client.js：面板关着不渲染；点输入框按钮后打开并读到插件状态', async () => {
  const calls = []
  stubHost(calls)
  const { plugin, ctx, registered } = mountPlugin()
  plugin.apply(ctx)
  const toggleEntry = registered.find((entry) => entry.options.name === 'conversation.input.left')
  const panelEntry = registered.find((entry) => entry.options.name === 'shell.overlay')
  const toggle = harness.mount(toggleEntry.component)
  const panel = harness.mount(panelEntry.component)
  assert.equal(panel.tree, null, '关着的时候浮层里什么都不该有')
  assert.equal(toggle.tree.props['aria-pressed'], false)
  assert.equal(textOf(toggle.tree), 'MNN')

  toggle.tree.props.onClick()
  await flush()
  await flush()

  assert.ok(panel.tree !== null, '点一下应该把面板打开')
  assert.equal(toggle.tree.props['aria-pressed'], true)
  assert.deepEqual(calls.map((entry) => entry.url), ['/dsh-mnn-chat/state'])
  const text = textOf(panel.tree)
  assert.match(text, /ModelScope\/MNN/u, '面板顶部要显示 provider 显示名')
  assert.match(text, /192\.168\.1\.23:8080/u, '要显示服务地址')
  // 地址拆成了 协议 / 地址 / 端口 三个格子
  assert.equal(inputByLabel(panel.tree, '服务器地址').props.value, '192.168.1.23')
  assert.equal(inputByLabel(panel.tree, '端口').props.value, '8080')
  const scheme = findAll(panel.tree, (node) => node.type === 'button' && node.props['aria-pressed'] === true).map((node) => textOf(node))
  assert.ok(scheme.includes('http'), '协议默认 http')
  assert.equal(inputByLabel(panel.tree, '系统提示词').props.value, '配置里的提示词', '提示词编辑框预填当前生效的内容')
  assert.equal(inputByLabel(panel.tree, '兜底模型名').props.value, 'ModelScope/MNN/Qwen3.5-0.8B-MNN', '兜底模型名预填配置里的列表')
  assert.match(text, /跟随配置/u, '要标出每个字段当前来自哪里')
})

test('client.js：点面板外面或按 Esc 关闭；点面板里面和点开关都不关', async () => {
  const calls = []
  stubHost(calls)
  const { plugin, ctx, registered } = mountPlugin()
  plugin.apply(ctx)
  const toggle = harness.mount(registered.find((entry) => entry.options.name === 'conversation.input.left').component)
  const panel = harness.mount(registered.find((entry) => entry.options.name === 'shell.overlay').component)

  toggle.tree.props.onClick()
  await flush()
  assert.ok(panel.tree !== null)

  // 面板自己的 pointerdown（比如点输入框、拉滚动条）不该关
  fire('document', 'pointerdown', { target: fakeTarget({ inPanel: true }) })
  assert.ok(panel.tree !== null, '点面板里面不该关')

  // 开关按钮自己也标了 data-mnn-toggle：不排除的话它的 pointerdown 会先关、
  // 紧接着 onClick 又开，表现为「怎么点都关不掉」
  fire('document', 'pointerdown', { target: fakeTarget({ inToggle: true }) })
  assert.ok(panel.tree !== null, '点开关按钮本身不该被当成「点外面」')

  // 真正的「外面」：关闭，并且把监听器摘干净
  fire('document', 'pointerdown', { target: fakeTarget() })
  assert.equal(panel.tree, null, '点面板外面应该关掉')
  assert.equal(toggle.tree.props['aria-pressed'], false, '开关按钮的状态要跟着回去')

  // 再开一次，用 Esc 关
  toggle.tree.props.onClick()
  await flush()
  assert.ok(panel.tree !== null)
  fire('window', 'keydown', { key: 'Escape' })
  assert.equal(panel.tree, null, 'Esc 应该关掉')

  // 关掉之后不该再留着 document 上的监听器（否则会一直挂着手柄）
  assert.equal(listeners.document.filter((entry) => entry.type === 'pointerdown').length, 0, '关闭后要摘掉 document 监听器')
  assert.equal(listeners.window.filter((entry) => entry.type === 'keydown').length, 0, '关闭后要摘掉 keydown 监听器')
})

test('client.js：改地址与端口后保存，POST 出去的是合成好的完整 URL', async () => {
  const calls = []
  stubHost(calls)
  const { plugin, ctx, registered } = mountPlugin()
  plugin.apply(ctx)
  const { panel } = await openPanel(registered)

  inputByLabel(panel.tree, '服务器地址').props.onChange({ target: { value: '10.0.0.5' } })
  inputByLabel(panel.tree, '端口').props.onChange({ target: { value: '9090' } })
  await flush()
  assert.match(textOf(panel.tree), /→ http:\/\/10\.0\.0\.5:9090\/v1\/chat\/completions/u, '存之前就该看到最终地址')

  buttonByText(panel.tree, '保存').props.onClick()
  await flush()
  await flush()

  const posted = calls.find((entry) => entry.url === '/dsh-mnn-chat/settings')
  assert.deepEqual(posted.body, { baseURL: 'http://10.0.0.5:9090' })
  assert.match(textOf(panel.tree), /面板覆盖/u, '保存后来源标签要变成面板覆盖')
  assert.match(textOf(panel.tree), /已保存连接地址/u)
})
test('client.js：粘一个完整 https URL 会自动拆成协议 / 地址 / 端口', async () => {
  const calls = []
  stubHost(calls)
  const { plugin, ctx, registered } = mountPlugin()
  plugin.apply(ctx)
  const { panel } = await openPanel(registered)

  inputByLabel(panel.tree, '服务器地址').props.onChange({ target: { value: 'https://mnn.example.com:8443/proxy' } })
  await flush()
  const text = textOf(panel.tree)
  assert.equal(inputByLabel(panel.tree, '服务器地址').props.value, 'mnn.example.com/proxy')
  assert.equal(inputByLabel(panel.tree, '端口').props.value, '8443')
  assert.ok(findAll(panel.tree, (node) => node.type === 'button' && node.props['aria-pressed'] === true).map((node) => textOf(node)).includes('https'), '协议跟着切成 https')
  assert.match(text, /→ https:\/\/mnn\.example\.com:8443\/proxy\/v1\/chat\/completions/u)

  buttonByText(panel.tree, '保存').props.onClick()
  await flush()
  await flush()
  assert.deepEqual(calls.find((entry) => entry.url === '/dsh-mnn-chat/settings').body, { baseURL: 'https://mnn.example.com:8443/proxy' })
})

test('client.js：保存与清除 API Key 走的是两个不同的字段', async () => {
  const calls = []
  stubHost(calls)
  const { plugin, ctx, registered } = mountPlugin()
  plugin.apply(ctx)
  const { panel } = await openPanel(registered)

  // 没输入内容时保存密钥按钮应当是禁用的
  assert.equal(buttonByText(panel.tree, '保存密钥').props.disabled, true)
  inputByLabel(panel.tree, 'API Key').props.onChange({ target: { value: 'test-key-123' } })
  const save = buttonByText(panel.tree, '保存密钥')
  assert.equal(save.props.disabled, false)
  save.props.onClick()
  await flush()
  await flush()
  assert.deepEqual(calls.filter((entry) => entry.url === '/dsh-mnn-chat/settings').at(-1).body, { apiKey: 'test-key-123' })
  assert.equal(inputByLabel(panel.tree, 'API Key').props.value, '', '保存后输入框要清空，别把明文留在界面上')

  buttonByText(panel.tree, '清除').props.onClick()
  await flush()
  await flush()
  assert.deepEqual(calls.filter((entry) => entry.url === '/dsh-mnn-chat/settings').at(-1).body, { clearApiKey: true })
})

test('client.js：兜底模型名与参数分别保存', async () => {
  const calls = []
  stubHost(calls)
  const { plugin, ctx, registered } = mountPlugin()
  plugin.apply(ctx)
  const { panel } = await openPanel(registered)

  // 兜底模型名：一行一个，空行丢掉
  // （新区块「手机端模型（自动拉取）」的标题也含"模型"两个字，所以这里用
  //   只出现在「模型」区块里的文字来定位。）
  inputByLabel(panel.tree, '兜底模型名').props.onChange({ target: { value: 'ModelScope/MNN/Qwen3-0.6B-MNN\n\nModelScope/MNN/Qwen3.5-0.8B-MNN\n' } })
  buttonIn(panel.tree, '兜底模型名', '保存').props.onClick()
  await flush()
  await flush()
  assert.deepEqual(calls.filter((entry) => entry.url === '/dsh-mnn-chat/settings').at(-1).body, {
    models: ['ModelScope/MNN/Qwen3-0.6B-MNN', 'ModelScope/MNN/Qwen3.5-0.8B-MNN'],
  })

  // 参数：两个数字一起提交
  inputByLabel(panel.tree, '上下文窗口').props.onChange({ target: { value: '4096' } })
  inputByLabel(panel.tree, '单次输出上限').props.onChange({ target: { value: '512' } })
  buttonIn(panel.tree, '参数', '保存').props.onClick()
  await flush()
  await flush()
  assert.deepEqual(calls.filter((entry) => entry.url === '/dsh-mnn-chat/settings').at(-1).body, { contextWindow: 4096, maxTokens: 512 })
})

test('client.js：改提示词后保存，POST 的 body 与界面回执都对', async () => {
  const calls = []
  stubHost(calls)
  const { plugin, ctx, registered } = mountPlugin()
  plugin.apply(ctx)
  const { panel } = await openPanel(registered)

  inputByLabel(panel.tree, '系统提示词').props.onChange({ target: { value: '面板里改过的提示词' } })
  buttonIn(panel.tree, '系统提示词', '保存').props.onClick()
  await flush()
  await flush()

  assert.deepEqual(calls.find((entry) => entry.url === '/dsh-mnn-chat/settings').body, { systemPrompt: '面板里改过的提示词' })
  const text = textOf(panel.tree)
  assert.match(text, /已保存提示词/u)
  assert.match(text, /面板覆盖/u)
  assert.equal(inputByLabel(panel.tree, '系统提示词').props.value, '面板里改过的提示词')
})

test('client.js：清除覆盖发的是 null', async () => {
  const calls = []
  stubHost(calls)
  const { plugin, ctx, registered } = mountPlugin()
  plugin.apply(ctx)
  const { panel } = await openPanel(registered)

  inputByLabel(panel.tree, '系统提示词').props.onChange({ target: { value: '面板里改过的提示词' } })
  buttonIn(panel.tree, '系统提示词', '保存').props.onClick()
  await flush()
  await flush()
  // 保存之后才出现可用的「清除覆盖」
  const clear = buttonIn(panel.tree, '系统提示词', '清除覆盖')
  assert.equal(clear.props.disabled, false, '保存过覆盖之后，清除覆盖应当可用')
  clear.props.onClick()
  await flush()
  await flush()
  assert.deepEqual(calls.filter((entry) => entry.url === '/dsh-mnn-chat/settings').at(-1).body, { systemPrompt: null })
  assert.equal(inputByLabel(panel.tree, '系统提示词').props.value, '配置里的提示词', '清除后回落到配置里的内容')
})

test('client.js：连通性测试先探模型列表，再跑一次对话往返并显示结果', async () => {
  const calls = []
  stubHost(calls)
  const { plugin, ctx, registered } = mountPlugin()
  plugin.apply(ctx)
  const { panel } = await openPanel(registered)

  buttonByText(panel.tree, '测试连通性').props.onClick()
  await flush()
  await flush()
  await flush()

  assert.deepEqual(
    calls.filter((entry) => entry.url === '/dsh-mnn-chat/probe').map((entry) => entry.method),
    ['GET', 'POST'],
  )
  const text = textOf(panel.tree)
  assert.match(text, /服务地址/u)
  assert.match(text, /Qwen3-0\.6B-MNN/u, '要显示模型名（去掉前缀后的显示名）')
  assert.match(text, /配置里没写（也能直接用）/u)
  assert.match(text, /正常/u)
  assert.match(text, /240 毫秒/u, '要报首字延迟')
  assert.match(text, /812 毫秒/u, '要报总耗时')
  assert.match(text, /模型回复：正常/u)
})

test('client.js：端点报错时面板显示原因，而不是静默失败', async () => {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push({ url: String(url) })
    return { ok: false, status: 502, text: async () => JSON.stringify({ ok: false, error: '连不上手机上的 MNN 服务' }) }
  }
  const { plugin, ctx, registered } = mountPlugin()
  plugin.apply(ctx)
  const { panel } = await openPanel(registered)
  assert.match(textOf(panel.tree), /连不上手机上的 MNN 服务/u)
  assert.equal(calls.length, 1)
})

test('client.js：设置 → 模型页底部的入口能开面板并顺手测试', async () => {
  const calls = []
  stubHost(calls)
  const { plugin, ctx, registered } = mountPlugin()
  plugin.apply(ctx)
  const footerEntry = registered.find((entry) => entry.options.name === 'settings.models.footer')
  const panelEntry = registered.find((entry) => entry.options.name === 'shell.overlay')
  const panel = harness.mount(panelEntry.component)
  const footer = harness.mount(footerEntry.component)

  const text = textOf(footer.tree)
  assert.match(text, /MNN Chat（手机端）/u)
  assert.match(text, /打开面板/u)
  assert.match(text, /测试连通性/u)

  buttonByText(footer.tree, '测试连通性').props.onClick()
  await flush()
  await flush()
  await flush()
  await flush()
  assert.ok(panel.tree !== null, '从设置页点测试也要把面板打开（结果都显示在面板里）')
  assert.deepEqual(
    calls.map((entry) => entry.url),
    ['/dsh-mnn-chat/state', '/dsh-mnn-chat/probe', '/dsh-mnn-chat/probe'],
  )
})

test('client.js：手机端模型（自动拉取）区块能刷新并填写兜底', async () => {
  const calls = []
  stubHost(calls)
  const { plugin, ctx, registered } = mountPlugin()
  plugin.apply(ctx)
  const { panel } = await openPanel(registered)

  // 初始状态：还没拉到过任何列表
  const section = sectionOf(panel.tree, '手机端模型（自动拉取）')
  assert.match(textOf(section), /还没有从手机端拉到过模型列表/u)
  assert.match(textOf(section), /后台每 30 秒自动拉取一次/u)

  // 点「立即刷新」→ POST /refresh → 面板显示最新列表
  buttonIn(panel.tree, '手机端模型（自动拉取）', '立即刷新').props.onClick()
  await flush()
  await flush()
  assert.deepEqual(calls.filter((entry) => entry.url === '/dsh-mnn-chat/refresh').map((entry) => entry.method), ['POST'])
  const refreshed = sectionOf(panel.tree, '手机端模型（自动拉取）')
  assert.match(textOf(refreshed), /Qwen3-0\.6B-MNN/u, '刷新后要显示手机端报的模型')
  assert.match(textOf(panel.tree), /已刷新/u)

  // 「填进兜底」只是把 id 灌进编辑框，真正保存要用户再点「保存」
  buttonIn(panel.tree, '手机端模型（自动拉取）', '把这份列表填进兜底编辑框').props.onClick()
  assert.equal(inputByLabel(panel.tree, '兜底模型名').props.value, 'ModelScope/MNN/Qwen3-0.6B-MNN')
  assert.deepEqual(calls.filter((entry) => entry.url === '/dsh-mnn-chat/settings'), [], '填进编辑框不该直接发请求')
})

test('client.js：插槽服务缺席时不抛异常（插件静默不挂任何东西）', () => {
  const { plugin } = mountPlugin()
  assert.doesNotThrow(() => plugin.apply({ get: () => undefined, effect: () => () => {} }))
})

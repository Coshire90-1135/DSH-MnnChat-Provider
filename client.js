// ============================================================================
// dsh-mnn-chat 的浏览器半边：一个悬浮设置面板 + 两个入口
// ----------------------------------------------------------------------------
// 这是 package 的 client 半边（package.json 里的 dsh.client + "./client" 导出），
// 由 @deepseek-ai/dsh-client-modules 扫描后作为浏览器 bundle 提供给页面。
// 写法照官方模板：window.__ModuleLoader__.load({id: 包名, factory(require){...}})，
// factory 只注册、不产生副作用，模块体在首次使用时才执行。
//
// 面板能改的东西（全部走 Host 半边的 /dsh-mnn-chat/settings）：
//   · 连接：协议(http/https) + 地址 + 端口、API Key（写进 DSH 凭据，不回显明文）
//   · 模型：选择器里的显示名、手机没响应时的兜底模型名
//   · 参数：上下文窗口、单次输出上限
//   · 系统提示词
//   · 连通性测试（先探模型列表，再真的跑一次对话往返）
//
// 约定与坑（改之前先读）：
//  1. 只能 require 平台表里的模块（react 是基线）；**不能** require 任何
//     @deepseek-ai/* 客户端包 —— 它们不在平台表里，require 会直接抛。
//  2. 面板挂在 shell.overlay（全帧浮层，本身点击穿透），所以要自己
//     pointer-events: auto。
//  3. 样式只用 --dsw-alias-* 主题令牌，并且作为 React 元素渲染在组件里，
//     这样卸载时会被一起移除，不往 document 上留东西。
//  4. 数据全部走同源 fetch：面板不 import 宿主的任何服务，宿主代码改了也不用跟着改。
//  5. 任何一处抛异常都会让这个 slot 条目整块消失（console 里报
//     "slot entry crashed"），所以每个注册都单独 try/catch。
// ============================================================================

window.__ModuleLoader__.load({
  id: 'dsh-mnn-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Host 半边注册的端点前缀。 */
    const BASE = '/dsh-mnn-chat'

    // ------------------------------------------------------------------
    // 共享状态：三个入口（浮层面板、输入框按钮、设置页那一行）
    // 是三个独立的 React 根，靠这个小 store 同步开关与数据。
    // ------------------------------------------------------------------
    const listeners = new Set()
    const state = {
      open: false,
      /** idle | loading | ready | error */
      phase: 'idle',
      /** /state 的返回值 */
      info: null,
      error: '',
      saving: false,
      /** 保存/测试后给人看的一句话 */
      note: '',
      noteTone: 'ok',
      testing: false,
      /** 测试结果：{ probe, chat, chatError } */
      test: null,
      testError: '',
      /** 强制刷新手机端模型目录中 */
      refreshing: false,
      /** 各区块的编辑草稿（打开面板时从 /state 灌进去） */
      draft: emptyDraft(),
    }
    function emptyDraft() {
      return { scheme: 'http', address: '', port: '', apiKey: '', models: '', contextWindow: '', maxTokens: '', prompt: '' }
    }
    function update(patch) {
      Object.assign(state, patch)
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // 一个订阅者出问题不该影响其它订阅者。
        }
      }
    }
    function patchDraft(patch) {
      update({ draft: { ...state.draft, ...patch } })
    }
    function useStore() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const listener = () => force((value) => value + 1)
        listeners.add(listener)
        return () => listeners.delete(listener)
      }, [])
      return state
    }

    // ------------------------------------------------------------------
    // 地址 ↔ 三个输入框
    // ------------------------------------------------------------------
    /** `http://host:8080/v1` → {scheme:'http', address:'host/v1', port:'8080'}。 */
    function splitBaseURL(text) {
      const raw = String(text ?? '').trim()
      const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw)
      const scheme = (match ? match[1] : 'http').toLowerCase()
      const rest = match ? match[2] : raw
      const slash = rest.indexOf('/')
      const head = slash === -1 ? rest : rest.slice(0, slash)
      const tail = slash === -1 ? '' : rest.slice(slash)
      const portMatch = /:(\d+)$/.exec(head)
      return {
        scheme: scheme === 'https' ? 'https' : 'http',
        address: (portMatch === null ? head : head.slice(0, portMatch.index)) + tail,
        port: portMatch === null ? '' : portMatch[1],
      }
    }

    /** 三个输入框 → 完整 URL（地址里已经写了端口就不动它）。 */
    function joinBaseURL(draft) {
      const text = String(draft.address ?? '')
        .trim()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      if (text.length === 0) return ''
      const slash = text.indexOf('/')
      const head = slash === -1 ? text : text.slice(0, slash)
      const tail = slash === -1 ? '' : text.slice(slash)
      const port = String(draft.port ?? '').trim()
      const withPort = /:\d+$/.test(head) || port.length === 0 ? head : `${head}:${port}`
      return `${draft.scheme === 'https' ? 'https' : 'http'}://${withPort}${tail}`
    }

    /** 把 /state 的返回值灌进各区块的草稿。 */
    function seed(info) {
      const url = splitBaseURL(info?.baseURL)
      return {
        scheme: url.scheme,
        address: url.address,
        port: url.port,
        apiKey: '',
        models: (info?.configuredModels ?? []).join('\n'),
        contextWindow: String(info?.contextWindow ?? ''),
        maxTokens: String(info?.maxTokens ?? ''),
        prompt: info?.prompt?.text ?? '',
      }
    }

    // ------------------------------------------------------------------
    // 与 Host 半边通信
    // ------------------------------------------------------------------
    async function call(path, options) {
      let response
      try {
        response = await fetch(`${BASE}${path}`, {
          ...options,
          headers: { accept: 'application/json', ...(options?.body === undefined ? {} : { 'content-type': 'application/json' }), ...(options?.headers ?? {}) },
        })
      } catch (error) {
        throw new Error(`调不到宿主端点 ${BASE}${path}（${error?.message ?? error}）。请确认页面是从 DSH 自己的 Web 地址打开的。`)
      }
      const text = await response.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        // 宿主里没有这条路由时，dsh-host-webserver 回的是「空响应体的 404」。
        // 最常见的成因：插件这一代没注册成功 —— 改配置会触发 Loader 重建插件实例，
        // 新旧实例短暂共存时会把端点互相踩掉（见 lib/index.js 里 claimNamed 的注释）。
        // 完整退出并重开 DSH 会重新挂上。
        payload =
          response.status === 404
            ? {
                ok: false,
                error: `端点 ${BASE}${path} 不存在（HTTP 404）：插件这一代没有把端点注册上。完整退出并重开 DSH 会重新挂上；若重启之后还是这样，请把这条报给维护者。`,
              }
            : { ok: false, error: `端点 ${BASE}${path} 返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 200)}` }
      }
      return { status: response.status, payload }
    }

    /** 拉一次 /state（连接 + 参数 + 提示词），顺手把草稿填上。 */
    async function refresh({ keepDraft = false } = {}) {
      update({ phase: 'loading', error: '' })
      try {
        const { payload } = await call('/state')
        if (payload.ok !== true) throw new Error(payload.error ?? '未知错误')
        update({ phase: 'ready', info: payload, error: '', draft: keepDraft ? state.draft : seed(payload) })
      } catch (error) {
        update({ phase: 'error', error: error?.message ?? String(error) })
      }
    }

    /**
     * 写回面板设置。body 里出现的字段会被覆盖（null = 清除该覆盖）。
     * @param {object} body 例如 { baseURL }、{ apiKey }、{ systemPrompt: null }。
     * @param {string} [label] 保存成功后提示语的前缀。
     */
    async function save(body, label = '已保存') {
      update({ saving: true, note: '' })
      try {
        const { payload } = await call('/settings', { method: 'POST', body: JSON.stringify(body) })
        if (payload.ok !== true) throw new Error(payload.error ?? '未知错误')
        update({
          saving: false,
          info: payload,
          draft: seed(payload),
          note: `${label}${payload.credential === null || payload.credential === undefined ? '' : ` · ${payload.credential}`}，下一次操作就生效`,
          noteTone: 'ok',
        })
      } catch (error) {
        update({ saving: false, note: `保存失败：${error?.message ?? String(error)}`, noteTone: 'error' })
      }
    }

    /** 连通性测试：先探模型列表，再真的跑一次对话往返。 */
    async function runTest() {
      update({ testing: true, test: null, testError: '' })
      try {
        const first = await call('/probe')
        if (first.payload.ok !== true) throw new Error(first.payload.error ?? `HTTP ${first.status}`)
        const chat = await call('/probe', { method: 'POST', body: JSON.stringify({ chat: true }) })
        update({
          testing: false,
          test: { probe: first.payload, chat: chat.payload.chat ?? null, chatError: chat.payload.ok === true ? '' : (chat.payload.error ?? '') },
        })
      } catch (error) {
        update({ testing: false, testError: error?.message ?? String(error) })
      }
    }

    /** 强制重探手机端 /v1/models：成功后把返回的最新状态灌回面板。 */
    async function refreshCatalog() {
      update({ refreshing: true, note: '' })
      try {
        const { status, payload } = await call('/refresh', { method: 'POST', body: '{}' })
        if (payload.ok !== true) throw new Error(payload.error ?? `HTTP ${status}`)
        update({
          refreshing: false,
          info: payload,
          note: `已刷新：手机端${(payload.refreshed?.models ?? []).length > 0 ? `报了 ${(payload.refreshed.models ?? []).length} 个模型` : '没有报任何模型'}（${payload.refreshed?.ms ?? '—'} 毫秒）`,
          noteTone: 'ok',
        })
      } catch (error) {
        update({ refreshing: false, note: `刷新失败：${error?.message ?? String(error)}`, noteTone: 'error' })
      }
    }

    function openPanel({ test = false } = {}) {
      update({ open: true, note: '' })
      void refresh().then(() => {
        if (test) void runTest()
      })
    }
    function closePanel() {
      update({ open: false })
    }

    // ------------------------------------------------------------------
    // 样式：只用主题令牌，跟随明暗主题
    // ------------------------------------------------------------------
    const CSS = `
.mnn-scope{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.mnn-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.mnn-chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mnn-chip[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.mnn-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.mnn-dot[data-state="ok"]{background:var(--dsw-alias-state-success-primary)}
.mnn-dot[data-state="bad"]{background:var(--dsw-alias-state-error-primary)}
.mnn-dot[data-state="busy"]{background:var(--dsw-alias-state-warn-primary)}
.mnn-panel{position:fixed;right:24px;bottom:104px;z-index:40;width:468px;max-width:calc(100vw - 32px);max-height:min(80vh,760px);display:flex;flex-direction:column;pointer-events:auto;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.28);overflow:hidden}
.mnn-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mnn-title{font-weight:600;font-size:13px}
.mnn-sub{color:var(--dsw-alias-label-secondary);font-size:11px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mnn-grow{flex:1;min-width:0}
.mnn-icon{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}
.mnn-icon:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mnn-body{padding:12px;overflow:auto;display:flex;flex-direction:column;gap:12px}
.mnn-sec{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 10px;display:flex;flex-direction:column;gap:7px}
.mnn-sec-head{display:flex;align-items:center;gap:8px}
.mnn-sec-title{font-size:12px;font-weight:600}
.mnn-field{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.mnn-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.mnn-btn{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.mnn-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.mnn-btn[disabled]{opacity:.5;cursor:default}
.mnn-btn[data-primary="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.mnn-input{height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.mnn-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.mnn-input[data-wide="true"]{flex:1;min-width:120px}
.mnn-input[data-narrow="true"]{width:76px}
.mnn-area{width:100%;box-sizing:border-box;min-height:88px;max-height:220px;resize:vertical;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.55}
.mnn-area:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.mnn-note{font-size:11px;color:var(--dsw-alias-label-secondary)}
.mnn-note[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.mnn-note[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.mnn-tag{font-size:10px;padding:1px 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.mnn-tag[data-tone="panel"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.mnn-card{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:7px 9px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:3px}
.mnn-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.mnn-row{display:flex;align-items:center;gap:8px;justify-content:space-between}
.mnn-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}
.mnn-seg > button{height:24px;padding:0 9px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.mnn-seg > button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mnn-list{margin:0;padding-left:16px}
`

    // ------------------------------------------------------------------
    // 小组件
    // ------------------------------------------------------------------
    /** 「面板覆盖 / 跟随配置」标签。 */
    function SourceTag(source) {
      if (source === undefined) return null
      const text = source === 'panel' ? '面板覆盖' : source === 'none' ? '未设置' : '跟随配置'
      return h('span', { className: 'mnn-tag', 'data-tone': source === 'panel' ? 'panel' : undefined }, text)
    }

    function Row(label, value) {
      return h('div', { className: 'mnn-row', key: label }, h('span', { className: 'mnn-label' }, label), h('span', { className: 'mnn-mono' }, value))
    }

    /** 一个区块的壳：标题 + 右上角来源标签 + 内容。 */
    function Section(title, extra, children) {
      return h(
        'div',
        { className: 'mnn-sec' },
        h('div', { className: 'mnn-sec-head' }, h('span', { className: 'mnn-sec-title' }, title), h('span', { className: 'mnn-grow' }), extra),
        ...children.filter(Boolean),
      )
    }

    // ------------------------------------------------------------------
    // 各区块
    // ------------------------------------------------------------------
    function TestSection({ testing, test, testError }) {
      return Section('连通性测试', test?.probe ? h('span', { className: 'mnn-note' }, `模型列表 ${test.probe.modelsMs} 毫秒`) : null, [
        h(
          'div',
          { className: 'mnn-field', key: 'run' },
          h('button', { className: 'mnn-btn', 'data-primary': 'true', disabled: testing, onClick: () => void runTest() }, testing ? '测试中…（手机端首次加载模型可能较慢）' : '测试连通性'),
          h('span', { className: 'mnn-note' }, '先探 /v1/models，再真的发一句话跑一次对话往返'),
        ),
        testError.length > 0 ? h('div', { className: 'mnn-note', key: 'err', 'data-tone': 'error' }, testError) : null,
        test?.probe
          ? h(
              'div',
              { className: 'mnn-card', key: 'probe' },
              Row('服务地址', test.probe.baseURL ?? '—'),
              Row('模型列表', `${(test.probe.serverModels ?? []).length} 个`),
              (test.probe.serverModels ?? []).length === 0
                ? h('div', { className: 'mnn-note' }, '手机端没提供任何模型：App 里先加载一个模型。')
                : h(
                    'ul',
                    { className: 'mnn-list' },
                    (test.probe.serverModels ?? []).map((model) =>
                      h(
                        'li',
                        { key: model.id },
                        h('span', null, model.label ?? model.id),
                        h('span', { className: 'mnn-note' }, model.configured ? ' · 配置里有' : ' · 配置里没写（也能直接用）'),
                        h('div', { className: 'mnn-mono' }, model.id),
                      ),
                    ),
                  ),
            )
          : null,
        test?.chat
          ? h(
              'div',
              { className: 'mnn-card', key: 'chat' },
              h(
                'div',
                { className: 'mnn-row' },
                h('span', { className: 'mnn-label' }, '对话往返'),
                h('span', { className: 'mnn-note', 'data-tone': test.chat.ok ? 'ok' : 'error' }, test.chat.ok ? '正常' : '没拿到回复'),
              ),
              Row('用的模型', test.chat.model ?? '—'),
              Row('首字延迟', test.chat.firstTokenMs === undefined ? '—' : `${test.chat.firstTokenMs} 毫秒`),
              Row('总耗时', `${test.chat.ms} 毫秒`),
              test.chat.reply ? h('div', { className: 'mnn-mono' }, `模型回复：${test.chat.reply}`) : null,
              test.chat.truncated ? h('div', { className: 'mnn-note', 'data-tone': 'error' }, '流被中途掐断（手机端常见：切后台会停服务）。') : null,
            )
          : null,
        test?.chatError ? h('div', { className: 'mnn-note', key: 'chaterr', 'data-tone': 'error' }, test.chatError) : null,
      ])
    }

    /** 「手机端此刻提供的模型」：自动拉取的现状 + 手动强制刷新。 */
    function CatalogSection({ info, saving, refreshing }) {
      const catalog = info?.catalog
      const cached = Array.isArray(catalog?.cached) ? catalog.cached : null
      const lastKnown = Array.isArray(catalog?.lastKnown?.models) ? catalog.lastKnown.models : []
      const shown = cached ?? []
      const stale = cached === null && lastKnown.length > 0
      const items = stale ? lastKnown.map((id) => ({ id, label: id })) : shown
      const refreshMs = catalog?.refreshMs ?? 0
      return Section('手机端模型（自动拉取）', null, [
        h(
          'div',
          { className: 'mnn-field', key: 'head' },
          h('button', { className: 'mnn-btn', 'data-primary': 'true', disabled: refreshing || saving, onClick: () => void refreshCatalog() }, refreshing ? '刷新中…' : '立即刷新'),
          h('span', { className: 'mnn-note' }, '强制问一次手机此刻在提供什么模型'),
        ),
        h(
          'div',
          { className: 'mnn-note', key: 'status' },
          refreshMs > 0
            ? `后台每 ${(refreshMs / 1000).toFixed(0)} 秒自动拉取一次；下面是最近一次的结果${stale ? `（${catalog?.lastKnown?.at ?? '时间未知'} 探到的，此刻没连上手机）` : ''}。`
            : '后台自动拉取已关闭（catalogRefreshMs=0），点「立即刷新」手动问一次。',
        ),
        items.length > 0
          ? h(
              'div',
              { className: 'mnn-card', key: 'list' },
              items.map((model) =>
                h(
                  'div',
                  { key: model.id },
                  h('span', null, model.label ?? model.id),
                  cached !== null && model.configured ? h('span', { className: 'mnn-note' }, ' · 配置里有') : null,
                  h('div', { className: 'mnn-mono' }, model.id),
                ),
              ),
              cached !== null && items.length > 0
                ? h(
                    'button',
                    { className: 'mnn-btn', disabled: saving, onClick: () => patchDraft({ models: items.map((model) => model.id).join('\n') }) },
                    '把这份列表填进兜底编辑框',
                  )
                : null,
            )
          : h('div', { className: 'mnn-note', key: 'empty' }, '还没有从手机端拉到过模型列表。手机开着 API 服务时点「立即刷新」；之后每次换模型这里会自动跟上。'),
      ])
    }

    function ConnectionSection({ info, draft, saving }) {
      const key = info?.apiKey
      return Section('连接', SourceTag(info?.sources?.baseURL), [
        h(
          'div',
          { className: 'mnn-field', key: 'addr' },
          h(
            'div',
            { className: 'mnn-seg' },
            h('button', { type: 'button', 'aria-pressed': draft.scheme === 'http', onClick: () => patchDraft({ scheme: 'http' }) }, 'http'),
            h('button', { type: 'button', 'aria-pressed': draft.scheme === 'https', onClick: () => patchDraft({ scheme: 'https' }) }, 'https'),
          ),
          h('input', {
            className: 'mnn-input',
            'data-wide': 'true',
            value: draft.address,
            spellCheck: false,
            placeholder: '192.168.1.23 或完整 URL',
            'aria-label': '服务器地址',
            onChange: (event) => {
              const value = event.target.value
              // 直接粘完整 URL 时，顺手把协议与端口拆到各自的格子里。
              if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())) patchDraft(splitBaseURL(value))
              else patchDraft({ address: value })
            },
          }),
          h('span', { className: 'mnn-label' }, '端口'),
          h('input', {
            className: 'mnn-input',
            'data-narrow': 'true',
            value: draft.port,
            inputMode: 'numeric',
            'aria-label': '端口',
            onChange: (event) => patchDraft({ port: event.target.value }),
          }),
          h('button', { className: 'mnn-btn', 'data-primary': 'true', disabled: saving, onClick: () => save({ baseURL: joinBaseURL(draft) }, '已保存连接地址') }, '保存'),
        ),
        h('div', { className: 'mnn-mono', key: 'preview' }, `→ ${joinBaseURL(draft) || '（地址不能为空）'}/v1/chat/completions`),
        h(
          'div',
          { className: 'mnn-field', key: 'key' },
          h('span', { className: 'mnn-label' }, 'API Key'),
          h('input', {
            className: 'mnn-input',
            'data-wide': 'true',
            type: 'password',
            value: draft.apiKey,
            spellCheck: false,
            autoComplete: 'off',
            placeholder: key?.configured === true ? '已配置；填新的会覆盖它' : '粘贴手机 App 里显示的密钥',
            'aria-label': 'API Key',
            onChange: (event) => patchDraft({ apiKey: event.target.value }),
          }),
          h('button', { className: 'mnn-btn', disabled: saving || draft.apiKey.length === 0, onClick: () => save({ apiKey: draft.apiKey }, '已保存密钥') }, '保存密钥'),
          h('button', { className: 'mnn-btn', disabled: saving || key?.configured !== true, onClick: () => save({ clearApiKey: true }, '已清除密钥') }, '清除'),
        ),
        h(
          'div',
          { className: 'mnn-note', key: 'keystate', 'data-tone': key?.configured === true ? 'ok' : 'error' },
          key?.configured === true
            ? `已配置：凭据 ${key.ref}${key.source ? `（来自 ${key.source}）` : ''}`
            : key?.ref
              ? `未配置：凭据 ${key.ref} 里还没有值`
              : '配置里没有 apiKeyEnv，请求不会带 Authorization 头',
        ),
        key?.hint ? h('div', { className: 'mnn-note', key: 'keyhint' }, key.hint) : null,
        key?.configured === true && key?.writable === false
          ? h(
              'div',
              { className: 'mnn-note', key: 'keyro', 'data-tone': 'error' },
              '这个凭据现在由更高优先级的来源（环境变量 / .env）提供，写不进去 —— 要在这里改，得先清掉那个来源。',
            )
          : null,
        h(
          'div',
          { className: 'mnn-note', key: 'notes' },
          '密钥存在 DSH 凭据里，不会写进面板文件，也不会回显。CORS 只约束浏览器直连手机服务；DSH 是从电脑进程里请求的，不受 CORS 限制，手机上开不开它都能用。地址支持 https://（前面挂了 TLS 反代时用，自签证书 Node 会拒绝）。',
        ),
      ])
    }

    function ModelSection({ info, draft, saving }) {
      const label = info?.modelLabel ?? 'prefixed'
      return Section('模型', SourceTag(info?.sources?.models), [
        h(
          'div',
          { className: 'mnn-field', key: 'label' },
          h('span', { className: 'mnn-label' }, '选择器里的显示名'),
          h(
            'div',
            { className: 'mnn-seg' },
            h('button', { type: 'button', 'aria-pressed': label === 'prefixed', disabled: saving, onClick: () => save({ modelLabel: 'prefixed' }, `已切换为带 ${info?.provider ?? 'mnn-chat'}/ 前缀`) }, '带 provider 前缀'),
            h('button', { type: 'button', 'aria-pressed': label === 'tail', disabled: saving, onClick: () => save({ modelLabel: 'tail' }, '已切换为只显示末段') }, '只显示末段'),
            h('button', { type: 'button', 'aria-pressed': label === 'full', disabled: saving, onClick: () => save({ modelLabel: 'full' }, '已切换为完整 id') }, '完整 id'),
          ),
          h('span', { className: 'mnn-grow' }),
          SourceTag(info?.sources?.modelLabel),
        ),
        h(
          'div',
          { className: 'mnn-note', key: 'labelnote' },
          `只改选择器里显示的名字，发给手机端的 id 一个字都不变。当前效果：${info?.labelSample ?? `${info?.provider ?? 'mnn-chat'}/Qwen3-0.6B-MNN`}（前缀取 DSH 的路由名，不是上面的显示名）。`,
        ),
        h(
          'div',
          { className: 'mnn-field', key: 'models' },
          h('span', { className: 'mnn-label' }, '兜底模型名'),
          h('span', { className: 'mnn-note' }, '手机没响应时也列出来的名字，一行一个'),
        ),
        h('textarea', {
          className: 'mnn-area',
          key: 'modelsarea',
          style: { minHeight: 54 },
          value: draft.models,
          spellCheck: false,
          placeholder: 'ModelScope/MNN/Qwen3-0.6B-MNN',
          'aria-label': '兜底模型名',
          onChange: (event) => patchDraft({ models: event.target.value }),
        }),
        h(
          'div',
          { className: 'mnn-field', key: 'modelactions' },
          h(
            'button',
            {
              className: 'mnn-btn',
              disabled: saving,
              onClick: () =>
                save(
                  {
                    models: draft.models
                      .split(/[\n,]/u)
                      .map((line) => line.trim())
                      .filter((line) => line.length > 0),
                  },
                  '已保存兜底模型名',
                ),
            },
            '保存',
          ),
          h('button', { className: 'mnn-btn', disabled: saving || info?.sources?.models !== 'panel', onClick: () => save({ models: null }, '已清除兜底模型名覆盖') }, '清除覆盖'),
        ),
      ])
    }

    function ParamsSection({ info, draft, saving }) {
      const overridden = info?.sources?.contextWindow === 'panel' || info?.sources?.maxTokens === 'panel'
      return Section('参数', null, [
        h(
          'div',
          { className: 'mnn-field', key: 'params' },
          h('span', { className: 'mnn-label' }, '上下文窗口'),
          h('input', {
            className: 'mnn-input',
            'data-narrow': 'true',
            value: draft.contextWindow,
            inputMode: 'numeric',
            'aria-label': '上下文窗口',
            onChange: (event) => patchDraft({ contextWindow: event.target.value }),
          }),
          SourceTag(info?.sources?.contextWindow),
          h('span', { className: 'mnn-grow' }),
          h('span', { className: 'mnn-label' }, '单次输出上限'),
          h('input', {
            className: 'mnn-input',
            'data-narrow': 'true',
            value: draft.maxTokens,
            inputMode: 'numeric',
            'aria-label': '单次输出上限',
            onChange: (event) => patchDraft({ maxTokens: event.target.value }),
          }),
          SourceTag(info?.sources?.maxTokens),
          h(
            'button',
            {
              className: 'mnn-btn',
              disabled: saving,
              onClick: () => save({ contextWindow: Number(draft.contextWindow), maxTokens: Number(draft.maxTokens) }, '已保存参数'),
            },
            '保存',
          ),
          h('button', { className: 'mnn-btn', disabled: saving || !overridden, onClick: () => save({ contextWindow: null, maxTokens: null }, '已清除参数覆盖') }, '清除覆盖'),
        ),
        h('div', { className: 'mnn-note', key: 'paramnote' }, '端侧模型窗口通常 4K–32K：报大了 DSH 会等到超限才压缩，请求会被服务端截断。'),
      ])
    }

    function PromptSection({ info, draft, saving }) {
      const source = info?.prompt?.source
      return Section('系统提示词', SourceTag(source === 'none' ? 'none' : source), [
        h('textarea', {
          className: 'mnn-area',
          key: 'area',
          value: draft.prompt,
          spellCheck: false,
          placeholder: '只对 MNN 这条路由生效的一段话。留空 = 不追加任何内容。',
          'aria-label': '系统提示词',
          onChange: (event) => patchDraft({ prompt: event.target.value }),
        }),
        h(
          'div',
          { className: 'mnn-field', key: 'actions' },
          h('button', { className: 'mnn-btn', 'data-primary': 'true', disabled: saving, onClick: () => save({ systemPrompt: draft.prompt }, '已保存提示词') }, '保存'),
          h('button', { className: 'mnn-btn', disabled: saving || source !== 'panel', onClick: () => save({ systemPrompt: null }, '已清除提示词覆盖') }, '清除覆盖'),
          h(
            'button',
            { className: 'mnn-btn', disabled: saving || !info?.prompt?.configText, onClick: () => save({ systemPrompt: info.prompt.configText }, '已填入配置里的提示词') },
            '用配置里的',
          ),
          h('span', { className: 'mnn-grow' }),
          h('span', { className: 'mnn-note' }, `${draft.prompt.length} 字 · 段落 ${info?.prompt?.section ?? '—'} @ ${info?.prompt?.order ?? '—'}`),
        ),
        info?.prompt?.registered === false
          ? h('div', { className: 'mnn-note', key: 'noreg', 'data-tone': 'error' }, '当前组装里没有 systemPrompt 服务，这段文字不会被送进模型。')
          : null,
        h('div', { className: 'mnn-note', key: 'literal' }, '这段是字面文本，不会展开 {{变量}}（写错一个花括号不会让模型调用失败）。'),
      ])
    }

    function Panel() {
      const snapshot = useStore()
      const open = snapshot.open
      React.useEffect(() => {
        if (!open || typeof window === 'undefined') return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') closePanel()
        }
        /**
         * 点面板以外的地方就关掉。
         * 用 document 的**捕获阶段** pointerdown，而不是 React 的 onClick：
         *  1. 捕获阶段早于冒泡，早于任何 onClick —— 不会和面板内按钮的点击抢顺序；
         *  2. 关闭发生在 pointerdown，用户按下鼠标的瞬间面板就消失，手感干脆。
         * 两种点击不算「外面」：
         *  · 面板自己（用 data 属性现查 DOM，而不是 ref —— 面板每次渲染都是新节点，
         *    ref 里留的是上一个节点，拿它做 contain 判断会把面板内点击误判成外面）；
         *  · 打开面板的那几个开关按钮（标了 data-mnn-toggle）：不排除的话，
         *    开关自己的 pointerdown 会先把面板关掉，紧接着 onClick 又把它开起来 ——
         *    结果是「怎么点都关不掉」。
         */
        const onPointerDown = (event) => {
          const target = event.target
          if (target === null || typeof target.closest !== 'function') return
          if (target.closest('[data-mnn-panel]') !== null) return
          if (target.closest('[data-mnn-toggle]') !== null) return
          closePanel()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        window.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          window.removeEventListener('keydown', onKey)
        }
      }, [open])
      if (!open) return null
      const info = snapshot.info
      const props = { info, draft: snapshot.draft, saving: snapshot.saving }
      return h(
        'div',
        { className: 'mnn-panel', role: 'dialog', 'aria-label': 'MNN Chat 面板', 'data-mnn-panel': 'true' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'mnn-head' },
          h('span', { className: 'mnn-title' }, info?.displayName ?? 'MNN Chat'),
          h('span', { className: 'mnn-sub mnn-grow' }, info ? `${info.provider} → ${info.baseURL}` : snapshot.phase === 'loading' ? '读取中…' : ''),
          h('button', { className: 'mnn-icon', type: 'button', title: '重新读取', 'aria-label': '重新读取', onClick: () => void refresh({ keepDraft: true }) }, '⟳'),
          h('button', { className: 'mnn-icon', type: 'button', title: '关闭', 'aria-label': '关闭', onClick: () => closePanel() }, '✕'),
        ),
        h(
          'div',
          { className: 'mnn-body' },
          snapshot.error.length > 0 ? h('div', { className: 'mnn-note', 'data-tone': 'error' }, `读不到插件状态：${snapshot.error}`) : null,
          TestSection(snapshot),
          CatalogSection(snapshot),
          ConnectionSection(props),
          ModelSection(props),
          ParamsSection(props),
          PromptSection(props),
          snapshot.note.length > 0 ? h('div', { className: 'mnn-note', 'data-tone': snapshot.noteTone }, snapshot.note) : null,
          h(
            'div',
            { className: 'mnn-scope' },
            info?.file ? h('div', { className: 'mnn-mono' }, `面板存档：${info.file}`) : null,
            info?.codeVersion ? h('div', { className: 'mnn-mono' }, `插件代码版本：${info.codeVersion}${info.savedAt ? ` · 上次保存 ${info.savedAt}` : ''}`) : null,
          ),
        ),
      )
    }

    // ------------------------------------------------------------------
    // 入口一：输入框工具行上的小按钮
    // ------------------------------------------------------------------
    function ComposerToggle() {
      const snapshot = useStore()
      const tone = snapshot.testing ? 'busy' : snapshot.test?.chat ? (snapshot.test.chat.ok ? 'ok' : 'bad') : snapshot.error ? 'bad' : 'idle'
      return h(
        'button',
        {
          className: 'mnn-chip',
          type: 'button',
          title: 'MNN Chat：连接设置、连通性测试与系统提示词',
          'aria-pressed': snapshot.open,
          // 标了 data-mnn-toggle 的按钮不会触发「点外面自动关」——
          // 否则它的 pointerdown 先关、onClick 再开，看起来像关不掉。
          'data-mnn-toggle': 'true',
          onClick: () => (snapshot.open ? closePanel() : openPanel()),
        },
        h('style', null, CSS),
        h('span', { className: 'mnn-dot', 'data-state': tone }),
        'MNN',
      )
    }

    // ------------------------------------------------------------------
    // 入口二：设置 → 模型 页底部的扩展区
    //
    // 为什么不挂 settings.models.provider-card（那张 provider 卡片上的扩展区）：
    // 它只在「目录行 + 设置命名空间」都解析出来时才派发，而设置命名空间要求
    // 插件导出带 toJSON 的 Config schema（dsh-settings 的 schema(entry) 读
    // fiber.runtime.Config）。本插件是个无 schema 的纯 JS 插件，那条路永远是空的。
    // settings.models.footer 是无条件渲染的，所以入口放这里。
    // ------------------------------------------------------------------
    function SettingsModelsFooter() {
      const snapshot = useStore()
      return h(
        'div',
        { className: 'mnn-scope', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12 } },
        h('style', null, CSS),
        h('span', { className: 'mnn-label' }, 'MNN Chat（手机端）'),
        h('button', { className: 'mnn-btn', type: 'button', 'data-mnn-toggle': 'true', onClick: () => openPanel() }, '打开面板'),
        h(
          'button',
          { className: 'mnn-btn', type: 'button', 'data-mnn-toggle': 'true', disabled: snapshot.testing, onClick: () => openPanel({ test: true }) },
          snapshot.testing ? '测试中…' : '测试连通性',
        ),
        h('span', { className: 'mnn-note' }, '地址、密钥、模型显示名、提示词都在悬浮面板里；对话页输入框左侧的 ● MNN 也能打开它。点面板外面或按 Esc 关闭。'),
      )
    }

    return {
      name: 'dsh-mnn-chat-panel',
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots ?? ctx.get?.('slots')
        if (slots === undefined) return
        /** 一个注册出问题不该连累其它两个入口。 */
        const mount = (key, register) => {
          try {
            ctx.effect(() => slots.inject(key, register))
          } catch (error) {
            console.error(`[dsh-mnn-chat] 挂载 ${key} 失败：`, error)
          }
        }
        mount('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'mnn-chat.panel', order: 20 }, Panel))
        mount('conversation.input.left', () => slots.register({ name: 'conversation.input.left', id: 'mnn-chat.toggle', order: 40 }, ComposerToggle))
        mount('settings.models.footer', () => slots.register({ name: 'settings.models.footer', id: 'mnn-chat.entry', order: 20 }, SettingsModelsFooter))
      },
    }
  },
})

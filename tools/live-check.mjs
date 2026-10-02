#!/usr/bin/env node
// ============================================================================
// 真机联调自检：不启动 DSH，直接在本进程里拉起插件的 Host 半边，
// 用它自己的端点去打真实手机上的 MNN Chat 服务。
//
// 和 tools/probe.mjs 的区别：probe.mjs 只测「网络通不通」；这个脚本走的是
// 插件真正的那几个 HTTP 端点（/probe、/probe{chat}、/state、/settings），
// 所以能验到配置归一化、覆盖层、密钥解析、SSE 解析这一整条链路 ——
// 而且不需要重启 DSH 就能跑（改了 lib/index.js 之后先跑这个）。
//
// 用法：
//   node tools/live-check.mjs http://192.168.1.23:8080 --key 你的API密钥
//   node tools/live-check.mjs --model ModelScope/MNN/Qwen3-0.6B-MNN
//
// 它不会碰你真实的 $DSH_HOME：面板状态写在一个临时目录里，跑完就删。
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resolveConfig, toWireBody } from '../lib/index.js'
import { makeCtx, MockSystemPrompt } from '../test/helpers.mjs'

// —— 参数 ——
const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const baseURL = args.find((value) => !value.startsWith('--') && value !== flag('--key') && value !== flag('--model')) ?? 'http://127.0.0.1:8080'
const apiKey = flag('--key')
const model = flag('--model')

// —— 干净的临时 $DSH_HOME ——
const home = mkdtempSync(join(tmpdir(), 'mnn-live-'))
process.env.DSH_HOME = home

const routes = []
const config = { baseURL, models: [model ?? 'ModelScope/MNN/占位-MNN'], apiKeyEnv: apiKey === undefined ? undefined : 'MNN_CHAT_API_KEY' }
const ctx = makeCtx({
  config,
  systemPrompt: new MockSystemPrompt(),
  credentials: { resolve: async () => (apiKey === undefined ? undefined : { value: apiKey, source: '命令行 --key' }) },
  webServer: { register: (route) => (routes.push(route), () => {}) },
})
apply(ctx)

const call = async (path, options = {}) => {
  const route = routes.find((entry) => entry.path === `/dsh-mnn-chat/${path}`)
  if (route === undefined) throw new Error(`插件没有注册 /dsh-mnn-chat/${path}`)
  const request = { method: options.method ?? 'GET' }
  if (options.body !== undefined) {
    const bytes = Buffer.from(JSON.stringify(options.body))
    request[Symbol.asyncIterator] = async function* () {
      yield bytes
    }
  }
  const response = await new Promise((resolve) => {
    route.handler(request, {
      statusCode: 0,
      writeHead(status) {
        this.statusCode = status
      },
      end(text) {
        resolve({ status: this.statusCode, payload: JSON.parse(text) })
      },
    })
  })
  return response
}

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✖'} ${label}${detail.length > 0 ? `：${detail}` : ''}`)
  if (!ok) failures += 1
}

try {
  console.log(`代码版本：${(await call('state')).payload.codeVersion}`)
  console.log(`目标地址：${baseURL}` + (apiKey === undefined ? '（不带密钥）' : '（带密钥）') + '\n')

  // 1) 只探模型列表
  const probe = await call('probe')
  if (probe.payload.ok !== true) {
    check('GET /probe 连通', false, `${probe.payload.code} ${probe.payload.error}`)
  } else {
    check('GET /probe 连通', true, `${probe.payload.modelsMs} 毫秒`)
    console.log(`  服务端模型：${probe.payload.serverModels.map((m) => `${m.label}（${m.id}）`).join('、') || '（空）'}`)
    check('服务端至少提供一个模型', probe.payload.serverModels.length > 0, probe.payload.hint)
  }

  // 2) 真的跑一次对话往返
  const chat = await call('probe', { method: 'POST', body: { chat: true, ...(model === undefined ? {} : { model }) } })
  check('POST /probe {chat:true} 拿到回复', chat.payload.chat?.ok === true, chat.payload.chat?.truncated ? '流被掐断' : chat.payload.error ?? '')
  if (chat.payload.chat) {
    console.log(`  用的模型：${chat.payload.chat.model}`)
    console.log(`  首字延迟：${chat.payload.chat.firstTokenMs ?? '—'} 毫秒，总耗时 ${chat.payload.chat.ms} 毫秒`)
    console.log(`  模型回复：${chat.payload.chat.reply || '（空）'}`)
  }

  // 3) 面板：改地址（写成同一个地址，验证覆盖层 + 立刻生效）
  const saved = await call('settings', { method: 'POST', body: { baseURL, systemPrompt: '只回答一个字。', modelLabel: 'tail' } })
  check('POST /settings 保存成功', saved.payload.ok === true, saved.payload.error ?? `${saved.payload.changed.join(', ')}`)
  check('保存后来源变成面板覆盖', saved.payload.sources.baseURL === 'panel' && saved.payload.prompt.source === 'panel')

  // 4) 覆盖之后立刻生效：section 的 text 是函数，重取就该是新内容
  check('提示词立刻生效（不用重建插件）', ctx.promptSections[0]?.text({}) === '只回答一个字。')

  // 5) 清掉覆盖，回落到配置
  await call('settings', { method: 'POST', body: { baseURL: null, systemPrompt: null, modelLabel: null } })
  const after = await call('state')
  check('清除覆盖后回落到配置', after.payload.sources.baseURL === 'config' && after.payload.prompt.source !== 'panel')

  // 6) 非法输入要被挡住
  const bad = await call('settings', { method: 'POST', body: { baseURL: 'ftp://x/y' } })
  check('非法地址被拒绝', bad.status === 400 && /http\/https/u.test(bad.payload.error), `HTTP ${bad.status}`)

  // 7) 极简模式回归：装配被 complete:true 人设压掉时，提示词仍须自己挂到 wire 上。
  //    这里用插件真正在用的那条路径（resolveConfig 读覆盖层 + toWireBody 拼 body），
  //    把 options.system 造成极简模式预设那句固定英文，看尾部有没有补上我们的提示词。
  await call('settings', { method: 'POST', body: { systemPrompt: '你是久霖' } })
  const state = await call('state')
  const wire = toWireBody(resolveConfig({ ...config, systemPrompt: state.payload.prompt.configText ?? '你是久霖' }), {
    provider: 'mnn-chat',
    model: model ?? 'ModelScope/MNN/占位-MNN',
    system: 'You are a helpful software engineer assistant.',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你是谁' }] }],
  })
  const tail = wire.messages.at(-1)
  check(
    '极简模式回归：提示词以尾部 system 消息送达',
    tail?.role === 'system' && tail?.content === '你是久霖',
    JSON.stringify(wire.messages.map((message) => `${message.role}:${String(message.content).slice(0, 12)}`)),
  )
  await call('settings', { method: 'POST', body: { systemPrompt: null } })
} catch (error) {
  check('自检本身没有抛异常', false, error?.stack ?? String(error))
} finally {
  // 注意用 delete 而不是赋 undefined：给 process.env 赋 undefined 会变成字符串 "undefined"。
  delete process.env.DSH_HOME
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // 临时目录删不掉不影响结论。
  }
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)

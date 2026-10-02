#!/usr/bin/env node
// 独立连通性自检：不经过 DSH，直接按插件使用的同一份协议打 MNN Chat 的服务。
// 用法：
//   node tools/probe.mjs http://192.168.1.23:8080
//   node tools/probe.mjs http://192.168.1.23:8080 --prompt "你好" --model Qwen3-4B
//
// 输出依次是：解析后的地址 → /v1/models 结果 → 一次真实 SSE 流式对话的分片。
// 只要这里能通，插件里填同一个 baseURL 就一定能通。

import { resolveConfig, toWireBody } from '../lib/index.js'

const args = process.argv.slice(2)
const baseURL = args.find((arg) => !arg.startsWith('--')) ?? 'http://127.0.0.1:8080'
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const prompt = flag('prompt', '用一句话自我介绍')
const modelArg = flag('model', undefined)
const apiKey = flag('key', process.env.MNN_CHAT_API_KEY)

const config = resolveConfig({ baseURL, models: [modelArg ?? 'probe'], apiKey })
const headers = { accept: 'application/json' }
if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`

console.log(`解析后的地址：${config.baseURL}`)

// —— 1. 模型列表 ——
let model = modelArg
try {
  const response = await fetch(`${config.baseURL}/v1/models`, { headers, signal: AbortSignal.timeout(10000) })
  const text = await response.text()
  console.log(`GET /v1/models → HTTP ${response.status}`)
  if (response.ok) {
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = undefined
    }
    const ids = []
    for (const entry of payload?.data ?? []) if (entry?.id !== undefined) ids.push(entry.id)
    for (const entry of payload?.models ?? []) ids.push(typeof entry === 'string' ? entry : entry?.id)
    console.log(ids.length > 0 ? `服务端模型：${ids.filter(Boolean).join(', ')}` : `（列表为空，原始返回：${text.slice(0, 200)}）`)
    if (model === undefined) model = ids.filter(Boolean)[0]
  } else {
    console.log(`（${text.slice(0, 200)}）`)
  }
} catch (error) {
  console.log(`GET /v1/models 失败：${error?.cause?.message ?? error?.message ?? error}`)
}

if (model === undefined) {
  console.error('\n没能确定模型名。请用 --model <手机上加载的模型名> 再试一次。')
  process.exit(2)
}
console.log(`\n使用模型：${model}`)

// —— 2. 一次真实流式对话 ——
// 注意：绝不能带 stream_options。实测 MNN Chat 收到它就一直不返回、最后断开连接
// （插件里对应 includeUsage，默认关闭）。
// Accept 与插件保持一致：application/json 在前（真机对 chat 端点不挑 Accept，
// 但 JSON 在前能避开个别构建内容协商的怪癖），text/event-stream 低权重跟在后面。
const body = toWireBody(
  { ...config, includeUsage: false, extraBody: undefined },
  { provider: 'mnn-chat', model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens: Number(flag('max-tokens', 256)) },
)
const streamHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream;q=0.9' }
if (apiKey !== undefined) streamHeaders.authorization = `Bearer ${apiKey}`

console.log(`POST /v1/chat/completions（stream）……\n`)
const started = Date.now()
let chars = 0
try {
  const response = await fetch(`${config.baseURL}/v1/chat/completions`, {
    method: 'POST',
    headers: streamHeaders,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })
  if (!response.ok) {
    console.error(`HTTP ${response.status}：${(await response.text()).slice(0, 400)}`)
    process.exit(1)
  }

  // 直接把整段 SSE 读完再解析：自检工具只需要看结果，
  // 不需要真的边收边渲染（那样反而容易在服务端提前断开时丢掉已收到的内容）。
  const raw = await response.text()
  if (raw.length === 0) {
    console.error(`服务端返回空响应（HTTP ${response.status}，content-type=${response.headers.get('content-type')}）。` +
      `常见原因：手机端模型正忙、被系统挂起，或请求带了 stream_options。`)
    process.exit(1)
  }
  let sawDone = false
  let finishReason
  for (const event of raw.split(/\r?\n\r?\n/u)) {
    for (const line of event.split(/\r?\n/u)) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        sawDone = true
        continue
      }
      let parsed
      try {
        parsed = JSON.parse(payload)
      } catch {
        continue
      }
      const choice = parsed?.choices?.[0]
      const delta = choice?.delta ?? {}
      const text = delta.content ?? delta.reasoning_content
      if (typeof text === 'string' && text.length > 0) {
        chars += text.length
        process.stdout.write(text)
      }
      if (choice?.finish_reason !== undefined && choice?.finish_reason !== null) finishReason = choice.finish_reason
    }
  }
  const elapsed = Date.now() - started
  console.log(`\n\n${sawDone ? '[DONE]' : '（服务端未发 [DONE]）'} 共 ${chars} 字，finish_reason=${finishReason ?? '无'}，总计 ${elapsed}ms`)
  if (!sawDone && finishReason === undefined) {
    console.error('流被截断，回复可能不完整。')
    process.exit(1)
  }
} catch (error) {
  console.error(`\n请求失败：${error?.cause?.message ?? error?.message ?? error}`)
  process.exit(1)
}

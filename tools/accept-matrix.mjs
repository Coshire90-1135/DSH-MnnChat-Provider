// 临时诊断：等到手机服务起来的瞬间，一口气把 chat 请求的头部/参数组合跑完。
// 手机服务会随 App 前后台闪断，所以顺序手测很容易全部落空。
// 用法: node tools/accept-matrix.mjs <服务地址> [密钥]
//   例: node tools/accept-matrix.mjs http://192.168.1.23:8080
import { setTimeout as delay } from 'node:timers/promises'

const base = process.argv[2]
const key = process.argv[3] ?? process.env.MNN_CHAT_API_KEY
if (!base) {
  console.log('用法: node tools/accept-matrix.mjs <服务地址> [密钥]')
  console.log('例:   node tools/accept-matrix.mjs http://192.168.1.23:8080')
  process.exit(2)
}
const auth = key === undefined ? {} : { authorization: `Bearer ${key}` }

/** 等到服务起来（/v1/models 返回 200）。 */
async function waitForService(maxWaitMs = 90000) {
  const deadline = Date.now() + maxWaitMs
  let attempts = 0
  while (Date.now() < deadline) {
    attempts += 1
    try {
      const response = await fetch(`${base}/v1/models`, { headers: { accept: 'application/json', ...auth }, signal: AbortSignal.timeout(3000) })
      if (response.ok) {
        const payload = await response.json()
        const ids = (payload.data ?? []).map((model) => model.id)
        console.log(`服务已就绪（第 ${attempts} 次探测，${((maxWaitMs - (deadline - Date.now())) / 1000).toFixed(1)} 秒）：${ids.join('、') || '（无模型）'}\n`)
        return ids[0]
      }
    } catch {
      // 继续等
    }
    await delay(400)
  }
  console.log(`等了 ${maxWaitMs / 1000} 秒服务都没起来，放弃。`)
  return undefined
}

const model = await waitForService()
if (model === undefined) process.exit(1)

const cases = [
  { label: 'stream=true  accept=text/event-stream', accept: 'text/event-stream', stream: true },
  { label: 'stream=true  accept=application/json', accept: 'application/json', stream: true },
  { label: 'stream=true  无 accept', accept: undefined, stream: true },
  { label: 'stream=true  accept=*/*', accept: '*/*', stream: true },
  { label: 'stream=false accept=application/json', accept: 'application/json', stream: false },
  { label: 'stream=false 无 accept', accept: undefined, stream: false },
]

for (const testCase of cases) {
  const headers = { 'content-type': 'application/json', ...auth }
  if (testCase.accept !== undefined) headers.accept = testCase.accept
  const started = Date.now()
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: testCase.stream, max_tokens: 8 }),
      signal: AbortSignal.timeout(20000),
    })
    const text = (await response.text()).slice(0, 160).replace(/\s+/gu, ' ')
    console.log(`${testCase.label.padEnd(42)} -> HTTP ${response.status}  ${Date.now() - started}ms  ${text}`)
  } catch (error) {
    console.log(`${testCase.label.padEnd(42)} -> 失败 ${Date.now() - started}ms  ${error?.message ?? error}`)
  }
  await delay(200)
}

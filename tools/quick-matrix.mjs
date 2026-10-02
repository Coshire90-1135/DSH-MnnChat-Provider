// 快速对照实验:对手机服务跑一组头部矩阵(带端口预探,服务掉了立即退出,避免浪费)。
// 用法: node tools/quick-matrix.mjs <服务地址> [密钥]
//   例: node tools/quick-matrix.mjs http://192.168.1.23:8080
//       node tools/quick-matrix.mjs http://192.168.1.23:8080 你的API密钥
// 密钥也可以省略,走环境变量 MNN_CHAT_API_KEY;本地服务没开鉴权时两个都不填。
import net from 'node:net'

const base = process.argv[2]
const key = process.argv[3] ?? process.env.MNN_CHAT_API_KEY
if (!base) {
  console.log('用法: node tools/quick-matrix.mjs <服务地址> [密钥]')
  console.log('例:   node tools/quick-matrix.mjs http://192.168.1.23:8080')
  process.exit(2)
}
const url = new URL(base)
const host = url.hostname
const port = Number(url.port || 8080)

function probePort(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

const up = await probePort()
console.log(`TCP ${host}:${port} -> ${up ? 'OPEN' : 'CLOSED'}`)
if (!up) {
  console.log('服务此刻不在。结论要在服务活着时才能测;稍后再跑一次。')
  process.exit(0)
}

const auth = key === undefined ? {} : { authorization: `Bearer ${key}` }
const cases = [
  { label: 'GET /v1/models  accept=text/event-stream', method: 'GET', path: '/v1/models', headers: { accept: 'text/event-stream' } },
  { label: 'GET /v1/models  accept=application/json', method: 'GET', path: '/v1/models', headers: { accept: 'application/json' } },
  { label: 'GET /           (无 accept)', method: 'GET', path: '/', headers: {} },
  { label: 'GET /v1/queue/status (无 accept)', method: 'GET', path: '/v1/queue/status', headers: {} },
]

let modelId
for (const c of cases) {
  if (!(await probePort(800))) {
    console.log(`[中断] 端口在用例间隙关闭,服务已掉。已完成的用例仍有效。`)
    process.exit(0)
  }
  const started = Date.now()
  try {
    const res = await fetch(base + c.path, { method: c.method, headers: { ...auth, ...c.headers }, signal: AbortSignal.timeout(8000) })
    const text = await res.text()
    const short = text.replace(/\s+/g, ' ').slice(0, 160)
    console.log(`${c.label.padEnd(46)} -> HTTP ${res.status}  ${Date.now() - started}ms  ${short || '(空)'}`)
    if (res.ok && c.path === '/v1/models') {
      try {
        const payload = JSON.parse(text)
        modelId = payload?.data?.[0]?.id
      } catch {}
    }
  } catch (error) {
    console.log(`${c.label.padEnd(46)} -> 失败 ${Date.now() - started}ms  ${error?.cause?.code ?? error?.cause?.message ?? error?.message}`)
  }
}

if (!modelId) {
  console.log('没拿到模型 id,跳过 chat 矩阵。')
  process.exit(0)
}

const chatCases = [
  { label: 'chat stream accept=text/event-stream', accept: 'text/event-stream', stream: true },
  { label: 'chat stream accept=application/json', accept: 'application/json', stream: true },
  { label: 'chat stream accept=*/*', accept: '*/*', stream: true },
  { label: 'chat stream 无 accept', accept: undefined, stream: true },
  { label: 'chat nostream accept=application/json', accept: 'application/json', stream: false },
  { label: 'chat nostream accept=text/event-stream', accept: 'text/event-stream', stream: false },
]

for (const c of chatCases) {
  if (!(await probePort(800))) {
    console.log(`[中断] 端口关闭,服务已掉。已完成的用例仍有效。`)
    process.exit(0)
  }
  const headers = { 'content-type': 'application/json', ...auth }
  if (c.accept !== undefined) headers.accept = c.accept
  const started = Date.now()
  try {
    const res = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], stream: c.stream, max_tokens: 8 }),
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    const short = text.replace(/\s+/g, ' ').slice(0, 120)
    console.log(`${c.label.padEnd(46)} -> HTTP ${res.status}  ${Date.now() - started}ms  ct=${res.headers.get('content-type') ?? '-'}  ${short || '(空)'}`)
  } catch (error) {
    console.log(`${c.label.padEnd(46)} -> 失败 ${Date.now() - started}ms  ${error?.cause?.code ?? error?.cause?.message ?? error?.message}`)
  }
}

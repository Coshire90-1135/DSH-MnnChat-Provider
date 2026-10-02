import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { startFakeMnn, delta, end } from './helpers.mjs'

const NODE = process.execPath
const PROBE = fileURLToPath(new URL('../tools/probe.mjs', import.meta.url))

/**
 * 异步跑自检工具。
 * 必须用异步 spawn：spawnSync 会阻塞测试进程的事件循环，而假服务端就跑在
 * 同一个事件循环上，同步等待会自己把自己锁死。
 * @returns {Promise<{status: number, stdout: string, stderr: string}>}
 */
function runProbe(args, options = {}) {
  return new Promise((resolve) => {
    execFile(NODE, [PROBE, ...args], { encoding: 'utf8', timeout: options.timeout ?? 60000 }, (error, stdout, stderr) => {
      resolve({ status: error?.code ?? 0, stdout, stderr })
    })
  })
}

test('tools/probe.mjs：能自检一个 OpenAI 兼容服务并跑完一次流式对话', async () => {
  const fake = await startFakeMnn((req) => {
    if (req.url === '/v1/models') return { json: { data: [{ id: 'Qwen3-4B' }] } }
    return { chunks: [delta({ content: '你好' }), delta({ content: '，我是手机上的模型' }), end('stop'), '[DONE]'] }
  })

  const run = await runProbe([fake.baseURL, '--prompt', '打个招呼'])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /GET \/v1\/models → HTTP 200/u)
  assert.match(run.stdout, /服务端模型：Qwen3-4B/u)
  assert.match(run.stdout, /你好，我是手机上的模型/u)
  assert.match(run.stdout, /\[DONE\]/u)
  await fake.close()
})

test('tools/probe.mjs：模型列表拿不到时提示显式传 --model', async () => {
  const fake = await startFakeMnn((req) => {
    if (req.url === '/v1/models') return { status: 404, json: { error: { message: 'no listing' } } }
    return { chunks: [delta({ content: 'ok' }), end(), '[DONE]'] }
  })

  const withoutModel = await runProbe([fake.baseURL])
  assert.equal(withoutModel.status, 2)
  assert.match(withoutModel.stderr, /--model/u)

  const withModel = await runProbe([fake.baseURL, '--model', 'Qwen3-4B'])
  assert.equal(withModel.status, 0, withModel.stderr)
  assert.match(withModel.stdout, /ok/u)
  await fake.close()
})

test('tools/probe.mjs：连不上时非零退出并说明原因', async () => {
  const run = await runProbe(['http://127.0.0.1:1', '--model', 'Qwen3-4B'])
  assert.notEqual(run.status, 0)
  assert.match(`${run.stdout}${run.stderr}`, /失败/u)
})

// 从会话日志里翻出真实报错（.jsonl.zstd，用 Node 内置 zstd 解）
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createZstdDecompress } from 'node:zlib'

/** 会话文件是多帧 zstd（每追加一段就是一帧），必须流式解，一次拿全部内容。 */
function readZstd(file) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const stream = createReadStream(file).pipe(createZstdDecompress())
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', reject)
  })
}

const root = 'D:\\dsh\\home\\sessions'
const needles = ['连不上', 'dsh-mnn-chat', 'mnn-chat', 'TRANSPORT', 'mnn']
const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.zstd')) files.push(full)
  }
}
walk(root)
files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
console.log(`会话文件 ${files.length} 个，检查最近 6 个：\n`)

for (const file of files.slice(0, 6)) {
  let text
  try {
    text = await readZstd(file)
  } catch (error) {
    console.log(`  [跳过] ${file}: ${error.message}`)
    continue
  }
  const lines = text.split('\n').filter((line) => line.length > 0)
  const hits = []
  for (const line of lines) {
    if (needles.some((needle) => line.includes(needle))) hits.push(line)
  }
  console.log(`--- ${file.replace(root + '\\', '')}  (${lines.length} 行, 命中 ${hits.length}) ${statSync(file).mtime.toISOString()}`)
  for (const hit of hits.slice(-6)) {
    // 只打出有用的部分，避免刷屏
    let summary = hit
    try {
      const event = JSON.parse(hit)
      summary = JSON.stringify({
        type: event.type,
        ...(event.data?.failure ? { failure: event.data.failure } : {}),
        ...(event.data?.message ? { message: String(event.data.message).slice(0, 400) } : {}),
        ...(event.data?.error ? { error: String(event.data.error).slice(0, 400) } : {}),
        ...(event.data?.text ? { text: String(event.data.text).slice(0, 300) } : {}),
      })
    } catch {
      summary = hit.slice(0, 300)
    }
    console.log(`    ${summary.slice(0, 600)}`)
  }
}

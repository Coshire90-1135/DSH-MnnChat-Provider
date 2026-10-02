#!/usr/bin/env node
// 从 DSH 的 app.asar 里导出官方包的源码，供对照实现契约用。
// 例子（导出 LLM 适配器与插件管理器的实现）：
//   node tools/dump-asar.mjs
//   node tools/dump-asar.mjs dsh/node_modules/@deepseek-ai/dsh-llm/
//
// 导出目录默认在 .asar-dump/，可用 --out 指定。
// 说明：DSH 的 profile 解析器只把 profile 自己声明的依赖交给插件，内置包
// （@deepseek-ai/dsh-llm 等）对插件不可 import —— 想读它们的实现，只能这样
// 从 asar 里抠出来看。

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_ASAR = 'D:/code/dsh/resources/app.asar'
const DEFAULT_OUT = '.asar-dump'
const DEFAULT_PREFIXES = [
  'dsh/node_modules/@deepseek-ai/dsh-llm/',
  'dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/',
  'dsh/node_modules/@deepseek-ai/dsh-plugin-manager/',
]

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outRoot = outIndex >= 0 ? args[outIndex + 1] : DEFAULT_OUT
const asarIndex = args.indexOf('--asar')
const asarPath = asarIndex >= 0 ? args[asarIndex + 1] : DEFAULT_ASAR
const prefixes = args.filter((arg, index) => !arg.startsWith('--') && index !== outIndex + 1 && index !== asarIndex + 1)
const wanted = prefixes.length > 0 ? prefixes : DEFAULT_PREFIXES

if (!fs.existsSync(asarPath)) {
  console.error(`找不到 asar：${asarPath}\n用 --asar <路径> 指定。`)
  process.exit(1)
}

const fd = fs.openSync(asarPath, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const headerBuffer = Buffer.alloc(headerSize)
fs.readSync(fd, headerBuffer, 0, headerSize, 16)
const header = JSON.parse(headerBuffer.toString('utf8').replace(/\0+$/u, ''))
const dataOffset = 16 + headerSize

const files = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = prefix.length === 0 ? name : `${prefix}/${name}`
    if (entry.files !== undefined) walk(entry, full)
    else files.push({ path: full, entry })
  }
}
walk(header, '')

let count = 0
for (const { path: filePath, entry } of files) {
  if (!wanted.some((prefix) => filePath.startsWith(prefix))) continue
  const destination = path.join(outRoot, filePath)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (entry.unpacked === true) {
    fs.copyFileSync(path.join(`${asarPath}.unpacked`, filePath), destination)
  } else {
    const buffer = Buffer.alloc(entry.size)
    fs.readSync(fd, buffer, 0, entry.size, dataOffset + Number(entry.offset))
    fs.writeFileSync(destination, buffer)
  }
  count += 1
}
fs.closeSync(fd)

console.log(`导出 ${count} 个文件到 ${path.resolve(outRoot)}`)
console.log(`asar 内共 ${files.length} 个文件；用了 ${wanted.length} 个前缀过滤。`)

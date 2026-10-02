// 读取 DSH 的 app.asar：ls（列路径）/ grep（正则+行号）/ dump（整文件）/ range（行区间）
// 用法（在插件目录下执行）：
//   node tools/asar.mjs ls <regex>
//   node tools/asar.mjs grep <regex> [pathRegex] [cap]
//   node tools/asar.mjs dump <exact/path>
//   node tools/asar.mjs range <exact/path> <from> [to]
// 只读不落盘；要把整个包导出到磁盘用 tools/dump-asar.mjs。
// 说明：DSH 的 profile 解析器只把 profile 自己声明的依赖交给插件，内置包
// （@deepseek-ai/dsh-llm 等）对插件不可 import —— 想读它们的实现只能这样抠出来看。
import { readFileSync } from 'node:fs';

const ASAR = process.env.DSH_ASAR ?? 'D:\\code\\dsh\\resources\\app.asar';
const buf = readFileSync(ASAR);
const jsonSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'));
const dataStart = 16 + jsonSize;

const files = [];
(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p);
    else files.push({ path: p, ...entry });
  }
})(header, '');

const read = (f) =>
  buf.subarray(dataStart + Number(f.offset), dataStart + Number(f.offset) + Number(f.size)).toString('utf8');
const entry = (p) => files.find((f) => f.path === p);

const [mode, arg, arg2, arg3] = process.argv.slice(2);

if (mode === 'ls') {
  const re = new RegExp(arg, 'i');
  for (const f of files) if (re.test(f.path)) console.log(`${String(f.size).padStart(9)}  ${f.path}`);
} else if (mode === 'grep') {
  const re = new RegExp(arg, 'i');
  const pathRe = arg2 ? new RegExp(arg2, 'i') : null;
  let hits = 0;
  for (const f of files) {
    if (Number(f.size) > 30_000_000) continue;
    if (pathRe && !pathRe.test(f.path)) continue;
    let text;
    try {
      text = read(f);
    } catch {
      continue;
    }
    if (!re.test(text)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      const line = lines[i].length > 400 ? `${lines[i].slice(0, 400)}…` : lines[i];
      console.log(`${f.path}:${i + 1}: ${line.trim()}`);
      if (++hits >= (Number(arg3) || 400)) {
        console.log('… (hit cap reached)');
        process.exit(0);
      }
    }
  }
} else if (mode === 'dump') {
  const f = entry(arg);
  if (!f) {
    console.error('not found:', arg);
    process.exit(1);
  }
  process.stdout.write(read(f));
} else if (mode === 'range') {
  const f = entry(arg);
  if (!f) {
    console.error('not found:', arg);
    process.exit(1);
  }
  const from = Number(arg2);
  const to = Number(arg3 ?? from + 60);
  read(f)
    .split('\n')
    .slice(from - 1, to)
    .forEach((l, i) => console.log(`${from + i}: ${l}`));
} else {
  console.error('modes: ls <regex> | grep <regex> [pathRegex] [cap] | dump <path> | range <path> <from> [to]');
  process.exit(2);
}

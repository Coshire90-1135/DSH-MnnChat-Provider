// 扫本地 /24 网段的 8080：手机换了 IP 之后，配置里那个地址就再也连不上了，
// 而「手机上服务明明开着」——这个脚本用来定位服务现在到底在哪个地址。
// 用法: node tools/find-mnn-service.mjs [网段前缀] [端口] [超时毫秒]
//   例: node tools/find-mnn-service.mjs 192.168.1
// （先在电脑上跑 ipconfig 看自己的网段,前缀就是前三段。）
import net from 'node:net'

const prefix = process.argv[2] ?? '192.168.1'
const port = Number(process.argv[3] ?? 8080)
const timeoutMs = Number(process.argv[4] ?? 400)

const probe = (host) =>
  new Promise((resolve) => {
    const socket = new net.Socket()
    const done = (open) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open ? host : null)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host)
  })

const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`)
const found = []
const batchSize = 64
for (let i = 0; i < hosts.length; i += batchSize) {
  const batch = hosts.slice(i, i + batchSize)
  const results = await Promise.all(batch.map(probe))
  for (const host of results) if (host !== null) found.push(host)
}
console.log(`${prefix}.0/24 上 ${port} 端口开着的地址：${found.length === 0 ? '（一个都没有）' : found.join('、')}`)

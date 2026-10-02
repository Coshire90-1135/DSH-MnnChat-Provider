// 高频探一个 host:port，看它是「一直不在」还是「时有时无」。
// 用法：node tools/poke-port.mjs <host> [port] [次数]
//   例：node tools/poke-port.mjs 192.168.1.23 8080 20
import net from 'node:net'

const host = process.argv[2]
if (!host) {
  console.log('用法: node tools/poke-port.mjs <host> [port] [次数]')
  console.log('例:   node tools/poke-port.mjs 192.168.1.23 8080 20')
  process.exit(2)
}
const port = Number(process.argv[3] ?? 8080)
const times = Number(process.argv[4] ?? 20)

const once = () =>
  new Promise((resolve) => {
    const started = Date.now()
    const socket = new net.Socket()
    const finish = (state) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve({ state, ms: Date.now() - started })
    }
    socket.setTimeout(2000)
    socket.once('connect', () => finish('open'))
    socket.once('timeout', () => finish('timeout'))
    socket.once('error', (error) => finish(error.code ?? 'error'))
    socket.connect(port, host)
  })

const tally = new Map()
for (let i = 0; i < times; i += 1) {
  const result = await once()
  tally.set(result.state, (tally.get(result.state) ?? 0) + 1)
  console.log(`  #${String(i + 1).padStart(2)} ${result.state.padEnd(12)} ${result.ms} 毫秒`)
  await new Promise((resolve) => setTimeout(resolve, 300))
}
console.log(`\n${host}:${port} 共 ${times} 次：${[...tally].map(([state, count]) => `${state} × ${count}`).join('，')}`)

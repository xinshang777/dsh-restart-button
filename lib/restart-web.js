import net from 'node:net'
import { spawn } from 'node:child_process'

// 由 lib/index.js 以 detached 方式拉起的独立助手：
// 等旧 dsh web 释放端口后，按原参数重新拉起一个新进程。

const encoded = process.env.DSH_RESTART_BTN
if (!encoded) process.exit(1)

let info
try {
  info = JSON.parse(encoded)
} catch {
  process.exit(1)
}

const port = Number(info.port) || 3080
const host = typeof info.host === 'string' && info.host ? info.host : '127.0.0.1'

function portFree() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => resolve(true))
  })
}

async function waitFree(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await portFree()) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 120))
  }
}

// 超时也继续尝试拉起：旧进程可能仍在优雅退出，端口随后即可复用
await waitFree()

const env = { ...process.env }
delete env.DSH_RESTART_BTN
delete env.DSH_PERMISSION_MODE

// detached + windowsHide；shell:false 避免再走 dsh.cmd / cmd.exe（不弹黑框）
const child = spawn(info.execPath, info.argv, {
  detached: true,
  stdio: 'ignore',
  cwd: info.cwd || process.cwd(),
  env,
  windowsHide: true,
  shell: false,
})
child.on('error', () => process.exit(1))
child.unref()
// 等子进程脱离 job，避免助手退出时把新进程一起带走
await new Promise((r) => setTimeout(r, 400))
process.exit(0)
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = path.join(HERE, '..', 'assets', 'client.js')
const CLIENT_PATH = '/dsh-restart/client.js'
const RESTART_PATH = '/dsh-restart/restart'
const STATUS_PATH = '/dsh-restart/status'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// 每次进程启动生成一个 bootId：浏览器用它区分"旧进程还活着"和"新进程已起来"
const BOOT_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}`

// assets/client.js 按 mtime 缓存，改完刷新页面即可生效
let clientCache = null
function loadClientJs() {
  try {
    const st = fs.statSync(CLIENT_FILE)
    if (clientCache && clientCache.mtimeMs === st.mtimeMs) return clientCache.text
    const text = fs.readFileSync(CLIENT_FILE, 'utf8')
    clientCache = { text, mtimeMs: st.mtimeMs }
    return text
  } catch (err) {
    return ''
  }
}

// 回环/同源校验：重启是个有副作用的写接口，不能允许跨站页面或 DNS 重绑定触发
function isLoopbackHostname(hn) {
  const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

function guard(req, res) {
  const headers = (req && req.headers) || {}
  const deny = (code) => {
    try {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
    } catch (err) {}
    return true
  }
  let hostUrl = null
  try {
    hostUrl = new URL('http://' + String(headers.host || ''))
  } catch (err) {
    return deny(403)
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return deny(403)
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return deny(403)
  const origin = headers.origin
  if (typeof origin === 'string' && origin && origin !== 'null') {
    let originUrl = null
    try {
      originUrl = new URL(origin)
    } catch (err) {
      return deny(403)
    }
    if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return deny(403)
  }
  return false
}

function hostFromRequest(req) {
  const hostHeader = String((req && req.headers && req.headers.host) || '127.0.0.1')
  return hostHeader.replace(/:\d+$/, '') || '127.0.0.1'
}

function portFromRequest(req) {
  const m = String((req && req.headers && req.headers.host) || '').match(/:(\d+)$/)
  if (m) return Number(m[1])
  return Number(process.env.PORT) || 3080
}

// dsh 的入口 bin.js：正常启动时就是 process.argv[1]
function resolveBinJs() {
  const argv1 = process.argv[1] || ''
  if (/bin\.js$/i.test(argv1) && fs.existsSync(argv1)) return argv1
  const dir = argv1 ? path.dirname(argv1) : ''
  if (!dir) return null
  const candidates = [
    path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.resolve(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ]
  return candidates.find((p) => fs.existsSync(p)) || null
}

// 进程级启动 token 每次启动都会变（见 dsh-client-connection 的 processLaunchToken）。
// 页面重启后如果沿用 URL 里的旧 token，就会 401；所以状态接口要回传"本进程"的带 token URL。
function connectionService(ctx) {
  let conn = null
  try {
    conn = ctx.get('connection') || ctx.connection
  } catch (err) {
    return null
  }
  return conn && typeof conn.authenticatedUrl === 'function' ? conn : null
}

export default {
  name: 'dsh-restart-button',
  inject: ['webServer', 'connection'],
  apply(ctx) {
    const disposers = []

    function scheduleRestart(req, binJs) {
      const helper = fileURLToPath(new URL('./restart-web.js', import.meta.url))
      const port = portFromRequest(req)
      const payload = {
        execPath: process.execPath,
        argv: [binJs, 'web', '--port', String(port), '--no-open'],
        cwd: process.cwd(),
        host: hostFromRequest(req),
        port,
      }
      const env = { ...process.env }
      delete env.DSH_PERMISSION_MODE
      env.DSH_RESTART_BTN = JSON.stringify(payload)
      try {
        const child = spawn(process.execPath, [helper], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
          env,
        })
        child.unref()
      } catch (err) {
        try {
          console.error('[dsh-restart-button] 拉起重启助手失败：' + String((err && err.message) || err))
        } catch (e2) {}
        return
      }
      // 等响应刷出后再退出，helper 会等端口释放后重新拉起 dsh web
      setTimeout(() => process.exit(0), 250)
    }

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (req, res) => {
        if (guard(req, res)) return
        const conn = connectionService(ctx)
        let url = null
        if (conn) {
          try {
            url = conn.authenticatedUrl('http://' + String(req.headers.host || '') + '/')
          } catch (err) {
            url = null
          }
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, bootId: BOOT_ID, pid: process.pid, url }))
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: RESTART_PATH,
      handler: (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' })
          res.end('method not allowed')
          return
        }
        const binJs = resolveBinJs()
        if (!binJs) {
          res.writeHead(500, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'dsh bin.js not found' }))
          return
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, bootId: BOOT_ID }))
        scheduleRestart(req, binJs)
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: CLIENT_PATH,
      handler: (req, res) => {
        if (guard(req, res)) return
        const body = loadClientJs()
        if (!body) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('client script missing')
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(body)
      },
    }))

    disposers.push(ctx.webServer.tapIndex((html) => {
      if (html.indexOf(CLIENT_PATH) !== -1) return html
      const tag = `<script defer src="${CLIENT_PATH}"></script>`
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
      return html + tag
    }))

    ctx.effect(() => () => {
      for (const d of disposers) {
        try {
          d()
        } catch (err) {}
      }
    })
  },
}
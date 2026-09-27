/* dsh-restart-button —— 注入到 DSH Web 页面的前端脚本
 * 在「设置」按钮右侧插一个同款「重启」按钮：点击后重启 dsh web 服务，
 * 等新进程起来（bootId 变化）后自动刷新页面。
 */
(function () {
  'use strict'
  if (window.__dshRestartButtonInstalled) return
  window.__dshRestartButtonInstalled = true

  var BTN_ID = 'dsh-restart-btn'
  var LABEL = '重启'
  var LABEL_BUSY = '重启中…'
  var LABEL_TIMEOUT = '重启超时'
  var LABEL_FAIL = '重启失败'
  var STATUS_URL = '/dsh-restart/status'
  var RESTART_URL = '/dsh-restart/restart'
  var POLL_INTERVAL = 600
  var POLL_TIMEOUT = 120000

  var REFRESH_ICON = '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/>'

  var busy = false
  var labelNode = null

  // 「设置」按钮：优先用 data-slot（与语言无关），退回 aria-label
  function findSettingsButton() {
    var slot = document.querySelector('[data-slot="settings.trigger"]')
    if (slot) {
      var viaSlot = slot.closest('button')
      if (viaSlot) return viaSlot
    }
    var byLabel = document.querySelector('button[aria-label="设置"]')
    if (byLabel) return byLabel
    return document.querySelector('button[aria-label="Settings"]')
  }

  function setLabel(text) {
    if (labelNode) {
      labelNode.textContent = text
      return
    }
    var btn = document.getElementById(BTN_ID)
    if (btn) btn.textContent = text
  }

  // 克隆「设置」按钮拿到完全一致的样式与图标尺寸，再换成刷新图标与文案
  function buildButton(anchor) {
    var btn = anchor.cloneNode(true)
    btn.id = BTN_ID
    btn.removeAttribute('aria-haspopup')
    btn.removeAttribute('aria-expanded')
    btn.setAttribute('aria-label', LABEL)
    btn.setAttribute('title', '重启 dsh web 服务（重启完成后页面自动刷新）')
    var slot = btn.querySelector('[data-slot="settings.trigger"]')
    if (slot) slot.setAttribute('data-slot', 'dsh-restart.trigger')
    var svg = btn.querySelector('svg')
    if (svg) {
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '2')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.innerHTML = REFRESH_ICON
    }
    var spans = btn.querySelectorAll('span')
    labelNode = spans.length ? spans[spans.length - 1] : null
    if (labelNode) labelNode.textContent = LABEL
    btn.addEventListener('click', onClick)
    return btn
  }

  function ensureButton() {
    var anchor = findSettingsButton()
    if (!anchor || !anchor.parentElement) return
    var existing = document.getElementById(BTN_ID)
    if (existing) {
      if (existing.parentElement === anchor.parentElement && existing.previousElementSibling === anchor) return
      existing.parentNode.removeChild(existing)
    }
    try {
      anchor.insertAdjacentElement('afterend', buildButton(anchor))
    } catch (err) {}
  }

  function scheduleEnsure() {
    if (scheduleEnsure.pending) return
    scheduleEnsure.pending = true
    var run = function () {
      scheduleEnsure.pending = false
      try {
        ensureButton()
      } catch (err) {}
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else setTimeout(run, 16)
  }

  function readStatus() {
    return fetch(STATUS_URL, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) {
        return res.ok ? res.json() : null
      })
      .catch(function () {
        return null
      })
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms)
    })
  }

  // 轮询直到 bootId 与重启前不同 —— 说明新进程已经接管。
  // 返回新进程的 status（其中 url 带本进程的启动 token，重新打开一定通过鉴权）。
  function waitForNewBoot(beforeBootId) {
    var deadline = Date.now() + POLL_TIMEOUT
    return (function tick() {
      if (Date.now() > deadline) return Promise.resolve(null)
      return sleep(POLL_INTERVAL)
        .then(readStatus)
        .then(function (status) {
          if (status && status.ok && (!beforeBootId || status.bootId !== beforeBootId)) return status
          return tick()
        })
    })()
  }

  function finish(text) {
    busy = false
    var btn = document.getElementById(BTN_ID)
    if (btn) btn.removeAttribute('data-busy')
    setLabel(text)
    setTimeout(function () {
      if (!busy) setLabel(LABEL)
    }, 4000)
  }

  function onClick() {
    if (busy) return
    busy = true
    var btn = document.getElementById(BTN_ID)
    if (btn) btn.setAttribute('data-busy', '1')
    setLabel(LABEL_BUSY)

    readStatus()
      .then(function (before) {
        var beforeBootId = before && before.ok ? before.bootId : null
        // 先把启动前的 bootId 记下来，再发起重启
        return fetch(RESTART_URL, {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }).catch(function () {
          // 服务端紧接着就会退出，请求中断属正常
          return null
        }).then(function () {
          return waitForNewBoot(beforeBootId)
        })
      })
      .then(function (status) {
        if (status) {
          // 用「新进程」的带 token URL 打开：旧 URL 里的 token 已随上个进程失效，
          // 直接 reload 会被 401 挡在门外。
          var target = status.url || (location.origin + '/')
          try {
            location.replace(target)
            return
          } catch (err) {}
        }
        finish(LABEL_TIMEOUT)
      })
      .catch(function () {
        finish(LABEL_FAIL)
      })
  }

  function start() {
    ensureButton()
    var observer = new MutationObserver(scheduleEnsure)
    observer.observe(document.documentElement, { childList: true, subtree: true })
    // 首屏可能还没渲染出页脚，兜底多试几次
    var tries = 0
    var timer = setInterval(function () {
      tries += 1
      ensureButton()
      if (document.getElementById(BTN_ID) || tries > 40) clearInterval(timer)
    }, 250)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
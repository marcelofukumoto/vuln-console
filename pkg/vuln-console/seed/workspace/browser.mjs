#!/usr/bin/env node
// CDP helper for driving the browser sidecar via Playwright.
//
// Taken from the Dev extension's agent seed (agent-seed/bin/browser.mjs) rather than rewritten.
// It is the tool that already works against this exact sidecar, and a second implementation of
// screencast-plus-ffmpeg would be a second set of the same bugs. The endpoint comes from
// $CLAUDE_BROWSER_CDP, which workspace-setup.sh writes into the workspace's .env.
// Usage:
//   node /workspace/browser.mjs screenshot <url> <out.png>
//   node /workspace/browser.mjs record <url> <out.webm> [durationMs]
//   node /workspace/browser.mjs goto <url>                # just navigate the active tab
//   node /workspace/browser.mjs eval "<js>"              # run JS in the active tab, print result
//
// Pass `--new-tab` (anywhere in the args) to open a fresh tab for the
// command and auto-close it on exit, instead of reusing the user's active
// tab. Use this for any transient/automated work (e.g. scraping, uploading,
// background checks) so the user's open tabs aren't navigated away from.
//
// `record` injects a visual overlay into the page (URL bar at the bottom,
// cursor dot that tracks mouse movement, click ripples, and keystroke badges)
// so the resulting webm shows the URL, the pointer, and input actions even
// though CDP screencast only captures the viewport.
//
// CDP endpoint comes from $CLAUDE_BROWSER_CDP (set in .bashrc by init.sh).

import { chromium } from 'playwright-core'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'

const CDP = process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222'

// Overlay installed into the page for `record`. Idempotent - safe to run on
// every navigation. Positions the URL bar at the bottom (semi-transparent,
// 32px) so it minimally covers the page; cursor + ripples + key badges
// float above.
const OVERLAY_SCRIPT = () => {
  if (document.getElementById('__hn_urlbar')) return

  const style = document.createElement('style')
  style.textContent = `
    @keyframes __hn_ripple { to { width: 56px; height: 56px; opacity: 0; } }
    @keyframes __hn_keyfade {
      0%   { opacity: 0; transform: translateY(8px); }
      12%  { opacity: 1; transform: translateY(0); }
      70%  { opacity: 1; }
      100% { opacity: 0; transform: translateY(-6px); }
    }
  `
  document.documentElement.appendChild(style)

  // --- URL bar (bottom) ---------------------------------------------------
  const bar = document.createElement('div')
  bar.id = '__hn_urlbar'
  bar.style.cssText = [
    'position:fixed', 'left:0', 'right:0', 'bottom:0', 'height:28px',
    'background:rgba(18,18,22,0.82)', 'color:#eaeaea',
    'font:12px/28px ui-monospace,SFMono-Regular,Menlo,monospace',
    'padding:0 10px', 'z-index:2147483647', 'pointer-events:none',
    'border-top:1px solid rgba(255,255,255,0.1)',
    'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
    'display:flex', 'align-items:center', 'gap:8px',
    'backdrop-filter:blur(6px)',
  ].join(';')
  bar.innerHTML = '<span style="opacity:0.55;font-size:11px">URL</span><span id="__hn_url"></span>'
  document.documentElement.appendChild(bar)

  const updateUrl = () => {
    const el = document.getElementById('__hn_url')
    if (!el) return
    el.textContent = location.href
    const b = document.getElementById('__hn_urlbar')
    if (b) {
      b.style.transition = 'none'
      b.style.background = 'rgba(220,60,100,0.6)'
      requestAnimationFrame(() => {
        b.style.transition = 'background 3s ease-out'
        b.style.background = 'rgba(18,18,22,0.82)'
      })
    }
  }
  updateUrl()
  const origPush = history.pushState
  const origReplace = history.replaceState
  history.pushState = function () { origPush.apply(this, arguments); updateUrl() }
  history.replaceState = function () { origReplace.apply(this, arguments); updateUrl() }
  window.addEventListener('popstate', updateUrl)
  window.addEventListener('hashchange', updateUrl)

  // --- Cursor dot ---------------------------------------------------------
  // No CSS transition on top/left. The recorder interpolates pointer position
  // itself (dozens of small mouse-move steps per gesture), so the dot must
  // follow each mousemove 1:1. A positional transition would smear across the
  // per-step moves and leave the dot visibly trailing the true pointer.
  // `transform` keeps a short transition purely for the click press effect.
  const cursor = document.createElement('div')
  cursor.id = '__hn_cursor'
  cursor.style.cssText = [
    'position:fixed', 'width:14px', 'height:14px',
    'background:rgba(220,60,100,0.85)', 'border:2px solid #fff',
    'border-radius:50%', 'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
    'pointer-events:none', 'z-index:2147483646',
    'transform:translate(-50%,-50%)', 'transition:transform .08s ease-out',
    'top:-100px', 'left:-100px',
  ].join(';')
  document.documentElement.appendChild(cursor)

  // --- Force continuous frame emission ------------------------------------
  // CDP Page.startScreencast only emits frames when the compositor produces
  // new content. During a quiet hold with no motion the stream would stop and
  // the recording would compress that hold to nothing. Animate a 1px invisible
  // canvas via rAF so the compositor always has work, which together with the
  // measured-fps encode keeps playback locked to wall time.
  const __hn_ff = document.createElement('canvas')
  __hn_ff.width = 1; __hn_ff.height = 1
  __hn_ff.style.cssText = 'position:fixed;bottom:0;right:0;width:1px;height:1px;pointer-events:none;opacity:0.003;z-index:2147483645'
  document.documentElement.appendChild(__hn_ff)
  const __hn_ffctx = __hn_ff.getContext('2d')
  let __hn_fft = 0
  const __hn_tick = () => {
    __hn_ffctx.fillStyle = (__hn_fft++ & 1) ? '#000' : '#fff'
    __hn_ffctx.fillRect(0, 0, 1, 1)
    requestAnimationFrame(__hn_tick)
  }
  requestAnimationFrame(__hn_tick)

  document.addEventListener('mousemove', (e) => {
    cursor.style.top = e.clientY + 'px'
    cursor.style.left = e.clientX + 'px'
  }, true)

  // --- Click ripples ------------------------------------------------------
  // The dot also squashes on press and springs back on release, so the dwell
  // between mousedown and mouseup reads as a deliberate click rather than a
  // ripple appearing out of nowhere.
  document.addEventListener('mouseup', () => {
    cursor.style.transform = 'translate(-50%,-50%) scale(1)'
  }, true)

  document.addEventListener('mousedown', (e) => {
    cursor.style.transform = 'translate(-50%,-50%) scale(0.68)'
    const r = document.createElement('div')
    r.style.cssText = [
      'position:fixed', `top:${e.clientY}px`, `left:${e.clientX}px`,
      'width:10px', 'height:10px',
      'background:rgba(220,60,100,0.35)',
      'border:2px solid rgba(220,60,100,0.85)',
      'border-radius:50%', 'pointer-events:none',
      'z-index:2147483646', 'transform:translate(-50%,-50%)',
      'animation:__hn_ripple .6s ease-out forwards',
    ].join(';')
    document.documentElement.appendChild(r)
    setTimeout(() => r.remove(), 700)
  }, true)

  // --- Keystroke badges ---------------------------------------------------
  const tray = document.createElement('div')
  tray.id = '__hn_keys'
  tray.style.cssText = [
    'position:fixed', 'right:12px', 'bottom:40px',
    'display:flex', 'flex-direction:column', 'align-items:flex-end',
    'gap:4px', 'pointer-events:none', 'z-index:2147483646',
  ].join(';')
  document.documentElement.appendChild(tray)

  // --- Nuke the webpack-dev-server runtime error overlay ------------------
  // The dev server mounts an iframe (#webpack-dev-server-client-overlay) at
  // max z-index whenever there's a compile/runtime warning. Iframes intercept
  // mouse events even with parent pointer-events:none, so once it's up the
  // cursor dot stops tracking and the recording shows no pointer. Kill it
  // every time it appears.
  const killWebpackOverlay = () => {
    for (const id of ['webpack-dev-server-client-overlay', 'webpack-dev-server-client-overlay-div']) {
      const el = document.getElementById(id)
      if (el) el.remove()
    }
  }
  killWebpackOverlay()
  new MutationObserver(killWebpackOverlay).observe(document.documentElement, { childList: true, subtree: true })

  // --- Highlight API -------------------------------------------------------
  // Accepts an element, a selector, or a static {x,y,width,height} rect. `id`
  // is optional - when omitted one is generated and returned, so raw
  // `window.__highlight({selector, label})` works without the caller having to
  // invent unique ids (two id-less calls would otherwise collide).
  window.__hn_highlights = {}
  let __hn_hlSeq = 0

  window.__highlight = ({ element, selector, rect, label, color = '#ff3333', id }) => {
    const el = element || (selector ? document.querySelector(selector) : null)
    if (!el && !rect) return null
    const hid = id || `__hn_hl_${++__hn_hlSeq}`
    const overlay = document.createElement('div')
    overlay.id = hid
    overlay.style.cssText = `position:fixed;border:2px solid ${color};border-radius:3px;pointer-events:none;z-index:2147483646;padding:0;`
    if (label) {
      const lbl = document.createElement('div')
      lbl.textContent = label
      lbl.style.cssText = `position:absolute;top:-20px;left:0;background:${color};color:white;font-size:11px;padding:1px 5px;border-radius:2px;white-space:nowrap;`
      overlay.appendChild(lbl)
    }
    document.documentElement.appendChild(overlay)
    const place = (r) => {
      overlay.style.left = (r.left ?? r.x) - 4 + 'px'
      overlay.style.top = (r.top ?? r.y) - 4 + 'px'
      overlay.style.width = r.width + 8 + 'px'
      overlay.style.height = r.height + 8 + 'px'
    }
    if (el) {
      // Follow the element through scrolls and layout shifts.
      const track = () => {
        if (!document.getElementById(hid)) return
        place(el.getBoundingClientRect())
        requestAnimationFrame(track)
      }
      requestAnimationFrame(track)
    } else {
      place(rect)
    }
    window.__hn_highlights[hid] = overlay
    return hid
  }

  window.__removeHighlight = (id) => {
    const el = document.getElementById(id)
    if (el) el.remove()
    delete window.__hn_highlights[id]
  }

  window.__clearHighlights = () => {
    for (const [id, el] of Object.entries(window.__hn_highlights)) {
      if (el && el.parentNode) el.remove()
    }
    window.__hn_highlights = {}
  }

  // --- Banner API ----------------------------------------------------------
  // Narrative label near the top of frame ("Adding a service to show live
  // update"). Pass {duration} to auto-remove, otherwise __removeBanner(id).
  // Multiple banners stack.
  let __hn_bnSeq = 0
  const bannerWrap = document.createElement('div')
  bannerWrap.id = '__hn_bannerWrap'
  bannerWrap.style.cssText = [
    'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)',
    'display:flex', 'flex-direction:column', 'align-items:center',
    'gap:6px', 'pointer-events:none', 'z-index:2147483647',
    // `width:max-content` is what makes the cap mean 80vw. With `width:auto`
    // the wrapper is shrink-to-fit against the space from `left:50%` to the
    // right edge, i.e. 50vw, and the translate that re-centres it happens after
    // that width is decided - so the effective cap was 50vw and `max-width`
    // never bound. Sizing to content first hands `max-width` the decision.
    'width:max-content', 'max-width:80vw',
  ].join(';')
  document.documentElement.appendChild(bannerWrap)

  const bannerCSS = document.createElement('style')
  bannerCSS.textContent = `
    @keyframes __hn_bannerIn { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:translateY(0); } }
    @keyframes __hn_bannerOut { from { opacity:1; } to { opacity:0; transform:translateY(-6px); } }
  `
  document.documentElement.appendChild(bannerCSS)

  window.__banner = (text, opts = {}) => {
    const id = `__hn_bn_${++__hn_bnSeq}`
    const el = document.createElement('div')
    el.id = id
    el.textContent = text
    el.style.cssText = [
      `background:${opts.color || 'rgba(18,18,22,0.92)'}`, 'color:#fff',
      'font:600 13px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace',
      'padding:8px 14px', 'border-radius:6px',
      'border:1px solid rgba(255,255,255,0.15)',
      'box-shadow:0 4px 12px rgba(0,0,0,0.5)',
      'animation:__hn_bannerIn .25s ease-out forwards',
      // Wraps. A banner that clipped to an ellipsis was unreadable exactly
      // where there was most to read, which is the case the reading-time hold
      // exists for. The wrapper is already capped at 80vw, so long text grows
      // downwards instead of running off the side.
      'white-space:normal', 'overflow-wrap:anywhere', 'text-align:center',
      'max-width:100%',
    ].join(';')
    bannerWrap.appendChild(el)
    if (opts.duration > 0) setTimeout(() => window.__removeBanner(id), opts.duration)
    return id
  }

  window.__removeBanner = (id) => {
    const el = document.getElementById(id)
    if (!el) return
    el.style.animation = '__hn_bannerOut .25s ease-out forwards'
    setTimeout(() => el.remove(), 260)
  }

  window.__clearBanners = () => {
    document.querySelectorAll('[id^="__hn_bn_"]').forEach((el) => el.remove())
  }

  // --- Keystroke badges (with bare modifier hold support) -------------------
  const __hn_heldMods = {}

  document.addEventListener('keydown', (e) => {
    const key = e.key

    if (['Control', 'Meta', 'Alt', 'Shift'].includes(key)) {
      if (__hn_heldMods[key]) return
      const b = document.createElement('div')
      b.textContent = `${key === 'Meta' ? '⌘' : key} (hold)`
      b.style.cssText = [
        'background:rgba(18,18,22,0.92)', 'color:#fff',
        'font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace',
        'padding:6px 9px', 'border-radius:4px',
        'border:1px solid rgba(255,255,255,0.15)',
      ].join(';')
      tray.appendChild(b)
      __hn_heldMods[key] = b
      return
    }

    for (const [mod, badge] of Object.entries(__hn_heldMods)) {
      badge.remove()
      delete __hn_heldMods[mod]
    }

    const parts = []
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.metaKey) parts.push('⌘')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey && key.length > 1) parts.push('Shift')
    parts.push(key === ' ' ? 'Space' : key)

    const b = document.createElement('div')
    b.textContent = parts.join('+')
    b.style.cssText = [
      'background:rgba(18,18,22,0.92)', 'color:#fff',
      'font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace',
      'padding:6px 9px', 'border-radius:4px',
      'border:1px solid rgba(255,255,255,0.15)',
      'animation:__hn_keyfade 1.2s ease-out forwards',
    ].join(';')
    tray.appendChild(b)
    setTimeout(() => b.remove(), 1300)
  }, true)

  document.addEventListener('keyup', (e) => {
    if (__hn_heldMods[e.key]) {
      __hn_heldMods[e.key].remove()
      delete __hn_heldMods[e.key]
    }
  }, true)
}

async function connect({ newTab = false } = {}) {
  const browser = await chromium.connectOverCDP(CDP)
  const ctx = browser.contexts()[0] || await browser.newContext()
  let page
  let createdPage = false
  if (newTab || ctx.pages().length === 0) {
    page = await ctx.newPage()
    createdPage = true
  } else {
    page = ctx.pages()[0]
  }
  return { browser, ctx, page, createdPage }
}

async function disconnect({ browser, page, createdPage }) {
  if (createdPage) { try { await page.close() } catch { /* ignore */ } }
  try { await browser.close() } catch { /* ignore */ }
}

async function installOverlay(page, ctx) {
  // addInitScript runs on every future navigation.
  await ctx.addInitScript(OVERLAY_SCRIPT)
  // Also install on the currently-loaded document, if any.
  try { await page.evaluate(OVERLAY_SCRIPT) } catch { /* about:blank etc. */ }
}

async function screenshot(url, out, opts) {
  const conn = await connect(opts)
  if (url && url !== '-') await conn.page.goto(url, { waitUntil: 'networkidle' })
  await conn.page.screenshot({ path: out, fullPage: true })
  console.log(`saved ${out}`)
  await disconnect(conn)
}

async function goto(url, opts) {
  const conn = await connect(opts)
  await conn.page.goto(url, { waitUntil: 'networkidle' })
  console.log(`navigated to ${url}`)
  await disconnect(conn)
}

async function evalJs(expr, opts) {
  const conn = await connect(opts)
  const result = await conn.page.evaluate(expr)
  console.log(JSON.stringify(result, null, 2))
  await disconnect(conn)
}

// Uses CDP Page.startScreencast to capture frames, then ffmpeg to assemble webm.
// Overlay (URL bar + cursor + click/key indicators) is injected before capture.
async function record(url, out, durationMs, opts) {
  await runRecording(out, opts, async (page) => {
    if (url && url !== '-') await page.goto(url, { waitUntil: 'domcontentloaded' })
    await new Promise(r => setTimeout(r, Number(durationMs) || 10_000))
  })
}

// Deterministic PRNG. Every "human" variation below draws from this, so a
// rerun of the same script produces the same path curvature, the same
// overshoots and the same keystroke cadence. Override with $RECORD_SEED.
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v

// Minimum-jerk reach profile (the standard model of a human arm movement),
// warped so peak velocity lands early. Result: quick acceleration, long
// deceleration into the target, which is what a real pointer does.
const reachProfile = (t) => {
  const w = Math.pow(t, 0.85)
  return 10 * w ** 3 - 15 * w ** 4 + 6 * w ** 5
}

// How long a viewer needs to read a piece of on-screen text: a fixation cost
// to notice and locate it, plus a words-per-minute budget.
//
// The ceiling is a runaway guard, not a pacing knob. It used to be 3000ms,
// which silently cut every banner longer than eleven words - a 26-word label
// was being held at an implied 520wpm, i.e. not readable, in exactly the case
// where reading time matters most. If a beat computes to something absurd the
// answer is shorter text, not a shorter hold, so the cap sits far above any
// sane banner and `say()` warns before it bites.
function readingTime(text, opts = {}) {
  const { wpm = 250, base = 350, min = 650, max = 12_000 } = opts
  const words = (String(text ?? '').trim().match(/\S+/g) || []).length
  return Math.round(clamp(base + (words / wpm) * 60_000, min, max))
}

// Longest hold that is not tied to text or to a UI condition before `pause`
// complains. The symmetric guard to `say`'s 6.5s reading warning: `say` catches
// "too much text to hold", this catches "no text at all, held anyway".
const PAUSE_WARN_MS = 1200

// Selectors that mean "this view is still loading" in the Rancher dashboard.
const SPINNERS = [
  '.loading-indicator', '[data-testid="loading-indicator"]',
  '.data-loading', '.icon-spinner', '.loading',
]

// Which pages have a live helper layer, and how to reach that layer's `idle`.
//
// `Locator` in playwright-core is a module-level class: every page in the
// process shares one prototype. Patching `waitFor` on it therefore patches it
// for pages this recorder knows nothing about, and a patch that closed over one
// page's ramble would drive the wrong pointer (or a dead one, once that page is
// closed). So the patch is installed once, keyed on the locator's own page, and
// falls through to the original for any page without a helper layer. The patch
// is removed again when the last live page is disposed.
const LIVE_PAGES = new WeakMap()
const LOCATOR_PATCHES = new Map()   // Locator.prototype -> { raw, own, live }

// Build interaction helpers for record-script.
//
// Pointer motion is interpolated: every gesture is a curved, eased path made
// of many small mouse-move steps, with an occasional overshoot-and-correct and
// a short settle before the button goes down. Typing has variable inter-key
// timing that slows at word boundaries and punctuation. Waits are expressed as
// "wait for the condition, then hold only as long as a person needs to read
// what appeared" rather than as fixed sleeps.
function buildHelpers(page) {
  // Kept for backwards compatibility: scripts written against the old helpers
  // use these as waitForTimeout arguments.
  const MOVE_DELAY = 180
  const TYPE_DELAY = 60

  const rand = mulberry32(Number(process.env.RECORD_SEED) || 0xC0FFEE)
  const rnd = (a, b) => a + rand() * (b - a)
  // The idle ramble gets its own stream, seeded once from the main one. It is
  // paced by the wall clock, so how many values it spends depends on CDP
  // latency and on how long the page took - and anything it drew from the main
  // stream would shift every gesture after it by an amount that depends on the
  // machine. Off its own stream it cannot: main-stream consumption stays a
  // function of the script alone.
  const rambleRand = mulberry32((rand() * 4294967296) >>> 0)
  const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)))

  const loc = (sel) => typeof sel === 'string' ? page.locator(sel) : sel

  // --- Network quiet tracking ---------------------------------------------
  // Rancher holds websockets open forever, so waitForLoadState('networkidle')
  // never resolves. Count only the requests that actually gate rendering.
  let inflight = 0
  let lastNetChange = Date.now()
  const gating = (req) => !['websocket', 'eventsource', 'media', 'ping'].includes(req.resourceType())
  page.on('request', (r) => { if (gating(r)) { inflight++; lastNetChange = Date.now() } })
  const done = (r) => { if (gating(r)) { inflight = Math.max(0, inflight - 1); lastNetChange = Date.now() } }
  page.on('requestfinished', done)
  page.on('requestfailed', done)

  // --- Pointer state -------------------------------------------------------
  // Starts near the middle of the viewport so the first gesture glides in from
  // somewhere plausible instead of teleporting from off-screen.
  let ptr = { x: 640, y: 400 }
  let primed = false

  // Two pieces of code can want the pointer at the same time: a gesture (a
  // glide, a scroll, the press inside `click`) and the idle ramble running
  // underneath a wait. `pointerBusy` is held by the gesture; the ramble stands
  // aside while it is set and picks up from wherever the gesture left the
  // cursor. Without this, an `idle(...)` wrapped around a wait that overlaps a
  // click would have two writers fighting over the mouse.
  let pointerBusy = 0
  let driftActive = false
  let rambleMoving = 0

  // Claiming the pointer is not instant: a ramble step can already be in flight
  // over CDP, and that one cannot be cancelled, only waited for. Without the
  // drain, a stray 1-2px ramble move lands between mousedown and mouseup, which
  // is enough to read as a drag to anything watching for one. Bounded, so a
  // hung page delays a click rather than hanging it.
  async function acquirePointer() {
    pointerBusy++
    for (let i = 0; i < 40 && rambleMoving; i++) await sleep(5)
  }
  const releasePointer = () => { pointerBusy-- }

  // Captured before `installLiveWaits` wraps `page.mouse` so the recorder's own
  // moves go straight out rather than back through the wrapper.
  const bindIf = (o, k) => typeof o?.[k] === 'function' ? o[k].bind(o) : null
  const rawMouse = {
    move: bindIf(page.mouse, 'move'),
    down: bindIf(page.mouse, 'down'),
    up: bindIf(page.mouse, 'up'),
    click: bindIf(page.mouse, 'click'),
    dblclick: bindIf(page.mouse, 'dblclick'),
  }

  async function moveTo(x, y) {
    await rawMouse.move(x, y)
    ptr = { x, y }
    primed = true
  }

  // One eased, slightly curved traversal from the current pointer position to
  // (tx, ty). Driven by wall time rather than step index so CDP round-trip
  // latency does not stretch the gesture.
  async function glide(tx, ty, opts = {}) {
    // `opts.rng` lets a caller whose own loop count depends on the page (see
    // `scrollTo`) run this gesture off a local stream, so the main stream's
    // draw count stays a function of the script and not of the machine.
    const R = opts.rng ?? rand
    const Rnd = (a, b) => a + R() * (b - a)
    const from = { ...ptr }
    const dist = Math.hypot(tx - from.x, ty - from.y)
    if (!primed) { await moveTo(from.x, from.y) }
    if (dist < 1.5) { await moveTo(tx, ty); return }

    const duration = clamp(180 + 0.6 * dist, 240, 800) * (opts.speed ?? 1)
    // Control point: midpoint pushed sideways so the path bows instead of
    // running dead straight. Bigger travel bows more, capped so it stays sane.
    const nx = -(ty - from.y) / dist
    const ny = (tx - from.x) / dist
    const bow = Math.min(45, dist * Rnd(0.05, 0.13)) * (R() < 0.5 ? -1 : 1)
    const cx = (from.x + tx) / 2 + nx * bow
    const cy = (from.y + ty) / 2 + ny * bow

    // Stepping is paced by the CDP round trip, not by this sleep. Measured
    // in-page under a live screencast (mousemove timestamps over six
    // full-width glides): a step every 14-17ms, 15-16ms overall - about twice
    // the rate the idle ramble runs at, and near the capture period measured on
    // the same recording (raw frame arrivals: median 16ms, mean 14-15ms, p10-p90
    // 8-20ms). So a gesture is the part of a recording where frames mostly do
    // NOT tie: 8-16% of consecutive captured frames came out byte-identical
    // inside gesture motion, against most of them during the holds either side,
    // where the ramble's 28ms sets the pace (see STEP_MS and `drift`). That
    // split holds only while the round trip stays where it is. Driving from
    // wall time keeps the gesture the length it claims to be whatever the
    // round trip does.
    await acquirePointer()
    try {
      const t0 = Date.now()
      for (;;) {
        const raw = (Date.now() - t0) / duration
        const t = raw >= 1 ? 1 : reachProfile(raw)
        const u = 1 - t
        await moveTo(
          u * u * from.x + 2 * u * t * cx + t * t * tx,
          u * u * from.y + 2 * u * t * cy + t * t * ty,
        )
        if (raw >= 1) break
        await sleep(4)
      }
    } finally { releasePointer() }
    ptr = { x: tx, y: ty }
  }

  // --- Idle pointer motion --------------------------------------------------
  // OFF by default. The ramble below was on for every hold, on the theory that
  // a perfectly still pointer reads as generated — but in a bug reproduction it
  // reads as a cursor wandering in circles while nothing happens, which draws
  // the eye away from the thing the video is about. Set
  // `RECORD_CURSOR_RAMBLE=1` to bring it back.
  //
  // Nothing else depends on it. Frame emission is held up by the overlay's 1px
  // rAF keepalive canvas (see the injected overlay above), not by pointer
  // motion, so a still cursor still yields a hold at wall-clock length rather
  // than a compressed one.
  const IDLE_RAMBLE = /^(1|true|on|yes|ramble)$/i.test(process.env.RECORD_CURSOR_RAMBLE || '')
  //
  // What the ramble does when it is on: a hand resting on a mouse never holds
  // still, and a pointer that holds one pixel for half a second is the loudest
  // tell that a video was generated.
  //
  // The pointer rambles: a heading that random-walks, a speed that never drops
  // to zero, and a pull back towards where the hand is resting so the whole
  // excursion stays inside ~18px. Constant-ish speed is the point - a sum of
  // sines has moments of zero velocity, and those land as long still runs.
  //
  // Consecutive captured frames are NOT all distinct, and cannot be. Capture
  // runs at a 15-17ms median period (58-68fps, the overlay's rAF keepalive
  // driving it) and emission at 28ms, so `1 - 15/28` of frame pairs must show a
  // position the previous frame already showed. Measured live on the 2.5s
  // opening hold of three recordings: 49.4%, 41.0%, 49.4% repeated, against
  // 47%, 39%, 47% predicted. What the ramble actually buys is that the repeats
  // stay isolated - longest still run 3-4 frame intervals, 0.050-0.060s - not
  // that no two frames ever tie.
  //
  // How far the cursor moves between two captured frames is NOT speed x frame
  // interval. A captured frame shows the last position that was dispatched, so
  // a frame-to-frame delta spans one *or two* emitter steps depending on where
  // the frame boundary falls. The bound is therefore
  //
  //     v_max x (frame_period + step_period)
  //
  // = 55 x 1.22 px/s over 15 + 28ms ~= 2.9px at the median frame period, with a
  // floor of 0: the walk can double back inside a frame. Measured live
  // (cursor-dot centroid, 58.2-68.3fps, three runs): min 0.00, p25 0.00, median
  // 0.34-0.99, mean 0.79-0.92, p90 2.07-2.14, max 2.50-3.29px. Evaluated per
  // pair against that pair's own interval, 2 of 170 sit above the bound by
  // under 20% - the frame times are arrival times, and delivery jitter moves a
  // boundary by more than that. Treat the formula as the shape of the ceiling.
  //
  // STEP_MS paces emission off the wall clock instead of "whatever the round
  // trip cost, plus 4". Below it the loop cannot outrun the target; above it the
  // round trip is the pace and the sleep contributes nothing, which is the
  // regime where the duplicate rate climbs further (it cannot be driven to zero
  // from here: no amount of sleeping makes CDP answer faster).
  //
  // Everything random in here comes off `rambleRand`, never the main stream:
  // both how many iterations a hold runs *and* how many holds there are depend
  // on timing (a `settle` that finds three spinners instead of five is three
  // holds instead of five), so a single draw from the main stream anywhere in
  // this path would desynchronise every gesture after it. One local stream per
  // call, so a given hold's shape depends only on how many holds preceded it.
  const TAU = Math.PI * 2
  // Target emission period for the ramble. A wall-clock target rather than a
  // fixed trailing sleep: on a fast link it stops the loop spending round trips
  // nobody sees, and on a slow one it adds nothing on top of the round trip the
  // way `sleep(4)` did. It sits *above* the 15-17ms capture period, not below
  // it - which is where the duplicate-frame rate above comes from. Lowering it
  // would not fix that: at 8ms of synthetic round trip the emitter still cannot
  // beat the compositor, and every step costs a CDP round trip nobody sees.
  const STEP_MS = 28
  async function drift(shouldStop) {
    // Still cursor: hold the pointer where the last gesture left it and just
    // wait the caller out. Same contract as the ramble — return when
    // `shouldStop()` says the wait is over — so `pause`, `idle` and `settle`
    // behave identically either way.
    if (!IDLE_RAMBLE) {
      while (!shouldStop()) await sleep(20)
      return
    }
    // Another ramble already owns the pointer (a `pause` inside an `idle`, or
    // nested `idle`s - and `settle` is both, since every locator wait inside it
    // is an `idle` of its own). Two would fight, so wait it out - and then take
    // over, rather than staying in the poll for the rest of the caller's wait.
    // Standing down permanently is how `settle`'s network-quiet phase, which
    // has no inner wait to ramble for it, ended up frozen.
    while (!shouldStop() && driftActive) await sleep(20)
    if (shouldStop()) return
    driftActive = true
    let warned = false
    try {
      if (!primed) { try { await moveTo(ptr.x, ptr.y) } catch { /* reported below */ } }
      const local = mulberry32((rambleRand() * 4294967296) >>> 0)
      const lrnd = (a, b) => a + local() * (b - a)
      let home = { ...ptr }
      const speed = lrnd(35, 55)        // px/s
      const radius = lrnd(6.5, 9)       // px, soft bound on the excursion
      const turn = lrnd(1.8, 3.2)       // rad/s of heading wander
      let ang = lrnd(0, TAU)
      let phase = lrnd(0, TAU)
      let x = ptr.x, y = ptr.y
      // One frame in the past, not "now": a first step with dt=0 emits the
      // position the pointer is already at, and that duplicate is a
      // pixel-identical frame pair at capture rate - the exact thing the
      // ramble exists to prevent.
      let last = Date.now() - 16
      while (!shouldStop()) {
        // A real gesture owns the pointer (a glide, a scroll, the press inside
        // `click`). Stand aside, then pick up from wherever it left the cursor.
        if (pointerBusy) {
          await sleep(15)
          x = ptr.x; y = ptr.y; home = { ...ptr }; last = Date.now() - 16
          continue
        }
        const now = Date.now()
        const dt = Math.min(0.12, (now - last) / 1000)
        last = now
        ang += (local() * 2 - 1) * turn * dt
        // Steer home, harder the further out it has wandered.
        const ox = x - home.x, oy = y - home.y
        const r = Math.hypot(ox, oy)
        if (r > 0.5) {
          const homeAng = Math.atan2(-oy, -ox)
          let diff = ((homeAng - ang + Math.PI * 3) % TAU) - Math.PI
          ang += diff * Math.min(1, (r / radius) ** 2) * Math.min(1, 6 * dt)
        }
        phase += dt * 2.1
        const v = speed * (1 + 0.22 * Math.sin(phase))   // never near zero
        x += Math.cos(ang) * v * dt
        y += Math.sin(ang) * v * dt
        // A move can be rejected mid-navigation. Say so once and keep the hold
        // alive rather than throwing: the caller's wait still has to finish,
        // and a rejected ramble used to leave the rest of it frozen in silence.
        rambleMoving++
        let failed = null
        try { await moveTo(x, y) } catch (e) { failed = e } finally { rambleMoving-- }
        if (failed) {
          if (!warned) {
            console.error(`drift(): pointer move failed (${failed.message}); retrying, this part of the hold has no motion.`)
            warned = true
          }
          x = ptr.x; y = ptr.y; home = { ...ptr }; last = Date.now() - 16
          await sleep(30)
          continue
        }
        // Pace off the wall clock: whatever the round trip cost comes out of
        // the target, so the emission period is STEP_MS on a fast link and the
        // round trip on a slow one. The 1ms floor is there to yield, not to add.
        await sleep(Math.max(1, STEP_MS - (Date.now() - now)))
      }
    } finally { driftActive = false }
  }

  // Run an await that has nothing to do with the pointer (a UI wait, a
  // navigation) with the idle drift going underneath it, so waiting for the
  // page does not freeze the cursor either.
  async function idle(work) {
    let over = false
    const task = (async () => {
      try { return await (typeof work === 'function' ? work() : work) } finally { over = true }
    })()
    // `drift` handles a failing mouse move itself, so anything that lands here
    // is unexpected. It must not take the wait down with it, but it must not
    // be swallowed either - a silent catch is how the rest of a wait ends up
    // frozen with nothing in the log to explain it.
    const motion = drift(() => over).catch((e) => {
      console.error(`idle(): pointer ramble stopped (${e && e.message}); the rest of this wait is frozen.`)
    })
    const [result] = await Promise.all([task, motion])
    return result
  }

  // --- Scrolling ------------------------------------------------------------
  // `scrollIntoViewIfNeeded` jumps the page in a single frame: measured against
  // the dashboard's main scroller, 556px between one rendered frame and the
  // next. That was the one gesture left in a recording that still teleported -
  // the cursor glided while the document under it cut. This eases the same
  // travel over a few hundred milliseconds instead, one step per rendered
  // frame. Measured live on 332px of that scroller: 38-45 steps over three
  // runs, one of them 1,1,1,2,3,3,4,5,7,5,10,9,12,10,14,15,17,18,22,22,16,15,
  // 17,19,13,12,10,9,8,7,6,4,8,2,2,1,1,1 - accelerate, peak, decelerate. The
  // count is duration/render period, so it moves with the frame rate: the same
  // travel came out as 15-16 much larger steps back when render ran ~25fps.
  async function wheel(dy, opts = {}) {
    const R = opts.rng ?? rand
    const dist = Math.abs(dy)
    if (dist < 8) return
    if (!primed) await moveTo(ptr.x, ptr.y)
    const dir = dy < 0 ? -1 : 1
    // The tween runs inside the page rather than as a stream of CDP wheel
    // events. Measured: under an active screencast each round-tripped
    // `mouse.wheel` costs 40-140ms, so the scroll lands in 6-10 jumps of up to
    // 140px - the same teleport in smaller pieces. Animating in the page puts
    // exactly one eased step on every rendered frame, and still fires real
    // scroll events on whichever container a wheel would have moved.
    await acquirePointer()
    try {
      await page.evaluate(({ x, y, delta, fixedDuration }) => new Promise((resolve) => {
        const scrollerFor = (el) => {
          for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
            const s = getComputedStyle(n)
            if (/(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return n
          }
          return document.scrollingElement || document.documentElement
        }
        const el = scrollerFor(document.elementFromPoint(x, y) || document.body)
        const prevBehavior = el.style.scrollBehavior
        el.style.scrollBehavior = 'auto'   // do not fight a CSS smooth-scroll
        const from = el.scrollTop
        // Clamp to what the scroller can actually give before the tween starts.
        // Unclamped, a request past the end spends its whole deceleration half
        // pressed against the boundary: measured on a `wheel(-600)` against a
        // scroller with ~330px left, the per-frame steps ran
        // -2,-4,-6,-9,-14,-17,-22,-25,-32,-38,-45,-49,-63 and then simply
        // stopped - all acceleration, no arrival. Clamping first means the ease
        // describes the travel that exists, so the scroll still lands softly.
        const room = Math.max(0, el.scrollHeight - el.clientHeight)
        const d = Math.max(-from, Math.min(delta, room - from))
        if (Math.abs(d) < 1) { el.style.scrollBehavior = prevBehavior; return resolve(0) }
        // Duration follows the clamped distance for the same reason.
        const duration = fixedDuration ?? Math.max(380, Math.min(1600, 260 + 1.5 * Math.abs(d)))
        const ease = (t) => t < 0.5 ? 4 * t ** 3 : 1 - Math.pow(2 - 2 * t, 3) / 2
        const t0 = performance.now()
        const step = () => {
          const t = Math.min(1, (performance.now() - t0) / duration)
          el.scrollTop = from + d * ease(t)
          if (t < 1) return requestAnimationFrame(step)
          el.style.scrollBehavior = prevBehavior
          resolve(d)
        }
        requestAnimationFrame(step)
      }), {
        // Which scroller moves is decided by a point on screen, the way a wheel
        // decides it. Callers that know what they are scrolling towards (see
        // `scrollTo`) pass the target's own position, so a pointer parked over
        // the side nav does not scroll the side nav instead of the content.
        x: Math.round(clamp(opts.at?.x ?? ptr.x, 2, (page.viewportSize()?.width ?? 1280) - 2)),
        y: Math.round(clamp(opts.at?.y ?? ptr.y, 2, (page.viewportSize()?.height ?? 720) - 2)),
        delta: dir * dist, fixedDuration: opts.duration ?? null,
      })
    } finally { releasePointer() }
    await sleep(90 + R() * 80)   // the page comes to rest before the hand acts
  }

  // Bring a target into comfortable view by scrolling, not by jumping. Falls
  // back to Playwright's instant scroll only when the tween cannot move it at
  // all (nested scrollers, or a target with no box), so a script never fails
  // to reach something just because the scroll is prettier now.
  async function scrollTo(target, opts = {}) {
    const l = loc(target)
    const vp = page.viewportSize() || { width: 1280, height: 720 }
    const margin = opts.margin ?? 90
    // How many attempts this loop runs is decided by the page, not by the
    // script, so anything drawn inside it would shift the main stream by an
    // amount that depends on what the page did. One draw, then spend a local
    // stream seeded from it - see `drift` for the same treatment.
    const rng = mulberry32((rand() * 4294967296) >>> 0)
    const box2 = () => idle(() => l.boundingBox({ timeout: opts.timeout ?? 5000 }).catch(() => null))
    for (let attempt = 0; attempt < 3; attempt++) {
      // Short timeout: if the element is not there yet this is not the call
      // that should spend 30s finding out - the click/hover that follows will
      // report it properly. Wrapped in `idle` because Playwright spends that
      // timeout with the pointer parked otherwise.
      const box = await box2()
      if (!box) { await l.scrollIntoViewIfNeeded().catch(() => {}); return }
      let dy = 0
      if (box.y < margin) dy = box.y - margin
      else if (box.y + box.height > vp.height - margin) dy = box.y + box.height - (vp.height - margin)
      if (Math.abs(dy) < 8) return
      // Put the pointer over the region that owns the scroll before wheeling,
      // the way a person moves toward what they are about to look at.
      if (attempt === 1) {
        await glide(clamp(box.x + box.width / 2, 60, vp.width - 60), vp.height / 2, { rng })
        await sleep(50 + rng() * 60)
      }
      await wheel(dy, { at: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, rng })
      const after = await box2()
      if (!after || Math.abs(after.y - box.y) < 4) {
        if (attempt >= 1) { await l.scrollIntoViewIfNeeded().catch(() => {}); return }
      }
    }
  }

  // Full reach: on longer travel a person frequently sails slightly past the
  // target and pulls back, so do the same about half the time.
  async function reach(tx, ty) {
    const dist = Math.hypot(tx - ptr.x, ty - ptr.y)
    if (dist > 220 && rand() < 0.45) {
      const ux = (tx - ptr.x) / dist
      const uy = (ty - ptr.y) / dist
      const over = rnd(7, 18)
      await glide(tx + ux * over + rnd(-4, 4), ty + uy * over + rnd(-4, 4))
      await sleep(rnd(45, 95))
    }
    await glide(tx, ty)
  }

  async function centreOf(target) {
    const l = loc(target)
    await scrollTo(l)
    // `boundingBox()` has its own actionability wait: on a target that is not
    // there yet it can sit for seconds, and it does that with the pointer
    // parked unless the ramble is running underneath it.
    const box = await idle(() => l.boundingBox())
    if (!box) return null
    return { box, x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }

  async function move(target) {
    const p = await centreOf(target)
    if (!p) { await loc(target).hover(); await sleep(MOVE_DELAY); primed = true; return }
    await reach(p.x, p.y)
    await sleep(rnd(60, 130))   // settle: the hand arrives before the finger acts
  }

  async function click(target, opts = {}) {
    const l = loc(target)
    await move(target)
    await sleep(rnd(40, 100))
    // Playwright runs its own actionability wait *inside* `click()`, with the
    // pointer wherever it was. Do the visibility half of that wait out here,
    // with the ramble underneath, so the only frozen part is the press itself
    // (~55-105ms). The rest of the actionability check is normally instant by
    // this point, because `move` already resolved the element's box.
    await idle(() => l.first().waitFor({ state: 'visible', timeout: 10_000 })).catch(() => {})
    // `delay` is the dwell between mousedown and mouseup. Zero reads as a
    // machine; 55-105ms is what a person's finger does. The pointer is owned
    // for the press so a ramble running under some outer wait cannot drag the
    // cursor out from under the button between mousedown and mouseup.
    await acquirePointer()
    try {
      await l.click({ delay: Math.round(rnd(55, 105)), ...opts })
    } finally { releasePointer() }
  }

  async function type(target, text, opts = {}) {
    await click(target)
    await sleep(rnd(90, 180))    // look at the field before the first keystroke
    await typeText(text, opts)
  }

  // Variable-cadence typing. The first keystroke lands after a beat (the hand
  // finding the keys, not a longer gap *after* character one, which reads as
  // the second character lagging), the first few characters run slightly slow
  // and then settle into a rhythm, gaps stretch after spaces and punctuation,
  // and there is the occasional short think-pause.
  async function typeText(text, opts = {}) {
    const base = opts.delay || TYPE_DELAY
    const chars = [...String(text)]
    if (opts.lead !== false && chars.length) await sleep(base * rnd(0.9, 1.6))
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]
      await page.keyboard.type(ch)
      if (i === chars.length - 1) break
      const warmup = i < 3 ? 1.3 - 0.1 * i : 1      // settles by the 4th key
      let d = base * rnd(0.55, 1.5) * warmup
      if (ch === ' ') d += base * rnd(0.5, 1.2)
      else if ('.,;:!?/\\-_@()[]{}'.includes(ch)) d += base * rnd(0.8, 1.6)
      if (rand() < 0.05) d += base * rnd(2, 4)
      await sleep(d)
    }
  }

  // A hold that is not dead air: the pointer wanders continuously for the whole
  // hold (see `drift`). Emission is slower than capture, so ~41-49% of frame
  // pairs do repeat a position; what the ramble guarantees is that they stay
  // isolated - measured longest still run 0.050-0.060s, against the 18.9s
  // freezes this replaced. `{ still: true }` opts out and really does freeze the
  // pointer - only use it when the frame has its own motion.
  async function pause(ms, opts = {}) {
    const total = Math.max(0, Math.round(ms))
    if (total <= 0) return
    // A live cursor makes a hold *look* recorded; it does not make it earn its
    // place. A long beat with nothing to read and nothing loading is still the
    // video sitting and waiting, so warn on it the way `say` warns on a banner
    // too long to read. `{ ack: true }` is the acknowledgement; holds that
    // `read`/`say` derive from actual on-screen text pass `tied` and never warn.
    if (total > PAUSE_WARN_MS && !opts.tied && !opts.ack) {
      const why = opts.legacy
        ? 'page.waitForTimeout() is a guess by construction - use waitFor()/settle() for a UI wait and say()/read() for a reading beat'
        : 'keep untied beats under ~1.2s, or pass { ack: true } if the frame really needs it'
      console.error(`pause(): ${total}ms hold with nothing tied to it. ${why}.`)
    }
    // Under about three captured frames there is nothing to ramble through:
    // spinning up a hold, priming the pointer and tearing it down again costs
    // more than the two or three frames it could move on. The idiom this
    // protects is the hand-rolled `page.mouse.move` loop with a short wait
    // between steps - those raw moves now claim the pointer and publish where
    // they left it, so a longer hold inside such a loop is merely pointless
    // rather than actively harmful.
    if (opts.still || total < 120) { await sleep(total); return }
    // `drift` primes the pointer, so the first hold of a recording is never a
    // frame with no cursor in it at all.
    const t0 = Date.now()
    await drift(() => Date.now() - t0 >= total)
  }

  // Hold for as long as the given text takes to read (or a literal ms count).
  // Tied to text by definition, so it never trips the untied-hold warning.
  async function read(textOrMs, opts = {}) {
    await pause(typeof textOrMs === 'number' ? textOrMs : readingTime(textOrMs, opts), { ...opts, tied: true })
  }

  // Wait for the view to actually be ready: spinners gone, then a short quiet
  // window with no gating requests in flight. Returns as soon as both hold,
  // so a page that is ready in 200ms costs 200ms. Never blocks past `timeout`.
  // The idle drift runs underneath both waits, so a slow view does not buy the
  // video a frozen cursor on top of a frozen page.
  async function settle(opts = {}) {
    const { quiet = 400, timeout = 8000, spinners = SPINNERS } = opts
    await idle(async () => {
      const deadline = Date.now() + timeout
      for (const sel of spinners) {
        const left = deadline - Date.now()
        if (left <= 0) break
        try { await page.locator(sel).first().waitFor({ state: 'hidden', timeout: left }) } catch { /* absent or stuck */ }
      }
      while (Date.now() < deadline) {
        if (inflight === 0 && Date.now() - lastNetChange >= quiet) return
        await sleep(60)
      }
    })
  }

  // `.first()` so a selector that happens to match several elements is a wait,
  // not a strict-mode violation. Waiting is never ambiguous the way a click is.
  async function waitFor(target, opts = {}) {
    await idle(() => loc(target).first().waitFor(opts))
  }

  // --- Annotations ----------------------------------------------------------
  //
  // Every one of these is a call into the overlay, and the overlay can
  // genuinely be absent for a moment. It is installed as an init script and
  // re-injected from `page.on('load')`, and that listener is async: a full
  // document load between putting an annotation up and taking it down leaves a
  // fresh `window` whose `__removeHighlight` does not exist yet. An unguarded
  // call there threw `window.__removeHighlight is not a function` out through
  // the script body and past the encode, which discarded a completed recording
  // - 20s of captured frames, no webm at all. Nothing cosmetic is allowed to
  // cost the recording, so every call goes through here: the missing API is a
  // no-op, the destroyed execution context is caught, and either way one stderr
  // line goes out so an annotation that never appeared is not also silent.
  const MISSING = '__hn_no_overlay'
  async function overlayCall(what, fn, arg, target = null) {
    try {
      const r = await (target ? target.evaluate(fn, arg) : page.evaluate(fn, arg))
      if (r === MISSING) {
        console.error(`overlay: ${what} skipped, the overlay is not on this document yet (a page load landed between the annotation and this call)`)
        return null
      }
      return r
    } catch (e) {
      console.error(`overlay: ${what} skipped (${String(e && e.message).split('\n')[0]})`)
      return null
    }
  }

  async function highlight(target, label, opts = {}) {
    const color = opts.color || '#ff3333'
    return overlayCall('highlight', (el, { label, color }) => (
      typeof window.__highlight === 'function'
        ? window.__highlight({ element: el, label, color })
        : '__hn_no_overlay'
    ), { label, color }, loc(target))
  }

  async function removeHighlight(id) {
    if (!id) return
    await overlayCall('removeHighlight', (id) => (
      typeof window.__removeHighlight === 'function' ? (window.__removeHighlight(id), null) : '__hn_no_overlay'
    ), id)
  }

  async function clearHighlights() {
    await overlayCall('clearHighlights', () => (
      typeof window.__clearHighlights === 'function' ? (window.__clearHighlights(), null) : '__hn_no_overlay'
    ))
  }

  async function banner(text, opts = {}) {
    return overlayCall('banner', ({ text, opts }) => (
      typeof window.__banner === 'function' ? window.__banner(text, opts) : '__hn_no_overlay'
    ), { text, opts })
  }

  async function removeBanner(id) {
    if (id) {
      await overlayCall('removeBanner', (id) => (
        typeof window.__removeBanner === 'function' ? (window.__removeBanner(id), null) : '__hn_no_overlay'
      ), id)
    } else {
      await overlayCall('clearBanners', () => (
        typeof window.__clearBanners === 'function' ? (window.__clearBanners(), null) : '__hn_no_overlay'
      ))
    }
  }

  // Show a narrative banner, hold it exactly long enough to be read, drop it.
  // This is the replacement for banner + waitForTimeout(4500) + removeBanner.
  async function say(text, opts = {}) {
    const hold = opts.hold ?? readingTime(text, opts)
    if (hold > 6500 && opts.hold === undefined) {
      console.error(`say(): "${String(text).slice(0, 40)}..." needs ${hold}ms to read. Shorten the banner rather than holding the frame that long.`)
    }
    const id = await banner(text, { color: opts.color })
    await read(hold, opts)
    // `id` is null only if the banner never went up. Do not fall through to
    // `removeBanner()`'s clear-everything branch on the strength of that.
    if (id) await removeBanner(id)
    await pause(140)   // the banner's fade-out is 250ms; do not cut it dead
  }

  // Highlight a thing, hold for its label's reading time, drop it. Moves the
  // pointer onto the target first when the target is a discrete control rather
  // than a whole region, because a person points at what they are looking at.
  async function point(target, label, opts = {}) {
    const p = opts.move === false ? null : await centreOf(target)
    const vp = page.viewportSize() || { width: 1280, height: 720 }
    if (p && p.box.width * p.box.height < vp.width * vp.height * 0.25) {
      await reach(p.x, p.y)
      await sleep(rnd(60, 130))
    }
    const id = await highlight(target, label, opts)
    await read(opts.hold ?? readingTime(label ?? '', { base: 550, min: 1000, ...opts }), opts)
    await removeHighlight(id)
  }

  // --- Raw Playwright waits, made live -------------------------------------
  //
  // The helpers above only fix the scripts that use them. Every script that
  // reaches for `page.waitForTimeout(4000)` - which is what scripts written
  // before these helpers existed do, and what a script written from Playwright
  // habit does - freezes the pointer, the page and the compositor for its full
  // duration. Preserving that is preserving the exact defect this recorder
  // exists to remove, so the raw calls are routed through the live-pointer
  // paths instead. One assignment covers every existing and future script,
  // including ones this repo does not own.
  //
  // `page.waitForTimeout` becomes a `pause` (rambling pointer, warning when the
  // hold is long and untied); the condition waits become `idle(...)` so they
  // keep the ramble underneath while they wait. None of these paths calls back
  // into the patched methods, so there is no recursion; `drift` yields to any
  // gesture that owns the pointer and swallows its own move failures, so there
  // is no deadlock and no throw where Playwright would not have thrown.
  //
  // The same treatment goes to raw `page.mouse.*`, for the mirror-image reason:
  // a wait that was registered but not yet awaited leaves a ramble running
  // underneath the script's own `page.mouse.move` loop, and an unwrapped raw
  // move neither claims the pointer nor updates `ptr`, so the ramble keeps
  // steering back to where the last helper left the cursor and interleaves
  // foreign moves into the script's gesture.

  // How long a raw pointer call keeps the ramble at bay after it returns. Long
  // enough to cover the settle-and-press at the end of a hand-rolled move loop
  // (`waitForTimeoutStill(90)` then a click), short enough that a real wait
  // after the loop starts rambling promptly.
  const EXTERNAL_LEASE_MS = 120
  let leaseHeld = false
  let leaseTimer = null
  function renewLease() {
    if (!leaseHeld) { leaseHeld = true; pointerBusy++ }
    if (leaseTimer) clearTimeout(leaseTimer)
    leaseTimer = setTimeout(dropLease, EXTERNAL_LEASE_MS)
    leaseTimer.unref?.()
  }
  function dropLease() {
    if (leaseTimer) { clearTimeout(leaseTimer); leaseTimer = null }
    if (leaseHeld) { leaseHeld = false; pointerBusy-- }
  }

  // Explicit form of the same thing, for a script that drives the pointer by
  // hand for longer than one call: `const done = await ownPointer()` ... then
  // `done({ x, y })` with wherever it left the cursor. Held until released
  // (no expiry), and the release hands back through the normal lease so the
  // ramble does not snap in the instant the script lets go.
  async function ownPointer() {
    renewLease()
    if (leaseTimer) { clearTimeout(leaseTimer); leaseTimer = null }
    // A ramble step can already be in flight over CDP; it cannot be cancelled,
    // only waited for, or it lands *after* the caller's own move.
    for (let i = 0; i < 40 && rambleMoving; i++) await sleep(5)
    let released = false
    return (pos) => {
      if (released) return
      released = true
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        ptr = { x: pos.x, y: pos.y }
        primed = true
      }
      renewLease()
    }
  }

  async function external(fn, pos) {
    const release = await ownPointer()
    try { return await fn() } finally { release(pos) }
  }

  function installLiveWaits() {
    if (page.__hnLiveWaits) return false
    page.__hnLiveWaits = true

    const rawTimeout = page.waitForTimeout.bind(page)
    // Escape hatch for a script that really wants a dead sleep (an off-camera
    // transition, a frame with its own animation).
    page.waitForTimeoutStill = rawTimeout
    page.waitForTimeout = (ms) => pause(ms, { legacy: true })

    // Condition waits: same result, same timeouts, pointer alive throughout.
    // Each is invoked synchronously inside `idle` so the listener-registering
    // ones (`waitForEvent`, `waitForResponse`, `waitForNavigation`) still
    // subscribe before the caller triggers the thing they are waiting for.
    for (const name of [
      'waitForSelector', 'waitForURL', 'waitForResponse', 'waitForRequest',
      'waitForLoadState', 'waitForFunction', 'waitForEvent', 'waitForNavigation',
    ]) {
      const raw = page[name]
      if (typeof raw !== 'function') continue
      page[name] = (...args) => idle(() => raw.apply(page, args))
    }

    // Raw pointer calls: claim the pointer for the call plus a short lease, and
    // publish where the caller put the cursor. Instance properties, so this is
    // this page's mouse only. `moveTo` was bound to the originals above, so the
    // recorder's own moves do not come back through here.
    const m = page.mouse
    if (m && !m.__hnLiveWaits) {
      m.__hnLiveWaits = true
      if (rawMouse.move) m.move = (x, y, ...r) => external(() => rawMouse.move(x, y, ...r), { x, y })
      if (rawMouse.click) m.click = (x, y, ...r) => external(() => rawMouse.click(x, y, ...r), { x, y })
      if (rawMouse.dblclick) m.dblclick = (x, y, ...r) => external(() => rawMouse.dblclick(x, y, ...r), { x, y })
      // No coordinates of their own; they still must not have a ramble move
      // land between the press and the release.
      if (rawMouse.down) m.down = (...a) => external(() => rawMouse.down(...a))
      if (rawMouse.up) m.up = (...a) => external(() => rawMouse.up(...a))
    }

    // `locator.waitFor` is the other one scripts reach for directly. It has to
    // be patched on the prototype, since locators are created per call - and in
    // playwright-core that prototype is a module-level class shared by every
    // page in the process. A patch that closed over *this* page's ramble would
    // therefore drive the wrong pointer for a locator belonging to some other
    // page, and a dead one once this page is closed. So the patch is installed
    // once per prototype, resolves the helper layer from the locator's own
    // page, and calls straight through for a page that has none.
    LIVE_PAGES.set(page, { idle })
    try {
      const proto = Object.getPrototypeOf(page.locator('html'))
      if (proto && typeof proto.waitFor === 'function') {
        let entry = LOCATOR_PATCHES.get(proto)
        if (!entry) {
          entry = { raw: proto.waitFor, own: Object.hasOwn(proto, 'waitFor'), live: 0 }
          const { raw } = entry
          proto.waitFor = function (...args) {
            let owner = null
            try { owner = typeof this.page === 'function' ? this.page() : this._frame?.page?.() ?? null } catch { owner = null }
            const live = owner && LIVE_PAGES.get(owner)
            return live ? live.idle(() => raw.apply(this, args)) : raw.apply(this, args)
          }
          LOCATOR_PATCHES.set(proto, entry)
        }
        entry.live++
        patchedProto = proto
      }
    } catch (e) {
      console.error(`record-script: could not make locator.waitFor live (${e.message}); explicit locator waits will hold the pointer still.`)
    }
    return true
  }

  // Undo everything `installLiveWaits` did to shared state. The page-local
  // patches die with the page; the `Locator.prototype` one does not, so it is
  // reference-counted and restored when the last live page lets go of it.
  let patchedProto = null
  function disposeLiveWaits() {
    if (!LIVE_PAGES.has(page)) return
    LIVE_PAGES.delete(page)
    dropLease()
    const entry = patchedProto && LOCATOR_PATCHES.get(patchedProto)
    if (entry && --entry.live <= 0) {
      if (entry.own) patchedProto.waitFor = entry.raw
      else delete patchedProto.waitFor
      LOCATOR_PATCHES.delete(patchedProto)
    }
    patchedProto = null
  }
  // Only the call that actually installed owns the undo; a second
  // `buildHelpers` on the same page early-returns and must not replace it with
  // a closure that has nothing to give back.
  if (installLiveWaits()) page.__hnDisposeLiveWaits = disposeLiveWaits

  return {
    click, type, move, waitFor,
    highlight, removeHighlight, clearHighlights,
    banner, removeBanner,
    // Added: pacing helpers so scripts stop hand-rolling sleeps.
    settle, pause, read, readingTime, say, point, typeText,
    // Added: scrolling that does not teleport, and a way to run any other
    // await (page.waitForURL, waitForResponse) without freezing the pointer.
    scrollTo, wheel, idle,
    // Added: explicit pointer ownership for a script that drives the cursor by
    // hand across several calls. Single `page.mouse.*` calls do not need it.
    ownPointer,
    MOVE_DELAY, TYPE_DELAY,
  }
}

// Run a user-provided playwright script while recording. The script receives:
//
//   input       click(target, opts?)   move(target)   type(target, text, opts?)
//               typeText(text, opts?)   scrollTo(target)   wheel(dy)
//   waiting     waitFor(target, opts?)   settle(opts?)   idle(promiseOrFn)
//   pacing      pause(ms, opts?)   read(textOrMs, opts?)   readingTime(text, opts?)
//   annotation  say(text, opts?)   point(target, label, opts?)
//               highlight / removeHighlight / clearHighlights
//               banner / removeBanner
//   control     page, ctx, startRecording, MOVE_DELAY, TYPE_DELAY
//
// `startRecording` gates frame capture - call it after page load / setup is
// done so the video only captures the interactions, not the initial load.
// Recording stops the moment the script's promise resolves.
// Viewport is pinned to 1280x720.
//
// Prefer `settle()` over a fixed sleep after navigation, `say`/`point` over
// banner + sleep + removeBanner, and `pause`/`read` over waitForTimeout. All
// of them hold only as long as there is something to wait for or read, and the
// pointer wanders continuously underneath them, so the longest stretch a hold
// sits still for is 0.050-0.060s (see `drift` for what that does and does not
// mean frame by frame).
//
// Scripts that do none of that still get the floor: `buildHelpers` rebinds the
// raw Playwright waits on this page before the script body runs -
// `page.waitForTimeout` becomes a rambling `pause`, and the condition waits
// (`waitForSelector`, `waitForURL`, `waitForResponse`, `locator.waitFor`, ...)
// run inside `idle`. Same durations, same results, live pointer. The dead sleep
// is still available as `page.waitForTimeoutStill(ms)` for an off-camera beat.
// `idle(...)` remains the wrapper for a wait none of those covers.
//
// The script must default-export an async function that accepts
// {page, ctx, startRecording, click, type, move, waitFor, settle, say, point, ...}.
async function recordScript(scriptPath, out, opts) {
  const path = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const abs = path.resolve(scriptPath)
  const mod = await import(pathToFileURL(abs).href)
  const action = mod.default || mod.run
  if (typeof action !== 'function') {
    throw new Error(`script ${scriptPath} must default-export (or export 'run') an async function ({page, ctx, startRecording, click, type, ...}) => ...`)
  }
  // Always use a new tab so the script doesn't trample on whatever the user is
  // currently looking at, and so the overlay's cursor starts in a clean place.
  // deferCapture: script controls when frames start being saved via startRecording().
  // viewport: pin to 1280×720 for consistent recording output.
  await runRecording(out, { ...opts, newTab: true, deferCapture: true, viewport: { width: 1280, height: 720 } }, async (page, ctx, startRecording) => {
    const helpers = buildHelpers(page)
    // `buildHelpers` patches `Locator.prototype`, which outlives the page and
    // the recording. Hand it back whatever the script does.
    try {
      await action({ page, ctx, startRecording, ...helpers })
    } finally {
      try { page.__hnDisposeLiveWaits?.() } catch { /* nothing left to undo */ }
    }
  })
}

// Shared recording machinery - sets up overlay + screencast, runs the body,
// then stops + ffmpeg-assembles. `body` controls what happens during capture
// (fixed duration for `record`, scripted actions for `recordScript`).
//
// opts.deferCapture: if true, frames are discarded until body calls
// startRecording(). Use for record-script so the initial page load
// (blank → spinner → content) stays out of the video.
async function runRecording(out, opts, body) {
  const conn = await connect(opts)
  // A tab we opened ourselves gets the standard recording size; a tab the user
  // already had open is never resized out from under them.
  const viewport = opts.viewport || (conn.createdPage ? { width: 1280, height: 720 } : null)
  if (viewport) await conn.page.setViewportSize(viewport)
  // Every mode pins the screencast to the page's CSS-pixel viewport, not just
  // record-script. The sidecar runs at devicePixelRatio 2, so unpinned frames
  // come back at twice the size in each axis: several times the bytes and the
  // encode time of the thing anyone actually watches.
  const capSize = viewport
    || conn.page.viewportSize()
    || await conn.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => null)
  await installOverlay(conn.page, conn.ctx)
  try { await conn.page.evaluate(OVERLAY_SCRIPT) } catch {}
  // addInitScript can miss navigations on CDP connections - re-inject on load.
  conn.page.on('load', async () => {
    try { await conn.page.evaluate(OVERLAY_SCRIPT) } catch {}
  })
  const client = await conn.page.context().newCDPSession(conn.page)
  const tmpDir = `/tmp/screencast-${Date.now()}`
  await fs.mkdir(tmpDir, { recursive: true })
  let frame = 0
  let capturing = !opts.deferCapture
  let t0 = capturing ? Date.now() : 0
  let t1 = 0
  // Everything in here is best-effort: a frame can arrive while the page is
  // being torn down, and an unhandled rejection from the ack would kill the
  // process between the last frame and the encode, losing the whole recording.
  client.on('Page.screencastFrame', async ({ data, sessionId }) => {
    try {
      if (capturing) {
        const n = String(frame++).padStart(6, '0')
        await fs.writeFile(`${tmpDir}/f${n}.jpg`, Buffer.from(data, 'base64'))
        t1 = Date.now()
      }
      await client.send('Page.screencastFrameAck', { sessionId })
    } catch { /* page closed mid-frame */ }
  })
  await client.send('Page.startScreencast', {
    format: 'jpeg', quality: 80, everyNthFrame: 1,
    ...(capSize ? { maxWidth: Math.round(capSize.width), maxHeight: Math.round(capSize.height) } : {}),
  })
  const startRecording = () => { if (!capturing) { capturing = true; t0 = Date.now() } }
  // Frames already on disk are worth more than the throw is. A script that dies
  // at second 20 of a 24s run has still recorded the thing it was demonstrating,
  // and re-running costs minutes; discarding the frames to re-raise immediately
  // is the most expensive possible way to report the error. Encode first, then
  // re-throw, so the exit code and the message are unchanged.
  let bodyError = null
  try {
    await body(conn.page, conn.ctx, startRecording)
  } catch (err) {
    bodyError = err
  } finally {
    capturing = false
    try { await client.send('Page.stopScreencast') } catch { /* page may be closed */ }
    await disconnect(conn)
  }

  // Encode at the rate the frames actually arrived at, not a hardcoded 15.
  // Screencast emits on compositor activity, so the rate is a property of the
  // machine, not a constant: a fixed 15 fps input stretched every recording by
  // a third and turned every pause into a longer one. Measuring keeps playback
  // locked to wall-clock time whatever the compositor does.
  //
  // The ceiling is a guard against a divide-by-a-tiny-elapsed, not a rate
  // policy. It was 60, written when capture ran ~20 fps and could not reach it.
  // The overlay's rAF keepalive now drives capture to 61-68 fps, so 60 clamped
  // the encode below the true rate and stretched playback by up to 13% - the
  // same defect as the original hardcoded 15, arrived at from the other side.
  // Anything the compositor can actually produce must pass through untouched.
  const elapsed = (t1 - t0) / 1000
  if (frame === 0) {
    await fs.rm(tmpDir, { recursive: true, force: true })
    throw bodyError || new Error('no frames captured - the script failed before startRecording(), or the browser sidecar went away mid-run')
  }
  const fps = (frame > 2 && elapsed > 0.5) ? clamp(frame / elapsed, 4, 240) : 15
  console.log(`captured ${frame} frames over ${elapsed.toFixed(1)}s -> encoding at ${fps.toFixed(2)} fps`)
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-framerate', fps.toFixed(3), '-i', `${tmpDir}/f%06d.jpg`,
      // yuv420p needs even dimensions and a viewport can be an odd number of
      // pixels tall, so round down rather than fail the encode.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libvpx-vp9', '-b:v', '1M', '-pix_fmt', 'yuv420p',
      '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1',
      out,
    ], { stdio: 'inherit' })
    ff.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)))
  })
  await fs.rm(tmpDir, { recursive: true, force: true })
  console.log(`saved ${out}`)
  if (bodyError) {
    console.error(`script failed after ${frame} frames; ${out} holds the recording up to that point`)
    throw bodyError
  }
}

const argv = process.argv.slice(2)
const newTab = argv.includes('--new-tab')
const positional = argv.filter(a => a !== '--new-tab')
const [cmd, ...rest] = positional
const opts = { newTab }
try {
  if (cmd === 'screenshot') await screenshot(rest[0], rest[1] || 'screenshot.png', opts)
  else if (cmd === 'record') await record(rest[0], rest[1] || 'recording.webm', rest[2], opts)
  else if (cmd === 'record-script') await recordScript(rest[0], rest[1] || 'recording.webm', opts)
  else if (cmd === 'goto') await goto(rest[0], opts)
  else if (cmd === 'eval') await evalJs(rest[0], opts)
  else {
    console.error(`Unknown command: ${cmd}`)
    console.error(`Usage: browser.mjs {screenshot|record|record-script|goto|eval} ... [--new-tab]`)
    process.exit(1)
  }
} catch (err) {
  console.error(err.message || err)
  process.exit(1)
}

#!/usr/bin/env node
// Taken from this team's `playwright-ui-testing` skill (.claude/skills/playwright-ui-testing/
// scripts/record.mjs) and carried here so the extension is self-contained. The recorder, its
// captions, chapters and callouts are all theirs; the only change is that it will also load
// `playwright-core`, which is what a workspace has.
//
// Use it for anything a person will WATCH. `browser.mjs record` draws a cursor and ripples but
// has no captions, chapters or callouts, so its clips show what happened without saying what it
// means - which is the difference between a recording and an explanation.
// One recorder for every clip we ship: CDP screencast + an injected overlay, driven by a script.
//
// This merges the two things we had and the one we took from codyrancher/rancher-skills:
//
//   * the ENGINE is theirs (record-browser-video): a CDP screencast captured frame-by-frame and
//     assembled by ffmpeg, with an in-page overlay re-injected on every navigation. That buys the
//     two things `playwright-cli video-*` could not do — a visible pointer (cursor dot, click
//     ripples, keystroke badges) and `startRecording()`, which keeps the blank→spinner→content
//     page load out of the clip.
//   * the ANNOTATIONS are ours: the action callouts that made `video-show-actions` mandatory in
//     the first place (each click/type named on screen, target ring-highlighted), plus the
//     caption bar, title/end cards and chapter markers from scripts/pw-lib.mjs.
//   * the OUTPUT is ours: mp4 by default, never bare webm (Safari cannot play webm, and mp4 is
//     smaller). Pass an .webm path if you specifically want VP9.
//
// So a clip recorded through here satisfies the annotated-video rule *and* looks like a person
// driving the UI, which the callout-only clips never did.
//
// Env:
//   RECORD_CDP          attach to an existing Chromium instead of launching one (e.g. a sidecar)
//   RANCHER_PASSWORD    used by login() below
//
// Usage:
//   node record.mjs script <script.mjs> <out.mp4>    # the normal path — see SKILL.md
//   node record.mjs url <url> <out.mp4> [durationMs] # freeform fallback, pauses and all

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The globally-installed playwright, whose chromium the image already cached.
 *
 * Never `npm i playwright` beside a script: that resolves a different version whose browser is
 * not in /ms-playwright, and a one-shot agent then hangs for ever trying to download one.
 *
 * Bare `import('playwright')` is not enough to reach the global install, because NODE_PATH is a
 * CommonJS mechanism and ESM resolution ignores it — the global module is found only by
 * resolving it through `require`, or by absolute path. So: try the ordinary import first (a repo
 * that has its own playwright wins), then fall back to the global root.
 */
async function loadPlaywright() {
  // `playwright-core` as well as `playwright`. A vulnerability-console workspace installs the
  // core package on purpose: it attaches to the Chromium sidecar over CDP and must never try to
  // download a browser of its own into a pod.
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return await import(name);
    } catch { /* not resolvable from here - try the roots below */ }
  }

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const roots = (process.env.NODE_PATH || '').split(':').concat('/usr/local/lib/node_modules').filter(Boolean);

  for (const root of roots) {
    for (const name of ['playwright', 'playwright-core']) {
      try {
        return await import(pathToFileURL(require.resolve(`${ root }/${ name }`)).href);
      } catch { /* next */ }
    }
  }

  throw new Error('neither playwright nor playwright-core is installed - workspace-setup.sh installs playwright-core at $WSD/node_modules.');
}

// playwright is CommonJS, so importing it by absolute path can hand back a namespace whose only
// real member is `default` (node's named-export detection does not always see through it).
const pw = await loadPlaywright();
const chromium = pw.chromium || pw.default?.chromium;

if (!chromium) throw new Error('resolved playwright, but it exposes no chromium — check the install in the image.');

const CDP = process.env.RECORD_CDP || '';
const FPS = 15;

// ── The overlay ─────────────────────────────────────────────────────────────────────────────
//
// Runs in the page, so it must be self-contained: it is passed to addInitScript and re-evaluated
// after every navigation. Idempotent — installing twice is a no-op.
//
// Everything the driver draws goes through `window.__rec`, so the Node side never has to know
// how any of it is rendered.
const OVERLAY = () => {
  if (window.__rec) return;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes __rec_ripple { to { width: 56px; height: 56px; opacity: 0; } }
    @keyframes __rec_keyfade {
      0% { opacity: 0; transform: translateY(8px); }
      12% { opacity: 1; transform: translateY(0); }
      70% { opacity: 1; }
      100% { opacity: 0; transform: translateY(-6px); }
    }
    @keyframes __rec_pulse {
      0% { box-shadow: 0 0 0 0 rgba(220,60,100,0.55); }
      100% { box-shadow: 0 0 0 14px rgba(220,60,100,0); }
    }
  `;
  document.documentElement.appendChild(style);

  const add = (tag, css, text) => {
    const el = document.createElement(tag);
    el.style.cssText = css;
    if (text !== undefined) el.textContent = text;
    document.documentElement.appendChild(el);
    return el;
  };
  const TOP = 'z-index:2147483647;pointer-events:none';

  // --- Route changes, reported OUT to the driver -------------------------------------------
  //
  // The URL bar is no longer drawn in the page — it is a band *below* the viewport, composited
  // at encode time, so it cannot cover the app. All the page does is say when the route changed.
  const sendUrl = () => {
    try { window.__recNote?.('url', location.href); } catch { /* binding not installed yet */ }
  };
  sendUrl();
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function (...args) { orig.apply(this, args); sendUrl(); };
  }
  window.addEventListener('popstate', sendUrl);
  window.addEventListener('hashchange', sendUrl);

  // --- Cursor dot -------------------------------------------------------------------------
  const cursor = add('div', `position:fixed;width:14px;height:14px;${ TOP };
    background:rgba(220,60,100,0.85);border:2px solid #fff;border-radius:50%;
    box-shadow:0 2px 8px rgba(0,0,0,0.4);transform:translate(-50%,-50%);
    transition:top .15s linear,left .15s linear;top:-100px;left:-100px`);
  document.addEventListener('mousemove', (e) => {
    cursor.style.top = `${ e.clientY }px`;
    cursor.style.left = `${ e.clientX }px`;
  }, true);

  // --- Click ripples ----------------------------------------------------------------------
  document.addEventListener('mousedown', (e) => {
    const r = add('div', `position:fixed;top:${ e.clientY }px;left:${ e.clientX }px;${ TOP };
      width:10px;height:10px;background:rgba(220,60,100,0.35);
      border:2px solid rgba(220,60,100,0.85);border-radius:50%;
      transform:translate(-50%,-50%);animation:__rec_ripple .6s ease-out forwards`);
    setTimeout(() => r.remove(), 700);
  }, true);

  // --- Keystroke badges -------------------------------------------------------------------
  const tray = add('div', `position:fixed;right:12px;bottom:40px;${ TOP };
    display:flex;flex-direction:column;align-items:flex-end;gap:4px`);
  document.addEventListener('keydown', (e) => {
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.metaKey) parts.push('⌘');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey && e.key.length > 1) parts.push('Shift');
    parts.push(e.key === ' ' ? 'Space' : e.key);
    const b = add('div', `background:rgba(18,18,22,0.92);color:#fff;
      font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:6px 9px;
      border-radius:4px;border:1px solid rgba(255,255,255,0.15);
      animation:__rec_keyfade 1.2s ease-out forwards`, parts.join('+'));
    tray.appendChild(b);
    // Typing at 60ms produces ~20 badges inside one badge's 1.3s lifetime, which walks a column
    // of keys up the whole right edge. Keep the most recent few — enough to read what was typed.
    while (tray.children.length > 6) tray.firstChild.remove();
    setTimeout(() => b.remove(), 1300);
  }, true);

  // --- webpack-dev-server's runtime-error iframe ------------------------------------------
  //
  // It mounts at max z-index on any compile warning and swallows mouse events, which kills the
  // cursor dot, the ripples and the badges all at once. Removing it on a MutationObserver is
  // the only thing that survives a re-mount mid-recording.
  const killOverlay = () => {
    for (const id of ['webpack-dev-server-client-overlay', 'webpack-dev-server-client-overlay-div']) {
      document.getElementById(id)?.remove();
    }
  };
  killOverlay();
  new MutationObserver(killOverlay).observe(document.documentElement, { childList: true, subtree: true });

  // --- Nudge the compositor ----------------------------------------------------------------
  //
  // CDP only emits a screencast frame when the compositor paints, so a quiet waitForTimeout
  // emits nothing. Upstream leans on this 1px rAF canvas to keep frames flowing — but it does
  // not actually work in a headless container (a fully transparent layer is never painted): a
  // 10s idle wait yields ~1 frame either way. Timing therefore does NOT depend on it; every
  // frame is stamped with its arrival time and the encode resamples to a constant rate. Kept
  // because it costs nothing and does help where the compositor honours it.
  const ff = add('canvas', `position:fixed;bottom:0;right:0;width:1px;height:1px;
    ${ TOP };opacity:0`);
  ff.width = 1; ff.height = 1;
  const fctx = ff.getContext('2d');
  let n = 0;
  const tick = () => {
    fctx.fillStyle = (n++ & 1) ? '#000' : '#fff';
    fctx.fillRect(0, 0, 1, 1);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // ── The annotation API the driver calls ─────────────────────────────────────────────────
  const layer = add('div', `position:fixed;inset:0;${ TOP }`);

  window.__rec = {
    // The ONLY mark we still draw over the app, because it is the one that has to be there: a
    // pulsing ring around the element being acted on. It is a 2px outline offset outside the
    // element's box, so it points without hiding — the *name* of the action goes in the band.
    ring(rect) {
      if (!rect) return;
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;left:${ rect.x - 4 }px;top:${ rect.y - 4 }px;
        width:${ rect.width + 8 }px;height:${ rect.height + 8 }px;border-radius:5px;
        border:2px solid rgba(220,60,100,0.95);animation:__rec_pulse 1s ease-out 2`;
      layer.appendChild(el);
      setTimeout(() => el.remove(), 2000);
    },

    // A full-screen title / section / end card.
    card(big, small) {
      document.getElementById('__rec_card')?.remove();
      const el = add('div', `position:fixed;inset:0;${ TOP };background:rgba(12,12,16,0.94);
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
        color:#fff;text-align:center;padding:40px`);
      el.id = '__rec_card';
      el.innerHTML = `<div style="font:700 34px/1.25 system-ui,-apple-system,Segoe UI,sans-serif">${ big }</div>` +
        (small ? `<div style="font:400 17px/1.5 system-ui;opacity:.8;max-width:760px">${ small }</div>` : '');
    },
    clearCard() { document.getElementById('__rec_card')?.remove(); },
  };
};

// ── Driving the browser ─────────────────────────────────────────────────────────────────────

/**
 * Attach to a Chromium if one is offered, otherwise launch our own.
 *
 * The upstream version only ever did connectOverCDP, because in their cluster a browser sidecar
 * is always up. We have no sidecar — the agent container just has chromium — so launching is the
 * normal path here and RECORD_CDP is the exception.
 */
async function connect() {
  if (CDP) {
    const browser = await chromium.connectOverCDP(CDP);
    const ctx = browser.contexts()[0] || await browser.newContext();

    return { browser, ctx, page: await ctx.newPage(), owned: false };
  }

  const browser = await chromium.launch({ args: ['--force-device-scale-factor=1'] });
  // 1280x720: a device-pixel-ratio viewport screencasts at 3000+px wide and the file is
  // unshareable. Pinned here so a script cannot forget.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

  return { browser, ctx, page: await ctx.newPage(), owned: true };
}

/** The helpers a recording script is handed. Everything paced so the overlay can keep up. */
function helpers(page, band) {
  // The cursor dot has a 150ms CSS transition. Every visible interaction has to move the pointer
  // first and let it land, or the viewer sees a click with no pointer anywhere near it — the
  // single most common reason a recording looks broken.
  const MOVE = 180;
  const rec = (fn, ...args) => page.evaluate(([f, a]) => window.__rec?.[f]?.(...a), [fn, args]).catch(() => {});

  const describe = async (loc, fallback) => {
    if (fallback) return fallback;
    const name = await loc.getAttribute('aria-label').catch(() => null)
      || (await loc.textContent().catch(() => ''))?.trim()
      || await loc.getAttribute('placeholder').catch(() => null)
      || '';

    return name.replace(/\s+/g, ' ').slice(0, 60);
  };

  /** hover → let the pointer land → ring the target, name the action in the band → act. */
  async function act(loc, { label, verb = 'Click' } = {}) {
    const target = typeof loc === 'string' ? page.locator(loc) : loc;
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.hover();
    const box = await target.boundingBox().catch(() => null);
    band.note('action', `${ verb } ${ await describe(target, label) }`.trim());
    await rec('ring', box);
    await page.waitForTimeout(MOVE);

    return target;
  }

  return {
    MOVE,
    caption: (t) => band.note('caption', t),
    card:    async (big, small, hold = 2200) => { await rec('card', big, small); await page.waitForTimeout(hold); },
    clearCard: () => rec('clearCard'),
    /** A chapter is just a card that clears itself — the marker `video-chapter` used to give us. */
    chapter: async (t, hold = 1800) => { await rec('card', t, ''); await page.waitForTimeout(hold); await rec('clearCard'); },

    async click(loc, opts = {}) { await (await act(loc, opts)).click(); await page.waitForTimeout(120); },

    /**
     * Type key by key. `fill()` sets the value in one go, which is invisible in a recording and
     * emits no keystroke badges.
     */
    async type(loc, text, opts = {}) {
      const target = await act(loc, { verb: 'Type into', ...opts });
      await target.click();
      await page.keyboard.type(text, { delay: opts.delay ?? 60 });
    },

    /** Log in to a Rancher dashboard. Password never appears in a callout or on the page. */
    async login(base, { user = 'admin', password = process.env.RANCHER_PASSWORD } = {}) {
      if (!password) throw new Error('login() needs RANCHER_PASSWORD in the environment.');
      await page.goto(`${ base.replace(/\/+$/, '') }/auth/login`, { waitUntil: 'domcontentloaded' });
      // The password field's data-testid is on a WRAPPER div — target the inner input.
      await page.locator('input[type="password"], [data-testid="local-login-password"] input').first()
        .waitFor({ timeout: 30_000 });
      await page.locator('input[name="username"], #username').first().fill(user);
      await page.locator('input[type="password"], [data-testid="local-login-password"] input').first().fill(password);
      await page.locator('button[type="submit"], [data-testid="login-submit"]').first().click();
      await page.waitForURL(/\/dashboard|\/home/, { timeout: 60_000 }).catch(() => {});
    },
  };
}

// ── The bands ───────────────────────────────────────────────────────────────────────────────
//
// Every piece of TEXT the driver puts on a clip lives out here instead of in the page: a
// narration strip above the viewport and a URL strip below it, composited at encode time. So the
// recorded pixels of the app are exactly what a person would have seen — nothing we say can sit
// on top of the thing we are pointing at. That is the whole reason the in-page caption bar and
// the callout boxes are gone; the ring stays, because it has to be on the element.
//
// Time is tracked in SECONDS SINCE startRecording(), for the bands and for the frames alike.
// It cannot be tracked in captured frames, because the capture rate is not constant: CDP emits a
// screencast frame only when the compositor paints, so a busy second yields ~45 frames and an
// idle one yields none. Stamping each frame with its arrival time and letting the encode
// resample to a constant rate is what makes a clip play at wall-clock speed — without it a 10s
// wait for a spinner collapses into a blip and a burst of animation runs in slow motion.

const TOP_BAND = 64;
const URL_BAND = 28;
const FLASH_MS = 1200;   // how long the URL strip stays pink after a route change

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Width/height of a baseline JPEG, read off its SOF marker — the true size of a captured frame. */
function jpegSize(buf) {
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }

  return null;
}

/** The log the driver writes to, and the running state each entry is a snapshot of. */
function bandRecorder() {
  const band = {
    at:      () => 0,   // replaced by runRecording with "seconds since startRecording()"
    top:     [],
    bottom:  [],
    caption: '',
    action:  '',
    note(kind, value) {
      if (kind === 'url') {
        band.bottom.push({ t: band.at(), url: value });

        return;
      }
      // A new caption opens a new section, so the action left over from the last one is stale.
      if (kind === 'caption') { band.caption = value || ''; band.action = ''; } else { band.action = value || ''; }
      band.top.push({ t: band.at(), caption: band.caption, action: band.action });
    },
  };

  return band;
}

/** Collapse the log into [{ state, seconds }] — one entry per visible change. */
function narrationSegments(events, total) {
  const segs = [];
  let cur = { caption: '', action: '' };
  let start = 0;

  for (const e of events) {
    const t = Math.min(Math.max(e.t, 0), total);
    if (e.caption === cur.caption && e.action === cur.action) continue;
    if (t > start) segs.push({ state: cur, seconds: t - start });
    cur = { caption: e.caption, action: e.action };
    start = t;
  }
  segs.push({ state: cur, seconds: Math.max(1 / FPS, total - start) });

  return segs.filter((s) => s.seconds > 0);
}

/** Same for the URL strip, except each change opens with a pink flash that then settles. */
function urlSegments(events, total) {
  const changes = [];
  for (const e of events) {
    const t = Math.max(e.t, 0);
    if (t >= total) break;
    const last = changes[changes.length - 1];
    if (last && last.url === e.url) continue;
    if (last && last.t === t) changes.pop();   // same instant: only the last one is ever seen
    changes.push({ t, url: e.url });
  }
  if (!changes.length) return [{ state: { url: '', flash: false }, seconds: total }];

  const segs = [];
  const flash = FLASH_MS / 1000;
  if (changes[0].t > 0) segs.push({ state: { url: '', flash: false }, seconds: changes[0].t });

  for (let i = 0; i < changes.length; i++) {
    const span = (i + 1 < changes.length ? changes[i + 1].t : total) - changes[i].t;
    if (span <= 0) continue;
    const lit = Math.min(flash, span);
    if (lit > 0) segs.push({ state: { url: changes[i].url, flash: true }, seconds: lit });
    if (span - lit > 0) segs.push({ state: { url: changes[i].url, flash: false }, seconds: span - lit });
  }

  return segs;
}

const narrationHtml = (w, h) => ({ caption, action }) => `<!doctype html><meta charset="utf-8"><style>
  html, body { margin:0; padding:0 }
  body { box-sizing:border-box; width:${ w }px; height:${ h }px; background:#121216; color:#fff;
    display:flex; align-items:center; gap:14px; padding:0 18px;
    font:600 15px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;
    border-bottom:1px solid rgba(255,255,255,0.10) }
  .cap { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
  .act { flex:none; max-width:46%; background:rgba(220,60,100,0.95); border-radius:999px;
    padding:6px 13px; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
</style><div class="cap">${ esc(caption) }</div>${ action ? `<div class="act">${ esc(action) }</div>` : '' }`;

const urlHtml = (w, h) => ({ url, flash }) => `<!doctype html><meta charset="utf-8"><style>
  html, body { margin:0; padding:0 }
  body { box-sizing:border-box; width:${ w }px; height:${ h }px; color:#eaeaea;
    background:${ flash ? 'rgba(200,50,90,0.9)' : '#121216' };
    display:flex; align-items:center; gap:8px; padding:0 12px;
    font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
    border-top:1px solid rgba(255,255,255,0.10) }
  .k { opacity:.55; font-size:11px }
  .u { min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
</style><span class="k">URL</span><span class="u">${ esc(url) }</span>`;

/**
 * Render each segment to a PNG — deduped, so a caption that comes back reuses its file — and
 * write the ffmpeg concat list that replays them for the right number of frames.
 *
 * Chromium draws these, so the bands keep the fonts, ellipsis and layout the in-page overlay had.
 * This is a move, not a downgrade.
 */
async function buildBand(ctx, dir, tag, segs, html, width, height) {
  if (!segs.length) return null;

  const page = await ctx.newPage();
  await page.setViewportSize({ width, height });

  const cache = new Map();
  const shots = [];

  for (const seg of segs) {
    const markup = html(seg.state);
    let file = cache.get(markup);
    if (!file) {
      file = `${ dir }/${ tag }-${ cache.size }.png`;
      await page.setContent(markup, { waitUntil: 'load' });
      await page.screenshot({ path: file });
      cache.set(markup, file);
    }
    shots.push({ file, seconds: seg.seconds });
  }
  await page.close();

  return concatList(`${ dir }/${ tag }.txt`, shots);
}

/**
 * An ffmpeg concat list: each image held for a real number of seconds. This is the one timebase
 * in here — the bands and the captured frames are both replayed through it, so they cannot drift
 * apart, and `fps=` at encode time turns the variable rate into a constant one.
 */
async function concatList(path, entries) {
  if (!entries.length) return null;

  const lines = [];
  for (const { file, seconds } of entries) {
    lines.push(`file '${ file }'`, `duration ${ Math.max(seconds, 0.001).toFixed(4) }`);
  }
  // The concat demuxer ignores the final duration unless the file is repeated after it.
  lines.push(`file '${ entries[entries.length - 1].file }'`);
  await fs.writeFile(path, `${ lines.join('\n') }\n`);

  return path;
}

// ── Capture ─────────────────────────────────────────────────────────────────────────────────

async function encode(out, bands) {
  const webm = out.endsWith('.webm');
  const codec = webm
    ? ['-c:v', 'libvpx-vp9', '-b:v', '1M']
    // yuv420p is what every player wants; faststart puts the index at the front so the clip
    // plays before it has finished downloading.
    : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

  // One input per strip plus the frame sequence, stacked vertically. The app keeps its own
  // 1280x720 untouched — the bands are added around it, nothing is scaled or cropped.
  const inputs = [];
  const filters = [];
  const stack = [];
  let idx = 0;

  const addLayer = (list, label) => {
    if (!list) return;
    inputs.push('-f', 'concat', '-safe', '0', '-i', list);
    // fps= is what turns each layer's real-time concat list into the constant rate vstack needs.
    filters.push(`[${ idx++ }:v]fps=${ FPS },format=rgba[${ label }]`);
    stack.push(`[${ label }]`);
  };

  addLayer(bands.top, 'top');
  addLayer(bands.app, 'app');
  addLayer(bands.url, 'url');

  const chain = `${ filters.join(';') };${ stack.join('') }vstack=inputs=${ stack.length },format=yuv420p[v]`;

  await fs.mkdir(nodePath.dirname(nodePath.resolve(out)), { recursive: true });
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', ...inputs, '-filter_complex', chain, '-map', '[v]', ...codec, '-an', out],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${ code }: ${ err.slice(-600) }`))));
  });
}

async function runRecording(out, body, { deferred = true } = {}) {
  const conn = await connect();
  const band = bandRecorder();

  // The page reports route changes out through this binding. Everything else that goes in a band
  // the driver already knows — it is the one issuing the actions.
  await conn.ctx.exposeFunction('__recNote', (kind, value) => band.note(kind, value));
  await conn.ctx.addInitScript(OVERLAY);
  await conn.page.evaluate(OVERLAY).catch(() => {});
  conn.page.on('load', () => conn.page.evaluate(OVERLAY).catch(() => {}));

  const client = await conn.page.context().newCDPSession(conn.page);
  const tmpDir = await fs.mkdtemp('/tmp/rec-');
  const frames = [];
  let size = null;    // the real frame size, off the first JPEG — DPR and page zoom included
  let t0 = null;      // set by startRecording(); everything is measured from here
  let capturing = !deferred;

  const at = () => (t0 === null ? 0 : (Date.now() - t0) / 1000);
  band.at = at;

  client.on('Page.screencastFrame', async ({ data, sessionId }) => {
    if (capturing) {
      const t = at();
      const buf = Buffer.from(data, 'base64');
      const file = `${ tmpDir }/f${ String(frames.length).padStart(6, '0') }.jpg`;
      size ||= jpegSize(buf);
      frames.push({ file, seconds: 0, t });
      await fs.writeFile(file, buf);
    }
    await client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  if (!deferred) t0 = Date.now();
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });

  let bands = { top: null, app: null, url: null };
  let total = 0;

  try {
    await body(conn.page, helpers(conn.page, band), () => { t0 ??= Date.now(); capturing = true; });
    await client.send('Page.stopScreencast').catch(() => {});
    total = at();

    if (frames.length && size) {
      // Each frame is held until the next one arrived, so an idle stretch holds its last frame
      // instead of vanishing, and a burst of 45fps is thinned back to FPS by the encode.
      frames.forEach((f, i) => { f.seconds = (i + 1 < frames.length ? frames[i + 1].t : total) - f.t; });
      // Nothing painted before the first frame, so it is also what the screen looked like from
      // t=0. Extending it backwards keeps the app layer exactly as long as the bands.
      frames[0].seconds += frames[0].t;

      // h264 needs even dimensions, and the app's own height is whatever the viewport was.
      const urlBand = URL_BAND + ((size.h + TOP_BAND + URL_BAND) % 2);

      bands = {
        top: band.top.length
          ? await buildBand(conn.ctx, tmpDir, 'top', narrationSegments(band.top, total),
            narrationHtml(size.w, TOP_BAND), size.w, TOP_BAND)
          : null,
        app: await concatList(`${ tmpDir }/app.txt`, frames),
        url: await buildBand(conn.ctx, tmpDir, 'url', urlSegments(band.bottom, total),
          urlHtml(size.w, urlBand), size.w, urlBand),
      };
    }
  } finally {
    await client.send('Page.stopScreencast').catch(() => {});
    if (conn.owned) await conn.browser.close().catch(() => {});
    else await conn.page.close().catch(() => {});
  }

  if (!frames.length) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    throw new Error('no frames captured — did the script never call startRecording()?');
  }

  await encode(out, bands);
  await fs.rm(tmpDir, { recursive: true, force: true });

  // Cheap guard against shipping a hollow clip: a real recording is never a few hundred bytes.
  const bytes = (await fs.stat(out)).size;
  if (bytes < 10_000) throw new Error(`${ out } is only ${ bytes } bytes — the capture is broken.`);
  console.log(`saved ${ out } (${ total.toFixed(1) }s, ${ frames.length } captured frames, `
    + `${ size.w }x${ size.h } + bands, ${ (bytes / 1e6).toFixed(1) } MB)`);
}

// ── Entry points ────────────────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === 'script') {
    const [scriptPath, out = 'recording.mp4'] = rest;
    const mod = await import(pathToFileURL(nodePath.resolve(scriptPath)).href);
    const action = mod.default || mod.run;

    if (typeof action !== 'function') {
      throw new Error(`${ scriptPath } must default-export async ({ page, ui, startRecording }) => ...`);
    }
    await runRecording(out, (page, ui, startRecording) => action({ page, ui, startRecording }));
  } else if (cmd === 'url') {
    const [url, out = 'recording.mp4', durationMs] = rest;

    await runRecording(out, async (page, ui, startRecording) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      startRecording();
      await page.waitForTimeout(Number(durationMs) || 10_000);
    }, { deferred: true });
  } else {
    console.error('Usage:\n  record.mjs script <script.mjs> <out.mp4>\n  record.mjs url <url> <out.mp4> [durationMs]');
    process.exit(1);
  }
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}

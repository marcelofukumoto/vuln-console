# Verifying a fix in the browser

The one place this is written down. Both the fix and the record actions point here rather than
each carrying their own copy, so there is one thing to correct when it turns out to be wrong.

## What is already here

Nothing needs installing. A Chromium sidecar runs in this pod and everything below is in
`$WSD/bin`:

| | |
|---|---|
| `wait-for-sidecars` | blocks until the browser and Rancher answer. Chromium takes a few seconds after the pod starts, and a check that runs before it is up fails for no reason |
| `rancher-login.mjs` | sets the Rancher session cookie from the token minted for you |
| `browser.mjs` | drives the sidecar over CDP: `screenshot`, `record`, `record-script`, `goto`, `eval` |

Do not install a browser, do not `npm i playwright`, and do not hand-roll a `recordVideo`
script. `playwright-core` is already at `$WSD/node_modules`.

## The order

```
wait-for-sidecars
node $WSD/bin/rancher-login.mjs
node $WSD/bin/browser.mjs record-script <script.mjs> $WSD/artifacts/<slug>.webm
ffmpeg -y -i <slug>.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an <slug>.mp4
```

Deliver **mp4**: Safari cannot play webm, and mp4 is smaller.

## Make it watchable

Record into `$WSD/artifacts/`, then copy the finished mp4 and the notes into
`$WSD/src/public/vc-artifacts/`. The dev server serves `public/` at its root and the dev server
is already reachable through the Rancher proxy with the viewer's own session — so that copy is a
link anybody can open, with no second server and no credential. It is excluded from git, so it
cannot reach a diff.

Record the URL, not the path. `$VULN_PREVIEW_URL` is this workspace's own address:

```
cp $WSD/artifacts/<slug>.mp4 $WSD/artifacts/<slug>.md $WSD/src/public/vc-artifacts/
$ROOT/job.sh <board> "<library>" \
  videoUrl=$VULN_PREVIEW_URL/vc-artifacts/<slug>.mp4 \
  infoUrl=$VULN_PREVIEW_URL/vc-artifacts/<slug>.md
```

A path like `/workspaces/…` is no use to anybody reading the board — it is not a link, and
nobody can open it. A URL is.

`record` and `record-script` draw the URL bar, the cursor, click ripples and keystroke badges
into the video, so the clip SHOWS what was done. `record-script` takes a module whose default
export is `async ({ page, click, type, waitFor, settle, say }) => { … }` — use it for anything
with steps, so the actions are scripted and annotated rather than narrated afterwards.

## Three things that decide a page from a spinner

Not preferences. Each is the difference between a screenshot of the dashboard and one of a
loading circle.

1. **Open the RANCHER PROXY URL, not `localhost:8005`.** A session is a cookie and a cookie
   belongs to an origin. On Rancher's own origin the session applies; on localhost it does not,
   and the dashboard boots into a spinner it never leaves.

   ```
   $RANCHER_URL/k8s/clusters/local/api/v1/namespaces/<workspace>/services/<scheme>:<workspace>:8005/proxy/
   ```

   `<workspace>` is the namespace your commands run in. `<scheme>` is `http` or `https`
   depending on the repository — check which one answers before assuming.

2. **Wait for real content, never a timer and never `networkidle`.** The dashboard holds sockets
   open so idle never comes, and a fixed wait fires while it is still booting:

   ```js
   await page.waitForSelector('header, .dashboard-root, nav', { timeout: 90000 });
   ```

3. **Write helper scripts under `$WSD`.** An ESM `import` ignores `NODE_PATH` and resolves from
   the SCRIPT's own directory upward. A script in `/tmp` dies with `ERR_MODULE_NOT_FOUND`; one in
   `$WSD/artifacts/` finds `$WSD/node_modules`. That is also why `browser.mjs` works from
   `$WSD/bin`.

## What to verify

Grep the checkout for where the bumped library is actually used and pick two to four real
interactions that exercise it. A `js-yaml` bump is shown by a page that renders YAML; a
`dompurify` bump by one that renders user content. "The app still loads" is not a verification.

Write it up as numbered checks, each ending ✅ or ❌, then a one-line verdict.

## When you cannot

If the dev server does not serve for this repository, say so and record what you can instead —
the build output, the lockfile diff, the test run. An honest "could not verify in a browser
because the dev server does not start here" is worth more than a video of nothing. If a page
comes back as the login screen, the session did not take: say that rather than screenshotting it.

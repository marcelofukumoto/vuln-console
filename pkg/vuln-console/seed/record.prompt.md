# Capture the verification recording again

The fix exists but its recording does not, or needs redoing. Produce it, and change nothing else.

1. Check out the fix branch and let the supervised dev server compile it. Do not start a second
   server — the pod's memory fits one.
2. Grep the checkout for where the library is used and pick two to four real interactions that
   exercise it.
3. Sign the browser in — the dev server proxies Rancher's API, so without a session every page
   is the login screen:

```
node $WSD/bin/rancher-login.mjs
```

4. Drive them with the browser that is already in this pod. Do not install one, and do not
   hand-roll a `recordVideo` script:

```
node $WSD/bin/browser.mjs record-script <script.mjs> $WSD/artifacts/<slug>.webm
```

   `record-script` takes a module whose default export is
   `async ({ page, click, type, waitFor, settle, say }) => { … }` and draws the URL bar, the
   cursor, click ripples and keystroke badges into the clip — so it shows what was done.

### Three things that decide whether you get a page or a spinner

These are not preferences. Each one is the difference between a screenshot of the dashboard and
a screenshot of a loading circle.

1. **Open it through the Rancher proxy, not `localhost:8005`.** Rancher's session is a cookie,
   and a cookie belongs to an origin. On Rancher's own origin the session applies; on localhost
   it does not, and the dashboard boots into a spinner it never leaves. The URL is:

   ```
   $RANCHER_URL/k8s/clusters/local/api/v1/namespaces/<workspace>/services/http:<workspace>:8005/proxy/
   ```

   (`<workspace>` is the namespace your commands run in; `http` is this repository's dev-server
   scheme — some serve TLS and take `https` there instead.)

2. **Wait for real content, never for a timer or for network idle.** The dashboard holds sockets
   open, so `networkidle` never settles, and a fixed wait fires while it is still booting:

   ```js
   await page.waitForSelector('header, .dashboard-root, nav', { timeout: 90000 });
   ```

3. **Put any script you write under `$WSD`.** `playwright-core` is installed at
   `$WSD/node_modules`, and an ESM `import` ignores NODE_PATH — it resolves by walking up from
   the SCRIPT's own directory. A script in `/tmp` cannot find it and dies with
   ERR_MODULE_NOT_FOUND; one in `$WSD/artifacts/` resolves. That is also why `browser.mjs` works
   from `$WSD/bin`.


5. Convert it, because Safari cannot play webm:

```
ffmpeg -y -i <slug>.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an <slug>.mp4 \
  && rm -f <slug>.webm
```

6. Write the checks up as a numbered list, each ending ✅ or ❌, then a one-line verdict, and
   record both:

```
$ROOT/job.sh <board> "<library>" videoUrl=<path> infoUrl=<path> message="<one line verdict>"
```

If the dev server does not serve for this repository, say so plainly and record what you could
check instead. An honest "not verifiable in a browser here" beats a video of nothing.

Do not change the branch, do not open or edit a pull request.

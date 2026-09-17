# Capture the verification recording again

The fix exists but its recording does not, or needs redoing. Produce it, and change nothing else.

**Read `$ROOT/verifying.md` before touching the browser.** It is the single copy of how to
verify in this workspace: what is already installed, the order to run it in, and the three
conditions that decide whether you get the dashboard or a loading spinner. Do not work them out
again.


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

## Recording what happened

`phase` is one of exactly five words: **Running, Fixed, Done, Failed, Cancelled**. job.sh refuses
anything else, because the board reads `phase` to decide whether a run is still going — an
invented value makes a live run look finished and the row offers its buttons again.

For progress, use `stage=<what you are doing>`, which is free-form and is what the board shows
while it waits.

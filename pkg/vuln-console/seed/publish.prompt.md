# Attach a staged recording to its pull request

The recording exists and the pull request exists; put one in the other, so a reviewer can press
play without leaving the diff.

## There is no API for this

`user-attachments` is a browser flow — a CSRF token that only the classic comment box renders, a
policy call, a POST to the bucket it names, then a confirm. A token cannot do it and neither can
`gh`. A release asset is not a substitute: it renders as a link, not a player.

So there is a tool, and it drives **the browser this person set up for themselves** from the
console's Credentials dialog — a Chromium of their own that they signed in to GitHub once. Not
this workspace's sidecar, which is signed in to Rancher rather than GitHub, and not a shared one:
an upload should be done by whoever asked for it.

```
node $WSD/bin/gh-attach.mjs --check                       # is that browser signed in?
node $WSD/bin/gh-attach.mjs <file> <pull-request-url>     # prints the attachment URL
```

**Check first.** If `$GITHUB_BROWSER_CDP` is empty they have not set one up; if `--check` says
`not signed in` they have but have not signed in yet. Either way, stop and record it — the fix
is a human opening the Credentials dialog, and no amount of retrying here substitutes. The
recording is already watchable at its `videoUrl`, so nothing is lost by saying so:

```
$ROOT/job.sh <board> "<library>" message="recording is at its videoUrl but could not be attached: set up a GitHub browser in the console's Credentials dialog and sign it in"
```

## When it is signed in

1. Convert to mp4 first if it is still webm — Safari cannot play webm, and mp4 is smaller.
2. Upload it, and keep the URL it prints.
3. Put that URL **on its own line** in the pull request body's `### Screenshot/Video` section.
   On its own line is what makes GitHub render a player instead of a link.
4. Record the published URL, which is what turns the board's pill into a link:

```
$ROOT/job.sh <board> "<library>" videoUrl=<the https://github.com/user-attachments/... URL>
```

Leave the staged copy alone until the upload is confirmed.

Do not comment on the pull request. Do not mark it ready for review.

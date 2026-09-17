# Address the review comments on a pull request

Re-read the pull request's review comments, make any changes that are actually requested,
re-verify, and **stage a reply for the human to send**.

## The rule that matters most

**Do not post a comment on the pull request.** Not a reply, not a summary, not an
acknowledgement. Marcelo answers reviewers himself, in his own words — an auto-posted reply reads
as his and is not.

What you do instead: write the per-point reply as a draft and record where it is, so the board
shows a **reply draft** pill he can read and then post himself.

Editing the pull request **body** is still wanted — the description should stay true as the
branch changes, and the video belongs there.

## What to do

1. Read every review comment and every review state on the pull request.
2. For each point: decide whether it asks for a change. If it does, make it in the checkout.
3. If you changed anything: re-run the verification against the dev server, capture a fresh
   video, and update the `### Screenshot/Video` section of the body.
4. Write the reply draft — one short paragraph per point, saying what you did or why nothing
   changed. Never a bare `#<number>` in it.
5. Record:

```
$ROOT/job.sh "<library>" phase=Done replyUrl=<path> message="<one line: what changed>"
```

If nothing needed changing, say so in the draft and record it the same way.

## Recording what happened

`phase` is one of exactly five words: **Running, Fixed, Done, Failed, Cancelled**. job.sh refuses
anything else, because the board reads `phase` to decide whether a run is still going — an
invented value makes a live run look finished and the row offers its buttons again.

For progress, use `stage=<what you are doing>`, which is free-form and is what the board shows
while it waits.

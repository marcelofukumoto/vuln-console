# Attach a staged recording to its pull request

The recording exists and the pull request exists; put one in the other.

1. Upload the video as a GitHub user-attachment so it renders as an inline player. A release
   asset link renders as a link, not a player, which is not what this is for.
2. Splice it into the pull request body's `### Screenshot/Video` section, **on its own line**.
3. Leave the staged copy alone until the upload is confirmed, then record the published URL:

```
$ROOT/job.sh "<library>" videoUrl=<github-url>
```

Do not comment on the pull request. Do not mark it ready for review.

## Recording what happened

`phase` is one of exactly five words: **Running, Fixed, Done, Failed, Cancelled**. job.sh refuses
anything else, because the board reads `phase` to decide whether a run is still going — an
invented value makes a live run look finished and the row offers its buttons again.

For progress, use `stage=<what you are doing>`, which is free-form and is what the board shows
while it waits.

# Rebase a fix branch onto the latest default branch

The pull request has drifted from its base, or conflicts with it. Bring it up to date.

## What to do

1. Fetch upstream and check whether the branch actually conflicts. GitHub computes mergeability
   asynchronously, so a "conflict" flag can be one poll stale — look for yourself.
2. If it is clean and merely behind, rebase it onto the latest default branch.
3. If it conflicts, rebase and **re-apply the fix** rather than resolving by hand where the
   resolution is a lockfile: regenerate the lockfiles from the rebased tree using the recipe in
   the fix prompt, so what lands is a real resolution and not a merge artefact.
4. Re-check that no vulnerable version remains and that the diff adds no new vulnerable package.
5. Force-push **only this branch**, and only when it is the branch this job owns.
6. Record:

```
$ROOT/job.sh "<library>" phase=Done message="<one line: rebased onto <sha>, lockfiles regenerated>"
```

## What you must not do

- do not force-push any branch other than this one
- do not comment on the pull request
- do not mark it ready for review

## Recording what happened

`phase` is one of exactly five words: **Running, Fixed, Done, Failed, Cancelled**. job.sh refuses
anything else, because the board reads `phase` to decide whether a run is still going — an
invented value makes a live run look finished and the row offers its buttons again.

For progress, use `stage=<what you are doing>`, which is free-form and is what the board shows
while it waits.

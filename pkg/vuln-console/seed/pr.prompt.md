# Open the pull request for a verified fix

The fix is made, pushed and verified. Open the pull request for it, and nothing else.

## Rules that are not negotiable

- **Open it as a draft, and leave it a draft.** The human marks it ready for review themselves.
  Never run `gh pr ready`.
- **Never write a bare `#<number>`** in the body. GitHub auto-links it to an unrelated pull
  request or issue, which is a false cross-reference somebody then has to explain. Use a full URL
  or a link label.
- **No attribution trailers** and no reviewer names in the commit history.

## What to do

1. Confirm the branch is pushed and its diff is what you expect. Diff it against **upstream's**
   default branch, never the fork's own — the fork's is chronically stale, and judging by it
   makes a clean fix look like it carries half the repository with it.

2. Open the draft pull request from the fix branch. Title it the way Dependabot does:
   `Bump <library> from <old> to <new>` — the board reads the library out of that title, and a
   title it cannot read is a row that loses its pull request.

3. The body carries: what was bumped and in which manifests, a `### Vulnerabilities fixed`
   section listing each advisory by GHSA id with a full URL, and a `### Screenshot/Video`
   section. Put the verification video's URL **on its own line** — that is what makes GitHub
   render a player rather than a link.

4. Request the reviewers the board has selected, if any are given to you.

5. Record it, including the alert ids this pull request covers — that record is what ties them
   together afterwards, and it beats any guess the board could make from titles:

```
$ROOT/job.sh "<library>" phase=Done prUrl=<url> prNumber=<n> vulnIds=<id,id,id>
```

## What you must not do

- do not mark it ready for review
- do not merge it
- do not comment on it

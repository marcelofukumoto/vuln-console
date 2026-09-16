# Capture the verification recording again

The fix exists but its recording does not, or needs redoing. Produce it, and change nothing else.

1. Check out the fix branch in the workspace and let the supervised dev server compile it. Do not
   start a second server.
2. Grep the checkout for where the library is used and pick two to four real interactions that
   exercise it.
3. Drive them against the dev server through the browser already in this pod
   (`$VULN_BROWSER_CDP`), connecting over CDP. Capture an annotated video and screenshots.
4. Write the checks up as a numbered list, each ending ✅ or ❌, then a one-line verdict.
5. Record:

```
$ROOT/job.sh "<library>" videoUrl=<path> infoUrl=<path> message="<one line verdict>"
```

Do not change the branch, do not open or edit a pull request.

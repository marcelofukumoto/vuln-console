# Vulnerability Console

The Dependabot board for `rancher/dashboard`, as a Rancher UI extension: see what is actionable,
and fix it with an agent running inside the cluster.

It replaces a static console — an HTML page, a Python server and a 710-line shell watcher running
on somebody's laptop — with an extension that has no watcher at all. The work happens in a
workspace the extension provisions through Apps Plus, and the agent is the one the
[Agents extension](https://github.com/codyrancher/agents) already provides.

## What it needs

| | |
|---|---|
| **Agents** | required — this extension has no model, no key and no agent of its own |
| **Apps Plus** | required — a fix workspace is an App installation |
| **A GitHub token** | `gh_token`, in this extension's Secret or Extension Studio's |

## Layout

```
pkg/vuln-console/
  config/      every cluster name this extension uses, in one place
  lib/         the board's logic: the gather's ledger, the store, the run
  seed/        what runs inside a pod — the gather, the workspace scripts, the prompts
  yaml/        what a fix workspace is made of, as Apps Plus App templates
  components/  the board
```

`seed/` and `yaml/` are packed into the bundle by `yarn gen-seed`, because a built extension
cannot fetch a file next to itself. A YAML template may inline a script with
`@@include:<path>@@`, so the shell stays shell and the YAML stays YAML.

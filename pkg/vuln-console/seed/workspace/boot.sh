#!/bin/sh
# Bring one fix workspace up: a rancher/dashboard checkout with its dependencies installed and
# the dev server supervised on top of it.
#
# The container's main process ends up being the supervisor, not the server, because a fix run
# does things that kill a dev server - switches branch, regenerates a lockfile, runs a build -
# and a pod whose main process was the server would restart on each of those and take the run's
# terminal with it.
#
# `${install}`, `${repo}` and `${port}` are apps-plus substitutions, filled in when the App is
# rendered. Everything written `$LIKE_THIS` is ordinary shell and is left alone: apps-plus only
# substitutes the braced form, and only for names its App declares.
set -e

# Force apt onto IPv4 before anything runs one. The node has no working IPv6 route to the Debian
# mirror, so an `apt-get update` left alone resolves an IPv6 address and hangs on it for minutes
# while holding the apt lock - which is how a workspace comes up with no tmux and no terminal.
mkdir -p /etc/apt/apt.conf.d
printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "3";\n' > /etc/apt/apt.conf.d/99vuln-ipv4

WS=/workspaces/${install}
mkdir -p "$WS/.home"
chown node:node "$WS" "$WS/.home" 2>/dev/null || true
[ -f "$WS/.owned" ] || { chown -R node:node "$WS" 2>/dev/null; touch "$WS/.owned"; }

# The browser sidecar mounts these as subPaths, and the kubelet creates a missing subPath as
# root - leaving the seed unable to write into it.
mkdir -p "$WS/.a11y/opt" "$WS/.a11y/init"
chown -R node:node "$WS/.a11y" 2>/dev/null || true

# What every workspace on this node shares rather than keeping its own copy. Measured before
# this existed: Cypress 813 MB, yarn 749 MB, and a gigabyte of node_modules - most of a
# workspace's 3 GB, per workspace.
SHARED=/workspaces/.shared
mkdir -p "$SHARED/yarn" "$SHARED/cypress" "$SHARED/npm" "$SHARED/template"
chown node:node "$SHARED" "$SHARED/yarn" "$SHARED/cypress" "$SHARED/npm" "$SHARED/template" 2>/dev/null || true

# tmux and kubectl, which the terminal needs. No claude: the conversation runs in the agents pod
# and reaches this one through a tunnel, so a claude here is hundreds of megabytes of hostPath
# that nothing executes.
[ -f /seed/terminal-tools.sh ] \
  && (TOOLS_NO_CLAUDE=1 HOME_DIR="$WS/.home" /bin/sh /seed/terminal-tools.sh >"$WS/.terminal-tools.log" 2>&1 &) \
  || true

# What a recording and a lockfile bump need and the image lacks. Backgrounded so the dev server
# is not a minute later for it; the lock timeout lets it wait for the tmux install above rather
# than colliding with it.
(command -v ffmpeg >/dev/null 2>&1 && command -v lsof >/dev/null 2>&1) || (
  apt-get -o DPkg::Lock::Timeout=300 update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq \
      ffmpeg jq lsof iproute2 >"$WS/.apt.log" 2>&1 &
) || true

# /workspace-config, not /seed. This extension's scripts are mounted from its own ConfigMap;
# /seed is the agents extension's, which is optional here and usually absent - so pointing at it
# crash-looped the pod with "cannot open /seed/checkout.sh".
exec setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh /workspace-config/checkout.sh

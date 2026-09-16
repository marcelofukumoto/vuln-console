#!/bin/sh
# The workspace's checkout and install, as the node user. Split from boot.sh so the privileged
# half is short enough to read and this half can be run again by hand.
set -e

WS=/workspaces/${install}
SHARED=/workspaces/.shared

export HOME="$WS/.home"
export YARN_CACHE_FOLDER="$SHARED/yarn"
export CYPRESS_CACHE_FOLDER="$SHARED/cypress"
export npm_config_cache="$SHARED/npm"

# init + fetch rather than `git clone`, because clone refuses a non-empty directory and this one
# is not reliably empty: the agent seed writes `.claude` into the checkout, and if that lands
# first - a separate trigger racing this boot - a clone would fail and leave the pod serving
# nothing.
if [ ! -d "$WS/dashboard/.git" ]; then
  mkdir -p "$WS/dashboard"
  cd "$WS/dashboard"
  git init -q
  git remote add origin https://github.com/${repo} 2>/dev/null || true
  DEFAULT=$(git ls-remote --symref origin HEAD | sed -n 's@^ref: refs/heads/\(.*\)[[:space:]]HEAD@\1@p')
  git fetch --depth 1 origin "$DEFAULT"
  git checkout -f -B "$DEFAULT" FETCH_HEAD
fi

cd "$WS/dashboard"

# The fork is where fixes are pushed, so it is a remote from the start rather than something the
# agent has to remember to add. `upstream` is what a branch is diffed against - never the fork's
# own master, which is chronically stale and makes a clean fix look like it carries half the
# repository with it.
git remote add fork "https://github.com/${fork}" 2>/dev/null || true
git remote set-url fork "https://github.com/${fork}" 2>/dev/null || true
git remote add upstream "https://github.com/${repo}" 2>/dev/null || true

# node_modules, hard-linked from a template of the same lockfile if this node already has one.
# The files are the same inodes, so a second workspace's node_modules costs directory entries
# and nothing else. Keyed by the lockfile hash, so a template is only ever used by a checkout
# that would have installed exactly it.
HASH=$(sha1sum yarn.lock 2>/dev/null | cut -c1-12)

if [ -n "$HASH" ] && [ ! -d node_modules ] && [ -d "$SHARED/template/$HASH/node_modules" ]; then
  cp -al "$SHARED/template/$HASH/node_modules" node_modules && touch .install-done
fi

[ -f .install-done ] || {
  yarn install --mutex "file:$SHARED/yarn/.mutex" --network-timeout 600000
  touch .install-done
}

# The first workspace to install a given lockfile leaves the template for the next one.
if [ -n "$HASH" ] && [ -d node_modules ] && [ ! -d "$SHARED/template/$HASH" ]; then
  mkdir -p "$SHARED/template/$HASH"
  cp -al node_modules "$SHARED/template/$HASH/node_modules" || rm -rf "$SHARED/template/$HASH"
fi

exec /bin/bash /workspace-config/serve.sh ${port}

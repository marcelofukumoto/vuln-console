#!/bin/sh
# Make a fix workspace able to do the work: give it a GitHub credential, the `gh` CLI, and a
# fork to push to.
#
# This runs in the AGENTS pod, not the workspace, and that is the point. The agents pod's
# ServiceAccount can read the token out of the Secret; the workspace's cannot, and should not -
# it is a pod running a build. So the token is read here and handed across the one channel that
# already exists between them, an exec into the workspace.
#
# The token is never on a command line. `kubectl exec` argv travels through the apiserver as URL
# query parameters, which are logged; it goes over STDIN instead.
#
# usage: workspace-setup.sh <workspace-namespace> <repo> <fork> <token-key> <board> <library>
set -e

NS=${1:?workspace-setup.sh needs the workspace namespace}
REPO=${2:?workspace-setup.sh needs the upstream repository}
FORK=${3:?workspace-setup.sh needs the fork}
# The Secret key holding the token of the person who pressed the button. The branch is pushed
# with THEIR credential, to THEIR fork, so the work is attributable to them.
TOKEN_KEY=${4:?workspace-setup.sh needs the token key}
# So each step can name itself on the job, and the board can say what it is waiting for rather
# than showing "Running" through five minutes of clone and install.
BOARD=${5:-}
LIBRARY=${6:-}

SECRET_NS=vuln-console
SECRET=settings
WS=/workspaces/$NS

kube() { KUBECONFIG=/dev/null kubectl "$@"; }

stage() {
  [ -n "$BOARD" ] && [ -n "$LIBRARY" ] || return 0
  sh "$(dirname "$0")/job.sh" "$BOARD" "$LIBRARY" "stage=$1" >/dev/null 2>&1 || true
}

# Wait for the workspace to exist before trying to talk to it.
#
# A workspace is minutes old before it is usable: Fleet has to render the Bundle, the kubelet has
# to pull node:24, and boot.sh then clones the repository and runs a yarn install. Exec'ing into
# it before any of that has happened fails with `container not found ("workspace")`, which is
# what the first real run did.
stage waiting
# Tested by TRYING it, not by reading a status. What this needs is to be able to exec into the
# container and find the checkout; both readiness conditions available here mean something else.
# `readyReplicas` and the container's `ready` are both the startup probe, which is the DEV SERVER
# answering on 8005 - the last thing to start and, for a repository whose dev server does not
# build, something that may never happen. A fix does not need a dev server to bump a lockfile, so
# waiting on one would fail every run on such a repository for a reason unrelated to the work.
echo "workspace-setup.sh: waiting for $NS to be usable"
i=0
ok=no
while [ "$i" -lt 240 ]; do
  if kube exec -n "$NS" "deploy/$NS" -c workspace -- test -d "$WS/src/.git" >/dev/null 2>&1; then
    ok=yes
    break
  fi
  i=$((i + 1))
  sleep 5
done

if [ "$ok" != yes ]; then
  echo "workspace-setup.sh: $NS did not become usable within 20 minutes" >&2
  exit 2
fi

secret_key() {
  kube get secret "$2" -n "$1" -o "jsonpath={.data.$3}" 2>/dev/null | base64 -d 2>/dev/null | tr -d '\r\n'
}

GH_TOKEN=$(secret_key "$SECRET_NS" "$SECRET" "$TOKEN_KEY")

if [ -z "$GH_TOKEN" ]; then
  echo "workspace-setup.sh: no GitHub token is stored for this user, so nothing could be pushed" >&2
  exit 2
fi

# The fork has to exist before the agent needs it. Creating it is one call and it is idempotent;
# discovering it is missing happens at `git push`, three minutes into a run, after the work.
FORK_OWNER=${FORK%%/*}
FORK_NAME=${FORK##*/}

status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$FORK_OWNER/$FORK_NAME")

if [ "$status" = "404" ]; then
  echo "workspace-setup.sh: $FORK does not exist yet - forking $REPO"
  curl -s -o /dev/null -X POST \
    -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/forks"
  # A fork is created asynchronously; it is usually there within a few seconds.
  i=0
  while [ "$i" -lt 30 ]; do
    status=$(curl -s -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/$FORK_OWNER/$FORK_NAME")
    [ "$status" = "200" ] && break
    i=$((i + 1))
    sleep 2
  done
fi

[ "$status" = "200" ] || { echo "workspace-setup.sh: $FORK is not reachable (HTTP $status)" >&2; exit 2; }

# Everything below runs inside the workspace, as its own user.
#
# The script goes in FIRST, as a separate exec, and only then is the token piped to it. Doing
# both at once does not work and fails silently: `kubectl exec -i` gives the pod one stdin, and a
# `<<HEREDOC` feeding `sh -s` claims it - so the `$(cat)` that was meant to read the token got
# EOF and wrote an EMPTY credentials file. Everything looked like it had worked until a push
# asked for a password.
# Written to a file rather than captured with `INNER=$(cat <<EOF)`: a heredoc inside a command
# substitution whose body contains `case` patterns trips the parser on their unbalanced `)`.
INNER_FILE=$(mktemp)
cat > "$INNER_FILE" <<'INNER_EOF'
set -e
TOKEN=$(cat)

if [ -z "$TOKEN" ]; then
  echo "workspace-setup: no token arrived on stdin" >&2
  exit 3
fi

mkdir -p "$WS/bin" "$HOME"

# git, for the push. A credential store file rather than a URL with the token embedded in it: a
# remote carrying a token is a token in `git remote -v`, in every error message, and in the
# repository's own config on disk.
umask 077
printf 'https://x-access-token:%s@github.com\n' "$TOKEN" > "$WS/.git-credentials"
git config --global credential.helper "store --file=$WS/.git-credentials"
git config --global user.name "${GIT_NAME:-Vulnerability Console}"
git config --global user.email "${GIT_EMAIL:-noreply@rancher.com}"

# Never attribute a console fix to the agent. The commits are the human's, on their fork.
git config --global --unset-all trailer.co-authored-by 2>/dev/null || true

# The fork remote, set here rather than at clone time: the fork follows whoever's token this is,
# which the checkout could not know.
cd "$WS/src"
git remote add fork "https://github.com/$FORK" 2>/dev/null || true
git remote set-url fork "https://github.com/$FORK"
git remote add upstream "https://github.com/$REPO" 2>/dev/null || true
git remote set-url upstream "https://github.com/$REPO"

# gh, which the fix prompt uses to read alerts and list pull requests. Not in the image and not
# in Debian's repositories, so the released static binary.
if ! [ -x "$WS/bin/gh" ]; then
  GH_VERSION=2.76.1
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64) GH_ARCH=amd64 ;;
    aarch64|arm64) GH_ARCH=arm64 ;;
    *) GH_ARCH=amd64 ;;
  esac
  URL="https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz"
  curl -sL "$URL" -o /tmp/gh.tgz
  tar -xzf /tmp/gh.tgz -C /tmp
  mv "/tmp/gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh" "$WS/bin/gh"
  chmod 755 "$WS/bin/gh"
  rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_${GH_ARCH}"
fi

# gh reads GH_TOKEN from the environment; the shell wrapper sources this for every command the
# agent runs. 0600, because it is a token in a file.
printf 'GH_TOKEN=%s\nGITHUB_TOKEN=%s\nVULN_FORK=%s\nVULN_REPO=%s\n' "$TOKEN" "$TOKEN" "$FORK" "$REPO" > "$WS/.env"
chmod 600 "$WS/.env"

# Prove it rather than assume it. A credential that does not work is worth knowing about now,
# not three minutes into a fix with the work already done.
git ls-remote --heads fork >/dev/null 2>&1 || {
  echo "workspace-setup: the stored token cannot reach $FORK" >&2
  exit 4
}

echo "workspace-setup: credential verified, gh $("$WS/bin/gh" --version | head -1 | awk '{print $3}'), fork $FORK"
INNER_EOF

# The script travels on argv (it is not a secret); the token travels on stdin (it is).
INNER_B64=$(base64 < "$INNER_FILE" | tr -d '\n')
rm -f "$INNER_FILE"

kube exec -n "$NS" "deploy/$NS" -c workspace -- \
  setpriv --reuid=1000 --regid=1000 --init-groups \
  /bin/sh -c "printf %s '$INNER_B64' | base64 -d > '$WS/.vc-setup.sh'"

stage preparing

printf '%s' "$GH_TOKEN" | kube exec -i -n "$NS" "deploy/$NS" -c workspace -- \
  setpriv --reuid=1000 --regid=1000 --init-groups \
  /usr/bin/env HOME="$WS/.home" WS="$WS" FORK="$FORK" REPO="$REPO" \
  /bin/sh "$WS/.vc-setup.sh"

kube exec -n "$NS" "deploy/$NS" -c workspace -- rm -f "$WS/.vc-setup.sh" >/dev/null 2>&1 || true

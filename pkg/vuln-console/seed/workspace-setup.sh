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
# usage: workspace-setup.sh <workspace-namespace> <repo> <fork>
set -e

NS=${1:?workspace-setup.sh needs the workspace namespace}
REPO=${2:?workspace-setup.sh needs the upstream repository}
FORK=${3:?workspace-setup.sh needs the fork}

SECRET_NS=vuln-console
SECRET=settings
STUDIO_NS=extension-studio
STUDIO_SECRET=settings
WS=/workspaces/$NS

kube() { KUBECONFIG=/dev/null kubectl "$@"; }

secret_key() {
  kube get secret "$2" -n "$1" -o "jsonpath={.data.$3}" 2>/dev/null | base64 -d 2>/dev/null | tr -d '\r\n'
}

GH_TOKEN=$(secret_key "$SECRET_NS" "$SECRET" gh_token)
[ -n "$GH_TOKEN" ] || GH_TOKEN=$(secret_key "$STUDIO_NS" "$STUDIO_SECRET" gh_token)

if [ -z "$GH_TOKEN" ]; then
  echo "workspace-setup.sh: no GitHub token is stored, so the workspace could not push anything" >&2
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

# Everything below runs inside the workspace, as its own user, reading the token off stdin.
printf '%s' "$GH_TOKEN" | kube exec -i -n "$NS" "deploy/$NS" -c workspace -- \
  setpriv --reuid=1000 --regid=1000 --init-groups \
  /usr/bin/env WS="$WS" FORK="$FORK" REPO="$REPO" /bin/sh -s <<'INNER'
set -e
TOKEN=$(cat)
mkdir -p "$WS/bin"

# git, for the push. A credential store file rather than a URL with the token embedded in it:
# a remote carrying a token is a token in `git remote -v`, in every error message, and in the
# repository's own config on disk.
umask 077
printf 'https://x-access-token:%s@github.com\n' "$TOKEN" > "$WS/.git-credentials"
git config --global credential.helper "store --file=$WS/.git-credentials"
git config --global user.name "${GIT_NAME:-Vulnerability Console}"
git config --global user.email "${GIT_EMAIL:-noreply@rancher.com}"

# Never attribute a console fix to the agent. The commits are the human's, opened on their fork.
git config --global --unset-all trailer.co-authored-by 2>/dev/null || true

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

echo "workspace-setup: credential, gh $("$WS/bin/gh" --version | head -1 | awk '{print $3}') and $FORK ready"
INNER

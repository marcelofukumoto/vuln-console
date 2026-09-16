#!/bin/sh
# Refresh the board: gather the Dependabot picture and put it in the cluster.
#
# Deterministic from end to end - there is no agent in this path and nothing is judged. The old
# console needed a watcher on somebody's laptop to do this on a timer; here it is a script the
# extension runs in a pod it already has, and the result is a ConfigMap rather than a file in an
# emptyDir that a pod rollout wiped.
#
# It resolves the token itself rather than being handed one. A token pasted into a page and
# written through the exec socket is a token the browser held; read here, with the pod's own
# ServiceAccount, at the moment it is needed, the browser never has it at all.
#
# usage: gather.sh <work-dir> <board-id> <repo> <token-key> [owner-package]
set -e

DIR=${1:?gather.sh needs a working directory}
BOARD=${2:?gather.sh needs a board id}
REPO=${3:?gather.sh needs a repository}
# The Secret key holding the token of the person who asked for this. Per user, so a gather is
# done as them and "our pull requests" means theirs.
TOKEN_KEY=${4:?gather.sh needs the token key}
# Optional: the package this repository gets most of its tree from. Empty for one that is its own.
OWNER_PACKAGE=${5:-}
SEED=$(dirname "$0")

[ -d "$DIR" ] || { echo "gather.sh: no such directory: $DIR" >&2; exit 2; }

NS=vuln-console
SECRET=settings

# kubectl as the pod rather than as whoever opened a terminal in it. shell.sh writes a kubeconfig
# carrying the Rancher identity of the person who opened the pane, and that identity may not be
# allowed to read these Secrets - the pod's ServiceAccount is. A KUBECONFIG naming nothing is
# what sends kubectl to the in-cluster config.
kube() {
  KUBECONFIG=/dev/null kubectl "$@"
}

secret_key() {
  kube get secret "$2" -n "$1" -o "jsonpath={.data.$3}" 2>/dev/null | base64 -d 2>/dev/null | tr -d '\r\n'
}

GH_TOKEN=$(secret_key "$NS" "$SECRET" "$TOKEN_KEY")

if [ -z "$GH_TOKEN" ]; then
  echo "gather.sh: no GitHub token is stored for this user. Set one from the Credentials dialog." >&2
  exit 2
fi

# 0600 before anything is in it, so it is never briefly readable. Removed however this ends.
CREDS="$DIR/creds.json"
SNAPSHOT="$DIR/snapshot.json"

cleanup() { rm -f "$CREDS"; }
trap cleanup EXIT INT TERM

: > "$CREDS"
chmod 600 "$CREDS"

# Through node rather than printf, so a token containing a quote or a backslash is JSON-encoded
# rather than pasted into a string and hoped for.
GH_TOKEN="$GH_TOKEN" node -e \
  'require("fs").writeFileSync(process.argv[1], JSON.stringify({ GH_TOKEN: process.env.GH_TOKEN }))' \
  "$CREDS"

CREDS_FILE="$CREDS" OUT="$SNAPSHOT" VULN_REPO="$REPO" OWNER_PACKAGE="$OWNER_PACKAGE" \
  node "$SEED/gather.mjs"

cleanup

# A ConfigMap holds a megabyte. A snapshot that does not fit has to fail as a gather somebody can
# see, not as a kubectl error nobody reads.
SIZE=$(wc -c < "$SNAPSHOT")

if [ "$SIZE" -gt 950000 ]; then
  echo "gather.sh: the snapshot is $((SIZE / 1024)) KiB, over what a ConfigMap can hold" >&2
  exit 2
fi

kube get namespace "$NS" >/dev/null 2>&1 || kube create namespace "$NS" >/dev/null

# Server-side apply, NOT the client-side default. A client-side `apply` records the whole object
# it sent in a `kubectl.kubernetes.io/last-applied-configuration` annotation, and annotations are
# capped at 256 KiB - so a snapshot large enough to be worth having is one the apiserver rejects
# outright ("metadata.annotations: Too long"). Server-side apply keeps its bookkeeping in
# managedFields instead, where there is no such limit.

kube create configmap "snapshot-$BOARD" \
  --namespace "$NS" \
  --from-file=snapshot.json="$SNAPSHOT" \
  --dry-run=client -o json |
  node -e '
    let raw = "";

    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      const cm = JSON.parse(raw);

      cm.metadata.labels = {
        "vuln-console.rancher.io/owns": "true",
        "vuln-console.rancher.io/board": process.argv[1],
      };
      process.stdout.write(JSON.stringify(cm));
    });
  ' "$BOARD" |
  kube apply --server-side --force-conflicts -f - >/dev/null

echo "gather.sh: published a $((SIZE / 1024)) KiB snapshot for $BOARD ($REPO)"

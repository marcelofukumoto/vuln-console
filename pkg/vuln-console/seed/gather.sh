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
# usage: gather.sh <work-dir>
set -e

DIR=${1:?gather.sh needs a working directory}
SEED=$(dirname "$0")

[ -d "$DIR" ] || { echo "gather.sh: no such directory: $DIR" >&2; exit 2; }

NS=vuln-console
SECRET=settings
# Extension Studio keeps an account's GitHub token under this exact name. Ours is preferred -
# setting one here is somebody choosing it for this extension - and theirs is the fallback, so
# nobody has to keep two copies of one token in step.
STUDIO_NS=extension-studio
STUDIO_SECRET=settings

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

GH_TOKEN=$(secret_key "$NS" "$SECRET" gh_token)
[ -n "$GH_TOKEN" ] || GH_TOKEN=$(secret_key "$STUDIO_NS" "$STUDIO_SECRET" gh_token)

if [ -z "$GH_TOKEN" ]; then
  echo "gather.sh: no GitHub token is stored. Set one from the extension's Credentials dialog." >&2
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

CREDS_FILE="$CREDS" OUT="$SNAPSHOT" VULN_REPO="${VULN_REPO:-rancher/dashboard}" \
  FORK_OWNER="${FORK_OWNER:-marcelofukumoto}" node "$SEED/gather.mjs"

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

kube create configmap snapshot \
  --namespace "$NS" \
  --from-file=snapshot.json="$SNAPSHOT" \
  --dry-run=client -o json |
  node -e '
    let raw = "";

    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      const cm = JSON.parse(raw);

      cm.metadata.labels = { "vuln-console.rancher.io/owns": "true" };
      process.stdout.write(JSON.stringify(cm));
    });
  ' |
  kube apply --server-side --force-conflicts -f - >/dev/null

echo "gather.sh: published a $((SIZE / 1024)) KiB snapshot"

#!/bin/sh
# Record what a run achieved, as fields on its job.
#
# The agent calls this rather than composing kubectl itself, for the same reason the report
# console has a publish script: the object name and the label are what the board selects on, so
# a job written with a typo'd label is a job that exists and cannot be found.
#
# It MERGES. Each call sets the fields it is given and leaves the rest, so recording a branch
# early and a pull request later does not erase the branch - which is the failure mode of every
# "write the whole file" version of this.
#
# usage: job.sh <library> phase=Done branch=... prNumber=123 message="..."
set -e

LIBRARY=${1:?job.sh needs the library}
shift

NS=vuln-console

kube() { KUBECONFIG=/dev/null kubectl "$@"; }

# The object name, by the same rule the extension uses: lowercased, anything that is not a
# letter or a digit becomes a hyphen. `@scope/name` is not a legal object name and this is only
# an address - the record keeps the real library name in a field.
NAME=job-$(printf '%s' "$LIBRARY" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-*//; s/-*$//' | cut -c1-50)

CURRENT=$(kube get configmap "$NAME" -n "$NS" -o "jsonpath={.data.job\.json}" 2>/dev/null || true)

# Read the current record, apply the assignments, write it back. Through node because the values
# are arbitrary text - a message can contain a quote, a URL contains slashes - and sed would
# mangle both.
UPDATED=$(CURRENT="$CURRENT" LIBRARY="$LIBRARY" node -e '
  const assignments = process.argv.slice(1);
  let job = {};

  try {
    job = JSON.parse(process.env.CURRENT || "{}") || {};
  } catch {
    job = {};
  }

  job.library = job.library || process.env.LIBRARY;

  // Numbers stay numbers and the empty string clears a field, so `prNumber=` is how a run says
  // "there is no pull request" without writing the string "null" into the board.
  for (const pair of assignments) {
    const at = pair.indexOf("=");

    if (at < 1) {
      continue;
    }

    const key = pair.slice(0, at);
    const raw = pair.slice(at + 1);

    if (raw === "") {
      job[key] = null;
    } else if (/^(prNumber|startedAt|updatedAt)$/.test(key)) {
      job[key] = Number(raw);
    } else if (key === "vulnIds") {
      job[key] = raw.split(",").map((n) => Number(n.trim())).filter((n) => !Number.isNaN(n));
    } else {
      job[key] = raw;
    }
  }

  job.updatedAt = Date.now();
  process.stdout.write(JSON.stringify(job));
' "$@")

[ -n "$UPDATED" ] || { echo "job.sh: refusing to write an empty job" >&2; exit 1; }

kube get namespace "$NS" >/dev/null 2>&1 || kube create namespace "$NS" >/dev/null

printf '%s' "$UPDATED" > /tmp/job-$$.json

kube create configmap "$NAME" \
  --namespace "$NS" \
  --from-file=job.json=/tmp/job-$$.json \
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

rm -f /tmp/job-$$.json

echo "job.sh: recorded $*"

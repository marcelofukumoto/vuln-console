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
# usage: job.sh <board> <library> phase=Done branch=... prNumber=123 message="..."
set -e

BOARD=${1:?job.sh needs the board}
LIBRARY=${2:?job.sh needs the library}
shift 2

NS=vuln-console

kube() { KUBECONFIG=/dev/null kubectl "$@"; }

# The object name, by the same rule the extension uses: lowercased, anything that is not a
# letter or a digit becomes a hyphen. `@scope/name` is not a legal object name and this is only
# an address - the record keeps the real library name in a field.
NAME=job-$BOARD-$(printf '%s' "$LIBRARY" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-*//; s/-*$//' | cut -c1-40)

CURRENT=$(kube get configmap "$NAME" -n "$NS" -o "jsonpath={.data.job\.json}" 2>/dev/null || true)

# Read the current record, apply the assignments, write it back. Through node because the values
# are arbitrary text - a message can contain a quote, a URL contains slashes - and sed would
# mangle both.
UPDATED=$(CURRENT="$CURRENT" LIBRARY="$LIBRARY" BOARD="$BOARD" node -e '
  const assignments = process.argv.slice(1);
  let job = {};

  try {
    job = JSON.parse(process.env.CURRENT || "{}") || {};
  } catch {
    job = {};
  }

  job.library = job.library || process.env.LIBRARY;
  job.board = job.board || process.env.BOARD;

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

  // A recording that only exists as a path inside a pod cannot be watched, and the board has
  // nothing to link to - which is exactly how a finished recording read as "Recorded, not
  // served". The workspace dev server publishes its own `artifacts/` directory at
  // `/vc-artifacts` and is already reachable through the Rancher proxy with the session of
  // whoever is looking, so the same file is a link with nothing copied and nothing to clean up.
  //
  // Done HERE rather than asked for in the prompt. The prompt has said to record a URL since
  // the recording flow existed and a run still reported a bare path; an instruction an agent
  // can skip is not a mechanism. A value that is already a URL is left exactly as it is.
  //
  // String work only, no filesystem: this script runs in the agent pod, which does not mount
  // the workspace that holds the file.
  const base = (job.previewUrl || process.env.VULN_PREVIEW_URL || "").replace(/\/+$/, "");

  for (const key of ["videoUrl", "infoUrl"]) {
    const value = job[key];

    if (typeof value !== "string" || !base) {
      continue;
    }

    const artifact = /^\/workspaces\/[^/]+\/artifacts\/(.+)$/.exec(value);

    if (artifact) {
      job[key] = `${ base }/vc-artifacts/${ artifact[1] }`;
    }
  }

  // A phase the board does not know is worse than no phase at all: "is this running" is
  // `phase === "Running"`, so an invented value makes a live run look finished and the board
  // offers its buttons again while an agent is still working. Progress belongs in `stage`,
  // which is free-form on purpose.
  const PHASES = ["Running", "Fixed", "Done", "Failed", "Cancelled"];

  if (job.phase && !PHASES.includes(job.phase)) {
    process.stderr.write(
      `job.sh: "${ job.phase }" is not a phase. Use one of ${ PHASES.join(", ") } - and for ` +
      `progress use stage=<what you are doing> instead, which is free-form.\n`,
    );
    process.exit(2);
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

      cm.metadata.labels = {
        "vuln-console.rancher.io/owns": "true",
        "vuln-console.rancher.io/board": process.argv[1],
      };
      process.stdout.write(JSON.stringify(cm));
    });
  ' "$BOARD" |
  kube apply --server-side --force-conflicts -f - >/dev/null

rm -f /tmp/job-$$.json

echo "job.sh: recorded $*"

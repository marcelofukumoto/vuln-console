#!/bin/sh
# Everything a run does after its button has answered: wait for the workspace, prepare it, and
# start the agent's pane.
#
# In the agents pod, detached, and NOT in the browser tab that pressed the button. It used to be
# a promise left running in the page, and a page is not somewhere to keep a run: the workspace
# can take twenty minutes to become usable, and closing the tab - or navigating anywhere else in
# Rancher - in that time killed the run where it stood. The agent was never started, nothing
# recorded a failure, and the row said "preparing" until the stale timer caught it. Here it
# outlives the tab, and every way it can end is written on the job.
#
# usage: run-start.sh <board> <library> <repo> <workspace> <fork> <token-key> <rancher-token-key>
#                     <rancher-url> <session> <conversations-dir> <agent-home>
BOARD=${1:?run-start.sh needs the board}
LIBRARY=${2:?run-start.sh needs the library}
REPO=${3:?run-start.sh needs the repository}
WORKSPACE=${4:?run-start.sh needs the workspace}
FORK=${5:?run-start.sh needs the fork}
TOKEN_KEY=${6:?run-start.sh needs the token key}
RANCHER_TOKEN_KEY=${7:-}
RANCHER_URL=${8:-}
SESSION=${9:?run-start.sh needs the session}
CONVERSATIONS=${10:?run-start.sh needs the conversations directory}
AGENT_HOME=${11:?run-start.sh needs the agent home}

ROOT=$(cd "$(dirname "$0")" && pwd)
LOG="$ROOT/run-$WORKSPACE.log"
ERR="$ROOT/run-$WORKSPACE.err"

job() { sh "$ROOT/job.sh" "$BOARD" "$LIBRARY" "$@" >/dev/null 2>&1 || true; }

# The reason, from what the step said on stderr - the same text the board used to show when the
# page ran this, so a failure reads the same as it always has.
fail() {
  why=$(tail -n 5 "$ERR" 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-500)
  [ -n "$why" ] || why=$(tail -n 3 "$LOG" 2>/dev/null | tr '\n' ' ' | cut -c1-500)
  job phase=Failed "message=Could not $1: ${why:-it reported nothing}"
  exit 1
}

: > "$LOG"
: > "$ERR"
echo "run-start.sh: $BOARD/$LIBRARY in $WORKSPACE, $(date -u +%FT%TZ)" >> "$LOG"

sh "$ROOT/workspace-setup.sh" "$WORKSPACE" "$REPO" "$FORK" "$TOKEN_KEY" "$BOARD" "$LIBRARY" \
  "$RANCHER_TOKEN_KEY" "$RANCHER_URL" >> "$LOG" 2>> "$ERR" \
  || fail "prepare the workspace for $REPO"

job stage=starting

# The pane, detached, with the shell prefix pointing into the workspace. Without it nothing
# attaches until somebody opens the terminal by hand, and the queued prompt is never read.
: > "$ERR"
/bin/sh /seed/shell.sh "$SESSION" "$CONVERSATIONS" "$AGENT_HOME" start "$ROOT/shell-$WORKSPACE.sh" >> "$LOG" 2>> "$ERR" \
  || fail "start the conversation in the agent pod"

echo "run-start.sh: the agent is started" >> "$LOG"

#!/bin/bash
# The dev server, supervised: the container's process is this loop, not the server.
#
# A fix run does things that kill a dev server - switches branch, regenerates a lockfile, runs a
# build. When the pod's main process was the server itself, each of those restarted the
# container and took the run's terminal with it, mid-fix. So the server is restarted when it
# exits, and left alone while something else holds the port.
PORT=${1:-8005}

# The boot script runs this from the checkout, so the tree is its parent - which is where the
# log and the retarget file live.
WS=${WS:-$(dirname "$PWD")}
RETARGET=$WS/.dev-server.env
LOG=$WS/.dev-server.log

echo "$PORT" > "$WS/.dev-server.port" 2>/dev/null || true
export PORT WS RETARGET LOG IONICE

held() {
  node -e "require('net').connect(Number(process.argv[1]),'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" "$PORT" 2>/dev/null
}

# Not all at once. Rancher's embedded k3s runs beside these servers, and when it restarts every
# workspace pod restarts with it and every webpack compiles at the same moment: a dozen of them
# on twelve cores, k3s's controllers fail to renew their lease, k3s exits, Rancher restarts -
# and the herd forms again. So a server waits, with jitter so they do not all wake together,
# while the node's one-minute load is above what the cores can carry.
CORES=$(nproc 2>/dev/null || echo 4)
gate() {
  load=$(cut -d. -f1 /proc/loadavg 2>/dev/null || echo 0)
  [ "$load" -le $(( CORES * 3 / 2 )) ]
}

# One dev server per pod, whoever started it. A second webpack is another two gigabytes at every
# rebuild and the pod's limit is five, so an agent that starts its own gets the port until it is
# done and this one comes back afterwards. Only node processes, matched by command line: a shell
# or a grep that merely mentions the server would otherwise count and stop this one for nothing.
servers() { pgrep -f "^[^ ]*node .*vue-cli-service serve" 2>/dev/null; }
foreign() {
  local p
  for p in $(servers); do
    [ "$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')" = "$SERVER" ] || echo "$p"
  done
}

SERVER=""
stop_ours() {
  if [ -n "$SERVER" ]; then
    kill -TERM -- -"$SERVER" 2>/dev/null
    wait "$SERVER" 2>/dev/null
    SERVER=""
  fi
}
trap "stop_ours; exit 0" TERM INT

while :; do
  if held || [ -n "$(foreign)" ]; then sleep 10; continue; fi

  sleep $(( RANDOM % 20 ))

  waited=0
  while ! gate && [ "$waited" -lt 300 ]; do
    [ "$waited" -eq 0 ] && echo "[workspace] the node is busy; waiting to start the dev server"
    sleep 10
    waited=$((waited + 10))
  done

  # Below the cluster's own processes: a compile that takes every core has taken k3s down with
  # it on a busy node, and a slow first page is the better failure.
  IONICE=""
  command -v ionice >/dev/null 2>&1 && IONICE="ionice -c 3"

  # What the server runs against can be changed without a new pod: writing the retarget file
  # restarts it onto a different Rancher. Read in the server's own shell, so it replaces the
  # pod's environment for the server alone.
  STAMP=$(stat -c %Y "$RETARGET" 2>/dev/null || echo 0)
  [ -f "$RETARGET" ] && echo "[workspace] the dev server runs against $(grep '^API=' "$RETARGET" | cut -d= -f2-)"

  # setsid, so the server and everything it starts are one process group a stop can signal as a
  # whole; tee, so the log is in the tree as well as in the pod's.
  setsid bash -c 'if [ -f "$RETARGET" ]; then set -a; . "$RETARGET"; set +a; fi; nice -n 15 $IONICE env VUE_CLI_SERVICE_CONFIG_PATH="$WS/src/.workspace.vue.config.js" yarn dev --port "$PORT" 2>&1 | tee "$LOG"' &
  SERVER=$!

  # `sleep & wait`, not `sleep`: a trap runs once the foreground command returns, and a stop
  # that waited out the sleep left the server running for the check that followed.
  while kill -0 "$SERVER" 2>/dev/null; do
    sleep 10 & wait $!
    if [ -n "$(foreign)" ]; then
      echo "[workspace] another dev server is running in this pod; standing down until it is gone"
      stop_ours; sleep 10; continue 2
    fi
    if [ "$(stat -c %Y "$RETARGET" 2>/dev/null || echo 0)" != "$STAMP" ]; then
      echo "[workspace] the dev server's target changed; restarting it"
      stop_ours; continue 2
    fi
  done

  SERVER=""
  echo "[workspace] the dev server exited; starting it again in 5s"
  sleep 5
done

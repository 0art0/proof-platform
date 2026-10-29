#!/usr/bin/env bash
# Starts the proof worker and the web app together; Ctrl-C stops both.
#
#   scripts/start.sh            # in-memory store (state is lost on exit)
#   PROOF_DATABASE_URL=postgres://... scripts/start.sh   # PostgreSQL store (run `npm run migrate` first)
#
# The worker reads AI settings (AI_GATEWAY_API_KEY, PROOF_AI_*) from .env.local when it exists.
# PROOF_HTTP_PORT (default 8787) and WEB_PORT (default 3000) choose the ports.
set -euo pipefail

cd "$(dirname "$0")/.."

WORKER_PORT="${PROOF_HTTP_PORT:-8787}"
WEB_PORT="${WEB_PORT:-3000}"

if [ ! -d node_modules ]; then
  echo "Installing dependencies (npm ci)..."
  npm ci
fi

for port in "$WORKER_PORT" "$WEB_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "Port $port is already in use; stop whatever is listening there or choose another port." >&2
    exit 1
  fi
done

if [ -n "${PROOF_DATABASE_URL:-${DATABASE_URL:-}}" ]; then
  store="postgres"
else
  export PROOF_STORE=memory
  store="memory (not persisted)"
fi

env_file_args=()
if [ -f .env.local ]; then
  env_file_args=(--env-file=.env.local)
fi

pids=()
cleanup() {
  trap - INT TERM EXIT
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

PROOF_HTTP_PORT="$WORKER_PORT" node "${env_file_args[@]}" --import tsx apps/worker/src/main.ts &
pids+=($!)

PROOF_HTTP_ORIGIN="http://127.0.0.1:$WORKER_PORT" NEXT_TELEMETRY_DISABLED=1 \
  node_modules/.bin/next dev apps/web --hostname 127.0.0.1 --port "$WEB_PORT" &
pids+=($!)

echo
echo "Worker: http://127.0.0.1:$WORKER_PORT (store: $store)"
# The API's same-origin check expects the page on localhost, not 127.0.0.1.
echo "Open:   http://localhost:$WEB_PORT"
echo

# Exit as soon as either server stops, taking the other down with it.
wait -n

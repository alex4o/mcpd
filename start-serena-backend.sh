#!/bin/bash
# Starts the Serena SSE backend server (without mcp-proxy).
# mcpd handles the SSE client connection itself.
SCRIPT_DIR="$(dirname "$(realpath "$0")")"
PIDFILE="$SCRIPT_DIR/.serena.pid"
PORT=8766

# If already running, nothing to do
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    exit 0
fi

rm -f "$PIDFILE"

uv run --directory "$HOME/Projects/serena" serena start-mcp-server \
    --context claude-code \
    --project "$SCRIPT_DIR" \
    --transport sse \
    --port "$PORT" &>"$SCRIPT_DIR/.serena.log" &
echo $! > "$PIDFILE"

# Wait for it to be ready before exiting
for _ in $(seq 1 120); do
    curl -sf "http://localhost:$PORT/sse" -m 1 -o /dev/null
    [ $? -le 28 ] && exit 0
    sleep 0.5
done

echo "Serena failed to start" >&2
exit 1

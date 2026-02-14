#!/bin/bash
SCRIPT_DIR="$(dirname "$(realpath "$0")")"
PIDFILE="$SCRIPT_DIR/.serena.pid"
PORT=8766

start_server() {
    uv run --directory "$HOME/Projects/serena" serena start-mcp-server \
        --context claude-code \
        --project "$SCRIPT_DIR" \
        --transport sse \
        --port "$PORT" &>"$SCRIPT_DIR/.serena.log" &
    echo $! > "$PIDFILE"
}

wait_ready() {
    for _ in $(seq 1 60); do
        curl -sf "http://localhost:$PORT/sse" -m 1 -o /dev/null
        [ $? -le 28 ] && return 0
        sleep 0.5
    done
    return 1
}

stop_server() {
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        kill "$(cat "$PIDFILE")"
        # Wait for port to be free
        for _ in $(seq 1 20); do
            ss -tlnp 2>/dev/null | grep -q ":$PORT " || break
            sleep 0.5
        done
        rm -f "$PIDFILE"
        return 0
    else
        rm -f "$PIDFILE"
        return 1
    fi
}

if [ "$1" = "kill" ]; then
    stop_server && echo "Serena stopped" || echo "Serena not running"
    exit 0
fi

if [ "$1" = "restart" ]; then
    stop_server
    start_server
    wait_ready
    echo "Serena restarted" >&2
    exec uvx mcp-proxy "http://localhost:$PORT/sse"
fi

# Default: start if not running, then proxy
if ! [ -f "$PIDFILE" ] || ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    rm -f "$PIDFILE"
    start_server
    wait_ready
fi

exec uvx mcp-proxy "http://localhost:$PORT/sse"

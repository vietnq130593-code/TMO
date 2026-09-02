#!/bin/bash
# Start OpenCode Server as a persistent daemon
# Auto-detects project root (3 levels up from this script)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$SCRIPT_DIR"
# FIX 2026-09-15: tôn trọng OPENCODE_SERVER_PORT từ môi trường (multi-instance —
# vd chạy thêm bản clone của app để kiểm định trước khi push: đặt 18791+).
# Trước đây hardcode 18790 → 2 instance giết nhau giữ port (manager "Killing
# port holder" ping-pong giữa production và clone).
export OPENCODE_SERVER_PORT="${OPENCODE_SERVER_PORT:-18790}"
export OPENCODE_WORKSPACE="${OPENCODE_WORKSPACE:-$PROJECT_ROOT}"

# Double-fork to daemonize
(bun server.ts > /tmp/opencode-server.log 2>&1 &)
echo "OpenCode Server started (workspace: $OPENCODE_WORKSPACE, port: $OPENCODE_SERVER_PORT)"

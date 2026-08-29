#!/bin/bash
# =============================================================================
# PM2 start wrapper for Theopusflashlite (TMO)
# =============================================================================
# Mục đích: "PM2 duy trì hiển thị giao diện app" trong MỌI tình huống.
#
# Vấn đề: nếu process cha (next dev CLI) bị SIGKILL (vd: kernel OOM-killer),
# con của nó là `next-server` có thể thành process mồ côi, vẫn giữ port 3000.
# Khi PM2 restart app, instance mới gặp EADDRINUSE → crash-loop → app "chết"
# dù PM2 vẫn chạy.
#
# Giải pháp: trước khi khởi động Next.js, dọn mọi process đang giữ port 3000
# (chỉ có thể là process mồ côi hoặc instance cũ chưa chết hết — instance mới
# chưa tồn tại). Sau đó exec thay thế bash bằng node next dev để PM2 quản lý
# trực tiếp process Next.js.
# =============================================================================

PORT="${PORT:-3000}"

# Tìm PID đang giữ port (loại trừ chính mình)
HOLDER=$(ss -tlnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | sort -u | head -1)

if [ -n "$HOLDER" ] && [ "$HOLDER" != "$$" ]; then
  echo "[pm2-start] Port ${PORT} đang bị PID ${HOLDER} giữ — dọn dẹp (orphan/port-conflict)..."
  # Ưu tiên SIGTERM cho process chết sạch (release port graceful)
  kill "$HOLDER" 2>/dev/null
  for i in 1 2 3 4 5; do
    sleep 1
    if ! kill -0 "$HOLDER" 2>/dev/null; then
      break
    fi
  done
  # Vẫn sống → SIGKILL
  if kill -0 "$HOLDER" 2>/dev/null; then
    echo "[pm2-start] PID ${HOLDER} không chịu chết sau 5s — SIGKILL."
    kill -9 "$HOLDER" 2>/dev/null
    sleep 1
  fi
  # Dọn cả các process con mồ côi của next (postcss pool, turbopack workers...)
  pkill -9 -f "tmo-app/.next/dev/build" 2>/dev/null
  echo "[pm2-start] Port ${PORT} đã được giải phóng."
fi

# Khởi động Next.js — exec để PM2 sở hữu trực tiếp process node next
cd "$(dirname "$0")/.."
exec node node_modules/next/dist/bin/next dev -p "$PORT"

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

# =============================================================================
# GUARD DATABASE_URL (fix 2026-09-01 — lỗi đã xảy ra thật):
# Shell sandbox xuất khẩu DATABASE_URL=file:/home/z/my-project/db/custom.db
# (DB của scaffold my-project). Lệnh `pm2 restart --update-env` hấp thụ env
# shell → GHI ĐÈ env pin trong ecosystem.config.cjs → app trỏ sang DB SAI
# (schema lệch, scheduler không thấy proposal, tạo row rác ở DB khác).
# Wrapper luôn ép DATABASE_URL về DB của tmo-app — bất kể env đến từ đâu.
# (Đường dẫn tương đối để giữ tính portable khi copy thư mục.)
# =============================================================================
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "$DATABASE_URL" ] && [[ "$DATABASE_URL" != *"$APP_DIR"* ]]; then
  echo "[pm2-start] ⚠️ DATABASE_URL shell nhiễm đường dẫn ngoài app ($DATABASE_URL) — ép về DB của tmo-app."
fi
if [[ "$DATABASE_URL" == *"/my-project/"* ]] || [ -z "$DATABASE_URL" ]; then
  export DATABASE_URL="file:$APP_DIR/db/custom.db"
  echo "[pm2-start] DATABASE_URL pinned: $DATABASE_URL"
fi

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

# =============================================================================
# DỌN RÁC /tmp (fix 2026-10-21 Task 24 — đĩa từng đầy 100% vì loại rác này):
# mỗi lần bun spawn (opencode CLI, script test...) có thể để lại file compile
# cache ~5.4MB dạng /tmp/.bcd9*.so và KHÔNG tự dọn → tích lũy vài GB → SQLite/
# Next.js không ghi được đĩa (nguyên nhân một phần các vụ OOM-crash trước).
# Xóa các file cũ hơn 60 phút (file đang được process giữ vẫn an toàn trên Linux).
# =============================================================================
find /tmp -maxdepth 1 -name '.bcd9*.so' -mmin +60 -delete 2>/dev/null
find /tmp -maxdepth 1 -type d -name '.*.node-gyp' -mmin +60 -exec rm -rf {} + 2>/dev/null

# =============================================================================
# VÒNG 10 (2026-09-30) — HARD-SET NODE_OPTIONS chống restart-loop:
# ① next dev (Turbopack) để V8 GC lười → RSS ratchet 2.3GB → MemAvailable toàn
#   cục <650MB → MemWatchdog self-exit → mission goal-loop chết giữa LLM call
#   (RESUME lặp 39+ lần kẹt "chu kỳ 7, 12 vòng"; attempts leo 62/200).
# ② PM2 env bị nhiễm "--enable-source-maps" từ một lần --update-env trước (không
#   có trong ecosystem — khai 1024): source-map giữ map toàn bộ module graph
#   trong RAM → boot nổ 2.2GB CHỈ TRONG 30s, crash-loop nhanh dần. HARD-SET
#   (không append) để mọi nguồn nhiễm (shell --update-env, ecosystem cũ 1024,
#   flag append trùng) đều bị ghi đè deterministic.
# Nếu log xuất hiện "JavaScript heap out of memory" → nâng 1408 → 1536 → 1664.
# =============================================================================
# VÒNG 15 (2026-09-30 18:45) — HẠ 1664 → 1280 chống reaper SIGINT ~38s/lần:
# Đo thực: next-server child RSS boot-ramp 840MB → 2216MB trong ~36s khi browser
# user poll ~15 route (turbopack cold-compile mỗi lần restart). Reaper sandbox
# SIGINT cả tree khi RSS child ~2.1-2.2GB (kể cả MemAvailable dư 2GB — round-11c).
# Cap 1664 chỉ chặn old-space, external (turbopack native + buffer) vẫn đẩy RSS
# lên vùng chết. Hạ cap 384MB → V8 GC gấp đứng đỉnh ~1.8-1.9GB < 2.1GB reaper
# → đời sống app dài hơn (cần ≥2-3' liên tục cho request_code_team workflow
# in-process 10-30' của round-15 directive). Tối quan sát 5': OOM >1 lần → nâng
# bậc thang trên; RSS đỉnh vẫn >2.05GB → hạ tiếp 1152.
export NODE_OPTIONS="--max-old-space-size=1280"

# Khởi động Next.js — exec để PM2 sở hữu trực tiếp process node next
cd "$(dirname "$0")/.."
exec node node_modules/next/dist/bin/next dev -p "$PORT"

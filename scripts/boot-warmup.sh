#!/bin/bash
# =============================================================================
# BOOT WARMUP — serialized cold-compile pipeline (§7.10 phần 2 — trả nợ 2026-10-21)
# =============================================================================
# VẤN ĐỀ (bằng chứng §7.10 + KPI #4b): Next dev cold-compile lúc boot — browser
# poll ~15 route CÙNG LÚC → turbopack compile song song → RSS next-server spike
# 2330-2603MB (peak kỷ lục 2603MB) ≥ HARD-RSS 2100MB → §7.10 boot-grace 180s
# phải THA mỗi lần (vô hại vận hành nhưng spike vẫn đó — nợ "build pipeline").
#
# GIẢI PHÁP: WARMUP TUẦN TỰ chạy nền NGAY khi port mở — curl TỪNG route một
# (nghỉ 2s giữa các route) → turbopack compile MỘT route/lượt thay vì 15 song
# song → đỉnh RSS kỳ vọng xuống xa dưới 2100 (mỗi compile spike rồi GC giữa
# các route — NODE_OPTIONS --expose-gc sẵn sàng cho MemWatchdog soft tier).
# Route được compile xong trước khi browser user poll → storm thực tế còn lại
# gần như 0 (cache ấm).
#
# ĐO KÈM (KPI #4b before/after): mỗi route log HTTP code + thời gian + RSS
# next-server; cuối warmup log PEAK RSS so baseline 2603MB.
#
# AN TOÀN:
#   - Chỉ đọc GET (0 side-effect) — route ops là read-only, /api/health idempotent.
#   - Idempotent: cache ấm → mỗi GET ~50-100ms, warmup tự trở thành no-op rẻ.
#   - Chống chồng lặp restart-loop: thoát NGAY nếu có warmup khác đang chạy.
#   - Time-box: đợi port tối đa 120s; mỗi GET timeout 120s; tắt bằng TMO_BOOT_WARMUP=0.
#   - Detached (setsid + nohup): không giữ pm2-start.sh (script chính exec sang node).
# =============================================================================

PORT="${PORT:-3000}"
LOG="${TMO_WARMUP_LOG:-/home/z/my-project/dev.log}"

# Chống chạy chồng (restart-loop spawn wrapper mỗi vòng — chỉ 1 warmup sống).
# FB-DEBT4-LIVE-01: bản pgrep tự ĐÁNH CHẾT CHÍNH MÌNH — `$(pgrep -f "boot-warmup.sh")`
# fork subshell có CÙNG cmdline "bash .../boot-warmup.sh" với script cha → pgrep
# trả 2 pid (cha + fork tạm) → pid khác $$ → exit 0 ngay (bằng chứng live
# 06:14: 2 lần spawn đều chết im, 0 dòng [pm2-warmup]). flock kernel-managed
# thay thế: lock tự nhả khi process chết — an toàn cả crash-loop.
LOCK_FILE="${TMO_WARMUP_LOCK:-/tmp/tmo-boot-warmup.lock}"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  # Warmup khác đang giữ lock (đang chờ port/đang warm) — thoát NGAY
  exit 0
fi

log() { echo "[pm2-warmup] $(date -u '+%H:%M:%S') $*" >> "$LOG"; }

# Route warmup — trang chính + các API nặng nhất theo thứ tự dùng nhiều nhất
# (browser poll storm đã quan sát: / + agents + todos + neural-architecture…).
ROUTES=(
  "/"
  "/api/health"
  "/api/agents"
  "/api/todos"
  "/api/neural-architecture"
  "/api/self-direction/proposals"
  "/api/observation/write-queue"
  "/api/observation/interactive-tx"
)

# Đợi port sẵn sàng (next dev mất 1-4s mở listener)
READY=0
for i in $(seq 1 120); do
  if ss -tln 2>/dev/null | grep -q ":${PORT} "; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  log "port ${PORT} không sẵn sàng sau 120s — bỏ warmup (lần này)"
  exit 0
fi

# RSS (kB) của process next-server đang giữ port — thăm dò mỗi route + giữ peak
server_rss_kb() {
  local holder
  holder=$(ss -tlnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | sort -u | head -1)
  if [ -n "$holder" ] && [ -r "/proc/${holder}/status" ]; then
    awk '/^VmRSS/{print $2}' "/proc/${holder}/status" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

PEAK_KB=0
STARTED=$(date +%s)
log "bắt đầu warmup tuần tự ${#ROUTES[@]} route (port ${PORT}) — serialized compile thay thế storm song song"

for route in "${ROUTES[@]}"; do
  t0=$(date +%s%3N)
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 120 "http://127.0.0.1:${PORT}${route}" 2>/dev/null || echo "ERR")
  dt=$(( $(date +%s%3N) - t0 ))
  rss=$(server_rss_kb)
  if [ "$rss" -gt "$PEAK_KB" ] 2>/dev/null; then PEAK_KB=$rss; fi
  log "warmup ${route} → HTTP ${code} ${dt}ms · RSS next-server $((rss/1024))MB (peak $((PEAK_KB/1024))MB)"
  sleep 2
done

ELAPSED=$(( $(date +%s) - STARTED ))
log "HOÀN TẤT warmup ${#ROUTES[@]} route trong ${ELAPSED}s — PEAK RSS next-server = $((PEAK_KB/1024))MB (§7.10-p2 mục tiêu < 2100MB · baseline storm song song = 2603MB)"

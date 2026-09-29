#!/bin/bash
# =============================================================================
# TMO KEEPALIVE WATCHDOG — "PM2 duy trì hiển thị giao diện app"
# =============================================================================
# Sự cố thực chiến (2026-09-29): goal-loop agent chạy `pm2 stop/restart
# theopusflashlite` qua tool shell của chính app → PM2 giết process tree app
# (kể cả pm2 CLI đang phát lệnh) → pha start không bao giờ chạy → app nằm im
# stopped, UI mất hoàn toàn (4 lần: 11:21, 12:17, 12:21, 13:32, 15:13, 15:29
# UTC — kẻ thủ phạm xác định: agent SENTINEL job zmdh0r4q).
#
# Lớp phòng thủ 2 lớp (2026-09-29):
#   LỚP 1 (trong app): self-destruct guard trong protected-paths.ts —
#          chặn/rewrite lệnh pm2 nhắm process app trong tool shell.
#   LỚP 2 (file này, NGOÀI app): watchdog độc lập chạy bởi PM2 (app riêng
#          tmo-keepalive) — phát hiện app không phục vụ → tự kéo dậy.
#          Covers MỌI nguyên nhân: agent qua gateway exec, tay sai, env...
#
# Hành vi mỗi 30s:
#   - curl /api/health != 200:
#       · pm2 status != online  → pm2 restart theopusflashlite (ngay)
#       · pm2 status = online   → có thể HTTP-wedge (in-app HTTP Watchdog
#         tự xử lý bằng self-exit ~3 phút) → chờ tối đa 4 phút rồi restart
#         từ ngoài nếu vẫn chưa phục hồi.
#   - curl 200 → bình thường, xoá state first-fail.
#
# ESCAPE HATCH (operator bảo trì / agent maintenance chain — round-5):
#   · File flag RỖNG (touch) → watchdog nghỉ VÔ HẠN — operator xoá file sau bảo trì.
#   · File flag CHỨA epoch hết hạn (vd `date -d '+30 minutes' +%s > .keepalive-off`)
#     → watchdog nghỉ ĐẾN hết hạn rồi TỰ HỒI NHIỆM VỤ (gỡ flag, kéo app dậy nếu
#     cần) — bảo hiểm khi chuỗi bảo trì detached chết giữa chừng, app không bị
#     bỏ mặc quá lâu (UI mất tối đa = thời hạn ghi trong flag).
# =============================================================================

APP="theopusflashlite"
URL="http://127.0.0.1:3000/api/health"
STATE="/tmp/tmo-keepalive-firstfail"
FLAG="/home/z/tmo-app/.keepalive-off"
TAG="[TMO-Keepalive]"
WEDGE_PATIENCE=240  # giây — chờ in-app watchdog tự xử wedge trước khi can thiệp

log() { echo "$TAG $(date -u '+%F %T') UTC — $*"; }

log "watchdog khởi động (chu kỳ 30s, URL=$URL, wedge-patience=${WEDGE_PATIENCE}s)"

while true; do
  # Escape hatch: operator/agent đang bảo trì — kiểm tra flag + expiry
  if [ -f "$FLAG" ]; then
    EXPIRY=$(tr -dc '0-9' < "$FLAG" 2>/dev/null)
    if [ -n "$EXPIRY" ] && [ "$(date +%s)" -ge "$EXPIRY" ]; then
      log "keepalive-off flag HẾT HẠN (epoch $EXPIRY đã qua) — gỡ flag, HỒI NHIỆM VỤ"
      rm -f "$FLAG"
    else
      sleep 30
      continue
    fi
  fi

  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$URL" 2>/dev/null)

  if [ "$CODE" = "200" ]; then
    rm -f "$STATE" 2>/dev/null
    sleep 30
    continue
  fi

  # Health KHÔNG 200 — xem PM2 đang nói gì
  STATUS=$(pm2 describe "$APP" 2>/dev/null | grep -m1 'status' | grep -oE 'online|stopped|errored|launching|stopping' | head -1)
  NOW=$(date +%s)
  FIRST=$(cat "$STATE" 2>/dev/null || echo 0)

  if [ "$STATUS" != "online" ]; then
    # stopped/errored/launching-stuck → KHÔNG gì khác có thể kéo dậy từ trong
    # app (process đã chết) → restart từ NGOÀI ngay.
    log "health=$CODE pm2=$STATUS → pm2 restart $APP"
    pm2 restart "$APP" >/dev/null 2>&1
    rm -f "$STATE" 2>/dev/null
  elif [ "$FIRST" = "0" ]; then
    # online nhưng không phản hồi — khả năng HTTP-wedge; cho in-app HTTP
    # Watchdog (Task 6-b) ~4 phút tự xử (self-exit → PM2 kéo dậy).
    echo "$NOW" > "$STATE"
    log "health=$CODE nhưng pm2=online (wedge?) — chờ in-app watchdog tới ${WEDGE_PATIENCE}s"
  elif [ $((NOW - FIRST)) -ge "$WEDGE_PATIENCE" ]; then
    # wedge kéo dài quá kiên nhẫn → can thiệp từ ngoài
    log "wedge kéo dài ≥${WEDGE_PATIENCE}s → pm2 restart $APP từ ngoài"
    pm2 restart "$APP" >/dev/null 2>&1
    rm -f "$STATE" 2>/dev/null
  fi

  sleep 30
done

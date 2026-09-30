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
#
# SMART-RESUME (fix 2026-09-30, sau sự cố preview mất 31 phút):
#   · Flag CÒN hạn nhưng pm2 != online VÀ không còn process build nào sống
#     (pgrep next.build) → lý do tạm dừng đã biến mất (chuỗi build detached
#     chết giữa chừng — thực chiến: gate 21:01 stop app + flag 45 phút, next
#     build bị OOM-kill sau 20 giây, app nằm im tới khi operator phát hiện).
#     → gỡ flag + kéo app dậy NGAY, không đợi hết hạn.
#   · Chỉ áp dụng cho flag CÓ epoch (chuỗi tự động có failsafe); flag rỗng =
#     operator bảo trì thủ công → tuyệt đối tôn trọng, không tự ý kéo app.
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
    elif [ -n "$EXPIRY" ]; then
      # SMART-RESUME: flag còn hạn — nhưng nếu app đã chết và chuỗi build đã
      # không còn process nào sống thì chờ thêm là vô nghĩa (xem header).
      PAUSE_STATUS=$(pm2 describe "$APP" 2>/dev/null | grep -m1 'status' | grep -oE 'online|stopped|errored|launching|stopping' | head -1)
      if [ "$PAUSE_STATUS" != "online" ] && ! pgrep -f 'next.build' >/dev/null 2>&1; then
        log "flag còn hạn nhưng pm2=$PAUSE_STATUS và KHÔNG còn process build sống — chuỗi build đã chết giữa chừng → gỡ flag, HỒI NHIỆM VỤ ngay"
        rm -f "$FLAG"
        pm2 restart "$APP" >/dev/null 2>&1
      fi
      sleep 30
      continue
    else
      # flag RỖNG (không epoch) = operator bảo trì thủ công — nghỉ vô hạn
      sleep 30
      continue
    fi
  fi

  # ===== CORRUPTION SELF-HEAL (fix 2026-09-30 vòng 9 — sự cố thực chiến 06:43) =====
  # package.json/.env bị ghi đè rác (vd "hacked" 7B — agent probe khi guard off)
  # → turbopack không compile nổi route nào → MỌI API 500 (18× thực chiến) →
  # restart PM2 VÔ NGHĨA vì file vẫn hỏng. Watchdog khôi phục TỰ ĐỘNG từ git
  # HEAD khi file degenerate:
  #   package.json: JSON parse FAIL   ·   .env: < 20 dòng (bình thường 600+)
  # Điều kiện KÉP (degenerate + git-modified-vs-HEAD) → file hợp lệ chỉnh có
  # chủ địch KHÔNG bao giờ bị đụng. Sau restore: Next.js dev tự "Reload env" +
  # recompile — health hồi phục không cần restart.
  if ! node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" >/dev/null 2>&1; then
    if [ -n "$(git status --porcelain -- package.json 2>/dev/null)" ]; then
      log "SELF-HEAL: package.json corrupted (JSON parse FAIL + modified vs HEAD) → git checkout -- package.json"
      git checkout -- package.json 2>/dev/null
      rm -f "$STATE" 2>/dev/null
    fi
  fi
  ENV_LINES=9999
  [ -f .env ] && ENV_LINES=$(wc -l < .env 2>/dev/null | tr -d ' ')
  if [ "$ENV_LINES" -lt 20 ] 2>/dev/null; then
    if [ -n "$(git status --porcelain -- .env 2>/dev/null)" ]; then
      log "SELF-HEAL: .env degenerate (${ENV_LINES} dòng + modified vs HEAD) → git checkout -- .env"
      git checkout -- .env 2>/dev/null
      rm -f "$STATE" 2>/dev/null
    fi
  fi

  # FIX round-11c (2026-09-30): -m 5 quá ngắn — health cold-boot turbopack
  # compile mất 5.7-8.9s thực chiến (CPU bận 90%+ khi mission resume) → curl
  # timeout = 000 → keepalive tưởng wedge → pm2 restart giết mission giữa
  # LLM call → vòng lặp tử thần (235+ restart). 20s = đầu gấp đôi worst-case.
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$URL" 2>/dev/null)

  if [ "$CODE" = "200" ]; then
    rm -f "$STATE" 2>/dev/null
    sleep 30
    continue
  fi

  # Health KHÔNG 200 — xem PM2 đang nói gì
  STATUS=$(pm2 describe "$APP" 2>/dev/null | grep -m1 'status' | grep -oE 'online|stopped|errored|launching|stopping' | head -1)
  NOW=$(date +%s)
  FIRST=$(cat "$STATE" 2>/dev/null || echo 0)

  # FIX round-11c: STATUS RỖNG (pm2 describe fail/daemon bận) hoặc 'launching'
  # (app đang boot) → KHÔNG restart — chờ tick sau kiểm tra lại. Trước đây
  # empty status rơi vào nhánh "!= online" → restart NGAY gây giết app giữa
  # pha compile (log thực chiến: "health=000 pm2= → pm2 restart" lặp nhiều
  # lần/giờ). Chỉ tin trạng thái TƯỜNG MINH dừng hẳn mới can thiệp ngay.
  if [ "$STATUS" = "stopped" ] || [ "$STATUS" = "errored" ]; then
    # stopped/errored → KHÔNG gì khác có thể kéo dậy từ trong app (process đã
    # chết) → restart từ NGOÀI ngay.
    log "health=$CODE pm2=$STATUS → pm2 restart $APP"
    pm2 restart "$APP" >/dev/null 2>&1
    rm -f "$STATE" 2>/dev/null
  elif [ -z "$STATUS" ]; then
    log "health=$CODE nhưng pm2 status KHÔNG ĐỌC ĐƯỢC (daemon bận?) — hoãn, tick sau kiểm tra lại"
  elif [ "$STATUS" = "launching" ] || [ "$STATUS" = "stopping" ]; then
    log "health=$CODE pm2=$STATUS (đang khởi động/dừng) — chờ, không can thiệp"
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

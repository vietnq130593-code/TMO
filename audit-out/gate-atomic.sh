#!/usr/bin/env bash
# =============================================================================
# GATE-ATOMIC — chạy run-gate.sh với app tạm dừng, LUÔN hồi phục app + gỡ flag
# =============================================================================
# Sự cố thực chiến (2026-09-30, preview mất 31 phút): chuỗi "stop app →
# keepalive-off 45 phút → run-gate → build → restart app" được orchestrate
# BÊN NGOÀI script (lệnh rời rạc) — next build bị OOM-kill sau 20 giây, chuỗi
# kết thúc mà không ai restart app, keepalive bị flag khóa tới 21:46 → UI chết
# hoàn toàn tới khi operator phát hiện thủ công.
#
# Nguyên tắc của wrapper này: mọi tạm dừng PHẢI đi kèm trap hồi phục — exit
# code bất kỳ (0, lỗi gate, OOM build, Ctrl-C, SIGTERM) đều đưa app về trạng
# thái ban đầu. Kết hợp với SMART-RESUME của tmo-keepalive.sh (flag còn hạn
# nhưng app chết + không còn build process → tự hồi phục), app không bao giờ
# bị bỏ mặc quá ~60 giây sau khi build chết.
#
# Cách dùng:
#   bash audit-out/gate-atomic.sh              # gate đầy đủ (stop app nếu đang chạy)
#   bash audit-out/gate-atomic.sh --reuse-build # mọi stage trừ next build
#   bash audit-out/gate-atomic.sh --no-validate # bỏ validator
#
# Lưu ý: nếu app ĐANG CHẠY khi wrapper bắt đầu, nó sẽ bị stop (giải phóng RAM
# cho next build trên host 4GB không swap) và được KHÔI PHỤC khi wrapper thoát.
# Nếu app đã stopped từ trước, wrapper giữ nguyên trạng thái stopped (không
# tự ý kéo dậy thứ mình không stop).
# =============================================================================
set -u
cd "$(dirname "$0")/.." || exit 1  # repo root

APP="theopusflashlite"
FLAG="$PWD/.keepalive-off"
PAUSE_MINUTES=45

log() { echo "[gate-atomic] $(date -u '+%F %T') UTC — $*"; }

pm2_app_status() {
  pm2 describe "$APP" 2>/dev/null | grep -m1 'status' | grep -oE 'online|stopped|errored|launching|stopping' | head -1
}

APP_WAS_ONLINE=0
RESTORE_DONE=0

restore() {
  [ "$RESTORE_DONE" -eq 1 ] && return 0
  RESTORE_DONE=1
  rm -f "$FLAG"
  if [ "$APP_WAS_ONLINE" -eq 1 ]; then
    log "hồi phục: gỡ flag + pm2 restart $APP"
    pm2 restart "$APP" >/dev/null 2>&1
  else
    log "hồi phục: gỡ flag (app vốn stopped trước đó — giữ nguyên)"
  fi
}
trap restore EXIT INT TERM

# --- 1. Ghi nhận trạng thái ban đầu ------------------------------------------
STATUS_BEFORE=$(pm2_app_status)
if [ "$STATUS_BEFORE" = "online" ]; then
  APP_WAS_ONLINE=1
  log "app đang online → tạm dừng cho gate (RAM cho build), flag ${PAUSE_MINUTES} phút"
  date -u -d "+${PAUSE_MINUTES} minutes" +%s > "$FLAG"
  pm2 stop "$APP" >/dev/null 2>&1
  sleep 2
else
  log "app đã không online (status=${STATUS_BEFORE:-unknown}) — không cần dừng"
fi

# --- 2. Chạy gate (exit code bất kỳ đều đi qua trap restore) ------------------
log "chạy: bash audit-out/run-gate.sh $*"
bash audit-out/run-gate.sh "$@"
GATE_EXIT=$?
log "run-gate.sh thoát với $GATE_EXIT"

# --- 3. restore() chạy qua trap EXIT -----------------------------------------
exit "$GATE_EXIT"

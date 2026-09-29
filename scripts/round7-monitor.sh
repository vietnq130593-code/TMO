#!/usr/bin/env bash
# =============================================================================
# round7-monitor.sh — ROUND 7 OBSERVATION SNAPSHOT (2026-09-29)
# =============================================================================
# Mục tiêu vòng 7: "agents làm việc hiệu quả hơn, kết quả thực tế tốt hơn".
# Script chụp 1 snapshot bằng chứng cho 10 tiêu chí quan sát vòng 7 (mỗi tiêu
# chí map 1 cơ chế fix đã deploy trong commits 1ad7503 / c0ff3b2 / 5779ce0):
#
#   #1 Delegation rate      — kỳ vọng TĂNG khỏi baseline 0.29% (fix reinforcement
#                             loop c0ff3b2) — đo qua ToolMetric window API
#   #2 Trọng tài CHƯA ĐẠT   — kỳ vọng GIẢM khỏi 71% (grace + evidence đầy)
#   #3 Todo reconcile       — dòng [GoalLoop] ... RECONCILE (cơ chế mới F2 —
#                             cảnh báo todo kẹt ≥2 chu kỳ phải xuất hiện khi có
#                             drift, và GIẢM dần qua các chu kỳ)
#   #4 Read:work ratio      — mục tiêu ≤3:1 (baseline lịch sử 7:1; snapshot
#                             2026-09-29 24h: 1.96:1)
#   #5 Token efficiency     — [ZEN] log có split prompt/completion — prompt
#                             tokens/vòng mục tiêu giảm 25-45% (54.6k baseline)
#   #6 Memory RSS           — restart counter pm2 + RSS: kỳ vọng ngừng mọc đều
#                             theo nhịp 1GB (fix S1 process-manager reap)
#   #7 Reasoning starvation — EMPTY RESPONSE → retry effort→high phải hồi phục
#                             (không còn chu kỳ chết vì 0-content)
#   #8 Starvation preemption— event session_mutex_starvation chỉ cảnh báo khi
#                             blocked ≥10 phút (không còn 3.258 dòng spam)
#   #9 SHR mirror           — dòng "SHR mirror" xuất hiện khi spawn CLI ghi
#                             hypothesis (hết lặp nguyên văn 4×)
#  #10 Read-repeat nudge    — dòng "ĐỌC LẶP" (nhắc dùng kết quả transcript thay
#                             vì đọc lại — mức đọc lặp phải giảm dần)
#
# Cách dùng:
#   bash scripts/round7-monitor.sh              # snapshot tức thời
#   bash scripts/round7-monitor.sh --watch 60   # lặp mỗi 60s (Ctrl-C dừng)
# =============================================================================
set -u

DEV_LOG="${TMO_DEV_LOG:-/home/z/my-project/dev.log}"
SINCE_MIN="${1:-}"
WATCH=0
[ "${1:-}" = "--watch" ] && { WATCH=1; SINCE_MIN="${2:-60}"; }
SINCE_MIN="${SINCE_MIN:-120}"
SINCE_HUMAN="${SINCE_MIN} phút"

# log-grep helper: đếm pattern trong N phút cuối của dev.log
lg() { tail -n 40000 "$DEV_LOG" 2>/dev/null | rg -c "$1" 2>/dev/null || echo 0; }

snapshot() {
  echo "====================================================================="
  echo "ROUND-7 OBSERVATION SNAPSHOT — $(date -u '+%Y-%m-%d %H:%M:%SZ')"
  echo "Cửa sổ log: ~${SINCE_HUMAN} (40k dòng cuối) · host: $(hostname)"
  echo "====================================================================="

  # --- PM2 / memory (#6) ---
  echo ""
  echo "── #6 MEMORY / PM2 ──"
  pm2 jlist 2>/dev/null | python3 -c "
import json,sys
try:
  procs = json.load(sys.stdin)
  for p in procs:
    if p['name'] == 'theopusflashlite':
      m = p.get('monit', {})
      print(f\"restarts={p.get('pm2_env',{}).get('restart_time','?')} uptime_since={p.get('pm2_env',{}).get('pm_uptime', 0)} rss={m.get('memory',0)//1024//1024}MB cpu={m.get('cpu',0)}%\")
except Exception as e:
  print('pm2-jlist-error:', e)
" 2>/dev/null || echo "(pm2 jlist lỗi)"
  free -m 2>/dev/null | rg "Mem:" || true

  # --- ToolMetric window (#1 #4) ---
  echo ""
  echo "── #1 DELEGATION + #4 READ:WORK (ToolMetric 24h window) ──"
  curl -s --max-time 15 "http://localhost:3000/api/tools/analytics?window=24h" | python3 -c "
import json,sys
try:
  d = json.load(sys.stdin)
  c, p = d['current'], d['previous']
  def cat(w, name): return next((x for x in w['byCategory'] if x['category'] == name), {'calls':0,'share':0})
  dl, tot = cat(c,'delegate')['calls'], c['totalCalls']
  dl_p, tot_p = cat(p,'delegate')['calls'], p['totalCalls']
  print(f\"total: {tot} (kỳ trước {tot_p})\")
  print(f\"delegate: {dl} calls = {round(100*dl/tot,2) if tot else 0}% (kỳ trước {dl_p}/{tot_p} = {round(100*dl_p/tot_p,2) if tot_p else 0}%)\")
  print(f\"read:work ratio: {c['balance']['readToWorkRatio']}:1 (kỳ trước {p['balance']['readToWorkRatio']}:1) — mục tiêu ≤3:1\")
  for x in c['byCategory'][:7]:
    print(f\"  {x['label']:14} {x['calls']:>6} calls ({round(x['share']*100,1)}%)\")
except Exception as e:
  print('window-api-error:', e)
" 2>/dev/null || echo "(window API lỗi)"

  # --- Log markers (#2 #3 #5 #7 #8 #9 #10) ---
  echo ""
  echo "── LOG MARKERS (đếm trong 40k dòng cuối dev.log) ──"
  echo "#2  Trọng tài CHƯA ĐẠT:    $(lg 'CHƯA ĐẠT') (kỳ vọng: tỉ lệ giảm khỏi 71%)"
  echo "#2  Trọng tài ĐẠT:        $(lg 'ĐẠT 9[0-9]%|verdict.*ĐẠT')"
  echo "#3  Todo RECONCILE:       $(lg 'RECONCILE') (cơ chế mới — >0 khi có drift)"
  echo "#3  Todo kẹt cảnh báo:    $(lg 'todo in_progress kẹt')"
  echo "#5  [ZEN] split tokens:   $(lg 'tokens \(prompt:')" 
  echo "#7  EMPTY RESPONSE:       $(lg 'EMPTY RESPONSE') (mỗi cái phải có dòng retry kế)"
  echo "#7  Starvation retry:     $(lg 'reasoning starvation — 0 content')"
  echo "#8  Mutex starvation:     $(lg 'session_mutex_starvation|bị chờ mutex')"
  echo "#9  SHR mirror:           $(lg 'SHR mirror')"
  echo "#10 ĐỌC LẶP nudge:        $(lg 'ĐỌC LẶP')"
  echo "    Sub-agent launches:   $(lg 'Sub-agent launch|launching sub-agent')"
  echo "    OC-CLI spawn:         $(lg '\[OC-CLI\]')"
  echo ""
  echo "Ghi chú: #5 cần So sánh prompt tokens [ZEN] trung bình/vòng với baseline"
  echo "54.6k (Task B). Đánh giá #1/#2 cần ≥1 mission thật chạy trong cửa sổ."
  echo "====================================================================="
}

if [ "$WATCH" = "1" ]; then
  while true; do
    clear 2>/dev/null || true
    snapshot
    echo "(--watch: làm mới sau 60s — Ctrl-C để dừng)"
    sleep 60
  done
else
  snapshot
fi

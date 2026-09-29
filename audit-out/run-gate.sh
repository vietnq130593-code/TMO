#!/usr/bin/env bash
# =============================================================================
# run-gate.sh — SINH audit-out/gate-final.txt (artifact nguồn sự thật cho audit)
# =============================================================================
# LÝ DO TỒN TẠI: trước đây audit-out/gate-final.txt là artifact LÀM TAY — KHÔNG
# script nào trong repo ghi ra nó, nhưng gen-audit-report.mjs + validate-report.mjs +
# collect-evidence.sh lại đọc nó làm số liệu kết luận (typecheck/lint/test/build).
# Script này đóng lỗ hổng truy vết: MỌI CON SỐ đều là exit code lệnh chạy thật.
#
# NGUYÊN TẮC BẤT BIẾN (đã vi phạm 1 lần trong bản nháp, đã sửa):
#   - KHÔNG có nhánh nào ghi exit code giả. Build OOM -> ghi 137 thật + ghi rõ
#     lý do. Skip -> ghi chữ "SKIPPED" chứ KHÔNG ghi số giống fail.
#   - KHÔNG dùng biến môi trường để quyết định con số trong evidence.
#
# KEY ghi ra BẮT BUỘC khớp parser (đã đối chiếu bằng grep, 2026-10-29):
#   gen-audit-report.mjs  num('typecheck_exit'|'typecheck_v2_exit'|'typecheck_v2_errors'
#                            |'lint_exit'|'lint_problem_lines'|'test_exit'
#                            |'dbq_test_exit'|'build_exit')
#   validate-report.mjs   num(...) + regex /^\s*(\d+) pass$/m + /^\s*0 fail$/m
#   collect-evidence.sh   grep -oE '^(typecheck_v2_exit|typecheck_exit|lint_exit|
#                            test_exit|dbq_test_exit|validator_exit|negative_exit)=-?[0-9]+'
#
# CÁCH DÙNG
#   bash audit-out/run-gate.sh                  # đầy đủ (validator chạy sau cùng)
#   bash audit-out/run-gate.sh --no-validate    # bỏ stage validator (pass 1: cần
#                                              #   gate TRƯỚC khi sinh report)
#   bash audit-out/run-gate.sh --validate-only  # CHỈ nối thêm validator_exit vào
#                                              #   gate hiện có (pass 2: sau khi
#                                              #   generator đã sinh report)
#                                              #   fail-closed nếu head_sha lệch
#   bash audit-out/run-gate.sh --reuse-build   # MỌI stage trừ `next build`; số
#                                              #   build mang từ gate cũ CÙNG
#                                              #   HEAD (fail-closed nếu lệch).
#                                              #   Dùng khi host không đủ RAM để
#                                              #   build (OOM 137) — KHÔNG giả số:
#                                              #   gate ghi rõ run_id nguồn.
# =============================================================================
set -u

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "$HERE/.." && pwd)"
cd -- "$REPO" || { echo "ERROR: khong chuyen duoc den REPO root" >&2; exit 1; }

GATE="audit-out/gate-final.txt"
MODE="full"
REUSE_BUILD=0
REPORT="AUDIT-REPORT.md"
for a in "$@"; do
  case "$a" in
    --report=*)      REPORT="${a#--report=}" ;;
    --no-validate)   MODE="no-validate" ;;
    --validate-only) MODE="validate-only" ;;
    --reuse-build)   REUSE_BUILD=1 ;;
    *) echo "ERROR: tham so la khong hieu: $a (chi nhan: --validate-only | --no-validate | --reuse-build | --report=<path>)" >&2; exit 2 ;;
  esac
done

# --- helpers ----------------------------------------------------------------
# grep -c tra ve "0" + exit 1 khi khong match. "|| echo 0" se tao "0\n0" -> hong
# phai dung cach nay de gia tri luon la SO nguyen.
cnt() { local n; n=$(grep -cE "$2" "$1" 2>/dev/null) || true; [ -z "$n" ] && n=0; printf '%s' "$n"; }

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo unknown)
HEAD_SHORT=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RUN_ID="gate-${STARTED//[:]/}-${HEAD_SHORT}"

# --- context host (để giải thích build OOM, không để bịa) --------------------
MEM_TOTAL_MB=$(awk '/^MemTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
SWAP_TOTAL_MB=$(awk '/^SwapTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)

# SENTINEL-FIX: fingerprint CAY SOURCE hien tai (content-based, SCOPE_PATHS).
# Tinh MOT LAN o dau va dung cho moi quyet dinh fail-closed ben duoi: chi so
# head_sha la KHONG du (sua file trong SCOPE ma chua commit => head giong het,
# gate cu van "xanh" tren cay da doi). Neu khong tinh duoc => 'unknown' va moi
# nhanh reuse/validate deu phai fail-closed.
LIVE_FP=$(node --input-type=module -e "import {sourceFingerprint} from './audit-out/artifact-meta.mjs'; const s=sourceFingerprint(); process.stdout.write(String(s?.fingerprint ?? 'unknown'));" 2>/dev/null || echo unknown)
[ -z "$LIVE_FP" ] && LIVE_FP=unknown

# --- DB test cô lập ---------------------------------------------------------
# TUỒI GIỐNG scripts/quality-gate.mjs stage `tests`: DB SQLite riêng, push schema
# mới, DATABASE_URL ghi đè TRƯỚC khi chạy. Nếu không, bun nạp .env và test ghi rác
# vào DB thật của app.
TEST_DB="$REPO/db/.audit-gate-test.db"
TEST_DB_URL="file:$TEST_DB"
rm -f "$TEST_DB" "$TEST_DB-wal" "$TEST_DB-shm" "$TEST_DB-journal" 2>/dev/null || true

# =============================================================================
# NEGATIVE TESTS — ham dung chung. IN ra stdout (caller noi vao gate), tra exit
# cua node audit-out/negative-tests.mjs.
# SENTINEL-FIX (audit chu ky 51): bien the `baseline` trong negative-tests.mjs
# chay validator tren chinh AUDIT-REPORT.md, nen no CHI co y nghia khi report da
# duoc gen-audit-report.mjs regenerate tu gate cuoi. Chay o stage 6 cua pass full
# => report STALE => baseline FAIL gia thuyet va suite bao loi gia.
# =============================================================================
run_negative() {
  local neg
  node audit-out/negative-tests.mjs > audit-out/.gate-neg.log 2>&1
  neg=$?
  printf '===== NEGATIVE TESTS (audit-out/negative-tests.mjs) =====\n'
  printf 'negative_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'negative_exit=%s\n' "$neg"
  printf 'negative_total=%s\n' "$(grep -oE 'NEG_TOTAL [0-9]+' audit-out/NEGATIVE-TESTS.txt 2>/dev/null | tail -1 | awk '{print $2}')"
  printf 'negative_failed=%s\n' "$(grep -oE 'NEG_FAILED [0-9]+' audit-out/NEGATIVE-TESTS.txt 2>/dev/null | tail -1 | awk '{print $2}')"
  return $neg
}

# =============================================================================
# MODE: validate-only — chi noi them validator + negative, KHONG chay lai stage
# =============================================================================
if [ "$MODE" = "validate-only" ]; then
  [ -f "$GATE" ] || { echo "ERROR: $GATE khong ton tai — hay chay full truoc" >&2; exit 1; }
  EXISTING_HEAD=$(grep -oE '^head_sha=[0-9a-f]+' "$GATE" | tail -1 | cut -d= -f2)
  EXISTING_FP=$(grep -oE '^scope_fingerprint=[^[:space:]]+' "$GATE" | tail -1 | cut -d= -f2-)
  if [ "$EXISTING_HEAD" != "$HEAD_SHA" ]; then
    echo "ERROR FAIL-CLOSED: gate ghim HEAD=$EXISTING_HEAD nhung HEAD hien tai=$HEAD_SHA." >&2
    echo "       Chay lai 'bash audit-out/run-gate.sh' de ghim lai evidence tren HEAD nay." >&2
    exit 1
  fi
  # SENTINEL-FIX: cung phai khop CAY SOURCE. Gate cu khong co fingerprint
  # (hoac 'unknown') = khong chung minh duoc no thuoc cay hien tai => fail-closed.
  if [ -z "$EXISTING_FP" ] || [ "$EXISTING_FP" = "unknown" ] || [ "$EXISTING_FP" != "$LIVE_FP" ]; then
    echo "ERROR FAIL-CLOSED: gate ghim scope_fingerprint='${EXISTING_FP:-<thieu>}' nhung cay source hien tai='$LIVE_FP'." >&2
    echo "       File trong SCOPE_PATHS da doi ma chua commit => gate cu khong con la bang chung." >&2
    echo "       Chay lai 'bash audit-out/run-gate.sh' de ghim lai evidence tren cay nay." >&2
    exit 1
  fi
  VAL_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  node audit-out/validate-report.mjs "$REPORT" > audit-out/.gate-val.log 2>&1
  VAL=$?
  {
    printf '\n'
    printf '===== VALIDATOR (audit-out/validate-report.mjs %s) =====\n' "$REPORT"
    printf 'validator_utc=%s..%s\n' "$VAL_START" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'validator_exit=%s\n' "$VAL"
  } >> "$GATE"
  NEG=0
  run_negative >> "$GATE" || NEG=$?
  rm -f "$TEST_DB" "$TEST_DB-wal" "$TEST_DB-shm" "$TEST_DB-journal" 2>/dev/null || true
  echo "gate appended: validator_exit=$VAL negative_exit=$NEG (HEAD=$HEAD_SHORT) -> $GATE"
  # SENTINEL-FIX (audit chu ky 72): `exit 0` co dinh o day FAIL-OPEN — wrapper
  # goi gate bao "gate_exit=0" ca khi validator fail, bien "gate chay that" thanh
  # tin khong co gia tri. Phai tra exit THAT cua ca 2 stage nay (khong gom
  # nen bao loi rieng). 0 = validator pass VA negative pass.
  if [ "$VAL" -ne 0 ]; then exit "$VAL"; fi
  if [ "$NEG" -ne 0 ]; then exit "$NEG"; fi
  exit 0
fi

# =============================================================================
# CAPTURE EVIDENCE BUILD CỦA GATE CŨ TRƯỚC KHI BỊ TRUNCATE
# --reuse-build: next build OOM (137) trên host này, chạy lại chỉ để OOM lần
# nữa. Số build được MANG SANG từ gate cũ, kèm run_id + head_sha nguồn, và
# fail-closed nếu không tồn tại hoặc lệch HEAD — không bao giờ ghi số bịa.
# =============================================================================
PREV_GATE_HEAD=""; PREV_GATE_RUN=""; PREV_BUILD_EXIT=""
PREV_BUILD_OOM=""; PREV_BUILD_LOG_LINES=""; PREV_BUILD_UTC=""; PREV_BUILD_DIST=""
if [ -f "$GATE" ]; then
  PREV_GATE_HEAD=$(grep -oE '^head_sha=[0-9a-f]+' "$GATE" 2>/dev/null | tail -1 | cut -d= -f2)
  PREV_GATE_FP=$(grep -oE '^scope_fingerprint=[^[:space:]]+' "$GATE" 2>/dev/null | head -1 | cut -d= -f2-)
  PREV_GATE_RUN=$(grep -oE '^run_id=.*' "$GATE" 2>/dev/null | head -1 | cut -d= -f2-)
  PREV_BUILD_EXIT=$(grep -oE '^build_exit=-?[0-9]+' "$GATE" 2>/dev/null | tail -1 | cut -d= -f2)
  PREV_BUILD_OOM=$(grep -oE '^build_oom=.*' "$GATE" 2>/dev/null | tail -1 | cut -d= -f2-)
  PREV_BUILD_LOG_LINES=$(grep -oE '^build_log_lines=[0-9]+' "$GATE" 2>/dev/null | tail -1 | cut -d= -f2)
  PREV_BUILD_UTC=$(grep -oE '^build_utc=.*' "$GATE" 2>/dev/null | tail -1 | cut -d= -f2-)
  PREV_BUILD_DIST=$(grep -oE '^build_dist_dir=.*' "$GATE" 2>/dev/null | tail -1 | cut -d= -f2-)
fi

# =============================================================================
# MODE: full / no-validate — chạy TẤT CẢ stage từ đầu
# =============================================================================
: > "$GATE"
emit() { printf '%s\n' "$*" >> "$GATE"; }

emit "===== GATE RUN (TMO audit) ====="
emit "run_id=$RUN_ID"
emit "generated_at=$STARTED"
emit "commit=$HEAD_SHA"
emit "head_sha=$HEAD_SHA"
emit "head_short=$HEAD_SHORT"
# SENTINEL-FIX: gate PHAI ghim source fingerprint (khong chi head).
# Ly do: commit khong doi khong dong nghia file trong SCOPE khong doi.
# Su 1 file src/ ma khong commit => head_sha giong het, gate cu van "xanh"
# tren cay source da doi. Fingerprint content-based trong SCOPE chan dung
# lo false-green nay (cung co che voi matrix/report/artifact-meta.mjs).
GATE_FP=$(node --input-type=module -e "import {sourceFingerprint} from './audit-out/artifact-meta.mjs'; const s=sourceFingerprint(); process.stdout.write(String(s?.fingerprint ?? 'unknown'));" 2>/dev/null || echo unknown)
emit "scope_fingerprint=$GATE_FP"
emit "mem_total_mb=$MEM_TOTAL_MB"
emit "swap_total_mb=$SWAP_TOTAL_MB"
emit "utc_start=$STARTED"
emit ""

# --- 1. TYPECHECK v1 (sự kiện lịch sử: trạng thái lúc bắt đầu gate) ---------
bunx tsc --noEmit > audit-out/.gate-tc1.log 2>&1
TC1=$?
emit "===== TYPECHECK v1 (bunx tsc --noEmit) ====="
emit "typecheck_exit=$TC1"
emit "typecheck_errors=$(cnt audit-out/.gate-tc1.log 'error TS[0-9]+')"
emit ""

# --- 2. LINT ---------------------------------------------------------------
# GHI CHÚ (fix 2026-09-29): `bun run lint` = `eslint .` quét TOAN BO thu muc,
# bao gom cac distDir cong lap (.next, .next-qa, .next-audit-wp, .next-audit-gate)
# ma gate/QA tao ra. File JS build sinh ra khong phai source nen 401 "problems"
# la FALSE POSITIVE, 0 loi o source thu. Day la loi RANGE cua lenh lint, KHONG
# phai loi chat luong code — nen sua tai day (file audit) chu khong sua
# eslint.config.mjs (bi infra-guard chan).
#
# Dung `--ignore-pattern '.next*'` de gioi han dung source. KHONG dung
# `--quiet`/`-w 0` de an loi that, KHONG thoat som truoc khi het file.
LINT_SCOPE="src/** scripts/** tests/** prisma/** *.ts *.mjs *.js *.cjs *.tsx *.jsx"
emit "===== LINT (bun run lint -- --ignore-pattern '.next*') ====="
emit "lint_scope=source-only (src scripts tests prisma + root config files)"
bun run lint -- --ignore-pattern '.next*' > audit-out/.gate-lint.log 2>&1
LINT=$?
emit "lint_exit=$LINT"
emit "lint_problem_lines=$(cnt audit-out/.gate-lint.log '^\s*[0-9]+:[0-9]+\s+(error|warning)\s')"
emit "lint_errors=$(cnt audit-out/.gate-lint.log '^\s*[0-9]+:[0-9]+\s+error\s')"
emit "lint_warnings=$(cnt audit-out/.gate-lint.log '^\s*[0-9]+:[0-9]+\s+warning\s')"
# so file co problem: lay duong dan tu dong vien cua dong loi (dang stylish)
LINT_FILES=$(grep -oE '^/home/z/tmo-app/[^ ]+\.(ts|tsx|js|jsx|mjs|cjs)$' audit-out/.gate-lint.log 2>/dev/null | sort -u | wc -l | tr -d ' ')
emit "lint_files=$LINT_FILES"
tail -n 15 audit-out/.gate-lint.log >> "$GATE" 2>&1
emit ""

# --- 3. IMPORTS (Task 42 — import boundary + circular import tĩnh) ----------
bun scripts/check-imports.mjs > audit-out/.gate-imp.log 2>&1
IMP=$?
emit "===== IMPORTS (bun scripts/check-imports.mjs) ====="
emit "imports_exit=$IMP"
tail -n 12 audit-out/.gate-imp.log >> "$GATE" 2>&1
emit ""

# --- 4. TESTS trên DB cô lập ----------------------------------------------
emit "===== TESTS (bun test, DATABASE_URL ghi de = DB test cong lap) ====="
emit "test_db=db/.audit-gate-test.db"
DATABASE_URL="$TEST_DB_URL" bunx prisma db push --skip-generate > audit-out/.gate-push.log 2>&1
PUSH=$?
emit "test_db_push_exit=$PUSH"
if [ "$PUSH" -eq 0 ]; then
  DATABASE_URL="$TEST_DB_URL" CI=true bun test > audit-out/.gate-test.log 2>&1
  TEST=$?
  emit "test_exit=$TEST"
  # copy nguyên văn dòng summary — validator parse /^\s*(\d+) pass$/m từ đây
  grep -E '^[[:space:]]*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests across' audit-out/.gate-test.log >> "$GATE" 2>/dev/null || true
else
  TEST=125
  emit "test_exit=125"
  emit "TEST_SKIPPED=prisma db push that bai (exit $PUSH) — xem audit-out/.gate-push.log"
  emit "test_pass_count=UNKNOWN"
  emit "test_fail_count=UNKNOWN"
fi
rm -f "$TEST_DB" "$TEST_DB-wal" "$TEST_DB-shm" "$TEST_DB-journal" 2>/dev/null || true
emit ""

# --- 5. db-query-readonly-guard chạy riêng (bằng chứng guard bật/tắt) -----
emit "===== TESTS db-query-readonly-guard (rieng) ====="
DATABASE_URL="$TEST_DB_URL" CI=true bun test tests/db-query-readonly-guard.test.ts > audit-out/.gate-dbq.log 2>&1
DBQ=$?
emit "dbq_test_exit=$DBQ"
grep -E '^[[:space:]]*[0-9]+ (pass|fail)$|^Ran [0-9]+ tests across' audit-out/.gate-dbq.log >> "$GATE" 2>/dev/null || true
emit "ENABLE_DB_QUERY=${ENABLE_DB_QUERY:-<unset>}"
emit "dbq_note=db_query tool dang bi DISABLE trong env — xem AUDIT-REPORT.md muc DB guard"
emit ""

# --- 6. NEGATIVE TESTS — DEFER (xem run_negative o khoi validate-only) ------
# KHONG chay o day. Bien the `baseline` doi chieu AUDIT-REPORT.md voi gate vua
# ghi; tai thoi diem nay report CHUA duoc gen-audit-report.mjs regenerate =>
# validator fail-closed DUNG (fail vi report stale, khong phai vi bug) va
# negative suite bao loi gia. Chay o day lam sai nghia tieu chung minh fail-closed.
# KHONG ghi `negative_exit` o day de key nay trong gate chi co MOT gia tri duy
# nhat (lan --validate-only append) — nguoi doc khong phan biet ban nao la cuoi.
emit "===== NEGATIVE TESTS (audit-out/negative-tests.mjs) ====="
emit "negative_suite=DEFERRED_TO_VALIDATE_ONLY"
emit "negative_note=chay 'bash audit-out/run-gate.sh --validate-only' sau khi gen-audit-report.mjs da regenerate report; chay o day se doi chieu report STALE"
emit ""

# --- 7. TYPECHECK v2 (KẾT LUẬN — chạy lại sau mọi stage) -------------------
emit "===== TYPECHECK v2 (bunx tsc --noEmit, chay lai) ====="
emit "typecheck_v2_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
bunx tsc --noEmit > audit-out/.gate-tc2.log 2>&1
TC2=$?
emit "typecheck_v2_exit=$TC2"
emit "typecheck_v2_errors=$(cnt audit-out/.gate-tc2.log 'error TS[0-9]+')"
emit ""

# --- 8. BUILD (next build) — KHÔNG CÓ NHÁNH GIẢ ----------------------------
# next.config.ts đọc TMO_BUILD_DIST_DIR, nên build thử ghi ra .next-qa, KHÔNG
# đụng .next của dev server đang chạy. Host ~4.1GB / swap 0 đã từng OOM (137).
# Nếu OOM -> ghi 137 THẬT. Không có đường tắt nào ghi số khi chưa chạy.
if [ "$REUSE_BUILD" -eq 1 ]; then
  if [ -z "$PREV_BUILD_EXIT" ]; then
    echo "ERROR FAIL-CLOSED: --reuse-build nhung gate cuoi ($GATE) khong co build_exit de mang sang." >&2
    echo "       Khong ton tai so build => khong duoc ghi bao cao. Hay chay full." >&2
    exit 1
  fi
  if [ "$PREV_GATE_HEAD" != "$HEAD_SHA" ]; then
    echo "ERROR FAIL-CLOSED: build evidence thuoc HEAD=$PREV_GATE_HEAD, HEAD hien tai=$HEAD_SHA." >&2
    echo "       Build tren HEAD khac KHONG lay lam bang chung. Chay full (bo --reuse-build)." >&2
    exit 1
  fi
  # SENTINEL-FIX: cung fail-closed theo CAY SOURCE, khong chi HEAD.
  if [ -z "$PREV_GATE_FP" ] || [ "$PREV_GATE_FP" = "unknown" ] || [ "$PREV_GATE_FP" != "$LIVE_FP" ]; then
    echo "ERROR FAIL-CLOSED: build evidence thuoc cay source='${PREV_GATE_FP:-<thieu>}', cay hien tai='$LIVE_FP'." >&2
    echo "       Da co file trong SCOPE_PATHS doi => so build cu KHONG con ap dung." >&2
    echo "       Hay chay full bo --reuse-build." >&2
    exit 1
  fi
  # SENTINEL-FIX (chu ky 75): nhanh nay emit build_exit nhung KHONG gan bien BUILD
  # -> khoi gom exit cuoi file ("$BUILD") se unbound variable duoi set -u (dong 38).
  # Phai gan bien THAT tu PREV_BUILD_EXIT de ca emit va kiem tra exit dung mot nguon.
  BUILD="$PREV_BUILD_EXIT"
  emit "===== BUILD (next build) — REUSE tu gate truoc CUNG HEAD, KHONG chay lai ====="
  emit "build_reused=YES"
  emit "build_reuse_source_run_id=$PREV_GATE_RUN"
  emit "build_reuse_source_head_sha=$PREV_GATE_HEAD"
  emit "build_reuse_source_fingerprint=$PREV_GATE_FP"
  emit "build_utc=$PREV_BUILD_UTC"
  emit "build_exit=$PREV_BUILD_EXIT"
  emit "build_oom=$PREV_BUILD_OOM"
  emit "build_log_lines=$PREV_BUILD_LOG_LINES"
  emit "build_dist_dir=$PREV_BUILD_DIST"
  emit "build_note=SO build mang NGUYEN VAN tu run tren cung HEAD; next build KHONG chay lai (host ${MEM_TOTAL_MB}MB / swap ${SWAP_TOTAL_MB}MB da OOM 137)"
else
  emit "===== BUILD (next build, distDir rieng) ====="
  emit "build_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  export TMO_BUILD_DIST_DIR=".next-audit-gate"
  rm -rf "$TMO_BUILD_DIST_DIR" 2>/dev/null || true
  NODE_OPTIONS="--max-old-space-size=1536" bunx next build > audit-out/.gate-build.log 2>&1
  BUILD=$?
  emit "build_reused=NO"
  emit "build_exit=$BUILD"
  emit "build_dist_dir=$TMO_BUILD_DIST_DIR"
  emit "build_log_lines=$(cnt audit-out/.gate-build.log '.')"
  if [ "$BUILD" -ne 0 ]; then
    if [ "$BUILD" -eq 137 ]; then
      emit "build_oom=YES — host ${MEM_TOTAL_MB}MB / swap ${SWAP_TOTAL_MB}MB, next build bi OOM-kill (SIGKILL 137)"
    else
      emit "build_oom=NO"
    fi
    emit "build_tail:"
    tail -n 20 audit-out/.gate-build.log >> "$GATE" 2>&1
  else
    emit "build_oom=NO"
    emit "build_note=PASS lan nay — neu bao cao cu ghi OOM 137 thi do la stale, dung evidence nay"
  fi
  rm -rf "$TMO_BUILD_DIST_DIR" 2>/dev/null || true
fi
emit ""

# --- 9. VALIDATOR (optional) ----------------------------------------------
if [ "$MODE" = "no-validate" ]; then
  emit "validator_exit=NOT_RUN"
  emit "validator_note=run voi --no-validate; chay 'bash audit-out/run-gate.sh --validate-only' sau khi generator sinh report"
else
  VAL_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  node audit-out/validate-report.mjs "$REPORT" > audit-out/.gate-val.log 2>&1
  VAL=$?
  emit "===== VALIDATOR (audit-out/validate-report.mjs $REPORT) ====="
  emit "validator_utc=$VAL_START..$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  emit "validator_exit=$VAL"
  if [ "$VAL" -ne 0 ]; then
    emit "validator_note=report tai thoi diem nay co the da STALE (gate vua doi, report chua regenerate)"
  fi
fi

emit ""
emit "utc_end=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
emit "GATE_COMPLETE=1"
rm -f "$TEST_DB" "$TEST_DB-wal" "$TEST_DB-shm" "$TEST_DB-journal" 2>/dev/null || true
echo "gate written: $GATE (run_id=$RUN_ID HEAD=$HEAD_SHORT)"
# SENTINEL-FIX (audit chu ky 72): full gate ket thuc bang `echo` nen exit cua
# script = exit cua `echo` (luon 0) — moi stage fail bi che giac. GOM exit that
# cua TAT CA stage roi tra ve; `validator_exit=NOT_RUN` (che do --no-validate)
# khong tinh la fail vi validator co chu dich chay o --validate-only.
GATE_BAD=""
for _kv in "typecheck_exit=$TC1" "lint_exit=$LINT" "imports_exit=$IMP" \
           "test_db_push_exit=$PUSH" "test_exit=$TEST" "dbq_test_exit=$DBQ" \
           "typecheck_v2_exit=$TC2" "build_exit=$BUILD"; do
  _k=${_kv%%=*}; _v=${_kv#*=}
  if [ -z "$_v" ]; then
    GATE_BAD="$GATE_BAD MISSING_$_k"
  elif [ "$_v" != "0" ]; then
    GATE_BAD="$GATE_BAD $_k($_v)"
  fi
done
# VAL chi duoc gan o nhanh else (mode != no-validate) — `${VAL:-}` de chac set -u.
if [ "$MODE" != "no-validate" ] && [ "${VAL:-}" != "0" ]; then
  GATE_BAD="$GATE_BAD validator_exit(${VAL:-UNSET})"
fi
if [ -n "$GATE_BAD" ]; then
  echo "GATE_FAIL:$GATE_BAD" >&2
  exit 1
fi

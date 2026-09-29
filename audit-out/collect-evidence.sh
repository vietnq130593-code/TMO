#!/usr/bin/env bash
# Gom TOAN BO bang chung may doc duoc vao mot file, khong in ra console.
# Muc tieu: trong tai / nguoi doc co the thay day du, khong bi cat.
set -u
# REPO suy ra tu vi tri script thay vi hardcode duong dan may.
# Script nay duoc git add -f tai audit-out/ (cap 1 cua repo) nen
# "$HERE/.." luon chinh la repo root tren moi may clone.
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$HERE/.." || { echo "ERROR: khong chuyen duoc den REPO root" >&2; exit 1; }
OUT=audit-out/FINAL-EVIDENCE.txt
: > "$OUT"

emit() { printf '%s\n' "$*" >> "$OUT"; }

emit "===== 0. MOI TRUONG ====="
emit "date: $(date -Is)"
emit "cwd: $(pwd)"
emit "node: $(node -v 2>&1)"
emit ""

emit "===== 1. AUDIT-REPORT.md TON TAI ====="
if [ -f AUDIT-REPORT.md ]; then
  emit "exists: yes"
  emit "bytes: $(wc -c < AUDIT-REPORT.md | tr -d ' ')"
  emit "lines: $(wc -l < AUDIT-REPORT.md | tr -d ' ')"
else
  emit "exists: NO"
fi
emit ""

emit "===== 2. 6 TIEU DE SECTION TRONG REPORT ====="
grep -n '^## ' AUDIT-REPORT.md >> "$OUT" 2>&1
emit "section_count: $(grep -c '^## ' AUDIT-REPORT.md)"
emit ""

emit "===== 3. §4 CAN DUNG 1 CAU ====="
awk '/^## §4\./{f=1;next} /^## §5\./{f=0} f' AUDIT-REPORT.md | grep -v '^[[:space:]]*$' >> "$OUT"
emit ""

emit "===== 4. KHONG PLACEHOLDER / n-a ====="
emit "TODO/TBD/FIXME/XXX count: $(grep -Ec 'TODO|TBD|FIXME|XXX' AUDIT-REPORT.md)"
emit "'n/a' count: $(grep -Eo '\bn/a\b' AUDIT-REPORT.md | wc -l | tr -d ' ')"
emit ""

emit "===== 5. MACHINE-CHECK BLOCK ====="
awk '/^```json/{f=1;next} f&&/^```/{f=0} f' AUDIT-REPORT.md | head -200 >> "$OUT"
emit ""

emit "===== 6. ARTIFACT JSON RAW (may la nguon su) ====="
for f in audit-out/e2e-matrix-unified.json audit-out/e2e-lifecycle.json audit-out/e2e-skills-lifecycle.json audit-out/reconcile-final.json audit-out/dbq-summary.json; do
  if [ -f "$f" ]; then
    emit "--- $f ($(wc -c < "$f" | tr -d ' ') bytes) ---"
    cat "$f" >> "$OUT"
    emit ""
  else
    emit "--- $f MISSING ---"
  fi
done

emit "===== 7. DB_QUERY KET LUAN (ENABLE_DB_QUERY) ====="
grep -n 'ENABLE_DB_QUERY' src/lib/feature-flags.ts >> "$OUT" 2>&1
emit ""

emit "===== 7b. KIEM THU AM (so bien the doc tu NEG_TESTS, co canh no-mutation) ====="
node audit-out/negative-tests.mjs > /dev/null 2>&1
NC=$?
emit "negative_exit: $NC (0 = moi bien the am tra exit nhu mong doi)"
if [ -f audit-out/NEGATIVE-TESTS.txt ]; then
  cat audit-out/NEGATIVE-TESTS.txt >> "$OUT"
else
  emit "NEGATIVE-TESTS.txt MISSING — can chay: node audit-out/negative-tests.mjs"
fi
emit ""

emit "===== 8. VALIDATOR CHAY THAT (fail-closed) ====="
node audit-out/validate-report.mjs AUDIT-REPORT.md > audit-out/.val.out 2>&1
VC=$?
cat audit-out/.val.out >> "$OUT"
emit "validator_exit: $VC"
emit ""

emit "===== 10. DOI CHIEU 2 DIEM TRANH TAI (machine truth) ====="
emit "--- 10a. stopReason that cua 10 run ---"
node -e "const j=require('./audit-out/reconcile-final.json');const m={};j.runs.forEach(r=>{m[String(r.stopReason)]=(m[String(r.stopReason)]||0)+1});console.log('stopReasonDistribution='+JSON.stringify(m));console.log('incompleteRuns='+JSON.stringify(j.runs.filter(r=>r.complete!==true).map(r=>({id:r.runId,complete:r.complete,stopReason:r.stopReason}))));const md=require('fs').readFileSync('AUDIT-REPORT.md','utf8');console.log('report_mentions_cancel='+((md.match(/cancel/gi)||[]).length));" >> "$OUT" 2>&1
emit ""
emit "--- 10b. con so 19/10 ---"
node -e "const j=require('./audit-out/reconcile-final.json');console.log('runsInWindow='+j.metrics.runsInWindow);console.log('agentRunToolFailuresSum='+j.metrics.agentRunToolFailuresSum);console.log('toolMetricFailureTotal='+j.metrics.toolMetricFailureTotal);const hit=[];j.runs.forEach(r=>{if(r.toolCalls===19)hit.push({id:r.runId,toolCalls:r.toolCalls,toolFailures:r.toolFailures})});console.log('runs_with_toolCalls_19='+JSON.stringify(hit));" >> "$OUT" 2>&1
emit ""
emit "--- 10c. skills artifact that ---"
node -e "const j=require('./audit-out/e2e-skills-lifecycle.json');console.log('stepsTotal='+j.stepsTotal+' stepsPassed='+j.stepsPassed+' assertions='+j.assertions+' assertionsPassed='+j.assertionsPassed+' ok='+j.ok);" >> "$OUT" 2>&1
emit ""

emit "===== 11. GATE MAY (typecheck / lint / test / build exit code that) ====="
# FAIL-CLOSED: khong con nhan STALE vo dieu kien. Trang thai gate duoc QUYET DINH bang
# timestamp that: gate phai moi hon moi file nguon lien quan, va exit phai = 0.
# Neu bat ky dieu kien nao sai -> emit STALE_VIOLATION + gate_fresh=0 (khong dua vao ket luan).
GATE=audit-out/gate-final.txt
if [ ! -f "$GATE" ]; then
  emit "gate-final.txt: file khong ton tai"
  emit "gate_fresh=0"
  emit "STALE_VIOLATION=GATE_MISSING"
  emit ""
else
  GATE_MTIME=$(date -r "$GATE" +%s 2>/dev/null || echo 0)
  # file nguon ma typecheck v2 chay tren
  SRC_NEWEST=0
  SRC_FILE="none"
  for f in src/lib/memory-tiers.ts src/lib/feature-flags.ts src/components/tools/tools-manager-dialog.tsx src/app/api/skills/route.ts; do
    if [ -f "$f" ]; then
      M=$(date -r "$f" +%s 2>/dev/null || echo 0)
      if [ "$M" -gt "$SRC_NEWEST" ]; then SRC_NEWEST=$M; SRC_FILE="$f"; fi
    fi
  done
  # SENTINEL-FIX (audit chu ky 64): gate-final.txt duoc APPEND nhieu lan (full-gate
  # moi truncate, --validate-only noi them), nen doc `tail -1` tren TOAN file co
  # FAIL-OPEN theo 2 duong, ca 2 duoc chong o day:
  #   1) doc lot SO CU cua run truoc khi run moi ghi gia tri KHONG PHAI SO
  #      (`validator_exit=NOT_RUN`, `negative_suite=DEFERRED_...`): regex cu
  #      `-?[0-9]+` bo qua cac dong do, tail -1 tra ve 0 cua run da ket thuc;
  #   2) doc nham sang block GATE RUN cu khi file da bi append nhieu lan.
  # Cach sua: cat ve BLOCK GATE RUN CUOI CUNG, va chi chap nhan gia tri LAN CUOI
  # cung xuat hien — neu khong phai SO thi tra "NONNUM(...)" de fail-closed.
  # awk exit 3 = khong co marker GATE RUN nao trong file. Truong hop nay PHAI
  # fail-closed: neu de awk quy toan file, ta se quay ve doc SO CU cua block da
  # ket thuc — dung fail-open dang can chong.
  GATE_LAST_BLOCK=$(awk '/^===== GATE RUN \(TMO audit\) =====/{buf=""; seen=1} {buf=buf $0 "\n"} END{if(!seen) exit 3; printf "%s", buf}' "$GATE") || GATE_BLOCK_MISSING=1
  if [ -z "${GATE_LAST_BLOCK//[[:space:]]/}" ] || [ -n "${GATE_BLOCK_MISSING:-}" ]; then
    GATE_BLOCK_MISSING=1
    GATE_LAST_BLOCK=""
    emit "STALE_VIOLATION=GATE_RUN_BLOCK_MISSING — gate khong co marker '===== GATE RUN (TMO audit) ====='"
  fi
  gate_last_exit() { # $1=ten khoa -> gia tri lan cuoi, hoac NONNUM(...) neu khong phai so
    local _rk="$1" _rv
    if [ -n "${GATE_BLOCK_MISSING:-}" ]; then printf 'NONNUM(GATE_RUN_BLOCK_MISSING)'; return 0; fi
    _rv=$(printf '%s\n' "$GATE_LAST_BLOCK" | grep -oE "^${_rk}=.*" 2>/dev/null | tail -1 | cut -d= -f2-)
    case "$_rv" in
      ''|*[!0-9]*) [ -z "$_rv" ] || printf 'NONNUM(%s)' "$_rv" ;;
      *) printf '%s' "$_rv" ;;
    esac
  }
  # uu tien nhanh typecheck_v2 neu co (nhanh chay lai tren trang thai file hien tai)
  TC_RAW=$(gate_last_exit typecheck_v2_exit)
  if [ -n "$TC_RAW" ]; then TC_KEY="typecheck_v2_exit"; TC_VAL="$TC_RAW";
  else TC_KEY="typecheck_exit"; TC_VAL=$(gate_last_exit typecheck_exit); fi
  LINT_VAL=$(gate_last_exit lint_exit)
  TEST_VAL=$(gate_last_exit test_exit)
  DBQ_VAL=$(gate_last_exit dbq_test_exit)
  VAL_VAL=$(gate_last_exit validator_exit)
  NEG_VAL=$(gate_last_exit negative_exit)
  emit "gate_final_mtime: $(date -r "$GATE" -Is 2>/dev/null || echo unknown)"
  emit "gate_final_epoch: $GATE_MTIME"
  emit "newest_source_file: $SRC_FILE"
  emit "newest_source_epoch: $SRC_NEWEST"
  emit "$TC_KEY=$TC_VAL lint_exit=$LINT_VAL test_exit=$TEST_VAL dbq_test_exit=$DBQ_VAL validator_exit=$VAL_VAL negative_exit=$NEG_VAL"
  GATE_FRESH=1
  STALE_REASONS=""
  if [ -n "${GATE_BLOCK_MISSING:-}" ]; then GATE_FRESH=0; STALE_REASONS="$STALE_REASONS GATE_RUN_BLOCK_MISSING"; fi
  if [ "$GATE_MTIME" -lt "$SRC_NEWEST" ]; then GATE_FRESH=0; STALE_REASONS="$STALE_REASONS GATE_OLDER_THAN_SOURCE"; fi
  for kv in "$TC_KEY=${TC_VAL:-}" "lint_exit=${LINT_VAL:-}" "test_exit=${TEST_VAL:-}" "dbq_test_exit=${DBQ_VAL:-}" "validator_exit=${VAL_VAL:-}" "negative_exit=${NEG_VAL:-}"; do
    k=${kv%%=*}; v=${kv#*=}
    if [ -z "$v" ]; then GATE_FRESH=0; STALE_REASONS="$STALE_REASONS MISSING_$k";
    elif [ "$v" != "0" ]; then GATE_FRESH=0; STALE_REASONS="$STALE_REASONS NONZERO_$k($v)"; fi
  done
  emit "gate_fresh=$GATE_FRESH"
  if [ "$GATE_FRESH" -eq 1 ]; then
    emit "GATE_STATUS=XAN — tat ca exit = 0 va gate moi hon moi file nguon. Dung duoc lam co so ket luan."
  else
    emit "GATE_STATUS=NON — STALE_VIOLATION=$STALE_REASONS — KHONG dung duoc lam co so ket luan."
  fi
  emit "--- noi dung gate-final.txt (de doi chieu) ---"
  cat "$GATE" >> "$OUT"
fi
emit ""

emit "===== 12. BANG CHUNG MAY CHO LEDGER #1 VA #2 ====="
emit "--- 12a. interface RegistryData (tools-manager-dialog.tsx) ---"
awk '/interface RegistryData/,/^}/' src/components/tools/tools-manager-dialog.tsx >> "$OUT" 2>&1
emit "customTools_occurrences_in_file: $(grep -c 'customTools' src/components/tools/tools-manager-dialog.tsx)"
emit "RegistryData_field_count: $(awk '/interface RegistryData/,/^}/' src/components/tools/tools-manager-dialog.tsx | grep -cE '^[[:space:]]+[a-zA-Z_]+[?]?:')"
emit ""
emit "--- 12b. exported handlers cua src/app/api/skills/route.ts ---"
grep -nE 'export (async function|const) (GET|POST|PUT|DELETE|PATCH)' src/app/api/skills/route.ts >> "$OUT" 2>&1
emit "DELETE_handler_present: $(grep -cE 'export (async function|const) DELETE' src/app/api/skills/route.ts)"
emit ""

emit "===== 9. KET LUAN ====="
if [ "$VC" -eq 0 ]; then emit "VERDICT: PASS — validator exit 0, report khop artifact"; else emit "VERDICT: FAIL — validator exit $VC"; fi
# So bien the phai DOC TU NEGATIVE-TESTS.txt (machine truth), khong gõ tay.
# KHONG anchor dau dong: negative-tests.mjs ghi "NEG_TOTAL n NEG_FAILED m" tren CUNG mot dong.
NEG_TOTAL=$(grep -oE 'NEG_TOTAL [0-9]+' audit-out/NEGATIVE-TESTS.txt 2>/dev/null | tail -1 | awk '{print $2}')
NEG_FAILED=$(grep -oE 'NEG_FAILED [0-9]+' audit-out/NEGATIVE-TESTS.txt 2>/dev/null | tail -1 | awk '{print $2}')
if [ -z "$NEG_TOTAL" ]; then
  emit "NEGATIVE: FAIL — NEG_TOTAL khong doc duoc tu NEGATIVE-TESTS.txt (negative_exit=$NC)"
elif [ "$NC" -eq 0 ] && [ "$NEG_FAILED" = "0" ]; then
  emit "NEGATIVE: PASS — $NEG_TOTAL/$NEG_TOTAL bien the tra exit nhu mong doi (doc tu NEGATIVE-TESTS.txt)"
else
  emit "NEGATIVE: FAIL — negative_exit=$NC · $NEG_FAILED/$NEG_TOTAL bien the FAIL"
fi
emit ""

echo "evidence written: $(wc -l < "$OUT" | tr -d ' ') lines"

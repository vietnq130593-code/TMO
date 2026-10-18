#!/bin/bash
set -x
# R38 D0 DRIVER v2 — XẾP NHÓM đúng D0 §5.2 (nhóm chạy đồng thời trong group, tuần tự giữa group):
#   G1: 001(80) + 002(58, lấp 9 chunk thiếu §5.4)   G2: 003(46) + 005(67)
#   G3: 004(59)                                      G4: 006(131) + 007(138) + 008(134)
#   G5: 009(155, PSY chót — tránh trộn cửa sổ phân loại)
# Mỗi doc: chỉ kick khi đứng (extracting/parsing/chunked = đợi); partial→reExtract; error→PUT recover+reExtract;
# uploaded→plain; indexed→verify vector thật. 002 thêm điều kiện coverage NEW-id ≥ 58.
LOG=/home/z/tmo-app/scratch/r38-d0-run.log
QDR=http://localhost:6333
API=http://localhost:3000
export -n DATABASE_URL 2>/dev/null; unset DATABASE_URL

status_of() {
  curl -s --max-time 15 "$API/api/ingestion/process?documentId=$1" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin); doc=d.get('document') or d
  print(doc.get('status','')+'|'+str(doc.get('processing_percent','?')))
except Exception: print('?|?')" 2>/dev/null
}
vectors_of() {
  curl -s --max-time 30 -X POST "$QDR/collections/theopus_chunks/points/scroll" -H 'Content-Type: application/json' \
    -d "{\"filter\":{\"must\":[{\"key\":\"document_id\",\"match\":{\"value\":\"$1\"}}]},\"limit\":300,\"with_vector\":true}" | python3 -c "
import json,sys
try:
  pts=json.load(sys.stdin)['result']['points']
  real=sum(1 for p in pts if any(abs(x)>1e-9 for x in (p.get('vector') or [])))
  print(f'{len(pts)}|{real}')
except Exception: print('0|0')" 2>/dev/null
}
# coverage NEW-id cho doc: LocalEntity.chunkId ∩ Qdrant chunk ids hiện tại
covered_new() {
  bun /home/z/tmo-app/scratch/r38-coverage-new.ts "$1" 2>/dev/null | tail -1
}

declare -A DOCS=(
  [02d37297-a3c2-4136-b595-578a3e0a5811]="80|001-GEN_CAUSAL"
  [c46fdb42-4bc5-4cea-8822-635c3c8efb3e]="58|002-NAS_EVOL"
  [210091a5-464a-4d29-9c06-69494e1d4c99]="46|003-OPT_CONVEX"
  [aec6a00b-7550-4bdf-ad9d-27bcf7078755]="67|005-CORE_GRAPH"
  [5b29eb40-6911-42fc-a5a9-013239a1359b]="59|004-SYS_DYN"
  [3e6ea2b0-fa8a-4e9f-b7db-b0bda3c1f4cb]="131|006-COMPLEXITY"
  [3870d7a0-ad85-42de-bafc-bca304f1c6e8]="138|007-DSL"
  [3e92366a-2a59-4713-832b-5d687b560a81]="134|008-GTH"
  [dbfd9a75-07a2-4b77-a7d8-3904250dda48]="155|009-PSY"
)
GROUPS=("02d37297-a3c2-4136-b595-578a3e0a5811 c46fdb42-4bc5-4cea-8822-635c3c8efb3e" "210091a5-464a-4d29-9c06-69494e1d4c99 aec6a00b-7550-4bdf-ad9d-27bcf7078755" "5b29eb40-6911-42fc-a5a9-013239a1359b" "3e6ea2b0-fa8a-4e9f-b7db-b0bda3c1f4cb 3870d7a0-ad85-42de-bafc-bca304f1c6e8 3e92366a-2a59-4713-832b-5d687b560a81" "dbfd9a75-07a2-4b77-a7d8-3904250dda48")

echo "[DRIVER-V2 START $(date -u +%H:%M:%S)] groups: G1(001+002) G2(003+005) G3(004) G4(006+007+008) G5(009)" >> $LOG
GI=0
for GRP in "${GROUPS[@]}"; do
  GI=$((GI+1))
  echo "=== GROUP $GI: $GRP ($(date -u +%H:%M:%S)) ===" >> $LOG
  GDEADLINE=$(( $(date +%s) + 3600 ))   # 60 phút/group mềm
  # trạng thái hoàn tất của từng doc trong group
  declare -A DONE=()
  while [ "$(date +%s)" -lt "$GDEADLINE" ]; do
    ALLDONE=1
    for DOC in $GRP; do
      IFS='|' read -r EXPECTED NAME <<< "${DOCS[$DOC]}"
      [ "${DONE[$DOC]:-0}" = "1" ] && continue
      read ST PCT <<< "$(status_of $DOC | tr '|' ' ')"
      case "$ST" in
        extracting|parsing|chunked) ALLDONE=0; sleep 15 ;;
        indexed)
          read PTS REAL <<< "$(vectors_of $DOC | tr '|' ' ')"
          OKVEC=0; [ "$REAL" -ge "$EXPECTED" ] 2>/dev/null && OKVEC=1
          if [ "$NAME" = "002-NAS_EVOL" ]; then
            COV=$(covered_new $DOC)
            echo "[$(date -u +%H:%M:%S)] $NAME indexed pts=$PTS real=$REAL/$EXPECTED covNew=$COV/58" >> $LOG
            if [ "$OKVEC" = "1" ] && [ "$COV" -ge 58 ] 2>/dev/null; then DONE[$DOC]=1; continue; fi
          else
            echo "[$(date -u +%H:%M:%S)] $NAME indexed pts=$PTS real=$REAL/$EXPECTED" >> $LOG
            if [ "$OKVEC" = "1" ]; then DONE[$DOC]=1; continue; fi
          fi
          ALLDONE=0
          curl -s --max-time 30 -X POST "$API/api/ingestion/process" -H 'Content-Type: application/json' -d "{\"documentId\":\"$DOC\",\"async\":true,\"reExtract\":true}" > /dev/null
          sleep 25 ;;
        partial)
          ALLDONE=0
          echo "[$(date -u +%H:%M:%S)] $NAME partial pct=$PCT — reExtract" >> $LOG
          curl -s --max-time 30 -X POST "$API/api/ingestion/process" -H 'Content-Type: application/json' -d "{\"documentId\":\"$DOC\",\"async\":true,\"reExtract\":true}" > /dev/null
          sleep 35 ;;
        error)
          ALLDONE=0
          echo "[$(date -u +%H:%M:%S)] $NAME error — PUT recover + reExtract" >> $LOG
          curl -s --max-time 30 -X PUT "$API/api/ingestion/process" -H 'Content-Type: application/json' -d "{\"documentId\":\"$DOC\"}" > /dev/null
          sleep 3
          curl -s --max-time 30 -X POST "$API/api/ingestion/process" -H 'Content-Type: application/json' -d "{\"documentId\":\"$DOC\",\"async\":true,\"reExtract\":true}" > /dev/null
          sleep 35 ;;
        uploaded)
          ALLDONE=0
          echo "[$(date -u +%H:%M:%S)] $NAME uploaded — plain kick" >> $LOG
          curl -s --max-time 30 -X POST "$API/api/ingestion/process" -H 'Content-Type: application/json' -d "{\"documentId\":\"$DOC\",\"async\":true}" > /dev/null
          sleep 25 ;;
        *) ALLDONE=0; sleep 20 ;;
      esac
    done
    [ "$ALLDONE" = "1" ] && { echo "[GROUP $GI DONE $(date -u +%H:%M:%S)]" >> $LOG; break; }
    sleep 10
  done
  unset DONE
done
echo "[DRIVER-V2 END $(date -u +%H:%M:%S)] — tổng kết Qdrant:" >> $LOG
curl -s "$QDR/collections/theopus_chunks" | python3 -c "import json,sys; print('theopus_chunks total:', json.load(sys.stdin)['result']['points_count'])" >> $LOG
curl -s "$QDR/collections/theopus_documents" | python3 -c "import json,sys; print('theopus_documents total:', json.load(sys.stdin)['result']['points_count'])" >> $LOG

#!/bin/bash
# R38 D0 RE-INGESTION DRIVER — chạy nền, tuần tự 9 shard theo thứ tự D0 §5.2
# (001 EVO-priority → 002 lấp 9 chunk thiếu §5.4 → 003+005 nhỏ → 004 → 006/007/008 lớn → 009 PSY chót).
# Mỗi doc: đợi đứng → kick đúng loại (uploaded: plain POST; partial: reExtract; error: PUT recover + reExtract;
# indexed-missing-coverage: reExtract) → poll tới indexed → verify Qdrant vector thật == kỳ vọng.
# Extraction core: nemotron-550b qua env EXTRACTION_MODEL (R38) — glm đang sóng hang.
LOG=/home/z/tmo-app/scratch/r38-d0-run.log
QDR=http://localhost:6333
API=http://localhost:3000
export -n DATABASE_URL 2>/dev/null; unset DATABASE_URL

declare -A ORDER=( [1]="02d37297-a3c2-4136-b595-578a3e0a5811:80:001-GEN_CAUSAL" [2]="c46fdb42-4bc5-4cea-8822-635c3c8efb3e:58:002-NAS_EVOL" [3]="210091a5-464a-4d29-9c06-69494e1d4c99:46:003-OPT_CONVEX" [4]="aec6a00b-7550-4bdf-ad9d-27bcf7078755:67:005-CORE_GRAPH" [5]="5b29eb40-6911-42fc-a5a9-013239a1359b:59:004-SYS_DYN" [6]="3e6ea2b0-fa8a-4e9f-b7db-b0bda3c1f4cb:131:006-COMPLEXITY" [7]="3870d7a0-ad85-42de-bafc-bca304f1c6e8:138:007-DSL" [8]="3e92366a-2a59-4713-832b-5d687b560a81:134:008-GTH" [9]="dbfd9a75-07a2-4b77-a7d8-3904250dda48:155:009-PSY" )

get_status() {
  curl -s --max-time 15 "$API/api/ingestion/process?documentId=$1" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin); doc=d.get('document') or d
  print(doc.get('status','')+'|'+str(doc.get('processing_percent','?')))
except Exception: print('?|?')" 2>/dev/null
}

verify_vectors() { # docId expected → in real_vector_count
  curl -s --max-time 30 -X POST "$QDR/collections/theopus_chunks/points/scroll" -H 'Content-Type: application/json' \
    -d "{\"filter\":{\"must\":[{\"key\":\"document_id\",\"match\":{\"value\":\"$1\"}}]},\"limit\":300,\"with_vector\":true}" | python3 -c "
import json,sys
try:
  pts=json.load(sys.stdin)['result']['points']
  real=sum(1 for p in pts if any(abs(x)>1e-9 for x in (p.get('vector') or [])))
  print(f'{len(pts)}|{real}')
except Exception: print('0|0')" 2>/dev/null
}

echo "[DRIVER START $(date -u +%H:%M:%S)] extraction core: nemotron (env R38)" >> $LOG
for i in 1 2 3 4 5 6 7 8 9; do
  IFS=':' read -r DOC EXPECTED NAME <<< "${ORDER[$i]}"
  echo "=== [$NAME] doc=$DOC expected=$EXPECTED ($(date -u +%H:%M:%S)) ===" >> $LOG
  DEADLINE=$(( $(date +%s) + 1800 ))  # 30 phút/shard mềm
  KICKED=0
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    read ST PCT <<< "$(get_status $DOC | tr '|' ' ')"
    case "$ST" in
      extracting|parsing|chunked) sleep 25; continue ;;
      indexed)
        # verify vector thật — ROUND-34 guard đã chạy bên trong, đây là cửa ngoài
        read PTS REAL <<< "$(verify_vectors $DOC $EXPECTED | tr '|' ' ')"
        echo "[$(date -u +%H:%M:%S)] $NAME indexed — points=$PTS real_vectors=$REAL expected=$EXPECTED" >> $LOG
        if [ "$REAL" -ge "$EXPECTED" ] 2>/dev/null; then echo "[$NAME] DONE ✓ ($PTS pts, $REAL real)"; break; fi
        echo "[$(date -u +%H:%M:%S)] $NAME thiếu vector thật ($REAL/$EXPECTED) — reExtract lại" >> $LOG
        curl -s --max-time 30 -X POST "$API/api/ingestion/process" -H 'Content-Type: application/json' -d "{\"documentId\":\"$DOC\",\"async\":true,\"reExtract\":true}" > /dev/null
        sleep 30 ;;
      partial)
        echo "[$(date -u +%H:%M:%S)] $NAME partial pct=$PCT — reExtract" >> $LOG
        curl -s --max-time 30 -X POST "$API/api/ingestion/process" -H 'Content-Type: application/json' -d "{\"documentId\":\"$DOC\",\"async\":true,\"reExtract\":true}" > /dev/null
        sleep 40 ;;
      error)
        echo "[$(date -u +%H:%M:%S)] $NAME error — PUT recover + reExtract" >> $LOG
        curl -s --max-time 30 -X PUT "$API/api/ingestion/process" -H 'Content-Type: application/json' -d "{\"documentId\":\"$DOC\"}" > /dev/null
        sleep 3
        curl -s --max-time 30 -X POST "$API/api/ingestion/process" -H 'Content-Type: application/json' -d "{\"documentId\":\"$DOC\",\"async\":true,\"reExtract\":true}" > /dev/null
        sleep 40 ;;
      uploaded)
        if [ "$KICKED" -eq 0 ]; then
          echo "[$(date -u +%H:%M:%S)] $NAME uploaded — plain kick" >> $LOG
          curl -s --max-time 30 -X POST "$API/api/ingestion/process" -H 'Content-Type: application/json' -d "{\"documentId\":\"$DOC\",\"async\":true}" > /dev/null
          KICKED=1; sleep 30
        else
          curl -s --max-time 30 -X POST "$API/api/ingestion/process" -H 'Content-Type: application/json' -d "{\"documentId\":\"$DOC\",\"async\":true}" > /dev/null; sleep 30
        fi ;;
      *) sleep 25 ;;
    esac
  done
  # snapshot trạng thái cuối của doc này
  read ST PCT <<< "$(get_status $DOC | tr '|' ' ')"
  read PTS REAL <<< "$(verify_vectors $DOC $EXPECTED | tr '|' ' ')"
  echo "[$NAME FINAL] status=$ST points=$PTS real=$REAL expected=$EXPECTED" >> $LOG
done
echo "[DRIVER END $(date -u +%H:%M:%S)] — tổng kết:" >> $LOG
curl -s "$QDR/collections/theopus_chunks" | python3 -c "import json,sys; print('theopus_chunks total:', json.load(sys.stdin)['result']['points_count'])" >> $LOG
curl -s "$QDR/collections/theopus_documents" | python3 -c "import json,sys; print('theopus_documents total:', json.load(sys.stdin)['result']['points_count'])" >> $LOG

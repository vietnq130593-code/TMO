#!/bin/bash
# R38 D0 DRIVER v3 — PHẲNG: không associative array, không IFS trick.
# Group chạy per-doc subshell song song; tuần tự giữa group theo D0 §5.2.
LOG=/home/z/tmo-app/scratch/r38-d0-run.log
QDR=http://localhost:6333
API=http://localhost:3000
export -n DATABASE_URL 2>/dev/null; unset DATABASE_URL

log() { echo "[$(date -u +%H:%M:%S)] $*" >> "$LOG"; }

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
  print(str(len(pts))+'|'+str(real))
except Exception: print('0|0')" 2>/dev/null
}
covered_new() { bun /home/z/tmo-app/scratch/r38-coverage-new.ts "$1" 2>/dev/null | tail -1; }

kick_plain()   { curl -s --max-time 30 -X POST "$API/api/ingestion/process" -H 'Content-Type: application/json' -d "{\"documentId\":\"$1\",\"async\":true}" > /dev/null; }
kick_re()      { curl -s --max-time 30 -X POST "$API/api/ingestion/process" -H 'Content-Type: application/json' -d "{\"documentId\":\"$1\",\"async\":true,\"reExtract\":true}" > /dev/null; }
put_recover()  { curl -s --max-time 30 -X PUT "$API/api/ingestion/process" -H 'Content-Type: application/json' -d "{\"documentId\":\"$1\"}" > /dev/null; }

drive_doc() { # $1=docId $2=expectedChunks $3=shortName
  local DOC="$1" EXPECTED="$2" NAME="$3"
  local DEADLINE=$(( $(date +%s) + 2700 ))
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    local ST PCT; read ST PCT <<< "$(status_of "$DOC" | tr '|' ' ')"
    case "$ST" in
      extracting|parsing|chunked) sleep 20 ;;
      indexed)
        local PTS REAL; read PTS REAL <<< "$(vectors_of "$DOC" | tr '|' ' ')"
        if [ "$REAL" -ge "$EXPECTED" ] 2>/dev/null; then
          if [ "$NAME" != "002" ]; then log "$NAME DONE pts=$PTS real=$REAL/$EXPECTED"; return 0; fi
          local COV; COV="$(covered_new "$DOC" | cut -d/ -f1)"
          if [ "$COV" -ge 58 ] 2>/dev/null; then log "002 DONE pts=$PTS real=$REAL covNew=$COV/58"; return 0; fi
          log "002 indexed (vec OK $REAL/$EXPECTED) nhưng covNew=$COV/58 — reExtract"; kick_re "$DOC"; sleep 35
        else
          log "$NAME indexed thiếu vector ($REAL/$EXPECTED) — reExtract"; kick_re "$DOC"; sleep 35
        fi ;;
      partial) log "$NAME partial pct=$PCT — reExtract"; kick_re "$DOC"; sleep 35 ;;
      error)   log "$NAME error — PUT recover + reExtract"; put_recover "$DOC"; sleep 3; kick_re "$DOC"; sleep 35 ;;
      uploaded) log "$NAME uploaded — plain kick"; kick_plain "$DOC"; sleep 25 ;;
      *) sleep 20 ;;
    esac
  done
  log "$NAME TIMEOUT 45p — bỏ qua"
}

log "DRIVER-V3 START — G1(001+002) → G2(003+005) → G3(004) → G4(006+007+008) → G5(009)"
# ===== G1 =====
drive_doc "02d37297-a3c2-4136-b595-578a3e0a5811" 80 "001" &
drive_doc "c46fdb42-4bc5-4cea-8822-635c3c8efb3e" 58 "002" &
wait
log "G1 xong"
# ===== G2 =====
drive_doc "210091a5-464a-4d29-9c06-69494e1d4c99" 46 "003" &
drive_doc "aec6a00b-7550-4bdf-ad9d-27bcf7078755" 67 "005" &
wait
log "G2 xong"
# ===== G3 =====
drive_doc "5b29eb40-6911-42fc-a5a9-013239a1359b" 59 "004"
log "G3 xong"
# ===== G4 =====
drive_doc "3e6ea2b0-fa8a-4e9f-b7db-b0bda3c1f4cb" 131 "006" &
drive_doc "3870d7a0-ad85-42de-bafc-bca304f1c6e8" 138 "007" &
drive_doc "3e92366a-2a59-4713-832b-5d687b560a81" 134 "008" &
wait
log "G4 xong"
# ===== G5 =====
drive_doc "dbfd9a75-07a2-4b77-a7d8-3904250dda48" 155 "009"
log "G5 xong"
log "DRIVER-V3 END — tổng kết:"
curl -s "$QDR/collections/theopus_chunks" | python3 -c "import json,sys; print('theopus_chunks total:', json.load(sys.stdin)['result']['points_count'])" >> "$LOG"
curl -s "$QDR/collections/theopus_documents" | python3 -c "import json,sys; print('theopus_documents total:', json.load(sys.stdin)['result']['points_count'])" >> "$LOG"

#!/bin/bash
# R24-a: vòng lặp reExtract tới khi đủ 58 chunk có entities (hoặc hết lượt)
DOC="c46fdb42-4bc5-4cea-8822-635c3c8efb3e"
export -n DATABASE_URL 2>/dev/null; unset DATABASE_URL
MAX_PASSES=${1:-10}
for pass in $(seq 1 $MAX_PASSES); do
  # Chờ doc về trạng thái đứng (không extracting/parsing/chunked)
  for i in $(seq 1 60); do
    st=$(curl -s "http://localhost:3000/api/ingestion/process?documentId=$DOC" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('document') or d).get('status',''))" 2>/dev/null)
    case "$st" in extracting|parsing|chunked) sleep 15 ;; *) break ;; esac
  done
  cov=$(bun scratch/r24a-chunk-coverage.ts 2>/dev/null | grep '^{' | tail -1)
  missing=$(echo "$cov" | python3 -c "import json,sys; print(json.load(sys.stdin)['chunksMissing'])" 2>/dev/null)
  echo "[PASS $pass $(date -u +%H:%M:%S)] status=$st cov=$cov"
  if [ "$missing" = "0" ]; then echo "DONE — đủ entities mọi chunk"; break; fi
  # Kích hoạt reExtract (async)
  curl -s -X POST http://localhost:3000/api/ingestion/process -H 'Content-Type: application/json' \
    -d "{\"documentId\":\"$DOC\",\"async\":true,\"reExtract\":true}" > /dev/null
  echo "  → reExtract pass $pass đã kích hoạt, chờ chạy..."
  sleep 45
done

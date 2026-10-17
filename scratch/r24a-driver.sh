#!/bin/bash
# R24-a: driver bền — lặp reExtract tới khi 58/58 chunk có entities HOẶC hết
# thời gian sống (timeout phút, mặc định 240'). Khác r24a-iterate.sh bản cũ:
# không giới hạn số pass (NIM sóng 503 làm pass thất bại nhanh — cần nhiều pass
# hơn dự kiến), log mỗi pass 1 dòng, thoát an toàn khi đủ phủ.
DOC="c46fdb42-4bc5-4cea-8822-635c3c8efb3e"
export -n DATABASE_URL 2>/dev/null; unset DATABASE_URL
DEADLINE_MIN=${1:-240}
END_AT=$(( $(date +%s) + DEADLINE_MIN * 60 ))
PASS=0
while [ "$(date +%s)" -lt "$END_AT" ]; do
  # Chờ doc về trạng thái đứng (không extracting/parsing/chunked) tối đa 15'
  for i in $(seq 1 60); do
    st=$(curl -s "http://localhost:3000/api/ingestion/process?documentId=$DOC" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('document') or d).get('status',''))" 2>/dev/null)
    case "$st" in extracting|parsing|chunked) sleep 15 ;; *) break ;; esac
  done
  cov=$(bun scratch/r24a-chunk-coverage.ts 2>/dev/null | grep '^{' | tail -1)
  missing=$(echo "$cov" | python3 -c "import json,sys; print(json.load(sys.stdin)['chunksMissing'])" 2>/dev/null)
  PASS=$((PASS+1))
  echo "[DRIVE $PASS $(date -u +%H:%M:%S)] status=$st cov=$cov"
  if [ "$missing" = "0" ]; then echo "DONE — đủ entities mọi chunk ($PASS pass)"; break; fi
  curl -s -X POST http://localhost:3000/api/ingestion/process -H 'Content-Type: application/json' \
    -d "{\"documentId\":\"$DOC\",\"async\":true,\"reExtract\":true}" > /dev/null
  sleep 30
done
echo "[DRIVER] kết thúc $(date -u +%H:%M:%S) sau $PASS pass"

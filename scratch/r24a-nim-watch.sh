#!/bin/bash
# R24-a: theo dõi sóng 503 NIM — probe mỗi 120s, ghi 1 dòng/kết quả
for i in $(seq 1 60); do
  r=$(bun scratch/r24a-nim-probe.ts 2>/dev/null | grep PROBE)
  echo "[$(date -u +%H:%M:%S)] $r" >> scratch/r24a-nim-watch.log
  case "$r" in *OK*) echo "[$(date -u +%H:%M:%S)] NIM RECOVERED" >> scratch/r24a-nim-watch.log; break ;; esac
  sleep 120
done

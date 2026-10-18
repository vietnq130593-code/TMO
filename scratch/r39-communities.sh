#!/bin/bash
# R39: community-detect refresh toàn đồ thị sau D0 9 shard (user duyệt D0 §5.5).
# Chạy dưới pm2 — bài học R38: process nền trần trọi bị kill giữa chừng,
# pm2 restart tự động. Log: pm2 logs r39-communities
cd /home/z/tmo-app
set -a && source .env && set +a
exec bun scripts/refresh-communities.ts

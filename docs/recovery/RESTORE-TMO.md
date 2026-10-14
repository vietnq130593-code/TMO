# RUNBOOK KHỤC PHỤC TMO SAU CONTAINER RESET (2026-10-14 08:18 UTC)

> Container reset giữa phiên quan sát lượt 4 (R8) — `/home/z/tmo-app` bị xóa sạch, thay bằng scaffold tại `/home/z/my-project`. Runbook này thực thi NGAY khi có GitHub PAT từ user.

## Điều kiện tiên quyết (ĐANG CHỜ)

- [ ] **GitHub PAT** (`ghp_…` hoặc `github_pat_…`) có quyền repo — tài khoản `nguyenquocviety2c-code` (kho chính, HEAD `6556926`) hoặc `vietnq130593-code` (kho mirror)
- Đã xác minh từ container mới: 2 kho đều PRIVATE (404 anonymous), **không có token nào sót lại** (đã rà: worklog, tool-results, bash history, .git-credentials, .env, node_modules — chỉ có example token trong docs bun-types)

## Các bước (thứ tự bắt buộc)

### B1. Clone lại repo

```bash
# Thay <PAT> bằng token user cung cấp; chọn 1 trong 2 kho
git clone https://<PAT>@github.com/nguyenquocviety2c-code/TMO.git /home/z/tmo-app
cd /home/z/tmo-app && git log --oneline -3   # kỳ vọng HEAD 6556926 hoặc mới hơn
```

### B2. Cài đặt + DB

```bash
cd /home/z/tmo-app
bun install
cp .env.example .env
mkdir -p db && bunx prisma db push        # db/custom.db mới (DB cũ KHÔNG thể phục hồi từ git)
```

⚠️ DB lịch sử (runs/episodes/lessons từ các lượt quan sát R2–R8) **không phục hồi được từ git**. Chỉ có thể re-seed từ R2 backup nếu bucket Cloudflare R2 `themagnumopus` còn snapshot (cần R2 credentials — cũng mất theo reset; hỏi user nếu có).

### B3. Hạ tầng phụ trợ

```bash
# PM2 (mất theo reset)
npm install -g pm2

# Qdrant 1.13.2 (binary mất theo reset)
mkdir -p /home/z/qdrant /home/z/my-project/.zscripts
curl -L -o /tmp/qdrant.tar.gz https://github.com/qdrant/qdrant/releases/download/v1.13.2/qdrant-x86_64-unknown-linux-gnu.tar.gz
tar -xzf /tmp/qdrant.tar.gz -C /home/z/qdrant
chmod +x /home/z/qdrant/qdrant
```

### B4. Tái áp fix R8-1 (NIM rescue utility-core)

Theo `recovery/R8-1-nim-rescue.md`: sửa `src/lib/llm.ts` → `callUtilityLLM` → thay khối return lỗi cuối nhánh `isZenConfigured`. Gate: `bunx tsc --noEmit` + `bun run lint`.

### B5. Cleanup V-1 (lessons test bẩn) — CHỈ CHẠY NẾU DB CÓ DỮ LIỆU CŨ

```sql
-- Verify tồn tại TRƯỚC khi xóa (cả SQLite lẫn Neo4j):
-- id IN ('test-lesson-p1c-llm','test-lesson-p1c-db','test-lesson-r39-low',
--        'lesson_muyex3ee_gk7cxh','lesson_muzarpqi_gjx0qh')
-- SQLite: DELETE FROM LessonRecord WHERE id IN (...)
-- Neo4j : MATCH (l:Lesson) WHERE l.id IN [...] DETACH DELETE l
```

DB trắng mới từ git thì các id này KHÔNG tồn tại — chỉ cần verify rồi bỏ qua.

### B6. Khởi động

```bash
# Giải phóng port 3000 nếu scaffold dev server đang chạy
# (kill next-server của my-project nếu chiếm 3000)
cd /home/z/tmo-app
pm2 start ecosystem.config.cjs && pm2 save
pm2 list    # kỳ vọng: theopusflashlite (3000) + qdrant (6333) online
```

### B7. Bật lại 5 cờ observation

```bash
curl -X POST http://localhost:3000/api/neural-architecture -H 'Content-Type: application/json' -d '<payload 5 cờ obs theo doc API>'
# (5 cờ: §0b — obs_flags trong NeuralArchitecture; xem entry R8 worklog)
```

### B8. Verify E2E (agent-browser)

- UI "THE MAGNUM OPUS" render đầy đủ, HEALTHY, Qdrant v1.13.2 kết nối
- Module Agents/Smolab tương tác OK, BRAIN tab (5 tab console + Quan sát), 0 lỗi console/page
- Test NIM rescue: xác nhận log `[LLM] Utility-core NIM RESCUE (R8)` hoạt động khi cần

### B9. Commit + dual-push (NGAY SAU KHI VERIFY — bài học R8)

```bash
cd /home/z/tmo-app
git add -A && git commit -m "R8: NIM rescue utility-core + phục hồi sau container reset 2026-10-14"
git push   # remote đã nhúng PAT ở B1; kho thứ 2 push bằng PAT riêng nếu user cấp
```

### B10. Sau khôi phục — xử lý các vấn đề còn treo từ user

1. **⑩ BRAIN tab**: điều chỉnh phải HIỆU LỰC THẬT (không draft) — kiểm tra cơ chế "Lưu & áp dụng" / BrainSpecDraft apply path
2. **⑪ UI timer**: agent dừng/lỗi nhưng timer vẫn chạy — state sync bug ở component hiển thị run
3. **⑫ Đài quan sát não**: 2 khoảng đen 2 bên che ảnh — layout canvas/viewport
4. **⑧ Local "Failed to fetch"** (handleNativeFolderPick/authedFetch/doFetch) + **⑨ nghịch lý HK** (local VN vẫn báo chặn vì HK — nghi frontend local gọi qua backend HK)
5. Zen 403 free-tier theo IP datacenter (Task 30) + list model miễn phí opencode + auto-update
6. Opus Review vượt quyền thực thi tác vụ (R3–R7 đã xử lý phần nào — kiểm tra lại), Brain-A tiến triển (đủ 30 nhãn sau 2–3 ngày)

## Thứ tự ưu tiên nếu thiếu nguồn lực

PAT → B1–B4–B6–B8–B9 (khôi phục + fix + verify + commit) → B7 → phần còn lại

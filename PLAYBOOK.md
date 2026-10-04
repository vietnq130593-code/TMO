# Playbook — Kinh nghiệm & Quy tắc rút ra

> File này lưu trữ các bài học kinh nghiệm mà Agent rút ra sau mỗi task.
> Agent sẽ đọc file này trước khi làm task mới để tránh lặp lại lỗi cũ.


Can't initialize prompt toolkit: Found xterm-256color, while expecting a 
Windows console. Maybe try to run this program using "winpty" or run it in 
cmd.exe instead. Or otherwise, in case of Cygwin, use the Python executable 
that is compiled for Cygwin.
───────────────────────────────────────────────────────────────────────────────
You can skip this check with --no-gitignore
Added .env to .gitignore
Aider v0.86.2
Model: openai/z-ai/glm-5.2 with diff edit format
Git repo: .git with 725 files
Repo-map: disabled
Added CONVENTIONS.md to the chat (read-only).
Added MEMORY.md to the chat (read-only).

[API DELETE Endpoint - Xóa Agent]                                              

 • Quy tắc: Khi tạo API DELETE (như /api/agents/[id]), luôn bọc logic trong    
   try-catch, kiểm tra sự tồn tại của bản ghi trước khi xóa, và trả về response
   format chuẩn { ok: boolean, data?: any, error?: string } với HTTP status    
   code phù hợp (200/204 khi thành công, 404 nếu không tìm thấy, 500 khi lỗi   
   server).                                                                    
 • Lý do: Giúp API an toàn, dễ debug, tránh crash server khi Prisma query lỗi  
   (ví dụ: P2025 - Record not found), và đảm bảo frontend nhận được phản hồi   
   nhất quán để xử lý UI đúng cách.                                            

Tokens: 9.4k sent, 160 received.

---

## ROUND-32 — Quy ước Backup/Restore & Migrations (xem docs/BLUEPRINT-DB-P0-P3.md)

### Backup / Restore SQLite (P0-1/P0-2/P3-c)
- **Backup hằng ngày TỰ ĐỘNG**: instrumentation tự POST `/api/storage/db-backup` mỗi 24h
  (đối chiếu lastModified bản cuối trên R2, đệm 20h; `TMO_AUTO_BACKUP=0` để tắt).
- **Mọi backup tự verify nội tuyến**: tải lại bản vừa upload, so sha256 + SQLite header
  magic — response có `verify` field; log `[DB-Backup] Verify PASS`.
- **Restore drill trước release lớn**: `bun scripts/restore-drill.ts` — tải bản latest về
  /tmp, `PRAGMA integrity_check` + đếm bảng + đối chiếu row, KHÔNG đụng DB chạy.
- **Path DB không bao giờ đoán**: route hỏi `PRAGMA database_list` + mismatch guard từ
  chối khi app mở nhầm DB (env-leak trap). Nếu thấy lỗi "DB path mismatch" → kiểm tra
  env shell `DATABASE_URL` (chạy qua `pm2-start.sh` đã unset đúng).
- **Restore an toàn (round-35 A-1)**: restore giờ tải về `.restore-tmp` → verify SQLite
  magic TRƯỚC KHI PHÁ → tự backup DB hiện tại lên R2 (`backups/sqlite/pre-restore-<ts>.db`)
  → `fs.rename` atomic (swap inode — process giữ fd cũ không thể ghi stale page đè bản
  mới). Bản restore hỏng → DB hiện tại nguyên vẹn; restore tồi → khôi phục từ pre-restore key.
- **Clone instance PHẢI tắt auto-backup (round-35 A-4)**: 2 instance chia sẻ .env R2 sẽ
  ghi đè lẫn nhau qua latest pointer `backups/sqlite/custom.db` → restore production kéo
  nhầm DB clone. Trên bản clone đặt `TMO_AUTO_BACKUP=0`.
- **Prisma raw API**: `$queryRawUnsafe`/`$executeRawUnsafe` chỉ nhận STRING THƯỜNG;
  tagged-template `` db.$executeRawUnsafe`...` `` throw mọi lần (đã trả giá 2 lần:
  checkpointWal + sweep). Tagged template = `$queryRaw`. PRAGMA trả result set → dùng
  `$queryRawUnsafe('PRAGMA ...')` (string), không phải execute.

### Migrations (P3-b — từ round-32 chuyển từ db:push thuần sang baseline migrations)
- `prisma/migrations/0_init` = baseline 89 bảng (snapshot schema @ round-32), đã mark
  applied trên DB chạy. Bản `20260618_add_code_team_checkpoint` cũ ĐÃ GỠ (full-dump stale
  đặt sai tên — trùng bảng với baseline, giữ lại sẽ vỡ `migrate deploy`).
- **Đổi schema = tạo migration**: sửa `schema.prisma` xong chạy `bun run db:migrate`
  (= `prisma migrate dev`) — commit kèm file migration. KHÔNG dùng `db:push` cho thay
  đổi schema nữa (chỉ dùng cho DB scratch thử nghiệm).
- **Khôi phục sau reset** (cập nhật runbook round-30): sau khi clone xong chạy
  `env -u DATABASE_URL bun run db:deploy` (= `prisma migrate deploy`) thay cho db:push.
- **Thứ tự deploy trên DB TRẮNG (round-35 A-3)**: `db:deploy` khi app DỪNG
  (`pm2 stop theopusflashlite` trước). Nếu app đã boot trước và self-heal `db push` tạo
  bảng trước → `migrate deploy` sẽ fail CREATE TABLE trùng → chữa bằng
  `env -u DATABASE_URL bunx prisma migrate resolve --applied 0_init` rồi start app.
- Lưu ý vận hành: lệnh prisma migrate/resolve cần app DỪNG (WAL lock — "database is
  locked"): `pm2 stop theopusflashlite` → chạy lệnh → `pm2 start theopusflashlite`.

### Vận hành khác
- Chạy test/lint/prisma luôn kèm `env -u DATABASE_URL` — shell sandbox xuất trap
  DATABASE_URL trỏ DB scaffold (đã gây 14 test fail ảo + backup nhầm DB trước round-32).
- Qdrant point ID phải là UUID/unsigned int (chuỗi tự do "al-..."/"ep_..." = 400 mọi
  upsert) — dùng `deterministicUuid` từ `src/lib/deterministic-uuid.ts`.
- Prisma lưu DateTime trong SQLite là INTEGER epoch-ms — SQL raw trên cột này dùng
  `date(timestamp/1000, 'unixepoch')`, KHÔNG dùng `strftime('...', timestamp)` (NULL).

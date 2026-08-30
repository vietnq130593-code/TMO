---
name: tmo-code-workflow
slug: tmo-code-workflow
version: 2.0.0
description: SOP chuẩn cho agents làm tác vụ code trong TMO — quy trình workspace → edit → lint/typecheck → test → commit scoped → push → pull verify, kèm bộ tools structured và quy ước an toàn (không git add -A, token qua token store, truy hồi context đã nén qua context_recall).
metadata: {"tmo": {"minAppVersion": "2.0.0", "phase": "GĐ3"}}
---

# TMO Code Workflow — SOP cho Agents

## Khi nào dùng

Mọi tác vụ code trong TMO: sửa file, thêm tính năng, fix bug, refactor — dù qua Goal Loop
(chat), Code Team workflow, hay đề xuất SELF-DIRECTION dạng `code-workflow`.
Mọi thay đổi code **bắt buộc** qua pipeline kiểm định trước khi push (triết lý CI-6).

## Bộ tools có sẵn (KHÔNG dùng shell thô khi tool structured tồn tại)

| Nhóm | Tools | Ghi chú |
|---|---|---|
| Đọc/ghi file | `file_read`, `file_edit`, `file_multi_edit`, `file_write`, `file_list`, `grep` | file_read trả số dòng + cursor offset — đọc tiếp file lớn bằng offset |
| Kiểm định | `lint`, `type_check`, `run_tests`, `lsp_diagnostics`, `test_coverage` | chạy TRƯỚC khi commit — phát hiện lỗi sớm |
| Git structured | `git_status`, `git_diff`, `git_log`, `git_branch`, `git_clone` | receipt structured, chống injection, token tự mask |
| Git ghi | `git_commit` (scoped paths, KHÔNG push), `git_push`, `git_pull` | commit = argv-array an toàn, message 1 argv |
| Pipeline | `verify_and_push` | gộp 9 bước kiểm định + push + pull verify (xem dưới) |
| Context | `context_recall` | truy hồi thông tin context ĐÃ NÉN của các run trước |
| Todo | `todo_write` | todo gắn theo runId — tự đóng theo evidence |

## Quy trình 9 bước pipeline (`verify_and_push` / `runPrePushVerification`)

```
1. lint          — eslint . (script "lint" của repo)
2. type_check    — tsc --noEmit (script "typecheck")
3. run_tests     — bun test trên DB test cô lập (script "test")
4. smoke         — probe HTTP HEAD url (mặc định app :3000) — mong < 400
5. secret_scan   — quét diff HEAD + commit chưa push + file untracked (12 pattern)
6. git_preflight — đọc trạng thái cây; cây sạch + đã sync → dừng an toàn (skip 7-9)
7. commit        — scoped paths (KHÔNG BAO GIỜ git add -A)
8. push          — token resolution 3 tầng (URL nhúng > token store > env)
9. pull_verify   — git pull --ff-only xác nhận round-trip push/pull
```

**Bất kỳ bước nào FAIL → KHÔNG push → sửa → chạy lại pipeline từ đầu.**
Cây sạch không có gì để commit = ĐẠT (pipeline vẫn PASS, ghi chú receipt).

## Quy ước bắt buộc

1. **Scoped paths khi commit** — liệt kê TỪNG file đã sửa; không bao giờ `git add -A`
   (chặn lẫn file dở dang của agent/tác vụ khác đang chạy song song).
2. **Token KHÔNG nằm trong code/URL** — PAT sống trong GitHub Token Store
   (`db/.github-token.json`, mode 0600) hoặc env `GITHUB_TOKEN`/`GH_TOKEN`.
   Remote origin KHÔNG BAO GIỜ chứa token nhúng.
3. **Commit message** — conventional commits (`feat|fix|refactor|docs|test(scope): ...`),
   tiếng Việt mô tả rõ thay đổi; pipeline SELF-DIRECTION tự sinh message chuẩn
   (slug không dấu + proposal id + trailer "Triển khai từ đề xuất SELF-DIRECTION").
4. **Kiểm định trước commit** — chạy `lint` + `type_check` + `run_tests` ngay sau khi
   sửa xong nhóm file; đừng dồn hết cho bước cuối.
5. **Đọc file trước khi sửa** — `file_read` vùng cần sửa trước `file_edit`
   (giảm sai lệch match; file_edit có guard match_count).
6. **Context phình to** — tool result tự bị cap 4k chars + rolling digest 50k.
   Khi cần chi tiết CŨ đã bị nén: `context_recall(query, runId?)` — trả digest/raw/task_summary
   từ Kho Context (SQLite + Qdrant). KHÔNG thử đọc lại toàn bộ transcript.
7. **Todo trung thực** — `todo_write` nội dung actionable; hệ thống tự đánh dấu hoàn thành
   khi thấy bằng chứng tool thay đổi thật; không tự viết "done" nếu chưa chạy tool.
8. **Shell chỉ khi cần** — Ưu tiên tool structured; shell chấp nhận được cho lệnh ad-hoc
   (build, one-off) nhưng KHÔNG dùng shell cho git khi tool git_* tồn tại.

## Self-direction code-workflow (CI-6 B5)

Đề xuất SELF-DIRECTION được phân loại `executionMode=code-workflow` → Omega lập plan
(kết thúc bằng bước `verify_and_push`), agents thực thi bằng tools thật trong workspace,
bước cuối chạy pipeline 9 bước single-shot: PASS → commit + push + pull verify → báo cáo
kèm commit hash; FAIL → KHÔNG push, step fail có failReason + receipt từng bước.
Commit/push/pull qua shell trong code-steps bị denylist chặn — pipeline là đường DUY NHẤT.

## Anti-patterns

- ❌ `git add -A` / `git add .` — luôn scoped paths
- ❌ Push khi pipeline chưa PASS hoặc bỏ qua bước kiểm định
- ❌ Nhúng token vào URL/remote/code — token store lo việc đó
- ❌ Dùng `shell` chạy git raw khi có `git_status`/`git_diff`/`git_commit`...
- ❌ Viết todo hoàn thành mà không có bằng chứng tool tương ứng
- ❌ Copy code dài vào message (bloat context) — dẫn file path + điểm chính,
  khi cần chi tiết cũ dùng `context_recall`

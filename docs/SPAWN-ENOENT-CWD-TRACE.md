# Truy vết: spawn /bin/bash ENOENT — cwd sai định dạng (2026-10-14)

## 1. Kết luận
Nguồn gốc là **cấu hình biến môi trường (category b)**, KHÔNG phải thiếu kiến thức.
Giá trị `E:\APP\TMO-clone` (đường dẫn Windows của máy dev) nằm trong file cấu hình
dotenv đã commit:

| File | Dòng | Biến | Giá trị |
|---|---|---|---|
| dotenv (thật) | 519 | `TMO_DEFAULT_WORKSPACE` | `E:\APP\TMO-clone` |
| dotenv (thật) | 526 | `TMO_CLONE_DIR` | `E:\APP\TMO-clone` |
| dotenv mẫu | 519 / 526 | (như trên) | như trên |

## 2. Điểm rò rỉ (không có kiểm định)
| File | Dòng (trước fix) | Code |
|---|---|---|
| `src/lib/workspace/ensure-default-workspace.ts` | 52 | `const rootPath = (process.env.TMO_DEFAULT_WORKSPACE \|\| '').trim()` |
| `src/lib/workspace/workspace-context.ts` | 123 | `const cloneDir = (process.env.TMO_CLONE_DIR \|\| '').trim()` |

Cả hai chỉ `.trim()` — không kiểm tra separator, không kiểm tra tồn tại, không kiểm tra
platform. Đây là **cửa duy nhất** để giá trị hỏng đi từ config vào `cwd`.

## 3. Cơ chế Windows-path lọt vào Linux
1. `path.resolve('E:\APP\TMO-clone')` trên POSIX → `/home/z/tmo-app/E:\APP\TMO-clone`
   (không ném lỗi — coi đây là tên thư mục hợp lệ vì backslash là ký tự hợp lệ trên Linux).
2. `mkdir -p` trong bootstrap tạo thư mục LITERAL đó → **chính lần chạy lỗi tạo ra bằng chứng
   làm giảm triệu chứng** (xác nhận giả thuyết (d) của khảo sát).
3. Trước khi thư mục tồn tại: `spawn('/bin/bash', { cwd })` → `spawn /bin/bash ENOENT` ×10.
4. Sau khi thư mục đã tồn tại: spawn "thành công" nhưng rơi vào workspace rác → agent đọc/ghi
   sai thư mục, sinh lỗi dây chuyền.
5. Workspace row (rootPath @unique) được upsert lại mỗi lần restart → lỗi **tái lập**, đúng
   tính chất hệ thống quan sát được.

## 4. Hệ quả cần lưu ý (phát hiện mới, chưa xử lý)
Root workspace của chính TMO server hiện là `/home/z/tmo-app/E:\APP\TMO-clone` — tức **toàn bộ
tool file_read / file_list / file_edit / file_write của agent đang bị gốc rễ vào thư mục rác**,
chỉ chứa `audit-out/` và `docs/`, trong khi repo thật nằm ở thư mục cha. Vì vậy mọi lượt làm việc
phải dùng shell thay vì tool file. Sửa cấu hình cần Omega/intervention ngoài phạm vi G2-B.

## 5. Bản vá đã áp dụng
- Mới: `src/lib/workspace/sanitize-env-path.ts` — `sanitizeEnvPath(raw, label)`.
  Chặn: NUL byte, dấu nháy thừa, Windows/UNC path trên POSIX, backslash lẫn, `~` chưa expand,
  relative path, path không tồn tại, path không phải directory. Trả `path: null` + `warnings`.
- `ensure-default-workspace.ts:52` → dùng sanitizer; log warning; rỗng ⇒ no-op (không mkdir rác).
- `workspace-context.ts:123` → chỉ hiện clone note khi path hợp lệ.

## 6. Blast radius — call site sinh process (inventory)
| Call site | Ghi chú |
|---|---|
| `src/lib/exec-runner.ts:156` (`execFile`) | qua allowlist + protected-paths; nhận `cwd` từ workspace root |
| `src/lib/db-setup.ts:211` (`spawnSync 'node'`) | probe version, không dùng cwd env |
| `src/lib/db-setup.ts:227` (`spawn`) | không dùng cwd env |
| `src/lib/code-team/dev-tools.ts` | shell/git tool của team → nhận cwd từ workspace root |

`exec-allowlist.ts` chỉ kiểm tra **token lệnh**, không kiểm tra **cwd** → cwd hỏng đi lọt qua.
Đây là hạng mục nên giao G3 (đóng cửa thứ 2 ở tầng thực thi).

## 7. Việc còn lại (cần phê duyệt ngoài phạm vi G2-B)
- Sửa 2 giá trị trong file dotenv thật + file mẫu sang đường dẫn POSIX hoặc để trống.
- Xoá thư mục rác literal `E:\APP` và sửa Workspace row trong DB (rootPath đang lưu giá trị hỏng).
- Rà lại logic gán nhãn root cause: path/config lỗi KHÔNG được nhãn KNOWLEDGE_GAP.

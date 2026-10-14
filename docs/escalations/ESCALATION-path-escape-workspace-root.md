# ESCALATION DOSSIER — `path escapes workspace root` gây TOOL_FAILURE lặp lại

- **Mã ticket:** [Escalation] Vá lỗ 'path escapes workspace root'
- **Mở bởi:** ALISTA 🛠️ · Bước 1 — Xác nhận pattern lỗi qua Neo4j
- **Ngày khảo sát:** 2026-10-14 (ca trực 23h30)
- **Nguồn dữ liệu:** Neo4j `ErrorOccurrence` (db `${NEO4J_DATABASE}`) + SQLite `db/custom.db → AgentRunRecord`
- **Kịch bản khảo sát:** `audit-out/alista-escape-pattern.mjs` · output thô: `audit-out/escape-pattern-output.txt`

---

## 0. BẰNG CHỨNG 0 — tái hiện trực tiếp trong chính ca khảo sát

Trước khi truy vấn, ALISTA thử ghi scratch script đúng theo convention mới (`/tmp/opencode`):

```
tmo_file_write({"path": "/tmp/opencode/alista-escape-pattern.mjs"})
→ Access denied: path escapes workspace root (/tmp/opencode/alista-escape-pattern.mjs)
```

**Kết luận:** infra guard hiện **chưa** cho phép `/tmp/opencode` → lỗi **đang tái diễn ở thời điểm hiện tại**, không phải sự cố lịch sử đã hết. Đây là bằng chứng mạnh nhất cho giải pháp lớp (1) của ticket.

### 0b. Biến thể path-esolve lạ (phát hiện phụ — cần ticket riêng)

`tmo_file_write` với đường dẫn **relative** trong workspace không ghi vào `/home/z/tmo-app` mà ghi vào một thư mục tên literal kiểu Windows:

```
/home/z/tmo-app/E:\APP\TMO-clone/audit-out/alista-escape-pattern.mjs
```

TMO server resolve workspace root theo chuỗi `E:\APP\TMO-clone` (kể cả khi backslash bị escape thành `%5C`), khiến `node` ném `ERR_INVALID_MODULE_SPECIFIER`. **Không thuộc phạm vi ticket này** (không phải TOOL_FAILURE path-escape) nhưng cùng họ "path guard/resolve" → ghi nhận để ticket riêng.

---

## 1. KẾT QUẢ TRUY VẤN BẮT BUỘC

```cypher
MATCH (e:ErrorOccurrence) WHERE e.raw_message CONTAINS 'path escapes workspace root'
RETURN e.raw_message, e.occurred_at ORDER BY occurred_at DESC LIMIT 20
```

**→ LỖI CÚ PHÁP (SyntaxError):**

```
Neo.ClientError.Statement.SyntaxError
Variable `occurred_at` not defined (line 1, column 131)
```

Nguyên nhân: mệnh đề `ORDER BY occurred_at` thiếu prefix `e.` (đã khai báo `RETURN e.raw_message, e.occurred_at`). Truy vấn **không chạy được nguyên văn**.

**Bản sửa tối thiểu** (giữ nguyên ý nghĩa, chạy ở mục 3): `ORDER BY e.occurred_at DESC`.

---

## 2. BẢNG ĐỐI CHIẾU — 5 `ErrorOccurrence` TOOL_FAILURE gần nhất

```cypher
MATCH (e:ErrorOccurrence) WHERE e.root_cause = 'TOOL_FAILURE'
RETURN e.raw_message, e.occurred_at, e.agent_name, e.resolved
ORDER BY e.occurred_at DESC LIMIT 5
```

| # | Thời điểm | Nhóm | `raw_message` (rút gọn) | resolved | agent_name |
|---|---|---|---|---|---|
| 1 | 2026-10-13 18:44:45 | **path-escape** | `Tool error: Access denied: path escapes workspace root (/tmp/test-neo4j.mjs)` | `false` | `null` |
| 2 | 2026-10-13 18:43:07 | **path-escape** | `Tool error: Access denied: path escapes workspace root (..)` | `true` | `null` |
| 3 | 2026-10-07 02:44:21 | other | `{"success":false,"exit_code":1,"stdout":"=== A. .env TRACKED BY GIT? ...` | `false` | `null` |
| 4 | 2026-10-06 15:36:49 | other | `garbled output (5 provider markers) — đã yêu cầu phát lại sạch` | `true` | `null` |
| 5 | 2026-10-06 15:36:49 | other | `garbled output (3 provider markers) — đã yêu cầu phát lại sạch` | `true` | `null` |

---

## 3. PATH CỤ THỂ BỊ CHẶN

```cypher
MATCH (e:ErrorOccurrence) WHERE e.raw_message CONTAINS 'path escapes workspace root'
RETURN e.raw_message AS msg, e.occurred_at ORDER BY e.occurred_at DESC LIMIT 20
```

| Path / mẫu bị chặn | Loại lỗi | Thời điểm |
|---|---|---|
| `/tmp/test-neo4j.mjs` | **absolute path ngoài workspace** | 2026-10-13 18:44:45 |
| `..` | **relative path thoát lên trên** | 2026-10-13 18:43:07 |

→ Tổng **2** path-escape, cả hai nằm trong `/tmp`-vùng / thoát bằng `..`.
→ Phân bố theo ngày (`RETURN date(e.occurred_at), count(*)`): **1 ngày duy nhất — 2026-10-13, n = 2**. Tập trung 2 phát trong **98 giây** (18:43:07 → 18:44:45) → hành vi **lặp nhanh trong 1 phiên agent**, không phải rò rỉ đều đặn.

---

## 4. KẾT LUẬN ĐỐI CHIẾU MỤC TIÊU ≥ 2/3

```cypher
MATCH (e:ErrorOccurrence) WHERE e.root_cause = 'TOOL_FAILURE'
WITH e, CASE WHEN e.raw_message CONTAINS 'path escapes workspace root'
            THEN 'path_escape' ELSE 'other' END AS bucket
RETURN bucket, count(*) AS total, sum(CASE WHEN e.resolved THEN 1 ELSE 0 END) AS resolved
```

| bucket | total | resolved | unresolved |
|---|---|---|---|
| `path_escape` | **2** | 1 | **1** |
| `other` | 3 | 1 | 2 |
| **Tổng** | **5** | 2 | 3 |

**Tỉ lệ path-escape = 2/5 = 40,0 %** → **KHÔNG đạt** mục tiêu ≥ 2/3 (66,7 %).

### 4b. ⚠ Đính chính số liệu so với mô tả escalation

| Claim trong escalation | Dữ liệu thật từ Neo4j | Kết luận |
|---|---|---|
| "TOOL_FAILURE lặp lại **5 lần**" | Có đúng **5** ErrorOccurrence `root_cause='TOOL_FAILURE'` | ✅ đúng, nhưng 5 là **tổng nhóm**, không phải 5 lần path-escape |
| "**3 chưa resolve**" | unresolved = 3 (path_escape 1 + other 2) | ✅ đúng về tổng, ❌ **chỉ 1** thuộc path-escape |
| (ngầm định) toàn bộ 5 là path-escape | path-escape chỉ **2/5 = 40 %** | ❌ **sai** — 3/5 là lỗi khác |

**Ý nghĩa:** ticket **giữ nguyên phạm vi** (vá path-escape đúng là nhóm lớn nhất về mức độ lặp — 2 phát/98 giây), nhưng **kỳ vọng phải hiệu chỉnh**: vá guard sẽ **không** xử lý 3/5 lỗi còn lại. Những lỗi đó phải theo ticket riêng (mục 5).

---

## 5. NHÓM LỖI CÒN LẠI — CẦN TICKET RIÊNG (KHÔNG xử lý ở ticket này)

```cypher
MATCH (e:ErrorOccurrence) WHERE e.root_cause = 'TOOL_FAILURE'
  AND NOT e.raw_message CONTAINS 'path escapes workspace root'
RETURN e.raw_message, e.occurred_at ORDER BY e.occurred_at DESC LIMIT 10
```

| Nhóm | Số lần | Thời điểm | Mô tả | Ticket riêng |
|---|---|---|---|---|
| **shell exit_code 1** | 1 | 2026-10-07 02:44:21 | Tool trả `{"success":false,"exit_code":1}` kèm stdout dài kiểm tra `.env` git tracking — **lỗi thực thi lệnh shell**, không liên quan path guard | ✅ TICKET RIÊNG |
| **garbled output (5 provider markers)** | 1 | 2026-10-06 15:36:49 | Output tool bị vỡ ký tự khi in danh sách provider | ✅ TICKET RIÊNG |
| **garbled output (3 provider markers)** | 1 | 2026-10-06 15:36:49 | Cùng lớp lỗi garbled output | ✅ TICKET RIÊNG (gộp với dòng trên) |

**→ Đề xuất: 2 ticket riêng** — (a) `shell tool trả exit_code 1 không được retry/giải thích`, (b) `garbled output khi tool in danh sách dài`. **Không đưa vào phạm vi vá path-escape** để giữ ticket nhỏ, dễ kiểm chứng.

---

## 6. QUÉT `AgentRunRecord` (SQLite `db/custom.db`)

Lịch sử run **không lưu chuỗi `path escapes`** ở bất kỳ cột nào (`stopReason` chỉ gồm `error` / `crashed` / `cancelled` / `complete` / `no_progress`) → lỗi nằm ở **tầng tool/infra**, không nổi lên tầng agent-run.

**Phân bố run không hoàn tất (groupBy `status`,`stopReason`):**

| status | stopReason | Số run | `toolFailures` (sum) | `startedAt` gần nhất |
|---|---|---|---|---|
| `failed` | `error` | **11** | 15 | 1791948256586 |
| `cancelled` | `cancelled` | 6 | **93** | 1791956723149 |
| `failed` | `crashed` | 2 | — | 1791956217135 |

**Top run theo `toolFailures`:**

| agentName | status | stopReason | toolFailures |
|---|---|---|---|
| SENTINEL | cancelled | cancelled | **29** |
| SENTINEL | cancelled | cancelled | 25 |
| Omega | cancelled | cancelled | 24 |
| SHOCWAVE | failed | error | 3 |

**Kết luận phần này: CHƯA ĐỦ DỮ LIỆU.** Không có cột nào trong `AgentRunRecord` mang nội dung lỗi path-escape, nên **không thể** quy `failed/error × 11` là do path-escape. Nhóm `cancelled` (toolFailures 93) là ứng viên đáng ngờ về hành vi lặp tool, nhưng **chưa đủ bằng chứng** để kết luận — cần `messageId → ToolCall log` để nối chuỗi. Không suy đoán trong dossier này.

---

## 7. KẾT LUẬN BƯỚC 1

1. **Pattern lỗi ĐÃ xác nhận** — 2 ErrorOccurrence path-escape, cùng ngày 2026-10-13, cách nhau 98 giây, path cụ thể: `/tmp/test-neo4j.mjs` và `..`.
2. **Tỉ lệ 2/5 = 40 % < mục tiêu 66,7 %** → nhóm path-escape là lớp lớn nhất *trong các lỗi lặp nhanh* nhưng **không chiếm đa số tuyệt đối**. Phần khác đã tách ticket riêng ở mục 5.
3. **Số liệu escalation cần hiệu chỉnh**: "5 lần, 3 chưa resolve" là **tổng nhóm TOOL_FAILURE**; phần thuộc path-escape là **2 lần / 1 chưa resolve**.
4. **Lỗi đang sống** — tái hiện trực tiếp trong ca này ở mục 0 (`/tmp/opencode` bị chặn).
5. **Truy vấn bắt buộc có lỗi cú pháp** — `ORDER BY occurred_at` thiếu prefix `e.`; bản sửa đã dùng để lấy số liệu.

### 🎯 Tiêu chí xác nhận hiệu quả (cho vòng lặp phản hồi kín)

| Metric | Hiện tại | Ngưỡng mục tiêu | Đo lại |
|---|---|---|---|
| `ErrorOccurrence` path-escape mới trong 7 ngày | 2 (2026-10-13) + 1 sự kiện tái hiện ca 14/10 | **0** | Sweep 60s sau khi guard vá + 3 ngày |
| `file_write` ra `/tmp/opencode` | `Access denied` | **thành công** | Ngay sau deploy |
| Tỉ lệ path-escape / tổng TOOL_FAILURE | 40 % (2/5) | **100 % chuyển sang 0** | 7 ngày sau deploy |
| Số ngày có path-escape | 1 | **0** | 7 ngày sau deploy |

---

## BƯỚC 2 — CHẨN ĐOÁN TẦNG CHẶN (SENTINEL, đọc code thật)

### (a) Tầng ném lỗi: MỘT tầng duy nhất — client-side `dev-tools.ts`

Grep `path escapes workspace root` (repo, --exclude-dir=node_modules --exclude-dir=.next):

| file:line | vai trò | tầng agent? |
|---|---|---|
| `src/lib/code-team/dev-tools.ts:207` | **THROW GỐC** trong `resolveWithinWorkspace()` (def dòng 193) | ✅ ĐÂY |
| `src/lib/code-team/dev-tools.ts:498` | wrap `file_write thất bại: ${msg}` | ✅ |
| `src/lib/code-team/workspace-root.ts:8,45` | CHỈ là COMMENT mô tả triệu chứng | ❌ |
| `src/app/api/opencode/files/diff/route.ts:44` | API route web UI | ❌ |
| `src/app/api/opencode/files/delete/route.ts:30` | API route web UI | ❌ |

Bằng chứng quyết định: lời gọi `tmo_file_write` thật trả
`"file_write thất bại: Access denied: path escapes workspace root (/tmp/other.mjs)"` +
`hint: "Path phải nằm TRONG workspace root (dùng đường dẫn relative, không ../)."`
→ chuỗi hint DUY NHẤT nằm ở `dev-tools.ts:500`, wrapper ở `:498`.

**Kết luận**: KHÔNG có infra guard TMO-server riêng sinh message này.
`src/lib/protected-paths.ts` là guard khác (package.json/prisma/.env), message khác.
⇒ Vá đúng 1 file: `src/lib/code-team/dev-tools.ts`.

### (b) Ba ca path chạy thật (tool receipt)

| # | path | kết quả |
|---|---|---|
| A | `/tmp/opencode/sentinel-probe.mjs` | ❌ DENIED — `Access denied: path escapes workspace root (...)` |
| B | `/tmp/other.mjs` | ❌ DENIED — `Access denied: path escapes workspace root (...)` |
| C | `audit-out/sentinel-probe.mjs` (relative) | receipt success:true — **nhưng file KHÔNG tồn tại trên disk** (xem (e)) |

Thêm: `tmo_file_read` với path TUYẾT ĐỐI trong chính workspace
(`/home/z/tmo-app/src/lib/code-team/workspace-root.ts`) cũng bị DENIED cùng message
(root in ra là `/home/z/tmo-app`) ⇒ `path.resolve(absRoot, filePath)` với filePath tuyệt
đối luôn ra ngoài root. Chỉ path TƯƠNG ĐỐI mới dùng được.

### (c) Nơi chèn quy ước (dùng chung) — 2 điểm

1. **Tool descriptions (chung)**: `tool-executor.ts:2258 getToolDefinitions(tools)`
   → `:2247 getToolDefinitionsForPosition(position)` → `workflow-engine.ts:2589`
   → `applyDescriptionOverrides()` (`src/lib/tool-access.ts:283`) `:2592` →
   `buildToolSchemasSection()` (`src/lib/code-team/prompts.ts:79`) → `:2600`
   `systemBlocks.push({name:'toolSchemas', priority:10})`.
   ⇒ Sửa description `file_read/file_write/file_edit/shell` trong `tool-executor.ts`:
   1 sửa → mọi agent thấy.
2. **System prompt chung**: `workflow-engine.ts:2355 systemBlocks[]` (khối `workspace`
   `:2382`, `capabilities` `:2393`), cắt ngân sách `:2351` + `:2608 budgetPrompt`.
   ⇒ Thêm 1 dòng vào khối `workspace` (priority 40): rẻ, không bị cắt.

**Agent dùng chung**: MEGATRON (TL), SHOCWAVE (G1), RAMPAGE (G2-A), SENTINEL (G2-B),
CATALYST (G3) — `src/lib/code-team/agents.ts:456-460`. Ngoài pipeline còn các entry
`self-direction/orchestrator.ts`, `omega-orchestrator.ts`, `subagent-delegate.ts`,
`standalone-agents.ts`, `opus/pipeline.ts`: cùng chịu guard nhưng KHÔNG đi qua
workflow-engine ⇒ vá prompt phải kiểm tra riêng các entry này.

### (d) Kết luận chẩn đoán

- Tầng vá (1): `dev-tools.ts:193-210` — allowlist `/tmp/opencode` + `/tmp/opencode/**`
  như scratch root phụ, giữ fail-closed cho mọi path khác. KHÔNG vá `workspace-root.ts`
  (chỉ comment), KHÔNG vá 2 API route (không liên quan tool agent).
- Tầng vá (2): thêm quy ước "file tạm/script kiểm thử đặt dưới /tmp/opencode, không tạo
  file trực tiếp trong /tmp" vào descriptions `tool-executor.ts` + khối `workspace`
  `workflow-engine.ts:2382`.
- Lưu ý khi vá: vì file_* chỉ nhận path TƯƠNG ĐỐI, agent muốn ghi `/tmp/opencode/x.mjs`
  phải dùng được dạng tương đối tới scratch root — nếu không normalize được, agent vẫn
  phải đoán và vẫn TOOL_FAILURE.

### (e) BUG MỚI phát hiện — receipt success:true nhưng KHÔNG ghi file

`file_write` trả `{"success":true,"bytesWritten":5396,"fileExistedBefore":false}` cho
lần append dossier và `{"success":true,"bytesWritten":18}` cho case C, nhưng kiểm chứng
disk cho thấy **cả hai đều không tồn tại**:
- `wc -l docs/escalations/...md` = 176 dòng, `grep -c "BƯỚC 2"` = **0** (nội dung append mất).
- `ls audit-out/sentinel-probe.mjs` = No such file or directory.
- `fileExistedBefore:false` cho cả 2 lần, kể cả lần append file ĐÃ tồn tại ⇒ ghi vào root
  khác (tool cwd khác repo cwd) và không báo lỗi.
⇒ Đây là nguồn TOOL_FAILURE thứ 2 (nặng hơn): agent tin receipt, file không có, rồi lặp
tool call. Bắt buộc xử lý cùng batch: hoặc sửa resolve để trả đúng abs path + verify
ghi thật, hoặc tối thiểu báo lỗi thay vì success giả.

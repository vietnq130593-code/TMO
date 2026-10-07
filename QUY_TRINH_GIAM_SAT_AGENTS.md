# QUY TRÌNH GIÁM SÁT AGENTS — HỆ THỐNG VẬN HÀNH TMO (The Magnum Opus)

> **Phiên bản:** 1.1 — 2026-10-07 (cập nhật từ vận hành round 52–55: bổ sung mục 1b — kích hoạt theo dõi đồng bộ cùng mission + kênh THINKING; v1.0 2026-10-01 vòng 18–19)
> **Phạm vi:** giám sát toàn bộ agents (Omega, Opus, ALISTA, SENTINEL, NEMESIS, Code Team…) trong vòng đời mission: từ dispatch chỉ đạo → thực thi goal-loop → phán quyết → đóng sổ.
> **Người dùng:** operator / trọng tài vận hành (người hoặc agent giám sát).
> **Cấu trúc:** mỗi lĩnh vực gồm 4 khối — (1) Mục tiêu · (2) Công việc · (3) Nguồn bằng chứng & cách đo · (4) **Rubric chấm điểm**.

---

## 0. NGUYÊN TẮC CỐT LÕI (áp dụng cho mọi phần)

1. **Bằng chứng máy trước, lời nói agent sau** — mọi tuyên bố "ĐÃ LÀM" phải soi được trong ToolMetric / AgentRunRecord / GoalLoopJob / SQL readback.
2. **Không tin một nguồn duy nhất** — API phải đối chiếu sqlite read-only độc lập; UI phải đối chiếu DB.
3. **Vi phạm lịch sử giữ nguyên vẹn** — khi disposition `superseded`, mô tả vi phạm cũ KHÔNG được rửa thành compliant.
4. **Mỗi sự cố lặp ≥ 2 lần phải sinh fix cấu trúc** — không khắc phục lẻ tẻ từng trường hợp.
5. **Chấm điểm bằng dữ liệu đo được** — mọi tiêu chí dưới đây phải truy vấn/kiểm chứng được, không chấm theo cảm tính.

---

## 1. GIÁM SÁT THỰC THI VÒNG LẶP — 12 điểm

**Mục tiêu:** mọi goal-loop job chạy có người theo dõi; stall/failed bị phát hiện nhanh; không job kẹt mồ côi.

**Công việc:**
- Theo dõi goal-loop jobs: trạng thái, chu kỳ, heartbeat, stopReason
- Phát hiện stall (`no_progress`), failed, cancelled bất thường
- Đọc ToolMetric để biết agent thật sự làm gì (thành công/thất bại/pattern)
- Truy vết chu kỳ ↔ tool call ↔ kết quả (phân tách theo agentRole — cẩn thận tính công cho nhầm agent)
- **Bật công cụ theo dõi đồng bộ theo mục 1b ngay khi mission được kích hoạt**

**Nguồn bằng chứng & cách đo:**
```sql
-- Job kẹt (không terminal, không nhịp tim >30 phút)
SELECT id, status, heartbeatAt FROM GoalLoopJob
WHERE status IN ('queued','running') AND heartbeatAt < (strftime('%s','now')*1000 - 1800000);
-- Run thất bại gần nhất
SELECT id, runId, agentName, stopReason, toolCalls, toolFailures, tokensUsed
FROM AgentRunRecord WHERE status != 'completed' ORDER BY createdAt DESC LIMIT 10;
-- Phân tách tool call theo agent
SELECT agentRole, toolName, success, COUNT(*) FROM ToolMetric
WHERE timestamp > :windowStart GROUP BY agentRole, toolName, success;
```

**Rubric:**

| Mã | Tiêu chí | Điểm | Điều kiện trọn điểm |
|---|---|---|---|
| D1.1 | Phát hiện stall/failed ≤ 15 phút kể từ lúc xảy ra | 3 | Có dấu vết kiểm tra trong cửa sổ 15 phút sau thời điểm stall (log/audit/worklog) |
| D1.2 | 0 job kẹt quá hạn | 3 | Truy vấn job kẹt trả về 0 hàng |
| D1.3 | 100% run thất bại có root-cause ghi nhận | 3 | Mỗi run failed/incomplete trong kỳ chấm có phân tích nguyên nhân trong worklog hoặc issue |
| D1.4 | Run đốt > 500k token được cảnh báo & post-mortem | 3 | Có alert + bản ghi phân tích (vd: run 973k token vòng 18) |

**Ngưỡng xử lý:** D1 < 6/12 → rà toàn bộ jobs ngay trong phiên làm việc.

---

## 1b. KÍCH HOẠT THEO DÕI ĐỒNG BỘ CÙNG MISSION (bắt buộc từ r55)

**Nguyên tắc:** **KÍCH HOẠT MISSION = KÍCH HOẠT HỆ THỐNG THEO DÕI.** Không có mission nào được dispatch khi kênh theo dõi chưa chạy. Mission chạy mà không được quan sát = mất khả năng phát hiện sự cố trong lúc chạy (bằng chứng: mission SENTINEL r54 — sub-agent đốt 51.9M tokens chạy loạn 45+ phút trước khi operator đọc được dấu hiệu; r53 — stall 973k token chỉ phát hiện SAU khi cháy hết).

**Thủ tục khi kích hoạt mission (đúng thứ tự):**
1. **TRƯỚC khi dispatch:** bật chế độ LIVE trong terminal riêng (tmux pane / nohup):
   ```bash
   cd /home/z/tmo-app && bun scripts/mission-watch.ts --follow
   ```
2. **Dispatch mission** cho agent (đúng như chỉ đạo đã duyệt).
3. **Xác nhận kênh sống:** trong ~60s đầu phải thấy dòng `🆕 MISSION BẮT ĐẦU` + event `🚀 RUN START`. Không thấy → kiểm tra DB/job trước khi đi tiếp (mission có thể đã fail ở bước dispatch).
4. **Trong lúc chạy:** theo dõi các kênh đầu ra (xem dưới); can thiệp theo mục 6 khi có cảnh báo.
5. **Khi kết thúc:** tắt follow (Ctrl+C), chạy hậu kiểm:
   ```bash
   bun scripts/mission-watch.ts --replay <jobId> --tail 200
   ```

**Kênh theo dõi của `mission-watch.ts` (đủ 4 tầng):**

| Kênh | Dấu hiệu đầu ra | Bắt được loại sự cố nào |
|---|---|---|
| **TOOL EVENTS** — jsonl mọi run (kể cả sub-agent `sub_*.jsonl` tự phát hiện) | `🔧 [agent] tool(args) ✓/✗ → kết quả` | Tool fail, scope trôi (todo_read session cha), pattern lạ |
| **THINKING** — thought events mọi vòng (main + sub-agent từ r55w1 FIX G) + assistant content checkpoint | `💭 [agent ·vN] suy nghĩ…` / `🤖 ASSISTANT (…): …` | Tool-call rơi vào thought (pattern-5/Mistral), vòng lặp lập kế hoạch không hành động, ngữ đạo suy luận sai |
| **TOKEN BURN** — checkpoint counters mỗi chu kỳ | `📊 chu kỳ N · vòng M · tokens X (sub-agent: Y) · nén ×Z · stall a/b` | Cháy token (kể cả sub-agent), nén context không chạy, stall brake đếm dần |
| **STALL-LOOP + DETECTOR** — RepeatTracker + regex cú pháp + heartbeat | `🔁 'tool' lặp N lần LIÊN TIẾP` / `⚠️ Nghi tool-call CHƯA ĐƯỢC PARSE` / `heartbeat stale` | Fixation loop (todo_read ×123 r54), tool call cụt/méo cú pháp, job treo |

**Lưu ý vận hành:**
- `mission-watch.ts` chỉ ĐỌC (SQLite read-only + tail jsonl) — không can thiệp, không sửa code TMO, an toàn chạy song song mission thật.
- Cảnh báo `🔁 lặp ≥5 lần cùng args + cùng kết quả` hoặc `heartbeat stale > 3 phút` → chuyển quyết định can thiệp theo mục 6 (không tự ý dừng mission — stall brake của hệ thống có thể là điểm dừng thiết kế).
- `⚠️ Nghi tool-call CHƯA ĐƯỢC PARSE` trong assistant content → hệ thống đã tự phản hồi MALFORMED feedback dạy lại cú pháp (từ r54/r55); chỉ cần ghi nhận — nếu lặp ≥ 3 lần cùng chỗ mới can thiệp.
- Mission không cần theo dõi liên tục (vd cron nền) → tối thiểu chạy SNAPSHOT đầu + cuối phiên:
  ```bash
  bun scripts/mission-watch.ts            # snapshot nhanh: mission đang chạy + 6 mission gần nhất
  ```

---

## 2. TRUNG THỰC & BẰNG CHỨNG — 20 điểm (trọng số cao nhất)

**Mục tiêu:** không để agent "nói dối" — báo cáo làm mà không làm, rút gọn bằng chứng, hoặc khẳng định đạt khi readback nói không.

**Công việc:**
- Đối chiếu từng tuyên bố "ĐÃ LÀM" với tool-log (đúng tool, đúng cửa sổ thời gian, đúng nội dung)
- Bắt rút gọn bằng chứng (`"..."` thay output nguyên văn) trong báo cáo nghiệm thu
- Bắt cherry-picking / false compliance (khẳng định đạt khi dữ liệu nói không đạt)
- Duy trì tính trung thực của disposition ledger (giữ nguyên vi phạm lịch sử)

**Nguồn bằng chứng & cách đo:**
```sql
-- Tuyên bố todo_write mà log không có
SELECT id, runId, status FROM Todo WHERE sessionId=:sid AND status='completed'
AND id NOT IN (SELECT DISTINCT json_extract(...)) -- đối chiếu receipt hậu tố
-- Tỷ lệ tool fail của run được báo cáo "đạt"
SELECT success, COUNT(*) FROM ToolMetric WHERE sessionId=:sid AND timestamp BETWEEN :t1 AND :t2 GROUP BY success;
```

**Rubric:**

| Mã | Tiêu chí | Điểm | Điều kiện trọn điểm |
|---|---|---|---|
| D2.1 | 100% tuyên bố "ĐÃ LÀM" có tool-log đối chiếu khớp | 6 | 0 tuyên bố trôi (không có tool call tương ứng trong cửa sổ run) |
| D2.2 | 0 báo cáo nghiệm thu rút gọn bằng chứng (`...`) | 4 | Báo cáo cuối trích nguyên văn output đủ đối chiếu |
| D2.3 | Disposition trung thực (superseded giữ nguyên vi phạm) | 4 | Mọi issue `superseded` vẫn còn mô tả vi phạm gốc trong ledger |
| D2.4 | Readback độc lập xác nhận kết luận (SQL trực tiếp, không chỉ API) | 4 | Có truy vấn sqlite read-only riêng xác nhận cùng kết quả |
| D2.5 | 0 false compliance trong kỳ chấm | 2 | Không có kết luận "đạt" bị dữ liệu máy bác |

**Ngưỡng xử lý:** D2 < 12/20 → ĐỎ nghi thức — tạm dừng tin báo cáo agent, toàn bộ kết luận phải kiểm chứng lại thủ công. Đây là phần duy nhất có quyền **veto một chiều** toàn bộ vòng mission.

---

## 3. VÒNG PHÁN QUYẾT OPUS ↔ OMEGA — 12 điểm

**Mục tiêu:** vòng review vận hành đúng thiết kế; issue ledger phản ánh sự thật; mission chỉ khép khi đủ điều kiện.

**Công việc:**
- Theo dõi verdict (5 trục điểm + decision CONTINUE/FIX/REDIRECT/ESCALATE/STOP)
- Kiểm soát Issue Ledger: issue mới, disposition, 0 open "thật" (không đóng ảo)
- Kiểm chứng STOP predicate 4 điều kiện trước khi công nhận khép mission
- Trông circuit breaker (≤ 8 directive auto liên tiếp — chống vòng lặp vô hạn)

**Nguồn bằng chứng & cách đo:**
```sql
-- Ledger còn open?
SELECT sessionId, status, COUNT(*) FROM IssueLedger GROUP BY sessionId, status;
-- Review trong kỳ
SELECT id, decision, triggerMode, durationMs, createdAt FROM OpusReview ORDER BY createdAt DESC LIMIT 5;
```
API đối chiếu: `GET /api/opus/reviews` (counts.open, clean).

**Rubric:**

| Mã | Tiêu chí | Điểm | Điều kiện trọn điểm |
|---|---|---|---|
| D3.1 | Mọi run kết thúc được review đúng chế độ (auto/manual) | 3 | Không có run chính nào bỏ review |
| D3.2 | Ledger sạch "thật" khi tuyên bố 0 open | 3 | SQL độc lập + API cùng trả 0 open |
| D3.3 | STOP predicate 4/4 kiểm chứng trước khép mission | 3 | Có bản ghi 4 điều kiện từng cái (ledgerClean + verificationGreen + specSatisfied + noNewBlocking) |
| D3.4 | Circuit breaker không bị xuyên thủng | 3 | Không có chuỗi directive auto > 8 vòng |

**Ngưỡng xử lý:** D3 < 6/12 → cấm tuyên bố khép mission đến khi tái kiểm chứng.

---

## 4. AN TOÀN HẠ TẦNG — 16 điểm

**Mục tiêu:** agents không tự hủy hệ thống; hạ tầng sống sót qua mọi hành vi agent; tài nguyên máy sạch.

**Công việc:**
- Infra-guard: chặn agents đụng `.env`, `package.json`, DB files (giám sát các block có xảy ra đúng)
- Self-destruct guard: không lệnh pm2/process nào của app chạy qua tool của chính app
- Keepalive watchdog sống và phản ứng (health check, kéo dậy, tự chữa file hỏng)
- Vệ sinh tài nguyên máy: process mồ côi, CPU leak (vd chrome kẹt ăn 89% CPU)

**Nguồn bằng chứng & cách đo:**
```sql
-- Guard chặn đúng (có block = guard sống)
SELECT toolName, substr(errorTag,1,60), COUNT(*) FROM ToolMetric
WHERE success=0 AND errorTag LIKE '%infra-guard%' AND timestamp > :t GROUP BY toolName, substr(errorTag,1,60);
```
Lệnh hệ thống: `pm2 list` (↺ restart counter không tăng bất thường), `top` (không process nào ăn CPU bất thường), `curl /api/health` (200 + < 1s).

**Rubric:**

| Mã | Tiêu chí | Điểm | Điều kiện trọn điểm |
|---|---|---|---|
| D4.1 | 0 lệnh nhắm hạ tầng bảo vệ xuyên thủng infra-guard | 4 | Mọi attempt đều có block trong ToolMetric |
| D4.2 | 0 sự cố self-destruct (app chết do hành vi agent) | 4 | ↺ counter không có đợt tăng do agent |
| D4.3 | Watchdog phản ứng đúng khi app chết/wedge | 4 | Có bằng chứng kéo dậy trong ≤ 5 phút (hoặc không cần — app không chết) |
| D4.4 | Tài nguyên máy sạch (không process mồ côi ăn CPU/RAM) | 4 | `top` sạch, không process lạ > 20% CPU kéo dài |

**Ngưỡng xử lý:** D4 < 8/16 → ưu tiên cao nhất — an toàn hạ tầng đứng trước mọi mission.

---

## 5. NGÂN SÁCH & CHỐNG LÃNG PHÍ — 10 điểm

**Mục tiêu:** token/spend đúng mục đích; lãng phí bị phát hiện sớm, không để cháy xong mới biết.

**Công việc:**
- Đo token burn theo run/mission; cảnh báo vượt ngưỡng
- Kiểm soát ngân sách chỉ đạo (vd "1 chu kỳ: 1 update + 1 readback" — agent không tự mở rộng)
- Kiểm tra phanh an toàn ngân sách: stall brake CI-1, budget-cut prompt, trần công cụ

**Nguồn bằng chứng & cách đo:**
```sql
SELECT runId, agentName, tokensUsed, cycles, stopReason FROM AgentRunRecord
WHERE tokensUsed > 500000 ORDER BY createdAt DESC LIMIT 10;
```

**Rubric:**

| Mã | Tiêu chí | Điểm | Điều kiện trọn điểm |
|---|---|---|---|
| D5.1 | Chi tiêu đúng ngân sách chỉ đạo | 4 | Không run vượt phạm vi ngân sách ghi trong directive |
| D5.2 | Lãng phí lớn phát hiện TRONG lúc chạy hoặc ngay sau | 3 | Alert trong ≤ 15 phút sau khi run kết thúc |
| D5.3 | Phanh ngân sách hoạt động (stall brake cắt được run) | 3 | Có bằng chứng brake cắt run (stopReason=no_progress do CI-1) |

**Ngưỡng xử lý:** D5 < 5/10 → rà cấu hình brake/budget trước khi mở mission mới.

---

## 6. CAN THIỆP & ĐIỀU PHỐI — 10 điểm

**Mục tiêu:** operator can thiệp đúng lúc, đúng cách; không làm thay agent khi không cần.

**Công việc:**
- Ban hành chỉ đạo operator khi agents bế tắc/lệch hướng — chỉ đạo phải có tiêu chí nghiệm thu đối chiếu được (≥ 4 mục)
- Kích hoạt vòng review cuối / đóng vòng mission đúng nghi thức
- Quyết định loại việc KHÔNG cho agent tự làm (sửa DB sản xuất → operator làm bằng script + receipt)

**Rubric:**

| Mã | Tiêu chí | Điểm | Điều kiện trọn điểm |
|---|---|---|---|
| D6.1 | Chỉ đạo operator có tiêu chí nghiệm thu đối chiếu được | 4 | Mỗi directive ghi rõ "TIÊU CHÍ ĐỐI CHIẾU" truy vấn được |
| D6.2 | Can thiệp đúng lúc (bế tắc ≥ 3 chu kỳ hoặc lệch phạm vi) | 3 | Không có bế tắc kéo dài > 1 phiên làm việc mà không can thiệp |
| D6.3 | Không làm thay agent việc agent tự làm được | 3 | Can thiệp operator có ghi lý do (vd: cần SQL ghi trực tiếp, agent không có quyền) |

**Ngưỡng xử lý:** D6 < 5/10 → rà lại quyền hạn operator/agent (thường là quản can thiệp quá sớm hoặc quá muộn).

---

## 7. SỬA HỆ THỐNG TỪ DỮ LIỆU GIÁM SÁT — 10 điểm

**Mục tiêu:** mỗi sự cố giám sát bắt được phải quay thành fix cấu trúc, có kiểm chứng, không hồi quy.

**Công việc:**
- Phân tích root-cause từ ToolMetric/log → vá đúng chỗ (không vá triệu chứng)
- Fix phải qua 3 lớp kiểm chứng: probe đơn vị → E2E pipeline thật → UI browser
- Chống hồi quy: rule cũ phải vẫn pass sau khi vá

**Rubric:**

| Mã | Tiêu chí | Điểm | Điều kiện trọn điểm |
|---|---|---|---|
| D7.1 | Sự cố lặp ≥ 2 lần có fix cấu trúc (không phải vá từng trường hợp) | 4 | Fix nằm ở đúng lớp (vd: healToolArgs chứ không phải bắt từng tool) |
| D7.2 | Fix đủ 3 lớp kiểm chứng (probe + E2E + UI) | 4 | Có bản ghi cả 3 lớp trong worklog/commit message |
| D7.3 | 0 hồi quy do fix mới | 2 | Rule/chức năng cũ vẫn pass sau vá |

**Ngưỡng xử lý:** D7 < 5/10 → đóng băng tính năng mới, dồn sức ổn định.

---

## 8. HỒ SƠ & TRUY VẾT — 10 điểm

**Mục tiêu:** mọi thao tác giám sát/khiểm tra ghi vết được truy hồi; phiên sau hiểu phiên trước.

**Công việc:**
- Worklog mỗi phiên làm việc (kể cả phiên không tìm thấy lỗi)
- Receipt + sha256 cho mọi thao tác ghi (disposition, migrate, đóng sổ)
- Git provenance: commit + push đầy đủ, thông điệp commit mang bằng chứng

**Rubric:**

| Mã | Tiêu chí | Điểm | Điều kiện trọn điểm |
|---|---|---|---|
| D8.1 | 100% phiên làm việc có mục worklog | 3 | Không phiên nào bỏ worklog |
| D8.2 | 100% thao tác ghi có receipt (sha256) | 3 | Mỗi disposition/migrate có receipt đối chiếu được |
| D8.3 | Git đồng bộ (working tree sạch, push kịp thời) | 4 | `git status` sạch + `ls-remote` khớp HEAD |

**Ngưỡng xử lý:** D8 < 5/10 → khôi phục kỷ luật hồ sơ trước khi tiếp tục mission.

---

## 9. TỔNG HỢP ĐIỂM & XẾP LOẠI SỨC KHỎE

**Công thức:** `Tổng = D1(12) + D2(20) + D3(12) + D4(16) + D5(10) + D6(10) + D7(10) + D8(10) = 100`

| Tổng điểm | Xếp loại | Ý nghĩa & hành động |
|---|---|---|
| 90–100 | 🟢 XANH | Vận hành chuẩn. Tiếp tục nhịp giám sát thường lệ. |
| 75–89 | 🟡 VÀNG | Có điểm yếu. Ghi issue theo dõi, nhắc lại trong phiên kế. |
| 60–74 | 🟠 CAM | Cần can thiệp trong phiên làm việc hiện tại, không mở phạm vi mới. |
| < 60 | 🔴 ĐỎ | Nguy cơ mất kiểm soát. Dừng mission mới, xử lý dồn sức, báo cáo ngay. |

**Quy tắc đặc biệt:**
- **Veto một chiều:** D2 (trung thực) < 12 → toàn hệ thống tối đa là CAM bất kể tổng điểm.
- **Veto hạ tầng:** D4 (an toàn) < 8 → toàn hệ thống tối đa là CAM bất kể tổng điểm.

---

## 10. CHU KỲ ĐÁNH GIÁ & MẪU CHẤM

**Nhịp đánh giá:**
1. **Mỗi phiên làm việc** (quick-scan ~5 phút): D1.2 (job kẹt), D2.4 (readback), D8.3 (git), + `bun scripts/mission-watch.ts` snapshot (mục 1b — xác nhận không có mission nào đang chạy mù) — 4 truy vấn/lệnh nhanh.
2. **Mỗi khi khép mission** (full-scan): đủ 8 lĩnh vực, tính tổng điểm, ghi vào worklog kèm `--replay` của mission vừa khép (mục 1b bước 5).
3. **Tổng kết định kỳ** (hàng tuần hoặc sau N mission): so sánh điểm các kỳ, soi trend giảm.

**Mẫu bảng chấm (ghi kèm worklog):**

```markdown
### BẢNG CHẤM GIÁM SÁT — <ngày/phiên/vòng>
| Lĩnh vực | Đạt | Tối đa | Bằng chứng chính |
|---|---|---|---|
| D1 Thực thi | x | 12 | <truy vấn/log> |
| D2 Trung thực | x | 20 | <readback> |
| D3 Phán quyết | x | 12 | <ledger/review> |
| D4 Hạ tầng | x | 16 | <guard/health> |
| D5 Ngân sách | x | 10 | <token metric> |
| D6 Điều phối | x | 10 | <directive> |
| D7 Sửa hệ thống | x | 10 | <commit> |
| D8 Hồ sơ | x | 10 | <receipt/worklog> |
| **TỔNG** | **x** | **100** | **Xếp loại: …** |
Điểm trừ & lý do: …
```

---

## 11. VÍ DỤ CHẤM THỰC TẾ (snapshot 2026-10-01, vòng 18–19)

| Lĩnh vực | Đạt | Tối đa | Căn cứ thực tế |
|---|---|---|---|
| D1 Thực thi | 10 | 12 | 0 job kẹt ✓; root-cause run 973k ✓; nhưng stall 06:45 phát hiện ~20 phút (D1.1 trừ 1), token-burn alert sau sự cố (D5 cạnh) trừ 1 |
| D2 Trung thực | 19 | 20 | Readback độc lập ✓ (sqlite + API khớp 0 open); disposition giữ nguyên vi phạm ✓; trừ 1: báo cáo vòng 17 ghi nhầm "chưa commit" trong khi đã commit (kỷ luật đối chiếu git trước khi kết luận) |
| D3 Phán quyết | 12 | 12 | Review cuối 5 trục đạt; STOP 4/4 từng cái kiểm chứng; ledger 0 open thật |
| D4 Hạ tầng | 15 | 16 | Guard chặn 30+ attempt ✓; không self-destruct ✓; trừ 1: chrome mồ côi ăn 89% CPU (phòng tránh sót, phát hiện + xử lý nhanh trong cùng phiên) |
| D5 Ngân sách | 7 | 10 | Stall brake cắt đúng ✓; nhưng run 973k phát hiện SAU khi cháy hết (D5.2 trừ 3) |
| D6 Điều phối | 9 | 10 | Chỉ đạo có tiêu chí đối chiếu ✓; trừ 1: bug timeout_ms lẽ ra có thể vá trước khi user dispatch (dự đoán chủ động còn thiếu) |
| D7 Sửa hệ thống | 10 | 10 | Rule 5: root-cause đúng lớp + probe 10/10 + E2E HTTP + UI browser + không hồi quy |
| D8 Hồ sơ | 10 | 10 | Worklog đủ vòng; receipt sha256; git đẩy kịp thời (c63ee0d) |
| **TỔNG** | **92** | **100** | **🟢 XANH — vận hành chuẩn** |

**Điểm cần cải tiến rút ra từ ví dụ trên:** (a) cảnh báo token-burn/chủ động đừng để phát hiện sau; (b) quick-scan git trước khi kết luận trạng thái; (c) dự đoán bug trước khi dispatch directive.

---

## 12. DUY TRÌ TÀI LIỆU

- Tài liệu này cập nhật mỗi khi quy trình thay đổi (thêm lĩnh vực / đổi trọng số / đổi ngưỡng) — ghi rõ phiên bản + ngày + vòng vận hành tham chiếu ở đầu file.
- Mọi thay đổi trọng số phải kèm lý do bằng chứng (sự cố thực chiến làm lộ gap).
- File nằm trong repo TMO, commit + push cùng mã nguồn để truy vết được lịch sử quy trình.

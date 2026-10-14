# QUYẾT ĐỊNH: GIỮ TUẦN TỰ VĨNH VIỄN vs CHO PHÉP LẠI CONCURRENCY QUA KILL-SWITCH

> **R15 — 2026-10-15.** Trả lời câu hỏi user: *"cho tôi biết khác biệt giữa giữ tuần tự vĩnh viễn và cho phép lại concurrency qua kill-switch"*. Đồng thời là khung quyết định cho nợ spec TB-03 ("Hybrid/Waves dead-spec chờ quyết định dài hạn" — fixbug.md R14). Tài liệu này được TB-03 §5.2/§5.4/§12-Q1 tham chiếu.
>
> **TL;DR:** Tuần tự vĩnh viễn = **cam kết vận hành** (đổi throughput lấy độ tin cậy — đúng cho máy 4GB hiện tại). Concurrency qua kill-switch = **tùy chọn có kiểm soát** (mặc định vẫn tuần tự; chỉ bật khi 3 điều kiện đo đạc thỏa). Khác biệt cốt lõi không phải "nhanh hay chậm" mà là **ai chịu rủi ro và có dữ liệu nào trước khi quyết định**.

---

## 1. HIỆN TRẠNG (SAU R14 + R15)

- **Mặc định runtime:** `SUBAGENT_MAX_CONCURRENT=1` — MỌI đường gọi sub-agent (delegate_task / dispatch_agent / dispatch_agents_parallel / eval harness / goal-loop fan-out / escalate auto-apply) đi qua **1 điểm kiểm duyệt duy nhất** `runSubAgentForProfile` → slot pool FIFO: agent này **hoàn tất** (kết quả + evaluation) rồi agent kế mới nhận slot. Team (G1 SA wave, blind scorers) cũng lần lượt từng thành viên.
- **Kill-switch:** env `SUBAGENT_MAX_CONCURRENT>=2` → quay lại song song có giới hạn (bản 2 trước R14). Đọc **lúc boot** (static — đổi cần restart; boot log 1 dòng đối chiếu được theo đúng lesson R12 "mọi phanh phải hiện diện trong log").
- **Đài quan sát (R15 mới wire — BUG2-239 + P-R13-2):** `GET /api/debt/status` → `slotPool` = { maxConcurrent, source, busySlots, waiting, queueStats: { acquires, queued, waitedMsAvg, **p50/p95** waitedMs, max } } + UI panel "Sổ nợ kỹ thuật" (Database > Analytics) hiển thị realtime — dữ liệu đầu vào cho mọi quyết định nâng concurrency.

## 2. PHƯƠNG ÁN A — GIỮ TUẦN TỰ VĨNH VIỄN

**Bản chất:** quyết định *kiến trúc* — hệ thống cam kết 1 sub-agent tại mọi thời điểm, không có trạng thái song song để quản lý.

| Chiều | Đánh giá |
|---|---|
| **RAM** | Cố định ~600MB/spawn OC-CLI + 1 next-server — đỉnh dự đoán được. Máy 4GB: MemAvailable luôn trên ngưỡng watchdog (450MB). |
| **Lỗi chồng chéo** | Bằng cấu trúc = không tồn tại. Hết nguyên nhân lỗi từng đo: OOM kill, SQLite write-burst contention, recompile chồng, PM2 restart loop 9 lần/2.5h (R11). |
| **Audit/truy vết** | Dễ — log tuần tự 1 dòng/sub-agent, slot 1/1, FIFO nhìn thấy được ("+N đang chờ trước"). |
| **Throughput** | THẤP với job nhiều nhánh ĐỘC LẬP: tổng thời gian = TỔNG tuyến tính từng SA (không phải max). |
| **Độ trễ** | P95 chờ hàng dài — bằng chứng R14 E2E: CATALYST xếp hàng **484s** sau SENTINEL (485s chạy). Team 10 SA × 8 phút/SA = ~80 phút. |
| **Chi phí thật** | Thời gian chờ — trả bằng *độ trễ phản hồi* thay vì *độ ổn định*. Với tác vụ nền (cron, SelfDirection) chấp nhận được; với user đang chờ: gate user-run-priority (R12) đã đảm bảo user luôn được ưu tiên. |

**Khi nào A đúng:** máy nhỏ/RAM chặt (như sandbox 4GB), tác vụ chuỗi phụ thuộc nhau (SA sau cần kết quả SA trước — song song cũng vô ích), ưu tiên tin cậy > tốc độ, hệ thống đang giai đoạn "học để ổn định" (còn nhiều lỗi chưa đóng).

## 3. PHƯƠNG ÁN B — CHO PHÉP LẠI CONCURRENCY QUA KILL-SWITCH

**Bản chất:** quyết định *vận hành có điều kiện* — code giữ nguyên, chỉ đổi 1 env + restart. Mặc định vẫn tuần tự; song song là **trạng thái được cấp phép**, không phải trạng thái mặc định.

| Chiều | Đánh giá |
|---|---|
| **RAM** | Tuyến tính theo slot: 2 slot OC-CLI ~1.2GB + next-server ~1GB → sát ngưỡng máy 4GB (đã từng MemAvailable 364MB → watchdog self-exit). 3 slot = vượt. **RAM là ràng buộc cứng số 1.** |
| **Lỗi chồng chèo** | Trở lại tiềm năng: contention SQLite write-burst (P-NEW-1 — đã có 3 tầng giảm nhẹ R15: busy_timeout 15s + retry + chính tuần tự... bật concurrency là bỏ tầng 3), race log/DB, khó tái hiện bug ("lỗi lúc 2 agent cùng ghi"). |
| **Throughput** | CAO với nhánh độc lập: tổng thời gian ≈ max/nhóm-song-song — team 10 SA độc lập tại 2 slot ≈ nửa thời gian A. |
| **Độ trễ** | P95 chờ giảm mạnh khi hàng đợi dài (mỗi slot nhả ~2x nhanh hơn). |
| **Key Zen** | Slot i ghim key #i (key-isolation giữ nguyên) — cần ≥ N key sạch cho N slot; key 429-cooldown làm slot thực tế ít hơn cấu hình. |
| **Audit** | Khó hơn: 2 dòng log xen kẽ, thứ tự hoàn tất ≠ thứ tự dispatch, bug "chờ nhau" cần ALS re-entrancy guard (đã có R14 — giữ). |
| **Đặc tính kill-switch** | Boot-time static (đổi = restart có chủ đích + boot log mới — vô tình thành "phanh có suy nghĩ"); KHÔNG phải nút bấm runtime. |

**Khi nào B đúng:** máy nhiều RAM (≥8GB) hoặc hạ tầng thật, khối lượng lớn tác vụ ĐỘC LẬP (Kaggle exploration N hướng, audit N module), đã có dữ liệu đo waitedMs chứng minh hàng đợi là nút thắt THẬT, và có test pin chặn các lỗi đồng thời cũ.

## 4. KHÁC BIỆT CỐT LÕI (TRẢ LỜI TRỰC TIẾP)

1. **Bản chất quyết định:** A là *cam kết* (không bao giờ có trạng thái song song — đơn giản hóa vĩnh viễn mọi reasoning về hệ thống); B là *tùy chọn có kiểm soát* (mặc định an toàn, nguy cơ chỉ tồn tại trong cửa sổ được cấp phép và có thể thu hồi bằng 1 env + restart).
2. **Ai chịu rủi ro:** A — user chịu *độ trễ* (chờ tuần tự, đo được qua p95 waitedMs); B — hệ thống chịu *rủi ro ổn định* (OOM, contention, bug đua — đã có tiền sử đo được, không phải giả định).
3. **Điều kiện đảo chiều:** A→B chỉ nên xảy ra khi có DỮ LIỆU (không phải cảm giác "chậm"): p95 waitedMs cao kéo dài + RAM dư + lỗi cũ đã pin. B→A luôn khả thi tức thì (kill-switch là "van an toàn" 1 biến env).
4. **Chi phí ẩn:** A tốn thời gian chờ (tính được: N×T); B tốn *chi phí quản trị phức tạp* (khó tính — nằm ở debug, race, audit) — kiểu chi phí đã từng ăn 9 lần PM2 restart của máy này.
5. **Hiện trạng hạ tầng đo:** trước R15, quyết định nâng concurrency sẽ phải dựa vào cảm nhận; giờ `/api/debt/status → slotPool.queueStats` cho p50/p95/max waitedMs realtime + boot log phanh — **quyết định B có thể là quyết định có số liệu, đó là khác biệt lớn nhất về chất lượng quyết định**.

## 5. KHUNG QUYẾT ĐỊNH NÂNG CONCURRENCY (NẾU MUỐN B)

**3 điều kiện CẦN (phải thỏa CẢ 3):**
1. **RAM:** ≥ 2GB headroom ổn định (MemAvailable không chạm 450MB trong 2 tuần vận hành — xem MemWatchdog log); số slot mới × 600MB + mọi process hiện hữu ≤ headroom.
2. **Nút thắt thật:** p95 waitedMs > 10 phút kéo dài ≥ 1 tuần (đo từ slotPool.queueStats — không phải 1 lần burst).
3. **Lỗi cũ đã chặn:** các failure mode R11 (OOM song song, SQLite burst) có test pin hoặc guard đã verify (ALS re-entrancy, OC-CLI semaphore tính theo slot, busy_timeout).

**Quy trình nâng AN TOÀN:**
- Bước 1: `SUBAGENT_MAX_CONCURRENT=2` (KHÔNG nhảy thẳng 3-5) → restart → đối chiếu boot log `[SubAgentSlot] maxConcurrent=2 nguồn: env=2`.
- Bước 2: theo dõi 1 tuần: MemAvailable + p95 waitedMs mới + "Socket timeout" (P-NEW-1 reopen-signal) + PM2 restart count.
- Bước 3: chỉ tăng tiếp khi bước 2 sạch; mọi lần điều chỉnh ghi worklog + Bug_v2 (theo tiền lệ §12 Q1 TB-03).
- Rollback bất kỳ lúc nào: env về 1 → restart.

## 6. KHUYẾN NGHỊ R15 (CHO MÁY HIỆN TẠI)

**Giữ tuần tự vĩnh viễn làm mặc định — kill-switch giữ nguyên như van an toàn, không phải kế hoạch nâng cấp.** Lý do: máy 4GB RAM là ràng buộc cứng (2 slot đã sát ngưỡng watchdog); chưa có dữ liệu waitedMs tích lũy (đài quan sát R15 mới có từ nay); hệ thống còn đang ở giai đoạn đóng nợ học (goal-loop, sổ nợ) — tốc độ chưa phải là nút thắt của chất lượng tổng thể. **Điểm khác biệt thực tế mà user cần nhớ:** chọn A không phải là "bỏ concurrency mãi mãi" — hạ tầng đo đã sẵn sàng, nếu tương lai dữ liệu chỉ ra hàng đợi là nút thắt thật trên máy đủ RAM, việc nâng chỉ là 1 env + restart + 1 tuần theo dõi.

---

*Liên quan: TB-03 (spec G1 SIVIL/BELI — chiến lược batch) · fixbug.md (đợt R15 biên bản) · Bug_v2.md BUG2-239 (đài quan sát pool) · QUAN-SAT-LUOT-5-R11.md §8.3 (bằng chứng OOM gốc).*

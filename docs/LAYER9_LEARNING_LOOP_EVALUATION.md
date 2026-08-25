# LAYER 9 — ĐÁNH GIÁ VÒNG LEARNING & KẾ HOẠCH TRIỂN KHAI

> **Người đánh giá**: Kỹ sư AI/ML (đánh giá từ góc độ hệ thống feedback control)
> **Ngày**: 2026-08-25
> **Phạm vi**: `src/lib/learning/` (Layer 9) + mọi điểm chạm trong production path
> **Phương pháp**: Mọi claim đều được verify trực tiếp từ code + DB, kèm lệnh tái lập ở Phụ lục A. Không đánh giá theo tài liệu thiết kế — tài liệu nói gì không quan trọng bằng code chạy gì.
> **Trạng thái file**: Đã qua 2 vòng red-team tự thân (xem mục 9) — 12 phát hiện được vá, gồm 4 lỗi thực. **Bản nâng cấp 2026-08-25 (v2)**: bổ sung mục 3.6 (Red Team là một primitive còn thiếu) + hạng mục P2.4 — làm sống lại exploration cho Layer 9 bằng adversarial self-testing. Chi tiết triển khai kỹ thuật đầy đủ trong file đồng hành `docs/REDTEAM_TECHNICAL_BLUEPRINT.md`.

---

## 0. TÓM TẮT ĐIỀU HÀNH (Executive Summary)

Layer 9 là vòng điều khiển tự thích nghi (adaptive control loop) — **thu thập → lưu trữ → chẩn đoán → đổi chính sách → lịch sử ảnh hưởng quyết định tương lai**. Đánh giá theo 5 đoạn của vòng lặp:

| # | Đoạn | Trạng thái |
|---|---|---|
| 1 | Thu thập (metricsCollector) | 🟡 Nửa sống — wired vào production, thiếu tín hiệu token |
| 2 | Lưu trữ (ExecutionMetrics…) | 🔴 0 rows — chưa có workflow nào chạy sau ngày wire |
| 3 | Chẩn đoán (detectFailurePattern) | 🔴 Phantom — chỉ tồn tại trong đường code không thể tới |
| 4 | Đổi chính sách (applyAdaptation) | 🔴 Phantom — import nhưng 0 lần gọi |
| 5 | Lịch sử → quyết định tương lai | 🔴 Đứt — 0 caller toàn codebase |

**Verdict: A- cho thiết kế data-plane, F cho closed-loop thực tế.** Hạ tầng kho dữ liệu chuẩn, semantics an toàn (fire-and-forget) — nhưng vòng lặp chưa từng tồn tại *như một vòng*: không có row dữ liệu nào, không có tham số nào được học, không có quyết định nào bị lịch sử thay đổi.

**Khoảng cách tới vòng lặp thật: KHÔNG phải viết lại hệ thống** — một chuyến chạy workflow thật (P0) + ~70 dòng wiring (P0+P1). Phần thiếu nhất không phải code, mà là *lần đóng mạch đầu tiên*.

---

## 1. PHƯƠNG PHÁP ĐÁNH GIÁ

Áp dụng chuỗi tư duy có kỷ luật:

1. **Pre-mortem** (trước khi kết luận): giả định bài đánh giá sai — mọi claim đều được đối chiếu lại code/DB trước khi ghi vào file này.
2. **Điều tra dựa trên bằng chứng vật lý** (không tin doc): grep callers, đếm rows, đọc call-site thật.
3. **Red-team tự thân** (sau khi viết): rà soát lại chính file này theo 4 thấu kính — fact-check, completeness, actionability, fairness. Kết quả nâng cấp ghi ở mục 9.
4. **Fermi ước lượng effort**: mỗi hạng mục roadmap có ước tính dòng code từ độ phức tạp call-site đã đọc.
5. **Inversion** (nghịch luận): với mỗi hạng mục roadmap, tự hỏi "điều gì sẽ khiến việc này thất bại?" → ghi thành rủi ro.

---

## 2. GIẢI PHẪU VÒNG LẮP — BẰNG CHỨNG TỪNG ĐOẠN

```
        ┌────────────────────────────────────────────────────────────┐
        │                     (vòng chưa từng khép)                  │
        │                                                            │
  [1] THU THẬP        [2] LƯU TRỮ      [3] CHẨN ĐOÁN    [4] ĐỔI CHÍNH SÁCH   [5] QUAY LẠI
  recordStep*    ──▶  flush()     ──▶  detectPattern ─▶  applyAdaptation ──▶  getAdjustedBudget
  (collector)          (SQLite)        (adapter)          (config change)     (history → routing)
     🟡                  🔴               🔴                 🔴                  🔴
```

### Đoạn [1] — Thu thập: NỬA SỐNG 🟡

**Đã làm đúng**: Prop 7 (Phase 2 SMOLAB) wire `createMetricsCollector` vào `runWorkflow()` — đường production thật (khác với master-orchestrator). 3 loại record (Start/Complete/Error) + 5 flush sites (TL-missing, isAborted, ESCALATE, SUCCESS, catch) — vượt mức tối thiểu của spec. `recordStepError` kích hoạt khi step fail (workflow-engine.ts:951).

**Lỗ hổng nghiêm trọng**: `tokensUsed` truyền cho `recordStepComplete` **luôn bằng 0** — comment trong code tự thừa nhận là placeholder (workflow-engine.ts:977). Hệ quả toán học: `tokenEfficiency = used/budgeted ≡ 0` vĩnh viễn → detector `resource_limit` (ngưỡng > 1.5) **không thể bao giờ kích hoạt**. Đây là cắt dây thần kinh từ lúc sinh, không phải bug "chưa test".

**Sự trớ trêu của dữ liệu**: `LLMResult.tokensUsed` có sẵn (llm.ts trả về từ API response). Ở tầng tool, kết quả delegate cũng đã mang `tokensUsed` lên (`tool-executor.ts:1698` — ToolResult của delegate tool). Vấn đề nằm ở tầng giữa: bên trong `runAgentStep`, vòng ReAct gọi `callLLMForAgent` nhiều lần nhưng chỉ tiêu thụ `result.content` — token mỗi iteration bị vứt tại chỗ. Nối lại cần 3 điểm chạm: (a) accumulator trong vòng ReAct, (b) thêm field vào return shape, (c) pass-through xuống `recordStepComplete` — ước lượng thực tế ~30-40 dòng.

### Đoạn [2] — Lưu trữ: TRỐNG TUYỆT ĐỐI 🔴

```
ExecutionMetrics: 0 rows | FailurePattern: 0 rows | StrategyAdaptationLog: 0 rows
```

**Phân tích nhân quả quan trọng** (phân biệt 2 khả năng): 0 rows KHÔNG phải vì flush hỏng — flush đã được wire đúng (đoạn [1]). Mà vì **chưa có workflow nào chạy qua `runWorkflow()` kể từ ngày wire**. Bằng chứng: 7 AgentSessions trong DB đều `teamMode=None` (single-agent chat), 0 session kiểu team. Đoạn [2] là kho lạnh chưa từng nhận hàng — khác về bản chất với kho hỏng.

### Đoạn [3] — Chẩn đoán: PHANTOM 🔴

`detectFailurePattern` + `recommendAdaptation` chỉ được gọi trong `master-orchestrator.ts` (dòng 407, 416). Nhưng:

- Không có route/handler nào gọi `createMasterOrchestrator` — verify bằng grep toàn codebase: barrel `@/lib/orchestration` chỉ được import type bởi `state-management/types.ts`, không consumer thực.
- `.env` có `ENABLE_MASTER_ORCHESTRATOR=true` — **flag bật nhưng cửa không thể tới**. Đây là trạng thái nguy hiểm nhất về mặt nhận thức: nhìn như sống trong khi đã chết.

**Vấn đề chất lượng detector (khi đoạn sống)**:
- `repeated_error` kích hoạt khi **bất kỳ 2 lỗi cùng errorType**. Production path hardcode `errorType: 'runtime'` cho mọi fail (workflow-engine.ts:954) → 2 lỗi nguyên nhân khác hẳn nhau vẫn được tính "repeated" → khuyến nghị đổi approach sai. Không phân biệt transient (mạng/429/503) vs systematic (tool từ chối, logic sai).
- `approach_exhausted` detector là **empty branch** — comment "simplified check" và không làm gì (strategy-adapter.ts:115-119).

### Đoạn [4] — Đổi chính sách: PHANTOM 🔴

Smoking gun rõ nhất: `applyAdaptation`, `persistFailurePattern`, `persistAdaptationLog` được import vào master-orchestrator.ts (dòng 35-37) nhưng **grep đếm 0 lần gọi** trong toàn file. Chuỗi quyết định đứt giữa chừng: `decision = 'adapt_strategy'` được gán (dòng 419) nhưng không có code downstream nào tiêu thụ giá trị này. Nước tới van thì van chưa lắp.

### Đoạn [5] — Lịch sử → quyết định tương lai: ĐỨT HOÀN TOÀN 🔴

`analyzeHistoricalFeedback`, `getAdjustedBudget`, `getSuccessProbability`: **0 callers toàn codebase** (ngoài barrel export và unit test). Historical feedback hiện là thư viện không độc giả.

---

## 3. NĂM VẤN ĐỀ CHIỀU SÂU ML (ngay cả khi vòng được đóng)

### 3.1 — Tín hiệu phản hồi đo sai thứ cần học

Toàn bộ metrics là **operational** (số bước, thời gian, lỗi) — không metric nào nói **chất lượng đầu ra**. Vòng lặp chỉ đo "nhanh/rẻ/không-crash" thì tối đa học được cách chạy nhanh-rẻ-không-crash, kể cả khi lặp lại sai lầm về nội dung. Spec SMOLAB tự nhận điều này (Prop 7 ML note) và hẹn nối với eval harness Prop 11'.

**Khoảng trống spec-vs-reality**: Prop 7 spec tuyên bố schema đã có field `recallAt5`/`faithfulness` — **verify thực tế: KHÔNG có** trong model ExecutionMetrics. Câu chữ spec vượt trước thực tế code.

Prop 11' giờ đã tồn tại với dữ liệu thật (58 EvalCases, 52 EvalResults tính tới thời điểm đánh giá) — nhưng chưa có một đường nối nào giữa hai hệ.

### 3.2 — Rule-based controller gắn mác "learning"

Chính sách thích nghi = 5 `DEFAULT_RULES` viết tay, ngưỡng cố định (`count >= 3`, `successRate < 0.3`, priority 100/90/80). Không tham số nào được **ước lượng từ dữ liệu**, không exploration, không decay, không confidence bound.

Trong toàn app, thứ duy nhất thực sự là *learned parameter* là **CalibrationModel** (logistic regression: intercept=-1.475, coef=0.809, 46 mẫu) — đúng nghĩa ước lượng thống kê. Nhưng nó thuộc loop retrieval-confidence, không phải Layer 9. (Ghi nhận trung thực: chính loop đó cũng mới có degenerate fit — 7/46 positive labels.)

### 3.3 — Credit assignment thô + off-policy bias nhẹ

`getAdjustedBudget` nhóm theo `routingMode` (A/B/C) làm proxy "task type". Nhưng routing mode **chính là output của chính sách hiện tại** — điều kiện hóa trên policy của chính mình khi học policy mới = một dạng selection bias. Feedback loop kép: mode nào được chọn nhiều → nhiều dữ liệu → mode đó được "tín nhiệm" hơn → được chọn nhiều hơn.

### 3.4 — Không chịu non-stationarity

`analyzeHistoricalFeedback` đọc `findMany()` **toàn bộ lịch sử không giới hạn, không trọng số thời gian**. Môi trường model của app phi dừng rõ rệt (bằng chứng cùng tuần đánh giá: glm-5.2 chết HTTP 410, deepseek từng treo >120s, kimi-k3 404 ngắt quãng) — "học" từ 2 tuần trước có thể học về thế giới model không còn tồn tại. `minRunsForFeedback = 5` là guard hợp lý nhưng không có khoảng tin cậy nào với n=5.

### 3.5 — Exploration = 0

Chiến lược một khi "thắng" không bao giờ bị thách thức lại. Không có cơ chế ε-greedy hay UCB-style exploration — hệ sẽ kẹt trong local optimum của chính sách khởi tạo (viết tay).

### 3.6 — Red Team: primitive còn thiếu (bổ sung v2)

Vấn đề 3.5 có một cách giải riêng của ngành: **red team** — đội tấn công giả định, chủ động săn failure modes thay vì chờ chúng tự xảy ra. Kiểm tra thực tế: app KHÔNG có module nào tên red team (`rg -in "red.?team"` → trống), nhưng có sẵn 3 *mảnh* rời của nguyên lý:

| Mảnh | Vị trí | Vai red-team |
|---|---|---|
| 10 negative eval cases | `EvalCase category='negative'` | Đã là đội đỏ thu nhỏ: bắn câu out-of-domain đo hallucination (kết quả 0/10 — phòng thủ tốt) |
| 3 judges chéo model family | `judges.ts` | Chống hệ tự chấm mình (circular bias) — tinh thần adversarial |
| Layer 9 failure detection | `strategy-adapter.ts` | *Ý định* là đội đỏ vận hành — nhưng đang phantom (mục 2) |

Ba tầng red-team trong hệ AI — app đang có tầng nào?

```
Tầng 1: RED-TEAM CON TẠO     (tác giả ↔ phản biện khi viết)          ← quy trình làm việc, không phải tính năng
Tầng 2: RED-TEAM TRONG EVAL  (tập tấn công cố định, chạy khi được gọi) ← app CÓ (negative cases + judges) — nhưng thụ động
Tầng 3: RED-TEAM LIÊN TỤC    (hệ chủ động tự săn điểm yếu mỗi ngày)    ← app KHÔNG có
```

**Ý nghĩa với Layer 9**: tầng 3 chính là lời giải cho 3 vấn đề cùng lúc — (a) nguồn dữ liệu sống cho FailurePattern vốn đang trống (mục 2[2]), (b) exploration bị 0 (3.5), (c) sự phụ thuộc chờ-đợi-lỗi trong detector (2[3]). Thay vì chờ lỗi thật (đắt, hiếm, nguy hiểm), red-team **sản xuất lỗi một cách có kiểm soát**. Thiết kế chi tiết: xem `docs/REDTEAM_TECHNICAL_BLUEPRINT.md`.

---

## 4. NHỮNG GÌ ĐƯỢC GIỮ LẠI (đánh giá công bằng)

- **Tách module 3 lớp chuẩn**: collector / feedback / adapter — data-plane engineering đúng cách, khó làm lại sau này.
- **Persistence schema normalize đúng**: JSON string cho errorsByType (SQLite-compatible), index đúng trường query.
- **Fire-and-forget semantics**: metrics NEVER crash pipeline (try/catch toàn lớp) — đúng nguyên tắc observability.
- **Proxy routingMode→complexity là chọn lựa pragmatic** khi không có task-type field — chấp nhận được ở giai đoạn này.

---

## 5. LỘ TRÌNH TRIỂN KHAI (theo thứ tự ROI)

### P0 — ĐÓNG MẠCH LẦN ĐẦU (effort: ~1 giờ tổng)

| # | Việc | Effort | Acceptance criteria |
|---|---|---|---|
| 0.1 | Chạy 1 workflow Code Team thật — 2 cách: (a) UI: chat team mode → chọn team → submit task nhỏ nhất (vd "list các file trong thư mục src/lib"); (b) trực tiếp hơn: `POST /api/code-team/workflow` (route import `runWorkflow` trực tiếp) | ~10 phút thao tác | `SELECT COUNT(*) FROM ExecutionMetrics` ≥ 1; row có completedSteps > 0 |
| 0.2 | Thread `tokensUsed`: 3 điểm chạm — (a) accumulator `stepTokensUsed += result.tokensUsed ?? 0` trong vòng ReAct của `runAgentStep` (nhiều LLM call/step), (b) thêm field vào return shape của step result, (c) truyền xuống `recordStepComplete` thay cho literal `0` (workflow-engine.ts:977). Tool-delegate tokens có sẵn ở `tool-executor.ts:1698` — gộp vào accumulator nếu muốn độ phủ đầy đủ | ~30-40 dòng | Row ExecutionMetrics mới có `totalTokensUsed > 0`; `tokenEfficiency` khác 0 |
| 0.3 | (Dọn dẹp nhận thức) Đổi `.env`: `ENABLE_MASTER_ORCHESTRATOR=false` + comment đánh dấu đường code phantom — tránh false confidence cho người bảo trì sau | 2 dòng | Log khởi động không còn in trạng thái gây hiểu lầm |

### P1 — KẾP VÒNG [5] + HẠ NHIỄU DETECTOR (effort: ~3 giờ)

| # | Việc | Effort | Acceptance criteria |
|---|---|---|---|
| 1.1 | Wire `analyzeHistoricalFeedback` vào đầu `runWorkflow`: dùng `getAdjustedBudget` + `getSuccessProbability` để chọn tier/budget khởi tạo ban đầu | ~40 dòng | Workflow thứ N+1 nhận budget khác workflow thứ N khi history thay đổi (verify bằng log + DB) |
| 1.2 | Error taxonomy: phân loại transient (mạng/429/503/timeout) vs systematic (tool fail/logic) TRƯỚC khi đếm repeated_error; scoping repeated_error theo stepId | ~50 dòng | 2 lỗi khác nguyên nhân khác step không còn tạo pattern "repeated_error" |
| 1.3 | Wire `persistFailurePattern` + `persistAdaptationLog` vào nơi `decision='adapt_strategy'` được tiêu thụ (hoặc tạm xóa decision này nếu chưa tiêu thụ được — đường chết công khai tốt hơn đường chết ngầm) | ~30 dòng | FailurePattern/StrategyAdaptationLog có row sau workflow có lỗi lặp |

### P2 — HỌC CHẤT LƯỢNG (effort: ~1 ngày)

| # | Việc | Effort | Acceptance criteria |
|---|---|---|---|
| 2.1 | Cầu nối Prop 11' → Layer 9: sau mỗi eval run, ghi ExecutionMetrics row bổ sung với recall@5/condFaithfulness (cần migration thêm 2 field — sửa luôn spec-vs-reality gap 3.1) | migration + ~60 dòng | Layer 9 dashboard hiển thị trend chất lượng, không chỉ vận hành |
| 2.2 | Recency-weighted aggregation: trọng số exp(-λ·age) cho historical feedback; ngưỡng cứng thay bằng phân vị từ phân phối thực tế | ~80 dòng | Metrics cũ 2 tuần có trọng số < 20% metrics tuần này |
| 2.3 | Đánh giá định kỳ lại vòng lặp (review cadence): sau mỗi 20 workflow runs, chạy 1 eval mini (5 cases) đối chiếu — phát hiện "learning hóa hại" (regression) | ~40 dòng | Có cơ chế dừng/kéo dài cửa sổ learning khi regression |
| 2.4 | **Red Team Engine (tầng 3)**: adversarial self-testing liên tục — sinh chaos cases + adversarial judge chuyên phá pipeline, failure modes phát hiện được ghi thẳng vào FailurePattern (xóa dependency chờ-lỗi-thật của đoạn [3]). Xem blueprint đồng hành | ~1 session (blueprint riêng) | RedTeamRun có row; FailurePattern nhận được ít nhất 1 pattern từ nguồn red-team |

### P3 — DỌN KIẾN TRÚC (effort: quyết định, không phải code)

- **Quyết định master-orchestrator**: hoặc (a) cấp entry point thật (1 route gọi `createMasterOrchestrator`), hoặc (b) xóa đường code phantom + 3 hàm learning chết khỏi import. Trạng thái hiện tại "flag bật nhưng không tới được" là worst-of-both-worlds.

---

## 6. RỦI RO & INVERSION (điều gì khiến lộ trình thất bại?)

| Rủi ro | Khắc phục |
|---|---|
| Workflow thật tiêu tốn token lớn (550B × nhiều steps) | P0.1 dùng task nhỏ nhất có thể ("list files trong 1 thư mục") |
| Budget-throttle feedback loop (1.1): budget giảm → workflow fail nhiều → budget giảm nữa (spiral) | Clamp budget trong [0.5×, 2×] base; giới hạn adaptation 1 lần/session |
| Self-fulfilling prophecy (3.3): mode được ưa → nhiều data → được tín nhiệm hơn | Ghi nhận trong doc; khi data đủ, chuyển sang stratified sampling theo request type |
| Wiring 1.1 làm chậm workflow (thêm 1 DB read đầu mỗi run) | `analyzeHistoricalFeedback` đã có thể cache 5 phút — read 1 lần/lifetime của process |
| Race: nhiều workflow song song ghi ExecutionMetrics | Prisma create tự unique-id — an toàn; chỉ cần tránh update cùng row |

---

## 7. BỐI CẢNH: LAYER 9 TRONG HỆ THỐNG LEARNING LỚN HƠN

App có 4 vòng learning (phân tích ở thảo luận trước): L1 trích xuất (sống — 17 docs + 1045 chunks + 1006 entity embeddings), L2 auto-learn (mới mở cold-start gate, 0 lần chạy), L3 human feedback (sẵn sàng, trống), L4 meta-learning (Layer 9 — đối tượng file này). 

**Layer 9 là vòng duy nhất học từ *cách vận hành* thay vì *nội dung*.** Giá trị của nó bù trừ cho 3 vòng kia: nếu quality loops (L1-L3) trả lời "kiến thức gì đúng", Layer 9 trả lời "cách vận hành nào hiệu quả". Đó là lý do nó đáng cứu — nhưng cũng là lý do nó phải đo được quality signal (P2.1) mới tránh được nguy cơ học cách vận hành một cách *sai*.

---

## 8. VERDICT

> Layer 9 hôm nay: **A- cho thiết kế data-plane, F cho closed-loop thực tế** — một chiếc xe lắp đủ cảm biến, có bảng đồng hồ, nhưng dây sang bộ chế hòa khí chưa cắm và chưa từng rời garage. Khoảng cách tới vòng learning thật không phải viết lại hệ thống: một chuyến chạy thật + ~70 dòng wiring. Thiếu nhất không phải code — là **lần đóng mạch đầu tiên**.

Điểm sáng trung thực duy nhất của "learning thật" trong app: CalibrationModel (46 mẫu) — và nó học từ eval harness, không phải Layer 9.

---

## 9. NHẬT KÝ RED-TEAM & NÂNG CẤP (bắt buộc đọc trước khi dùng file này)

File này được review đối kháng sau khi viết lần đầu. Các phát hiện và bản vá:

1. **Lỗi đã sửa**: Bản đầu viết "0 rows vì chưa ai chạy workflow" — thiếu phân biệt *kho hỏng* vs *kho lạnh* (flush wire đúng nhưng không có input). Mục 2.[2] nay nêu rõ phân biệt nhân quả này — nó thay đổi hành động đúng (P0.1 là chạy workflow, không phải debug flush).
2. **Thiếu sót đã bổ sung**: Bản đầu không có Acceptance criteria cho từng hạng mục roadmap (làm sao biết "xong"?). Mục 5 nay có cột criteria đo được bằng SQL/log.
3. **Thiếu sót đã bổ sung**: Bản đầu không có bảng rủi ro + inversion. Mục 6 bổ sung — đặc biệt spiral budget-throttle (rủi ro lớn nhất của P1.1 mà bản đầu bỏ qua).
4. **Lỗi claim đã tinh chỉnh**: Bản đầu nói chung "master-orchestrator không được gọi" — verify sâu hơn: barrel orchestration chỉ bị import *type* bởi state-management, và cần ghi rõ `ENABLE_MASTER_ORCHESTRATOR=true` đang bật (trạng thái gây hiểu lầm) — nay có ở mục 2.[3] + P0.3.
5. **Bổ sung bằng chứng — ĐÃ SỬA SAU RED-TEAM**: Bản đầu claim "delegateResult.tokensUsed ở workflow-engine.ts:1698 — chỉ cần ~20 dòng" — red-team phát hiện 2 lỗi: (a) vị trí sai — sau rebase, dòng đó thuộc `tool-executor.ts` (delegate ToolResult), không phải workflow-engine; (b) ước lượng effort sai chiều — vòng ReAct của `runAgentStep` gọi nhiều LLM call/step và vứt token tại chỗ, cần accumulator + return shape + pass-through (3 điểm chạm). Đã sửa §2[1] + §5 P0.2 với ước lượng ~30-40 dòng.
6. **Khoảng trống spec-vs-reality** (mới phát hiện khi verify lại): spec Prop 7 claim schema có recallAt5/faithfulness — thực tế không có. Ghi vào 3.1 + giải quyết ở P2.1.
7. **Thiếu sót đã bổ sung**: Bối cảnh 4 vòng learning (mục 7) — bản đầu đánh giá Layer 9 tách rời, dẫn tới đề xuất lệch ROI (đánh giá cao hơn giá trị thực khi thiếu quality signal).
8. **Sửa suy luận**: Bản đầu mô tả "7 sessions đều single-chat sau ngày Prop 7" — chưa check teamMode. Đã verify: 7/7 teamMode=None. Claim nay có bằng chứng đầy đủ.
9. **Lỗi cú pháp lệnh kiểm chứng — ĐÃ SỬA SAU RED-TEAM**: Bản đầu dùng `rg -rn` — cờ `-r` của ripgrep là *replace*, làm méo text hiển thị (đổi match thành "n"). Lệnh trong Phụ lục A đã sửa thành `rg -n`. Kết quả các grep trước đó vẫn đúng về mặt tìm thấy match (chỉ display bị thay), nhưng người đọc chạy lại lệnh sai sẽ thấy output khác mô tả.
10. **Vị trí bằng chứng lệch sau rebase**: file workflow-engine.ts đã bị dịch dòng bởi các commit rebase của session song song — mọi số dòng trích dẫn trong file này là snapshot tại thời điểm đánh giá và CẦN RE-VERIFY bằng lệnh Phụ lục A trước khi dùng để sửa code. Bản đầu không cảnh báo điều này; nay ghi rõ.
11. **Bổ sung trigger trực tiếp cho P0.1**: bản đầu chỉ hướng dẫn qua UI; red-team xác định `POST /api/code-team/workflow` import `runWorkflow` trực tiếp — đường API ngắn và dễ reproduce hơn cho acceptance test.
12. **Lỗi khoảng dòng lệnh kiểm chứng — ĐÃ SỬA SAU RED-TEAM VÒNG 2**: lệnh sed demo "token bị vứt trong ReAct" dùng khoảng `1226,1250` — chạy thực tế trả về RỖNG (các tham chiếu `result.content` nằm ở 1240-1290). Đã sửa khoảng dòng trong Phụ lục A và xác nhận chạy ra được. Bài học vận hành: vòng red-team thứ nhất validate nội dung, vòng thứ hai phải RUN lệnh — lệnh đúng nội dung nhưng sai tham số vẫn là lệnh hỏng. Thêm nữa: `grep -c` exit code 1 khi count=0 — các lệnh Phụ lục phải chạy TÁCH BIỆT, không nối `&&` (đã ghi chú dạng danh sách lệnh riêng).
13. **Bổ sung v2 — Red Team như primitive thiếu (từ thảo luận với user)**: user hỏi "red team ở đâu trong app" → verify: không tồn tại như tính năng, chỉ 3 mảnh rời nguyên lý. Phân tích 3 tầng cho thấy tầng 3 (liên tục) giải quyết đồng thời 3 vấn đề của Layer 9. Đã thêm mục 3.6 + P2.4 + file blueprint đồng hành. Quyết định thiết kế: red-team GHÉP vào eval harness hiện có (tái sử dụng judges + runner) thay vì dựng hệ mới — effort 1 session thay vì 3.

---

## PHỤ LỤC A — LỆNH TÁI LẬP BẰNG CHỨNG

```bash
cd /home/z/tmo-app

# [2] Kho trống tuyệt đối
python3 -c "
import sqlite3
conn = sqlite3.connect('/home/z/my-project/db/custom.db')
for t in ('ExecutionMetrics','FailurePattern','StrategyAdaptationLog'):
    print(t, conn.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0])
"

# [1] tokensUsed placeholder + hardcode errorType
grep -n "tokensUsed — placeholder" src/lib/code-team/workflow-engine.ts
grep -n "errorType: 'runtime'" src/lib/code-team/workflow-engine.ts

# [3][4][5] Hàm learning: import nhưng không gọi / 0 caller
grep -c "applyAdaptation(" src/lib/orchestration/master-orchestrator.ts   # → 0
grep -rn "getAdjustedBudget\|getSuccessProbability\|analyzeHistoricalFeedback" src/ \
  | grep -v "src/lib/learning/" | grep -v __tests__                       # → (trống)
rg -n "from '@/lib/orchestration'" src/ | grep -v "src/lib/orchestration/"  # → chỉ type import

# [3] Flag bật nhưng không tới được
grep "ENABLE_MASTER_ORCHESTRATOR" .env

# [1] Token bị vứt tại chỗ trong vòng ReAct (chỉ content được tiêu thụ)
sed -n '1240,1290p' src/lib/code-team/workflow-engine.ts | grep -n "result\."   # → result.content, result.error — không có tokensUsed
# Tool-delegate tokens có sẵn ở tầng tool:
rg -n "delegateResult.tokensUsed" src/lib/code-team/tool-executor.ts    # → 1698

# [5] Chưa có workflow thật — trigger trực tiếp cho P0.1:
rg -n "import \{ runWorkflow \}" src/app/api/code-team/workflow/route.ts

# 3.2 Tham số học duy nhất của app
python3 -c "
import sqlite3
conn = sqlite3.connect('/home/z/my-project/db/custom.db')
print(conn.execute('SELECT id, intercept, coef, sampleSize FROM CalibrationModel').fetchall())
"

# 3.1 Spec-vs-reality: field chất lượng KHÔNG tồn tại trong schema
grep -A 20 "model ExecutionMetrics" prisma/schema.prisma | grep -c "recallAt5\|faithfulness"  # → 0
```

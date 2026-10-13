# BLUEPRINT GIAO THỨC QUAN SÁT V2 P1 → P4 — "TOÀN CẢNH VẬN HÀNH DATABASE · NÃO · TỰ HỌC"

> **Phiên bản:** 0.3 — **☑ TRIỂN KHAI HOÀN TẤT OBS-P1→P4 2026-10-13 (Task 23)
> — §7 chốt theo khuyến nghị, gate 4 tầng PASS, live verify agent-browser.**
> *(0.2 — §7 chốt cùng ngày, user chỉ thị: "7 câu hỏi mở hãy theo đề xuất của
> bạn đi. Sau đó tiến hành triển khai Blueprint Observation".)*
> *(Hiệu đính 0.1→0.1.1, Task 22 2026-10-13: sửa 3 sai số kiện chứng — poll
> activity thực tế 2,5s chứ không phải 5s (A.1/C.4/C.5 — code `POLL_ACTIVITY_MS
> = 2_500`), đồng bộ poll thích ứng 2,5s/15s với §10.1-6 BLUEPRINT-HYPERNAS v0.2.
> Không đổi thiết kế.)*
> Sinh từ yêu cầu user (2026-10-13): *"rất nhiều nâng cấp xoay quanh kiến trúc
> database, kiến trúc học, triển khai tác vụ của agent nên sau này khi kích hoạt
> giao thức quan sát bạn sẽ cần làm nhiều việc hơn — cần hiểu giao thức quan sát
> hiện tại có gì, và có cần triển khai thêm gì để thấy được CẢ QUÁ TRÌNH vận hành
> của database, các bộ não, chế độ tự học, đến cấp độ xác định các vấn đề trong
> tinh chỉnh kiến trúc, số lớp, số nơ-ron, siêu tham số, trọng số, tham số runtime,
> hàm và công thức — nói chung toàn cảnh database mỗi khi agent vận hành."*
>
> File này = **phần A: kiểm kê hiện trạng (có bằng chứng code)** + **phần B: phân
> tích khoảng trống** + **phần C: thiết kế V2** để khi user kích hoạt là triển
> khai được ngay. Liên kết chéo [BLUEPRINT-HYPERNAS-P1-P5.md](./BLUEPRINT-HYPERNAS-P1-P5.md) §9.

---

## 0. TÓM TẮT ĐIỀU HÀNH

| Phase | Tên | Mục tiêu một câu | Artifacts | Cờ (mặc định) | Test |
|---|---|---|---|---|---|
| **OBS-P1** | Observation Ledger core | Bảng `ObservationEvent` append-only (model 103) + helper `observeEvent()` + hooks đợt 1 (điểm nóng: brain train/infer, tuning change, agent run start/end) | `src/lib/observation/ledger.ts` · prisma model 103 | `obs_ledger` (off) | r95 |
| **OBS-P2** | Brain Inference Trace + Timeline API | Bảng `BrainInferenceTrace` (model 104) lưu MỖI lần não suy diễn + `GET /api/observation/timeline` lọc/runId/kind/actor | `src/lib/observation/trace.ts` · route timeline | `obs_brain_trace` (off) | r96 |
| **OBS-P3** | UI Panorama + Kim tuyến | Tab "Quan sát" mới (module Smolab): timeline dọc live-poll + filter + drill-down payload + chế độ "kim tuyến" nhập runId → chuỗi sự kiện trọn vẹn của run | `src/components/smolab/observation-tab.tsx` | `ui_observation` (off) | r97 |
| **OBS-P4** | Impact Tracker + Meta-health | Job nền so sánh KPI window trước/sau mỗi TuningChangeLog (correlation, KHÔNG claim nhân quả) + sự kiện search.* HyperNAS + sức khỏe của chính ledger (độ trễ ghi, queue drop) | `src/lib/observation/impact.ts` | `obs_impact` (off) | r98 |

**Tiến độ:** ☑ OBS-P1 ☑ OBS-P2 ☑ OBS-P3 ☑ OBS-P4 — **HOÀN TẤT 2026-10-13
(Task 23)**: model 103/104 + ledger/trace/kinds/impact (src/lib/observation/)
+ timeline API + 13 hook call-site + tab "Quan sát" Smolab + 4 cờ
(TUNING_SPECS 26–29, node hist-feedback) + test r95–r98 (64 test) — gate 4
tầng PASS (tsc · eslint · check:imports · full suite 1491/1491 ×2). Quyết
định triển khai ghi thêm: hook gắn node **hist-feedback** (Historical
Feedback — learning layer) thay vì node riêng (giữ 23 node, r81 khớp 2 chiều
nodeId↔paramKeys); Câu hỏi mở HN-P2 (HyperNAS) không đụng — kind search.*
đã reserve từ v0.1.

---

## PHẦN A — KIỂM KÊ GIAO THỨC QUAN SÁT HIỆN TẠI (đo 2026-10-13)

### A.1 Bề mặt UI

| Bề mặt | Nội dung quan sát | Hạn chế |
|---|---|---|
| **Tab BRAIN** (Smolab — "đài quan sát não") | Điểm sáng nơ-ron real-time (poll `/api/brain/activity` 2,5s *(hiệu đính Task 22: v0.1 ghi 5s — code là `POLL_ACTIVITY_MS = 2_500`)* + poll feed `/api/brain` 15s) + input vector THẬT + activation từng lớp (khi active) + Brain Stage lan truyền tiến/xanh ngược/vàng + Training Console (train + quỹ đạo loss) + Tham số runtime dialog + Nhật ký tinh chỉnh (changeLog) + tab Hàm & công thức (9 activation + 4 loss) | Chỉ là **snapshot gần nhất** — không persist lịch sử inference; poll 2,5s bỏ lỡ sự kiện giữa 2 lần poll |
| **Tab Kiến trúc** (Database) | Graph kiến trúc não + Q-table (QEntry) + SAL + dashboard 3 vùng cũ | Tĩnh theo lần mở; không nối chuỗi với run agent |
| **Database → analytics** | Stats + embedding status + health | Vận hành KB, không phải vận hành não |
| **Analytics module** | `runtime-metrics-panel` (ToolMetric/Daily) + `episodic-memory-panel` | Chỉ tool-usage + episodic; không có não/tuning |
| **Self-Direction module** | Đề xuất tự hướng + duyệt | Chỉ proposal flow |
| **Status bar** | `/api/health` — qdrant · neo4j (đã bật Aura: 95.587 node/204.251 quan hệ) · sqlite · r2 · supabase · llm | Health hạ tầng — không nói gì về hoạt động học |

### A.2 Bề mặt API quan sát

- `GET /api/brain/activity` — vector input thật + activations (chỉ khi có bản active); **không persist**.
- `GET /api/brain` — signals (đếm mẫu ngưỡng), models, feed tuning + changeLog.
- `GET /api/brain/policy` — report Brain-C READ-ONLY + composite reward LOG-ONLY (**đợt quan sát 1 — đang chỉ `console.log`, xem GAP-4**).
- `POST /api/brain/replay` — replay-eval bootstrap CI.
- `GET /api/health` — 5 dịch vụ hạ tầng.
- `/api/agent-run`, `/api/agent-activity`, `/api/agent-events` — trạng thái run agent.
- `POST /api/metrics/anomalies/scan` — quét MetricAnomaly cho UI.
- `/api/tools/analytics` — cân bằng tool usage.
- `/api/eval/*`, `/api/episodic/*`, `/api/opus`, `/api/redteam` — quan sát chuyên ngành riêng.

### A.3 Bảng DB mang tính quan sát (23+ bảng)

`LearningLog` · `AgentInsight/Correction/Preference/Skill` · `ToolMetric`/`ToolMetricDaily` ·
`MetricAnomaly` · `KpiSnapshot` (1 dòng/ngày/KPI) · `ExecutionMetrics` ·
`StrategyAdaptationLog` · `TuningChangeLog` (mọi thay đổi tham số — ai/cũ/mới/lý do) ·
`DigestGateEvent` · `AgentRunRecord` (kết cục run + tokens + latency) ·
`ArbiterVerdict` · `QEntry` · `EpisodeRecord` · `LessonRecord` · `EvalCase/Result/Run` ·
`SmolabTask` · `GoalLoopJob` (checkpoint chu kỳ) · `RunContext` · `WorkflowSession` ·
`BrainModel.trainMetaJson` (nSamples, CV + CI, Brier/MAE, **gradAbsMean từng lớp**,
draftUsed provenance).

### A.4 Giao thức quan sát của trợ lý AI (tôi — ngoài app)

`fixbug.md` v1.1 (rà→fix→rà đến 0 phát hiện, chấm chéo độc lập 3 phía, checklist
C1–C8) · live-verify bằng agent-browser sau launch (0 lỗi console) · gate 4 tầng
(tsc · eslint · check:imports · full tests ×2) · theo dõi `dev.log` · worklog
Task từng phiên. *(Giao thức này vận hành theo phiên làm việc — không phải hệ thống
runtime; V2 dưới đây cho cả hai: khi tôi live-verify sẽ có timeline thật để soi.)*

---

## PHẦN B — PHÂN TÍCH KHOẢNG TRỐNG (đối chiếu yêu cầu "toàn cảnh")

| # | Khoảng trống | Bằng chứng | Chặn việc gì |
|---|---|---|---|
| **GAP-1** | **Không có timeline thống nhất** — sự kiện nằm rải rác 23+ bảng, không join được chuỗi "run X → QEntry mới → tuning change → brain inference → reward log" | Không có bảng/`API` nào tổng hợp theo runId/ts | Xác định NGUYÊN NHÂN vấn đề (chỉ thấy từng mảnh) |
| **GAP-2** | **Não suy diễn không để vết** — mỗi lần brain predict (steering organ, replay-eval, mixture π) không lưu input/output/model-version/latency | `/api/brain/activity` chỉ trả snapshot gần nhất; không có bảng inference | Trả lời "não đã tư duy gì, dùng weights nào, lúc mấy giờ?" — cốt lõi yêu cầu user |
| **GAP-3** | **Không audit DB-writes theo run** — run agent ghi nhiều bảng (auto-learn, QEntry, Episode…) nhưng không bảng nào ghi "run X đã đổi những gì" | `AgentRunRecord` chỉ kết cục cuối | Toàn cảnh "database mỗi khi agent vận hành" |
| **GAP-4** | **Composite reward chỉ console.log** (log-only đợt 1 đúng Q1) | `reward.ts:339` console.log → mất theo rotation dev.log | Quan sát đủ 2 đợt để mở khóa đợt 2 (Q1 brain blueprint) |
| **GAP-5** | **Đổi tham số không đo tác động** — TuningChangeLog ghi thay đổi, KpiSnapshot theo NGÀY, không nối window trước/sau | Không có job/field nào nối 2 bảng | "Tinh chỉnh tham số runtime có hiệu quả không?" |
| **GAP-6** | **Chưa quan sát search/HyperNAS** (tương lai) | HyperNAS chưa triển khai | Khi có: thấy quá trình tìm kiến trúc (đã thiết kế kind `search.*` trong HyperNAS §9) |
| **GAP-7** | **Meta-health thiếu** — không đo độ trễ ghi/độ rớt sự kiện của chính hệ thống quan sát | — | Tin cậy dữ liệu quan sát |
| **GAP-8** | **Nhãn vận hành thiếu lineage chi tiết** — badge tổng nhãn có (computeLabelTotal) nhưng không breakdown theo agent/thời gian/loại | `registry.ts` computeLabelTotal chỉ tổng | Tìm "thiếu nhãn loại nào để brain thức tỉnh" |

**Kết luận Phần B: cần triển khai thêm — có.** Hiện trạng là các "đài quan sát chuyên
khoa" (mỗi panel một mảnh); thiếu "bảng bệnh án toàn thân" (ledger sự kiện + kim
tuyến theo run). Đó chính là OBS V2.

---

## PHẦN C — THIẾT KẾ V2

### C.1 Kiến trúc

```
   Agent chạy ──► observeEvent() ──► ObservationEvent (model 103, append-only)
   Brain inference ──► traceInference() ──► BrainInferenceTrace (model 104)
   Tuning change ──► (đã có TuningChangeLog) ──► +1 ObservationEvent
                                        │
   GET /api/observation/timeline ◄──────┴── join + filter (runId/kind/actor/since)
                                        │
   UI Tab "Quan sát" — timeline dọc + kim tuyến runId + drill-down payload
                                        │
   OBS-P4: impact tracker (window KPI quanh mỗi tuning change) + meta-health
```

Nguyên tắc: **ledger là XƯƠNG SỐNG SỰ KIỆN — KHÔNG thay thế bảng chuyên khoa hiện
có** (ToolMetric/KpiSnapshot/… giữ nguyên vai trò; additive — doctrine #7). Các
panel hiện tại dần ĐỌC THÊM từ ledger, không bị sửa đổi.

### C.2 Bảng DB mới (model 103 + 104 — additive)

```prisma
/// OBS-P1 — sổ cái sự kiện quan sát (append-only). KHÔNG update/xoá dòng cũ
/// (trừ prune policy). Model thứ 103.
model ObservationEvent {
  id        String   @id @default(cuid())
  /// thứ tự đơn điệu (sqlite seq) — chống xáo trộn cùng-ts
  seq       Int      @unique
  ts        DateTime @default(now())
  /// 'agent:<name>' | 'user' | 'system' | 'brain:<key>' | 'search'
  actor     String
  /// enum chuỗi mở: run.start|run.end|db.write|brain.train|brain.infer-ref|
  /// tuning.change|reward.log|qentry.add|verdict.add|learn.episode|flag.flip|
  /// search.session|search.candidate|proposal.apply|impact.estimate|obs.health
  kind      String
  /// FK logic (không ràng buộc cứng — multi-table): id AgentRunRecord/…
  runId     String?
  sessionId String?
  /// bảng SQLite bị ảnh hưởng (kind=db.write) — vd 'QEntry'
  table     String?
  rowKey    String?
  /// 1 dòng tóm tắt hiển thị timeline (không JSON)
  summary   String
  /// chi tiết ≤ 4KB (JSON-stringify; overflow truncate + flag truncated:true)
  payloadJson String
  createdAt DateTime @default(now())

  @@index([ts])
  @@index([runId, ts])
  @@index([kind, ts])
}

/// OBS-P2 — vết suy diễn não (tần suất cao → bảng riêng, prune riêng).
/// Model thứ 104.
model BrainInferenceTrace {
  id           String   @id @default(cuid())
  ts           DateTime @default(now())
  brain        String   /// 'calibration_v3'|'surrogate'|'policy'
  modelVersion Int      /// bản BrainModel dùng (provenance)
  organ        String?  /// 'calibrate'|'replay_eval'|'policy_mixture'|...
  runId        String?
  inputHash    String   /// SHA-256 vector input (nhẹ, so khớp được)
  /// vector input capped 2KB + output capped 2KB (mặc định hash-only khi
  /// cờ obs_brain_trace off → chỉ lưu hash + shape)
  inputJson    String?
  outputJson   String?
  latencyMs    Int
  createdAt    DateTime @default(now())

  @@index([brain, ts])
  @@index([runId, ts])
}
```

**Prune:** `OBS_EVENTS_KEEP = 50_000` dòng / 30 ngày (tiền lệ cap TuningChangeLog);
`OBS_TRACE_KEEP = 20_000` / 14 ngày. Job prune chạy sau mỗi batch ghi 1.000 sự
kiện (không cron thêm).

### C.3 Ghi sự kiện — helper + chiến lược rollout theo đợt

`observeEvent(evt)` — **fire-and-forget** (await KHÔNG bắt buộc tại call-site;
bounded queue 512, đầy → drop + đếm `obs.health.dropped` — fail-open tuyệt đối,
quan sát KHÔNG BAO GIỜ làm hỏng nghiệp vụ chính). Ghi qua Prisma create thường.

- **Đợt 1 (OBS-P1 — điểm nóng, ~12 call-site):** brain train start/end (3 pipeline),
  tuning set/change (tuning-store), agent run start/end/fail (agent-run-tracker),
  reward.log (reward.ts — GAP-4: thêm 1 dòng observeEvent cạnh console.log, vẫn
  LOG-ONLY với runtime), flag.flip. Mỗi hook 1 dòng code + test.
- **Đợt 2 (OBS-P2):** brain inference (organ call-sites: calibration áp V3,
  replay-eval, policy mixture) → `traceInference()`; db.write cho các bảng học
  (QEntry/ArbiterVerdict/EpisodeRecord/LessonRecord/auto-learn) — hook TẠI HÀM
  GHI của lib (không sửa 100 call-site UI).
- **Đợt 3 (OBS-P4):** search.* (HyperNAS), impact.estimate, obs.health.

**Cờ:** `obs_ledger` (đợt 1+2 gate ghi event) · `obs_brain_trace` (bật lưu
input/output đầy đủ — mặc định off chỉ hash) · `obs_impact` · `ui_observation`.
Tất cả off mặc định (STORE > ENV > DEFAULT precedent). Khi tất cả off → overhead
bằng 0 (check cờ trước khi ghi).

### C.4 API Timeline (OBS-P2)

`GET /api/observation/timeline?runId=|actor=|kind=|since=|before=|limit=`
— trả sự kiện mới→cũ, paginate bằng `before=seq`, join `BrainInferenceTrace`
theo runId, **cả 2 nguồn trong 1 response** (kind `brain.infer`). Read-only,
không ghi gì. Rate-guard nhẹ (poll thích ứng 2,5s chạy / 15s idle precedent —
tái dùng pattern tab BRAIN).

### C.5 UI Tab "Quan sát" (OBS-P3 — module Smolab, tab mới cạnh BRAIN)

1. **Timeline dọc** live-poll thích ứng (2,5s khi có activity mới / 15s idle —
   precedent tab BRAIN): mỗi sự kiện 1 dòng (ts · actor badge · kind chip
   màu theo nhóm · summary); click → drill-down payload JSON viewer (dialog precedent
   tuning-param-dialog).
2. **Filter bar:** actor · kind (multi-select) · runId · khoảng ts.
3. **Kim tuyến (golden thread):** nhập/chọn runId → timeline lọc chỉ run đó + tự
   vẽ giai đoạn (run.start → các db.write/brain.infer xếp giữa → run.end) — đây là
   câu trả lời trực tiếp "toàn cảnh mỗi khi agent vận hành".
4. **Panel nhãn & não:** breakdown nhãn theo nguồn (GAP-8) + lifecycle 3 brain +
   link sang tab BRAIN (không nhân bản dashboard — single-source API cũ).

### C.6 Impact Tracker (OBS-P4)

Job nền (tick precedent GoalLoopWorker — không cron mới): với mỗi
`TuningChangeLog` entry chưa có `impact.estimate` và đã đủ window 24h: so sánh
KPI snapshot trước/sau (hiệu ± CI thô từ sampleSize) → ghi `ObservationEvent`
kind `impact.estimate` — **framing trung thực: correlation window, KHÔNG claim
nhân quả** (nhiều thứ đổi song song). UI hiển thị trong timeline + log tab
Tham số runtime.

### C.7 Ánh xạ "yêu cầu tinh chỉnh → dữ liệu quan sát cần" (đối chiếu trực tiếp câu user)

| Cấp độ tinh chỉnh | Dữ liệu quan sát V2 cung cấp |
|---|---|
| **Kiến trúc — số lớp, số nơ-ron** | `search.candidate` (spec + cvScore + params từng ứng viên) + `brain.train` (gradAbsMean từng lớp — đã có trainMeta) + params vs nSamples cảnh báo overfit |
| **Siêu tham số** | quỹ đạo loss downsample + early-stop epoch + cvScore + CI mỗi lần train (trainMetaJson) → so sánh lịch sử qua timeline |
| **Trọng số** | modelVersion trong mọi inference trace → biết weights nào đang tư duy; diff version qua models list sẵn có |
| **Tham số runtime** | `tuning.change` + `impact.estimate` window + `flag.flip` — chuỗi đổi → hệ quả |
| **Hàm và công thức** | tab ref (công thức) + draft activation/loss dùng thật trong `brain.train`/`search.candidate` → biết tổ hợp hàm nào đã thử và kết quả |
| **Tự học** | `learn.episode`/`qentry.add`/`verdict.add` theo runId — kim tuyến |

---

## 4. RỦI RO & GIẢI PHÁP

| # | Rủi ro | Mức | Giải pháp |
|---|---|---|---|
| RO-1 | Write amplification (event quá nhiều) | Cao | Cờ off mặc định · bounded queue drop · prune 50K/30 ngày · sampling khi cần |
| RO-2 | Payload chứa nội dung nhạy cảm (context agent) | Cao | Chỉ lưu metadata + hash + summary ngắn — KHÔNG lưu full context (precedent redaction redteam) |
| RO-3 | Ghi event fail làm chậm nghiệp vụ | Cao | Fire-and-forget + try/catch toàn bộ + check cờ trước ghi (overhead 0 khi off) |
| RO-4 | seq đơn điệu bị race | TB | `SELECT MAX(seq)+1` trong transaction ngắn (SQLite serialise tự nhiên) |
| RO-5 | Ledger thành "bảng thứ 24 không ai đọc" | TB | Kim tuyến + timeline là USP — thiết kế quanh runId từ ngày đầu; UI OBS-P3 bắt buộc trước khi mở cờ |
| RO-6 | Impact tracker bị đọc thành nhân quả | TB | Copy UI "correlation — không phải nhân quả" + payload ghi rõ window |

---

## 5. DOCTRINE COMPLIANCE

1. Hằng số kèm nguồn (cap/prune §C.2). ✓ 2. Fail-open (C.3 — quan sát không bao
giờ phá nghiệp vụ). ✓ 3. Không mở rộng phạm vi (chỉ quan sát, không can thiệp).
✓ 4. Commit trung thực. ✓ 5. DB write runtime thật → additive model 103/104 +
prune policy. ✓ 6. Test trước (r95–r98: helper all-off overhead 0, prune đúng,
seq race, timeline API contract, kim tuyến UI contract). ✓ 7. Additive schema.
✓ 8. Cờ off mặc định (4 cờ). ✓ 9. Single-source (kind-name thống nhất với
HyperNAS §9 — khai báo từ v0.1 cả 2 bên).

---

## 6. THỨ TỰ TRIỂN KHAI KHUYẾN NGHỊ

OBS-P1 → (OBS-P2 + HyperNAS HN-P1 song song được — không phụ thuộc) → OBS-P3 →
OBS-P4. Lý do: ledger phải có trước để mọi thứ sau phát sự kiện vào đúng chỗ;
UI panorama (P3) cần API (P2) đủ ổn.

---

## 7. DANH SÁCH CHỐT — **☑ TẤT CẢ 5 CÂU CHỐT THEO KHUYẾN NGHỊ 2026-10-13 (Task 23)**

| # | Câu hỏi | Khuyến nghị | Trạng thái chốt |
|---|---|---|---|
| Q1 | Triển khai OBS V2 ngay hay chờ? | **OBS-P1 có thể triển khai ngay** (ledger rỗng chạy vô hại, cờ off overhead 0) — dữ liệu bắt đầu được bảo toàn từ sớm | ☑ CHỐT triển khai ngay — user chỉ thị triển khai toàn bộ P1→P4 |
| Q2 | Mặc định payload inference chỉ hash (tiết kiệm) hay full vector (chi tiết)? | Hash mặc định (`obs_brain_trace` bật full khi cần điều tra) | ☑ CHỐT hash mặc định |
| Q3 | Prune 50K/30 ngày đủ chưa? | Đủ cho sandbox; chỉnh bằng cờ nếu cần | ☑ CHỐT 50K/30 ngày (event) + 20K/14 ngày (trace) — hardcode kèm nguồn |
| Q4 | Tab "Quan sát" để module Smolab (khuyến nghị) hay module riêng? | Smolab — đúng trung tâm thí nghiệm | ☑ CHỐT Smolab, tab cạnh BRAIN (id 'observation') |
| Q5 | Impact tracker 24h window có hợp lý (agents vận hành không đều)? | Cửa sổ trượt theo "N sự kiện vận hành" thay vì giờ cố định — chốt khi triển khai OBS-P4 | ☑ CHỐT TẠI TRIỂN KHAI: KpiSnapshot có hạt độ THEO NGÀY (1 dòng/ngày/KPI) nên cửa sổ "N sự kiện" không chiếu được vào nguồn dữ liệu này — cửa sổ chốt = **snapshot ngày liền trước đổi vs snapshot ngày liền sau đổi** (tra tối đa ±3 ngày mỗi bên, cần đủ cả 2 bên mới tính, đợi tối thiểu 24h sau change), payload ghi rõ granularity + framing "correlation — KHÔNG claim nhân quả" (RO-6). Trung thực với nguồn dữ liệu hơn là vẽ cửa sổ giả chính xác |

---

*Ngày soạn: 2026-10-13 · Task 21 (worklog `/home/z/my-project/worklog.md`) ·
Áp dụng sau khi user kích hoạt "giao thức quan sát" — mọi phase độc lập với
BLUEPRINT-HYPERNAS-P1-P5 (chỉ thống nhất kind-name §9 HyperNAS).*

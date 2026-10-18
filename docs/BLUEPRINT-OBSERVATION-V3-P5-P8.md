# BLUEPRINT GIAO THỨC QUAN SÁT V3 P5 → P8 — "MỞ RỘNG THEO 4 NÃO + NAS/EVO + CHUỖI HỌC"

> **Phiên bản:** 0.2 — 2026-10-18 (Task R34-OBSV3-DEPLOY). **Hiệu đính sau
> review-đối-chiếu-code-thật (user chỉ thị: "review lại và vá nếu có vấn đề")**:
> (1) GAP-V3-3 + hook H3 **HỦY** — não A calibration_v3 CÓ phát `brain.train`
> (`calibration-v3.ts:347/355/376` — observeBrainTrain start/end đầy đủ như não
> B/C; kết luận sai trong 0.1 do grep bị cắt ngắn); (2) GAP-V3-8 hiệu chỉnh —
> rule `job-stale` ĐÃ theo dõi BrainSearchRun (30 phút, alerts.ts:347) nhưng
> sweep 60s trên GET (evolve.ts:862) đánh failed IM LẶNG + cửa sổ mù 60s–30'
> → H4b phát `search.session` end khi sweep + rule `evo-stuck` 5 phút; (3) H5
> đổi call-site — KHÔNG có fire-site "escalate → Goal Generator" riêng; đường
> THẬT là sweep `sweepEscalationImprovements` (instrumentation-node.ts:955,
> boot + 6h) tạo SelfDirectionProposal → hook tại mỗi proposal được tạo;
> (4) H6 hook trong `consumeEscalationEmit` (adaptation-engine.ts:280 — single-
> source cho mọi caller); (5) H7 thêm throttle (1 event/provider:model:lỗi/10'
> — chống spam timeline khi model chết + caller retry liên tục); (6) r99-C1
> pin OBS_KINDS 19 → 25 (PIN UPDATE precedent R5).
>
> **Nguyên tắc đứng theo chỉ đạo user (2026-10-18):** GIAO THỨC QUAN SÁT
> KHÔNG nằm trong vận hành app — nó sinh ra để **trợ lý vận hành quan sát được
> mọi thông tin cần thiết trong quá trình vận hành của agents**. Hệ quả: tuyệt
> đối thụ động (fail-open, fire-and-forget, không bao giờ chặn/nghẽn nghiệp
> vụ), và giao diện tiêu thụ chính của trợ lý là **ledger + timeline API +
> SQL read-only** (UI Đài quan sát chỉ là phần bù cho người).
>
> 0.1 — 2026-10-18 (Task R34-OBSV3-AUDIT — đánh giá + thiết kế).
> Sinh từ yêu cầu user (2026-10-18): *"Kiểm tra giao thức quan sát, hiện tại đã
> có thêm 4 bộ não, mạng NAS … nghĩa là việc liên quan quá trình xử lý tác vụ
> của agent đã tăng lên. Xác định cho tôi giao thức quan sát có cần mở rộng
> không và nếu có thì cần mở rộng những gì. Trong giao thức quan sát hiện tại
> có nội dung thuộc về mục tiêu, mục đích cần đạt được của giao thức quan sát
> không"*
>
> File này = **phần A: kiểm kê hiện trạng (bằng chứng file:dòng, đo 2026-10-18
> sau R33)** + **phần B: 10 khoảng trống** + **phần C: thiết kế V3 (OBS-P5→P8)**
> + trả lời 2 câu hỏi user. Liên kết [BLUEPRINT-OBSERVATION-P1-P4.md](./BLUEPRINT-OBSERVATION-P1-P4.md)
> (V2 — khung xương sống, GIỮ NGUYÊN).

---

## TRẢ LỜI TRỰC TIẾP 2 CÂU HỎI USER (0.1 — giữ nguyên từ bản đánh giá)

**Câu 2 — Giao thức hiện tại có mục tiêu/mục đích không?**
**CÓ — 3 tầng**, nhưng **đã stale một phần**:
1. `GIAO_THUC_GIAM_SAT_AGENTS.md` §0 — 6 nguyên tắc cốt lõi (bằng chứng máy
   trước; không tin một nguồn; vẹn nguyên vi phạm lịch sử; sự cố lặp ≥2 → fix
   cấu trúc; chấm bằng dữ liệu đo được; **blind spot mới → kênh quan sát mới,
   danh sách kênh chỉ được dài ra**).
2. §0b **MỤC ĐÍCH KÍCH HOẠT** (chuẩn mực đứng, v1.5/Task 32): 4 đối tượng —
   Agent (run lifecycle) · Database (bảng học) · Não agent (train/infer-ref/
   trace/pipeline) · Quá trình thực thi của agent — đích cuối: *"xem có lỗi,
   vấn đề hay thiếu sót nào cần xử lý hoặc bổ sung — và tiến hành xử lý/bổ sung
   NGAY khi phát hiện"*.
3. Mỗi lĩnh vực D1–D8 có khối **Mục tiêu** riêng + rubric 100 điểm + ngưỡng xử lý.

**Stale ở đâu:** §0b mục 3 viết *"pipeline calibration/surrogate/policy"* = **3
não** (soạn 2026-10-14). Sau đó hệ thống thêm: **não thứ 4 knowledge** (Brain-D,
R28+), **EVO/NAS tiến hoá** (search.*, R31), **eval pipeline** (R33 seed-eval +
36 case), **KB consult D1/D2/D3** (nguồn dữ liệu Brain-A/D), **lesson engine**
(EVALUATE/CONSOLIDATE/escalate), **adaptation engine Layer 9** (TẠM DỪNG),
**provider failover NIM/Zen** (R25). → Mục đích chưa bao phủ đúng phạm vi xử lý
tác vụ agent HIỆN NAY (xem GAP-V3-1).

**Câu 1 — Có cần mở rộng không?** **CÓ** — 10 khoảng trống xác minh được
(Phần B), gom thành 4 phase OBS-P5→P8 (Phần C). Khung xương sống V2 (ledger
append-only + kim tuyến runId + 5 cờ + fail-open) **đủ dùng, không đổi** — mở
rộng thuần additive, đúng nguyên tắc §0.6.

---

## 0. TÓM TẮT ĐIỀU HÀNH

| Phase | Tên | Mục tiêu một câu | Artifacts | Cờ | Test |
|---|---|---|---|---|---|
| **OBS-P5** | Bít blind spot sự kiện | Hook các điểm nóng đang im lặng: eval.run · kb.consult · brain.train cho Brain-A · proposal.apply · learn.escalate · adapt.escalate · model.failover · đăng ký chat.fastpath | hooks tại call-site hiện có (mỗi hook 1 dòng kiểu precedent OBS-P1) | `obs_ledger` (dùng chung) | r105+ |
| **OBS-P6** | Alert rules thế hệ 2 | Rule cảnh báo cho failure mode mới: evo-stuck · eval-starvation · train-gate-repeat · provider-degraded · evo-budget-burn | `alerts.ts` thêm rule (precedent stall/token-burn) | `obs_alerts` | r105+ |
| **OBS-P7** | Impact tracker neo thứ 2 | Đo tác động KPI của việc TRIỂN KHAI kiến trúc EVO (không chỉ đổi tham số) | `impact.ts` thêm anchor `proposal.apply` | `obs_impact` | r105+ |
| **OBS-P8** | Cập nhật giao thức doc | §0b mở rộng 4 não + NAS/EVO + eval + KB + adapt; D1/D5 rubric; mission-watch kênh 6 (tùy chọn) | `GIAO_THUC_GIAM_SAT_AGENTS.md` v1.6 | — (doc) | — |

**Thứ tự:** P5 → P6 → P7 → P8 (P7 phụ thuộc P5 có `proposal.apply`; P8 chốt
sau khi P5–P6 chạy thật để doc phản ánh hiện thực, không phản ánh kế hoạch).

---

## PHẦN A — KIỂM KÊ HIỆN TRẠNG (đo 2026-10-18, sau R33)

### A.1 Kind đang phát THẬT vào ledger (21 call-site, 18 kind)

| Kind | Call-site | Ghi chú |
|---|---|---|
| `run.start` / `run.end` / `run.heart` ×2 | `agent-run-tracker.ts:556/643/739/971` | đủ 3 não-aware: runId kim tuyến + heartbeat 2 phút (Task 33) |
| `chat.fastpath` | `openclaw/chat/route.ts:1161` | **KHÔNG đăng ký OBS_KINDS** → chip rơi nhóm 'db' trung tính (GAP-V3-7) |
| `db.write` | `auto-learn.ts:236` | AutoLearnRecord |
| `qentry.add` | `learning/q-table.ts:364` | |
| `verdict.add` ×2 | `metrics-db.ts:242/273` | nhánh delegate + raw đều gắn runId (FB-OBS-R1-08) |
| `learn.episode` ×4 | `episodic-memory/episodic-db.ts:111/150/238/274` | Episode + Lesson **upsert** (có vết); **ESCALATE thì KHÔNG** (GAP-V3-6) |
| `brain.train` | `brains/policy.ts:537/545/566` + `brains/surrogate.ts:581/589/604` | **CHỈ não B + C**. Não A (calibration_v3) chỉ có trainProgress (bus UI `calibration-v3.ts:351`) — KHÔNG observeEvent (GAP-V3-3) |
| `brain.infer-ref` (→ BrainInferenceTrace) | `calibration-v3.ts:734` + `surrogate.ts:1305` + `policy.ts:1053` | đủ 3 organ đang sống; não D chưa infer (disabled — đúng) |
| `tuning.change` / `flag.flip` | `learning/tuning-store.ts:225` | |
| `model.sync` | `free-models-sync.ts:328` | catalog model free |
| `reward.log` | `brain/reward.ts:347` | LOG-ONLY đúng Q1 |
| `search.session` ×3 + `search.candidate` | `brain/evolve.ts:402/528/729/792` (payload: `evo/observe.ts`) | EVO/NAS ✓ start/end/candidate — nhưng sweep mồ côi im lặng (GAP-V3-8) |
| `impact.estimate` + `obs.health` | `observation/impact.ts:210/242` + `ledger.ts:351/361` | impact neo DUY NHẤT vào TuningChangeLog (GAP-V3-9) |
| `obs.alert` | `alerts.ts:212` + `opus/pipeline.ts:816` | |

### A.2 Alert rules đang sống (7)

`stall` D1.1 · `token-burn` D1.4 (500K) · `job-stale` ×2 (GoalLoopJob) ·
`orphan-sweep` D1.2 (AgentRunRecord) · `brain-label-starvation` ·
`chat-trace-loss` · `opus-review-failure-breaker`.

→ Toàn bộ theo dõi **AgentRunRecord + GoalLoopJob**. Không rule nào cho
BrainSearchRun (EVO) · EvalRun · train gate · provider.

### A.3 Cấu trúc quan sát không đổi từ V2 (đủ dùng)

Ledger append-only model 103 (bounded queue 512, prune 50K/30 ngày) ·
BrainInferenceTrace model 104 (20K/14 ngày) · `GET /api/observation/timeline`
(filter runId/kind/actor + alerts24h) · UI OBS_MODES 4 panel (Neurons /
Timeline / Traces / Kim tuyến) · 5 cờ `obs_ledger`/`obs_brain_trace`/
`obs_impact`/`obs_alerts`/`ui_observation` (đều ON trong DB restore hiện tại).

### A.4 Chuỗi xử lý tác vụ agent HIỆN NAY (đối tượng cần quan sát)

```
user → chat (fast-path | triage) → KB consult (Brain-A calibrate confidence, KbConsultLog D1)
     → goal-loop (durable, checkpoint) → tools (ToolMetric) → verdict (ArbiterVerdict)
     → reward (LOG-ONLY) → auto-learn + QEntry + Episode/Lesson (learn-*
       EVALUATE/CONSOLIDATE, escalate ≥3 pattern → Goal Generator)
     → adaptation Layer 9 (lỗi lặp ≥3 cách → TẠM DỪNG + escalate 1 lần — SSE-only)
     → não A/B/C train + infer (3 organ) · não D knowledge (đếm KB, disabled train)
     → EVO/NAS: search.session → candidate (CV, H7, Q2 budget) → sweep stale 60s
     → proposal.apply (client deploy kiến trúc) → train force → active
     → eval pipeline (seed + run 36 case → refusal/nhãn cho não)
     → provider: NIM 4 key + Zen failover (403 FreeTierError đã xảy ra THẬT)
```

---

## PHẦN B — PHÂN TÍCH KHOẢNG TRỐNG (10 GAP, đều có bằng chứng)

| # | Khoảng trống | Bằng chứng (file:dòng / sự cố thật) | Hậu quả |
|---|---|---|---|
| **GAP-V3-1** | **Mục đích §0b stale** — ghi 3 não "calibration/surrogate/policy", không có não D, EVO/NAS, eval, KB, adapt | `GIAO_THUC_GIAM_SAT_AGENTS.md` §0b (v1.5 2026-10-14) vs kiến trúc R28–R33 | Kích hoạt giao thức theo §0b sẽ KHÔNG tự nhìn các đối tượng mới — mục đích đứng bị lạc hậu phạm vi |
| **GAP-V3-2** | **Eval pipeline 0 sự kiện** — /api/eval/* + lib/eval/* không có observeEvent | rg "observeEvent" trong `src/lib/eval*` + `src/app/api/eval` = 0 kết quả | R33: eval 36 case **refusal 36/36** = tín hiệu "não không thể thức tỉnh" quan trọng nhất — vô hình trong timeline; kim tuyến không nối run → eval → train-blocked |
| ~~**GAP-V3-3**~~ | ~~Brain-A train không phát brain.train~~ **HỦY ở 0.2 — kết luận 0.1 SAI** (grep bị cắt): calibration-v3.ts:347/355/376 phát observeBrainTrain start/end đầy đủ; train bị chặn class imbalance VẸN hiển thị qua kind `brain.train` (phase end, trained=false, resultError) | `calibration-v3.ts:347/355/376` | (không còn gap — rule P6 `train-gate-repeat` vẫn có giá trị: đếm chuỗi gate-block từ các event này) |
| **GAP-V3-4** | **KB consult không có sự kiện** — KbConsultLog D1 LOG-ONLY chỉ nằm bảng riêng | rg trong `kb-routing/` = 0 observeEvent | Não D + ngưỡng D2/D3 + confidence calibrate của não A trên đường KB — toàn bộ im lặng với timeline; kim tuyến "run X consult gì, confidence bao nhiêu" đứt |
| **GAP-V3-5** | **proposal.apply KHÔNG BAO GIỜ phát** — khai báo từ OBS-P1, call-site = 0 | `evo/observe.ts:11-13` ghi "CÓ TÌNH KHÔNG phát (client-side)"; `evolve-tab.tsx` applyEvoHiddenToDraft/deployEvoArchitecture không hook | Lúc QUAN TRỌNG NHẤT (kiến trúc mới trở thành active!) timeline mù; impact tracker không có anchor (GAP-V3-9) |
| **GAP-V3-6** | **Lesson escalate + Adaptation Layer 9 chỉ SSE/console** — không ledger | `lessons.ts` + `agent-brain.ts` + `adaptation-engine.ts:27` (escalate_to_user → SSE warning) = 0 observeEvent | Chỉ thị TẠM DỪNG can thiệp run + escalate Goal Generator (≥3 pattern) biến mất theo session — vi phạm nguyên tắc #1 bằng chứng máy |
| **GAP-V3-7** | **chat.fastpath không đăng ký kinds** — phát thật nhưng chip sai nhóm | `kinds.ts` OBS_KINDS không có 'chat.fastpath' → UI fail-open nhóm 'db' trung tính | Thống kê filter theo nhóm sai; rẻ mà bỏ (1 dòng OBS_KINDS) |
| **GAP-V3-8** | **EVO stale-sweep im lặng** — đánh dấu failed trong DB nhưng không phát search.session end + không obs.alert | `evolve.ts:861-867` (sweep heartbeat stale >60s → update DB, không emit) | "Worker chết (restart?)" chỉ thấy khi người mở tab Tiến hoá; không ai bị cảnh báo |
| **GAP-V3-9** | **Impact tracker neo duy nhất TuningChangeLog** — không đo tác động triển khai kiến trúc EVO | `impact.ts` query chỉ TuningChangeLog (§C.6 V2 chốt Q5) | "Kiến trúc EVO mới có thật sự tốt hơn không?" — không có window trước/sau bằng dữ liệu |
| **GAP-V3-10** | **Provider failover không quan sát** — NIM key lỗi/Zen 403 không thành sự kiện/alert | R32: Zen FreeTierError 403 phát hiện bằng **probe thủ công**, không phải hệ thống quan sát; không có kind model.failover | Thay đổi policy upstream (sự cố thật đã xảy ra) lặng lẽ làm hỏng utility cores — đúng định nghĩa blind spot §0.6 |

**Kết luận Phần B: cần mở rộng — CÓ.** Xương sống V2 đúng thiết kế và đã chứng
minh (5 cờ ON, 344+ sự kiện sau restore); khoảng trống nằm ở **độ phủ điểm
nóng mới** (P5), **alert thế hệ 2** (P6), **neo impact thứ 2** (P7) và **doc
mục đích** (P8). Không gap nào đòi đổi schema/kiến trúc.

---

## PHẦN C — THIẾT KẾ V3

### C.1 OBS-P5 — Bít blind spot sự kiện (8 hook, thuần additive)

Nguyên tắc giữ nguyên V2 §C.3: fire-and-forget · check cờ `obs_ledger` trước
khi ghi (overhead 0 khi off) · mỗi hook ~1 dòng + test · payload metadata +
hash (RO-2 không lưu full context).

| Hook | Kind | Call-site THẬT (hiệu đính 0.2 sau đối chiếu code) | Payload chính |
|---|---|---|---|
| H1 | `eval.run` (group 'brain') | (a) start: POST /api/eval/run sau `db.evalRun.create` (route.ts:56) + auto-eval.ts:113; (b) end: runner.ts sau update completed (~:397) + nhánh catch failed (~:463) — 1 start + 1 end/run, KHÔNG per-case | phase, runId (rowKey), nCases, answered, refusals, avgCoverage, avgRecall, durationMs, status |
| H2 | `kb.consult` (group 'db') | consult-log.ts `logKbConsult` sau create thành công (single-source — mọi caller gồm fallback đều qua đây) | taskType, intent, confidence, rawConfidence, latencyMs, tokensUsed, queryHash (SHA-256 12 ký tự — KHÔNG lưu nội dung), nTop, runId/sessionId nếu có |
| ~~H3~~ | ~~brain.train não A~~ | **HỦY 0.2** — đã có sẵn (calibration-v3.ts:347/355/376) | — |
| H4 | `proposal.apply` (kind sẵn) | POST /api/brain/train — phát khi `result.active && useDraft` (đường deploy duy nhất lên active: R7 saveDraft → train force); client deployEvoArchitecture truyền thêm `origin:'evo-deploy'` (body tùy chọn, whitelist) | brain, version, forced, improved, cvScore, inputMode, origin ('evo-deploy' | 'editor'), archSummary (hidden từ draft override) |
| H5 | `learn.escalate` (group 'db') | instrumentation-node.ts `sweepEscalationImprovements` (boot + 6h) — phát khi 1 SelfDirectionProposal escalation ĐƯỢC TẠO (created++) | rootCause (cắt 200), occurrences, unresolved, priority |
| H6 | `adapt.escalate` (group 'alert') | adaptation-engine.ts `consumeEscalationEmit` — phát đúng LẦN ĐẦU/session (single-source cho mọi caller: workflow-engine, redteam, tương lai) | sessionId, reason 'Layer 9: lỗi lặp ≥3 cách', escalationEmittedAt |
| H7 | `model.failover` (group 'tuning') | llm.ts 2 điểm: (a) wrapper quanh `callModelWithKeyRotation` — phát khi toàn chuỗi xoay key NIM fail (result.error); (b) `callUtilityLLM` nhánh return lỗi cuối (Zen HTTP + CLI đều fail) — dùng `observeEventThrottled` 1 event/(provider:model:errorTag)/10' chống spam | provider, model, taskLabel, error (cắt 300), path ('nim-rotation' | 'zen-http+cli') |
| H4b | `search.session` end khi sweep (GAP-V3-8 thật) | evolve.ts:862 — sweep đánh failed kèm emit builder mới `buildEvoSessionSwept` (evo/observe.ts) — mọi lượt GET sweep từ giờ hiển thị trong timeline | phase end, status failed, swept:true, reason heartbeat stale | 
| H8 | đăng ký `chat.fastpath` vào OBS_KINDS (group 'run') | kinds.ts 1 dòng (+5 kinds mới H1/H2/H5/H6/H7 → OBS_KINDS 19 → 25; pin r99-C1 cập nhật precedent R5) | — |

Ghi chú H4 (0.2): đường deploy LÊN ACTIVE duy nhất là train (R7) — spec-draft
PUT chỉ lưu nháp. Nên hook tại train route khi `result.active && useDraft`;
client chỉ THÊM trường `origin` (tùy chọn, whitelist 'evo-deploy') qua chuỗi
deployEvoArchitecture → saveDraft → trainBrain — observation vẫn 100% server-
side. runId BrainSearchRun đặt vào `rowKey` + payload (tiền lệ 31-e: không đè
evt.runId vì FK là kim tuyến AgentRunRecord).

Ghi chú H7 (0.2): llm.ts là module nền — import ledger qua dynamic import()
tại call-site (tiền lệ reward.ts/agent-run-tracker, chống chu trình tĩnh).
Throttle `observeEventThrottled` thêm vào ledger.ts (in-memory theo
`${kind}:${throttleKey}`, mặc định 10') — test được ở r122.

### C.2 OBS-P6 — Alert rules thế hệ 2 (5 rule, precedent dedupe + markAlerted)

| Rule | Điều kiện (chốt §7 theo khuyến nghị — ngưỡng bám hằng số sẵn có) | Hành động |
|---|---|---|
| `evo-stuck` | BrainSearchRun status='running' + heartbeat stale > 5 phút (an toàn: candidate train thực tế < 60s — Q2;補 sung cho job-stale 30') | obs.alert "EVO worker chết/kẹt — nobody polled" |
| `eval-starvation` | ≥ 2 EvalRun completed LIÊN TIẾP gần nhất đều refusalCount ≥ caseCount > 0 (100% refusal) | obs.alert "não không thể thức tỉnh — eval toàn refusal (tiền lệ R33: Positive=0/44)" |
| `train-gate-repeat` | kind brain.train phase end với trained=false ≥ 3 lần / não / 24h (parse payloadJson) | obs.alert "đốt compute thử train mà gate luôn chặn — xem dữ liệu thay vì thử tiếp" |
| `provider-degraded` | kind model.failover cùng (provider, model) ≥ 3 lần / 1h | obs.alert "provider/model lỗi lặp — kiểm tra policy upstream (tiền lệ Zen 403)" |
| `evo-budget-burn` | kind search.session end có nAbandoned ≥ 3 VÀ nAbandoned/candidatesMax > 50% | obs.alert "Q2 bỏ chấm quá nửa — ngân sách ứng viên lệch" |

### C.3 OBS-P7 — Impact tracker neo thứ 2 (proposal.apply)

Mở rộng job nền impact.ts: ngoài TuningChangeLog, với mỗi `proposal.apply`
(kind từ P5-H4) đã đủ window → so KPI snapshot trước/sau (cùng cơ chế Q5 V2:
snapshot ngày liền trước/sau, ±3 ngày, cần đủ 2 bên, tối thiểu 24h) → phát
`impact.estimate` với `anchor: 'evo-deploy'` + archSummary trong payload.
Framing giữ nguyên RO-6: **correlation — KHÔNG claim nhân quả**.

### C.4 OBS-P8 — Cập nhật `GIAO_THUC_GIAM_SAT_AGENTS.md` → v1.6

1. **§0b mục 3** "Não agent": thêm não thứ 4 (knowledge — nguồn KB, đếm D2/D3)
   + **EVO/NAS** (search session/candidate/deploy — BrainSearchRun) + **eval
   pipeline** (sinh nhãn huấn luyện).
2. **§0b mục 4** "Quá trình thực thi": thêm lesson escalate (≥3 pattern) +
   adaptation Layer 9 TẠM DỪNG + provider failover.
3. **Bảng tín hiệu tối thiểu §0b**: thêm hàng obs.alert rule thế hệ 2 (P6) +
   hàng eval/kb (P5).
4. **D1 rubric**: mở tập được theo dõi từ "goal-loop jobs + AgentRunRecord"
   thành "+ BrainSearchRun (EVO) + EvalRun" (tiêu chí D1.5: 0 search/eval job
   kẹt mồ côi > 24h).
5. **D5 rubric**: token/compute burn thêm phạm vi EVO (ngân sách 250K Q2) +
   eval spend (D5.4: alert trong ≤15 phút).
6. **mission-watch (tùy chọn, kênh thứ 6 "BRAIN/EVO")**: tail ObservationEvent
   kind brain.*/search.* trong cửa sổ mission — chỉ khi user xác nhận cần xem
   hoạt động não ngay trong terminal theo dõi (timeline UI đã có live-poll).
7. Ghi version v1.6 + ngày + tham chiếu blueprint này (đúng §12 duy trì tài liệu).

### C.5 Những gì KHÔNG đổi (trung thực phạm vi)

- Schema Prisma: 0 model mới (kinds là enum chuỗi mở — đủ).
- 5 cờ: dùng chung, không thêm cờ.
- Xương sống ledger/trace/timeline/kim tuyến: giữ nguyên.
- BrainInferenceTrace: đủ 3 organ; não D khi có inference chỉ thêm call-site.
- Cờ opusReviewMode chính sách: không đụng.

---

## 4. RỦI RO & GIẢI PHÁP (bổ sung trên RO-1..RO-6 của V2)

| # | Rủi ro | Mức | Giải pháp |
|---|---|---|---|
| RO-V3-1 | kb.consult tần suất CAO (mỗi câu chat) → write amplification | Cao | Mặc định chỉ phát khi D1 ghi log thật (đã có ngưỡng) + hash statement; sampling 1/N nếu cần; cờ off = overhead 0 |
| RO-V3-2 | eval.run phát trong lúc eval đang chạy dài → spam | TB | Chỉ start + end (không per-case); per-case đã có bảng riêng |
| RO-V3-3 | Alert thế hệ 2 false-positive (vd eval-starvation khi Qdrant chủ ý trống) | TB | Dedupe precedent + payload ghi ngữ cảnh + ngưỡng chốt §7 |
| RO-V3-4 | impact neo EVO bị đọc thành nhân quả | TB | Copy "correlation" + anchor rõ ràng (RO-6 precedent) |

---

## 5. DOCTRINE COMPLIANCE

1. Hằng số kèm nguồn (ngưỡng lấy đúng số hiện có: 60s sweep · 250K Q2 · 500K token). ✓
2. Fail-open tuyệt đối (fire-and-forget + check cờ). ✓
3. Không mở rộng phạm vi can thiệp — chỉ quan sát. ✓
4. Commit trung thực. ✓
5. DB write runtime → 0 model mới. ✓
6. Test trước (mỗi hook + mỗi rule 1 test; id tiếp theo r105+ theo kiểm kê worklog). ✓
7. Additive (0 sửa hành vi hiện có; kinds.ts chỉ THÊM dòng). ✓
8. Cờ off mặc định (dùng chung cờ sẵn — không cờ mới). ✓
9. Single-source kind-name kinds.ts (không pin payload — emitter tự ghi shape, precedent 31-e). ✓

---

## 6. THỨ TỰ TRIỂN KHAI KHUYẾN NGHỊ

P5 (hooks — rẻ nhất, giá trị cao nhất) → P6 (rules dựa trên kind P5 phát) →
P7 (cần P5-H4) → P8 (doc chốt sau khi P5–P6 chạy thật ≥ 1 phiên quan sát).
P5 và P6 có thể gộp 1 đợt triển khai nếu user duyệt cả hai.

---

## 7. DANH SÁCH CHỐT — ☑ TẤT CẢ THEO KHUYẾN NGHỊ (user chỉ thị 2026-10-18: "Câu hỏi thì theo đề xuất của bạn hết đi, tiến hành bổ sung giao thức quan sát")

| # | Câu hỏi | Khuyến nghị | Trạng thái chốt |
|---|---|---|---|
| Q-V3-1 | Triển khai ngay OBS-P5 (hooks) hay chờ? | Triển khai ngay — additive, overhead 0 khi cờ off, cùng luận điệu Q1 V2 (ledger rỗng chạy vô hại) | ☑ CHỐT triển khai ngay (P5+P6 gộp 1 đợt) |
| Q-V3-2 | `kb.consult` chi tiết mức nào? | Hash statement + metadata (RO-V3-1), KHÔNG lưu nội dung câu hỏi | ☑ CHỐT hash (SHA-256 12 ký tự) + metadata |
| Q-V3-3 | Ngưỡng 5 rule P6 chốt như đề xuất C.2? | Theo đề xuất (số liệu đều lấy từ hằng số hiện có); tinh chỉnh sau 1 tuần chạy thật | ☑ CHỐT theo C.2 (hiệu chỉnh 0.2: evo-stuck 5 phút) |
| Q-V3-4 | Impact neo EVO-deploy (P7) cần window gì? | Giữ nguyên cơ chế Q5 V2 (snapshot ngày liền trước/sau ±3 ngày) — trung thực với nguồn dữ liệu | ☑ CHỐT cùng cơ chế Q5 V2 (anchor 'evo-deploy') |
| Q-V3-5 | mission-watch kênh 6 BRAIN/EVO có cần không? | TÙY — timeline UI đã live-poll 2,5s; chỉ thêm nếu user hay theo dõi mission bằng terminal | ☑ CHỐT KHÔNG thêm kênh 6 — theo nguyên tắc đứng mới (giao thức cho trợ lý vận hành): trợ lý quan sát qua timeline API + SQL read-only đã có; UI live-poll là phần bù |

---

*Ngày soạn: 2026-10-18 · Task R34-OBSV3-AUDIT (worklog `/home/z/my-project/worklog.md`)
· Bám bằng chứng đo được trên HEAD 761a244 (R33). Áp dụng sau khi user chốt §7 —
mọi phase độc lập với BLUEPRINT-EVO-NAO (EVO-P* không đổi).*

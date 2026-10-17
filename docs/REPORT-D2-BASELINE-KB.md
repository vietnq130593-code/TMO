# REPORT D2 — BASELINE ĐỐI CHỨNG KB (heuristic CỨNG 4 lớp)

> BLUEPRINT-EVO-NAO-P1-P5 §8.2 · Task 31-d · Sinh lúc: `2026-10-17T19:16:10.384Z` · Nguồn: bảng `KbConsultLog` thật (`/home/z/tmo-app/db/custom.db`) + join `runId → AgentRunRecord.runId` cho Outcome*.
> Chạy lại: `cd /home/z/tmo-app && (unset DATABASE_URL; bun scripts/d2-baseline-report.ts)` — script CHỈ ĐỌC DB, không chạm app pm2. Số liệu machine-readable kèm theo: `docs/D2-BASELINE.json` (gate A1 của D3 load từ đây).

## 0. CẢNH BÁO DỮ LIỆU MỎNG — đọc trước khi dùng số liệu

- Corpus hiện **n = 40 log** — DƯỚI ngưỡng ≥100 của D2 (§8.1: D2 "bắt đầu có dữ liệu" ≥100 log; tiến độ 40%). Đây là SNAPSHOT trung thực, không phải báo cáo đủ sức thống kê.
- Log có Outcome* (runId): **30/40** — tiến độ ngưỡng D3 ≥300: 10%. D3 chưa đủ dữ liệu train.
- Số liệu KHÔNG đáng tin ở n này: p95 (cần ~20+ quan sát mỗi nhóm mới ổn), mọi hệ số tương quan Pearson (dưới ~30 cặp độc lập thì r dao động rất rộng), tỷ lệ nguồn theo intent (nhóm intent NULL áp đảo).
- Tương quan Outcome* chỉ join được **3 run riêng biệt** (2 success / 1 fail / 0 đang mở) — quá ít để nói gì về quan hệ nhân-quả; r dưới đây chỉ ghi nhận KHÔNG suy diễn.
- tokensUsed luôn 0 (thiết kế D1-v1 — API embed/rerank chưa trả usage, R21 chốt) → latencyMs là chiều hiệu năng duy nhất của snapshot này.

## 1. Tổng quan corpus

| Chỉ số | Giá trị |
|---|---|
| Tổng log | **40** |
| Log có runId (Outcome*) | 30 |
| Log có tokensUsed > 0 | 0 |
| Khoảng thời gian | 2026-10-17 05:36:14 → 2026-10-17 19:06:26 (UTC) |

Theo taskType (§8.1: chat · tool:* · smart-kb · kb-fallback-dense · graph-query · NULL):

| taskType | n |
|---|---|
| tool:knowledge_graph | 23 |
| chat | 10 |
| tool:knowledge_search | 7 |

Theo intent (intent-classifier: casual/meta/procedural/factual):

| intent | n |
|---|---|
| NULL (không classify) | 30 |
| factual | 10 |

## 2. Phân phối latency (latencyMs)

| Phạm vi | n | p50 | p95 | mean | max |
|---|---|---|---|---|---|
| **TOÀN BỘ** | 40 | 206.5 | 1019.6 | 372.1 | 1076.0 |
| intent=NULL | 30 | 188.0 | 1046.1 | 354.5 | 1076.0 |
| intent=factual | 10 | 407.5 | 514.9 | 425.0 | 523.0 |
| taskType=tool:knowledge_graph | 23 | 169.0 | 252.6 | 168.5 | 410.0 |
| taskType=chat | 10 | 407.5 | 514.9 | 425.0 | 523.0 |
| taskType=tool:knowledge_search | 7 | 990.0 | 1074.2 | 965.4 | 1076.0 |

Đọc: pipeline 4 lớp cố định đang trả kết quả ở p50 ~207ms / p95 ~1020ms trên corpus này. D3 (khi thức tỉnh) phải đạt latency tương đương hoặc tốt hơn trên cùng corpus — đấy là điều kiện hiệu năng của gate A1 (analog chặn H7 latency của HyperNAS).

## 3. Kết quả nguồn (hit / empty / error / disabled)

Row searchUserKB (4 nguồn song song): **17** · row graph-query (graphRecords): **23** · row fallback dense-only (pipelineError): **0** · không phân loại được (sourcesJson rác/thiếu): **0** · row bị truncate JSON: **0**.

| Nguồn | rows | hit | empty | error | disabled | hit-while-disabled (bất thường) | hit-rate (trên lượt nguồn CHẠY) |
|---|---|---|---|---|---|---|---|
| chunks | 17 | 3 | 14 | 0 | 0 | 0 | 17.6% |
| entities | 17 | 15 | 1 | 0 | 1 | 0 | 93.8% |
| memories | 17 | 3 | 13 | 0 | 1 | 0 | 18.8% |
| communities | 17 | 9 | 8 | 0 | 0 | 0 | 52.9% |
| graph (Cypher) | 23 | 20 | 3 | 0 | — | — | 87.0% |

Phân biệt (§8.2): EMPTY = nguồn bật nhưng KB không có gì (không phải lỗi) · DISABLED = nguồn TẮT qua sourcesEnabled (bỏ chạy chủ đích, vd caller không truyền agentId → entities/memories tắt) · ERROR = nguồn chết (allSettled rejected) · HIT-WHILE-DISABLED = bất thường cấu hình (nguồn tắt mà vẫn có hits — hiện phải = 0).

## 4. Confidence — calibrated (Brain-A) vs rawConfidence (heuristic gốc)

| Trường | n | mean | p50 | min | max |
|---|---|---|---|---|---|
| confidence (SAU calibration) | 17 | 0.3237 | 0.3000 | 0.0000 | 0.8000 |
| rawConfidence (TRƯỚC calibration) | 17 | 0.3237 | 0.3000 | 0.0000 | 0.8000 |

Cả hai trường cùng có mặt ở 17 row; **lệch nhau 0 row** (meanΔ = 0.000000). → CalibrationModel chưa train (hoặc trả nguyên raw) — calibrated đang ĐỒNG NHẤT heuristic.

## 5. Tương quan kết quả ↔ Outcome* (Pearson r)

Join: 30 log row có runId khớp AgentRunRecord · 3 run riêng biệt (outcome: 2 success / 1 fail / 0 đang mở). Tương quan chỉ tính trên run ĐÃ CHỐT: 30 row (0 row thuộc run đang 'running' bị loại — outcome chưa cuối).

| Cặp | Pearson r | n |
|---|---|---|
| confidence ↔ thành công | 0.090 | 7 |
| tổng hits ↔ thành công | -0.271 | 30 |
| latencyMs ↔ thành công | 0.082 | 30 |

`null` = không tính được (n<3 hoặc variance 0 — helper correlateOutcome fail-open). Với 3 run riêng biệt, r chỉ có giá trị GHI NHẬN — không suy diễn quan hệ (các row cùng run dùng chung 1 outcome → quan sát không độc lập).

## 6. Bộ số liệu đối chứng cho D3 (gate A1)

Khi D3 policy head (§8.3) thức tỉnh (≥300 log có Outcome*) và bật runtime_knowledge, nó phải THẮNG heuristic CỨNG trên CÙNG cách đo — đủ mục nào tính mục đó:

| # | Chỉ số baseline (heuristic CỨNG) | Giá trị snapshot |
|---|---|---|
| 1 | Latency p50 / p95 toàn bộ (ms) | 206.5 / 1019.6 |
| 2a | Hit-rate nguồn chunks (trên lượt nguồn chạy) | 17.6% (3/17) |
| 2b | Hit-rate nguồn entities (trên lượt nguồn chạy) | 93.8% (15/16) |
| 2c | Hit-rate nguồn memories (trên lượt nguồn chạy) | 18.8% (3/16) |
| 2d | Hit-rate nguồn communities (trên lượt nguồn chạy) | 52.9% (9/17) |
| 3 | Bất thường hit-while-disabled | 0 (phải giữ 0) |
| 4 | Mean confidence (calibrated) | 0.3237 |
| 5 | r(tổng hits ↔ thành công) | -0.271 (n=30) |
| 6 | Ngưỡng dữ liệu | D2 ≥ 100 log (đang 40) · D3 ≥ 300 log có Outcome* (đang 30) |

Snapshot này được ghi ở `docs/D2-BASELINE.json` cùng `(generatedAt, thresholds)` — D3 tải file này thay vì hard-code (single-source doctrine #9), so trên corpus TẠI THỜI ĐIỂM ĐO LẠI (không so chéo snapshot cũ).

## 7. Ghi chú kỹ thuật & hạn chế

- Outcome* = complete===true HOẶC status==='completed' (cùng ngữ nghĩa reward.ts outcomeFromEvidence); run status='running' bị loại khỏi tương quan (outcome chưa chốt) và đếm riêng.
- KbConsultLog.runId nối AgentRunRecord.RUNID (field runId — verify thật: join theo id KHÔNG khớp).
- Row fallback (pipelineError) không có hits trong corpus D1-v1 (kết quả nằm ở diagnostics tool) → bị loại khỏi cặp tương quan "tổng hits", vẫn tính ở latency.
- sourcesJson/retrievalConfigJson parse fail-open (d2-stats.ts) — row rác bị đếm "không phân loại được", không sập report.
- Section lỗi DB được ghi ở sectionErrors (fail-open theo section — precedent safeCount /api/brain):
  - (không có — mọi section tính thành công)
- Helper thuần: src/lib/kb-routing/d2-stats.ts (doctrine #9 — test r117, 31 test). Script này CHỈ ĐỌC DB.

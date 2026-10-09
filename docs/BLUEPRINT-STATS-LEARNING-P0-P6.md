# BLUEPRINT TRIỂN KHAI P0 → P6 — LỚP THỐNG KÊ HỌC-TỪ-DỮ-LIỆU CHO TMO (17 mục từ 4 tài liệu)

> **Phiên bản:** 1.0 — **Nguồn gốc:** Báo cáo nghiên cứu 4 PDF upload (MATH · DEEP LEARNING · Machine Learning · Data Analytics) → 17 khuyến nghị, phát triển thành kế hoạch triển khai qua fact-gathering toàn bộ codebase.
> **Phạm vi:** 3 trục — quy trình **TƯ DUY** (phán quyết, calibration, học) · **THỰC THI** (đo lường, anomaly, gate chất lượng) · **DATABASE** (vector, graph, ingestion).
> **Trạng thái:** mọi `file:line` trong tài liệu đã đối chiếu trực tiếp HEAD `2b3f6b4` (= origin/main, gate 595/595 PASS). Agent thực thi PHẢI grep lại call-site trước khi sửa — code trôi theo HEAD.
> **Định hướng chung:** không thay công nghệ nền (không thêm DB/framework mới). Xây **lớp thống kê học-từ-dữ-liệu** lên đúng hạ tầng đang chạy: mọi hằng số hiện đặt tay (0.80/0.35/0.5/0.92/γ=1.0) được đo, kiểm định, rồi hardcode lại TỪ DỮ LIỆU — đúng doctrine `hardcode > prompt` của dự án.

---

## 0. TÓM TẮT ĐIỀU HÀNH

| ID blueprint | Mục gốc (# báo cáo) | Trục | Việc | File chính (đã kiểm chứng) | Effort |
|---|---|---|---|---|---|
| **P0-1** | nền tảng | — | Thư viện thống kê `src/lib/stats/` — 7 module thuần toán | mới: `src/lib/stats/*` | M |
| **P1-M1** | #1 | Tư duy | Confusion matrix + Precision/Recall/F1/AUC-PR cho phán quyết evaluator | `src/lib/metrics-db.ts:323` (đã có `outcome` confirmed/refuted) | S |
| **P1-M2** | #2 | Database | nDCG@5 + MRR vào eval runner (đo thứ tự ranking) | `src/lib/eval/runner.ts:266-285` | S |
| **P1-M3** | #4 | Thực thi | IQR anomaly detector trên ToolMetric → model `MetricAnomaly` | `src/lib/tool-metrics-recorder.ts:68` | S |
| **P1-M4** | #5 | Thực thi | KPI layer — model `KpiSnapshot` + registry + API + cảnh báo | mới: `src/lib/kpi/*` | S |
| **P1-M5** | #3 | Database | Silhouette/DBI/CH đo chất lượng cụm Leiden + auto-tune γ | `src/lib/kb-routing/communities.ts:193` (γ=1.0 cứng) | M |
| **P2-M1** | #6 | Tư duy | ROC/PR sweep chọn ngưỡng từ dữ liệu (báo cáo → user duyệt) | `src/lib/structured-hypothesis.ts:30-32`, `src/lib/kb-routing/kb-access.ts:44` | S |
| **P2-M2** | #10 | Database | Wilson CI cho mọi xác suất rút từ mẫu | `src/lib/learning/historical-feedback.ts:142` | S |
| **P3-M1** | #9 | Tư duy | Logistic đa biến + L2 + odds ratio — model `CalibrationModelV2` | `src/lib/calibration-train.ts:70-95` (hiện 1 biến) | M |
| **P3-M2** | #13 | Tư duy | k-fold cross-validation cho calibration (chỉ thăng cấp khi CV thắng) | `src/lib/calibration-train.ts` | S |
| **P3-M3** | #11 | Tư duy | 3-judge median vào runtime cho phán quyết critical | `src/lib/eval/judges.ts:308`, điểm cắm `agent-goal-loop.ts:4883` | S |
| **P3-M4** | #7 | Thực thi | ROUGE-L + evidence-coverage gate cho digest/summary | `src/lib/context-compression.ts:423`, `memory-summarization.ts:51` | S |
| **P4-M1** | #8 | Tư duy | Cổng kiểm định thống kê (Welch-t/χ²/Fisher) cho Layer 9 adaptation | `src/lib/learning/adaptation-engine.ts:119,287` | M |
| **P4-M2** | #8b | Tư duy | Ghi `model` lên AgentRunRecord + ANOVA so sánh model | `src/lib/metrics-db.ts:462` (schema thiếu field) | S |
| **P5-M1** | #14 | Database | Matryoshka 512-dim pilot (collection riêng) + PCA/SVD 2D projection | `src/lib/embeddings.ts:34` (2048 cứng), `src/lib/qdrant.ts:139-213` | M |
| **P5-M2** | #17 | Database | Chunk/document dedup khi re-upload (contentHash + near-dup) | `prisma/schema.prisma:110-128` (Document), route upload `:118-121` | S |
| **P5-M3** | #16 | Database | Naive Bayes cho entity resolution | `src/lib/ingestion/entity-resolver.ts` | M |
| **P5-M4** | #12 | Thực thi | Data-quality expectations cho pipeline ingestion 14 bước | `src/app/api/ingestion/process/route.ts` (14 bước, L14-28) | S |
| **P6-M1** | #15 | Tư duy | Credit assignment — reward ledger thống nhất | `StrategyAdaptationLog` + `AgentRunRecord` (sau P4-M2) | M |
| **P6-M2** | #15 | Tư duy | Tabular Q-learning — model `QEntry` + `q-table.ts` | mới: `src/lib/learning/q-table.ts` | M |
| **P6-M3** | #15 | Tư duy | Softmax(τ) stochastic model-selection chống 429-cascade | `src/lib/llm.ts:5305-5340` (chuỗi 1-primary) | M |
| **P6-M4** | #15 | Tư duy | Q-value advisory → dropdown model + hint PLAN | `src/app/api/agents/models/route.ts:18-24` | S |

**Tổng effort:** 22 hạng mục ≈ 6 đợt triển khai (P0 → P6). Mọi hạng mục đều **additive** — không thay đổi semantics đường chạy nóng nào khi chưa có cờ bật.

---

## 1. NGUYÊN TẮC THỰC THI

1. **Hardcode từ dữ liệu, không bỏ hardcode.** Kết quả của P2 (threshold sweep) là hằng số MỚI kèm chú thích nguồn dữ liệu (ngày sweep, n mẫu, precision/recall đạt được) — theo tiền lệ `CONFIDENCE_THRESHOLD = 0.5 (user approved, option b)` tại `kb-access.ts:44`. Không đưa ngưỡng về "LLM tự quyết".
2. **Đo trước, đổi sau.** P1 tạo baseline trước khi P2/P3/P5/P6 đổi bất cứ hành vi nào. Mọi thay đổi hành vi phải đối chứng được số before/after.
3. **Fail-open cho đo lường, fail-closed cho an toàn.** Scorecard/KPI/anomaly/silhouette lỗi → trả rỗng + log, KHÔNG bao giờ làm gãy run agent. Gate chất lượng (P3-M4, P5-M2) là con đường kiểm tra thêm — lỗi gate thì fallback về đường cũ, không chặn pipeline.
4. **1 phase = 1 đợt commit** theo format `feat(P{n}-{m}): ...` — chạy `bun scripts/quality-gate.mjs` PASS trước khi push (tuyệt đối không `bun test` trực tiếp — bẫy DATABASE_URL scaffold, worklog r72).
5. **Schema chỉ additive.** Không đổi/đỡ field nào của 91 model hiện có — chỉ thêm model mới (`MetricAnomaly`, `KpiSnapshot`, `CalibrationModelV2`, `QEntry`) và field nullable mới (`EvalResult.ndcgAt5/mrr`, `EvalRun.avgNdcg/avgMrr`, `StrategyAdaptationLog.statsJson`, `AgentRunRecord.model`, `Document.contentHash`). `FailurePattern` KHÔNG đụng (schema cố ý không có agent/createdAt).
6. **Test theo pattern round.** Mỗi phase thêm `tests/r{NN}-<tên>.test.ts` (round kế tiếp = r76 trở đi) — test Stats thuần chạy DB-test-cô-lập của gate.
7. **Giao thức quan sát:** mọi lỗi quan sát được khi triển khai/lưu vận hành → append NGAY vào `Bug_v2.md` kèm ID `BUG2-0XX`, không im lặng.
8. **Cờ bật mặc định OFF** cho mọi thay đổi hành vi runtime (P3-M3 `RUNTIME_JUDGES`, P6-M3 `RUNTIME_MODEL_POLICY`, P5-M1 `MATRYOSHKA_PILOT`) — rollout từng bước sau khi đối chứng.
9. **Single-source hằng số** — mọi ngưỡng mới nằm đúng 1 chỗ, import lại (không nhân bản).

---

## 2. SƠ ĐỒ PHỤ THUỘC & THỨ TỰ TRIỂN KHAI

```
                    ┌────────────────────────────────────────────────┐
                    │  P0-1  src/lib/stats/  (THƯ VIỆN THỐNG KÊ)     │
                    │  descriptive · classification · ranking ·      │
                    │  text · cluster-quality · inference            │
                    └───────┬───────────┬───────────┬────────┬──────┘
                            │           │           │        │
        ┌───────────────────▼──┐ ┌──────▼──────┐ ┌──▼─────────▼──────┐
        │ P1 ĐO LƯỜNG NỀN      │ │ P2 NGƯỠNG   │ │ P3 CALIBRATION &   │
        │ M1 scorecard (cm)    │ │ M1 sweep    │ │    PHÁN QUYẾT      │
        │ M2 nDCG/MRR          │ │ M2 WilsonCI │ │ M1 logistic đa biến│
        │ M3 IQR anomaly       │ └──────┬──────┘ │ M2 k-fold CV       │
        │ M4 KPI layer         │        │        │ M3 3-judge runtime │
        │ M5 silhouette Leiden │        │        │ M4 ROUGE-L gate    │
        └───┬───────┬──────┬───┘        │        └─────────┬──────────┘
            │       │      │            │                  │
        ┌───▼──┐ ┌──▼───┐ ┌▼────────────▼───┐   ┌──────────▼─────────┐
        │ P5 DATABASE (song song được với P2-P4)  │ P4 CỔNG THỐNG KÊ   │
        │ M1 Matryoshka ← cần P1-M2 nDCG baseline │ M1 Welch-t/χ² gate│
        │ M2 dedup  M3 NaiveBayes  M4 expectations│ M2 model per run  │
        └────────────────────────────────────────-┘ M2 model per run  │
                                                     └──────────┬─────────┘
                                          ┌─────────────────────▼────────────┐
                                          │ P6 RL-LITE (CUỐI CÙNG)           │
                                          │ M1 credit assignment (cần P4-M2) │
                                          │ M2 Q-table   M3 softmax   M4 UI  │
                                          └──────────────────────────────────┘
```

**Thứ tự bắt buộc:** P0 → P1 (5 mục độc lập, làm song song được) → P2 → P3 → P4 → P5 → P6.
**Ngoại lệ song song:** P5 không phụ thuộc P2-P4 về thuật toán — có thể mở nhánh song song SAU P1, RIÊNG P5-M1 (Matryoshka) phải có P1-M2 (nDCG baseline) làm chuẩn đối chứng recall.
**Lý do P6 cuối cùng:** Q-learning cần reward sạch — phụ thuộc P4-M2 (biết run chạy bằng model nào) và P1-M1 (biết phán quyết đáng tin đến đâu); credit assignment (P6-M1) là nợ P1-c của BLUEPRINT-DB, giải ở đây.

---

## 3. FILE TẠO TRƯỚC — MANIFEST

**Trả lời câu hỏi "tạo/chỉnh sửa file gì trước":** tạo `src/lib/stats/` (P0-1) TRƯỚC TIÊN — 21/21 hạng mục còn lại đều import từ đây. Sau đó theo thứ tự manifest:

| Bước | TẠO MỚI | SỬA |
|---|---|---|
| 1 | `src/lib/stats/{index,descriptive,classification,ranking,text,cluster-quality,inference}.ts` | — |
| 2 | `src/lib/eval/verdict-scorecard.ts` | `src/lib/metrics-db.ts`, `prisma/schema.prisma` |
| 3 | — | `src/lib/eval/runner.ts` (+nDCG/MRR), `prisma/schema.prisma` |
| 4 | `src/lib/learning/anomaly-detector.ts` | `prisma/schema.prisma`, `src/app/api/metrics/overview/route.ts` |
| 5 | `src/lib/kpi/{registry,compute}.ts`, `src/app/api/metrics/kpi/route.ts` | `prisma/schema.prisma` |
| 6 | — | `src/lib/kb-routing/communities.ts` (+quality + γ sweep) |
| 7 | `src/lib/eval/threshold-sweep.ts`, `src/app/api/eval/threshold-sweep/route.ts` | — |
| 8 | — | `src/lib/learning/historical-feedback.ts` (+Wilson CI) |
| 9 | `src/lib/calibration-multifeature.ts` | `src/lib/calibration.ts`, `prisma/schema.prisma` |
| 10 | — | `src/lib/agent-goal-loop.ts` (điểm cắm 3-judge), `src/lib/eval/judges.ts` (tách runtime judge) |
| 11 | — | `src/lib/context-compression.ts`, `src/lib/memory-summarization.ts` (+gate) |
| 12 | — | `src/lib/learning/{strategy-adapter,adaptation-engine}.ts` (+stats gate), `prisma/schema.prisma` |
| 13 | — | `src/lib/metrics-db.ts` (+model field), `src/lib/agent-goal-loop.ts` (ghi model) |
| 14 | — | `src/lib/embeddings.ts` (+truncateVector), `src/lib/qdrant.ts` (+collection pilot) |
| 15 | — | `src/app/api/ingestion/upload/route.ts` (+contentHash), process route (+near-dup) |
| 16 | — | `src/lib/ingestion/entity-resolver.ts` (+Naive Bayes) |
| 17 | — | process route (+expectations) |
| 18-21 | `src/lib/learning/q-table.ts` | `src/lib/llm.ts` (+softmax), `src/app/api/agents/models/route.ts` |

Mỗi bước = 1 hạng mục dưới đây. Chi tiết đầy đủ theo từng mục.

---

# PHASE P0 — NỀN TẢNG: THƯ VIỆN THỐNG KÊ

## P0-1 · `src/lib/stats/` — 7 module thuần toán (tạo TRƯỚC TIÊN)

**Mục tiêu & nguồn:** Toàn bộ công thức đối chiếu từ 4 tài liệu (ML.pdf §Metrics/§Ranking/§ROUGE, MATH.pdf §Thống kê suy luận/§Linear Algebra, DA.pdf §CLT/§Outlier IQR). Không có sẵn bất kỳ util thống kê dùng chung nào (grep xác nhận — chỉ `calibration-metrics.ts` có brier/ece, `alista/collectors.ts:620-816` có mean/stddev/zScore inline riêng tư, không đụng).

**Thiết kế — 7 file:**

```ts
// src/lib/stats/descriptive.ts — DA.pdf §Pandas/§EDA
export function mean(xs: number[]): number
export function median(xs: number[]): number
export function quantile(xs: number[], q: number): number  // linear interpolation
export function iqrBounds(xs: number[], k = 1.5): { low: number; high: number; q1: number; q3: number }
export function stddev(xs: number[]): number               // mẫu (n−1)
export function zScore(x: number, mu: number, sigma: number): number

// src/lib/stats/classification.ts — ML.pdf §1,§3,§4,§8
export interface ConfusionMatrix { tp: number; fp: number; fn: number; tn: number }
export function confusionMatrix(predicted: boolean[], actual: boolean[]): ConfusionMatrix
export function prf1(m: ConfusionMatrix): { precision: number; recall: number; f1: number; specificity: number; balancedAccuracy: number }
export function logLoss(ps: number[], ys: number[]): number      // −mean(y·ln p + (1−y)·ln(1−p)), clamp p∈[1e−9, 1−1e−9]
export interface CurvePoint { threshold: number; tpr: number; fpr: number; precision: number; recall: number }
export function sweepThresholds(scores: number[], actuals: boolean[]): CurvePoint[]  // duyệt ngưỡng giảm dần
export function aucRoc(points: CurvePoint[]): number            // tích phân trapz
export function aucPr(points: CurvePoint[]): number             // step-wise (đúng chuẩn PR, không trapz)

// src/lib/stats/ranking.ts — ML.pdf §6 (MAP, nDCG, Hit Ratio)
export function ndcgAtK(relevance: number[], k: number): number  // DCG=Σ rel_i/log2(i+1), chia IDCG
export function mrr(relevance: number[]): number                 // mean(1/rank relevant đầu tiên)
export function hitAtK(relevance: number[], k: number): boolean
export function averagePrecision(relevance: number[]): number

// src/lib/stats/text.ts — ML.pdf §NLP Evaluation
export function rougeL(reference: string, hypothesis: string): { precision: number; recall: number; f1: number }  // LCS
export function tokenSetF1(a: string, b: string): number        // giao/tập-hợp trên token

// src/lib/stats/cluster-quality.ts — ML.pdf §5
export function silhouetteScore(vectors: number[][], labels: number[], dist?: (a: number[], b: number[]) => number): number // s(i)=(b−a)/max(a,b), chuẩn 1−cos
export function silhouetteFromGraph(n: number, edges: { source: number; target: number; weight: number }[], labels: number[]): number // biến thể đồ thị: a(i)=trung bình trọng số cạnh nội cụm, b(i)=cụm khác gần nhất
export function daviesBouldin(vectors: number[][], labels: number[]): number   // càng thấp càng tốt
export function calinskiHarabasz(vectors: number[][], labels: number[]): number // càng cao càng tốt

// src/lib/stats/inference.ts — MATH.pdf §Thống kê suy luận + DA.pdf §Hypothesis Testing
export function wilsonCI(p: number, n: number, z = 1.96): { low: number; high: number }  // (p̂+z²/2n ± z√(p̂(1−p̂)/n+z²/4n²))/(1+z²/n)
export function meanCI(xs: number[], z = 1.96): { mean: number; low: number; high: number; n: number } // x̄ ± z·s/√n (CLT)
export function welchTTest(a: number[], b: number[]): { t: number; df: number; p: number }  // df Welch–Satterthwaite
export function mannWhitneyU(a: number[], b: number[]): { u: number; z: number; p: number }  // hiệu chỉnh tie
export function chiSquare2x2(a: number, b: number, c: number, d: number): { chi2: number; p: number }  // Yates khi cell<5 → Fisher exact
export function fisherExact2x2(a: number, b: number, c: number, d: number): number            // p một phía
export function anovaF(groups: number[][]): { f: number; dfBetween: number; dfWithin: number; p: number }
export function normalCdf(z: number): number  // erf xấp xỉ Abramowitz–Stegun — KHÔNG thêm dependency
```

**Ràng buộc:** thuần hàm, 0 dependency ngoài stdlib, 0 DB, 0 LLM, 0 side-effect. `index.ts` re-export toàn bộ public API. Không tái xuất `brierScore/ece` từ `calibration-metrics.ts` (tránh vòng import — hai module độc lập).

**Các bước:**
1. Tạo 7 file + `index.ts`.
2. Test `tests/r76-stats-core.test.ts`: mỗi hàm ≥2 case đối chứng tay (ví dụ: confusion `{tp:8,fp:2,fn:1,tn:9}` → precision 0.8/recall 0.889/F1 0.842; wilsonCI(0.8, 25) → [0.616, 0.910]; ndcgAtK([1,0,1], 3) = 0.920; rougeL("the cat sat", "the cat") recall 1.0...).
3. Chạy gate.

**Kiểm chứng:** gate PASS với test mới; `bunx tsc --noEmit` sạch; import từ 2 nơi khác nhau chạy được (smoke).

**Rủi ro & rollback:** Thấp nhất blueprint — code chết cho tới khi P1 import. Rollback = xoá thư mục.

---

# PHASE P1 — ĐO LƯỜNG NỀN (baseline, KHÔNG đổi hành vi)

## P1-M1 · Verdict Scorecard — Confusion matrix + P/R/F1/AUC-PR cho evaluator (mục #1)

**Mục tiêu & nguồn:** ML.pdf §Classification Metrics + §Evaluation Curves. Đo trực diện độ tin cậy của lời tuyên bố "complete" — chỉ tiêu đánh bẹp lớp bug "model tự nhận hoàn thành" (GHI-NHẬN-d).

**Hiện trạng (đã kiểm chứng):** `ArbiterVerdict` đã có sẵn toàn bộ chuỗi ground-truth: `complete` (verdict hiệu lực sau verify-guard), `confidence`, `forcedDowngrade`, và quan trọng nhất `outcome: confirmed|refuted` + `runComplete` do `resolveArbiterVerdicts(sessionId, runComplete, stopReason)` ghi cuối run (`metrics-db.ts:323`, call `agent-goal-loop.ts:5621`; ground truth = `stopReason === 'complete'` tại `:5565`). Đã có sẵn hàm đọc `findArbiterVerdictsForCalibration(limit=2000)` lọc `outcome IS NOT NULL` (`metrics-db.ts:267-290`). **Chỉ thiếu đúng phép tính confusion matrix — không cần schema mới.**

**Thuật toán:**
- Ma trận nhầm lẫn: predicted = `verdict.complete`, actual = `verdict.runComplete` (đã resolve). TP = tuyên bố xong & thật sự xong; FP = tuyên bố xong nhưng run không complete (nguy hiểm nhất); FN = báo chưa xong nhưng run complete (mất cơ hội chốt sớm); TN = đúng báo chưa xong.
- AUC-PR trên cặp (`confidence`, `runComplete`) — dữ liệu lệch lớp (complete hiếm) nên AUC-PR đúng hơn AUC-ROC (ML.pdf §3).
- Phân tầng: tổng + theo `agentName` + theo `forcedDowngrade=true/false` (đo riêng nhóm verdict bị verify-guard hạ).

**Thiết kế:**
```ts
// src/lib/eval/verdict-scorecard.ts (MỚI)
export interface VerdictScorecard {
  n: number; tp: number; fp: number; fn: number; tn: number
  precision: number; recall: number; f1: number; specificity: number
  aucPr: number | null; brier: number; ece: number | null
  byAgent: Array<{ agentName: string; n: number; precision: number; f1: number }>
  forcedDowngrade: { n: number; fpWithoutGuard: number }  // đếm verdict đã bị hạ — FP nếu không có guard
}
export async function computeVerdictScorecard(windowDays = 30): Promise<VerdictScorecard>
// src/app/api/eval/verdict-scorecard/route.ts (MỚI) — GET ?windowDays=, fail-open
```
Sửa `metrics-db.ts`: thêm `findResolvedVerdictsForScorecard(windowDays)` (select đủ cột, cap 5000, index `[outcome]` + `[createdAt]` đã có).

**Các bước:** 1) hàm đọc trong `metrics-db.ts` → 2) `verdict-scorecard.ts` dùng `stats/classification` + `calibration-metrics` (brier/ece tái dùng) → 3) route GET → 4) test `r76-verdict-scorecard.test.ts` (seed ArbiverVerdict giả nhận ma trận đã biết).

**Kiểm chứng:** chạy route trên DB thật trả JSON có n>0 (nếu DB còn ít verdict resolved → trả n=0 + ghi chú "chờ dữ liệu", KHÔNG lỗi); `precision` khớp tính tay từ confusion matrix seed trong test.

**Rủi ro & rollback:** read-only hoàn toàn — không thể hỏng runtime. Rollback = xoá 2 file.

## P1-M2 · nDCG@5 + MRR cho retrieval eval (mục #2)

**Mục tiêu & nguồn:** ML.pdf §Ranking Metrics (nDCG, MRR, Hit@K) — đo **thứ tự** trả về của hybrid search (BM25+RRF+MMR), thứ mà recall@5 không thấy được. Là baseline bắt buộc trước khi quyết định host reranker bge-reranker-v2-m3 (560MB).

**Hiện trạng (đã kiểm chứng):** `runner.ts:266` có sẵn `top5 = kb.chunks.slice(0,5)` — `kb.chunks` là danh sách **đã xếp hạng**, mỗi phần tử `{text, score}`; `expectedEntities: {name, type}[]` + `normalizeForEntityMatch` (:84). Hiện chỉ tính `recallAt5` (:277) và `extractionF1` (:280-285). `EvalResult` chưa có cột nDCG/MRR.

**Thuật toán:** relevance nhị phân per chunk: chunk i relevant ⇔ ∃ entity chưa khớp nào xuất hiện (substring normalized) trong `chunk.text` — tái dùng đúng bộ khớp của recall@5 để đảm bảo nhất quán. Sau đó `ndcgAtK(rel, 5)`, `mrr(rel)` từ `stats/ranking`.

**Thiết kế:** Schema (additive):
```prisma
model EvalResult { /* thêm */ ndcgAt5 Float @default(0)  mrr Float @default(0) }
model EvalRun    { /* thêm */ avgNdcg Float @default(0) avgMrr Float @default(0) }
```
Sửa `runner.ts`: tại khối :266-285, tính `rel: number[]` song song với `expectedEntitiesRetrieved` (dùng chung vòng lặp — không gọi thêm phép match nào), ghi 2 cột mới + aggregate cuối run (:350-366) + dòng log `recall@5=… ndcg@5=… mrr=…` (:339).

**Các bước:** 1) schema + `bun run db:push` → 2) tính trong runner → 3) test `r76-ndcg-mrr.test.ts` (case mock 5 chunk: relevant ở vị trí 2,5 → nDCG xác định được bằng tay) → 4) chạy 1 eval run thật ghi nhận baseline (lưu số vào PR mô tả — đây là baseline cho P5-M1).

**Kiểm chứng:** eval run mới có `avgNdcg/avgMrr` ≠ 0; eval run cũ không bị lỗi (cột default 0); nDCG ∈ [0,1].

**Rủi ro & rollback:** additive, default 0 — eval cũ không đổi nghĩa. Rollback = bỏ ghi cột.

## P1-M3 · IQR Anomaly Detector trên ToolMetric (mục #4)

**Mục tiêu & nguồn:** DA.pdf §Outlier Detection (IQR/boxplot) — phát hiện tool chạy bất thường (thời lượng/output) mà errorTag không bắt được.

**Hiện trạng (đã kiểm chứng):** `recordToolMetric` (`tool-metrics-recorder.ts:68`) fire-and-forget ghi `durationMs/success/errorTag`; rollup `ToolMetricDaily` có `topErrorTags`. `/api/metrics/overview` chỉ đếm successRate/avgDuration — không có phát hiện bất thường.

**Thuật toán:** Cửa sổ 7 ngày theo (toolName, agentRole): `iqrBounds(durations, 1.5)` → bất thường nếu `durationMs > high` (kèm điều kiện n≥20 cho từng nhóm — dưới ngưỡng bỏ qua, chống nhiễu mẫu nhỏ, đúng LLN/CLT); bất thường mới = ngoài bound trong 24h qua. Điểm bất thường có `score = (x − q3)/iqr`.

**Thiết kế:**
```prisma
model MetricAnomaly {
  id        String   @id @default(cuid())
  kind      String   // tool_duration_high | tool_error_burst
  toolName  String
  agentRole String
  value     Float    // durationMs hoặc error-rate
  bound     Float    // q3 + 1.5·iqr
  score     Float    // (value−q3)/iqr
  sessionId String?
  observedAt DateTime @default(now())
  @@index([kind, observedAt]) @@@index([toolName, observedAt])
}
```
```ts
// src/lib/learning/anomaly-detector.ts (MỚI)
export interface AnomalyScanResult { scanned: number; anomalies: number; byTool: Array<{ toolName: string; n: number; anomalies: number }> }
export async function scanToolMetricAnomalies(lookbackDays = 7): Promise<AnomalyScanResult>  // fail-open toàn phần
```
Hook chạy: ① API `POST /api/metrics/anomalies/scan` (thủ công) ② gọi thêm trong `/api/metrics/overview` GET khi `?scan=1` (cache 10 phút, `TmoCache`). Không thêm cron mới ở bước này.

**Các bước:** 1) schema + push → 2) `anomaly-detector.ts` (query `toolMetric.findMany` cửa sổ 7d, group bằng Map, `stats/descriptive.iqrBounds`) → 3) route → 4) test `r76-anomaly-iqr.test.ts` (seed 25 lần gọi `run_tests` 1-3s + 1 lần 90s → bắt đúng 1 anomaly kind `tool_duration_high`).

**Kiểm chứng:** scan trên DB thật: trả `scanned>0`; anomaly sinh ra có `bound < value`; chạy 2 lần liên tiếp không nhân bản anomaly (idempotent theo (kind, toolName, value, observedAt truncate giờ)).

**Rủi ro & rollback:** ghi bảng mới, không đụng ToolMetric. Bảng phình nếu quên prune → thêm sweep xóa anomaly >30 ngày ngay từ đầu.

## P1-M4 · KPI Layer (mục #5)

**Mục tiêu & nguồn:** DA.pdf §KPIs and Metrics — lớp chỉ số có tên, có mục tiêu, có trạng thái, thay cho số liệu rời rạc.

**Hiện trạng:** `/api/metrics/overview` trả 4 section (tokens/tools/runs/alerts) — không có khái niệm KPI/target/trend. Không có model snapshot KPI (đã xác nhận).

**Thiết kế:**
```prisma
model KpiSnapshot {
  id String @id @default(cuid())
  date String  // YYYY-MM-DD UTC — 1 snapshot/ngày/KPI
  kpi String  // khóa registry
  value Float
  sampleSize Int @default(0)
  meta String @default("{}")  // JSON: breakdown
  @@unique([date, kpi]) @@index([kpi, date])
}
```
```ts
// src/lib/kpi/registry.ts (MỚI) — SINGLE SOURCE định nghĩa
export interface KpiDef { key: string; label: string; goal: 'higher'|'lower'; target?: number; compute: () => Promise<{ value: number; n: number; meta?: Record<string, unknown> }> }
export const KPI_REGISTRY: KpiDef[] = [
  // mission_success_rate    — AgentRunRecord 24h: completed/(completed+failed+incomplete)
  // verdict_precision       — từ P1-M1 scorecard (FP = tuyên bố xong giả)
  // verdict_f1              — từ P1-M1
  // tool_success_rate       — ToolMetric 24h
  // anomaly_count_24h       — MetricAnomaly (P1-M3)
  // eval_ndcg / eval_recall — EvalRun mới nhất
  // kb_fallback_rate        — searchUserKB: tỉ lệ rơi xuống Model-Knowledge (confidence < 0.5)
  // delegation_ratio        — AgentRunRecord có delegation / tổng (chống vượt trần 2/run)
]
// src/lib/kpi/compute.ts (MỚI) — computeAllKpis() upsert KpiSnapshot hôm nay (idempotent theo unique)
// src/app/api/metrics/kpi/route.ts (MỚI) — GET: danh sách KPI hôm nay + 7 ngày gần nhất + status so target
```
Mỗi `compute` fail-open độc lập (1 KPI lỗi không kéo cả bảng — đúng pattern overview route). Status: `on_target | near | off` theo target ±10%.

**Các bước:** 1) schema + push → 2) registry (khoanh vùng 8 KPI đầu, mở rộng dần) → 3) compute + upsert → 4) route → 5) gọi compute trong `/api/metrics/overview` khi `?kpi=1` → 6) test `r76-kpi-layer.test.ts`.

**Kiểm chứng:** GET `/api/metrics/kpi` trả ≥8 KPI có value; gọi 2 lần không nhân bản snapshot (unique date+kpi); KPI verdict_precision khớp số P1-M1.

**Rủi ro & rollback:** additive. KPI nào compute đắt → guard cache 10 phút.

## P1-M5 · Chất lượng cụm Leiden: Silhouette/DBI/CH + auto-tune γ (mục #3)

**Mục tiêu & nguồn:** ML.pdf §Clustering Metrics — Leiden hiện chạy best-of-3 theo modularity nhưng không đo chất lượng phân cụm; γ (resolution) cứng 1.0.

**Hiện trạng (đã kiểm chứng):** `leiden.ts` đã trả `LeidenResult.modularity` (có sẵn, :169 computeModularity) — KHÔNG có silhouette/DBI/CH. `communities.ts:193` gọi `leidenCommunityDetection(len, edges, { restarts: LEIDEN_RESTARTS, resolution: 1.0 })`; ghi `CommunityDetectStats.modularity`. Write-back Neo4j `writeCommunityIdsToNeo4j` (:365) + embed summary vào `theopus_communities` (:437/:485).

**Thuật toán:**
- **Silhouette biến thể đồ thị** (chính): với mỗi node i, `a(i)` = trung bình trọng số cạnh nội cụm (không cạnh nội → a=0), `b(i)` = max theo cụm khác của trung bình trọng số cạnh liên cụm; `s(i) = (b−a)/max(a,b)`; nhân trọng số qua `w' = w / (1+w)` chuẩn hóa. Dùng `silhouetteFromGraph` từ `stats/cluster-quality` — không cần embedding node.
- DBI/CH: cần vector — chạy trên embedding summary các cụm (đã có sẵn trong `theopus_communities`) như chỉ số phụ, chỉ informative.
- **Auto-tune γ:** chạy grid `γ ∈ {0.5, 0.8, 1.0, 1.2, 1.5}` × restarts=3, chọn γ maximizing `silhouette` (kèm tie-break modularity). Env `LEIDEN_AUTO_TUNE=on` mặc định OFF — bật sau khi quan sát 2-3 lần chạy so sánh.

**Thiết kế:** Sửa `communities.ts`: `CommunityDetectStats` thêm `silhouette: number | null; gammaSwept: number | null`; hàm mới `evaluateCommunityQuality(labels, edges)` gọi stats; hàm mới `detectAndStoreCommunitiesWithSweep()` (bọc bản hiện tại, đo trước khi write-back — KHÔNG đổi hành vi write-back khi auto-tune OFF). Route: thêm quality vào `getCommunityStatus()` (:555).

**Các bước:** 1) stats đã có (P0) → 2) `evaluateCommunityQuality` → 3) gắn vào flow hiện tại (đo + log, chưa đổi γ) → 4) sweep mode env-gated → 5) test `r76-leiden-quality.test.ts` (graph 3 cụm rõ + 1 graph nhiễu → silhouette cao/thấp đúng chiều; so sánh γ sweep chọn đúng γ của graph dựng sẵn).

**Kiểm chứng:** 1 lần chạy `detectAndStoreCommunities` thật log `silhouette=X modularity=Y`; sweep trên graph test chọn đúng γ; KHÔNG đổi communityId đang chạy khi auto-tune OFF (so sánh hash community trước/sau).

**Rủi ro & rollback:** Leiden chạy offline (route chủ động) — không đụng đường nóng. Sweep ×5 chi phí chỉ đáng kể khi bật. Rollback = flag OFF.

---

# PHASE P2 — NGƯỠNG HỌC TỪ DỮ LIỆU

## P2-M1 · ROC/PR Sweep — báo cáo ngưỡng tối ưu (mục #6)

**Mục tiêu & nguồn:** ML.pdf §Evaluation Curves — mọi ngưỡng hardcode hiện nay (SHR `PROMOTE_POSTERIOR: 0.80` / `DEMOTE_POSTERIOR: 0.35` tại `structured-hypothesis.ts:30-32`; KB `CONFIDENCE_THRESHOLD = 0.5` tại `kb-access.ts:44`; evaluator clamp 0.3 tại `agent-goal-loop.ts:1533`) chưa từng được sweep trên dữ liệu.

**Thuật toán:** Với từng chuỗi (score, actual): `sweepThresholds` (P0) → bảng (threshold, precision, recall, F1, TPR/FPR) + AUC. Với evaluator confidence: `actual = runComplete` từ ArbiterVerdict resolved — cùng nguồn P1-M1. Với SHR posterior: dữ liệu HypothesisRecord (α/β + status promoted/demoted sau đối chứng) — v1 chỉ làm evaluator + KB confidence (SHR cần dữ liệu verdict hypothesis đã đủ nhiều, ghi vào mục "chờ dữ liệu").

**Thiết kế:**
```ts
// src/lib/eval/threshold-sweep.ts (MỚI)
export interface SweepReport { target: 'evaluator_confidence' | 'kb_confidence'; n: number; aucPr: number | null; aucRoc: number | null
  points: CurvePoint[]; recommended: Array<{ criterion: 'max_f1' | 'precision_gte_0.9' | 'recall_gte_0.9'; threshold: number; precision: number; recall: number; f1: number }> }
export async function sweepEvaluatorThresholds(windowDays = 60): Promise<SweepReport>   // ArbiterVerdict resolved
export async function sweepKbConfidence(): Promise<SweepReport>                          // EvalResult rawConfidence × faithfulnessMedian>0.7 (đúng Y calibration hiện tại)
// src/app/api/eval/threshold-sweep/route.ts (MỚI) — GET ?target=
```
**KHÔNG tự đổi hằng số.** Kết quả sweep → bảng trình user duyệt (tiền lệ `CONFIDENCE_THRESHOLD` option-b). Khi user duyệt: đổi hằng số kèm comment mới ghi rõ `swept YYYY-MM-DD, n=…, precision/recall đạt` — vẫn hardcode, nhưng có nguồn gốc dữ liệu.

**Các bước:** 1) 2 hàm sweep → 2) route → 3) chạy trên dữ liệu thật, xuất bảng cho user → 4) chờ duyệt → 5) cập nhật hằng số được duyệt + test hồi quy (`r77-threshold-updates.test.ts` chặn giá trị cũ nếu dữ liệu đã chỉ ra khác).

**Kiểm chứng:** route trả bảng điểm đủ mốc ngưỡng 0.1..0.9; AUC khớp P1-M1 (cùng nguồn); mọi thay đổi hằng số có comment ngày + n mẫu.

**Rủi ro & rollback:** KHÔNG đổi hành vi nào cho tới khi user duyệt — rủi ro gần 0. Rollback hằng số = git revert.

## P2-M2 · Wilson CI cho mọi xác suất từ mẫu (mục #10)

**Mục tiêu & nguồn:** MATH.pdf §Confidence Interval + DA.pdf §CLT/Standard Error — xác suất rút từ đếm thô hiện không kèm khoảng tin cậy; các consumer tacit tin số với n nhỏ.

**Hiện trạng (đã kiểm chứng):** `getSuccessProbability(taskType, routingMode, metrics)` (`historical-feedback.ts:142`) trả số thô từ `successRate` đếm được; `getAdjustedBudget` đã có khái niệm `minRunsForFeedback = 5` nhưng threshold sinhSurvival không có CI.

**Thiết kế:**
- Sửa `AggregatedMetrics` group: thêm `successCI: { low: number; high: number }` (Wilson, z=1.95≈1.96) tính ngay khi aggregate trong `analyzeHistoricalFeedback` (:16) — có n mỗi nhóm sẵn (`sampleSize`).
- `getSuccessProbability` giữ nguyên CHỮ KÝ số (không phá 5 caller) — thêm hàm song song `getSuccessProbabilityWithCI(): { p: number; low: number; high: number; n: number }`.
- Consumer quyết định (strategy-adapter `getAdjustedBudget`, recommendAdaptation): dùng bản có CI — chỉ tin khi `n ≥ 5 ∧ (high − low) ≤ 0.5`; ngược lại rơi về nhánh fallback tổng thể (đã có chain fallback sẵn).
- Eval runner: aggregate `avgRecallAt5/avgNdcg` kèm `meanCI` — ghi vào log dòng kết quả (không thêm cột schema, v1 chỉ log + JSON meta của EvalRun qua `errorMessage`? KHÔNG —EvalRun không có cột meta → ghi CI vào log + KPI meta (P1-M4) thay thế).

**Các bước:** 1) `stats/inference.wilsonCI` (P0) → 2) gắn vào analyzeHistoricalFeedback → 3) hàm WithCI + consumer guard → 4) log CI eval → 5) test `r77-wilson-ci.test.ts` (n=5, p=0.8 → CI rộng ~[0.38, 0.96] — chứng minh cấm act trên 5 mẫu).

**Kiểm chứng:** mọi consumer cũ không đổi kết quả khi n lớn; test xác nhận số CI nhỏ bị chặn.

**Rủi ro & rollback:** hàm mới song song — không phá signature cũ. Rollback từng phần độc lập.

---

# PHASE P3 — CALIBRATION & CHẤT LƯỢNG PHÁN QUYẾT

## P3-M1 · Logistic đa biến + L2 + Odds Ratio (mục #9)

**Mục tiêu & nguồn:** MATH.pdf §Logistic (Prediction with Multiple Features, Interpreting Coefficients — Odds Ratio, Regularization L2). Nâng calibration 1 biến → đa biến; odds ratio cho biết đặc trưng nào đẩy nguy cơ phán quyết sai.

**Hiện trạng (đã kiểm chứng):** `calibration-train.ts:70-95`: X = `EvalResult.rawConfidence` duy nhất, Y = `faithfulnessMedian > 0.7`, GD lr 0.01 × 1000 epochs, upsert 1 row `CalibrationModel { id: 'default' }`. Runtime `getCalibratedConfidence` (`calibration.ts:23`) sigmoid 1 biến, gate `sampleSize ≥ 20` (fail-open).

**Thuật toán:** z = β₀ + Σⱼ βⱼ·x̂ⱼ (chuẩn hóa x̄ theo mean/std的训练 tập), σ(z); huấn luyện GD mini-batch + **điều chuẩn L2** λ=0.01 (MATH.pdf §Regularization — chống quá khớp khi đặc trưng tương quan); **odds ratio** ORⱼ = e^βⱼ (đọc: đặc trưng j tăng 1σ → nhân odds sai lệch ORⱼ lần).

**Bộ đặc trưng (từ EvalResult + join EvalCase — đều có sẵn):**
```
x1 = rawConfidence          (thành phần hiện tại — tương thích v1)
x2 = coverage               (0-1)
x3 = answered ? 1 : 0
x4 = retrievedChunks (log1p, chuẩn hóa)
x5 = extractionF1
x6 = hallucinationDetected ? 1 : 0
x7 = case.difficulty (map easy=0/medium=0.5/hard=1)
x8 = case.category (one-hot gộp: programming|ml|security|other → 3 nhị phân)
```
Target giữ nguyên Y = `faithfulnessMedian > 0.7` (không đổi semantics so v1 — so sánh được).

**Thiết kế:**
```prisma
model CalibrationModelV2 {
  id String @id @default("default")
  featureNames String  // JSON thứ tự đặc trưng
  means String; stds String          // JSON chuẩn hóa
  coefficients String                // JSON β
  intercept Float
  oddsRatios String                  // JSON e^β — diễn giải
  sampleSize Int
  cvBrier Float?; cvBrierCi String?  // từ P3-M2
  brierV1 Float?                     // đối chứng v1 trên cùng tập
  active Boolean @default(false)     // bật runtime sau khi thắng CV
  trainedAt DateTime @updatedAt
}
```
```ts
// src/lib/calibration-multifeature.ts (MỚI)
export interface MultiFeatureTrainResult { trained: boolean; sampleSize: number; cvBrier: number | null; brierV1: number | null; improved: boolean; oddsRatios: Record<string, number> }
export function buildFeatureVector(er: EvalResultRow, ec: EvalCaseRow | null): number[]  // export riêng để test
export async function trainCalibrationModelV2(): Promise<MultiFeatureTrainResult>
export async function getCalibratedConfidenceV2(rawConfidence: number, features?: Partial<FeatureCtx>): Promise<number>  // thiếu features → fallback v1
```
Sửa `calibration.ts`: `getCalibratedConfidence` thử V2-active trước, fallback V1 (không đổi chữ ký — 1 caller `kb-access.ts:286` không cần sửa nếu features partial đủ; features đầy đủ khi caller truyền thêm — nâng cấp `searchUserKB` truyền context sau).

**Các bước:** 1) schema + push → 2) feature builder (test độc lập trước) → 3) train + L2 + CV (P3-M2 làm ngay trong cùng file) → 4) so brier V2 vs V1 trên cùng hold-out → chỉ khi `improved` mới set `active=true` → 5) runtime ưu tiên V2 → 6) test `r77-calibration-v2.test.ts` (tổng hợp: dữ liệu nhân tạo có quan hệ thật giữa x2/x6 và Y → V2 bắt được, V1 không).

**Kiểm chứng:** `oddsRatios` in ra có nghĩa (vd hallucinationDetected OR>1); active chỉ bật khi CV thắng; fail-open giữ nguyên (thiếu model → rawConfidence).

**Rủi ro & rollback:** `active=false` mặc định — runtime không đổi tới khi đối chứng xong. Rollback = tắt active.

## P3-M2 · k-fold Cross-Validation (mục #13)

**Mục tiêu & nguồn:** ML.pdf §Tips ("luôn kiểm định lại kết quả bằng test set hoặc cross-validation") — V2 chỉ được tin khi thắng CV.

**Thiết kế:** Trong `trainCalibrationModelV2`: 5-fold stratified (giữ tỉ lệ Y mỗi fold), huấn luyện trên 4 fold / đo Brier trên 1 fold; `cvBrier = mean(fold Brier)`, `cvBrierCi = meanCI(fold Briers)` (P0 stats). Cùng lúc đo `brierV1` = Brier của model 1-biến hiện tại trên cùng hold-out. `improved = cvBrier < brierV1`.

**Kiểm chứng:** test xác định trên dữ liệu có quan hệ phi tuyến theo x2: cvBrier V2 < brierV1; CV trên dữ liệu thuần noise: improved=false (chống tự huyễn hoặc).

## P3-M3 · 3-judge median vào runtime cho phán quyết critical (mục #11)

**Mục tiêu & nguồn:** ML.pdf §Random Forest (ensemble giảm phương sai) + §GPT-4 as Judge. Đưa trọng tài đa số từ eval-only vào runtime cho các phán quyết đắt giá.

**Hiện trạng (đã kiểm chứng):** `judgeAnswer` (`judges.ts:308`) = 3 judge chéo họ model (OpenAI/NIM + Anthropic/Kimi + NIM minimax binary-rubric), median với sentinel −1, all-fail → 0.5 — CHỈ dùng trong eval. Runtime evaluator goal-loop = 1 call `parseEvalVerdict` (`agent-goal-loop.ts:1519`), verdict ghi `insertArbiterVerdict` tại :4883.

**Thiết kế:**
- Tách từ `judges.ts` lõi tái dùng: `export async function runtimeJudgeVerdict(contextSummary: string, criteria: string[]): Promise<{ median: number; scores: number[] }>` — dùng đúng 3 model family hiện có (không thêm model mới).
- Điểm cắm `agent-goal-loop.ts` EVALUATE phase, SAU `parseEvalVerdict` thành công: khi `RUNTIME_JUDGES=off|critical|all` (mặc định `off`):
  - `critical` = run thỏa: `stopReason dự kiến === 'complete'` ∧ (`toolCalls ≥ 20` ∨ `cycles ≥ 0.8·max_cycles`) — đúng lớp run đắt tiền, sai phán quyết tốn nhất.
  - Median 3 judge đánh verdict trên bộ tiêu chí rút gọn từ 18 rules hiện hành (5 tiêu chí lõi: evidence-verified / E2E-passed / todo-closed / no-derived-number / debt-ready).
  - Nếu `median < 0.5` ∧ verdict.complete=true → hạ complete=false, ghi `ArbiterVerdict.rootCause += '[3judge-downgrade]'` + `forcedDowngrade=true` (tái dùng field sẵn — không schema mới).
- Chi phí guard: tối đa 1 lần 3-judge/run (flag per-run), timeout 30s/judge fail-open (bỏ qua nếu lỗi — KHÔNG chặn verdict gốc).

**Các bước:** 1) tách runtimeJudgeVerdict → 2) cờ + điểm cắm goal-loop → 3) test `r77-runtime-judges.test.ts` (mock judge: 2/3 chấm fail → verdict bị hạ đúng 1 lần, rootCause có tag; judge lỗi hết → verdict gốc giữ nguyên).

**Kiểm chứng:** flag OFF mặc định — hành vi cũ 100% khi chưa bật; bật `critical` trên 1 run thử: log thấy 1 lần gọi 3-judge; verdict downgrade có tag đối chiếu được.

**Rủi ro & rollback:** chi phí 3 call LLM mỗi run critical (chỉ khi bật); fail-open mọi tầng. Rollback = flag off.

## P3-M4 · ROUGE-L + Evidence-coverage gate cho digest/summary (mục #7)

**Mục tiêu & nguồn:** ML.pdf §ROUGE/BERTScore — kiểm tra mất thông tin khi nén ngữ cảnh / tóm tắt bộ nhớ, bằng độ đo rẻ (không LLM).

**Hiện trạng (đã kiểm chứng):** `compressConversation` (`context-compression.ts:423`) — digest LLM qua `callUtilityLLM` + fallback heuristic sẵn; `CompressionResult` đã có `digest/method/receipt` nhưng KHÔNG có kiểm tra chất lượng (chỉ length). `summarizeMemories` (`memory-summarization.ts:51`) chỉ sanity-check độ dài. Bằng chứng lo mất: digest cắt 50k→4k chars.

**Thuật toán:**
- **Evidence coverage (chính, cho compression):** từ `CompressEvidenceEntry[]` (đã có interface `kind/tool/success/text`) — trích danh từ kỹ thuật + số dẫn chứng (regex camelCase/snake_case, số, đường dẫn) từ các entry, tính tỉ lệ xuất hiện (substring) trong digest. Gate: `coverage ≥ 0.7` (hằng số `DIGEST_EVIDENCE_COVERAGE_MIN`).
- **ROUGE-L recall (phụ, cho summarization):** `rougeL(unionContent, summary).recall` — đo phủ nội dung nguồn qua union mẫu đại diện; gate `≥ 0.3` cho summary nén 90% (mục tiêu nén — không đòi 0.7).
- Rớt gate → **fallback heuristic deterministic** (đường đã có sẵn cho compression) / `batch[0]` (đường sẵn cho summarization) + log `digest-gate-fallback` + đếm vào KPI `digest_gate_fallback_rate`.

**Thiết kế:** Sửa 2 file: trong `compressConversation` sau khi có digest LLM → `checkDigestGate(digest, evidence)` (hàm mới internal, dùng `stats/text`); trong `summarizeMemories` sau summary → `rougeL` check trước khi accept. KHÔNG đổi接口 — kết quả rớt gate đơn giản đổi `method: 'heuristic'` (đường có sẵn).

**Các bước:** 1) 2 hàm gate internal → 2) gắn sau LLM call → 3) test `r77-digest-gate.test.ts` (digest bỏ hết số liệu → coverage 0 → fallback heuristic; digest giữ đủ → method 'llm' giữ).

**Kiểm chứng:** chạy thật 1 mission dài: log thấy gate pass/fallback với số liệu cụ thể; KHÔNG tăng chi phí LLM (gate là toán thuần).

**Rủi ro & rollback:** fallback heuristic chất lượng thấp hơn digest LLM — nhưng đó là trạng thái an toàn đã được thiết kế sẵn (evidence-preserving); gate chỉ kích hoạt khi LLM digest quá tệ. Rollback = hằng số về 0.

---

# PHASE P4 — CỔNG KIỂM ĐỊNH THỐNG KÊ CHO VÒNG HỌC (LAYER 9)

## P4-M1 · Welch-t / χ² / Fisher gate cho adaptation (mục #8)

**Mục tiêu & nguồn:** MATH.pdf §Thống kê suy luận (hypothesis testing, t-test, chi-square, p-value) + DA.pdf §Hypothesis Testing. Thay quy tắc đếm ≥2/≥3 của Layer 9 bằng kiểm định ý nghĩa thống kê.

**Hiện trạng (đã kiểm chứng):** `strategy-adapter.ts` DEFAULT_RULES kích hoạt theo `count ≥ 2/≥3` (hints query `count: {gte: 2}` :463); `adaptation-engine.applyAdaptationToSession` (:119) merge config + render directives; `markSessionAdaptationOutcome` (:287) ghi `StrategyAdaptationLog.successful` (null=pending) từ workflow-engine:1689. **Dữ liệu before/after đã có sẵn trong StrategyAdaptationLog** — chỉ thiếu phép thử.

**Thuật toán:**
- Với mỗi cặp chiến lược (fromStrategy → toStrategy) có tiền sử: nhóm A = outcome các session dùng fromStrategy (sau lần adapt gần nhất), nhóm B = outcome dùng toStrategy. Bài toán nhị phân (successful) → **χ² 2×2** (Yates) khi mọi cell ≥5, ngược lại **Fisher exact**; nếu có biến liên tục (cycles/tokens từ ExecutionMetrics cùng session) → **Welch-t** bổ trợ. Gate: áp dụng chiến lược mới khi `p < 0.05` HOẶC `n < minSample` (quy tắc cũ giữ nguyên hành vi khi thiếu dữ liệu — không đổi khởi động lạnh).
- Kết quả lưu `StrategyAdaptationLog.statsJson` (mới, nullable): `{ test, p, nA, nB, decision }`.

**Thiết kế:**
```prisma
model StrategyAdaptationLog { /* thêm */ statsJson String? /* JSON {test,p,nA,nB,decision} */ }
```
```ts
// src/lib/learning/adaptation-stats.ts (MỚI)
export interface AdaptationStatsDecision { pass: boolean; test: 'chi2'|'fisher'|'welch_t'|'insufficient'; p: number | null; nA: number; nB: number; reason: string }
export function evaluateAdaptationEvidence(before: boolean[], after: boolean[]): AdaptationStatsDecision
// pass = p<0.05 (after TỐT HƠN — one-sided theo hướng cải thiện) ; n<10 mỗi nhóm → { pass: true, test: 'insufficient' } — giữ hành vi cũ
```
Điểm cắm: `applyAdaptationToSession` — trước khi merge config, khi pattern-type này ĐÃ từng được áp dụng (query StrategyAdaptationLog theo toStrategy, `successful != null`): gọi `evaluateAdaptationEvidence`; `pass=false` → không merge directives (chỉ log `adaptation-blocked-by-stats`) — đây là điểm **đổi hành vi duy nhất của phase**, env `ADAPTATION_STATS_GATE=on` mặc định OFF để quan sát log 2 đợt chạy trước khi bật chặn thật.

**Các bước:** 1) schema + push → 2) `adaptation-stats.ts` (thuần hàm + test trước) → 3) cắm vào applyAdaptationToSession (log-only) → 4) chạy 2 đợt quan sát → 5) bật chặn khi user duyệt → 6) test `r77-adaptation-stats-gate.test.ts`.

**Kiểm chứng:** test: trước=[T,T,F,F], sau=[T,T,T,T] (n=4) → insufficient (giữ cũ); n=30 mỗi nhóm, sau tốt hơn rõ → chi2 p<0.05 pass; sau tệ hơn rõ → p lớn → block. Log thật có dòng decision.

**Rủi ro & rollback:** chặn nhầm chiến lược tốt → mitigation: mặc định OFF + đường log-only dài đủ; rollback = flag OFF.

## P4-M2 · Ghi model lên AgentRunRecord + ANOVA so sánh model (mục #8b)

**Mục tiêu & nguồn:** MATH.pdf §ANOVA — so sánh ≥3 model; tiền đề bắt buộc cho P6 (biết run nào chạy bằng model nào).

**Hiện trạng (đã kiểm chứng):** `AgentRunRecord` KHÔNG có cột model (chỉ agentId/agentName); `insertAgentRunRecordRunning`/`updateLatestAgentRunRecord` (`metrics-db.ts:361/462`) chưa nhận model; goal-loop có sẵn `agentModel` param tại thời điểm ghi.

**Thiết kế:**
```prisma
model AgentRunRecord { /* thêm */ model String? /* id model zen thực chạy chính (sau normalize llm.ts:5331) */ }
```
Sửa `metrics-db.ts` 2 hàm ghi nhận `model?: string | null`; sửa `agent-goal-loop.ts` 2 call-site (:5581/:5602) truyền model. API mới `GET /api/eval/model-comparison`: nhóm AgentRunRecord theo `model` (completed vs failed/incomplete) → bảng per-model (n, success-rate + Wilson CI từ P2-M2) + `anovaF` trên cycles/tokens khi ≥3 model đủ n≥10 — dùng `stats/anova`.

**Kiểm chứng:** run mới có model khác null; route trả bảng; ANOVA từ chối tính khi thiếu nhóm.

**Rủi ro & rollback:** additive nullable — rủi ro gần 0.

---

# PHASE P5 — DATABASE NÂNG CAO (song song được sau P1)

## P5-M1 · Matryoshka 512-dim pilot + PCA/SVD 2D projection (mục #14)

**Mục tiêu & nguồn:** MATH.pdf §PCA/§SVD/§Eigenvalues + embeddings nemotron hỗ trợ Matryoshka (header `embeddings.ts:10` đã ghi nhưng guard ép 2048 ở :54-58 — chưa từng dùng).

**Hiện trạng (đã kiểm chứng):** `EMBEDDING_DIMENSION = 2048` const private; mọi collection 2048; dim guard trong `initializeCollections` (`qdrant.ts:139-213`) so mọi collection với 2048 — **truncation phải dùng collection RIÊNG để không phá guard toàn cục**.

**Thiết kế — pilot cô lập:**
1. `embeddings.ts`: thêm `export function truncateMatryoshka(v: number[], dims = 512): number[]` (MRL: giữ đúng N phần tử đầu) + const `MATRYOSHKA_PILOT_DIMS = 512` (env `MATRYOSHKA_PILOT=off` mặc định).
2. `qdrant.ts`: hàm `ensurePilotCollection(name, 512)` tạo collection 512-dim riêng (KHÔNG đụng guard 2048 — guard chỉ áp cho collection 2048 chính thức); pilot collection: `agent_memory_512`.
3. Dual-write trong `agent-memory.ts storeMemory`: khi pilot ON — upsert song song bản 512 vào pilot (đọc vẫn 2048). Đo: sau ≥2 tuần dữ liệu, chạy script so sánh `recall@k` (top-k trùng nhau giữa 2048 vs 512 trên cùng truy vấn mẫu 100 câu) + nDCG (P1-M2 chuẩn) → chỉ quyết định chuyển đọc khi recall drop <2%.
4. PCA/SVD 2D: `src/lib/stats/pca.ts` (thêm vào P0 scope nếu muốn — hoặc file riêng ở phase này): power-iteration top-2 thành phần chính trên ma trận hiệp phương sai; gắn vào `/api/query/graph-explore` (cap 500 node, cache 1h) trả `xy` cho UI vẽ bản đồ tri thức.

**Các bước:** 1) truncate + pilot collection → 2) dual-write flag → 3) script đo đối chứng → 4) quyết định chuyển đọc (user duyệt, có số) → 5) PCA route → 6) test `r78-matryoshka.test.ts` (512-vec tìm thấy cùng neighbor top-5 ≥98% trên mẫu embed thật).

**Kiểm chứng:** pilot collection tồn tại độc lập dim 512 KHÔNG làm health đỏ (guard bỏ qua collection có tiền tố `_pilot`/`_512` — quy ước tên); số đối chứng recall trước khi đổi bất kỳ đường đọc nào.

**Rủi ro & rollback:** mất chất lượng recall — toàn bộ đường đọc giữ 2048 tới khi có số đối chứng; rollback = pilot flag OFF.

## P5-M2 · Content-hash + near-dup dedup khi re-upload (mục #17)

**Mục tiêu & nguồn:** DA.pdf §Duplicate Rows — chống index trùng tài liệu.

**Hiện trạng (đã kiểm chứng):** `Document.title @unique` (schema :112) chặn trùng TÊN file, nhưng cùng nội dung đổi tên → index trùng toàn bộ chunk + entity. Upload gate chỉ check `.pdf` (`upload/route.ts:118-121`).

**Thiết kế:**
```prisma
model Document { /* thêm */ contentHash String?  duplicateOfId String? @default? /* nullable */ }
// @@index([contentHash]) — unique? KHÔNG unique cứng (PDF tái xuất khác byte nhưng cùng nội dung) — near-dup semantic lo phần còn lại
```
1. Upload route: `contentHash = sha256(bytes)` — nếu tồn tại Document cùng hash → trả 409 kèm `existingDocumentId` + tiêu đề (KHÔNG lưu bản mới).
2. Near-dup trong process step ④ (sau chunk, trước upsert Qdrant): embed 3 chunk đầu → `searchSimilar` top-1 score ≥ **0.98** → đánh dấu `Document.duplicateOfId = matchedDoc`, `status = 'duplicate'`, skip pipeline tiếp theo. Ngưỡng 0.98 khởi điểm (0.92 đang dùng cho memory merge khác phân phối — chunk PDF trùng nguyên văn gần 1.0; điều chỉnh bằng sweep sau).
3. Route list documents hiển thị badge "trùng với …" (UI phụ, tùy chọn).

**Kiểm chứng:** test `r78-doc-dedup.test.ts`: upload 2 lần cùng bytes → lần 2 nhận 409; upload cùng nội dung đổi tên → pipeline đánh dấu duplicate, KHÔNG sinh chunk mới (đếm chunk trước/sau bằng `getChunkCount`).

**Rủi ro & rollback:** hash collision vô hại (sha256); near-dup 0.98 quá chặt chỉ bỏ lỡ vài bản trùng — an toàn theo hướng không chặn nhầm.

## P5-M3 · Naive Bayes cho entity resolution (mục #16)

**Mục_tgt & nguồn:** MATH.pdf §Bayes + §Naive Bayes — thay fuzzy-match thuần bằng xác suất có học từ lịch sử resolve.

**Hiện trạng (đã kiểm chứng):** `resolveEntities` (`src/lib/ingestion/entity-resolver.ts`) = exact + fuzzy; nhãn dữ liệu để học đã có: `LocalEntity.resolvedEntityId` → `LocalResolvedEntity` (cặp đã ghép đúng là ground truth tích lũy sẵn).

**Thuật toán:** Đặc trưng cặp (entity mới, ứng viên canonical): `f1 = similarity tên (Levenshtein ratio 0-1)`, `f2 = cùng entityType? 1:0`, `f3 = Jaccard token description`, `f4 = cùng domain? 1:0`. Naive Bayes nhị phân (match/not-match) với Laplace smoothing λ=1 (MATH.pdf §Bayes): `LLR = log P(f1|match)+… − log P(f1|not)…`; match khi `LLR > τ`. Học from resolved history (≥100 cặp mới bật — dưới ngưỡng dùng fuzzy cũ); τ khởi điểm 0 ( cân bằng), hiệu chỉnh bằng sweep sau.

**Thiết kế:** sửa `entity-resolver.ts`: thêm `loadNaiveBayesModel()` (cache 10 phút, train trong RAM từ query LocalEntity resolved) + chèn vào resolve flow SAU exact-match, TRƯỚC fuzzy: NB có dữ liệu → dùng NB (fuzzy làm fallback khi LLR vùng xám |LLR|<0.5); chưa đủ dữ liệu → nguyên trạng thái cũ. KHÔNG schema mới.

**Kiểm chứng:** test `r78-entity-nb.test.ts`: seed 150 cặp resolved với phân bố đặc trưng tách biệt → NB phân loại đúng ≥ 95% cặp test; dưới 100 cặp → hành vi fuzzy cũ nguyên vẹn.

**Rủi ro & rollback:** sai ghép entity xấu hơn fuzzy → vùng xám giao về fuzzy + rollback tức thời (kill-switch env `ENTITY_NB=off`).

## P5-M4 · Data-quality expectations cho pipeline ingestion (mục #12)

**Mục tiêu & nguồn:** DA.pdf §Data Quality, Orchestration & Monitoring (Great Expectations-style) — mặc dù pipeline đã có guard P0-5 khá dày, chưa có lớp expectation khai báo được + ngưỡng.

**Hiện trạng (đã kiểm chứng):** process route (5883 dòng) có guard rời rạc: chunk count (:2238), zero-vector (:3936), extract giả (:3194). Thiếu: expectation khai báo tập trung + ngưỡng tỷ lệ (entity-rate), cảnh báo xu hướng.

**Thiết kế:**
```ts
// src/lib/ingestion/pipeline-expectations.ts (MỚI) — khai báo tập trung
export interface PipelineExpectation { id: string; step: string; metric: string; op: 'gt'|'lt'|'between'; bound: number | [number, number]; severity: 'warn'|'fail'; note: string }
export const PIPELINE_EXPECTATIONS: PipelineExpectation[] = [
  // chunks_per_page between [0.3, 8]  (warn)  — quá ít = parse hỏng, quá nhiều = chunking lỗi
  // entity_rate between [0.2, 6]/chunk (warn) — extraction hallucinating hoặc miss
  // zero_vector_rate lt 0.01 (fail)   — đã có guard riêng, nâng thành expectation thống kê
  // relationship_per_entity between [0.2, 4] (warn)
  // embedding_success_rate gt 0.999 (fail)
]
export function evaluateExpectations(measurements: Record<string, number>): Array<{ id: string; passed: boolean; severity: string; value: number }>
```
Điểm gọi: cuối pipeline (trước khi set `indexed`) — tính các số đo từ stats đã có sẵn trong route; `fail` → giữ `partial` (đúng cơ chế hiện có), `warn` → ghi vào `Document.processingSteps[].detail` + KPI `ingestion_expectation_fails`. KHÔNG chặn pipeline mới — chỉ phân loại cảnh báo.

**Kiểm chứng:** test `r78-pipeline-expectations.test.ts` (đo thuần hàm); chạy 1 document thật → expectation kết quả ghi trong processingSteps JSON.

**Rủi ro & rollback:** warn-only trừ zero-vector đã có cơ chế fail sẵn — không đường nóng mới.

---

# PHASE P6 — RL-LITE: HỌC TỪ PHẦN THƯỞNG (mục #15 — cuối cùng)

## P6-M1 · Credit assignment — reward ledger (giải nợ P1-c của BLUEPRINT-DB)

**Mục tiêu & nguồn:** DL.pdf §RL Framework (S_t, A_t, R_t+1) — phận thưởng phải gán được cho hành động, không dàn trải cả episode.

**Hiện trạng:** phần thưởng rời rạc ở 3 nơi (ArbiterVerdict outcome, StrategyAdaptationLog.successful, EpisodeRecord.outcome) — không có bảng "hành động nào tại trạng thái nào dẫn đến kết quả gì".

**Thiết kế:** Tận dụng `StrategyAdaptationLog` (đã có fromStrategy/toStrategy/successful) + `AgentRunRecord.model` (P4-M2) làm ledger — KHÔNG tạo bảng attribution riêng (tránh phình schema): quy ước state-key = `mode-${routingMode}-tier-${tier}` (đúng key sẵn của historical-feedback — tái dùng triệt để), action-key = model id hoặc strategy id. Mục tiêu nhập liệu: mỗi lần `markSessionAdaptationOutcome` + `resolveArbiterVerdicts` chốt → đủ bộ (stateKey, actionKey, reward) để P6-M2 updateQ.

## P6-M2 · Tabular Q-learning — model `QEntry` + `q-table.ts`

**Mục tiêu & nguồn:** DL.pdf §Q-Table + §Common RL Algorithms (Q-Learning) — không cần DQN/PPO, không gian trạng thái nhỏ (mode × tier × model).

**Thuật toán:** `Q(s,a) ← Q(s,a) + α[r + γ·max_a' Q(s',a') − Q(s,a)]`, α=0.1, γ=0.9; reward = +1 verdict confirmed ∧ runComplete / −1 refuted / 0 pending-bỏ. ε-greedy đã có sẵn tinh thần ở episodic preact — tái dùng.

**Thiết kế:**
```prisma
model QEntry { id String @id @default(cuid())  stateKey String  actionKey String
  qValue Float @default(0)  visits Int @default(0)  updatedAt DateTime @updatedAt
  @@unique([stateKey, actionKey]) }
```
```ts
// src/lib/learning/q-table.ts (MỚI)
export async function updateQ(stateKey: string, actionKey: string, reward: number, nextStateKey: string): Promise<void>
export async function getQAdvice(stateKey: string, candidateActions: string[]): Promise<Array<{ action: string; q: number; visits: number }>>
```
Update hook: cuối run goal-loop (chỗ `resolveArbiterVerdicts` :5621) fire-and-forget.

## P6-M3 · Softmax(τ) stochastic model-selection (mục #15 — chống 429-cascade)

**Mục tiêu & nguồn:** DL.pdf §Stochastic Policy — hôm nay chuỗi model là strictly-one-primary (`callLLMForAgent` :5305-5340, model từ AgentProfile.model) → khi model chính 429, toàn hệ thống dồn theo chuỗi failover đồng loạt.

**Thuật toán:** `score(a) = Q(s,a)` (P6-M2; chưa có → uniform prior theo caps) × health (model bị `markZenFreeTierBlocked`/cooldown → weight 0); `π(a) = softmax(score/τ)`, τ env `RUNTIME_MODEL_TAU=0.5`. Chọn primary khi agent KHÔNG có override tường minh. Deterministic seed = hash(sessionId, cycle) — chạy lại được.

**Thiết kế:** sửa `llm.ts` ngay sau `isZenConfigured` (:5322) khi `RUNTIME_MODEL_POLICY=softmax` (mặc định `off` giữ nguyên một-primary): candidate = các model `PROVIDER_MODELS.zen` có caps phù hợp vai agent (dùng caps {coding, reasoning, agentic} sẵn trong agent-constants) ∧ KHÔNG nằm trong `zenModelBlockSummary()` blocked ∧ key không cooldown. Log mỗi lần chọn: `softmax-pick model=X q=0.42 p=0.31 reason=…`. Failover chuỗi cũ giữ nguyên toàn bộ (softmax chỉ đổi điểm khởi đầu).

**Kiểm chứng:** test `r79-softmax-policy.test.ts` (pure: distribution π hợp lệ, blocked model weight 0, seed deterministic); chạy thật 1 đợt với flag on: phân bố gọi dàn ra ≥2 model, 429 không còn dồn 1 model.

**Rủi ro & rollback:** chọn model yếu hơn cho run đơn lẻ — mitigate bằng Q-weight + caps filter + τ thấp; rollback = flag off trở lại một-primary tức thì.

## P6-M4 · Q-value advisory lộ ra UI

**Thiết kế:** `/api/agents/models` thêm `advice: { stateKey: string; top: Array<{ model: string; q: number; visits: number }> }` (từ getQAdvice) — dropdown model hiện badge "Q học được đề xuất" (tương tự badge blockedTransports r74 — tái dùng đúng chỗ `route.ts:18-24`). Goal-loop PLAN phase: khi Q có visits ≥ 10 cho stateKey sắp tới → thêm 1 dòng hint vào system prompt block (advisory, không ép).

---

# PHẦN KẾT — TRÌNH TỰ THỰC THI & NGHIỆM THU

## Bảng đợt triển khai

| Đợt | Nội dung | Ngưỡng nghiệm thu đợt |
|---|---|---|
| **1** | P0-1 (stats core) | Gate PASS + test r76; import smoke từ 2 module |
| **2** | P1-M1 → M2 → M3 → M4 (làm tuần tự, M4 hội kết quả M1-M3) | 1 scorecard thật + 1 eval run có nDCG/MRR + 1 lần scan anomaly + GET /api/metrics/kpi đủ 8 KPI |
| **3** | P1-M5 (Leiden quality) | 1 lần detect thật log silhouette + modularity; test γ-sweep |
| **4** | P2-M1 + P2-M2 | Bảng sweep nộp user duyệt ngưỡng; Wilson CI trong historical-feedback |
| **5** | P3-M1 + M2 (cùng file) → P3-M4 → P3-M3 | V2 active chỉ khi CV thắng; digest gate log thật; 3-judge chạy mode critical 1 run |
| **6** | P4-M2 → P4-M1 (M2 trước vì M1 cần quan sát) | AgentRunRecord.model khác null; adaptation-stats log-only 2 đợt chạy |
| **7** | P5-M2 → M4 → M3 → M1 (M1 cuối vì cần dữ liệu pilot) | Dedup chặn đúng test-case; expectation ghi processingSteps; NB ≥95% test; Matryoshka có bảng recall đối chứng |
| **8** | P6-M1 → M2 → M3 → M4 | QEntry cập nhật sau 5 run thật; softmax phân bố ≥2 model khi bật; advisory hiện trên dropdown |

**Định nghĩa Hoàn thành từng hạng mục:** ① code land + gate PASS (595+ test cũ không hỏng) ② hằng số/cờ mới có comment nguồn ③ quan sát thật 1 lần ghi vào worklog ④ mọi bug quan sát được append Bug_v2.md ⑤ commit đẩy `feat(P{n}-{m}): …`.

## Điểm dừng quyết định của user (không tự ý vượt)

1. **P2-M1:** bảng ngưỡng sweep → user duyệt từng hằng số (tiền lệ option-b).
2. **P3-M1:** bật `active=true` cho CalibrationModelV2 chỉ khi CV thắng rõ (cvBrier < brierV1).
3. **P4-M1:** chuyển adaptation-gate từ log-only sang chặn thật.
4. **P5-M1:** chuyển đường đọc agent_memory sang 512-dim chỉ khi recall drop <2%.
5. **P6-M3:** bật `RUNTIME_MODEL_POLICY=softmax` trên đường chạy nóng.

## Ghi chú phạm vi loại trừ (đã cân nhắc ở báo cáo nghiên cứu)

Backprop/CNN/RNN/LSTM/Keras, Perplexity/BLEU/METEOR, Normal Equation (logistic vô nghiệm đóng), SciPy signal/spatial — KHÔNG triển khai (TMO không huấn luyện NN; các độ đo đó không thuộc tác vụ hệ thống). `alista/collectors.ts` zScore inline không tái cấu trúc (ngoài phạm vi — chỉ ghi nhận trùng lặp tiềm năng với `stats/descriptive`).

---

*Agent thực thi: trước mỗi hạng mục, grep lại call-site theo `file:line` nêu trong blueprint — số dòng có thể trôi sau các đợt commit; định danh hằng số là mỏ neo (tên hàm + tên hằng số là thật, số dòng là tham chiếu tại HEAD 2b3f6b4).*

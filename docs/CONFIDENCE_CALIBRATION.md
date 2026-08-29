# CONFIDENCE CALIBRATION — Self-Evaluation của TMO (Task 20-c)

> Hệ thống tự đánh giá mức chắc chắn của chính nó: mọi con số confidence hiển thị
> cho user phải là **dự đoán có thể đo lường được sai số** (Brier/ECE), không còn
> con số 0.6 hardcode giả trên mọi câu trả lời.

## 1. CONFIDENCE PROTOCOL — nguồn claim + mức chắc chắn (prompt-level)

Mọi agents chạy goal-loop (chat ReAct) nhận thêm 1 section trong system prompt
(`buildConfidenceProtocol()` trong `src/lib/agent-goal-loop.ts`):

**Gắn nhãn nguồn cho mỗi nhận định quan trọng:**

| Tag | Ý nghĩa |
|---|---|
| `[verified-by-tool]` | Đã kiểm chứng bằng tool thật (file_read đọc lại, shell, run_tests, lint...) |
| `[KB]` | Trích từ knowledge base / tài liệu người dùng cung cấp |
| `[model-prior]` | Suy đoán từ kiến thức có sẵn của model — CHƯA kiểm chứng |

**Cuối phản hồi LUÔN có 1 dòng** `Confidence: <0-100>%` phản ánh THẬT:

| Mức | Điều kiện |
|---|---|
| ≥85% | Có bằng chứng tool trực tiếp |
| 60-85% | Bằng chứng gián tiếp / KB |
| 35-60% | Suy luận |
| <35% | Đoán mò — nên đề xuất cách verify thêm |

EVALUATOR (trọng tài độc lập) cũng được thêm nguyên tắc #7: `confidence` là xác
suất dự đoán được CALIBRATE trung thực — đa số trường hợp "tự tin nhưng sai" nằm
ở 0.6-0.8 chứ không phải 0.95; chỉ ≥0.9 khi bằng chứng tool trực tiếp khớp
hoàn toàn mục tiêu.

## 2. Kiến trúc: verdict → outcome → Brier/ECE

```
CHAT (goal-loop)                       ĐO LƯỜNG SAU CÙNG
─────────────────                      ──────────────────
run START ──► AgentRunRecord (status='running')          ──► Runtime Metrics: runs.active ≠ 0
  │
  chu kỳ 1..N:
    EXECUTE (tools thật)
    EVALUATE ──► ArbiterVerdict row mỗi chu kỳ           ──► P(complete) = confidence
    │             (verdict EFFECTIVE sau verify-guard:      (dự đoán của trọng tài)
    │              forcedDowngrade khi harness hạ cấp)
    │
  run END ──► AgentRunRecord UPDATE đầy đủ metadata      ──► cycles/tokensUsed/evaluatorConfidence/
  │           (status/stopReason thật)                       toolCalls/toolFailures/durationMs/messageId
  └─────────► resolveArbiterVerdicts(sessionId):
                verdict.complete === run.complete ? 'confirmed' : 'refuted'
                + runStopReason/runComplete ghi kèm
                                       │
                                       ▼
              GET /api/eval/calibration:
                arbiter   = Brier/ECE của trọng tài (score=confidence, outcome=complete)
                retrieval = Brier/ECE của KB confidence (score=rawConfidence,
                            outcome=faithfulnessMedian>0.7 — từ EvalResult)
                model     = CalibrationModel (logistic regression đang áp runtime)
```

**Điểm đo then chốt:** mỗi verdict của trọng tài là 1 dự đoán xác suất. Khi run
kết thúc thật sự, outcome (confirmed/refuted) cho biết dự đoán đúng/sai → dồn
đủ dữ liệu là tính được Brier score (mean((p−y)²)) + ECE (reliability diagram)
của chính trọng tài — đo được "agent tự tin 90% nhưng chỉ đúng 60%" thay vì đoán mò.

**Confidence THẬT trên UI:** chat route trả về `confidence =
goalLoop.evaluatorConfidence ?? kbConfidence` (trước đây hardcode 0.6). Không có
nguồn nào → field bị bỏ → badge % tự ẩn (page.tsx check `msg.confidence != null`).

## 3. Components (file tham chiếu)

| File | Vai trò |
|---|---|
| `prisma/schema.prisma` — `ArbiterVerdict` | Bảng verdict: sessionId/cycle/complete/confidence/verified/missing/rootCause/forcedDowngrade/outcome(outcomeAt)/runStopReason/runComplete |
| `src/lib/metrics-db.ts` | Raw-SQL bridge (prefer delegate, fallback raw vì Prisma client dev-server stale sau `db push`): `insertArbiterVerdict`, `resolveArbiterVerdicts`, `findArbiterVerdictsForCalibration`, `insertAgentRunRecordRunning`, `updateLatestAgentRunRecord` |
| `src/lib/agent-goal-loop.ts` | Insert AgentRunRecord lúc start (status running) + ArbiterVerdict mỗi chu kỳ (verdict EFFECTIVE sau verify-guard) + update metadata thật + resolve outcome lúc end. CONFIDENCE PROTOCOL vào executor prompt; nguyên tắc calibrated-confidence vào EVALUATOR prompt |
| `src/lib/agent-run-tracker.ts` | Dedup: goal-loop gọi `startAgentRun({dbPersistBy:'caller'})` → tracker bỏ qua persist (goal-loop là nguồn sự thật của chat run; run Code Team giữ behavior 20-b) — **1 run = đúng 1 row AgentRunRecord** |
| `src/app/api/openclaw/chat/route.ts` | Confidence thật (evaluator ?? KB) trong response + metadata message; link messageId vào AgentRunRecord sau khi message persist |
| `src/lib/kb-routing/kb-access.ts` | `searchUserKB` trả thêm `rawConfidence` (giá trị TRƯỚC calibration) — `confidence` (calibrated) giữ nguyên cho consumer hiện có |
| `src/lib/eval/runner.ts` | Lưu `rawConfidence: kb.rawConfidence ?? kb.confidence` (hết feedback-loop fit trên output của chính mình) + auto-retrain sau eval run |
| `src/lib/calibration-metrics.ts` | Toán thuần: `brierScore(scores, outcomes)`, `ece(scores, outcomes, bins=10)` (empty input → 0/null an toàn) |
| `src/lib/calibration-train.ts` | `trainCalibrationModel()` — logistic regression (lr 0.01 × 1000 epoch) trên EvalResult → upsert CalibrationModel(id='default'). Dùng chung bởi CLI + API + auto-retrain |
| `scripts/train-calibration.ts` | CLI wrapper gọi lib (giữ behavior cũ: warn <50 usable, abort <10 usable) |
| `src/app/api/eval/calibration/route.ts` | GET: `{model, retrieval:{n,brier,ece,bins}, arbiter:{n,brier,ece,bins,avgConfidence,baseRate}, generatedAt}` — mỗi section fail-open. POST: retrain; usable <10 → `400 {error, usable, need:10}` |

## 4. Endpoints

```
GET  /api/eval/calibration
     → 200 {model|null, retrieval, arbiter, generatedAt}   (zero-state khi chưa có dữ liệu)
POST /api/eval/calibration
     → 200 {trained:true, usable, total, model, retrieval, arbiter}
     → 400 {error:'insufficient data: only N usable...', usable:N, need:10}
```

Đọc số liệu: **Brier** 0 = hoàn hảo, 0.25 = random guess, >0.25 = tệ hơn đoán mò.
**ECE** 0 = calibrated hoàn hảo; `avgConfidence` vs `baseRate` của arbiter cho
biết over/under-confident ngay bằng mắt (vd 0.85 vs 0.60 = overconfident 25 điểm).

## 5. Luồng vận hành (máy Windows)

```powershell
# 1. Seed eval cases (idempotent — 30 LLM-gen + ≤20 human + 10 negative)
bun scripts/seed-eval.ts

# 2. Chạy eval (background; mỗi case: 1 retrieval + 1 answer + 3 judge calls)
#    Tự AUTO-RETRAIN calibration khi đủ ≥10 usable EvalResult sau run
curl -X POST http://localhost:3000/api/eval/run -H "Content-Type: application/json" -d '{"caseLimit":10}'

# 3. Retrain thủ công + xem metrics calibration
curl -X POST http://localhost:3000/api/eval/calibration
curl http://localhost:3000/api/eval/calibration
```

**Lưu ý hiện trạng (0 rows):** DB chưa có EvalResult → chưa train được model
calibration. Runtime `getCalibratedConfidence` fail-open trả về raw confidence
khi chưa có CalibrationModel hoặc sampleSize < 20 — hệ thống chạy đúng, chỉ
chưa được "hiệu chỉnh". Chạy đủ eval (tối thiểu 10, nên 50+) để model áp dụng thật.

## 6. Gap còn lại (roadmap — chưa làm trong task này)

1. **Claim-level calibration**: hiện calibration áp cho retrieval confidence
   (kb-access) + đo Brier/ECE cho trọng tài ở mức RUN; tag
   `[verified-by-tool]/[KB]/[model-prior]` đã có trong prompt nhưng CHƯA được
   parse/quản lý per-claim → cần bảng Claim riêng + join feedback user.
2. **Arbiter cross-model**: EVALUATE dùng CÙNG model với agent bị đánh giá
   (độc lập theo role, không theo model) — khác eval judges chéo model-family.
   Đề xuất: cấu hình model riêng cho evaluator + đo chênh lệch verdict.
3. **Render reasoningChain/crossValidation**: /api/query trả về structured
   claims + crossValidation nhưng page.tsx KHÔNG render (đang bị drop) —
   khi render sẽ bổ sung lớp "bằng chứng" cho badge confidence.
4. **ArbiterVerdict.messageId**: hiện null (verdict sinh TRƯỚC khi message
   persist); có thể backfill qua updateLatestAgentRunRecord pattern nếu cần
   join verdict ↔ message nội dung.
5. **Stale 'running' rows**: process crash giữa run → AgentRunRecord kẹt
   status='running' mãi (runs.active ảo). Cần sweep startup/restart dọn row
   running > N giờ.
6. **CalibrationModel đa tham số**: hiện 1-feature logistic regression trên
   rawConfidence; mở rộng per-source/per-agent bins khi dữ liệu đủ.

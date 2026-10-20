/**
 * r131 — OBS-1 SOFTMAX HARDENING (2026-10-20 — giao thức quan sát, phiên quan
 * sát run Opus opus_rev_mvgfjoxn_xgez25 08:37-08:42)
 * =====================================================================================
 * HIỆN TƯỢNG QUAN SÁT ĐƯỢC (bằng chứng live, giao thức §0b mục 4 "chẩn đoán
 * từng tín hiệu về gốc rễ"):
 *   Opus review (manual) chạy 300.0s → verdict [FALLBACK] issues=0 — softmax
 *   pilot pick z-ai/glm-5.3-flash (q=0.00 p=0.25 uniform, seed tất định
 *   409499169) → model hang NIM 0 bytes → TIMEOUT-STRIKE 1/2 → key#1 timeout
 *   150s → key#2 timeout 150s → fail-fast R19 → reviewer guard infra (đúng —
 *   OPUS-VERDICT-1) → verdict ESCALATE fallback. Probe sau đó: glm-5.3-flash
 *   sống lại (small 2.5s OK, large 30KB 6.6s OK) → sự cố NIM thoáng qua.
 *
 * GỐC RỄ (3 lỗi cấu trúc của pilot, đều sửa trong commit này):
 *   1. Softmax KHÔNG nhìn circuit-breaker — glm bị breaker block 10 phút
 *      nhưng call kế VẪN pick glm → fail-fast lặp vô nghĩa (nếu NIM chưa hồi
 *      thì cháy tiếp 2×150s mỗi 10 phút).
 *   2. Q KHÔNG BAO GIỜ học từ kết quả call — updateQ chỉ có caller salvage
 *      crash (alerts.ts) + task-level (goal-loop). LLM infra fail thông thường
 *      không ghi Q → Q≡0 mãi → uniform → seed tất định hash(sessionId, cycle=0)
 *      pick CÙNG model mỗi session → model hỏng = kẹt vĩnh viễn session đó.
 *   3. AgentRunRecord của review fallback ghi 'completed'+'complete' — che
 *      thất bại khỏi rubric D1.3 (root-cause analysis mù).
 * Phát hiện phụ từ probe 4 model (prompt tầm thường): deepseek-v4.1-flash
 * 252.1s + glm-5.3 99.3s — pool ứng viên có model chậm cực đoan → reward
 * thành công phải phẳng theo latency (nhanh≈1, 4 phút≈0.19) để Q phân biệt.
 *
 * Fix (OBS-1): (A) filter isModelHardBlocked trong maybeApplySoftmaxNimPolicy;
 * (B) recordSoftmaxNimQOutcome — updateQ(stateKey, model, reward, stateKey)
 * fire-and-forget khi nimPolicy.applied, reward = softmaxNimOutcomeReward
 * (fail -1 / OK 1/(1+phút)); (C) reviewer endAgentRun stopReason 'fallback'.
 * Phong cách: source-scan (tiền lệ r124-r130) + unit reward thuần.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { softmaxNimOutcomeReward } from '@/lib/llm'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')
const llm = read('src/lib/llm.ts')
const reviewer = read('src/lib/opus/reviewer.ts')

describe('r131 A — softmax loại ứng viên bị circuit-breaker block', () => {
  test('A1. Filter isModelHardBlocked trong vòng chọn ứng viên', () => {
    const fnStart = llm.indexOf('async function maybeApplySoftmaxNimPolicy')
    expect(fnStart).toBeGreaterThan(0)
    const fnBody = llm.slice(fnStart, fnStart + 2500)
    expect(fnBody).toContain('const candidates = NVIDIA_AGENT_MODELS.filter(m => !isModelHardBlocked(m).blocked)')
    expect(fnBody).toContain('const blocked = NVIDIA_AGENT_MODELS.filter(m => isModelHardBlocked(m).blocked)')
    // Log bằng chứng khi loại ứng viên (dòng quan sát được trong dev.log)
    expect(fnBody).toContain('ứng viên bị circuit-breaker block')
  })

  test('A2. Đường 0/1 ứng viên không block: 0 → trả model cấu hình; 1 → pick thẳng (softmax 1 ứng viên = p 1.0)', () => {
    const fnStart = llm.indexOf('async function maybeApplySoftmaxNimPolicy')
    const fnBody = llm.slice(fnStart, fnStart + 2500)
    expect(fnBody).toContain('if (candidates.length === 0) return { model: configuredNimModel, applied: false }')
    expect(fnBody).toContain("reason=duy-nhất-ứng-viên-không-bị-block")
    expect(fnBody).toContain('return { model: candidates[0], applied: true }')
  })
})

describe('r131 B — Q học từ kết quả call (đóng vòng learning)', () => {
  test('B1. Call site ghi Q outcome khi policy áp dụng (nimPolicy.applied)', () => {
    expect(llm).toContain('const nimPolicy = await maybeApplySoftmaxNimPolicy(model, options)')
    expect(llm).toContain('if (nimPolicy.applied) void recordSoftmaxNimQOutcome(nimModel, nimResult, Date.now() - nimT0)')
  })

  test('B2. recordSoftmaxNimQOutcome: updateQ đối xứng state key với lúc pick + fail-open', () => {
    const fnStart = llm.indexOf('async function recordSoftmaxNimQOutcome')
    expect(fnStart).toBeGreaterThan(0)
    const fnBody = llm.slice(fnStart, fnStart + 1200)
    // Cùng state key agentRuntimeStateKey() như maybeApplySoftmaxNimPolicy
    expect(fnBody).toContain('const { updateQ, agentRuntimeStateKey } = await import(\'@/lib/learning/q-table\')')
    expect(fnBody).toContain('await updateQ(stateKey, model, reward, stateKey)')
    // Fail-open tuyệt đối — learning side-channel không làm hỏng call chính
    expect(fnBody).toContain('softmax-nim q-learn lỗi (fail-open)')
  })

  test('B3. softmaxNimOutcomeReward export + công thức 1/(1+phút)', () => {
    expect(llm).toContain('export function softmaxNimOutcomeReward(ok: boolean, latencyMs: number): number')
    expect(llm).toContain('return 1 / (1 + latencyMin)')
  })

  test('B4. OBS-1b: dấu vân tay Q vào seed — thoát vùng kẹt tất định (seed cũ không đổi khi Q đổi → pick glm lặp ~9 lần)', () => {
    // Seed phải gồm 3 input: session/agent + cycle + fingerprint Q
    expect(llm).toContain('`q=${scores.map(s => s.toFixed(3)).join(\',\')}`')
  })
})

describe('r131 C — unit softmaxNimOutcomeReward (thang [-1,1) — số đo probe thật)', () => {
  test('C1. Fail hạ tầng = -1 bất kể latency', () => {
    expect(softmaxNimOutcomeReward(false, 0)).toBe(-1)
    expect(softmaxNimOutcomeReward(false, 300_000)).toBe(-1)
  })

  test('C2. Thành công: nhanh ≈1, chậm giảm dần (nemotron 1.4s ≈0.98 · review khoẻ 25s ≈0.71 · glm-5.3 99s ≈0.38 · deepseek 252s ≈0.19)', () => {
    expect(softmaxNimOutcomeReward(true, 0)).toBeCloseTo(1, 10)
    expect(softmaxNimOutcomeReward(true, 1_400)).toBeCloseTo(0.977, 2)
    expect(softmaxNimOutcomeReward(true, 25_000)).toBeCloseTo(0.706, 2)
    expect(softmaxNimOutcomeReward(true, 99_300)).toBeCloseTo(0.377, 2)
    expect(softmaxNimOutcomeReward(true, 252_100)).toBeCloseTo(0.192, 2)
  })

  test('C3. Đơn điệu giảm theo latency + chặn dưới >0 (thành công chậm vẫn hơn fail)', () => {
    expect(softmaxNimOutcomeReward(true, 10_000)).toBeGreaterThan(softmaxNimOutcomeReward(true, 60_000))
    expect(softmaxNimOutcomeReward(true, 600_000)).toBeGreaterThan(0)
    // Thành công chậm nhất (10 phút ≈ 0.09) VẪN hơn fail hạ tầng (-1)
    expect(softmaxNimOutcomeReward(true, 600_000)).toBeGreaterThan(softmaxNimOutcomeReward(false, 0))
  })
})

describe('r131 D — AgentRunRecord review fallback hết che thất bại', () => {
  test('D1. endAgentRun nhận stopReason fallback khi verdict là fallback', () => {
    expect(reviewer).toContain("endAgentRun(sessionId, trackerRunId, failed ? 'error' : 'done', undefined, undefined, usedFallback ? 'fallback' : undefined)")
  })
})

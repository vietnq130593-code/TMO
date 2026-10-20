/**
 * r130 — SOFTMAX-PILOT (2026-10-20 — user duyệt "tôi duyệt hết các phần bạn vừa đề xuất")
 * =====================================================================================
 * Đề xuất đã duyệt: "bật RUNTIME_MODEL_POLICY=softmax thí điểm — để hệ tự học
 * model nào thắng cho loại việc nào".
 * Hiện trạng trước fix: maybeApplySoftmaxModelPolicy CH�ẢY trên đường ZEN — mà
 * toàn bộ agents đã chuyển NVIDIA NIM từ R17 + Zen chết (410/403, OPUS-VERDICT-1)
 * → bật policy theo thiết kế cũ = KHÔNG có tác dụng gì. Pilot này mở softmax
 * cho đường NIM (4 model sống NVIDIA_AGENT_MODELS).
 *
 * Fix (commit này):
 *   A. llm.ts maybeApplySoftmaxNimPolicy — mirror zen policy: ứng viên
 *      NVIDIA_AGENT_MODELS, Q(s,a) getQAdvice, τ runtime_model_tau, seed tất định
 *      hash(sessionId|agentName, qPolicyCycle). Pilot scope π_Q thuần (không
 *      Brain-C mixture — wire sau khi có dữ liệu Q ≠ 0).
 *   B. Tôn trọng lựa chọn tường minh (indicator KHÔNG BAO GIỜ nói X chạy Y):
 *      options.explicitModelChoice || hasExplicitModelOverride(DB) ||
 *      currentResearchModelOverride() (ALS) → giữ nguyên model — áp cho CẢ
 *      zen path lẫn NIM path.
 *   C. Caller đánh dấu explicit: goal-loop 3 site (final-report/CTO/main turn —
 *      model job = user thấy ở indicator) + chat fast-path + code-team engine
 *      2 site (explicitModelChoice = !!ctx.modelOverride — chỉ team override
 *      mới tường minh; workflow chạy profile mặc định vẫn eligible).
 *   D. Bật policy: .env RUNTIME_MODEL_POLICY=softmax (TuningParam store trống —
 *      env thắng; tắt thí điểm = bỏ dòng env + restart).
 * Evaluator (2151) KHÔNG đánh dấu — chủ ý: evaluator chạy model profile + ladder
 * → nguồn dữ liệu Q chính cho learning.
 * Phong cách: source-scan (tiền lệ r124-r129).
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')
const llm = read('src/lib/llm.ts')
const goalLoop = read('src/lib/agent-goal-loop.ts')
const chatRoute = read('src/app/api/openclaw/chat/route.ts')
const engine = read('src/lib/code-team/workflow-engine.ts')

describe('r130 A — softmax NIM trong llm.ts', () => {
  test('A1. maybeApplySoftmaxNimPolicy tồn tại + gọi trong NIM branch', () => {
    expect(llm).toMatch(/async function maybeApplySoftmaxNimPolicy\(configuredNimModel: string, options\?: LLMCallOptions\)/)
    expect(llm).toContain('const nimModel = await maybeApplySoftmaxNimPolicy(model, options)')
    // callModelWithKeyRotation + taskLabel + log/ERROR đều dùng nimModel (model thật)
    expect(llm).toContain("{ taskLabel: `agent-nim:${nimModel}` }")
    expect(llm).toContain('Agent dùng NIM ${nimModel} ✓')
  })

  test('A2. 3 lớp guard tường minh đều có (options / DB override / research ALS)', () => {
    expect(llm).toContain('if (options?.explicitModelChoice === true) {')
    expect(llm).toContain('reason=caller-đánh-dấu-lựa-chọn-tường-minh — giữ nguyên')
    expect(llm).toContain('if (currentResearchModelOverride()?.model) {')
    expect(llm).toContain('reason=research-chat-override — giữ nguyên')
    expect(llm).toContain('reason=agent-có-override-tường-minh — giữ nguyên')
  })

  test('A3. Cơ chế Q-learning đầy đủ: getQAdvice + softmaxPolicy + seed tất định', () => {
    expect(llm).toContain("import('@/lib/learning/q-table')")
    expect(llm).toContain('const advice = await getQAdvice(stateKey, candidates)')
    expect(llm).toContain('softmaxPolicy(scores, getTuningNumber(\'runtime_model_tau\'))')
    expect(llm).toContain('pickIndexBySeed(probs, seed)')
    expect(llm).toContain('NVIDIA_AGENT_MODELS.slice()')
  })

  test('A4. LLMCallOptions có explicitModelChoice + zen path cũng tôn trọng', () => {
    expect(llm).toContain('explicitModelChoice?: boolean')
    // Zen path: guard nằm SAU check policy (trước hasExplicitModelOverride)
    const zenFn = llm.indexOf('async function maybeApplySoftmaxModelPolicy')
    const zenExplicit = llm.indexOf('options?.explicitModelChoice === true', zenFn)
    const zenDb = llm.indexOf('hasExplicitModelOverride(options?.agentName)', zenFn)
    expect(zenExplicit).toBeGreaterThan(zenFn)
    expect(zenDb).toBeGreaterThan(zenExplicit)
  })
})

describe('r130 B — caller đánh dấu explicit (chống indicator nói dối)', () => {
  test('B1. goal-loop: 3 site model job đều explicit (final-report + CTO + main turn)', () => {
    const n = (goalLoop.match(/explicitModelChoice: true/g) || []).length
    expect(n).toBe(3)
    // Evaluator KHÔNG đánh dấu — nguồn dữ liệu Q cho learning
    const evalIdx = goalLoop.indexOf('EVALUATOR_SYSTEM_PROMPT, {')
    const evalSlice = goalLoop.slice(evalIdx, evalIdx + 400)
    expect(evalSlice).not.toContain('explicitModelChoice')
  })

  test('B2. Chat fast-path đánh dấu explicit', () => {
    expect(chatRoute).toContain('explicitModelChoice: true')
  })

  test('B3. Code-team engine: explicit = !!ctx.modelOverride (2 site)', () => {
    expect(engine).toContain('explicitModelChoice: !!(ctx as WorkflowContext).modelOverride')
    const n = (engine.match(/explicitModelChoice: !!\(ctx as WorkflowContext\)\.modelOverride/g) || []).length
    expect(n).toBe(2)
  })

  test('B4. .env bật pilot', () => {
    const env = readFileSync(join(TMO, '.env'), 'utf-8')
    expect(env).toMatch(/^RUNTIME_MODEL_POLICY=softmax$/m)
  })
})

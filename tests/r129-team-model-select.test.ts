/**
 * r129 — TEAM-MODEL-1: chọn được model ở team mode như agent độc lập
 * =====================================================================================
 * Bối cảnh (user report 2026-10-20): "khi đổi sang chọn team thì không thể chọn
 * model như khi chọn agent độc lập mà chỉ có model thiết lập sẵn".
 * Gốc rễ: smolab-module.tsx canPick = chatMode === 'single' && ... — model picker
 * tắt cứng ở multi (team); multi chat body cứng tl.model; workflow không nhận
 * model nào (engine tự dùng AgentProfile từng agent).
 * Fix (commit này):
 *   A. UI: canPick mở cho cả 2 mode; bấm chọn team → setSelectedModel(tl.model);
 *      multi chat body dùng effModel (ghi đè TL profile); indicator hiển thị
 *      selectedModel; tooltip ghi đè dùng shown.model (không crash agent=null).
 *   B. Code Team workflow: client gửi modelOverride/providerOverride (chỉ khi
 *      khác model TL) → route validate [A-Za-z0-9._/-]{1,120} → WorkflowConfig
 *      → ctx.modelOverride → applyModelOverride tại 3 điểm resolve (TL analyze,
 *      cache-loop runPipeline, TL verify).
 *   C. Research Team: route validate + wrap construct stream trong ALS
 *      (withResearchModelOverride) → resolveResearchBrain thấy override TRƯỚC
 *      AgentProfile DB — không sửa 15 call site.
 * Phong cách: source-scan (tiền lệ r124-r128) + unit thuần cho ALS module
 * (model-override-context KHÔNG import db — test trực tiếp được).
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')
const smolab = read('src/components/smolab/smolab-module.tsx')
const wfEngine = read('src/lib/code-team/workflow-engine.ts')
const wfRoute = read('src/app/api/code-team/workflow/route.ts')
const rsAgents = read('src/lib/research-team/agents.ts')
const rsRoute = read('src/app/api/research-team/workflow/route.ts')

describe('r129 A — UI smolab-module (team mode model picker)', () => {
  test('A1. canPick KHÔNG còn gate chatMode single — mở cho team', () => {
    expect(smolab).toContain("const canPick = shown.provider === 'zen' || shown.provider === 'nvidia'")
    // Chuỗi gate cũ phải TUYỆT ĐỐI hết (comment được phép nhắc nhưng không phải code)
    const oldGate = smolab.match(/const canPick = chatMode === 'single'/)
    expect(oldGate).toBeNull()
  })

  test('A2. Bấm chọn team → set model khởi đầu = model TL (cả 2 team)', () => {
    const codeBtn = smolab.match(/setSelectedTeam\('code'\)[\s\S]{0,600}?setSelectedModel\(tl\.model\)/)
    expect(codeBtn).not.toBeNull()
    const rsBtn = smolab.match(/setSelectedTeam\('research'\)[\s\S]{0,600}?setSelectedModel\(tl\.model\)/)
    expect(rsBtn).not.toBeNull()
  })

  test('A3. Multi chat body dùng effModel (ghi đè TL profile) + provider suy từ model', () => {
    expect(smolab).toContain('const effModel = selectedModel || tl.model')
    expect(smolab).toContain('chatBody.agentModel = effModel')
    expect(smolab).toContain("chosenOpt?.provider ?? (effModel.includes('/') ? 'nvidia' : tl.provider)")
    // Chuỗi cứng cũ phải hết
    expect(smolab).not.toContain('chatBody.agentModel = tl.model')
  })

  test('A4. Indicator hiển thị selectedModel cho cả 2 mode + tooltip không crash team', () => {
    expect(smolab).toContain('{selectedModel || shown.model}')
    expect(smolab).not.toContain("{chatMode === 'single' ? (selectedModel || shown.model) : shown.model}")
    expect(smolab).toContain('title={`Model mặc định: ${shown.model}`}')
    expect(smolab).not.toContain('agent!.model')
  })

  test('A5. startWorkflow + startResearchWorkflow gửi modelOverride khi khác model TL', () => {
    expect(smolab).toMatch(/workflowBody\.modelOverride = selectedModel/)
    expect(smolab).toMatch(/rb\.modelOverride = selectedModel/)
    // Chỉ gửi khi KHÁC model TL (không ghi đè vô nghĩa khi trùng)
    expect(smolab).toContain('selectedModel !== tl.model')
    expect(smolab).toContain('selectedModel !== rtl.model')
  })

  test('A6. createNewSession multi: model phiên = dropdown chọn', () => {
    expect(smolab).toContain('body.model = effModel')
    expect(smolab).not.toContain('body.model = tl.model')
  })
})

describe('r129 B — Code Team workflow backend', () => {
  test('B1. Route: parse + validate modelOverride (format chặt, graceful)', () => {
    expect(wfRoute).toContain('modelOverride?: string; providerOverride?: string')
    expect(wfRoute).toMatch(/\^\[A-Za-z0-9\._\\\/-\]\{1,120\}\$/)
    expect(wfRoute).toContain('sai format — bỏ qua (dùng model sẵn từng agent)')
    expect(wfRoute).toContain('{ continueOnDisconnect, modelOverride, providerOverride }')
  })

  test('B2. WorkflowConfig + ctx.modelOverride + applyModelOverride thuần', () => {
    expect(wfEngine).toContain('modelOverride?: string')
    expect(wfEngine).toContain('providerOverride?: string')
    expect(wfEngine).toMatch(/function applyModelOverride<T extends \{ provider: string; model: string \}>/)
    expect(wfEngine).toContain('modelOverride: config?.modelOverride')
  })

  test('B3. 3 điểm resolve đều qua applyModelOverride', () => {
    expect(wfEngine).toContain("applyModelOverride(await resolveAgent('TL'), ctx.modelOverride)")
    expect(wfEngine).toContain('ctx.resolvedAgentsCache.set(position, applyModelOverride(agent, ctx.modelOverride))')
    expect(wfEngine).toContain("applyModelOverride(ctx.resolvedAgentsCache.get('TL') || await resolveAgent('TL'), ctx.modelOverride)")
  })
})

describe('r129 C — Research Team (ALS, không sửa 15 call site)', () => {
  test('C1. resolveResearchBrain ưu tiên ALS override TRƯỚC DB', () => {
    expect(rsAgents).toContain('const chatOverride = currentResearchModelOverride()')
    expect(rsAgents).toContain('if (chatOverride?.model) {')
    // Thứ tự: check ALS phải nằm TRƯỚC db.agentProfile.findFirst
    const alsIdx = rsAgents.indexOf('const chatOverride = currentResearchModelOverride()')
    const dbIdx = rsAgents.indexOf('db.agentProfile.findFirst', rsAgents.indexOf('export async function resolveResearchBrain'))
    expect(alsIdx).toBeGreaterThan(0)
    expect(dbIdx).toBeGreaterThan(alsIdx)
  })

  test('C2. Route: validate + wrap construct stream trong ALS context', () => {
    expect(rsRoute).toContain('withResearchModelOverride(modelOv, async () => buildStream())')
    expect(rsRoute).toContain('const buildStream = () => new ReadableStream({')
    // Không override → buildStream() thẳng (behavior cũ 100%)
    expect(rsRoute).toMatch(/modelOv\s*\?\s*await withResearchModelOverride[\s\S]{0,80}: buildStream\(\)/)
  })
})

describe('r129 D — unit ALS model-override-context (pure, không db)', () => {
  test('D1. Override thấy được bên trong callback + qua await chain', async () => {
    const { withResearchModelOverride, currentResearchModelOverride } = await import('../src/lib/research-team/model-override-context')
    expect(currentResearchModelOverride()).toBeUndefined()
    const inner = await withResearchModelOverride({ model: 'z-ai/glm-5.3-flash', provider: 'nvidia' }, async () => {
      // Await chain: micro-task + timer — context phải giữ nguyên
      await Promise.resolve()
      await new Promise(r => setTimeout(r, 5))
      return currentResearchModelOverride()
    })
    expect(inner).toEqual({ model: 'z-ai/glm-5.3-flash', provider: 'nvidia' })
    // Ra ngoài callback → sạch (không leak context)
    expect(currentResearchModelOverride()).toBeUndefined()
  })

  test('D2. Các flow song song độc lập — không đè nhau', async () => {
    const { withResearchModelOverride, currentResearchModelOverride } = await import('../src/lib/research-team/model-override-context')
    const a = withResearchModelOverride({ model: 'model-a', provider: 'nvidia' }, async () => {
      await new Promise(r => setTimeout(r, 10))
      return currentResearchModelOverride()?.model
    })
    const b = withResearchModelOverride({ model: 'model-b', provider: 'nvidia' }, async () => {
      await new Promise(r => setTimeout(r, 2))
      return currentResearchModelOverride()?.model
    })
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toBe('model-a')
    expect(rb).toBe('model-b')
  })
})

/**
 * R103 TESTS — FIXBUG ĐỢT FB-EE (EXECUTION-EFFICIENCY W1+W2) — VÒNG R1
 * (giao thức fixbug.md mục 4/C5: MỖI fix ≥ 1 test case chứng minh lỗi cũ đã hết)
 *
 * Phạm vi regression — 6 fix vòng R1 trên commit triển khai 3641f90:
 *   A. FB-EE-B-R1-02 — isReasoningModel matching 2 CHIỀU (family không prefix):
 *      model-string ngắn 'glm-5.3-flash' phải match (bản trước entry có prefix
 *      'z-ai/glm-5.3-flash' → short name match=false → verdictBudget trả base
 *      → S3.1 tắt âm thầm).
 *   B. FB-EE-B-R1-04 + S3.1 — verdictBudget: reasoning 4× base; override 0 bị
 *      BỎ (bản trước 0 ?? base*4 → Math.max(0, base) = base — S3.1 tắt ngầm);
 *      NaN → 0 (không rò NaN xuống LLM call).
 *   C. FB-EE-B-R1-01 (consumer side) — buildDelegationOutcomeThought render
 *      dòng 📌 context_recall khi tool result có subRunId (delegate_task) và
 *      subRef từng item (dispatch_agents_parallel). Trước fix: KHÔNG đường
 *      GHI nào đặt subRunId vào result → dòng 📌 không bao giờ xuất hiện.
 *   D. FB-EE-B-R1-06 — buildDeterministicFinalReport đánh số section TỰ ĐỘNG
 *      tuần tự 1..N (bản trước hardcode '6'/'7' → khi run không có todo dãy
 *      nhảy 1,2,3,4,6,7).
 *   E. FB-EE-A-R1-05 — collectArtifactRefs (S2.4 survivor) dedupe THEO RUNID:
 *      2 biến thể dòng cùng sub-run + 1 sub-run khác → 2 refs (bản trước dedupe
 *      theo chuỗi nguyên văn → 3 refs, biến thể trùng chiếm slot cap 10).
 *   F. FB-EE-B-R1-01 (producer side, source-scan — precedent r95-H) — 5 điểm
 *      GHI subRunId: tool-executor delegate_task/dispatch_agent/escalate
 *      autoApplied + omega-orchestrator runDispatchTask/fanout + type
 *      DispatchResult có field — chặn regression bỏ key.
 *   G. FB-EE-A-R1-04 (source-scan) — LIKE layer kb-access strip wildcard
 *      %/_ trước Prisma contains (live-test trước fix: contains '%' match
 *      6/6 entity dù không tên nào chứa '%').
 *
 * KHÔNG đụng DB sống (buildDeterministicFinalReport gọi với runId=null —
 * skip todo query; các hàm còn lại thuần).
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isReasoningModel, verdictBudget } from '@/lib/llm'
import { buildDelegationOutcomeThought, buildDeterministicFinalReport } from '@/lib/agent-goal-loop'
import { collectArtifactRefs } from '@/lib/context-compression'

// ============ A. isReasoningModel — matching 2 chiều (FB-EE-B-R1-02) ============
describe('FB-EE-R1 · isReasoningModel matching 2 chiều (B-R1-02)', () => {
  test('short family name match = true (bản trước: false → S3.1 tắt âm thầm)', () => {
    expect(isReasoningModel('glm-5.3-flash')).toBe(true)
    expect(isReasoningModel('glm-5.3')).toBe(true)
    expect(isReasoningModel('deepseek-v4.1-flash')).toBe(true)
    expect(isReasoningModel('space-bunny')).toBe(true)
  })
  test('full prefixed id match = true (hành vi cũ giữ nguyên)', () => {
    expect(isReasoningModel('z-ai/glm-5.3-flash')).toBe(true)
    expect(isReasoningModel('deepseek-ai/deepseek-v4.1-flash')).toBe(true)
    expect(isReasoningModel('space-bunny-free')).toBe(true)
  })
  test('model thường + null/empty = false', () => {
    expect(isReasoningModel('nvidia/nemotron-3-ultra-550b-a55b')).toBe(false)
    expect(isReasoningModel(null)).toBe(false)
    expect(isReasoningModel('')).toBe(false)
    expect(isReasoningModel(undefined)).toBe(false)
  })
})

// ============ B. verdictBudget — guard + 4× reasoning (FB-EE-B-R1-04) ============
describe('FB-EE-R1 · verdictBudget guard (B-R1-04)', () => {
  test('reasoning model → 4× base (S3.1: 2000 → 8000)', () => {
    expect(verdictBudget('z-ai/glm-5.3-flash', 2000)).toBe(8000)
    expect(verdictBudget('glm-5.3-flash', 2000)).toBe(8000) // short name — trước fix trả 2000
  })
  test('model thường → base nguyên', () => {
    expect(verdictBudget('nvidia/nemotron-3-ultra-550b-a55b', 2000)).toBe(2000)
    expect(verdictBudget(null, 2000)).toBe(2000)
  })
  test('override dương được tôn trọng (consult 1100 → 4000)', () => {
    expect(verdictBudget('z-ai/glm-5.3-flash', 1100, 4000)).toBe(4000)
  })
  test('override 0 bị BỎ — rơi về 4× base (bản trước: 0 ?? base*4 → max(0,base) = base — S3.1 tắt ngầm)', () => {
    expect(verdictBudget('z-ai/glm-5.3-flash', 1100, 0)).toBe(4400)
  })
  test('NaN base → 0 (bản trước trả NaN rò xuống LLM call)', () => {
    expect(verdictBudget('z-ai/glm-5.3-flash', Number.NaN)).toBe(0)
  })
})

// ============ C. buildDelegationOutcomeThought — subRunId render (FB-EE-B-R1-01) ============
describe('FB-EE-R1 · buildDelegationOutcomeThought subRunId (B-R1-01)', () => {
  test('delegate_task result có subRunId → dòng 📌 context_recall 1 bước', () => {
    const t = buildDelegationOutcomeThought(2,
      { name: 'delegate_task', args: { agent: 'ALISTA', task: 'nghiên cứu quy trình thực thi' } },
      { success: true, result: { agent: 'ALISTA', iterations: 5, toolCalls: 10, tokensUsed: 12345, endedBy: 'concluded', report: 'Báo cáo nghiên cứu đầy đủ', subRunId: 'sub_test_123' } })
    expect(t).toBeTruthy()
    expect(t).toContain("📌 Báo cáo đầy đủ: context_recall({runId:'sub_test_123'})")
  })
  test('delegate_task result KHÔNG subRunId → không dòng 📌 (không bịa địa chỉ truy hồi)', () => {
    const t = buildDelegationOutcomeThought(2,
      { name: 'delegate_task', args: { agent: 'ALISTA', task: 'nghiên cứu' } },
      { success: true, result: { agent: 'ALISTA', iterations: 5, toolCalls: 10, tokensUsed: 12345, endedBy: 'concluded', report: 'Báo cáo' } })
    expect(t).toBeTruthy()
    expect(t).not.toContain('📌 Báo cáo đầy đủ')
  })
  test('dispatch_agents_parallel items có subRunId → subRef từng sub-run', () => {
    const t = buildDelegationOutcomeThought(3,
      { name: 'dispatch_agents_parallel', args: { tasks: [{ agent: 'ALISTA' }, { agent: 'SENTINEL' }] } },
      { success: true, result: { total: 2, succeeded: 1, tokensUsed: 5000, results: [
        { agent: 'ALISTA', success: true, iterations: 3, toolCalls: 5, report: 'ok', subRunId: 'sub_par_1' },
        { agent: 'SENTINEL', success: false, error: 'err' },
      ] } })
    expect(t).toBeTruthy()
    expect(t).toContain("📌 context_recall({runId:'sub_par_1'})")
  })
})

// ============ D. buildDeterministicFinalReport — numbering tuần tự (FB-EE-B-R1-06) ============
describe('FB-EE-R1 · buildDeterministicFinalReport đánh số tự động (B-R1-06)', () => {
  test('run KHÔNG todo (runId=null) + có delegationArtifacts → dãy số tuần tự 1..N không nhảy (bản trước: 1,2,3,4,6,7)', async () => {
    const report = await buildDeterministicFinalReport({
      goal: 'Nghiên cứu quy trình thực thi tác vụ',
      lastContent: 'Đã hoàn thành nghiên cứu, báo cáo đã lưu.',
      evidence: [
        { cycle: 1, kind: 'tool', tool: 'delegate_task', success: true, text: 'dispatch ALISTA' },
        { cycle: 2, kind: 'tool', tool: 'knowledge_search', success: true, text: 'tìm thấy 6 entity' },
      ],
      lastVerdict: { complete: false, confidence: 0.3, missing: ['chốt danh sách'], rootCause: 'đường truy hồi gãy' } as never,
      stopReason: 'no_progress',
      cyclesAttempted: 6,
      maxCycles: 12,
      agentName: 'Omega',
      delegationArtifacts: [{ agent: 'ALISTA', subRunId: 'sub_det_1' }, { agent: 'ALISTA', subRunId: 'sub_det_1' }],
      runId: null,        // bỏ qua todo query — không đụng DB
      agentSessionId: null,
      totalToolCalls: 36,
      lastError: 'all 3 LLM attempts failed (empty content)',
    })
    expect(report).toBeTruthy()
    // Bản cũ hardcode '6.' cho THÔNG ĐIỆP — bản mới phải là '5.' (todo rỗng)
    expect(report).toContain('5. THÔNG ĐIỆP CUỐI CỦA AGENT')
    expect(report).not.toContain('6. THÔNG ĐIỆP CUỐI CỦA AGENT')
    // Artifact refs render (dup subRunId → 1 dòng sau uniq)
    expect(report).toContain("context_recall({runId:'sub_det_1'})")
    // Dãy số section tuần tự strictly tăng từ 1 — không nhảy, không trùng
    const nums = [...report.matchAll(/^(\d+)\. /gm)].map(m => Number(m[1]))
    expect(nums.length).toBeGreaterThanOrEqual(5)
    for (let i = 0; i < nums.length; i++) expect(nums[i]).toBe(i + 1)
  })
})

// ============ E. collectArtifactRefs — dedupe theo runId (FB-EE-A-R1-05) ============
describe('FB-EE-R1 · collectArtifactRefs dedupe theo runId (A-R1-05)', () => {
  test('2 biến thể dòng CÙNG sub-run + 1 sub-run khác → 2 refs (bản trước: 3)', () => {
    const msgs = [
      { role: 'tool', content: 'Kết quả: ... \n\n📌 Báo cáo đầy đủ: context_recall({runId:\'sub_same_1\'})' },
      { role: 'assistant', content: '📌 Báo cáo đầy đủ: context_recall({runId:\'sub_same_1\'}) — 1 bước, nguyên vẹn (không cần đào trace)' },
      { role: 'tool', content: '· 📌 context_recall({runId:\'sub_other_2\'})' },
    ]
    const refs = collectArtifactRefs(msgs)
    expect(refs.length).toBe(2) // bản trước dedupe theo chuỗi nguyên văn → 3
    expect(refs.some(r => r.includes('sub_same_1'))).toBe(true)
    expect(refs.some(r => r.includes('sub_other_2'))).toBe(true)
  })
  test('messages không có ref → []', () => {
    expect(collectArtifactRefs([{ role: 'user', content: 'thường' }])).toEqual([])
    expect(collectArtifactRefs([])).toEqual([])
  })
  test('cap 10: 12 sub-run khác nhau → 10 refs', () => {
    const msgs = Array.from({ length: 12 }, (_, i) => ({
      role: 'tool' as const,
      content: `📌 Báo cáo đầy đủ: context_recall({runId:'sub_cap_${String(i).padStart(2, '0')}'})`,
    }))
    expect(collectArtifactRefs(msgs).length).toBe(10)
  })
})

// ============ F. subRunId plumbing — source-scan 5 điểm GHI (FB-EE-B-R1-01) ============
// (precedent r95-H source-scan wiring — chặn regression bỏ key tại tầng GHI)
describe('FB-EE-R1 · subRunId plumbing producer-side (B-R1-01)', () => {
  const toolExecutor = readFileSync('src/lib/code-team/tool-executor.ts', 'utf8')
  const orchestrator = readFileSync('src/lib/omega-orchestrator.ts', 'utf8')

  test('delegate_task result copy subRunId từ outcome', () => {
    expect(toolExecutor.includes('subRunId: outcome.subRunId')).toBe(true)
  })
  test('dispatch_agent result copy subRunId từ dispatched', () => {
    expect(toolExecutor.includes('subRunId: dispatched.subRunId')).toBe(true)
  })
  test('escalate autoApplied copy subRunId (≥2 chỗ: autoApplied + dispatch_agent)', () => {
    expect(toolExecutor.split('subRunId: dispatched.subRunId').length - 1).toBeGreaterThanOrEqual(2)
  })
  test('runDispatchTask return pass-through subRunId', () => {
    expect(orchestrator.includes('subRunId: outcome.subRunId')).toBe(true)
  })
  test('fanout results.push có subRunId', () => {
    expect(orchestrator.includes('subRunId: r.subRunId')).toBe(true)
  })
  test('type DispatchResult khai báo field subRunId', () => {
    expect(orchestrator.includes('subRunId?: string')).toBe(true)
  })
})

// ============ G. sanitizeLikeQuery — strip wildcard LIKE (FB-EE-A-R1-04) ============
describe('FB-EE-R1 · sanitizeLikeQuery strip wildcard (A-R1-04)', () => {
  test('query thuần wildcard → rỗng → caller SKIP LIKE layer (live-test trước fix: contains "%" match 6/6 entity)', async () => {
    const { sanitizeLikeQuery } = await import('@/lib/kb-routing/kb-access')
    expect(sanitizeLikeQuery('%')).toBe('')
    expect(sanitizeLikeQuery('_')).toBe('')
    expect(sanitizeLikeQuery('%_\\')).toBe('')
    expect(sanitizeLikeQuery('   ')).toBe('')
  })
  test('query thường + wildcard lẫn → strip wildcard, giữ nội dung tìm được', async () => {
    const { sanitizeLikeQuery } = await import('@/lib/kb-routing/kb-access')
    expect(sanitizeLikeQuery('TMO Execution Process Research')).toBe('TMO Execution Process Research')
    expect(sanitizeLikeQuery('50%_done')).toBe('50 done')
    expect(sanitizeLikeQuery('  glm  ')).toBe('glm')
  })
  test('LIKE layer dùng sanitizeLikeQuery + guard rỗng (source-scan — chặn regression bỏ guard)', () => {
    const kbAccess = readFileSync('src/lib/kb-routing/kb-access.ts', 'utf8')
    expect(kbAccess.includes('const q = sanitizeLikeQuery(query)')).toBe(true)
    expect(kbAccess.includes('if (q) {')).toBe(true)
  })
})

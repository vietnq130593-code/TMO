/**
 * ROUND-110 TESTS — BRAIN-D1 (BLUEPRINT-EVO-NAO-P1-P5 §8.1 — task R20)
 * KB CONSULT LOG — LOG-ONLY, FAIL-OPEN, ALS CONTEXT
 * ============================================================================
 *
 * Đo lường:
 *   A. Spec pin: TUNING_SPECS có 'kb_consult_log' default 'on' (LOG-ONLY quan
 *      sát → mặc định BẬT, khác mọi cờ brain runtime khác) · enum off/on ·
 *      envKey KB_CONSULT_LOG · node 'kb-access' tồn tại trong NEURAL_NODES với
 *      paramKeys chứa kb_consult_log · edges e38–e42 (chat/goal-loop →
 *      kb-access → qdrant/neo4j/sqlite) tồn tại trong NEURAL_EDGES.
 *   B. logKbConsult (DB cô lập qua preload):
 *      B1. ghi row đầy đủ field — verify từng cột qua findFirst;
 *      B2. topResults 300 phần tử → topResultsJson ≤ 4000 ký tự + parse có
 *          truncated:true + dropped = số phần bỏ;
 *      B3. queryText 10.000 ký tự → rút gọn ≤ ~2.050 + đuôi '[truncated]';
 *      B4. NEVER-THROW: topResults chứa circular reference → JSON.stringify
 *          nổ → bắt trong serializeCapped → '{}' — row VẪN ghi (fail-open
 *          tuyệt đối: lỗi ghi log không chạm caller);
 *      B5. cờ off (setTuningValue STORE) → KHÔNG ghi row mới; bật lại 'on'
 *          (cleanup) → ghi lại bình thường.
 *   C. consult-context ALS (thuần):
 *      C1. ngoài wrap → getKbConsultContext() = {} (LOG-ONLY không bắt buộc);
 *      C2. trong wrap → đọc đúng đủ field;
 *      C3. nested merge: cha {taskType:'chat', intent:'factual', runId:'r1'}
 *          bọc con {taskType:'tool:knowledge_search'} → trong con thấy
 *          taskType CỦA CON + intent/runId THỪA KẾ từ cha; sau khi thoát
 *          scope con, cha thấy lại context cha (isolation chuẩn ALS).
 *   D. Integration đường THẬT searchUserKB (sandbox: KB rỗng/embedding key
 *      thiếu — mọi nguồn fail-open về 0 hit, KHÔNG throw):
 *      D1. searchUserKB trả UserKBResult bình thường;
 *      D2. row KbConsultLog mới nhất: agentId truyền vào + retrievalConfig
 *          parse {topK, minImportance, hybrid, mmr, rerank} + sources parse
 *          đủ 4 key đếm (chunks/entities/memories/communities) + latencyMs ≥ 0
 *          — CHỨNG MINH điểm đo phủ MỌI lượt consult kể cả KB trống;
 *      D3. bọc runWithKbConsultContext quanh searchUserKB → row mới nhất có
 *          đúng taskType/intent/runId/sessionId — CHỨNG MINH ALS chảy từ
 *          caller xuống tầng log xuyên qua searchUserKB.
 *
 * Nguyên tắc test:
 * - fire-and-forget: searchUserKB ghi log qua `void logKbConsult(...)` →
 *   dùng poll-wait (50ms step, 5s timeout) thay sleep cứng.
 * - DB cô lập: bunfig preload trỏ DATABASE_URL sang /tmp (tests/
 *   db-isolation-preload.ts) — ghi KbConsultLog không đụng db/custom.db.
 */

import { describe, test, expect } from 'bun:test'
import { db } from '@/lib/db'
import { TUNING_SPECS, NEURAL_NODES, NEURAL_EDGES, getTuningSpec } from '@/lib/learning/neural-types'
import { setTuningValue } from '@/lib/learning/tuning-store'
import { logKbConsult } from '@/lib/kb-routing/consult-log'
import { runWithKbConsultContext, getKbConsultContext } from '@/lib/kb-routing/consult-context'

/** Poll-wait điều kiện (fire-and-forget log cần thời gian tới DB). */
async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return await cond()
}

async function latestLog(): Promise<{ id: string; [k: string]: unknown } | null> {
  const rows = await db.kbConsultLog.findMany({ orderBy: { createdAt: 'desc' }, take: 1 })
  return (rows[0] as { id: string; [k: string]: unknown } | undefined) ?? null
}

describe('r110-A · Spec pin — cờ + node + edges (BRAIN-D1)', () => {
  test('A1: TUNING_SPECS có kb_consult_log default ON (LOG-ONLY — khác mọi cờ runtime)', () => {
    const spec = getTuningSpec('kb_consult_log')
    expect(spec).not.toBeNull()
    expect(spec?.default).toBe('on')
    expect(spec?.type).toBe('enum')
    expect(spec?.enumValues).toEqual(['off', 'on'])
    expect(spec?.envKey).toBe('KB_CONSULT_LOG')
    expect(spec?.nodeId).toBe('kb-access')
    // Default ON là quyết định thiết kế D1: quan sát thuần không đổi hành vi —
    // mọi cờ brain runtime (runtime_policy/replay_eval…) default 'off'
    const runtimePolicy = getTuningSpec('runtime_policy')
    expect(runtimePolicy?.default).toBe('off')
  })

  test('A2: node kb-access trong NEURAL_NODES + paramKeys gắn cờ', () => {
    const node = NEURAL_NODES.find(n => n.id === 'kb-access')
    expect(node).toBeDefined()
    expect(node?.layer).toBe('processing')
    expect(node?.paramKeys).toContain('kb_consult_log')
    expect(node?.title.toLowerCase()).toContain('kb')
  })

  test('A3: edges e38–e42 — dòng consult KB (chat/goal-loop → kb-access → nguồn)', () => {
    const ids = new Set(NEURAL_EDGES.map(e => e.id))
    for (const id of ['e38', 'e39', 'e40', 'e41', 'e42']) {
      expect(ids.has(id)).toBe(true)
    }
    const e42 = NEURAL_EDGES.find(e => e.id === 'e42')
    expect(e42?.to).toBe('sqlite')
    expect(e42?.label).toContain('KbConsultLog')
  })

  test('A4: TUNING_SPECS không key trùng (thêm kb_consult_log không đè key cũ)', () => {
    const keys = TUNING_SPECS.map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('r110-B · logKbConsult — ghi + truncate + fail-open + cờ', () => {
  test('B1: ghi row đầy đủ field', async () => {
    const before = await db.kbConsultLog.count()
    await logKbConsult({
      taskType: 'chat',
      intent: 'factual',
      queryText: 'cách dùng Neo4j làm GraphRAG',
      retrievalConfig: { topK: 5, minImportance: 0.3, hybrid: true, mmr: false, rerank: true },
      sources: { chunks: 3, entities: 2, memories: 0, communities: 1 },
      topResults: [
        { id: 'c1', source: 'chunk', score: 0.91, denseScore: 0.42 },
        { id: 'e1', source: 'chunk', score: 0.85 },
      ],
      confidence: 0.62,
      rawConfidence: 0.58,
      tokensUsed: 0,
      latencyMs: 742,
      runId: 'run-r110-b1',
      sessionId: 'sess-r110',
      agentId: 'omega',
    })
    const ok = await waitFor(async () => (await db.kbConsultLog.count()) === before + 1)
    expect(ok).toBe(true)

    const row = await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-b1' } })
    expect(row).not.toBeNull()
    expect(row?.taskType).toBe('chat')
    expect(row?.intent).toBe('factual')
    expect(row?.queryText).toBe('cách dùng Neo4j làm GraphRAG')
    const cfg = JSON.parse(row?.retrievalConfigJson ?? '{}')
    expect(cfg.topK).toBe(5)
    expect(cfg.hybrid).toBe(true)
    expect(cfg.rerank).toBe(true)
    const src = JSON.parse(row?.sourcesJson ?? '{}')
    expect(src).toEqual({ chunks: 3, entities: 2, memories: 0, communities: 1 })
    const tops = JSON.parse(row?.topResultsJson ?? '[]')
    expect(tops).toHaveLength(2)
    expect(tops[0].id).toBe('c1')
    expect(tops[0].denseScore).toBe(0.42)
    expect(row?.confidence).toBe(0.62)
    expect(row?.rawConfidence).toBe(0.58)
    expect(row?.latencyMs).toBe(742)
    expect(row?.sessionId).toBe('sess-r110')
    expect(row?.agentId).toBe('omega')
  })

  test('B2: topResults 300 phần tử → truncate ≤4KB + flag truncated + dropped', async () => {
    const big = Array.from({ length: 300 }, (_, i) => ({
      id: `chunk-${i}`,
      source: 'chunk',
      score: 0.9 - i / 1000,
      denseScore: 0.4,
    }))
    await logKbConsult({
      retrievalConfig: { topK: 5 },
      sources: { chunks: 300 },
      topResults: big,
      latencyMs: 100,
      runId: 'run-r110-b2',
    })
    const ok = await waitFor(async () =>
      Boolean(await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-b2' } }))
    )
    expect(ok).toBe(true)
    const row = await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-b2' } })
    expect((row?.topResultsJson ?? '').length).toBeLessThanOrEqual(4000)
    const parsed = JSON.parse(row?.topResultsJson ?? '[]')
    expect(parsed[parsed.length - 1].truncated).toBe(true)
    expect(typeof parsed[parsed.length - 1].dropped).toBe('number')
    // Giữ top quan trọng nhất (top-1 đứng đầu)
    expect(parsed[0].id).toBe('chunk-0')
  })

  test('B3: queryText 10.000 ký tự → rút gọn + đuôi [truncated]', async () => {
    await logKbConsult({
      queryText: 'x'.repeat(10_000),
      retrievalConfig: {},
      sources: {},
      topResults: [],
      latencyMs: 5,
      runId: 'run-r110-b3',
    })
    const ok = await waitFor(async () =>
      Boolean(await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-b3' } }))
    )
    expect(ok).toBe(true)
    const row = await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-b3' } })
    expect((row?.queryText ?? '').length).toBeLessThanOrEqual(2_050)
    expect(row?.queryText).toContain('[truncated]')
  })

  test("B4: NEVER-THROW — circular reference trong topResults → '{}' + row vẫn ghi", async () => {
    const circular: Record<string, unknown> = { id: 'bad' }
    circular.self = circular
    const before = await db.kbConsultLog.count()
    // KHÔNG được throw ra ngoài
    await logKbConsult({
      retrievalConfig: {},
      sources: {},
      topResults: [circular as unknown as Record<string, unknown>],
      latencyMs: 1,
      runId: 'run-r110-b4',
    })
    const ok = await waitFor(async () => (await db.kbConsultLog.count()) === before + 1)
    expect(ok).toBe(true)
    const row = await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-b4' } })
    expect(row?.topResultsJson).toBe('{}')
  })

  test('B5: cờ off → skip ghi; bật lại on → ghi lại (STORE qua setTuningValue)', async () => {
    await setTuningValue('kb_consult_log', 'off')
    try {
      const before = await db.kbConsultLog.count()
      await logKbConsult({
        retrievalConfig: {},
        sources: {},
        topResults: [],
        latencyMs: 1,
        runId: 'run-r110-b5-should-not-exist',
      })
      // Cho fire-and-forget thời gian nếu nó (sai thiết kế) vẫn ghi
      await new Promise(r => setTimeout(r, 400))
      expect(await db.kbConsultLog.count()).toBe(before)
      expect(
        await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-b5-should-not-exist' } })
      ).toBeNull()
    } finally {
      await setTuningValue('kb_consult_log', 'on')
    }
    // Bật lại → ghi lại được
    await logKbConsult({
      retrievalConfig: {},
      sources: {},
      topResults: [],
      latencyMs: 1,
      runId: 'run-r110-b5-on',
    })
    const ok = await waitFor(async () =>
      Boolean(await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-b5-on' } }))
    )
    expect(ok).toBe(true)
  })
})

describe('r110-C · consult-context ALS (thuần)', () => {
  test('C1: ngoài wrap → {} (LOG-ONLY không bắt buộc ngữ cảnh)', () => {
    expect(getKbConsultContext()).toEqual({})
  })

  test('C2: trong wrap → đọc đúng đủ field', async () => {
    const seen = await runWithKbConsultContext(
      { taskType: 'chat', intent: 'procedural', runId: 'r1', sessionId: 's1', agentId: 'omega' },
      async () => getKbConsultContext()
    )
    expect(seen).toEqual({ taskType: 'chat', intent: 'procedural', runId: 'r1', sessionId: 's1', agentId: 'omega' })
  })

  test('C3: nested merge — con thắng theo key, thừa kế key cha, isolate khi thoát', async () => {
    const inner = await runWithKbConsultContext(
      { taskType: 'chat', intent: 'factual', runId: 'r-parent' },
      async () =>
        runWithKbConsultContext(
          { taskType: 'tool:knowledge_search' },
          async () => getKbConsultContext()
        )
    )
    // Con chỉ override taskType — intent/runId thừa kế từ cha
    expect(inner).toEqual({ taskType: 'tool:knowledge_search', intent: 'factual', runId: 'r-parent' })

    // Thoát scope con — cha thấy lại context cha
    const outer = await runWithKbConsultContext(
      { taskType: 'chat' },
      async () =>
        runWithKbConsultContext({ taskType: 'child' }, async () => 'x').then(() =>
          getKbConsultContext()
        )
    )
    expect(outer).toEqual({ taskType: 'chat' })
  })
})

describe('r110-D · Integration searchUserKB — điểm đo phủ mọi lượt (fail-open KB trống)', () => {
  test('D1+D2: searchUserKB KHÔNG throw trên KB trống + VẪN ghi log đầy đủ', async () => {
    const { searchUserKB } = await import('@/lib/kb-routing/kb-access')
    const before = await db.kbConsultLog.count()

    const result = await searchUserKB('test brain d1 consult log r110', 'agent-r110', { topK: 3 })
    // KB rỗng/embedding thiếu → fail-open: kết quả rỗng hợp lệ, KHÔNG throw
    expect(result.source).toBe('user-kb')
    expect(typeof result.confidence).toBe('number')
    expect(Array.isArray(result.chunks)).toBe(true)

    const ok = await waitFor(async () => (await db.kbConsultLog.count()) > before)
    expect(ok).toBe(true)

    const row = await latestLog()
    expect(row).not.toBeNull()
    expect(row?.agentId).toBe('agent-r110')
    const cfg = JSON.parse(String(row?.retrievalConfigJson ?? '{}'))
    expect(cfg.topK).toBe(3)
    expect(typeof cfg.hybrid).toBe('boolean')
    expect(typeof cfg.mmr).toBe('boolean')
    expect(typeof cfg.rerank).toBe('boolean')
    const src = JSON.parse(String(row?.sourcesJson ?? '{}'))
    expect(src).toHaveProperty('chunks')
    expect(src).toHaveProperty('entities')
    expect(src).toHaveProperty('memories')
    expect(src).toHaveProperty('communities')
    expect(Number(row?.latencyMs ?? -1)).toBeGreaterThanOrEqual(0)
    expect(String(row?.queryText ?? '')).toContain('r110')
  })

  test('D3: ALS từ caller chảy tới tầng log xuyên qua searchUserKB', async () => {
    const { searchUserKB } = await import('@/lib/kb-routing/kb-access')
    const before = await db.kbConsultLog.count()

    await runWithKbConsultContext(
      {
        taskType: 'test-wrap-r110',
        intent: 'meta',
        runId: 'run-r110-d3',
        sessionId: 'sess-r110-d3',
      },
      async () => searchUserKB('als context flow test r110', undefined, { topK: 2 })
    )

    const ok = await waitFor(async () => (await db.kbConsultLog.count()) > before)
    expect(ok).toBe(true)

    const row = await db.kbConsultLog.findFirst({
      where: { runId: 'run-r110-d3' },
      orderBy: { createdAt: 'desc' },
    })
    expect(row).not.toBeNull()
    expect(row?.taskType).toBe('test-wrap-r110')
    expect(row?.intent).toBe('meta')
    expect(row?.sessionId).toBe('sess-r110-d3')
  })
})

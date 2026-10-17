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
 *      B2. topResults 300 phần tử → topResultsJson ≤ 4.000 BYTE UTF-8 +
 *          parse có truncated:true + dropped = số phần bỏ;
 *      B3. queryText 10.000 ký tự → rút gọn ≤ 2.000 BYTE + đuôi '[truncated]';
 *      B3b (regression FB-D1-R1-03): chuỗi tiếng Việt 2-byte/char cắt theo
 *          BYTE thật (trước fix so theo .length UTF-16 → sai 2×);
 *      B4. NEVER-THROW: topResults chứa circular reference → JSON.stringify
 *          nổ → bắt trong serializeCapped → '{}' — row VẪN ghi (fail-open
 *          tuyệt đối: lỗi ghi log không chạm caller);
 *      B5. cờ off (setTuningValue STORE) → KHÔNG ghi row mới; bật lại 'on'
 *          (cleanup) → ghi lại bình thường;
 *      B6 (regression FB-D1-R1-08): queryText '' → ghi '' (không nhầm NULL).
 *   C. consult-context ALS (thuần):
 *      C1. ngoài wrap → getKbConsultContext() = {} (LOG-ONLY không bắt buộc);
 *      C2. trong wrap → đọc đúng đủ field;
 *      C3. nested merge: cha {taskType:'chat', intent:'factual', runId:'r1'}
 *          bọc con {taskType:'tool:knowledge_search'} → trong con thấy
 *          taskType CỦA CON + intent/runId THỪA KẾ từ cha; sau khi thoát
 *          scope con, cha thấy lại context cha (isolation chuẩn ALS);
 *      C4 (regression FB-D1-R1-02): context con build đủ key với nhiều field
 *          undefined (shape production của tool-executor) — undefined KHÔNG
 *          đè value cha (trước fix: spread copy key undefined → mất Outcome*).
 *   D. Integration đường THẬT searchUserKB (sandbox: KB rỗng/embedding key
 *      thiếu — mọi nguồn fail-open về 0 hit, KHÔNG throw):
 *      D1. searchUserKB trả UserKBResult bình thường;
 *      D2. row KbConsultLog mới nhất: agentId truyền vào + retrievalConfig
 *          parse {topK, minImportance, hybrid, mmr, rerank} + sources parse
 *          đủ 4 key đếm (chunks/entities/memories/communities) + latencyMs ≥ 0
 *          — CHỨNG MINH điểm đo phủ MỌI lượt consult kể cả KB trống;
 *      D3. bọc runWithKbConsultContext quanh searchUserKB → row mới nhất có
 *          đúng taskType/intent/runId/sessionId — CHỨNG MINH ALS chảy từ
 *          caller xuống tầng log xuyên qua searchUserKB;
 *      D4 (regression FB-D1-R1-04): retrievalConfig có denseThreshold (0..0.9,
 *          công thức ROUND-38 V5-6 dùng chung với searchChunks) +
 *          sourcesEnabled {chunks, communities, entities, memories}.
 *   E. Regression FB-D1-R1-05 — MỌI lượt consult có row (fallback + graph):
 *      E1. agentGraphQuery (Cypher) ghi row kể cả khi Neo4j không khả dụng
 *          (fail-open) — wrapper LOG-ONLY precedent executeTool;
 *      E2. logKbConsultFallback — row fallback giữ ngữ cảnh ALS + lý do lỗi.
 *   A5 (regression FB-D1-R1-01): migration add_kb_consult_log tồn tại trong
 *      prisma/migrations — máy user theo luồng "git pull → bun run db:deploy"
 *      (doctrine FB-P3) sẽ CÓ BẢNG (trước fix: schema-only → log chết im lặng).
 *
 * Nguyên tắc test:
 * - fire-and-forget: searchUserKB ghi log qua `void logKbConsult(...)` →
 *   dùng poll-wait (50ms step, 5s timeout) thay sleep cứng.
 * - DB cô lập: bunfig preload trỏ DATABASE_URL sang /tmp (tests/
 *   db-isolation-preload.ts) — ghi KbConsultLog không đụng db/custom.db.
 */

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@/lib/db'
import { TUNING_SPECS, NEURAL_NODES, NEURAL_EDGES, getTuningSpec } from '@/lib/learning/neural-types'
import { setTuningValue } from '@/lib/learning/tuning-store'
import { logKbConsult } from '@/lib/kb-routing/consult-log'
import { runWithKbConsultContext, getKbConsultContext } from '@/lib/kb-routing/consult-context'

/** Độ dài byte UTF-8 (FB-D1-R1-03 — cùng đơn vị với MAX_*_BYTES). */
function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

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

  test('A5 (regression FB-D1-R1-01): migration add_kb_consult_log tồn tại — db:deploy tạo được bảng', () => {
    // Trước fix: model chỉ nằm trong schema.prisma (đã push sandbox) nhưng
    // KHÔNG có migration → máy user "git pull → bun run db:deploy" (doctrine
    // FB-P3) không có bảng → mọi logKbConsult fail-open im lặng mãi mãi.
    const migrationsDir = join(process.cwd(), 'prisma', 'migrations')
    const dirs = readdirSync(migrationsDir).filter(d => d.endsWith('_add_kb_consult_log'))
    expect(dirs.length).toBeGreaterThanOrEqual(1)
    const sql = readFileSync(join(migrationsDir, dirs[0], 'migration.sql'), 'utf8')
    expect(sql).toContain('CREATE TABLE "KbConsultLog"')
    expect(sql).toContain('CREATE INDEX "KbConsultLog_createdAt_idx"')
    expect(sql).toContain('CREATE INDEX "KbConsultLog_runId_idx"')
    expect(sql).toContain('CREATE INDEX "KbConsultLog_taskType_idx"')
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
    expect(byteLen(row?.topResultsJson ?? '')).toBeLessThanOrEqual(4000)
    const parsed = JSON.parse(row?.topResultsJson ?? '[]')
    expect(parsed[parsed.length - 1].truncated).toBe(true)
    expect(typeof parsed[parsed.length - 1].dropped).toBe('number')
    // Giữ top quan trọng nhất (top-1 đứng đầu)
    expect(parsed[0].id).toBe('chunk-0')
  })

  test('B3: queryText 10.000 ký tự → rút gọn theo BYTE ≤2.000 + đuôi [truncated]', async () => {
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
    // FB-D1-R1-03 — guarantee theo BYTE UTF-8 (đơn vị của MAX_QUERY_TEXT_BYTES)
    expect(byteLen(row?.queryText ?? '')).toBeLessThanOrEqual(2_000)
    expect(row?.queryText).toContain('[truncated]')
  })

  test("B3b (regression FB-D1-R1-03): chuỗi tiếng Việt 2-byte/char cắt theo BYTE — không vượt 2KB, không cắt giữa ký tự", async () => {
    // 'ă' U+0103 = 2 byte UTF-8 nhưng 1 UTF-16 unit: trước fix so theo .length
    // → 2.000 chars = 4.000 bytes lưu vào DB (sai guarantee 2×).
    await logKbConsult({
      queryText: 'ă'.repeat(2_000),
      retrievalConfig: {},
      sources: {},
      topResults: [],
      latencyMs: 5,
      runId: 'run-r110-b3b',
    })
    const ok = await waitFor(async () =>
      Boolean(await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-b3b' } }))
    )
    expect(ok).toBe(true)
    const row = await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-b3b' } })
    const qt = row?.queryText ?? ''
    expect(byteLen(qt)).toBeLessThanOrEqual(2_000)
    expect(qt.endsWith('…[truncated]')).toBe(true)
    // Ranh giới ký tự nguyên vẹn: phần đầu (trước suffix) toàn 'ă' đủ ký tự
    const head = qt.slice(0, -'…[truncated]'.length)
    expect(head).toMatch(/^ă+$/)
    expect(head.length).toBeGreaterThan(900) // cắt ~1.000 ký tự chứ không phải 0
  })

  test("B6 (regression FB-D1-R1-08): queryText rỗng '' ghi '' — phân biệt với NULL (không có query)", async () => {
    // Trước fix: '' là falsy → capQueryText trả undefined → lưu NULL — mất
    // phân biệt "consult với query trống" với "không có query".
    await logKbConsult({
      queryText: '',
      retrievalConfig: {},
      sources: {},
      topResults: [],
      latencyMs: 1,
      runId: 'run-r110-b6',
    })
    const ok = await waitFor(async () =>
      Boolean(await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-b6' } }))
    )
    expect(ok).toBe(true)
    const row = await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-b6' } })
    expect(row?.queryText).toBe('')
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

  test('C4 (regression FB-D1-R1-02): nested — key undefined tường minh KHÔNG đè value cha', async () => {
    // Shape production của tool-executor: ctx con build ĐỦ key, nhiều field
    // undefined. Trước fix: {...parent, ...ctx} copy cả key undefined →
    // runId/sessionId/agentId của cha BỊ MẤT → row consult mất nối Outcome*.
    const inner = await runWithKbConsultContext(
      { taskType: 'chat', runId: 'r-parent', sessionId: 's-parent', agentId: 'omega' },
      async () =>
        runWithKbConsultContext(
          { taskType: 'tool:knowledge_search', runId: undefined, sessionId: undefined, agentId: undefined },
          async () => getKbConsultContext()
        )
    )
    expect(inner).toEqual({
      taskType: 'tool:knowledge_search',
      runId: 'r-parent',
      sessionId: 's-parent',
      agentId: 'omega',
    })
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

  test('D4 (regression FB-D1-R1-04): retrievalConfig ghi denseThreshold + sourcesEnabled — cấu hình hiệu lực ĐẦY ĐỦ cho D2', async () => {
    const { searchUserKB } = await import('@/lib/kb-routing/kb-access')
    await runWithKbConsultContext(
      { taskType: 'test-r110-d4', runId: 'run-r110-d4' },
      async () => searchUserKB('dense threshold logging test r110', 'agent-r110-d4', { topK: 2 })
    )
    const ok = await waitFor(async () =>
      Boolean(await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-d4' } }))
    )
    expect(ok).toBe(true)
    const row = await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-d4' } })
    const cfg = JSON.parse(String(row?.retrievalConfigJson ?? '{}'))
    // denseThreshold — công thức ROUND-38 V5-6 min(0.9, 0.3 + red-team delta)
    // dùng CHUNG với searchChunks (single source resolveDenseThreshold)
    expect(typeof cfg.denseThreshold).toBe('number')
    expect(cfg.denseThreshold).toBeGreaterThanOrEqual(0)
    expect(cfg.denseThreshold).toBeLessThanOrEqual(0.9)
    // sourcesEnabled — phân biệt "nguồn tắt" (agentId undefined → entities/
    // memories bỏ chạy) với "nguồn bật nhưng 0 hit" — D2 cần để hiểu phân phối
    expect(cfg.sourcesEnabled).toEqual({
      chunks: true,
      communities: true,
      entities: true, // agentId truyền vào → nguồn bật
      memories: true,
    })
  })
})

describe('r110-E · Regression FB-D1-R1-05 — MỌI lượt consult có row (fallback + graph)', () => {
  test('E1: agentGraphQuery (Cypher) ghi row KbConsultLog kể cả Neo4j không khả dụng (fail-open)', async () => {
    const { agentGraphQuery } = await import('@/lib/knowledge-bridge')
    // Trên sandbox test Neo4j không chạy → impl fail-open 'Neo4j driver not
    // available' — wrapper LOG-ONLY vẫn PHẢI ghi row (trước fix: graph-query
    // hoàn toàn ngoài quan sát D1).
    const res = await runWithKbConsultContext(
      { taskType: 'graph-test-r110', runId: 'run-r110-e1' },
      async () => agentGraphQuery('MATCH (n) RETURN n LIMIT 1')
    )
    expect(Array.isArray(res.records)).toBe(true)
    expect(typeof res.count).toBe('number')

    const ok = await waitFor(async () =>
      Boolean(await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-e1' } }))
    )
    expect(ok).toBe(true)
    const row = await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-e1' } })
    expect(row?.taskType).toBe('graph-test-r110')
    expect(String(row?.queryText ?? '')).toContain('MATCH')
    const src = JSON.parse(String(row?.sourcesJson ?? '{}'))
    expect(typeof src.graphRecords).toBe('number')
    // Neo4j không có → graphError ghi lý do (không nuốt im lặng)
    if (res.error) expect(src.graphError).toBe(res.error.slice(0, 200))
  })

  test('E2: logKbConsultFallback — row fallback giữ ngữ cảnh ALS + lý do pipeline lỗi', async () => {
    const { logKbConsultFallback } = await import('@/lib/kb-routing/consult-log')
    await runWithKbConsultContext(
      { taskType: 'tool:knowledge_search', runId: 'run-r110-e2', sessionId: 'sess-r110-e2' },
      async () =>
        logKbConsultFallback('query fallback test r110', Date.now() - 123, new Error('Qdrant unreachable (test)'))
    )
    const ok = await waitFor(async () =>
      Boolean(await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-e2' } }))
    )
    expect(ok).toBe(true)
    const row = await db.kbConsultLog.findFirst({ where: { runId: 'run-r110-e2' } })
    // Ngữ cảnh ALS giữ nguyên (taskType của tool, không bị đè 'kb-fallback-dense')
    expect(row?.taskType).toBe('tool:knowledge_search')
    expect(row?.sessionId).toBe('sess-r110-e2')
    const cfg = JSON.parse(String(row?.retrievalConfigJson ?? '{}'))
    expect(cfg.fallbackDenseOnly).toBe(true)
    const src = JSON.parse(String(row?.sourcesJson ?? '{}'))
    expect(String(src.pipelineError)).toContain('Qdrant unreachable')
    expect(Number(row?.latencyMs ?? -1)).toBeGreaterThanOrEqual(123)
  })
})

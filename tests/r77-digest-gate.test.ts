/**
 * ROUND-77 TESTS — P3-M4 ROUGE-L + EVIDENCE-COVERAGE GATE CHO DIGEST/SUMMARY
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P3-M4, mục #7 — ML.pdf §ROUGE/BERTScore)
 *
 * Đo lường:
 *   A. extractEvidenceTokens — trích đúng camelCase/PascalCase, snake/kebab,
 *      đường dẫn, SỐ ≥2 chữ số/thập phân (số 1 chữ số bỏ có chủ đích — phổ
 *      biến vô tín hiệu); khử trùng case-insensitive; cap 60; evidence rỗng.
 *   B. checkDigestGate — digest giữ đủ → pass; digest BỎ HẾT SỐ LIỆU →
 *      coverage thấp → fail (kịch bản chính blueprint); biên coverage đúng
 *      0.7 → pass (≥ ngată); tỉ lệ tính tay 7/10 vs 6/10; case-insensitive;
 *      evidence không token đo được → tự qua; missing cap 5.
 *   C. compressConversation (mock @/lib/llm) — LLM digest GIỮ dẫn chứng →
 *      method 'llm' giữ; LLM digest bỏ dẫn chứng → digest-gate-fallback →
 *      method 'heuristic' (digest chứa dòng evidence [tool]); LLM throw →
 *      heuristic như cũ (không đổi hành vi); DigestGateEvent ghi pass/fallback
 *      đúng; evidence rỗng + LLM tốt → gate tự qua giữ 'llm' (goal-loop
 *      precedent), evidence rỗng + LLM hỏng → return null (hành vi cũ).
 *   D. summarizeMemories (mock @/lib/llm) — summary giữ chủ đề (recall ≥ 0.3)
 *      → nhận; summary chệch chủ đề → digest-gate-fallback → batch[0]; các
 *      sanity check cũ giữ nguyên (dài hơn input → batch[0]; <2 mẫu → null;
 *      rỗng → null).
 *   E. KPI digest_gate_fallback_rate — compute() trên seed DigestGateEvent
 *      đúng tỉ lệ (3 pass + 1 fallback → 0.25), total 0 → 0.
 *
 * Mock: bun mock.module('@/lib/llm') với implementation điều khiển được qua
 * biến mutable (mỗi test gán hành vi riêng) — cả context-compression VÀ
 * memory-summarization đều qua callUtilityLLM nên 1 mock phủ cả hai.
 *
 * DB-cô-lập (bunfig preload copy DB) — DigestGateEvent ghi fire-and-forget
 * nên test poll đếm với deadline (không sleep cứng).
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test'
import { db } from '@/lib/db'

// ==================== MOCK @/lib/llm (điều khiển được) ====================

type LlmImpl = (prompt: string, context?: string) => Promise<{ content: string; tokensUsed: number }>

let llmImpl: LlmImpl = async () => ({ content: '', tokensUsed: 0 })

mock.module('@/lib/llm', () => ({
  callUtilityLLM: (prompt: string, _context?: string, label?: string) => llmImpl(prompt, label),
  // callLLM không dùng trong 2 module dưới — mock chống lỗi import type
  callLLM: async () => ({ content: '', error: 'not used in this test' }),
}))

const { compressConversation, checkDigestGate, extractEvidenceTokens, DIGEST_EVIDENCE_COVERAGE_MIN } =
  await import('@/lib/context-compression')
const { summarizeMemories, SUMMARY_ROUGE_RECALL_MIN } = await import('@/lib/memory-summarization')
const { KPI_REGISTRY } = await import('@/lib/kpi/registry')

/** Poll đếm row với deadline — recordDigestGateEvent ghi fire-and-forget */
async function waitForCount(
  count: () => Promise<number>,
  predicate: (n: number) => boolean,
  deadlineMs = 2000,
): Promise<number> {
  const start = Date.now()
  for (;;) {
    const n = await count()
    if (predicate(n)) return n
    if (Date.now() - start > deadlineMs) return n
    await new Promise(r => setTimeout(r, 25))
  }
}

// ==================== A. extractEvidenceTokens ====================

describe('r77 · P3-M4 extractEvidenceTokens — trích dẫn chứng kỹ thuật', () => {
  test('camelCase/PascalCase + snake/kebab + path + số', () => {
    const ev = [{ kind: 'tool', tool: 'shell', success: true, text: 'parseEvalVerdict và WilsonCI chạy raw_confidence tại goal-loop, xem src/lib/db, kết quả 722 test pass, tỉ lệ 0.55' }]
    const toks = extractEvidenceTokens(ev)
    expect(toks).toContain('parseEvalVerdict')
    expect(toks).toContain('WilsonCI')
    expect(toks).toContain('raw_confidence')
    expect(toks).toContain('goal-loop')
    expect(toks).toContain('src/lib/db')
    expect(toks).toContain('722')
    expect(toks).toContain('0.55')
  })

  test('số 1 chữ số KHÔNG trích (phổ biến vô tín hiệu — chọn có chủ đích)', () => {
    const ev = [{ kind: 'tool', tool: 't', success: true, text: 'exit code 1 với flag 0 và mức 5' }]
    const toks = extractEvidenceTokens(ev)
    expect(toks.some(t => t === '1' || t === '0' || t === '5')).toBe(false)
  })

  test('khử trùng case-insensitive (WilsonCI ≡ wilsonci)', () => {
    const ev = [
      { kind: 'tool', tool: 't', success: true, text: 'WilsonCI xuất hiện' },
      { kind: 'tool', tool: 't', success: true, text: 'wIlSoNcI xuất hiện lần nữa' },
    ]
    const toks = extractEvidenceTokens(ev)
    expect(toks.filter(t => t.toLowerCase() === 'wilsonci')).toHaveLength(1)
  })

  test('cap 60 token — evidence dài không phình chi phí gate', () => {
    const ev = Array.from({ length: 200 }, (_, i) => ({
      kind: 'tool' as const, tool: 't', success: true, text: `tokenSố${100 + i} và path${i}/file${i}`,
    }))
    expect(extractEvidenceTokens(ev).length).toBeLessThanOrEqual(60)
  })

  test('evidence rỗng / text rỗng → []', () => {
    expect(extractEvidenceTokens([])).toEqual([])
    expect(extractEvidenceTokens([{ kind: 'tool', tool: 't', text: '   ' }])).toEqual([])
  })
})

// ==================== B. checkDigestGate ====================

describe('r77 · P3-M4 checkDigestGate — evidence-coverage gate (0.7)', () => {
  // 8 token chuẩn (đếm tay): parseEvalVerdict, WilsonCI, raw_confidence,
  // goal-loop, src/lib/db, 722, 0.55, 4000
  const evidence = [
    { kind: 'tool', tool: 'shell', success: true, text: 'chạy parseEvalVerdict với WilsonCI' },
    { kind: 'tool', tool: 'grep', success: true, text: 'tìm raw_confidence trong goal-loop' },
    { kind: 'tool', tool: 'shell', success: true, text: 'đọc src/lib/db, đếm 722 dòng' },
    { kind: 'tool', tool: 'shell', success: true, text: 'kết quả 0.55 và chỉ số 4000' },
  ]

  test('digest giữ HẾT 8 token → coverage 1, pass', () => {
    const digest = 'Đã chạy parseEvalVerdict, WilsonCI, raw_confidence, goal-loop, đọc src/lib/db — 722 dòng, kết quả 0.55, chỉ số 4000, đầy đủ.'
    const g = checkDigestGate(digest, evidence)
    expect(g.tokens).toBe(8)
    expect(g.found).toBe(8)
    expect(g.coverage).toBe(1)
    expect(g.passed).toBe(true)
  })

  test('BLUEPRINT: digest bỏ HẾT số liệu + danh từ → coverage 0 → fail', () => {
    const digest = 'Đã làm xong toàn bộ công việc một cách trọn vẹn, không còn gì phải làm thêm.'
    const g = checkDigestGate(digest, evidence)
    expect(g.coverage).toBe(0)
    expect(g.passed).toBe(false)
    expect(g.missing.length).toBe(5) // cap hiển thị 5
  })

  test('tính tay 6/8 → coverage 0.75 → PASS', () => {
    const digest = 'Giữ: parseEvalVerdict, WilsonCI, raw_confidence, goal-loop, src/lib/db, 722.'
    const g = checkDigestGate(digest, evidence)
    expect(g.found).toBe(6)
    expect(g.coverage).toBeCloseTo(0.75, 12)
    expect(g.passed).toBe(true)
  })

  test('tính tay 5/8 → coverage 0.625 → FAIL', () => {
    const digest = 'Giữ: parseEvalVerdict, WilsonCI, raw_confidence, goal-loop, src/lib/db.'
    const g = checkDigestGate(digest, evidence)
    expect(g.found).toBe(5)
    expect(g.coverage).toBeCloseTo(0.625, 12)
    expect(g.passed).toBe(false)
  })

  test('BIÊN CHÍNH XÁC 0.7 (10 token giữ đúng 7) → PASS vì ngưỡng là ≥', () => {
    // Fixture 10 token snake định danh riêng để đếm tay sạch: rep000..rep009
    const ev = Array.from({ length: 10 }, (_, i) => ({
      kind: 'tool' as const, tool: 't', success: true, text: `bước rep_${String(i).padStart(3, '0')} xong`,
    }))
    // digest giữ đúng rep_000..rep_006 (7/10 = 0.7)
    const digest = Array.from({ length: 7 }, (_, i) => `rep_${String(i).padStart(3, '0')}`).join(' ') + ' — giữ lại'
    const g = checkDigestGate(digest, ev)
    expect(g.tokens).toBe(10)
    expect(g.found).toBe(7)
    expect(g.coverage).toBeCloseTo(0.7, 12)
    expect(g.passed).toBe(true) // 0.7 ≥ 0.7 — ngưỡng là ≥ (không phải >)
  })

  test('matching case-insensitive (WilsonCI khớp wilsonci)', () => {
    const g = checkDigestGate('đã xem wilsonci và 722', [{ kind: 'tool', tool: 't', text: 'WilsonCI 722' }])
    expect(g.coverage).toBe(1)
    expect(g.passed).toBe(true)
  })

  test('evidence không token đo được → gate TỰ QUA (không có gì để mất)', () => {
    const g = checkDigestGate('digest bất kỳ', [{ kind: 'directive', text: 'làm việc bình thường thôi' }])
    expect(g.tokens).toBe(0)
    expect(g.passed).toBe(true)
    expect(g.coverage).toBe(1)
  })

  test('hằng số ngưỡng mặc định 0.7 (spec §P3-M4)', () => {
    expect(DIGEST_EVIDENCE_COVERAGE_MIN).toBe(0.7)
    expect(SUMMARY_ROUGE_RECALL_MIN).toBe(0.3)
  })
})

// ==================== C. compressConversation (mock LLM) ====================

/** Dựng message array đủ lớn để qua ngưỡng nén (≥50k chars, ≥4 message nén được) */
function bigMessages(): Array<{ role: string; content: string }> {
  const filler = 'nội dung làm việc bình thường không có định danh kỹ thuật gì hết '.repeat(50)
  return Array.from({ length: 24 }, (_, i) => ({
    role: i % 2 === 0 ? 'assistant' : 'user',
    content: filler,
  }))
}

const evidenceWithTokens = [
  { kind: 'tool' as const, tool: 'shell', success: true, text: 'chạy parseEvalVerdict với WilsonCI xong, 722 test' },
  { kind: 'tool' as const, tool: 'grep', success: true, text: 'raw_confidence trong src/lib/db OK' },
]

describe('r77 · P3-M4 compressConversation — gate trong flow thật (mock LLM)', () => {
  beforeAll(async () => {
    await db.digestGateEvent.deleteMany({})
    llmImpl = async () => ({ content: '', tokensUsed: 0 }) // mặc định — từng test ghi đè
  })

  test('LLM digest GIỮ dẫn chứng → method llm + event pass', async () => {
    let seen = 0
    llmImpl = async () => {
      seen++
      return {
        content: `Công việc đã xong: chạy parseEvalVerdict với WilsonCI — 722 test pass, raw_confidence đọc từ src/lib/db OK. ${'tóm tắt thêm '.repeat(10)}`,
        tokensUsed: 100,
      }
    }
    const messages = bigMessages()
    const res = await compressConversation({ messages, protectedStartIndex: 0, keepRecent: 4, evidence: evidenceWithTokens })
    expect(seen).toBe(1)
    expect(res).not.toBeNull()
    expect(res!.method).toBe('llm')
    expect(res!.digest).toContain('parseEvalVerdict')
    const n = await waitForCount(
      () => db.digestGateEvent.count({ where: { kind: 'compression', outcome: 'pass' } }),
      c => c >= 1,
    )
    expect(n).toBeGreaterThanOrEqual(1)
  })

  test('BLUEPRINT: LLM digest BỎ HẾT số liệu → fallback heuristic + event fallback', async () => {
    await db.digestGateEvent.deleteMany({})
    llmImpl = async () => ({
      content: `Công việc đã hoàn thành trọn vẹn, mọi thứ đều ổn và không cần làm gì thêm. ${'diễn giải chung chung '.repeat(10)}`,
      tokensUsed: 100,
    })
    const messages = bigMessages()
    const res = await compressConversation({ messages, protectedStartIndex: 0, keepRecent: 4, evidence: evidenceWithTokens })
    expect(res).not.toBeNull()
    expect(res!.method).toBe('heuristic') // gate ép fallback
    // digest heuristic chứa dòng evidence gốc — dẫn chứng được bảo toàn
    expect(res!.digest).toContain('[shell] ✓')
    expect(res!.digest).toContain('parseEvalVerdict')
    const n = await waitForCount(
      () => db.digestGateEvent.count({ where: { kind: 'compression', outcome: 'fallback' } }),
      c => c >= 1,
    )
    expect(n).toBeGreaterThanOrEqual(1)
  })

  test('LLM throw → heuristic như cũ (hành vi không đổi vì gate)', async () => {
    llmImpl = async () => { throw new Error('utility core chết') }
    const messages = bigMessages()
    const res = await compressConversation({ messages, protectedStartIndex: 0, keepRecent: 4, evidence: evidenceWithTokens })
    expect(res).not.toBeNull()
    expect(res!.method).toBe('heuristic') // đường fallback cũ
    expect(res!.digest).toContain('[shell] ✓')
  })

  test('evidence RỖNG + LLM tốt → gate tự qua, giữ llm (goal-loop precedent)', async () => {
    llmImpl = async () => ({ content: `Digest văn xuôi không có gì đo được cả. ${'nội dung '.repeat(20)}`, tokensUsed: 50 })
    const messages = bigMessages()
    const res = await compressConversation({ messages, protectedStartIndex: 0, keepRecent: 4, evidence: [] })
    expect(res).not.toBeNull()
    expect(res!.method).toBe('llm') // không token → gate tự qua — KHÔNG ép fallback oan
  })

  test('evidence RỖNG + LLM hỏng → return null (hành vi cũ bảo toàn)', async () => {
    llmImpl = async () => { throw new Error('chết') }
    const messages = bigMessages()
    const res = await compressConversation({ messages, protectedStartIndex: 0, keepRecent: 4, evidence: [] })
    expect(res).toBeNull() // heuristic rỗng → null — đúng hành vi trước P3-M4
  })
})

// ==================== D. summarizeMemories (mock LLM) ====================

const memories = [
  'Agent phải chạy bun test qua env -u DATABASE_URL để không đụng DB production',
  'Chạy bun test với env -u DATABASE_URL tránh ghi nhầm vào DB production',
  'Nhớ chạy bun test env -u DATABASE_URL vì DB production không được phép ghi',
]

describe('r77 · P3-M4 summarizeMemories — ROUGE-L recall gate (0.3)', () => {
  test('summary giữ chủ đề (gần bản sao mẫu 1) → NHẬN', async () => {
    // union mẫu đại diện = mẫu 1 + mẫu 3 (28 token): summary 12 token là
    // subsequence của mẫu 1 → LCS 12 → recall 12/28 ≈ 0.43 ≥ 0.3
    llmImpl = async () => ({ content: 'Chạy bun test qua env -u DATABASE_URL để không đụng DB production', tokensUsed: 50 })
    const out = await summarizeMemories(memories)
    expect(out).toBe('Chạy bun test qua env -u DATABASE_URL để không đụng DB production')
  })

  test('BLUEPRINT: summary chệch chủ đề (recall thấp) → fallback batch[0] + event', async () => {
    await db.digestGateEvent.deleteMany({})
    llmImpl = async () => ({ content: 'Hệ thống đã hoàn thành toàn bộ công việc được giao một cách xuất sắc', tokensUsed: 50 })
    const out = await summarizeMemories(memories)
    expect(out).toBe(memories[0]) // fallback giữ mẫu đầu — bằng chứng mất = 0
    const n = await waitForCount(
      () => db.digestGateEvent.count({ where: { kind: 'summarization', outcome: 'fallback' } }),
      c => c >= 1,
    )
    expect(n).toBeGreaterThanOrEqual(1)
  })

  test('sanity cũ giữ: summary dài hơn input → batch[0]', async () => {
    llmImpl = async () => ({ content: memories.join(' ') + ' thêm chữ cho dài', tokensUsed: 50 })
    const out = await summarizeMemories(['a', 'b'])
    expect(out).toBe('a')
  })

  test('sanity cũ giữ: <2 mẫu → null (không gọi LLM)', async () => {
    let called = 0
    llmImpl = async () => { called++; return { content: 'x', tokensUsed: 0 } }
    expect(await summarizeMemories(['một mình'])).toBeNull()
    expect(await summarizeMemories([])).toBeNull()
    expect(called).toBe(0)
  })

  test('sanity cũ giữ: LLM trả rỗng → null', async () => {
    llmImpl = async () => ({ content: '   ', tokensUsed: 0 })
    expect(await summarizeMemories(memories)).toBeNull()
  })
})

// ==================== E. KPI digest_gate_fallback_rate ====================

describe('r77 · P3-M4 KPI digest_gate_fallback_rate — compute từ DigestGateEvent', () => {
  test('seed 3 pass + 1 fallback → value 0.25, meta đủ số liệu', async () => {
    await db.digestGateEvent.deleteMany({})
    await db.digestGateEvent.create({ data: { kind: 'compression', outcome: 'pass', coverage: 0.9, method: 'llm' } })
    await db.digestGateEvent.create({ data: { kind: 'compression', outcome: 'pass', coverage: 1.0, method: 'llm' } })
    await db.digestGateEvent.create({ data: { kind: 'summarization', outcome: 'pass', rougeRecall: 0.4, method: 'llm' } })
    await db.digestGateEvent.create({ data: { kind: 'compression', outcome: 'fallback', coverage: 0.2, method: 'heuristic' } })

    const def = KPI_REGISTRY.find(k => k.key === 'digest_gate_fallback_rate')
    expect(def).toBeDefined()
    const res = await def!.compute()
    expect(res.value).toBeCloseTo(0.25, 12) // 1/4
    expect(res.n).toBe(4)
    expect(res.meta).toMatchObject({ fallback: 1, total: 4, compression: 3, summarization: 1 })
  })

  test('total 0 → value 0 (không chia 0)', async () => {
    await db.digestGateEvent.deleteMany({})
    const def = KPI_REGISTRY.find(k => k.key === 'digest_gate_fallback_rate')!
    const res = await def!.compute()
    expect(res.value).toBe(0)
    expect(res.n).toBe(0)
  })

  test('dọn bảng sau test', async () => {
    await db.digestGateEvent.deleteMany({})
  })
})

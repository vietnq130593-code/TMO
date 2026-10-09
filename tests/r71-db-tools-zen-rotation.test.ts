// ============================================================================
// r71 — TEST CHO CÁC FIX ROUND-71 (Bug_v2.md — audit theo directive user)
//
// 3 câu hỏi user dẫn tới fix (bằng chứng trong Bug_v2.md ROUND-71):
//   - BUG2-019: knowledge_write gate chỉ CATALYST → mission không gọi
//     CATALYST thì 0 bài học ghi KB trong quá trình thực thi.
//   - BUG2-020: key Zen #1 429 FreeUsageLimitError giết cả call + delegation
//     dù key #2/#3 khỏe (không xoay key trong call + binding không thoát
//     được key chết + FreeUsageLimit bị coi transient 60s).
//   - BUG2-021: data_map có tool nhưng 0 whitelist chứa → mọi agent gọi bị
//     chặn (hồi quy r67 — mâu thuẫn prompt vs enforcement).
//   - BUG2-022: không có tool tra cứu bài học/episode/trí nhớ on-demand.
//
// Mọi test bắt từ bằng chứng quan sát thật (dev.log 17:23-17:31Z r70:
// "Zen 429 rate-limited (key #1) — FreeUsageLimitError"; 2 delegation chết
// nhãn error; delegation observed: SENTINEL/RAMPAGE/MEGATRON/Linh Sickyx/
// ALISTA — không có CATALYST).
// ============================================================================

// Ép DB đúng của tmo-app — chống shell DATABASE_URL nhiễm path my-project.
// KHI test cô lập (tests/db-isolation-preload.ts) thì PHẢI GIỮ NGUYÊN.
if (process.env.TMO_TEST_DB_ISOLATED !== '1') {
  process.env.DATABASE_URL = 'file:/home/z/tmo-app/db/custom.db'
}

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'

import { classifyZen429Body, pickHealthyZenKeyIndex, boundZenKeyUsable, zen429CooldownFor } from '../src/lib/llm'
import { delegationLessonWorthy, digestDelegationReport, DEFAULT_SUBAGENT_TOOLS, POSITION_BY_NAME, resolveDelegationTarget, DELEGATABLE_AGENTS } from '../src/lib/subagent-delegate'
import { CODE_TEAM_AGENTS } from '../src/lib/code-team/agents'
import { STANDALONE_AGENTS } from '../src/lib/standalone-agents'
import { lessonsSearch } from '../src/lib/lessons-search'
import { db } from '../src/lib/db'

// ==================== BUG2-020 — Zen 429 xoay key ====================

describe('r71 BUG2-020d — phân loại body 429 (bằng chứng r70: "FreeUsageLimitError" kéo dài ≥8 phút)', () => {
  test('body FreeUsageLimitError → free_usage (cooldown dài — không còn coi transient 60s)', () => {
    expect(classifyZen429Body('{"error":{"type":"FreeUsageLimitError","message":"Free usage limit exceeded"}}')).toBe('free_usage')
  })
  test('các biến thể "free usage limit" / "usage limit" / "daily quota" → free_usage', () => {
    expect(classifyZen429Body('free usage limit exceeded')).toBe('free_usage')
    expect(classifyZen429Body('Usage Limit for today reached')).toBe('free_usage')
    expect(classifyZen429Body('daily quota exhausted')).toBe('free_usage')
  })
  test('429 RPM thường (body không nhắc usage/free) → rpm', () => {
    expect(classifyZen429Body('{"error":{"message":"Too many requests"}}')).toBe('rpm')
    expect(classifyZen429Body('rate limited try again later')).toBe('rpm')
  })
  test('cooldown áp dụng: free_usage ≥ 10× rpm (mặc định 15 phút vs 60 giây)', () => {
    const fu = zen429CooldownFor('FreeUsageLimitError')
    const rpm = zen429CooldownFor('Too many requests')
    expect(fu).toBeGreaterThanOrEqual(rpm * 10)
    expect(fu).toBeGreaterThanOrEqual(900_000) // ≥ 15 phút
  })
})

describe('r71 BUG2-020a — pickHealthyZenKeyIndex: chọn key sạch kế tiếp (không fail-open trả key chết)', () => {
  const NOW = 1_000_000
  test('key #1 429, key #2/#3 khỏe → chọn key #2 (chính là kịch bản r70 mà hệ thống cũ chết)', () => {
    const cooldowns = [NOW + 60_000, 0, 0] // key #1 (index 0) đang cooldown
    const pick = pickHealthyZenKeyIndex(cooldowns, NOW, 0, [])
    expect(pick.index).toBe(1)
    expect(pick.next).toBe(2)
  })
  test('TẤT CẢ key đều cooldown → index -1 (không bao giờ trả key chết)', () => {
    const cooldowns = [NOW + 60_000, NOW + 60_000, NOW + 60_000]
    expect(pickHealthyZenKeyIndex(cooldowns, NOW, 0, []).index).toBe(-1)
  })
  test('cooldown hết hạn (timestamp ≤ now) → key được coi là sạch lại', () => {
    const cooldowns = [NOW - 1, 0, 0] // key #1 vừa hết cooldown
    expect(pickHealthyZenKeyIndex(cooldowns, NOW, 0, []).index).toBe(0)
  })
  test('lượt 1 né key bị sub-agent ghim; hết key riêng → lượt 2 chia sẻ key khỏe', () => {
    // key #2 bị ghim bởi sub-agent khác, key #1/#3 khỏe → con trỏ 0 chọn #1;
    // key #1 cooldown + key #2 ghim → chọn #3; chỉ còn key #2 (đang ghim)
    // khỏe → lượt 2 vẫn chọn #2 (chia sẻ còn hơn chết chờ).
    expect(pickHealthyZenKeyIndex([0, 0, 0], NOW, 0, [1]).index).toBe(0)
    expect(pickHealthyZenKeyIndex([NOW + 60_000, 0, 0], NOW, 0, [1]).index).toBe(2)
    expect(pickHealthyZenKeyIndex([NOW + 60_000, 0, NOW + 60_000], NOW, 0, [1]).index).toBe(1)
  })
  test('pool rỗng → index -1 (không crash)', () => {
    expect(pickHealthyZenKeyIndex([], NOW, 0, []).index).toBe(-1)
  })
})

describe('r71 BUG2-020c — boundZenKeyUsable: sub-agent ghim key 429 phải thoát ghim', () => {
  const NOW = 2_000_000
  test('key ghim đang cooldown → KHÔNG dùng được (đúng thuốc cho xác zombie delegation r70)', () => {
    expect(boundZenKeyUsable(0, [NOW + 900_000, 0, 0], NOW)).toBe(false)
  })
  test('key ghim hết cooldown → dùng lại bình thường (ghim chỉ tạm rời khi key chết)', () => {
    expect(boundZenKeyUsable(0, [NOW - 1, 0, 0], NOW)).toBe(true)
  })
  test('index ghim rác (null/âm/vượt pool) → false an toàn', () => {
    expect(boundZenKeyUsable(null, [0, 0, 0], NOW)).toBe(false)
    expect(boundZenKeyUsable(-1, [0, 0, 0], NOW)).toBe(false)
    expect(boundZenKeyUsable(99, [0, 0, 0], NOW)).toBe(false)
  })
})

// ==================== BUG2-019 — knowledge_write mở cho mọi agents ====================

describe('r71 BUG2-019 — knowledge_write có trong whitelist MỌI agents thực thi (bỏ gate chỉ-CATALYST)', () => {
  test('cả 5 Code Team agents đều có knowledge_write (trước r71 chỉ CATALYST)', () => {
    for (const def of CODE_TEAM_AGENTS) {
      expect(def.tools).toContain('knowledge_write')
    }
  })
  test('CATALYST vẫn có (không mất quyền cũ) + FORGE full-stack có (standalone — user directive 2026-10-09)', () => {
    const catalyst = CODE_TEAM_AGENTS.find(a => a.name === 'CATALYST')
    expect(catalyst?.tools).toContain('knowledge_write')
    // FORGE đã tách khỏi Code Team → def sống ở STANDALONE_AGENTS (team=null,
    // position=null) — KHÔNG còn trong CODE_TEAM_AGENTS.
    expect(CODE_TEAM_AGENTS.find(a => a.name === 'FORGE')).toBeUndefined()
    const forge = STANDALONE_AGENTS.find(a => a.name === 'FORGE')
    expect(forge?.tools).toContain('knowledge_write')
    expect(forge?.team).toBeNull()
    expect(forge?.position).toBeNull()
    // FORGE không rơi POSITION_BY_NAME của Code Team nữa (resolve by-name DB-first)
    expect(POSITION_BY_NAME['FORGE']).toBeUndefined()
    expect(resolveDelegationTarget('FORGE')).toBeNull()
    // Nhưng vẫn là đích delegate hợp lệ trong DELEGATABLE_AGENTS (guidance)
    expect(DELEGATABLE_AGENTS.some(a => a.name === 'FORGE')).toBe(true)
  })
  test('ALISTA + Linh Sickyx (standalone) có knowledge_write', () => {
    const alista = STANDALONE_AGENTS.find(a => a.name === 'ALISTA')
    const linh = STANDALONE_AGENTS.find(a => a.name === 'Linh Sickyx')
    expect(alista?.tools).toContain('knowledge_write')
    expect(linh?.tools).toContain('knowledge_write')
  })
  test('DEFAULT_SUBAGENT_TOOLS (agent custom không khai báo) có đủ 3 tool DB r71', () => {
    expect(DEFAULT_SUBAGENT_TOOLS).toContain('knowledge_write')
    expect(DEFAULT_SUBAGENT_TOOLS).toContain('data_map')
    expect(DEFAULT_SUBAGENT_TOOLS).toContain('lessons_search')
  })
})

// ==================== BUG2-021 — data_map vào whitelist (hết hồi quy r67) ====================

describe('r71 BUG2-021 — data_map + lessons_search có trong whitelist mọi agents (tool hết bị chặn oan)', () => {
  test('mọi Code Team agents (5 — FORGE đã tách 2026-10-09) có data_map + lessons_search + FORGE standalone vẫn có', () => {
    for (const def of CODE_TEAM_AGENTS) {
      expect(def.tools).toContain('data_map')
      expect(def.tools).toContain('lessons_search')
    }
    const forge = STANDALONE_AGENTS.find(a => a.name === 'FORGE')
    expect(forge?.tools).toContain('data_map')
    expect(forge?.tools).toContain('lessons_search')
  })
  test('Omega (mission TL) có data_map + lessons_search — prompt dạy "gọi data_map bất cứ lúc nào" giờ THÔNG THẬT', () => {
    const omega = STANDALONE_AGENTS.find(a => a.name === 'Omega')
    expect(omega?.tools).toContain('data_map')
    expect(omega?.tools).toContain('lessons_search')
  })
})

// ==================== BUG2-019 — harvest bài học delegation (hardcode) ====================

describe('r71 BUG2-019 — delegationLessonWorthy: tín hiệu đáng học (chống spam KB + không bỏ sót)', () => {
  test('delegation SẠCH tuyệt đối (0 lỗi tool + concluded + báo cáo không nhắc bài học) → KHÔNG ghi (chống spam)', () => {
    expect(delegationLessonWorthy({ toolFailures: 0, endedBy: 'concluded', report: 'ĐÃ LÀM: mọi việc xong.' })).toBe(false)
  })
  test('delegation có lỗi tool → đáng học (bằng chứng r70: SENTINEL/RAMPAGE crash giữa chừng)', () => {
    expect(delegationLessonWorthy({ toolFailures: 3, endedBy: 'concluded', report: 'xong' })).toBe(true)
  })
  test('kết thúc bất thường (error/timeout/stall_brake/token_budget/iteration_limit) → đáng học', () => {
    for (const endedBy of ['error', 'timeout', 'stall_brake', 'token_budget', 'iteration_limit']) {
      expect(delegationLessonWorthy({ toolFailures: 0, endedBy, report: '' })).toBe(true)
    }
  })
  test('báo cáo có mục "Bài học" → đáng học kể cả khi kết thúc sạch', () => {
    expect(delegationLessonWorthy({ toolFailures: 0, endedBy: 'concluded', report: '1. ĐÃ LÀM...\nBài học:\nnên grep trước khi sửa' })).toBe(true)
  })
  test('cancelled → KHÔNG đáng học (delegation bị huỷ không sinh tri thức)', () => {
    expect(delegationLessonWorthy({ toolFailures: 0, endedBy: 'cancelled', report: '' })).toBe(false)
  })
})

describe('r71 BUG2-019 — digestDelegationReport: Ưu tiên mục Bài học của báo cáo wrap-up (phần 5 mới)', () => {
  test('báo cáo có mục "Bài học" → digest LẤY đúng phần đó (không phải đầu báo cáo)', () => {
    const report = [
      '1. ĐÃ LÀM: đọc file, chạy lint pass.',
      '2. KẾ HOẠCH: 3/3 completed.',
      'Bài học:',
      'Zen 429 cần xoay key trong cùng call — đụng key khác ngay thay vì chết cả chuỗi.',
    ].join('\n')
    const digest = digestDelegationReport(report)
    expect(digest).toContain('xoay key')
    expect(digest).not.toContain('chạy lint pass')
  })
  test('báo cáo KHÔNG có mục bài học → digest lấy đầu báo cáo', () => {
    const digest = digestDelegationReport('Tổng kết: đã fix xong 3 file, gate pass.')
    expect(digest).toContain('đã fix xong 3 file')
  })
  test('báo cáo dài > 700 chars → digest cắt + ghi rõ độ dài gốc (không đốt KB)', () => {
    const long = 'A'.repeat(2000)
    const digest = digestDelegationReport(long)
    expect(digest.length).toBeLessThan(760)
    expect(digest).toContain('2000 chars gốc')
  })
  test('báo cáo rỗng → placeholder rõ ràng (không ghi chuỗi rỗng vào KB)', () => {
    expect(digestDelegationReport('')).toBe('(không có báo cáo)')
  })
})

// ==================== BUG2-022 — lessons_search (tool tra cứu on-demand) ====================

describe('r71 BUG2-022 — lessons_search: tra 3 kho bộ não DB theo từ khoá', () => {
  const LESSON_ID = 'test-r71-lesson'
  const EPISODE_ID = 'test-r71-episode'
  const MEMORY_ID = 'test-r71-memory'

  beforeAll(async () => {
    // Fixture từ BỐI CẢNH r70 thật: bài học về Zen 429 xoay key
    await db.lessonRecord.upsert({
      where: { id: LESSON_ID },
      create: {
        id: LESSON_ID,
        statement: 'Khi Zen trả 429 ở 1 key, xoay sang key kế trong cùng call thay vì chết cả chuỗi',
        triggerCondition: 'khi gặp Zen 429 rate-limited',
        appliesTo: JSON.stringify(['llm', 'zen', 'provider']),
        rootCause: 'REASONING_ERROR',
        source: 'SELF_DERIVED',
        confidence: 0.9,
        timesValidated: 2,
        needsReview: false,
      },
      update: { statement: 'Khi Zen trả 429 ở 1 key, xoay sang key kế trong cùng call thay vì chết cả chuỗi' },
    })
    await db.episodeRecord.upsert({
      where: { id: EPISODE_ID },
      create: {
        id: EPISODE_ID,
        title: 'Mission r70 — provider 429 giết 2 delegation',
        goal: 'Khắc phục sự cố provider Zen 429 FreeUsageLimitError',
        contextSummary: 'Delegation chết vì key ghim không thoát được 429',
        outcome: 'PARTIAL',
        confidence: 0.6,
        agent: 'SENTINEL',
      },
      update: { title: 'Mission r70 — provider 429 giết 2 delegation' },
    })
    await db.agentMemory.upsert({
      where: { id: MEMORY_ID },
      create: {
        id: MEMORY_ID,
        agentId: 'test-agent-r71',
        agentName: 'SENTINEL',
        category: 'insight',
        content: 'Zen 429 FreeUsageLimitError cần cooldown dài hơn 60s — hạn mức free usage không reset trong 1 phút',
        importance: 0.8,
        domain: 'work',
      },
      update: { content: 'Zen 429 FreeUsageLimitError cần cooldown dài hơn 60s — hạn mức free usage không reset trong 1 phút' },
    })
  })

  afterAll(async () => {
    await db.lessonRecord.deleteMany({ where: { id: LESSON_ID } }).catch(() => {})
    await db.episodeRecord.deleteMany({ where: { id: EPISODE_ID } }).catch(() => {})
    await db.agentMemory.deleteMany({ where: { id: MEMORY_ID } }).catch(() => {})
  })

  test('query "429" trúng CẢ 3 kho (lesson + episode + memory) — đúng kịch bản r70', async () => {
    const res = await lessonsSearch({ query: '429' })
    expect(res.success).toBe(true)
    expect(res.lessons.length).toBeGreaterThanOrEqual(1)
    expect(res.episodes.length).toBeGreaterThanOrEqual(1)
    expect(res.memories.length).toBeGreaterThanOrEqual(1)
    expect(res.lessons.some(l => l.id === LESSON_ID)).toBe(true)
    expect(res.episodes.some(e => e.id === EPISODE_ID)).toBe(true)
    expect(res.memories.some(m => m.id === MEMORY_ID)).toBe(true)
    expect(res.total).toBeGreaterThanOrEqual(3)
  })

  test('lọc agent="SENTINEL" chỉ giữ episode/memory của agent đó (lesson không lọc theo agent — học chéo)', async () => {
    const res = await lessonsSearch({ query: '429', agent: 'SENTINEL' })
    expect(res.agentFilter).toBe('SENTINEL')
    expect(res.episodes.every(e => e.agent.includes('SENTINEL'))).toBe(true)
    expect(res.memories.every(m => m.agentName.includes('SENTINEL'))).toBe(true)
  })

  test('query ngắn hơn 2 ký tự → hint hướng dẫn, không quét DB oan', async () => {
    const res = await lessonsSearch({ query: '4' })
    expect(res.total).toBe(0)
    expect(res.hint).toContain('2 ký tự')
  })

  test('wildcard LIKE (%/_) bị strip — truy vấn theo ý gọi, không pattern-match tự do', async () => {
    const res = await lessonsSearch({ query: '4%%29' })
    // '4  29' sau strip — không match gì cả (an toàn), KHÔNG throw
    expect(res.success).toBe(true)
  })

  test('query không khớp kho nào → hint gợi ý từ khoá khác (fail-open có hướng dẫn)', async () => {
    const res = await lessonsSearch({ query: 'zzzz-khong-ton-tai' })
    expect(res.total).toBe(0)
    expect(res.hint).toContain('thử từ khoá khác')
  })
})

// ==================== TÍCH HỢP — tool defs đăng ký đúng ====================

describe('r71 — cap bản đồ dữ liệu: vòng cắt THẬT SỰ đảm bảo ≤ maxChars (test r67 bắt hồi quy khi keyword mới tăng số vùng khớp)', () => {
  test('query khớp nhiều vùng (todo + bài học + trí nhớ + token) → block vẫn ≤ 1600 chars', async () => {
    const { buildDataMapBlock } = await import('../src/lib/data-map')
    const block = buildDataMapBlock('Đối chiếu todo dở và lưu bài học run vào trí nhớ, tra số liệu token đã tiêu hao')
    expect(block).toContain('BẢN ĐỒ DỮ LIỆU')
    expect(block.length).toBeLessThanOrEqual(1600)
  })
  test('keyword mới r71: "ghi bài học vào kb" giờ route được (trước đó 0-match)', async () => {
    const { routeDataMap } = await import('../src/lib/data-map')
    const { writes } = routeDataMap('ghi bài học vào kb')
    expect(writes.map(w => w.region.id)).toContain('knowledge_graph')
  })
})

describe('r71 — đăng ký tool lessons_search ở executor + parser (không còn "tool mồ côi")', () => {
  test('ALL_TOOL_DEFINITIONS có lessons_search + data_map + knowledge_write (getToolDefinitions build được)', async () => {
    const mod = await import('../src/lib/code-team/tool-executor')
    const defs = mod.getToolDefinitions(['lessons_search', 'data_map', 'knowledge_write'])
    expect(defs).toHaveLength(3)
    expect(defs.map(d => d.function.name).sort()).toEqual(['data_map', 'knowledge_write', 'lessons_search'])
  })
  test('mô tả knowledge_write KHÔNG còn dạy "chỉ CATALYST" (sửa kiến trúc sai ở mô tả)', async () => {
    const mod = await import('../src/lib/code-team/tool-executor')
    const defs = mod.getToolDefinitions(['knowledge_write'])
    expect(defs[0].function.description).not.toContain('CATALYST')
    expect(defs[0].function.description).toContain('MỌI agents')
  })
})

/**
 * R123 TESTS — FIXBUG ĐỢT REQ-AUDIT (4 nguồn request lãng phí) — VÒNG R1
 * (giao thức fixbug.md mục 4/C5: MỖI fix ≥ 1 test case chứng minh lỗi cũ đã hết)
 *
 * Phạm vi regression — 4 fix theo báo cáo REQ-AUDIT-1 (đo live 90s ~17 req/phút
 * + composition 3h ~1.900 request trên dev.log):
 *   A. FIX1 (source-scan — precedent r95-H/r103-F) — 24 điểm setInterval poll
 *      nền được gate `document.hidden`: trước fix chỉ 4 file có gate một phần
 *      (page.tsx, brain-stage, code-tab, smolab-module); 13 file component với
 *      24 điểm poll 10s-60s KHÔNG gate → tab trình duyệt ẩn vẫn request liên
 *      tục (đo thực: ~17 req/phút khi user rời tab).
 *   B. FIX2 (source-scan + unit) — 7 route nóng nhất bảng (ngoài agent-run/todos
 *      đã có sẵn) được withPollCache: oc|status · ag| · ocs|list · br| · na| ·
 *      glj| · opa|. Mutation (POST/PUT/PATCH/DELETE) invalidatePollCache ngay —
 *      không bị cache cũ giấu dữ liệu vừa đổi. Unit hành vi: hit/miss TTL +
 *      invalidate thật (bản trước KHÔNG có hàm invalidate — cache cũ phải đợi
 *      hết TTL sau mutation).
 *   C. FIX3 — HTTP Watchdog (instrumentation) probe đổi /api/goal-loop-jobs →
 *      /api/health. Trước fix: goal-loop-jobs 262/3h đứng đầu bảng request —
 *      đa số là watchdog 60s/lần dùng đúng endpoint UI poll.
 *   D. FIX4 — home stats 10s → 30s: /api/query?action=stats là round-trip Neo4j
 *      AuraDB CLOUD — 10s cho panel thống kê là quá dày (giảm 66% khi tab hiện).
 *
 * Không đụng DB sống — source-scan + unit thuần (Response trong Bun runtime).
 * Các cặp guard-đã-có-sẵn (brain-tab, neural-architecture-section) cũng được
 * assert (chống ai đó gỡ visibilitychange khi dọn code).
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { withPollCache, invalidatePollCache } from '@/lib/poll-microcache'

const read = (p: string): string => readFileSync(p, 'utf8')

// ============ A. FIX1 — 24 điểm poll nền được gate document.hidden ============

describe('R123 A · FIX1 — hidden gate cho poll nền (13 file / 24 điểm)', () => {
  const fix1Files: Array<[string, number]> = [
    // [file, số điểm gate REQ-AUDIT FIX1 kỳ vọng trong file]
    ['src/components/analytics/runtime-metrics-panel.tsx', 2],
    ['src/components/analytics/episodic-memory-panel.tsx', 2],
    ['src/components/analytics/debt-ledger-panel.tsx', 1],
    ['src/components/database/analytics-section.tsx', 2],
    ['src/components/database/auto-learn-section.tsx', 1],
    ['src/components/self-direction/self-direction-module.tsx', 1],
    ['src/components/smolab/knowledge-tab.tsx', 1],
    ['src/components/smolab/learning-tab.tsx', 4],
    ['src/components/smolab/skills-tab.tsx', 1],
    ['src/components/smolab/channels-tab.tsx', 1],
    ['src/components/smolab/automation-tab.tsx', 1],
    ['src/components/smolab/code-tab.tsx', 3],
    ['src/components/smolab/smolab-module.tsx', 3],
  ]
  for (const [file, expected] of fix1Files) {
    test(`${file}: ${expected} điểm gate + document.hidden`, () => {
      const src = read(file)
      const markers = src.match(/REQ-AUDIT FIX1/g) ?? []
      expect(markers.length).toBe(expected)
      expect(src).toContain('document.hidden')
    })
  }
  test('page.tsx: 3 điểm FIX1 (token fallback + recovery + docRefresh) + FIX4', () => {
    const src = read('src/app/page.tsx')
    const markers = src.match(/REQ-AUDIT FIX1/g) ?? []
    expect(markers.length).toBe(3)
    expect(src).toContain('document.hidden')
  })
  test('guard có sẵn không bị gỡ: brain-tab + neural-architecture-section (visibilitychange)', () => {
    expect(read('src/components/smolab/brain-tab.tsx')).toContain("document.visibilityState === 'hidden'")
    expect(read('src/components/database/neural-architecture-section.tsx')).toContain("document.visibilityState === 'hidden'")
  })
})

// ============ B. FIX2 — micro-cache 7 route + invalidate khi mutation ============

describe('R123 B · FIX2 — withPollCache 7 route nóng + invalidatePollCache', () => {
  test('poll-microcache xuất invalidatePollCache (bản trước KHÔNG có)', () => {
    const src = read('src/lib/poll-microcache.ts')
    expect(src).toContain('export function invalidatePollCache')
  })
  test('openclaw/status: wrapper oc|status TTL 20s', () => {
    const src = read('src/app/api/openclaw/status/route.ts')
    expect(src).toContain("withPollCache('oc|status', 20_000, () => GET_impl())")
  })
  test('agents: wrapper ag| TTL 40s + invalidate ở POST/PUT/DELETE (3 lần)', () => {
    const src = read('src/app/api/agents/route.ts')
    expect(src).toContain('withPollCache(`ag|${request.nextUrl.search}`, 40_000, () => GET_impl(request))')
    const n = src.match(/invalidatePollCache\('ag\|'\)/g) ?? []
    expect(n.length).toBe(3)
  })
  test('openclaw/sessions: CHỈ cache action=list (key ocs|) + invalidate ở POST/PATCH/DELETE', () => {
    const src = read('src/app/api/openclaw/sessions/route.ts')
    expect(src).toContain("withPollCache(`ocs|${sp.get('agentProfileId') ?? ''}|${sp.get('teamName') ?? ''}`, 40_000")
    expect(src).toContain("if (action !== 'list') return GET_impl(request)")
    const n = src.match(/invalidatePollCache\('ocs\|'\)/g) ?? []
    expect(n.length).toBe(3)
  })
  test('brain: wrapper br| TTL 20s + train route invalidate', () => {
    expect(read('src/app/api/brain/route.ts')).toContain("withPollCache('br|', 20_000, () => GET_impl())")
    expect(read('src/app/api/brain/train/route.ts')).toContain("invalidatePollCache('br|')")
  })
  test('neural-architecture: wrapper na| TTL 20s + POST set/reset invalidate', () => {
    const src = read('src/app/api/neural-architecture/route.ts')
    expect(src).toContain("withPollCache('na|', 20_000, () => GET_impl())")
    expect(src).toContain("invalidatePollCache('na|')")
  })
  test('goal-loop-jobs: wrapper glj| TTL 4s (key gộp jobId|sessionId|all) + POST invalidate', () => {
    const src = read('src/app/api/goal-loop-jobs/route.ts')
    expect(src).toContain("withPollCache(`glj|${sp.get('jobId') ?? ''}|${sp.get('sessionId') ?? ''}|${sp.get('all') === 'true'}`, 4_000")
    expect(src).toContain("invalidatePollCache('glj|')")
  })
  test('opus/activity: wrapper opa| TTL 5s key theo sessionId', () => {
    expect(read('src/app/api/opus/activity/route.ts')).toContain("withPollCache(`opa|${sid ?? ''}`, 5_000, () => GET_impl(request))")
  })
})

// ============ B2. Unit hành vi — TTL hit/miss + invalidate thật ============

describe('R123 B2 · FIX2 unit — hành vi cache/invalidate', () => {
  test('miss lần đầu → hit trong TTL (x-poll-cache header)', async () => {
    const key = 'r123|hitmiss'
    let calls = 0
    const mk = () => new Response(`body-${calls}`, { status: 200 })
    const first = await withPollCache(key, 30_000, () => { calls++; return Promise.resolve(mk()) })
    expect(calls).toBe(1)
    expect(first.headers.get('x-poll-cache')).toBe('miss')
    const second = await withPollCache(key, 30_000, () => { calls++; return Promise.resolve(mk()) })
    expect(calls).toBe(1) // producer KHÔNG chạy lại
    expect(second.headers.get('x-poll-cache')).toBe('hit')
    expect(await second.text()).toBe('body-1') // nội dung cached từ lần đầu
  })
  test('invalidatePollCache(prefix) → lần gọi kế miss lại (dữ liệu mới)', async () => {
    const key = 'r123|inval'
    let calls = 0
    await withPollCache(key, 30_000, () => { calls++; return Promise.resolve(new Response('v1', { status: 200 })) })
    expect(calls).toBe(1)
    invalidatePollCache('r123|inval')
    const after = await withPollCache(key, 30_000, () => { calls++; return Promise.resolve(new Response('v2', { status: 200 })) })
    expect(calls).toBe(2) // producer chạy lại — cache cũ đã bị bỏ
    expect(await after.text()).toBe('v2')
    // prefix không khớp → không đụng entry khác
    invalidatePollCache('r123|khac')
    const keep = await withPollCache(key, 30_000, () => { calls++; return Promise.resolve(new Response('v3', { status: 200 })) })
    expect(calls).toBe(2) // vẫn hit — prefix sai không xoá nhầm
    expect(await keep.text()).toBe('v2')
  })
})

// ============ C. FIX3 — watchdog probe /api/health (không còn dùng endpoint UI poll) ============

describe('R123 C · FIX3 — HTTP Watchdog probe đổi endpoint', () => {
  test('instrumentation probe = /api/health; goal-loop-jobs không còn là probe', () => {
    const src = read('src/instrumentation-node.ts')
    expect(src).toContain("const HTTP_PROBE_URL = `http://127.0.0.1:${process.env.PORT ?? '3000'}/api/health`")
    // Bản trước probe /api/goal-loop-jobs — sau fix dòng constant cũ phải hết
    // (chuỗi /api/goal-loop-jobs vẫn xuất hiện hợp lệ trong COMMENT giải thích)
    expect(src).not.toContain("HTTP_PROBE_URL = `http://127.0.0.1:${process.env.PORT ?? '3000'}/api/goal-loop-jobs`")
  })
})

// ============ D. FIX4 — home stats 10s → 30s ============

describe('R123 D · FIX4 — nhịp stats 30s (giảm round-trip AuraDB cloud)', () => {
  test('page.tsx: interval refresh 30000 + marker FIX4; nhịp 5s extracting giữ nguyên', () => {
    const src = read('src/app/page.tsx')
    expect(src).toContain('REQ-AUDIT FIX4')
    expect(src).toContain('}, 30000)')
    // nhịp dày 5s CHỈ khi đang extraction (điều kiện) — giữ nguyên hành vi cũ
    expect(src).toContain('}, 5000)')
    // chuỗi 10s của block stats cũ phải hết (block stats giờ 30s — 10s còn lại
    // là docRefresh lite 10s cho tab Documents, không phải stats)
    expect(src).not.toContain('}, 10000) // Every 10 seconds — fast enough')
  })
})

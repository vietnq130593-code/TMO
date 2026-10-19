/**
 * S3 SMOKE — CONTRACT READ-ONLY THẬT (BLUEPRINT-BACKUP-GATE P3/S3)
 * ============================================================================
 *
 * Tầng giữa "unit mock" và "e2e cần LLM sống": kiểm HTTP contract thật
 * (route + DB/vector sống + KHÔNG LLM) — điều mà 2036 unit test mock không
 * phủ được, mà 13 e2e thì cần LLM sống nên mãi mãi ngoài gate.
 *
 * NGUYÊN TẮC SẮT (bài học Task 54): TOÀN BỘ GET — 0 mutation. Không POST/PUT/
 * PATCH/DELETE, không ghi DB, không ghi Qdrant. Chỉ fetch + assert shape.
 *
 * Cơ chế 2 trạng thái (KPI §6 "smoke 2 trạng thái"):
 *   - TMO_SMOKE_STAGE != '1' (mặc định — bun test full suite) → TOÀN BỘ skip
 *     (describe.skipIf) — unit suite không phụ thuộc app đang chạy.
 *   - TMO_SMOKE_STAGE = '1' (gate stage smoke, sau khi probe /api/health
 *     3×2s reachable) → chạy thật, fetch timeout 10s/test.
 *   - App không chạy → gate SKIP stage smoke (probe fail) — không FAIL giả,
 *     không PASS giả.
 *
 * Preload db-isolation (bunfig [test].preload toàn cục): VÔ HẠI cho smoke —
 * chỉ copy DB ra /tmp; smoke chỉ fetch HTTP, không đụng DATABASE_URL.
 */

import { describe, test, expect } from 'bun:test'

const SMOKE_ENABLED = process.env.TMO_SMOKE_STAGE === '1'
const BASE = (process.env.TMO_SMOKE_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const TIMEOUT_MS = 10_000

/** GET JSON với timeout — smoke chỉ GET (0 mutation — Task 54). */
async function getJson(pathname: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/** GET text (HTML). */
async function getText(pathname: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  return { status: res.status, body: await res.text() }
}

describe.skipIf(!SMOKE_ENABLED)('S3 smoke · contract read-only (chỉ GET — 0 mutation)', () => {
  test('GET /api/health — status healthy + Qdrant connected + chunks pointCount > 0', async () => {
    const { status, body } = await getJson('/api/health')
    expect(status).toBe(200)
    expect(body?.status).toBe('healthy')
    expect(body?.services?.qdrant?.connected).toBe(true)
    const chunks = body?.services?.qdrant?.chunksCollection
    expect(chunks?.exists).toBe(true)
    expect(typeof chunks?.pointCount).toBe('number')
    expect(chunks.pointCount).toBeGreaterThan(0) // corpus 868 chunks đã restore W3-8c
  })

  test('GET /api/query?action=stats — shape thống kê KB đúng', async () => {
    const { status, body } = await getJson('/api/query?action=stats')
    expect(status).toBe(200)
    expect(typeof body?.totalDocuments).toBe('number')
    expect(typeof body?.totalEntities).toBe('number')
    expect(typeof body?.totalRelationships).toBe('number')
    expect(body?.entityTypeDistribution).toBeTypeOf('object')
  })

  test('GET /api/agents?enabled=true — mảng agents + id không trùng', async () => {
    const { status, body } = await getJson('/api/agents?enabled=true')
    expect(status).toBe(200)
    expect(Array.isArray(body?.agents)).toBe(true)
    expect(body.agents.length).toBeGreaterThan(0)
    const ids = body.agents.map((a: { id: string }) => a.id)
    expect(new Set(ids).size).toBe(ids.length) // không trùng id
  })

  test('GET /api/storage/snapshot-full — qdrantBackups (compat) + byCollection (S1.2) + point map', async () => {
    const { status, body } = await getJson('/api/storage/snapshot-full')
    expect(status).toBe(200)
    // compat trường cũ — UI/docs đang đọc
    expect(Array.isArray(body?.qdrantBackups)).toBe(true)
    expect(typeof body?.currentQdrantPoints).toBe('number')
    // S1.2 — grouping per-collection + point map per-collection
    expect(body?.byCollection).toBeTypeOf('object')
    expect(body?.currentQdrantPointsByCollection).toBeTypeOf('object')
    // entry nào có trong byCollection thì phải có field collection (parse từ key)
    for (const entries of Object.values<any[]>(body.byCollection ?? {})) {
      for (const e of entries ?? []) {
        expect(typeof e?.collection).toBe('string')
      }
    }
  })

  test('GET / — HTML trả về có <title>', async () => {
    const { status, body } = await getText('/')
    expect(status).toBe(200)
    expect(body).toContain('<title')
  })
})

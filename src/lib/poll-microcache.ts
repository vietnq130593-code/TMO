/**
 * Poll micro-cache + in-flight dedup cho các GET endpoint bị UI poll dồn dập.
 *
 * VÒNG 10 (2026-09-30 — quan sát agents thực thi): UI poll /api/agent-run mỗi
 * ~1.2s và /api/todos mỗi ~3s. Trong lúc mission ghi checkpoint, SQLite busy
 * (WAL busy_timeout 5000ms) khiến 1 query có khi mất 7.5s → các request poll
 * chồng đống nhau (mỗi request giữ Prisma connection + buffer serialize 131KB)
 * → RSS ratchet + MemAvailable toàn cục cạn → MemWatchdog self-exit giữa LLM
 * call của mission → RESUME lặp vô hạn (39+ lần kẹt "chu kỳ 7, 12 vòng").
 *
 * Giải pháp 2 tầng, hoàn toàn transparent với client:
 *   1. TTL micro-cache (mặc định 2.5s — người người không thể nhận ra, nhưng
 *      loại bỏ ~50-70% query DB + serialization garbage)
 *   2. In-flight dedup: các request cùng key đang bay → SHARE chung 1 promise
 *      (loại bỏ hoàn toàn cảnh chồng đống khi DB chậm)
 *
 * Lưu ý:
 *   - Cache trên globalThis (sống sót qua HMR reload của next dev).
 *   - Map bounded 64 entry (FIFO evict) — tự nó không thể thành leak.
 *   - Chỉ cache response 2xx (lỗi/self-heal path không cache).
 *   - Body cache dạng string (không dùng Response.clone/tee — tránh đệm đôi).
 *   - DELETE/POST làm đổi dữ liệu → TTL ngắn tự hội tụ sau ≤2.5s (panel poll
 *     lại ngay sau đó — chấp nhận được cho progress UI).
 */

interface PollCacheEntry {
  expiresAt: number
  body: string
  status: number
}

type G = typeof globalThis & {
  __pollMicroCache?: Map<string, PollCacheEntry>
  __pollMicroInflight?: Map<string, Promise<Response>>
}

const g = globalThis as G

const MAX_ENTRIES = 64

export async function withPollCache(
  key: string,
  ttlMs: number,
  producer: () => Promise<Response>,
): Promise<Response> {
  const cache = (g.__pollMicroCache ??= new Map<string, PollCacheEntry>())
  const inflight = (g.__pollMicroInflight ??= new Map<string, Promise<Response>>())

  // 1) TTL hit
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) {
    return new Response(hit.body, {
      status: hit.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-poll-cache': 'hit' },
    })
  }
  cache.delete(key)

  // 2) In-flight dedup — request cùng key đang bay thì đợi chung 1 promise
  const pending = inflight.get(key)
  if (pending) return pending

  const p = (async () => {
    try {
      const resp = await producer()
      if (resp.status >= 200 && resp.status < 300) {
        const body = await resp.text()
        cache.set(key, { expiresAt: Date.now() + ttlMs, body, status: resp.status })
        if (cache.size > MAX_ENTRIES) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        return new Response(body, {
          status: resp.status,
          headers: { 'content-type': 'application/json; charset=utf-8', 'x-poll-cache': 'miss' },
        })
      }
      return resp
    } catch (err) {
      // Không cache lỗi — ném nguyên trạng để error handler của route xử lý
      throw err
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

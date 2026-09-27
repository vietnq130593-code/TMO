/**
 * CACHE STORE — abstraction cache thống nhất (Redis-ready)
 * ========================================================
 * (Task 43 — user audit "Redis": TMO theo chính sách stack KHÔNG dùng
 * middleware ngoài (Redis/MySQL) — cache hiện tại là globalThis memory.
 * Trước đây mỗi module tự viết cache riêng (roster 60s TTL, seed memo...) →
 * không quan sát được, không có nơi thay backend tập trung.)
 *
 * Thiết kế:
 *   - TmoCache<T>: TTL cache sync (get/set/invalidate + stats hits/misses)
 *   - Global registry: mọi instance tự đăng ký → listCacheStores() quan sát
 *     toàn bộ cache của hệ thống qua GET /api/agent-events?caches=1
 *   - REDIS-READY: khi cần chuyển Redis, chỉ cần thay internals của lớp này
 *     bằng client async (same-name API) — mọi caller giữ nguyên. Điểm swap
 *     DUY NHẤT (trước đây phải sửa từng module).
 *
 * Nguyên tắc fail-open giữ nguyên: cache lỗi/quá hạn → trả null, caller tự
 * fetch nguồn thật (đã là hành vi của roster cache cũ).
 */

// ==================== TYPES ====================

export interface CacheStoreStats {
  name: string
  size: number
  ttlMs: number
  lastSetAt: number | null
  lastReadAt: number | null
  hits: number
  misses: number
  expiredCount: number
}

interface CacheEntry<T> {
  value: T
  setAt: number
}

interface Registry {
  stores: Map<string, TmoCache<unknown>>
}

const globalForCache = globalThis as unknown as {
  __tmoCacheStoreRegistry?: Registry
}

function getRegistry(): Registry {
  if (!globalForCache.__tmoCacheStoreRegistry) {
    globalForCache.__tmoCacheStoreRegistry = { stores: new Map() }
  }
  return globalForCache.__tmoCacheStoreRegistry
}

// ==================== CACHE CLASS ====================

/**
 * TTL cache in-memory — thay thế pattern thủ công:
 *   globalThis.__xCache?: { value: T; at: number }
 *
 * Sync get/set (khớp mọi caller hiện có — roster cache là sync). Backend
 * Redis tương lai sẽ cần async: khi đó get() trả về T | null vẫn dùng được
 * qua await wrapper ở caller (điểm swap tập trung tại đây).
 */
export class TmoCache<T> {
  private entry: CacheEntry<T> | null = null
  readonly name: string
  readonly ttlMs: number
  private hits = 0
  private misses = 0
  private expiredCount = 0
  private lastReadAt: number | null = null

  constructor(name: string, ttlMs: number) {
    this.name = name
    this.ttlMs = Math.max(0, ttlMs)
    // Đăng ký vào global registry (đè cùng tên — HMR reload module mới)
    getRegistry().stores.set(name, this as unknown as TmoCache<unknown>)
  }

  /** Giá trị còn hạn — null khi chưa set / đã quá hạn / đã invalidate. */
  get(): T | null {
    this.lastReadAt = Date.now()
    if (!this.entry) {
      this.misses++
      return null
    }
    if (this.ttlMs > 0 && Date.now() - this.entry.setAt > this.ttlMs) {
      this.expiredCount++
      this.entry = null
      this.misses++
      return null
    }
    this.hits++
    return this.entry.value
  }

  set(value: T): void {
    this.entry = { value, setAt: Date.now() }
  }

  invalidate(): void {
    this.entry = null
  }

  stats(): CacheStoreStats {
    return {
      name: this.name,
      size: this.entry ? 1 : 0,
      ttlMs: this.ttlMs,
      lastSetAt: this.entry?.setAt ?? null,
      lastReadAt: this.lastReadAt,
      hits: this.hits,
      misses: this.misses,
      expiredCount: this.expiredCount,
    }
  }
}

// ==================== REGISTRY QUERIES ====================

/** Toàn bộ cache store đang hoạt động (cho observability /api/agent-events). */
export function listCacheStores(): CacheStoreStats[] {
  const stores = getRegistry().stores
  const out: CacheStoreStats[] = []
  for (const store of stores.values()) {
    try {
      out.push(store.stats())
    } catch { /* fail-open — 1 store lỗi không chặn listing */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

'use client'

/**
 * dynamic-retry — lớp phòng thủ frontend cho code-split chunks (Turbopack dev).
 *
 * BỐI CẢNH: app TMO chạy mission nặng → RSS chạm HARD 2100MB → MemWatchdog
 * self-exit sạch + PM2 restart ~5-10s (đúng thiết kế vòng 11c/12b/12c).
 * Trong cửa sổ restart đó, tab trình duyệt đang mở lazy-load module qua
 * next/dynamic → fetch chunk fail → ChunkLoadError bắn thẳng ra màn hình
 * (trace 1a0f3586be589739 — smolab-module).
 *
 * Chiến lược 3 lớp:
 *   L1 (file này): loader retry backoff 1s→3s→6s→10s — cưỡi qua cửa sổ restart
 *      mà KHÔNG mất state trang; cạn retry → guarded reload 1 lần.
 *   L2 (chunk-error-recovery.tsx): listener toàn cục cho mọi chunk fail
 *      ngoài 8 module next/dynamic (route transition, CSS chunk, fast refresh).
 *   L3 (app/error.tsx): fallback thân thiện + auto-reload cho chunk error
 *      thay vì màn hình lỗi thô.
 *
 * KHÔNG đụng logic server — mission đang chạy không bị ảnh hưởng.
 */

const RELOAD_GUARD_KEY = 'tmo:chunk-reload-at'
const RELOAD_COOLDOWN_MS = 30_000

/**
 * STRICT: chắc chắn là lỗi tải module/chunk (tin cậy để auto-reload toàn trang).
 * Chỉ khớp thông điệp riêng của module loading — KHÔNG khớp "Failed to fetch"
 * chung (vì API poll cũng sinh lỗi đó, reload cả trang vì 1 poll fail là quá tay).
 */
export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false
  const name =
    typeof err === 'object' && err !== null && 'name' in err
      ? String((err as { name?: unknown }).name)
      : ''
  const message =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message?: unknown }).message)
      : String(err)
  if (name === 'ChunkLoadError') return true
  return (
    /Failed to load chunk/i.test(message) ||
    /Loading chunk \d+ failed/i.test(message) ||
    /Loading CSS chunk \d+ failed/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message)
  )
}

/**
 * RỘNG HƠN: thêm lỗi mạng generic (Failed to fetch / NetworkError / Load failed).
 * CHỈ dùng trong loader của import() — ở đó context chắc chắn là tải module,
 * fetch fail đồng nghĩa chunk fail (trùng cửa sổ restart).
 */
export function isTransientLoadError(err: unknown): boolean {
  if (isChunkLoadError(err)) return true
  if (!err) return false
  const message =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message?: unknown }).message)
      : String(err)
  return (
    /Failed to fetch/i.test(message) ||
    /NetworkError when attempting to fetch resource/i.test(message) ||
    /\bLoad failed\b/i.test(message)
  )
}

/** Reload trang tối đa 1 lần / 30s mỗi tab (sessionStorage guard — chống vòng reload vô hạn). Trả về true nếu đã kích hoạt reload. */
export function guardedChunkReload(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_GUARD_KEY) || '0')
    const now = Date.now()
    if (now - last < RELOAD_COOLDOWN_MS) return false
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(now))
    window.location.reload()
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Backoff 1s→3s→6s→10s — tổng ~20s: đủ cưỡi PM2 restart ~5s + turbopack warm-up. */
const RETRY_DELAYS_MS = [1_000, 3_000, 6_000, 10_000]

/**
 * Bọc loader cho next/dynamic: lỗi tải chunk (transient) → retry backoff;
 * lỗi code thật (module ném exception ở top-level) → rethrow NGAY không retry.
 * Cạn retry → guarded reload 1 lần; reload bị chặn bởi cooldown → ném lại lỗi gốc
 * cho error boundary (app/error.tsx) hiển thị fallback thân thiện.
 */
export async function importWithRetry<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load()
  } catch (err) {
    if (!isTransientLoadError(err)) throw err
    console.warn(
      '[dynamic-retry] Lỗi tải chunk (server đang restart?) — thử lại sau backoff:',
      err instanceof Error ? err.message : err,
    )
    let lastErr: unknown = err
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      await sleep(RETRY_DELAYS_MS[attempt])
      try {
        return await load()
      } catch (retryErr) {
        if (!isTransientLoadError(retryErr)) throw retryErr
        lastErr = retryErr
        console.warn(
          `[dynamic-retry] Lần thử ${attempt + 2}/${RETRY_DELAYS_MS.length + 1} vẫn lỗi chunk:`,
          retryErr instanceof Error ? retryErr.message : retryErr,
        )
      }
    }
    guardedChunkReload()
    throw lastErr
  }
}

/**
 * Adapter cho next/dynamic:
 *   dynamic(withChunkRetry(() => import('...').then(m => m.X)), { loading: ... })
 * Chunk vẫn được Turbopack tách như thường — literal import() nằm tĩnh trong closure.
 */
export function withChunkRetry<T>(load: () => Promise<T>): () => Promise<T> {
  return () => importWithRetry(load)
}

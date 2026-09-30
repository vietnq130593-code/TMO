'use client'

/**
 * fetch-retry — retry cho API call trúng cửa sổ app restart (trace 1a0f37bbc9c7e965).
 *
 * BỐI CẢNH: app TMO chạy mission nặng → MemWatchdog RSS self-exit + PM2 restart
 * ~5-10s/lần (đúng thiết kế 11c/12b/12c). Request API trúng cửa sổ đó nhận
 * HTTP 502/503/504 từ gateway (hoặc reject mạng) → trước đây Smolab
 * loadSessionTail ném `HTTP 502` ra console + XÓA messages đang hiển thị.
 *
 * fetchWithTransientRetry: 502/503/504 + lỗi mạng → retry backoff 1/3/6/10s
 * (~20s tổng — khớp cửa sổ restart; mirror chiến lược src/lib/dynamic-retry.ts).
 *
 * NGUYÊN TẮC AN TOÀN:
 *   - CHỈ retry status 502/503/504: gateway không nối được upstream → request
 *     CHƯA TỚI app → retry an toàn kể cả POST/PUT (không double-execute).
 *   - KHÔNG retry 500/4xx: app đã xử lý request (có thể đã ghi DB) → trả thẳng
 *     cho caller xử lý theo logic riêng. Đặc biệt KHÔNG BAO GIỜ tự retry POST
 *     chat/message — chỉ các endpoint read hoặc idempotent action mới bọc.
 *   - Cạn retry với response (vd 502 kéo dài) → trả về response cuối, caller
 *     throw `HTTP {status}` như luồng cũ; cạn retry vì lỗi mạng → ném lại lỗi.
 */

const RETRY_DELAYS_MS = [1_000, 3_000, 6_000, 10_000]

export function isTransientHttpStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchWithTransientRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { label?: string; delays?: number[] },
): Promise<Response> {
  const delays = opts?.delays ?? RETRY_DELAYS_MS
  const tag = opts?.label ? `[fetch-retry] [${opts.label}]` : '[fetch-retry]'
  let attempt = 0
  while (true) {
    if (attempt > 0) await sleep(delays[attempt - 1])
    try {
      const res = await fetch(input, init)
      if (!isTransientHttpStatus(res.status) || attempt >= delays.length) {
        return res // OK / 4xx / 500 (đã chạm app) / cạn retry → caller tự xử lý
      }
      console.warn(
        `${tag} HTTP ${res.status} (server đang restart?) — thử lại lần ${attempt + 1}/${delays.length}`,
      )
    } catch (err) {
      // fetch reject = mạng đứt (server down hẳn trong cửa sổ restart)
      if (attempt >= delays.length) throw err
      console.warn(
        `${tag} Lỗi mạng (${err instanceof Error ? err.message : String(err)}) — thử lại lần ${attempt + 1}/${delays.length}`,
      )
    }
    attempt++
  }
}

'use client'

/**
 * fetch-retry — retry cho API call trúng cửa sổ app restart (trace 1a0f37bbc9c7e965)
 * + gateway rate-limit 429 (user report 2026-11-05: brain-tab fetchBrainData/
 * fetchFeed "HTTP 429" — preview proxy ngoài chặn burst khi nhiều poller cùng
 * bắn 1 lúc; request CHƯA TỚI app — dev.log app chỉ thấy 200).
 *
 * BỐI CẢNH: app TMO chạy mission nặng → MemWatchdog RSS self-exit + PM2 restart
 * ~5-10s/lần (đúng thiết kế 11c/12b/12c). Request API trúng cửa sổ đó nhận
 * HTTP 502/503/504 từ gateway (hoặc reject mạng) → trước đây Smolab
 * loadSessionTail ném `HTTP 502` ra console + XÓA messages đang hiển thị.
 *
 * fetchWithTransientRetry:
 *   - 502/503/504 → retry backoff 1/3/6/10s (~20s tổng — khớp cửa sổ restart;
 *     mirror chiến lược src/lib/dynamic-retry.ts)
 *   - 429 → retry backoff ngắn CÓ JITTER ~0.9/1.8/3.6s (±35%) — gateway
 *     throttle thường tự dịu sau ~1-3s; jitter chống "retry storm" đồng bộ
 *     (nhiều poller cùng trúng 429 rồi cùng retry đúng 1 lúc → tự re-trip).
 *     Tôn trọng header Retry-After (giây hoặc HTTP-date, trần 30s) nếu có.
 *
 * NGUYÊN TẮC AN TOÀN:
 *   - CHỈ retry status 429/502/503/504: 429 = request KHÔNG được chấp nhận
 *     (chưa chạm app — retry an toàn kể cả POST); 502/503/504 = gateway
 *     không nối được upstream → request CŨNG chưa tới app.
 *   - KHÔNG retry 500/4xx khác: app đã xử lý request (có thể đã ghi DB) → trả
 *     thẳng cho caller xử lý theo logic riêng. Đặc biệt KHÔNG BAO GIỜ tự retry
 *     POST chat/message — chỉ các endpoint read hoặc idempotent action mới bọc.
 *   - AbortError (unmount/đổi query giữa chừng) → ném lại NGAY, không retry —
 *     nếu retry thì unmount cleanup bị trễ và response cũ ghi đè state mới.
 *   - Cạn retry với response (vd 502 kéo dài) → trả về response cuối, caller
 *     throw `HTTP {status}` như luồng cũ; cạn retry vì lỗi mạng → ném lại lỗi.
 */

const RETRY_DELAYS_MS = [1_000, 3_000, 6_000, 10_000]
/** 429 — gateway throttle: ngắn hơn cửa sổ restart, kèm jitter ±35%. */
const RATE_LIMIT_DELAYS_MS = [900, 1_800, 3_600]

export function isTransientHttpStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Delay 429 có jitter ±35% (min 50ms) — chống retry storm đồng bộ. */
function jittered(ms: number): number {
  const factor = 1 + (Math.random() * 0.7 - 0.35)
  return Math.max(50, Math.round(ms * factor))
}

/** Đọc header Retry-After (giây nguyên hoặc HTTP-date) → ms, trần 30s. */
function retryAfterMs(res: Response): number | null {
  try {
    const raw = res.headers.get('retry-after')
    if (!raw) return null
    const sec = Number(raw)
    if (Number.isFinite(sec) && sec >= 0) {
      return Math.min(30_000, Math.max(250, sec * 1000))
    }
    const date = Date.parse(raw)
    if (Number.isFinite(date)) {
      return Math.min(30_000, Math.max(250, date - Date.now()))
    }
  } catch { /* header rác — bỏ qua */ }
  return null
}

export async function fetchWithTransientRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { label?: string; delays?: number[] },
): Promise<Response> {
  const delays = opts?.delays ?? RETRY_DELAYS_MS
  const tag = opts?.label ? `[fetch-retry] [${opts.label}]` : '[fetch-retry]'
  let attempt = 0
  let waitMs: number | null = null // đã tính cho lần thử KẾ TIẾP (null = thử ngay)
  while (true) {
    if (waitMs !== null) {
      await sleep(waitMs)
      waitMs = null
    }
    try {
      const res = await fetch(input, init)
      if (!isTransientHttpStatus(res.status) || attempt >= delays.length) {
        return res // OK / 4xx / 500 (đã chạm app) / cạn retry → caller tự xử lý
      }
      if (res.status === 429) {
        // 429: Retry-After nếu gateway đưa, không thì jitter ngắn (~1-4s).
        // Drain body (best-effort) giải phóng connection trước khi chờ.
        try { await res.text() } catch { /* ignore */ }
        const ra = retryAfterMs(res)
        waitMs = ra ?? jittered(RATE_LIMIT_DELAYS_MS[Math.min(attempt, RATE_LIMIT_DELAYS_MS.length - 1)])
        console.warn(
          `${tag} HTTP 429 (gateway rate-limit${ra ? ` — Retry-After ${Math.round(ra / 1000)}s` : ' — backoff jitter'}) — thử lại lần ${attempt + 1}/${delays.length}`,
        )
      } else {
        // 502/503/504: nhịp 1/3/6/10s khớp cửa sổ restart (hành vi cũ giữ nguyên)
        waitMs = delays[attempt]
        console.warn(
          `${tag} HTTP ${res.status} (server đang restart?) — thử lại lần ${attempt + 1}/${delays.length}`,
        )
      }
    } catch (err) {
      // AbortError (unmount/đổi query) → KHÔNG retry, ném lại ngay
      if (err instanceof Error && err.name === 'AbortError') throw err
      // fetch reject = mạng đứt (server down hẳn trong cửa sổ restart)
      if (attempt >= delays.length) throw err
      waitMs = delays[attempt]
      console.warn(
        `${tag} Lỗi mạng (${err instanceof Error ? err.message : String(err)}) — thử lại lần ${attempt + 1}/${delays.length}`,
      )
    }
    attempt++
  }
}

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
 * ROUND-46 mở rộng cho CHUNK CORRUPTION (parse-stage): chunk trả về 200 nhưng
 * thân JS bị cắt cụt giữa chừng (watchdog self-exit đúng lúc stream) → V8 nổ
 * "Unexpected end of input" —KHÔNG phải fetch-fail nên các lớp cũ không thấy.
 * Giờ isChunkLoadError khớp cả họ dấu hiệu này (isChunkCorruptionError) —
 * mọi tầng tự fetch lại/self-heal; guardedChunkReload thêm cap 5 lần/session.
 *
 * KHÔNG đụng logic server — mission đang chạy không bị ảnh hưởng.
 */

const RELOAD_GUARD_KEY = 'tmo:chunk-reload-at'
const RELOAD_COOLDOWN_MS = 30_000
// ROUND-46: cap tổng số auto-reload mỗi tab-session — chống vòng reload vô hạn
// nếu dấu hiệu corruption bị false-positive trên một lỗi code thật lặp lại.
const RELOAD_MAX_COUNT = 5
const RELOAD_COUNT_KEY = 'tmo:chunk-reload-count'

/**
 * ROUND-46 — CHUNK CORRUPTION (parse-stage) SIGNATURES.
 *
 * Bằng chứng run thật (dev.log vòng 46, 5 lần "Uncaught SyntaxError:
 * Unexpected end of input" trên các page load liền nhau): MemWatchdog
 * self-exit + PM2 restart giữa lúc trình duyệt đang tải chunk → response HTTP
 * 200 nhưng body BỊ CẮT ĐỨT giữa chừng → V8 parse lỗi "Unexpected end of
 * input" (chunk KHÔNG fetch-fail — vẫn 200 — nên 3 lớp phòng thủ cũ không thấy).
 *
 * Phân biệt với lỗi syntax THẬT trong source: Turbopack dev bắt lỗi cú pháp
 * ở TẦNG BUILD (serving error-overlay, không phát chunk hỏng ra browser) —
 * nên một SyntaxError nổ ra ở TẦNG PARSE TRÙNG THỜI ĐIỂM RUNTIME gần như
 * chắc chắn là hỏng hóc vận chuyển (thân bị cắt / HTML thay JS / byte rác).
 *
 * Chỉ khớp các thông điệp đặc trưng cho parse-stage corruption; KHÔNG khớp
 * lỗi runtime thông thường ("x is not a function"...) — những lỗi đó phải
 * hiện cho dev thấy chứ không được tự reload che.
 */
const CHUNK_CORRUPTION_PATTERNS: RegExp[] = [
  /Unexpected end of input/i, // V8 — body JS bị cắt cụt giữa chừng
  /Unexpected token/i, // V8 — HTML/rác được serve thay vì JS (404-page, proxy error)
  /Unexpected identifier/i, // V8 — cắt giữa identifier
  /Unexpected number/i,
  /Unexpected string/i,
  /Unexpected eof/i,
  /Unexpected end of script/i, // một số engine
  /expected expression, got/i, // Firefox "expected expression, got '<'"
]

/** ROUND-46 review-fix (1a/1b): loại trừ SyntaxError của JSON.parse —
 * Chrome phát "Unexpected token '<', \"<html>…\" is not valid JSON" khi
 * fetch().json() ăn phải HTML error-page: đó là LỖI APP (reload không chữa
 * được) → không được khớp. Dấu hiệu nhận biết: message chứa "is not valid JSON"
 * hoặc JSON.parse prefix. Bỏ luôn pattern Safari-JSON chết (khớp không
 * thông điệp thật của engine nào; nếu để tự do nó false-positive trên API
 * JSON cắt cụt — reload không giúp gì). */
const NOT_CHUNK_CORRUPTION_PATTERNS: RegExp[] = [
  /is not valid JSON/i, // Chrome res.json()/JSON.parse — lỗi app-level
  /^JSON\.parse:/i, // Firefox JSON.parse prefix
  /^JSON Parse error/i, // Safari JSON.parse prefix
]

/** Chunk bị hỏng ở tầng PARSE (200 + body cắt cụt/rác) — an toàn để retry/reload. */
export function isChunkCorruptionError(err: unknown): boolean {
  if (!err) return false
  const name =
    typeof err === 'object' && err !== null && 'name' in err
      ? String((err as { name?: unknown }).name)
      : ''
  const message =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message?: unknown }).message)
      : String(err)
  // ROUND-46 review-fix (vòng 2): CHỈ nhận SyntaxError thật — name phải là
  // 'SyntaxError' (hoặc rỗng — chuỗi text "Uncaught SyntaxError: …" từ
  // console-event không kèm error object). Trước đây bất kỳ error nào có
  // message CHỨA chữ "SyntaxError" (vd TypeError('eval config: SyntaxError:
  // Unexpected token …') của app-code) cũng được nhận → auto-reload oan.
  const isSyntaxError =
    name === 'SyntaxError' ||
    (name === '' && /(^|\W)SyntaxError(\W|$)/i.test(message))
  if (!isSyntaxError) return false
  if (NOT_CHUNK_CORRUPTION_PATTERNS.some((re) => re.test(message))) return false
  return CHUNK_CORRUPTION_PATTERNS.some((re) => re.test(message))
}

/**
 * STRICT: chắc chắn là lỗi tải module/chunk (tin cậy để auto-reload toàn trang).
 * Chỉ khớp thông điệp riêng của module loading — KHÔNG khớp "Failed to fetch"
 * chung (vì API poll cũng sinh lỗi đó, reload cả trang vì 1 poll fail là quá tay).
 * ROUND-46: bổ sung chunk CORRUPTION parse-stage (isChunkCorruptionError) —
 * một chunk 200-nhưng-thân-bị-cắt cũng phải được đối xử như chunk fail
 * (retry + guarded reload) vì self-heal chỉ có thể là fetch lại.
 */
export function isChunkLoadError(err: unknown): boolean {
  if (isChunkCorruptionError(err)) return true
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

/**
 * Reload trang tối đa 1 lần / 30s mỗi tab (sessionStorage guard — chống vòng
 * reload vô hạn) VÀ tối đa RELOAD_MAX_COUNT lần / tab-session (ROUND-46 —
 * chống vòng reload dài hạn nếu dấu hiệu chunk lại bị false-positive).
 * Trả về true nếu đã kích hoạt reload.
 */
export function guardedChunkReload(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_GUARD_KEY) || '0')
    const count = Number(window.sessionStorage.getItem(RELOAD_COUNT_KEY) || '0')
    const now = Date.now()
    if (now - last < RELOAD_COOLDOWN_MS) return false
    if (count >= RELOAD_MAX_COUNT) return false
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(now))
    window.sessionStorage.setItem(RELOAD_COUNT_KEY, String(count + 1))
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

'use client'

/**
 * chunk-error-recovery — L2 trong bộ 3 lớp phòng thủ chunk (xem src/lib/dynamic-retry.ts).
 *
 * Lưới an toàn TOÀN CỤC cho mọi chunk fail nằm ngoài 8 loader next/dynamic đã
 * bọc withChunkRetry: route transition, CSS chunk, fast-refresh đổi tên chunk...
 * Nghe error + unhandledrejection ở window; khớp isChunkLoadError (STRICT —
 * không khớp "Failed to fetch" generic để tránh reload cả trang chỉ vì 1 API
 * poll fail khi server restart) → guarded reload 1 lần / 30s (cap 5 lần/session).
 *
 * ROUND-46 — 2 lớp nghe MỚI cho chunk CORRUPTION (bằng chứng: 5 lần
 * "Uncaught SyntaxError: Unexpected end of input" trong dev.log — MemWatchdog
 * self-exit cắt đôi response chunk đang bay, HTTP 200 nhưng thân JS thiếu đuôi):
 *   (1) PARSE-CORRUPTION: SyntaxError parse-stage từ <script> classic/import()
 *       nổ thành exception chưa bắt — isChunkLoadError (đã mở rộng round-46,
 *       xem isChunkCorruptionError) khớp được cả họ này → guarded reload.
 *   (2) RESOURCE-STYLE: <script> (module/HMR) fetch fail (404 chunk cũ sau
 *       restart, connection reset) sinh error event TRÊN PHẦN TỬ — không
 *       bubble, phải nghe ở pha CAPTURE. Chỉ tính script SAME-ORIGIN (chunk
 *       của app) — script bên thứ 3 fail không được kéo reload cả trang.
 */
import { useEffect } from 'react'
import { isChunkLoadError, guardedChunkReload } from '@/lib/dynamic-retry'

export function ChunkErrorRecovery() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const candidate = event.error ?? event.message
      if (isChunkLoadError(candidate)) {
        console.warn(
          '[chunk-recovery] Phát hiện lỗi chunk toàn cục — guarded reload:',
          typeof candidate === 'string' ? candidate : (candidate as Error)?.message ?? candidate,
        )
        guardedChunkReload()
      }
    }
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isChunkLoadError(event.reason)) {
        console.warn(
          '[chunk-recovery] Chunk promise reject — guarded reload:',
          event.reason instanceof Error ? event.reason.message : event.reason,
        )
        guardedChunkReload()
      }
    }
    /** ROUND-46: resource-error trên <script> (không bubble — nghe capture). */
    const onResourceError = (event: Event) => {
      const target = event.target as HTMLElement | null
      if (!(target instanceof HTMLScriptElement)) return
      const src = target.getAttribute('src') || ''
      if (!src) return // inline script — không phải chunk
      // ROUND-46 review-fix (1d): loại URL protocol-relative '//cdn.example.com/…'
      // — không same-origin (chỉ khớp '/path' tuyệt đối hoặc origin đầy đủ).
      if (src.startsWith('//')) return
      const sameOrigin = src.startsWith('/') || src.startsWith(window.location.origin)
      if (!sameOrigin) return // script third-party — không can thiệp
      console.warn('[chunk-recovery] <script> tải/hỏng giữa chừng (chunk cũ sau restart?) — guarded reload:', src)
      guardedChunkReload()
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    // capture-phase: resource errors trên phần tử không bubble lên window
    window.addEventListener('error', onResourceError, true)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('error', onResourceError, true)
    }
  }, [])

  return null
}

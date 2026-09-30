'use client'

/**
 * chunk-error-recovery — L2 trong bộ 3 lớp phòng thủ chunk (xem src/lib/dynamic-retry.ts).
 *
 * Lưới an toàn TOÀN CỤC cho mọi chunk fail nằm ngoài 8 loader next/dynamic đã
 * bọc withChunkRetry: route transition, CSS chunk, fast-refresh đổi tên chunk...
 * Nghe error + unhandledrejection ở window; khớp isChunkLoadError (STRICT —
 * không khớp "Failed to fetch" generic để tránh reload cả trang chỉ vì 1 API
 * poll fail khi server restart) → guarded reload 1 lần / 30s.
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
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  return null
}

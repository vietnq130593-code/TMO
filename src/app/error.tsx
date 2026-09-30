'use client'

/**
 * app/error.tsx — L3 trong bộ 3 lớp phòng thủ chunk (xem src/lib/dynamic-retry.ts).
 *
 * Trước đây KHÔNG có error boundary nào: ChunkLoadError (fetch chunk trúng cửa sổ
 * app restart) bắn thẳng lên màn hình thô của Next (trace 1a0f3586be589739).
 * Giâyờ:
 *   - Lỗi chunk → thông báo "server vừa tự khởi động lại" + đếm ngược 5s auto-reload
 *     (guarded — 1 lần/30s; bị chặn thì nút bấm reload trực tiếp).
 *   - Lỗi khác → fallback chung + nút "Thử lại" (reset) + "Tải lại trang".
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isChunkLoadError, guardedChunkReload } from '@/lib/dynamic-retry'

const CHUNK_COUNTDOWN_S = 5

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const isChunk = isChunkLoadError(error)
  const [countdown, setCountdown] = useState(CHUNK_COUNTDOWN_S)

  useEffect(() => {
    console.error('[error-boundary]', error)
  }, [error])

  useEffect(() => {
    if (!isChunk) return
    const timer = setInterval(() => {
      setCountdown((c) => c - 1)
    }, 1_000)
    return () => clearInterval(timer)
  }, [isChunk])

  useEffect(() => {
    if (isChunk && countdown <= 0) {
      if (!guardedChunkReload()) reset()
    }
  }, [isChunk, countdown, reset])

  return (
    <div
      role="alert"
      className="flex min-h-[60vh] flex-1 flex-col items-center justify-center gap-4 bg-slate-950 p-6 text-center"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full border border-amber-500/40 bg-amber-950/50">
        {isChunk ? (
          <Loader2 className="h-7 w-7 animate-spin text-amber-400" aria-hidden />
        ) : (
          <AlertTriangle className="h-7 w-7 text-amber-400" aria-hidden />
        )}
      </div>

      {isChunk ? (
        <>
          <h2 className="text-lg font-semibold text-stone-200">
            Mất kết nối tới server trong lúc tải module
          </h2>
          <p className="max-w-md text-sm leading-relaxed text-stone-400">
            App vừa tự khởi động lại (vệ sinh bộ nhớ trong lúc chạy mission nặng —
            bình thường, mất ~5-10s). Trang sẽ tự tải lại sau{' '}
            <span className="font-semibold text-cyan-400">{Math.max(countdown, 0)}s</span>.
          </p>
        </>
      ) : (
        <>
          <h2 className="text-lg font-semibold text-stone-200">Đã có lỗi xảy ra</h2>
          <p className="max-w-md text-sm leading-relaxed text-stone-400">
            {error.message || 'Lỗi không xác định'}
            {error.digest ? (
              <span className="mt-1 block font-mono text-xs text-stone-500">
                digest: {error.digest}
              </span>
            ) : null}
          </p>
        </>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        {isChunk ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.location.reload()}
            className="border-cyan-400/40 text-cyan-300 hover:bg-cyan-950/40"
          >
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
            Tải lại ngay
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={reset}
              className="border-cyan-400/40 text-cyan-300 hover:bg-cyan-950/40"
            >
              Thử lại
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.location.reload()}
              className="border-stone-600 text-stone-300 hover:bg-stone-900"
            >
              <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
              Tải lại trang
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

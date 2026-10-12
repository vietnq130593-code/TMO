'use client'

/**
 * BRAIN-UX §9.6 (UX-5) — nút bật/tắt theme hi-tech toàn app.
 * ============================================================================
 *
 * "Màn hình kính công nghệ cao trong phòng tối": cờ data-hitech="on" trên
 * <html> biến đổi tokens + bề mặt kính .nc-panel + vành sáng conic + nút nhô
 * bóng qua globals.css (CSS-driven toàn cục — không component nào khác phải
 * sửa; rollout theo mô-đun đợt sau nếu user muốn).
 *
 * Hợp đồng:
 *  - Đọc localStorage['tmo-hitech'] ('on'|'off') lúc MOUNT (queueMicrotask +
 *    try/catch fail-open — cùng pattern 'tmo-brain-selected') → set
 *    document.documentElement.dataset.hitech. Render nút TRUNG TÍNH trước
 *    mount (tránh hydration mismatch), cập nhật nhãn sau mount.
 *  - Nhấn: đổi dataset + localStorage + sync tuning-store để audit —
 *    POST /api/neural-architecture {action:'set', key:'ui_hitech', value:'on'}
 *    (tắt: {action:'reset', key:'ui_hitech'} — đúng format handleSet/Reset).
 *    KHÔNG chặn render chờ POST. POST fail → toast cảnh báo nhưng vẫn áp dụng
 *    local (fail-open trình bày — cờ là tiện lợi, không phải điều kiện sống còn).
 *  - Không store ngoài localStorage. OFF = trả về giao diện hiện tại nguyên vẹn.
 */

import { useCallback, useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'

const HITECH_KEY = 'tmo-hitech'

export function HiTechToggle({ collapsed = false }: { collapsed?: boolean }) {
  // null = trước mount — render trung tính "Hi-tech" (mặc định off), cập nhật
  // nhãn thật sau mount (tránh hydration mismatch — html đã suppressHydrationWarning
  // cho next-themes nhưng nút vẫn phải render nhất quán 2 phía).
  const [on, setOn] = useState<boolean | null>(null)

  // Mount: đọc localStorage → áp cờ lên <html> (fail-open: private mode → off)
  useEffect(() => {
    queueMicrotask(() => {
      let saved: string | null = null
      try {
        saved = localStorage.getItem(HITECH_KEY)
      } catch { /* private mode — giữ mặc định off */ }
      const next = saved === 'on'
      document.documentElement.dataset.hitech = next ? 'on' : 'off'
      setOn(next)
    })
  }, [])

  const toggle = useCallback(() => {
    const next = !(on ?? false)
    setOn(next)
    try {
      document.documentElement.dataset.hitech = next ? 'on' : 'off'
      localStorage.setItem(HITECH_KEY, next ? 'on' : 'off')
    } catch { /* private mode — vẫn áp dụng trong phiên hiện tại */ }
    // Sync tuning-store để audit — fire-and-forget, KHÔNG chặn render chờ POST
    void fetch('/api/neural-architecture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next
        ? { action: 'set', key: 'ui_hitech', value: 'on' }
        : { action: 'reset', key: 'ui_hitech' }),
    })
      .then(async res => {
        if (res.ok) return
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        toast.warning('Theme hi-tech áp dụng cục bộ — không sync được tuning-store', {
          description: json.error ?? `HTTP ${res.status}`,
        })
      })
      .catch(() => {
        toast.warning('Theme hi-tech áp dụng cục bộ — không sync được tuning-store', {
          description: 'lỗi mạng',
        })
      })
  }, [on])

  // Nhãn = hành động bấm sẽ làm (off → "Hi-tech": bật; on → "Cổ điển": về cũ);
  // icon amber + aria-pressed = trạng thái hiện tại.
  return (
    <button
      onClick={toggle}
      title="Theme hi-tech: màn hình kính viền sáng (UX-5) — bật/tắt tức thì, sync tuning-store để audit"
      aria-pressed={on === null ? undefined : on}
      className={`w-full min-h-[44px] flex items-center gap-3 rounded-none border border-transparent transition-colors ${
        collapsed ? 'px-0 py-2.5 justify-center' : 'px-3 py-2.5'
      } hover:bg-cyan-950/40`}
    >
      <Sparkles className={`h-4 w-4 flex-shrink-0 ${on ? 'text-amber-400' : 'text-stone-400'}`} />
      {!collapsed && (
        <span className="text-[11px] font-medium text-stone-300">
          {on ? 'Cổ điển' : 'Hi-tech'}
        </span>
      )}
    </button>
  )
}

'use client'

// ============================================================================
// agent-status-pill — Pill badge trạng thái 5 mức cạnh tên agent trong header
// Hội thoại Smolab (Task 31-g).
//
// Chuẩn: docs/AGENT-STATUS-DISPLAY-STANDARD.md — nguồn sự thật cho màu (§2),
// hình dạng/vị trí/nhãn (§3), icon + tooltip (§4), thông báo trình đọc màn
// hình (§5). Logic ánh xạ trạng thái (PURE) nằm ở src/lib/agent-status.ts.
//
// Điểm chính theo doc:
//   §3  Pill 22px bo tròn, nội dung ICON + CHỮ, đặt sau tên agent 8px (ml-2),
//       cùng dòng, không bao giờ xuống dòng, LUÔN hiển thị (kể cả khi rảnh).
//       Header hẹp → giữ icon + nhãn ngắn (mobile < sm dùng nhãn rút gọn).
//   §2  Màu hex verbatim theo bảng (chữ/nền/viền đạt WCAG AA); màu KHÔNG phải
//       tín hiệu duy nhất — icon khác nhau theo trạng thái + luôn có chữ.
//   §3  Trạng thái chặn (ERROR, OFFLINE) kèm hành động nhỏ bên phải pill:
//       "Thử lại" (OFFLINE — poll lại gateway status) / "Xem lỗi" (ERROR —
//       cuộn tới bubble lỗi / panel run lỗi gần nhất).
//   §4  Pill focusable (tabindex 0) + role="status" + aria-label đầy đủ (tên
//       trạng thái + nội dung tooltip). Hover mở tooltip sau 300ms, focus mở
//       tức thì, Escape/rời focus đóng. Tooltip không phải nguồn duy nhất.
//   §5  Pill nằm trong vùng sống role="status" aria-live="polite" (ERROR dùng
//       "assertive"); thông điệp "Trạng thái agent X: …" chỉ phát khi trạng
//       thái THỰC SỰ đổi; trạng thái chặn kèm gợi ý hành động.
//
// Touch target ≥44px (ràng buộc dự án): pill hiển thị đúng 22px theo doc §3
// nhưng vùng chạm/mouse mở rộng bằng pseudo-element âm (không đổi layout).
// ============================================================================

import { useEffect, useId, useRef, useState } from 'react'
import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_SHORT_LABELS,
  AGENT_STATUS_TOOLTIPS,
  AGENT_STATUS_VISUALS,
  type AgentPillStatus,
} from '@/lib/agent-status'

export interface AgentStatusPillProps {
  /** Trạng thái hiện tại (từ mapToAgentStatus — src/lib/agent-status.ts). */
  status: AgentPillStatus
  /** Tên agent hiển thị (không avatar) cho thông báo trình đọc màn hình §5. */
  agentName: string
  /** OFFLINE → nút "Thử lại": poll lại gateway status ngay lập tức. */
  onRetryConnection?: () => void
  /** ERROR → nút "Xem lỗi": cuộn tới lỗi gần nhất trong khung chat. */
  onViewError?: () => void
  /** Class thêm cho wrapper (vd "ml-2 align-middle" khi đặt cạnh tên agent). */
  className?: string
}

/** Icon 10px theo trạng thái (doc §2) — màu = màu viền (quy ước doc §2). */
function StatusIcon({ status }: { status: AgentPillStatus }) {
  const v = AGENT_STATUS_VISUALS[status]
  // BUSY: mũi tên xoay (mũi tên cong quay theo chiều kim đồng hồ) — CSS only,
  // tôn trọng prefers-reduced-motion (motion-reduce tắt vòng xoay).
  if (v.icon === 'spinner') {
    return (
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        className="h-[10px] w-[10px] flex-shrink-0 animate-spin motion-reduce:animate-none"
      >
        <path
          d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"
          fill="none" stroke={v.border} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        />
        <path
          d="M21 3v5h-5"
          fill="none" stroke={v.border} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        />
      </svg>
    )
  }
  // ACTIVE: dấu tích tròn ĐẶC (vòng tròn tô + dấu tích khắc màu nền pill).
  if (v.icon === 'check-circle-filled') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden className="h-[10px] w-[10px] flex-shrink-0">
        <circle cx="12" cy="12" r="9" fill={v.border} />
        <path
          d="M7.5 12.5l3 3 6-6.5"
          fill="none" stroke={v.bg} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        />
      </svg>
    )
  }
  // IDLE: vòng tròn rỗng.
  if (v.icon === 'circle-hollow') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden className="h-[10px] w-[10px] flex-shrink-0">
        <circle cx="12" cy="12" r="9" fill="none" stroke={v.border} strokeWidth="2.5" />
      </svg>
    )
  }
  // ERROR: dấu chấm than trong tam giác.
  if (v.icon === 'warning-triangle') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden className="h-[10px] w-[10px] flex-shrink-0">
        <path
          d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
          fill="none" stroke={v.border} strokeWidth="2.5" strokeLinejoin="round"
        />
        <line x1="12" y1="9" x2="12" y2="14" stroke={v.border} strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="12" cy="17.2" r="1.2" fill={v.border} />
      </svg>
    )
  }
  // OFFLINE: đường kẻ chéo tròn.
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-[10px] w-[10px] flex-shrink-0">
      <circle cx="12" cy="12" r="9" fill="none" stroke={v.border} strokeWidth="2.5" />
      <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" stroke={v.border} strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Pill trạng thái 5 mức theo docs/AGENT-STATUS-DISPLAY-STANDARD.md.
 * Thuần presentational + tooltip/thông báo a11y — toàn bộ logic trạng thái
 * nằm trong mapToAgentStatus (pure, src/lib/agent-status.ts).
 */
export function AgentStatusPill({
  status,
  agentName,
  onRetryConnection,
  onViewError,
  className,
}: AgentStatusPillProps) {
  const v = AGENT_STATUS_VISUALS[status]
  const label = AGENT_STATUS_LABELS[status]
  const tooltip = AGENT_STATUS_TOOLTIPS[status]
  const tipId = useId()

  // ── Tooltip (doc §4): hover 300ms / focus tức thì / Escape + rời focus đóng ──
  const [showTip, setShowTip] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openTipDelayed = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setShowTip(true), 300)
  }
  const closeTip = () => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
    setShowTip(false)
  }
  useEffect(() => () => {
    // unmount: dọn timer hover tránh setState sau khi tháo
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
  }, [])

  // ── Thông báo trình đọc màn hình (doc §5): chỉ phát khi trạng thái ĐỔI ──
  const [announcement, setAnnouncement] = useState('')
  const prevStatusRef = useRef<AgentPillStatus | null>(null)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    if (prev === null || prev === status) return // không phát lúc mount / lặp
    const hint =
      status === 'OFFLINE' ? ' Dùng nút Thử lại để kết nối lại.' :
      status === 'ERROR' ? ' Dùng nút Xem lỗi để xem chi tiết.' : ''
    setAnnouncement(`Trạng thái agent ${agentName}: ${label}.${hint}`)
  }, [status, agentName, label])

  // Pill hiển thị 22px (doc §3) nhưng vùng chạm/mouse ≥44px — pseudo âm.
  const hitAreaCls = 'before:absolute before:-inset-y-[11px] before:-inset-x-1 before:content-[""]'

  // Doc §3 "pill bo tròn" — hệ thống design của app globals.css ép
  // `*, ::before, ::after { border-radius: 0 !important }` (angular design
  // system) → cần hậu tố `!` (Tailwind 4 important) để class (.rounded-full\!
  // specificity 0,1,0) thắng universal selector (0,0,0) cho RIÊNG pill này.
  const shapeCls = 'rounded-full!'

  return (
    // Vùng sống (doc §5): pill + thông báo nằm trong role="status";
    // ERROR → aria-live="assertive", còn lại "polite".
    <span
      role="status"
      aria-live={status === 'ERROR' ? 'assertive' : 'polite'}
      className={`inline-flex items-center gap-1.5 align-middle ${className ?? ''}`}
    >
      <span
        tabIndex={0}
        role="status"
        aria-label={`${label} — ${tooltip}`}
        aria-describedby={showTip ? tipId : undefined}
        onMouseEnter={openTipDelayed}
        onMouseLeave={closeTip}
        onFocus={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current); setShowTip(true) }}
        onBlur={closeTip}
        onKeyDown={(e) => { if (e.key === 'Escape') closeTip() }}
        style={{ color: v.text, backgroundColor: v.bg, borderColor: v.border }}
        className={`relative inline-flex h-[22px] flex-shrink-0 cursor-default select-none items-center gap-1 whitespace-nowrap ${shapeCls} border px-2 outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950 ${hitAreaCls}`}
      >
        <StatusIcon status={status} />
        <span className="text-[10px] font-medium leading-none tracking-tight">
          {/* Doc §3: header hẹp → nhãn ngắn (mobile compact); SR đọc đúng 1 nhãn */}
          <span className="sm:hidden">{AGENT_STATUS_SHORT_LABELS[status]}</span>
          <span className="hidden sm:inline">{label}</span>
        </span>

        {/* Tooltip (doc §4) — đặt DƯỚI pill: header nằm sát mép trên nc-panel
            overflow-hidden → tooltip hướng lên sẽ bị cắt. Style khớp dropdown
            console sẵn có của smolab (bg-slate-950/95 + viền mảnh). */}
        {showTip && (
          <span
            id={tipId}
            role="tooltip"
            className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 w-max max-w-[220px] border border-cyan-400/40 bg-slate-950/95 px-2 py-1 text-[10px] font-normal leading-snug tracking-normal text-stone-200"
          >
            {tooltip}
          </span>
        )}
      </span>

      {/* Trạng thái chặn (doc §3): hành động nhỏ bên phải pill */}
      {status === 'OFFLINE' && onRetryConnection && (
        <button
          type="button"
          onClick={onRetryConnection}
          aria-label="Thử lại — kiểm tra kết nối agent"
          className={`relative inline-flex h-[22px] flex-shrink-0 items-center gap-1 whitespace-nowrap ${shapeCls} border border-stone-500/60 bg-slate-950/60 px-2 text-[10px] font-medium leading-none text-stone-300 transition-colors hover:border-cyan-400/60 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${hitAreaCls}`}
        >
          ↻ Thử lại
        </button>
      )}
      {status === 'ERROR' && onViewError && (
        <button
          type="button"
          onClick={onViewError}
          aria-label="Xem lỗi — cuộn tới phản hồi lỗi gần nhất"
          className={`relative inline-flex h-[22px] flex-shrink-0 items-center gap-1 whitespace-nowrap ${shapeCls} border border-stone-500/60 bg-slate-950/60 px-2 text-[10px] font-medium leading-none text-stone-300 transition-colors hover:border-amber-400/60 hover:text-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 ${hitAreaCls}`}
        >
          ⚠ Xem lỗi
        </button>
      )}

      {/* Thông báo cho trình đọc màn hình (doc §5) — sr-only, đổi nội dung
          chỉ khi trạng thái đổi → vùng sống phát đúng 1 lần mỗi chuyển. */}
      <span className="sr-only">{announcement}</span>
    </span>
  )
}

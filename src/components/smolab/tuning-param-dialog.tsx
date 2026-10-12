'use client'

// ========================================================================
// tuning-param-dialog — Dialog chỉnh 1 tham số runtime (BRAIN-LIVE, 15-b)
// ========================================================================
//
// Bối cảnh (chỉ thị user 2026-10-12): cột "Hành động" của bảng Tham số
// runtime trước đây chỉ bấm mũi tên → selection nhảy lên inspector phía
// trên → user phải CUỘN LÊN mới thấy ô chỉnh — phiền. Dialog này mở chỉnh
// ngay tại chỗ rồi đóng lại (task 15-d sẽ wiring vào tab BRAIN mới; bảng
// tuning trong neural-architecture-section cũng dùng lại được).
//
// THUẦN PRESENTATIONAL — không fetch, không state server: mọi POST SET/RESET
// do caller thực hiện qua onSet/onReset (pattern withSaving sẵn ở section đã
// có toast lỗi nếu POST fail — dialog đóng optimistic ngay khi bấm).
//
// Type TuningStateEntry import từ '@/lib/learning/neural-types' (thuần —
// client-safe). KHÔNG import qua barrel '@/lib/learning' vì barrel re-export
// tuning-store (kéo Prisma vào client bundle).
// ========================================================================

import { useState } from 'react'
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { TuningSpec, TuningStateEntry } from '@/lib/learning/neural-types'
import { parseTuningInput } from '@/lib/learning/tuning-input'

// ---------------------------------------------------------------------------
// SOURCE_BADGE — nguồn chung cho các UI tuning phía Smolab (export từ 15-d).
// Bản gốc là hằng số cục bộ trong neural-architecture-section.tsx (file đó
// giữ bản riêng cho bảng tuning/inspector của tab Kiến trúc — không đổi để
// không kéo dependency database↔smolab). Giữ class giống hệt bản gốc để
// badge nhìn như nhau mọi nơi. Đổi nhãn/màu: đổi ở ĐÚNG 2 nơi (đây + section)
// — cùng tinh thần JSDoc tuning-input (đồng bộ 2 chiều có chủ đích).
// ---------------------------------------------------------------------------
export const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  store:   { label: 'đã đặt',  cls: 'bg-emerald-950/70 text-emerald-400 border-emerald-500/45' },
  env:     { label: 'env',      cls: 'bg-cyan-950/70 text-cyan-400 border-cyan-500/45' },
  default: { label: 'mặc định', cls: 'bg-slate-950/70 text-stone-400 border-stone-600/50' },
}

export interface TuningParamDialogProps {
  /** Dialog đang mở (controlled — Radix lo Esc/overlay/focus-trap). */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Dòng tuning hiện tại (null = chưa chọn — dialog không render gì). */
  param: TuningStateEntry | null
  /** Spec tham số — caller lấy qua getTuningSpec(param.key) (neural-types, client-safe). */
  spec: TuningSpec | null
  /** Tên nút đồ thị hiển thị trong header (thuần label — không bấm). */
  nodeTitle?: string
  /** Đang POST SET/RESET key này (disable nút Lưu/Về mặc định + input). */
  saving: boolean
  /** POST SET — caller lo toast lỗi nếu fail (dialog đã đóng optimistic). */
  onSet: (key: string, value: number | string) => void
  /** POST RESET — caller lo toast lỗi nếu fail. */
  onReset: (key: string) => void
}

export function TuningParamDialog({
  open,
  onOpenChange,
  param,
  spec,
  nodeTitle,
  saving,
  onSet,
  onReset,
}: TuningParamDialogProps) {
  // Draft (string) — khởi tạo lại bằng giá trị HIỆU LỰC mỗi lần mở dialog
  // hoặc đổi param (kỹ thuật "set state khi prop đổi" của React — KHÔNG dùng
  // effect vì react-hooks/set-state-in-effect cấm). Chỉ theo dõi `open` +
  // `param.key`: refetch nền đổi identity param (cùng key) sẽ KHÔNG xoá draft
  // user đang gõ dở.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [draft, setDraft] = useState('')
  const [lastKey, setLastKey] = useState<string | null>(null)
  const activeKey = open && param ? param.key : null
  if (activeKey !== lastKey) {
    setLastKey(activeKey)
    setDraft(param ? String(param.effectiveValue) : '')
  }

  if (!open || !param || !spec) return null

  const parsed = parseTuningInput(spec, draft)
  const showNumberError = spec.type === 'number' && !parsed.ok && draft.trim() !== ''
  // "Đổi" so với giá trị HIỆU LỰC theo giá trị (không theo chuỗi):
  // '0.50' so với 0.5 là KHÔNG đổi → Lưu disabled.
  const dirty = parsed.ok && parsed.value !== param.effectiveValue
  const canSave = parsed.ok && dirty && !saving

  const src = SOURCE_BADGE[param.source] ?? SOURCE_BADGE.default
  const inputId = `tuning-input-${param.key}`
  const errorId = `${inputId}-error`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md dialog-scrollbar max-h-[85vh] overflow-y-auto bg-slate-950/95 border-stone-700 text-stone-200">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-stone-100">
            {param.label}
            {spec.unit ? <span className="text-[10px] font-normal text-stone-500">({spec.unit})</span> : null}
          </DialogTitle>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px] leading-relaxed text-stone-600">
            <span>{param.key}</span>
            {nodeTitle ? <span className="text-stone-500">· nút: {nodeTitle}</span> : null}
          </div>
          <DialogDescription className="text-xs leading-relaxed text-stone-400">
            {spec.description}
          </DialogDescription>
        </DialogHeader>

        {/* Cảnh báo spec (vd điểm dừng #5) — khối vàng, role="note" */}
        {spec.warning ? (
          <div
            role="note"
            className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-950/30 px-2.5 py-2 text-[10px] leading-relaxed text-amber-300/90"
          >
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            <span>{spec.warning}</span>
          </div>
        ) : null}

        {/* Trạng thái hiện tại: giá trị hiệu lực + badge nguồn + mặc định */}
        <div className="space-y-1 rounded-md border border-slate-800 bg-slate-950/60 px-2.5 py-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-stone-500">Hiệu lực hiện tại:</span>
            <span className="font-mono text-stone-100">
              {String(param.effectiveValue)}
              {spec.unit ? ` ${spec.unit}` : ''}
            </span>
            <Badge variant="outline" className={`h-3.5 px-1 text-[9px] ${src.cls}`}>{src.label}</Badge>
          </div>
          <p className="text-stone-500">
            Mặc định: <span className="font-mono text-stone-400">{String(spec.default)}{spec.unit ? ` ${spec.unit}` : ''}</span>
            {param.storeValue !== null ? (
              <>
                {' '}· override store: <span className="font-mono text-stone-400">{param.storeValue}</span>
              </>
            ) : null}
          </p>
        </div>

        {/* Editor theo type */}
        {spec.type === 'number' ? (
          <div className="space-y-1.5">
            <label htmlFor={inputId} className="text-[11px] font-medium text-stone-300">
              Giá trị mới
            </label>
            <Input
              id={inputId}
              type="number"
              inputMode="decimal"
              className="h-9 border-stone-700 bg-slate-950/70 font-mono text-xs text-stone-100"
              min={spec.min}
              max={spec.max}
              step={spec.step}
              value={draft}
              disabled={saving}
              onChange={e => setDraft(e.target.value)}
              aria-invalid={showNumberError}
              aria-describedby={showNumberError ? errorId : undefined}
            />
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[10px]">
              <span className="text-stone-500">
                Phạm vi [{spec.min ?? '-∞'}, {spec.max ?? '+∞'}]{spec.step ? ` · bước ${spec.step}` : ''}
                {spec.unit ? ` · đơn vị ${spec.unit}` : ''}
              </span>
              {showNumberError ? (
                <span id={errorId} role="alert" className="text-red-400">
                  {parsed.error}
                </span>
              ) : parsed.ok && !dirty ? (
                <span className="text-stone-600">Chưa đổi so với giá trị hiệu lực</span>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <span className="text-[11px] font-medium text-stone-300" id={`${inputId}-label`}>
              Chọn giá trị
            </span>
            {/* Fallback defensive: enum spec thiếu enumValues (hợp đồng spec
                nói enum PHẢI có) → input text tự do, parse sẽ chặn Lưu. */}
            {(spec.enumValues ?? []).length === 0 ? (
              <Input
                type="text"
                className="h-9 border-stone-700 bg-slate-950/70 font-mono text-xs text-stone-100"
                value={draft}
                disabled={saving}
                onChange={e => setDraft(e.target.value)}
                aria-labelledby={`${inputId}-label`}
              />
            ) : (
              <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={`${inputId}-label`}>
                {(spec.enumValues ?? []).map(v => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={draft === v}
                    disabled={saving}
                    onClick={() => setDraft(v)}
                    className={cn(
                      'min-h-[44px] rounded-md border px-3 py-1.5 font-mono text-[11px] transition-colors disabled:opacity-50 md:min-h-[32px]',
                      draft === v
                        ? 'border-cyan-500/45 bg-cyan-950/70 text-cyan-300'
                        : 'border-stone-700 bg-slate-950/70 text-stone-400 hover:border-stone-500 hover:text-stone-200',
                    )}
                  >
                    {v}
                  </button>
                ))}
              </div>
            )}
            <p className="text-[10px] text-stone-500">
              {parsed.ok && !dirty
                ? 'Chưa đổi so với giá trị hiệu lực'
                : parsed.ok
                  ? `Áp dụng tức thì · chuỗi hiệu lực STORE › ENV › DEFAULT`
                  : null}
            </p>
          </div>
        )}

        <DialogFooter className="gap-2">
          {param.storeValue !== null ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-stone-400 hover:text-amber-400 sm:mr-auto"
              disabled={saving}
              aria-label={`Trả ${param.label} về mặc định`}
              onClick={() => {
                onReset(param.key)
                onOpenChange(false)
              }}
            >
              <RotateCcw className="h-3 w-3" /> Về mặc định
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-stone-400"
            onClick={() => onOpenChange(false)}
          >
            Đóng
          </Button>
          <Button
            type="button"
            size="sm"
            className="bg-cyan-600 text-white hover:bg-cyan-700"
            disabled={!canSave}
            aria-label={`Lưu ${param.label}`}
            onClick={() => {
              if (!parsed.ok) return
              onSet(param.key, parsed.value)
              onOpenChange(false)
            }}
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

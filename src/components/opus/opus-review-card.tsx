'use client'

/**
 * OPUS REVIEW CARD (Task 13-c) — card hiển thị verdict của ⚖️ Opus (CTO meta-agent)
 * ngay dưới assistant message đã được review trong Smolab chat.
 *
 * Verdict 5 động từ (CONTINUE/FIX/REDIRECT/ESCALATE/STOP) + 5 trục đánh giá +
 * Issue Ledger + Directive 6 trường + predicate STOP 4 điều kiện — mirror đúng
 * API contract Task 13-b (src/lib/opus/types.ts, serializeOpusReview).
 *
 * Thiết kế ngôn ngữ visual TMO: nền slate-950/60, viền amber-400/35,
 * custom-scrollbar — TUYỆT ĐỐI KHÔNG dùng indigo/blue (cyan cho phép).
 */

import { useState } from 'react'
import { Scale, Gavel, Loader2, Users } from 'lucide-react'
import { toast } from '@/hooks/use-toast'

// ==================== TYPES (mirror API contract 13-b) ====================

export type OpusDecision = 'CONTINUE' | 'FIX' | 'REDIRECT' | 'ESCALATE' | 'STOP'

export interface OpusAxis {
  score: number
  note: string
}

export interface OpusIssue {
  title: string
  severity: 'blocking' | 'major' | 'minor' | 'nit'
  evidence: string
  suggestedFix?: string
}

export interface OpusDirective {
  goal: string
  rationale: string
  scope: string
  delegation: string
  acceptanceCriteria: string[]
  budgetHint?: string
}

export interface OpusStopAssessment {
  ledgerClean: boolean
  verificationGreen: boolean
  specSatisfied: boolean
  noNewBlocking: boolean
  allMet: boolean
  notes?: string
}

export interface OpusVerdict {
  decision: OpusDecision
  summary: string
  axes: {
    specCompliance: OpusAxis
    processQuality: OpusAxis
    verification: OpusAxis
    riskDebt: OpusAxis
    reportHonesty: OpusAxis
  }
  issues: OpusIssue[]
  directive: OpusDirective
  rationale: string
  evidenceRefs: string[]
  stopAssessment: OpusStopAssessment
}

/** Review đã serialize từ GET/POST API (verdict là object đã parse) */
export interface OpusReviewSerialized {
  id: string
  sessionId: string
  runRef: string | null
  messageId: string | null
  decision: string
  verdict: OpusVerdict | null
  triggerMode: string
  model: string | null
  tokensUsed: number | null
  durationMs: number | null
  createdAt: string
}

// ==================== DECISION BADGE (dùng chung với directive card) ====================

/** Màu badge theo 5 động từ — đậm màu, export cho page.tsx tái dùng (directive card) */
export function opusDecisionBadgeClass(decision: string): string {
  switch (decision) {
    case 'CONTINUE':
      return 'bg-emerald-500/90 text-white border-emerald-300/40'
    case 'FIX':
      return 'bg-amber-500/90 text-amber-950 border-amber-300/40'
    case 'REDIRECT':
      return 'bg-violet-500/90 text-white border-violet-300/40'
    case 'ESCALATE':
      return 'bg-cyan-500/90 text-cyan-950 border-cyan-300/40'
    case 'STOP':
      return 'bg-rose-500/90 text-white border-rose-300/40'
    default:
      return 'bg-stone-600/90 text-white border-stone-400/40'
  }
}

/** 5 trục đánh giá theo đúng thứ tự §IV OPUS_INSTRUCTION */
const OPUS_AXES: Array<{ key: keyof OpusVerdict['axes']; label: string }> = [
  { key: 'specCompliance', label: 'Spec' },
  { key: 'processQuality', label: 'Quy trình' },
  { key: 'verification', label: 'Kiểm định' },
  { key: 'riskDebt', label: 'Rủi ro & Nợ' },
  { key: 'reportHonesty', label: 'Trung thực báo cáo' },
]

/** Màu score bar theo điểm 0-10 (>=8 xanh / >=5 vàng / <5 đỏ) */
function scoreBarColor(score: number): string {
  if (score >= 8) return 'bg-emerald-400'
  if (score >= 5) return 'bg-amber-400'
  return 'bg-rose-400'
}

/** Badge severity cho issue của Issue Ledger */
function severityBadgeClass(severity: string): string {
  switch (severity) {
    case 'blocking':
      return 'bg-rose-500 text-white border border-rose-300/40'
    case 'major':
      return 'bg-amber-500/20 text-amber-300 border border-amber-400/50'
    case 'minor':
      return 'bg-stone-700/50 text-stone-300 border border-stone-500/50'
    default: // 'nit'
      return 'bg-stone-800/60 text-stone-400 border border-stone-600/50'
  }
}

/** 4 điều kiện predicate STOP (§VII) — tên hiển thị tiếng Việt */
const STOP_CONDITIONS: Array<{ key: keyof OpusStopAssessment; label: string }> = [
  { key: 'ledgerClean', label: 'Sổ vấn đề sạch' },
  { key: 'verificationGreen', label: 'Kiểm định toàn xanh' },
  { key: 'specSatisfied', label: 'Spec gốc đạt' },
  { key: 'noNewBlocking', label: 'Không issue blocking mới' },
]

/** Các decision có thể ban hành chỉ đạo (mirror DISPATCHABLE_DECISIONS backend) */
const DISPATCHABLE_DECISIONS = ['CONTINUE', 'FIX', 'REDIRECT']

// ==================== COMPONENT ====================

interface OpusReviewCardProps {
  review: OpusReviewSerialized
  /** true khi chỉ đạo của review này đã được ban hành vào chat */
  dispatched?: boolean
  /** Callback sau khi ban hành thành công — parent refresh messages */
  onDispatched?: (msg: unknown) => void
}

export default function OpusReviewCard({ review, dispatched, onDispatched }: OpusReviewCardProps) {
  const [dispatching, setDispatching] = useState(false)
  const [dispatchDone, setDispatchDone] = useState(!!dispatched)

  const verdict = review.verdict
  const dispatchable = DISPATCHABLE_DECISIONS.includes(review.decision)

  // Ban hành chỉ đạo: POST /api/opus/dispatch { reviewId } → chèn directive
  // message vào chat + enqueue goal-loop job.
  // FIX (400-conflation): backend giờ trả { error, code } — CHỈ code
  // 'already_dispatched' mới là "đã ban hành" (sync UI xanh); các code khác
  // (stop_guard / invalid_verdict / not_found / insert_failed) là lỗi thật —
  // hiện message thật để user biết phải làm gì (vd chạy lại "Opus review").
  const handleDispatch = async () => {
    setDispatching(true)
    try {
      const res = await fetch('/api/opus/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewId: review.id }),
      })
      if (res.status === 400 || res.status === 404 || res.status === 409) {
        const errData = (await res.json().catch(() => ({} as { error?: string; code?: string }))) as {
          error?: string
          code?: string
        }
        if (errData?.code === 'already_dispatched') {
          // Đã ban hành trước đó — sync UI về trạng thái đúng, không coi là lỗi
          setDispatchDone(true)
          toast({ title: 'Chỉ đạo đã được ban hành trước đó', duration: 3000 })
          return
        }
        // Lỗi thật (stop_guard / invalid_verdict / not_found / insert_failed)
        throw new Error(errData?.error || `HTTP ${res.status}`)
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({} as { error?: string }))
        throw new Error(errData?.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setDispatchDone(true)
      toast({
        title: '⚖️ Đã ban hành chỉ đạo Opus',
        description: 'Chỉ đạo đã vào chat — agent bắt đầu thực thi theo chỉ đạo.',
        duration: 4000,
      })
      onDispatched?.(data?.message ?? null)
    } catch (err) {
      toast({
        title: 'Không ban hành được chỉ đạo',
        description: err instanceof Error ? err.message : 'Lỗi hệ thống — thử lại sau.',
        variant: 'destructive',
        duration: 6000,
      })
    } finally {
      // FIX: reset LUÔN (kể cả return sớm ở nhánh already_dispatched) —
      // trước đây return sớm bỏ reset → button kẹt "Đang ban hành…" vĩnh viễn.
      setDispatching(false)
    }
  }

  return (
    <div className="w-full bg-slate-950/60 border border-amber-400/35 p-2.5">
      {/* Header — ⚖️ OPUS — REVIEW + decision badge + triggerMode + thời gian */}
      <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
        <Scale className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />
        <span className="text-[11px] font-semibold text-amber-300">⚖️ OPUS — REVIEW</span>
        <span className={`text-[9px] font-bold px-1.5 py-0.5 border ${opusDecisionBadgeClass(review.decision)}`}>
          {review.decision}
        </span>
        <span className="text-[9px] px-1 py-0.5 border border-stone-600/60 text-stone-400">
          {review.triggerMode === 'auto' ? 'auto' : 'manual'}
        </span>
        <span className="text-[9px] text-stone-500 ml-auto">
          {new Date(review.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {verdict ? (
        <>
          {/* Summary — 1-2 câu tổng kết cho Mr. Architect */}
          {verdict.summary && (
            <p className="text-xs italic text-stone-200 mb-1.5">{verdict.summary}</p>
          )}

          {/* 5 trục đánh giá — score bar + điểm + note */}
          <div className="space-y-1 mb-1.5">
            {OPUS_AXES.map(({ key, label }) => {
              const axis = verdict.axes?.[key]
              if (!axis) return null
              const score = typeof axis.score === 'number' ? axis.score : 0
              return (
                <div key={key} className="flex items-center gap-1.5">
                  <span className="text-[10px] text-stone-300 w-[118px] flex-shrink-0 truncate" title={label}>
                    {label}
                  </span>
                  <div className="flex-1 h-1 bg-stone-800 overflow-hidden">
                    <div
                      className={`h-full ${scoreBarColor(score)} transition-all`}
                      style={{ width: `${Math.max(0, Math.min(10, score)) * 10}%` }}
                    />
                  </div>
                  <span className={`text-[10px] font-medium w-6 text-right flex-shrink-0 ${scoreBarColor(score).replace('bg-', 'text-')}`}>
                    {axis.score % 1 === 0 ? score.toFixed(0) : score.toFixed(1)}
                  </span>
                  <span className="text-[10px] text-stone-400 flex-1 truncate" title={axis.note}>
                    {axis.note}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Issues — Issue Ledger từ verdict */}
          {verdict.issues && verdict.issues.length > 0 && (
            <div className="space-y-1 mb-1.5">
              {verdict.issues.map((issue, i) => (
                <div key={i} className="border border-stone-700/40 bg-stone-900/30 p-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 flex-shrink-0 ${severityBadgeClass(issue.severity)}`}>
                      {issue.severity}
                    </span>
                    <span className="text-xs font-semibold text-stone-100">{issue.title}</span>
                  </div>
                  {issue.evidence && (
                    <div className="text-[10px] italic text-stone-400 whitespace-pre-wrap mt-1 custom-scrollbar max-h-16 overflow-y-auto">
                      {issue.evidence}
                    </div>
                  )}
                  {issue.suggestedFix && (
                    <div className="text-[10px] text-emerald-300/70 mt-1">→ Sửa: {issue.suggestedFix}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Directive block — CONTINUE/FIX/REDIRECT (khung amber) */}
          {(review.decision === 'CONTINUE' || review.decision === 'FIX' || review.decision === 'REDIRECT') && verdict.directive && (
            <div className="mt-2 p-2 border border-amber-400/25 bg-amber-950/10">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-400/80 mb-1">📣 Chỉ đạo</div>
              {verdict.directive.goal && (
                <div className="text-[11px] text-stone-100">
                  <span className="font-semibold">Mục tiêu:</span> {verdict.directive.goal}
                </div>
              )}
              {verdict.directive.rationale && (
                <div className="text-[11px] text-stone-300 mt-0.5">
                  <span className="font-semibold">Lý do:</span> {verdict.directive.rationale}
                </div>
              )}
              {verdict.directive.scope && (
                <div className="text-[11px] text-stone-300 mt-0.5">
                  <span className="font-semibold">Phạm vi:</span> {verdict.directive.scope}
                </div>
              )}
              {verdict.directive.delegation && (
                <div className="text-[11px] text-stone-300 mt-0.5 flex items-start gap-1">
                  <Users className="h-3 w-3 mt-0.5 flex-shrink-0 text-amber-400/70" />
                  <span><span className="font-semibold">Phân công:</span> {verdict.directive.delegation}</span>
                </div>
              )}
              {verdict.directive.acceptanceCriteria && verdict.directive.acceptanceCriteria.length > 0 && (
                <div className="mt-1">
                  <div className="text-[10px] font-semibold text-emerald-300/80 mb-0.5">Tiêu chí nghiệm thu</div>
                  <ul className="list-disc list-inside text-[11px] text-emerald-300/80 space-y-0.5">
                    {verdict.directive.acceptanceCriteria.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}
              {verdict.directive.budgetHint && (
                <div className="text-[10px] text-stone-400 mt-1">Ngân sách đề xuất: {verdict.directive.budgetHint}</div>
              )}
            </div>
          )}

          {/* ESCALATE — câu hỏi cho Mr. Architect (khung cyan) */}
          {review.decision === 'ESCALATE' && (
            <div className="mt-2 p-2 border border-cyan-400/30 bg-cyan-950/10">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-cyan-400/80 mb-1">❓ Câu hỏi cho Mr. Architect</div>
              {verdict.directive?.goal && (
                <div className="text-[11px] font-semibold text-stone-100">{verdict.directive.goal}</div>
              )}
              {verdict.rationale && (
                <div className="text-[11px] text-stone-300 mt-1 whitespace-pre-wrap">{verdict.rationale}</div>
              )}
            </div>
          )}

          {/* STOP — predicate 4 điều kiện (khung emerald) */}
          {review.decision === 'STOP' && verdict.stopAssessment && (
            <div className="mt-2 p-2 border border-emerald-400/30 bg-emerald-950/10">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400/80 mb-1">
                🏁 Điều kiện dừng {verdict.stopAssessment.allMet ? '— ĐỦ 4/4, STOP hợp lệ' : ''}
              </div>
              <div className="space-y-0.5">
                {STOP_CONDITIONS.map(({ key, label }) => {
                  const met = verdict.stopAssessment?.[key] === true
                  return (
                    <div key={key} className="flex items-center gap-1.5 text-[11px]">
                      <span className={met ? 'text-emerald-400' : 'text-rose-400'}>{met ? '✓' : '✗'}</span>
                      <span className={met ? 'text-stone-200' : 'text-rose-300/90'}>{label}</span>
                    </div>
                  )
                })}
              </div>
              {verdict.stopAssessment.notes && (
                <div className="text-[10px] italic text-stone-400 mt-1">{verdict.stopAssessment.notes}</div>
              )}
            </div>
          )}

          {/* evidenceRefs — chip tham chiếu bằng chứng */}
          {verdict.evidenceRefs && verdict.evidenceRefs.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {verdict.evidenceRefs.map((ref, i) => (
                <span key={i} className="text-[9px] px-1.5 py-0.5 border border-stone-700 text-stone-400 truncate max-w-[200px]" title={ref}>
                  {ref}
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="text-[11px] text-stone-400 italic">Verdict chưa có dữ liệu (parse lỗi phía server).</p>
      )}

      {/* Footer — nút Ban hành chỉ đạo (manual mode) / badge Đã ban hành */}
      {dispatchable && (
        <div className="mt-2 pt-2 border-t border-amber-400/20 flex items-center gap-2 flex-wrap">
          {dispatchDone ? (
            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 bg-emerald-500/15 text-emerald-300 border border-emerald-400/40">
              Đã ban hành ✓
            </span>
          ) : (
            <button
              onClick={() => { void handleDispatch() }}
              disabled={dispatching}
              className="chamfer-sm border border-amber-400/50 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 text-[10px] px-2.5 py-1 flex items-center gap-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Chèn chỉ đạo vào chat + chạy agent theo chỉ đạo của Opus"
            >
              {dispatching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Gavel className="h-3 w-3" />}
              {dispatching ? 'Đang ban hành…' : 'Ban hành chỉ đạo'}
            </button>
          )}
          <span className="text-[9px] text-stone-500 ml-auto">
            {review.durationMs != null ? `${(review.durationMs / 1000).toFixed(1)}s` : ''}
            {review.model ? ` · ${review.model.split('/').pop()}` : ''}
          </span>
        </div>
      )}
    </div>
  )
}

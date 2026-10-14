'use client'

/**
 * DEBT LEDGER PANEL — R15 (P-R13-2 + BUG2-239 — "UI panel sổ nợ" chờ user từ R13)
 * ============================================================================
 *
 * Panel theo dõi SỔ NỢ KỸ THUẬT (DebtLedger) + PHANH TUẦN TỰ sub-agent —
 * mount trong tab Analytics của module Database (page.tsx):
 *   - Đầu panel: 4 thẻ counts (open / in_progress / resolved / parked)
 *   - PHANH TUẦN TỰ (R14/R15): maxConcurrent, busy/waiting, phân phối waitedMs
 *     (p50/p95/max — dữ liệu quyết định kill-switch SUBAGENT_MAX_CONCURRENT)
 *   - Nợ đang mở: title + attempts + recurrence + nguồn — nút hành động
 *     Resolve / Reopen / Park (PATCH /api/debt/status — can thiệp của
 *     thầy/user, user directive R13 "giám sát có giám sát")
 *   - Nợ đã park (chờ điều kiện) + 10 nợ resolved gần nhất (đối chiếu hiệu quả)
 *
 * Poll GET /api/debt/status mỗi 15s. Fail-open toàn bộ: lỗi → "—", không crash.
 * KHÔNG dùng indigo/blue (chuẩn UI TMO). Danh sách dài: max-h + overflow-y-auto.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Loader2, RefreshCw, NotebookPen, Gauge, CheckCircle2, PauseCircle, RotateCcw, Archive } from 'lucide-react'

// ==================== Types (mirror /api/debt/status) ====================

interface SlotPoolInfo {
  maxConcurrent: number
  source: 'env' | 'default'
  zenKeys: number
  busySlots: number
  waiting: number
  queueStats: {
    acquires: number
    queued: number
    waitedMsAvg: number | null
    waitedMsMax: number | null
    p50WaitedMs: number | null
    p95WaitedMs: number | null
    recentSamples: number
  }
}

interface DebtRow {
  id: string
  title: string
  kind: string
  /** R15: severity hết "cột chết" — 'high' = infra hoặc tái phát ≥2 lần */
  severity?: string
  status: string
  attempts: number
  recurrenceCount: number
  originSessionId: string | null
  lastSeenAt: string | null
  createdAt: string | null
  parkReason?: string | null
  resolutionEvidence?: string | null
}

interface DebtStatus {
  ok: boolean
  enabled: boolean
  config: {
    maxPickupAttempts: number
    globalPickupLimit: number
    globalMinAgeMin: number
    sweepStaleDays: number
  }
  slotPool: SlotPoolInfo | null
  counts: { open: number; in_progress: number; resolved: number; parked: number }
  open: DebtRow[]
  parked: DebtRow[]
  recentResolved: DebtRow[]
}

// ==================== Helpers ====================

function fmtWait(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
  } catch {
    return '—'
  }
}

function statusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case 'open':
      return { label: 'mở', className: 'bg-amber-950/60 text-amber-400 border-amber-500/50' }
    case 'in_progress':
      return { label: 'đang xử lý', className: 'bg-teal-950/60 text-teal-400 border-teal-500/50' }
    case 'resolved':
      return { label: 'đã giải quyết', className: 'bg-emerald-950/60 text-emerald-400 border-emerald-500/50' }
    case 'parked':
      return { label: 'đã park', className: 'bg-stone-800/80 text-stone-400 border-stone-600/60' }
    default:
      return { label: status, className: 'bg-stone-800/80 text-stone-400 border-stone-600/60' }
  }
}

// ==================== Component ====================

export function DebtLedgerPanel() {
  const [data, setData] = useState<DebtStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [actingId, setActingId] = useState<string | null>(null)
  const aliveRef = useRef(true)

  const fetchStatus = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true)
    try {
      const res = await fetch('/api/debt/status', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as DebtStatus
      if (aliveRef.current) setData(json)
    } catch {
      // fail-open — giữ data cũ, hiển thị "—" khi null
      if (aliveRef.current && !silent) setData(d => d) // no-op giữ nguyên
    } finally {
      if (aliveRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    // Pattern async-wrapper như runtime-metrics-panel (react-hooks
    // set-state-in-effect): setState chỉ xảy ra SAU await trong fetchStatus.
    const poll = async () => { await fetchStatus(true) }
    void poll()
    const timer = setInterval(() => { void poll() }, 15_000)
    return () => { aliveRef.current = false; clearInterval(timer) }
  }, [fetchStatus])

  /** PATCH /api/debt/status — can thiệp thủ công của thầy/user */
  const act = useCallback(async (id: string, action: 'resolve' | 'reopen' | 'park') => {
    setActingId(id)
    try {
      const res = await fetch('/api/debt/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      })
      const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null
      if (!res.ok || !json?.ok) {
        toast.error(`Không ${action} được nợ`, { description: json?.error ?? `HTTP ${res.status}` })
      } else {
        toast.success(
          action === 'resolve' ? 'Đã đóng nợ (resolvedBy=user)' : action === 'reopen' ? 'Đã mở lại (attempts=0)' : 'Đã park — dừng thử',
        )
        await fetchStatus(true)
      }
    } catch (err) {
      toast.error('Lỗi mạng khi PATCH', { description: err instanceof Error ? err.message : 'unknown' })
    } finally {
      setActingId(null)
    }
  }, [fetchStatus])

  const c = data?.counts
  const sp = data?.slotPool ?? null
  const cfg = data?.config

  return (
    <Card className="nc-panel nc-md nc-border-amber">
      <CardContent className="pt-5 pb-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600"><NotebookPen className="h-4 w-4 text-white" /></div>
            <div>
              <h3 className="text-sm font-semibold tracking-tight text-stone-100">📒 Sổ nợ kỹ thuật — DebtLedger</h3>
              <p className="text-[11px] text-stone-400">
                Vòng đời nợ khép kín (R13): pickup → resolved/parked · can thiệp thủ công của thầy · poll 15s
                {!cfg ? '' : ` · park sau ${cfg.maxPickupAttempts} lần thử · tối đa ${cfg.globalPickupLimit} nợ/run`}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => void fetchStatus()} disabled={refreshing}>
            {refreshing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            Làm mới
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-stone-400 text-xs"><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Đang tải sổ nợ…</div>
        ) : !data || !data.ok ? (
          <div className="py-8 text-center text-xs text-stone-400">
            <PauseCircle className="h-5 w-5 mx-auto mb-2 text-stone-500" />
            Không đọc được /api/debt/status — panel fail-open, thử Làm mới.
          </div>
        ) : (
          <>
            {/* Counts + Phanh tuần tự */}
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
              <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3">
                <div className="text-[10px] uppercase tracking-wider text-amber-400/80">Đang mở</div>
                <div className="text-xl font-bold text-amber-300">{c ? (c.open ?? 0) : '—'}</div>
              </div>
              <div className="rounded-xl border border-teal-500/30 bg-teal-950/20 p-3">
                <div className="text-[10px] uppercase tracking-wider text-teal-400/80">Đang xử lý</div>
                <div className="text-xl font-bold text-teal-300">{c ? (c.in_progress ?? 0) : '—'}</div>
              </div>
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3">
                <div className="text-[10px] uppercase tracking-wider text-emerald-400/80">Đã giải quyết</div>
                <div className="text-xl font-bold text-emerald-300">{c ? (c.resolved ?? 0) : '—'}</div>
              </div>
              <div className="rounded-xl border border-stone-600/40 bg-stone-900/40 p-3">
                <div className="text-[10px] uppercase tracking-wider text-stone-400">Đã park</div>
                <div className="text-xl font-bold text-stone-300">{c ? (c.parked ?? 0) : '—'}</div>
              </div>
              <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-3 col-span-2">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-rose-400/80"><Gauge className="h-3 w-3" /> Phanh tuần tự sub-agent</div>
                {sp ? (
                  <div className="mt-0.5 flex items-baseline gap-2 flex-wrap">
                    <span className="text-lg font-bold text-rose-200">{sp.busySlots}/{sp.maxConcurrent} slot</span>
                    <span className="text-[10px] text-stone-400">nguồn {sp.source === 'env' ? 'env (kill-switch)' : 'default=1'}</span>
                    {sp.waiting > 0 && <Badge className="bg-rose-950/70 text-rose-300 border-rose-500/50 text-[10px] px-1.5">{sp.waiting} đang chờ</Badge>}
                  </div>
                ) : (
                  <div className="text-xl font-bold text-stone-500">—</div>
                )}
              </div>
            </div>

            {/* Phân phối chờ hàng đợi — dữ liệu quyết định kill-switch */}
            {sp && (
              <div className="mt-2.5 rounded-xl border border-stone-700/40 bg-slate-950/40 p-3">
                <div className="text-[10px] uppercase tracking-wider text-stone-400 mb-1.5">
                  Phân phối chờ hàng đợi (waitedMs — {sp.queueStats.queued}/{sp.queueStats.acquires} lượt phải xếp hàng, {sp.queueStats.recentSamples} mẫu gần nhất)
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div><span className="text-stone-500">TB:</span> <span className="font-semibold text-stone-200">{fmtWait(sp.queueStats.waitedMsAvg)}</span></div>
                  <div><span className="text-stone-500">p50:</span> <span className="font-semibold text-stone-200">{fmtWait(sp.queueStats.p50WaitedMs)}</span></div>
                  <div><span className="text-stone-500">p95:</span> <span className={`font-semibold ${(sp.queueStats.p95WaitedMs ?? 0) > 300_000 ? 'text-rose-300' : 'text-stone-200'}`}>{fmtWait(sp.queueStats.p95WaitedMs)}</span></div>
                  <div><span className="text-stone-500">Max:</span> <span className="font-semibold text-stone-200">{fmtWait(sp.queueStats.waitedMsMax)}</span></div>
                </div>
                <p className="mt-1.5 text-[10px] text-stone-500">
                  p95 chờ cao + RAM dư → cân nhắc kill-switch SUBAGENT_MAX_CONCURRENT≥2; p95 thấp hoặc từng OOM → giữ tuần tự (R14).
                </p>
              </div>
            )}

            {/* Nợ đang mở */}
            <div className="mt-4">
              <div className="text-xs font-semibold text-stone-200 mb-2">🔥 Nợ đang mở — ưu tiên xử lý đầu run mới</div>
              {(data.open ?? []).length === 0 ? (
                <div className="rounded-xl border border-emerald-500/25 bg-emerald-950/15 px-3 py-4 text-xs text-emerald-300/90 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" /> Không có nợ đang mở — sạch.
                </div>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-xl border border-stone-700/40 bg-slate-950/40 divide-y divide-stone-800/60 dialog-scrollbar">
                  {(data.open ?? []).map(d => {
                    const b = statusBadge(d.status)
                    return (
                      <div key={d.id} className="px-3 py-2.5">
                        <div className="flex items-start justify-between gap-2 flex-wrap">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <Badge className={`${b.className} text-[10px] px-1.5`}>{b.label}</Badge>
                              <Badge className="bg-stone-800/80 text-stone-400 border-stone-600/60 text-[10px] px-1.5">{d.kind}</Badge>
                              {d.severity === 'high' && <Badge className="bg-rose-950/70 text-rose-300 border-rose-500/50 text-[10px] px-1.5" title="infra hoặc tái phát ≥2 lần — ưu tiên thầy nhìn">⚠ cao</Badge>}
                              {d.attempts > 0 && <span className="text-[10px] text-stone-500">đã thử {d.attempts} lần</span>}
                              {d.recurrenceCount > 0 && <span className="text-[10px] text-rose-400/80">tái xuất hiện {d.recurrenceCount} lần</span>}
                            </div>
                            <p className="mt-1 text-xs text-stone-200 break-words">{d.title}</p>
                            <p className="mt-0.5 text-[10px] text-stone-500">thấy gần nhất {fmtTime(d.lastSeenAt)} · nguồn {d.originSessionId?.slice(0, 12) ?? '—'}</p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[10px] border-emerald-600/40 text-emerald-300 hover:bg-emerald-950/40" disabled={actingId === d.id} onClick={() => void act(d.id, 'resolve')}>
                              {actingId === d.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3 mr-1" />} Đóng
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[10px] border-stone-600/50 text-stone-400 hover:bg-stone-900/60" disabled={actingId === d.id} onClick={() => void act(d.id, 'park')}>
                              <PauseCircle className="h-3 w-3 mr-1" /> Park
                            </Button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Đã park */}
            {(data.parked ?? []).length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-semibold text-stone-300 mb-2 flex items-center gap-1.5"><Archive className="h-3.5 w-3.5" /> Đã park — chờ điều kiện / thầy reopen</div>
                <div className="max-h-44 overflow-y-auto rounded-xl border border-stone-800/60 bg-stone-950/40 divide-y divide-stone-800/50 dialog-scrollbar">
                  {(data.parked ?? []).map(d => (
                    <div key={d.id} className="px-3 py-2 flex items-start justify-between gap-2 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-stone-300 break-words">{d.title}</p>
                        <p className="text-[10px] text-stone-500">{d.parkReason ?? '—'} · thử {d.attempts} lần</p>
                      </div>
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[10px] border-amber-600/40 text-amber-300 hover:bg-amber-950/40 shrink-0" disabled={actingId === d.id} onClick={() => void act(d.id, 'reopen')}>
                        {actingId === d.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3 mr-1" />} Mở lại
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Resolved gần đây */}
            {(data.recentResolved ?? []).length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-semibold text-stone-300 mb-2">✅ Đã giải quyết gần đây — bằng chứng đối chiếu</div>
                <div className="max-h-40 overflow-y-auto rounded-xl border border-stone-800/60 bg-stone-950/30 divide-y divide-stone-800/40 dialog-scrollbar">
                  {(data.recentResolved ?? []).map(d => (
                    <div key={d.id} className="px-3 py-1.5">
                      <p className="text-[11px] text-stone-400 break-words">{d.title}</p>
                      <p className="text-[10px] text-stone-600">{d.resolutionEvidence?.slice(0, 120) ?? ''}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

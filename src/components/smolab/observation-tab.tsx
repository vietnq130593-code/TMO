'use client'

/**
 * OBS-P3 (BLUEPRINT-OBSERVATION §C.5 — chốt §7 Task 23 2026-10-13)
 * ============================================================================
 *
 * TAB "QUAN SÁT" (BRAIN › SECTION 3 — tab console thứ 5, tích hợp vào tab
 * BRAIN theo chỉ thị user 2026-10-13 Task 25; trước đây là tab riêng cấp
 * module Smolab cạnh BRAIN) — "bảng bệnh án toàn thân":
 *
 *   1. Timeline dọc live-poll THÍCH ỨNG (2,5s khi có sự kiện mới / 15s idle —
 *      precedent tab BRAIN): ts · actor badge · kind chip màu theo nhóm ·
 *      summary; click → drill-down payload (Dialog precedent tuning-param-dialog).
 *   2. Filter bar: kind (select từ response.kinds — single-source kinds.ts) ·
 *      actor · khoảng ts (15 phút → tất cả).
 *   3. KIM TUYẾN (golden thread): nhập runId → timeline lọc chỉ run đó +
 *      join BrainInferenceTrace (C.4 "cả 2 nguồn trong 1 response") + tóm
 *      tắt run (start → end, thời lượng, đếm theo nhóm) — câu trả lời trực
 *      tiếp "toàn cảnh mỗi khi agent vận hành".
 *   4. Panel nhãn & não: lifecycle 3 brain + tín hiệu nhãn current/threshold
 *      theo nguồn (GAP-8) — single-source /api/brain (không nhân bản
 *      dashboard; SECTION 1 ngay phía trên đã có chi tiết đầy đủ).
 *
 * Cờ ui_observation (off mặc định) — off hiển thị trạng thái tắt + nút bật
 * nhanh (POST /api/neural-architecture precedent hitech-toggle). Cờ
 * obs_ledger/obs_brain_trace/obs_impact hiển thị chip trạng thái (bật tại
 * tab BRAIN › Tham số runtime).
 *
 * Read-only TUYỆT ĐỐI — toàn bộ dữ liệu từ GET /api/observation/timeline +
 * GET /api/brain. KHÔNG ghi gì (trừ nút bật cờ — đi đúng tuning-store audit).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eye, EyeOff, Activity, Filter, X, RefreshCw, GitBranch, BrainCircuit, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { OBS_GROUP_CLASSES, obsActorClass, obsKindDef, type ObsKindDef } from '@/lib/observation/kinds'
import { computeLabelTotal } from '@/lib/brain/registry'

// ==================== HẰNG SỐ (precedent brain-tab POLL_*) ====================

/** Poll nhanh khi có sự kiện mới (tiền lệ POLL_ACTIVITY_MS = 2_500). */
const POLL_ACTIVE_MS = 2_500
/** Poll chậm khi idle (tiền lệ POLL_NEURAL_MS = 15_000). */
const POLL_IDLE_MS = 15_000
/** Số sự kiện mỗi trang. */
const PAGE_LIMIT = 50

// ==================== TYPES (đối chiếu route.ts — pin r97 source-scan) ====================

interface ObsEventRow {
  seq: number
  ts: string
  actor: string
  kind: string
  runId: string | null
  sessionId: string | null
  table: string | null
  rowKey: string | null
  summary: string
  payload: Record<string, unknown>
}

interface ObsTraceRow {
  id: string
  ts: string
  brain: string
  modelVersion: number
  organ: string | null
  runId: string | null
  inputHash: string
  latencyMs: number
  input: string | null
  output: string | null
}

interface TimelineResponse {
  ok: boolean
  flags: { obsLedger: boolean; obsBrainTrace: boolean; obsImpact: boolean; uiObservation: boolean }
  events: ObsEventRow[]
  hasMore: boolean
  nextBefore: number | null
  total: number
  traces: ObsTraceRow[]
  kinds: ObsKindDef[]
}

interface BrainFeedEntry {
  key: string
  title: string
  lifecycle: 'dormant' | 'awake' | 'active'
  signals: Array<{ key: string; label: string; current: number | null; min: number; ok: boolean }>
}

interface BrainApiResponse {
  ok?: boolean
  brains?: BrainFeedEntry[]
}

// ==================== HELPERS ====================

const fmtTime = (iso: string): string => {
  const d = new Date(iso)
  return d.toLocaleTimeString('vi-VN', { hour12: false })
}

const fmtDate = (iso: string): string => {
  const d = new Date(iso)
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
}

/**
 * Chip màu kind — tra kinds.ts single-source (obsKindDef), kind lạ rơi nhóm
 * 'db' (fail-open). FB-OBS-R1-07: bỏ bản sao map 16-kind cục bộ — thêm kind
 * mới ở kinds.ts tự động đúng màu (bản cũ thiếu kind → sai màu nhóm 'db').
 */
function kindClass(kind: string): string {
  return OBS_GROUP_CLASSES[obsKindDef(kind)?.group ?? 'db']
}

const LIFECYCLE_BADGE: Record<BrainFeedEntry['lifecycle'], { label: string; cls: string }> = {
  dormant: { label: 'NGỦ', cls: 'bg-stone-500/15 text-stone-300 border-stone-500/30' },
  awake: { label: 'THỨC TỈNH', cls: 'bg-teal-500/15 text-teal-300 border-teal-500/30' },
  active: { label: 'ACTIVE', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
}

// ==================== COMPONENT ====================

export function ObservationTabContent() {
  // ── State dữ liệu ──
  const [data, setData] = useState<TimelineResponse | null>(null)
  const [brains, setBrains] = useState<BrainFeedEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /// Seq mới nhất đã thấy — quyết định nhịp poll (2,5s có mới / 15s idle)
  const lastSeqRef = useRef<number | null>(null)
  /// Cooldown poll nhanh: sau khi có dữ liệu mới, giữ nhịp nhanh VÒNG KẾ
  const fastUntilRef = useRef<number>(0)

  // ── State filter (kim tuyến + filter bar C.5-2) ──
  const [kindFilter, setKindFilter] = useState<string>('')
  const [actorFilter, setActorFilter] = useState('')
  const [sinceFilter, setSinceFilter] = useState<string>('')
  /// runId đang theo dõi kim tuyến (chuỗi rỗng = tắt)
  const [runIdInput, setRunIdInput] = useState('')
  const [runIdActive, setRunIdActive] = useState<string | null>(null)

  // ── Drill-down (dialog precedent tuning-param-dialog) ──
  const [detail, setDetail] = useState<ObsEventRow | null>(null)

  const sinceIso = useMemo(() => {
    if (!sinceFilter) return ''
    const minutes = Number(sinceFilter)
    return new Date(Date.now() - minutes * 60_000).toISOString()
  }, [sinceFilter])

  // ── Fetch timeline (mọi filter → query; READ-ONLY) ──
  const fetchTimeline = useCallback(async () => {
    try {
      const q = new URLSearchParams()
      if (kindFilter) q.set('kind', kindFilter)
      if (actorFilter.trim()) q.set('actor', actorFilter.trim())
      if (runIdActive) q.set('runId', runIdActive)
      if (sinceIso) q.set('since', sinceIso)
      q.set('limit', String(PAGE_LIMIT))
      const res = await fetch(`/api/observation/timeline?${q.toString()}`)
      if (!res.ok) {
        // 400 (query rác) → bỏ lặng lẽ — poll không toast spam (contract 15-a)
        setLoadError(res.status === 400 ? 'Tham số lọc không hợp lệ' : 'Lỗi tải timeline')
        return
      }
      const json = (await res.json()) as TimelineResponse
      if (!json.ok) return
      setData(json)
      setLoadError(null)
      // nhịp thích ứng: có sự kiện mới hơn seq đã thấy → giữ nhanh 1 vòng
      const top = json.events[0]?.seq ?? null
      if (top !== null && (lastSeqRef.current === null || top > lastSeqRef.current)) {
        fastUntilRef.current = Date.now() + POLL_ACTIVE_MS * 4
      }
      if (top !== null) lastSeqRef.current = Math.max(lastSeqRef.current ?? 0, top)
    } catch {
      setLoadError('Mất kết nối — giữ dữ liệu cũ') // fail-open giữ dữ liệu — phần "thử lại" do hậu tố spinner đảm nhiệm (FB-OBS-LIVE-01: tránh lặp "đang thử lại — thử lại")
    }
  }, [kindFilter, actorFilter, runIdActive, sinceIso])

  // ── Fetch /api/brain cho panel nhãn & não (single-source — không API mới) ──
  const fetchBrains = useCallback(async () => {
    try {
      const res = await fetch('/api/brain')
      if (!res.ok) return
      const json = (await res.json()) as BrainApiResponse
      if (Array.isArray(json.brains)) setBrains(json.brains)
    } catch { /* fail-open — panel hiển thị "không rõ" */ }
  }, [])

  // ── Poll thích ứng + visibilitychange (pattern brain-tab 15-d) ──
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer !== null) clearTimeout(timer)
      const delay = Date.now() < fastUntilRef.current ? POLL_ACTIVE_MS : POLL_IDLE_MS
      timer = setTimeout(async () => {
        await Promise.all([fetchTimeline(), fetchBrains()])
        schedule()
      }, delay)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (timer !== null) { clearTimeout(timer); timer = null }
      } else {
        void fetchTimeline()
        schedule()
      }
    }
    if (document.visibilityState !== 'hidden') {
      // queueMicrotask — pattern brain-tab 15-d: KHÔNG gọi fetch (chứa
      // setState) trực tiếp trong effect body (react-hooks/set-state-in-effect)
      queueMicrotask(() => {
        void fetchTimeline()
        void fetchBrains()
      })
      schedule()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [fetchTimeline, fetchBrains])

  const refetchNow = useCallback(async () => {
    await Promise.all([fetchTimeline(), fetchBrains()])
  }, [fetchTimeline, fetchBrains])

  // ── Bật cờ ui_observation nhanh (precedent hitech-toggle: POST neural-architecture) ──
  const [enabling, setEnabling] = useState(false)
  const enableUiObservation = useCallback(async () => {
    setEnabling(true)
    try {
      const res = await fetch('/api/neural-architecture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set', key: 'ui_observation', value: 'on' }),
      })
      if (!res.ok) throw new Error(String(res.status))
      toast.success('Đã bật tab Quan sát (ui_observation=on) — tuning-store ghi audit')
      await refetchNow()
    } catch {
      toast.warning('Không bật được cờ — bật tay tại tab BRAIN › Tham số runtime › UI_OBSERVATION')
    } finally {
      setEnabling(false)
    }
  }, [refetchNow])

  // ── Kim tuyến: tóm tắt run khi đang theo dõi ──
  const runSummary = useMemo(() => {
    if (!runIdActive || !data) return null
    const evs = data.events
    const start = evs.find(e => e.kind === 'run.start')
    const end = [...evs].reverse().find(e => e.kind === 'run.end')
    const byGroup = new Map<string, number>()
    for (const e of evs) {
      const g = e.kind.split('.')[0]
      byGroup.set(g, (byGroup.get(g) ?? 0) + 1)
    }
    const durationMs =
      start && end ? new Date(end.ts).getTime() - new Date(start.ts).getTime() : null
    return {
      total: data.total,
      loaded: evs.length,
      durationMs,
      running: !end,
      byGroup,
      nTraces: data.traces.length,
    }
  }, [runIdActive, data])

  const startGoldenThread = useCallback(() => {
    const v = runIdInput.trim()
    setRunIdActive(v !== '' ? v : null)
    lastSeqRef.current = null
  }, [runIdInput])

  const clearGoldenThread = useCallback(() => {
    setRunIdInput('')
    setRunIdActive(null)
    lastSeqRef.current = null
  }, [])

  const kindOptions = data?.kinds ?? []
  const flagUiOn = data?.flags.uiObservation ?? false
  /// Chưa có response đầu → đang tải (derive — không setState trong effect)
  const initialLoading = data === null
  const labelTotal = useMemo<number | null>(() => computeLabelTotal(brains), [brains])

  // ==================== RENDER ====================
  return (
    <div className="space-y-3" role="region" aria-label="Quan sát vận hành — timeline sự kiện">
      {/* ── Header + chip 4 cờ ── */}
      <div className="flex flex-wrap items-center gap-2">
        <Activity className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
        <h4 className="text-xs font-semibold text-stone-100">Quan sát — toàn cảnh vận hành</h4>
        <span className="text-[10px] text-stone-500">
          timeline sự kiện · kim tuyến runId · nhãn &amp; não — read-only
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {([
            ['obs_ledger', data?.flags.obsLedger],
            ['obs_brain_trace', data?.flags.obsBrainTrace],
            ['obs_impact', data?.flags.obsImpact],
            ['ui_observation', data?.flags.uiObservation],
          ] as const).map(([k, on]) => (
            <span
              key={k}
              className={`rounded border px-1.5 py-0.5 text-[9px] font-mono ${
                on ? 'bg-teal-500/15 text-teal-300 border-teal-500/30' : 'bg-stone-500/10 text-stone-500 border-stone-500/25'
              }`}
            >
              {k}={on ? 'on' : 'off'}
            </span>
          ))}
        </div>
      </div>

      {/* ── Trạng thái tắt (cờ ui_observation off) — bật nhanh tại chỗ ── */}
      {initialLoading === false && !flagUiOn && (
        <div className="rounded-md border border-stone-700/70 bg-stone-900/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <EyeOff className="h-4 w-4 shrink-0 text-stone-400" />
            <span className="text-[11px] text-stone-300">
              Cờ <span className="font-mono text-stone-100">ui_observation</span> đang TẮT — tab ở
              chế độ tối giản (chỉ chip trạng thái). Bật để xem timeline đầy đủ.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-8 gap-1 border-stone-600 text-[11px]"
              disabled={enabling}
              onClick={() => void enableUiObservation()}
              aria-label="Bật cờ ui_observation"
            >
              <Eye className="h-3 w-3" />
              {enabling ? 'Đang bật…' : 'Bật ngay'}
            </Button>
          </div>
        </div>
      )}

      {initialLoading && (
        <div className="flex items-center gap-2 py-6 text-[11px] text-stone-500" aria-live="polite">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          {/* FB-OBS-R1-12: lỗi fetch phải hiển thị cả khi data===null — trước đây
              loadError chỉ render trong nhánh ĐÃ có data → fetch hỏng kéo dài
              treo spinner "Đang tải…" vô hạn */}
          {loadError ? (
            <span className="text-amber-400">{loadError} — thử lại</span>
          ) : (
            'Đang tải timeline quan sát…'
          )}
        </div>
      )}

      {initialLoading === false && flagUiOn && (
        <>
          {/* ── Kim tuyến (golden thread — C.5-3) ── */}
          <div className="rounded-md border border-cyan-900/50 bg-cyan-950/20 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
              <span className="text-[10px] font-medium text-cyan-300">Kim tuyến runId</span>
              <input
                value={runIdInput}
                onChange={e => setRunIdInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') startGoldenThread() }}
                placeholder="run_xxx… — xem toàn cảnh 1 run agent"
                aria-label="runId cần theo dõi kim tuyến"
                className="min-h-[36px] flex-1 min-w-[180px] rounded border border-stone-700 bg-stone-900/60 px-2 text-[11px] text-stone-200 placeholder:text-stone-600 focus:border-cyan-600 focus:outline-none"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-9 border-cyan-800 text-[11px] text-cyan-300 hover:text-cyan-200"
                onClick={startGoldenThread}
                aria-label="Theo dõi runId"
              >
                Theo dõi
              </Button>
              {runIdActive && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 gap-1 text-[11px] text-stone-400"
                  onClick={clearGoldenThread}
                  aria-label="Thoát kim tuyến"
                >
                  <X className="h-3 w-3" /> Thoát
                </Button>
              )}
            </div>
            {runIdActive && runSummary && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-stone-400" aria-live="polite">
                <span className="font-mono text-cyan-300">{runIdActive}</span>
                <span>{runSummary.total} sự kiện</span>
                {runSummary.durationMs !== null && <span>thời lượng {(runSummary.durationMs / 1000).toFixed(1)}s</span>}
                <span className={runSummary.running ? 'text-teal-300' : 'text-stone-400'}>
                  {runSummary.running ? '● đang chạy' : '■ đã kết thúc'}
                </span>
                {runSummary.nTraces > 0 && <span>{runSummary.nTraces} vết suy diễn não</span>}
                <span className="text-stone-500">
                  {[...runSummary.byGroup.entries()].map(([g, n]) => `${g}:${n}`).join(' · ') || 'chưa có sự kiện'}
                </span>
              </div>
            )}
          </div>

          {/* ── Filter bar (C.5-2) ── */}
          <div className="flex flex-wrap items-center gap-2">
            <Filter className="h-3 w-3 shrink-0 text-stone-500" />
            <div className="relative">
              <select
                value={kindFilter}
                onChange={e => setKindFilter(e.target.value)}
                aria-label="Lọc theo loại sự kiện"
                className="min-h-[36px] appearance-none rounded border border-stone-700 bg-stone-900/60 py-1 pl-2 pr-7 text-[11px] text-stone-300 focus:border-cyan-600 focus:outline-none"
              >
                <option value="">Mọi loại</option>
                {kindOptions.map(k => (
                  <option key={k.kind} value={k.kind}>{k.label} ({k.kind})</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-stone-500" />
            </div>
            <input
              value={actorFilter}
              onChange={e => setActorFilter(e.target.value)}
              placeholder="actor (vd agent:opus)"
              aria-label="Lọc theo actor"
              className="min-h-[36px] w-40 rounded border border-stone-700 bg-stone-900/60 px-2 text-[11px] text-stone-200 placeholder:text-stone-600 focus:border-cyan-600 focus:outline-none"
            />
            <div className="relative">
              <select
                value={sinceFilter}
                onChange={e => setSinceFilter(e.target.value)}
                aria-label="Lọc theo khoảng thời gian"
                className="min-h-[36px] appearance-none rounded border border-stone-700 bg-stone-900/60 py-1 pl-2 pr-7 text-[11px] text-stone-300 focus:border-cyan-600 focus:outline-none"
              >
                <option value="">Mọi thời gian</option>
                <option value="15">15 phút</option>
                <option value="60">1 giờ</option>
                <option value="360">6 giờ</option>
                <option value="1440">24 giờ</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-stone-500" />
            </div>
            <span className="ml-auto text-[10px] text-stone-500" aria-live="polite">
              {loadError ? <span className="text-amber-400">{loadError}</span> : `${data?.total ?? 0} sự kiện`}
            </span>
          </div>

          {/* ── Cảnh báo obs_ledger off (dữ liệu ngừng ghi mới) ── */}
          {data && !data.flags.obsLedger && (
            <div className="rounded border border-amber-900/50 bg-amber-950/20 px-2.5 py-1.5 text-[10px] text-amber-300">
              Cờ <span className="font-mono">obs_ledger</span> đang tắt — không có sự kiện MỚI được
              ghi (lịch sử cũ vẫn hiển thị). Bật tại tab BRAIN › Tham số runtime › OBS_LEDGER.
            </div>
          )}

          {/* ── Timeline dọc (C.5-1) — max-h scroll + scrollbar mảnh ── */}
          <div className="max-h-96 overflow-y-auto overflow-x-auto rounded-md border border-stone-800 [scrollbar-width:thin]">
            {data && data.events.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-stone-500">
                {runIdActive
                  ? 'Chưa có sự kiện nào cho runId này (run chưa chạy khi cờ obs_ledger bật?)'
                  : 'Chưa có sự kiện nào — bật obs_ledger rồi vận hành agents, sự kiện sẽ chảy vào đây'}
              </div>
            )}
            <ul className="divide-y divide-stone-800/60">
              {data?.events.map(e => (
                <li key={e.seq}>
                  <button
                    onClick={() => setDetail(e)}
                    className="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-stone-800/30 min-h-[44px] md:min-h-[36px]"
                    aria-label={`Sự kiện ${e.kind} — ${e.summary}`}
                  >
                    <span className="shrink-0 pt-0.5 font-mono text-[9px] text-stone-500">
                      {fmtDate(e.ts)} {fmtTime(e.ts)}
                    </span>
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] ${obsActorClass(e.actor)}`}>
                      {e.actor.length > 18 ? `${e.actor.slice(0, 16)}…` : e.actor}
                    </span>
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] ${kindClass(e.kind)}`}>
                      {e.kind}
                    </span>
                    <span className="min-w-0 flex-1 text-[11px] leading-snug text-stone-300">{e.summary}</span>
                    {e.runId && (
                      <span className="shrink-0 font-mono text-[9px] text-cyan-500/80" title={e.runId}>
                        {runIdActive ? '◈' : `◈ ${e.runId.slice(0, 12)}…`}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {data?.hasMore && (
              <div className="px-3 py-2 text-center text-[10px] text-stone-500">
                Còn {Math.max(0, data.total - data.events.length)} sự kiện cũ hơn — thu hẹp filter
                hoặc xem tại DB (prune giữ 50K/30 ngày)
              </div>
            )}
          </div>

          {/* ── Vết suy diễn não của run (kim tuyến — join trace C.4) ── */}
          {runIdActive && data && data.traces.length > 0 && (
            <div className="rounded-md border border-violet-900/40 bg-violet-950/10 p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5">
                <BrainCircuit className="h-3 w-3 shrink-0 text-violet-400" />
                <span className="text-[10px] font-medium text-violet-300">
                  {data.traces.length} vết suy diễn não của run (mới → cũ)
                </span>
              </div>
              <ul className="max-h-48 space-y-1 overflow-y-auto [scrollbar-width:thin]">
                {data.traces.map(t => (
                  <li
                    key={t.id}
                    className="flex flex-wrap items-center gap-2 rounded border border-stone-800/60 bg-stone-900/40 px-2 py-1 text-[10px] text-stone-400"
                  >
                    <span className="font-mono text-[9px] text-stone-500">{fmtTime(t.ts)}</span>
                    <span className="text-violet-300">{t.brain}</span>
                    <span>· {t.organ ?? '?'} · v{t.modelVersion} · {t.latencyMs}ms</span>
                    <span className="truncate font-mono text-[9px] text-stone-600" title={t.inputHash}>
                      sha {t.inputHash.slice(0, 12)}…
                    </span>
                    {t.input === null && t.output === null && (
                      <span className="text-stone-600">(hash-only — bật obs_brain_trace để xem vector)</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Panel nhãn & não (C.5-4 — GAP-8 breakdown) ── */}
          <Card className="border-stone-800 bg-stone-900/30">
            <CardContent className="p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <BrainCircuit className="h-3 w-3 shrink-0 text-amber-400" />
                <span className="text-[10px] font-medium text-stone-300">Nhãn vận hành &amp; não</span>
                {labelTotal !== null && (
                  <span className="rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-300">
                    tổng nhãn {labelTotal.toLocaleString('vi-VN')}
                  </span>
                )}
                {/* Task 25: nút điều hướng sang tab não đã gỡ — component giờ
                    nằm NGAY TRONG tab BRAIN (SECTION 3); SECTION 1 (chọn não +
                    ngưỡng thức tỉnh) ngay phía trên cùng trang. */}
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {(brains ?? []).map(b => {
                  const badge = LIFECYCLE_BADGE[b.lifecycle] ?? LIFECYCLE_BADGE.dormant
                  return (
                    <div key={b.key} className="rounded border border-stone-800/70 bg-stone-900/40 p-2">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[11px] font-medium text-stone-200">{b.title}</span>
                        <span className={`shrink-0 rounded border px-1 py-0.5 text-[8px] ${badge.cls}`}>{badge.label}</span>
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {b.signals.map(s => (
                          <li key={s.label} className="flex items-center justify-between gap-1 text-[9px]">
                            <span className="truncate text-stone-500">{s.label}</span>
                            <span className={s.ok ? 'text-teal-300' : 'text-stone-400'}>
                              {s.current !== null ? `${s.current}/${s.min}` : `?/${s.min}`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
                {brains === null && (
                  <div className="col-span-3 py-2 text-center text-[10px] text-stone-500">
                    Không tải được trạng thái não (fail-open — thử lại chu kỳ poll sau)
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* ── Drill-down payload (dialog precedent tuning-param-dialog) ── */}
      <Dialog open={detail !== null} onOpenChange={open => { if (!open) setDetail(null) }}>
        <DialogContent className="max-w-lg border-stone-700 bg-stone-950">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`rounded border px-1.5 py-0.5 text-[10px] ${detail ? kindClass(detail.kind) : ''}`}>
                {detail?.kind}
              </span>
              <span className="font-mono text-[10px] text-stone-500">seq {detail?.seq}</span>
            </DialogTitle>
            <DialogDescription className="text-left text-[11px] text-stone-300">
              {detail?.summary}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-2 overflow-y-auto [scrollbar-width:thin]">
            {detail && (
              <>
                <div className="grid grid-cols-2 gap-1 text-[10px] text-stone-500">
                  <span>thời điểm: {fmtDate(detail.ts)} {fmtTime(detail.ts)}</span>
                  <span className="truncate">actor: {detail.actor}</span>
                  <span className="truncate">runId: {detail.runId ?? '—'}</span>
                  <span className="truncate">bảng: {detail.table ?? '—'}{detail.rowKey ? ` · ${detail.rowKey.slice(0, 18)}` : ''}</span>
                </div>
                <pre className="overflow-x-auto rounded border border-stone-800 bg-stone-900/60 p-2 text-[10px] leading-relaxed text-stone-300">
                  {JSON.stringify(detail.payload, null, 2)}
                </pre>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
